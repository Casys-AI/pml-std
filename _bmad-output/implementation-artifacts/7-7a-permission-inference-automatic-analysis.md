# Story 7.7a: Permission Inference - Automatic Permissions Analysis

> **Epic:** 7 - Emergent Capabilities & Learning System **ADR:** ADR-035 (Permission Sets for
> Sandbox Security) **Prerequisites:** Story 7.2b (SWC Schema Inference - DONE, 19 tests passing)
> **Status:** Done

## User Story

As a system executing capabilities in sandbox, I want automatic permission inference from code
analysis, So that capabilities run with minimal required permissions (principle of least privilege).

## Problem Context

### Current State (After Story 7.2b)

The sandbox executor uses broad permissions for all code:

```typescript
// src/sandbox/executor.ts (current)
const command = new Deno.Command("deno", {
  args: [
    "run",
    "--allow-read", // ALL files
    "--allow-net", // ALL network
    "--allow-env", // ALL env vars
    // ... overly permissive
  ],
});
```

**Risks:**

- Malicious capabilities can read sensitive files
- Unrestricted network access
- No differentiation between "trusted" and "untrusted" capabilities

### Solution: SWC-based Permission Inference

Reuse the SWC AST parsing infrastructure from Story 7.2b (`SchemaInferrer`) to detect permission
requirements from code patterns.

**Architecture Decision (ADR-035):** Permission Sets with automatic inference.

## Acceptance Criteria

### AC1: PermissionInferrer Class Created

- [x] File `src/capabilities/permission-inferrer.ts` created (~510 LOC)
- [x] Class `PermissionInferrer` exported
- [x] Reuses SWC parsing from Story 7.2b (`https://deno.land/x/swc@0.2.1/mod.ts`)
- [x] Same wrapping strategy as `SchemaInferrer.wrapCodeIfNeeded()`

### AC2: inferPermissions Method

- [x] Method `inferPermissions(code: string): Promise<InferredPermissions>` implemented
- [x] Returns:
  ```typescript
  interface InferredPermissions {
    permissionSet: string; // "minimal" | "readonly" | "network-api" | etc.
    confidence: number; // 0-1 (based on pattern clarity)
    detectedPatterns: string[]; // ["fetch", "mcp.filesystem"] for debugging
  }
  ```

### AC3: Pattern Detection via AST

- [x] Detect network patterns: `fetch(`, `Deno.connect`, URL patterns
- [x] Detect filesystem patterns: `mcp.filesystem`, `mcp.fs`, `Deno.readFile`, `Deno.writeFile`
- [x] Detect env patterns: `Deno.env`, `process.env`
- [x] Handle MCP tool prefixes: `mcp.github`, `mcp.slack` → network-api
- [x] Handle nested access: `mcp.filesystem.read` vs `mcp.filesystem.write`

### AC4: Permission Set Mapping

| Profile        | Read         | Write      | Net         | Env     | Detection Patterns                    |
| -------------- | ------------ | ---------- | ----------- | ------- | ------------------------------------- |
| `minimal`      | ❌           | ❌         | ❌          | ❌      | No I/O patterns detected              |
| `readonly`     | `["./data"]` | ❌         | ❌          | ❌      | `mcp.fs.read`, `Deno.readFile`        |
| `filesystem`   | `["./"]`     | `["/tmp"]` | ❌          | ❌      | `mcp.fs.write`, `Deno.writeFile`      |
| `network-api`  | ❌           | ❌         | `["api.*"]` | ❌      | `fetch`, `mcp.api`, `mcp.github`      |
| `mcp-standard` | ✅           | `["/tmp"]` | ✅          | Limited | Mixed patterns or unknown MCP         |
| `trusted`      | ✅           | ✅         | ✅          | ✅      | Manual/verified only (never inferred) |

### AC5: Database Migration (017)

- [x] Migration `017_permission_inference.ts` created
- [x] Add columns to `workflow_pattern`:
  ```sql
  ALTER TABLE workflow_pattern
  ADD COLUMN permission_set VARCHAR(50) DEFAULT 'minimal',
  ADD COLUMN permission_confidence FLOAT DEFAULT 0.0;

  CREATE INDEX idx_workflow_pattern_permission ON workflow_pattern(permission_set);
  ```
- [x] Migration idempotent (can be replayed)

### AC6: Integration with CapabilityStore.saveCapability()

- [x] `CapabilityStore` constructor accepts optional `PermissionInferrer`
- [x] `saveCapability()` calls `inferPermissions(code)` after schema inference
- [x] Permission set and confidence stored in database via UPSERT

### AC7: Confidence Scoring

- [x] Single clear pattern → confidence 0.90-0.95
- [x] Multiple patterns of same type → confidence 0.95
- [x] Mixed patterns → confidence 0.70-0.80
- [x] Unknown patterns → confidence 0.50 (fallback to mcp-standard)
- [x] No patterns → confidence 0.95 (minimal is safe default)

### AC8: Unit Tests

- [x] Test: code with `fetch()` → permission_set = "network-api"
- [x] Test: code with `mcp.fs.read()` → permission_set = "readonly"
- [x] Test: code with `mcp.fs.write()` → permission_set = "filesystem"
- [x] Test: code with `mcp.github.createIssue()` → permission_set = "network-api"
- [x] Test: code without I/O → permission_set = "minimal", confidence >= 0.95
- [x] Test: mixed fs + network → permission_set = "mcp-standard"
- [x] Test: graceful error handling (malformed code → minimal with low confidence)

## Tasks / Subtasks

### Task 1: Create PermissionInferrer Class (AC: #1, #2) ✅

- [x] 1.1 Create `src/capabilities/permission-inferrer.ts`
- [x] 1.2 Import SWC parser (same as schema-inferrer.ts:10)
- [x] 1.3 Implement `wrapCodeIfNeeded()` (copy pattern from schema-inferrer.ts:137-149)
- [x] 1.4 Define `InferredPermissions` interface
- [x] 1.5 Implement `inferPermissions()` method skeleton

### Task 2: Implement Pattern Detection (AC: #3) ✅

- [x] 2.1 Create `findPatterns(ast: unknown): DetectedPattern[]` method
- [x] 2.2 Implement network pattern detection:
  - `fetch` identifier in CallExpression
  - `Deno.connect` MemberExpression chain
  - URL patterns in string literals
- [x] 2.3 Implement filesystem pattern detection:
  - `mcp.filesystem.*` MemberExpression chains
  - `mcp.fs.*` MemberExpression chains
  - `Deno.readFile`, `Deno.writeFile` identifiers
- [x] 2.4 Implement env pattern detection:
  - `Deno.env` MemberExpression
  - `process.env` MemberExpression
- [x] 2.5 Add recursive AST traversal (reuse pattern from schema-inferrer.ts:179-191)

### Task 3: Implement Permission Set Mapping (AC: #4, #7) ✅

- [x] 3.1 Create `mapPatternsToPermissionSet(patterns: DetectedPattern[])` method
- [x] 3.2 Define permission profile constants
- [x] 3.3 Implement confidence scoring logic
- [x] 3.4 Handle edge cases (empty patterns, mixed patterns, unknown patterns)

### Task 4: Create Database Migration (AC: #5) ✅

- [x] 4.1 Create `src/db/migrations/017_permission_inference.ts`
- [x] 4.2 Add `permission_set` column with default 'minimal'
- [x] 4.3 Add `permission_confidence` column with default 0.0
- [x] 4.4 Create index on permission_set
- [x] 4.5 Test migration up/down idempotency

### Task 5: Integrate with CapabilityStore (AC: #6) ✅

- [x] 5.1 Add `permissionInferrer?: PermissionInferrer` to CapabilityStore constructor
- [x] 5.2 Call `inferPermissions()` in `saveCapability()` after schema inference
- [x] 5.3 Update UPSERT query to include `permission_set`, `permission_confidence`
- [x] 5.4 Update `rowToCapability()` to parse permission columns
- [x] 5.5 Add permission fields to `Capability` type

### Task 6: Write Unit Tests (AC: #8) ✅

- [x] 6.1 Create `tests/unit/capabilities/permission_inferrer_test.ts`
- [x] 6.2 Test network pattern detection (fetch, mcp.github, mcp.api)
- [x] 6.3 Test filesystem pattern detection (mcp.fs.read, mcp.fs.write)
- [x] 6.4 Test env pattern detection (Deno.env, process.env)
- [x] 6.5 Test mixed patterns mapping
- [x] 6.6 Test confidence scoring
- [x] 6.7 Test error handling (invalid code)
- [x] 6.8 Test capability store integration

### Task 7: Export and Documentation (AC: all) ✅

- [x] 7.1 Add export to `src/capabilities/mod.ts`
- [x] 7.2 Add JSDoc comments to public methods
- [x] 7.3 Update this story file with completion notes

## Dev Notes

### Critical Implementation Details

1. **SWC Reuse:** Use exact same import as SchemaInferrer:
   ```typescript
   import { parse } from "https://deno.land/x/swc@0.2.1/mod.ts";
   ```

2. **AST Traversal Pattern:** Copy recursive traversal from `SchemaInferrer.findArgsAccesses()`
   (schema-inferrer.ts:154-192)

3. **Non-Critical Failure:** Permission inference failure should NOT fail capability save - fallback
   to "minimal" with confidence 0.0

4. **Trusted Never Inferred:** The "trusted" permission set is ONLY for manually verified
   capabilities, never auto-assigned

### Pattern Detection Heuristics

| Pattern        | AST Node Type                  | Example Code                          |
| -------------- | ------------------------------ | ------------------------------------- |
| `fetch`        | CallExpression with Identifier | `fetch("https://api.example.com")`    |
| `mcp.fs.read`  | MemberExpression chain         | `await mcp.filesystem.read({ path })` |
| `Deno.env`     | MemberExpression               | `Deno.env.get("HOME")`                |
| `mcp.github.*` | MemberExpression chain         | `mcp.github.createIssue({...})`       |

### MCP Tool → Permission Set Mapping

Defined in `config/mcp-permissions.yaml`:

```yaml
# Filesystem tools
filesystem:
  permissionSet: filesystem
  isReadOnly: false

# Network tools
github:
  permissionSet: network-api
  isReadOnly: false

# Mixed tools
kubernetes:
  permissionSet: mcp-standard
  isReadOnly: false
```

See full config in `config/mcp-permissions.yaml` for all mappings.

### File Structure

```
config/
└── mcp-permissions.yaml   # NEW: MCP tool permission mappings (~70 LOC)

src/capabilities/
├── capability-store.ts   # MODIFY: Add permissionInferrer + save logic
├── types.ts              # MODIFY: Add permission fields to Capability
├── hash.ts               # EXISTING: No changes
├── schema-inferrer.ts    # EXISTING: Reference for patterns
├── permission-inferrer.ts # NEW: PermissionInferrer class (~510 LOC)
└── mod.ts                # MODIFY: Export PermissionInferrer

src/db/migrations/
└── 017_permission_inference.ts # NEW: Add permission columns (~60 LOC)

tests/unit/capabilities/
├── capability_store_test.ts      # EXISTING: Add permission tests
├── schema_inferrer_test.ts       # EXISTING: Reference for test patterns
└── permission_inferrer_test.ts   # NEW: Permission inference tests
```

### Performance Expectations

- SWC parse: <10ms (same as schema inference)
- Pattern detection: <5ms
- Total overhead per capability save: <20ms

### Dependencies

- **SWC:** `https://deno.land/x/swc@0.2.1/mod.ts` (already in use)
- **No new dependencies required**

## References

- [ADR-035: Permission Sets for Sandbox Security](../adrs/ADR-035-permission-sets-sandbox-security.md)
- [Story 7.2b: Schema Inference (SWC)](./7-2b-schema-inference-swc.md) - Pattern for SWC usage
- [SchemaInferrer](../../src/capabilities/schema-inferrer.ts) - Reference implementation
- [CapabilityStore](../../src/capabilities/capability-store.ts) - Integration point
- [Deno Permissions Documentation](https://docs.deno.com/runtime/fundamentals/permissions/)

## Estimation

- **Effort:** 1-2 days
- **LOC:** ~510 (permission-inferrer.ts) + ~60 (migration) + ~360 (tests) = ~930 total
- **Risk:** Low (reuses proven SWC infrastructure from Story 7.2b)

---

## Dev Agent Record

### Context Reference

- `src/capabilities/schema-inferrer.ts` - SWC parsing patterns to reuse
- `src/capabilities/capability-store.ts:62-70` - Constructor pattern for optional inferrers
- `src/capabilities/capability-store.ts:102-116` - Schema inference integration pattern
- `drizzle/migrations/016_capability_dependency.ts` - Latest migration pattern
- `tests/unit/capabilities/schema_inferrer_test.ts` - Test structure reference

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

<!-- Will be populated during implementation -->

### Completion Notes List

**Implementation completed on 2025-12-16**

1. **PermissionInferrer Class** (`src/capabilities/permission-inferrer.ts`): ~440 LOC
   - SWC-based AST parsing (reused from SchemaInferrer)
   - Pattern detection for network, filesystem, env, and MCP tools
   - Confidence scoring based on pattern clarity and category mixing
   - Graceful error handling with fallback to "minimal"

2. **Database Migration 017** (`src/db/migrations/017_permission_inference.ts`): ~60 LOC
   - Added `permission_set` VARCHAR(50) DEFAULT 'minimal'
   - Added `permission_confidence` REAL DEFAULT 0.0
   - Created index on permission_set for efficient filtering

3. **CapabilityStore Integration** (`src/capabilities/capability-store.ts`):
   - Constructor accepts optional `PermissionInferrer` (4th parameter)
   - `saveCapability()` calls `inferPermissions()` after schema inference
   - UPSERT query includes permission columns
   - `rowToCapability()` parses permission fields

4. **Types Update** (`src/capabilities/types.ts`):
   - Added `PermissionSet` type alias
   - Added `permissionSet` and `permissionConfidence` fields to `Capability` interface

5. **Unit Tests** (`tests/unit/capabilities/permission_inferrer_test.ts`): ~360 LOC, 19 tests
   - Network: fetch, Deno.connect, mcp.github, mcp.slack, mcp.tavily
   - Filesystem: mcp.filesystem.read/write, Deno.readFile/writeFile
   - Env: Deno.env, process.env
   - Mixed patterns → mcp-standard
   - Error handling (malformed code)
   - Integration with CapabilityStore

6. **Exports** (`src/capabilities/mod.ts`):
   - `PermissionInferrer` class export
   - `InferredPermissions`, `DetectedPattern`, `PatternCategory` type exports
   - `PermissionSet` type re-exported from types.ts

### File List

- [x] `src/capabilities/permission-inferrer.ts` - NEW (~440 LOC)
- [x] `src/capabilities/capability-store.ts` - MODIFIED (constructor + saveCapability +
      rowToCapability)
- [x] `src/capabilities/types.ts` - MODIFIED (added PermissionSet type and Capability fields)
- [x] `src/capabilities/mod.ts` - MODIFIED (export PermissionInferrer + types)
- [x] `src/db/migrations/017_permission_inference.ts` - NEW (~60 LOC)
- [x] `src/db/migrations.ts` - MODIFIED (registered migration 017)
- [x] `tests/unit/capabilities/permission_inferrer_test.ts` - NEW (~450 LOC, 25 tests)
- [x] `config/mcp-permissions.yaml` - NEW (~70 LOC) - MCP tool permission mappings

---

## Senior Developer Review (AI)

**Date:** 2025-12-16 **Reviewer:** Claude Opus 4.5 **Outcome:** ✅ APPROVED

### Review Summary

| Category            | Status       |
| ------------------- | ------------ |
| All ACs Implemented | ✅ 8/8       |
| Tests Passing       | ✅ 25/25     |
| Code Quality        | ✅ Good      |
| Security            | ✅ No issues |

### Issues Found & Fixed

| # | Severity    | Description                                                            | Resolution                                                                                                |
| - | ----------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 2 | HIGH        | `PermissionSet` type defined twice (permission-inferrer.ts + types.ts) | Fixed: Import from types.ts, re-export                                                                    |
| 3 | HIGH        | Wrong migration path in story (drizzle/ → src/db/)                     | Fixed: Corrected path                                                                                     |
| 4 | MEDIUM      | ADR-035 referenced Migration 012 instead of 017                        | Fixed: Updated to 017                                                                                     |
| 5 | MEDIUM      | LOC estimates incorrect (~120 vs ~510 actual)                          | Fixed: Updated estimates                                                                                  |
| 6 | IMPROVEMENT | MCP tool permissions hardcoded in code                                 | Fixed: Externalized to `config/mcp-permissions.yaml`                                                      |
| 7 | NEW TESTS   | YAML config loading needs test coverage                                | Added: 6 new tests for config-loaded tools (playwright, postgres, sqlite, brave_search, memory, context7) |

### Skipped Issues (User Approved)

- **Issue #1:** 9 files modified but not in File List - belong to Story 7.6 (Algorithm
  Observability), not 7.7a. User confirmed OK to leave uncommitted separately.

### Notes

- MCP tool permissions loaded from `config/mcp-permissions.yaml` (externalized during review)
- Unknown MCP tools fallback to `mcp-standard` (secure default)
- Config is lazy-loaded on first `inferPermissions()` call and cached
