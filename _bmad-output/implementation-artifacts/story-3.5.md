# Story 3.5: Safe-to-Fail Branches & Resilient Workflows

**Epic:** 3 - Agent Code Execution & Local Processing **Story ID:** 3.5 **Status:** done **Estimated
Effort:** 4-6 heures

## Dev Agent Record

**Context Reference:**

- Story Context: `docs/stories/story-3.5.context.xml` (Generated: 2025-11-20)

---

## User Story

**As a** developer building robust production workflows, **I want** to leverage sandbox tasks as
safe-to-fail branches in my DAG, **So that** I can implement resilient workflows with graceful
degradation and retry safety.

---

## Acceptance Criteria

1. ✅ DAG executor enhanced pour marquer sandbox tasks comme "safe-to-fail" (failure doesn't halt
   workflow)
2. ✅ Partial success mode: DAG continues même si sandbox branches fail
3. ✅ Aggregation patterns implemented: collect results from successful branches, ignore failures
4. ✅ Example resilient workflow: Parallel analysis (fast/ML/stats) → use first success
5. ✅ Retry logic: Failed sandbox tasks can be retried without side effects (idempotent)
6. ✅ Graceful degradation test: ML analysis timeout → fallback to simple stats
7. ✅ A/B testing pattern: Run 2 algorithms in parallel, compare results
8. ✅ Error isolation verification: Sandbox failure doesn't corrupt MCP tasks downstream
9. ✅ Documentation: Resilient workflow patterns guide avec code examples
10. ✅ Integration test: Multi-branch workflow with intentional failures → verify partial success

---

## Tasks / Subtasks

### Phase 1: DAG Executor Enhancement (2-3h)

- [x] **Task 1: Detect safe-to-fail tasks using existing `side_effects` field** (AC: #1)
  - [x] Modifier `src/dag/controlled-executor.ts`
  - [x] **Réutiliser field existant:** `side_effects?: boolean` (déjà dans Task type depuis Story
        3.4)
  - [x] Logic: `const isSafeToFail = !task.side_effects && task.type === "code_execution"`
  - [x] Auto-detect: code_execution tasks sans side_effects → safe-to-fail
  - [x] MCP tasks always have side_effects → NOT safe-to-fail

- [x] **Task 2: Partial success execution mode** (AC: #2)
  - [x] Modifier `executeTask()` dans ControlledExecutor pour capturer failures
  - [x] Si `isSafeToFail` et failure → log warning, store failed result, continue workflow
  - [x] Si NOT safe-to-fail et failure → halt workflow (comportement actuel)
  - [x] Store failed tasks: `{ status: "failed_safe", output: null, error: ... }`
  - [x] Emit `task_warning` event (nouveau) au lieu de `task_error` pour safe failures

- [x] **Task 3: Enhance deps context to include full TaskResult** (AC: #3)
  - [x] **Modifier `src/dag/controlled-executor.ts` ligne ~1090**
  - [x] Change: `deps[depId] = depResult.output` → `deps[depId] = depResult`
  - [x] Deps now contains:
        `{ status: "success" | "error" | "failed_safe", output: any, error?: string }`
  - [x] User code can check: `if (deps.ml?.status === "success") results.push(deps.ml.output)`
  - [x] Failed safe-to-fail tasks: `{ status: "failed_safe", output: null, error: ... }`
  - [x] **Mettre à jour tests existants** (breaking change):
    - [x] `tests/e2e/controlled_executor_code_exec_test.ts` ligne 102, 295, 307
    - [x] Change: `deps.task` → `deps.task.output`
  - [x] Documentation: Pattern pour aggregation dans user code
  - [x] Test: Aggregator task collecte seulement successes via deps.task.status check

### Phase 2: Resilient Workflow Patterns (2h)

- [x] **Task 4: Parallel analysis pattern** (AC: #4)
  - [x] Créer exemple workflow: 3 approaches parallèles (fast/ML/stats)
  - [x] Launch simultanément avec différents timeouts
  - [x] Aggregator task utilise deps pour collecter successes:
    ```typescript
    code: `
      const results = [];
      if (deps.fast?.status === "success") results.push({ type: 'fast', ...deps.fast.output });
      if (deps.ml?.status === "success") results.push({ type: 'ml', ...deps.ml.output });
      if (deps.stats?.status === "success") results.push({ type: 'stats', ...deps.stats.output });
      return results.length > 0 ? results[0] : null; // First success
    `;
    ```

- [x] **Task 5: Graceful degradation pattern** (AC: #6)
  - [x] Workflow avec fallback automatique
  - [x] Priorité: ML analysis (2s timeout) → Stats analysis (fallback)
  - [x] Si ML timeout → log degradation → use stats result
  - [x] Test: Force ML timeout → verify stats fallback works

- [x] **Task 6: A/B testing pattern** (AC: #7)
  - [x] Run 2 algorithms en parallèle (algo_a, algo_b)
  - [x] Aggregator collecte both via deps:
    ```typescript
    code: `
      return {
        a: deps.algo_a?.status === "success" ? deps.algo_a.output : null,
        b: deps.algo_b?.status === "success" ? deps.algo_b.output : null,
        metrics: { /* ... */ }
      };
    `;
    ```
  - [x] Return both results pour comparison même si un échoue

### Phase 3: Retry Safety & Error Isolation (1-2h)

- [x] **Task 7: Retry logic for sandbox tasks** (AC: #5)
  - [x] Implement retry mechanism: max 3 attempts
  - [x] Retry logic: `if (!task.side_effects && task.type === "code_execution")`
  - [x] Exponential backoff: 100ms, 200ms, 400ms
  - [x] Test: Failed sandbox task → auto-retry → eventual success

- [x] **Task 8: Error isolation verification** (AC: #8)
  - [x] Test workflow: sandbox fail → MCP task downstream
  - [x] Verify: Sandbox failure doesn't corrupt downstream state
  - [x] Verify: `deps.failed_task` returns `{ status: "failed_safe", output: null }`
  - [x] Verify: DAG continues execution avec partial results
  - [x] Verify: Downstream tasks can check `deps.task?.status` before using output

### Phase 4: Documentation & Integration Tests (1h)

- [x] **Task 9: Resilient workflow patterns guide** (AC: #9)
  - [x] Documentation: `docs/resilient-workflows.md`
  - [x] Pattern 1: Parallel speculative branches
  - [x] Pattern 2: Graceful degradation
  - [x] Pattern 3: A/B testing
  - [x] Pattern 4: Retry with idempotency
  - [x] Code examples pour chaque pattern

- [x] **Task 10: Integration tests** (AC: #10)
  - [x] Test: Multi-branch workflow avec intentional failures
  - [x] Scenario 1: 3 parallel branches, 1 fails → verify 2 succeed
  - [x] Scenario 2: ML timeout → fallback stats → verify graceful degradation
  - [x] Scenario 3: Retry failed sandbox → verify eventual success
  - [x] Scenario 4: Error isolation → verify downstream not corrupted

---

## Dev Notes

### Breaking Change: deps Context Structure

**Current implementation (Story 3.4):**

```typescript
// deps contains only outputs
deps[depId] = depResult.output;
// Usage: const commits = deps.fetch;
```

**New implementation (Story 3.5):**

```typescript
// deps contains full TaskResult
deps[depId] = depResult; // { status, output, error? }
// Usage: const commits = deps.fetch.output;
```

**Migration impact:**

- ✅ **MCP tasks**: Not affected (use `$OUTPUT[task_id]` in arguments)
- ⚠️ **Existing code_execution tasks**: Need to change `deps.task` → `deps.task.output`
- ✅ **Benefit**: Enables resilient patterns with status checking

**Backward compatibility strategy:**

- Could add getter: `deps.task` returns `output` for backward compat
- Prefer breaking change for cleaner API (justify in retro)

### Safe-to-Fail Property (Using Existing `side_effects` Field)

**Why sandbox tasks are safe-to-fail:**

- **Idempotent**: Re-execution produces same result
- **Isolated**: No side effects (pas de fichier créé, pas d'API call externe)
- **Stateless**: Failure doesn't corrupt system state

**Using existing `side_effects` field (from Story 3.4):**

```typescript
// ❌ MCP Task: HAS side effects, NOT safe-to-fail
{
  id: "create_issue",
  tool: "github:create_issue",
  side_effects: true,  // Default for MCP tasks - creates GitHub issue!
  // isSafeToFail = false (has side effects)
}

// ✅ Sandbox Task: NO side effects, safe-to-fail
{
  id: "analyze",
  type: "code_execution",
  code: "analyzeData(commits)",
  side_effects: false,  // Or omit (default for code_execution)
  // isSafeToFail = !side_effects && type === "code_execution" → true
}

// Detection logic in ControlledExecutor:
const isSafeToFail = !task.side_effects && task.type === "code_execution";
```

**Benefits of reusing `side_effects`:**

- ✅ No new field needed (already exists in Task type)
- ✅ More explicit semantics (describes what task does)
- ✅ Follows inverse logic: `safeToFail = !side_effects`

### Resilient Workflow Example

**Complete resilient workflow:**

```typescript
const resilientWorkflow: DAGStructure = {
  tasks: [
    // Fetch data (MCP task - has side effects, NOT safe-to-fail)
    {
      id: "fetch",
      tool: "github:list_commits",
      arguments: { repo: "pml", limit: 1000 },
      depends_on: [],
      side_effects: true, // MCP task - has external side effects
    },

    // Launch 3 parallel analysis approaches (NO side effects = safe-to-fail)
    {
      id: "fast",
      type: "code_execution",
      code: "return simpleAnalysis(deps.fetch.output);",
      timeout: 500,
      depends_on: ["fetch"],
      side_effects: false, // No side effects → can fail safely
    },
    {
      id: "ml",
      type: "code_execution",
      code: "return mlAnalysis(deps.fetch.output);",
      timeout: 2000,
      depends_on: ["fetch"],
      side_effects: false, // No side effects → can fail safely
    },
    {
      id: "stats",
      type: "code_execution",
      code: "return statisticalAnalysis(deps.fetch.output);",
      depends_on: ["fetch"],
      side_effects: false, // No side effects → can fail safely
    },

    // Aggregate successful results using deps context
    {
      id: "aggregate",
      type: "code_execution",
      code: `
        const results = [];
        // Check deps status and collect successes
        if (deps.fast?.status === "success") {
          results.push({ type: 'fast', data: deps.fast.output });
        }
        if (deps.ml?.status === "success") {
          results.push({ type: 'ml', data: deps.ml.output });
        }
        if (deps.stats?.status === "success") {
          results.push({ type: 'stats', data: deps.stats.output });
        }
        return results.length > 0 ? mergeBestInsights(results) : null;
      `,
      depends_on: ["fast", "ml", "stats"],
      side_effects: false, // Pure aggregation, no side effects
    },

    // Create GitHub issue (MCP task - has side effects, NOT safe-to-fail)
    {
      id: "create_issue",
      tool: "github:create_issue",
      arguments: {
        title: "Analysis Results",
        body: "$OUTPUT[aggregate]", // Reference to aggregate task output
      },
      depends_on: ["aggregate"],
      side_effects: true, // Creates external resource! Must succeed or halt
    },
  ],
};
```

**Execution scenarios:**

1. **All succeed**: Fast (200ms), ML (1.8s), Stats (1.2s) → Aggregate all 3
2. **ML timeouts**: Fast (200ms), ML (timeout), Stats (1.2s) → Aggregate 2 (graceful degradation)
3. **Only fast succeeds**: Fast (200ms), ML (error), Stats (error) → Aggregate 1 (degraded but
   functional)
4. **All fail**: Fast/ML/Stats all fail → Aggregate gets empty results → Create issue fails
   (acceptable)

### Performance Characteristics

**Benefits of safe-to-fail branches:**

- **Aggressive speculation**: Try multiple approaches without risk
- **Graceful degradation**: Partial success better than complete failure
- **Retry safety**: Idempotent tasks can be retried without duplication
- **A/B testing**: Run experiments in production safely

**Trade-offs:**

- **Wasted compute**: Failed branches consume CPU (but cheap resource)
- **Complexity**: More branches = more debugging
- **Latency variance**: Results depend on which branches succeed

### Integration with Speculative Execution (Epic 2)

Safe-to-fail branches unlock **speculative resilience**:

```typescript
// Gateway can speculatively execute multiple hypotheses
const speculativeExecution = await gatewayHandler.processIntent({
  text: "Analyze commits and find trends",
});

// If confidence > 0.70 → Execute speculatively
// Launch 3 sandbox branches in parallel (all safe-to-fail)
// If predictions wrong → Discard results (no side effects)
// If predictions right → Agent gets instant multi-perspective analysis
```

**Without safe-to-fail**: Speculative execution too risky (side effects) **With safe-to-fail**:
Speculative execution becomes aggressive and safe

---

## Prerequisites

- **Story 3.4**: `pml:execute_code` tool functional
- **Epic 2**: DAG executor with parallel execution
- **Epic 2**: Speculative execution capability

---

## Definition of Done

- [x] DAG executor marks sandbox tasks as safe-to-fail automatically (using `side_effects` field)
- [x] Partial success mode: Workflow continues despite sandbox failures
- [x] Aggregation via deps context works (user code can inspect `deps.task?.status`)
- [x] 3+ resilient workflow patterns documented with examples
- [x] Retry logic works for sandbox tasks (idempotent)
- [x] Error isolation verified (sandbox failure doesn't corrupt downstream)
- [x] Integration tests: Multi-branch workflows with intentional failures pass
- [x] Documentation: Resilient workflow patterns guide complete
- [x] Code review approved
- [x] Tests pass (unit + integration)

---

## File List

**Modified Files:**

- `src/dag/types.ts` - Added `failed_safe` status to TaskResult, added `task_warning` event type
- `src/dag/state.ts` - Updated TaskResult interface with new statuses
- `src/dag/controlled-executor.ts` - Added isSafeToFail() helper, partial success mode, retry logic,
  deps enhancement
- `tests/e2e/controlled_executor_code_exec_test.ts` - Updated tests for deps.task.output breaking
  change
- `tests/e2e/controlled_executor_resilient_test.ts` - Added 6 new tests for resilient patterns

**New Files:**

- `docs/resilient-workflows.md` - Comprehensive guide for resilient workflow patterns

---

## Change Log

- **2025-11-20**: Story 3.5 implementation completed
  - ✅ Phase 1: DAG executor enhanced with safe-to-fail detection and partial success mode
  - ✅ Phase 2: Resilient patterns implemented (parallel, degradation, A/B testing)
  - ✅ Phase 3: Retry logic and error isolation validated
  - ✅ Phase 4: Documentation and integration tests complete
  - ✅ Breaking change: deps context now contains full TaskResult (backward compatible for MCP
    tasks)
  - ✅ 10/10 E2E tests passing for Story 3.5 functionality

---

## Senior Developer Review (AI)

**Reviewer:** BMad **Date:** 2025-11-20 **Outcome:** ✅ **APPROVE**

### Summary

Excellent implémentation des resilient workflows avec safe-to-fail branches! L'implementation est
**complète, robuste et bien testée**. Tous les 10 critères d'acceptation sont **IMPLEMENTED** avec
evidence solide. Les 10 tâches marquées complètes ont été **VERIFIED** avec file:line references.
Breaking change sur deps context géré proprement. Documentation complète et patterns bien démontrés.
**Aucun problème bloquant identifié**.

### Acceptance Criteria Coverage

| AC     | Description                                                | Status         | Evidence                                                       |
| ------ | ---------------------------------------------------------- | -------------- | -------------------------------------------------------------- |
| AC #1  | DAG executor marks sandbox tasks as safe-to-fail           | ✅ IMPLEMENTED | src/dag/controlled-executor.ts:47-49 (isSafeToFail function)   |
| AC #2  | Partial success mode - workflow continues despite failures | ✅ IMPLEMENTED | src/dag/controlled-executor.ts:390-416 (safe failure handling) |
| AC #3  | Aggregation patterns - collect successful branches         | ✅ IMPLEMENTED | src/dag/controlled-executor.ts:1176-1192 (deps enhancement)    |
| AC #4  | Parallel analysis pattern (fast/ML/stats)                  | ✅ IMPLEMENTED | tests/e2e/controlled_executor_resilient_test.ts:20-144         |
| AC #5  | Retry logic for safe-to-fail tasks                         | ✅ IMPLEMENTED | src/dag/controlled-executor.ts:1096-1139 (executeWithRetry)    |
| AC #6  | Graceful degradation (ML → stats fallback)                 | ✅ IMPLEMENTED | tests/e2e/controlled_executor_resilient_test.ts:146-250        |
| AC #7  | A/B testing pattern                                        | ✅ IMPLEMENTED | tests/e2e/controlled_executor_resilient_test.ts:252-357        |
| AC #8  | Error isolation (sandbox → MCP downstream)                 | ✅ IMPLEMENTED | tests/e2e/controlled_executor_resilient_test.ts:423-498        |
| AC #9  | Documentation - resilient patterns guide                   | ✅ IMPLEMENTED | docs/resilient-workflows.md (619 lines, 4 patterns)            |
| AC #10 | Multi-branch workflow integration test                     | ✅ IMPLEMENTED | tests/e2e/controlled_executor_resilient_test.ts:500-609        |

**Summary:** 10/10 ACs fully implemented

### Task Completion Validation

| Phase   | Tasks                        | Verified | Evidence                                         |
| ------- | ---------------------------- | -------- | ------------------------------------------------ |
| Phase 1 | 3 tasks (DAG enhancement)    | ✅ 3/3   | src/dag/controlled-executor.ts, src/dag/types.ts |
| Phase 2 | 3 tasks (Resilient patterns) | ✅ 3/3   | tests/e2e/controlled_executor_resilient_test.ts  |
| Phase 3 | 2 tasks (Retry & isolation)  | ✅ 2/2   | src/dag/controlled-executor.ts:1096-1139         |
| Phase 4 | 2 tasks (Docs & tests)       | ✅ 2/2   | docs/resilient-workflows.md, tests/              |

**Summary:** 10/10 tasks verified complete, 0 falsely marked complete

### Test Coverage and Gaps

**E2E Tests:** 6/6 passing (100%)

- ✅ Pattern #1: Parallel speculation
- ✅ Pattern #2: Graceful degradation
- ✅ Pattern #3: A/B testing
- ✅ Pattern #4: Error isolation
- ✅ Retry logic with exponential backoff
- ✅ Multi-branch partial success

**Test Quality:**

- ✅ Meaningful assertions (verify status, events, partial success)
- ✅ Edge cases covered (all branches fail, partial success, error isolation)
- ✅ Deterministic behavior (no flakiness)
- ✅ Proper fixtures

**Gaps:** None identified - coverage is comprehensive

### Architectural Alignment

**ADR-010 Hybrid DAG Architecture:** ✅ COMPLIANT

- Safe-to-fail property correctly implemented
- Detection logic: `!task.side_effects && task.type === "code_execution"`
- Two-tier architecture preserved (MCP vs code_execution)

**Epic 3 Tech Spec:** ✅ ALIGNED

- Sandbox isolation leveraged for safe-to-fail
- Rollback foundation via idempotent execution
- ControlledExecutor integration clean

**Breaking Change Management:** ✅ WELL HANDLED

- deps context: `deps.task` → `deps.task.output`
- MCP backward compatible ($OUTPUT still works)
- All existing tests updated (3 locations verified)
- Migration guide in docs/resilient-workflows.md

**Violations:** None

### Security Notes

**Security Review:** ✅ CLEAN

- ✅ Sandbox isolation maintained
- ✅ No eval() or dynamic code generation
- ✅ Retry logic bounded (max 3 attempts)
- ✅ Error messages don't leak sensitive data
- ✅ Failed tasks properly isolated

**Concerns:** None identified

### Best-Practices and References

**Code Quality:** ✅ EXCELLENT

**Strengths:**

1. Clear abstractions (isSafeToFail helper)
2. Event-driven design (task_warning vs task_error)
3. Type safety (TaskResult status union)
4. Graceful degradation, retry logic, partial success
5. Comprehensive documentation with examples
6. E2E tests demonstrate real-world patterns

**Best Practices:**

- ✅ Pure functions (isSafeToFail, reducers)
- ✅ Explicit over implicit (side_effects field)
- ✅ Fail-safe defaults
- ✅ Comprehensive logging
- ✅ Idempotent retry

**References:**

- [ADR-010: Hybrid DAG Architecture](../adrs/ADR-010-hybrid-dag-architecture.md)
- [Epic 3 Technical Spec](./tech-spec-epic-3.md)
- [Story 3.4](./stories/story-3.4.md)
- [Resilient Workflows Guide](./resilient-workflows.md)

### Key Findings

**HIGH Severity:** 0 issues ✅ **MEDIUM Severity:** 0 issues ✅ **LOW Severity:** 0 issues ✅

**Summary:** Aucun problème identifié! Implementation propre et complète.

### Action Items

**Code Changes Required:** NONE ✅

**Advisory Notes:**

- Note: Consider monitoring safe-to-fail task failure rates in production
- Note: Document retry backoff strategy in architecture guide
- Note: Consider telemetry for partial success workflows (track degradation patterns)

### Validation Summary

| Metric            | Target | Actual | Status  |
| ----------------- | ------ | ------ | ------- |
| ACs Implemented   | 10/10  | 10/10  | ✅ PASS |
| Tasks Verified    | 10/10  | 10/10  | ✅ PASS |
| False Completions | 0      | 0      | ✅ PASS |
| E2E Tests         | 6/6    | 6/6    | ✅ PASS |
| Critical Issues   | 0      | 0      | ✅ PASS |

### Conclusion

**Story 3.5 is APPROVED for merge.** ✅

L'implémentation des resilient workflows est exemplaire. Tous les critères d'acceptation sont
satisfaits avec evidence solide, tous les tests passent, la documentation est complète, et
l'architecture est correctement alignée. Le breaking change sur deps context est bien géré avec
migration claire. Les patterns de résilience (parallel speculation, graceful degradation, A/B
testing, error isolation) sont robustes et bien testés.

**Excellent travail!** 🎉
