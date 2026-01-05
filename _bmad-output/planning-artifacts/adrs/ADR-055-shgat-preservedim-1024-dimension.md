# ADR-055: SHGAT PreserveDim - Keep d=1024 Throughout Message Passing

**Status:** Accepted **Date:** 2025-01-04 **Related:**

- ADR-038 (Scoring Algorithms Reference)
- ADR-050 (SuperHyperGraph Edge Constraints)

## Problem

K-head attention scoring produces nearly identical scores (~0.6) for all capabilities, destroying discriminative information from embeddings.

- Pure cosine similarity: **MRR=1.000** (100% Hit@1)
- K-head with propagated embeddings: **MRR=0.148** (4.9% Hit@1)

## Root Causes Identified

### 1. W_q ≠ W_k Random Initialization

When W_q and W_k are different random matrices:
- Q = W_q @ intent → projects to random subspace A
- K = W_k @ cap → projects to random subspace B
- Q·K has no relationship to original cosine similarity

**Fix applied**: Use shared projection `W_q = W_k` in `initialization/parameters.ts`

**Result**: MRR improved from 0.065 to 0.980 (when using original 1024-dim embeddings)

### 2. Dimension Mismatch in computeHeadScoreV1

```typescript
// In shgat.ts:884-907
private computeHeadScoreV1(intentProjected, capEmbedding, headIdx) {
  const inputDim = Math.min(intentProjected.length, capEmbedding.length, hiddenDim);
  // = min(64, 64, 64) = 64

  for (let j = 0; j < inputDim; j++) {  // Only uses first 64 columns!
    Q[i] += hp.W_q[i][j] * intentProjected[j];
    K[i] += hp.W_k[i][j] * capEmbedding[j];
  }
}
```

| Component | Expected Dim | Actual Dim |
|-----------|-------------|------------|
| W_q, W_k | [64][1024] | [64][1024] ✓ |
| intentProjected | 1024 | 64 (after W_intent) |
| capEmbedding | 1024 | 64 (after message passing) |

**Result**: 94% of W_q/W_k weights are ignored (only first 64 of 1024 columns used)

## Message Passing Analysis

Message passing IS working correctly:
- Incidence matrix: 33 tools × 58 capabilities, 88 connections
- Similarity range INCREASES after message passing: [0.53, 0.85] → [-0.23, 0.77]
- But norms decrease: 1.0 → 0.16 (6x reduction)

The issue is the dimension mismatch, not message passing itself.

## Benchmark Results

| Configuration | MRR | Hit@1 |
|--------------|------|-------|
| Cosine BGE-only (baseline) | 1.000 | 100% |
| K-head + propagated 64-dim | 0.148 | 4.9% |
| K-head + original 1024-dim + W_q≠W_k | 0.065 | 1.6% |
| K-head + original 1024-dim + W_q=W_k | 0.980 | 95.9% |
| Shared projection W_q=W_k | 1.000 | 100% |
| Orthogonal projection | 1.000 | 100% |

## Message Passing Dimension Flow

Understanding how dimensions change through the pipeline:

```
ENTRÉE:
  Tools H_init:  [33 tools][1024-dim]   ← embeddings BGE originaux
  Caps E_init:   [58 caps][1024-dim]    ← embeddings BGE originaux

UPWARD PASS (per head, then concat):
  Level 0: H[1024] → W_child[headDim][1024] → [headDim] per head
           E[1024] → W_parent[headDim][1024] → [headDim] per head
           concatHeads → [numHeads × headDim] = [64]

  Level 1+: E_prev[64] → same process → [64]

DOWNWARD PASS:
  Level k: E[64] → projection → [64]
           + residual E_pre[64]  ← INTRA-layer residual (already exists)
           = E_new[64]

SORTIE FINALE:
  H: [33 tools][64-dim]   ← no longer 1024-dim!
  E: [58 caps][64-dim]    ← no longer 1024-dim!
```

The existing residual connection (line 382-383 in multi-level-orchestrator.ts) is **intra-layer** (64 + 64), not a skip-connection to original 1024-dim embeddings.

## Proposed Solutions

### Option A: Use original 1024-dim for K-head scoring
- Bypass projectIntent, use raw intentEmbedding
- Bypass message passing output, use original cap.embedding
- Works (MRR=0.980) but **doesn't benefit from message passing**

### Option B: Change W_q/W_k to [64][64]
- Match dimensions with projected/propagated embeddings
- Smaller model, fewer parameters
- **Still loses discriminative info** (already compressed to 64-dim)

### Option C: Simple residual connection
```typescript
final_emb = α * propagated_emb + (1-α) * original_emb
```
- **Problem**: Dimensions don't match (64 vs 1024)
- Would require padding or projection, which defeats the purpose

### Option D: Dual-Path Scoring with Local Alpha (RECOMMENDED)

Instead of mixing embeddings, **mix scores** from two parallel paths:

```typescript
// Semantic path: uses original 1024-dim embeddings
score_semantic = kHeadScore(intent, cap.embedding);      // Full discriminability

// Structure path: uses propagated 64-dim embeddings
score_structure = kHeadScore(intentProj, E[cIdx]);       // Graph structure

// Local Alpha controls the mix per-capability
final_score = α * score_semantic + (1 - α) * score_structure;
```

**Key insight**: Reuse the existing **Local Alpha** system (ADR-048) which already calculates per-node confidence in graph vs semantic:

- `α = 1.0` → Pure semantic (don't trust graph)
- `α = 0.5` → Maximum graph trust

#### Local Alpha Algorithms

| Situation | Algorithm | Alpha | Effect |
|-----------|-----------|-------|--------|
| Cold start (< 5 observations) | Bayesian | ~1.0 | Trust semantic |
| Dense zone, coherent | Embeddings Hybrides | ~0.6 | Balanced mix |
| Sparse zone, isolated | Heat Diffusion | ~0.9 | Trust semantic |
| Capability with hierarchy | Heat Hierarchical | variable | Parent→child propagation |

#### Implementation Sketch

```typescript
// In scoreAllCapabilities:
const localAlphaCalculator = new LocalAlphaCalculator(deps);

for (const [capId, cap] of capabilityNodes) {
  const cIdx = this.graphBuilder.getCapabilityIndex(capId)!;

  // Get per-capability alpha from Local Alpha system
  const { alpha, algorithm } = localAlphaCalculator.getLocalAlphaWithBreakdown(
    "active",
    capId,
    "capability",
    contextToolIds
  );

  // Dual-path K-head scoring
  // Path 1: Semantic (original 1024-dim, full W_q/W_k usage)
  const headScores_semantic = this.computeMultiHeadScoresV1(
    intentEmbedding,    // 1024-dim
    cap.embedding       // 1024-dim original
  );

  // Path 2: Structure (propagated 64-dim, needs W_q/W_k [64][64])
  const headScores_structure = this.computeMultiHeadScoresV1_64(
    intentProjected,    // 64-dim
    E[cIdx]             // 64-dim propagated
  );

  // Fuse with Local Alpha
  const headScores = headScores_semantic.map((sem, h) =>
    alpha * sem + (1 - alpha) * headScores_structure[h]
  );

  const avgScore = headScores.reduce((a, b) => a + b, 0) / numHeads;
  // ...
}
```

#### Advantages of Dual-Path + Local Alpha

1. **No dimension mixing**: Each path uses appropriate dimensions
2. **Adaptive per-capability**: Not a fixed α for all nodes
3. **Cold start handling**: Bayesian prior → trust semantic until enough observations
4. **Density-aware**: Heat diffusion → sparse nodes trust semantic more
5. **Coherence-aware**: Embeddings Hybrides → if graph matches semantics, trust graph more
6. **Already implemented**: Local Alpha exists in `src/graphrag/local-alpha.ts`

#### Required Changes

1. Add `computeMultiHeadScoresV1_64()` with W_q/W_k [64][64] for structure path
2. Or keep single W_q/W_k [64][1024] and use first 64 cols for structure path
3. Integrate LocalAlphaCalculator into SHGAT scoring
4. Add `score_semantic`, `score_structure`, `alpha` to AttentionResult for observability

## ✅ SOLUTION: Keep d=1024 Throughout Message Passing (Option E)

### The Fix

Following the HGAT paper specification where H^(l), E^(l) ∈ R^(N×d) maintain the **same dimension d** throughout all layers:

```typescript
// BEFORE (broken): 1024 → 64 compression
W_child: [headDim][1024]  // headDim=16, numHeads=4
concatHeads → [64]        // Loses 94% of information!

// AFTER (fixed): Keep d=1024 throughout
W_child: [1024][1024]     // Identity-like projection
W_parent: [1024][1024]    // Identity-like projection
Output: [1024]            // Preserves discriminability
```

### Benchmark Results (2025-01-04)

| Configuration | MRR | Hit@1 | Score Range |
|--------------|------|-------|-------------|
| MP 64-dim (broken) | 0.053 | 0.8% | [0.498, 0.502] |
| **MP 1024-dim** | **1.000** | **100%** | [0.566, 0.627] |
| MP 1024-dim residual=0.0 | 0.836 | 72.1% | - |
| MP 1024-dim residual=0.2+ | 1.000 | 100% | - |

**Key insight**: Score range increased from **0.004** (no discriminability) to **0.061** (15x improvement).

### Why It Works

1. **HGAT paper compliance**: Original paper specifies same dimension throughout
2. **Information preservation**: 1024-dim → 1024-dim keeps all semantic info
3. **Graph structure injection**: Message passing still aggregates neighbor info
4. **K-head scoring works**: W_q/W_k [hiddenDim][1024] can now use full 1024 columns

### Implementation Notes

```typescript
// Identity-like projection preserves original while allowing learning
const createIdentityLike = (): number[][] => {
  return Array.from({ length: 1024 }, (_, i) =>
    Array.from({ length: 1024 }, (_, j) =>
      i === j ? 1.0 : (random() - 0.5) * 0.01
    )
  );
};

// Message passing with residual (recommended: residual ≥ 0.2)
const E_final = E_propagated.map((e, idx) =>
  e.map((v, i) => (1 - residual) * v + residual * E_original[idx][i])
);
```

### Residual Connection Analysis

| Residual Weight | MRR | Hit@1 | Note |
|----------------|------|-------|------|
| 0.0 (pure propagated) | 0.836 | 72.1% | Some info loss from aggregation |
| 0.2 | 1.000 | 100% | ✓ Sweet spot |
| 0.4-0.8 | 1.000 | 100% | ✓ All work well |
| 1.0 (pure original) | 1.000 | 100% | No graph benefit |

**Recommendation**: Use residual weight 0.2-0.5 to balance graph structure with original semantics.

## Files Modified

- `src/graphrag/algorithms/shgat/initialization/parameters.ts`: W_q = W_k fix
- `src/graphrag/algorithms/shgat.ts`: preserveDim mode implementation
- `tests/benchmarks/e2e-pipeline.bench.ts`: Investigation spikes + 1024-dim MP tests

## ✅ FINAL IMPLEMENTATION (2025-01-04)

The `preserveDim` mode is now fully implemented with these key components:

### 1. Config option `preserveDim: true`

```typescript
const shgat = createSHGATFromCapabilities(caps, new Map(), {
  preserveDim: true,       // Enable 1024-dim preservation
  preserveDimResidual: 0.3 // 30% original + 70% propagated (default)
});
// hiddenDim is now adaptive: numHeads * 16 (headDim=16 fixed)
```

### 2. Message passing keeps 1024-dim

- `initializeLevelParametersPreserveDim()` creates W_child/W_parent with output=1024
- After concat heads: numHeads × headDim = numHeads × 256 = 1024

### 3. K-head scoring projects 1024 → hiddenDim (adaptive)

- **hiddenDim = numHeads × 16** (headDim=16 is standard, fixed)
- With 4 heads: hiddenDim=64, with 8 heads: hiddenDim=128, etc.
- W_q/W_k: [hiddenDim][1024] - projects 1024-dim to hiddenDim
- Q = W_q @ intent(1024) → hiddenDim
- K = W_k @ cap(1024) → hiddenDim
- score = sigmoid(Q·K / sqrt(hiddenDim))

### 4. Residual to original embeddings

```typescript
// In forward(), after message passing:
if (preserveDim) {
  E_final = (1-r) * E_propagated + r * E_original
  // Normalize to unit vector
}
```

### 5. Skip W_intent projection

```typescript
// In scoreAllCapabilities():
const intentForScoring = config.preserveDim
  ? intentEmbedding        // Use raw 1024-dim
  : projectIntent(intent); // Project to 64-dim
```

### Test Results

```
PreserveDim SHGAT:
  hiddenDim (scoring): 64, numHeads: 4
  W_q dims: [64][1024]
  Scores: cap1=0.5956, cap2=0.5063, cap3=0.4964
  Top: cap1 ✓
  Score range: 0.0992 (good discriminability)
```

## Next Steps

1. [x] Validate 1024-dim message passing in benchmark
2. [x] Update SHGAT to keep d=1024 throughout pipeline
3. [x] Implement preserveDim mode with residual connection
4. [ ] Re-run full benchmark suite with production SHGAT preserveDim=true
5. [x] **Re-test Node2Vec with preserveDim** - TESTED 2025-01-04
   - Hypothesis: Node2Vec might help with preserveDim + residual
   - **Result: HYPOTHESIS INVALIDATED**

   | Config | MRR | Hit@1 | Note |
   |--------|-----|-------|------|
   | BGE-M3 seul | 0.391 | 20.9% | **Best** |
   | BGE+Node2Vec (standard) | 0.310 | 14.0% | -21% degradation |
   | BGE+Node2Vec+ (γ=0.5) | 0.364 | 20.9% | -7% degradation |

   Node2Vec embeddings dilute semantic similarity from BGE even with preserveDim.
   The issue is fundamental: graph structure ≠ semantic similarity for MCP tools.