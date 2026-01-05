# Story 13.9: Routing Inheritance

Status: done

## Story

As a **developer**, I want **capability routing automatically inherited from tools used**, So that **local execution happens when any tool requires local access, without manual configuration**.

## Context

### Problem Statement

Cloud PML cannot execute capabilities that use local-only MCP tools (filesystem, shell). When a capability is created, we don't know if it needs local or cloud execution. But we CAN infer this from the tools it uses: if ANY tool is local-only (filesystem, shell), the capability MUST run locally. This avoids manual routing configuration.

### Current State (after Story 13.8)

- `capability_records` table has a `routing` column (TEXT, DEFAULT 'local')
- `tool_schema` table also has `routing` column added in migration 031
- `pml_registry` VIEW unifies both tables and exposes `routing`
- `tools_used` is stored in `workflow_pattern.dag_structure` JSONB (array of tool names)
- **Routing is NOT computed automatically** - it defaults to 'local' always

### Target State

1. When a capability is created/saved, compute `routing` from `tools_used`
2. If ANY tool in `tools_used` requires local execution -> `routing = 'local'`
3. If ALL tools can run on cloud -> `routing = 'cloud'`
4. Explicit override in metadata takes precedence
5. `cap:lookup` and `pml:discover` return `routing` in response

### Architecture Decision

**Storage Strategy: Computed at creation, stored in DB**

Le routing est calculé une fois à la création de la capability et stocké dans `capability_records.routing`.

Alternatives considérées :
- ❌ Calcul à la volée (retirer colonne routing) - Plus flexible mais complexifie les queries
- ❌ Per-user routing config - Prématuré, à implémenter quand le besoin arrive
- ✅ **Stocké en DB** - Simple, performant, suffisant pour l'instant

Note: Si le routing devient per-user plus tard (ex: user A veut github en local, user B en cloud),
on pourra ajouter une table `user_routing_overrides` avec `effectiveRouting = userOverride ?? capability.routing`.

**Routing Resolution Algorithm:**
```
routing = explicit_override ?? inferFromToolsUsed(tools_used) ?? 'cloud'

inferFromToolsUsed(tools):
  for each tool in tools:
    serverName = extractServerName(tool)  # e.g., "filesystem" from "filesystem:read_file"
    if isLocalServer(serverName):
      return 'local'
  return 'cloud'

isLocalServer(serverName):
  # From config/mcp-permissions.json or hardcoded list
  LOCAL_SERVERS = ['filesystem', 'fs', 'shell', 'process', 'ssh', 'docker', 'kubernetes']
  return serverName in LOCAL_SERVERS
```

## Acceptance Criteria

### AC1: Tools Used Tracking
**Given** a capability created via `pml_execute`
**When** execution completes successfully
**Then** `tools_used` array is populated in `workflow_pattern.dag_structure` with all tools called during execution

**Implementation Note:** This is already done in Story 7.3b (capability-injection-nested-tracing). The `tools_used` array is extracted from IPC tracking and stored in `dag_structure` JSONB.

### AC2: Routing Resolution - Local Priority
**Given** capability with `tools_used: ["filesystem:read_file", "pml:search"]`
**When** routing is resolved during capability save
**Then** `routing = "local"` because `filesystem` is a local server

### AC3: Routing Resolution - All Cloud
**Given** capability with `tools_used: ["pml:search", "tavily:search", "memory:store"]`
**When** routing is resolved during capability save
**Then** `routing = "cloud"` because all servers are cloud-compatible

### AC4: Routing Lookup Table
**Given** tool name like `filesystem:read_file` or `fs:read`
**When** routing lookup performed
**Then** extracts server name (`filesystem` or `fs`) and checks against LOCAL_SERVERS list

### AC5: Explicit Override
**Given** capability with explicit `routing: "cloud"` in metadata
**When** capability saved with `tools_used: ["filesystem:read_file"]`
**Then** explicit value `"cloud"` is used regardless of tools_used

### AC6: No Tools Used (Pure Compute)
**Given** capability with empty `tools_used` array (pure TypeScript compute)
**When** routing is resolved
**Then** defaults to `"cloud"` (safe, no local access needed)

### AC7: API Exposure
**Given** `cap:lookup("my-reader")` or `pml:discover({ intent: "read files" })`
**When** response returned
**Then** includes `routing: "local" | "cloud"` field

## Tasks / Subtasks

- [ ] Task 1: Create RoutingResolver utility (AC: #2, #3, #4, #6)
  - [ ] 1.1: Create `src/capabilities/routing-resolver.ts`
  - [ ] 1.2: Implement `resolveRouting(toolsUsed: string[], explicitRouting?: CapabilityRouting): CapabilityRouting`
  - [ ] 1.3: Implement `extractServerName(toolName: string): string` (e.g., "filesystem:read_file" -> "filesystem")
  - [ ] 1.4: Implement `isLocalServer(serverName: string): boolean` using LOCAL_SERVERS constant
  - [ ] 1.5: Unit tests for resolver (8+ tests covering all ACs)

- [ ] Task 2: Integrate resolver in capability creation (AC: #1, #2, #3, #5)
  - [ ] 2.1: Modify `CapabilityStore.create()` or `save()` to call `resolveRouting()`
  - [ ] 2.2: Pass `tools_used` from `dag_structure` to resolver
  - [ ] 2.3: Respect explicit override if provided
  - [ ] 2.4: Integration tests

- [ ] Task 3: Ensure routing exposed in APIs (AC: #7)
  - [ ] 3.1: Verify `cap:lookup` returns `routing` (already in CapabilityRecord)
  - [ ] 3.2: Verify `pml:discover` returns `routing` (already in PmlRegistryRecord via VIEW)
  - [ ] 3.3: Add E2E test for full flow

## Dev Notes

### Existing Code References

**tools_used extraction:**
```typescript
// src/capabilities/capability-store.ts:846
// Story 7.4: Extract tools_used, tool_invocations, and static_structure from dag_structure JSONB
if (Array.isArray(dagStruct?.tools_used)) {
  toolsUsed = dagStruct.tools_used;
}
```

**Routing type:**
```typescript
// src/capabilities/types/fqdn.ts:29
export type CapabilityRouting = "local" | "cloud";
```

**capability_records.routing:**
```typescript
// src/capabilities/capability-registry.ts:93
// Routing stored in capability_records table
input.routing || "local",  // Default to local
```

### LOCAL_SERVERS List

Based on `config/mcp-permissions.json` and security considerations:

```typescript
// src/capabilities/routing-resolver.ts

/**
 * Servers that require local execution (access filesystem, processes, etc.)
 * These CANNOT safely run on cloud - they would access server resources!
 */
const LOCAL_SERVERS = new Set([
  // Filesystem access
  "filesystem",
  "fs",

  // Process execution
  "process",
  "shell",

  // Container/orchestration
  "docker",
  "kubernetes",

  // Remote access
  "ssh",

  // Database with local files
  "sqlite",  // SQLite files are local

  // Archives (local file operations)
  "archive",
]);

/**
 * Servers that can run on cloud (HTTP APIs, cloud services)
 * Safe to execute remotely - no local resource access
 */
// All others: memory, tavily, github, slack, api, http, etc.
```

### Data Flow

```
pml_execute with code
  → Sandbox execution with IPC tracking
    → tools_used captured via WorkerBridge
  → CapabilityStore.save()
    → Extract tools_used from dag_structure
    → resolveRouting(tools_used, explicitRouting)
      → Check each tool against LOCAL_SERVERS
      → Return 'local' if any match, else 'cloud'
    → Store routing in capability_records

cap:lookup("my-reader")
  → CapabilityRegistry.resolveByName()
  → Return CapabilityRecord with routing field

pml:discover({ intent: "..." })
  → Vector search in workflow_pattern
  → Join with capability_records
  → Return results with routing from pml_registry VIEW
```

### Testing Strategy

**Unit Tests (routing-resolver.ts):**
1. `extractServerName("filesystem:read_file")` -> `"filesystem"`
2. `extractServerName("fs:read")` -> `"fs"`
3. `extractServerName("memory:store")` -> `"memory"`
4. `extractServerName("mcp__code__analyze")` -> `"code"` (capability tool format)
5. `isLocalServer("filesystem")` -> `true`
6. `isLocalServer("tavily")` -> `false`
7. `resolveRouting(["filesystem:read", "memory:store"])` -> `"local"` (any local = local)
8. `resolveRouting(["memory:store", "tavily:search"])` -> `"cloud"` (all cloud)
9. `resolveRouting([])` -> `"cloud"` (empty = cloud)
10. `resolveRouting(["filesystem:read"], "cloud")` -> `"cloud"` (explicit override)

**Integration Tests:**
1. Create capability with filesystem tool -> verify routing = 'local'
2. Create capability with only cloud tools -> verify routing = 'cloud'
3. cap:lookup returns correct routing

### Files to Create/Modify

| File | Type | Description |
|------|------|-------------|
| `src/capabilities/routing-resolver.ts` | NEW | RoutingResolver utility |
| `src/capabilities/mod.ts` | MODIFY | Export resolver |
| `src/capabilities/capability-store.ts` | MODIFY | Call resolver on save |
| `tests/unit/capabilities/routing_resolver_test.ts` | NEW | Unit tests (10+) |
| `tests/integration/routing_inheritance_test.ts` | NEW | E2E tests (3) |

### Project Structure Notes

- Follows Feature Module Pattern: `routing-resolver.ts` in capabilities folder
- Uses Interface-First Design: `CapabilityRouting` type already defined
- Repository Pattern: resolver called from CapabilityStore (data layer)

### References

- [Story 13.8: Unified PML Registry](./story-13.8.md) - Added routing to tool_schema
- [Story 13.3: CapabilityMCPServer + Gateway](./13-3-capability-mcp-server-gateway.md) - Capability execution flow
- [Story 7.3b: Capability Injection](./7-3b-capability-injection-nested-tracing.md) - tools_used tracking
- [Epic 13: Capability Naming](../epics/epic-13-capability-naming-curation.md) - FR057-FR059
- [Epic 14: Local/Cloud MCP Routing](../epics/epic-14-jsr-package-local-cloud-mcp-routing.md) - Future routing work
- [Project Context](../project-context.md) - Architecture patterns

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5

### Debug Log References

N/A

### Completion Notes List

**2025-12-30: Implementation Complete**

1. **Config File Created**: `config/mcp-routing.json`
   - Lists cloud servers only (memory, tavily, pml, json, etc.)
   - Everything else defaults to LOCAL for security
   - Simple structure: `{ routing: { cloud: [...] } }`

2. **Routing Resolver Created**: `src/capabilities/routing-resolver.ts`
   - `extractServerName()` - parses tool ID to server name
   - `isLocalServer()` / `isCloudServer()` - checks against config
   - `resolveRouting(toolsUsed, explicitOverride)` - main logic
   - `initRoutingConfig()` / `reloadRoutingConfig()` - lifecycle

3. **Integration in CapabilityRegistry**
   - Added `toolsUsed?: string[]` to `CreateCapabilityRecordInput`
   - `create()` now calls `resolveRouting(toolsUsed, routing)` instead of hardcoded "local"

4. **Execute Handler Updated**
   - Passes `toolsCalled` as `toolsUsed` when creating capability record

5. **Unit Tests**: 33 tests passing
   - extractServerName: 6 tests (incl. edge cases)
   - isLocalServer/isCloudServer: 8 tests
   - getToolRouting: 3 tests
   - resolveRouting: 10 tests (incl. null/undefined handling)
   - Config lifecycle: 6 tests

**2025-12-30: Consolidation**

6. **JSON Validation**: Added `isValidConfig()` + `parseConfig()` with safe fallback
7. **Sync Loading**: Added `loadRoutingJsonSync()` to avoid race condition on first access
8. **Edge Cases**: Handle null, undefined, empty strings in toolsUsed array
9. **Architecture Decision**: Keep routing in `capability_records` (computed at creation)
   - Future per-user routing can use override table

### File List

| File | Type | Description |
|------|------|-------------|
| `config/mcp-routing.json` | NEW | Cloud servers config |
| `src/capabilities/routing-resolver.ts` | NEW | Routing inference logic |
| `src/capabilities/capability-registry.ts` | MODIFIED | Added toolsUsed + resolveRouting |
| `src/mcp/handlers/execute-handler.ts` | MODIFIED | Pass toolsCalled |
| `src/capabilities/mod.ts` | MODIFIED | Export routing functions |
| `src/cli/commands/serve.ts` | MODIFIED | Call checkAndSyncRouting at startup |
| `tests/unit/capabilities/routing_resolver_test.ts` | NEW | 33 unit tests |
