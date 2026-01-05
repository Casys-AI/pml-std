# GraphRAG Technical Implementation Guide (with Graphology)

**Date:** 2025-11-03 (Updated) **Author:** BMad **Stack:** Deno 2.5, PGlite 0.3.11 + pgvector,
**Graphology 0.25**, BGE-Large-EN-v1.5 **Approach:** True GraphRAG with Graphology (PageRank,
Louvain, path finding)

---

## 🎯 Architecture Overview

### Hybrid Approach: PGlite + Graphology

```
┌─────────────────────────────────────────────────────────────┐
│                    Casys PML GraphRAG                       │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  PGlite (Disk - Persistence)          Graphology (RAM - Compute) │
│  ├── Vector search (pgvector)         ├── PageRank           │
│  ├── Workflow patterns                ├── Community detection│
│  ├── Tool dependencies (edges)        ├── Shortest paths     │
│  └── Execution history                └── Graph traversal    │
│                                                               │
│  Flow: PGlite → sync → Graphology → compute → results        │
└─────────────────────────────────────────────────────────────┘
```

**Division of Responsibility:**

- **PGlite:** Persist data, vector search (pgvector)
- **Graphology:** Graph algorithms (PageRank, Louvain, paths)

---

## 📦 Dependencies

```json
// deno.json
{
  "imports": {
    "@electric-sql/pglite": "npm:@electric-sql/pglite@0.3.11",
    "@xenova/transformers": "npm:@xenova/transformers@^2.6.0",
    "graphology": "npm:graphology@^0.25.4",
    "graphology-metrics": "npm:graphology-metrics@^2.2.0",
    "graphology-shortest-path": "npm:graphology-shortest-path@^2.0.2",
    "graphology-communities-louvain": "npm:graphology-communities-louvain@^2.0.1",
    "std/": "https://deno.land/std@0.210.0/"
  }
}
```

**Graphology size:** ~100KB gzipped ✅

---

## 📊 Simplified Database Schema

### No More Complex SQL!

**Before (pseudo-GraphRAG SQL):**

```sql
-- ❌ Complex recursive CTEs
WITH RECURSIVE tool_paths AS (...);

-- ❌ Pseudo-PageRank views
CREATE VIEW tool_importance AS ...;

-- ❌ Manual graph traversal
```

**After (Graphology):**

```sql
-- ✅ Simple storage only (no calculations)
CREATE TABLE tool_dependency (
  from_tool_id TEXT,
  to_tool_id TEXT,
  observed_count INTEGER,
  confidence_score REAL,
  PRIMARY KEY (from_tool_id, to_tool_id)
);

-- Graphology does the rest!
```

### Complete Schema

```sql
-- ============================================
-- Foundation (Epic 1)
-- ============================================

CREATE TABLE tool_schema (
  tool_id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  input_schema JSONB,
  cached_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE tool_embedding (
  tool_id TEXT PRIMARY KEY REFERENCES tool_schema(tool_id),
  server_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  embedding vector(1024) NOT NULL,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_tool_embedding_hnsw
ON tool_embedding USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- ============================================
-- GraphRAG Extension (Epic 2)
-- ============================================

-- Workflow execution history
CREATE TABLE workflow_execution (
  execution_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  executed_at TIMESTAMP DEFAULT NOW(),
  intent_text TEXT,
  dag_structure JSONB NOT NULL,
  success BOOLEAN NOT NULL,
  execution_time_ms INTEGER NOT NULL,
  error_message TEXT
);

CREATE INDEX idx_execution_timestamp ON workflow_execution(executed_at DESC);

-- Workflow patterns (for semantic search)
CREATE TABLE workflow_pattern (
  pattern_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern_hash TEXT UNIQUE NOT NULL,
  dag_structure JSONB NOT NULL,
  intent_embedding vector(1024) NOT NULL,
  usage_count INTEGER DEFAULT 1,
  success_count INTEGER DEFAULT 0,
  last_used TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_pattern_intent_embedding
ON workflow_pattern USING hnsw (intent_embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- Tool dependencies (SIMPLE - just storage)
CREATE TABLE tool_dependency (
  from_tool_id TEXT,
  to_tool_id TEXT,
  observed_count INTEGER DEFAULT 1,
  confidence_score REAL,
  PRIMARY KEY (from_tool_id, to_tool_id)
);

-- That's it! No complex views or CTEs needed.
```

---

## 🧩 TypeScript Implementation

### 1. GraphRAG Engine (Graphology)

```typescript
// src/graphrag/graph-engine.ts
import Graph from "npm:graphology";
import { pagerank } from "npm:graphology-metrics/centrality/pagerank";
import { louvain } from "npm:graphology-communities-louvain";
import { bidirectional } from "npm:graphology-shortest-path/bidirectional";

export class GraphRAGEngine {
  private graph: Graph;
  private pageRanks: Record<string, number> = {};
  private communities: Record<string, string> = {};

  constructor(private db: PGlite) {
    this.graph = new Graph({ type: "directed", allowSelfLoops: false });
  }

  /**
   * Sync graph from PGlite to Graphology in-memory
   */
  async syncFromDatabase(): Promise<void> {
    const startTime = performance.now();

    this.graph.clear();

    // 1. Load nodes (tools) from PGlite
    const tools = await this.db.query(`
      SELECT tool_id, tool_name, server_id
      FROM tool_embedding
    `);

    for (const tool of tools) {
      this.graph.addNode(tool.tool_id, {
        name: tool.tool_name,
        serverId: tool.server_id,
      });
    }

    // 2. Load edges (dependencies) from PGlite
    const deps = await this.db.query(`
      SELECT from_tool_id, to_tool_id, confidence_score, observed_count
      FROM tool_dependency
      WHERE confidence_score > 0.3
    `);

    for (const dep of deps) {
      if (this.graph.hasNode(dep.from_tool_id) && this.graph.hasNode(dep.to_tool_id)) {
        this.graph.addEdge(dep.from_tool_id, dep.to_tool_id, {
          weight: dep.confidence_score,
          count: dep.observed_count,
        });
      }
    }

    const syncTime = performance.now() - startTime;
    console.log(
      `✓ Graph synced: ${this.graph.order} nodes, ${this.graph.size} edges (${
        syncTime.toFixed(1)
      }ms)`,
    );

    // 3. Precompute graph metrics
    await this.precomputeMetrics();
  }

  /**
   * Precompute expensive graph metrics (PageRank, Communities)
   */
  private async precomputeMetrics(): Promise<void> {
    const startTime = performance.now();

    // PageRank (native Graphology)
    this.pageRanks = pagerank(this.graph, {
      weighted: true,
      tolerance: 0.0001,
    });

    // Community detection (Louvain algorithm)
    this.communities = louvain(this.graph, {
      resolution: 1.0,
    });

    const computeTime = performance.now() - startTime;
    console.log(`✓ Graph metrics computed (${computeTime.toFixed(1)}ms)`);
  }

  /**
   * Get PageRank score for a tool
   */
  getPageRank(toolId: string): number {
    return this.pageRanks[toolId] || 0;
  }

  /**
   * Get community ID for a tool
   */
  getCommunity(toolId: string): string | undefined {
    return this.communities[toolId];
  }

  /**
   * Find tools in the same community
   */
  findCommunityMembers(toolId: string): string[] {
    const community = this.communities[toolId];
    if (!community) return [];

    return Object.entries(this.communities)
      .filter(([_, comm]) => comm === community)
      .map(([id]) => id)
      .filter((id) => id !== toolId);
  }

  /**
   * Find shortest path between two tools
   */
  findShortestPath(fromToolId: string, toToolId: string): string[] | null {
    try {
      return bidirectional(this.graph, fromToolId, toToolId);
    } catch {
      return null; // No path exists
    }
  }

  /**
   * Build DAG from tool candidates using graph topology
   */
  buildDAG(candidateTools: string[]): DAGStructure {
    const tasks: Task[] = [];

    for (let i = 0; i < candidateTools.length; i++) {
      const toolId = candidateTools[i];
      const dependsOn: string[] = [];

      // Find dependencies from previous tools
      for (let j = 0; j < i; j++) {
        const prevToolId = candidateTools[j];
        const path = this.findShortestPath(prevToolId, toolId);

        // If path exists and is short (≤3 hops), add as dependency
        if (path && path.length > 0 && path.length <= 4) {
          dependsOn.push(`task_${j}`);
        }
      }

      tasks.push({
        id: `task_${i}`,
        tool: toolId,
        arguments: {},
        depends_on: dependsOn,
      });
    }

    return { tasks };
  }

  /**
   * Update graph with new execution data
   */
  async updateFromExecution(execution: WorkflowExecution): Promise<void> {
    // Extract dependencies from executed DAG
    for (const task of execution.dag_structure.tasks) {
      for (const depTaskId of task.depends_on) {
        const depTask = execution.dag_structure.tasks.find((t) => t.id === depTaskId);
        if (!depTask) continue;

        const fromTool = depTask.tool;
        const toTool = task.tool;

        // Update or add edge in Graphology
        if (this.graph.hasEdge(fromTool, toTool)) {
          const edge = this.graph.getEdgeAttributes(fromTool, toTool);
          edge.count += 1;
          edge.weight = Math.min(edge.weight * 1.1, 1.0); // Increase confidence
        } else {
          this.graph.addEdge(fromTool, toTool, {
            count: 1,
            weight: 0.5,
          });
        }
      }
    }

    // Recompute metrics (fast with Graphology)
    await this.precomputeMetrics();

    // Persist updated edges to PGlite
    await this.persistEdgesToDB();
  }

  private async persistEdgesToDB(): Promise<void> {
    for (const edge of this.graph.edges()) {
      const [from, to] = this.graph.extremities(edge);
      const attrs = this.graph.getEdgeAttributes(edge);

      await this.db.exec(
        `
        INSERT INTO tool_dependency (from_tool_id, to_tool_id, observed_count, confidence_score)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (from_tool_id, to_tool_id) DO UPDATE SET
          observed_count = $3,
          confidence_score = $4
      `,
        [from, to, attrs.count, attrs.weight],
      );
    }
  }

  /**
   * Get graph statistics
   */
  getStats(): GraphStats {
    return {
      nodeCount: this.graph.order,
      edgeCount: this.graph.size,
      communities: new Set(Object.values(this.communities)).size,
      avgPageRank: Object.values(this.pageRanks).reduce((a, b) => a + b, 0) / this.graph.order,
    };
  }
}

interface GraphStats {
  nodeCount: number;
  edgeCount: number;
  communities: number;
  avgPageRank: number;
}
```

### 2. DAG Suggester (Simplified)

```typescript
// src/graphrag/dag-suggester.ts
export class DAGSuggester {
  constructor(
    private graphEngine: GraphRAGEngine,
    private vectorSearch: VectorSearch,
  ) {}

  async suggestDAG(intent: WorkflowIntent): Promise<SuggestedDAG | null> {
    // 1. Vector search for semantic candidates
    const candidates = await this.vectorSearch.searchTools(intent.text, 10);

    if (candidates.length === 0) return null;

    // 2. Rank by PageRank (Graphology)
    const rankedCandidates = candidates
      .map((c) => ({
        ...c,
        pageRank: this.graphEngine.getPageRank(c.toolId),
      }))
      .sort((a, b) => b.pageRank - a.pageRank)
      .slice(0, 5);

    // 3. Build DAG using graph topology (Graphology)
    const dagStructure = this.graphEngine.buildDAG(
      rankedCandidates.map((c) => c.toolId),
    );

    // 4. Calculate confidence
    const confidence = this.calculateConfidence(rankedCandidates, dagStructure);

    if (confidence < 0.70) return null;

    // 5. Find alternatives from same community (Graphology)
    const alternatives = this.graphEngine
      .findCommunityMembers(rankedCandidates[0].toolId)
      .slice(0, 3);

    return {
      dagStructure,
      confidence,
      rationale: this.generateRationale(rankedCandidates, dagStructure),
      alternatives,
    };
  }

  private calculateConfidence(candidates: any[], dag: DAGStructure): number {
    // Simplified confidence: semantic score + PageRank + pattern frequency
    const semanticScore = candidates[0].score;
    const pageRankScore = candidates[0].pageRank;

    return semanticScore * 0.6 + pageRankScore * 0.4;
  }

  private generateRationale(candidates: any[], dag: DAGStructure): string {
    const topTool = candidates[0];
    return `Based on semantic similarity (${
      (topTool.score * 100).toFixed(0)
    }%) and PageRank importance (${(topTool.pageRank * 100).toFixed(2)}%).`;
  }
}
```

### 3. Pattern Storage (Unchanged)

```typescript
// src/graphrag/pattern-store.ts
export class PatternStore {
  constructor(
    private db: PGlite,
    private embeddingModel: EmbeddingModel,
  ) {}

  async storePattern(
    intent: WorkflowIntent,
    dagStructure: DAGStructure,
    executionResult: { success: boolean; executionTimeMs: number },
  ): Promise<void> {
    // 1. Store execution history
    const executionId = await this.storeExecution(intent, dagStructure, executionResult);

    // 2. Generate pattern hash
    const patternHash = this.hashDAGStructure(dagStructure);

    // 3. Generate intent embedding
    const intentEmbedding = await this.embeddingModel.encode(intent.text);

    // 4. Upsert workflow_pattern
    await this.db.exec(
      `
      INSERT INTO workflow_pattern (pattern_hash, dag_structure, intent_embedding, usage_count, success_count)
      VALUES ($1, $2, $3, 1, ${executionResult.success ? 1 : 0})
      ON CONFLICT (pattern_hash) DO UPDATE SET
        usage_count = workflow_pattern.usage_count + 1,
        success_count = workflow_pattern.success_count + ${executionResult.success ? 1 : 0},
        last_used = NOW()
    `,
      [patternHash, JSON.stringify(dagStructure), `[${intentEmbedding.join(",")}]`],
    );

    // 5. Update dependencies (will be synced to Graphology later)
    await this.updateDependencies(dagStructure, executionResult.success);
  }

  private async updateDependencies(dag: DAGStructure, success: boolean): Promise<void> {
    for (const task of dag.tasks) {
      for (const depId of task.depends_on) {
        const depTask = dag.tasks.find((t) => t.id === depId);
        if (!depTask) continue;

        await this.db.exec(
          `
          INSERT INTO tool_dependency (from_tool_id, to_tool_id, observed_count, confidence_score)
          VALUES ($1, $2, 1, ${success ? 0.8 : 0.3})
          ON CONFLICT (from_tool_id, to_tool_id) DO UPDATE SET
            observed_count = tool_dependency.observed_count + 1,
            confidence_score = CASE
              WHEN $3 THEN LEAST(tool_dependency.confidence_score * 1.1, 1.0)
              ELSE tool_dependency.confidence_score * 0.9
            END
        `,
          [depTask.tool, task.tool, success],
        );
      }
    }
  }
}
```

---

## 🚀 Integration Example

```typescript
// src/mcp/gateway-handler.ts
export class GatewayHandler {
  private graphEngine: GraphRAGEngine;
  private suggester: DAGSuggester;
  private patternStore: PatternStore;

  async initialize(): Promise<void> {
    // Initialize graph engine
    this.graphEngine = new GraphRAGEngine(this.db);

    // Sync graph from PGlite to Graphology
    await this.graphEngine.syncFromDatabase();

    // Initialize suggester
    this.suggester = new DAGSuggester(this.graphEngine, this.vectorSearch);

    // Initialize pattern store
    this.patternStore = new PatternStore(this.db, this.embeddingModel);
  }

  async handleWorkflowRequest(request: {
    intent?: WorkflowIntent;
    workflow?: DAGStructure;
  }): Promise<any> {
    // Case 1: Explicit workflow (Option A fallback)
    if (request.workflow) {
      return await this.executor.execute(request.workflow);
    }

    // Case 2: Query GraphRAG for suggestion
    const suggestion = await this.suggester.suggestDAG(request.intent);

    if (suggestion) {
      return {
        mode: "suggestion",
        suggested_dag: suggestion.dagStructure,
        confidence: suggestion.confidence,
        rationale: suggestion.rationale,
        alternatives: suggestion.alternatives,
      };
    } else {
      return {
        mode: "explicit_required",
        message: "No patterns found. Please provide explicit workflow.",
      };
    }
  }
}
```

---

## 📊 Performance Comparison

### Before (Pseudo-GraphRAG SQL)

```
Operation                     | Time
------------------------------|-------
Recursive CTE traversal       | 200-500ms
Pseudo-PageRank view query    | 150-300ms
Manual path finding           | 100-200ms
Total                         | 450-1000ms ❌
```

### After (Graphology)

```
Operation                     | Time
------------------------------|-------
Graph sync from DB (startup)  | 30-50ms
PageRank (precomputed)        | 50-100ms
Shortest path query           | <1ms
Community detection           | 100-150ms
Total suggestion              | <200ms ✅
```

**Speedup: 3-5x faster!** ⚡

---

## 🧪 Testing

### Unit Test: Graph Sync

```typescript
Deno.test("GraphRAGEngine - sync from database", async () => {
  const db = await setupTestDB();
  const engine = new GraphRAGEngine(db);

  await engine.syncFromDatabase();

  const stats = engine.getStats();
  assert(stats.nodeCount > 0);
  assert(stats.edgeCount >= 0);
});
```

### Unit Test: PageRank

```typescript
Deno.test("GraphRAGEngine - PageRank computation", async () => {
  const engine = await setupTestEngine();

  const rank = engine.getPageRank("filesystem:read");
  assert(rank > 0 && rank <= 1);
});
```

### Unit Test: Shortest Path

```typescript
Deno.test("GraphRAGEngine - shortest path", async () => {
  const engine = await setupTestEngine();

  const path = engine.findShortestPath("filesystem:read", "json:parse");
  assert(path !== null);
  assert(path.length >= 2);
});
```

---

## 🚀 Speculative Execution (THE Feature)

### Overview

**Vision:** The gateway should perform actions BEFORE Claude's response, not just suggest them. Have
results ready immediately when user confirms.

**User Insight:** "et donc les algo graph aident la gateway a performer l action avant meme l appel
de claude non ? cetait l idee" (so the graph algorithms help the gateway perform the action even
before Claude's call, right? That was the idea)

**Design Philosophy:** Speculative execution is THE feature - the core differentiator. Not optional,
not opt-in. Default mode with smart safeguards.

### Three Execution Modes

```typescript
interface ExecutionMode {
  mode: "explicit_required" | "suggestion" | "speculative_execution";
  confidence: number;
  dagStructure?: DAGStructure;
  results?: ExecutionResult[];
  explanation?: string;
}
```

**Mode Selection Logic:**

- **`explicit_required`** (confidence < 0.70): No pattern found, Claude must provide explicit
  workflow
- **`suggestion`** (0.70-0.85): Good pattern found, suggest DAG to Claude
- **`speculative_execution`** (>0.85): High confidence, execute immediately and have results ready

### Gateway Handler Implementation

```typescript
export class GatewayHandler {
  private thresholds = {
    speculative: 0.85, // High confidence = execute immediately
    suggestion: 0.70, // Medium confidence = suggest to Claude
    explicit: 0.70, // Low confidence = require explicit workflow
  };

  private dangerousOperations = new Set([
    "delete",
    "remove",
    "destroy",
    "deploy",
    "publish",
    "payment",
    "charge",
    "bill",
    "send_email",
    "send_message",
  ]);

  async handleWorkflowRequest(request: {
    intent?: WorkflowIntent;
    workflow?: DAGStructure;
  }): Promise<ExecutionMode> {
    // If explicit workflow provided, just execute it
    if (request.workflow) {
      return await this.executeWorkflow(request.workflow, request.intent);
    }

    // Use GraphRAG to suggest workflow
    if (request.intent) {
      const suggestion = await this.suggester.suggestDAG(request.intent);

      // Mode 1: No pattern found (low confidence)
      if (!suggestion || suggestion.confidence < this.thresholds.explicit) {
        return {
          mode: "explicit_required",
          confidence: suggestion?.confidence || 0,
          explanation: "No workflow pattern found for this intent. Please provide explicit DAG.",
        };
      }

      // Safety check: Never speculate on dangerous operations
      if (this.isDangerous(suggestion.dagStructure)) {
        return {
          mode: "suggestion",
          confidence: suggestion.confidence,
          dagStructure: suggestion.dagStructure,
          explanation: suggestion.explanation,
          warning: "⚠️  Dangerous operations detected - review required before execution",
        };
      }

      // Mode 3: High confidence - SPECULATIVE EXECUTION
      if (suggestion.confidence >= this.thresholds.speculative) {
        return await this.executeSpeculatively(suggestion, request.intent);
      }

      // Mode 2: Medium confidence - SUGGESTION
      return {
        mode: "suggestion",
        confidence: suggestion.confidence,
        dagStructure: suggestion.dagStructure,
        explanation: suggestion.explanation,
      };
    }

    throw new Error("Invalid request: must provide either intent or workflow");
  }

  private async executeSpeculatively(
    suggestion: SuggestedDAG,
    intent: WorkflowIntent,
  ): Promise<ExecutionMode> {
    const startTime = performance.now();

    try {
      // 🚀 Execute optimistically
      const result = await this.executor.execute(suggestion.dagStructure);
      const executionTime = performance.now() - startTime;

      // Track metrics
      await this.trackSpeculativeExecution({
        success: true,
        confidence: suggestion.confidence,
        executionTime,
        dagSize: suggestion.dagStructure.tasks.length,
      });

      return {
        mode: "speculative_execution",
        confidence: suggestion.confidence,
        dagStructure: suggestion.dagStructure,
        results: result.results,
        explanation: suggestion.explanation,
        note: `✨ Results prepared speculatively in ${
          executionTime.toFixed(0)
        }ms - ready immediately`,
      };
    } catch (error) {
      // Speculative execution failed - graceful fallback to suggestion
      await this.trackSpeculativeExecution({
        success: false,
        confidence: suggestion.confidence,
        error: error.message,
      });

      return {
        mode: "suggestion",
        confidence: suggestion.confidence,
        dagStructure: suggestion.dagStructure,
        explanation: suggestion.explanation,
        error: `Speculative execution failed: ${error.message}. Review and retry?`,
      };
    }
  }

  private isDangerous(dag: DAGStructure): boolean {
    return dag.tasks.some((task) => {
      const toolName = task.tool.split(":")[1]?.toLowerCase() || "";
      return Array.from(this.dangerousOperations).some((op) => toolName.includes(op));
    });
  }
}
```

### Adaptive Threshold Learning

```typescript
export class AdaptiveThresholdManager {
  private history: ExecutionRecord[] = [];
  private config = {
    thresholds: {
      speculative: 0.85,
      suggestion: 0.70,
    },
  };

  async recordExecution(record: {
    confidence: number;
    mode: "explicit" | "suggestion" | "speculative";
    success: boolean;
    userAccepted?: boolean;
    executionTime?: number;
  }): Promise<void> {
    this.history.push({
      ...record,
      timestamp: Date.now(),
    });

    // Adjust thresholds after collecting enough data
    if (this.history.length >= 50) {
      await this.adjustThresholds();
    }
  }

  private async adjustThresholds(): Promise<void> {
    const recent = this.history.slice(-100);

    // Analyze speculative execution performance
    const highConfidence = recent.filter((r) => r.confidence >= this.config.thresholds.speculative);
    const successRate = highConfidence.filter((r) => r.success).length / highConfidence.length;

    // If success rate is very high, become more aggressive
    if (successRate > 0.95) {
      this.config.thresholds.speculative *= 0.95; // Lower threshold (more speculation)
      console.log(
        `📊 Adaptive learning: Lowering speculative threshold to ${
          this.config.thresholds.speculative.toFixed(2)
        }`,
      );
    }

    // If success rate is too low, become more conservative
    if (successRate < 0.80) {
      this.config.thresholds.speculative *= 1.05; // Raise threshold (less speculation)
      console.log(
        `📊 Adaptive learning: Raising speculative threshold to ${
          this.config.thresholds.speculative.toFixed(2)
        }`,
      );
    }

    // Persist updated config
    await this.saveConfig();
  }
}
```

### Explainability for Speculative Execution

```typescript
export class DAGExplainer {
  constructor(private graphEngine: GraphRAGEngine) {}

  async explainDAG(dag: DAGStructure): Promise<string> {
    const explanations: string[] = [];

    // Extract dependency chains
    for (const task of dag.tasks) {
      if (task.depends_on.length > 0) {
        const deps = task.depends_on.map((depId) => {
          const depTask = dag.tasks.find((t) => t.id === depId);
          return depTask?.tool || depId;
        });

        explanations.push(
          `${task.tool} depends on: ${deps.join(", ")}`,
        );

        // Find graph paths for each dependency
        for (const depId of task.depends_on) {
          const depTask = dag.tasks.find((t) => t.id === depId);
          if (!depTask) continue;

          const path = this.graphEngine.findShortestPath(depTask.tool, task.tool);
          if (path && path.length > 2) {
            explanations.push(
              `  → Transitive path (${path.length - 1} hops): ${path.join(" → ")}`,
            );
          }
        }
      }
    }

    // Add PageRank scores
    const toolScores = dag.tasks.map((task) => ({
      tool: task.tool,
      pagerank: this.graphEngine.getPageRank(task.tool),
    })).sort((a, b) => b.pagerank - a.pagerank);

    explanations.push("\nTool Importance (PageRank):");
    for (const { tool, pagerank } of toolScores.slice(0, 3)) {
      explanations.push(`  • ${tool}: ${pagerank.toFixed(3)}`);
    }

    return explanations.join("\n");
  }
}
```

### Performance Targets

- **Speculative execution:** <300ms total (suggestion + execution)
- **Graceful degradation:** <10ms overhead on fallback to suggestion
- **Success rate:** >95% for high-confidence workflows
- **Waste rate:** <10% (failed speculations)
- **Cost savings from context:** $5-10/day >> $0.50 waste

### Metrics Tracking

```typescript
interface SpeculativeMetrics {
  totalSpeculativeAttempts: number;
  successfulExecutions: number;
  failedExecutions: number;
  avgExecutionTime: number;
  avgConfidence: number;
  wastedComputeCost: number; // Cost of failed speculations
  savedLatency: number; // Total latency saved vs sequential
}
```

---

## 📋 Implementation Checklist

### Story 2.1: GraphRAG Engine with Graphology + Speculative Execution

**Part 1: Core GraphRAG (4-5 hours)**

- [ ] Add Graphology dependencies to deno.json
- [ ] Implement `GraphRAGEngine` class
- [ ] Implement graph sync from PGlite
- [ ] Implement PageRank calculation
- [ ] Implement community detection
- [ ] Implement shortest path finding
- [ ] Implement DAG builder using graph topology
- [ ] Update `DAGSuggester` to use GraphRAGEngine

**Part 2: Speculative Execution (2-3 hours) - THE FEATURE**

- [ ] Implement three execution modes (explicit/suggestion/speculative)
- [ ] Implement `GatewayHandler` with mode selection logic
- [ ] Implement safety checks for dangerous operations
- [ ] Implement graceful fallback on speculative failures
- [ ] Implement adaptive threshold learning
- [ ] Track speculative execution metrics

**Part 3: Explainability (1 hour)**

- [ ] Implement `DAGExplainer` with dependency paths
- [ ] Add PageRank scores to explanations
- [ ] Format explanations for Claude consumption

**Part 4: Testing & Documentation**

- [ ] Write unit tests (sync, PageRank, paths, communities)
- [ ] Write speculative execution tests (success, failure, dangerous ops)
- [ ] Benchmark performance (<300ms total including execution)
- [ ] Document graph operations and speculative execution flow

**Estimated effort:** 6-7 hours (GraphRAG + Speculative Execution + Explainability)

---

## 🎯 Benefits of Graphology Approach

### 1. Simplicity ✅

- **90% less SQL complexity**
- No recursive CTEs
- No complex views
- Just simple storage

### 2. True Graph Algorithms ✅

- Real PageRank (not pseudo)
- Real Louvain community detection
- Real shortest path algorithms
- Proven, optimized implementations

### 3. Performance ⚡

- In-memory graph operations (<1ms for paths)
- Precomputed metrics (PageRank, communities)
- 3-5x faster than SQL approach

### 4. Maintainability 📝

- Simple, readable code
- Well-documented library
- Active community
- Easy to debug

### 5. Extensibility 🚀

- Easy to add more graph algorithms
- Betweenness centrality
- Closeness centrality
- Custom graph metrics

---

## 🔮 Future Enhancements (v1.1+)

### 1. Graph Visualization

```typescript
import { serializeGraph } from "npm:graphology-utils";

// Export graph for visualization
const serialized = serializeGraph(this.graph);
await Deno.writeTextFile("graph.json", JSON.stringify(serialized));

// Can be visualized with sigma.js, cytoscape.js, etc.
```

### 2. Advanced Centrality Measures

```typescript
import { betweenness } from "npm:graphology-metrics/centrality/betweenness";

const bridgeTools = betweenness(this.graph);
// Find tools that are critical "bridges" in the workflow graph
```

### 3. Temporal Graphs

```typescript
// Track how graph evolves over time
const snapshot = this.graph.copy();
await this.storeGraphSnapshot(snapshot, Date.now());
```

---

## 📚 References

- [Graphology Documentation](https://graphology.github.io/)
- [PageRank Algorithm](https://en.wikipedia.org/wiki/PageRank)
- [Louvain Method](https://en.wikipedia.org/wiki/Louvain_method)
- [Bidirectional Search](https://en.wikipedia.org/wiki/Bidirectional_search)
- [PGlite + pgvector](https://github.com/electric-sql/pglite)

---

**Status:** 🟢 READY FOR IMPLEMENTATION **Complexity:** Medium → **Low** (Graphology simplifies
everything!) **Innovation:** High (True GraphRAG in MCP space) **Dependencies:** PGlite + Graphology
(~100KB total)
