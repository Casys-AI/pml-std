# SWC Static Structure Detection

> Technical specification for code analysis via SWC in `StaticStructureBuilder`

## Overview

The `StaticStructureBuilder` uses SWC (Rust-based TypeScript parser) to analyze code statically and
extract control flow, MCP tool calls, and parallel execution patterns.

**File:** `src/capabilities/static-structure-builder.ts`

## Detected Patterns

### MCP Tool Calls

| Pattern                                | Status      | Notes                     |
| -------------------------------------- | ----------- | ------------------------- |
| `await mcp.server.tool({ args })`      | ✅ Detected | Creates `task` node       |
| `mcp.server.tool({ args })` (no await) | ✅ Detected | Same handling             |
| `await capabilities.name()`            | ✅ Detected | Creates `capability` node |

### Control Flow - Branches

| Pattern                   | Status      | Node Type  | Notes                                                |
| ------------------------- | ----------- | ---------- | ---------------------------------------------------- |
| `if (cond) { } else { }`  | ✅ Detected | `decision` | Both branches tracked with `outcome: "true"/"false"` |
| `if (cond) { }` (no else) | ✅ Detected | `decision` | Only true branch                                     |
| `switch (x) { case: }`    | ✅ Detected | `decision` | Each case tracked with `outcome: "case:value"`       |
| `cond ? a : b` (ternary)  | ✅ Detected | `decision` | Both branches tracked                                |

### Parallel Execution

| Pattern                               | Status      | Notes                             |
| ------------------------------------- | ----------- | --------------------------------- |
| `Promise.all([mcp.a(), mcp.b()])`     | ✅ Detected | Creates `fork` → N tasks → `join` |
| `Promise.allSettled([...])`           | ✅ Detected | Same as Promise.all               |
| `[...].map(x => mcp.tool())` inline   | ✅ Detected | Unrolls to N parallel tasks       |
| `arr.map(x => mcp.tool())` (variable) | ✅ Detected | Creates 1 task as template        |

### Array Operations (Phase 1 - Planned)

> **Tech-Spec:** See [index.md](./index.md) for full implementation details.

| Pattern                    | Status     | Tool ID        | Notes                      |
| -------------------------- | ---------- | -------------- | -------------------------- |
| `arr.filter(x => ...)`     | 🔜 Planned | `code:filter`  | Pure operation, HIL bypass |
| `arr.map(x => ...)`        | 🔜 Planned | `code:map`     | Pure operation, HIL bypass |
| `arr.reduce((a,b) => ...)` | 🔜 Planned | `code:reduce`  | Pure operation, HIL bypass |
| `arr.flatMap(x => ...)`    | 🔜 Planned | `code:flatMap` | Pure operation             |
| `arr.find(x => ...)`       | 🔜 Planned | `code:find`    | Pure operation             |
| `arr.some(x => ...)`       | 🔜 Planned | `code:some`    | Pure operation             |
| `arr.every(x => ...)`      | 🔜 Planned | `code:every`   | Pure operation             |
| `arr.sort(...)`            | 🔜 Planned | `code:sort`    | Pure operation             |
| `arr.slice(...)`           | 🔜 Planned | `code:slice`   | Pure operation             |

**Implementation approach:**

1. Detect array method via `MemberExpression` in `handleCallExpression()`
2. Extract original code via SWC span: `originalCode.substring(span.start, span.end)`
3. Create task with `tool: "code:<method>"`, `type: "code_execution"`
4. Mark as pure operation → `isSafeToFail()` returns `true`, HIL bypassed

**SHGAT Learning:**

- Traces operation names only: `executedPath = ["code:filter", "code:map"]`
- Does NOT trace callback content or variable values

### Arguments Extraction

| Pattern                                      | Status       | Notes                                         |
| -------------------------------------------- | ------------ | --------------------------------------------- |
| Literal values: `{ path: "file.txt" }`       | ✅ Extracted | `type: "literal"`                             |
| Nested objects: `{ config: { a: 1 } }`       | ✅ Extracted | Recursive extraction                          |
| Arrays: `{ items: [1, 2, 3] }`               | ✅ Extracted | `type: "literal"`                             |
| Variable reference: `{ path: filePath }`     | ✅ Extracted | `type: "reference"`                           |
| Parameter: `{ path: args.path }`             | ✅ Extracted | `type: "parameter"`                           |
| Previous output: `{ content: file.content }` | ✅ Extracted | `type: "reference"` with node ID substitution |
| Template literal (simple): `` `SELECT *` ``  | ✅ Extracted | `type: "literal"` (no interpolation)          |
| Template literal (dynamic): `` `${x}` ``     | ✅ Extracted | `type: "reference"` (has interpolation)       |
| Code template: `` `async (page) => {...}` `` | ✅ Extracted | Nested literals parameterized (Story 10.2f)   |

### Nested Literal Extraction (Story 10.2f)

**Status:** ✅ IMPLEMENTED (2025-12-31)

**Problem:** Template literals containing code (e.g., Playwright browser code) weren't having their
nested literals (URLs, numbers, strings) extracted for parameterization.

```typescript
// This code had hardcoded values that weren't parameterizable:
mcp.playwright.browser_run_code({
  code: `async (page) => {
    await page.goto('http://localhost:8081/dashboard');  // ← Hardcoded URL
    await page.waitForLoadState('networkidle');          // ← Hardcoded state
    return texts.slice(0, 100).join(' | ');              // ← Hardcoded numbers
  }`
});
```

**Solution:** Code templates are detected via heuristics (contains `await`, `=>`, `page.`, etc.) and
parsed recursively to extract nested literals.

#### Implementation

| File                                          | Change                                                          |
| --------------------------------------------- | --------------------------------------------------------------- |
| `src/capabilities/nested-literal-extractor.ts` | NEW: Parses code content and extracts parameterizable literals |
| `src/capabilities/code-transformer.ts`         | Added `looksLikeCode()` heuristic and `codeTemplates` handling |

#### How It Works

```typescript
// Input:
mcp.playwright.browser_run_code({
  code: `page.goto('http://localhost:8081'); texts.slice(0, 100);`
});

// After transformation:
mcp.playwright.browser_run_code({
  code: `page.goto('${args.url}'); texts.slice(${args.sliceStart}, ${args.sliceEnd});`
});

// Generated parameters:
// - url: "http://localhost:8081"
// - sliceStart: 0
// - sliceEnd: 100
```

#### Parameter Naming

- URLs detected by `http://` or `https://` prefix → `url`
- Method context used: `goto(x)` → `url`, `slice(a, b)` → `sliceStart`, `sliceEnd`
- Object property names used directly: `{ endpoint: "..." }` → `endpoint`
- Conflicts resolved with numeric suffix: `url`, `url2`, `url3`

### Literal Bindings (Story 10.2b - Option B)

**Status:** ✅ IMPLEMENTED (2025-12-28)

**Problem:** Local variable declarations with literal values were not tracked, causing argument
resolution to fail for shorthand properties.

```typescript
// This code FAILED before the fix:
const numbers = [10, 20, 30];     // ← VariableDeclaration NOT tracked
mcp.math.sum({ numbers })         // ← { numbers: { type: "reference", expression: "numbers" }}

// At runtime:
resolveReference("numbers") → undefined  // ❌ ReferenceError
```

**Root Cause:** `handleVariableDeclarator` only tracked variables assigned from MCP calls (creating
`variableBindings`), not literals.

**Solution (Option B):** Track literal values separately in `literalBindings` and pass them to the
execution context.

#### Implementation

| File                                           | Change                                                                                         |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `src/capabilities/types.ts`                    | Added `literalBindings?: Record<string, JsonValue>` to `StaticStructure`                       |
| `src/capabilities/static-structure-builder.ts` | Added `literalBindings` map + `isLiteralExpression()` + tracking in `handleVariableDeclarator` |
| `src/mcp/handlers/code-execution-handler.ts`   | Spread `staticStructure.literalBindings` into `executionContext`                               |

#### How It Works

```typescript
// 1. static-structure-builder detects the literal:
private handleVariableDeclarator(n, nodes, position, ...) {
  const init = n.init;
  if (variableName && init && this.isLiteralExpression(init)) {
    const literalValue = this.extractLiteralValue(init);
    this.literalBindings.set(variableName, literalValue);
    return; // Don't recurse - no nodes to create
  }
  // ... existing logic for MCP results
}

// 2. buildStaticStructure returns literalBindings:
return { nodes, edges, variableBindings, literalBindings };

// 3. code-execution-handler passes to context:
const executionContext = {
  parameters: request.context || {},
  ...staticStructure.literalBindings,  // ← { numbers: [10, 20, 30] }
};

// 4. argument-resolver uses existing fallback (line 182-189):
if (rootPart in context) {
  return context[rootPart];  // ← context["numbers"] → [10, 20, 30] ✅
}
```

#### Supported Literal Types

| Type           | Example                    | Tracked |
| -------------- | -------------------------- | ------- |
| Array literal  | `const arr = [1, 2, 3]`    | ✅      |
| Object literal | `const obj = { a: 1 }`     | ✅      |
| Nested arrays  | `const m = [[1,2], [3,4]]` | ✅      |
| String         | `const s = "hello"`        | ✅      |
| Number         | `const n = 42`             | ✅      |
| Boolean        | `const b = true`           | ✅      |
| Null           | `const x = null`           | ✅      |

#### Computed Expressions (Extended 2025-12-28)

When operands are known literals or tracked variables, expressions are evaluated statically:

| Expression    | Example                         | Result       |
| ------------- | ------------------------------- | ------------ |
| Arithmetic    | `const sum = a + b` (a=10, b=5) | `15`         |
| String concat | `firstName + " " + lastName`    | `"John Doe"` |
| Comparison    | `x > y`, `a === b`              | `true/false` |
| Logical       | `a && b`, `a \|\| b`            | Evaluated    |
| Unary         | `-x`, `!flag`, `+num`           | Evaluated    |

**Supported operators:** `+`, `-`, `*`, `/`, `%`, `**`, `==`, `===`, `!=`, `!==`, `<`, `>`, `<=`,
`>=`, `&&`, `||`, `-` (unary), `+` (unary), `!`, `typeof`

#### NOT Supported (v1)

| Type             | Example                | Reason                         |
| ---------------- | ---------------------- | ------------------------------ |
| Unknown operands | `known + getData()`    | Can't resolve runtime values   |
| Function calls   | `const x = foo()`      | Runtime-only                   |
| `let` mutations  | `let x = 1; x++`       | Dynamic value                  |
| Async/await      | `const x = await fn()` | Runtime-only (unless MCP call) |

#### Tests

See `tests/unit/capabilities/static-structure-code-ops.test.ts`:

- `literalBindings tracks array literals`
- `literalBindings tracks object literals`
- `literalBindings tracks primitive literals`
- `literalBindings does NOT track MCP results`
- `literalBindings works with nested arrays`
- `literalBindings evaluates arithmetic expressions`
- `literalBindings evaluates string concatenation`
- `literalBindings evaluates comparison expressions`
- `literalBindings evaluates unary expressions`
- `literalBindings handles complex expressions`
- `literalBindings skips expressions with unknown variables`

## Not Detected (TODO)

### Loops

| Pattern                               | Status          | Workaround                      |
| ------------------------------------- | --------------- | ------------------------------- |
| `for (const x of arr) { mcp.tool() }` | ❌ Not detected | Use `Promise.all(arr.map(...))` |
| `for (let i = 0; i < n; i++) { }`     | ❌ Not detected | Use `Promise.all(arr.map(...))` |
| `while (cond) { }`                    | ❌ Not detected | N/A - dynamic iteration count   |
| `arr.forEach(x => mcp.tool())`        | ❌ Not detected | Use `Promise.all(arr.map(...))` |

**Why:** Loops have dynamic iteration counts that can't be determined statically. The number of
iterations depends on runtime values.

### Map Parameter Resolution

| Pattern                                   | Status     | Notes                                            |
| ----------------------------------------- | ---------- | ------------------------------------------------ |
| `["a","b"].map(p => mcp.tool({path: p}))` | ⚠️ Partial | Detects 2 tasks, but `p` is undefined at runtime |

**Why:** SWC detects the structure correctly, but the DAG executor doesn't substitute arrow function
parameters with array element values.

**Future improvement:** Track arrow function parameter name and substitute with corresponding array
element for each unrolled task.

### Dynamic Patterns

| Pattern                           | Status          | Notes                            |
| --------------------------------- | --------------- | -------------------------------- |
| `await obj[methodName]()`         | ❌ Not detected | Dynamic method call              |
| `await fn()` where fn is variable | ❌ Not detected | Can't resolve function reference |
| `eval()` / `new Function()`       | ❌ Never        | Security risk                    |

## Node Types

```typescript
type StaticStructureNode =
  | { type: "task"; tool: string; arguments?: ArgumentsStructure }
  | { type: "decision"; condition: string }
  | { type: "capability"; capabilityId: string }
  | { type: "fork" }
  | { type: "join" };
```

## Edge Types

```typescript
type StaticStructureEdge = {
  from: string;
  to: string;
  type: "sequence" | "conditional" | "provides";
  outcome?: string; // For conditional: "true", "false", "case:value"
  coverage?: "strict" | "partial" | "optional"; // For provides
};
```

## Example Output

```typescript
// Input code:
const file = await mcp.filesystem.read_file({ path: "config.json" });
if (file.exists) {
  await mcp.memory.create_entities({ entities: [] });
}

// Output structure:
{
  nodes: [
    { id: "n1", type: "task", tool: "filesystem:read_file", arguments: { path: { type: "literal", value: "config.json" } } },
    { id: "d1", type: "decision", condition: "file.exists" },
    { id: "n2", type: "task", tool: "memory:create_entities", arguments: { entities: { type: "literal", value: [] } } }
  ],
  edges: [
    { from: "n1", to: "d1", type: "sequence" },
    { from: "d1", to: "n2", type: "conditional", outcome: "true" }
  ]
}
```

## Dashboard Modes

| Mode           | Description               | Source                    |
| -------------- | ------------------------- | ------------------------- |
| **Definition** | Static structure from SWC | `static_structure` column |
| **Invocation** | Actual calls at runtime   | `execution_trace` table   |

- **Definition:** Shows what SWC detected (1 tool for a loop body)
- **Invocation:** Shows what actually ran (N calls if loop executed N times)

## Related Files

- `src/capabilities/static-structure-builder.ts` - Main parser
- `src/capabilities/types.ts` - Type definitions
- `src/capabilities/schema-inferrer.ts` - Schema inference (related SWC usage)
- `src/capabilities/permission-inferrer.ts` - Permission inference

## Modular Code Operations (Phase 1)

**Status:** ✅ IMPLEMENTED (2025-12-26)

### Overview

StaticStructureBuilder now detects JavaScript operations (array methods, string methods, etc.) and
converts them to **pseudo-tools** with `code:` prefix. These operations are traced via WorkerBridge
for SHGAT learning.

### Detected Operations

#### Array Operations

| Pattern                 | Pseudo-Tool      | Extracted Code | Notes                       |
| ----------------------- | ---------------- | -------------- | --------------------------- |
| `arr.filter(fn)`        | `code:filter`    | Via SWC span   | Original callback preserved |
| `arr.map(fn)`           | `code:map`       | Via SWC span   | Original callback preserved |
| `arr.reduce(fn, init)`  | `code:reduce`    | Via SWC span   | Includes accumulator        |
| `arr.flatMap(fn)`       | `code:flatMap`   | Via SWC span   | -                           |
| `arr.find(fn)`          | `code:find`      | Via SWC span   | -                           |
| `arr.findIndex(fn)`     | `code:findIndex` | Via SWC span   | -                           |
| `arr.some(fn)`          | `code:some`      | Via SWC span   | -                           |
| `arr.every(fn)`         | `code:every`     | Via SWC span   | -                           |
| `arr.sort(fn)`          | `code:sort`      | Via SWC span   | Optional comparator         |
| `arr.slice(start, end)` | `code:slice`     | Via SWC span   | -                           |

#### String Operations

| Pattern                             | Pseudo-Tool        | Notes |
| ----------------------------------- | ------------------ | ----- |
| `str.split(sep)`                    | `code:split`       | -     |
| `str.replace(pattern, replacement)` | `code:replace`     | -     |
| `str.trim()`                        | `code:trim`        | -     |
| `str.toLowerCase()`                 | `code:toLowerCase` | -     |
| `str.toUpperCase()`                 | `code:toUpperCase` | -     |
| `str.substring(start, end)`         | `code:substring`   | -     |

#### Object Operations

| Pattern                             | Pseudo-Tool           | Notes |
| ----------------------------------- | --------------------- | ----- |
| `Object.keys(obj)`                  | `code:Object.keys`    | -     |
| `Object.values(obj)`                | `code:Object.values`  | -     |
| `Object.entries(obj)`               | `code:Object.entries` | -     |
| `Object.assign(target, ...sources)` | `code:Object.assign`  | -     |

#### Math Operations

| Pattern               | Pseudo-Tool       | Notes |
| --------------------- | ----------------- | ----- |
| `Math.abs(x)`         | `code:Math.abs`   | -     |
| `Math.max(...values)` | `code:Math.max`   | -     |
| `Math.min(...values)` | `code:Math.min`   | -     |
| `Math.round(x)`       | `code:Math.round` | -     |

**Total:** 97 pure operations defined in `src/capabilities/pure-operations.ts`

### Code Extraction via SWC Spans

**Implementation:** `src/capabilities/static-structure-builder.ts`

```typescript
// Detect array operation (e.g., users.filter(...))
if (arrayOps.includes(methodName)) {
  const nodeId = this.generateNodeId("task");

  // Extract original code via SWC span (Phase 1)
  const span = n.span as { start: number; end: number } | undefined;
  const code = span ? this.originalCode.substring(span.start, span.end) : undefined;

  nodes.push({
    id: nodeId,
    type: "task",
    tool: `code:${methodName}`, // Pseudo-tool: "code:filter"
    position,
    parentScope,
    code, // Original code: "users.filter(u => u.active && u.score > 50)"
  });
}
```

**Benefits:**

- ✅ Preserves original callbacks with closures
- ✅ Preserves variable references
- ✅ No placeholder generation needed

### DAG Conversion

**Implementation:** `src/dag/static-to-dag-converter.ts`

Pseudo-tools are converted to `code_execution` tasks:

```typescript
if (node.tool.startsWith("code:")) {
  const operation = node.tool.replace("code:", "");
  const code = node.code || generateOperationCode(operation); // Fallback

  return {
    id: taskId,
    tool: node.tool, // Keep "code:filter" for tracing
    type: "code_execution",
    code, // Extracted code from SWC span
    sandboxConfig: {
      permissionSet: "minimal", // Pure operations are safe
    },
    metadata: { pure: isPureOperation(node.tool) },
    staticArguments: node.arguments,
  };
}
```

### Execution & Tracing

**Problem:** Code operations weren't traced, so SHGAT couldn't learn from them.

**Solution:** Route through WorkerBridge for tracing

**Implementation:** `src/dag/controlled-executor.ts`

```typescript
if (taskType === "code_execution") {
  // Phase 1: Use WorkerBridge for pseudo-tool tracing
  if (this.workerBridge && task.tool) {
    return await this.executeCodeTaskViaWorkerBridge(task, previousResults);
  }

  // Fallback: DenoSandboxExecutor (no tracing)
  // ...
}
```

**WorkerBridge.executeCodeTask():** `src/sandbox/worker-bridge.ts:454-543`

```typescript
async executeCodeTask(
  toolName: string,      // "code:filter", "code:map", etc.
  code: string,
  context?: Record<string, unknown>,
  toolDefinitions: ToolDefinition[] = [],
): Promise<ExecutionResult> {
  // Emit tool_start trace
  this.traces.push({
    type: "tool_start",
    tool: toolName,  // "code:filter"
    traceId,
    ts: startTime,
  });

  // Execute in Worker sandbox (permissions: "none")
  const result = await this.execute(code, toolDefinitions, context);

  // Emit tool_end trace
  this.traces.push({
    type: "tool_end",
    tool: toolName,
    traceId,
    ts: endTime,
    success: result.success,
    durationMs: endTime - startTime,
    result: result.result,
  });

  return result;
}
```

### Traces → executedPath

**How it works:** `src/sandbox/worker-bridge.ts:354-361`

```typescript
const executedPath = sortedTraces
  .filter((t): t is ToolTraceEvent | CapabilityTraceEvent =>
    t.type === "tool_end" || t.type === "capability_end"
  )
  .map((t) => {
    if (t.type === "tool_end") return t.tool; // ← "code:filter" appears here!
    return (t as CapabilityTraceEvent).capability;
  });
```

**Before Phase 1:**

```typescript
executed_path = ["db:query"]; // ❌ Missing code operations
```

**After Phase 1:**

```typescript
executed_path = ["db:query", "code:filter", "code:map", "code:reduce"]; // ✅ Complete
```

### Pure Operations

**Registry:** `src/capabilities/pure-operations.ts`

97 operations classified as **pure** (no side effects):

- ✅ Safe to execute without HIL validation
- ✅ Always produce same output for same input
- ✅ No I/O, no mutations

**Validation bypass:** `src/mcp/handlers/workflow-execution-handler.ts:67-79`

```typescript
if (taskType === "code_execution") {
  // Pure operations NEVER require validation (Phase 1)
  if (task.metadata?.pure === true || isPureOperation(task.tool)) {
    log.debug(`Skipping validation for pure operation: ${task.tool}`);
    continue;
  }
  // ...
}
```

### Example: Complete Flow

```typescript
// Input code
const users = await mcp.db.query({ table: "users" });
const active = users.filter(u => u.active && u.score > 50);
const names = active.map(u => u.name.toUpperCase());
const sorted = names.sort();

// Static structure detected
{
  nodes: [
    { id: "n1", type: "task", tool: "db:query", arguments: { table: "users" } },
    { id: "n2", type: "task", tool: "code:filter", code: "users.filter(u => u.active && u.score > 50)" },
    { id: "n3", type: "task", tool: "code:map", code: "active.map(u => u.name.toUpperCase())" },
    { id: "n4", type: "task", tool: "code:sort", code: "names.sort()" }
  ],
  edges: [
    { from: "n1", to: "n2", type: "sequence" },
    { from: "n2", to: "n3", type: "sequence" },
    { from: "n3", to: "n4", type: "sequence" }
  ]
}

// Execution traces
[
  { type: "tool_end", tool: "db:query", ts: 1000, success: true },
  { type: "tool_end", tool: "code:filter", ts: 1100, success: true },
  { type: "tool_end", tool: "code:map", ts: 1150, success: true },
  { type: "tool_end", tool: "code:sort", ts: 1200, success: true }
]

// executedPath (stored in execution_trace table)
["db:query", "code:filter", "code:map", "code:sort"]

// SHGAT learns from complete trace
graph.addNode("db:query");
graph.addNode("code:filter");
graph.addNode("code:map");
graph.addNode("code:sort");
graph.addEdge("db:query", "code:filter", { type: "sequence" });
graph.addEdge("code:filter", "code:map", { type: "sequence" });
graph.addEdge("code:map", "code:sort", { type: "sequence" });
```

### Files Modified

| File                                             | Changes                                              |
| ------------------------------------------------ | ---------------------------------------------------- |
| `src/capabilities/pure-operations.ts`            | **NEW** - Registry of 97 pure operations             |
| `src/capabilities/static-structure-builder.ts`   | Added span extraction for code operations            |
| `src/capabilities/types.ts`                      | Added `code?: string` field to `StaticStructureNode` |
| `src/dag/static-to-dag-converter.ts`             | Convert pseudo-tools to `code_execution` tasks       |
| `src/dag/execution/task-router.ts`               | Add `isSafeToFail()` for pure operations             |
| `src/mcp/handlers/workflow-execution-handler.ts` | Bypass validation for pure ops, pass WorkerBridge    |
| `src/sandbox/worker-bridge.ts`                   | Add `executeCodeTask()` method for tracing           |
| `src/dag/controlled-executor.ts`                 | Route code tasks through WorkerBridge                |

### Related Documentation

- **Tech Spec (SHGAT):** `docs/sprint-artifacts/tech-spec-shgat-multihead-traces.md` (Section 13)
- **ADR-032:** Sandbox Worker RPC Bridge
- **Commits:** c348a58, edf2d40, d878ed8, 438f01e, 0fb74b8

### Benefits for SHGAT Learning

**Before:**

- ❌ Code operations invisible to SHGAT
- ❌ Can't learn "query → filter → map → reduce" patterns
- ❌ TraceStats incomplete

**After:**

- ✅ All operations in graph (MCP + code)
- ✅ K-head attention learns modular patterns
- ✅ TraceStats computed for code operations
- ✅ Feature extraction works on complete traces

---

## Method Chaining Support (Story 10.2c)

**Status:** ✅ IMPLEMENTED (2025-12-28)

**Problem:** Only the outermost call was detected in chained method calls.

```typescript
// Only sort() was detected, filter() and map() were invisible
const result = numbers.filter((x) => x > 0).map((x) => x * 2).sort();
```

**Solution:** Recursively process CallExpression nodes when `callee.object` is also a
CallExpression.

### Implementation

**Key changes in `handleCallExpression()`:**

1. **Span tracking** - Track processed spans to prevent duplicates
2. **Recursive processing** - Process chained call BEFORE creating current node
3. **Method code extraction** - Extract just `map(x => x * 2)`, not the whole chain
4. **Edge metadata** - Store `chainedFrom` in node metadata for edge generation

```typescript
// Story 10.2c: Process chained call BEFORE creating current node
let chainedInputNodeId: string | undefined;
if (callee.type === "MemberExpression") {
  const objectExpr = callee.object;
  if (objectExpr?.type === "CallExpression") {
    // Recursively process the chained call
    const chainedResult = this.handleCallExpression(objectExpr, nodes, ...);
    chainedInputNodeId = chainedResult.nodeId;
  }
}

// When creating node, store chainedFrom in metadata
metadata: {
  chainedFrom: chainedInputNodeId, // For edge generation
}
```

### Example

```typescript
// Input code
const result = numbers.filter(n => n > 2).map(n => n * 2).sort();

// Static structure detected (Story 10.2c)
{
  nodes: [
    { id: "n1", type: "task", tool: "code:filter", code: "filter(n => n > 2)" },
    { id: "n2", type: "task", tool: "code:map", code: "map(n => n * 2)" },
    { id: "n3", type: "task", tool: "code:sort", code: "sort()" }
  ],
  edges: [
    { from: "n1", to: "n2", type: "sequence" },  // filter → map
    { from: "n2", to: "n3", type: "sequence" }   // map → sort
  ]
}
```

### Benefits

- ✅ All operations in a chained call are detected
- ✅ Proper edges created between chained operations
- ✅ Code extraction shows just the method call, not the whole chain
- ✅ SHGAT can learn from complete chained patterns

---

## Variable Bindings & Semantic Hashing (Story 7.2c)

**Status:** ✅ IMPLEMENTED (2025-12-31)

### Problem

Different variable names produced different code hashes despite identical semantics:

```typescript
// Code A:
const result = await mcp.std.psql_query({ query: args.query });
return result;

// Code B (semantically identical):
const data = await mcp.std.psql_query({ query: args.query });
return data;

// Before: hashCode(A) ≠ hashCode(B) ❌
// After:  hashSemanticStructure(A) === hashSemanticStructure(B) ✅
```

### Solution: Static Structure as Canonical Form

The **Static Structure** (not the DAG) is used for semantic hashing because:

1. **Created directly from SWC parsing** - No execution context needed
2. **Arguments already normalized** - `extractArguments()` converts `file.content` → `n1.content` in-place
3. **Deterministic** - Same semantics → same structure → same hash

**Key insight:** The normalization happens during AST traversal in `extractArguments()`, NOT during hashing.

**Pipeline:**

```
Code → SWC Parse → extractArguments() → StaticStructure → hashSemanticStructure() → code_hash
                          ↓                      ↓
                   file.content → n1.content    nodes have normalized args
```

### Why Static Structure (not DAG)?

| Aspect           | Static Structure              | Logical/Physical DAG              |
| ---------------- | ----------------------------- | --------------------------------- |
| **Created from** | SWC AST parsing               | Converted from static structure   |
| **Variables**    | Already normalized to node IDs | May have execution-specific data |
| **Determinism**  | Always deterministic          | May vary with execution context  |
| **Use case**     | Hashing, deduplication        | Execution planning, runtime       |

### Implementation

#### 1. In-Place Argument Normalization (The Key Step)

**File:** `src/capabilities/static-structure-builder.ts` (lines 1292-1300)

During AST traversal, `extractArguments()` converts variable references to node IDs:

```typescript
// In extractValue() - called by extractArguments():

// Story 10.5: Convert variable name to node ID if tracked
// e.g., "file.content" → "n1.content" if file was assigned from node n1
const variableName = chain[0];
const nodeId = this.variableToNodeId.get(variableName);
if (nodeId) {
  const convertedChain = [nodeId, ...chain.slice(1)];
  const expression = convertedChain.join(".");
  return { type: "reference", expression };  // ← "n1.content" stored in node
}
```

**Result:** Node arguments ALREADY contain `n1.content`, not `file.content`.

#### 2. Variable Bindings (For Code Storage)

**File:** `src/capabilities/static-structure-builder.ts`

`variableBindings` is exported separately for normalizing stored code:

```typescript
// When we see: const result = await mcp.foo();
// We track: "result" → "n1"
public variableToNodeId = new Map<string, string>();

// Output in buildStaticStructure():
return {
  nodes,   // ← Arguments already have node IDs
  edges,
  variableBindings: Object.fromEntries(this.variableToNodeId),  // ← For code normalization
  // ...
};
```

#### 3. Semantic Hashing

**File:** `src/capabilities/hash.ts`

```typescript
/**
 * Hash static structure for semantic deduplication.
 * Variable names don't matter - only node IDs and edges.
 */
export async function hashSemanticStructure(structure: StaticStructure): Promise<string> {
  const serializedNodes = structure.nodes.map(serializeNode).sort().join("|");
  const serializedEdges = structure.edges.map(serializeEdge).sort().join("|");
  const canonical = `nodes:${serializedNodes}||edges:${serializedEdges}`;

  const encoder = new TextEncoder();
  const data = encoder.encode(canonical);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}
```

**⚠️ DEPRECATED:** `hashCode()` - Does NOT normalize variables. Use `hashSemanticStructure()` instead.

#### 3. Code Normalization for Storage

**File:** `src/capabilities/code-transformer.ts`

Before storing capability code, variable names are normalized:

```typescript
export function normalizeVariableNames(
  code: string,
  variableBindings: Record<string, string>,
): NormalizeVariablesResult {
  // Input:  "const result = await mcp.foo(); return result;"
  // Output: "const _n1 = await mcp.foo(); return _n1;"

  const renames: Record<string, string> = {};
  for (const [varName, nodeId] of Object.entries(variableBindings)) {
    renames[varName] = `_${nodeId}`;
  }

  // Use negative lookbehind to avoid replacing property accesses
  // e.g., "file.content" should become "_n1.content", not "_n1._n1"
  const pattern = new RegExp(`(?<!\\.)\\b${escapeRegExp(originalName)}\\b`, "g");
  // ...
}
```

#### 4. Storage Pipeline

**File:** `src/capabilities/capability-store.ts`

```typescript
async store(input: SaveCapabilityInput): Promise<CapabilityStoreResult> {
  // 1. Build static structure (nodes already have normalized arguments!)
  const staticStructure = await structureBuilder.buildStaticStructure(code);
  // staticStructure.nodes[0].arguments = { text: { type: "reference", expression: "n1.content" } }

  // 2. Compute semantic hash from nodes (already normalized via extractArguments)
  let codeHash: string;
  if (staticStructure && staticStructure.nodes.length > 0) {
    codeHash = await hashSemanticStructure(staticStructure);  // ← Hash comes from nodes
  } else {
    codeHash = await hashCode(code); // Fallback for code without MCP calls
  }

  // 3. Normalize code_snippet for storage (SEPARATE from hash!)
  // Uses variableBindings to make stored code consistent
  let normalizedCode = code;
  if (staticStructure?.variableBindings) {
    normalizedCode = normalizeVariableNames(code, staticStructure.variableBindings).code;
  }
  // "const file = ..." → "const _n1 = ..."

  // 4. Store normalized code and semantic hash
  // ...
}
```

**Important:** The hash comes from static structure nodes (already normalized during AST traversal).
The code normalization is for human-readable storage, NOT for hashing.

### Tests

**File:** `tests/unit/capabilities/hash.test.ts`

- `hashSemanticStructure - same structure produces same hash`
- `hashSemanticStructure - different tools produce different hash`
- `hashSemanticStructure - different arguments produce different hash`
- `hashSemanticStructure - multiple variables normalize correctly`

**File:** `tests/unit/capabilities/normalize-variables.test.ts`

- `normalizeVariableNames - single variable`
- `normalizeVariableNames - multiple variables`
- `normalizeVariableNames - respects word boundaries`
- `normalizeVariableNames - handles variable in property access`
- `normalizeVariableNames - integration: same semantics produce same code`
- `normalizeVariableNames - integration: multiple MCP calls`

### Example: Full Deduplication Flow

```typescript
// Two capabilities with different variable names:
const code1 = `const file = await mcp.fs.read({ path: args.p });
return mcp.json.parse({ text: file.content });`;

const code2 = `const data = await mcp.fs.read({ path: args.p });
return mcp.json.parse({ text: data.content });`;

// 1. Build static structures:
const struct1 = await builder.buildStaticStructure(code1);
// → variableBindings: { file: "n1" }
// → nodes[0].arguments: { path: { type: "parameter", parameterName: "p" } }
// → nodes[1].arguments: { text: { type: "reference", expression: "n1.content" } }  ← ALREADY normalized!

const struct2 = await builder.buildStaticStructure(code2);
// → variableBindings: { data: "n1" }
// → nodes[0].arguments: { path: { type: "parameter", parameterName: "p" } }
// → nodes[1].arguments: { text: { type: "reference", expression: "n1.content" } }  ← SAME!

// 2. Semantic hashes are IDENTICAL (nodes have same arguments):
const hash1 = await hashSemanticStructure(struct1);
const hash2 = await hashSemanticStructure(struct2);
// hash1 === hash2 ✅ (because node arguments are identical)

// 3. Normalized code for storage (optional, for readability):
const norm1 = normalizeVariableNames(code1, struct1.variableBindings);
const norm2 = normalizeVariableNames(code2, struct2.variableBindings);
// norm1.code: "const _n1 = await mcp.fs.read(...); return mcp.json.parse({ text: _n1.content });"
// norm2.code: same!

// 4. Only ONE capability stored (deduplicated by code_hash)
```

**Key point:** The hash is identical because `extractArguments()` already converted
`file.content` → `n1.content` and `data.content` → `n1.content` during AST traversal.

---

## Changelog

- **2025-12-31:** Added semantic hashing & variable normalization (Story 7.2c) - `hashSemanticStructure()`
  produces same hash for semantically identical code regardless of variable names. `normalizeVariableNames()`
  normalizes stored code. `hashCode()` deprecated for capability deduplication.
- **2025-12-31:** Added nested literal extraction for code templates (Story 10.2f) - URLs, numbers,
  and strings inside Playwright/code templates are now parameterized with `${args.xxx}` interpolations
- **2025-12-31:** Template literals without interpolation now detected as `type: "literal"` (enables
  SQL query parameterization via `args.query`)
- **2025-12-28:** Added Method Chaining Support (Story 10.2c) - detects all operations in chained
  calls
- **2025-12-28:** Added computed expression evaluation (a + b, -x, !flag, etc.) for literal bindings
- **2025-12-28:** Added Literal Bindings (Story 10.2b - Option B) for local variable resolution
- **2025-12-26:** Added modular code operations detection with WorkerBridge tracing (Phase 1)
- **2025-12-26:** Added Array Operations (Phase 1 - Planned) section with `code:*` pseudo-tools
- **2025-12-22:** Added `Promise.all(arr.map(fn))` detection with literal array unrolling
