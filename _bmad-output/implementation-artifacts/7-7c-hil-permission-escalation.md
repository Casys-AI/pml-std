# Story 7.7c: HIL Permission Escalation - Human Approval for Permission Upgrades

> **Epic:** 7 - Emergent Capabilities & Learning System **ADR:** ADR-035 (Permission Sets for
> Sandbox Security) **Prerequisites:** Story 7.7b (Sandbox Permission Integration - DONE, 37 tests
> passing) **Status:** review-ready

## User Story

As a user, I want to approve permission escalations when a capability needs more access, So that
security is maintained while allowing legitimate operations.

## Problem Context

### Current State (After Story 7.7b)

Story 7.7b implemented granular permission enforcement:

- Capabilities execute with their inferred `permission_set` (minimal, readonly, filesystem,
  network-api, mcp-standard)
- Low confidence inferences (< 0.7) fallback to `minimal` for safety
- `--deny-run` and `--deny-ffi` always enforced (security-critical)

**However, there's no recovery path when a capability fails due to insufficient permissions:**

```typescript
// Current behavior (7.7b)
const result = await executor.execute(code, context, "minimal");
if (!result.success && result.error?.message.includes("PermissionDenied")) {
  // Capability fails with no recovery option
  // User must manually update the capability's permission_set
  throw new Error("Permission denied - no escalation mechanism");
}
```

**Problem:** Legitimate capabilities can fail if:

1. Permission inference confidence was low (forced to minimal)
2. Inference missed a pattern (e.g., dynamic URL construction)
3. Capability was updated but permissions weren't re-inferred

### Solution: HIL Permission Escalation

When a capability fails with `PermissionDenied`, the system:

1. Detects the error type (read, write, net, env)
2. Suggests appropriate permission escalation (e.g., minimal -> network-api)
3. Requests human approval via existing HIL mechanism (ControlledExecutor)
4. If approved: updates capability's `permission_set` in DB permanently
5. Retries execution with new permissions

**Flow (from ADR-035):**

```
Execution fails: PermissionDenied
           |
           v
Detect error type (read, write, net, env)
           |
           v
Suggest escalation (minimal -> network-api)
           |
           v
Request HIL approval via ControlledExecutor
           |
           v
    +------+------+
    |             |
 Approved      Rejected
    |             |
    v             v
 UPDATE DB     Return error
 permission    to user
    |
    v
 Retry execution
 with new perms
```

## Acceptance Criteria

### AC1: PermissionEscalationRequest Interface Defined

- [x] Interface `PermissionEscalationRequest` defined in `src/capabilities/types.ts`:
  ```typescript
  interface PermissionEscalationRequest {
    capabilityId: string;
    currentSet: PermissionSet; // "minimal"
    requestedSet: PermissionSet; // "network-api"
    reason: string; // "PermissionDenied: net access to api.example.com"
    detectedOperation: string; // "fetch"
    confidence: number; // 0.85 (how confident we are this is the right escalation)
  }
  ```

### AC2: suggestEscalation() Function Implemented

- [x] Function `suggestEscalation(error: string): PermissionEscalationRequest | null` in
      `src/capabilities/permission-escalation.ts`
- [x] Parses Deno PermissionDenied error messages to determine required permissions:
  | Error Pattern              | Detected Operation | Suggested Set                  |
  | -------------------------- | ------------------ | ------------------------------ |
  | `Requires read access to`  | `read`             | `readonly` -> `filesystem`     |
  | `Requires write access to` | `write`            | `filesystem`                   |
  | `Requires net access to`   | `net`              | `network-api`                  |
  | `Requires env access to`   | `env`              | `mcp-standard`                 |
  | `Requires run access to`   | `run`              | **REJECT** (security-critical) |
  | `Requires ffi access`      | `ffi`              | **REJECT** (security-critical) |
- [x] Returns `null` for run/ffi requests (cannot escalate security-critical permissions)
- [x] Confidence scoring based on error specificity (exact path vs general)

### AC3: Integration with ControlledExecutor.requestHILApproval()

- [x] New HIL request type `permission_escalation_response` added to `src/dag/types.ts`
- [x] `ControlledExecutor` extended to handle permission escalation requests:
  ```typescript
  // In controlled-executor.ts
  async requestPermissionEscalation(
    request: PermissionEscalationRequest
  ): Promise<{ approved: boolean; feedback?: string }> {
    // Emit decision_required event
    // Wait for approval via CommandQueue
    // Return decision
  }
  ```
- [x] Approval flow follows existing HIL pattern (5 minute timeout)

### AC4: Capability Permission Update on Approval

- [x] If approved: `CapabilityStore.updatePermissionSet(capabilityId, newSet)` called
- [x] Permission update persisted permanently in `workflow_pattern` table
- [x] Update includes audit trail (who approved, when, from what to what)

### AC5: Automatic Retry After Approval

- [x] After permission update, capability is automatically retried with new permission set
- [x] Retry uses same execution context (no need to rebuild)
- [x] Maximum 1 escalation retry per execution (prevent infinite loops)

### AC6: PermissionAuditLog Table Created

- [x] Migration 018 creates `permission_audit_log` table:
  ```typescript
  export const permissionAuditLog = sqliteTable("permission_audit_log", {
    id: text("id").primaryKey(),
    timestamp: integer("timestamp", { mode: "timestamp" }).notNull(),
    capabilityId: text("capability_id").notNull(),
    fromSet: text("from_set").notNull(), // "minimal"
    toSet: text("to_set").notNull(), // "network-api"
    approved: integer("approved", { mode: "boolean" }).notNull(),
    approvedBy: text("approved_by"), // user_id or "system"
    reason: text("reason"), // Original error message
    detectedOperation: text("detected_operation"), // "fetch", "read", etc.
  });
  ```
- [x] Index on `capabilityId` for efficient filtering
- [x] Index on `timestamp` for audit queries

### AC7: Audit Logging for All Escalation Decisions

- [x] Every escalation request logged (approved or rejected)
- [x] Log includes: timestamp, capability_id, from_set, to_set, approved, approvedBy, reason
- [x] Queryable via `PermissionAuditStore.getAuditLog(capabilityId?)` method

### AC8: Unit Tests - Error Parsing

- [x] Test: `suggestEscalation("PermissionDenied: Requires read access to /etc/passwd")` ->
      `{ requestedSet: "filesystem", detectedOperation: "read" }`
- [x] Test: `suggestEscalation("PermissionDenied: Requires net access to api.example.com:443")` ->
      `{ requestedSet: "network-api", detectedOperation: "net" }`
- [x] Test: `suggestEscalation("PermissionDenied: Requires write access to /tmp/output.txt")` ->
      `{ requestedSet: "filesystem", detectedOperation: "write" }`
- [x] Test: `suggestEscalation("PermissionDenied: Requires run access to /bin/sh")` -> `null`
      (security-critical)
- [x] Test: `suggestEscalation("PermissionDenied: Requires ffi access")` -> `null`
      (security-critical)
- [x] Test: `suggestEscalation("Some other error")` -> `null` (not a permission error)

### AC9: Integration Tests - Full Escalation Flow

- [x] Test: capability fails with PermissionDenied -> HIL request -> approve -> retry succeeds
- [x] Test: capability fails with PermissionDenied -> HIL request -> reject -> error propagated
- [x] Test: run/ffi permission errors -> no HIL request (auto-rejected)
- [x] Test: audit log contains all decisions (approved and rejected)
- [x] Test: permission update persisted in DB after approval

### AC10: E2E Tests - Real Capability Execution

- [x] Test: ControlledExecutor capability task with permission escalation integration
- [x] Test: Permission escalation setter and getter methods work correctly
- [x] Test: Capability executes successfully when permissions are sufficient

## Tasks / Subtasks

### Task 1: Define Types and Interfaces (AC: #1)

- [x] 1.1 Add `PermissionEscalationRequest` interface to `src/capabilities/types.ts`
- [x] 1.2 Add `PermissionAuditLogEntry` interface to `src/capabilities/types.ts`
- [x] 1.3 Export new types from `src/capabilities/mod.ts`

### Task 2: Create Database Migration (AC: #6)

- [x] 2.1 Create `src/db/migrations/018_permission_audit_log.ts`
- [x] 2.2 Define `permission_audit_log` table schema
- [x] 2.3 Create indexes on `capabilityId` and `timestamp`
- [x] 2.4 Register migration in `src/db/migrations.ts`
- [x] 2.5 Test migration up/down idempotency

### Task 3: Implement suggestEscalation() Function (AC: #2)

- [x] 3.1 Create `src/capabilities/permission-escalation.ts` (~200 LOC)
- [x] 3.2 Implement Deno error message parsing with regex patterns
- [x] 3.3 Implement permission set suggestion logic
- [x] 3.4 Implement confidence scoring based on error specificity
- [x] 3.5 Return `null` for security-critical permissions (run, ffi)

### Task 4: Create PermissionAuditStore (AC: #7)

- [x] 4.1 Create `src/capabilities/permission-audit-store.ts` (~140 LOC)
- [x] 4.2 Implement `logEscalation(entry: PermissionAuditLogEntry)` method
- [x] 4.3 Implement `getAuditLog(capabilityId?: string)` query method
- [x] 4.4 Export from `src/capabilities/mod.ts`

### Task 5: Extend ControlledExecutor for Permission Escalation (AC: #3, #4, #5)

- [x] 5.1 Add `permission_escalation_response` to command types in `src/dag/types.ts`
- [x] 5.2 Add `requestPermissionEscalation()` method to `ControlledExecutor`
- [x] 5.3 Implement HIL request emission with escalation details
- [x] 5.4 Implement approval handling with DB update (via PermissionEscalationHandler)
- [x] 5.5 Implement automatic retry logic after approval in `executeCapabilityTask()`
- [x] 5.6 Add escalation attempt tracking (max 1 per execution)

### Task 6: Integrate with CapabilityStore (AC: #4)

- [x] 6.1 Add `updatePermissionSet(capabilityId, newSet)` method to `CapabilityStore`
- [x] 6.2 Update method includes timestamp and audit trail
- [x] 6.3 Method validates permission set transition is valid (via isValidEscalation())

### Task 7: Write Unit Tests (AC: #8)

- [x] 7.1 Create `tests/unit/capabilities/permission_escalation_test.ts` (28 tests)
- [x] 7.2 Test error parsing for all permission types (read, write, net, env)
- [x] 7.3 Test rejection for security-critical permissions (run, ffi)
- [x] 7.4 Test confidence scoring logic
- [x] 7.5 Test invalid/unknown error messages return null

### Task 8: Write Integration Tests (AC: #9)

- [x] 8.1 Create `tests/integration/capabilities/permission_escalation_integration_test.ts` (12
      tests)
- [x] 8.2 Test full escalation flow with mocked HIL approval
- [x] 8.3 Test rejection flow with mocked HIL rejection
- [x] 8.4 Test audit log persistence
- [x] 8.5 Test CapabilityStore.updatePermissionSet() DB persistence

### Task 9: Write E2E Tests (AC: #10)

- [x] 9.1 Create `tests/e2e/permission_escalation_e2e_test.ts` (8 tests)
- [x] 9.2 Test real capability execution with escalation (mocked approval)
- [x] 9.3 Test ControlledExecutor integration with permission escalation

### Task 10: Documentation and Exports (AC: all)

- [x] 10.1 Add JSDoc comments to all new public methods
- [x] 10.2 Update `src/capabilities/mod.ts` with new exports
- [x] 10.3 Update this story file with completion notes

## Dev Notes

### Critical Implementation Details

1. **Error Message Parsing:** Deno permission errors follow a consistent format:
   ```
   PermissionDenied: Requires {permission} access to {resource}, run again with --allow-{permission}
   ```
   Use regex to extract permission type and resource.

2. **Security-Critical Permissions:** NEVER allow escalation to permissions that could escape
   sandbox:
   - `run` - Could spawn arbitrary processes
   - `ffi` - Could call native code These are hardcoded rejections, no HIL override possible.

3. **Escalation Path Logic:**
   ```
   minimal -> readonly (read-only file access)
   minimal -> network-api (network access)
   minimal -> filesystem (read + limited write)
   readonly -> filesystem (add write capability)
   filesystem -> mcp-standard (add network)
   network-api -> mcp-standard (add filesystem)
   * -> trusted (only via manual override, not escalation)
   ```

4. **Integration with Existing HIL:** The `ControlledExecutor` already has HIL infrastructure:
   - `waitForDecisionCommand(type, timeout)` - waits for human response
   - `captureHILDecision()` - episodic memory capture
   - `CommandQueue` - for receiving approval commands

   Permission escalation should use the same patterns.

5. **Retry Safety:** Only 1 escalation retry per execution to prevent:
   - Infinite escalation loops
   - Accidental privilege accumulation
   - Resource exhaustion

### Error Parsing Regex Patterns

```typescript
const PERMISSION_PATTERNS = {
  read: /Requires read access to ([^\s,]+)/,
  write: /Requires write access to ([^\s,]+)/,
  net: /Requires net access to ([^\s,]+)/,
  env: /Requires env access to "?([^"]+)"?/,
  run: /Requires run access to ([^\s,]+)/,
  ffi: /Requires ffi access/,
};
```

### File Structure

```
src/capabilities/
├── permission-escalation.ts  # NEW: suggestEscalation() + escalation logic (~120 LOC)
├── permission-audit-store.ts # NEW: Audit log persistence (~80 LOC)
├── permission-inferrer.ts    # EXISTING: No changes
├── capability-store.ts       # MODIFY: Add updatePermissionSet() (~20 LOC)
├── types.ts                  # MODIFY: Add escalation interfaces (~25 LOC)
└── mod.ts                    # MODIFY: Export new classes/types

src/dag/
├── controlled-executor.ts    # MODIFY: Add requestPermissionEscalation() (~60 LOC)
└── types.ts                  # MODIFY: Add permission_escalation HIL type (~5 LOC)

src/db/migrations/
└── 018_permission_audit_log.ts # NEW: Audit log table (~40 LOC)

tests/unit/capabilities/
└── permission_escalation_test.ts # NEW: Unit tests (~200 LOC)

tests/integration/
└── permission_escalation_test.ts # NEW: Integration tests (~250 LOC)
```

### HIL Request Format

```typescript
// Emitted event for human approval
const escalationEvent: ExecutionEvent = {
  type: "decision_required",
  timestamp: Date.now(),
  workflowId: workflowId,
  decisionType: "HIL",
  description: `
=== Permission Escalation Request ===

Capability: ${request.capabilityId}
Current Permission Set: ${request.currentSet}
Requested Permission Set: ${request.requestedSet}

Reason: ${request.reason}
Detected Operation: ${request.detectedOperation}
Confidence: ${(request.confidence * 100).toFixed(0)}%

This capability attempted an operation that requires additional permissions.
Approving will permanently upgrade the capability's permission set.

[A]pprove permission escalation
[R]eject and abort execution
  `.trim(),
};
```

### Performance Expectations

- Error parsing: <1ms
- HIL request emission: <5ms (async)
- DB update after approval: <10ms
- Total overhead for escalation flow: <50ms (excluding human wait time)

### Dependencies

- Existing `ControlledExecutor` HIL infrastructure
- Existing `CapabilityStore` for permission updates
- No new external dependencies

### Related Files from Story 7.7b

- `src/sandbox/executor.ts` - Permission set enforcement (where PermissionDenied errors originate)
- `src/capabilities/types.ts` - `PermissionSet` type definition
- `tests/integration/permission_enforcement_test.ts` - Test patterns for permission errors

## References

- [ADR-035: Permission Sets for Sandbox Security](../adrs/ADR-035-permission-sets-sandbox-security.md)
- [Story 7.7a: Permission Inference](./7-7a-permission-inference-automatic-analysis.md) - Permission
  inference
- [Story 7.7b: Sandbox Permission Integration](./7-7b-sandbox-permission-integration.md) -
  Permission enforcement
- [Story 2.5-3: AIL/HIL Integration](./2.5-3-ail-hil-integration-dag-replanning.md) - HIL pattern
  reference
- [ControlledExecutor](../../src/dag/controlled-executor.ts) - HIL implementation
- [Deno Permissions Documentation](https://docs.deno.com/runtime/fundamentals/permissions/)

## Estimation

- **Effort:** 1-1.5 days
- **LOC:** ~120 (permission-escalation.ts) + ~80 (audit-store.ts) + ~40 (migration) + ~60
  (controlled-executor changes) + ~450 (tests) = ~750 total
- **Risk:** Low (leverages existing HIL infrastructure from Story 2.5-3)

---

## Dev Agent Record

### Context Reference

- `src/dag/controlled-executor.ts:496-531` - Existing `captureHILDecision()` method
- `src/dag/controlled-executor.ts:725-746` - Existing `waitForDecisionCommand()` method
- `src/dag/controlled-executor.ts:1253-1327` - Existing HIL approval checkpoint flow
- `src/capabilities/capability-store.ts:102-150` - saveCapability() pattern for DB updates
- `src/capabilities/types.ts:39-50` - PermissionSet type definition
- `src/sandbox/executor.ts:170-230` - permissionSetToFlags() for error context
- `tests/integration/permission_enforcement_test.ts` - E2E test patterns

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

<!-- Will be populated during implementation -->

### Completion Notes List

**Implementation Summary (2024-12-16):**

1. **Core Implementation:**
   - `suggestEscalation()` parses Deno PermissionDenied errors with regex and suggests appropriate
     permission set escalations
   - `PermissionEscalationHandler` orchestrates the full escalation flow: detect → suggest → HIL
     request → approve/reject → update DB
   - `PermissionAuditStore` provides persistent audit logging with filtering capabilities
   - Security-critical permissions (`run`, `ffi`) are blocked at the suggestion level - no HIL
     override possible

2. **ControlledExecutor Integration:**
   - Added `setPermissionEscalationDependencies(auditStore)` method to configure the handler
   - Added `requestPermissionEscalation(request)` method that follows existing HIL pattern
   - Modified `executeCapabilityTask()` to catch PermissionDenied errors and trigger escalation flow
   - After approval, capability is automatically retried with updated permissions

3. **Test Coverage:**
   - 28 unit tests covering error parsing, security-critical blocking, escalation paths, confidence
     scoring
   - 12 integration tests covering full escalation flow, rejection flow, audit log persistence
   - 8 E2E tests covering ControlledExecutor integration, capability execution with permissions

4. **Code Review Fixes Applied:**
   - Fixed userId hardcoding: Handler now accepts userId in constructor and passes to audit log
   - Added comprehensive JSDoc to `formatEscalationRequest()`
   - Added `getPermissionAuditStore()` getter to ControlledExecutor

**Total Test Count:** 48 tests (28 unit + 12 integration + 8 E2E)

### File List

- [x] `src/capabilities/permission-escalation.ts` - NEW (~200 LOC)
- [x] `src/capabilities/permission-escalation-handler.ts` - NEW (~350 LOC) - Orchestrates escalation
      flow
- [x] `src/capabilities/permission-audit-store.ts` - NEW (~140 LOC)
- [x] `src/capabilities/types.ts` - MODIFIED (add PermissionEscalationRequest,
      PermissionAuditLogEntry interfaces)
- [x] `src/capabilities/capability-store.ts` - MODIFIED (add updatePermissionSet, isValidEscalation)
- [x] `src/capabilities/mod.ts` - MODIFIED (exports)
- [x] `src/dag/controlled-executor.ts` - MODIFIED (~120 LOC added: requestPermissionEscalation,
      setPermissionEscalationDependencies, executeCapabilityTask error handling)
- [x] `src/dag/types.ts` - MODIFIED (add permission_escalation_response command type)
- [x] `src/db/migrations/018_permission_audit_log.ts` - NEW (~60 LOC)
- [x] `src/db/migrations.ts` - MODIFIED (register migration)
- [x] `tests/unit/capabilities/permission_escalation_test.ts` - NEW (28 tests, ~230 LOC)
- [x] `tests/integration/capabilities/permission_escalation_integration_test.ts` - NEW (12 tests,
      ~540 LOC)
- [x] `tests/e2e/permission_escalation_e2e_test.ts` - NEW (8 tests, ~420 LOC)
- [x] `src/graphrag/types.ts` - MODIFIED (add permissionSet to Task.sandboxConfig) - 2025-12-16

## Change Log

| Date       | Change                                                    | Author          |
| ---------- | --------------------------------------------------------- | --------------- |
| 2024-12-16 | Initial implementation - 48 tests passing                 | Claude          |
| 2025-12-16 | Extended HIL escalation to `code_execution` tasks in DAGs | Claude Opus 4.5 |

---

## Extension: code_execution Task Support (2025-12-16)

### Problem

The original 7.7c implementation only supported permission escalation for **capability** tasks
(tasks with `capabilityId`). When `code_execution` tasks in DAGs failed with `PermissionDenied`
errors, they would fail without any HIL escalation opportunity.

**Gap identified:**

- `code_execution` tasks don't have `capabilityId`
- The existing HIL check required `task.capabilityId` to trigger escalation
- Result: `fetch()` in code execution tasks would fail silently with no recovery path

### Solution

Extended `executeCodeTask()` in `controlled-executor.ts` to:

1. **Accept `permissionSet` parameter**: Either from `task.sandboxConfig.permissionSet`, explicit
   parameter, or default to "minimal"
2. **Pass `permissionSet` to `executor.execute()`**: Sandbox now respects permission configuration
3. **Detect permission errors**: Catch `PermissionError`, `PermissionDenied`, `NotCapable` in error
   messages
4. **Trigger HIL escalation**: Use existing `suggestEscalation()` to parse error and
   `waitForDecisionCommand()` for approval
5. **Retry on approval**: If approved, recursively call `executeCodeTask()` with the escalated
   permission set

### Key Differences from Capability Escalation

| Aspect         | Capability Tasks                                | Code Execution Tasks                   |
| -------------- | ----------------------------------------------- | -------------------------------------- |
| ID used        | `task.capabilityId`                             | `task.id` (placeholder)                |
| DB persistence | Yes - updates `workflow_pattern.permission_set` | No - ephemeral for this execution only |
| Audit log      | Yes - via `PermissionAuditStore`                | No - only logged, not persisted        |
| Retry          | Uses same capability                            | Passes new permissionSet parameter     |

### Type Changes

Added `permissionSet` to `Task.sandboxConfig` in `src/graphrag/types.ts`:

```typescript
sandboxConfig?: {
  timeout?: number;
  memoryLimit?: number;
  allowedReadPaths?: string[];
  /** Permission set for sandbox execution (Story 7.7c). Default: "minimal" */
  permissionSet?: PermissionSet;
};
```

### Usage Example

```typescript
// DAG with code_execution task that needs network access
const dag = {
  tasks: [{
    id: "fetch_data",
    type: "code_execution",
    code: `
      const response = await fetch('https://api.example.com/data');
      return await response.json();
    `,
    dependsOn: [],
    sandboxConfig: {
      permissionSet: "network-api", // Pre-configure, or let HIL escalate
    },
  }],
};
```

### Flow Diagram

```
code_execution task starts
         |
         v
executor.execute(code, context, "minimal")
         |
         v
    PermissionDenied?
    /           \
   No            Yes
   |              |
   v              v
 Success    suggestEscalation(error)
   |              |
   v              v
 Return      Suggestion found?
             /           \
            No            Yes
            |              |
            v              v
          Throw     Emit decision_required
                          |
                          v
                   waitForDecisionCommand()
                          |
                    Approved?
                   /         \
                  No          Yes
                  |            |
                  v            v
               Throw    Retry with new permissionSet
```
