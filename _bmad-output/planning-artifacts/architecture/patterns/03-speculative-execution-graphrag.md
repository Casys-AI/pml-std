## Pattern 3: Speculative Execution with GraphRAG (THE Feature)

> **ADRs:** ADR-005 (Graphology), ADR-006 (Speculative Execution), ADR-010 (Hybrid DAG), ADR-030
> (Gateway Real Execution)

**Problem:** Reduce latency by executing workflows optimistically before Claude responds, when
confidence is high enough.

**Vision:** The gateway should perform actions BEFORE Claude's call, not just suggest them. Have
results ready immediately when user confirms.

**Solution Architecture:**

**Components:**

1. **GraphRAG Engine** (`dag/builder.ts`)
   - Uses Graphology for true graph algorithms (not pseudo-SQL)
   - PageRank for tool importance ranking
   - Louvain community detection for related tools
   - Bidirectional shortest path for dependency chains
   - Hybrid: PGlite stores edges, Graphology computes metrics

2. **Three Execution Modes**
   - `explicit_required` (confidence < 0.70): No pattern found, Claude must provide explicit
     workflow
   - `suggestion` (0.70-0.85): Good pattern found, suggest DAG to Claude
   - `speculative_execution` (>0.85): High confidence, execute immediately and have results ready

3. **Adaptive Threshold Learning**
   - Start conservative (0.92 threshold)
   - Track success rates over 50-100 executions
   - Adjust thresholds based on user acceptance patterns
   - Target: >95% success rate, <10% waste

4. **Safety Checks**
   - Never speculate on dangerous operations (delete, deploy, payment, send_email)
   - Cost/resource limits (<$0.10 estimated cost, <5s execution time)
   - Graceful fallback to suggestion mode on failure

**Data Flow:**

```typescript
// User Intent → Gateway Handler
const intent = {
  naturalLanguageQuery: "Read all JSON files and create a summary report",
};

// Step 1: Vector search + GraphRAG suggestion
const suggestion = await suggester.suggestDAG(intent);
// { confidence: 0.92, dagStructure: {...}, explanation: "..." }

// Step 2: Mode determination
if (suggestion.confidence >= 0.85 && !isDangerous(suggestion.dagStructure)) {
  // 🚀 SPECULATIVE: Execute optimistically
  const results = await executor.execute(suggestion.dagStructure);

  return {
    mode: "speculative_execution",
    results: results, // Already executed!
    confidence: 0.92,
    note: "✨ Results prepared speculatively - ready immediately",
  };
}

// Step 3: Claude sees completed results in <300ms (vs 2-5s sequential execution)
```

**Graphology Integration:**

```typescript
import Graph from "npm:graphology";
import { pagerank } from "npm:graphology-metrics/centrality/pagerank";
import { louvain } from "npm:graphology-communities-louvain";
import { bidirectional } from "npm:graphology-shortest-path/bidirectional";

export class GraphRAGEngine {
  private graph: Graph;
  private pageRanks: Record<string, number> = {};

  async syncFromDatabase(): Promise<void> {
    // Load tool nodes and dependency edges from PGlite
    // Compute PageRank, communities
    this.pageRanks = pagerank(this.graph, { weighted: true });
  }

  findDependencyPath(from: string, to: string): string[] | null {
    return bidirectional(this.graph, from, to);
  }

  suggestWorkflow(intent: WorkflowIntent): SuggestedDAG {
    // Use vector search + graph metrics to suggest optimal DAG
    // PageRank = tool importance
    // Communities = related tools cluster
    // Paths = dependency chains
  }
}
```

**Performance Targets:**

- Graph sync from DB: <50ms
- PageRank computation: <100ms
- Shortest path query: <1ms
- Total suggestion time: <200ms
- Speculative execution: <300ms (4-5x faster than sequential)

**Database Schema:**

```sql
-- Simple storage, Graphology does the computation
CREATE TABLE tool_dependency (
  from_tool_id TEXT,
  to_tool_id TEXT,
  observed_count INTEGER,
  confidence_score REAL,
  PRIMARY KEY (from_tool_id, to_tool_id)
);

-- 90% simpler than recursive CTEs approach
-- Let Graphology handle PageRank, Louvain, paths
```

**Explainability:**

When Claude asks "why this DAG?", extract dependency paths:

```typescript
const explanation = {
  directDependencies: ["filesystem:read → json:parse"],
  transitiveDependencies: [
    "filesystem:read → json:parse → github:create (2 hops)",
  ],
  pageRankScores: {
    "filesystem:read": 0.15,
    "json:parse": 0.12,
  },
};
```

**Edge Cases:**

- Dangerous operations → Always fall back to suggestion mode with warning
- Low confidence (0.70-0.85) → Suggestion mode, let Claude decide
- Very low confidence (<0.70) → Explicit workflow required
- Speculative execution fails → Return error, fall back to suggestion

**Key Benefits:**

- **Latency:** 0ms perceived wait (results ready when user confirms)
- **Context savings:** Still applies ($5-10/day >> $0.50 waste)
- **User experience:** Feels instantaneous vs 2-5s sequential execution
- **Safety:** Multiple guardrails prevent dangerous speculation

**Affects Epics:** Epic 2 (Story 2.1 - GraphRAG + Speculative Execution)

**Design Philosophy:** Speculative execution is THE feature - the core differentiator. Not optional,
not opt-in. Default mode with smart safeguards.

---
