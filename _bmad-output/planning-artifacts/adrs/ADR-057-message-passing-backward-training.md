# ADR-057: End-to-End Message Passing Backward Training

**Status:** Accepted **Date:** 2026-01-04 **Related:**

- ADR-055 (SHGAT PreserveDim - Keep d=1024)
- ADR-056 (InfoNCE Contrastive Training)

## Problem

After implementing InfoNCE contrastive training (ADR-056), the K-head attention parameters (W_q, W_k) and intent projection (W_intent) were being trained, but the **message passing parameters** (levelParams) were not receiving gradients.

The forward pass flows through:
```
V → E^0 → E^1 → ... → E^L → ... → E^0 → V → K-head scoring → loss
```

But the backward pass only trained:
```
loss → K-head (W_q, W_k) → W_intent
        ↑
   gradients stop here, levelParams not updated
```

This means the multi-level message passing (V→E, E→E, E→V phases) was acting as a **frozen feature extractor** rather than learning from the training signal.

## Solution: Full Backward Through Message Passing

### 1. Per-Phase Backward Implementation

Each message passing phase now has `forwardWithCache()` and `backward()` methods:

**V→E Phase** (`vertex-to-edge-phase.ts`):
```typescript
interface VEForwardCache {
  H: number[][];           // Original tool embeddings
  E: number[][];           // Original cap embeddings
  H_proj: number[][];      // Projected tool embeddings
  E_proj: number[][];      // Projected cap embeddings
  concatPreAct: Map<string, number[]>;  // Pre-activation for LeakyReLU
  aggregated: number[][];  // Pre-ELU values
  attention: number[][];   // Attention weights
  connectivity: number[][];
  leakyReluSlope: number;
}

interface VEGradients {
  dW_source: number[][];   // [headDim][embDim]
  dW_target: number[][];
  da_attention: number[];  // [2*headDim]
  dH: number[][];          // Gradient to input H
  dE: number[][];          // Gradient to input E
}
```

**E→V Phase** (`edge-to-vertex-phase.ts`): Same structure, reversed roles.

**E→E Phase** (`edge-to-edge-phase.ts`): For capability hierarchy (level k → level k+1).

### 2. Multi-Level Orchestrator Backward

The orchestrator chains backward through all phases in reverse order:

```typescript
interface MultiLevelBackwardCache extends MultiLevelForwardCache {
  veCaches: Map<number, VEForwardCache[]>;      // V→E caches per level per head
  eeUpwardCaches: Map<number, EEForwardCache[]>;  // E→E upward caches
  eeDownwardCaches: Map<number, EEForwardCache[]>;  // E→E downward caches
  evCaches: EVForwardCache[];                   // E→V caches per head
  v2vCache?: V2VForwardCache;                   // V→V cache (if trainable V2V enabled)
}

interface MultiLevelGradients {
  levelGrads: Map<number, LevelParamsGradients>;  // Per-level parameter gradients
  dH: number[][];           // Gradient for input tool embeddings
  dE: Map<number, number[][]>;  // Gradient for input cap embeddings per level
  v2vGrads?: V2VGradients;  // V→V gradients (if trainable V2V enabled)
}
```

Backward order:
1. E→V backward (final downward phase) → dE^0
2. E→E downward backward (level by level) → dE^k+1, dE^k
3. V→E backward (initial upward phase) → dH
4. E→E upward backward (level by level) → accumulate dW, da gradients
5. V→V backward (if enabled) → dResidualLogit, dTemperatureLogit, dH_init

### 3. Training Integration

In `trainBatchV1KHead()`:

```typescript
// 1. Forward with cache
const { result, cache } = this.orchestrator.forwardMultiLevelWithCache(...);

// 2. K-head scoring (uses flattened E)
const { dCapEmbedding } = backpropMultiHeadKHeadLogit(...);

// 3. Route dCapEmbedding to correct levels
this.accumulateDCapGradient(dE_accum, capIdx, dCapEmbedding, capIndexToLevel);

// 4. After batch: backward through message passing
const mpGrads = this.orchestrator.backwardMultiLevel(dE_final, null, cache, levelParams);

// 5. Apply gradients
applyLevelGradients(mpGradsConverted, this.levelParams, ...);
```

## Implementation Details

### Files Modified

1. **`src/graphrag/algorithms/shgat/message-passing/vertex-to-edge-phase.ts`**
   - NEW: `VEForwardCache`, `VEGradients`, `VEPhaseResultWithCache` interfaces
   - NEW: `forwardWithCache()` method
   - NEW: `backward()` method with full gradient computation

2. **`src/graphrag/algorithms/shgat/message-passing/edge-to-vertex-phase.ts`**
   - Same pattern as V→E with roles swapped

3. **`src/graphrag/algorithms/shgat/message-passing/edge-to-edge-phase.ts`**
   - For capability hierarchy levels (child → parent)

4. **`src/graphrag/algorithms/shgat/message-passing/vertex-to-vertex-phase.ts`**
   - NEW: `V2VParams`, `V2VForwardCache`, `V2VGradients`, `V2VPhaseResultWithCache` interfaces
   - NEW: `DEFAULT_V2V_PARAMS` constant
   - NEW: `forwardWithCache()` method with learnable residual/temperature
   - NEW: `backward()` method (simplified, skips cosine gradient)

5. **`src/graphrag/algorithms/shgat/message-passing/multi-level-orchestrator.ts`**
   - NEW: `MultiLevelBackwardCache`, `MultiLevelGradients`, `LevelParamsGradients` interfaces
   - NEW: `v2vCache` in `MultiLevelBackwardCache`
   - NEW: `v2vGrads` in `MultiLevelGradients`
   - NEW: `forwardMultiLevelWithCache()` with optional `v2vParams`
   - NEW: `backwardMultiLevel()` with optional `v2vParams`
   - Helper methods: `accumulateMatrix`, `accumulateVector`, `createEdgeToEdgePhaseForBackward`

6. **`src/graphrag/algorithms/shgat/message-passing/index.ts`**
   - NEW exports: `V2VParams`, `V2VForwardCache`, `V2VGradients`, `DEFAULT_V2V_PARAMS`

7. **`src/graphrag/algorithms/shgat.ts`**
   - NEW: `v2vParams: V2VParams` field
   - Modified `trainBatchV1KHead()` to pass `v2vParams` and apply V2V gradients
   - Modified `exportParams()` / `importParams()` for V2V persistence
   - NEW: `buildCapIndexToLevelMap()` - maps flat cap index to (level, withinLevelIdx)
   - NEW: `accumulateDCapGradient()` - routes gradients to correct level
   - NEW: `buildDEFinalFromAccum()` - converts to per-level format
   - NEW: `convertMPGradsToAccumFormat()` - adapts to existing gradient format
   - NEW: `computeMPGradNorm()` - computes MP gradient contribution

### Gradient Flow

```
Forward:
  H_init ──→ V→V ──→ V→E ──→ E^0 ──→ E→E ──→ E^1 ──→ ... ──→ E^L
                                     ↓
                              E→E (downward)
                                     ↓
                              E→V ──→ H_final ──→ K-head ──→ loss

Backward:
  loss ──→ K-head ──→ dCapEmbedding
                            ↓
  dE_final ←── (route to levels) ←── dCapEmbedding
       ↓
  E→V backward ──→ dE^0, dW, da
       ↓
  E→E downward backward ──→ dE^k, dW, da
       ↓
  V→E backward ──→ dH, dW, da
       ↓
  E→E upward backward ──→ accumulate dW, da
       ↓
  V→V backward ──→ dResidualLogit, dTemperatureLogit, dH_init
       ↓
  Apply gradients to levelParams + v2vParams
```

### Parameters Now Trained

| Component | Parameters | Shape |
|-----------|------------|-------|
| K-head | W_q, W_k | [scoringDim][embDim] per head |
| W_intent | W_intent | [hiddenDim][embDim] |
| Level 0 | W_child, W_parent | [numHeads][headDim][embDim] |
| Level 0 | a_upward, a_downward | [numHeads][2*headDim] |
| Level k | (same as Level 0) | (same) |
| V→V | residualLogit, temperatureLogit | 2 scalars |

## V→V Phase: Lightweight Trainable Parameters

The V→V co-occurrence phase now has **2 trainable scalar parameters** using logit transformations:

```typescript
interface V2VParams {
  residualLogit: number;      // sigmoid → β ∈ [0, 1]
  temperatureLogit: number;   // exp → T > 0
}

const DEFAULT_V2V_PARAMS: V2VParams = {
  residualLogit: Math.log(0.3 / 0.7),  // sigmoid⁻¹(0.3) ≈ -0.847
  temperatureLogit: 0.0,                // exp(0) = 1.0
};
```

### V2V Forward with Cache

```typescript
// Transform learnable parameters
const residualWeight = sigmoid(params.residualLogit);  // β
const temperature = exp(params.temperatureLogit);       // T

// Attention scores with temperature
score[i,j] = cosineSim(H[i], H[j]) * coocWeight[i,j] / temperature

// Softmax + aggregation
attention = softmax(scores)
aggregated[i] = Σ attention[j] * H[j]

// Residual connection + L2 norm
H'[i] = normalize(H[i] + β * aggregated[i])
```

### V2V Backward

Gradient flow (simplified, skips cosine gradient):

```
dH_enriched
     ↓
L2 norm backward: dPreNorm = (dH - y·(dH·y)) / ||preNorm||
     ↓
Residual backward: dH[i] += dPreNorm, dAggregated = β * dPreNorm
                   dResidualLogit += (dPreNorm · aggregated) * β * (1-β)
     ↓
Aggregation backward: dAttention[n] = dAggregated · H[neighbor]
                      dH[neighbor] += attention[n] * dAggregated
     ↓
Softmax backward: dScore = attention * (dAttention - Σ attention * dAttention)
     ↓
Temperature backward: dTemperatureLogit += dScore * (-score/T) * T
```

**Note**: Gradient through cosine similarity is skipped because:
1. Embeddings are typically frozen (pre-trained)
2. Attention gradient provides sufficient learning signal
3. Co-occurrence weights not stored in cache

### Integration

```typescript
// In orchestrator.forwardMultiLevelWithCache()
if (v2vParams && this.vertexToVertexPhase && this.cooccurrenceData) {
  const v2vResult = this.vertexToVertexPhase.forwardWithCache(H_init, cooccurrenceData, v2vParams);
  H_enriched = v2vResult.embeddings;
  v2vCache = v2vResult.cache;
}

// In orchestrator.backwardMultiLevel()
if (v2vParams && cache.v2vCache) {
  v2vGrads = this.vertexToVertexPhase.backward(dH, cache.v2vCache, v2vParams);
}

// In shgat.trainBatchV1KHead()
if (mpGrads.v2vGrads) {
  this.v2vParams.residualLogit -= lr * mpGrads.v2vGrads.dResidualLogit / batchSize;
  this.v2vParams.temperatureLogit -= lr * mpGrads.v2vGrads.dTemperatureLogit / batchSize;
}
```

### What V2V Learns

| Parameter | Controls | Initial | Range |
|-----------|----------|---------|-------|
| `residualLogit` | Mix original vs enriched | -0.847 (β=0.3) | β ∈ [0,1] |
| `temperatureLogit` | Attention sharpness | 0.0 (T=1.0) | T > 0 |

The co-occurrence weights from scraped n8n workflows remain **fixed** - only the mixing and temperature are learned.

## Trade-offs

### Advantages

1. **End-to-end training**: All learnable parameters receive gradients
2. **Message passing learns from loss**: Embeddings are shaped by what helps scoring
3. **Consistent architecture**: All phases follow same forward/backward pattern

### Disadvantages

1. **More computation**: Forward and backward through all phases
2. **Memory overhead**: Must cache intermediate activations
3. **Complexity**: Multi-level backward requires careful gradient routing

## Testing

```bash
# Type check
deno check src/graphrag/algorithms/shgat.ts

# Quick training test with V2V
deno eval "
import { createSHGATFromCapabilities } from './src/graphrag/algorithms/shgat.ts';

const caps = [
  { id: 'cap1', embedding: Array(1024).fill(0).map(() => Math.random()), toolsUsed: ['t1', 't2'], successRate: 0.8 },
  { id: 'cap2', embedding: Array(1024).fill(0).map(() => Math.random()), toolsUsed: ['t2', 't3'], successRate: 0.7 },
];

const shgat = createSHGATFromCapabilities(caps);

// Enable V2V with co-occurrence
shgat.setCooccurrenceData([
  { from: 0, to: 1, weight: 0.8 },
  { from: 1, to: 0, weight: 0.8 },
]);

const example = {
  intentEmbedding: Array(1024).fill(0).map(() => Math.random()),
  contextTools: ['t1'],
  candidateId: 'cap1',
  outcome: 1,
  negativeCapIds: ['cap2'],
};

const result = shgat.trainBatchV1KHead([example]);
console.log('gradNorm:', result.gradNorm);  // Includes MP + V2V gradients

const exported = shgat.exportParams();
console.log('V2V residualLogit:', exported.v2vParams.residualLogit);
console.log('V2V temperatureLogit:', exported.v2vParams.temperatureLogit);
"
```

## References

- GAT: Graph Attention Networks (Veličković et al., 2018)
- SHGAT: Super Hypergraph Attention Networks
- [Internal] ADR-055, ADR-056 for SHGAT training context
