# ADR-022: Hybrid Search Integration in DAG Suggester

**Status:** ✅ Implemented **Date:** 2025-11-27

## Context

Currently, the `DAGSuggester` relies solely on `VectorSearch` (semantic similarity) to select
candidate tools for a workflow.

- **Pros**: Finds tools that textually match the user intent.
- **Cons**: Misses intermediate or related tools that are logically necessary but not explicitly
  described (e.g., finding `git_clone` and `deploy` but missing `npm_install`).

Meanwhile, Story 5.1 implemented a powerful "Hybrid Search" logic (Semantic + Adamic-Adar + Graph
Neighbors) inside the `pml:search_tools` MCP tool. This logic is currently trapped inside the
`GatewayServer` handler and is not reused by the `DAGSuggester`.

This disconnect leads to "fragile DAGs" for complex requests, where critical intermediate steps are
omitted because they weren't semantically prominent in the prompt.

## Decision

We will refactor the search architecture to make Hybrid Search the default standard for internal
tool discovery.

1. **Extract Logic**: Move the hybrid search logic (Semantic + Adaptive Alpha + Adamic-Adar +
   Neighbors) from `GatewayServer.handleSearchTools` into a reusable method in `GraphRAGEngine`
   (e.g., `searchToolsHybrid`).
2. **Update DAGSuggester**: Replace the direct usage of `vectorSearch.searchTools` with
   `graphEngine.searchToolsHybrid` in the `suggestDAG` method.
3. **Deprecate Direct Vector Search**: Mark direct usage of `VectorSearch` as discouraged for
   high-level discovery features.

## Detailed Design

### 1. New Method in `GraphRAGEngine`

```typescript
async searchToolsHybrid(
  query: string,
  limit: number = 10,
  contextTools: string[] = []
): Promise<HybridSearchResult[]> {
  // 1. Semantic Search (Base)
  const semanticResults = await this.vectorSearch.searchTools(query, limit * 2);

  // 2. Adaptive Alpha Calculation
  const alpha = this.calculateAdaptiveAlpha();

  // 3. Graph Scoring (Adamic-Adar + Neighbors)
  return semanticResults.map(tool => {
    const graphScore = this.computeGraphRelatedness(tool.id, contextTools);
    // Boost score if tool is a known "hub" (high PageRank) or bridge
    const finalScore = (alpha * tool.score) + ((1 - alpha) * graphScore);
    return { ...tool, score: finalScore };
  });
}
```

### 2. Impact on DAG Suggester

The `suggestDAG` method will now benefit from graph intelligence during candidate selection:

- Input: "Deploy to prod"
- Vector finds: `deploy_prod`
- Hybrid boost: Sees `deploy_prod` is strongly linked to `npm_install` via Adamic-Adar.
- Result: `npm_install` is bubbled up into the top candidates list, allowing `buildDAG` to wire it
  correctly.

## Consequences

### Positive

- **Smarter Suggestions**: The system will infer implicit dependencies (missing links) much better.
- **Code Reusability**: The advanced search logic is centralized, serving both the MCP tool and the
  internal Suggester.
- **Robustness**: Reduces the "Cold Start" failure rate for complex intents.

### Negative

- **Performance**: Computing Adamic-Adar for every suggestion adds a slight overhead (estimated
  <20ms).
- **Complexity**: Debugging why a tool was selected becomes harder (is it semantic? or graph?). We
  must keep detailed logs/reasoning.

## Compliance

- This change aligns with the "Intelligent Tool Discovery" goal of Epic 5.
- It respects the "Graceful Degradation" principle (falls back to semantic if graph is empty).
