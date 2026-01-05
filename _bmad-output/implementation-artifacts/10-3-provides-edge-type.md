# Story 10.3: Provides Edge Type - Data Flow Relationships

Status: done

> **Epic:** 10 - DAG Capability Learning & Unified APIs **Tech-Spec:**
> [tech-spec-dag-capability-learning.md](../tech-specs/tech-spec-dag-capability-learning.md)
> **Prerequisites:** Story 10.1 (Static Analysis - DONE, provides edges at code level) **Depends
> on:** Epic 7 (Emergent Capabilities), existing `tool_schema` table with input/output schemas

---

## Story

As a graph learning system, I want a `provides` edge type that captures data flow between tools, So
that I can understand which tools can feed data to which other tools and improve DAG suggestions.

---

## Context

**Distinction between Story 10.1 and 10.3:**

| Aspect          | Story 10.1 (DONE)                              | Story 10.3 (THIS)                                          |
| --------------- | ---------------------------------------------- | ---------------------------------------------------------- |
| **Level**       | Code analysis                                  | Graph system                                               |
| **Scope**       | Edges WITHIN a capability's code               | Edges BETWEEN tools in the global graph                    |
| **Location**    | `src/capabilities/static-structure-builder.ts` | `src/graphrag/algorithms/edge-weights.ts` + new calculator |
| **Data Source** | AST analysis + inline schema lookup            | MCP tool schemas from `tool_schema` table                  |
| **Purpose**     | Visualize data flow in capability structure    | Improve DAG suggestions via schema-based relatedness       |

**Why this matters:**

- The DAGSuggester can use `provides` edges to understand which tools naturally chain together
- Pathfinding algorithms can prefer paths where data flows naturally (A's output -> B's input)
- The graph visualization can show data flow relationships separate from co-occurrence

**Coverage Types (from Epic spec):**

```typescript
type ProvidesCoverage =
  | "strict" // R <= O (all required inputs covered)
  | "partial" // R intersection O != empty (some required covered)
  | "optional"; // Only optional inputs covered
```

---

## Acceptance Criteria

### AC1: Cleanup EdgeType in edge-weights.ts

- [x] Add `provides` to `EdgeType` union
- [x] Remove `alternative` (not used, not in ADR-050)
- [x] Final `EdgeType`: `"dependency" | "contains" | "sequence" | "provides"`

### AC2: Configure provides Weight

- [x] Add `provides: 0.7` to `EDGE_TYPE_WEIGHTS`
- [x] Position: stronger than sequence (0.5), weaker than contains (0.8)
- [x] Rationale: Data flow is meaningful but less certain than explicit hierarchy

### AC3: Define ProvidesEdge Interface

- [x] Create interface in `src/graphrag/types.ts`:

```typescript
interface ProvidesEdge {
  from: string; // Tool/capability provider
  to: string; // Tool/capability consumer
  type: "provides";
  coverage: ProvidesCoverage;

  // Schemas exposed for AI to understand how to fill args
  providerOutputSchema: JSONSchema; // What A produces
  consumerInputSchema: JSONSchema; // What B expects (required + optional)
  fieldMapping: Array<{ // Field-by-field correspondences
    fromField: string; // e.g., "content"
    toField: string; // e.g., "json"
    typeCompatible: boolean; // Types compatible?
  }>;
}
```

### AC4: Implement computeCoverage Function

- [x] Create `src/graphrag/provides-edge-calculator.ts`
- [x] Function signature:

```typescript
function computeCoverage(
  providerOutputs: Set<string>,
  consumerInputs: { required: Set<string>; optional: Set<string> },
): ProvidesCoverage | null;
```

- [x] Returns `null` if no intersection (no edge)
- [x] Returns `"strict"` if all required inputs covered
- [x] Returns `"partial"` if some required inputs covered
- [x] Returns `"optional"` if only optional inputs covered

### AC5: Implement createProvidesEdges Function

- [x] Function to calculate provides edges from MCP tool schemas
- [x] Signature:

```typescript
async function createProvidesEdges(
  db: PGliteClient,
  toolIds?: string[], // Optional filter, all tools if not provided
): Promise<ProvidesEdge[]>;
```

- [x] Query `tool_schema.input_schema` and `tool_schema.output_schema`
- [x] For each pair (A, B), calculate coverage
- [x] Create edge if coverage !== null
- [x] Include field mapping for each matched field

### AC6: Type Compatibility Check

- [x] Implement `areTypesCompatible(fromType: string, toType: string): boolean`
- [x] Basic rules:
  - Same type = compatible
  - `string` -> `any` = compatible
  - `object` -> `any` = compatible
  - `number` -> `string` = compatible (can stringify)
- [x] Strictness configurable via parameter

### AC7: Database Storage

- [x] No migration needed - `edge_type` column is already TEXT
- [x] Ensure `tool_dependency` table can store `provides` edges
- [x] Include `provides_metadata` JSONB for schema details (optional - not needed, full schema in
      ProvidesEdge)

### AC8: Integration with GraphStore

- [x] `GraphStore.addEdge()` accepts `provides` edge type
- [x] `GraphStore.getEdges()` can filter by `provides` type (added `getEdgesByType()`)
- [x] Edge weight calculation uses `EDGE_TYPE_WEIGHTS.provides`

### AC9: Tests

- [x] Test: `fs:read` (output: content) -> `json:parse` (input: json) -> coverage = "partial" or
      "strict"
- [x] Test: `json:parse` -> `http:post` (needs url, body) -> coverage = "partial"
- [x] Test: No overlap between schemas -> null (no edge)
- [x] Test: Provider has no output_schema -> null (no edge)
- [x] Test: Field mapping correctly identifies compatible fields

### AC10: Scalable DB Persistence (Performance Optimization)

- [x] Persist provides edges to `tool_dependency` table for O(1) queries
- [x] Implement `persistProvidesEdges()` to store calculated edges in DB
- [x] Implement `syncProvidesEdgesForTool()` for incremental updates when a tool schema changes
- [x] Modify `getToolProvidesEdges()` to query DB directly instead of recalculating O(n²)
- [x] Store coverage in `confidence_score` column (strict=1.0, partial=0.7, optional=0.4)
- [x] Implement `syncAllProvidesEdges()` for full refresh
- [x] Implement `getToolProvidesEdgesFull()` for complete data with schema join
- [x] Rationale: With 1000+ tools, O(n²) calculation per query is not viable

---

## Tasks / Subtasks

- [x] **Task 1: Update EdgeType** (AC: 1, 2)
  - [x] Edit `src/graphrag/algorithms/edge-weights.ts`
  - [x] Add `provides` to EdgeType union
  - [x] Remove `alternative` from EdgeType
  - [x] Add `provides: 0.7` to EDGE_TYPE_WEIGHTS
  - [x] Update JSDoc comments

- [x] **Task 2: Define Types** (AC: 3)
  - [x] Add `ProvidesCoverage` type to `src/graphrag/types.ts` (re-exported from
        capabilities/types.ts)
  - [x] Add `ProvidesEdge` interface to `src/graphrag/types.ts`
  - [x] Add `FieldMapping` interface
  - [x] Export from module

- [x] **Task 3: Create Provides Edge Calculator** (AC: 4, 5, 6)
  - [x] Create `src/graphrag/provides-edge-calculator.ts`
  - [x] Implement `computeCoverage()` function
  - [x] Implement `areTypesCompatible()` helper
  - [x] Implement `createFieldMapping()` helper
  - [x] Implement `createProvidesEdges()` main function
  - [x] Export from `src/graphrag/mod.ts`

- [x] **Task 4: Integrate with GraphStore** (AC: 7, 8)
  - [x] Verify `GraphStore.addEdge()` handles provides type
  - [x] Add `getEdgesByType()` method
  - [x] Ensure edge weight calculation works

- [x] **Task 5: Write Tests** (AC: 9)
  - [x] Create `tests/unit/graphrag/provides_edge_calculator_test.ts`
  - [x] Test computeCoverage() with various schemas
  - [x] Test createProvidesEdges() with mock tool schemas (semantic matching tests)
  - [x] Test field mapping generation
  - [x] Test type compatibility rules

- [x] **Task 6: DB Persistence for Scalability** (AC: 10)
  - [x] Implement `persistProvidesEdges(db, edges)` - bulk insert/upsert to tool_dependency
  - [x] Implement `syncProvidesEdgesForTool(db, toolId)` - recalculate edges for one tool
  - [x] Implement `syncAllProvidesEdges(db)` - full refresh of all provides edges
  - [x] Modify `getToolProvidesEdges()` to query tool_dependency table directly (O(1))
  - [x] Modify `findDirectProvidesEdge()` to query DB directly (O(1))
  - [x] Add `getToolProvidesEdgesFull()` for complete data with schema join
  - [x] Add 6 integration tests with PGlite in-memory DB

---

## Dev Notes

### Reusable Pattern from Story 10.1

Story 10.1 already implemented `computeCoverage()` in `static-structure-builder.ts:841-881`. The
algorithm can be reused:

```typescript
// From static-structure-builder.ts (lines 841-881)
private computeCoverage(
  providerOutput: { properties?: Record<string, unknown> },
  consumerInput: { properties?: Record<string, unknown>; required?: string[] },
): ProvidesCoverage | null {
  const outputProps = new Set(Object.keys(providerOutput.properties || {}));
  const inputProps = new Set(Object.keys(consumerInput.properties || {}));
  const requiredInputs = new Set(consumerInput.required || []);

  // Calculate intersections
  const allIntersection = new Set([...outputProps].filter((p) => inputProps.has(p)));
  const requiredIntersection = new Set([...outputProps].filter((p) => requiredInputs.has(p)));
  const optionalIntersection = new Set([...allIntersection].filter((p) => !requiredInputs.has(p)));

  // No intersection = no edge
  if (allIntersection.size === 0) return null;

  // All required covered = strict
  if (requiredInputs.size > 0 && requiredIntersection.size === requiredInputs.size) {
    return "strict";
  }

  // Some required covered = partial
  if (requiredIntersection.size > 0) return "partial";

  // Only optional covered
  if (optionalIntersection.size > 0) return "optional";

  return null;
}
```

**Difference:** Story 10.3's version also needs to return `fieldMapping` details.

### Current edge-weights.ts Structure

```typescript
// Current (from src/graphrag/algorithms/edge-weights.ts)
export type EdgeType = "dependency" | "contains" | "alternative" | "sequence";

export const EDGE_TYPE_WEIGHTS: Record<EdgeType, number> = {
  dependency: 1.0, // Explicit DAG from templates
  contains: 0.8, // Parent-child hierarchy
  alternative: 0.6, // Same intent, different implementation (REMOVE)
  sequence: 0.5, // Temporal order
};

// Target after this story:
export type EdgeType = "dependency" | "contains" | "sequence" | "provides";

export const EDGE_TYPE_WEIGHTS: Record<EdgeType, number> = {
  dependency: 1.0, // Explicit DAG from templates
  contains: 0.8, // Parent-child hierarchy
  provides: 0.7, // Data flow (NEW)
  sequence: 0.5, // Temporal order
};
```

### Tool Schema Table Structure

```sql
-- From migration 004
CREATE TABLE tool_schema (
  tool_id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  input_schema JSONB,      -- JSON Schema for tool inputs
  output_schema JSONB,     -- JSON Schema for tool outputs (may be null)
  description TEXT,
  intent_embedding vector(1024),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

### Example Schema Analysis

```typescript
// filesystem:read_file schema
{
  input_schema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"]
  },
  output_schema: {
    type: "object",
    properties: { content: { type: "string" } }
  }
}

// json:parse schema
{
  input_schema: {
    type: "object",
    properties: { json: { type: "string" } },
    required: ["json"]
  },
  output_schema: {
    type: "object",
    properties: { parsed: { type: "object" } }
  }
}

// Analysis: fs:read_file -> json:parse
// Provider outputs: { content }
// Consumer inputs: { json } (required)
// Intersection: {} (no exact match)
// But with field mapping: content -> json (both strings) = partial coverage
```

### Field Mapping Heuristics

The field mapping needs intelligent matching beyond exact name match:

1. **Exact match:** `content` -> `content`
2. **Common patterns:**
   - `content`, `text`, `data` -> `json`, `input`, `body`
   - `result`, `output` -> `input`, `data`
   - `path`, `file` -> `path`, `file_path`
3. **Type-based:** If types match and names are semantically similar

### Project Structure Notes

**Files to Create:**

- `src/graphrag/provides-edge-calculator.ts` (~100-150 LOC)

**Files to Modify:**

- `src/graphrag/algorithms/edge-weights.ts` (~10 LOC) - Add provides, remove alternative
- `src/graphrag/types.ts` (~30 LOC) - Add ProvidesEdge, FieldMapping interfaces

**Test Files:**

- `tests/unit/graphrag/provides_edge_calculator_test.ts` - New test file

### References

**Source Files:**

- [src/graphrag/algorithms/edge-weights.ts](../../src/graphrag/algorithms/edge-weights.ts) -
  EdgeType definitions
- [src/graphrag/types.ts](../../src/graphrag/types.ts) - Graph type definitions
- [src/capabilities/static-structure-builder.ts:841-881](../../src/capabilities/static-structure-builder.ts) -
  computeCoverage reference implementation
- [src/capabilities/types.ts:364](../../src/capabilities/types.ts) - ProvidesCoverage type already
  defined

**Epic & Specs:**

- [epic-10-dag-capability-learning-unified-apis.md](../epics/epic-10-dag-capability-learning-unified-apis.md#story-103)
- [tech-spec-dag-capability-learning.md](../tech-specs/tech-spec-dag-capability-learning.md)

**ADRs:**

- ADR-041: Hierarchical Trace Tracking
- ADR-050: Edge Types (informs removal of `alternative`)

---

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

N/A - No debug issues encountered.

### Completion Notes List

- **Task 1:** Updated EdgeType in `edge-weights.ts` - Added `provides: 0.7`, removed `alternative`
  from weights. Updated JSDoc. Also updated related types in `graph-store.ts`,
  `capabilities/types.ts`, `hypergraph-builder.ts`, `capabilities.ts` handler,
  `spectral-clustering-config.ts`, and `capability-store.ts`.
- **Task 2:** Defined `ProvidesEdge`, `FieldMapping`, and `JSONSchema` interfaces in
  `src/graphrag/types.ts`. Re-exported `ProvidesCoverage` from `capabilities/types.ts`.
- **Task 3:** Created `provides-edge-calculator.ts` with `computeCoverage()`,
  `areTypesCompatible()`, `createFieldMapping()`, and `createProvidesEdges()` functions. ~350 LOC
  including semantic field matching via aliases.
- **Task 4:** Added `getEdgesByType()` method to `GraphStore`. Verified `edge_type TEXT` column
  accepts any value (no migration needed).
- **Task 5:** Created 31 unit tests covering all functions and edge cases. Also updated 4 existing
  tests that used deprecated `alternative` edge type.
- **Task 6:** Added DB persistence for scalability (AC10). Implemented `persistProvidesEdges()`,
  `syncProvidesEdgesForTool()`, `syncAllProvidesEdges()`. Modified `getToolProvidesEdges()` and
  `findDirectProvidesEdge()` to query DB directly for O(1) lookups. Added
  `getToolProvidesEdgesFull()` for complete data with schema join. Coverage stored in
  `confidence_score` column (strict=1.0, partial=0.7, optional=0.4). Added 6 integration tests.

### Change Log

- 2025-12-18: Story context created by BMM create-story workflow
- 2025-12-18: Implementation complete - 31 new tests passing, 78 total tests in affected files
- 2025-12-18: Added AC10 + Task 6 for DB persistence (scalability optimization). 37 tests now
  passing.

### File List

- [x] `src/graphrag/algorithms/edge-weights.ts` - MODIFY (add provides: 0.7, remove alternative from
      EdgeType)
- [x] `src/graphrag/types.ts` - MODIFY (add ProvidesEdge, FieldMapping, JSONSchema interfaces)
- [x] `src/graphrag/provides-edge-calculator.ts` - NEW (~350 LOC with semantic matching)
- [x] `src/graphrag/mod.ts` - MODIFY (export new calculator and types)
- [x] `src/graphrag/core/graph-store.ts` - MODIFY (add provides to EdgeAttributes, add
      getEdgesByType())
- [x] `src/capabilities/types.ts` - MODIFY (add provides to CapabilityEdgeType)
- [x] `src/capabilities/capability-store.ts` - MODIFY (add provides to EDGE_TYPE_WEIGHTS)
- [x] `src/capabilities/hypergraph-builder.ts` - MODIFY (add provides to edge type validation)
- [x] `src/mcp/routing/handlers/capabilities.ts` - MODIFY (add provides to validEdgeTypes)
- [x] `src/graphrag/spectral-clustering-config.ts` - MODIFY (add provides to SpectralEdgeWeights)
- [x] `config/spectral-clustering.schema.json` - MODIFY (add provides to JSON schema)
- [x] `tests/unit/graphrag/provides_edge_calculator_test.ts` - NEW (31 tests)
- [x] `tests/unit/graphrag/algorithms/edge_weights_test.ts` - MODIFY (update tests for provides)
- [x] `tests/unit/graphrag/dag/execution_learning_test.ts` - MODIFY (update tests for provides)
