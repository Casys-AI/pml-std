# Story 11.1: Result Tracing - Capture des Résultats d'Exécution

Status: done

## Story

As a learning system, I want to capture the `result` of each tool and capability execution, So that
I can store execution traces with actual outcomes for learning.

## Context & Background

**Epic 11: Learning from Execution Traces** focuses on building a TD Error + PER + SHGAT learning
system (DQN/Rainbow style). This story is the first step: capturing execution results in traces.

**Why this matters:**

- Epic 10 created Capabilities via static analysis
- Epic 11 will learn from actual execution traces
- Story 11.2 will persist these traces to `execution_trace` table
- Story 11.3 will calculate TD error using SHGAT predictions vs actual results
- Story 11.6 will train SHGAT using PER-weighted sampling from traces

**Current state (before this story):**

- `tool_start` event includes `args` (AC1 already done - see lines 404-411 in worker-bridge.ts)
- `tool_end` event has `success`, `durationMs`, `error` but **NOT `result`**
- `capability_end` event has `success`, `error` but **NOT `result`**

**Prerequisite:** Story 11.0 (DB Schema Cleanup) is **done** - KV singleton, workflow-state-cache,
migration 019 completed 2025-12-22.

## Acceptance Criteria

1. **AC1:** `tool_end` event includes `result` in `worker-bridge.ts` (line ~447):
   ```typescript
   this.traces.push({
     type: "tool_end",
     tool: toolId,
     traceId: id,
     ts: endTime,
     success: !isToolError,
     durationMs: durationMs,
     parentTraceId: parentTraceId,
     result: result, // ← NEW - Story 11.1
   });
   ```

2. **AC2:** `capability_end` event includes `result` in `code-generator.ts` (line ~87-106):
   ```typescript
   // In generateInlineCode() template - capture return value:
   async (args) => {
     // ... depth check, trace start ...
     let __capSuccess = true;
     let __capError = null;
     let __capResult = undefined;  // ← NEW
     const __capStartTime = Date.now();  // ← NEW for durationMs
     try {
       __capResult = await (async () => { ${sanitizedCode} })();  // ← Wrap to capture
       return __capResult;
     } catch (e) { ... }
     finally {
       __trace({
         type: "capability_end",
         capability: "${name}",
         capabilityId: "${capability.id}",
         success: __capSuccess,
         error: __capError?.message,
         result: __capResult,  // ← NEW
         durationMs: Date.now() - __capStartTime,  // ← NEW
       });
     }
   }
   ```

3. **AC3:** Types updated in `src/sandbox/types.ts`:
   - Add `result?: unknown` to `BaseTraceEvent` interface (line ~263)

4. **AC4:** EventBus payload types updated in `src/events/types.ts`:
   - Add `result?: unknown` to `ToolEndPayload` (line ~126)
   - Add `result?: unknown` to `CapabilityEndPayload` (line ~164)

5. **AC5:** EventBus emit calls updated in `src/sandbox/worker-bridge.ts`:
   - Line ~501: Add `result` to `tool.end` eventBus.emit payload
   - Line ~196: Add `result` to `capability.end` eventBus.emit payload (via BroadcastChannel
     handler)

6. **AC6:** sandbox-worker.ts `__trace()` function handles `result`:
   - Line ~96: Add `result: event.result` to `fullEvent` object

7. **AC7:** Tests: tool execution → result captured in trace
   - Unit test in `tests/unit/sandbox/result_tracing_test.ts` (NEW file)

8. **AC8:** Tests: capability execution → result captured in trace
   - Unit test for code-generator.ts capability tracing

9. **AC9:** Tests: result is JSON-serializable (no circular refs)
   - Test that circular objects are handled gracefully (fallback to summary)

## Tasks / Subtasks

- [x] **Task 1: Update TraceEvent types** (AC: #3)
  - [x] 1.1 Add `result?: unknown` to `BaseTraceEvent` in `src/sandbox/types.ts:263`
  - [x] 1.2 Verify discriminated union still works correctly

- [x] **Task 2: Update EventBus payload types** (AC: #4)
  - [x] 2.1 Add `result?: unknown` to `ToolEndPayload` in `src/events/types.ts:126`
  - [x] 2.2 Add `result?: unknown` to `CapabilityEndPayload` in `src/events/types.ts:164`

- [x] **Task 3: Capture tool results in worker-bridge.ts** (AC: #1, #5)
  - [x] 3.1 Store `result` in tool_end trace event (line ~447)
  - [x] 3.2 Store `result` in eventBus.emit payload for tool.end (line ~459)
  - [x] 3.3 Handle potential circular refs with `safeSerializeResult()` helper

- [x] **Task 4: Capture capability results in code-generator.ts** (AC: #2, #5)
  - [x] 4.1 Add `let __capResult = undefined;` to template
  - [x] 4.2 Add `const __capStartTime = Date.now();` for durationMs
  - [x] 4.3 Wrap sanitizedCode in IIFE to capture return:
        `__capResult = await (async () => { ... })()`
  - [x] 4.4 Add `result: __capResult` and `durationMs` to capability_end __trace() call
  - [x] 4.5 Update eventBus handler in worker-bridge.ts:158-172 for capability.end

- [x] **Task 5: Update sandbox-worker.ts __trace()** (AC: #6)
  - [x] 5.1 Add `result: event.result` to fullEvent object (line ~96)
  - [x] 5.2 Add `durationMs: event.durationMs` to fullEvent if present

- [x] **Task 6: Write unit tests** (AC: #7, #8, #9)
  - [x] 6.1 Create `tests/unit/sandbox/result_tracing_test.ts`
  - [x] 6.2 Test tool_end includes result after successful tool call
  - [x] 6.3 Test capability_end includes result after capability execution
  - [x] 6.4 Test circular reference handling (should not crash)
  - [x] 6.5 Test large results (verify no memory issues)

- [x] **Task 7: Validation**
  - [x] 7.1 `deno check` passes for all modified files
  - [x] 7.2 Run existing sandbox tests: 275 tests passing
  - [x] 7.3 New result_tracing_test.ts: 7 tests passing

## Dev Notes

### Critical Implementation Details

**1. Result Serialization Safety**

MCP tools can return arbitrary objects. Ensure results are JSON-serializable:

```typescript
// In worker-bridge.ts handleRPCCall():
let safeResult: unknown = result;
try {
  // Validate JSON serializable
  JSON.stringify(result);
} catch {
  // Fallback for non-serializable results
  safeResult = { __type: "non-serializable", toString: String(result) };
}
this.traces.push({ ..., result: safeResult });
```

**2. Large Result Handling**

Consider result size for traces. Story 11.2 will truncate for storage, but in-memory traces should
handle large results:

```typescript
// For now, store full result in trace
// Story 11.2 will handle storage truncation in ExecutionTraceStore
```

**3. Capability Code Template Change**

Current template (code-generator.ts:87-106):

```typescript
async (args) => {
  // ... depth check, trace start ...
  let __capSuccess = true;
  let __capError = null;
  try {
    ${sanitizedCode}  // ← Problem: doesn't capture return value!
  } catch (e) { ... }
  finally { ... }
}
```

New template (Story 11.1):

```typescript
async (args) => {
  // ... depth check, trace start ...
  let __capSuccess = true;
  let __capError = null;
  let __capResult = undefined;  // ← NEW
  try {
    __capResult = await (async () => { ${sanitizedCode} })();  // ← Wrap to capture return
    return __capResult;
  } catch (e) { ... }
  finally {
    __trace({
      // ...
      result: __capResult,  // ← NEW
    });
  }
}
```

### Files to Modify

| File                                        | Changes                                                         | LOC |
| ------------------------------------------- | --------------------------------------------------------------- | --- |
| `src/sandbox/types.ts:263`                  | Add `result?: unknown` to BaseTraceEvent                        | ~3  |
| `src/events/types.ts:126,164`               | Add `result?: unknown` to ToolEndPayload + CapabilityEndPayload | ~4  |
| `src/sandbox/worker-bridge.ts:447,459,169`  | Add result to tool_end trace + eventBus + capability_end emit   | ~15 |
| `src/sandbox/sandbox-worker.ts:96`          | Add `result` and `durationMs` to fullEvent in __trace()         | ~5  |
| `src/capabilities/code-generator.ts:87-106` | Capture return value + durationMs in template                   | ~20 |

### Files to Create

| File                                        | Purpose                               | LOC  |
| ------------------------------------------- | ------------------------------------- | ---- |
| `tests/unit/sandbox/result_tracing_test.ts` | Unit tests for result capture (AC7-9) | ~100 |

### Architecture Compliance

- **Deno 2.x** - Runtime (not Node.js)
- **TypeScript strict mode** - All types explicit
- **camelCase** - For all properties (not snake_case)
- **No magic strings** - Use constants/types
- **Async/await** - No callbacks or .then() chains
- **PGlite/Deno KV** - No persistence in this story (handled by 11.2)

### References

- [Epic 11: Learning from Traces](../epics/epic-11-learning-from-traces.md)
- [Story 11.0: DB Schema Cleanup](./11-0-db-schema-cleanup.md) - Prerequisite (DONE)
- [Source: src/sandbox/worker-bridge.ts:447](../../src/sandbox/worker-bridge.ts) - tool_end trace
- [Source: src/sandbox/sandbox-worker.ts:76-123](../../src/sandbox/sandbox-worker.ts) - __trace()
  function
- [Source: src/capabilities/code-generator.ts:87-106](../../src/capabilities/code-generator.ts) -
  generateInlineCode()
- [Source: src/sandbox/types.ts:263](../../src/sandbox/types.ts) - BaseTraceEvent interface
- [Source: src/events/types.ts:126,164](../../src/events/types.ts) - ToolEndPayload,
  CapabilityEndPayload
- [Tests: tests/unit/sandbox/worker_bridge_test.ts](../../tests/unit/sandbox/worker_bridge_test.ts) -
  Existing test patterns
- [ADR-036: EventBus BroadcastChannel](../adrs/ADR-036-eventbus-broadcast-channel.md)
- [ADR-041: Hierarchical Trace Tracking](../adrs/ADR-041-hierarchical-trace-tracking.md)

### Previous Story Intelligence (11.0)

From Story 11.0 (DB Schema Cleanup):

- **Patterns established:** KV singleton in `src/cache/kv.ts`, module exports in `src/cache/mod.ts`
- **Test patterns:** `tests/unit/cache/workflow-state-cache.test.ts` - 11 tests with setup/teardown
- **Files created:** workflow-state-cache.ts uses same patterns we'll need for tracing

### Git Intelligence

Recent commits (2025-12-22):

```
dbefd58 chore(story-10.6): mark done + simplify unified-search benchmark
acda3ff benchmarks algo + work on algos
352ebdb test(dr-dsp): add unit tests with meta-capability hierarchy
```

Patterns observed:

- Commit format: `type(scope): message`
- Test-first approach for algorithm changes
- Benchmark separation from test suite

### Estimation

**Effort:** 1 day

**Breakdown:**

- Task 1 (types.ts): 15 min
- Task 2 (events/types.ts): 15 min
- Task 3 (worker-bridge.ts): 1h
- Task 4 (code-generator.ts): 1.5h (template refactoring)
- Task 5 (sandbox-worker.ts): 30 min
- Task 6 (unit tests): 2h
- Task 7 (validation): 30 min

**Risk:** code-generator.ts template change requires careful testing - the IIFE wrapping must
preserve async behavior and error handling.

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

- No debug logs required - all tests pass

### Completion Notes List

- ✅ AC1-AC6: All type and implementation changes completed
- ✅ AC7-AC9: 9 unit tests created and passing
- ✅ Added `safeSerializeResult()` helper for circular reference handling
- ✅ Capability template now wraps code in IIFE to capture return value
- ✅ Both tool_end and capability_end traces now include `result` and `durationMs`
- ✅ EventBus payloads updated to propagate results to subscribers
- ✅ 277 sandbox tests passing (including 9 new result tracing tests)

**Code Review Fixes (2025-12-22):**

- ✅ Added `parentTraceId?: string` to ToolStartPayload and ToolEndPayload (ADR-041 compliance)
- ✅ Added `MAX_TOSTRING_LENGTH` constant for non-serializable result fallback
- ✅ Fixed null handling bug in worker-bridge.ts (optional chaining for mcpResult?.isError)
- ✅ Added test for tool failure case (result NOT captured when success=false)
- ✅ Added test for raw null result handling

### File List

**Modified:**

- `src/sandbox/types.ts` - Added `result?: unknown` to BaseTraceEvent
- `src/events/types.ts` - Added `result?: unknown` to ToolEndPayload/CapabilityEndPayload +
  `parentTraceId?: string`
- `src/sandbox/worker-bridge.ts` - Added safeSerializeResult(), result capture, MAX_TOSTRING_LENGTH,
  null handling fix
- `src/sandbox/sandbox-worker.ts` - Added result and durationMs to __trace() fullEvent
- `src/capabilities/code-generator.ts` - Refactored template to capture result via IIFE wrapper

**Created:**

- `tests/unit/sandbox/result_tracing_test.ts` - 9 unit tests for result tracing

### Change Log

- 2025-12-22: Story 11.1 implementation complete - result tracing for tools and capabilities
- 2025-12-22: Code review fixes - parentTraceId types, null handling bug, 2 additional tests
