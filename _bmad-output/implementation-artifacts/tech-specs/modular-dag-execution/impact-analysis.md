# Impact Analysis: Modular DAG Code Execution

**Generated:** 2025-12-26 **Updated:** 2025-12-26 (Post-discussion simplification) **Purpose:**
Detailed analysis of existing code that will be impacted by the implementation

---

## Executive Summary (Phase 1 MVP)

| Category            | Count | Notes                                  |
| ------------------- | ----- | -------------------------------------- |
| Files to Modify     | 3     | Minimal changes                        |
| New Files           | 1     | `pure-operations.ts` only              |
| Types to Extend     | 1     | `Task.metadata`                        |
| Functions to Add    | 2     | `isPureOperation`, `isCodeOperation`   |
| Functions to Modify | 2     | `handleCallExpression`, `isSafeToFail` |

> **Key Simplification:** Scope capture bypassed, fusion deferred to Phase 2+.

---

## 1. File-Level Impact (Phase 1 MVP)

### 1.1 Files to MODIFY

| File                                           | Impact     | Changes                                                                    |
| ---------------------------------------------- | ---------- | -------------------------------------------------------------------------- |
| `src/capabilities/static-structure-builder.ts` | **MEDIUM** | Add array operation detection in `handleCallExpression()`, span extraction |
| `src/dag/static-to-dag-converter.ts`           | **LOW**    | Handle `code:*` tools in `nodeToTask()`                                    |
| `src/dag/execution/task-router.ts`             | **LOW**    | Extend `isSafeToFail()` for pure ops (3 lines)                             |

### 1.2 Files to CREATE

| File                         | Purpose                                                          |
| ---------------------------- | ---------------------------------------------------------------- |
| `src/dag/pure-operations.ts` | Pure operation registry (`PURE_OPERATIONS`, `isPureOperation()`) |

### 1.3 Files NOT Modified (Deferred Phase 2+)

| File                                 | Why Deferred                                          |
| ------------------------------------ | ----------------------------------------------------- |
| ~~`src/dag/dag-optimizer.ts`~~       | Fusion deferred to Phase 2+                           |
| ~~`src/dag/trace-generator.ts`~~     | Not needed without fusion                             |
| ~~`src/dag/controlled-executor.ts`~~ | No changes needed - uses existing `executeCodeTask()` |

---

## 2. Type-Level Impact (Phase 1 MVP)

### 2.1 Types - NO CHANGES NEEDED

#### `StaticStructureNode` (src/capabilities/types.ts)

```typescript
// NO CHANGE - "task" type already supports any tool string
// We use convention: tool = "code:filter", "code:map", etc.
type StaticStructureNode = {
  type: "task";
  id: string;
  tool: string;
  arguments?: ArgumentsStructure;
};
// ...
```

#### `Task` (src/graphrag/types.ts)

```typescript
// MINIMAL CHANGE - Just add optional metadata
interface Task {
  // ... existing fields unchanged ...

  /**
   * Metadata for code operations (Phase 1)
   */
  metadata?: {
    /** True if this is a pure operation (no side effects) */
    pure?: boolean;
  };
}
```

#### `InternalNode` (src/capabilities/static-structure-builder.ts)

```typescript
// MINIMAL CHANGE - Add code field for span extraction
type InternalNode =
  & {
    // ... existing ...
  }
  & (
    {
      type: "task";
      tool: string;
      arguments?: ArgumentsStructure;
      /** Original code extracted via span (for code:* operations) */
      code?: string;
    }
  ) // ...
;
```

> **Note:** `callbackCode`, `inputRef`, `fusedFrom`, `logicalTools` are deferred to Phase 2+.

### 2.2 New Types to CREATE (Phase 1)

#### `pure-operations.ts` (NEW FILE)

```typescript
// src/dag/pure-operations.ts

export const PURE_OPERATIONS = [
  // Array (Phase 1)
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
  // String (Phase 1)
  "code:split",
  "code:replace",
  "code:trim",
  "code:toLowerCase",
  "code:toUpperCase",
  // Object (Phase 1)
  "code:Object.keys",
  "code:Object.values",
  "code:Object.entries",
  // JSON (Phase 1)
  "code:JSON.parse",
  "code:JSON.stringify",
] as const;

export type PureOperationId = typeof PURE_OPERATIONS[number];

export function isPureOperation(toolId: string): boolean {
  return PURE_OPERATIONS.includes(toolId as PureOperationId);
}

export function isCodeOperation(toolId: string): boolean {
  return toolId.startsWith("code:");
}
```

> **Deferred Phase 2+:** `OptimizedDAG`, `FusionCandidate` types for fusion.

---

## 3. Function-Level Impact (Phase 1 MVP)

### 3.1 Functions to MODIFY

#### `StaticStructureBuilder.handleCallExpression()` (L320-376)

**Current:** Only detects `mcp.*` and `capabilities.*` patterns

**After:** Also detect array methods + span extraction:

```typescript
// ADD: Array method detection
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
  const methodName = callee.property?.value as string;

  if (TRACKED_METHODS.includes(methodName)) {
    // Extract original code via span
    const code = this.originalCode.substring(n.span.start, n.span.end);

    nodes.push({
      id: this.generateNodeId("task"),
      type: "task",
      tool: `code:${methodName}`,
      code, // ← Original code via span
      position,
      parentScope,
    });
    return false;
  }
}
```

> **Note:** `originalCode` must be passed to builder. Minor refactor needed.

#### `isSafeToFail()` in task-router.ts (L40-48)

**Current:** Only checks `type === "code_execution"` and `permissionSet === "minimal"`

**After:** Also check pure operations (3 lines added):

```typescript
import { isCodeOperation, isPureOperation } from "../pure-operations.ts";

export function isSafeToFail(task: Task): boolean {
  // Existing logic unchanged...
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

### 3.2 Functions to ADD (Phase 1)

#### In `pure-operations.ts` (NEW FILE)

| Function                  | Purpose                 | Lines |
| ------------------------- | ----------------------- | ----- |
| `isPureOperation(toolId)` | Check if tool is pure   | 3     |
| `isCodeOperation(toolId)` | Check if tool is code:* | 3     |

**That's it for Phase 1.**

### 3.3 Functions DEFERRED (Phase 2+)

| Function                      | File                     | Why Deferred              |
| ----------------------------- | ------------------------ | ------------------------- |
| ~~`extractCallbackCode()`~~   | static-structure-builder | Scope capture bypassed    |
| ~~`extractInputReference()`~~ | static-structure-builder | Scope capture bypassed    |
| ~~`canFuseTasks()`~~          | dag-optimizer            | Fusion deferred           |
| ~~`fuseTasks()`~~             | dag-optimizer            | Fusion deferred           |
| ~~`optimizeDAG()`~~           | dag-optimizer            | Fusion deferred           |
| ~~`generateLogicalTrace()`~~  | trace-generator          | Not needed without fusion |
| ~~`validatePureCode()`~~      | pure-operations          | Optional validation       |

---

## 4. Dependency Graph (Phase 1 MVP)

```
┌─────────────────────────────────────┐
│   static-structure-builder.ts       │
│   + Detect array methods            │
│   + Extract code via span           │
└─────────────────┬───────────────────┘
                  │ StaticStructure (with code:* tools)
                  ▼
┌─────────────────────────────────────┐
│   static-to-dag-converter.ts        │
│   + Handle code:* → code_execution  │
└─────────────────┬───────────────────┘
                  │ DAGStructure
                  ▼
┌─────────────────────────────────────┐     ┌──────────────────────┐
│   controlled-executor.ts            │◄────│  pure-operations.ts  │
│   (NO CHANGES - uses existing       │     │  (NEW: registry)     │
│    executeCodeTask())               │     └──────────────────────┘
└─────────────────┬───────────────────┘              │
                  │                                  │
                  ▼                                  ▼
┌─────────────────────────────────────┐     ┌──────────────────────┐
│   task-router.ts                    │◄────│  isPureOperation()   │
│   + Extend isSafeToFail()           │     │  isCodeOperation()   │
└─────────────────────────────────────┘     └──────────────────────┘
```

**Deferred Phase 2+:**

- ~~dag-optimizer.ts~~
- ~~trace-generator.ts~~

---

## 5. Existing Code We REUSE (Zero Changes)

### 5.1 SWC Parsing

```typescript
// static-structure-builder.ts - Already have:
import { parse } from "https://deno.land/x/swc@0.2.1/mod.ts";

// Reusing:
extractMemberChain(); // ← For detecting method calls
generateNodeId(); // ← For creating task IDs
// SWC span           // ← For code extraction
```

### 5.2 Sandbox Execution

```typescript
// controlled-executor.ts - NO CHANGES, reusing:
executeCodeTask(); // ← Executes code:* tasks as-is
executeWithRetry(); // ← Retry logic works

// task-router.ts - Reusing:
getTaskType(); // ← Returns "code_execution" for code:*
requiresSandbox(); // ← Returns true for code_execution
```

### 5.3 Type Infrastructure

```typescript
// capabilities/types.ts - Already supports:
StaticStructureNode; // ← tool: string supports "code:filter"

// graphrag/types.ts - Already has:
Task.code; // ← Already exists for code_execution
Task.sandboxConfig; // ← Already exists
Task.type; // ← "code_execution" already supported
```

**Bottom line:** Almost everything exists. We're just connecting the dots.

---

## 6. Breaking Changes Assessment

| Change                       | Breaking? | Notes           |
| ---------------------------- | --------- | --------------- |
| New `code:*` tool convention | No        | Additive        |
| Extended `Task.metadata`     | No        | Optional field  |
| Modified `isSafeToFail()`    | No        | Only adds cases |
| New `pure-operations.ts`     | No        | New file        |

**Verdict:** Zero breaking changes.

---

## 7. Test Coverage Required (Phase 1)

| Component                      | Test Type   | Priority |
| ------------------------------ | ----------- | -------- |
| Array operation detection      | Unit        | P0       |
| Span extraction                | Unit        | P0       |
| `isPureOperation()`            | Unit        | P0       |
| `isSafeToFail()` extended      | Unit        | P0       |
| End-to-end: code → DAG → trace | Integration | P1       |

**Deferred Tests (Phase 2+):**

- ~~DAG fusion logic~~
- ~~Trace expansion~~

---

## 8. Risk Assessment (Phase 1)

| Risk                       | Probability | Impact | Mitigation                   |
| -------------------------- | ----------- | ------ | ---------------------------- |
| ~~Scope capture~~          | N/A         | N/A    | **BYPASSED**                 |
| ~~Lambda serialization~~   | N/A         | N/A    | **BYPASSED** (execute as-is) |
| Span extraction edge cases | Low         | Low    | Good test coverage           |
| Breaking existing traces   | Low         | Medium | Feature flag optional        |

**Key insight:** Most risks eliminated by "execute as-is, trace operation only" approach.

---

## 9. Quick Reference: Key Locations

### Detection Point

`src/capabilities/static-structure-builder.ts:320` - `handleCallExpression()`

### Conversion Point

`src/dag/static-to-dag-converter.ts:230` - `nodeToTask()`

### Routing Point

`src/dag/execution/task-router.ts:40` - `isSafeToFail()`

### New File

`src/dag/pure-operations.ts` - Pure operation registry
