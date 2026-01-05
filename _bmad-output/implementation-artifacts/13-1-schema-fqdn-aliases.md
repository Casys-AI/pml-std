# Story 13.1: Schema, FQDN & Aliases

Status: done

## Story

As a **PML developer**, I want **a capability registry with FQDN structure, rich metadata, and alias
support**, So that **capabilities have stable identities with full provenance tracking and rename
safety**.

## Acceptance Criteria

### AC1: Schema Creation (Migration 021)

**Given** the PGlite database **When** migration 021 is executed **Then** the `capability_records`
table is created with columns:

- Identity: `id` (FQDN primary key), `display_name`, `org`, `project`, `namespace`, `action`, `hash`
- Provenance: `created_by`, `created_at`, `updated_by`, `updated_at`
- Versioning: `version` (INTEGER DEFAULT 1), `version_tag` (TEXT, optional semantic version)
- Trust: `verified` (BOOLEAN DEFAULT FALSE), `signature` (TEXT, optional hash)
- Metrics: `usage_count`, `success_count`, `total_latency_ms`
- Metadata: `tags` (TEXT[]), `visibility` (TEXT: 'private'|'project'|'org'|'public'),
  `code_snippet`, `parameters_schema` (JSONB), `description`, `tools_used` (TEXT[]), `routing`
  (TEXT: 'local'|'cloud')

### AC2: Indexes

**Given** the capability_records table **When** schema is applied **Then** indexes exist for:

- `(org, project)` - Scope-based queries
- `(org, project, display_name)` - Name resolution within scope
- `namespace` - Namespace filtering
- `created_by` - Creator queries
- `tags` (GIN) - Tag-based search
- `visibility` - Access control filtering

### AC3: Aliases Table

**Given** the migration **When** executed **Then** `capability_aliases` table is created with
columns:

- `alias` (TEXT) - The old/alternative name
- `org` (TEXT) - Scoped to organization
- `project` (TEXT) - Scoped to project
- `target_fqdn` (TEXT REFERENCES capability_records(id)) - Points to actual capability
- `created_at` (TIMESTAMPTZ)
- PRIMARY KEY on `(org, project, alias)`

### AC4: FQDN Generation

**Given** capability with namespace "fs", action "read_json" **When** FQDN is generated with org
"local" and project "default" **Then** FQDN is `local.default.fs.read_json.<hash>` where hash is
4-char hex of content hash

### AC5: Display Name Extraction

**Given** FQDN `acme.webapp.fs.read_json.a7f3` **When** display name is requested **Then** returns
the user-provided name (free format, stored in `display_name` column)

### AC6: FQDN Parsing

**Given** FQDN string `acme.webapp.fs.read_json.a7f3` **When** parsed **Then** returns object with
`{ org: "acme", project: "webapp", namespace: "fs", action: "read_json", hash: "a7f3" }`

### AC7: Scope Resolution

**Given** short name "my-reader" and session context `{ org: "acme", project: "webapp" }` **When**
resolved **Then** searches matching records in current scope and returns matching FQDN

### AC8: Alias Resolution

**Given** call using old name after rename **When** lookup performed **Then** resolves via alias
table and logs warning about deprecated name

### AC9: Alias Chain Prevention

**Given** alias A → B, then B renamed to C **When** rename executed **Then** alias A updated to
point to C directly (no alias chains)

### AC10: Backward Compatibility

**Given** existing `workflow_pattern` table with capabilities **When** migration runs **Then**
existing data is preserved; new tables are additive (workflow_pattern NOT modified by this
migration)

## Tasks / Subtasks

- [x] Task 1: Create Migration 021 (AC: #1, #2, #3)
  - [x] 1.1: Create `capability_records` table with all identity, provenance, versioning, trust,
        metrics, and metadata columns
  - [x] 1.2: Create indexes for all required query patterns
  - [x] 1.3: Create `capability_aliases` table with foreign key constraint
  - [x] 1.4: Add migration to registry in `src/db/migrations.ts`
  - [x] 1.5: Test migration up/down idempotence
- [x] Task 2: Implement FQDN Utilities (AC: #4, #5, #6)
  - [x] 2.1: Create `src/capabilities/fqdn.ts` with types `FQDNComponents`, `CapabilityRecord`
  - [x] 2.2: Implement `generateFQDN(components: FQDNComponents): string`
  - [x] 2.3: Implement `parseFQDN(fqdn: string): FQDNComponents`
  - [x] 2.4: Implement `generateHash(code: string): string` (4-char hex)
  - [x] 2.5: Implement `isValidMCPName(name: string): boolean` - Validate MCP format (alphanumeric,
        underscores, hyphens, colons only)
  - [x] 2.6: Unit tests for generation, parsing, hash collision resistance, MCP name validation
- [x] Task 3: Implement CapabilityRegistry Class (AC: #7, #8, #9)
  - [x] 3.1: Create `src/capabilities/capability-registry.ts` with PGliteClient dependency
  - [x] 3.2: Implement `resolveByName(name: string, scope: Scope): Promise<CapabilityRecord | null>`
  - [x] 3.3: Implement
        `resolveByAlias(alias: string, scope: Scope): Promise<{record: CapabilityRecord, isAlias: boolean}>`
  - [x] 3.4: Implement `createAlias(org, project, alias, targetFqdn): Promise<void>`
  - [x] 3.5: Implement `updateAliasChains(oldFqdn, newFqdn): Promise<void>` for chain prevention
  - [x] 3.6: Add logging for alias usage with deprecation warnings
- [x] Task 4: Integration Tests (AC: #10)
  - [x] 4.1: Test migration preserves existing workflow_pattern data
  - [x] 4.2: Test FQDN generation with various inputs
  - [x] 4.3: Test scope resolution with ambiguous names
  - [x] 4.4: Test alias chain prevention scenario
  - [x] 4.5: Test concurrent alias creation

## Dev Notes

### Architecture Pattern: Dual-Table Strategy

This story introduces `capability_records` as a **new table** alongside existing `workflow_pattern`.
The strategy is:

1. **capability_records** - Registry with FQDN structure, versioning, visibility, provenance
2. **workflow_pattern** - Continues to store code, embeddings, execution stats
3. **Future migration (13.2)** - Links records via `capability_records.workflow_pattern_id` FK

**Rationale:** Additive approach avoids risky migrations on production data. The
`capability_records` table can be populated gradually as capabilities are named.

### FQDN Format

```
<org>.<project>.<namespace>.<action>.<hash>
```

Examples:

- `local.default.fs.read_json.a7f3` - Local dev capability
- `acme.webapp.api.fetch_user.b8e2` - Organization capability
- `marketplace.public.util.format_date.c9d1` - Public marketplace capability

### Hash Generation

Use first 4 chars of SHA-256 hex of `code_snippet` content:

```typescript
const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
const hex = Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
return hex.substring(0, 4); // "a7f3"
```

### Naming Convention

Per Epic 13 decisions:

- **Capability names are FREE FORMAT** - Users choose whatever they want
- **MCP format constraints only** - Must be valid MCP tool names:
  - Alphanumeric + underscores + hyphens + colons
  - No spaces, no special characters that break MCP protocol
  - Examples: `read_config`, `myapp:fetch_user`, `analytics-compute`, `fs:read_json`
- No enforced namespaces - `fs:`, `api:`, etc. are user choices, not system requirements
- No `dns:*` prefix (confusing with real DNS)
- No `learn:*` prefix (redundant)

### Session Context for Scope Resolution

```typescript
interface Scope {
  org: string; // "local" for self-hosted, org slug for cloud
  project: string; // Project identifier
}

// Resolution order:
// 1. Exact match in (org, project, display_name)
// 2. Alias match in capability_aliases
// 3. Public capability match (visibility = 'public')
```

### Alias Chain Prevention Algorithm

```sql
-- When B is renamed to C, update all aliases pointing to B:
UPDATE capability_aliases
SET target_fqdn = 'new.fqdn.c'
WHERE target_fqdn = 'old.fqdn.b';
```

### Project Structure Notes

| File                                                     | Purpose                                        |
| -------------------------------------------------------- | ---------------------------------------------- |
| `src/db/migrations/021_capability_records.ts`            | New migration                                  |
| `src/capabilities/fqdn.ts`                               | FQDN generation & parsing                      |
| `src/capabilities/capability-registry.ts`                | Registry class with name/alias resolution      |
| `src/capabilities/types.ts`                              | Add `CapabilityRecord`, `FQDNComponents` types |
| `tests/unit/capabilities/fqdn_test.ts`                   | Unit tests                                     |
| `tests/unit/capabilities/capability_registry_test.ts`    | Registry tests                                 |
| `tests/integration/capability_records_migration_test.ts` | Migration tests                                |

### Alignment with Unified Project Structure

- **Database:** PGlite with Drizzle ORM patterns (see project-context.md)
- **Imports:** Use `@std/*` for Deno std lib, `npm:` prefix for npm packages
- **Extensions:** Always `.ts` in imports
- **Naming:** camelCase for properties, PascalCase for types
- **Testing:** Deno.test with @std/assert

### References

- [Epic 13: Capability Naming & Curation](../epics/epic-13-capability-naming-curation.md) -
  FR035-FR040, AC1-AC10
- [Tech Spec: Capability Naming](../tech-specs/tech-spec-capability-naming-curation.md) - FQDN
  structure, DNS-like system
- [Project Context](../project-context.md) - Technology stack, coding patterns
- [Migration 011](../../src/db/migrations/011_capability_storage_migration.ts) - Existing
  workflow_pattern schema
- [CapabilityStore](../../src/capabilities/capability-store.ts) - Existing capability storage logic

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

- All 66 tests pass (41 unit FQDN + 16 unit Registry + 9 integration)
- Type-check passes for all new files
- Code review fixes applied: date correction, additional validation tests

### Completion Notes List

- ✅ Migration 021 created with capability_records and capability_aliases tables
- ✅ All indexes created per AC2 (scope, name, namespace, creator, tags GIN, visibility)
- ✅ FQDN utilities implemented with generateFQDN, parseFQDN, generateHash, isValidMCPName
- ✅ CapabilityRegistry class with resolveByName, resolveByAlias, createAlias, updateAliasChains
- ✅ Alias chain prevention implemented (A->B->C scenario tested)
- ✅ Deprecation warning logging for alias usage
- ✅ workflow_pattern data preservation verified (AC10)
- ✅ Concurrent alias creation tested with upsert behavior

### File List

New files:

- src/db/migrations/021_capability_records.ts
- src/capabilities/fqdn.ts
- src/capabilities/capability-registry.ts
- tests/unit/capabilities/fqdn_test.ts
- tests/unit/capabilities/capability_registry_test.ts
- tests/integration/capability_records_migration_test.ts

Modified files:

- src/db/migrations.ts (added import and registration)
- src/capabilities/types.ts (added FQDN types: FQDNComponents, Scope, CapabilityRecord,
  CapabilityAlias, AliasResolutionResult, CapabilityVisibility, CapabilityRouting)

### Change Log

- 2025-12-24: Story 13.1 implementation complete - FQDN schema, utilities, and registry class
- 2025-12-24: Code review fixes - added 3 validation tests, fixed changelog date
