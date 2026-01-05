# Story 10.1: Static Code Analysis - Capability Creation

Status: done

> **Epic:** 10 - DAG Capability Learning & Unified APIs **Tech-Spec:**
> [tech-spec-dag-capability-learning.md](../tech-specs/tech-spec-dag-capability-learning.md)
> **Prerequisites:** Story 7.2b (SWC Schema Inference - DONE, 19 tests passing) **Depends on:** Epic
> 7 (Emergent Capabilities), HIL Phase 2 (Permission Escalation)

---

## Story

As an execution system, I want to parse code statically to generate a complete `static_structure`,
So that I can **create the Capability immediately** with full branch/condition visibility for HIL.

---

## Context & Philosophy Change

**AVANT:** La Capability etait creee apres execution (validee par l'usage) **MAINTENANT:** La
Capability est creee a l'analyse statique (structure complete)

**Pourquoi ce changement?**

1. L'analyse statique EST suffisante grace aux schemas MCP et a l'inference existante
2. L'HIL fonctionne immediatement (on connait les tools avant execution)
3. Les conditions/branches sont visibles dans la structure, pas perdues dans les traces
4. La memoire episodique (traces) et semantique (capability) sont bien separees

**Distinction cle:**

| Concept        | Quand cree                  | Contenu                                     | Stockage                                          |
| -------------- | --------------------------- | ------------------------------------------- | ------------------------------------------------- |
| **Capability** | Analyse statique (PRE-exec) | Structure COMPLETE avec branches/conditions | `workflow_pattern.dag_structure.static_structure` |
| **Trace**      | Apres execution (POST-exec) | Chemin EMPRUNTE (une branche)               | `execution_trace` (Epic 11)                       |
| **Learning**   | Agregation des traces       | Stats par chemin, dominant path             | `workflow_pattern.dag_structure.learning`         |

---

## Acceptance Criteria

### AC1: StaticStructureBuilder Class Created

- [x] File `src/capabilities/static-structure-builder.ts` created
- [x] Class `StaticStructureBuilder` exported
- [x] Constructor: `constructor(db: PGliteClient)`
- [x] Reuses SWC import: `https://deno.land/x/swc@0.2.1/mod.ts` (same as SchemaInferrer)

### AC2: Static Structure Types Defined

- [x] Types added to `src/capabilities/types.ts`:

```typescript
// Static structure node types
type StaticStructureNode =
  | { id: string; type: "task"; tool: string }
  | { id: string; type: "decision"; condition: string }
  | { id: string; type: "capability"; capabilityId: string }
  | { id: string; type: "fork" }
  | { id: string; type: "join" };

// Static structure edge types
interface StaticStructureEdge {
  from: string;
  to: string;
  type: "sequence" | "provides" | "conditional" | "contains";
  outcome?: string; // For conditional: "true", "false", "case1"
  coverage?: "strict" | "partial" | "optional"; // For provides
}

interface StaticStructure {
  nodes: StaticStructureNode[];
  edges: StaticStructureEdge[];
}
```

### AC3: buildStaticStructure Method

- [x] Method `buildStaticStructure(code: string): Promise<StaticStructure>` implemented
- [x] Returns StaticStructure with nodes and edges arrays
- [x] Empty arrays `{ nodes: [], edges: [] }` if no patterns detected
- [x] Graceful error handling (returns empty structure on parse errors)

### AC4: Node Detection - MCP Tools

- [x] Detect `mcp.*.*()` calls -> Node type "task" with tool ID
- [x] Extract tool name from member chain (e.g., `mcp.filesystem.read` -> `filesystem:read`)
- [x] Handle both `mcp.server.tool()` and `await mcp.server.tool()` patterns

### AC5: Node Detection - Capabilities

- [x] Detect `capabilities.*()` calls -> Node type "capability"
- [x] Extract capability ID from call
- [x] Create `CapabilityDependency` edge (from current cap to called cap)

### AC6: Node Detection - Control Flow

- [x] Detect `if/else` statements -> Node type "decision" with condition string
- [x] Detect `switch` statements -> Node type "decision"
- [x] Detect ternary operators `? :` -> Node type "decision"
- [x] Detect `Promise.all/allSettled` -> Nodes "fork" + "join"

### AC7: Edge Generation - Sequence

- [x] Sequential `await` statements generate "sequence" edges
- [x] Order preserved from AST traversal
- [x] No edge between parallel tasks (detected via Promise.all)

### AC8: Edge Generation - Conditional

- [x] `if` branches generate "conditional" edges with outcome "true"/"false"
- [x] `switch` cases generate "conditional" edges with case value as outcome
- [x] `else` block generates "conditional" edge with outcome "false"

### AC9: Edge Generation - Provides (Data Flow)

- [x] Query `tool_schema.input_schema` and `tool_schema.output_schema` from DB
- [x] Calculate coverage: outputs(A) intersect inputs(B)
- [x] Generate "provides" edge with coverage: "strict", "partial", or "optional"
- [x] No edge if no intersection

### AC10: Integration with CapabilityStore

- [x] `CapabilityStore` constructor accepts optional `StaticStructureBuilder`
- [x] `saveCapability()` calls `buildStaticStructure(code)` before saving
- [x] Static structure stored in `dag_structure.static_structure` JSON field
- [x] Creates `CapabilityDependency` records for nested capability calls

### AC11: HIL Integration

- [x] Extract all tools from `static_structure.nodes` (type "task")
- [x] For each tool, call `getToolPermissionConfig()` (from permission-inferrer.ts)
- [x] If any tool has `approvalMode: "hil"`, flag capability for pre-execution approval
- [x] Return list of HIL-required tools in structure metadata

### AC12: Tests

- [x] Test: code with `mcp.fs.read()` -> node type "task", tool "fs:read"
- [x] Test: code with `if/else` -> node "decision" + edges "conditional"
- [x] Test: code with `Promise.all([...])` -> nodes "fork"/"join"
- [x] Test: code with `capabilities.summarize()` -> node "capability" + CapabilityDependency
- [x] Test: tool A output -> tool B input -> edge "provides" with coverage calculated
- [x] Test: code without mcp/capabilities calls -> empty structure (graceful)
- [x] Test: parse error -> empty structure (graceful, no exception)

---

## Tasks / Subtasks

- [x] **Task 1: Define types** (AC: 2)
  - [x] Add `StaticStructureNode` type union to types.ts
  - [x] Add `StaticStructureEdge` interface to types.ts
  - [x] Add `StaticStructure` interface to types.ts
  - [x] Export new types from mod.ts

- [x] **Task 2: Create StaticStructureBuilder class** (AC: 1, 3)
  - [x] Create `src/capabilities/static-structure-builder.ts`
  - [x] Import SWC parse (same version as SchemaInferrer)
  - [x] Implement `wrapCodeIfNeeded()` (reuse pattern from SchemaInferrer)
  - [x] Implement `buildStaticStructure()` main method
  - [x] Add graceful error handling

- [x] **Task 3: Implement node detection** (AC: 4, 5, 6)
  - [x] Implement `findMcpToolCalls()` - detect `mcp.*.*()` patterns
  - [x] Implement `findCapabilityCalls()` - detect `capabilities.*()` patterns
  - [x] Implement `findControlFlowNodes()` - detect if/switch/ternary
  - [x] Implement `findParallelBlocks()` - detect Promise.all/allSettled
  - [x] Generate unique node IDs (n1, n2, d1, f1, j1, etc.)

- [x] **Task 4: Implement edge generation** (AC: 7, 8, 9)
  - [x] Implement `generateSequenceEdges()` - connect sequential awaits
  - [x] Implement `generateConditionalEdges()` - connect decision nodes to branches
  - [x] Implement `generateProvidesEdges()` - query tool schemas, calculate coverage
  - [x] Implement `computeCoverage()` helper function

- [x] **Task 5: Integrate with CapabilityStore** (AC: 10)
  - [x] Add `staticStructureBuilder?: StaticStructureBuilder` to CapabilityStore constructor
  - [x] Call `buildStaticStructure()` in `saveCapability()` after schema inference
  - [x] Store result in `dag_structure.static_structure`
  - [x] Create `CapabilityDependency` records for detected capability calls

- [x] **Task 6: Implement HIL integration** (AC: 11)
  - [x] Extract tool IDs from static_structure nodes
  - [x] Query permission configs via `getToolPermissionConfig()`
  - [x] Flag HIL-required tools in metadata
  - [x] Add `hilRequiredTools: string[]` to structure response

- [x] **Task 7: Write unit tests** (AC: 12)
  - [x] Create `tests/unit/capabilities/static_structure_builder_test.ts`
  - [x] Test MCP tool detection
  - [x] Test control flow detection
  - [x] Test parallel block detection
  - [x] Test edge generation
  - [x] Test provides edge coverage calculation
  - [x] Test graceful error handling

---

## Dev Notes

### Reusable Patterns from SchemaInferrer (7.2b)

The existing `SchemaInferrer` provides proven patterns to follow:

```typescript
// 1. SWC import (same version)
import { parse } from "https://deno.land/x/swc@0.2.1/mod.ts";

// 2. Code wrapping pattern
private wrapCodeIfNeeded(code: string): string {
  if (code.includes("function ") || code.includes("class ") || code.includes("export ")) {
    return code;
  }
  return `async function _wrapper() {\n${code}\n}`;
}

// 3. AST traversal pattern
private findPatterns(node: unknown, results: Map<string, T> = new Map()): T[] {
  if (!node || typeof node !== "object") {
    return Array.from(results.values());
  }
  const n = node as Record<string, unknown>;

  // Check node type and extract info
  if (n.type === "CallExpression") { /* ... */ }

  // Recurse through children
  for (const key of Object.keys(n)) {
    const val = n[key];
    if (Array.isArray(val)) {
      for (const item of val) this.findPatterns(item, results);
    } else if (typeof val === "object" && val !== null) {
      this.findPatterns(val, results);
    }
  }
  return Array.from(results.values());
}

// 4. Member chain extraction (from PermissionInferrer)
private extractMemberChain(node: Record<string, unknown>, parts: string[] = []): string[] {
  if (node.type === "Identifier") {
    return [node.value as string, ...parts];
  }
  if (node.type === "MemberExpression") {
    const prop = node.property as Record<string, unknown>;
    if (prop?.type === "Identifier" && typeof prop?.value === "string") {
      parts.unshift(prop.value);
    }
    return this.extractMemberChain(node.object as Record<string, unknown>, parts);
  }
  return parts;
}
```

### SWC AST Node Types Reference

| Code Pattern      | AST Node Type         | Key Properties                  |
| ----------------- | --------------------- | ------------------------------- |
| `mcp.fs.read()`   | CallExpression        | callee: MemberExpression        |
| `await expr`      | AwaitExpression       | argument: CallExpression        |
| `if (cond) { }`   | IfStatement           | test, consequent, alternate     |
| `switch (x) { }`  | SwitchStatement       | discriminant, cases             |
| `cond ? a : b`    | ConditionalExpression | test, consequent, alternate     |
| `Promise.all([])` | CallExpression        | callee.property.value === "all" |
| `const { a } = x` | VariableDeclarator    | id: ObjectPattern               |

### Provides Edge Coverage Algorithm

```typescript
function computeCoverage(
  providerOutputs: Set<string>,
  consumerInputs: { required: Set<string>; optional: Set<string> },
): "strict" | "partial" | "optional" | null {
  const requiredCovered = intersection(consumerInputs.required, providerOutputs);
  const optionalCovered = intersection(consumerInputs.optional, providerOutputs);

  // No intersection = no edge
  if (requiredCovered.size === 0 && optionalCovered.size === 0) {
    return null;
  }

  // All required covered = strict
  if (isSubset(consumerInputs.required, providerOutputs)) {
    return "strict";
  }

  // Some required covered = partial
  if (requiredCovered.size > 0) {
    return "partial";
  }

  // Only optional covered
  return "optional";
}
```

### Example: Code to Static Structure

**Input code:**

```typescript
const file = await mcp.fs.stat({ path });
if (file.exists) {
  const content = await mcp.fs.read({ path });
  return content;
} else {
  await mcp.fs.create({ path });
  await mcp.fs.write({ path, content: "" });
}
```

**Output static_structure:**

```typescript
{
  nodes: [
    { id: "n1", type: "task", tool: "fs:stat" },
    { id: "d1", type: "decision", condition: "file.exists" },
    { id: "n2", type: "task", tool: "fs:read" },
    { id: "n3", type: "task", tool: "fs:create" },
    { id: "n4", type: "task", tool: "fs:write" },
  ],
  edges: [
    { from: "n1", to: "d1", type: "sequence" },
    { from: "d1", to: "n2", type: "conditional", outcome: "true" },
    { from: "d1", to: "n3", type: "conditional", outcome: "false" },
    { from: "n3", to: "n4", type: "sequence" },
    { from: "n1", to: "n2", type: "provides", coverage: "strict" }  // Data flow infere
  ]
}
```

### Project Structure Notes

**Files to Create:**

- `src/capabilities/static-structure-builder.ts` (~200-250 LOC)

**Files to Modify:**

- `src/capabilities/types.ts` - Add StaticStructure types (~40 LOC)
- `src/capabilities/capability-store.ts` - Integrate static_structure (~30 LOC)
- `src/capabilities/mod.ts` - Export new class

**Test Files:**

- `tests/unit/capabilities/static_structure_builder_test.ts` - New test file

### Architecture Alignment

| Pattern        | Location               | Convention                             |
| -------------- | ---------------------- | -------------------------------------- |
| SWC import     | Direct URL             | `https://deno.land/x/swc@0.2.1/mod.ts` |
| Logging        | `getLogger("default")` | Use existing telemetry logger          |
| Error handling | Non-critical           | Return empty structure, don't throw    |
| DB access      | `PGliteClient`         | Query tool_schema for provides edges   |

### References

**Epic & Tech Spec:**

- [epic-10-dag-capability-learning-unified-apis.md](../epics/epic-10-dag-capability-learning-unified-apis.md)
- [tech-spec-dag-capability-learning.md](../tech-specs/tech-spec-dag-capability-learning.md)

**SWC Documentation (v0.2.1 - LATEST):**

- [deno.land/x/swc@0.2.1](https://deno.land/x/swc@0.2.1) - Module homepage
- [GitHub: littledivy/deno_swc](https://github.com/littledivy/deno_swc) - Source & README
- [SWC Official Docs](https://swc.rs/docs/usage/core) - Core SWC documentation

**SWC API Reference:**

```typescript
// Import (same as SchemaInferrer/PermissionInferrer)
import { parse } from "https://deno.land/x/swc@0.2.1/mod.ts";

// Parse options
const ast = await parse(code, {
  syntax: "typescript", // or "ecmascript"
  comments: false,
  script: true, // vs module
});

// Key AST node types for Story 10.1:
// - CallExpression: function calls (mcp.*.*, capabilities.*)
// - MemberExpression: property access (mcp.filesystem.read)
// - AwaitExpression: async calls
// - IfStatement: if/else blocks
// - SwitchStatement: switch/case blocks
// - ConditionalExpression: ternary operators
// - ArrayExpression: Promise.all([...])
```

**Codebase Pattern Sources:**

- `src/capabilities/schema-inferrer.ts` (726 LOC, 19 tests) - AST traversal patterns
- `src/capabilities/permission-inferrer.ts` (706 LOC) - Member chain extraction
- `src/capabilities/types.ts` - Capability type definitions

**ADRs:**

- ADR-041: Hierarchical Trace Tracking (parentTraceId)
- ADR-035: Permission Sets (getToolPermissionConfig)

---

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

- SWC AST debugging for Promise.all argument structure (wrapped in `{ spread, expression }`)

### Completion Notes List

- StaticStructureBuilder implemented with 800+ LOC
- 11 unit tests passing (all AC12 tests)
- Types exported from mod.ts: `StaticStructure`, `StaticStructureNode`, `StaticStructureEdge`,
  `ProvidesCoverage`
- HIL integration via `getHILRequiredTools()` method
- Prerequisite export added: `getToolPermissionConfig` and `PermissionConfig` now exported from
  mod.ts

### Change Log

- 2025-12-18: Story context created by BMM create-story workflow
- 2025-12-18: Implementation completed - StaticStructureBuilder class with full AST analysis
- 2025-12-18: Code Review fix - AC10 integration: StaticStructureBuilder added to CapabilityStore
  constructor and saveCapability method

### File List

- [x] `src/capabilities/static-structure-builder.ts` - NEW (800+ LOC)
- [x] `src/capabilities/types.ts` - MODIFY (add StaticStructure types, ~60 LOC added)
- [x] `src/capabilities/mod.ts` - MODIFY (export StaticStructureBuilder + types)
- [x] `src/capabilities/capability-store.ts` - MODIFY (AC10 integration: constructor +
      saveCapability)
- [x] `tests/unit/capabilities/static_structure_builder_test.ts` - NEW (11 tests)
