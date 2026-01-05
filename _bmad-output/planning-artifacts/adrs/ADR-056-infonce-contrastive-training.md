# ADR-056: InfoNCE Contrastive Training for SHGAT

**Status:** Accepted **Date:** 2026-01-04 **Related:**

- ADR-055 (SHGAT PreserveDim - Keep d=1024)
- ADR-053 (SHGAT Subprocess PER Training)

## Problem

After fixing the dimension architecture (ADR-055), SHGAT training still produced uniform scores (~0.66-0.67) with only 0.6% spread instead of the expected ~6% spread. Training accuracy was ~0.15-0.19 (close to random for 5 classes).

## Root Cause Analysis

### 1. BCE Loss Doesn't Discriminate

The original training used Binary Cross-Entropy (BCE) to predict success/failure:

```typescript
// Old approach
const loss = binaryCrossEntropy(score, outcome); // outcome = 0 or 1
```

**Problem**: ~90% of traces have `success=1`, so the model learns to output ~0.6-0.7 for everything to minimize BCE loss. This doesn't teach the model which capability is **better** than others.

### 2. Sigmoid Scores in InfoNCE

When we first switched to InfoNCE, we used sigmoid-transformed scores:

```typescript
// BROKEN: softmax(sigmoid(x))
const score = sigmoid(dotQK / scale);       // Squashes to ~0.5
const softmax = softmax([posScore, ...negScores] / τ);  // All ~0.5 → uniform
```

**Problem**: Sigmoid squashes Q·K to [0, 1], clustering around 0.5. Softmax of uniform values gives uniform probabilities → loss = log(5) ≈ 1.609 (random) → no learning.

## Solution: InfoNCE with Raw Logits

### 1. Use Logits (Not Sigmoid) for Contrastive Learning

```typescript
// FIXED: Use raw logits
const logit = dotQK / scale;                // Raw logit, can be any real number
const softmax = softmax([posLogit, ...negLogits] / τ);  // Proper contrast
```

### 2. InfoNCE Loss Function

For each training example:
- **Positive**: The capability/tool that was actually executed
- **Negatives**: 4 **random negatives** (sampled uniformly from other capabilities)

```
L = -log( exp(pos/τ) / Σ exp(all/τ) )
```

Where τ = 0.1 (temperature) makes the distribution sharper.

### 3. Random Negative Sampling

We use **random sampling** to select negatives:

```typescript
// RANDOM NEGATIVE MINING: Select random capabilities (excluding positive)
const candidateIds: string[] = [];
for (const [capId] of allEmbeddings) {
  if (capId === positiveId) continue; // Exclude positive
  candidateIds.push(capId);
}

// Fisher-Yates shuffle and take first NUM_NEGATIVES
for (let i = candidateIds.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [candidateIds[i], candidateIds[j]] = [candidateIds[j], candidateIds[i]];
}
const randomNegatives = candidateIds.slice(0, 4);
```

### Why Random (Not Hard) Negatives

**Initial approach**: Hard negatives (top-K by cosine similarity with intent embedding)

**Problem observed**: Training accuracy stuck at ~51% (random chance for 2-class) after 9 epochs:
```
Epoch 9: loss=0.6990, accuracy=0.5139, spread=2.88%
```

**Root cause**: With 1024-dim embeddings, ALL capabilities have ~0.9 cosine similarity with intent. Hard negatives are too similar to positives - the model cannot learn to distinguish them.

**Solution**: Random negatives provide more varied difficulty:
- Some are easy (low similarity) → clear gradient signal
- Some are medium → progressive learning
- Some happen to be hard → fine-grained discrimination

This allows the model to learn basic discrimination first, building up to harder cases naturally.

### 4. Direct Gradient Flow (No Sigmoid Derivative)

For InfoNCE, gradients flow directly through logits without sigmoid derivative:

```typescript
// BEFORE (BCE): dDotQK = dScore * sigmoid'(x) = dScore * score * (1 - score)
// AFTER (InfoNCE): dDotQK = dLogit / scale  (direct gradient)
```

## Implementation Details

### Files Modified

1. **`src/graphrag/algorithms/shgat/training/multi-level-trainer-khead.ts`**
   - `computeKHeadScoreWithCache`: Returns both `score` (sigmoid) and `logit` (raw)
   - `computeMultiHeadKHeadScoresWithCache`: Returns `scores` and `logits` arrays
   - NEW: `backpropKHeadScoreLogit`: Direct gradient without sigmoid derivative
   - NEW: `backpropMultiHeadKHeadLogit`: Multi-head version for InfoNCE

2. **`src/graphrag/algorithms/shgat.ts`**
   - `trainBatchV1KHead`: Uses logits for InfoNCE softmax
   - Uses `backpropMultiHeadKHeadLogit` for InfoNCE backward pass
   - Falls back to BCE with sigmoid for examples without negatives

3. **`src/graphrag/algorithms/shgat/types.ts`**
   - `TrainingExample.negativeCapIds?: string[]`: Optional negatives for contrastive learning

4. **`src/mcp/gateway-server.ts`**
   - Random negative sampling with Fisher-Yates shuffle
   - `NUM_NEGATIVES = 4`, `epochs = 10`, `learningRate = 0.01`

5. **`src/graphrag/learning/per-training.ts`**
   - `traceToTrainingExamples`: Accepts `Map<string, number[]>` for random negative sampling
   - Fisher-Yates shuffle to select random negatives (not cosine-based hard negatives)
   - Both `trainSHGATOnPathTraces` and `trainSHGATOnPathTracesSubprocess` pass all embeddings

### Architecture

```
Training Example:
  ├── intentEmbedding: number[1024]
  ├── candidateId: string          (positive - executed capability)
  ├── negativeCapIds: string[4]    (random negatives via Fisher-Yates shuffle)
  └── outcome: number              (1 = success, 0 = failure, for BCE fallback)

Forward Pass (InfoNCE):
  intent ──────────────────────────────────────────┐
           │                                       │
  posLogit = mean(heads[h].Q·K / √dim)            │
           │                                       │
  negLogits = [mean(heads[h].Q·K_neg / √dim), ...] │
           │                                       │
  softmax([posLogit, ...negLogits] / τ)  ←─────────┘
           │
  loss = -log(softmax[0])  (positive should have highest prob)

Backward Pass (InfoNCE):
  dLoss/dLogit_pos = (softmax[0] - 1) / τ
  dLoss/dLogit_neg = softmax[i] / τ

  → backpropMultiHeadKHeadLogit (NO sigmoid derivative!)
  → dDotQK = dLogit / scale  (direct gradient)
  → dW_q, dW_k gradients
```

### Expected Metrics

| Metric | Random (5 classes) | Target |
|--------|-------------------|--------|
| Loss | log(5) ≈ 1.609 | < 0.5 |
| Accuracy | 20% (1/5) | > 80% |
| Score Spread | 0% | ~6% |

## Trade-offs

### Advantages

1. **Discriminative learning**: Model learns which capability is BETTER, not just success/failure
2. **Contrastive signal**: Positive vs negatives provides strong gradient signal
3. **Works with existing traces**: No need for explicit ranking data

### Disadvantages

1. **More computation**: Need to compute scores for 5 candidates instead of 1
2. **τ sensitivity**: Temperature affects gradient magnitude
3. **Random variance**: Different runs may select different negatives

## Future Improvements

1. **In-batch negatives**: Use other examples in batch as negatives (more efficient)
2. **Temperature annealing**: Start with high τ, decrease over training
3. **Curriculum learning**: Start with random negatives → semi-hard → hard negatives as training progresses
4. **Semi-hard negatives**: Select negatives that are harder than easy but not as hard as top-K

## References

- [InfoNCE: Contrastive Predictive Coding](https://arxiv.org/abs/1807.03748)
- [SimCLR: A Simple Framework for Contrastive Learning](https://arxiv.org/abs/2002.05709)
