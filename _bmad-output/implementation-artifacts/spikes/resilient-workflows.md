# Resilient Workflow Patterns Guide

**Story:** 3.5 - Safe-to-Fail Branches & Resilient Workflows **Version:** 1.0 **Date:** 2025-11-20

## Overview

This guide demonstrates how to build resilient workflows using **safe-to-fail branches** and
**partial success execution** in Casys PML. These patterns enable aggressive speculation, graceful
degradation, and fault-tolerant DAG workflows.

## Core Concepts

### Safe-to-Fail Tasks

A task is "safe-to-fail" when:

1. **Type:** `code_execution` (sandbox isolation)
2. **Side effects:** `side_effects: false` (idempotent, no external impact)
3. **Isolation:** Runs in Deno sandbox (no MCP tools, no file writes)

**Detection Logic:**

```typescript
function isSafeToFail(task: Task): boolean {
  return !task.side_effects && task.type === "code_execution";
}
```

### Task Result Structure

Since Story 3.5, the `deps` context contains **full TaskResult objects**:

```typescript
interface TaskResult {
  taskId: string;
  status: "success" | "error" | "failed_safe";
  output?: unknown;
  error?: string;
  executionTimeMs?: number;
}
```

**Old API (Story 3.4):**

```typescript
// deps contained only outputs
const data = deps.fetch_data;
```

**New API (Story 3.5):**

```typescript
// deps contains full TaskResult
const data = deps.fetch_data.output;

// Can check status
if (deps.ml_analysis?.status === "success") {
  results.push(deps.ml_analysis.output);
}
```

### Task Status Types

| Status        | Meaning                                 | Workflow Behavior              |
| ------------- | --------------------------------------- | ------------------------------ |
| `success`     | Task completed successfully             | Continue workflow              |
| `error`       | Critical failure (MCP or non-safe task) | **Halt workflow**              |
| `failed_safe` | Safe-to-fail task failed                | Continue workflow, log warning |

## Pattern 1: Parallel Speculative Execution

**Use Case:** Launch multiple analysis approaches simultaneously, use first success.

### Example: Fast/ML/Stats Analysis

```typescript
const speculativeDAG: DAGStructure = {
  tasks: [
    // Fetch data (MCP task - NOT safe-to-fail)
    {
      id: "fetch",
      tool: "github:list_commits",
      arguments: { repo: "pml", limit: 1000 },
      depends_on: [],
      side_effects: true, // MCP task - has external side effects
    },

    // Launch 3 parallel analysis branches (safe-to-fail)
    {
      id: "fast_analysis",
      type: "code_execution",
      code: `
        const commits = deps.fetch.output;
        return simpleCount(commits);
      `,
      tool: "code_execution",
      arguments: {},
      timeout: 500, // 500ms deadline
      depends_on: ["fetch"],
      side_effects: false, // Safe-to-fail
    },
    {
      id: "ml_analysis",
      type: "code_execution",
      code: `
        const commits = deps.fetch.output;
        return deepLearningAnalysis(commits);
      `,
      tool: "code_execution",
      arguments: {},
      timeout: 2000, // 2s deadline
      depends_on: ["fetch"],
      side_effects: false, // Safe-to-fail
    },
    {
      id: "stats_analysis",
      type: "code_execution",
      code: `
        const commits = deps.fetch.output;
        return statisticalAnalysis(commits);
      `,
      tool: "code_execution",
      arguments: {},
      depends_on: ["fetch"],
      side_effects: false, // Safe-to-fail
    },

    // Aggregate successful results
    {
      id: "aggregate",
      type: "code_execution",
      code: `
        const results = [];

        // Check status and collect successes
        if (deps.fast_analysis?.status === "success") {
          results.push({ type: 'fast', ...deps.fast_analysis.output });
        }
        if (deps.ml_analysis?.status === "success") {
          results.push({ type: 'ml', ...deps.ml_analysis.output });
        }
        if (deps.stats_analysis?.status === "success") {
          results.push({ type: 'stats', ...deps.stats_analysis.output });
        }

        // Use first success (lowest latency)
        return {
          primaryResult: results[0] || null,
          allResults: results,
          successCount: results.length
        };
      `,
      tool: "code_execution",
      arguments: {},
      depends_on: ["fast_analysis", "ml_analysis", "stats_analysis"],
      side_effects: false,
    },
  ],
};
```

**Execution Scenarios:**

1. **All succeed:** Fast (200ms), ML (1.8s), Stats (1.2s) → Return fast result, include all 3
2. **ML timeouts:** Fast (200ms), ML (timeout), Stats (1.2s) → Return fast result, include 2
3. **Only fast succeeds:** Fast (200ms), ML (error), Stats (error) → Return fast result only
4. **All fail:** No results → Aggregate returns null (acceptable)

**Benefits:**

- ⚡ **Low latency:** Use fastest successful result
- 🛡️ **Fault tolerance:** Partial success better than complete failure
- 🎯 **Accuracy trade-off:** Fast simple analysis vs slow deep analysis

## Pattern 2: Graceful Degradation

**Use Case:** Prefer high-quality result, fallback to simple analysis on timeout/failure.

### Example: ML Analysis → Stats Fallback

```typescript
const degradationDAG: DAGStructure = {
  tasks: [
    {
      id: "fetch",
      tool: "github:list_commits",
      arguments: { repo: "pml" },
      depends_on: [],
      side_effects: true,
    },

    // Preferred: ML analysis (with timeout)
    {
      id: "ml_analysis",
      type: "code_execution",
      code: `
        const commits = deps.fetch.output;
        return deepLearningAnalysis(commits);
      `,
      tool: "code_execution",
      arguments: {},
      timeout: 2000, // 2s deadline
      depends_on: ["fetch"],
      side_effects: false, // Safe-to-fail
    },

    // Fallback: Simple stats (always fast)
    {
      id: "stats_fallback",
      type: "code_execution",
      code: `
        const commits = deps.fetch.output;
        return simpleStatistics(commits);
      `,
      tool: "code_execution",
      arguments: {},
      depends_on: ["fetch"],
      side_effects: false,
    },

    // Decision logic: prefer ML, fallback to stats
    {
      id: "final_result",
      type: "code_execution",
      code: `
        // Prefer ML if succeeded
        if (deps.ml_analysis?.status === "success") {
          return {
            source: "ml",
            quality: "high",
            result: deps.ml_analysis.output
          };
        }

        // Fallback to stats
        return {
          source: "stats",
          quality: "degraded",
          result: deps.stats_fallback.output
        };
      `,
      tool: "code_execution",
      arguments: {},
      depends_on: ["ml_analysis", "stats_fallback"],
      side_effects: false,
    },
  ],
};
```

**Degradation Path:**

1. **ML succeeds:** Return high-quality ML analysis
2. **ML timeouts:** Log degradation → Return simple stats
3. **Both fail:** Return empty result (edge case)

**Benefits:**

- 🎯 **Quality preference:** Try best approach first
- ⏱️ **Bounded latency:** Fallback ensures response
- 📊 **Observability:** Track degradation events

## Pattern 3: A/B Testing

**Use Case:** Run two algorithms in parallel, compare results even if one fails.

### Example: Algorithm A vs B Comparison

```typescript
const abTestDAG: DAGStructure = {
  tasks: [
    {
      id: "fetch",
      tool: "github:list_commits",
      arguments: { repo: "pml" },
      depends_on: [],
      side_effects: true,
    },

    // Algorithm A
    {
      id: "algo_a",
      type: "code_execution",
      code: `
        const data = deps.fetch.output;
        return algorithmA(data);
      `,
      tool: "code_execution",
      arguments: {},
      depends_on: ["fetch"],
      side_effects: false, // Safe-to-fail
    },

    // Algorithm B
    {
      id: "algo_b",
      type: "code_execution",
      code: `
        const data = deps.fetch.output;
        return algorithmB(data);
      `,
      tool: "code_execution",
      arguments: {},
      depends_on: ["fetch"],
      side_effects: false, // Safe-to-fail
    },

    // Compare results
    {
      id: "comparison",
      type: "code_execution",
      code: `
        const results = {
          a: deps.algo_a?.status === "success" ? deps.algo_a.output : null,
          b: deps.algo_b?.status === "success" ? deps.algo_b.output : null
        };

        return {
          results,
          metrics: {
            a_succeeded: deps.algo_a?.status === "success",
            b_succeeded: deps.algo_b?.status === "success",
            comparison: results.a && results.b ? compare(results.a, results.b) : null
          }
        };
      `,
      tool: "code_execution",
      arguments: {},
      depends_on: ["algo_a", "algo_b"],
      side_effects: false,
    },
  ],
};
```

**Test Scenarios:**

1. **Both succeed:** Full comparison metrics
2. **A succeeds, B fails:** Partial metrics (A-only)
3. **A fails, B succeeds:** Partial metrics (B-only)
4. **Both fail:** No metrics (edge case)

**Benefits:**

- 🧪 **Safe experimentation:** Test new algorithms in production
- 📈 **Partial insights:** Learn from partial results
- 🔬 **A/B metrics:** Track success rates per algorithm

## Pattern 4: Retry with Idempotence

**Use Case:** Retry flaky safe-to-fail tasks without side effect duplication.

### Automatic Retry Logic

Safe-to-fail tasks are **automatically retried** with exponential backoff:

- **Max attempts:** 3
- **Backoff:** 100ms, 200ms, 400ms
- **Only for:** `side_effects: false && type: "code_execution"`

```typescript
const retryDAG: DAGStructure = {
  tasks: [
    {
      id: "fetch",
      tool: "github:list_commits",
      arguments: { repo: "pml" },
      depends_on: [],
      side_effects: true, // NOT retried (MCP task)
    },

    // Flaky analysis task (automatically retried)
    {
      id: "flaky_analysis",
      type: "code_execution",
      code: `
        const data = deps.fetch.output;
        return flakyMLModel(data);  // May fail, will retry
      `,
      tool: "code_execution",
      arguments: {},
      depends_on: ["fetch"],
      side_effects: false, // Safe-to-fail → automatic retry
    },
  ],
};
```

**Retry Behavior:**

- **Attempt 1:** Fail → Wait 100ms
- **Attempt 2:** Fail → Wait 200ms
- **Attempt 3:** Fail → Mark as `failed_safe`, continue workflow

**Why Safe:**

- ✅ **Idempotent:** Re-execution produces same result
- ✅ **Isolated:** No side effects (no duplicate API calls, no duplicate file writes)
- ✅ **Stateless:** Failure doesn't corrupt system state

## Error Isolation Verification

**Critical Property:** Sandbox failures MUST NOT corrupt downstream MCP tasks.

### Example: Sandbox Fail → MCP Downstream

```typescript
const isolationDAG: DAGStructure = {
  tasks: [
    // Sandbox task that fails
    {
      id: "sandbox_fail",
      type: "code_execution",
      code: `throw new Error("Sandbox analysis failed");`,
      tool: "code_execution",
      arguments: {},
      depends_on: [],
      side_effects: false, // Safe-to-fail
    },

    // Parallel safe branch
    {
      id: "safe_branch",
      type: "code_execution",
      code: `return { status: "ok", data: [1, 2, 3] };`,
      tool: "code_execution",
      arguments: {},
      depends_on: [],
      side_effects: false,
    },

    // Downstream MCP task (depends on both)
    {
      id: "mcp_downstream",
      tool: "github:create_issue",
      arguments: {
        title: "Analysis Results",
        // Can still access safe_branch result
        body: "$OUTPUT[safe_branch]",
      },
      depends_on: ["sandbox_fail", "safe_branch"],
      side_effects: true, // MCP task - NOT safe-to-fail
    },
  ],
};
```

**Execution Flow:**

1. `sandbox_fail` fails → Emits `task_warning`
2. `safe_branch` succeeds → Emits `task_complete`
3. `mcp_downstream` executes with partial deps:
   - `deps.sandbox_fail = { status: "failed_safe", output: null, error: "..." }`
   - `deps.safe_branch = { status: "success", output: { ... } }`
4. MCP task uses `$OUTPUT[safe_branch]` (safe_branch succeeded)

**Guarantees:**

- ✅ Sandbox failure isolated (no state corruption)
- ✅ MCP task receives correct partial deps
- ✅ Workflow continues (partial success)

## Best Practices

### 1. Mark Side Effects Explicitly

```typescript
// ✅ GOOD: Explicit side_effects flag
{
  id: "create_issue",
  tool: "github:create_issue",
  arguments: { ... },
  depends_on: [...],
  side_effects: true  // MCP task - NOT safe-to-fail
}

// ✅ GOOD: Safe-to-fail explicitly
{
  id: "analyze",
  type: "code_execution",
  code: "...",
  depends_on: [...],
  side_effects: false  // Safe-to-fail
}
```

### 2. Always Check Status in Aggregators

```typescript
// ✅ GOOD: Check status before using output
if (deps.task?.status === "success") {
  results.push(deps.task.output);
}

// ❌ BAD: Assume task succeeded
results.push(deps.task.output); // May be null if failed!
```

### 3. Use Timeouts for Speculative Branches

```typescript
// ✅ GOOD: Bounded speculation
{
  id: "ml_analysis",
  type: "code_execution",
  code: "...",
  timeout: 2000,  // 2s deadline
  depends_on: [...],
  side_effects: false
}

// ❌ BAD: Unbounded speculation
{
  id: "ml_analysis",
  type: "code_execution",
  code: "...",
  // No timeout - may run forever!
  depends_on: [...],
  side_effects: false
}
```

### 4. Log Degradation Events

```typescript
// ✅ GOOD: Track quality degradation
if (deps.ml_analysis?.status === "success") {
  console.log("Using high-quality ML analysis");
  return { quality: "high", ...deps.ml_analysis.output };
} else {
  console.warn("ML analysis failed, degrading to stats");
  return { quality: "degraded", ...deps.stats_fallback.output };
}
```

## Performance Characteristics

### Compute Cost

**Safe-to-fail branches consume CPU even if they fail:**

| Pattern              | Wasted Compute (on failure)     | Benefit                         |
| -------------------- | ------------------------------- | ------------------------------- |
| Parallel speculation | 33-66% (1-2 of 3 branches fail) | Low latency (use first success) |
| Graceful degradation | 0-50% (ML timeout)              | Bounded latency guarantee       |
| A/B testing          | 0-50% (1 algorithm fails)       | Safe experimentation            |
| Retry                | 0-200% (up to 3x execution)     | Fault tolerance                 |

**Trade-off:** Wasted compute is cheap (CPU cycles) vs. saved latency/resilience (valuable).

### Latency

| Pattern              | Best Case              | Worst Case             | Typical      |
| -------------------- | ---------------------- | ---------------------- | ------------ |
| Parallel speculation | Fast branch (200ms)    | Slowest branch (2s)    | Fast (200ms) |
| Graceful degradation | ML success (2s)        | Stats fallback (1s)    | ML (2s)      |
| A/B testing          | Parallel (max latency) | Parallel (max latency) | Parallel     |
| Retry                | 1st attempt            | 3 attempts + backoff   | 1st attempt  |

## Integration with Speculative Execution (Epic 3.5)

Safe-to-fail branches unlock **aggressive speculation**:

```typescript
// Gateway can speculatively execute multiple hypotheses
const result = await gatewayHandler.processIntent({
  text: "Analyze commits and find trends",
});

// If confidence > 0.70 → Execute speculatively
// Launch 3 sandbox branches in parallel (all safe-to-fail)
// If predictions wrong → Discard results (no side effects)
// If predictions right → Agent gets instant multi-perspective analysis
```

**Without safe-to-fail:** Speculative execution too risky (side effects) **With safe-to-fail:**
Speculative execution becomes aggressive and safe

## Testing Resilient Workflows

See `tests/e2e/controlled_executor_resilient_test.ts` for comprehensive examples:

- ✅ Pattern 1: Parallel speculation (fast/ML/stats)
- ✅ Pattern 2: Graceful degradation (ML timeout → stats)
- ✅ Pattern 3: A/B testing (parallel algorithms)
- ✅ Pattern 4: Error isolation (sandbox → MCP downstream)
- ✅ Retry logic with exponential backoff

## Migration Guide

### Breaking Change: deps Structure

**Old code (Story 3.4):**

```typescript
// deps contained only outputs
const data = deps.fetch;
```

**New code (Story 3.5):**

```typescript
// deps contains full TaskResult
const data = deps.fetch.output;

// Can check status
if (deps.fetch?.status === "success") {
  // ...
}
```

**Migration Steps:**

1. Update all code_execution tasks:
   - Change `deps.task` → `deps.task.output`
2. MCP tasks unchanged:
   - `$OUTPUT[task_id]` still works (automatic `.output` extraction)
3. Add status checks for resilient patterns:
   - Use `deps.task?.status === "success"` before accessing output

## See Also

- [ADR-010: Hybrid DAG Architecture](../adrs/ADR-010-hybrid-dag-architecture.md) - Safe-to-fail
  property definition
- [Epic 3 Technical Spec](./tech-spec-epic-3.md) - Sandbox foundation for safe-to-fail
- [Story 3.4](./stories/story-3.4.md) - Code execution foundation
- [Story 3.5](./stories/story-3.5.md) - This implementation

---

**Last Updated:** 2025-11-20 **Version:** 1.0 **Author:** Casys PML Team
