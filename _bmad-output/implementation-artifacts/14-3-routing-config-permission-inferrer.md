# Story 14.3: Routing Configuration & Permission Inferrer Integration

Status: done

> **Epic:** 14 - JSR Package Local/Cloud MCP Routing
> **FR Coverage:** FR14-3 (Routing + Permission inference)
> **Prerequisites:** Story 14.2 (Workspace Resolution System - DONE), Story 13.9 (Routing Resolver - DONE)
> **Previous Story:** 14-2-workspace-resolution-system.md

## Story

As a platform maintainer, I want MCP routing and permission decisions based on declarative configuration, So that routing logic is consistent and capability permissions are inferred from their tools.

## Scope Clarification (2025-12-30)

**Original Epic AC (Routing) - DONE via Story 13.9:**
- ~~Schema extension for `routing` field~~ → `config/mcp-routing.json`
- ~~`getToolRouting()` function~~ → `src/capabilities/routing-resolver.ts`
- ~~Default routing config~~ → Cloud list with local default

**This Story (14.3) Focuses On:**
1. **PML Package Routing Integration** - Embed routing resolver in `packages/pml`
2. **Capability Permission Inference** - `inferCapabilityApprovalMode(toolsUsed, permissions)` at runtime

## Problem Context

### Current State (After Story 14.2 + Story 13.9)

**Routing (Platform-defined, stored in DB) - DONE:**
- `config/mcp-routing.json` - liste des serveurs cloud ✅
- `src/capabilities/routing-resolver.ts` - `getToolRouting()`, `resolveRouting()` ✅
- `capability_records.routing` - stocké en DB ✅

**Permissions (User-specific, NOT in DB):**
- `config/mcp-permissions.json` - allow/deny/ask par tool ✅
- `src/capabilities/permission-inferrer.ts` - `isToolAllowed()`, `toolRequiresHil()` ✅
- `packages/pml/src/permissions/loader.ts` - charge `.pml.json` de l'utilisateur ✅

### What's Missing for PML Package

| Component | Status | Description |
|-----------|--------|-------------|
| Main codebase routing | ✅ DONE (13.9) | `routing-resolver.ts`, `mcp-routing.json` |
| `inferCapabilityApprovalMode()` | ❌ MISSING | Infer HIL from capability's tools_used |
| PML routing resolver | ❌ MISSING | Embedded routing defaults for PML package |
| PML permission inferrer | ❌ MISSING | Runtime approval mode inference |

### Key Architecture Insight

**Routing vs Approval Mode:**

| Aspect | Routing | Approval Mode |
|--------|---------|---------------|
| **Who decides?** | Platform (us) | User |
| **Source** | `config/mcp-routing.json` | User's `.pml.json` |
| **Storage** | DB (`capability_records.routing`) | **Runtime only** |
| **Scope** | Same for all users | Per-user |
| **Mutability** | Immutable | User can change anytime |

**Why approval_mode is NOT in DB:**
- User A has `filesystem:*` in `allow` → capability is `auto`
- User B has `filesystem:*` in `ask` → same capability is `hil`
- User can change their `.pml.json` at any time
- Must be computed at runtime for each execution

---

## Acceptance Criteria

### AC1: Capability Approval Mode Inference

**Given** a capability with `tools_used = ["filesystem:read", "tavily:search"]`
**And** user's permissions: `{ allow: ["tavily:*"], ask: ["filesystem:*"] }`
**When** `inferCapabilityApprovalMode(toolsUsed, permissions)` is called
**Then** it returns `"hil"` because `filesystem:read` requires ask

### AC2: Approval Mode Precedence

**Given** a capability's tools_used list
**When** inferring approval mode
**Then** the following precedence applies:
  1. If ANY tool is `denied` → throw error (capability blocked)
  2. If ANY tool is `ask` → return `"hil"`
  3. If ALL tools are `allow` → return `"auto"`
  4. Unknown tools → `"hil"` (safe default)

### AC3: PML Package Routing Resolver

**Given** the PML package (`packages/pml`)
**When** it needs to determine routing
**Then** it has embedded routing defaults matching `config/mcp-routing.json`
**And** returns `"local"` for unknown tools (security-first)

### AC4: PML Package Permission Inferrer

**Given** the PML package
**When** a capability is about to execute
**Then** it computes approval_mode from `tools_used` + user's loaded permissions
**And** triggers HIL flow if `approval_mode === "hil"`

### AC5: Integration with serve-command

**Given** the PML `serve` command receives a capability execution request
**When** processing the request
**Then** it resolves routing via `resolveToolRouting()` (determines local/cloud)
**And** it infers approval via `inferCapabilityApprovalMode()` (determines hil/auto)
**And** blocks execution if any tool is denied

### AC6: Unit Tests

**Given** the permission inference implementation
**When** tests are run
**Then** all scenarios are covered:
  - All tools allowed → `auto`
  - Any tool requires ask → `hil`
  - Any tool denied → error thrown
  - Unknown tools → `hil` (safe default)
  - Empty tools_used → `auto`

---

## Tasks / Subtasks

### Phase 1: Permission Inferrer for Capabilities (~1.5h)

- [x] Task 1: Create capability approval mode inferrer (AC: #1, #2)
  - [x] Create `packages/pml/src/permissions/capability-inferrer.ts`
  - [x] Implement `inferCapabilityApprovalMode(toolsUsed, permissions): ApprovalMode`
  - [x] Handle denied tools with clear error
  - [x] Return `"hil"` for any `ask` tool
  - [x] Return `"auto"` only if ALL tools are `allow`
  - [x] Default to `"hil"` for unknown tools (safe)

- [x] Task 2: Add types (AC: #4)
  - [x] Add `ApprovalMode = "hil" | "auto"` to `packages/pml/src/types.ts`
  - [x] Add `CapabilityPermissionResult` interface
  - [x] Export from module

### Phase 2: PML Routing with Cloud Sync

> **Architecture (2026-01-05):** Routing config synced from cloud at startup, cached locally.
> Package decides routing based on cached config for fast lookups.

- [x] Task 3: Create PML routing with cloud sync
  - [x] Create `packages/pml/src/routing/cache.ts` - Local cache management
  - [x] Create `packages/pml/src/routing/sync.ts` - Cloud sync with version check
  - [x] Create `packages/pml/src/routing/resolver.ts` - Fast lookup from cache
  - [x] Default fallback config for offline mode

- [x] Task 4: Export routing modules
  - [x] Create `packages/pml/src/routing/mod.ts`
  - [x] Update `packages/pml/mod.ts` with routing exports

### Phase 3: Integration (~30m)

- [x] Task 5: Wire to serve-command (AC: #5)
  - [x] Permission inferrer imported and used
  - [x] Routing sync at startup with cloud
  - [x] Display routing version in startup info

### Phase 4: Tests (~1h)

- [x] Task 6: Unit tests for capability permission inferrer (20 tests passing)
  - [x] Test all tools allowed → `auto`
  - [x] Test any tool ask → `hil`
  - [x] Test any tool denied → error
  - [x] Test unknown tools → `hil`
  - [x] Test empty tools_used → `auto`

- [x] Task 7: Unit tests for routing resolver (25 tests passing)
  - [x] Test local tools → `"local"`
  - [x] Test cloud tools → `"cloud"`
  - [x] Test unknown → `"local"`
  - [x] Test custom config support
  - [x] Test initialization state

---

## Dev Notes

### Capability Approval Mode Inferrer

```typescript
// packages/pml/src/permissions/capability-inferrer.ts

import type { ApprovalMode, PmlPermissions } from "../types.ts";
import { checkPermission } from "./loader.ts";

/**
 * Error thrown when a capability uses a denied tool
 */
export class CapabilityBlockedError extends Error {
  constructor(
    public readonly toolId: string,
    public readonly capabilityId?: string,
  ) {
    super(`Capability blocked: tool "${toolId}" is denied by user permissions`);
    this.name = "CapabilityBlockedError";
  }
}

/**
 * Infer approval mode for a capability based on its tools and user permissions.
 *
 * This is computed at RUNTIME, not stored in DB, because:
 * - Each user has their own permissions in .pml.json
 * - Users can change permissions at any time
 * - Same capability may be "auto" for one user and "hil" for another
 *
 * Precedence:
 * 1. If ANY tool is denied → throw CapabilityBlockedError
 * 2. If ANY tool requires ask → return "hil"
 * 3. If ALL tools are allowed → return "auto"
 * 4. Unknown tools → "hil" (safe default)
 *
 * @param toolsUsed - Array of tool IDs used by the capability
 * @param permissions - User's loaded permissions from .pml.json
 * @returns "hil" or "auto"
 * @throws CapabilityBlockedError if any tool is denied
 *
 * @example
 * ```ts
 * const approval = inferCapabilityApprovalMode(
 *   ["filesystem:read", "tavily:search"],
 *   { allow: ["tavily:*"], deny: [], ask: ["filesystem:*"] }
 * );
 * // Returns "hil" because filesystem:read requires ask
 * ```
 */
export function inferCapabilityApprovalMode(
  toolsUsed: string[],
  permissions: PmlPermissions,
): ApprovalMode {
  // Empty tools = pure compute = auto (safe)
  if (!toolsUsed || toolsUsed.length === 0) {
    return "auto";
  }

  let requiresHil = false;

  for (const tool of toolsUsed) {
    const result = checkPermission(tool, permissions);

    switch (result) {
      case "denied":
        throw new CapabilityBlockedError(tool);

      case "ask":
        requiresHil = true;
        break;

      case "allowed":
        // Continue checking other tools
        break;
    }
  }

  return requiresHil ? "hil" : "auto";
}

/**
 * Check if a capability can execute with user's permissions.
 * Returns detailed result instead of throwing.
 *
 * @param toolsUsed - Tools used by capability
 * @param permissions - User permissions
 * @returns Object with canExecute, approvalMode, and blockedTool if any
 */
export function checkCapabilityPermissions(
  toolsUsed: string[],
  permissions: PmlPermissions,
): CapabilityPermissionResult {
  if (!toolsUsed || toolsUsed.length === 0) {
    return { canExecute: true, approvalMode: "auto" };
  }

  let requiresHil = false;

  for (const tool of toolsUsed) {
    const result = checkPermission(tool, permissions);

    if (result === "denied") {
      return {
        canExecute: false,
        approvalMode: "hil",
        blockedTool: tool,
        reason: `Tool "${tool}" is denied by user permissions`,
      };
    }

    if (result === "ask") {
      requiresHil = true;
    }
  }

  return {
    canExecute: true,
    approvalMode: requiresHil ? "hil" : "auto",
  };
}
```

### Type Additions

```typescript
// packages/pml/src/types.ts - ADD

/**
 * Approval mode for capability execution
 * - "auto": Execute without user confirmation
 * - "hil": Requires Human-in-the-Loop approval
 */
export type ApprovalMode = "hil" | "auto";

/**
 * Tool routing destination
 * - "local": Execute in user's sandbox
 * - "cloud": Forward to pml.casys.ai
 */
export type ToolRouting = "local" | "cloud";

/**
 * Result of checking capability permissions
 */
export interface CapabilityPermissionResult {
  /** Whether the capability can execute */
  canExecute: boolean;
  /** Required approval mode */
  approvalMode: ApprovalMode;
  /** Tool that blocked execution (if canExecute is false) */
  blockedTool?: string;
  /** Human-readable reason (if blocked) */
  reason?: string;
}
```

### PML Routing Resolver

```typescript
// packages/pml/src/routing/resolver.ts

import type { ToolRouting } from "../types.ts";

/**
 * Cloud servers - matches config/mcp-routing.json
 * Everything else defaults to LOCAL for security.
 */
const CLOUD_SERVERS = new Set([
  "memory", "tavily", "brave_search", "exa",
  "github", "slack", "api", "http", "fetch",
  "sequential-thinking", "context7", "magic",
  "json", "math", "datetime", "crypto",
  "collections", "validation", "format",
  "transform", "algo", "string", "color",
  "geo", "resilience", "schema", "diff",
  "state", "plots", "pml",
]);

/**
 * Extract namespace from tool ID
 */
export function extractNamespace(toolId: string): string {
  if (!toolId) return "";
  if (toolId.startsWith("mcp__")) {
    const parts = toolId.split("__");
    return parts[1] || "";
  }
  const colonIndex = toolId.indexOf(":");
  return colonIndex > 0 ? toolId.slice(0, colonIndex) : toolId;
}

/**
 * Resolve routing for a tool.
 * DEFAULT IS LOCAL - only explicit cloud servers route to cloud.
 */
export function resolveToolRouting(tool: string): ToolRouting {
  const namespace = extractNamespace(tool);
  return CLOUD_SERVERS.has(namespace) ? "cloud" : "local";
}

export function isLocalTool(tool: string): boolean {
  return resolveToolRouting(tool) === "local";
}

export function isCloudTool(tool: string): boolean {
  return resolveToolRouting(tool) === "cloud";
}
```

### Project Structure

**Files to Create:**
```
packages/pml/src/
├── permissions/
│   └── capability-inferrer.ts  # NEW: Approval mode inference
├── routing/
│   ├── resolver.ts             # NEW: Routing resolver
│   └── mod.ts                  # NEW: Exports

packages/pml/tests/
├── capability_inferrer_test.ts # NEW: Permission inference tests
└── routing_test.ts             # NEW: Routing tests
```

**Files to Modify:**
```
packages/pml/src/types.ts              # ADD ApprovalMode, ToolRouting, CapabilityPermissionResult
packages/pml/src/permissions/mod.ts    # RE-EXPORT capability-inferrer
packages/pml/mod.ts                    # RE-EXPORT routing, permission inferrer
packages/pml/src/cli/serve-command.ts  # WIRE routing + permission inference
```

### Testing Strategy

```typescript
// packages/pml/tests/capability_inferrer_test.ts

import { assertEquals, assertThrows } from "@std/assert";
import {
  CapabilityBlockedError,
  inferCapabilityApprovalMode,
} from "../src/permissions/capability-inferrer.ts";

const testPermissions = {
  allow: ["json:*", "math:*", "tavily:*"],
  deny: ["ssh:*"],
  ask: ["filesystem:*", "shell:*"],
};

Deno.test("inferCapabilityApprovalMode - all allowed → auto", () => {
  const result = inferCapabilityApprovalMode(
    ["json:parse", "math:add"],
    testPermissions,
  );
  assertEquals(result, "auto");
});

Deno.test("inferCapabilityApprovalMode - any ask → hil", () => {
  const result = inferCapabilityApprovalMode(
    ["json:parse", "filesystem:read"],
    testPermissions,
  );
  assertEquals(result, "hil");
});

Deno.test("inferCapabilityApprovalMode - denied → throws", () => {
  assertThrows(
    () => inferCapabilityApprovalMode(["ssh:connect"], testPermissions),
    CapabilityBlockedError,
    "ssh:connect",
  );
});

Deno.test("inferCapabilityApprovalMode - unknown → hil (safe)", () => {
  const result = inferCapabilityApprovalMode(
    ["unknown:tool"],
    testPermissions,
  );
  assertEquals(result, "hil"); // checkPermission returns "ask" for unknown
});

Deno.test("inferCapabilityApprovalMode - empty tools → auto", () => {
  const result = inferCapabilityApprovalMode([], testPermissions);
  assertEquals(result, "auto");
});

Deno.test("inferCapabilityApprovalMode - mixed → hil wins", () => {
  const result = inferCapabilityApprovalMode(
    ["tavily:search", "shell:exec", "json:parse"],
    testPermissions,
  );
  assertEquals(result, "hil"); // shell:exec is in ask
});
```

### Integration Flow (serve-command)

```typescript
// In serve-command.ts - execution flow

// 1. Load user permissions (Story 14.2)
const permResult = await loadUserPermissions(workspace);

// 2. For each tool call or capability execution:

// 2a. Resolve ROUTING (platform-defined)
const routing = resolveToolRouting(toolId);
// → "local" or "cloud"

// 2b. For capabilities, infer APPROVAL (user-defined)
const approval = inferCapabilityApprovalMode(
  capability.toolsUsed,
  permResult.permissions,
);
// → "auto" or "hil"

// 3. Execute based on routing + approval
if (routing === "local") {
  // Story 14.5: Sandboxed local execution
  if (approval === "hil") {
    // Trigger HIL flow, wait for approval
  }
  // Execute locally
} else {
  // Story 14.6: Forward to cloud with BYOK
}
```

### Dependencies

- **Story 13.9** (DONE): Routing resolver in main codebase
- **Story 14.2** (DONE): Workspace resolution, permission loading
- **Story 14.5** (NEXT): Sandboxed local execution uses routing + approval
- **Story 14.6** (FUTURE): Cloud RPC uses routing

### References

- [Source: config/mcp-routing.json] - Platform routing config
- [Source: config/mcp-permissions.json] - Default permissions
- [Source: src/capabilities/routing-resolver.ts] - Main codebase routing
- [Source: src/capabilities/permission-inferrer.ts] - Main codebase permissions
- [Source: packages/pml/src/permissions/loader.ts] - User permission loading

---

## Estimation

- **Effort:** 1 day
- **LOC:** ~250 net
  - capability-inferrer.ts: ~80 lines
  - routing/resolver.ts: ~50 lines
  - types.ts additions: ~20 lines
  - tests: ~100 lines
- **Risk:** Low (clear patterns, no DB changes)

---

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Context Reference

- `config/mcp-routing.json` - Platform routing (cloud list)
- `config/mcp-permissions.json` - Default tool permissions
- `src/capabilities/routing-resolver.ts` - Main codebase routing
- `src/capabilities/permission-inferrer.ts` - Main codebase tool permissions
- `packages/pml/src/permissions/loader.ts` - User permission loading
- `packages/pml/src/types.ts` - PML types

### Debug Log References

### Completion Notes List

- ✅ Permission inferrer implemented with `inferCapabilityApprovalMode()` and `checkCapabilityPermissions()`
- ✅ Routing with cloud sync: synced at startup, cached locally for fast lookups
- ✅ Types added: `ApprovalMode`, `CapabilityPermissionResult`, `RoutingConfig`, `RoutingCache`, `ToolRouting`
- ✅ 122 unit tests passing (23 permission + 25 routing + 74 others)

### Code Review Fixes (2026-01-05)

- ✅ H1: Added capability-inferrer imports to serve-command.ts
- ✅ M1: Refactored code duplication with `scanToolsPermissions()` helper
- ✅ M2: Wired `capabilityId` parameter through API for better error messages
- ✅ L1: Fixed test type safety (removed `as any` casts)
- ✅ L2: Added integration test

### Architecture Decision (2026-01-05)

- Routing config is fetched from cloud at startup (with version check)
- Cached locally in `~/.pml/routing-cache.json`
- Offline mode uses cached config or fallback defaults
- Fast lookups at runtime (no network calls per tool)

### Change Log

- 2026-01-05: Routing with cloud sync architecture implemented
- 2026-01-05: Code review fixes applied (H1, M1, M2, L1, L2)
- 2026-01-03: Initial implementation (commit 78895354)

### File List

**Created:**
- `packages/pml/src/routing/cache.ts` - Local cache management
- `packages/pml/src/routing/sync.ts` - Cloud sync with version check
- `packages/pml/src/routing/resolver.ts` - Fast lookup from cache
- `packages/pml/src/routing/mod.ts` - Module exports
- `packages/pml/tests/routing_test.ts` - 25 routing tests

**Modified:**
- `packages/pml/src/permissions/capability-inferrer.ts` - Added capabilityId, refactored
- `packages/pml/tests/capability_inferrer_test.ts` - 23 tests with integration
- `packages/pml/src/cli/serve-command.ts` - Routing sync at startup
- `packages/pml/src/types.ts` - Added routing types
- `packages/pml/mod.ts` - Exports routing + permissions
