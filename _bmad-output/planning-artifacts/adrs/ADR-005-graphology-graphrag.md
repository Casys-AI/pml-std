# ADR-005: Graphology for GraphRAG (True Graph Algorithms)

**Status:** accepted **Date:** 2025-11-03 **Implementation:** done

## Decision

Use Graphology library for graph algorithms instead of pseudo-GraphRAG with recursive CTEs in
PostgreSQL.

## Context

User insight: "et networkx ou un truc comme ca?" (what about networkx or something like that?)

The system needs graph algorithms for:

- PageRank (tool importance)
- Community detection (tool clustering)
- Shortest path (dependency chains)
- Adamic-Adar (link prediction)

## Rationale

- Graphology is the "NetworkX of JavaScript" (~100KB)
- True graph algorithms: Real PageRank, Louvain community detection, bidirectional search
- 90% simpler SQL schema (just storage, no recursive CTEs)
- 3-5x performance improvement vs pseudo-SQL approach
- Hybrid architecture: PGlite stores data, Graphology computes metrics
- Better separation of concerns: Storage vs computation

## Consequences

### Positive

- Enables true GraphRAG capabilities for workflow suggestion
- Simplifies database schema dramatically
- Fast graph operations (<100ms PageRank, <1ms shortest path)
- Foundation for speculative execution (THE feature)
- Small dependency footprint (~100KB)

### Negative

- Graph must be loaded into memory
- Sync required between DB and in-memory graph

## Alternatives Considered

| Alternative                      | Reason Rejected                              |
| -------------------------------- | -------------------------------------------- |
| Recursive CTEs + pseudo-PageRank | 90% more complex SQL, 3-5x slower            |
| NetworkX (Python)                | Language barrier, would need Python runtime  |
| Neo4j                            | Breaks portability requirement               |
| No graph library                 | Would need to implement algorithms ourselves |

## Implementation

```typescript
import Graph from "graphology";
import pagerank from "graphology-metrics/centrality/pagerank";
import louvain from "graphology-communities-louvain";

const graph = new Graph();
graph.addNode("tool1", { name: "read_file" });
graph.addEdge("tool1", "tool2", { weight: 0.8 });

const ranks = pagerank(graph);
const communities = louvain(graph);
```
