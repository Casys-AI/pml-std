# ADR-020: AIL Control Protocol - Unified Command Architecture

**Status:** 📝 Draft **Date:** 2025-11-25 | **Consolidates:** ADR-018 + ADR-019

> Deferred to Epic 3.5+ - SSE streaming incompatible with MCP one-shot protocol.

## Executive Summary

**Decision:** Adopt a **Three-Level AIL Architecture** with **4 unified commands** that serve both
external MCP agents (Level 1) and internal native agents (Level 2).

| Level       | Agent Type                  | Communication         | Commands via      |
| ----------- | --------------------------- | --------------------- | ----------------- |
| **Level 1** | External MCP (Claude Code)  | HTTP Request/Response | MCP meta-tools    |
| **Level 2** | Internal Native (JS/TS)     | SSE + CommandQueue    | Direct enqueue    |
| **Level 3** | Embedded MCP (haiku/sonnet) | Task Input/Output     | N/A (task output) |

### MCP Tools (gateway-server.ts)

| Tool                    | Purpose                | Status                           |
| ----------------------- | ---------------------- | -------------------------------- |
| `pml:execute`           | Execute workflow       | ✅ Exists (was execute_workflow) |
| `pml:search_tools`      | Semantic tool search   | ✅ Exists                        |
| `pml:execute_code`      | Deno sandbox execution | ✅ Exists                        |
| `pml:continue`          | Continue to next layer | 🆕 Story 2.5-4                   |
| `pml:abort`             | Abort workflow         | 🆕 Story 2.5-4                   |
| `pml:replan`            | Replan via GraphRAG    | 🆕 Story 2.5-4                   |
| `pml:approval_response` | HIL approval           | 🆕 Story 2.5-4                   |

---

## Context

### Problem Discovery (2025-11-24)

During Epic 2.5 implementation, we discovered:

1. **Story 2.5-3** implemented SSE + CommandQueue for AIL decision points
2. **MCP is one-shot**: External agents (Claude Code) cannot receive SSE events mid-execution
3. **SSE still valuable**: Internal native agents CAN use SSE (they're JS/TS code, not MCP clients)
4. **Commands dual-purpose**: Same 4 commands work for both Level 1 (MCP tools) and Level 2
   (CommandQueue)

### Key Insight

```
┌─────────────────────────────────────────────────────────────┐
│ MCP Protocol = Request → Response (one-shot)                │
│                                                             │
│ Level 1: Claude Code → MCP tool call → Gateway → Response   │
│          (Cannot receive SSE events mid-execution)          │
│                                                             │
│ Level 2: Internal Agent → SSE events → CommandQueue         │
│          (CAN receive SSE - native JS/TS code)              │
└─────────────────────────────────────────────────────────────┘
```

---

## Decision

### The 4 Unified Commands

| Command             | Purpose                | Level 1 (MCP)           | Level 2 (Internal)                                 |
| ------------------- | ---------------------- | ----------------------- | -------------------------------------------------- |
| `continue`          | Resume execution       | `pml:continue`          | `commandQueue.enqueue({type:"continue"})`          |
| `abort`             | Stop workflow          | `pml:abort`             | `commandQueue.enqueue({type:"abort"})`             |
| `replan`            | Add tasks via GraphRAG | `pml:replan`            | `commandQueue.enqueue({type:"replan"})`            |
| `approval_response` | HIL approval           | `pml:approval_response` | `commandQueue.enqueue({type:"approval_response"})` |

### Command Definitions

```typescript
// src/dag/types.ts (existing)
export type Command =
  | { type: "continue"; reason?: string }
  | { type: "abort"; reason: string }
  | { type: "replan"; new_requirement: string; available_context: Record<string, unknown> }
  | { type: "approval_response"; checkpoint_id: string; approved: boolean; feedback?: string };
```

---

## Level 1: External MCP Agents

### Flow

```
Claude Code                    Gateway
    │                            │
    ├─ pml:execute() ────►│ Execute Layer 0
    │                            │
    │◄── {status: "layer_complete", results: [...]} ──┤
    │                            │
    │   [Agent analyzes results] │
    │                            │
    ├─ pml:continue() ───►│ Execute Layer 1
    │                            │
    │◄── {status: "layer_complete", results: [...]} ──┤
    │                            │
    │   [Agent finds XML files]  │
    │                            │
    ├─ pml:replan() ─────►│ GraphRAG adds XML parser
    │                            │
    │◄── {status: "layer_complete", new_tasks: [...]} │
    │                            │
    └─ pml:continue() ───►│ Complete
```

### MCP Meta-Tools

```typescript
// Implemented in gateway-server.ts (Story 2.5-4)
const controlTools: MCPTool[] = [
  {
    name: "pml:continue",
    description: "Continue workflow execution to next layer",
    inputSchema: {
      type: "object",
      properties: {
        workflow_id: { type: "string" },
        reason: { type: "string" },
      },
      required: ["workflow_id"],
    },
  },
  {
    name: "pml:abort",
    description: "Abort workflow execution",
    inputSchema: {
      type: "object",
      properties: {
        workflow_id: { type: "string" },
        reason: { type: "string" },
      },
      required: ["workflow_id", "reason"],
    },
  },
  {
    name: "pml:replan",
    description: "Replan workflow with new requirement (triggers GraphRAG)",
    inputSchema: {
      type: "object",
      properties: {
        workflow_id: { type: "string" },
        new_requirement: { type: "string" },
        available_context: { type: "object" },
      },
      required: ["workflow_id", "new_requirement"],
    },
  },
  {
    name: "pml:approval_response",
    description: "Respond to HIL approval checkpoint",
    inputSchema: {
      type: "object",
      properties: {
        workflow_id: { type: "string" },
        checkpoint_id: { type: "string" },
        approved: { type: "boolean" },
        feedback: { type: "string" },
      },
      required: ["workflow_id", "checkpoint_id", "approved"],
    },
  },
];
```

### Per-Layer Validation Mode

```typescript
// execute with per-layer validation
const response = await pml.execute({
  intent: "Analyze codebase for security issues",
  config: { per_layer_validation: true }  // ← Enable AIL
});

// Response pauses after each layer
{
  status: "layer_complete",
  workflow_id: "uuid",
  layer_index: 0,
  layer_results: [...],
  next_layer_preview: {...},
  options: ["continue", "replan", "abort"]
}
```

---

## Level 2: Internal Native Agents

### Flow

```typescript
// Internal agent subscribes to SSE events
const stream = executor.executeStream(dag);

for await (const event of stream) {
  if (event.type === "decision_required") {
    // Internal agent decides
    const decision = await myAgent.decide(event.context);

    // Enqueue command
    commandQueue.enqueue({
      type: decision.action,
      ...decision.params,
    });
  }
}
```

### Use Cases

1. **Rule-Based Agent**: State machine with business rules
2. **Multi-Agent Collaboration**: Security + Performance + Cost agents
3. **Background Workflow**: Long-running autonomous pipeline
4. **LLM Agent via API**: Direct Anthropic API call (not MCP)

---

## Level 3: Embedded Agents (Future - Epic 3.5+)

Agents run as DAG tasks, output available to dependent tasks.

```typescript
{
  id: "analyze_api",
  type: "agent_delegation",
  agent_model: "haiku",
  agent_goal: "Analyze API docs",
  depends_on: ["fetch_docs"]
}
```

**Status:** Deferred to Epic 3.5+

---

## Two Types of Checkpoints

| Type                | Command               | Purpose                         | Options                  |
| ------------------- | --------------------- | ------------------------------- | ------------------------ |
| **Fault Tolerance** | `checkpoint_response` | Resume after crash              | continue/rollback/modify |
| **HIL Approval**    | `approval_response`   | Human approval for critical ops | approved yes/no          |

### Fault Tolerance (Story 2.5-2)

```
Layer 0 → [Checkpoint saved] → Layer 1 → [Checkpoint] → CRASH
                                              ↓
                                    Resume from checkpoint
```

**Command:** `checkpoint_response`

```typescript
{ type: "checkpoint_response", checkpoint_id: "uuid", decision: "continue" | "rollback" | "modify" }
```

### HIL Approval (Story 2.5-3)

```
Layer 2 → [PAUSE: "Delete 500 files?"] → Human approves → Layer 3
```

**Command:** `approval_response`

```typescript
{ type: "approval_response", checkpoint_id: "uuid", approved: true, feedback?: "..." }
```

---

## Implementation Status

### Done (Epic 2.5)

| Component                     | Status | Location                         |
| ----------------------------- | ------ | -------------------------------- |
| Command types                 | ✅     | `src/dag/types.ts:246-292`       |
| CommandQueue                  | ✅     | `src/dag/command-queue.ts`       |
| BUG-001 fix                   | ✅     | `drainSync()` line 215           |
| ControlledExecutor            | ✅     | `src/dag/controlled-executor.ts` |
| SSE Events                    | ✅     | 10 event types                   |
| Checkpoints (fault tolerance) | ✅     | Story 2.5-2                      |
| AIL/HIL integration           | ✅     | Story 2.5-3                      |

### To Do (Story 2.5-4 revised)

| Component                 | Priority | Estimate |
| ------------------------- | -------- | -------- |
| MCP meta-tools (4 tools)  | P0       | 3h       |
| Per-layer validation mode | P0       | 2h       |
| Workflow state management | P1       | 2h       |
| Integration tests         | P1       | 1h       |

---

## Story 2.5-4 Revised Scope

**Old scope:** Fix BUG-001 + error handling (4h) **New scope:** Expose commands as MCP meta-tools
(8h)

### AC1: MCP Control Tools (3h)

Add 4 MCP meta-tools to `gateway-server.ts`:

- `pml:continue`
- `pml:abort`
- `pml:replan`
- `pml:approval_response`

### AC2: Per-Layer Validation Mode (2h)

Modify `pml:execute` to support `per_layer_validation: true`:

- Return after each layer with partial results
- Store workflow state for continuation
- Support checkpoint_url for recovery

### AC3: Workflow State Management (2h)

Track active workflows for continuation:

```typescript
const activeWorkflows = new Map<string, {
  dag: DAGStructure;
  currentLayer: number;
  results: TaskResult[];
  state: WorkflowState;
}>();
```

### AC4: Integration Tests (1h)

- Test: External agent flow (execute → continue → complete)
- Test: Replan mid-workflow (execute → replan → continue)
- Test: Abort mid-workflow (execute → abort)
- Test: HIL approval flow

---

## Deferred Commands (YAGNI)

| Command               | Reason                                        | Reconsider if                        |
| --------------------- | --------------------------------------------- | ------------------------------------ |
| `inject_tasks`        | `replan` via GraphRAG preferred               | >5 use cases needing precise control |
| `skip_layer`          | Safe-to-fail pattern covers this              | >5 proven use cases                  |
| `modify_args`         | No proven HIL correction workflow             | >3 user requests                     |
| `retry_task`          | Auto-retry in executor                        | >3 cases where auto insufficient     |
| `checkpoint_response` | ✅ APPROVED (separate from approval_response) | N/A                                  |

---

## Migration

### ADR-018 → Superseded

```markdown
## Status

**SUPERSEDED** - 2025-11-25 by ADR-020

> This ADR documented initial command handler decisions. See ADR-020: AIL Control Protocol for
> consolidated architecture.
```

### ADR-019 → Superseded

```markdown
## Status

**SUPERSEDED** - 2025-11-25 by ADR-020

> This ADR documented three-level architecture discovery. See ADR-020: AIL Control Protocol for
> consolidated architecture.
```

---

## Consequences

### Positive

- **Single source of truth**: One ADR for all AIL/command decisions
- **Clear implementation path**: Story 2.5-4 has concrete scope
- **MCP compatible**: External agents can control workflows
- **Internal agents enabled**: SSE + CommandQueue for Level 2

### Negative

- **More MCP tools**: 4 new tools to maintain
- **State management**: Must track active workflows

### Neutral

- **Epic 2.5 nearly complete**: Just need MCP tools + per-layer validation

---

## Related Documents

- **Story 2.5-4**: Implementation of MCP control tools
- **ADR-007**: 3-Loop Learning (conceptual foundation)
- **Spike**: Agent-Human DAG Feedback Loop (original exploration)

---

## Approval

**Author**: BMad + Claude Opus 4.5 **Date**: 2025-11-25 **Status**: APPROVED

**Decision**: Adopt unified AIL Control Protocol with 4 commands serving both Level 1 (MCP
meta-tools) and Level 2 (CommandQueue) agents.
