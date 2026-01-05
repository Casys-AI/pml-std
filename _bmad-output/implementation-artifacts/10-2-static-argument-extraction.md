# Story 10.2: Static Argument Extraction for Speculative Execution

Status: done

> **Epic:** 10 - DAG Capability Learning & Unified APIs **Tech-Spec:**
> [tech-spec-dag-capability-learning.md](../tech-specs/tech-spec-dag-capability-learning.md)
> **Prerequisites:** Story 10.1 (Static Structure Builder - DONE, 11 tests passing) **Depends on:**
> Story 3.5-1 (Speculative Execution - DONE)

---

## Story

As a speculative execution system, I want to extract and store tool arguments from static code
analysis, So that I can execute capabilities speculatively without requiring runtime argument
inference.

---

## Context & Problem

**Le problème actuel:** Story 10.1 parse le code et extrait les appels MCP tools, mais ne capture
PAS les arguments passés:

```typescript
// Code parsé :
const file = await mcp.fs.read({ path: "config.json" });

// Structure actuelle (Story 10.1) :
{ id: "n1", type: "task", tool: "fs:read" }  // <- PAS d'arguments !

// Structure souhaitée (Story 10.2) :
{
  id: "n1",
  type: "task",
  tool: "fs:read",
  arguments: {
    path: { type: "literal", value: "config.json" }
  }
}
```

**Pourquoi c'est important pour la spéculation:**

- L'exécution spéculative a besoin des arguments pour vraiment exécuter
- Les arguments peuvent être: littéraux, variables résolues via chaînage, ou paramètres de la
  capability
- Sans arguments, on ne peut que "préparer" l'exécution, pas l'exécuter

---

## Distinction importante : parametersSchema vs Arguments

**Ce qui existe déjà (Story 7.2b - SchemaInferrer):**

`parametersSchema` décrit les INPUTS de la capability (comme une signature de fonction):

```typescript
// Code analysé :
const file = await mcp.fs.read({ path: args.filePath });
if (args.debug) console.log(file);

// parametersSchema produit (déjà implémenté) :
{
  type: "object",
  properties: {
    filePath: { type: "string" },
    debug: { type: "boolean" }
  }
}
// → Dit "la capability attend un param filePath de type string et debug de type boolean"
```

**Ce que Story 10.2 ajoute:**

`arguments` de chaque node décrit COMMENT les params sont utilisés dans chaque appel tool:

```typescript
// Code analysé :
const file = await mcp.fs.read({ path: args.filePath });
const parsed = await mcp.json.parse({ input: file.content });

// static_structure.nodes[0].arguments (Story 10.2) :
{
  path: { type: "parameter", parameterName: "filePath" }
}
// → Dit "le tool fs:read reçoit path qui vient du param filePath de la capability"

// static_structure.nodes[1].arguments (Story 10.2) :
{
  input: { type: "reference", expression: "file.content" }
}
// → Dit "le tool json:parse reçoit input qui vient du résultat de file"
```

**Le lien entre les deux:** Story 10.2 utilise `parametersSchema` pour classifier les Identifiers :

- Si `filePath` est dans `parametersSchema.properties` → c'est un `parameter`
- Si c'est une MemberExpression (`file.content`) → c'est une `reference`
- Si c'est un literal (`"config.json"`) → c'est un `literal`

---

## Acceptance Criteria

### AC1: ArgumentValue Type Defined

- [x] New type `ArgumentValue` in `src/capabilities/types.ts`:

```typescript
interface ArgumentValue {
  type: "literal" | "reference" | "parameter";
  value?: unknown; // For literal: the actual value
  expression?: string; // For reference: "file.content", "result.data"
  parameterName?: string; // For parameter: "userPath", "inputData"
}
```

### AC2: ArgumentsStructure Type Defined

- [x] New type `ArgumentsStructure` in `src/capabilities/types.ts`:

```typescript
type ArgumentsStructure = Record<string, ArgumentValue>;
```

### AC3: StaticStructureNode Extended with Arguments

- [x] Type `StaticStructureNode` (task variant) extended:

```typescript
type StaticStructureNode = {
  id: string;
  type: "task";
  tool: string;
  arguments?: ArgumentsStructure; // NEW
};
// ... other variants unchanged
```

### AC4: Literal Argument Extraction

- [x] Extract literal values from ObjectExpression arguments
- [x] Support: strings, numbers, booleans, null
- [x] Support: nested objects and arrays (JSON-serializable)
- [x] Store as `{ type: "literal", value: <parsed_value> }`

### AC5: Reference Argument Detection

- [x] Detect MemberExpression arguments (e.g., `file.content`)
- [x] Extract expression as string representation
- [x] Store as `{ type: "reference", expression: "file.content" }`
- [x] Link to ProvidesEdge for resolution path (via existing edge generation)

### AC6: Parameter Argument Detection

- [x] Detect Identifier arguments that are function parameters
- [x] Check against known patterns: `args.X`, `params.X`, `input.X`
- [x] Store as `{ type: "parameter", parameterName: "X" }`

### AC7: Integration with PredictedNode (Capability Prediction)

- [x] In `predictCapabilities()` (extracted to `src/graphrag/prediction/capabilities.ts`), populate
      `PredictedNode.arguments` from capability's `static_structure`
- [x] Literals copied directly as `Record<string, unknown>` via
      `extractArgumentsFromStaticStructure()`
- [x] References logged for future runtime resolution (not included in arguments)
- [x] Parameters logged for future intent extraction (not included in arguments)

### AC8: Tests

- [x] Test: literal string argument extracted correctly
- [x] Test: literal number argument extracted correctly
- [x] Test: literal boolean argument extracted correctly
- [x] Test: literal object (nested) argument extracted correctly
- [x] Test: literal array argument extracted correctly
- [x] Test: reference argument (member expression) detected
- [x] Test: parameter argument (identifier) detected
- [x] Test: mixed arguments (literal + reference + parameter) handled
- [x] Test: empty arguments handled gracefully (returns `{}`)
- [x] Test: spread operator handled gracefully (skip or warn)

---

## Tasks / Subtasks

- [x] **Task 1: Define ArgumentsStructure types** (AC: 1, 2) ✅
  - [x] Add `ArgumentValue` interface to `src/capabilities/types.ts`
  - [x] Add `ArgumentsStructure` type alias to `src/capabilities/types.ts`
  - [x] Export new types from `src/capabilities/mod.ts`

- [x] **Task 2: Extend StaticStructureNode** (AC: 3) ✅
  - [x] Add optional `arguments?: ArgumentsStructure` to task variant in `StaticStructureNode`
  - [x] Verify type guards continue to work (discriminated union)

- [x] **Task 3: Implement argument extraction in StaticStructureBuilder** (AC: 4, 5, 6) ✅
  - [x] Add `extractArguments(callExprArgs: unknown[]): ArgumentsStructure` method
  - [x] Add `extractArgumentValue(node: unknown): ArgumentValue` helper
  - [x] Implement literal extraction for StringLiteral, NumericLiteral, BooleanLiteral
  - [x] Implement literal extraction for ObjectExpression (recursive)
  - [x] Implement literal extraction for ArrayExpression (recursive)
  - [x] Implement reference extraction for MemberExpression
  - [x] Implement parameter detection for Identifier patterns (`args.X`)

- [x] **Task 4: Store arguments in static_structure nodes** (AC: 3, 4, 5, 6) ✅
  - [x] Modify `handleCallExpression()` to call `extractArguments()` and store result
  - [x] Ensure backward compatibility (arguments is optional)

- [x] **Task 5: Link to PredictedNode in DAGSuggester** (AC: 7) ✅
  - [x] In `DAGSuggester.predictNextNodes()`, when source="capability", extract arguments from
        static_structure
  - [x] Resolve literals immediately to `PredictedNode.arguments`
  - [x] Mark references for runtime resolution (can log or skip for now)
  - [x] Mark parameters as "needs extraction from intent" (log or skip)

- [x] **Task 6: Write unit tests** (AC: 8) ✅
  - [x] Extend `tests/unit/capabilities/static_structure_builder_test.ts`
  - [x] Test literal extraction (string, number, boolean, object, array)
  - [x] Test reference detection (MemberExpression)
  - [x] Test parameter detection (Identifier via args.X)
  - [x] Test mixed argument scenarios
  - [x] Test edge cases (empty args, spread operator, computed properties)

---

## Dev Notes

### SWC AST for Arguments

The call expression arguments in SWC are wrapped in a `{ spread, expression }` structure:

```typescript
// Code: mcp.fs.read({ path: "config.json", verbose: true })
// AST (simplified):
{
  type: "CallExpression",
  callee: { /* MemberExpression: mcp.fs.read */ },
  arguments: [{
    spread: null,
    expression: {
      type: "ObjectExpression",
      properties: [
        {
          type: "KeyValueProperty",
          key: { type: "Identifier", value: "path" },
          value: { type: "StringLiteral", value: "config.json" }
        },
        {
          type: "KeyValueProperty",
          key: { type: "Identifier", value: "verbose" },
          value: { type: "BooleanLiteral", value: true }
        }
      ]
    }
  }]
}
```

**Important:** SWC wraps CallExpression arguments in `{ spread, expression }` structure - see Story
10.1 `handlePromiseAll()` for the pattern.

### SWC Literal Types

| Code       | SWC Type         | Value Property      |
| ---------- | ---------------- | ------------------- |
| `"hello"`  | StringLiteral    | `value: "hello"`    |
| `42`       | NumericLiteral   | `value: 42`         |
| `true`     | BooleanLiteral   | `value: true`       |
| `null`     | NullLiteral      | (no value)          |
| `{ a: 1 }` | ObjectExpression | `properties: [...]` |
| `[1, 2]`   | ArrayExpression  | `elements: [...]`   |

### Reference Expression Examples

```typescript
// Reference to previous result
{
  input: file.content;
}
// AST: MemberExpression { object: Identifier("file"), property: Identifier("content") }
// Store as: { type: "reference", expression: "file.content" }

// Chained reference
{
  data: result.items[0].value;
}
// Store as: { type: "reference", expression: "result.items[0].value" }
// Note: Computed member access like [0] requires special handling
```

### Parameter Detection Pattern

```typescript
// Common patterns for capability parameters:
const result = await mcp.fs.read({ path: args.filePath });
const result = await mcp.fs.read({ path: params.userPath });
const result = await mcp.fs.read({ path: input.path });

// Detection: MemberExpression where object is Identifier with value in ["args", "params", "input"]
// Extract parameterName from property.value
```

### Reusing Story 10.1 Patterns

The `StaticStructureBuilder` already has these helper methods that can be reused:

```typescript
// From static-structure-builder.ts (Story 10.1)

// Extract member chain: mcp.fs.read → ["mcp", "fs", "read"]
private extractMemberChain(node: Record<string, unknown>, parts: string[] = []): string[]

// Extract condition text (useful for reference expression building)
private extractConditionText(node: Record<string, unknown> | undefined): string
```

### Link to Speculative Execution

`PredictedNode.arguments` already exists in `src/graphrag/types.ts:233`:

```typescript
export interface PredictedNode {
  toolId: string;
  confidence: number;
  reasoning: string;
  source: "community" | "co-occurrence" | "capability" | "hint" | "learned";
  // ...
  arguments?: Record<string, unknown>; // ← ALREADY EXISTS
}
```

The link is in `DAGSuggester.predictNextNodes()` at `src/graphrag/dag-suggester.ts:333`. When a
capability is matched, we should extract its `static_structure` and populate
`PredictedNode.arguments` from the task nodes.

### Speculative Execution Flow

```typescript
// In SpeculativeExecutor.executeSpeculation():
async executeSpeculation(prediction: PredictedNode, context: ExecutionContext) {
  const args = {};

  for (const [key, argValue] of Object.entries(prediction.arguments || {})) {
    // For Story 10.2, we start simple: only pass literal values
    // References and parameters require runtime context (future stories)
    args[key] = argValue;  // Direct pass-through for now
  }

  return sandbox.execute(prediction.toolId, args);
}
```

---

## Architecture Alignment

| Pattern                  | Convention                                            |
| ------------------------ | ----------------------------------------------------- |
| SWC version              | `https://deno.land/x/swc@0.2.1/mod.ts` (same as 10.1) |
| Type location            | `src/capabilities/types.ts`                           |
| Implementation           | `src/capabilities/static-structure-builder.ts`        |
| DAGSuggester integration | `src/graphrag/dag-suggester.ts`                       |
| Error handling           | Graceful (return empty arguments on parse error)      |
| Logging                  | `getLogger("default")`                                |

### Project Structure Notes

**Files to Modify:**

- `src/capabilities/types.ts` - Add ArgumentValue, ArgumentsStructure types (~20 LOC)
- `src/capabilities/static-structure-builder.ts` - Add argument extraction (~100-150 LOC)
- `src/capabilities/mod.ts` - Export new types
- `src/graphrag/dag-suggester.ts` - Populate PredictedNode.arguments (~30 LOC)

**Test Files:**

- `tests/unit/capabilities/static_structure_builder_test.ts` - Add argument extraction tests

### Critical Implementation Pattern

The key insight is that `ArgumentsStructure` stores **how to resolve** each argument, not the
resolved value:

| Scenario      | Storage                                             | Resolution                                           |
| ------------- | --------------------------------------------------- | ---------------------------------------------------- |
| **Literal**   | `{ type: "literal", value: "config.json" }`         | Immediate - use value directly                       |
| **Reference** | `{ type: "reference", expression: "file.content" }` | Runtime - resolve via ProvidesEdge + previous result |
| **Parameter** | `{ type: "parameter", parameterName: "filePath" }`  | Runtime - extract from capability input              |

For Story 10.2, we focus on **storage**. Resolution is handled by speculative execution.

---

## References

**Codebase Sources (CRITICAL - Read these first):**

- `src/capabilities/static-structure-builder.ts:297-346` - `handleCallExpression()` to extend
- `src/capabilities/static-structure-builder.ts:510-530` - `extractMemberChain()` to reuse
- `src/capabilities/static-structure-builder.ts:535-580` - `extractConditionText()` pattern
- `src/capabilities/types.ts:353-398` - `StaticStructureNode` and related types
- `src/graphrag/types.ts:208-234` - `PredictedNode` with existing `arguments` field
- `src/graphrag/dag-suggester.ts:333-380` - `predictNextNodes()` where to integrate
- `tests/unit/capabilities/static_structure_builder_test.ts` - 11 existing tests as pattern

**Epic & Tech Spec:**

- [epic-10-dag-capability-learning-unified-apis.md](../epics/epic-10-dag-capability-learning-unified-apis.md) -
  Story 10.2 definition
- [tech-spec-dag-capability-learning.md](../tech-specs/tech-spec-dag-capability-learning.md) -
  Overall architecture

**SWC Documentation:**

- [deno.land/x/swc@0.2.1](https://deno.land/x/swc@0.2.1) - Module homepage (LATEST)
- [GitHub: littledivy/deno_swc](https://github.com/littledivy/deno_swc) - Source & README

**Previous Story Learnings (10.1):**

- SWC wraps arguments in `{ spread, expression }` structure - always unwrap
- Use discriminated unions for node types (already established pattern)
- Graceful error handling: return empty structure on errors, don't throw
- Keep counters for unique node IDs (existing pattern)

**ADRs:**

- ADR-006: Speculative Execution as Default Mode
- ADR-041: Hierarchical Trace Tracking (parentTraceId)

---

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

- 22 tests passing in `static_structure_builder_test.ts`

### Completion Notes List

- ArgumentValue/ArgumentsStructure types added to types.ts with full JSDoc documentation
- StaticStructureNode task variant extended with optional `arguments` field
- extractArguments() and extractArgumentValue() methods added to StaticStructureBuilder
- Handles: literals (string/number/boolean/null/object/array), references (MemberExpression),
  parameters (args.X/params.X/input.X)
- Integration via CapabilityStore.getStaticStructure() → predictCapabilities() →
  PredictedNode.arguments
- Spread operators gracefully skipped with debug logging

### Change Log

- 2025-12-28: **Story 10.2b Extension** - Literal Bindings for local variable resolution (Claude
  Opus 4.5)
- 2025-12-19: Story context created by BMM create-story workflow (Claude Opus 4.5)
- 2025-12-19: Implementation completed (Claude Opus 4.5) - All AC met, 22 tests passing
- 2025-12-19: Code review fixes - AC7 wording corrected, File List updated, checkboxes completed
  (Claude Opus 4.5)

---

## Extension: Story 10.2b - Literal Bindings (Option B)

**Status:** ✅ IMPLEMENTED (2025-12-28)

### Problem Discovered

After Story 10.2 implementation, a critical gap was discovered: **local variable declarations with
literal values were not tracked**, causing argument resolution to fail for shorthand properties:

```typescript
// This code FAILED:
const numbers = [10, 20, 30];     // ← VariableDeclaration NOT tracked
mcp.math.sum({ numbers })         // ← { numbers: { type: "reference", expression: "numbers" }}

// At runtime:
resolveReference("numbers") → undefined  // ❌ Bug!
```

**Root Cause:** `handleVariableDeclarator` only tracked variables assigned from MCP calls (creating
`variableBindings` → node ID mapping), not literals.

### Solution: Option B - literalBindings

Instead of inlining literals at static analysis time (Option A), we chose **Option B**: track
literal values separately and pass them to the execution context.

**Why Option B:**

- More extensible for future features (mutations, reassignments)
- Follows existing design intent (argument-resolver already has fallback for local variables)
- Cleaner separation of concerns

### Implementation

| File                                           | Change                                                                                       |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `src/capabilities/types.ts`                    | `literalBindings?: Record<string, JsonValue>` already existed (Story 10.2)                   |
| `src/capabilities/static-structure-builder.ts` | Added `literalBindings` map, `isLiteralExpression()`, tracking in `handleVariableDeclarator` |
| `src/mcp/handlers/code-execution-handler.ts`   | Spread `staticStructure.literalBindings` into `executionContext`                             |

### Flow

```typescript
// 1. static-structure-builder detects the literal:
if (variableName && init && this.isLiteralExpression(init)) {
  this.literalBindings.set(variableName, this.extractLiteralValue(init));
}

// 2. buildStaticStructure returns:
{
  nodes, edges, variableBindings, literalBindings;
}

// 3. code-execution-handler passes to context:
const executionContext = {
  parameters: request.context || {},
  ...staticStructure.literalBindings, // ← { numbers: [10, 20, 30] }
};

// 4. argument-resolver uses existing fallback (line 182-189):
if (rootPart in context) {
  return context[rootPart]; // ← Works! ✅
}
```

### Supported Types

| Type                  | Example                | Tracked |
| --------------------- | ---------------------- | ------- |
| Array                 | `[1, 2, 3]`            | ✅      |
| Object                | `{ a: 1 }`             | ✅      |
| String/Number/Boolean | `"test"`, `42`, `true` | ✅      |
| Nested structures     | `[[1,2], [3,4]]`       | ✅      |

### NOT Supported (v1)

| Type                           | Reason              |
| ------------------------------ | ------------------- |
| Computed expressions (`a + b`) | Requires evaluation |
| Function calls (`foo()`)       | Runtime-only        |
| `let` mutations                | Dynamic value       |

### Tests Added

See `tests/unit/capabilities/static-structure-code-ops.test.ts`:

- `literalBindings tracks array literals`
- `literalBindings tracks object literals`
- `literalBindings tracks primitive literals`
- `literalBindings does NOT track MCP results`
- `literalBindings works with nested arrays`

### Documentation

Full technical details:
[SWC Static Structure Detection](../architecture/swc-static-structure-detection.md#literal-bindings-story-102b---option-b)

---

### File List

- [x] `src/capabilities/types.ts` - MODIFY (add ArgumentValue, ArgumentsStructure types, extend
      StaticStructureNode)
- [x] `src/capabilities/static-structure-builder.ts` - MODIFY (add argument extraction methods ~250
      LOC)
- [x] `src/capabilities/mod.ts` - MODIFY (export new types ArgumentValue, ArgumentsStructure)
- [x] `src/capabilities/capability-store.ts` - MODIFY (add getStaticStructure() method for
      DAGSuggester integration)
- [x] `src/graphrag/prediction/capabilities.ts` - MODIFY (add extractArgumentsFromStaticStructure(),
      populate PredictedNode.arguments)
- [x] `tests/unit/capabilities/static_structure_builder_test.ts` - MODIFY (add 10 argument
      extraction tests)
