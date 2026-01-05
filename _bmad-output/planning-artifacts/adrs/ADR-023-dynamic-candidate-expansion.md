# ADR-023: Dynamic Candidate Expansion for Hybrid Search

**Status:** ✅ Implemented **Date:** 2025-12-03

## Context

In ADR-022, we introduced Hybrid Search (Semantic + Graph) as the standard for tool discovery. A key
parameter in this process is the **Candidate Expansion Factor (K)**. Currently, we fetch `limit * 2`
candidates from the semantic search before re-ranking them with graph scores.

- **Problem**: A static factor of 2 is suboptimal.
  - In a **Cold Start** scenario (empty graph), fetching extra candidates is wasteful because the
    graph cannot boost them anyway. The semantic score is the only signal.
  - In a **Mature Graph** scenario, valuable tools might be semantically distant (e.g.,
    "npm_install" vs "deploy") and might not appear in the top `limit * 2`. We miss the opportunity
    to leverage the graph's intelligence.

## Decision

We will implement a **Dynamic Expansion Multiplier** based on graph maturity (density).

The logic will be: `search_limit = requested_limit * expansion_multiplier`

Where `expansion_multiplier` is calculated as:

| Graph State    | Density (Edges/MaxEdges) | Multiplier | Rationale                                                                             |
| :------------- | :----------------------- | :--------- | :------------------------------------------------------------------------------------ |
| **Cold Start** | < 0.01                   | **1.5x**   | Graph has little signal. Trust semantic search. Performance priority.                 |
| **Growing**    | 0.01 - 0.10              | **2.0x**   | Standard balance. Some graph patterns emerging.                                       |
| **Mature**     | > 0.10                   | **3.0x**   | Rich graph signals. Cast a wide net to find "hidden gems" (non-obvious dependencies). |

## Implementation Details

```typescript
private calculateExpansionMultiplier(): number {
  const nodeCount = this.graph.order;
  if (nodeCount < 2) return 1.0;

  const maxEdges = nodeCount * (nodeCount - 1); // Directed graph
  const density = this.graph.size / maxEdges;

  if (density < 0.01) return 1.5;
  if (density < 0.10) return 2.0;
  return 3.0;
}

// Usage in searchToolsHybrid
const multiplier = this.calculateExpansionMultiplier();
const candidates = await this.vectorSearch.searchTools(query, Math.ceil(limit * multiplier));
```

## Consequences

### Positive

- **Efficiency**: Saves resources when the graph is empty.
- **Discovery**: Drastically improves "serendipitous" discovery of related tools in mature systems.
- **Scalability**: The system adapts its computational effort to its intelligence level.

### Negative

- **Predictability**: The number of candidates processed varies over time, which might make
  debugging slightly inconsistent (a query might return different results as the graph grows).

## Compliance

- Extends ADR-022.
- Supports Story 5.1 (Hybrid Search).
