## Pattern 4: 3-Loop Learning Architecture (Adaptive DAG Feedback Loops)

> **ADRs:** ADR-007 (Adaptive Feedback Loops), ADR-008 (Episodic Memory), ADR-020 (AIL Control
> Protocol)
>
> **⚠️ UPDATE 2025-11-24:** AIL/HIL implementation uses ADR-020 unified command architecture
> (L1-L2). ADR-019 superseded. HTTP response pattern (not SSE streaming) for MCP compatibility.

**Problem:** Enable truly adaptive workflows that learn and improve over time through
agent-in-the-loop (AIL) and human-in-the-loop (HIL) decision points, with dynamic re-planning and
continuous meta-learning.

**Vision:** Three distinct learning loops operating at different timescales:

- **Loop 1 (Execution):** Real-time workflow execution with event streaming (milliseconds)
- **Loop 2 (Adaptation):** Runtime decision-making and DAG replanning (seconds-minutes)
- **Loop 3 (Meta-Learning):** Continuous improvement of the knowledge graph (per-workflow)

**Challenge:** Current DAG executor runs linearly without:

- Agent decision points (AIL) - agent cannot inject new tools based on discoveries
- Human approval checkpoints (HIL) - no way to pause for confirmation
- Multi-turn state persistence - conversations don't survive across turns
- Dynamic DAG modification - cannot add/remove nodes during execution
- GraphRAG re-planning - no feedback loop to improve suggestions
- Adaptive learning - no mechanism to learn optimal patterns over time

**Critical Distinction: Knowledge Graph vs Workflow Graph**

⚠️ **Two Separate Concepts:**

**GraphRAG (Knowledge Graph)** = Permanent knowledge base

- **Nodes:** Available tools in the system (e.g., `filesystem:read`, `json:parse`)
- **Edges:** Relationships between tools (co-occurrence, dependencies, success patterns)
- **Storage:** PGlite (persistent database)
- **Algorithms:** PageRank, Louvain, vector search
- **Purpose:** Source of truth for tool suggestions
- **Managed by:** `GraphRAGEngine` (src/graphrag/graph-engine.ts)
- **Updates:** Learns from every workflow execution

**DAG (Workflow Execution Graph)** = Ephemeral execution plan

- **Nodes:** Specific tasks to execute for THIS workflow (e.g., "read config.json", "parse it",
  "validate")
- **Edges:** Execution order dependencies
- **Storage:** In-memory + checkpoints (for resume)
- **Purpose:** Blueprint for current workflow only
- **Created by:** `DAGSuggester` (src/graphrag/dag-suggester.ts)
- **Lifetime:** Created → Modified during execution → Discarded after completion

**Relationship:**

```
DAGSuggester (Workflow Layer)
    ↓ queries
GraphRAGEngine (Knowledge Graph Layer)
    ↓ reads/writes
PGlite (Storage: tools, edges, embeddings)
```

---

**Solution Architecture:**

## Components:

**1. ControlledExecutor** (`src/dag/controlled-executor.ts`)

- Extends `ParallelExecutor` (zero breaking changes)
- Event stream for real-time observability
- Command queue for non-blocking control
- State management with MessagesState-inspired reducers

**2. WorkflowState with Reducers**

```typescript
interface WorkflowState {
  messages: Message[]; // Agent/human messages (reducer: append)
  tasks: TaskResult[]; // Completed tasks (reducer: append)
  decisions: Decision[]; // AIL/HIL decisions (reducer: append)
  context: Record<string, any>; // Shared context (reducer: merge)
  checkpoint_id?: string; // Resume capability
}

// MessagesState-inspired reducers (LangGraph v1.0 pattern)
const reducers = {
  messages: (existing, update) => [...existing, ...update],
  tasks: (existing, update) => [...existing, ...update],
  decisions: (existing, update) => [...existing, ...update],
  context: (existing, update) => ({ ...existing, ...update }),
};
```

**3. Event Stream** (TransformStream API)

```typescript
// Real-time observability
eventStream.emit({
  type: "task_completed",
  taskId: "parse_json",
  result: { parsed: {...} },
  timestamp: Date.now()
});

// Consumers can subscribe
executor.eventStream.subscribe((event) => {
  if (event.type === "task_completed") {
    // Agent can decide next action based on result
  }
});
```

**4. Command Queue** (AsyncQueue pattern)

```typescript
// Agent/Human inject commands
commandQueue.enqueue({
  type: "inject_tasks",
  tasks: [{ toolId: "xml:parse", inputs: {...} }]
});

// Executor processes between layers (non-blocking)
await this.processCommands();
```

**5. GraphRAG Integration** (Feedback Loop)

**⚠️ ARCHITECTURE LAYERS:**

**Layer 1: DAGSuggester** (Workflow Layer) - `src/graphrag/dag-suggester.ts`

```typescript
export class DAGSuggester {
  constructor(
    private graphEngine: GraphRAGEngine, // Uses knowledge graph
    private vectorSearch: VectorSearch,
  ) {}

  // ✅ EXISTS - Initial DAG suggestion
  async suggestDAG(intent: WorkflowIntent): Promise<SuggestedDAG | null> {
    // 1. graphEngine.vectorSearch(query) → Find relevant tools
    // 2. graphEngine.getPageRank(toolId) → Rank by importance
    // 3. graphEngine.buildDAG(toolIds) → Construct workflow DAG
  }

  // ✅ NEW METHOD - Dynamic re-planning during execution
  async replanDAG(
    currentDAG: DAGStructure,
    newContext: {
      completedTasks: TaskResult[];
      newRequirement: string;
      availableContext: Record<string, any>;
    },
  ): Promise<DAGStructure> {
    // 1. graphEngine.vectorSearch(newRequirement) → New tools
    // 2. graphEngine.findShortestPath(current, target) → Optimize path
    // 3. graphEngine.buildDAG([...existing, ...new]) → Augmented DAG
  }

  // ✅ NEW METHOD - Speculative prediction
  async predictNextNodes(
    state: WorkflowState,
    completed: TaskResult[],
  ): Promise<PredictedNode[]> {
    // 1. Analyze completed task patterns in GraphRAG
    // 2. graphEngine.findCommunityMembers(lastTool) → Tools often used after
    // 3. graphEngine.getPageRank() → Confidence score
  }
}
```

**Layer 2: GraphRAGEngine** (Knowledge Graph Layer) - `src/graphrag/graph-engine.ts`

```typescript
export class GraphRAGEngine {
  // ✅ EXISTS - Used by suggestDAG()
  async vectorSearch(query: string, k: number): Promise<Tool[]>;
  getPageRank(toolId: string): number;
  buildDAG(toolIds: string[]): DAGStructure;

  // ✅ EXISTS - Used by replanDAG()
  findShortestPath(from: string, to: string): string[];
  findCommunityMembers(toolId: string): string[];

  // ✅ EXISTS - Feedback learning
  async updateFromExecution(execution: WorkflowExecution): Promise<void> {
    // - Extract dependencies from executed DAG
    // - Update tool co-occurrence edges in knowledge graph
    // - Recompute PageRank weights
    // - Persist to PGlite
  }
}
```

---

## Complete Feedback Loop (3 Phases):

```
┌───────────────────────────────────────────────────────────┐
│        Adaptive DAG Feedback Loop Architecture            │
└───────────────────────────────────────────────────────────┘

PHASE 1: INITIAL SUGGESTION (Knowledge → Workflow)
┌────────────┐
│   User     │ "Analyze JSON files in ./data/"
└─────┬──────┘
      │
      ▼
┌──────────────────┐
│  DAGSuggester    │ Queries knowledge graph
│  .suggestDAG()   │ → vectorSearch("analyze JSON")
└─────┬────────────┘ → PageRank ranking
      │ uses        → buildDAG()
      ▼
┌──────────────────┐
│ GraphRAGEngine   │ Knowledge graph operations
│ (Knowledge Base) │ Tools: [list_dir, read_json, analyze]
└─────┬────────────┘
      │ returns
      ▼
┌──────────────────┐
│  Workflow DAG    │ Tasks: list_dir → read_json → analyze
└─────┬────────────┘

PHASE 2: ADAPTIVE EXECUTION (Runtime Discovery & Re-planning)
      │
      ▼
┌────────────────────────────────────────┐
│      ControlledExecutor                │
│                                        │
│  Layer 1: list_dir                    │
│           └─► Discovers XML files!    │
│               │                        │
│               ▼                        │
│         AIL Decision:                  │
│         "Need XML parser too"          │
│               │                        │
│               ▼                        │
│    CommandQueue.enqueue({              │
│      type: "replan_dag",               │
│      requirement: "parse XML"          │
│    })                                  │
│               │                        │
│               ▼                        │
│    DAGSuggester.replanDAG()            │
│      → queries GraphRAG                │
│      → finds "xml:parse" tool          │
│      → returns augmented DAG           │
│               │                        │
│               ▼                        │
│    Inject new node: parse_xml          │
│                                        │
│  Layer 2: [read_json, parse_xml] NEW  │
│           └─► Both execute in parallel │
│               │                        │
│               ▼                        │
│         HIL Checkpoint:                │
│         "Approve before analyze?"      │
│         Human: "Yes, proceed"          │
│                                        │
│  Layer 3: analyze (updated context)    │
│                                        │
└────────┬───────────────────────────────┘
         │
         ▼

PHASE 3: LEARNING (Workflow → Knowledge)
┌─────────────────────────────────┐
│  GraphRAGEngine                 │
│  .updateFromExecution()         │
│                                 │
│  Updates Knowledge Graph:       │
│  ✓ Add edge: list_dir → parse_xml │
│  ✓ Strengthen: parse → analyze  │
│  ✓ Update PageRank weights      │
│  ✓ Store user preferences       │
│  ✓ Persist to PGlite            │
└────────┬────────────────────────┘
         │
         ▼
┌─────────────────────────────────┐
│  Enriched Knowledge Graph       │
│  Better suggestions next time!  │
└─────────────────────────────────┘

NEXT WORKFLOW: Cycle improves
  User: "Analyze data files"
      ↓
  DAGSuggester queries enriched graph
      ↓
  Suggests: [list_dir, read_json, parse_xml, analyze]
      ↓
  XML parser included proactively! ✨
```

---

## 4 Roles of GraphRAG in Feedback Loop:

**Role 1: Initial Workflow Suggestion**

- User provides intent → DAGSuggester queries GraphRAG
- Vector search finds relevant tools
- PageRank ranks by importance
- buildDAG creates initial workflow

**Role 2: Dynamic Re-planning (AIL/HIL)**

- Agent/Human discovers new requirement mid-execution
- DAGSuggester.replanDAG() re-queries GraphRAG
- Finds additional tools needed
- Injects new nodes into running DAG

**Role 3: Speculative Prediction**

- During agent thinking, predict next likely tools
- DAGSuggester.predictNextNodes() queries community members
- High confidence (>0.7) → execute speculatively
- Results ready when agent needs them (0ms latency)

**Role 4: Learning & Enrichment**

- After workflow completion, update knowledge graph
- GraphRAGEngine.updateFromExecution() stores patterns
- Tool co-occurrence edges strengthened
- PageRank recomputed with new data
- User preferences learned

---

## Integration with ControlledExecutor:

```typescript
class ControlledExecutor extends ParallelExecutor {
  private dagSuggester: DAGSuggester; // Workflow layer
  private graphEngine: GraphRAGEngine; // Knowledge layer
  private state: WorkflowState;
  private commandQueue: AsyncQueue<Command>;
  private eventStream: TransformStream<ExecutionEvent>;

  async executeWithControl(dag: DAGStructure, config: ExecutionConfig) {
    // Before each layer: Speculative prediction
    if (config.speculation.enabled) {
      const predictions = await this.dagSuggester.predictNextNodes(
        this.state,
        this.state.tasks,
      );
      // Execute high-confidence predictions speculatively
      this.startSpeculativeExecution(predictions);
    }

    // Process commands (may include replan requests)
    await this.processCommands();

    // Execute layer with event streaming
    for (const layer of this.layers) {
      for (const task of layer) {
        const result = await this.executeTask(task);
        this.eventStream.emit({ type: "task_completed", task, result });

        // Update state with reducers
        this.updateState({ tasks: [result] });
      }
    }

    // After execution: Update knowledge graph
    await this.graphEngine.updateFromExecution({
      workflow_id: this.executionId,
      executed_dag: dag,
      execution_results: this.state.tasks,
      timestamp: new Date(),
      success: true,
    });
  }

  private async handleReplanCommand(cmd: ReplanCommand) {
    // DAGSuggester re-queries GraphRAG for new tools
    const updatedDAG = await this.dagSuggester.replanDAG(
      this.currentDAG,
      {
        completedTasks: this.state.tasks,
        newRequirement: cmd.requirement,
        availableContext: this.state.context,
      },
    );

    // Merge new nodes into current DAG
    this.mergeDynamicNodes(updatedDAG.newNodes);
  }
}
```

---

## Benefits:

**Immediate:**

- ✅ **Adaptive workflows:** Plans adjust in real-time based on discoveries
- ✅ **Smart predictions:** Speculation based on real usage patterns
- ✅ **Progressive discovery:** Don't need to predict everything upfront
- ✅ **Context-aware:** Suggestions consider current workflow state

**Long-term Learning:**

- ✅ **Pattern recognition:** Detects frequent tool sequences
- ✅ **User preferences:** Learns from human decisions
- ✅ **Error avoidance:** Tools that fail together → lower rank
- ✅ **Efficiency:** Optimal paths reinforced by PageRank

**Example Learning Cycle:**

```
Week 1: User often "list_dir → find XML → need parse_xml"
        → GraphRAGEngine learns pattern (updateFromExecution)
        → Edge list_dir → parse_xml added to knowledge graph

Week 2: list_dir finds XML
        → DAGSuggester queries GraphRAG
        → GraphRAG suggests parse_xml proactively (confidence 0.85)
        → Speculation executes it
        → User: "Perfect!" ✅
        → Pattern reinforced in knowledge graph

Week 3: Same scenario
        → Confidence now 0.92 (stronger edge weight)
        → Speculation happens automatically
        → 0ms perceived latency 🚀
```

---

## Checkpoint Architecture & Workflow State

**What Checkpoints Save:**

Checkpoints sauvegardent l'état complet du workflow dans PGlite :

```typescript
interface Checkpoint {
  id: string;
  workflow_id: string;
  timestamp: Date;
  layer: number; // Current DAG layer
  state: WorkflowState; // Complete workflow state
}

interface WorkflowState {
  workflow_id: string;
  current_layer: number;
  tasks: TaskResult[]; // Completed tasks with results
  decisions: Decision[]; // AIL/HIL decisions made
  commands: Command[]; // Pending commands
  messages: Message[]; // Multi-turn conversation
  context: Record<string, any>; // Workflow context
}
```

**What Checkpoints DON'T Save:**

- ❌ Filesystem state (modified files)
- ❌ External side-effects (API calls, DB writes)
- ❌ Code diffs or file changes

**Why This Works for Epic 2.5:**

- Epic 2.5 workflows = **orchestration primarily** (AIL/HIL decisions, GraphRAG queries, DAG
  replanning)
- File modifications **delegated to Epic 3** (Sandbox isolation)
- Tasks requiring file changes → **idempotence required** (documented per story)

**Resume Behavior:**

- ✅ **Read-only workflows:** Perfect resume (zero data loss)
- ⚠️ **Workflows with modifications:** Tasks re-execute (idempotency ensures safety)
- 🎯 **Epic 3 (future):** Sandbox isolation eliminates this concern entirely

---

## Context Management & Agent Architecture

**Architecture Principle:** Un seul agent en conversation continue

Epic 2.5 utilise un seul agent Claude qui exécute le DAG via ses MCP tools et prend toutes les
décisions (AIL) dans sa conversation continue.

```typescript
class ControlledExecutor {
  private agent: ClaudeAgent;  // Un agent, une conversation

  async executeStream(dag: DAGStructure) {
    for (const layer of layers) {
      // Agent exécute les tasks via MCP tools
      // Les résultats MCP apparaissent dans SA conversation
      const results = await this.executeLayer(layer);

      // Checkpoint (état workflow sauvegardé)
      yield { type: "checkpoint", state: this.state };

      // AIL: Agent continue sa conversation
      const decision = await this.agent.continue(
        `Layer ${layer} completed. Continue or replan?`
      );

      // ✅ Agent voit tous les MCP results (comportement naturel Claude)
      // ✅ Pas de filtering contexte
      // ✅ Décisions informées avec contexte complet
    }
  }
}
```

**Principes Clés:**

- ✅ **Agent voit tous les MCP results:** Comportement normal de Claude (comme Bash, Read, etc.)
- ✅ **Conversation continue:** Pas de re-contexte, pas de pruning, pas de summary pour agent
- ✅ **MCP tools filtrent naturellement:** Les tools retournent résultats pertinents (top-k, search,
  etc.)
- ✅ **Décisions AIL informées:** Agent a accès à l'intégralité des résultats
- ✅ **Summary pour HIL uniquement:** Génération de résumés pour affichage UI humain (~500-1000
  tokens)

**Coût Contexte:**

- **AIL:** Minimal (agent continue sa conversation avec MCP results déjà visibles)
- **HIL:** ~500-1000 tokens (génération summary pour affichage UI une fois)

**Note:** Les stratégies de "context pruning" ou "progressive summarization" seraient utiles
uniquement pour des architectures multi-agents (supervisor ≠ executor), ce qui n'est pas le cas
d'Epic 2.5.

---

## Performance Targets:

- Event stream overhead: <5ms per event
- Command queue latency: <10ms from enqueue to process
- State update: <1ms per reducer operation
- GraphRAG query (replan): <200ms
- Checkpoint save: <50ms (PGlite)
- Total feedback loop: <300ms end-to-end

## Implementation Plan:

**Epic 2.5:** Adaptive DAG Feedback Loops (9-13 hours)

**Story 2.5-1:** Event Stream + Command Queue + State Management (3-4h)

- ControlledExecutor foundation
- Event stream with TransformStream
- Command queue with AsyncQueue
- State reducers (MessagesState pattern)

**Story 2.5-2:** Checkpoint & Resume (2-3h)

- WorkflowState persistence to PGlite
- Resume from checkpoint
- State pruning strategy

**Story 2.5-3:** AIL/HIL Integration (2-3h)

- Agent decision points
- Human approval checkpoints
- Command injection patterns
- DAGSuggester.replanDAG() integration

**Story 2.5-4:** Speculative Execution + GraphRAG (3-4h)

- DAGSuggester.predictNextNodes()
- Confidence-based speculation
- GraphRAGEngine.updateFromExecution()
- Feedback loop validation

---

**Affects Epics:** Epic 2.5 (Stories 2.5-1 through 2.5-4)

**References:**

- ADR-007: `docs/adrs/ADR-007-dag-adaptive-feedback-loops.md`
- Research: `docs/research-technical-2025-11-13.md`
- Spike: `docs/spikes/spike-agent-human-dag-feedback-loop.md`

**Design Philosophy:** Feedback loops enable truly intelligent workflows that learn and adapt. The
distinction between knowledge graph (permanent learning) and workflow graph (ephemeral execution) is
critical for understanding the architecture.

---
