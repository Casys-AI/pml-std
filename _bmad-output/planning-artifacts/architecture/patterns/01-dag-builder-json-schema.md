## Pattern 1: DAG Builder with JSON Schema Dependency Detection

> **ADRs:** ADR-002 (Custom DAG), ADR-010 (Hybrid DAG Architecture), ADR-022 (Hybrid Search
> Integration)

**Problem:** Automatically detect dependencies between MCP tools to enable parallel execution
without manual dependency specification.

**Challenge:** MCP tools expose input/output schemas as JSON Schema. Need to infer which outputs
feed into which inputs semantically.

**Solution Architecture:**

**Components:**

1. **Schema Analyzer** (`dag/builder.ts`)
   - Parses JSON Schema for each tool
   - Extracts parameter names and types
   - Identifies required vs optional parameters

2. **Dependency Detector**
   - Matches output property names to input parameter names (string matching)
   - Type compatibility check (string → string, object → object, etc.)
   - Builds directed edge if `tool_A.output.property` matches `tool_B.input.param`

3. **DAG Constructor**
   - Nodes: Tool invocations with inputs
   - Edges: Data flow dependencies
   - Cycle detection (invalid DAG → error)
   - Topological sort for execution order

**Data Flow:**

```typescript
// Example: 3 tools workflow
Tool A (filesystem:read) → output: { content: string }
Tool B (json:parse)      → input: { jsonString: string }, output: { parsed: object }
Tool C (github:create)   → input: { data: object }

// Detected dependencies:
A.output.content → B.input.jsonString  (string → string match)
B.output.parsed  → C.input.data        (object → object match)

// DAG:
A → B → C (sequential execution required)
```

**Implementation Guide for Agents:**

```typescript
interface DAGNode {
  toolId: string;
  inputs: Record<string, unknown>;
  dependencies: string[]; // Tool IDs this node depends on
}

interface DAGEdge {
  from: string; // Source tool ID
  to: string; // Target tool ID
  dataPath: string; // e.g., "output.content → input.jsonString"
}

// Story 2.1 AC: Custom topological sort (no external deps)
function buildDAG(tools: Tool[]): { nodes: DAGNode[]; edges: DAGEdge[] } {
  // 1. Analyze schemas
  // 2. Detect dependencies via name/type matching
  // 3. Construct graph
  // 4. Validate (no cycles)
  // 5. Topological sort
}
```

**Edge Cases:**

- No dependencies → All tools run in parallel
- Partial dependencies → Mixed parallel/sequential
- Circular dependencies → Reject workflow, return error
- Ambiguous matches → Conservative (assume dependency)

### Hybrid Search Integration (ADR-022)

The DAGSuggester uses Hybrid Search (Semantic + Graph) to find relevant tools:

```typescript
async searchToolsHybrid(
  query: string,
  limit: number = 10,
  contextTools: string[] = []
): Promise<HybridSearchResult[]> {
  // 1. Semantic Search (Base) - finds textually relevant tools
  const semanticResults = await this.vectorSearch.searchTools(query, limit * 2);

  // 2. Adaptive Alpha Calculation (graph density)
  const alpha = this.calculateAdaptiveAlpha();

  // 3. Graph Scoring (Adamic-Adar + Neighbors)
  return semanticResults.map(tool => {
    const graphScore = this.computeGraphRelatedness(tool.id, contextTools);
    // Hub tools (high PageRank) get boosted
    const finalScore = (alpha * tool.score) + ((1 - alpha) * graphScore);
    return { ...tool, score: finalScore };
  });
}
```

**Benefits:**

- Finds implicit dependencies (e.g., `npm_install` between `git_clone` and `deploy`)
- Graph intelligence bubbles related tools into candidates
- Reduces "fragile DAGs" for complex intents

**Affects Epics:** Epic 2 (Story 2.1, 2.2), Epic 5 (Story 5.1)

---
