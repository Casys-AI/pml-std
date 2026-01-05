# Tech-Spec: Permission System Matrix Refactor

**Created:** 2025-12-16 **Status:** Completed

> **⚠️ PARTIALLY OBSOLETE (2025-12-19)**
>
> The `ffi` and `run` fields described in this spec have been **removed**. The permission model was
> simplified to 2 axes:
>
> - `scope`: metadata for audit/documentation
> - `approvalMode`: `auto` (default) or `hil`
>
> Worker sandbox always runs with `permissions: "none"`. MCP servers run as separate processes. See
> `config/mcp-permissions.yaml` for current format.

## Overview

### Problem Statement

The current permission system has two critical limitations:

1. **Linear model is incorrect**:
   `minimal < readonly < filesystem < network-api < mcp-standard < trusted` treats `ffi` and `run`
   as "above" other permissions, when they are actually orthogonal
2. **Hardcoded block**: `run` and `ffi` are hardcoded as blocked in `permission-escalation.ts:37`
   with no escalation path possible, even via HIL

This prevents legitimate use cases like Fermat MCP (NumPy/Python via FFI) from working in the
sandbox.

### Solution

Refactor to a **3-axis matrix model**:

```
┌─────────────────────────────────────────────────────────┐
│  SCOPE (resources)   │  SANDBOX ESCAPE  │  APPROVAL     │
├──────────────────────┼──────────────────┼───────────────┤
│  minimal             │  ffi: boolean    │  hil          │
│  readonly            │  run: boolean    │  auto         │
│  filesystem          │                  │               │
│  network-api         │                  │               │
│  mcp-standard        │                  │               │
└──────────────────────┴──────────────────┴───────────────┘
```

- **scope**: What resources can be accessed (files, network, etc.)
- **ffi/run**: Independent flags for sandbox escape capabilities
- **approvalMode**: `hil` (human approves) or `auto` (trusted, auto-approve)

### Scope

**In Scope:**

- Permission system refactor (types, escalation, inferrer)
- New YAML config format with backward-compatible shorthand
- Fermat MCP server integration
- npm package dependencies for primitives library
- Primitives library refactor with battle-tested packages

**Out of Scope:**

- Pyodide WASM integration (future enhancement)
- AI-based permission decision logic (using config-based auto-approve instead)

## Context for Development

### Codebase Patterns

- **Runtime:** Deno with TypeScript
- **Config format:** YAML with JSDoc-style comments
- **Type definitions:** Union types and interfaces in `types.ts`
- **Permission flow:** Error → suggestEscalation → HIL callback → update DB

### Files to Reference

| File                                                        | Purpose                                   |
| ----------------------------------------------------------- | ----------------------------------------- |
| `src/capabilities/types.ts:39-45`                           | Current `PermissionSet` type definition   |
| `src/capabilities/permission-escalation.ts:37`              | Hardcoded `SECURITY_CRITICAL_PERMISSIONS` |
| `src/capabilities/permission-escalation-handler.ts:175-177` | HIL callback invocation                   |
| `src/capabilities/permission-inferrer.ts`                   | YAML config loader                        |
| `config/mcp-permissions.yaml`                               | Permission mappings config                |
| `config/.mcp-servers.json`                                  | MCP server definitions                    |
| `lib/mcp-tools.ts`                                          | Primitives library (94 tools)             |

### Technical Decisions

1. **Breaking change accepted** - No backward compat shim for `PermissionSet` type
2. **YAML shorthand supported** - Old format auto-converts to new `PermissionConfig`
3. **Auto mode = config-based** - No LLM decision logic, just trust declaration
4. **Fermat requires Python** - User must have Python/uvx installed

## Implementation Plan

### Tasks

#### Part 1: Permission System Refactor

- [x] **Task 1.1:** Update `src/capabilities/types.ts`
  - Add `PermissionScope` type (same values as current `PermissionSet` minus `trusted`)
  - Add `ApprovalMode` type: `"hil" | "auto"`
  - Add `PermissionConfig` interface with 4 fields
  - Keep `PermissionSet` as deprecated alias during transition

- [x] **Task 1.2:** Update `src/capabilities/permission-escalation.ts`
  - Remove `SECURITY_CRITICAL_PERMISSIONS` constant (line 37)
  - Remove early return block for run/ffi (lines 124-131)
  - Update `OPERATION_TO_PERMISSION` to return `PermissionConfig`
  - Update escalation paths to work with new model

- [x] **Task 1.3:** Update `src/capabilities/permission-escalation-handler.ts`
  - Add `approvalMode` check before HIL callback
  - If `approvalMode === "auto"`: return `{ approved: true, feedback: "auto-approved" }`
  - If `approvalMode === "hil"`: call existing `hilCallback`

- [x] **Task 1.4:** Update `src/capabilities/permission-inferrer.ts`
  - Support both shorthand and explicit YAML formats
  - Shorthand: `permissionSet: X` → `{ scope: X, ffi: false, run: false, approvalMode: hil }`
  - Explicit: parse all 4 fields directly
  - Add validation for unknown fields

- [x] **Task 1.5:** Migrate `config/mcp-permissions.yaml`
  - Add documentation header explaining both formats
  - Keep existing entries as shorthand (backward compat)
  - Add Fermat with explicit format

#### Part 2: Python MCP Integration

> **Note:** Fermat MCP doesn't exist on PyPI. Replaced with verified packages.

- [x] **Task 2.1:** Add `mcp-plots` to `config/.mcp-servers.json`
  ```json
  "plots": {
    "type": "stdio",
    "command": "uvx",
    "args": ["mcp-plots", "-t", "stdio"]
  }
  ```

- [x] **Task 2.2:** Add plots permissions to `config/mcp-permissions.yaml`
  ```yaml
  plots:
    scope: filesystem
    ffi: true
    run: false
    approvalMode: auto
  ```

> **Rejected packages:**
>
> - `fermat-mcp` - doesn't exist on PyPI
> - `numpy-mcp` - no executable
> - `mcp-pandas` - requires `--data-path` at startup (unusable dynamically)
> - `jupyter-mcp-server` - requires Jupyter server running

#### Part 3: Primitives Library Refactor

- [x] **Task 3.1:** Add npm dependencies to `deno.json`
  ```json
  {
    "date-fns": "npm:date-fns@^4.1.0",
    "lodash-es": "npm:lodash-es@^4.17.21",
    "zod": "npm:zod@^3.23.0",
    "@faker-js/faker": "npm:@faker-js/faker@^9.0.0",
    "papaparse": "npm:papaparse@^5.5.0",
    "diff": "npm:diff@^7.0.0",
    "jsondiffpatch": "npm:jsondiffpatch@^0.7.0",
    "jmespath": "npm:jmespath@^0.16.0",
    "change-case": "npm:change-case@^5.4.0",
    "mathjs": "npm:mathjs@^14.0.0",
    "mnemonist": "npm:mnemonist@^0.39.0",
    "simple-statistics": "npm:simple-statistics@^7.8.0"
  }
  ```

- [x] **Task 3.2:** Refactor `lib/mcp-tools.ts` into `lib/primitives/` modules

  Created modular files in `lib/primitives/`:
  - `types.ts` - shared types (MiniTool, MiniToolHandler, etc.)
  - `text.ts` - `change-case` + `lodash-es`
  - `json.ts` - `jmespath` + `lodash-es`
  - `math.ts` - `mathjs`
  - `datetime.ts` - `date-fns`
  - `collections.ts` - `lodash-es`
  - `validation.ts` - `zod`
  - `data.ts` - `@faker-js/faker`
  - `transform.ts` - `papaparse` (CSV)
  - `compare.ts` - `diff` + `jsondiffpatch`
  - `algo.ts` - `mnemonist` + `simple-statistics`
  - `mod.ts` - exports all + `MiniToolsClient` class

- [x] **Task 3.3:** Keep custom implementations (no change)
  - `crypto.ts` - native `crypto.subtle` sufficient
  - `vfs.ts` - in-memory Map is fine
  - `state.ts` - in-memory KV with TTL is fine
  - `http.ts` - mock/educational tools
  - `format.ts` - simple formatting

- [x] **Task 3.4:** Bundle for Deno sandbox
  - Created `lib/primitives/build.ts` using esbuild
  - Bundle output: `lib/primitives/bundle.js` (11.8MB)
  - Added `deno task build:primitives` command
  - Auto-rebuild at server startup via `src/lib/primitives-loader.ts`

#### Part 4: Tests

- [x] **Task 4.1:** Update `tests/unit/capabilities/permission_escalation_test.ts`
  - Remove tests expecting run/ffi to be blocked
  - Add tests for new `PermissionConfig` parsing
  - Add tests for shorthand → explicit conversion

- [x] **Task 4.2:** Update `tests/e2e/permission_escalation_e2e_test.ts`
  - No existing e2e tests to update (skipped)
  - Unit tests cover the auto-approval logic

- [x] **Task 4.3:** Primitives library verification (build & type check)
  - Type checking passes with `deno check`
  - Bundle builds successfully (11.8MB)
  - MCP server responds to tools/list and tools/call

- [ ] **Task 4.4:** Primitives library unit tests (DEFERRED)
  - Comprehensive unit tests for 94+ tools deferred to separate story
  - Current coverage: build verification only, no functional tests

### Acceptance Criteria

- [x] **AC1:** Given a tool with `approvalMode: auto`, when permission error occurs, then escalation
      is auto-approved without HIL prompt
- [x] **AC2:** Given a tool with `ffi: true`, when FFI permission is requested, then it is allowed
      (not hardcoded blocked)
- [x] **AC3:** Given old YAML format `permissionSet: X`, when loaded, then it converts to
      `{ scope: X, ffi: false, run: false, approvalMode: hil }`
- [x] **AC4:** Given `mcp-plots` configured with `ffi: true, approvalMode: auto`, when DAG uses
      `plots_*` tools, then FFI is auto-approved
- [x] **AC5:** Given primitives library with npm packages, when bundle is built, then all 17 modules
      compile successfully
- [x] **AC6:** All existing tests pass after migration (39 tests pass)

## Additional Context

### Dependencies

- **Python + uvx:** Required for `mcp-plots` (visualization)
- **npm packages:** 12 packages for primitives (see Task 3.1)
- **esbuild:** For bundling primitives for Deno sandbox

### Testing Strategy

1. **Unit tests:** Permission config parsing, shorthand conversion
2. **Integration tests:** HIL bypass with auto mode
3. **E2E tests:** Full Fermat flow (DAG → FFI → NumPy)
4. **Regression:** All 48 existing tests must pass

### Notes

- The `trusted` permission set is deprecated - use explicit config instead
- Shorthand format is for backward compatibility only, new entries should use explicit format
- Future enhancement: Pyodide WASM for sandbox-safe Python (no FFI needed)

### Lessons Learned

1. **Many Python MCP packages don't exist or don't work:**
   - Always verify with `uvx <package> --help` before adding to config
   - Check PyPI directly, don't trust hallucinated package names
   - Some packages require runtime args (e.g., `mcp-pandas` needs `--data-path`)
   - Some packages default to HTTP transport, need `-t stdio` flag

2. **Deno sandbox requires bundling for npm packages:**
   - Sandbox workers can't do dynamic imports
   - Solution: esbuild bundle with `platform: browser` and `nodeModulesDir: true`
   - Auto-rebuild at server startup via mtime comparison

3. **Verified working Python MCP packages (as of 2025-12):**
   - `mcp-plots` - visualizations (line, bar, scatter, etc.)
   - `mcp-server-fetch` - HTTP fetching
   - `mcp-server-git` - Git operations
   - `mcp-server-time` - Date/time operations
   - `mcp-server-sqlite` - SQLite database

### YAML Config Header (to add)

```yaml
# MCP Tool Permission Mappings
#
# Two formats supported:
#
# 1. Shorthand (backward compatible):
#    github:
#      permissionSet: network-api
#
# 2. Explicit (recommended for new entries):
#    fermat:
#      scope: minimal        # minimal|readonly|filesystem|network-api|mcp-standard
#      ffi: true             # Allow FFI (native calls via Deno.dlopen)
#      run: false            # Allow subprocess (Deno.Command)
#      approvalMode: auto    # hil = ask human, auto = trust & auto-approve
#
# Shorthand defaults: scope=value, ffi=false, run=false, approvalMode=hil
```
