# Tech Spec: Failing Tests Inventory

**Status:** 📋 INVENTORY **Date:** 2024-12-16 **Priority:** P2 - Technical Debt

---

## Summary

This document tracks all known failing or blocked tests identified during the integration test
audit. Each issue has a root cause and recommended fix.

---

## 1. BUG-HIL-DEADLOCK (BLOCKED - 3 tests)

**File:** `tests/integration/dag/hil_workflow_e2e_test.ts`

**Tests:**

- E2E HIL Workflow: Human approves continuation
- E2E HIL Workflow: Human rejects and workflow aborts
- E2E HIL Workflow: Never mode skips all approvals

**Status:** `ignore: true`

**Root Cause:** Architectural deadlock - the async generator `executeStream()` cannot `yield` while
`Promise.allSettled()` is waiting. The `decision_required` event never reaches the client.

**Fix:** Implement "Deferred Escalation Pattern" from
`docs/tech-specs/tech-spec-hil-permission-escalation-fix.md`

---

## 2. BUG-AIL-ABORT (BLOCKED - 2 tests)

**File:** `tests/integration/dag/ail_workflow_e2e_test.ts`

**Tests:**

- E2E AIL Workflow: Agent discovers XML files and triggers replanning
- E2E AIL Workflow: Agent abort command stops execution

**Status:** `ignore: true`

**Root Cause:** Related to BUG-HIL-DEADLOCK. Same architectural issue with abort handling in the
generator.

**Fix:** Same as HIL - implement Deferred Escalation Pattern.

---

## 3. JSONRPC Handler Failures (FAILING - 3 tests)

**File:** `tests/integration/mcp-gateway/06-jsonrpc.test.ts`

**Tests:**

- JSONRPC-007: User context propagation
- JSONRPC-009: Missing required parameters
- JSONRPC-012: Tool execution failure returns proper error

**Status:** Tests run but fail assertions

**Root Cause:** Error response format mismatch. Tests expect `error.message` but handler returns
`undefined`. The error handling in the JSON-RPC handler doesn't properly propagate error details.

**Fix:**

1. Review `src/mcp/handlers/` error handling
2. Ensure JSON-RPC errors follow spec: `{code, message, data}`
3. Check `assertExists(result.error.message)` expectations

---

## 4. BroadcastChannel Leak (FAILING - 1 test)

**File:** `tests/unit/graphrag/graph_engine_metrics_test.ts:213`

**Test:**

- GraphRAGEngine.getTotalCommunities - returns 0 for empty graph

**Status:** Test passes but fails sanitizer

**Root Cause:** BroadcastChannel not properly closed between tests. Deno's resource sanitizer
detects async operations that started before the test but completed during it.

**Fix:**

1. Add `afterEach` hook to close BroadcastChannel
2. Or use `sanitizeResources: false` with proper manual cleanup
3. Check `GraphRAGEngine` for BroadcastChannel usage in event emitter

---

## 5. Checkpoint Save Failure (FAILING - 1 test)

**File:** `tests/integration/dag/checkpoint_integration_test.ts:116`

**Test:**

- Checkpoint Integration - checkpoint save failure does not stop execution

**Status:** Test fails assertion

**Root Cause:** Test expects execution to continue when checkpoint save fails, but the behavior may
have changed. Need to verify expected behavior.

**Fix:**

1. Review `ControlledExecutor.setCheckpointManager()` error handling
2. Determine if checkpoint failures should be fatal or non-fatal
3. Update test or code to match intended behavior

---

## 6. Permission Escalation Handler (FAILING - 1 test)

**File:** `tests/integration/capabilities/permission_escalation_integration_test.ts`

**Test:**

- PermissionEscalationHandler - returns not handled for security-critical

**Status:** Test fails with DB error

**Error:** `Failed to update permission set in DB`

**Root Cause:** Test database setup issue or missing migration. The permission_audit_log table may
not be properly initialized.

**Fix:**

1. Verify migration 018 (permission_audit_log) runs in test setup
2. Check `setupTestDb()` includes all required migrations
3. Review DB mock/stub configuration

---

## Priority Order for Fixes

| Priority | Bug                   | Impact                           | Effort               |
| -------- | --------------------- | -------------------------------- | -------------------- |
| **P1**   | HIL/AIL Deadlock      | Blocks human approval workflows  | High (architectural) |
| **P2**   | JSONRPC Handlers      | API error handling broken        | Medium               |
| **P2**   | Permission Escalation | Security feature testing blocked | Low                  |
| **P3**   | Checkpoint Failure    | Edge case handling               | Low                  |
| **P3**   | BroadcastChannel Leak | Test hygiene only                | Low                  |

---

## Quick Wins (< 1 hour each)

1. Fix BroadcastChannel leak - add cleanup hook
2. Fix Permission Escalation - verify test DB setup
3. Fix Checkpoint test - clarify expected behavior

## Requires Tech Spec Implementation

1. HIL/AIL Deadlock → `tech-spec-hil-permission-escalation-fix.md`
2. JSONRPC errors → May need error handling review doc
