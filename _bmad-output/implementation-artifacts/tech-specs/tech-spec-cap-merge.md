# Tech-Spec: cap:merge - Capability Consolidation Tool

**Created:** 2025-12-30
**Status:** ✅ Completed
**Epic:** 13 (Capability Naming & Curation) - Deferred Feature
**Story:** TBD (Epic 14+)

## Overview

### Problem Statement

Users have multiple capabilities that do the same thing - often older versions with deprecated code snippets but using the same tool. They want to consolidate duplicates into a single canonical capability without losing usage statistics or provenance history.

### Solution

Implement `cap:merge` tool that:
1. Validates source and target capabilities use identical `tools_used`
2. Merges statistics (cumulative usage_count, oldest created_at)
3. Keeps the most recent code_snippet (or allows manual selection)
4. Deletes the source capability after successful merge
5. Optionally tracks merge history via `merged_from[]` array on target

### Scope

**In Scope:**
- `cap:merge` MCP tool implementation
- Validation: same `tools_used` required
- Statistics consolidation (usage_count, success_count, total_latency_ms)
- Timestamp handling (keep oldest created_at)
- Code snippet selection (newest by default, optional override)
- Source capability deletion post-merge
- Provenance tracking (`merged_from` array)

**Out of Scope:**
- Alias/redirect system (deferred - delete instead)
- Merging capabilities with different tools_used
- Bulk merge operations (single source → target only)
- Undo/rollback functionality

## Context for Development

### Codebase Patterns

- **CapModule pattern:** `lib/std/cap.ts` - all `cap:*` tools in single module
- **Tool definition:** `listTools()` returns MCP tool schema, `call()` routes to handler
- **Database access:** Direct SQL via `this.db.query()` with parameterized queries
- **Response format:** `CapToolResult` with `{ content: [{ type: "text", text: JSON }] }`
- **Error handling:** `this.errorResult(message)` for failures
- **Logging:** `@std/log` with `[CapModule]` prefix

### Files to Reference

| File | Purpose |
|------|---------|
| `lib/std/cap.ts` | Add `cap:merge` handler here (lines 309-1014) |
| `src/db/migrations/021_capability_records.ts` | Schema reference |
| `src/capabilities/capability-registry.ts` | `resolveByName()`, `getById()` methods |
| `src/capabilities/types/capability.ts` | Type definitions |

### Technical Decisions

1. **Validation-first approach:** Check `tools_used` match before any mutations
2. **Transaction safety:** Wrap merge + delete in single transaction
3. **No alias complexity:** Simple delete of source (MVP approach)
4. **Provenance via JSONB:** Add `merged_from TEXT[]` column to track history

## Implementation Plan

### Tasks

- [x] **Task 1: Migration** - SKIPPED (no merged_from tracking needed for MVP)

- [x] **Task 2: Types** - Add `CapMergeOptions`, `CapMergeResponse`, and Zod schema
  - File: `lib/std/cap.ts:241-281`
  - Added `CapMergeOptionsSchema` with Zod validation

- [x] **Task 3: Handler** - Implement `handleMerge()` in CapModule
  - File: `lib/std/cap.ts:867-1001`
  - Validates with Zod, checks tools_used match, merges stats, deletes source
  - Uses real DB transaction for atomicity (UPDATE + DELETE)

- [x] **Task 4: Tool Registration** - Add to `listTools()` and `call()` router
  - Added to listTools(): `lib/std/cap.ts:463-486`
  - Added to call() switch: `lib/std/cap.ts:503-504`
  - Added to pmlTools array: `lib/std/cap.ts:1178-1205`

- [x] **Task 5: Tests** - Unit tests for merge scenarios (10 tests)
  - File: `tests/unit/lib/std/cap_test.ts:462-807`
  - All 31 tests passing (including AC2, AC4, AC5, AC6 coverage)

### Acceptance Criteria

- [x] **AC1:** Given source and target with identical `tools_used`, when `cap:merge({ source, target })` is called, then target's `usage_count = source.usage_count + target.usage_count` ✅ Test: "merges usage stats correctly (AC1)"

- [x] **AC2:** Given source and target with identical `tools_used`, when merge completes, then target's `created_at = MIN(source.created_at, target.created_at)` ✅ Test: "uses MIN created_at (AC2)"

- [x] **AC3:** Given source and target with **different** `tools_used`, when `cap:merge` is called, then error returned: "Cannot merge: tools_used mismatch" ✅ Test: "rejects different tools_used (AC3)"

- [x] **AC4:** Given source with newer `updated_at`, when merge with default options, then target gets source's `code_snippet` ✅ Test: "uses newest code_snippet by default (AC4)"

- [x] **AC5:** Given `preferSourceCode: true`, when merge, then source's `code_snippet` is used regardless of timestamps ✅ Test: "preferSourceCode override forces source code (AC5)"

- [x] **AC6:** After successful merge, source capability is deleted from `capability_records` ✅ Test: "deletes source capability (AC6)"

- [N/A] **AC7:** ~~After successful merge, target's `merged_from[]` contains source's UUID~~ - SKIPPED per user request (no provenance tracking)

## Additional Context

### Dependencies

- Story 13.5 complete (cap:list, cap:rename, cap:lookup, cap:whois)
- CapModule initialized with registry and db

### Database Changes

> **Note:** Migration for `merged_from` column was SKIPPED per user request.
> No database schema changes required for MVP implementation.

### MCP Tool Schema

```typescript
{
  name: "cap:merge",
  description: "Merge duplicate capabilities into a canonical one. Combines usage stats, keeps newest code. Requires identical tools_used.",
  inputSchema: {
    type: "object",
    properties: {
      source: {
        type: "string",
        description: "Source capability to merge FROM (name, UUID, or FQDN) - will be deleted"
      },
      target: {
        type: "string",
        description: "Target capability to merge INTO (name, UUID, or FQDN) - will be updated"
      },
      preferSourceCode: {
        type: "boolean",
        description: "If true, use source's code_snippet even if older. Default: use newest."
      }
    },
    required: ["source", "target"]
  }
}
```

### Merge Logic Pseudocode

```typescript
async handleMerge(options: CapMergeOptions): Promise<CapToolResult> {
  // 1. Resolve both capabilities
  const source = await this.resolveCapability(options.source);
  const target = await this.resolveCapability(options.target);

  // 2. Validate tools_used match
  if (!arraysEqual(source.toolsUsed, target.toolsUsed)) {
    return this.errorResult("Cannot merge: tools_used mismatch");
  }

  // 3. Calculate merged values
  const mergedUsageCount = source.usageCount + target.usageCount;
  const mergedSuccessCount = source.successCount + target.successCount;
  const mergedLatencyMs = source.totalLatencyMs + target.totalLatencyMs;
  const mergedCreatedAt = min(source.createdAt, target.createdAt);

  // 4. Determine code_snippet (newest by updated_at, or forced via preferSourceCode)
  const useSourceCode = options.preferSourceCode ??
    (source.updatedAt > target.updatedAt);
  const finalCodeSnippet = useSourceCode ? source.codeSnippet : target.codeSnippet;

  // 5. Execute in REAL transaction for atomicity
  await this.db.transaction(async (tx) => {
    // Update target with merged stats
    await tx.exec(`
      UPDATE capability_records SET
        usage_count = $1, success_count = $2, total_latency_ms = $3,
        created_at = $4, code_snippet = $5, updated_at = NOW()
      WHERE id = $6
    `, [mergedUsageCount, mergedSuccessCount, mergedLatencyMs,
        mergedCreatedAt, finalCodeSnippet, target.id]);

    // Delete source (rolled back if UPDATE failed)
    await tx.exec(`DELETE FROM capability_records WHERE id = $1`, [source.id]);
  });

  return this.successResult({ ... });
}
```

### Testing Strategy

1. **Unit tests** in `tests/unit/lib/std/cap_test.ts` (10 tests for cap:merge)
2. Mock database with transaction support
3. Test matrix:
   - Same tools_used → success (AC1)
   - Different tools_used → error (AC3)
   - MIN created_at logic (AC2)
   - Default code selection by updated_at (AC4)
   - preferSourceCode override (AC5)
   - DELETE verification (AC6)
   - Self-merge rejection
   - Zod validation errors

### Notes

- Consider future enhancement: batch merge with glob pattern (`cap:merge({ pattern: "old_*", target: "canonical" })`)
- Consider future enhancement: dry-run mode to preview merge without executing
- Related: `cap:fork` (FR044) for copying capabilities - separate story
