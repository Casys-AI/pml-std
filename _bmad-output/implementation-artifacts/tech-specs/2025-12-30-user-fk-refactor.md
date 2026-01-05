# Tech Spec: User Foreign Key Refactor

**Date**: 2025-12-30
**Status**: Proposed
**Priority**: Low (future enhancement)

## Problem Statement

Currently, 6 tables use TEXT columns for user references with `'local'` as a default value:

| Table | Columns | Type |
|-------|---------|------|
| `workflow_execution` | user_id, created_by | TEXT |
| `execution_trace` | user_id, created_by | TEXT |
| `entropy_history` | user_id | TEXT |
| `capability_records` | created_by | TEXT |
| `shgat_params` | user_id | TEXT |
| `workflow_pattern` | created_by | TEXT |

This approach has limitations:
1. No referential integrity - can reference non-existent users
2. No CASCADE DELETE when users are removed
3. Inconsistent with proper relational design
4. `'local'` is a magic string, not a real user entity

## Proposed Solution

### Phase 1: Create System User

Create a "local" system user in the `users` table during database initialization:

```sql
INSERT INTO users (id, username, email, role, created_at)
VALUES (
  '00000000-0000-0000-0000-000000000000',  -- Well-known UUID
  'local',
  'local@system.internal',
  'system',
  NOW()
) ON CONFLICT (id) DO NOTHING;
```

### Phase 2: Migrate Columns to UUID

For each affected table:

```sql
-- 1. Add new UUID column
ALTER TABLE {table} ADD COLUMN {column}_uuid UUID;

-- 2. Populate from users table (match by username)
UPDATE {table} t
SET {column}_uuid = u.id
FROM users u
WHERE t.{column} = u.username;

-- 3. Set default to system user for 'local'
UPDATE {table}
SET {column}_uuid = '00000000-0000-0000-0000-000000000000'
WHERE {column} = 'local' AND {column}_uuid IS NULL;

-- 4. Drop old column, rename new
ALTER TABLE {table} DROP COLUMN {column};
ALTER TABLE {table} RENAME COLUMN {column}_uuid TO {column};

-- 5. Add FK constraint
ALTER TABLE {table}
ADD CONSTRAINT fk_{table}_{column}
FOREIGN KEY ({column}) REFERENCES users(id)
ON DELETE SET NULL;  -- Or CASCADE depending on requirements
```

### Phase 3: Update Application Code

1. Update all queries to use UUID instead of TEXT
2. Update `src/lib/auth.ts` to return system user UUID in local mode
3. Update all stores/services that reference user columns

## Impact Analysis

### Tables Affected
- 6 tables with 9 total columns

### Code Changes Required

| File | Change |
|------|--------|
| `src/lib/auth.ts` | Return UUID in local mode |
| `src/capabilities/data-service.ts` | Use UUID for user filtering |
| `src/capabilities/capability-store.ts` | Use UUID for createdBy |
| `src/capabilities/execution-trace-store.ts` | Use UUID for user_id/created_by |
| `src/graphrag/user-usage.ts` | Use UUID for user filtering |
| `src/graphrag/sync/db-sync.ts` | Use UUID for trace inserts |
| `src/mcp/routing/handlers/emergence.ts` | Use UUID for userId |
| `src/mcp/routing/handlers/metrics.ts` | Use UUID for userId |
| `src/dag/executor.ts` | Use UUID for userId |
| `src/sandbox/executor.ts` | Use UUID for userId |

### Migration Complexity
- **High**: Requires data migration with JOIN to users table
- **Order-dependent**: System user must exist before column migration
- **Rollback risk**: Complex to rollback if issues arise

### Breaking Changes
- API contracts that expose user IDs may change from string to UUID
- Any external integrations using user_id strings would break

## Risks

1. **Fresh Install**: System user must be created before any other data
2. **Existing Data**: Must handle rows where user doesn't exist in users table
3. **Cloud vs Local**: Different behavior in cloud mode vs local mode
4. **Performance**: JOINs to users table may impact query performance

## Alternatives Considered

### Keep TEXT (Current Approach)
- **Pros**: Simple, works in local mode, no migration needed
- **Cons**: No referential integrity, magic strings

### Soft FK (Application-level)
- **Pros**: No schema change, validates at application level
- **Cons**: Still no DB-level integrity, requires code changes

## Decision

**Deferred** - The TEXT approach is sufficient for current use cases:
- Local mode works without users table
- Cloud mode uses actual user IDs
- Consistency with existing tables

Revisit when:
- Multi-tenant cloud deployment becomes priority
- User management features are expanded
- Data integrity issues arise in production

## References

- Story 9.8: Per-user dashboard metrics
- Migration 033: workflow_pattern.created_by (TEXT)
- `src/lib/auth.ts`: User context handling
