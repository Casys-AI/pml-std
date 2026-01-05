# Story 11.3: TD Error + PER Priority

Status: done

## Story

As a learning system, I want to calculate TD error for PER priority, So that SHGAT can sample and
learn from surprising traces efficiently.

## Context & Background

**Epic 11: Learning from Execution Traces** implements a TD Error + PER + SHGAT learning system
(DQN/Rainbow style). This story is the third step: calculating TD error as a signal for Prioritized
Experience Replay (PER).

**Architecture Overview (2025-12-22):**

```
+---------------------------------------------------------------------------------+
|                     TD + PER + SHGAT (style DQN/Rainbow)                         |
+---------------------------------------------------------------------------------+
|                                                                                 |
|  1. EXECUTION -> TRACE                                                          |
|     workflow terminates -> execution_trace stored (Story 11.2)                   |
|                                                                                 |
|  2. TD ERROR (learning signal)                                                  |
|     td_error = actual_success - shgat.predictPathSuccess(path)                  |
|     -> If SHGAT predicts 0.9 and outcome = 0.0 -> td_error = -0.9 (surprise!)   |
|                                                                                 |
|  3. PER (replay priority)                                                       |
|     priority = |td_error|                                                       |
|     -> Surprising traces -> high priority -> sampled more often                 |
|                                                                                 |
|  4. SHGAT (the learning model) - Story 11.6                                     |
|     - Sample traces by PER priority                                             |
|     - Train attention weights on these traces                                   |
|     - Loss = td_error^2 (MSE on prediction vs actual)                           |
|                                                                                 |
+---------------------------------------------------------------------------------+
```

**Role of each component:**

| Component    | Role                  | What it produces                     |
| ------------ | --------------------- | ------------------------------------ |
| **TD Error** | Learning signal       | `                                    |
| **PER**      | Replay prioritization | Traces weighted by surprise          |
| **SHGAT**    | The model itself      | Attention weights, prediction scores |

**DEPRECATIONS (2025-12-22):**

| Deprecated                         | Replaced by                        | Reason                               |
| ---------------------------------- | ---------------------------------- | ------------------------------------ |
| `CapabilityLearning` structure     | SHGAT weights                      | SHGAT learns directly from traces    |
| `workflow_pattern.learning` column | `execution_trace.priority` + SHGAT | No intermediate stats                |
| `updateLearningTD()` -> stats      | `updatePriority()` -> PER only     | TD error = signal for PER, not stats |
| `pathSuccessRate` calculated       | SHGAT predicts directly            | Network learns patterns              |

**Previous Story Intelligence (11.1 - completed 2025-12-22):**

- Result tracing implemented in `worker-bridge.ts` and `code-generator.ts`
- `tool_end` and `capability_end` events now include `result` field
- `safeSerializeResult()` handles circular references
- 277 sandbox tests passing including 9 result tracing tests

**Important:** Story 11.2 (`execution_trace` table) is a **prerequisite** for this story. This story
depends on:

- `ExecutionTraceStore` class with `saveTrace()`, `getTraces()`, `updatePriority()` methods
- `execution_trace.priority` column (FLOAT, default 0.5)

## Acceptance Criteria

1. **AC1:** `calculateTDError(shgat, embeddingProvider, trace)` function implemented:
   ```typescript
   async function calculateTDError(
     shgat: SHGAT,
     embeddingProvider: EmbeddingProvider,
     trace: { intentText?: string; executedPath?: string[]; success: boolean },
   ): Promise<TDErrorResult> {
     const intentEmbedding = await embeddingProvider.getEmbedding(trace.intentText ?? "");
     const predicted = shgat.predictPathSuccess(intentEmbedding, trace.executedPath ?? []);
     const actual = trace.success ? 1.0 : 0.0;
     const tdError = actual - predicted;
     return { tdError, priority: Math.abs(tdError), predicted, actual, isColdStart: false };
   }
   ```
   _Note: Requires `EmbeddingProvider` to generate intent embedding for SHGAT multi-head scoring._

2. **AC2:** `SHGAT.predictPathSuccess(intentEmbedding, path)` method added to SHGAT class:
   ```typescript
   /**
    * Predict success probability for a given execution path
    * @param intentEmbedding - Intent embedding (1024-dim BGE-M3) for multi-head scoring
    * @param path - Array of node IDs representing the executed path
    * @returns Probability between 0 and 1
    */
   predictPathSuccess(intentEmbedding: number[], path: string[]): number
   ```
   _Note: Uses same multi-head architecture as scoreAllTools/scoreAllCapabilities._

3. **AC3:** `storeTraceWithPriority()` saves trace with `priority = |tdError|`:
   ```typescript
   async function storeTraceWithPriority(
     shgat: SHGAT,
     traceStore: ExecutionTraceStore,
     trace: ExecutionTrace,
   ): Promise<void> {
     const tdError = await calculateTDError(shgat, trace);
     const priority = Math.abs(tdError);
     await traceStore.save({ ...trace, priority });
   }
   ```

4. **AC4:** **COLD START handling:** If SHGAT not yet trained (no capabilities registered), priority
   = 0.5 (neutral)

5. **AC5:** `ExecutionTraceStore.getHighPriorityTraces(limit)` for PER sampling (Story 11.6
   prerequisite):
   ```typescript
   getHighPriorityTraces(limit: number): Promise<ExecutionTrace[]>
   ```

6. **AC6:** Tests: new path (SHGAT predicts ~0.5) + success -> priority ~= 0.5

7. **AC7:** Tests: path with SHGAT predict 0.9 + failure -> priority ~= 0.9

8. **AC8:** Tests: path with SHGAT predict 0.9 + success -> priority ~= 0.1

9. **AC9:** Tests: cold start (no capabilities) -> priority = 0.5

## Tasks / Subtasks

- [x] **Task 1: Add predictPathSuccess to SHGAT** (AC: #2, #4) ✅ 2025-12-23
  - [x] 1.1 Add `predictPathSuccess(intentEmbedding, path)` method to SHGAT class
  - [x] 1.2 Use multi-head architecture (same as scoreAllTools/scoreAllCapabilities)
  - [x] 1.3 Weighted average of node scores (later nodes weighted higher)
  - [x] 1.4 Handle cold start: return 0.5 if no nodes registered
  - [x] 1.5 Add `getToolCount()` and `getCapabilityCount()` getters

- [x] **Task 2: Create per-priority.ts module** (AC: #1, #3) ✅ 2025-12-23
  - [x] 2.1 Create `src/capabilities/per-priority.ts`
  - [x] 2.2 Implement `calculateTDError(shgat, embeddingProvider, trace)` function
  - [x] 2.3 Implement `storeTraceWithPriority(traceStore, shgat, embeddingProvider, trace)` function
  - [x] 2.4 Implement `updateTracePriority()` for post-training updates
  - [x] 2.5 Implement `batchUpdatePriorities()` for batch updates
  - [x] 2.6 Export `COLD_START_PRIORITY`, `MIN_PRIORITY`, `MAX_PRIORITY` constants
  - [x] 2.7 Add JSDoc documentation with examples

- [x] **Task 3: Add priority query methods to ExecutionTraceStore** (AC: #5) ✅ Done in 11.2
  - [x] 3.1 `getHighPriorityTraces(limit)` method - ALREADY EXISTS (11.2)
  - [x] 3.2 `updatePriority(traceId, priority)` method - ALREADY EXISTS (11.2)
  - [x] 3.3 `sampleByPriority(limit, minPriority?)` - ALREADY EXISTS (11.2)

- [x] **Task 4: Write unit tests** (AC: #6, #7, #8, #9) ✅ 2025-12-23
  - [x] 4.1 Create `tests/unit/capabilities/per_priority_test.ts` (12 tests)
  - [x] 4.2 Test: cold start -> priority 0.5
  - [x] 4.3 Test: empty path -> priority 0.5
  - [x] 4.4 Test: unknown nodes -> neutral score
  - [x] 4.5 Test: success with known tools
  - [x] 4.6 Test: failure with known tools
  - [x] 4.7 Test: capability in path
  - [x] 4.8 Test: mixed path (tools + capabilities)
  - [x] 4.9 Test: TD error sign direction
  - [x] 4.10 Test: priority bounds clamping

- [x] **Task 5: Integration and validation** ✅ 2025-12-23
  - [x] 5.1 Run `deno check` for all modified files - PASSED
  - [x] 5.2 Run 12 per-priority tests - ALL PASSED
  - [x] 5.3 Document in ADR-050

### Review Follow-ups (AI) - 2025-12-23

- [x] [AI-Review][HIGH] **AC1 API Mismatch**: ~~Story spec says `calculateTDError(shgat, trace)` but
      implementation requires `embeddingProvider` parameter.~~ AC1 spec updated to match
      implementation. [per-priority.ts:98-102]
- [x] [AI-Review][HIGH] **AC2 API Mismatch**: ~~Story spec says `predictPathSuccess(path)` but
      implementation requires `intentEmbedding` parameter.~~ AC2 spec updated to match
      implementation. [shgat.ts:971]
- [x] [AI-Review][MEDIUM] **Performance**: ~~`predictPathSuccess` is O(n × SHGAT_forward)~~ FALSE
      ALARM - Code already caches via toolScoresMap/capScoresMap. Complexity is O(scoreAll) +
      O(path), not O(n × scoreAll). [shgat.ts:985-1017]
- [x] [AI-Review][MEDIUM] **batchUpdatePriorities count**: ~~`updated++` increments even when update
      is skipped.~~ FIXED - `updateTracePriority` now returns boolean, `batchUpdatePriorities`
      tracks skipped count. [per-priority.ts:224-298]
- [x] [AI-Review][MEDIUM] **Missing E2E test**: ~~Add integration test for full flow.~~ ADDED
      `tests/integration/per_priority_e2e_test.ts` - 5 E2E tests covering success/failure cases,
      cold start, and priority ordering.
- [x] [AI-Review][LOW] **Commit files**: ~~All implementation files are untracked/unstaged.~~
      COMMITTED as `2b6fb75` - 6 files, 1183 insertions

## Dev Notes

### Implementation Summary (2025-12-23)

**Files Created:**

- `src/capabilities/per-priority.ts` - TD Error + PER functions

**Files Modified:**

- `src/graphrag/algorithms/shgat.ts` - Added `predictPathSuccess()`, `getToolCount()`,
  `getCapabilityCount()`
- `docs/adrs/ADR-050-unified-search-simplification.md` - Documented multi-head architecture

**Tests Created:**

- `tests/unit/capabilities/per_priority_test.ts` - 12 tests, all passing

### Critical Implementation Details

**1. SHGAT.predictPathSuccess() - Multi-Head Architecture (ADR-050)**

Unlike the original proposal (average embeddings), we use the same **multi-head architecture** as
`scoreAllTools` and `scoreAllCapabilities`:

```typescript
// In src/graphrag/algorithms/shgat.ts (line 956-1024)
predictPathSuccess(intentEmbedding: number[], path: string[]): number {
  // Cold start: no nodes registered
  if (this.getCapabilityCount() === 0 && this.getToolCount() === 0) {
    return 0.5;
  }

  // Empty path: neutral prediction
  if (!path || path.length === 0) {
    return 0.5;
  }

  // Cache tool and capability scores (avoid recomputing)
  const toolScoresMap = new Map<string, number>();
  const capScoresMap = new Map<string, number>();

  // Only compute if path contains that node type
  if (path.some(id => this.toolNodes.has(id))) {
    for (const r of this.scoreAllTools(intentEmbedding)) {
      toolScoresMap.set(r.toolId, r.score);
    }
  }
  if (path.some(id => this.capabilityNodes.has(id))) {
    for (const r of this.scoreAllCapabilities(intentEmbedding)) {
      capScoresMap.set(r.capabilityId, r.score);
    }
  }

  // Collect scores for each node
  const nodeScores: number[] = [];
  for (const nodeId of path) {
    nodeScores.push(
      toolScoresMap.get(nodeId) ??
      capScoresMap.get(nodeId) ??
      0.5  // Unknown node
    );
  }

  // Weighted average: later nodes more critical
  // Weights: 1.0, 1.5, 2.0, 2.5, ...
  let weightedSum = 0, weightTotal = 0;
  for (let i = 0; i < nodeScores.length; i++) {
    const weight = 1 + i * 0.5;
    weightedSum += nodeScores[i] * weight;
    weightTotal += weight;
  }

  return weightedSum / weightTotal;
}
```

**2. calculateTDError() uses EmbeddingProvider**

TD Error requires the intent embedding for multi-head scoring:

```typescript
// In src/capabilities/per-priority.ts
async function calculateTDError(
  shgat: SHGAT,
  embeddingProvider: EmbeddingProvider, // VectorSearch or similar
  trace: { intentText?: string; executedPath?: string[]; success: boolean },
): Promise<TDErrorResult> {
  const intentEmbedding = await embeddingProvider.getEmbedding(trace.intentText ?? "");
  const predicted = shgat.predictPathSuccess(intentEmbedding, trace.executedPath ?? []);
  const actual = trace.success ? 1.0 : 0.0;
  const tdError = actual - predicted;
  const priority = Math.abs(tdError); // Clamped to [0.01, 1.0]

  return { tdError, priority, predicted, actual, isColdStart: false };
}
```

**3. Cold Start Strategy**

When SHGAT has no registered nodes:

- `getToolCount() === 0 && getCapabilityCount() === 0`
- Returns `COLD_START_PRIORITY = 0.5`
- All traces get neutral priority until SHGAT learns

**4. Priority Range**

| Scenario           | Predicted | Actual | TD Error | Priority |
| ------------------ | --------- | ------ | -------- | -------- |
| Cold start         | 0.5       | any    | 0        | 0.5      |
| Expected success   | 0.9       | 1.0    | 0.1      | 0.1      |
| Unexpected failure | 0.9       | 0.0    | -0.9     | 0.9      |
| Expected failure   | 0.1       | 0.0    | -0.1     | 0.1      |
| Unexpected success | 0.1       | 1.0    | 0.9      | 0.9      |

### Architecture Compliance

- **Deno 2.x** - Runtime (not Node.js)
- **TypeScript strict mode** - All types explicit
- **camelCase** - For all properties (not snake_case)
- **No magic numbers** - Use constants (e.g., `COLD_START_PRIORITY = 0.5`)
- **Async/await** - No callbacks or .then() chains
- **PGlite** - Traces stored in `execution_trace` table (Story 11.2)

### Files to Create

| File                                           | Purpose                                   | LOC |
| ---------------------------------------------- | ----------------------------------------- | --- |
| `src/capabilities/per-priority.ts`             | TD error calculation and priority storage | ~60 |
| `tests/unit/capabilities/per_priority_test.ts` | Unit tests                                | ~80 |

### Files to Modify

| File                                        | Changes                                           | LOC |
| ------------------------------------------- | ------------------------------------------------- | --- |
| `src/graphrag/algorithms/shgat.ts:~795`     | Add `predictPathSuccess()` method                 | ~40 |
| `src/capabilities/execution-trace-store.ts` | Add `getHighPriorityTraces()`, `updatePriority()` | ~30 |

### References

- [Epic 11: Learning from Traces](../epics/epic-11-learning-from-traces.md)
- [Story 11.1: Result Tracing](./11-1-result-tracing.md) - DONE
- [Story 11.2: Execution Trace Table](../epics/epic-11-learning-from-traces.md#story-112-execution-trace-table--store) -
  PREREQUISITE (backlog)
- [Source: src/graphrag/algorithms/shgat.ts](../../src/graphrag/algorithms/shgat.ts) - SHGAT
  implementation
- [Source: src/capabilities/types.ts](../../src/capabilities/types.ts) - ExecutionTrace types (to be
  added in 11.2)
- [Project Context](../project-context.md) - Architecture patterns

### Previous Story Intelligence (11.1)

From Story 11.1 (Result Tracing - completed 2025-12-22):

- Pattern: `safeSerializeResult()` for handling non-JSON values
- Pattern: IIFE wrapper in code-generator.ts to capture return values
- Test patterns in `tests/unit/sandbox/result_tracing_test.ts`
- EventBus integration: `result` propagated via `tool.end` and `capability.end` events

### Git Intelligence

Recent commits (2025-12-22):

```
f1f924c feat(story-11.0): DB schema cleanup - KV singleton and workflow state cache
cde94eb feat(story-11.1): result tracing for tools and capabilities
dbefd58 chore(story-10.6): mark done + simplify unified-search benchmark
```

Patterns observed:

- Commit format: `feat(story-X.Y): description`
- Test-first approach for algorithm changes
- Story files include Dev Agent Record section

### Dependencies

```
Story 11.2 (execution_trace table) <-- REQUIRED
       |
       v
Story 11.3 (TD Error + PER Priority) <-- THIS STORY
       |
       v
Story 11.6 (SHGAT Training with PER Sampling)
```

**Story 11.2 provides:**

- `execution_trace` table with `priority` column (FLOAT, default 0.5)
- `ExecutionTraceStore` class with `save()`, `getTraces()` methods
- `ExecutionTrace` interface with `executedPath`, `success`, `priority` fields

**This story provides to 11.6:**

- `calculateTDError()` function for computing TD error
- `storeTraceWithPriority()` for saving traces with PER priority
- `SHGAT.predictPathSuccess()` for path-level predictions
- `getHighPriorityTraces()` for PER sampling

### Estimation

**Effort:** 1-2 days (simplified because no CapabilityLearning structure)

**Breakdown:**

- Task 1 (SHGAT.predictPathSuccess): 2-3h
- Task 2 (per-priority.ts): 1-2h
- Task 3 (ExecutionTraceStore methods): 1h
- Task 4 (unit tests): 2h
- Task 5 (validation): 30min

**Risk:**

- Dependency on Story 11.2 (execution_trace table) which is still in backlog
- Recommend implementing 11.2 first, or mocking ExecutionTraceStore for testing

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

### Completion Notes List

- 2025-12-23: Implementation complete, 12 tests passing
- 2025-12-23: Code review identified API mismatches between AC specs and implementation
  (embeddingProvider param required)
- 2025-12-23: Performance concern flagged for predictPathSuccess O(n × forward) complexity

### File List

**Created:**

- `src/capabilities/per-priority.ts` - TD Error + PER priority functions (290 LOC)
- `tests/unit/capabilities/per_priority_test.ts` - 12 unit tests (323 LOC)

**Modified:**

- `src/graphrag/algorithms/shgat.ts` - Added predictPathSuccess(), getToolCount(),
  getCapabilityCount() (~70 LOC added)
- `docs/adrs/ADR-050-unified-search-simplification.md` - Documented multi-head architecture and
  predictPathSuccess
