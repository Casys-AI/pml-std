# Spike: Node2Vec + Local Alpha Integration

**Date:** 2026-01-01 **Status:** Exploration **Author:** Erwan + Claude

## Context

Benchmark results from `hybrid-embeddings.ts` spike showed:

| Méthode | MRR | Amélioration |
|---------|-----|--------------|
| BGE seul | 0.041 | baseline |
| BGE + Node2Vec | 0.355 | +757% |
| BGE + Spectral | < 0.355 | moins bon |

Node2Vec outperforms spectral embeddings for capability/tool matching because it captures **local co-occurrence patterns** (random walks) rather than global community structure (eigenvectors).

## Current Architecture: Local Alpha (ADR-048)

We already have adaptive semantic/structural weighting via `local-alpha.ts`:

```
alpha=1.0 → Pure semantic (BGE only)
alpha=0.5 → Equal weight (max graph influence)
```

Algorithms by mode:
- **Active Search**: Embeddings Hybrides (Pearson correlation semantic vs structural)
- **Passive Suggestion**: Heat Diffusion (context propagation)
- **Cold Start**: Bayesian (prior-based uncertainty)

Current structural signal: **spectral embeddings** + edge weights

## Problem

Local alpha uses spectral embeddings for structural similarity, but benchmark proved Node2Vec is superior. The two systems are complementary:

1. **Hybrid embeddings**: WHAT vectors to compare (BGE + Node2Vec)
2. **Local alpha**: HOW MUCH to trust the comparison (dynamic per-node weight)

## Proposed Integration

### Replace Spectral with Node2Vec in Local Alpha

```typescript
// local-alpha.ts - computeAlphaEmbeddingsHybrides()

// Before (spectral - edge weight only)
const structuralSim = this.getEdgeWeight(nodeId, neighbor);

// After (Node2Vec - richer signal)
const structuralSim = cosineSimilarity(
  node2vecEmbeddings[nodeId],
  node2vecEmbeddings[neighbor]
);
```

### Adaptive Weight Based on Usage

```typescript
function computeWeights(capability: Capability): { bge: number; node2vec: number } {
  const usage = capability.usageCount;

  // More traces → more trust in Node2Vec
  // Fewer traces → fallback to semantic (BGE)
  const node2vecWeight = Math.min(0.8, usage / 100);
  const bgeWeight = 1.0 - node2vecWeight;

  return { bge: bgeWeight, node2vec: node2vecWeight };
}
```

### Full Pipeline

```
                         ┌─────────────────────────────┐
                         │       Local Alpha           │
                         │  (Pearson correlation)      │
Texte ──→ BGE ───────────┤                             ├──→ Score final
         (semantic)      │   coherence(sem, struct)    │
                         │   → alpha ∈ [0.5, 1.0]      │
Graph ──→ Node2Vec ──────┤                             │
         (structural)    │   high coherence → low α    │
                         │   low coherence → high α    │
                         └─────────────────────────────┘
```

## Implementation Challenges

### Live Learning

Node2Vec depends on full graph structure. When new capability is added:

1. Graph changes (new node + edges)
2. Node2Vec embeddings become stale
3. Need to recompute (expensive) or approximate (fast but less accurate)

**Options:**
- **Full recompute**: On startup or periodically (hourly)
- **Incremental**: Approximate new node embedding from neighbors
- **CasysDB GDS**: Native Rust implementation, 100x faster

### Storage

| Approach | Pros | Cons |
|----------|------|------|
| In-memory only | Simple, no persistence | Recompute at startup |
| Store in DB | Fast startup | Stale on graph change |
| CasysDB | Native, fast, PITR | Needs GDS implementation |

## Recommendation

### Short-term (now)
- Keep hybrid embeddings spike code (`hybrid-embeddings.ts`)
- Don't integrate yet (live learning complexity)
- Local alpha continues with spectral (good enough for now)

### Medium-term (CasysDB)
1. Implement Node2Vec in `crates/casys_engine/src/gds/` (~200 lines Rust)
2. Implement HNSW in `crates/casys_engine/src/ann/` (~100 lines Rust)
3. Expose via napi bindings
4. Replace spectral with Node2Vec in local-alpha.ts
5. Store embeddings in CasysDB with PITR for versioning

### Architecture Target

```
PostgreSQL              CasysDB                    SHGAT
┌──────────────┐       ┌──────────────┐          ┌──────────────┐
│ capabilities │──sync─│ Node2Vec     │──embed──→│ K-head       │
│ embeddings   │       │ GDS          │          │ attention    │
│ (BGE)        │       │              │          │              │
└──────────────┘       │ HNSW index   │←─query──│ scoring      │
                       │              │          │              │
                       │ Local Alpha  │──alpha──→│ fusion       │
                       └──────────────┘          └──────────────┘
```

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-01-01 | Defer hybrid embeddings integration | Live learning complexity, needs CasysDB GDS |
| 2026-01-01 | Keep local alpha with spectral | Works for now, Node2Vec is optimization |
| 2026-01-01 | Plan Node2Vec in CasysDB GDS | O(n²) TS too slow, Rust 100x faster |

## References

- `src/graphrag/hybrid-embeddings.ts` - Node2Vec spike implementation
- `src/graphrag/local-alpha.ts` - Current adaptive alpha (ADR-048)
- `src/graphrag/spectral-clustering.ts` - Current structural embeddings
- ADR-048: Local Adaptive Alpha
- Benchmark: +757% MRR with Node2Vec vs BGE-only
