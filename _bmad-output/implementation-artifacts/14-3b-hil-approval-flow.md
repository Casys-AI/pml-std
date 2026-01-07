# Story 14.3b: HIL Approval Flow for Stdio Mode

Status: done

> **Epic:** 14 - JSR Package Local/Cloud MCP Routing
> **Extends:** Story 14.3 (Permission Inference)
> **Fixes:** Story 14.4 (HIL callback blocks stdio)
> **Prerequisites:** Story 14.3 (DONE), Story 14.4 (DONE)
> **Estimated Effort:** 0.5 day
> **LOC:** ~120 net

## Story

As a developer using PML via Claude Code, I want dependency installation approval to work via MCP response/callback pattern, So that I don't block the JSON-RPC protocol.

## Problem Context

### Current Broken Implementation

Story 14.4 uses a blocking callback:

```typescript
// capability-loader.ts:211-215 - BROKEN
const approved = await this.hilCallback(prompt, dep);
// ↑ Tries to read stdin, but stdin = JSON-RPC!
```

**Result:** Process hangs, Claude never sees approval request.

### Correct Pattern (From Main Codebase)

The main PML codebase already has this pattern in `src/mcp/server/responses.ts`:

```typescript
// formatApprovalRequired() returns:
{
  status: "approval_required",
  workflow_id: "...",
  options: ["continue", "abort", "replan"],
  ...context
}
```

And handlers in `src/mcp/handlers/control-commands-handler.ts`:
- `handleContinue()` - Resume workflow
- `handleApprovalResponse()` - Process approval

We reuse this pattern.

## Architecture: Stateless Approval

**Key insight:** No workflow state storage needed!

```
1. Claude calls `serena:analyze`
2. PML fetches capability metadata → sees mcpDeps
3. Check permission → "ask", not installed
4. Return approval_required with options

5. Claude recalls `serena:analyze` + continue_workflow: { approved: true }
6. PML fetches same metadata → same deps
7. Sees approved: true → install → execute
```

The capability metadata contains all needed info. Claude's context remembers the tool being called.

## Acceptance Criteria

### AC1: Approval Required Response

**Given** a tool call with uninstalled dependencies
**And** permission is "ask" (implicit default or explicit)
**When** PML processes the request
**Then** returns MCP response:
```json
{
  "status": "approval_required",
  "workflow_id": "uuid",
  "description": "Install serena@0.5.0 to execute serena:analyze",
  "options": ["continue", "abort", "replan"]
}
```

### AC2: Continue Workflow

**Given** Claude receives `approval_required`
**When** Claude calls back with `continue_workflow: { approved: true }`
**Then** PML installs dependency and executes tool

### AC3: Auto-Approve for Allowed Tools

**Given** tool is in `permissions.allow`
**When** it needs dependencies
**Then** installs silently, no approval_required

### AC4: Abort

**Given** Claude calls with `continue_workflow: { approved: false }`
**Then** returns error, no installation

## Tasks

### Task 1: Modify capability-loader.ts (~30m) ✅

- [x] Remove `hilCallback` parameter from `CapabilityLoaderOptions`
- [x] Add `permissions: PmlPermissions` parameter
- [x] Add `ContinueWorkflowParams` type in types.ts
- [x] Add `ApprovalRequiredResult` and `CapabilityLoadResult` types
- [x] Modify `ensureDependency()` to check permissions:
  - "allowed" → auto-install
  - "denied" → throw error
  - "ask" → return `ApprovalRequiredResult`
- [x] Modify `load()` to accept `continueWorkflow` parameter
- [x] Add static `isApprovalRequired()` helper method
- [x] Update `mod.ts` exports

**Files:**
- `packages/pml/src/loader/capability-loader.ts`
- `packages/pml/src/loader/types.ts`
- `packages/pml/src/loader/mod.ts`

### Task 2: Handle in stdio-command.ts (~45m) ✅

- [x] Add `formatApprovalRequired()` function following main codebase pattern
- [x] Add `extractContinueWorkflow()` to parse callback from args
- [x] Modify `handleToolsCall()` to:
  - Extract `continue_workflow` from args
  - Pass `continueWorkflow` to `loader.call()`
  - Check result with `CapabilityLoader.isApprovalRequired()`
  - Return MCP approval_required response if needed
- [x] Load permissions from `loadUserPermissions()` and pass to loader
- [x] Update `serve-command.ts` to use `permissions` instead of `hilCallback`

**Files:**
- `packages/pml/src/cli/stdio-command.ts`
- `packages/pml/src/cli/serve-command.ts`

### Task 3: Tests (~30m) ✅

- [x] Test: returns `ApprovalRequiredResult` for deps with ask permission
- [x] Test: auto-installs deps in allow list (no approval needed)
- [x] Test: denies deps in deny list (throws error)
- [x] Test: `continue_workflow` approved triggers install
- [x] Test: `continue_workflow` denied throws error
- [x] Test: `isApprovalRequired()` correctly identifies result types

**Files:**
- `packages/pml/tests/capability_loader_test.ts` (6 new tests added)

## Dev Notes

### Key Difference from Main Codebase

Main codebase stores workflow state in `activeWorkflows` Map because DAG execution is complex (layers, checkpoints, etc.).

PML package is simpler: capability metadata contains everything. When Claude calls back, we just re-parse the capability → same deps → install → execute.

### Permission Check Logic

```
1. Check deny list → match? → error
2. Check allow list → match? → auto-install
3. Default (no match) → "ask" → approval_required
```

No need for explicit `ask: ["*"]` in config. Implicit default is "ask".

### Files to Modify

| File | Change |
|------|--------|
| `packages/pml/src/loader/capability-loader.ts` | Return approval status, remove hilCallback |
| `packages/pml/src/loader/types.ts` | Add `LoadResult` with approvalRequired |
| `packages/pml/src/cli/stdio-command.ts` | Handle approval_required and continue_workflow |

### What NOT to Do

- ❌ Don't create `workflow-state.ts` - stateless!
- ❌ Don't store pending workflows in Map
- ❌ Don't add TTL/cleanup logic
- ❌ Don't use stdin for prompts

## Estimation

- **Effort:** 0.5 day
- **LOC:** ~120 net
  - capability-loader.ts: ~30 lines changed
  - stdio-command.ts: ~50 lines added
  - types.ts: ~20 lines
  - tests: ~20 lines
- **Risk:** Low - follows existing pattern

## Dependencies

- Story 14.3 (DONE): `checkPermission()`
- Story 14.4 (DONE): CapabilityLoader, DepInstaller

## References

- [Source: src/mcp/server/responses.ts:132-150] `formatApprovalRequired()`
- [Source: src/mcp/handlers/control-commands-handler.ts:80-155] `handleContinue()`
- [Source: packages/pml/src/loader/capability-loader.ts:188-236] Current blocking HIL

---

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Change Log

| Date | Change |
|------|--------|
| 2026-01-06 | Story created from code review |
| 2026-01-06 | Simplified to stateless architecture |
| 2026-01-06 | ✅ Implementation complete - 199 tests passing |
| 2026-01-06 | ✅ Code review passed - 3 issues fixed (H1, M3, H1b) |

## Implementation Summary

**Completed:** 2026-01-06

### Files Modified

| File | Changes |
|------|---------|
| `packages/pml/src/loader/types.ts` | Added `ApprovalRequiredResult`, `LoadSuccessResult`, `CapabilityLoadResult`, `ContinueWorkflowParams` types |
| `packages/pml/src/loader/capability-loader.ts` | Replaced `hilCallback` with `permissions`-based approval. Added `isApprovalRequired()` static method |
| `packages/pml/src/loader/mod.ts` | Exported new types, removed `HilCallback` |
| `packages/pml/src/loader/dep-state.ts` | [Review fix] Lazy env access to avoid top-level `Deno.env.get()` |
| `packages/pml/src/cli/stdio-command.ts` | Added `formatApprovalRequired()`, `extractContinueWorkflow()`, handles MCP approval flow |
| `packages/pml/src/cli/serve-command.ts` | Updated to use `permissions` parameter instead of `hilCallback` |
| `packages/pml/src/types.ts` | [Review fix] Removed obsolete `HilCallback` export, added new 14.3b types |
| `packages/pml/tests/capability_loader_test.ts` | Added 6 new tests for approval flow |

### Test Results

- **Total tests:** 199 passing
- **New tests:** 6 (approval flow)
- **Coverage:** Full approval flow coverage

### Architecture Notes

The implementation follows a **stateless** pattern:
1. First call → returns `approval_required` if dependency needs user approval
2. Claude shows approval to user, user approves
3. Second call with `continue_workflow: { approved: true }` → installs and executes

No workflow state is stored server-side - the capability metadata contains all needed context.
