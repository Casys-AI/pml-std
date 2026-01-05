# ADR-024: Full Adjacency Matrix for Dependency Resolution

**Status:** ✅ Implemented **Date:** 2025-12-03

## Context

The current `buildDAG` algorithm uses a "greedy triangular" approach: it only checks dependencies
between a candidate tool and tools that appear _before_ it in the list (`j < i`).

This creates a critical **Ordering Bias**:

- If `Parent` appears _after_ `Child` in the candidate list (e.g., because `Child` has a better
  semantic match to the user query), the dependency is missed.
- Result: Both run in parallel → `Child` fails.

With the introduction of **Hybrid Search (ADR-022)**, this risk increases significantly. Hybrid
Search injects graph-related tools (often prerequisites like `install` or `auth`) into the list, but
their ranking might be lower than the main intent tools.

## Decision

We will replace the triangular loop with a **Full Adjacency Matrix** approach for DAG construction.

### Algorithm Change

**Current (Fragile):**

```typescript
for (let i = 0; i < candidates.length; i++) {
  for (let j = 0; j < i; j++) {
    // Only looks backwards
    if (hasPath(candidates[j], candidates[i])) {
      candidates[i].dependsOn.push(candidates[j]);
    }
  }
}
```

**Proposed (Robust):**

```typescript
// 1. Build Adjacency Matrix (N*N)
for (let i = 0; i < candidates.length; i++) {
  for (let j = 0; j < candidates.length; j++) {
    if (i === j) continue; // Skip self

    // Check path in BOTH directions regardless of list order
    if (hasPath(candidates[j], candidates[i])) {
      candidates[i].dependsOn.push(candidates[j]);
    }
  }
}

// 2. Detect & Break Cycles (Topological Sort)
// Since we check all pairs, we might discover cycles (A->B and B->A).
// We must run a cycle breaker (e.g., keep the edge with higher weight/confidence).
```

## Consequences

### Positive

- **Order Independence**: The DAG structure is now determined solely by the graph topology, not by
  the arbitrary sort order of the search results.
- **Synergy with Hybrid Search**: Perfectly handles cases where "Prerequisites" are discovered by
  the graph but ranked lower than "Goals".
- **Correctness**: Eliminates the "Parallel Execution Crash" for inverted parent/child pairs.

### Negative

- **Complexity**: Requires cycle detection/breaking logic (which wasn't needed with the triangular
  loop as it structurally prevented cycles).
- **Performance**: O(N²) comparisons instead of O(N²/2). Negligible for small N (top 10-20 tools).

## Compliance

- Essential companion to ADR-022 (Hybrid Search).
- Fixes the vulnerability identified in Spike `2025-11-26-dag-suggester-dependency-analysis`.
