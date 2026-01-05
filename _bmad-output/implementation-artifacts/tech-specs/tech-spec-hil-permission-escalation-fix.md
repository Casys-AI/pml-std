# Tech-Spec: HIL Permission Escalation Architecture Fix

**Created:** 2025-12-16 **Status:** ✅ Phase 1-2 Complete, Phase 3-4 Superseded **Updated:**
2025-12-19 **Related Stories:** 2.5-3, 7.7a, 7.7b, 7.7c

> **⚠️ PARTIALLY OBSOLETE (2025-12-19)**
>
> - **Phase 3 (sideEffects cleanup)**: ✅ Completed - `sideEffects` field removed
> - **Phase 4 (per-task HIL)**: Superseded by `per_layer_validation` mechanism
> - **ffi/run validation**: Removed - these fields no longer exist in config
>
> Current validation triggers (see `requiresValidation()` in workflow-execution-handler.ts):
>
> - Unknown MCP tools (not in mcp-permissions.yaml)
> - Tools with `approvalMode: "hil"`
> - `code_execution` with non-minimal permissions

## Overview

### Problem Statement

The Human-in-the-Loop (HIL) mechanism for permission escalation in DAG execution had multiple
architectural issues:

1. **Deadlock Bug**: Tasks execute inside `Promise.allSettled()`, so the generator cannot `yield`
   events while waiting. `waitForDecisionCommand()` blocks indefinitely waiting for a response that
   can never arrive.

2. **Dual Execution Paths**: `execute()` (non-interactive) and `executeStream()` (generator) had
   separate implementations, causing HIL to only work with `executeStream()`.

3. **Client-Controlled Security**: `per_layer_validation` was controlled by the client, allowing
   potential bypass of security checks.

4. **Invisible Errors**: MCP tool errors used JSON-RPC format `{ error: {...} }` instead of MCP tool
   format `{ isError: true, content: [...] }`, making errors invisible to LLM clients.

### Solution Implemented

**Phase 1: Unified Execution (Completed)**

- `execute()` now wraps `executeStream()` - single code path
- Non-interactive mode returns errors in result instead of deadlocking
- Permission errors provide helpful suggestions (use `primitives:http_get`)

**Phase 2: Server-Side Validation Detection (Completed)**

- Server auto-detects if DAG requires validation based on:
  - `code_execution` with `permissionSet !== "minimal"`
  - `capability` with non-minimal permissions
  - MCP tools with elevated permissions in `mcp-permissions.yaml`
- Client cannot bypass validation - server decides
- MCP tool errors now use correct format and are logged for observability

**Phase 3: Legacy Cleanup (Pending)**

- Remove deprecated `sideEffects` mechanism
- Clean up unused HIL config

**Phase 4: Per-Task HIL (Future)**

- True HIL with pause BEFORE executing specific tasks marked `approvalMode: "hil"`

### Scope

**In Scope:**

- Fix HIL for `code_execution` tasks
- Fix HIL for `capability` tasks
- Remove `sideEffects` flag and related code
- Remove `shouldRequireApproval()` and `generateHILSummary()`
- Remove HIL config from ExecutorConfig (`hil.enabled`, `hil.approval_required`)
- Update gateway-server.ts to remove HIL config

**Out of Scope:**

- AIL (Agent-in-the-Loop) mechanism - unchanged
- Checkpoint/resume functionality - unchanged
- Permission escalation logic itself - only the delivery mechanism changes

## Context for Development

### Codebase Patterns

**Event Emission Pattern (current - broken for mid-task):**

```typescript
// In executeStream() - this works
const event: ExecutionEvent = { type: "task_complete", ... };
await this.eventStream.emit(event);
yield event;  // ✅ Works - we're in the generator

// In executeCodeTask() - this DOESN'T work
await this.eventStream.emit(escalationEvent);  // Event goes to array
const command = await this.waitForDecisionCommand();  // ❌ BLOCKS - generator can't yield
```

**Deferred Escalation Pattern (new - solution):**

```typescript
// In executeCodeTask() - throw instead of block
throw new PermissionEscalationNeeded({
  taskId: task.id,
  currentSet: "minimal",
  requestedSet: "network-api",
  detectedOperation: "net",
  originalError: error,
});

// In executeStream() layer processing - handle after Promise.allSettled
const escalationsNeeded = layerResults
  .filter(r => r.status === "rejected" && r.reason instanceof PermissionEscalationNeeded);

for (const escalation of escalationsNeeded) {
  // Now we CAN yield because we're back in the generator
  yield { type: "decision_required", ... };
  const command = await this.waitForDecisionCommand();
  if (command.approved) {
    // Re-execute task with escalated permissions
  }
}
```

### Files to Reference

#### Already Modified (Pre-Spec Implementation)

| File                                       | Changes Made                                      | Status                                     |
| ------------------------------------------ | ------------------------------------------------- | ------------------------------------------ |
| `src/dag/controlled-executor.ts`           | HIL logic in executeCodeTask, ~120 lines          | 🔄 Needs refactor (throw instead of block) |
| `src/dag/types.ts`                         | checkpointId + context on decision_required event | ✅ Keep                                    |
| `src/mcp/gateway-server.ts`                | decision_required handler + hil config            | 🔄 Keep handler, remove hil config         |
| `src/events/types.ts`                      | capability.permission.updated event               | ✅ Keep                                    |
| `docs/epics.md`                            | Stories 7.7a/b/c documentation                    | ✅ Keep                                    |
| `docs/sprint-artifacts/sprint-status.yaml` | Story 7.7c status                                 | 🔄 Update                                  |
| `docs/sprint-artifacts/story-2.5-3.md`     | Bug documentation                                 | ✅ Keep                                    |

#### To Modify (Implementation Phase)

| File                                                | Purpose                                                                      |
| --------------------------------------------------- | ---------------------------------------------------------------------------- |
| `src/dag/controlled-executor.ts`                    | Refactor to Option A/B pattern                                               |
| `src/dag/types.ts`                                  | Add PermissionEscalationNeeded error, remove sideEffects from ExecutorConfig |
| `src/mcp/gateway-server.ts`                         | Remove hil config from ControlledExecutor instantiation                      |
| `src/graphrag/types.ts`                             | Remove Task.sideEffects field                                                |
| `src/capabilities/permission-escalation-handler.ts` | Update HIL callback interface (if Option B)                                  |

#### Reference Only (No Changes)

| File                                        | Purpose                                |
| ------------------------------------------- | -------------------------------------- |
| `src/dag/event-stream.ts`                   | Event streaming architecture reference |
| `src/sandbox/executor.ts`                   | DenoSandboxExecutor reference          |
| `src/capabilities/permission-escalation.ts` | suggestEscalation() reference          |

### Technical Decisions

**Decision pending** - 4 architectural options documented below. Final choice TBD.

---

## ADR: HIL Permission Escalation Delivery Mechanism

### Context

The HIL mechanism for permission escalation in DAG execution has a deadlock bug. When a task needs
permission escalation, it emits a `decision_required` event and waits for approval. However, the
event never reaches the client because the generator cannot yield while `Promise.allSettled()` is
waiting.

### Options

#### Option A: Deferred Escalation Pattern (Error-Based)

**Approach:** Tasks throw `PermissionEscalationNeeded` error, handled at layer boundary after
`Promise.allSettled`.

```typescript
// In executeCodeTask() - throw instead of block
throw new PermissionEscalationNeeded({
  taskId: task.id,
  currentSet: "minimal",
  requestedSet: "network-api",
});

// After Promise.allSettled - handle escalations
for (const escalation of escalationsNeeded) {
  yield { type: "decision_required", ... };
  const command = await waitForDecisionCommand();
  if (approved) re-execute task;
}
```

| Aspect                   | Assessment                                 |
| ------------------------ | ------------------------------------------ |
| **Complexity**           | Low - ~200 lines                           |
| **Risk**                 | Low - uses existing error handling         |
| **UX**                   | Prompt after layer tasks attempt execution |
| **Concurrency**          | Preserved via Promise.allSettled           |
| **Multiple Escalations** | ✅ Handles multiple in same layer          |

**Pros:** Simple, low risk, fits existing architecture **Cons:** Slight delay before user sees
approval request

---

#### Option B: Async Event Buffer with Custom Executor

**Approach:** Replace `Promise.allSettled` with a custom concurrent executor that can yield events
mid-execution.

```typescript
// Custom executor that yields events as they happen
for await (const event of concurrentTaskExecutor(layer)) {
  if (event.type === "decision_required") {
    yield event;  // ✅ Immediate yield!
    const command = await waitForDecisionCommand();
    executor.signal(event.taskId, command);  // Resume/abort task
  } else {
    yield event;
  }
}
```

| Aspect                   | Assessment                             |
| ------------------------ | -------------------------------------- |
| **Complexity**           | High - ~400-500 lines, new abstraction |
| **Risk**                 | Medium - new execution model           |
| **UX**                   | Prompt immediately when needed         |
| **Concurrency**          | Preserved with fine-grained control    |
| **Multiple Escalations** | ✅ Handles with proper ordering        |

**Pros:** Clean event-driven design, immediate UX, extensible for future mid-task events **Cons:**
More code, new patterns to learn, potential race conditions

---

#### Option C: Sequential Task Execution (Rejected)

**Approach:** Execute tasks one-by-one instead of in parallel.

```typescript
for (const task of layer) {
  const result = await executeTask(task);  // One at a time
  yield events...
}
```

| Aspect          | Assessment                                         |
| --------------- | -------------------------------------------------- |
| **Complexity**  | Low                                                |
| **Risk**        | Low                                                |
| **Performance** | ❌ **Terrible** - loses 5x parallelization speedup |

**Verdict:** ❌ Rejected - defeats the purpose of DAG parallelization

---

#### Option D: Hybrid - Isolate Permission-Sensitive Tasks

**Approach:** Tasks with `sandboxConfig.permissionSet !== "trusted"` execute sequentially, others in
parallel.

```typescript
const [trustedTasks, riskyTasks] = partition(layer, t => t.sandboxConfig?.permissionSet === "trusted");

// Run trusted tasks in parallel
await Promise.allSettled(trustedTasks.map(executeTask));

// Run risky tasks sequentially (can yield mid-execution)
for (const task of riskyTasks) {
  try {
    await executeTask(task);
  } catch (e) {
    if (e instanceof PermissionEscalationNeeded) {
      yield decision_required;
      // handle...
    }
  }
}
```

| Aspect          | Assessment                                         |
| --------------- | -------------------------------------------------- |
| **Complexity**  | Medium - ~300 lines                                |
| **Risk**        | Medium                                             |
| **UX**          | Immediate for risky tasks only                     |
| **Concurrency** | Partial - trusted tasks parallel, risky sequential |

**Pros:** Compromise between A and B, targets the problem specifically **Cons:** Two execution paths
to maintain, "risky" classification may be wrong

---

### Decision Matrix

| Criteria (Weight)           | Option A   | Option B   | Option C   | Option D |
| --------------------------- | ---------- | ---------- | ---------- | -------- |
| Implementation Effort (20%) | ⭐⭐⭐⭐⭐ | ⭐⭐       | ⭐⭐⭐⭐⭐ | ⭐⭐⭐   |
| Risk (25%)                  | ⭐⭐⭐⭐⭐ | ⭐⭐⭐     | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| Performance (25%)           | ⭐⭐⭐⭐   | ⭐⭐⭐⭐   | ⭐         | ⭐⭐⭐   |
| Maintainability (15%)       | ⭐⭐⭐⭐   | ⭐⭐⭐     | ⭐⭐⭐⭐⭐ | ⭐⭐⭐   |
| UX Quality (15%)            | ⭐⭐⭐     | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐   | ⭐⭐⭐⭐ |
| **Weighted Score**          | **4.1**    | **3.4**    | **3.2**    | **3.4**  |

### Decision

**✅ Option A Selected** - Deferred Escalation Pattern

Rationale:

- Low risk, fits existing architecture
- Single execution path: `execute()` wraps `executeStream()`
- Clear error messages guide users to authorized tools
- Server-side validation detection prevents client bypass

---

## Implementation Plan

### Phase 1: Unified Execution ✅ Complete

- [x] **Task 1.1**: Override `execute()` in ControlledExecutor to wrap `executeStream()`
  - Single code path for all execution modes
  - File: `src/dag/controlled-executor.ts`

- [x] **Task 1.2**: Non-interactive mode throws on `decision_required`
  - `execute()` throws clear error instead of blocking
  - Error message guides to use `executeStream()` or `per_layer_validation`

- [x] **Task 1.3**: Add `getPermissionSuggestion()` helper
  - Maps permission errors to authorized tool suggestions
  - Example: "Permission denied: --allow-net → Use primitives:http_get"

### Phase 2: Server-Side Validation Detection ✅ Complete

- [x] **Task 2.1**: Create `requiresValidation()` function
  - File: `src/mcp/handlers/workflow-execution-handler.ts`
  - Analyzes DAG to determine if validation needed
  - Server decides, client cannot bypass

- [x] **Task 2.2**: Detection rules implemented
  - `code_execution` with `permissionSet !== "minimal"` → needs validation
  - `capability` with non-minimal permissions → needs validation

- [x] **Task 2.3**: Integrate MCP tool permissions
  - Read from `config/mcp-permissions.yaml` via `getToolPermissionConfig()`
  - Validation triggers: `scope !== "minimal"`, `approvalMode === "hil"`, `ffi`, `run`
  - Integrated in `requiresValidation()` for all MCP tool tasks

- [x] **Task 2.4**: Auto-enable validation in `handleWorkflowExecution()`
  - Server-side detection: `serverRequiresValidation || perLayerValidation`
  - Client can request validation but cannot bypass server requirement
  - Integrated in both explicit workflow and intent-based flows

- [x] **Task 2.5**: Fix MCP tool error format
  - Created `formatMCPToolError()` in `src/mcp/server/responses.ts`
  - Returns `{ isError: true, content: [...] }` format per MCP spec
  - Errors now visible to LLM clients (Claude Code)
  - Added server-side logging with `[MCP_TOOL_ERROR]` prefix for Promtail/Loki

- [x] **Task 2.6**: Convert all handlers to new error format
  - `control-commands-handler.ts` - all validation errors
  - `workflow-execution-handler.ts` - parameter errors
  - `search-handler.ts` - search failures
  - `code-execution-handler.ts` - execution failures
  - `gateway-server.ts` - tool call errors (except `tools/list` which stays JSON-RPC)

### Phase 3: Legacy Cleanup (Pending)

> **Note:** On garde le code HIL existant (`shouldRequireApproval`, `generateHILSummary`, `hil`
> config) car il sera réutilisé/adapté pour Phase 4 (per-task HIL). On nettoie seulement
> `sideEffects`.

- [ ] **Task 3.1**: Remove legacy `sideEffects` mechanism only
  - Remove `sideEffects` from Task type in `src/graphrag/types.ts`
  - Remove `sideEffects` checks in `shouldRequireApproval()` (but keep the function)
  - Keep `generateHILSummary()` for Phase 4

- [ ] **Task 3.2**: Keep HIL infrastructure for Phase 4
  - ~~Remove `hil` field from `ExecutorConfig`~~ → **KEEP** for Phase 4
  - ~~Update gateway-server.ts to remove HIL config~~ → Already not passing config, code stays
  - Document that HIL is disabled by not passing config (not by removing code)

- [ ] **Task 3.3**: Update security tests
  - `tests/dag/checkpoint-resume-security.test.ts` - mark HIL/AIL tests as `.skip()` until Phase 4
  - Add test for server-side validation detection (`requiresValidation()`)

### Phase 4: Per-Task HIL (Future)

- [ ] **Task 4.1**: Implement task-level HIL detection
  - Before executing a task with `task.tool`, check
    `getToolPermissionConfig(toolPrefix).approvalMode === "hil"`
  - If true, yield `decision_required` event and wait for approval
  - Different from per-layer validation: pauses BEFORE task execution, not after layer

- [ ] **Task 4.2**: Update ControlledExecutor for mid-layer HIL
  - Challenge: Cannot yield from inside `Promise.allSettled()`
  - Options: Sequential execution for HIL tasks, or custom concurrent executor
  - See ADR Options B and D for architectural approaches

- [ ] **Task 4.3**: Wire up approval flow
  - `approval_response` with `approved: true` → execute task
  - `approval_response` with `approved: false` → skip task, continue workflow

---

## Server-Side Validation Detection

### `requiresValidation()` Function

**Location:** `src/mcp/handlers/workflow-execution-handler.ts`

```typescript
async function requiresValidation(
  dag: DAGStructure,
  capabilityStore?: CapabilityStore,
): Promise<boolean> {
  for (const task of dag.tasks) {
    const taskType = getTaskType(task);

    // Code execution with elevated permissions → needs validation
    if (taskType === "code_execution") {
      const permSet = task.sandboxConfig?.permissionSet ?? "minimal";
      if (permSet !== "minimal") {
        return true;
      }
    }

    // Capability with non-minimal permissions → needs validation
    if (taskType === "capability" && task.capabilityId && capabilityStore) {
      const cap = await capabilityStore.findById(task.capabilityId);
      if (cap?.permissionSet && cap.permissionSet !== "minimal") {
        return true;
      }
    }

    // MCP tool with elevated permissions or human approval required → needs validation
    if (taskType === "mcp_tool" && task.tool) {
      const toolPrefix = task.tool.split(":")[0];
      const permConfig = getToolPermissionConfig(toolPrefix);
      if (permConfig) {
        if (permConfig.scope !== "minimal") return true;
        if (permConfig.approvalMode === "hil") return true;
        if (permConfig.ffi || permConfig.run) return true;
      }
    }
  }
  return false;
}
```

### Detection Rules

| Task Type        | Condition                            | Validation Required |
| ---------------- | ------------------------------------ | ------------------- |
| `code_execution` | `permissionSet === "minimal"`        | ❌ No               |
| `code_execution` | `permissionSet !== "minimal"`        | ✅ Yes              |
| `capability`     | Stored `permissionSet === "minimal"` | ❌ No               |
| `capability`     | Stored `permissionSet !== "minimal"` | ✅ Yes              |
| `mcp_tool`       | `approvalMode: "auto"` in yaml       | ❌ No               |
| `mcp_tool`       | `approvalMode: "hil"` in yaml        | ✅ Yes              |

### Permission Sets

From `src/capabilities/types.ts`:

- `"minimal"` - No special permissions (safe to run)
- `"readonly"` - Read-only filesystem access
- `"filesystem"` - Read/write filesystem access
- `"network-api"` - HTTP/HTTPS network access
- `"mcp-standard"` - MCP tool usage
- `"trusted"` - Full permissions (dangerous)

### MCP Permissions Configuration

**Location:** `config/mcp-permissions.yaml`

```yaml
servers:
  filesystem:
    tools:
      read_file:
        permissions:
          scope: read
        approvalMode: auto
      write_file:
        permissions:
          scope: full
        approvalMode: hil # Requires human approval
```

The 3-axis permission model:

- `scope`: `read` | `full` | `none`
- `ffi`: `true` | `false` - Foreign Function Interface
- `run`: `true` | `false` - Subprocess execution

### Acceptance Criteria

- [ ] **AC1**: `code_execution` task with permission error returns `approval_required` to PML client
  ```
  Given: DAG with code_execution task that requires network access
  When: Task executes with "minimal" permission set
  Then: Client receives { status: "approval_required", decision_type: "HIL", ... }
  ```

- [ ] **AC2**: Approved escalation re-executes task successfully
  ```
  Given: approval_required returned for permission escalation
  When: Client sends approval_response with approved: true
  Then: Task re-executes with escalated permissions and completes
  ```

- [ ] **AC3**: Rejected escalation fails task gracefully
  ```
  Given: approval_required returned for permission escalation
  When: Client sends approval_response with approved: false
  Then: Task marked as failed, workflow continues (if other tasks independent)
  ```

- [ ] **AC4**: `capability` task escalation works identically
  ```
  Given: DAG with capability task that hits permission error
  When: PermissionEscalationHandler suggests escalation
  Then: Same approval_required flow as code_execution
  ```

- [ ] **AC5**: Legacy sideEffects mechanism fully removed
  ```
  Given: Task with sideEffects: true
  When: Executed in DAG
  Then: No HIL triggered (field ignored/removed)
  ```

- [ ] **AC6**: No deadlock under any permission error scenario
  ```
  Given: Any combination of permission errors in a layer
  When: Errors occur during execution
  Then: All events reach client, no infinite waits
  ```

## Changes Already Made (Pre-Spec)

These changes were made during initial debugging before this spec was created. They are **partial
fixes** that need to be completed or revised:

### 1. `src/dag/controlled-executor.ts` (~120 lines added)

- Extended `executeCodeTask()` to accept `permissionSet` parameter
- Added permission error detection (PermissionError, PermissionDenied, NotCapable)
- Integration with `suggestEscalation()` to determine needed permissions
- HIL checkpoint creation with `decision_required` event emission
- **PROBLEM**: Still uses blocking `waitForDecisionCommand()` pattern - causes deadlock
- **ACTION**: Refactor to throw `PermissionEscalationNeeded` instead

### 2. `src/dag/types.ts` (~4 lines added)

- Added `checkpointId?: string` to ExecutionEvent `decision_required` type
- Added `context?: Record<string, unknown>` for escalation details
- **STATUS**: Keep - these additions are needed for the fix

### 3. `src/mcp/gateway-server.ts` (~80 lines added)

- Added `decision_required` event handler in both event loops (lines ~940 and ~1730)
- Returns `approval_required` status to client with checkpoint_id and context
- Added `"awaiting_approval"` to `ActiveWorkflow.status` union type
- Added `hil: { enabled: true, approval_required: "critical_only" }` to ControlledExecutor configs
- **STATUS**: Keep decision_required handlers, **REMOVE** hil config (sideEffects mechanism)

### 4. `src/events/types.ts` (~1 line added)

- New event type: `capability.permission.updated`
- **STATUS**: Keep - useful for observability

### 5. `docs/epics.md` (~189 lines added)

- Full documentation for Stories 7.7a, 7.7b, 7.7c
- **STATUS**: Keep - update after fix complete

### 6. `docs/sprint-artifacts/sprint-status.yaml` (~1 line changed)

- Story 7.7c status: backlog → review
- **STATUS**: Update to reflect this spec

### 7. `docs/sprint-artifacts/story-2.5-3.md` (~144 lines added)

- Critical bug documentation discovered during debugging
- Documents that `decision_required` events were never wired up
- **STATUS**: Keep as historical record, update with resolution

### Summary of Pre-Spec State

| Change                                      | Keep/Remove/Modify                 |
| ------------------------------------------- | ---------------------------------- |
| decision_required handler in gateway-server | ✅ Keep                            |
| checkpointId/context in types               | ✅ Keep                            |
| executeCodeTask HIL logic                   | 🔄 Modify (throw instead of block) |
| hil config in gateway-server                | ❌ Remove                          |
| capability.permission.updated event         | ✅ Keep                            |

## Additional Context

### Dependencies

- Story 7.7a/b/c: Permission system foundation (complete)
- Story 2.5-3: Original HIL/AIL architecture (to be modified)
- PML gateway-server: Client communication (already has decision_required handler)

### Testing Strategy

1. **Unit Tests**:
   - `PermissionEscalationNeeded` error serialization
   - Layer-level escalation detection logic
   - Re-execution with updated permissions

2. **Integration Tests**:
   - Full DAG with code_execution needing network → approval → success
   - Full DAG with capability needing filesystem → rejection → failure
   - Multi-task layer with mixed escalation needs

3. **Security Regression Tests** (already exist):
   - `tests/dag/checkpoint-resume-security.test.ts` - 6 tests validating H4 fix
   - Currently failing due to deadlock bug - will pass once this spec is implemented
   - Tests verify: HIL required on resume, rejection aborts workflow, AIL triggers, timeout handling
   - **Bugs exposed:**
     - `BUG-HIL-DEADLOCK`: HIL tests timeout (generator can't yield before blocking)
     - `BUG-AIL-ABORT`: AIL abort command not processed (same deadlock pattern)

4. **Manual Testing**:
   - Via PML `execute_dag` with explicit workflow containing permission-requiring tasks
   - Verify `approval_required` status returned
   - Verify `approval_response` tool works

### Rollback Plan

If issues arise:

1. Revert to blocking pattern (current broken state)
2. Add `--allow-all` flag to sandbox as temporary workaround
3. Use `approvalMode: "auto"` in PermissionConfig for trusted capabilities

### Notes

**Why not use EventStream.subscribe()?** The EventStream's `subscribe()` method returns an async
iterator, but the problem is that `executeStream()` IS the generator - we can't have a generator
yield from events that happen inside its own synchronous execution. The deferred pattern solves this
by moving HIL handling to a point where the generator has control.

**Performance Impact:** Minimal. The extra error handling and re-execution only happens on
permission errors, which should be rare in production after initial capability learning.

**Migration:** No migration needed. The `sideEffects` field was never widely used. Capabilities
continue to work with their stored `permissionSet`.

---

## Phase 2 Implementation Details

### MCP Tool Error Format Fix

**Problem:** Errors returned by MCP tools used JSON-RPC format which was invisible to LLM clients.

**Solution:** Created `formatMCPToolError()` function that returns MCP-compliant error format.

**Files Modified:**

| File                                             | Changes                                   |
| ------------------------------------------------ | ----------------------------------------- |
| `src/mcp/server/responses.ts`                    | Added `formatMCPToolError()` with logging |
| `src/mcp/server/mod.ts`                          | Export `formatMCPToolError`               |
| `src/mcp/handlers/control-commands-handler.ts`   | Converted all errors to new format        |
| `src/mcp/handlers/workflow-execution-handler.ts` | Converted parameter errors                |
| `src/mcp/handlers/search-handler.ts`             | Converted search failures                 |
| `src/mcp/handlers/code-execution-handler.ts`     | Converted execution failures              |
| `src/mcp/gateway-server.ts`                      | Converted tool call errors                |

**Error Format Comparison:**

```typescript
// OLD - JSON-RPC format (invisible to LLM)
formatMCPError(MCPErrorCodes.INVALID_PARAMS, "Workflow not found", { workflow_id });
// Returns: { error: { code: -32602, message: "Workflow not found", data: {...} } }

// NEW - MCP tool format (visible to LLM)
formatMCPToolError("Workflow not found", { workflow_id });
// Returns: { isError: true, content: [{ type: "text", text: "{\"error\": \"...\", ...}" }] }
```

**Logging:**

All tool errors are now logged server-side for observability:

```
ERROR [MCP_TOOL_ERROR] Workflow xyz not found or expired { data: { workflow_id: "xyz" } }
```

Filter in Loki: `{job="pml-server"} |= "MCP_TOOL_ERROR"`

### MCP Tool Permission Detection

**Implementation in `requiresValidation()`:**

```typescript
// MCP tool with elevated permissions → needs validation
if (taskType === "mcp_tool" && task.tool) {
  const toolPrefix = task.tool.split(":")[0]; // "github:create_issue" → "github"
  const permConfig = getToolPermissionConfig(toolPrefix);

  if (permConfig) {
    if (permConfig.scope !== "minimal") return true; // elevated scope
    if (permConfig.approvalMode === "hil") return true; // human approval required
    if (permConfig.ffi || permConfig.run) return true; // dangerous permissions
  }
}
```

**Validation Triggers:**

| Condition              | Validation Required | Reason                     |
| ---------------------- | ------------------- | -------------------------- |
| `scope: "minimal"`     | No                  | Safe by default            |
| `scope: "filesystem"`  | Yes                 | File system access         |
| `scope: "network-api"` | Yes                 | Network access             |
| `approvalMode: "hil"`  | Yes                 | Human approval required    |
| `ffi: true`            | Yes                 | Foreign function interface |
| `run: true`            | Yes                 | Subprocess execution       |
| Tool not in YAML       | No                  | Permissive default         |

### AIL Implicite via Layer Results

**Pattern actuel (recommandé):**

1. Workflow s'exécute et retourne `layer_complete` avec `resultPreview`
2. Claude (l'agent) voit les résultats et décide
3. Claude fait un appel séparé : `pml_continue`, `pml_abort`, ou `pml_replan`

**Avantages:**

- Pas de deadlock (pas de `waitForDecisionCommand` bloquant)
- Claude a le contexte pour décider (preview des résultats)
- Architecture simple et robuste

**Layer Results Format:**

```json
{
  "layer_results": [
    {
      "taskId": "read_file",
      "status": "success",
      "output": {
        "executionTimeMs": 5.27,
        "resultPreview": "{\"content\":[{\"type\":\"text\",\"text\":\"...",
        "resultSize": 10247
      }
    }
  ],
  "options": ["continue", "replan", "abort"]
}
```

**Future:** Tool `pml_get_task_result` pour récupérer le résultat complet si le preview ne suffit
pas.

### Current vs Future HIL Behavior

**Current (Phase 2):** Per-layer validation + AIL implicite

- Tools avec permissions élevées triggent `per_layer_validation` mode
- Workflow pause APRÈS chaque layer avec `resultPreview`
- Claude review les résultats et décide via appel séparé

**Future (Phase 4):** Per-task HIL

- Tools with `approvalMode: "hil"` trigger pause BEFORE execution
- User explicitly approves each sensitive operation
- Requires architectural changes to handle mid-layer yields
