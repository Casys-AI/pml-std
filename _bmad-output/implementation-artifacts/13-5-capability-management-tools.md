# Story 13.5: Capability Management Tools

Status: done

## Story

As a **Claude agent**, I want **tools to list, rename, and inspect capabilities**, So that **I can
manage and discover capabilities in the registry**.

## Consolidation Note

**Merged from:** Original 13.4 (Curation) + 13.5 (Discovery & Query) + part of 13.7 (cap:rename)

**Simplified scope:** Focus on essential management tools, defer LLM auto-curation.

## Acceptance Criteria

### AC1: cap:list Basic

**Given** 10 capabilities in the registry **When** `cap:list({})` called **Then** returns all 10
with: `id`, `name`, `description`, `usageCount`, `namespace`, `action`

### AC2: cap:list Filter by Pattern

**Given** capabilities with various names **When** `cap:list({ pattern: "fs:*" })` called **Then**
returns only matching capabilities

### AC3: cap:list Filter Unnamed Only

**Given** mix of named and unnamed capabilities **When** `cap:list({ unnamed_only: true })` called
**Then** returns only `unnamed_*` capabilities

### AC4: cap:list Pagination

**Given** 100 capabilities **When** `cap:list({ limit: 10, offset: 20 })` called **Then** returns
capabilities 21-30 with `total: 100` for pagination UI

### AC5: cap:rename Basic

**Given** capability with name "old-reader" **When**
`cap:rename({ name: "old-reader", newName: "json-reader" })` called **Then** capability renamed,
alias created for "old-reader"

### AC6: cap:rename with Description

**Given** capability exists **When**
`cap:rename({ name: "x", newName: "y", description: "Reads JSON files" })` called **Then** name AND
description updated

### AC7: cap:rename Collision Error

**Given** capability "json-reader" already exists **When**
`cap:rename({ name: "old", newName: "json-reader" })` called **Then** returns error "Name
'json-reader' already exists"

### AC8: cap:lookup

**Given** capability named "json-reader" **When** `cap:lookup({ name: "json-reader" })` called
**Then** returns `{ fqdn, displayName, description, usageCount, successRate }`

### AC9: cap:lookup via Alias

**Given** capability renamed from "old-reader" to "json-reader" **When**
`cap:lookup({ name: "old-reader" })` called **Then** returns capability with warning "Using
deprecated alias"

### AC10: cap:whois

**Given** capability FQDN **When** `cap:whois({ fqdn: "local.default.fs.read_json.a7f3" })` called
**Then** returns complete CapabilityRecord with all metadata

## Tools Summary

| Tool         | Purpose                | Key Params                                       |
| ------------ | ---------------------- | ------------------------------------------------ |
| `cap:list`   | List capabilities      | `pattern?`, `unnamed_only?`, `limit?`, `offset?` |
| `cap:rename` | Rename capability      | `name`, `newName`, `description?`                |
| `cap:lookup` | Resolve name → details | `name`                                           |
| `cap:whois`  | Full metadata          | `fqdn`                                           |

## Architecture

### Design: lib/std/mcp/ (Original Epic Design)

Séparation claire des responsabilités :

- **CapabilityMCPServer** (Story 13.3) → Execute capabilities (`mcp__*`)
- **lib/std/mcp/cap.ts** (This story) → Manage registry (`cap:*`)

```
lib/std/mcp/
  mod.ts       # PmlStdServer - routes cap:* calls
  cap.ts       # cap:list, cap:rename, cap:lookup, cap:whois handlers
  types.ts     # CapListOptions, CapListItem, etc.
```

### PmlStdServer Integration

```typescript
// lib/std/mcp/mod.ts
import { CapModule } from "./cap.ts";

export class PmlStdServer implements MCPServer {
  readonly serverId = "pml-std";
  private cap: CapModule;

  constructor(private registry: CapabilityRegistry) {
    this.cap = new CapModule(registry);
  }

  async listTools(): Promise<Tool[]> {
    return this.cap.listTools();
  }

  async callTool(name: string, args: unknown): Promise<ToolResult> {
    if (name.startsWith("cap:")) {
      return this.cap.call(name, args);
    }
    throw new Error(`Unknown tool: ${name}`);
  }
}
```

### Cap Module

```typescript
// lib/std/mcp/cap.ts
export class CapModule {
  constructor(private registry: CapabilityRegistry) {}

  listTools(): Tool[] {
    return [
      { name: "cap:list", description: "List capabilities", inputSchema: {...} },
      { name: "cap:rename", description: "Rename a capability", inputSchema: {...} },
      { name: "cap:lookup", description: "Lookup capability by name", inputSchema: {...} },
      { name: "cap:whois", description: "Get full capability metadata", inputSchema: {...} },
    ];
  }

  async call(name: string, args: unknown): Promise<ToolResult> {
    switch (name) {
      case "cap:list": return this.handleList(args);
      case "cap:rename": return this.handleRename(args);
      case "cap:lookup": return this.handleLookup(args);
      case "cap:whois": return this.handleWhois(args);
      default: throw new Error(`Unknown cap tool: ${name}`);
    }
  }
}

### Data Flow
```

cap:list({ pattern: "fs:_" }) → CapModule.handleList() → CapabilityRegistry.list({ pattern: "fs:_"
}) → Format response ← { items: [...], total: 100, limit: 50, offset: 0 }

cap:rename({ name: "old", newName: "new" }) → CapModule.handleRename() →
CapabilityRegistry.resolveByName("old") → get FQDN → Check collision:
CapabilityRegistry.existsByName("new", scope) → CapabilityRegistry.updateDisplayName(fqdn, "new",
description?) → CapabilityRegistry.createAlias("old", fqdn) ← { success: true, fqdn: "..."
(unchanged), aliasCreated: true }

````
**CRITICAL: FQDN is immutable (like an IP address)**
- `cap:rename` only updates `display_name` column
- FQDN (`local.default.fs.read_json.a7f3`) NEVER changes
- Alias points old display_name → same FQDN

### Types

```typescript
// Input/Output types for cap:* tools

interface CapListOptions {
  pattern?: string;      // Glob pattern (e.g., "fs:*")
  unnamedOnly?: boolean; // Only unnamed_* capabilities
  limit?: number;        // Default: 50
  offset?: number;       // Default: 0
}

interface CapListItem {
  id: string;            // FQDN
  name: string;          // display_name
  description: string | null;
  namespace: string;
  action: string;
  usageCount: number;
  successRate: number;
}

interface CapRenameOptions {
  name: string;          // Current name or FQDN
  newName: string;       // New display_name
  description?: string;  // Optional description update
}

interface CapListResponse {
  items: CapListItem[];
  total: number;         // Total count for pagination UI
  limit: number;
  offset: number;
}

interface CapLookupResult {
  fqdn: string;
  displayName: string;
  description: string | null;
  usageCount: number;
  successRate: number;
  isAlias?: boolean;     // True if resolved via deprecated alias
}
````

## Tasks / Subtasks

- [x] Task 1: Create lib/std/cap.ts (AC: all)
  - [x] 1.1: Create `lib/std/cap.ts` with CapModule and PmlStdServer classes
  - [x] 1.2: Follow lib/std/ architecture (single file per module)
  - [x] 1.3: Include all types inline (CapListOptions, CapListItem, etc.)

- [x] Task 2: Implement cap:list (AC: #1, #2, #3, #4)
  - [x] 2.1: Add `handleList()` in CapModule
  - [x] 2.2: Pattern filter (glob → SQL LIKE conversion via globToSqlLike())
  - [x] 2.3: `unnamedOnly` filter (`display_name LIKE 'unnamed_%'`)
  - [x] 2.4: Pagination with `total` count using COUNT(*) OVER()
  - [x] 2.5: Unit tests (4 tests)

- [x] Task 3: Implement cap:rename (AC: #5, #6, #7)
  - [x] 3.1: Add `handleRename()` in CapModule
  - [x] 3.2: Add `existsByName()` for collision detection
  - [x] 3.3: Add `updateDisplayName()` - FQDN stays immutable!
  - [x] 3.4: Create alias via existing `createAlias()` after display_name update
  - [x] 3.5: Unit tests (3 tests)

- [x] Task 4: Implement cap:lookup (AC: #8, #9)
  - [x] 4.1: Add `handleLookup()` in CapModule
  - [x] 4.2: Use existing `resolveByName()` from CapabilityRegistry
  - [x] 4.3: Add alias warning in response
  - [x] 4.4: Unit tests (3 tests)

- [x] Task 5: Implement cap:whois (AC: #10)
  - [x] 5.1: Add `handleWhois()` in CapModule
  - [x] 5.2: Return full CapabilityRecord with aliases
  - [x] 5.3: Unit tests (2 tests)

- [x] Task 6: Gateway integration
  - [x] 6.1: Add PmlStdServer to GatewayServer
  - [x] 6.2: Route cap:* calls to PmlStdServer
  - [x] 6.3: Include cap:* tools in listTools()
  - [x] 6.4: Unit tests pass (21 tests total)

## Dev Notes

### Files Created (Actual Implementation)

| File                             | Description                                                                  |
| -------------------------------- | ---------------------------------------------------------------------------- |
| `lib/std/cap.ts`                 | CapModule + PmlStdServer + all types (single file, follows lib/std/ pattern) |
| `tests/unit/lib/std/cap_test.ts` | 21 unit tests covering all ACs                                               |

**Note:** Original design proposed `lib/std/mcp/` directory structure, but implementation uses
single file following existing `lib/std/*.ts` pattern (algo.ts, crypto.ts, etc.).

### Files Modified

| File                        | Changes                                                                                      |
| --------------------------- | -------------------------------------------------------------------------------------------- |
| `src/mcp/gateway-server.ts` | Import PmlStdServer, init in constructor, add to listTools(), route cap:* in routeToolCall() |

### Architecture Decision: Methods in CapModule (not Registry)

**Original plan:** Add `list()`, `updateDisplayName()`, `existsByName()` to CapabilityRegistry.

**Actual implementation:** These are **private methods in CapModule** (`lib/std/cap.ts`):

- `existsByName()` - Direct SQL query for collision detection
- `updateDisplayName()` - Direct SQL UPDATE (FQDN immutable)
- List logic embedded in `handleList()` with custom SQL

**Rationale:** Keeps CapabilityRegistry focused on core CRUD + alias resolution. Management-specific
queries stay in CapModule.

### Existing Infrastructure Used (from Story 13.1, 13.3)

**CapabilityRegistry** (`src/capabilities/capability-registry.ts`):

- ✅ `resolveByName(name, scope)` - Used in cap:rename, cap:lookup
- ✅ `createAlias(org, project, alias, targetFqdn)` - Used in cap:rename
- ✅ `getByFqdn(fqdn)` - Used in cap:whois
- ✅ `getAliases(fqdn)` - Used in cap:whois
- ⚠️ `rename()` - NOT used (creates new FQDN, we need display_name update only)

**CapabilityMCPServer** (`src/mcp/capability-server/server.ts`):

- Handles `mcp__*` tool calls (execute capabilities)
- Separate from cap:* management tools

### Pattern Matching

For `cap:list({ pattern: "fs:*" })`:

**Glob → SQL LIKE conversion (in CapModule, NOT in SQL):**

```typescript
// lib/std/mcp/cap.ts
function globToSqlLike(pattern: string): string {
  // Escape SQL special chars first, then convert glob
  return pattern
    .replace(/%/g, "\\%") // Escape existing %
    .replace(/_/g, "\\_") // Escape existing _
    .replace(/\*/g, "%") // Glob * → SQL %
    .replace(/\?/g, "_"); // Glob ? → SQL _
}

// Examples:
// "fs:*"       → "fs:%"
// "read_?"     → "read\__"  (first _ escaped, second from ?)
// "api:get_*"  → "api:get\\_%"
```

**Alternative: Regex in TypeScript (if glob patterns get complex):**

```typescript
function matchPattern(name: string, pattern: string): boolean {
  // Convert glob to regex: "fs:*" → /^fs:.*$/
  const regex = new RegExp(
    "^" + pattern.replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
  );
  return regex.test(name);
}
```

### SQL Queries

```sql
-- cap:list with pattern (includes total for pagination)
SELECT cr.id, cr.display_name, cr.namespace, cr.action,
       cr.usage_count, cr.success_count,
       wp.description,
       COUNT(*) OVER() as total  -- Window function for total count
FROM capability_records cr
LEFT JOIN workflow_pattern wp ON cr.workflow_pattern_id = wp.pattern_id
WHERE cr.display_name LIKE :pattern  -- 'fs:%' after glob→SQL conversion
  AND cr.org = :org AND cr.project = :project
ORDER BY cr.usage_count DESC
LIMIT :limit OFFSET :offset;

-- cap:list unnamed only
SELECT ... WHERE cr.display_name LIKE 'unnamed\_%' ESCAPE '\';

-- existsByName: Check name collision before rename
SELECT 1 FROM capability_records
WHERE display_name = :name AND org = :org AND project = :project
LIMIT 1;

-- updateDisplayName: Rename capability (FQDN stays immutable!)
UPDATE capability_records
SET display_name = :newName,
    updated_at = NOW(),
    updated_by = :userId
WHERE id = :fqdn;  -- FQDN is the immutable primary key

-- Optional: Update description in workflow_pattern
UPDATE workflow_pattern
SET description = :description
WHERE pattern_id = (
  SELECT workflow_pattern_id FROM capability_records WHERE id = :fqdn
);
```

### References

- [Epic: docs/epics/epic-13-capability-naming-curation.md]
- [Tech Spec: docs/tech-specs/tech-spec-capability-naming-curation.md]
- [Source: src/capabilities/capability-registry.ts] - resolveByName (L178), createAlias (L267),
  listByScope (L402)
- [Source: src/mcp/capability-server/mod.ts] - CapabilityMCPServer (Story 13.3)
- [Source: src/capabilities/types.ts] - CapabilityRecord, Scope, CapabilityAlias
- [Source: src/mcp/gateway-server.ts] - Gateway integration pattern (L400)

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5

### Debug Log References

N/A

### Completion Notes List

1. **Architecture simplified:** Instead of lib/std/mcp/ directory, used single file `lib/std/cap.ts`
   following existing lib/std/ pattern (algo.ts, crypto.ts, etc.)

2. **CapModule:** Handles all cap:* tool calls with proper error handling and logging

3. **PmlStdServer:** Minimal wrapper that routes cap:* calls to CapModule

4. **globToSqlLike():** Converts glob patterns to SQL LIKE (escapes % and _, converts * to % and ?
   to _)

5. **Gateway integration:** PmlStdServer initialized in constructor, cap:* tools added to
   listTools(), routing added to routeToolCall()

6. **Tests:** 25 unit tests covering all 10 ACs (21 original + 4 code review fixes)

### File List

| File                                                        | Action   | Description                                         |
| ----------------------------------------------------------- | -------- | --------------------------------------------------- |
| `lib/std/cap.ts`                                            | Created  | CapModule + PmlStdServer + types (~440 lines)       |
| `tests/unit/lib/std/cap_test.ts`                            | Created  | 25 unit tests                                       |
| `src/mcp/gateway-server.ts`                                 | Modified | Import PmlStdServer, init, listTools, routeToolCall |
| `docs/sprint-artifacts/13-5-capability-management-tools.md` | Modified | Status → done                                       |
| `docs/sprint-artifacts/sprint-status.yaml`                  | Modified | Status → done                                       |

## Senior Developer Review (AI)

**Reviewer:** Claude Opus 4.5 **Date:** 2025-12-26 **Outcome:** ✅ APPROVED (with 5 issues fixed)

### Issues Found & Fixed

| ID | Severity | Issue                                                                                     | Fix Applied                                                   |
| -- | -------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| H1 | HIGH     | Story Dev Notes claimed capability-registry.ts modifications but methods are in CapModule | Updated Dev Notes to reflect actual architecture              |
| M1 | MEDIUM   | Double DB call in cap:lookup (resolveByName + resolveByAlias redundant)                   | Optimized: detect alias via `displayName !== name` comparison |
| M2 | MEDIUM   | Missing edge case tests for globToSqlLike (empty, SQL injection, unicode)                 | Added 3 new tests (24 total)                                  |
| M3 | MEDIUM   | Hardcoded DEFAULT_SCOPE limitation not documented                                         | Added JSDoc explaining MVP scope limitation                   |
| M4 | MEDIUM   | No validation of newName in cap:rename before SQL update                                  | Added `isValidMCPName(newName)` validation + test             |

### Validation Summary

- **All 10 ACs:** ✅ Implemented and tested
- **All 6 Tasks:** ✅ Marked [x] with evidence in code
- **Tests:** 25 passing (was 21, +4 from code review)
- **Type Check:** ✅ `deno check lib/std/cap.ts` passes
- **Git vs Story:** ✅ File List matches git status

### Quality Notes

- Clean separation: CapModule handles management SQL, Registry stays focused on CRUD
- Good use of parameterized queries (no SQL injection risk)
- Proper error handling with typed responses
- Follows lib/std/ pattern (single file per module)
