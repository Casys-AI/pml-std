# Story 7.4: DAGSuggester Extension - Mixed DAG (Tools + Capabilities)

> **Epic:** 7 - Emergent Capabilities & Learning System **ADRs:** ADR-027 (Execute Code Graph
> Learning), ADR-028 (Emergent Capabilities), ADR-038 (Scoring Algorithms Reference), ADR-041
> (Hierarchical Trace Tracking) **Prerequisites:** Story 7.3b (Capability Injection - DONE, 298
> tests passing) **Status:** done **Review Date:** 2025-12-10 (Adversarial code review completed,
> all issues fixed)

## User Story

As an AI agent, I want DAGs that include both MCP tools AND capabilities, So that I can reuse
learned patterns in larger workflows.

## Problem Context

### Current State (After Story 7.3b)

Le systeme a maintenant:

1. **CapabilityMatcher** (`src/capabilities/matcher.ts`) - Trouve les capabilities pour un intent:
   - `findMatch(intent)` -> CapabilityMatch | null
   - Scoring: `Semantic * Reliability` (ADR-038)
   - Adaptive thresholds (pas de valeurs hardcodees)

2. **CapabilityCodeGenerator** (`src/capabilities/code-generator.ts`) - Genere le code inline:
   - Wraps capabilities avec `__trace()` calls
   - Cycle detection (max depth = 3)
   - Code sanitization (blocked patterns)

3. **WorkerBridge** (`src/sandbox/worker-bridge.ts`) - Execute avec injection:
   - `buildCapabilityContext()` genere le code capabilities
   - BroadcastChannel pour traces en temps reel
   - Integration GraphRAG (`updateFromCodeExecution`)

4. **DAGSuggester** (`src/graphrag/dag-suggester.ts`) - Suggere des DAGs:
   - `suggestDAG(intent)` -> Tools uniquement
   - `searchCapabilities(intent)` -> Delègue à CapabilityMatcher
   - `predictNextNodes()` -> Tools uniquement

**MAIS:** `suggestDAG()` et `predictNextNodes()` ne retournent que des **tools**. Les capabilities
ne sont jamais suggerees dans les DAGs.

```
Current Flow:
suggestDAG(intent) -> [ tool1, tool2, tool3 ] // Tools only

Desired Flow:
suggestDAG(intent) -> [ tool1, capability1, tool2 ] // Mixed!
```

### Missing Components

1. **Mixed DAGStructure** - Tasks avec `type: "tool" | "capability"`
2. **Capability Search in suggestDAG** - Chercher aussi les capabilities
3. **Spectral Clustering** - Boost les capabilities du cluster actif (ADR-038)
4. **Unified Ranking** - Trier tools + capabilities ensemble
5. **execute_dag Update** - Gerer les deux types de tasks

### Impact

Sans mixed DAG:

- Les capabilities apprises ne sont jamais suggerees automatiquement
- Claude doit explicitement appeler `search_capabilities` puis integrer manuellement
- Pas de suggestion proactive de capabilities dans les workflows

---

## Solution: Strategic Discovery Mode (ADR-038)

### Algorithm (from ADR-038)

**Mode:** Passive Suggestion (Implicit Context) **Formule:**
`Score = ToolsOverlap * (1 + SpectralClusterBoost)`

### Architecture

```
                              Intent
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  DAGSuggester.suggestDAG() [EXTENDED]                               │
│                                                                      │
│  ┌────────────────────┐    ┌─────────────────────────────────────┐  │
│  │ Tool Search        │    │ Capability Search [NEW]             │  │
│  │ (Existing Hybrid)  │    │                                     │  │
│  │                    │    │ 1. Query CapabilityStore.search()   │  │
│  │ semanticScore *    │    │ 2. Calculate ToolsOverlap           │  │
│  │ α + graphScore *   │    │ 3. Compute SpectralClusterBoost     │  │
│  │ (1-α)              │    │ 4. Final: Overlap * (1 + Boost)     │  │
│  └────────────────────┘    └─────────────────────────────────────┘  │
│            │                              │                         │
│            └──────────────┬───────────────┘                         │
│                           ▼                                         │
│              ┌────────────────────────┐                            │
│              │ Unified Ranking        │                            │
│              │                        │                            │
│              │ Sort all by finalScore │                            │
│              │ Tools + Capabilities   │                            │
│              └────────────────────────┘                            │
│                           │                                         │
│                           ▼                                         │
│              ┌────────────────────────┐                            │
│              │ Mixed DAGStructure     │                            │
│              │                        │                            │
│              │ tasks: [               │                            │
│              │   { type: "tool" },    │                            │
│              │   { type: "capability"}│                            │
│              │ ]                      │                            │
│              └────────────────────────┘                            │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Spectral Clustering Integration

Spectral Clustering identifie les "clusters" de tools qui travaillent souvent ensemble. Une
capability qui utilise des tools du cluster actif est plus susceptible d'etre pertinente.

```typescript
// Hypergraph Bipartite: Tools ↔ Capabilities
//
// Cluster A (File ops):     Cluster B (Git ops):
// ┌─────────────────┐       ┌─────────────────┐
// │ fs:read         │       │ git:status      │
// │ fs:write        │       │ git:commit      │
// │ parseConfig     │◄──────│ createPR        │
// │ (capability)    │       │ (capability)    │
// └─────────────────┘       └─────────────────┘
//
// Si context_tools = [fs:read, fs:write]
// → Cluster A actif → Boost "parseConfig" capability
```

---

## Acceptance Criteria

### AC1: DAGStructure Extended for Mixed Tasks

- [x] `DAGStructure.tasks[].type` field added (`"mcp_tool" | "code_execution" | "capability"`)
- [x] Type definition updated in `src/graphrag/types.ts`:
  ```typescript
  interface Task {
    id: string;
    tool: string;
    type?: "mcp_tool" | "code_execution" | "capability";
    capabilityId?: string; // For type: "capability" (NEW)
    arguments: Record<string, unknown>;
    dependsOn: string[];
  }
  ```
- [x] Backward compatible: `type` defaults to `"mcp_tool"` if not specified

### AC2: CapabilityStore.searchByContext() Method

- [x] New method in `src/capabilities/capability-store.ts`:
  ```typescript
  async searchByContext(
    contextTools: string[],
    limit?: number,
    minOverlap?: number
  ): Promise<Array<{ capability: Capability; overlapScore: number }>>
  ```
- [x] Query: Find capabilities whose `tools_used` overlap with `contextTools`
- [x] Overlap score: `|intersection| / |capability.tools_used|`
- [x] Min overlap threshold: 0.3 (at least 30% tools match)

### AC3: SpectralClusteringManager Class Created

- [x] File `src/graphrag/spectral-clustering.ts` created (~500 LOC)
- [x] Dependency: `ml-matrix` added to `deno.json` for eigendecomposition
- [x] Class `SpectralClusteringManager` exported
- [x] Method `buildBipartiteMatrix(tools: string[], capabilities: ClusterableCapability[])`:
  - Constructs adjacency matrix (tools ↔ capabilities)
  - Uses `ml-matrix` Matrix class
- [x] Method `computeNormalizedLaplacian(adjacencyMatrix: Matrix)`:
  - L = I - D^(-1/2) × A × D^(-1/2)
- [x] Method `computeClusters(k?: number)`:
  - Eigendecomposition of Laplacian (k smallest eigenvectors)
  - K-means on eigenvector matrix rows
  - Auto-detect K using eigengap heuristic if not specified
- [x] Method `getClusterBoost(capability: ClusterableCapability, activeCluster: number)`:
  - Returns boost factor (0 to 0.5) if capability in active cluster
- [x] Method `identifyActiveCluster(contextTools: string[])`:
  - Returns cluster ID with most context tools

### AC3b: Hypergraph PageRank

- [x] Method `computeHypergraphPageRank(capabilities: ClusterableCapability[])`:
  - Builds bipartite adjacency matrix (tools ↔ capabilities)
  - Computes stationary distribution via power iteration
  - Returns `Map<capability_id, pageRank>` (importance score 0-1)
- [x] PageRank influences unified ranking as minor boost factor
- [x] Performance: < 50ms for 50 capabilities, 200 tools

### AC4: DAGSuggester.suggestDAG() Extended

- [x] Method extended to search capabilities alongside tools:
  ```typescript
  async suggestDAG(intent: WorkflowIntent): Promise<SuggestedDAG | null> {
    // Existing: Hybrid tool search
    const toolCandidates = await this.graphEngine.searchToolsHybrid(...);

    // NEW: Capability search by context
    const contextTools = toolCandidates.slice(0, 3).map(t => t.toolId);
    const capCandidates = await this.capabilityStore.searchByContext(contextTools, 5);

    // NEW: Apply spectral boost
    const activeCluster = this.spectral.identifyActiveCluster(contextTools);
    const boostedCaps = capCandidates.map(c => ({
      ...c,
      finalScore: c.overlapScore * (1 + this.spectral.getClusterBoost(c.capability, activeCluster))
    }));

    // NEW: Unified ranking
    const allCandidates = [...toolCandidates, ...boostedCaps]
      .sort((a, b) => b.finalScore - a.finalScore)
      .slice(0, 5);

    // Build mixed DAG
    return this.buildMixedDAG(allCandidates);
  }
  ```
- [x] Returns `SuggestedDAG` with mixed task types

### AC5: DAGSuggester.predictNextNodes() Extended

- [x] Method extended to predict capabilities as well as tools:
  ```typescript
  async predictNextNodes(
    workflowState: WorkflowPredictionState | null,
    completedTasks?: CompletedTask[],
  ): Promise<PredictedNode[]> {
    // Existing: Tool predictions
    const toolPredictions = /* existing logic */;

    // NEW: Capability predictions based on context
    const contextTools = completedTasks?.map(t => t.tool) || [];
    const capPredictions = await this.predictCapabilities(contextTools);

    // Merge and sort
    return [...toolPredictions, ...capPredictions]
      .sort((a, b) => b.confidence - a.confidence);
  }
  ```
- [x] `PredictedNode.source` updated: `"community" | "co-occurrence" | "capability"` (removed
      "adamic-adar" per ADR-038)

### AC6: execute_dag Updated for Mixed Tasks

- [x] `ControlledExecutor.executeSingleTask()` modified to handle both types:
  ```typescript
  private async executeSingleTask(task: DAGTask): Promise<TaskResult> {
    if (task.type === "capability") {
      // Execute capability via code execution
      return await this.executeCapability(task.capability_id, task.arguments);
    } else {
      // Existing: Execute MCP tool
      return await this.executeMCPTool(task.tool, task.arguments);
    }
  }
  ```
- [x] Capability execution uses `execute_code` with stored `code_snippet`
- [x] Both types traced in ExecutionResult

### AC7: Observability Integration (ADR-039)

- [x] Log algorithm decisions for debugging:
  ```typescript
  logger.info("Spectral cluster identified", {
    activeCluster,
    contextTools,
    boostFactor,
  });

  logger.info("Capability ranked", {
    capability_id,
    overlapScore,
    spectralBoost,
    finalScore,
  });
  ```
- [x] Future: structured traces per ADR-039 format

### AC8: Unit Tests - SpectralClusteringManager

- [x] Test: buildBipartiteMatrix with 3 tools, 2 capabilities → correct dimensions
- [x] Test: computeClusters returns valid cluster assignments
- [x] Test: identifyActiveCluster with majority tools in cluster A → returns A
- [x] Test: getClusterBoost for capability in active cluster → returns > 0

### AC9: Unit Tests - Mixed DAG

- [x] Test: suggestDAG returns both tools and capabilities in tasks
- [x] Test: capability with high overlap score ranks above low-relevance tool
- [x] Test: spectral boost increases capability ranking
- [x] Test: predictNextNodes returns mixed predictions

### AC10: Integration Tests

- [x] Test: Full flow - Intent → Mixed DAG → execute_dag → Traces
- [x] Test: Capability task executed via execute_code
- [x] Test: Both tool and capability traces merged correctly

### AC11: Performance Requirements

- [x] Spectral clustering computation < 100ms for 50 capabilities, 200 tools
- [x] suggestDAG with capability search < 300ms P95
- [x] predictNextNodes with capability prediction < 100ms

---

## Tasks / Subtasks

- [x] **Task 0: Non-Regression Tests** (Pre-implementation)
  - [x] 0.1 Identify existing E2E tests for `execute_dag`
  - [x] 0.2 Run tests to establish baseline (all must pass)
  - [x] 0.3 Add backward compatibility test for `DAGTask` without `type` field
  - [x] 0.4 Document test count baseline

- [x] **Task 1: Extend DAGStructure Types** (AC: #1)
  - [x] 1.1 Update `Task` interface in `src/graphrag/types.ts`
  - [x] 1.2 Add `type` field: `"mcp_tool" | "code_execution" | "capability"`
  - [x] 1.3 Add `capabilityId` optional field (camelCase per implementation-patterns.md)
  - [x] 1.4 Update `PredictedNode.source` type (add "capability")
  - [x] 1.5 Update related types (SuggestedDAG, etc.)

- [x] **Task 2: Create CapabilityStore.searchByContext()** (AC: #2)
  - [x] 2.1 Add method to `src/capabilities/capability-store.ts`
  - [x] 2.2 Implement SQL query for overlap calculation (JSONB array intersection)
  - [x] 2.3 Add `findById()` method for capability lookup
  - [x] 2.4 Unit tests covered by existing tests

- [x] **Task 3: Create SpectralClusteringManager** (AC: #3, #3b, #8)
  - [x] 3.1 Add `ml-matrix` dependency to `deno.json`
  - [x] 3.2 Create `src/graphrag/spectral-clustering.ts`
  - [x] 3.3 Implement `buildBipartiteMatrix()` using ml-matrix Matrix
  - [x] 3.4 Implement `computeNormalizedLaplacian()`
  - [x] 3.5 Implement `computeClusters()` with eigendecomposition + K-means
  - [x] 3.6 Implement `identifyActiveCluster()`
  - [x] 3.7 Implement `getClusterBoost()` (returns 0 to 0.5)
  - [x] 3.8 Implement `computeHypergraphPageRank()` via power iteration
  - [x] 3.9 Export from `src/graphrag/mod.ts`
  - [x] 3.10 Tests in `tests/unit/graphrag/mixed_dag_test.ts` (15 tests)

- [x] **Task 4: Extend DAGSuggester.suggestDAG()** (AC: #4, #7)
  - [x] 4.1 Add CapabilityStore dependency via `setCapabilityStore()`
  - [x] 4.2 Add SpectralClusteringManager dependency
  - [x] 4.3 Implement capability search via `injectMatchingCapabilities()`
  - [x] 4.4 Implement spectral boost calculation via `computeClusterBoosts()`
  - [x] 4.5 Implement unified ranking
  - [x] 4.6 Build mixed DAG structure via `createCapabilityTask()`
  - [x] 4.7 Add observability logging

- [x] **Task 5: Extend DAGSuggester.predictNextNodes()** (AC: #5)
  - [x] 5.1 Add `predictCapabilities()` private method
  - [x] 5.2 Merge tool and capability predictions
  - [x] 5.3 Add `"capability"` to PredictedNode.source type

- [x] **Task 6: Update ControlledExecutor for Mixed Tasks** (AC: #6)
  - [x] 6.1 Modify `executeTask()` in `src/dag/controlled-executor.ts`
  - [x] 6.2 Add `executeCapabilityTask()` method
  - [x] 6.3 Integrate with WorkerBridge for capability execution
  - [x] 6.4 Ensure traces merged correctly

- [x] **Task 7: Unit Tests - Mixed DAG** (AC: #9)
  - [x] 7.1 Create `tests/unit/graphrag/mixed_dag_test.ts` (15 tests)
  - [x] 7.2 Test Task type supports capability value
  - [x] 7.3 Test SpectralClusteringManager all methods
  - [x] 7.4 Test cluster boost calculations

- [x] **Task 8: Integration Tests** (AC: #10, #11)
  - [x] 8.1 Create `tests/integration/dag/mixed_dag_integration_test.ts` (6 tests)
  - [x] 8.2 Test mixed DAG structure validation
  - [x] 8.3 Test dependency chain preservation
  - [x] 8.4 Test cycle detection in mixed DAGs

- [x] **Task 9: Naming Convention Fix** (ADR-041 + implementation-patterns.md)
  - [x] 9.1 Convert all trace types to camelCase: `traceId`, `parentTraceId`, `durationMs`,
        `capabilityId`
  - [x] 9.2 Update `src/sandbox/types.ts` - BaseTraceEvent, CapabilityTraceEvent, RPCCallMessage,
        InitMessage
  - [x] 9.3 Update `src/sandbox/sandbox-worker.ts` - TraceContext, __trace(), __rpcCall(),
        handleInit()
  - [x] 9.4 Update `src/sandbox/worker-bridge.ts` - handleRPCCall(), execute(), BroadcastChannel
        handler
  - [x] 9.5 Update `src/graphrag/graph-engine.ts` - updateFromCodeExecution()
  - [x] 9.6 Update `src/capabilities/code-generator.ts` - generateInlineCode()
  - [x] 9.7 Update `src/capabilities/matcher.ts` - eventBus payload
  - [x] 9.8 Update all test files to use camelCase

---

## Dev Notes

### Critical Implementation Details

1. **Spectral Clustering Algorithm**

   Use eigendecomposition of the normalized Laplacian:

   ```typescript
   // Simplified pseudo-code
   // 1. Build adjacency matrix A (bipartite: tools ↔ capabilities)
   // 2. Compute degree matrix D
   // 3. Normalized Laplacian: L = I - D^(-1/2) * A * D^(-1/2)
   // 4. Compute k smallest eigenvectors of L
   // 5. K-means on eigenvector matrix rows

   // For MVP, consider using ml-kmeans library or simple implementation
   ```

2. **Overlap Score Calculation**

   ```typescript
   function calculateOverlap(capTools: string[], contextTools: string[]): number {
     const intersection = capTools.filter((t) => contextTools.includes(t));
     return intersection.length / capTools.length;
   }
   ```

3. **Unified Ranking**

   Tools use `finalScore` from hybrid search. Capabilities use `overlapScore * (1 + spectralBoost)`.
   Both scores are in [0, 1] range, so they're directly comparable.

4. **Capability Execution in execute_dag**

   ```typescript
   async executeCapability(capabilityId: string, args: Record<string, unknown>): Promise<TaskResult> {
     const capability = await this.capabilityStore.findById(capabilityId);
     if (!capability) throw new Error(`Capability ${capabilityId} not found`);

     // Build context with capability
     const capContext = this.codeGenerator.generateInlineCode(capability);

     // Execute via WorkerBridge
     const result = await this.workerBridge.execute(
       `return await capabilities.${capability.name}(args);`,
       this.toolDefinitions,
       { args },
       capContext
     );

     return { status: result.success ? "success" : "error", result: result.result };
   }
   ```

5. **PredictedNode.source Type Extension**

   ```typescript
   // src/graphrag/types.ts
   interface PredictedNode {
     toolId: string;
     confidence: number;
     reasoning: string;
     source: "community" | "co-occurrence" | "capability"; // "adamic-adar" removed per ADR-038
   }
   ```

6. **Edge Types for Capabilities (ADR-041)**

   ```typescript
   // Capability → Tools (the tools used by capability)
   edge_type: "contains"; // Parent-child relationship
   edge_source: "observed"; // Confirmed by execution

   // Capability → Capability (cap calls another cap)
   edge_type: "sequence"; // Temporal order learned from execution
   edge_source: "inferred"; // Until confirmed 3+ times → "observed"
   ```

7. **Multiplicative Formula for Capabilities (ADR-038)**

   ```typescript
   // Strategic Discovery - MULTIPLICATIVE (strict)
   const discoveryScore = toolsOverlap * (1 + spectralBoost);

   // If toolsOverlap = 0 → score = 0 (no suggestion)
   // This is intentional: no overlap = not relevant
   ```

### Project Structure Notes

**Files to Create:**

```
src/graphrag/
├── spectral-clustering.ts   # NEW: SpectralClusteringManager (~150 LOC)
└── mod.ts                   # MODIFY: Export SpectralClusteringManager

tests/unit/graphrag/
└── spectral_clustering_test.ts  # NEW: Unit tests
tests/unit/graphrag/
└── mixed_dag_test.ts            # NEW: Mixed DAG tests
tests/integration/
└── mixed_dag_e2e_test.ts        # NEW: E2E tests
```

**Files to Modify:**

```
src/graphrag/types.ts           # Extend DAGTask, PredictedNode
src/graphrag/dag-suggester.ts   # Extend suggestDAG, predictNextNodes (~100 LOC)
src/capabilities/capability-store.ts  # Add searchByContext (~30 LOC)
src/mcp/controlled-executor.ts  # Add capability execution (~50 LOC)
```

### Existing Code Patterns to Follow

**DAGSuggester.suggestDAG()** (`src/graphrag/dag-suggester.ts:112-218`):

- Hybrid search for candidates
- Rank by finalScore + PageRank
- Build DAG using graph topology
- Already has `contextTools` pattern

**CapabilityStore.searchByIntent()** (`src/capabilities/capability-store.ts:251-274`):

- Vector search pattern
- Returns `{ capability, similarity }` array
- Good pattern for `searchByContext()`

**Controlled Executor Pattern** (`src/mcp/controlled-executor.ts`):

- Task execution loop
- Result handling and traces
- Integration point for capability execution

### References

- **DAGSuggester:** `src/graphrag/dag-suggester.ts`
- **GraphRAGEngine:** `src/graphrag/graph-engine.ts`
- **CapabilityStore:** `src/capabilities/capability-store.ts`
- **CapabilityMatcher:** `src/capabilities/matcher.ts`
- **CapabilityCodeGenerator:** `src/capabilities/code-generator.ts`
- **WorkerBridge:** `src/sandbox/worker-bridge.ts`
- **ControlledExecutor:** `src/mcp/controlled-executor.ts`
- **Types:** `src/graphrag/types.ts`
- **ADR-038:** `docs/adrs/ADR-038-scoring-algorithms-reference.md`
- **Previous story (7.3b):** `docs/sprint-artifacts/7-3b-capability-injection-nested-tracing.md`
- **Epics doc:** `docs/epics.md` (Story 7.4 section)

---

## Previous Story Intelligence

### From Story 7.3b (Capability Injection)

- **What worked:** BroadcastChannel for real-time trace emission
- **Pattern used:** CapabilityCodeGenerator generates wrapped inline code
- **Key insight:** Capabilities execute via WorkerBridge.execute() with `capabilityContext`
- **Files created:** `code-generator.ts`, `executor.ts` (CapabilityExecutor orchestrator)
- **Testing pattern:** 58 tests total across unit and E2E

### Code from 7.3b that 7.4 can reuse:

```typescript
// CapabilityExecutor.prepareCapabilityContext() for injection
const capContext = await this.capabilityExecutor.prepareCapabilityContext(intent);

// CapabilityCodeGenerator for inline code
const inlineCode = this.codeGenerator.generateInlineCode(capability);

// WorkerBridge.execute() signature
const result = await this.workerBridge.execute(
  code,
  toolDefinitions,
  context,
  capabilityContext, // From 7.3b
);
```

### From Story 7.3a (CapabilityMatcher)

- **What worked:** Adaptive thresholds integration (no hardcoded values)
- **Pattern used:** Helper class with DI for testability
- **Key insight:** `findMatch()` returns null if below threshold
- **Integration:** Via DAGSuggester.searchCapabilities()

---

## Git Intelligence

### Recent Commits (last 5):

```
d514241 feat(events): Story 6.5 - EventBus with BroadcastChannel (ADR-036)
7839231 Merge branch 'refactor/rename-to-casys-pml' into main
a11bd7e refactor: rename Casys PML to Casys PML (PML)
d3f36e0 docs: update README and architecture for Casys PML rebrand
f7f2a7d feat(capabilities): Story 7.3b - Capability injection with nested tracing
```

### Learnings from f7f2a7d (7.3b):

- CapabilityCodeGenerator pattern with sanitization and depth tracking
- BroadcastChannel used for trace emission (consistent with ADR-036)
- GraphRAG integration via `updateFromCodeExecution()`
- 298 tests passing demonstrates good test coverage

### Patterns from dag-suggester.ts:

- `getAdaptiveWeights()` for density-based weight adjustment
- `calculateConfidenceHybrid()` for multi-factor scoring
- `isDangerousOperation()` blacklist for safety
- `adjustConfidenceFromEpisodes()` for episodic memory integration

---

## Technical Stack (from Architecture)

- **Runtime:** Deno 2.5+ with TypeScript 5.7+
- **Graph Algorithms:** Graphology (PageRank, Louvain, Dijkstra)
- **Database:** PGlite 0.3.11 with pgvector
- **Sandbox:** Deno Worker with `permissions: "none"`
- **Events:** BroadcastChannel (ADR-036)
- **Testing:** Deno test runner, `deno task test:unit`

### Libraries for Spectral Clustering & Hypergraph PageRank

**Decision (2025-12-09):** Full Spectral Clustering + Hypergraph PageRank using `ml-matrix`

**Library:** `ml-matrix` (npm: ml-matrix, Deno compatible)

- Matrix operations: multiplication, transpose, inverse
- Eigendecomposition: `EigenvalueDecomposition` class
- Well-maintained, TypeScript types available

**Algorithm Implementation:**

```typescript
import { EigenvalueDecomposition, Matrix } from "ml-matrix";

// 1. Build bipartite adjacency matrix (tools × capabilities)
// 2. Compute normalized Laplacian: L = I - D^(-1/2) × A × D^(-1/2)
// 3. Eigendecomposition: get k smallest eigenvectors
// 4. K-means clustering on eigenvector rows
// 5. Hypergraph PageRank: power iteration on bipartite matrix
```

**Why not Louvain fallback?**

- Spectral Clustering better detects "soft" relations in bipartite hypergraphs
- Hypergraph PageRank gives importance per capability (not available in Louvain)
- ADR-038 specifies Spectral for capabilities explicitly

---

## Estimation

- **Effort:** 3-4 jours (updated for full Spectral + Hypergraph PageRank)
- **LOC:** ~450-500 (spectral ~200, dag-suggester ~120, executor ~50, tests ~130)
- **Risk:** Medium
  - Spectral clustering complexity (mitigated by ml-matrix library)
  - Eigendecomposition performance for large graphs
  - Integration with existing DAGSuggester flow

---

## Pre-Implementation Review Decisions (2025-12-09)

Summary of decisions made during story review before implementation:

| Topic                    | Decision                                         | Rationale                                    |
| ------------------------ | ------------------------------------------------ | -------------------------------------------- |
| **Algorithms**           | Spectral Clustering + Hypergraph PageRank (both) | Full implementation per ADR-038, not MVP     |
| **Library**              | `ml-matrix` for eigendecomposition               | Deno compatible, TypeScript types            |
| **Adamic-Adar**          | ❌ Not used for capabilities                     | ToolsOverlap + Spectral sufficient (ADR-038) |
| **PredictedNode.source** | `"community" \| "co-occurrence" \| "capability"` | Removed "adamic-adar"                        |
| **Edge Cap→Tools**       | `type: "contains"` (ADR-041)                     | Parent-child relationship                    |
| **Edge Cap→Cap**         | `type: "sequence"` (ADR-041)                     | Temporal order from execution                |
| **Formula**              | `ToolsOverlap × (1 + SpectralBoost)`             | Multiplicative (strict) per ADR-038          |
| **Task 0**               | Non-regression tests before coding               | Ensure backward compatibility                |

---

## Dev Agent Record

### Context Reference

- `src/graphrag/dag-suggester.ts:112-218` - suggestDAG() to extend
- `src/graphrag/dag-suggester.ts:575-698` - predictNextNodes() to extend
- `src/graphrag/types.ts` - DAGTask, PredictedNode types
- `src/capabilities/capability-store.ts:251-274` - searchByIntent pattern
- `src/mcp/controlled-executor.ts` - Task execution pattern
- `src/capabilities/code-generator.ts` - Capability code generation
- `src/sandbox/worker-bridge.ts` - Capability execution bridge

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

(Will be filled during implementation)

### Completion Notes List

(Will be filled during implementation)

### File List

- [x] `src/graphrag/spectral-clustering.ts` - NEW (SpectralClusteringManager)
- [x] `src/graphrag/types.ts` - MODIFY (Task.type, PredictedNode.source)
- [x] `src/graphrag/dag-suggester.ts` - MODIFY (suggestDAG, predictNextNodes, predictCapabilities)
- [x] `src/graphrag/mod.ts` - MODIFY (export SpectralClusteringManager)
- [x] `src/capabilities/capability-store.ts` - MODIFY (add searchByContext, toolsUsed extraction)
- [x] `src/capabilities/types.ts` - MODIFY (add toolsUsed field to Capability)
- [x] `src/dag/controlled-executor.ts` - MODIFY (add executeCapabilityTask)
- [x] `tests/unit/graphrag/mixed_dag_test.ts` - NEW (15 tests)
- [x] `tests/integration/dag/mixed_dag_integration_test.ts` - NEW (8 tests)

---

## Senior Developer Review (AI)

**Reviewer:** BMad Senior Developer (Adversarial Review) **Date:** 2025-12-10 **Outcome:** ✅
APPROVED (all issues fixed)

### Issues Found and Fixed

| #  | Issue                                                     | Severity | Resolution                                                                             |
| -- | --------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------- |
| 1  | AC#8 HypergraphPageRank not integrated                    | HIGH     | ✅ Fixed: Added PageRank scoring in `dag-suggester.ts:1446-1455`                       |
| 2  | `getCapabilityToolsUsed()` returning empty array          | MEDIUM   | ✅ Fixed: Added `toolsUsed` field to Capability type, extract from dag_structure       |
| 3  | Missing ControlledExecutor integration test               | MEDIUM   | ✅ Fixed: Added 2 integration tests in `mixed_dag_integration_test.ts`                 |
| 4  | AC#11 Checkpoint test incomplete                          | LOW      | ✅ Fixed: Added checkpoint persistence test with capability result validation          |
| 5  | SQL array handling needs validation                       | LOW      | ✅ Fixed: Added input validation in `searchByContext()` (max 256 chars, max 100 tools) |
| 6  | ADR-038 formula misalignment (additive vs multiplicative) | MEDIUM   | ✅ Fixed: `injectMatchingCapabilities()` now uses `overlap * (1 + boost)`              |
| 7  | Spectral clustering recomputed each call                  | LOW      | ✅ Fixed: Added TTL-based cache (5 min) in `SpectralClusteringManager`                 |
| 8  | `predictCapabilities()` missing spectral boost            | MEDIUM   | ✅ Fixed: Added cluster boost calculation per ADR-038 Strategic Discovery              |
| 9  | Test files missing permission documentation               | LOW      | ✅ Fixed: Added `@requires` JSDoc to test files                                        |
| 10 | `searchByContext()` missing edge case tests               | LOW      | ✅ Fixed: Added 3 edge case tests (empty, invalid, threshold)                          |

### Files Modified in Review (Final)

1. `src/capabilities/types.ts` - Added `toolsUsed?: string[]` field
2. `src/capabilities/capability-store.ts`:
   - Extract `tools_used` from dag_structure in `rowToCapability()`
   - Input validation in `searchByContext()` (Issue #5)
3. `src/graphrag/dag-suggester.ts`:
   - Fixed `getCapabilityToolsUsed()` to use `capability.toolsUsed`
   - Integrated HypergraphPageRank (Issue #1)
   - Use spectral clustering cache (Issue #7)
   - Fixed ADR-038 multiplicative formula in `injectMatchingCapabilities()` (Issue #6)
   - Added spectral boost to `predictCapabilities()` (Issue #8)
4. `src/graphrag/spectral-clustering.ts`:
   - Added `ClusterCache` interface
   - Added `restoreFromCacheIfValid()`, `saveToCache()`, `invalidateCache()` methods
   - 5-minute TTL cache for cluster assignments
5. `tests/integration/dag/mixed_dag_integration_test.ts`:
   - Added "ControlledExecutor executes capability task (AC#7)" test (Issue #3)
   - Added "Mixed DAG with checkpoint persistence (AC#11)" test (Issue #4)
   - Added `@requires` JSDoc for permissions (Issue #9)
6. `tests/unit/graphrag/mixed_dag_test.ts`:
   - Added `@requires` JSDoc for permissions (Issue #9)
7. `tests/unit/capabilities/capability_store_test.ts`:
   - Added 3 edge case tests for `searchByContext()` (Issue #10)

### Test Results

- **Mixed DAG tests:** 23 passed (8 integration + 15 unit)
- **CapabilityStore tests:** 23 passed (including 3 new edge case tests)
- **Type check:** Clean compilation
- **Regression:** No failures

### Recommendation

Story is **COMPLETE**. All acceptance criteria validated, all review issues fixed.

---

## Change Log

| Date       | Author             | Change                                                                                                                           |
| ---------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| 2025-12-09 | Dev Agent          | Initial implementation: Spectral clustering, DAGSuggester extension, mixed DAG types                                             |
| 2025-12-10 | BMad Review        | Fixed Issues #1-2 (HypergraphPageRank, toolsUsed)                                                                                |
| 2025-12-10 | BMad Review        | Fixed Issues #3-5, #7 (integration tests, input validation, caching)                                                             |
| 2025-12-10 | Adversarial Review | Fixed Issues #6, #8: ADR-038 multiplicative formula alignment in both `injectMatchingCapabilities()` and `predictCapabilities()` |
| 2025-12-10 | Adversarial Review | Fixed Issues #9, #10: Test permission docs, searchByContext edge case tests                                                      |
