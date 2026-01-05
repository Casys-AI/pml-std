# Tech-Spec: Modular DAG Code Execution

**Created:** 2025-12-26 **Updated:** 2025-12-27 **Status:** Ready for Development **Author:** Erwan
/ Claude

---

## Overview

### Problem Statement

The current PML system executes agent code as a monolithic sandbox block, which limits:

1. **SHGAT Learning** - Cannot observe granular operations (filter, map, reduce) for pattern
   learning
2. **HIL Validation** - Either too many or too few validation checkpoints
3. **Checkpointing** - Cannot resume execution mid-workflow
4. **Parallelism** - Missed opportunities for parallel execution of independent operations

### Solution

**Phase 1 (MVP):** Detect JS operations and represent them as `code:*` pseudo-tools in the DAG.
Execute code as-is, trace only the operation names for SHGAT.

**Phase 2+ (Future):** Implement DAG fusion for performance optimization.

| Phase        | What                | Complexity         |
| ------------ | ------------------- | ------------------ |
| **Phase 1**  | Detection + Tracing | Simple             |
| **Phase 2+** | DAG Fusion          | Complex (deferred) |

### Scope

**In Scope (Phase 1):**

- Detect JS operations via SWC parsing (filter, map, reduce, etc.)
- Create pseudo-tools with `code:` prefix convention
- Auto-classify pure operations to bypass HIL
- Generate operation traces for SHGAT learning

**Deferred to Phase 2+:**

- DAG optimizer for task fusion
- Two-level DAG architecture (logical vs physical)

**Out of Scope:**

- Loop unrolling (while, for with dynamic conditions)
- eval/Function code generation
- External module imports in code tasks

---

## Key Technical Decisions

> These decisions were made after discussing the 4 main technical challenges.

### Decision 1: Scope Capture → BYPASSED

**Problem:** Callbacks can reference external variables (`threshold` in `u => u.score > threshold`).

**Decision:** Execute original code as-is, trace only operation names.

```typescript
// SHGAT learns:
executedPath = ["code:filter", "code:map", "code:reduce"];

// SHGAT does NOT learn:
// - Variable names (threshold vs limit)
// - Concrete values (100 vs 200)
// - Callback content (u => u.active)
```

**Impact:** No scope analysis needed. No variable serialization. Simple.

### Decision 2: Code Extraction → Span Slicing

**Problem:** SWC gives AST, not source code.

**Decision:** Use SWC spans to extract original code.

```typescript
// SWC provides: span: { start: 45, end: 72 }
const code = originalCode.substring(span.start, span.end);
// Result: "users.filter(u => u.active)"
```

**Impact:** Simple, faithful to original code.

### Decision 3: DAG Fusion → DEFERRED Phase 2+

**Problem:** Fusing N tasks into 1 is complex.

**Decision:** Phase 1 executes each operation as separate task. Measure overhead first.

| Without Fusion                | With Fusion            |
| ----------------------------- | ---------------------- |
| More layers, more checkpoints | Fewer layers           |
| Better debugging              | Less granular          |
| SHGAT traces identical        | SHGAT traces identical |

**Impact:** No `dag-optimizer.ts` needed Phase 1. Simpler implementation.

### Decision 4: Executor → Reuse `code_execution`

**Problem:** How to execute `code:*` tasks?

**Decision:** Reuse existing `code_execution` type and `executeCodeTask()`.

```typescript
// Task generated:
{
  type: "code_execution",  // ← Existing type!
  tool: "code:filter",
  code: "users.filter(u => u.active)",
  sandboxConfig: { permissionSet: "minimal" }
}
// Routed to existing executeCodeTask() - zero new code
```

**Impact:** Zero executor changes.

---

## Context for Development

### Codebase Patterns

| File                                           | Purpose                  | Phase 1 Changes               |
| ---------------------------------------------- | ------------------------ | ----------------------------- |
| `src/capabilities/static-structure-builder.ts` | SWC AST parsing          | Add array operation detection |
| `src/dag/static-to-dag-converter.ts`           | Convert AST to DAG       | Generate `code:*` tasks       |
| `src/dag/execution/task-router.ts`             | Route tasks to executors | Extend `isSafeToFail()`       |
| `src/dag/pure-operations.ts`                   | **NEW**                  | Pure operation registry       |

### Files to Reference

**Design Documents (this folder):**

- [impact-analysis.md](./impact-analysis.md) - Detailed code impact analysis
- [swc-static-structure-detection.md](../../architecture/swc-static-structure-detection.md) - ⭐
  **Moved to Architecture** - Core SWC detection patterns, literal bindings
- [parseable-code-patterns.md](./parseable-code-patterns.md) - All detectable JS patterns
- [modular-operations-implementation.md](./modular-operations-implementation.md) - Pseudo-tools
  implementation
- [pure-operations-permissions.md](./pure-operations-permissions.md) - HIL bypass for pure ops
- [two-level-dag-architecture.md](./two-level-dag-architecture.md) - Logical vs Physical DAG + UI
  Fusion Display (Phase 2a)
- [operation-embeddings.md](./operation-embeddings.md) - Operation embeddings for SHGAT learning
  (Phase 2a)
- [shgat-learning-and-dag-edges.md](./shgat-learning-and-dag-edges.md) - Learning impact
- [modular-code-execution.md](./modular-code-execution.md) - Examples

---

## Implementation Plan

### Phase 1: MVP (Priority 1)

**Goal:** Detect operations, execute as-is, trace for SHGAT.

#### Task 1.1: Array Operation Detection

Extend `StaticStructureBuilder.handleCallExpression()`:

```typescript
// Detect array methods
const TRACKED_METHODS = [
  "filter",
  "map",
  "reduce",
  "flatMap",
  "find",
  "findIndex",
  "some",
  "every",
  "sort",
  "slice",
];

if (callee.type === "MemberExpression") {
  const methodName = callee.property?.value;
  if (TRACKED_METHODS.includes(methodName)) {
    const code = originalCode.substring(node.span.start, node.span.end);
    nodes.push({
      id: this.generateNodeId("task"),
      type: "task",
      tool: `code:${methodName}`,
      code, // ← Original code via span
      position,
      parentScope,
    });
  }
}
```

#### Task 1.2: Pure Operations Registry

Create `src/dag/pure-operations.ts`:

```typescript
export const PURE_OPERATIONS = [
  // Array
  "code:filter",
  "code:map",
  "code:reduce",
  "code:flatMap",
  "code:find",
  "code:findIndex",
  "code:some",
  "code:every",
  "code:sort",
  "code:slice",
  "code:concat",
  "code:join",
  // String
  "code:split",
  "code:replace",
  "code:trim",
  "code:toLowerCase",
  "code:toUpperCase",
  // Object
  "code:Object.keys",
  "code:Object.values",
  "code:Object.entries",
  // JSON
  "code:JSON.parse",
  "code:JSON.stringify",
] as const;

export function isPureOperation(toolId: string): boolean {
  return PURE_OPERATIONS.includes(toolId as typeof PURE_OPERATIONS[number]);
}

export function isCodeOperation(toolId: string): boolean {
  return toolId.startsWith("code:");
}
```

#### Task 1.3: Extend isSafeToFail()

In `src/dag/execution/task-router.ts`:

```typescript
import { isCodeOperation, isPureOperation } from "../pure-operations.ts";

export function isSafeToFail(task: Task): boolean {
  // Existing: code_execution with minimal permissions
  if (task.type === "code_execution") {
    const permSet = task.sandboxConfig?.permissionSet ?? "minimal";
    if (permSet === "minimal") return true;
  }

  // NEW: Pure operations are always safe-to-fail
  if (isCodeOperation(task.tool) && isPureOperation(task.tool)) {
    return true;
  }

  return false;
}
```

#### Task 1.4: DAG Converter Update

In `src/dag/static-to-dag-converter.ts`, update `nodeToTask()`:

```typescript
case "task":
  // Handle code:* operations
  if (node.tool.startsWith("code:")) {
    return {
      id: taskId,
      tool: node.tool,
      type: "code_execution",
      code: node.code,  // ← From span extraction
      arguments: {},
      dependsOn: [],
      sandboxConfig: { permissionSet: "minimal" },
      metadata: { pure: isPureOperation(node.tool) },
    };
  }
  // ... existing MCP tool handling
```

#### Task 1.5: Unit Tests

```typescript
Deno.test("detects filter operation", async () => {
  const builder = new StaticStructureBuilder(db);
  const structure = await builder.buildStaticStructure(
    `users.filter(u => u.active)`,
  );
  assertEquals(structure.nodes[0].tool, "code:filter");
});

Deno.test("isPureOperation returns true for code:filter", () => {
  assertEquals(isPureOperation("code:filter"), true);
  assertEquals(isPureOperation("filesystem:read"), false);
});

Deno.test("isSafeToFail returns true for pure operations", () => {
  const task = { tool: "code:filter", type: "code_execution" };
  assertEquals(isSafeToFail(task), true);
});
```

---

### Phase 2a: DAG Fusion - Sequential (COMPLETE)

**Goal:** Fuse sequential pure operations for performance.

**Status:** ✅ **COMPLETE** (2025-12-27)

- [x] Implement `canFuseTasks(tasks: Task[]): boolean`
- [x] Implement `fuseTasks(tasks: Task[]): Task`
- [x] Implement `optimizeDAG(logical: DAG): OptimizedDAG`
- [x] Generate logical traces from fused execution
- [x] Unit tests for fusion logic
- [x] E2E tests for pure code execution
- [x] Integration with ControlledExecutor
- [x] Update execute-handler.ts to use optimizer
- [x] Update code-execution-handler.ts to use optimizer

**Files Created:**

- `src/dag/dag-optimizer.ts` - Sequential fusion implementation
- `src/dag/trace-generator.ts` - Logical trace generation
- `tests/unit/dag/dag-optimizer.test.ts` - Unit tests
- `tests/e2e/code-execution/07-dag-optimizer-pure-code.test.ts` - E2E tests

**Files Modified (Integration):**

- `src/mcp/handlers/execute-handler.ts` - Integrated optimizer for `executeDirectMode` and
  `executeByNameMode`
- `src/mcp/handlers/code-execution-handler.ts` - Integrated optimizer for deprecated
  `pml:execute_code`

**Impact:**

- ✅ Pure code with literals now works (no more `ReferenceError: numbers is not defined`)
- ✅ Execution layers reduced by ~50% for sequential pure operations
- ✅ SHGAT receives logical traces with atomic operations for learning
- ✅ Performance optimization via code fusion

**Next:** Phase 2b+ (Fork-join, partial fusion) - Deferred

---

## Phase 1 Implementation Status

**Status:** ✅ **IMPLEMENTED** (2025-12-26) **Commits:** `c348a58`, `edf2d40`, `d878ed8`, `438f01e`,
`0fb74b8`, `ae0b4b8`

### What Was Implemented

| Component                    | Location                                               | Status               |
| ---------------------------- | ------------------------------------------------------ | -------------------- |
| SWC operation detection      | `src/capabilities/static-structure-builder.ts`         | ✅ Complete          |
| Pure operations registry     | `src/capabilities/pure-operations.ts`                  | ✅ Complete (97 ops) |
| Pseudo-tools generation      | `src/dag/static-to-dag-converter.ts`                   | ✅ Complete          |
| WorkerBridge routing         | `src/sandbox/worker-bridge.ts`                         | ✅ Complete          |
| Variable bindings            | `src/capabilities/static-structure-builder.ts:588-594` | ⚠️ Partial           |
| Deterministic error handling | `src/dag/execution/code-executor.ts:33-45`             | ✅ Complete          |

### Implementation Approach

Phase 1 implementation **diverged from original design**:

**Original Design (Decision 1):**

```
Execute original code as-is, trace only operation names
```

**Actual Implementation:**

```
Split code into separate tasks (Phase 2 behavior)
+ Variable bindings to propagate context
```

**Why the divergence?** To enable SHGAT to see atomic operations as separate DAG nodes.

### Critical Limitation Discovered

**Variable Bindings are Incomplete** (`static-structure-builder.ts:588-594`):

```typescript
// Only tracks variables IF a task node was created
const nodeCountAfter = this.nodeCounters.task;
if (variableName && nodeCountAfter > nodeCountBefore) {
  this.variableToNodeId.set(variableName, nodeId);
}
```

**Works for:** MCP results

```typescript
const users = await mcp.db.query(...);  // ✅ Creates task node → tracked
const active = users.filter(u => u.active);  // ✅ users binding works
```

**Fails for:** Literals

```typescript
const numbers = [1, 2, 3]; // ❌ No task node → NOT tracked
const doubled = numbers.map((x) => x * 2); // ❌ ReferenceError: numbers is not defined
```

**Root Cause:** Literals don't create task nodes, so `nodeCountAfter === nodeCountBefore` → no
binding created.

### Why Phase 2 DAG Optimizer Solves This

The DAG Optimizer (see `two-level-dag-architecture.md`) **fuses code blocks**, eliminating the
variable binding problem:

**DAG Logique (detects operations):**

```typescript
task_lit1: "const numbers = [1, 2, 3]";
task_c1: "code:map";
```

**DAG Physique (after fusion):**

```typescript
task_fused_1: {
  code: `
    const numbers = [1, 2, 3];           // ← Literal included in fused code
    const doubled = numbers.map(x => x * 2);  // ← numbers exists!
    return doubled;
  `;
}
```

**Result:**

- ✅ SHGAT sees atomic operations in `executedPath: ["code:literal", "code:map"]`
- ✅ Execution works (no variable scope issues)
- ✅ Performance optimized (fewer layers)

### Variable Bindings After Fusion

**variableBindings doesn't become obsolete** - it changes role:

**Before Fusion (current):**

```typescript
// Inject variables directly into execution context
executionContext[varName] = previousResults.get(taskId).output;
```

**After Fusion:**

```typescript
// Used by DAG Optimizer to generate fused code
const code = `
  const active = deps.task_n1.output.filter(...);  // ← Generated from variableBindings
`;
```

**Still needed for:** MCP results that can't be fused (side effects).

### Next Steps

**Recommendation:** Implement Phase 2 DAG Optimizer rather than extend variable tracking.

**Rationale:**

1. ✅ Solves variable binding limitation for literals
2. ✅ Enables SHGAT atomic operation learning
3. ✅ Performance optimization (fusion)
4. ✅ Design already documented (`two-level-dag-architecture.md`)

**Estimated Effort:** 2-3 days (fusion logic + trace generation)

---

## Acceptance Criteria

### Phase 1

| AC         | Description                                                                         | Test        |
| ---------- | ----------------------------------------------------------------------------------- | ----------- |
| **AC 1.1** | `users.filter(u => u.active).map(u => u.name)` → DAG with `code:filter`, `code:map` | Unit        |
| **AC 1.2** | `code:filter` task executes and returns filtered array                              | Integration |
| **AC 1.3** | `executedPath` contains `["code:filter", "code:map"]`                               | Integration |
| **AC 1.4** | `isSafeToFail(code:filter)` returns `true`                                          | Unit        |
| **AC 1.5** | Layer with only pure ops skips HIL validation                                       | Integration |

---

## Estimation

| Task                        | Complexity | Time         |
| --------------------------- | ---------- | ------------ |
| Task 1.1: Detection         | Medium     | 1 day        |
| Task 1.2: Pure ops registry | Simple     | 2 hours      |
| Task 1.3: isSafeToFail      | Simple     | 1 hour       |
| Task 1.4: DAG converter     | Simple     | 2 hours      |
| Task 1.5: Tests             | Medium     | 1 day        |
| **Total Phase 1**           |            | **2-3 days** |

---

## Quick Reference

### Pseudo-Tool Naming

```
code:<operation>

Examples:
- code:filter
- code:map
- code:reduce
- code:Object.keys
- code:JSON.parse
```

### Task Structure

```typescript
{
  id: "task_c1",
  type: "code_execution",
  tool: "code:filter",
  code: "users.filter(u => u.active)",  // ← Original code via span
  arguments: {},
  dependsOn: ["task_n1"],
  sandboxConfig: { permissionSet: "minimal" },
  metadata: { pure: true }
}
```

### Detection Flow

```
Original Code
     │
     ▼
┌─────────────────────────────────┐
│  StaticStructureBuilder         │
│  handleCallExpression()         │
│  - Detect array methods         │
│  - Extract code via span        │
│  - Generate tool: "code:filter" │
└─────────────────┬───────────────┘
                  │
                  ▼
┌─────────────────────────────────┐
│  static-to-dag-converter        │
│  - type: "code_execution"       │
│  - code: original via span      │
│  - metadata.pure: true          │
└─────────────────┬───────────────┘
                  │
                  ▼
┌─────────────────────────────────┐
│  controlled-executor            │
│  - executeCodeTask() (existing) │
│  - isSafeToFail() → true        │
│  - HIL validation skipped       │
└─────────────────┬───────────────┘
                  │
                  ▼
┌─────────────────────────────────┐
│  SHGAT Learning                 │
│  executedPath: ["code:filter"]  │
│  (operation only, not content)  │
└─────────────────────────────────┘
```
