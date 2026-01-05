# Story 7.7b: Sandbox Permission Integration - Execute with Granular Permissions

> **Epic:** 7 - Emergent Capabilities & Learning System **ADR:** ADR-035 (Permission Sets for
> Sandbox Security) **Prerequisites:** Story 7.7a (Permission Inference - DONE, 25 tests passing)
> **Status:** Done

## User Story

As a sandbox executor, I want to run capabilities with their inferred permission set, So that each
capability has only the minimum permissions required (principle of least privilege).

## Problem Context

### Current State (After Story 7.7a)

Story 7.7a implemented the permission inference system:

- `PermissionInferrer` class analyzes code via SWC AST parsing
- `permission_set` and `permission_confidence` columns added to `workflow_pattern` table
- Capabilities are tagged with inferred permissions on save (`minimal`, `readonly`, `filesystem`,
  `network-api`, `mcp-standard`)

**However, the sandbox executor still ignores these permissions:**

```typescript
// src/sandbox/executor.ts (current - lines 485-525)
private buildCommand(code: string): { command: Deno.Command; tempFilePath: string } {
  // ...
  args.push(`--allow-read=${tempFile}`);
  args.push("--deny-write");  // HARDCODED
  args.push("--deny-net");    // HARDCODED - ignores permission_set
  args.push("--deny-run");
  args.push("--deny-ffi");
  args.push("--deny-env");    // HARDCODED
  // ...
}
```

**Problem:** A capability tagged `permission_set = "network-api"` will still fail with
`PermissionDenied` when calling `fetch()`.

### Solution: Permission Set Integration

This story modifies `DenoSandboxExecutor` to use the stored `permission_set` when executing
capabilities.

**Architecture (from ADR-035):**

```
┌─────────────────────────────────────────────────────────────────┐
│  Capability Execution Flow                                       │
│                                                                  │
│  1. Load capability from DB (includes permission_set)            │
│  2. Determine final permissions:                                 │
│     - source="manual" → use stored permission_set                │
│     - confidence < 0.7 → use "minimal" (safety)                  │
│     - else → use inferred permission_set                         │
│  3. Execute with determined permissions                          │
└─────────────────────────────────────────────────────────────────┘
```

## Acceptance Criteria

### AC1: Permission Set Parameter in execute()

- [x] `DenoSandboxExecutor.execute()` accepts optional parameter `permissionSet?: PermissionSet`
- [x] `DenoSandboxExecutor.executeWithTools()` accepts optional parameter
      `permissionSet?: PermissionSet`
- [x] Default value: `"minimal"` (most restrictive, backward compatible)
- [x] Type uses `PermissionSet` from `src/capabilities/types.ts`

### AC2: Permission Sets in deno.json

- [x] Add `_sandboxPermissions` section to `deno.json` with all 6 profiles (using underscore prefix
      as documentation)
- [x] Note: `deno.json` permission sets are Deno 2.5+ feature - using flags fallback for all
      versions

### AC3: Deno 2.5+ Permission Set Support

- [x] Method `supportsPermissionSets(): boolean` added to check Deno version >= 2.5
- [x] Note: Deno 2.5 `--permission-set` flag not yet available - using explicit flags fallback
- [x] Test that version detection works correctly (3 tests)

### AC4: Fallback for Deno < 2.5 (Explicit Flags)

- [x] Method `permissionSetToFlags(set: PermissionSet): string[]` implemented
- [x] Maps each permission set to equivalent explicit flags:
  | Set            | Flags                                                                                     |
  | -------------- | ----------------------------------------------------------------------------------------- |
  | `minimal`      | `[]` (deny all)                                                                           |
  | `readonly`     | `["--allow-read=./data,/tmp"]`                                                            |
  | `filesystem`   | `["--allow-read", "--allow-write=/tmp"]`                                                  |
  | `network-api`  | `["--allow-net"]`                                                                         |
  | `mcp-standard` | `["--allow-read", "--allow-write=/tmp,./output", "--allow-net", "--allow-env=HOME,PATH"]` |
  | `trusted`      | `["--allow-all"]`                                                                         |
- [x] Fallback used for all versions (primary implementation)

### AC5: --no-prompt Always Added

- [x] `--no-prompt` flag always included (prevent subprocess hangs)
- [x] Applies regardless of permission set or Deno version

### AC6: buildCommand() Updated

- [x] `buildCommand(code, permissionSet)` signature updated to accept permission set
- [x] Remove hardcoded deny flags when permission set allows access
- [x] Permission set applied to both `execute()` and `executeWithTools()`
- [x] Always deny `--deny-run` and `--deny-ffi` for security (even with trusted)

### AC7: WorkerBridge Permission Support

- [x] `executeWithTools()` accepts permission set parameter (informational in Worker mode)
- [x] Note: Worker mode uses `permissions: "none"` by default - permission set affects subprocess
      mode only
- [x] Log warning if permission set != "minimal" used with Worker mode (Worker is always sandboxed)

### AC8: Confidence Threshold Check

- [x] When executing a capability, check `permissionConfidence`:
  - If `confidence < 0.7` AND `source = "emergent"` → fallback to `"minimal"`
  - If `source = "manual"` → always use stored permission set
- [x] Log when fallback is applied: `"Low confidence permission inference, using minimal"`
- [x] Exported `determinePermissionSet()` function and `PERMISSION_CONFIDENCE_THRESHOLD` constant

### AC9: Unit Tests - Permission Set to Flags

- [x] Test: `permissionSetToFlags("minimal")` → `[]`
- [x] Test: `permissionSetToFlags("readonly")` → `["--allow-read=./data,/tmp"]`
- [x] Test: `permissionSetToFlags("filesystem")` → `["--allow-read", "--allow-write=/tmp"]`
- [x] Test: `permissionSetToFlags("network-api")` → `["--allow-net"]`
- [x] Test: `permissionSetToFlags("mcp-standard")` → includes read, write, net, limited env
- [x] Test: `permissionSetToFlags("trusted")` → `["--allow-all"]`
- [x] Test: unknown permission set returns empty (fallback to minimal)

### AC10: E2E Tests - Permission Enforcement

- [x] Test: capability with `permission_set = "minimal"` → `PermissionDenied` if attempts fetch
- [x] Test: capability with `permission_set = "network-api"` → fetch succeeds
- [x] Test: capability with `permission_set = "readonly"` → read succeeds, write fails
- [x] Test: capability with `permission_set = "filesystem"` → read/write to /tmp succeeds
- [x] Test: fallback behavior when `confidence < 0.7`
- [x] Test: --deny-run and --deny-ffi always applied (even with trusted)
- [x] Test: sequential executions with different permission sets

### AC11: Deno Version Fallback Test

- [x] Test: `supportsPermissionSets()` returns correct result for current Deno version
- [x] Test: result is cached for performance
- [x] Test: version detection matches Deno.version parsing

## Tasks / Subtasks

### Task 1: Add Permission Set Parameter to Executor (AC: #1, #6) ✅

- [x] 1.1 Import `PermissionSet` type from `src/capabilities/types.ts`
- [x] 1.2 Add optional `permissionSet?: PermissionSet` parameter to `execute()` signature
- [x] 1.3 Add optional `permissionSet?: PermissionSet` parameter to `executeWithTools()` signature
- [x] 1.4 Update `buildCommand()` to accept and use permission set
- [x] 1.5 Set default value `"minimal"` for backward compatibility

### Task 2: Implement Permission Set to Flags Mapping (AC: #4) ✅

- [x] 2.1 Create `permissionSetToFlags(set: PermissionSet): string[]` method (public for testing)
- [x] 2.2 Implement mapping for each permission set (as specified)
- [x] 2.3 Handle unknown permission sets (fallback to minimal with warning)

### Task 3: Implement Version Detection (AC: #3, #11) ✅

- [x] 3.1 Create `supportsPermissionSets(): boolean` method (public for testing)
- [x] 3.2 Parse `Deno.version.deno` to extract major.minor version
- [x] 3.3 Return `true` if version >= 2.5, `false` otherwise
- [x] 3.4 Cache result to avoid repeated parsing

### Task 4: Update buildCommand() (AC: #5, #6) ✅

- [x] 4.1 Update signature: `buildCommand(code: string, permissionSet: PermissionSet = "minimal")`
- [x] 4.2 Using explicit flags fallback (Deno 2.5 --permission-set not yet available)
- [x] 4.3 Always add `--no-prompt`
- [x] 4.4 Remove hardcoded deny flags, controlled by permission set (except --deny-run and
      --deny-ffi)
- [x] 4.5 Keep `--allow-read=${tempFile}` for the temp code file (always needed)
- [x] 4.6 Keep `--v8-flags=--max-old-space-size=${memoryLimit}` (independent of permissions)

### Task 5: Add Confidence Threshold Check (AC: #8) ✅

- [x] 5.1 Create helper function `determinePermissionSet(capability): PermissionSet`
- [x] 5.2 Implement logic as specified
- [x] 5.3 Export function and `PERMISSION_CONFIDENCE_THRESHOLD = 0.7` constant from
      `src/sandbox/mod.ts`

### Task 6: WorkerBridge Permission Logging (AC: #7) ✅

- [x] 6.1 Add `permissionSet?: PermissionSet` parameter to `executeWithTools()` (Worker mode)
- [x] 6.2 Log warning if permission set != "minimal" used with Worker mode
- [x] 6.3 Note: Worker mode inherently uses `permissions: "none"` - warning is informational only

### Task 7: Write Unit Tests (AC: #9) ✅

- [x] 7.1 Create `tests/unit/sandbox/permission_integration_test.ts`
- [x] 7.2 Test `permissionSetToFlags()` for all 6 permission sets (7 tests)
- [x] 7.3 Test `supportsPermissionSets()` version detection (3 tests)
- [x] 7.4 Test `determinePermissionSet()` confidence threshold logic (8 tests)
- [x] 7.5 Test execute() with permission set parameter (6 tests)
- **24 unit tests passing**

### Task 8: Write E2E Tests (AC: #10) ✅

- [x] 8.1 Create `tests/integration/permission_enforcement_test.ts`
- [x] 8.2 Test minimal permission blocks fetch
- [x] 8.3 Test network-api permission allows fetch
- [x] 8.4 Test readonly permission blocks write
- [x] 8.5 Test filesystem permission allows /tmp write
- [x] 8.6 Test mcp-standard full permissions
- [x] 8.7 Test trusted permission allows all (except run/ffi)
- [x] 8.8 Test confidence threshold fallback
- [x] 8.9 Test --deny-run and --deny-ffi always applied
- **13 E2E tests passing**

### Task 9: Update deno.json (AC: #2) ✅

- [x] 9.1 Add `_sandboxPermissions` section to `deno.json` (documentation)
- [x] 9.2 Note: Using underscore prefix as Deno 2.5 permission sets not yet available
- [x] 9.3 Document all 6 permission set profiles

### Task 10: Documentation and Exports (AC: all) ✅

- [x] 10.1 Add JSDoc comments to all new public methods
- [x] 10.2 Export `determinePermissionSet` and `PERMISSION_CONFIDENCE_THRESHOLD` from
      `src/sandbox/mod.ts`
- [x] 10.3 Update this story file with completion notes

## Dev Notes

### Critical Implementation Details

1. **Backward Compatibility:** Default to `"minimal"` permission set - existing code should work
   unchanged

2. **Deno Version Detection:**
   ```typescript
   private supportsPermissionSets(): boolean {
     // Parse version like "2.5.1" → [2, 5]
     const [major, minor] = Deno.version.deno.split(".").map(Number);
     return major > 2 || (major === 2 && minor >= 5);
   }
   ```

3. **Always Allow Temp File Read:** The temp file for code execution must always be readable:
   ```typescript
   args.push(`--allow-read=${tempFile}`); // Always add this
   // Then add permission set flags
   ```

4. **Worker Mode vs Subprocess Mode:**
   - `execute()` uses subprocess mode - permissions apply
   - `executeWithTools()` uses Worker mode - Worker is always sandboxed (permissions: "none")
   - Permission set is informational for Worker mode (log warning if not minimal)

5. **Security Priority:** When in doubt, use more restrictive permissions

### File Structure

```
src/sandbox/
├── executor.ts           # MODIFY: Add permission set support (~100 LOC changes)
├── worker-bridge.ts      # MODIFY: Add permission set logging (~10 LOC)
├── types.ts              # EXISTING: No changes (PermissionSet in capabilities/types.ts)
└── mod.ts                # MODIFY: Export determinePermissionSet if needed

src/capabilities/
├── types.ts              # EXISTING: PermissionSet type defined here
└── mod.ts                # EXISTING: Already exports PermissionSet

tests/unit/sandbox/
└── permission_integration_test.ts  # NEW: Unit tests (~200 LOC)

tests/integration/
└── permission_enforcement_test.ts  # NEW: E2E tests (~150 LOC)

deno.json                 # MODIFY: Add permissions section (documentation)
```

### Performance Expectations

- Version check: <1ms (cached after first call)
- Permission set to flags mapping: <1ms
- No impact on execution time (only affects command building)

### Dependencies

- `PermissionSet` type from `src/capabilities/types.ts` (already exists from Story 7.7a)
- No new external dependencies

### Related Files from Story 7.7a

- `src/capabilities/permission-inferrer.ts` - Infers permission sets from code
- `src/capabilities/capability-store.ts` - Stores permission_set and permission_confidence
- `src/db/migrations/017_permission_inference.ts` - DB schema for permission columns

## References

- [ADR-035: Permission Sets for Sandbox Security](../adrs/ADR-035-permission-sets-sandbox-security.md)
- [Story 7.7a: Permission Inference](./7-7a-permission-inference-automatic-analysis.md) -
  Prerequisite (DONE)
- [Deno Permissions Documentation](https://docs.deno.com/runtime/fundamentals/permissions/)
- [Deno 2.5 Release Notes](https://deno.com/blog) - Permission sets feature

## Estimation

- **Effort:** 1-2 days
- **LOC:** ~100 (executor.ts) + ~10 (worker-bridge.ts) + ~200 (unit tests) + ~150 (e2e tests) = ~460
  total
- **Risk:** Low (leverages existing permission inference from 7.7a)

---

## Dev Agent Record

### Context Reference

- `src/sandbox/executor.ts:475-525` - Current buildCommand() to modify
- `src/sandbox/executor.ts:881-997` - executeWithTools() to add permission set param
- `src/capabilities/types.ts:39-45` - PermissionSet type definition
- `src/capabilities/permission-inferrer.ts` - Reference for how permissions are inferred
- `config/mcp-permissions.yaml` - MCP tool permission mappings
- `tests/unit/capabilities/permission_inferrer_test.ts` - Test structure reference

### Agent Model Used

Claude Opus 4.5

### Debug Log References

- Type check passed: `deno check src/sandbox/executor.ts src/sandbox/mod.ts`
- 251 existing sandbox tests still passing (no regressions)

### Completion Notes List

1. **Implementation Approach**: Used explicit flags fallback for all Deno versions since Deno 2.5
   `--permission-set` flag is not yet available. The `supportsPermissionSets()` method is ready for
   future when native support is added.

2. **Security Enhancement**: Always apply `--deny-run` and `--deny-ffi` regardless of permission
   set. Even "trusted" permission cannot spawn subprocesses or use FFI - these are considered
   security-critical.

3. **Worker Mode Note**: Worker mode (`executeWithTools()`) inherently uses `permissions: "none"`.
   The permission set parameter is informational only and logs a warning if not "minimal".

4. **Test Coverage**: 37 new tests (24 unit + 13 E2E) covering:
   - All 6 permission set mappings
   - Version detection with caching
   - Confidence threshold logic (0.7 threshold)
   - Permission enforcement (blocks fetch, write, env as expected)
   - Sequential execution with different permission sets

5. **Backward Compatibility**: Default permission set is "minimal" - existing code unchanged.

### File List

- [x] `src/sandbox/executor.ts` - MODIFIED (~130 LOC added: permission methods +
      determinePermissionSet)
- [x] `src/sandbox/mod.ts` - MODIFIED (exports determinePermissionSet,
      PERMISSION_CONFIDENCE_THRESHOLD)
- [x] `tests/unit/sandbox/permission_integration_test.ts` - NEW (24 tests, ~250 LOC)
- [x] `tests/integration/permission_enforcement_test.ts` - NEW (13 tests, ~340 LOC)
- [x] `deno.json` - MODIFIED (added _sandboxPermissions section)

### Test Summary

| Test Type              | Count   | Status                  |
| ---------------------- | ------- | ----------------------- |
| Unit Tests             | 24      | ✅ PASS                 |
| E2E Tests              | 13      | ✅ PASS                 |
| Existing Sandbox Tests | 251     | ✅ PASS (no regression) |
| **Total**              | **288** | **✅ PASS**             |

---

## Senior Developer Review (AI)

**Reviewer:** Claude Opus 4.5 **Date:** 2025-12-16 **Outcome:** ✅ APPROVED

### Review Summary

All 11 Acceptance Criteria verified against implementation. All tasks marked `[x]` confirmed
complete.

### Issues Found & Fixed

| Severity | Issue                                                     | Resolution                                                      |
| -------- | --------------------------------------------------------- | --------------------------------------------------------------- |
| MEDIUM   | Unused import `assertStringIncludes` in E2E test (TS6133) | ✅ Fixed - Removed unused import                                |
| MEDIUM   | Flaky unit test using unreliable `httpbin.org` endpoint   | ✅ Fixed - Changed to resilient `google.com/robots.txt` pattern |

### Test Results After Fixes

| Test Type  | Count | Status  |
| ---------- | ----- | ------- |
| Unit Tests | 24/24 | ✅ PASS |
| E2E Tests  | 13/13 | ✅ PASS |
| Type Check | All   | ✅ PASS |

### Files Modified During Review

- `tests/integration/permission_enforcement_test.ts` - Removed unused import
- `tests/unit/sandbox/permission_integration_test.ts` - Fixed flaky network test pattern
