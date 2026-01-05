# Story 11.2: Execution Trace Table & Store

Status: done

## Story

As a learning system, I want a unified `execution_trace` table that stores execution history, So
that I can track execution patterns with proper FK to capabilities and learning-specific fields.

## Context & Background

**Epic 11: Learning from Execution Traces** implements TD Error + PER + SHGAT learning (DQN/Rainbow
style). This story creates the persistence layer for execution traces.

**Why this matters:**

- Story 11.1 (done) added `result` capture to tool_end and capability_end events
- This story creates the `execution_trace` table to persist those traces
- Story 11.3 will calculate TD error using SHGAT predictions and store as `priority`
- Story 11.6 will train SHGAT using PER-weighted sampling from traces

**Current state (before this story):**

- `workflow_execution` table exists but lacks:
  - FK to `workflow_pattern` (capability)
  - Learning-specific fields (`executed_path`, `decisions`, `priority`)
  - Multi-tenancy (`user_id`, `created_by`)
- Traces are captured in memory via Story 11.1 but not persisted

**Separation: Capability vs Trace (CRITICAL):**

| Concept        | Table                   | Contenu                                                    | Lifecycle                |
| -------------- | ----------------------- | ---------------------------------------------------------- | ------------------------ |
| **Capability** | `workflow_pattern`      | `code`, `intent`, `static_structure`, `parameters_schema`  | Immutable after creation |
| **Trace**      | `execution_trace` (NEW) | `executed_path`, `task_results`, `decisions`, `durationMs` | Created per execution    |

**Refactor Required:**

- `saveCapability()` currently stores both structure AND execution stats
- After this story: `saveCapability()` → structure only, `saveTrace()` → execution data

**Prerequisites:**

- Story 11.0 (done) - DB Schema Cleanup (KV singleton, workflow-state-cache)
- Story 11.1 (done) - Result Tracing (tool_end/capability_end include `result`)

## Acceptance Criteria

1. **AC1:** Migration 020 creates `execution_trace` table with schema:
   ```sql
   CREATE TABLE execution_trace (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     capability_id UUID REFERENCES workflow_pattern(pattern_id),
     intent_text TEXT,
     initial_context JSONB DEFAULT '{}',
     executed_at TIMESTAMPTZ DEFAULT NOW(),
     success BOOLEAN NOT NULL,
     duration_ms INTEGER NOT NULL,
     error_message TEXT,
     user_id TEXT DEFAULT 'local',
     created_by TEXT DEFAULT 'local',
     updated_by TEXT,
     executed_path TEXT[],
     decisions JSONB DEFAULT '[]',
     task_results JSONB DEFAULT '[]',
     priority FLOAT DEFAULT 0.5,
     parent_trace_id UUID REFERENCES execution_trace(id)
   );
   ```

2. **AC2:** Indexes created for efficient queries:
   - `idx_exec_trace_capability` ON `execution_trace(capability_id)`
   - `idx_exec_trace_timestamp` ON `execution_trace(executed_at DESC)`
   - `idx_exec_trace_user` ON `execution_trace(user_id)`
   - `idx_exec_trace_path` USING GIN ON `execution_trace(executed_path)`
   - `idx_exec_trace_priority` ON `execution_trace(capability_id, priority DESC)`

3. **AC3:** Types defined in `src/capabilities/types.ts`:
   ```typescript
   interface ExecutionTrace {
     id: string;
     capabilityId?: string;
     intentText?: string;
     initialContext?: Record<string, JsonValue>;
     executedAt: Date;
     success: boolean;
     durationMs: number;
     errorMessage?: string;
     executedPath?: string[];
     decisions: BranchDecision[];
     taskResults: TraceTaskResult[];
     priority: number;
     parentTraceId?: string;
     userId?: string;
     createdBy?: string;
   }

   interface BranchDecision {
     nodeId: string;
     outcome: string;
     condition?: string;
   }

   interface TraceTaskResult {
     taskId: string;
     tool: string;
     args: Record<string, JsonValue>;
     result: JsonValue;
     success: boolean;
     durationMs: number;
   }
   ```

4. **AC4:** `ExecutionTraceStore` class created with methods:
   - `saveTrace(trace: Omit<ExecutionTrace, 'id'>): Promise<ExecutionTrace>` → INSERT
   - `getTraces(capabilityId: string, limit?: number): Promise<ExecutionTrace[]>` → SELECT
   - `getTraceById(traceId: string): Promise<ExecutionTrace | null>` → SELECT
   - `getHighPriorityTraces(limit: number): Promise<ExecutionTrace[]>` → SELECT ORDER BY priority
     DESC
   - `updatePriority(traceId: string, priority: number): Promise<void>` → UPDATE priority
   - `sampleByPriority(limit: number, minPriority?: number): Promise<ExecutionTrace[]>` → Weighted
     sampling

5. **AC5:** Migration handles `workflow_execution` → `execution_trace`:
   - Option A: Migrate data if exists
   - Option B: DROP if empty (testing environment)
   - Keep backward compatibility during transition

6. **AC6:** Files updated to use `execution_trace`:
   - `src/graphrag/sync/db-sync.ts:persistWorkflowExecution()` → use new table
   - `src/graphrag/metrics/collector.ts:getMetricsTimeSeries()` → query new table
   - `src/web/routes/api/user/delete.ts` → anonymize new table

7. **AC7:** Tests: INSERT trace with FK capability validates

8. **AC8:** Tests: SELECT traces by capability_id works

9. **AC9:** `initial_context` stores workflow input arguments (Epic 12 dependency)

10. **AC10:** `task_results[].args` stores each task's arguments (Epic 12 dependency)

11. **AC11:** Data sanitization applied before storage:
    - Redact sensitive fields (API keys, tokens)
    - Truncate large payloads (>10KB → summary)
    - Create `src/utils/sanitize-for-storage.ts`

12. **AC12:** Refactor post-execution calls (Capability vs Trace separation):
    - `executor.ts` → pass `traceData` to `saveCapability()` for unified capability+trace creation
    - `worker-bridge.ts` → pass `traceData` to `saveCapability()` for unified capability+trace
      creation
    - `saveCapability()` returns `{ capability, trace }` - creates both atomically when traceData
      provided
    - Design decision: "Unit of Work" pattern - capability and its first trace created together with
      correct FK linkage

## Tasks / Subtasks

- [x] **Task 1: Create migration 020** (AC: #1, #2, #5)
  - [x] 1.1 Create `src/db/migrations/020_execution_trace.ts`
  - [x] 1.2 Create `execution_trace` table with all columns
  - [x] 1.3 Add indexes for query performance
  - [x] 1.4 Handle migration from `workflow_execution` (conditional)
  - [x] 1.5 Make migration idempotent (`IF NOT EXISTS`, `IF EXISTS`)

- [x] **Task 2: Define TypeScript types** (AC: #3)
  - [x] 2.1 Add `ExecutionTrace` interface to `src/capabilities/types.ts`
  - [x] 2.2 Add `BranchDecision` interface
  - [x] 2.3 Add `TraceTaskResult` interface
  - [x] 2.4 Verify `JsonValue` type is reusable

- [x] **Task 3: Create ExecutionTraceStore** (AC: #4)
  - [x] 3.1 Create `src/capabilities/execution-trace-store.ts`
  - [x] 3.2 Implement `saveTrace()` with INSERT
  - [x] 3.3 Implement `getTraces()` by capability_id
  - [x] 3.4 Implement `getTraceById()`
  - [x] 3.5 Implement `getHighPriorityTraces()` for PER sampling
  - [x] 3.6 Implement `updatePriority()` for Story 11.3
  - [x] 3.7 Implement `sampleByPriority()` with weighted sampling

- [x] **Task 4: Create sanitize utility** (AC: #11)
  - [x] 4.1 Create `src/utils/sanitize-for-storage.ts`
  - [x] 4.2 Implement `sanitizeForStorage(data: unknown): JsonValue`
  - [x] 4.3 Add redaction for sensitive patterns (api_key, token, password)
  - [x] 4.4 Add truncation for large payloads (>10KB)
  - [x] 4.5 Add export from `src/utils/mod.ts`

- [x] **Task 5: Update dependent files** (AC: #6)
  - [x] 5.1 Update `src/graphrag/sync/db-sync.ts:persistWorkflowExecution()`
  - [x] 5.2 Update `src/graphrag/metrics/collector.ts:getMetricsTimeSeries()`
  - [x] 5.3 Update `src/web/routes/api/user/delete.ts` for anonymization

- [x] **Task 6: Refactor saveCapability separation** (AC: #12)
  - [x] 6.1 Identify call sites: `executor.ts`, `worker-bridge.ts`
  - [x] 6.2 Create new `saveTrace()` calls for execution data
  - [x] 6.3 Clean up `SaveCapabilityInput` interface (add traceData field)
  - [x] 6.4 Verify capability created only via static analysis path

- [x] **Task 7: Write unit tests** (AC: #7, #8)
  - [x] 7.1 Create `tests/unit/capabilities/execution_trace_store_test.ts`
  - [x] 7.2 Test `saveTrace()` with valid data
  - [x] 7.3 Test `saveTrace()` with FK capability validation
  - [x] 7.4 Test `getTraces()` by capability_id
  - [x] 7.5 Test `getHighPriorityTraces()` ordering
  - [x] 7.6 Test `updatePriority()` updates correctly
  - [x] 7.7 Test sanitization strips sensitive data

- [x] **Task 8: Validation**
  - [x] 8.1 `deno check` passes for all modified files
  - [x] 8.2 Run existing tests: no regressions
  - [x] 8.3 Run new tests: all passing (33 tests - 25 original + 8 inferDecisions)
  - [x] 8.4 Migration runs successfully

### Review Follow-ups (AI)

- [x] [AI-Review][MEDIUM] ~~Implement runtime branch decision tracking~~ → **IMPLEMENTED via
      inference**
  - Solution: `StaticStructureBuilder.inferDecisions(staticStructure, executedPath)`
  - Matches executed tools against conditional edges to infer which branches were taken
  - No runtime instrumentation needed - uses existing static analysis + trace data
  - 8 unit tests added, all passing

## Dev Notes

### Critical Implementation Details

**1. Migration Strategy (Backward Compatible)**

```sql
-- src/db/migrations/020_execution_trace.sql

-- Create new table (idempotent)
CREATE TABLE IF NOT EXISTS execution_trace (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  capability_id UUID REFERENCES workflow_pattern(pattern_id),
  intent_text TEXT,
  initial_context JSONB DEFAULT '{}',
  executed_at TIMESTAMPTZ DEFAULT NOW(),
  success BOOLEAN NOT NULL,
  duration_ms INTEGER NOT NULL,
  error_message TEXT,
  user_id TEXT DEFAULT 'local',
  created_by TEXT DEFAULT 'local',
  updated_by TEXT,
  executed_path TEXT[],
  decisions JSONB DEFAULT '[]',
  task_results JSONB DEFAULT '[]',
  priority FLOAT DEFAULT 0.5,
  parent_trace_id UUID REFERENCES execution_trace(id)
);

-- Indexes (idempotent)
CREATE INDEX IF NOT EXISTS idx_exec_trace_capability ON execution_trace(capability_id);
CREATE INDEX IF NOT EXISTS idx_exec_trace_timestamp ON execution_trace(executed_at DESC);
CREATE INDEX IF NOT EXISTS idx_exec_trace_user ON execution_trace(user_id);
CREATE INDEX IF NOT EXISTS idx_exec_trace_path ON execution_trace USING GIN(executed_path);
CREATE INDEX IF NOT EXISTS idx_exec_trace_priority ON execution_trace(capability_id, priority DESC);

-- Optional: Migrate data from workflow_execution if it exists
-- Only run if workflow_execution has data and execution_trace is empty
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'workflow_execution')
     AND NOT EXISTS (SELECT 1 FROM execution_trace LIMIT 1) THEN
    INSERT INTO execution_trace (intent_text, executed_at, success, duration_ms, error_message, user_id)
    SELECT intent_text, executed_at, success, execution_time_ms, error_message, COALESCE(user_id, 'local')
    FROM workflow_execution;
  END IF;
END $$;
```

**2. ExecutionTraceStore Implementation Pattern**

Follow `capability-store.ts` patterns:

- Constructor takes `PGliteClient`
- Use parameterized queries (no SQL injection)
- Return typed objects from `rowToTrace()`
- Emit events via `eventBus` for observability

```typescript
// src/capabilities/execution-trace-store.ts
import type { PGliteClient } from "../db/client.ts";
import type { BranchDecision, ExecutionTrace, JsonValue, TraceTaskResult } from "./types.ts";
import { sanitizeForStorage } from "../utils/sanitize-for-storage.ts";
import { eventBus } from "../events/mod.ts";
import { getLogger } from "../telemetry/logger.ts";

const logger = getLogger("default");

export class ExecutionTraceStore {
  constructor(private db: PGliteClient) {}

  async saveTrace(trace: Omit<ExecutionTrace, "id">): Promise<ExecutionTrace> {
    // Sanitize large/sensitive data before storage
    const sanitizedContext = sanitizeForStorage(trace.initialContext ?? {});
    const sanitizedResults = trace.taskResults.map((r) => ({
      ...r,
      args: sanitizeForStorage(r.args),
      result: sanitizeForStorage(r.result),
    }));

    const result = await this.db.query(
      `
      INSERT INTO execution_trace (
        capability_id, intent_text, initial_context, success, duration_ms,
        error_message, user_id, created_by, executed_path, decisions,
        task_results, priority, parent_trace_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING *
    `,
      [
        trace.capabilityId ?? null,
        trace.intentText ?? null,
        JSON.stringify(sanitizedContext),
        trace.success,
        trace.durationMs,
        trace.errorMessage ?? null,
        trace.userId ?? "local",
        trace.createdBy ?? "local",
        trace.executedPath ?? [],
        JSON.stringify(trace.decisions),
        JSON.stringify(sanitizedResults),
        trace.priority ?? 0.5,
        trace.parentTraceId ?? null,
      ],
    );

    const savedTrace = this.rowToTrace(result[0]);

    // Emit event for observability
    eventBus.emit({
      type: "execution.trace.saved",
      source: "execution-trace-store",
      payload: {
        traceId: savedTrace.id,
        capabilityId: savedTrace.capabilityId,
        success: savedTrace.success,
        priority: savedTrace.priority,
      },
    });

    return savedTrace;
  }

  // ... other methods
}
```

**3. Sanitization Utility**

```typescript
// src/utils/sanitize-for-storage.ts
const SENSITIVE_PATTERNS = [
  /api[_-]?key/i,
  /token/i,
  /password/i,
  /secret/i,
  /authorization/i,
];

const MAX_VALUE_SIZE = 10 * 1024; // 10KB

export function sanitizeForStorage(data: unknown): JsonValue {
  if (data === null || data === undefined) return null;

  // Handle primitives
  if (typeof data === "string") {
    return data.length > MAX_VALUE_SIZE ? `[TRUNCATED: ${data.length} chars]` : data;
  }
  if (typeof data === "number" || typeof data === "boolean") return data;

  // Handle arrays
  if (Array.isArray(data)) {
    return data.map(sanitizeForStorage) as JsonValue[];
  }

  // Handle objects
  if (typeof data === "object") {
    const result: Record<string, JsonValue> = {};
    for (const [key, value] of Object.entries(data)) {
      // Redact sensitive keys
      if (SENSITIVE_PATTERNS.some((p) => p.test(key))) {
        result[key] = "[REDACTED]";
      } else {
        result[key] = sanitizeForStorage(value);
      }
    }
    return result;
  }

  // Fallback for unsupported types
  return String(data);
}
```

**4. Priority Default Value (0.5)**

The `priority` column defaults to 0.5 (neutral). This is the cold start value when SHGAT hasn't been
trained yet:

- 0.0 = expected trace (not surprising)
- 0.5 = unknown (cold start, SHGAT not trained)
- 1.0 = surprising trace (high learning value)

Story 11.3 will calculate `priority = |td_error|` after SHGAT predictions.

**5. Files to Modify for db-sync.ts**

Current `persistWorkflowExecution()` inserts into `workflow_execution`:

```typescript
// BEFORE (db-sync.ts:268-295)
export async function persistWorkflowExecution(
  db: PGliteClient,
  execution: { intentText?: string; dagStructure: unknown; ... }
): Promise<void> {
  await db.query(
    `INSERT INTO workflow_execution ...`,
    [...]
  );
}
```

After this story:

```typescript
// AFTER - delegate to ExecutionTraceStore
import { ExecutionTraceStore } from "../../capabilities/execution-trace-store.ts";

export async function persistWorkflowExecution(
  db: PGliteClient,
  execution: { ... },
  traceStore?: ExecutionTraceStore
): Promise<void> {
  if (traceStore) {
    await traceStore.saveTrace({
      intentText: execution.intentText,
      success: execution.success,
      durationMs: execution.executionTimeMs,
      errorMessage: execution.errorMessage,
      userId: execution.userId,
      decisions: [],
      taskResults: [],
    });
  } else {
    // Fallback to legacy table during transition
    await db.query(`INSERT INTO workflow_execution ...`, [...]);
  }
}
```

### Files to Create

| File                                                    | Purpose                 | LOC  |
| ------------------------------------------------------- | ----------------------- | ---- |
| `src/db/migrations/020_execution_trace.sql`             | Migration for new table | ~50  |
| `src/capabilities/execution-trace-store.ts`             | Store class with CRUD   | ~200 |
| `src/utils/sanitize-for-storage.ts`                     | Sanitization utility    | ~60  |
| `tests/unit/capabilities/execution-trace-store.test.ts` | Unit tests              | ~150 |

### Files to Modify

| File                                   | Changes                                             | LOC |
| -------------------------------------- | --------------------------------------------------- | --- |
| `src/capabilities/types.ts`            | Add ExecutionTrace, BranchDecision, TraceTaskResult | ~50 |
| `src/capabilities/mod.ts`              | Export new store                                    | ~5  |
| `src/graphrag/sync/db-sync.ts`         | Update persistWorkflowExecution                     | ~30 |
| `src/graphrag/metrics/collector.ts`    | Update workflow rate query                          | ~20 |
| `src/web/routes/api/user/delete.ts`    | Add execution_trace anonymization                   | ~15 |
| `src/sandbox/executor.ts`              | Add trace saving after execution                    | ~20 |
| `src/sandbox/worker-bridge.ts`         | Add trace saving after execution                    | ~20 |
| `src/capabilities/capability-store.ts` | Clean SaveCapabilityInput                           | ~30 |

### Architecture Compliance

- **Deno 2.x** - Runtime (not Node.js)
- **TypeScript strict mode** - All types explicit
- **camelCase** - For all properties (not snake_case)
- **PGlite** - PostgreSQL WASM for persistence
- **Async/await** - No callbacks or .then() chains
- **EventBus** - Emit events for observability (ADR-036)

### References

- [Epic 11: Learning from Traces](../epics/epic-11-learning-from-traces.md)
- [Story 11.0: DB Schema Cleanup](./11-0-db-schema-cleanup.md) - Prerequisite (DONE)
- [Story 11.1: Result Tracing](./11-1-result-tracing.md) - Prerequisite (DONE)
- [Source: src/capabilities/capability-store.ts](../../src/capabilities/capability-store.ts) -
  Pattern to follow
- [Source: src/graphrag/sync/db-sync.ts:268](../../src/graphrag/sync/db-sync.ts) -
  persistWorkflowExecution
- [Source: src/graphrag/metrics/collector.ts:188](../../src/graphrag/metrics/collector.ts) -
  workflowRateResult query
- [Source: src/web/routes/api/user/delete.ts:83](../../src/web/routes/api/user/delete.ts) - workflow
  anonymization
- [ADR-036: EventBus BroadcastChannel](../adrs/ADR-036-eventbus-broadcast-channel.md)
- [ADR-041: Hierarchical Trace Tracking](../adrs/ADR-041-hierarchical-trace-tracking.md) -
  parentTraceId

### Previous Story Intelligence (11.1)

From Story 11.1 (Result Tracing):

- **Patterns established:** `result?: unknown` in TraceEvent types
- **Test patterns:** `tests/unit/sandbox/result_tracing_test.ts` - 9 tests with safeSerializeResult
- **Files modified:** worker-bridge.ts, sandbox-worker.ts, code-generator.ts, events/types.ts
- **Learnings:** IIFE wrapper needed to capture return values in code-generator template

### Git Intelligence

Recent commits (2025-12-22):

```
f1f924c feat(story-11.0): DB schema cleanup - KV singleton and workflow state cache
cde94eb feat(story-11.1): result tracing for tools and capabilities
dbefd58 chore(story-10.6): mark done + simplify unified-search benchmark
```

Patterns observed:

- Commit format: `type(scope): message`
- Migration files: `0XX_descriptive_name.sql`
- Test files: `*_test.ts` or `*.test.ts`

### Estimation

**Effort:** 2-3 days

**Breakdown:**

- Task 1 (migration): 2h
- Task 2 (types): 1h
- Task 3 (ExecutionTraceStore): 4h
- Task 4 (sanitize utility): 2h
- Task 5 (update dependent files): 3h
- Task 6 (refactor saveCapability): 4h
- Task 7 (unit tests): 3h
- Task 8 (validation): 1h

**Risk:** Refactoring saveCapability (Task 6) touches multiple files - careful testing required to
avoid regressions.

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

- Migration 020 applies successfully in tests
- 25 unit tests for ExecutionTraceStore all passing
- Fixed pre-existing test failures in schema_inferrer_test.ts (mcp_server table removed in
  migration 019)

### Completion Notes List

1. **Migration 020 created** - `execution_trace` table with all learning-specific fields (priority,
   decisions, taskResults, executedPath, parentTraceId)
2. **TypeScript types defined** - ExecutionTrace, BranchDecision, TraceTaskResult interfaces added
   to types.ts
3. **ExecutionTraceStore implemented** - Full CRUD + PER sampling (saveTrace, getTraces,
   getHighPriorityTraces, updatePriority, sampleByPriority, getChildTraces, anonymizeUserTraces,
   pruneOldTraces)
4. **Sanitization utility created** - sanitizeForStorage() redacts sensitive data (api_key, token,
   password, secret, authorization) and truncates payloads >10KB
5. **Dependent files updated** - db-sync.ts, collector.ts, delete.ts now use execution_trace table
6. **saveCapability refactored** - Returns `{ capability: Capability; trace?: ExecutionTrace }`,
   optionally saves trace via traceData field
7. **25 unit tests written** - Full coverage of AC7 (FK validation), AC8 (SELECT by capability_id),
   AC11 (sanitization)
8. **Fixed pre-existing test** - schema_inferrer_test.ts now works without mcp_server table
9. **decisions[] inference implemented** - `StaticStructureBuilder.inferDecisions()` matches
   executedPath vs static structure conditional edges to infer branch decisions (8 tests added)

### File List

**Created:**

- `src/db/migrations/020_execution_trace.ts` - Migration for execution_trace table
- `src/capabilities/execution-trace-store.ts` - ExecutionTraceStore class
- `src/utils/sanitize-for-storage.ts` - Sanitization utility
- `src/utils/mod.ts` - Utils module exports
- `tests/unit/capabilities/execution_trace_store_test.ts` - 25 unit tests

**Modified:**

- `src/db/migrations.ts` - Register migration 020
- `src/capabilities/types.ts` - Added ExecutionTrace, BranchDecision, TraceTaskResult,
  SaveTraceInput, traceData field, DEFAULT_TRACE_PRIORITY constant
- `src/capabilities/mod.ts` - Export ExecutionTraceStore, DEFAULT_TRACE_PRIORITY
- `src/capabilities/capability-store.ts` - New return type { capability, trace }, optional trace
  saving, uses DEFAULT_TRACE_PRIORITY
- `src/capabilities/execution-trace-store.ts` - Uses DEFAULT_TRACE_PRIORITY from types.ts
- `src/events/types.ts` - Added execution trace event types
- `src/graphrag/sync/db-sync.ts` - Updated persistWorkflowExecution to use execution_trace,
  sanitizeForStorage, DEFAULT_TRACE_PRIORITY
- `src/graphrag/metrics/collector.ts` - Updated queries for execution_trace
- `src/web/routes/api/user/delete.ts` - Added execution_trace anonymization
- `src/sandbox/executor.ts` - Added traceData to saveCapability call (AC12)
- `src/sandbox/worker-bridge.ts` - Added traceData with taskResults from traces (AC12)
- `tests/unit/capabilities/capability_store_test.ts` - Updated for new saveCapability return type
- `tests/unit/capabilities/capability_dependency_test.ts` - Updated for new saveCapability return
  type
- `tests/unit/capabilities/permission_inferrer_test.ts` - Updated for new saveCapability return type
- `tests/unit/capabilities/schema_inferrer_test.ts` - Updated for new saveCapability return type +
  fixed mcp_server test
- `tests/unit/capabilities/static_structure_builder_test.ts` - Updated for new saveCapability return
  type
