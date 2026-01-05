# ADR-015: Dynamic Alpha Based on Graph Density

**Status:** ✅ Implemented **Date:** 2025-11-21 | **Story:** 5.1 (search_tools hybrid scoring)

## Context

The `search_tools` tool combines semantic similarity with graph-based relatedness using a weighted
formula:

```
finalScore = α × semanticScore + (1-α) × graphScore
```

The initial implementation used hardcoded thresholds:

- `edgeCount > 50` → α = 0.6
- `edgeCount > 10` → α = 0.8
- else → α = 1.0

This approach has limitations:

1. Arbitrary thresholds don't adapt to graph size
2. Step functions create discontinuities
3. Doesn't account for graph sparsity vs density

## Decision

Replace hardcoded thresholds with a density-based formula:

```typescript
const nodeCount = graphEngine.getStats().nodeCount;
const maxPossibleEdges = nodeCount * (nodeCount - 1); // directed graph
const density = maxPossibleEdges > 0 ? edgeCount / maxPossibleEdges : 0;
const alpha = Math.max(0.5, 1.0 - density * 2);
```

### Formula Behavior

| Nodes | Edges | Max Edges | Density | Alpha |
| ----- | ----- | --------- | ------- | ----- |
| 50    | 0     | 2450      | 0%      | 1.00  |
| 50    | 50    | 2450      | 2%      | 0.96  |
| 50    | 250   | 2450      | 10%     | 0.80  |
| 50    | 500   | 2450      | 20%     | 0.60  |
| 50    | 600+  | 2450      | 25%+    | 0.50  |

### Key Properties

1. **Smooth transition**: No step functions, gradual shift from semantic to hybrid
2. **Scale-invariant**: Adapts to graph size (50 nodes vs 500 nodes)
3. **Bounded**: α ∈ [0.5, 1.0] - semantic always contributes at least 50%
4. **Cold start safe**: α = 1.0 when density = 0

## Consequences

### Positive

- Better adaptation to actual graph richness
- Smooth degradation as graph grows
- No magic numbers to tune

### Negative

- Requires `nodeCount` in addition to `edgeCount`
- Slightly more computation (negligible)

## Related

- Story 5.1: search_tools implementation
- `docs/spikes/spike-search-tools-graph-traversal.md`
