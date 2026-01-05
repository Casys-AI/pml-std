# Epic Technical Specification: Adaptive DAG Feedback Loops (Foundation)

Date: 2025-11-14 Author: Bob (Scrum Master) via BMM Workflow Epic ID: 2.5 Status: Ready for Story
Generation

> **⚠️ UPDATE 2025-11-24:** AIL/HIL implementation clarified. Story 2.5-3 SSE pattern incompatible
> with MCP one-shot protocol. See **ADR-019: Two-Level AIL Architecture** for MCP-compatible HTTP
> response pattern. Loop 2 details updated accordingly.

---

## Overview

Epic 2.5 établit la fondation pour workflows adaptatifs via une architecture 3-Loop Learning qui
permet aux workflows de s'ajuster dynamiquement pendant l'exécution. Contrairement au
`ParallelExecutor` actuel qui exécute un DAG linéairement sans possibilité d'interaction, le nouveau
`ControlledExecutor` introduit trois boucles d'apprentissage opérant à différentes échelles
temporelles : **Loop 1 (Execution)** fournit observabilité temps réel via event stream et contrôle
dynamique via command queue ; **Loop 2 (Adaptation)** permet des décisions Agent-in-the-Loop (AIL)
et Human-in-the-Loop (HIL) avec re-planification dynamique du DAG ; **Loop 3 (Meta-Learning)**
commence l'enrichissement du knowledge graph avec patterns d'exécution.

Cette architecture hybride combine best practices de LangGraph MessagesState (reducers automatiques
pour state management robuste) avec Event-Driven patterns (observability complète), atteignant un
score 95/100 après analyse comparative. Epic 2.5 se concentre sur **l'orchestration et la décision**
(pas l'exécution de code), avec checkpoints sauvegardant WorkflowState complet (tasks, decisions,
messages, context) dans PGlite. La speculation et l'episodic memory sont **déférées** : Epic 3.5
implémentera speculation WITH sandbox isolation (THE feature safe), et Epic 4 (ADR-008) ajoutera
episodic memory + adaptive thresholds avec données réelles de production.

## Objectives and Scope

### In Scope

**Loop 1 (Execution - Temps Réel):**

- ✅ Event stream observable pour monitoring en temps réel (TransformStream API)
- ✅ Command queue non-bloquant pour contrôle dynamique (AsyncQueue pattern)
- ✅ State management avec reducers MessagesState-inspired (messages, tasks, decisions, context)
- ✅ Checkpoint & resume infrastructure (PGlite persistence, 5 checkpoints retention)

**Loop 2 (Adaptation - Runtime):**

- ✅ Agent-in-the-Loop (AIL): Décisions autonomes pendant exécution
- ✅ Human-in-the-Loop (HIL): Validation humaine pour opérations critiques
- ✅ DAG replanning dynamique via `DAGSuggester.replanDAG()`
- ✅ Multi-turn state persistence pour conversations

**Loop 3 (Meta-Learning - Basic):**

- ✅ GraphRAG updates from execution patterns via `GraphRAGEngine.updateFromExecution()`
- ✅ Co-occurrence learning (tools utilisés ensemble)
- ✅ Foundation pour futures optimisations

**Architecture:**

- ✅ `ControlledExecutor` extends `ParallelExecutor` (zero breaking changes)
- ✅ Speedup 5x préservé (parallélisme maintenu)
- ✅ Un seul agent en conversation continue (pas de filtering contexte)
- ✅ Workflows = orchestration primarily (idempotence documentée si modifications)

### Out of Scope (Deferred)

**Epic 3.5 (Speculation with Sandbox):**

- ❌ `DAGSuggester.predictNextNodes()` - Prédiction spéculative des prochains nodes
- ❌ Confidence-based speculation (threshold 0.7+)
- ❌ Speculative execution (0ms perceived latency)
- **Rationale:** Speculation SANS sandbox = risqué (side-effects non isolés)

**Epic 4 (ADR-008 - Episodic Memory & Adaptive Learning):**

- ❌ Episodic memory storage (hybrid JSONB + typed columns)
- ❌ Context-aware episode retrieval for prediction boost
- ❌ Adaptive threshold learning (EMA algorithm, 0.92 → 0.70-0.95)
- ❌ Per-workflow-type threshold convergence
- ❌ Advanced state pruning strategy
- **Rationale:** Nécessite données réelles de production (après Epic 2.5 + Epic 3)

**General Out of Scope:**

- ❌ Filesystem state persistence (Epic 3 Sandbox gérera isolation complète)
- ❌ External side-effects rollback (API calls, DB writes)
- ❌ Distributed execution (local-only MVP)

## System Architecture Alignment

**Extends Existing Components:**

- `ParallelExecutor` (`src/dag/executor.ts`) → Extended by `ControlledExecutor` (backward
  compatible)
- `DAGSuggester` (`src/graphrag/dag-suggester.ts`) → Add `replanDAG()` method (queries GraphRAG)
- `GraphRAGEngine` (`src/graphrag/graph-engine.ts`) → Use existing `updateFromExecution()` (feedback
  loop)

**New Components:**

- `ControlledExecutor` (`src/dag/controlled-executor.ts`) → Event stream + command queue + state
  reducers
- `WorkflowState` (`src/dag/state.ts`) → MessagesState-inspired with reducers (messages, tasks,
  decisions, context)
- `CommandQueue` (`src/dag/command-queue.ts`) → AsyncQueue for non-blocking control
- `EventStream` (`src/dag/event-stream.ts`) → TransformStream for real-time observability
- Checkpoint infrastructure → PGlite persistence (table: `workflow_checkpoint`)

**Architecture Pattern:** Pattern 4 - 3-Loop Learning Architecture (ADR-007 v2.0)

**Key Constraints:**

- **Performance:** Speedup 5x preserved (checkpoint overhead <50ms)
- **Compatibility:** Zero breaking changes (extension pattern)
- **Memory:** State footprint <10MB (pruning strategy)
- **Storage:** PGlite checkpoints (5 most recent per workflow)

**Integration Points:**

- GraphRAG Knowledge Graph → DAGSuggester queries for replanning
- Vector Search → Tool discovery during re-planning
- PGlite → Checkpoint persistence + GraphRAG updates
- MCP Gateway → Un seul agent exécute tasks et prend décisions

## Detailed Design

### Services and Modules

| Module                          | Responsibility                                                                   | Inputs                            | Outputs                                           | Owner              |
| ------------------------------- | -------------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------- | ------------------ |
| **ControlledExecutor**          | Orchestrate DAG execution with event stream, command queue, and state management | `DAGStructure`, `ExecutionConfig` | `AsyncGenerator<ExecutionEvent>`, `WorkflowState` | Epic 2.5           |
| **WorkflowState**               | Maintain workflow state with MessagesState-inspired reducers                     | State updates (partial)           | Complete state snapshot                           | Epic 2.5           |
| **CommandQueue**                | Non-blocking command injection for agent/human control                           | `Command[]`                       | Processed commands                                | Epic 2.5           |
| **EventStream**                 | Real-time observability via TransformStream                                      | Execution events                  | `ExecutionEvent` stream                           | Epic 2.5           |
| **CheckpointManager**           | Persist and resume workflow state from PGlite                                    | `WorkflowState`, `workflow_id`    | `Checkpoint`                                      | Epic 2.5           |
| **DAGSuggester** (extended)     | Dynamic replanning via GraphRAG queries                                          | `WorkflowState`, new requirements | Updated `DAGStructure`                            | Epic 2.5 extension |
| **GraphRAGEngine** (existing)   | Update knowledge graph from execution patterns                                   | `WorkflowExecution`               | Updated graph edges                               | Epic 1 (reused)    |
| **ParallelExecutor** (existing) | Base parallel layer execution (extended, not replaced)                           | `DAGStructure`                    | `DAGExecutionResult`                              | Epic 2 (base)      |

**Key Architectural Decisions:**

- `ControlledExecutor` **extends** `ParallelExecutor` → Zero breaking changes
- State reducers inspired by LangGraph MessagesState → 15% code reduction vs manual
- Event stream for observability → Non-blocking, real-time monitoring
- Command queue for control → Agent + Human can inject commands dynamically

### Data Models and Contracts

```typescript
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// WorkflowState - MessagesState-inspired with reducers
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

interface WorkflowState {
  workflow_id: string;              // Unique workflow identifier
  current_layer: number;            // Current DAG layer being executed
  messages: Message[];              // Multi-turn conversation (reducer: append)
  tasks: TaskResult[];              // Completed tasks (reducer: append)
  decisions: Decision[];            // AIL/HIL decisions (reducer: append)
  context: Record<string, any>;     // Shared workflow context (reducer: merge)
  checkpoint_id?: string;           // Resume capability
}

// Reducers (automatic state updates)
const reducers = {
  messages: (existing: Message[], update: Message[]) => [...existing, ...update],
  tasks: (existing: TaskResult[], update: TaskResult[]) => [...existing, ...update],
  decisions: (existing: Decision[], update: Decision[]) => [...existing, ...update],
  context: (existing: Record<string, any>, update: Record<string, any>) =>
    ({ ...existing, ...update })
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Message Types
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

type Message =
  | { role: "agent"; content: string; timestamp: Date }
  | { role: "human"; content: string; timestamp: Date }
  | { role: "system"; content: string; timestamp: Date };

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TaskResult
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

interface TaskResult {
  task_id: string;                  // Unique task identifier
  tool_id: string;                  // MCP tool executed
  inputs: Record<string, unknown>;  // Tool inputs
  result: unknown;                  // Tool result
  status: "success" | "failure";
  error?: Error;
  duration_ms: number;
  timestamp: Date;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Decision Types (AIL/HIL)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

type Decision =
  | { type: "ail"; action: "continue" | "replan" | "abort"; reasoning: string; timestamp: Date }
  | { type: "hil"; action: "approve" | "reject" | "modify"; feedback?: string; timestamp: Date };

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Command Types (Control Queue)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

type Command =
  | { type: "abort"; reason: string }
  | { type: "inject_tasks"; tasks: Task[] }
  | { type: "replan_dag"; requirement: string; context: Record<string, any> }
  | { type: "skip_layer"; layer_index: number }
  | { type: "modify_args"; task_id: string; new_args: Record<string, unknown> }
  | { type: "checkpoint_response"; approved: boolean };

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Event Types (Observability Stream)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

type ExecutionEvent =
  | { type: "workflow_start"; workflow_id: string; dag: DAGStructure; timestamp: Date }
  | { type: "layer_start"; layer: number; tasks: Task[]; timestamp: Date }
  | { type: "task_start"; task_id: string; tool_id: string; timestamp: Date }
  | { type: "task_complete"; task_id: string; result: TaskResult; timestamp: Date }
  | { type: "task_error"; task_id: string; error: Error; timestamp: Date }
  | { type: "state_updated"; state: WorkflowState; timestamp: Date }
  | { type: "checkpoint"; checkpoint_id: string; state: WorkflowState; timestamp: Date }
  | { type: "decision_required"; decision_type: "ail" | "hil"; context: string; timestamp: Date }
  | { type: "workflow_complete"; state: WorkflowState; duration_ms: number; timestamp: Date };

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Checkpoint (PGlite Persistence)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

interface Checkpoint {
  id: string;                       // UUID
  workflow_id: string;              // Parent workflow
  timestamp: Date;                  // Checkpoint creation time
  layer: number;                    // Current DAG layer
  state: WorkflowState;             // Complete state snapshot (JSONB)
}

// Database schema (PGlite)
CREATE TABLE workflow_checkpoint (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  layer INTEGER NOT NULL,
  state JSONB NOT NULL,
  CONSTRAINT fk_workflow FOREIGN KEY (workflow_id)
    REFERENCES workflow_execution(id) ON DELETE CASCADE
);

-- Retention: Keep 5 most recent per workflow
CREATE INDEX idx_checkpoint_workflow_ts
  ON workflow_checkpoint(workflow_id, timestamp DESC);
```

### APIs and Interfaces

#### ControlledExecutor API

```typescript
export class ControlledExecutor extends ParallelExecutor {
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Primary Execution Method (Generator Pattern)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  async *executeStream(
    dag: DAGStructure,
    config: ExecutionConfig,
  ): AsyncGenerator<ExecutionEvent, WorkflowState, void> {
    // Yields events in real-time
    // Returns final WorkflowState
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Resume from Checkpoint
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  async *resumeFromCheckpoint(
    checkpoint_id: string,
    config: ExecutionConfig,
  ): AsyncGenerator<ExecutionEvent, WorkflowState, void>;

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Command Queue API (Non-Blocking Control)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  enqueueCommand(command: Command): void;

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // State Management
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  getState(): Readonly<WorkflowState>;
  updateState(update: Partial<WorkflowState>): void; // Uses reducers
}
```

#### DAGSuggester Extended API

```typescript
export class DAGSuggester {
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // ✅ EXISTING - Initial DAG suggestion (Epic 2)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  async suggestDAG(intent: WorkflowIntent): Promise<SuggestedDAG | null>;

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // ✅ NEW - Dynamic Re-planning (Epic 2.5)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  async replanDAG(
    currentDAG: DAGStructure,
    newContext: {
      completedTasks: TaskResult[];
      newRequirement: string;
      availableContext: Record<string, any>;
    },
  ): Promise<DAGStructure>;
  // Queries GraphRAG for new tools
  // Merges with existing DAG
  // Returns augmented DAG structure
}
```

#### CheckpointManager API

```typescript
export class CheckpointManager {
  // Save checkpoint to PGlite
  async saveCheckpoint(
    workflow_id: string,
    layer: number,
    state: WorkflowState,
  ): Promise<Checkpoint>;

  // Load checkpoint by ID
  async loadCheckpoint(checkpoint_id: string): Promise<Checkpoint | null>;

  // Get latest checkpoint for workflow
  async getLatestCheckpoint(workflow_id: string): Promise<Checkpoint | null>;

  // Cleanup old checkpoints (keep 5 most recent)
  async pruneCheckpoints(workflow_id: string): Promise<void>;
}
```

#### ExecutionConfig

```typescript
interface ExecutionConfig {
  workflow_id: string;
  checkpoints: {
    enabled: boolean; // Enable/disable checkpointing
    frequency: "per_layer" | "per_task" | "manual";
  };
  ail: {
    enabled: boolean; // Agent-in-the-Loop decisions
    decision_points: "per_layer" | "on_error" | "manual";
  };
  hil: {
    enabled: boolean; // Human-in-the-Loop validation
    approval_required: "always" | "critical_only" | "never";
  };
  timeout_ms: number; // Per-task timeout (default: 30000)
}
```

### Workflows and Sequencing

#### Workflow 1: Normal Execution with AIL (Agent-in-the-Loop)

```
┌─────────────────────────────────────────────────────────────┐
│          ControlledExecutor - AIL Workflow                   │
└─────────────────────────────────────────────────────────────┘

1. Start Execution
   ├─► Emit: { type: "workflow_start", workflow_id, dag }
   └─► Initialize WorkflowState with reducers

2. For Each DAG Layer:
   ├─► Emit: { type: "layer_start", layer, tasks }
   │
   ├─► Process Command Queue (non-blocking)
   │   └─► Handle: abort, inject_tasks, replan_dag, etc.
   │
   ├─► Execute Layer Tasks in Parallel (Promise.all)
   │   ├─► For each task:
   │   │   ├─► Emit: { type: "task_start", task_id, tool_id }
   │   │   ├─► Execute MCP tool
   │   │   └─► Emit: { type: "task_complete", result }
   │   │           OR { type: "task_error", error }
   │
   ├─► Update State with Reducers
   │   └─► this.updateState({ tasks: results })
   │       └─► Automatic reducer: [...existing, ...update]
   │
   ├─► Save Checkpoint to PGlite
   │   └─► Emit: { type: "checkpoint", checkpoint_id, state }
   │
   ├─► AIL Decision Point (if enabled)
   │   ├─► Emit: { type: "decision_required", decision_type: "ail" }
   │   ├─► Agent evaluates: "Continue or replan?"
   │   ├─► Agent sees ALL MCP results (natural conversation)
   │   └─► Decision options:
   │       ├─► "continue" → Next layer
   │       ├─► "replan" → DAGSuggester.replanDAG()
   │       │              ├─► Queries GraphRAG
   │       │              ├─► Finds new tools
   │       │              └─► Injects new nodes into DAG
   │       └─► "abort" → Workflow terminates
   │
   └─► Repeat for next layer

3. Workflow Complete
   ├─► Update GraphRAG: GraphRAGEngine.updateFromExecution()
   │   ├─► Extract tool co-occurrence patterns
   │   ├─► Update edge weights in knowledge graph
   │   └─► Recompute PageRank
   │
   ├─► Emit: { type: "workflow_complete", state, duration_ms }
   └─► Return final WorkflowState
```

#### Workflow 2: HIL Approval for Critical Operations

```
┌─────────────────────────────────────────────────────────────┐
│          ControlledExecutor - HIL Workflow                   │
└─────────────────────────────────────────────────────────────┘

1. Layer Execution Complete
   └─► Checkpoint saved

2. HIL Decision Point (if approval_required)
   ├─► Emit: { type: "decision_required", decision_type: "hil" }
   │
   ├─► Generate Summary for Human (500-1000 tokens)
   │   └─► Summarize: completed tasks, results, next layer preview
   │
   ├─► Display to Human via UI
   │   └─► Options: [Approve] [Reject] [Modify]
   │
   ├─► Human Response → Command Queue
   │   └─► { type: "checkpoint_response", approved: true/false }
   │
   └─► Process Response:
       ├─► "Approve" → Continue to next layer
       ├─► "Reject" → Abort workflow
       └─► "Modify" → Allow human to inject commands
                      └─► { type: "inject_tasks", tasks: [...] }

3. Continue Execution
   └─► Next layer starts with human-approved context
```

#### Workflow 3: Resume from Checkpoint

```
┌─────────────────────────────────────────────────────────────┐
│          Resume from Checkpoint Workflow                     │
└─────────────────────────────────────────────────────────────┘

1. Load Checkpoint
   ├─► CheckpointManager.loadCheckpoint(checkpoint_id)
   └─► Restore WorkflowState:
       ├─► workflow_id
       ├─► current_layer (e.g., layer 2 if crashed during layer 3)
       ├─► tasks[] (all completed tasks from layers 0-2)
       ├─► decisions[] (AIL/HIL decisions made)
       ├─► messages[] (multi-turn conversation history)
       └─► context (shared workflow context)

2. Reconstruct DAG
   ├─► Reload original DAG structure
   └─► Mark layers 0-2 as "completed" (skip)

3. Resume Execution
   ├─► Start from current_layer + 1 (layer 3)
   ├─► Agent has full conversation context (messages[])
   ├─► Agent sees all previous results (tasks[])
   └─► Execute remaining layers normally

4. Note: Idempotence Requirement
   └─► If tasks modified filesystem:
       └─► Tasks MUST be idempotent (re-run safe)
       └─► Epic 3 (Sandbox) will eliminate this concern
```

#### Workflow 4: Dynamic DAG Replanning (Agent Discovery)

```
┌─────────────────────────────────────────────────────────────┐
│          Dynamic Replanning - Agent Discovery                │
└─────────────────────────────────────────────────────────────┘

Initial DAG:
  Layer 0: [list_directory]  → Discovers JSON + XML files
  Layer 1: [parse_json]

Execution Flow:
1. Layer 0 Executes
   └─► list_directory returns: ["data.json", "config.xml"]

2. AIL Decision Point
   ├─► Agent analyzes results
   └─► Agent: "Discovery: XML file found, need XML parser"

3. Agent Injects Replan Command
   └─► Command: { type: "replan_dag", requirement: "parse XML files" }

4. DAGSuggester.replanDAG() Execution
   ├─► Query GraphRAG: vectorSearch("parse XML")
   ├─► GraphRAG returns: ["xml:parse" tool, confidence 0.85]
   ├─► Build new nodes: [parse_xml task]
   └─► Merge with existing DAG

Updated DAG:
  Layer 0: [list_directory]         (✅ completed)
  Layer 1: [parse_json, parse_xml]  (← NEW node injected, parallel)
  Layer 2: [analyze]                (operates on both results)

5. Continue Execution
   ├─► Layer 1 executes with BOTH parsers in parallel
   └─► Agent adapts to discovery without re-starting workflow
```

## Non-Functional Requirements

### Performance

**NFR-P1: Speedup 5x Preservation (Critical)**

- ✅ **Requirement:** Maintain existing 5x speedup from parallel layer execution
- ✅ **Target:** P95 latency <3 seconds for 5-tool workflow (unchanged from Epic 2)
- ✅ **Measurement:** Benchmark suite comparing ParallelExecutor vs ControlledExecutor with
  checkpoints OFF
- ✅ **Success Criteria:** <5% performance degradation vs baseline

**NFR-P2: Checkpoint Overhead (Critical)**

- ✅ **Requirement:** Minimal latency added by checkpoint operations
- ✅ **Target:** Checkpoint save <50ms P95 (excluding agent response time)
- ✅ **Measurement:** Time from state snapshot to PGlite write completion
- ✅ **Implementation:** Async checkpoint save (non-blocking execution)

**NFR-P3: Command Queue Latency (High)**

- ✅ **Requirement:** Near-instant command injection for agent/human control
- ✅ **Target:** Command injection latency <10ms from enqueue to process
- ✅ **Measurement:** Time from `enqueueCommand()` call to command handler execution
- ✅ **Implementation:** AsyncQueue with priority handling

**NFR-P4: Event Stream Overhead (Medium)**

- ✅ **Requirement:** Real-time observability without performance penalty
- ✅ **Target:** Event emission overhead <5ms per event
- ✅ **Measurement:** Time added by `eventStream.emit()` calls
- ✅ **Implementation:** TransformStream with backpressure handling

**NFR-P5: State Update Performance (High)**

- ✅ **Requirement:** Fast state updates with reducers
- ✅ **Target:** State update <1ms per reducer operation
- ✅ **Measurement:** Time for `updateState()` with reducer application
- ✅ **Implementation:** Shallow copying, no deep clones

**NFR-P6: Memory Footprint (Medium)**

- ✅ **Requirement:** Bounded memory usage for WorkflowState
- ✅ **Target:** State footprint <10MB per workflow (with pruning)
- ✅ **Measurement:** RSS memory before/after workflow execution
- ✅ **Mitigation:** Pruning strategy (configurable retention policy)

**NFR-P7: GraphRAG Query Performance (High)**

- ✅ **Requirement:** Fast replanning via GraphRAG queries
- ✅ **Target:** `DAGSuggester.replanDAG()` completes <200ms P95
- ✅ **Measurement:** Time from replan request to augmented DAG return
- ✅ **Dependency:** Epic 1 GraphRAG performance targets (PageRank <100ms)

**Performance Budget Summary:**

| Operation                  | P95 Target               | Critical?   | Notes                  |
| -------------------------- | ------------------------ | ----------- | ---------------------- |
| Layer execution (parallel) | Baseline (no regression) | ✅ Critical | Preserve 5x speedup    |
| Checkpoint save            | <50ms                    | ✅ Critical | Async, non-blocking    |
| Command injection          | <10ms                    | 🟡 High     | Queue processing       |
| Event emission             | <5ms                     | 🟢 Medium   | Per-event overhead     |
| State update (reducer)     | <1ms                     | 🟡 High     | Per-operation          |
| GraphRAG replan            | <200ms                   | 🟡 High     | Agent decision latency |
| Total feedback loop        | <300ms                   | 🟡 High     | End-to-end AIL cycle   |

### Security

**NFR-S1: State Isolation (High)**

- ✅ **Requirement:** WorkflowState isolated per workflow_id
- ✅ **Implementation:** Unique `workflow_id` per execution, no shared state
- ✅ **Validation:** Unit tests verify state leakage prevention

**NFR-S2: Command Validation (Critical)**

- ✅ **Requirement:** All commands validated before execution
- ✅ **Implementation:** Type-safe Command union types, runtime validation
- ✅ **Protection:** Reject malformed commands, log security events
- ✅ **Example:** Prevent SQL injection in checkpoint queries (parameterized)

**NFR-S3: Checkpoint Data Protection (Medium)**

- ✅ **Requirement:** Sensitive data handling in checkpoints
- ✅ **Implementation:** Store WorkflowState as JSONB (encrypted at rest via PGlite)
- ✅ **Retention:** Auto-delete old checkpoints (5 most recent retention)
- ✅ **Note:** Epic 3 (Sandbox) will add additional data isolation

**NFR-S4: Agent Decision Logging (High)**

- ✅ **Requirement:** Audit trail for all AIL/HIL decisions
- ✅ **Implementation:** Log all decisions to `decisions[]` in WorkflowState
- ✅ **Format:** `{ type: "ail|hil", action, reasoning, timestamp }`
- ✅ **Persistence:** Stored in checkpoints, queryable for audit

**NFR-S5: Error Message Sanitization (Medium)**

- ✅ **Requirement:** Prevent sensitive data leakage in error messages
- ✅ **Implementation:** Sanitize error messages before logging/emitting
- ✅ **Example:** Mask file paths, credentials in error events

**NFR-S6: Input Validation (Critical)**

- ✅ **Requirement:** Validate all external inputs (commands, context updates)
- ✅ **Implementation:** TypeScript type guards + runtime checks
- ✅ **Protection:** Reject invalid inputs early, prevent state corruption

**Security Controls Summary:**

| Control               | Priority    | Implementation        | Validation        |
| --------------------- | ----------- | --------------------- | ----------------- |
| State isolation       | 🟡 High     | Unique workflow_id    | Unit tests        |
| Command validation    | ✅ Critical | Type guards + runtime | Integration tests |
| Checkpoint encryption | 🟢 Medium   | PGlite encryption     | Configuration     |
| Decision audit trail  | 🟡 High     | Logged to state       | Queryable         |
| Error sanitization    | 🟢 Medium   | Sanitize before emit  | Manual review     |
| Input validation      | ✅ Critical | TypeScript + guards   | Unit tests        |

### Reliability/Availability

**NFR-R1: Checkpoint & Resume (Critical)**

- ✅ **Requirement:** Workflows resumable from any checkpoint after crash
- ✅ **Target:** 100% success rate for checkpoint resume (read-only workflows)
- ✅ **Limitation:** Workflows with file modifications require idempotent tasks
- ✅ **Testing:** Inject crashes at random layers, verify resume correctness
- ✅ **Note:** Epic 3 (Sandbox) will eliminate idempotence requirement

**NFR-R2: Graceful Degradation (High)**

- ✅ **Requirement:** System continues if non-critical components fail
- ✅ **Scenarios:**
  - Checkpoint save fails → Log error, continue execution (no resume capability)
  - Event stream backpressure → Drop events (non-critical for correctness)
  - GraphRAG query timeout → Fallback to manual replanning
- ✅ **Implementation:** Try-catch around non-critical operations

**NFR-R3: Error Recovery (High)**

- ✅ **Requirement:** Task failures don't crash entire workflow
- ✅ **Implementation:** Task-level error handling, continue to next layer
- ✅ **Behavior:** Failed tasks marked `status: "failure"`, logged in `tasks[]`
- ✅ **Agent decision:** AIL can decide to abort or continue despite failures

**NFR-R4: State Consistency (Critical)**

- ✅ **Requirement:** WorkflowState always consistent (no partial updates)
- ✅ **Implementation:** Atomic state updates via reducers (all-or-nothing)
- ✅ **Validation:** State invariants checked after each update
- ✅ **Example:** `tasks.length >= decisions.length` (decisions follow tasks)

**NFR-R5: Timeout Protection (High)**

- ✅ **Requirement:** No infinite hangs on task/command execution
- ✅ **Target:** Per-task timeout 30s (configurable), per-layer timeout 5min
- ✅ **Implementation:** `Promise.race()` with timeout promises
- ✅ **Behavior:** Timeout → Mark task as failed, emit error event, continue

**NFR-R6: Checkpoint Retention (Medium)**

- ✅ **Requirement:** Prevent unbounded checkpoint storage growth
- ✅ **Implementation:** Keep 5 most recent checkpoints per workflow
- ✅ **Cleanup:** Auto-prune on new checkpoint save (async cleanup)
- ✅ **Measurement:** Monitor database size, alert if >100MB growth

**NFR-R7: Idempotence Documentation (Medium)**

- ✅ **Requirement:** Clear documentation of idempotence requirements
- ✅ **Implementation:** Story acceptance criteria specify idempotent tasks
- ✅ **Example:** "Task X MUST be idempotent (re-run safe)"
- ✅ **Testing:** Tests verify re-run behavior for filesystem-modifying tasks

**Reliability Guarantees:**

| Guarantee              | Confidence | Limitation               | Mitigation         |
| ---------------------- | ---------- | ------------------------ | ------------------ |
| Resume from checkpoint | ✅ 100%    | Read-only workflows only | Epic 3 (Sandbox)   |
| Task failure isolation | ✅ 100%    | Per-task error handling  | Tested             |
| State consistency      | ✅ 100%    | Atomic reducers          | Invariants checked |
| Timeout protection     | ✅ 99%+    | Configurable timeouts    | Tested             |
| Checkpoint retention   | ✅ 100%    | Auto-pruning             | Monitored          |
| Idempotent tasks       | ⚠️ 70%     | Manual developer effort  | Documented         |

### Observability

**NFR-O1: Real-Time Event Stream (Critical)**

- ✅ **Requirement:** Complete visibility into workflow execution
- ✅ **Implementation:** Event stream emits all execution events (9 event types)
- ✅ **Consumers:** Logs, metrics, UI dashboards, debugging tools
- ✅ **Format:** Structured events with timestamps, workflow_id, context

**Event Types Emitted:**

1. `workflow_start` - Workflow begins
2. `layer_start` - DAG layer execution starts
3. `task_start` - Individual task starts
4. `task_complete` - Task succeeds
5. `task_error` - Task fails
6. `state_updated` - WorkflowState changed
7. `checkpoint` - Checkpoint saved
8. `decision_required` - AIL/HIL decision point
9. `workflow_complete` - Workflow finishes

**NFR-O2: Structured Logging (High)**

- ✅ **Requirement:** All events logged with structured context
- ✅ **Format:** JSON logs with `{ timestamp, level, event_type, workflow_id, context }`
- ✅ **Levels:** ERROR (task failures), WARN (degradation), INFO (events), DEBUG (internals)
- ✅ **Destination:** File (`~/.pml/logs/`) + Console (development)

**NFR-O3: State Snapshots (High)**

- ✅ **Requirement:** WorkflowState queryable at any checkpoint
- ✅ **Implementation:** `state_updated` events include complete state snapshot
- ✅ **Use Cases:** Debugging, post-mortem analysis, replay workflows
- ✅ **Storage:** Checkpoints in PGlite (queryable via SQL)

**NFR-O4: Performance Metrics (Medium)**

- ✅ **Requirement:** Track performance metrics per workflow
- ✅ **Metrics:**
  - Workflow duration (end-to-end)
  - Layer execution times
  - Task durations
  - Checkpoint save times
  - Command queue latencies
- ✅ **Implementation:** Extract from event stream timestamps
- ✅ **Storage:** Telemetry table (existing from Epic 1)

**NFR-O5: Decision Audit Trail (High)**

- ✅ **Requirement:** Complete history of AIL/HIL decisions
- ✅ **Implementation:** `decisions[]` array in WorkflowState
- ✅ **Format:** `{ type, action, reasoning, feedback?, timestamp }`
- ✅ **Query:** SQL queries on checkpoint JSONB for decision analysis

**NFR-O6: Error Context (Critical)**

- ✅ **Requirement:** Rich context for all errors
- ✅ **Implementation:** Error events include:
  - `task_id`, `tool_id` (what failed)
  - `error.message`, `error.stack` (why failed)
  - `state` snapshot (workflow context at failure)
  - `timestamp` (when failed)
- ✅ **Use Case:** Root cause analysis, debugging

**NFR-O7: Replay Capability (Medium)**

- ✅ **Requirement:** Ability to replay workflows from checkpoints
- ✅ **Implementation:** Resume from any checkpoint with same inputs
- ✅ **Use Case:** Debugging, testing, post-mortem analysis
- ✅ **Limitation:** Replay non-deterministic if external state changed

**Observability Stack:**

| Component           | Purpose                | Implementation         | Consumers             |
| ------------------- | ---------------------- | ---------------------- | --------------------- |
| Event Stream        | Real-time visibility   | TransformStream        | Logs, metrics, UI     |
| Structured Logs     | Searchable audit trail | JSON logs              | Debugging, monitoring |
| State Snapshots     | Point-in-time state    | Checkpoints (PGlite)   | Replay, analysis      |
| Performance Metrics | Latency tracking       | Event timestamps       | Dashboards, alerts    |
| Decision Audit      | AIL/HIL history        | `decisions[]` array    | Compliance, analysis  |
| Error Context       | Rich error info        | Error events           | Root cause analysis   |
| Replay              | Workflow replay        | Resume from checkpoint | Testing, debugging    |

## Dependencies and Integrations

### External Dependencies

**Epic 2.5 introduces ZERO new external dependencies.** All functionality implemented using:

| Dependency               | Version    | Source         | Purpose                                       | Notes                      |
| ------------------------ | ---------- | -------------- | --------------------------------------------- | -------------------------- |
| **Deno Runtime**         | 2.2+ (LTS) | Built-in       | AsyncGenerator, TransformStream, Promise APIs | No additional packages     |
| **TypeScript**           | 5.7+       | Built-in       | Type safety, union types, generics            | Via Deno                   |
| **@electric-sql/pglite** | 0.3.11     | npm (existing) | Checkpoint persistence (JSONB storage)        | Already installed (Epic 1) |
| **graphology**           | ^0.25.4    | npm (existing) | GraphRAG operations (PageRank, communities)   | Already installed (Epic 2) |

**Rationale for Zero New Dependencies:**

- ✅ Event stream → Native `TransformStream` API (Deno built-in)
- ✅ Command queue → Custom `AsyncQueue` implementation (~50 LOC)
- ✅ State reducers → Pure TypeScript functions (MessagesState pattern)
- ✅ Checkpoint storage → PGlite JSONB (already available)
- ✅ Type safety → TypeScript discriminated unions (built-in)

**Philosophy:** Minimize external dependencies, leverage Deno's modern APIs.

### Internal Module Dependencies

Epic 2.5 **extends** existing modules rather than replacing them:

```
┌─────────────────────────────────────────────────────────────┐
│                   Epic 2.5 Module Graph                      │
└─────────────────────────────────────────────────────────────┘

NEW MODULES (Epic 2.5):
┌──────────────────────┐
│ ControlledExecutor   │ (extends ParallelExecutor)
└──────┬───────────────┘
       │
       ├──► WorkflowState (new)
       │    └──► State reducers (messages, tasks, decisions, context)
       │
       ├──► CommandQueue (new)
       │    └──► AsyncQueue implementation
       │
       ├──► EventStream (new)
       │    └──► TransformStream wrapper
       │
       └──► CheckpointManager (new)
            └──► PGlite persistence

EXTENDED MODULES (Epic 2.5 additions):
┌──────────────────────┐
│   DAGSuggester       │ (Epic 2 - EXTENDED)
└──────┬───────────────┘
       │
       └──► + replanDAG() method (NEW)
            └──► Queries GraphRAGEngine
            └──► Merges with existing DAG

REUSED MODULES (no changes):
┌──────────────────────┐
│  GraphRAGEngine      │ (Epic 1 - REUSED)
└──────┬───────────────┘
       │
       └──► updateFromExecution() (existing method)
            └──► Feedback loop to knowledge graph

┌──────────────────────┐
│  ParallelExecutor    │ (Epic 2 - BASE CLASS)
└──────────────────────┘
            ↑
            │ extends (zero breaking changes)
            │
┌──────────────────────┐
│ ControlledExecutor   │
└──────────────────────┘
```

**Dependency Flow:**

```typescript
// Epic 2.5 dependencies (imports)
import { ParallelExecutor } from "../dag/executor.ts"; // Epic 2 (base)
import { DAGSuggester } from "../graphrag/dag-suggester.ts"; // Epic 2 (extend)
import { GraphRAGEngine } from "../graphrag/graph-engine.ts"; // Epic 1 (reuse)
import { PGlite } from "@electric-sql/pglite"; // Epic 1 (reuse)

// Epic 2.5 exports (new)
export { ControlledExecutor } from "./controlled-executor.ts";
export { WorkflowState } from "./state.ts";
export { CheckpointManager } from "./checkpoint-manager.ts";
export type { Command, Decision, ExecutionEvent } from "./types.ts";
```

### Integration Points

#### Integration 1: PGlite Database (Checkpoint Persistence)

**Connection:** Epic 2.5 → Epic 1 (PGlite)

**Schema Extension:**

```sql
-- NEW TABLE for Epic 2.5
CREATE TABLE workflow_checkpoint (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  layer INTEGER NOT NULL,
  state JSONB NOT NULL,  -- WorkflowState serialized
  CONSTRAINT fk_workflow FOREIGN KEY (workflow_id)
    REFERENCES workflow_execution(id) ON DELETE CASCADE
);

CREATE INDEX idx_checkpoint_workflow_ts
  ON workflow_checkpoint(workflow_id, timestamp DESC);
```

**Integration Code:**

```typescript
// CheckpointManager uses existing PGlite client
import { db } from "../db/client.ts"; // Epic 1 PGlite instance

export class CheckpointManager {
  async saveCheckpoint(
    workflow_id: string,
    layer: number,
    state: WorkflowState,
  ): Promise<Checkpoint> {
    const result = await db.query(
      `INSERT INTO workflow_checkpoint (id, workflow_id, layer, state)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [crypto.randomUUID(), workflow_id, layer, JSON.stringify(state)],
    );
    return result.rows[0];
  }
}
```

**Data Flow:** ControlledExecutor → CheckpointManager → PGlite → Disk

#### Integration 2: GraphRAG Engine (Dynamic Replanning)

**Connection:** Epic 2.5 → Epic 1 (GraphRAG)

**Method Reuse:**

```typescript
// DAGSuggester.replanDAG() calls existing GraphRAGEngine methods
export class DAGSuggester {
  constructor(
    private graphEngine: GraphRAGEngine, // Epic 1 instance
    private vectorSearch: VectorSearch, // Epic 1 instance
  ) {}

  async replanDAG(
    currentDAG: DAGStructure,
    newContext: { newRequirement: string /* ... */ },
  ): Promise<DAGStructure> {
    // ✅ REUSE: Epic 1 vector search
    const tools = await this.vectorSearch.search(
      newContext.newRequirement,
      topK = 5,
    );

    // ✅ REUSE: Epic 1 GraphRAG operations
    const rankedTools = tools.map((tool) => ({
      ...tool,
      importance: this.graphEngine.getPageRank(tool.tool_id),
    }));

    // Build new DAG nodes and merge
    const newNodes = this.buildNodesFromTools(rankedTools);
    return this.mergeDagWithNewNodes(currentDAG, newNodes);
  }
}
```

**Data Flow:** Agent Decision → CommandQueue → DAGSuggester.replanDAG() → GraphRAGEngine → Vector
Search → New DAG Nodes

#### Integration 3: ParallelExecutor (Base Class Extension)

**Connection:** Epic 2.5 extends Epic 2

**Inheritance Pattern:**

```typescript
// ControlledExecutor extends ParallelExecutor (zero breaking changes)
export class ControlledExecutor extends ParallelExecutor {
  // ✅ INHERITED: Parallel layer execution logic
  // ✅ INHERITED: Topological sort
  // ✅ INHERITED: Task execution

  // ✅ ADDED: Event stream
  private eventStream: TransformStream<ExecutionEvent>;

  // ✅ ADDED: Command queue
  private commandQueue: AsyncQueue<Command>;

  // ✅ ADDED: Workflow state
  private state: WorkflowState;

  // ✅ OVERRIDE: Execute method (adds checkpoints, events, commands)
  async *executeStream(
    dag: DAGStructure,
    config: ExecutionConfig,
  ): AsyncGenerator<ExecutionEvent, WorkflowState, void> {
    // Calls super.execute() internally for layer execution
    for (const layer of this.topologicalSort(dag)) {
      await this.processCommands(); // NEW
      const results = await super.executeLayer(layer); // REUSE
      this.updateState({ tasks: results }); // NEW
      await this.checkpoint(); // NEW
      yield { type: "checkpoint", state: this.state }; // NEW
    }
  }
}
```

**Backward Compatibility:**

```typescript
// Epic 2 code continues to work (no breaking changes)
const executor = new ParallelExecutor();
const result = await executor.execute(dag); // ✅ Still works

// Epic 2.5 code uses new API
const controlledExecutor = new ControlledExecutor();
for await (const event of controlledExecutor.executeStream(dag, config)) {
  console.log(event); // Real-time events
}
```

#### Integration 4: MCP Gateway (Agent Execution)

**Connection:** Epic 2.5 → Epic 2 (MCP Gateway)

**Agent Integration:**

```typescript
// MCP Gateway uses ControlledExecutor for adaptive workflows
import { ControlledExecutor } from "../dag/controlled-executor.ts";

export class MCPGateway {
  async handleWorkflowRequest(intent: WorkflowIntent) {
    // 1. Suggest DAG (Epic 2 - existing)
    const suggestedDAG = await this.suggester.suggestDAG(intent);

    // 2. Execute with ControlledExecutor (Epic 2.5 - NEW)
    const executor = new ControlledExecutor(
      this.graphEngine,
      this.suggester
    );

    // 3. Stream events to agent
    for await (const event of executor.executeStream(suggestedDAG, config)) {
      if (event.type === "decision_required") {
        // Agent sees event, can inject commands
        const decision = await this.agent.decide(event.context);
        executor.enqueueCommand({ type: "replan_dag", ... });
      }
    }
  }
}
```

**Agent Conversation Flow:**

```
User Intent
    ↓
MCP Gateway
    ↓
DAGSuggester.suggestDAG() (Epic 2)
    ↓
ControlledExecutor.executeStream() (Epic 2.5)
    ↓
Event: decision_required
    ↓
Agent (Claude) sees event in conversation
    ↓
Agent injects command: replan_dag
    ↓
DAGSuggester.replanDAG() (Epic 2.5)
    ↓
Updated DAG execution continues
    ↓
GraphRAGEngine.updateFromExecution() (Epic 1)
```

### Version Constraints

| Component  | Minimum Version | Recommended  | Notes                                   |
| ---------- | --------------- | ------------ | --------------------------------------- |
| Deno       | 2.2 (LTS)       | 2.5 (latest) | TransformStream, AsyncGenerator support |
| PGlite     | 0.3.11          | 0.3.11       | JSONB storage, vector extension         |
| TypeScript | 5.7+            | Latest       | Discriminated unions, generics          |
| Graphology | 0.25.4          | 0.26.0       | PageRank, communities (Epic 1 dep)      |

**No version upgrades required for Epic 2.5.**

### Testing Dependencies

Epic 2.5 tests use existing test infrastructure:

| Test Type         | Framework             | Coverage                                        |
| ----------------- | --------------------- | ----------------------------------------------- |
| Unit tests        | Deno.test (built-in)  | ControlledExecutor, reducers, CheckpointManager |
| Integration tests | Deno.test             | End-to-end workflows with checkpoints           |
| Benchmarks        | Deno.bench (built-in) | Performance regression tests (5x speedup)       |
| Mocks             | Custom (tests/mocks/) | GraphRAGEngine, PGlite, MCP tools               |

**No new test dependencies required.**

## Acceptance Criteria (Authoritative)

### Epic-Level Acceptance Criteria

**AC-E1: 3-Loop Learning Architecture Functional**

- ✅ Loop 1 (Execution) implements event stream + command queue + state management
- ✅ Loop 2 (Adaptation) implements AIL/HIL decision points + DAG replanning
- ✅ Loop 3 (Meta-Learning) implements GraphRAG updates from execution patterns
- ✅ All three loops integrated and working end-to-end

**AC-E2: Zero Breaking Changes**

- ✅ Existing `ParallelExecutor` API unchanged
- ✅ Epic 2 code continues to work without modifications
- ✅ `ControlledExecutor` extends (not replaces) `ParallelExecutor`
- ✅ Backward compatibility verified via regression tests

**AC-E3: Performance Preservation**

- ✅ Speedup 5x maintained (checkpoints OFF)
- ✅ P95 latency <3 seconds for 5-tool workflow
- ✅ <5% performance degradation vs Epic 2 baseline
- ✅ Benchmark suite passes all performance tests

**AC-E4: Checkpoint & Resume Functional**

- ✅ Workflows resume correctly from any checkpoint
- ✅ 100% success rate for read-only workflows
- ✅ State fully restored (tasks, decisions, messages, context)
- ✅ Idempotence requirement documented for file-modifying workflows

**AC-E5: Agent-in-the-Loop (AIL) Functional**

- ✅ Agent can inject commands during execution
- ✅ Agent can trigger DAG replanning via GraphRAG queries
- ✅ Agent sees all MCP results in conversation (no filtering)
- ✅ Multi-turn conversation state persists across decisions

**AC-E6: Human-in-the-Loop (HIL) Functional**

- ✅ Human approval checkpoints configurable
- ✅ Summary generation for human display (500-1000 tokens)
- ✅ Human can approve/reject/modify workflow continuation
- ✅ Human decisions logged to audit trail

**AC-E7: Observability Complete**

- ✅ Event stream emits all 9 event types in real-time
- ✅ Structured logs with workflow_id context
- ✅ State snapshots queryable from checkpoints
- ✅ Performance metrics extractable from event timestamps

**AC-E8: Documentation & Testing Complete**

- ✅ All new components fully documented (TSDoc comments)
- ✅ Unit test coverage >80%
- ✅ Integration tests cover AIL/HIL workflows
- ✅ Performance benchmarks baseline established

### Story-Level Acceptance Criteria

#### Story 2.5-1: Event Stream + Command Queue + State Management

**AC-1.1: WorkflowState with Reducers**

- ✅ `WorkflowState` interface defined with 4 reducer fields (messages, tasks, decisions, context)
- ✅ Reducers implement MessagesState-inspired pattern (append/merge)
- ✅ `updateState()` method applies reducers automatically
- ✅ State invariants validated after each update

**AC-1.2: Event Stream Implementation**

- ✅ `ExecutionEvent` type union defines 9 event types
- ✅ `TransformStream<ExecutionEvent>` emits events in real-time
- ✅ Event emission overhead <5ms P95
- ✅ Backpressure handling prevents memory overflow

**AC-1.3: Command Queue Implementation**

- ✅ `AsyncQueue<Command>` implementation (~50 LOC, zero deps)
- ✅ 6 command types defined (abort, inject_tasks, replan_dag, skip_layer, modify_args,
  checkpoint_response)
- ✅ Commands processed non-blocking between layers
- ✅ Command injection latency <10ms P95

**AC-1.4: ControlledExecutor Foundation**

- ✅ Extends `ParallelExecutor` (inheritance verified)
- ✅ `executeStream()` method returns `AsyncGenerator<ExecutionEvent>`
- ✅ Parallel layer execution preserved (speedup 5x maintained)
- ✅ Zero breaking changes to Epic 2 code

**AC-1.5: Unit Tests**

- ✅ State reducer tests (>90% coverage)
- ✅ Event stream tests (emission, backpressure)
- ✅ Command queue tests (enqueue, dequeue, ordering)
- ✅ ControlledExecutor basic execution tests

#### Story 2.5-2: Checkpoint & Resume

**AC-2.1: Checkpoint Infrastructure**

- ✅ `workflow_checkpoint` table created in PGlite
- ✅ `Checkpoint` interface defined (id, workflow_id, layer, state, timestamp)
- ✅ `CheckpointManager` class implements CRUD operations
- ✅ Checkpoint save <50ms P95 (async, non-blocking)

**AC-2.2: Checkpoint Persistence**

- ✅ WorkflowState serialized to JSONB correctly
- ✅ Checkpoints saved after each layer execution
- ✅ Retention policy: Keep 5 most recent per workflow
- ✅ Auto-pruning on new checkpoint save

**AC-2.3: Resume from Checkpoint**

- ✅ `resumeFromCheckpoint()` method implemented
- ✅ State fully restored (workflow_id, current_layer, tasks, decisions, messages, context)
- ✅ Execution continues from current_layer + 1
- ✅ Completed layers skipped (no re-execution)

**AC-2.4: Idempotence Documentation**

- ✅ Checkpoint limitations documented (filesystem state NOT saved)
- ✅ Idempotence requirement documented for file-modifying tasks
- ✅ Epic 3 (Sandbox) noted as full resolution
- ✅ Example idempotent vs non-idempotent tasks provided

**AC-2.5: Resume Tests**

- ✅ Resume from checkpoint succeeds (read-only workflows)
- ✅ Inject crash at random layers, verify resume correctness
- ✅ State consistency verified post-resume
- ✅ Idempotent task re-run behavior tested

#### Story 2.5-3: AIL/HIL Integration + DAG Replanning

**AC-3.1: Agent-in-the-Loop (AIL)**

- ✅ AIL decision points configurable (per_layer, on_error, manual)
- ✅ `decision_required` event emitted with context
- ✅ Agent sees all MCP results (no filtering, natural conversation)
- ✅ Agent can enqueue commands (continue, replan, abort)

**AC-3.2: Human-in-the-Loop (HIL)**

- ✅ HIL approval checkpoints configurable (always, critical_only, never)
- ✅ Summary generated for human (500-1000 tokens)
- ✅ Human response via `checkpoint_response` command
- ✅ Human decisions logged to `decisions[]` array

**AC-3.3: DAG Replanning**

- ✅ `DAGSuggester.replanDAG()` method implemented
- ✅ Queries GraphRAG for new tools (vector search + PageRank)
- ✅ Merges new nodes with existing DAG structure
- ✅ Replan completes <200ms P95

**AC-3.4: GraphRAG Feedback Loop**

- ✅ `GraphRAGEngine.updateFromExecution()` called on workflow completion
- ✅ Tool co-occurrence patterns extracted
- ✅ Edge weights updated in knowledge graph
- ✅ PageRank recomputed with new data

**AC-3.5: Multi-Turn State**

- ✅ `messages[]` array persists conversation history
- ✅ Agent/human messages logged with timestamps
- ✅ Multi-turn state survives checkpoint/resume
- ✅ Conversation context available for AIL decisions

**AC-3.6: Integration Tests**

- ✅ End-to-end AIL workflow (agent triggers replan)
- ✅ End-to-end HIL workflow (human approves/rejects)
- ✅ Dynamic DAG replanning scenario (discovery pattern)
- ✅ GraphRAG update verification (edge weights changed)

### Cross-Story Acceptance Criteria

**AC-X1: Performance Budget Met**

- ✅ Layer execution: No regression (baseline preserved)
- ✅ Checkpoint save: <50ms P95
- ✅ Command injection: <10ms P95
- ✅ Event emission: <5ms per event
- ✅ State update: <1ms per reducer
- ✅ GraphRAG replan: <200ms P95
- ✅ Total feedback loop: <300ms end-to-end

**AC-X2: Memory Footprint Bounded**

- ✅ WorkflowState <10MB per workflow (with pruning)
- ✅ Event stream backpressure prevents overflow
- ✅ Checkpoint retention limits storage growth
- ✅ Memory leak tests pass (no unbounded growth)

**AC-X3: Error Handling Robust**

- ✅ Task failures don't crash workflow
- ✅ Checkpoint save failures logged, execution continues
- ✅ GraphRAG query timeouts fall back gracefully
- ✅ State consistency maintained on errors

**AC-X4: Security Controls Implemented**

- ✅ State isolation per workflow_id
- ✅ Command validation (type guards + runtime checks)
- ✅ Checkpoint data encrypted at rest (PGlite)
- ✅ Error message sanitization (no sensitive data leakage)

## Traceability Mapping

### PRD Requirements → Tech Spec → Components → Tests

| PRD Requirement                 | Tech Spec Section              | Component(s)                                | Acceptance Criteria    | Test Type         |
| ------------------------------- | ------------------------------ | ------------------------------------------- | ---------------------- | ----------------- |
| **FR-Epic2.5: 3-Loop Learning** | Overview, Detailed Design      | ControlledExecutor, WorkflowState           | AC-E1, AC-1.1, AC-1.4  | Integration       |
| **Loop 1: Event Stream**        | Detailed Design → APIs         | EventStream, ExecutionEvent types           | AC-1.2, AC-E7          | Unit, Integration |
| **Loop 1: Command Queue**       | Detailed Design → APIs         | CommandQueue, AsyncQueue                    | AC-1.3                 | Unit              |
| **Loop 1: State Management**    | Data Models, APIs              | WorkflowState, reducers                     | AC-1.1, AC-X3          | Unit              |
| **Loop 1: Checkpoints**         | Data Models, Workflows         | CheckpointManager, PGlite schema            | AC-2.1, AC-2.2, AC-2.3 | Unit, Integration |
| **Loop 2: AIL Decisions**       | Workflows, APIs                | ControlledExecutor.executeStream()          | AC-3.1, AC-E5          | Integration       |
| **Loop 2: HIL Approval**        | Workflows, NFR-O5              | HIL decision points, summary generation     | AC-3.2, AC-E6          | Integration       |
| **Loop 2: DAG Replanning**      | APIs, Integration 2            | DAGSuggester.replanDAG()                    | AC-3.3, AC-E5          | Integration       |
| **Loop 3: GraphRAG Updates**    | Integration 2, Workflows       | GraphRAGEngine.updateFromExecution()        | AC-3.4                 | Integration       |
| **NFR-P1: Speedup 5x**          | NFR Performance                | ControlledExecutor extends ParallelExecutor | AC-E3, AC-X1           | Benchmark         |
| **NFR-P2: Checkpoint Overhead** | NFR Performance                | CheckpointManager async save                | AC-2.1, AC-X1          | Benchmark         |
| **NFR-R1: Resume**              | NFR Reliability, Workflows     | resumeFromCheckpoint()                      | AC-2.3, AC-2.5, AC-E4  | Integration       |
| **NFR-R4: State Consistency**   | NFR Reliability, Data Models   | State reducers, invariants                  | AC-1.1, AC-X3          | Unit              |
| **NFR-O1: Event Stream**        | NFR Observability              | EventStream, 9 event types                  | AC-1.2, AC-E7          | Integration       |
| **NFR-O5: Decision Audit**      | NFR Observability, Data Models | decisions[] array, HIL/AIL logging          | AC-3.2, AC-3.5         | Integration       |
| **NFR-S2: Command Validation**  | NFR Security                   | Command type guards, runtime checks         | AC-X4                  | Unit              |

### Epic 2.5 Stories → Acceptance Criteria → Components

| Story                                   | Primary AC      | Secondary AC                   | Components Implemented                                               | Test Coverage Target |
| --------------------------------------- | --------------- | ------------------------------ | -------------------------------------------------------------------- | -------------------- |
| **2.5-1: Event Stream + Queue + State** | AC-1.1 - AC-1.5 | AC-X1 (perf), AC-X3 (errors)   | ControlledExecutor, WorkflowState, EventStream, CommandQueue         | >85%                 |
| **2.5-2: Checkpoint & Resume**          | AC-2.1 - AC-2.5 | AC-X1 (perf), AC-X2 (memory)   | CheckpointManager, PGlite schema, resumeFromCheckpoint()             | >80%                 |
| **2.5-3: AIL/HIL + Replanning**         | AC-3.1 - AC-3.6 | AC-X1 (perf), AC-X4 (security) | DAGSuggester.replanDAG(), AIL/HIL decision points, GraphRAG feedback | >80%                 |

### ADR-007 Decisions → Implementation → Validation

| ADR-007 Decision                    | Implementation Approach               | Tech Spec Section           | Validation Method                  |
| ----------------------------------- | ------------------------------------- | --------------------------- | ---------------------------------- |
| **Async Event Stream + Commands**   | TransformStream + AsyncQueue          | Detailed Design → APIs      | AC-1.2, AC-1.3 + Benchmarks        |
| **MessagesState-inspired Reducers** | Pure functions (append/merge)         | Data Models → WorkflowState | AC-1.1 + Unit tests (>90% cov)     |
| **Zero Breaking Changes**           | Extend ParallelExecutor (not replace) | Integration 3               | AC-E2 + Regression tests           |
| **Checkpoint Architecture**         | PGlite JSONB storage                  | Data Models, Integration 1  | AC-2.1, AC-2.2 + Integration tests |
| **One Agent Conversation**          | No context filtering, natural MCP     | Architecture Alignment      | AC-3.1, AC-E5 + Integration tests  |
| **GraphRAG Replanning**             | replanDAG() queries knowledge graph   | Integration 2, APIs         | AC-3.3, AC-3.4 + Integration tests |
| **Idempotence Limitation**          | Documented, Epic 3 resolution         | NFR Reliability, AC-2.4     | Documentation review               |

### Component → Interfaces → Tests

| Component              | Public Interface                                          | Dependencies                                      | Unit Tests                    | Integration Tests    |
| ---------------------- | --------------------------------------------------------- | ------------------------------------------------- | ----------------------------- | -------------------- |
| **ControlledExecutor** | executeStream(), resumeFromCheckpoint(), enqueueCommand() | ParallelExecutor, CheckpointManager, DAGSuggester | State updates, event emission | End-to-end workflows |
| **WorkflowState**      | updateState(), getState()                                 | Reducers (pure functions)                         | Reducer logic, invariants     | State persistence    |
| **CheckpointManager**  | saveCheckpoint(), loadCheckpoint(), pruneCheckpoints()    | PGlite                                            | CRUD operations, retention    | Resume scenarios     |
| **EventStream**        | emit(), subscribe()                                       | TransformStream                                   | Emission, backpressure        | Event consumers      |
| **CommandQueue**       | enqueue(), dequeue(), process()                           | AsyncQueue (~50 LOC)                              | Queue operations, ordering    | Command injection    |
| **DAGSuggester**       | replanDAG() (new method)                                  | GraphRAGEngine, VectorSearch                      | Replan logic, merging         | Dynamic replanning   |

### Test Strategy → Coverage → Success Metrics

| Test Level                 | Coverage Target             | Key Scenarios                                       | Success Criteria                       |
| -------------------------- | --------------------------- | --------------------------------------------------- | -------------------------------------- |
| **Unit Tests**             | >80% (>90% for reducers)    | State updates, reducers, queue ops, checkpoint CRUD | All tests pass, coverage target met    |
| **Integration Tests**      | End-to-end workflows        | AIL workflow, HIL workflow, resume, replanning      | All scenarios pass, no regressions     |
| **Performance Benchmarks** | Baseline vs current         | Speedup 5x, checkpoint <50ms, replan <200ms         | <5% degradation, all targets met       |
| **Regression Tests**       | Epic 2 compatibility        | ParallelExecutor unchanged, backward compat         | No breaking changes, Epic 2 code works |
| **Manual Testing**         | Edge cases, error scenarios | Crashes mid-layer, invalid commands, timeout        | Graceful handling, error logs correct  |

### NFR Traceability

| NFR Category      | Requirements           | Implementation                                        | Validation                             |
| ----------------- | ---------------------- | ----------------------------------------------------- | -------------------------------------- |
| **Performance**   | 7 requirements (P1-P7) | Async checkpoints, shallow copies, native APIs        | Benchmarks, profiling                  |
| **Security**      | 6 controls (S1-S6)     | Type guards, validation, sanitization, audit trail    | Unit tests, security review            |
| **Reliability**   | 7 guarantees (R1-R7)   | Error handling, timeouts, atomic updates, pruning     | Integration tests, chaos testing       |
| **Observability** | 7 capabilities (O1-O7) | Event stream, logs, snapshots, metrics, audit, replay | Integration tests, manual verification |

## Risks, Assumptions, Open Questions

### Risks

**RISK-1: Complexity Creep (Medium Severity, Medium Likelihood)**

- **Description:** Event-driven architecture + reducers + command queue adds complexity vs simple
  linear execution
- **Impact:** Development time exceeds 7-10h estimate, debugging becomes harder
- **Mitigation:**
  - Progressive implementation in 3 stories (can stop after story 1 if needed)
  - Each story delivers standalone value
  - Comprehensive unit tests (>80% coverage) reduce debugging time
  - Event stream provides excellent observability for debugging
- **Contingency:** If complexity becomes unmanageable, fall back to simpler synchronous checkpoints
  (ADR-007 Option 1)
- **Owner:** Story 2.5-1 (foundation)

**RISK-2: Race Conditions in Command Queue (Medium Severity, Low Likelihood)**

- **Description:** Concurrent command injection could cause state inconsistencies
- **Impact:** Workflow state corruption, unpredictable behavior
- **Mitigation:**
  - AsyncQueue implementation with FIFO ordering guarantees
  - Commands processed between layers (not during layer execution)
  - State updates atomic via reducers (all-or-nothing)
  - Concurrency integration tests
- **Contingency:** Add command versioning (optimistic locking) if race conditions detected
- **Owner:** Story 2.5-1

**RISK-3: State Bloat from Messages/Tasks Accumulation (Low Severity, Medium Likelihood)**

- **Description:** Long-running workflows accumulate unbounded messages[] and tasks[] arrays
- **Impact:** Memory usage exceeds 10MB target, checkpoint saves slow down
- **Mitigation:**
  - Pruning strategy configurable (keep last N items)
  - Memory usage monitoring tests
  - Checkpoint retention (5 most recent)
- **Contingency:** Implement aggressive pruning (keep last 100 items) if memory issues arise
- **Owner:** Story 2.5-1, Story 2.5-2

**RISK-4: GraphRAG Query Performance Degradation (Low Severity, Low Likelihood)**

- **Description:** `replanDAG()` GraphRAG queries exceed 200ms target as graph grows
- **Impact:** Replanning latency impacts user experience
- **Mitigation:**
  - Epic 1 GraphRAG already optimized (PageRank <100ms)
  - Vector search uses efficient PGlite indexes
  - Query timeout fallback to manual replanning
  - Performance benchmarks track regression
- **Contingency:** Add caching layer for frequent replanning patterns
- **Owner:** Story 2.5-3

**RISK-5: Checkpoint Resume Failures for Non-Idempotent Tasks (Medium Severity, High Likelihood)**

- **Description:** Workflows with file modifications fail or produce incorrect results on resume
- **Impact:** Data corruption, workflow failures after crashes
- **Mitigation:**
  - **Documentation:** Idempotence requirement clearly documented in AC-2.4
  - **Epic 2.5 scope:** Focus on orchestration (read-only workflows primarily)
  - **Epic 3 resolution:** Sandbox will provide filesystem isolation (full solution)
  - Resume tests verify behavior with idempotent tasks
- **Contingency:** Reject checkpoint resume for workflows flagged as "file-modifying" until Epic 3
- **Owner:** Story 2.5-2
- **Acceptance:** This is a **known limitation**, not a blocker (Epic 3 resolves)

**RISK-6: Performance Regression from Checkpoint/Event Overhead (Medium Severity, Low Likelihood)**

- **Description:** Checkpoint saves + event emissions degrade speedup 5x
- **Impact:** Epic 2 performance advantage lost
- **Mitigation:**
  - Async checkpoint saves (non-blocking)
  - Event emission <5ms overhead
  - Checkpoints configurable (can disable for perf-critical workflows)
  - Continuous benchmarking (baseline vs current)
- **Contingency:** Add "fast mode" flag that disables checkpoints + events entirely
- **Owner:** All stories (performance budget tracked)

### Assumptions

**ASSUMPTION-1: Epic 1 GraphRAG Performance Maintained**

- **Statement:** GraphRAG PageRank and vector search maintain <100ms P95 latency as graph grows
- **Validation:** Epic 1 performance benchmarks passing
- **Impact if False:** `replanDAG()` exceeds 200ms target, user experience degrades
- **Dependency:** Epic 1 implementation

**ASSUMPTION-2: PGlite JSONB Performance Sufficient**

- **Statement:** PGlite can save/load WorkflowState JSONB in <50ms P95
- **Validation:** Checkpoint save benchmarks
- **Impact if False:** Checkpoint overhead violates performance budget
- **Dependency:** Epic 1 PGlite infrastructure

**ASSUMPTION-3: Agent (Claude) Handles MCP Results Efficiently**

- **Statement:** Agent conversation context doesn't overflow with full MCP result visibility
- **Validation:** Integration tests with real workflows
- **Impact if False:** Agent hits context limits, needs filtering (architecture change)
- **Dependency:** MCP Gateway integration

**ASSUMPTION-4: Read-Only Workflows Dominate Early Use Cases**

- **Statement:** 80%+ of Epic 2.5 workflows are orchestration/analysis (not file modification)
- **Validation:** User workflow analysis
- **Impact if False:** Checkpoint resume limitation affects more users than expected
- **Mitigation:** Prioritize Epic 3 (Sandbox) if false

**ASSUMPTION-5: TransformStream Native API Stable**

- **Statement:** Deno 2.2+ TransformStream API is production-ready and stable
- **Validation:** Deno LTS status
- **Impact if False:** Event stream implementation needs alternative approach
- **Dependency:** Deno runtime

**ASSUMPTION-6: 3 Stories Sufficient for Foundation**

- **Statement:** Stories 2.5-1, 2.5-2, 2.5-3 cover all Loop 1-2 + basic Loop 3 requirements
- **Validation:** AC coverage review
- **Impact if False:** Additional stories needed, timeline extends
- **Mitigation:** Stories designed for incremental delivery

### Open Questions

**OQ-1: Pruning Strategy Configuration**

- **Question:** Should pruning strategy be global config or per-workflow configurable?
- **Options:**
  - A) Global config (`config.yaml` → `state_retention: { messages: 100, tasks: 200 }`)
  - B) Per-workflow config (`ExecutionConfig.pruning: { ... }`)
  - C) Automatic (ML-based retention based on workflow type)
- **Decision Needed By:** Story 2.5-1 implementation
- **Recommendation:** Option A (global config) for MVP, Option B for Epic 4
- **Owner:** Developer implementing Story 2.5-1

**OQ-2: HIL Summary Generation Strategy**

- **Question:** How to generate 500-1000 token summaries for human approval?
- **Options:**
  - A) Agent generates summary (uses LLM API call)
  - B) Template-based summary (extract key fields from state)
  - C) Configurable (user chooses strategy)
- **Decision Needed By:** Story 2.5-3 implementation
- **Recommendation:** Option A (agent summary) for best quality, Option C for flexibility
- **Owner:** Developer implementing Story 2.5-3

**OQ-3: Event Stream Backpressure Behavior**

- **Question:** When event stream consumer is slow, should we drop events or block?
- **Options:**
  - A) Drop events (non-critical for correctness)
  - B) Block execution (guarantee delivery)
  - C) Configurable per-event type
- **Decision Needed By:** Story 2.5-1 implementation
- **Recommendation:** Option A (drop) for observability events, logs capture everything anyway
- **Owner:** Developer implementing Story 2.5-1

**OQ-4: Checkpoint Encryption at Rest**

- **Question:** Should WorkflowState JSONB be explicitly encrypted beyond PGlite defaults?
- **Options:**
  - A) Rely on PGlite default encryption
  - B) Add application-level encryption (encrypt before JSONB insert)
  - C) Defer to Epic 3 (Sandbox isolation reduces risk)
- **Decision Needed By:** Story 2.5-2 implementation
- **Recommendation:** Option A for MVP (PGlite encryption sufficient), revisit if security audit
  requires
- **Owner:** Developer implementing Story 2.5-2

**OQ-5: GraphRAG Update Frequency**

- **Question:** When should `GraphRAGEngine.updateFromExecution()` be called?
- **Options:**
  - A) After every workflow completion
  - B) Batched (every N workflows)
  - C) Async background job (non-blocking)
- **Decision Needed By:** Story 2.5-3 implementation
- **Recommendation:** Option A (every workflow) for MVP, Option C for scale
- **Owner:** Developer implementing Story 2.5-3

**OQ-6: AIL Decision Timeout**

- **Question:** How long should we wait for agent decision before falling back?
- **Options:**
  - A) No timeout (wait indefinitely)
  - B) Fixed timeout (30s, 60s)
  - C) Configurable per-workflow
- **Decision Needed By:** Story 2.5-3 implementation
- **Recommendation:** Option B (60s timeout) with fallback to "continue" action
- **Owner:** Developer implementing Story 2.5-3

### Resolved Questions (from ADR-007)

**RQ-1: Checkpoint Filesystem State? ❌ NO**

- **Resolution:** Checkpoints save WorkflowState only (not filesystem)
- **Rationale:** Epic 2.5 = orchestration primarily, Epic 3 (Sandbox) resolves filesystem
- **Documented In:** ADR-007 Checkpoint Architecture section

**RQ-2: Context Filtering for Agent? ❌ NO**

- **Resolution:** Agent sees ALL MCP results in natural conversation
- **Rationale:** Claude handles context well, filtering adds complexity
- **Documented In:** ADR-007 Context Management section

**RQ-3: New External Dependencies? ❌ NO**

- **Resolution:** Zero new external dependencies
- **Rationale:** Deno native APIs + existing PGlite/Graphology sufficient
- **Documented In:** Dependencies section

## Test Strategy Summary

### Test Pyramid

```
                ┌─────────────────┐
                │  Manual Tests   │  (5% - Edge cases, UX)
                └─────────────────┘
            ┌─────────────────────────┐
            │  Integration Tests      │  (25% - E2E workflows)
            └─────────────────────────┘
        ┌───────────────────────────────────┐
        │  Performance Benchmarks           │  (10% - Regression)
        └───────────────────────────────────┘
┌───────────────────────────────────────────────┐
│          Unit Tests                           │  (60% - Components)
└───────────────────────────────────────────────┘
```

### Unit Tests (60% of test effort, >80% code coverage)

**Scope:**

- WorkflowState reducers (messages, tasks, decisions, context)
- CommandQueue operations (enqueue, dequeue, FIFO ordering)
- EventStream emission and backpressure
- CheckpointManager CRUD operations
- State invariants validation
- Type guards and validation logic

**Tools:** Deno.test (built-in)

**Coverage Target:** >80% (>90% for reducers)

**Example Tests:**

```typescript
// State reducer tests
Deno.test("WorkflowState: messages reducer appends new messages", () => {
  const state = { messages: [msg1], tasks: [], decisions: [], context: {} };
  updateState(state, { messages: [msg2, msg3] });
  assertEquals(state.messages, [msg1, msg2, msg3]);
});

// Command queue tests
Deno.test("CommandQueue: maintains FIFO ordering", async () => {
  const queue = new AsyncQueue<Command>();
  queue.enqueue(cmd1);
  queue.enqueue(cmd2);
  assertEquals(await queue.dequeue(), cmd1);
  assertEquals(await queue.dequeue(), cmd2);
});
```

### Integration Tests (25% of test effort, E2E scenarios)

**Scope:**

- End-to-end AIL workflow (agent triggers replan)
- End-to-end HIL workflow (human approves/rejects)
- Checkpoint & resume (inject crash, verify resume correctness)
- Dynamic DAG replanning (discovery pattern)
- GraphRAG feedback loop (verify edge weight updates)
- Multi-turn conversation persistence

**Tools:** Deno.test with mocks (GraphRAGEngine, PGlite, MCP tools)

**Key Scenarios:**

1. **AIL Workflow:**
   - Execute DAG layer 0
   - Agent decision point: trigger replan
   - DAGSuggester queries GraphRAG
   - New nodes injected into DAG
   - Execution continues with updated DAG

2. **HIL Workflow:**
   - Execute DAG layer 0
   - HIL approval required
   - Summary generated
   - Human approves
   - Execution continues

3. **Resume Workflow:**
   - Execute layers 0-2
   - Inject crash during layer 3
   - Load checkpoint (layer 2)
   - Resume execution from layer 3
   - Verify state consistency

4. **Replanning Workflow:**
   - Execute discovery task (list_directory)
   - Agent detects new requirement (XML files found)
   - Agent enqueues replan command
   - New parser node injected
   - Parallel execution of JSON + XML parsers

### Performance Benchmarks (10% of test effort, regression detection)

**Scope:**

- Speedup 5x preservation (ParallelExecutor baseline vs ControlledExecutor)
- Checkpoint save latency (<50ms P95)
- Command injection latency (<10ms P95)
- Event emission overhead (<5ms per event)
- State update latency (<1ms per reducer)
- GraphRAG replan latency (<200ms P95)

**Tools:** Deno.bench (built-in)

**Baseline:** Epic 2 performance metrics

**Success Criteria:** <5% degradation

**Example Benchmark:**

```typescript
Deno.bench("Checkpoint save latency", async (b) => {
  const state = createMockState();
  const manager = new CheckpointManager();

  b.start();
  await manager.saveCheckpoint("wf-123", 2, state);
  b.end();

  // Assert: <50ms P95
});
```

### Regression Tests (Epic 2 backward compatibility)

**Scope:**

- ParallelExecutor API unchanged
- Epic 2 code runs without modifications
- Existing tests pass

**Tools:** Deno.test (run Epic 2 test suite)

**Success Criteria:** 100% Epic 2 tests passing

### Manual Tests (5% of test effort, exploratory testing)

**Scope:**

- Edge cases (network failures, disk full, timeout scenarios)
- UX validation (HIL summary quality, error messages)
- Chaos testing (random crashes, concurrent command injection)
- Security review (sanitization, validation, audit trail)

**Execution:** Developer + QA review

### Test Data and Mocks

**Mock Components:**

- `MockGraphRAGEngine`: Returns predictable PageRank + vector search results
- `MockPGlite`: In-memory JSONB storage (no disk I/O)
- `MockMCPTool`: Simulates tool execution with configurable latency/results
- `MockAgent`: Simulates agent decisions (continue/replan/abort)

**Test Fixtures:**

- Sample DAGs (simple 3-layer, complex 10-layer)
- Sample WorkflowState (various sizes: small 1KB, large 5MB)
- Sample commands (all 6 command types)
- Sample events (all 9 event types)

### Continuous Integration

**CI Pipeline:**

```
1. Lint (deno lint)
2. Format check (deno fmt --check)
3. Type check (deno check src/**/*.ts)
4. Unit tests (deno test tests/unit/)
5. Integration tests (deno test tests/integration/)
6. Benchmarks (deno bench --baseline)
7. Coverage report (>80% target)
```

**Quality Gates:**

- All tests pass
- Coverage >80%
- No type errors
- Performance regression <5%

### Test Coverage Matrix

| Component          | Unit Tests                       | Integration Tests     | Benchmarks           | Manual Tests     |
| ------------------ | -------------------------------- | --------------------- | -------------------- | ---------------- |
| ControlledExecutor | ✅ State updates, event emission | ✅ E2E workflows      | ✅ Speedup 5x        | ✅ Chaos testing |
| WorkflowState      | ✅ Reducers (>90% cov)           | ✅ State persistence  | ✅ Update latency    | -                |
| CommandQueue       | ✅ Queue ops, ordering           | ✅ Command injection  | ✅ Injection latency | ✅ Concurrency   |
| EventStream        | ✅ Emission, backpressure        | ✅ Event consumers    | ✅ Emission overhead | -                |
| CheckpointManager  | ✅ CRUD, retention               | ✅ Resume scenarios   | ✅ Save latency      | ✅ Disk full     |
| DAGSuggester       | ✅ Replan logic                  | ✅ Dynamic replanning | ✅ Replan latency    | -                |

### Test Timeline

| Story     | Unit Tests | Integration Tests | Benchmarks | Total Test Time      |
| --------- | ---------- | ----------------- | ---------- | -------------------- |
| 2.5-1     | 2h         | 1h                | 0.5h       | 3.5h (50% of story)  |
| 2.5-2     | 1h         | 1h                | 0.5h       | 2.5h (50% of story)  |
| 2.5-3     | 1h         | 1.5h              | 0.5h       | 3h (60% of story)    |
| **Total** | **4h**     | **3.5h**          | **1.5h**   | **9h (56% of epic)** |

**Test-to-Code Ratio:** ~1.3:1 (healthy for production code)
