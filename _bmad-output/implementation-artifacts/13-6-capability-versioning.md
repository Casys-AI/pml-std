# Story 13.6: Capability Versioning

Status: deferred

## Deferral Reason

**Deferred on 2025-12-26** - This story requires the ability to modify capability code, which
doesn't exist yet.

**Prerequisites needed:**

1. `cap:update` tool to modify code of an existing capability
2. Dry-mode execution to validate new code before saving

**Current state:**

- Capabilities are created during execution (`pml_execute`)
- Code is immutable after creation (deduplication by `code_hash`)
- Only `display_name` and `description` can be modified (via `cap:rename` in Story 13.5)

**Versioning without code modification has no value** - there's nothing to version if code can't
change.

---

## Original Story (for future reference)

## Story

As a **developer**, I want **to track capability versions and call specific versions**, So that **I
can maintain backward compatibility and audit changes over time**.

## Phase Context

**Phase 3:** Versioning & History (Epic 13) **Dependencies:** Story 13.1 (Schema), Story 13.2
(pml_execute naming), Story 13.5 (cap:* tools)

## Requirements Coverage

This story implements **FR041-FR043** from Epic 13:

- **FR041:** A `capability_versions` table must track version history
- **FR042:** The system must support version specifiers: `@v1`, `@v1.2.0`, `@2025-12-22`
- **FR043:** Default resolution must use `@latest`

## Acceptance Criteria

### AC1: Version Table Creation

**Given** migration 026 executed **When** schema applied **Then** `capability_versions` table
created with columns:

- `id` (SERIAL PRIMARY KEY)
- `capability_fqdn` (TEXT NOT NULL, FK to capability_records.id)
- `version` (INTEGER NOT NULL)
- `version_tag` (TEXT, nullable for semantic versions)
- `code_snippet` (TEXT NOT NULL)
- `parameters_schema` (JSONB)
- `updated_by` (TEXT NOT NULL)
- `updated_at` (TIMESTAMPTZ NOT NULL)
- `change_summary` (TEXT)

### AC2: Auto-versioning on Update

**Given** capability at version 2 **When** `code_snippet` is updated via CapabilityRegistry **Then**
version incremented to 3 AND previous version (v2 state) saved to capability_versions

### AC3: Semantic Version Tags

**Given** capability update with `version_tag: "v1.2.0"` provided **When** save executed **Then**
`version_tag` stored alongside numeric version in both `capability_records` and
`capability_versions`

### AC4: Version Specifier @v1 (Major)

**Given** capability with versions 1, 2, 3 (all tagged v1.x.x) **When** `my-reader@v1` called via
pml_execute **Then** executes highest version with v1.x.x tag (version 3)

### AC5: Version Specifier @v1.2.0 (Exact)

**Given** capability with version_tag "v1.2.0" at version 2 **When** `my-reader@v1.2.0` called via
pml_execute **Then** executes exact version matching that tag (version 2 code)

### AC6: Version Specifier @latest (Default)

**Given** capability with multiple versions (1, 2, 3) **When** `my-reader@latest` or `my-reader`
called **Then** executes highest version number (version 3)

### AC7: Version Specifier @date

**Given** capability versions created at different dates:

- version 1: 2025-12-20
- version 2: 2025-12-22
- version 3: 2025-12-25 **When** `my-reader@2025-12-22` called **Then** executes version 2 (the
  version current on that date)

### AC8: Version Not Found Error

**Given** capability without version 5 **When** `my-reader@v5` called **Then** returns error:
"Version v5 not found for 'my-reader'"

### AC9: cap:history Tool

**Given** capability with 5 versions **When** `cap:history({ name: "my-reader" })` called **Then**
returns array of versions: `[{ version, versionTag, updatedAt, updatedBy, changeSummary }]`

### AC10: Immutable Versions

**Given** saved version in `capability_versions` table **When** any UPDATE attempted on that row
**Then** rejected (append-only table) - enforced via TRIGGER or application logic

## Architecture

### Design Decision: Append-Only Version History

The `capability_versions` table is **append-only**:

- No UPDATE or DELETE allowed on historical versions
- This provides audit trail and reproducibility
- Enforced via database trigger (preferred) or application validation

### Data Flow: Version Resolution

```
pml_execute({ capability: "my-reader@v1.2.0" })
  → parseVersionSpecifier("my-reader@v1.2.0")
    → { name: "my-reader", specifier: "v1.2.0", type: "exact" }
  → CapabilityRegistry.resolveByName("my-reader", scope)
    → Get current FQDN: "local.default.fs.read_json.a7f3"
  → VersionResolver.resolve(fqdn, specifier)
    → Query capability_versions WHERE version_tag = "v1.2.0"
    → Return historical code_snippet from that version
  → Execute code_snippet with args
```

### Version Specifier Parsing

```typescript
interface VersionSpecifier {
  name: string; // "my-reader"
  specifier: string; // "v1.2.0", "v1", "2025-12-22", "latest"
  type: "exact" | "major" | "date" | "latest";
}

function parseVersionSpecifier(input: string): VersionSpecifier {
  const match = input.match(/^(.+?)@(.+)$/);
  if (!match) return { name: input, specifier: "latest", type: "latest" };

  const [, name, spec] = match;

  // Exact semantic version: @v1.2.0
  if (/^v\d+\.\d+\.\d+$/.test(spec)) {
    return { name, specifier: spec, type: "exact" };
  }
  // Major version: @v1
  if (/^v\d+$/.test(spec)) {
    return { name, specifier: spec, type: "major" };
  }
  // Date: @2025-12-22
  if (/^\d{4}-\d{2}-\d{2}$/.test(spec)) {
    return { name, specifier: spec, type: "date" };
  }
  // Latest (explicit)
  if (spec === "latest") {
    return { name, specifier: "latest", type: "latest" };
  }
  // Unknown specifier - treat as exact tag match
  return { name, specifier: spec, type: "exact" };
}
```

### SQL Schema (Migration 026)

```sql
-- capability_versions: Append-only version history
CREATE TABLE capability_versions (
  id SERIAL PRIMARY KEY,
  capability_fqdn TEXT NOT NULL REFERENCES capability_records(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  version_tag TEXT,
  code_snippet TEXT NOT NULL,
  parameters_schema JSONB,
  updated_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  change_summary TEXT,

  CONSTRAINT uq_capability_version UNIQUE (capability_fqdn, version)
);

-- Index for version lookups
CREATE INDEX idx_capability_versions_fqdn ON capability_versions(capability_fqdn);
CREATE INDEX idx_capability_versions_tag ON capability_versions(version_tag);
CREATE INDEX idx_capability_versions_date ON capability_versions(updated_at);

-- Prevent modifications to historical versions (append-only)
CREATE OR REPLACE FUNCTION prevent_version_modification()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE' OR TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'capability_versions is append-only. Modifications not allowed.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_capability_versions_immutable
  BEFORE UPDATE OR DELETE ON capability_versions
  FOR EACH ROW EXECUTE FUNCTION prevent_version_modification();
```

### Version Resolution Queries

```sql
-- @latest: Get current version from capability_records
SELECT cr.*, wp.code_snippet, wp.parameters_schema
FROM capability_records cr
JOIN workflow_pattern wp ON cr.workflow_pattern_id = wp.pattern_id
WHERE cr.id = :fqdn;

-- @v1.2.0: Get exact version by tag
SELECT cv.*
FROM capability_versions cv
WHERE cv.capability_fqdn = :fqdn
  AND cv.version_tag = :versionTag
LIMIT 1;

-- @v1: Get highest version matching major (v1.x.x)
SELECT cv.*
FROM capability_versions cv
WHERE cv.capability_fqdn = :fqdn
  AND cv.version_tag LIKE 'v1.%'  -- Matches v1.0.0, v1.2.0, etc.
ORDER BY cv.version DESC
LIMIT 1;

-- @2025-12-22: Get version current on that date
SELECT cv.*
FROM capability_versions cv
WHERE cv.capability_fqdn = :fqdn
  AND cv.updated_at <= :date::timestamptz + interval '1 day'
ORDER BY cv.version DESC
LIMIT 1;

-- cap:history: Get all versions
SELECT cv.version, cv.version_tag, cv.updated_at, cv.updated_by, cv.change_summary
FROM capability_versions cv
WHERE cv.capability_fqdn = :fqdn
ORDER BY cv.version DESC;
```

## Tasks / Subtasks

- [ ] Task 1: Create migration 026_capability_versions (AC: #1, #10)
  - [ ] 1.1: Create `capability_versions` table with all columns
  - [ ] 1.2: Add unique constraint on (capability_fqdn, version)
  - [ ] 1.3: Create indexes (fqdn, tag, date)
  - [ ] 1.4: Add trigger to prevent UPDATE/DELETE (immutable)
  - [ ] 1.5: Unit test: verify table creation and trigger behavior

- [ ] Task 2: Implement auto-versioning on update (AC: #2, #3)
  - [ ] 2.1: Add `saveVersion()` method to CapabilityRegistry
  - [ ] 2.2: Modify capability update flow to save previous state before update
  - [ ] 2.3: Support optional `versionTag` and `changeSummary` params
  - [ ] 2.4: Unit tests: version increment, tag storage

- [ ] Task 3: Implement version specifier parsing (AC: #4, #5, #6, #7, #8)
  - [ ] 3.1: Create `parseVersionSpecifier()` function
  - [ ] 3.2: Create `VersionResolver` class with `resolve(fqdn, specifier)` method
  - [ ] 3.3: Implement resolution for each type: exact, major, date, latest
  - [ ] 3.4: Return appropriate error for not found versions
  - [ ] 3.5: Unit tests for each specifier type

- [ ] Task 4: Integrate versioning into pml_execute (AC: #4, #5, #6, #7)
  - [ ] 4.1: Parse version specifier from capability name in execute-handler
  - [ ] 4.2: Call VersionResolver to get correct code_snippet
  - [ ] 4.3: Execute with versioned code
  - [ ] 4.4: Unit tests: versioned execution

- [ ] Task 5: Implement cap:history tool (AC: #9)
  - [ ] 5.1: Add `handleHistory()` method to CapModule (lib/std/cap.ts)
  - [ ] 5.2: Query capability_versions for all versions
  - [ ] 5.3: Format response with version, tag, date, author, summary
  - [ ] 5.4: Add cap:history to listTools() in PmlStdServer
  - [ ] 5.5: Unit tests (2 tests)

- [ ] Task 6: End-to-end tests
  - [ ] 6.1: E2E test: create capability, update twice, verify versions
  - [ ] 6.2: E2E test: call by @v1.0.0, @v1, @latest, @date
  - [ ] 6.3: E2E test: cap:history returns correct version list

## Dev Notes

### Files to Create

| File                                               | Description                                       |
| -------------------------------------------------- | ------------------------------------------------- |
| `src/db/migrations/026_capability_versions.ts`     | Migration for capability_versions table + trigger |
| `src/capabilities/version-resolver.ts`             | VersionResolver class + parseVersionSpecifier()   |
| `tests/unit/capabilities/version-resolver_test.ts` | Unit tests for version resolution                 |

### Files to Modify

| File                                      | Changes                                                |
| ----------------------------------------- | ------------------------------------------------------ |
| `src/capabilities/capability-registry.ts` | Add `saveVersion()`, modify update to auto-version     |
| `src/mcp/handlers/execute-handler.ts`     | Parse version specifier, use VersionResolver           |
| `lib/std/cap.ts`                          | Add `handleHistory()` method, add cap:history to tools |

### Previous Story Patterns (from 13.5)

- **CapModule pattern:** Add handler method + add to listTools() + add to switch in call()
- **Registry access:** Use existing CapabilityRegistry methods where possible
- **SQL queries:** Use parameterized queries via db.query()
- **Error handling:** Return `{ isError: true, content: [...] }` for MCP errors

### Key Decisions

1. **Immutability via trigger:** Using PostgreSQL trigger is more robust than application-level
   validation
2. **Major version matching:** `@v1` matches any `v1.x.x` tag using LIKE pattern
3. **Date resolution:** Uses end of day (+ 1 day interval) for inclusive matching
4. **Code storage:** Version history stores full `code_snippet`, not diffs (simpler, more reliable)

### Project Context References

- **Deno 2.x runtime** - Use @std/assert for tests
- **PGlite database** - Single migration file pattern
- **camelCase everywhere** - Column names in SQL, property names in TypeScript
- **Drizzle-style migrations** - Export function returning Migration interface

### References

- [Epic: docs/epics/epic-13-capability-naming-curation.md#story-136-capability-versioning]
- [Tech Spec: docs/tech-specs/tech-spec-capability-naming-curation.md#ac13-versioning]
- [Source: src/capabilities/capability-registry.ts] - Base registry class
- [Source: src/mcp/handlers/execute-handler.ts] - pml_execute handler
- [Source: lib/std/cap.ts] - CapModule pattern from Story 13.5
- [Source: src/db/migrations/021_capability_records.ts] - Migration pattern

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List
