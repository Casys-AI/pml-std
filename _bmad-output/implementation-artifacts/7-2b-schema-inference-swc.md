# Story 7.2b: Schema Inference (SWC)

> **Epic:** 7 - Emergent Capabilities & Learning System **ADRs:** ADR-027 (Execute Code Graph
> Learning), ADR-028 (Emergent Capabilities System) **Prerequisites:** Story 7.2a (Capability
> Storage - ✅ DONE, 32 tests passing) **Status:** done

## User Story

As a system exposing capability interfaces, I want to automatically infer parameter schemas from
TypeScript code, So that Claude knows what arguments to pass when calling capabilities.

## Problem Context

### Current State (After Story 7.2a)

The `workflow_pattern.parameters_schema` column exists (Migration 011, line 38-41) but is **always
NULL**:

```sql
-- Migration 011: Added but never populated
ALTER TABLE workflow_pattern
ADD COLUMN IF NOT EXISTS parameters_schema JSONB
```

When `CapabilityStore.saveCapability()` is called (line 68-167), it stores:

- ✅ `code_snippet` - The TypeScript code
- ✅ `code_hash` - SHA-256 for deduplication
- ✅ `intent_embedding` - 1024-dim vector for semantic search
- ✅ `dag_structure.tools_used` - Tools called during execution
- ❌ `parameters_schema` - **NULL** (not inferred)

### Impact

When Claude or the system wants to reuse a learned capability, there's no structured way to know:

1. What arguments the code expects (e.g., `args.filePath`, `args.debug`)
2. What types those arguments should be (string, boolean, object)
3. Which arguments are required vs optional

**Example capability code:**

```typescript
const content = await mcp.filesystem.read({ path: args.filePath });
const parsed = JSON.parse(content);
if (args.debug) console.log(parsed);
return parsed;
```

**Current `parameters_schema`:** `NULL`

**Desired `parameters_schema`:**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "filePath": { "type": "string" },
    "debug": { "type": "boolean" }
  },
  "required": ["filePath"]
}
```

## Solution: SWC-based AST Analysis

### Why SWC over ts-morph?

| Critère          | **SWC** ✅                | ts-morph ❌               |
| ---------------- | ------------------------- | ------------------------- |
| **Deno Support** | Natif `deno.land/x/swc`   | JSR issues #949 #950      |
| **Performance**  | 🚀 20x faster (Rust/WASM) | Slow (TS compiler)        |
| **Tested**       | ✅ Validated in POC       | ⚠️ "Deno not tested well" |
| **Size**         | ~2MB (lz4 compressed)     | ~15MB+                    |
| **Used by**      | Deno, Next.js, Parcel     | Standalone                |

### POC Validation (2025-12-05)

```typescript
import { parse } from "https://deno.land/x/swc@0.2.1/mod.ts";

const code = `
async function run() {
  const content = await mcp.filesystem.read({ path: args.filePath });
  if (args.debug === true) console.log(content);
  const { name, count } = args;
  return args.result;
}`;

const ast = await parse(code, { syntax: "typescript" });
// ✅ Found args properties: ["filePath", "debug", "name", "count", "result"]
```

Create a `SchemaInferrer` class that:

1. Parses TypeScript code using **SWC** (Rust-based, Deno native)
2. Traverses AST to find `args.xxx` accesses and destructuring
3. Infers types from MCP tool schemas (database lookup)
4. Builds JSON Schema directly (no Zod needed)

---

## Acceptance Criteria

### AC1: SchemaInferrer Class Created

- [x] File `src/capabilities/schema-inferrer.ts` created
- [x] Class `SchemaInferrer` exported
- [x] Constructor: `constructor(db: PGliteClient)`
- [x] Import: `https://deno.land/x/swc@0.2.1/mod.ts` (no deno.json change needed)

### AC2: inferSchema Method

- [x] Method `inferSchema(code: string): Promise<JSONSchema>` implemented
- [x] Returns JSON Schema with `type: "object"` and `properties`
- [x] Empty properties `{}` if no `args.xxx` detected
- [x] Graceful error handling (returns empty schema on parse errors)

### AC3: args.xxx Detection via AST

- [x] Detect `MemberExpression` where object is `args` identifier
- [x] Extract property names (e.g., `args.filePath` → `filePath`)
- [x] Handle nested access (e.g., `args.config.timeout` → `config: object`)
- [x] Handle destructuring: `const { filePath } = args` via `ObjectPattern`

### AC4: Type Inference from MCP Schemas

- [x] Query `tool_schema.input_schema` to get tool parameter types
- [x] When `args.xxx` passed to MCP tool, infer type from tool schema
- [x] Example: `fs.read({ path: args.filePath })` → infer `filePath: string`
- [x] Track argument usage across multiple tool calls, use most specific type

### AC5: Type Inference Fallbacks

- [x] Comparison: `args.enabled === true` → `enabled: boolean`
- [x] Comparison: `args.count > 0` → `count: number`
- [x] Property access: `args.items.length` → `items: array`
- [x] String method: `args.name.toLowerCase()` → `name: string`
- [x] Ultimate fallback: `unknown` type

### AC6: JSON Schema Generation

- [x] Build JSON Schema directly from inferred types
- [x] Include `$schema: "http://json-schema.org/draft-07/schema#"`
- [x] Include `type: "object"` and `properties`
- [x] Mark as required if used without optional chaining

### AC7: Integration with CapabilityStore

- [x] `CapabilityStore` constructor accepts optional `SchemaInferrer`
- [x] `saveCapability()` calls `inferSchema(code)` after embedding generation
- [x] Schema stored in database via UPSERT

### AC8: Tests

- [x] Test: `args.filePath` in `fs.read()` → `filePath: string`
- [x] Test: `args.unknown` not mappable → `unknown: unknown`
- [x] Test: destructured args → all properties detected
- [x] Test: nested access → object schema
- [x] Test: comparison operators → correct type inference
- [x] Test: no args → empty properties

---

## Technical Deep Dive

### No deno.json Changes Required

SWC is imported directly from deno.land/x:

```typescript
import { parse } from "https://deno.land/x/swc@0.2.1/mod.ts";
```

### Integration Point: CapabilityStore.saveCapability()

**File:** `src/capabilities/capability-store.ts:68-167`

**Required changes:**

1. **Constructor modification (line 50-56):**

```typescript
constructor(
  private db: PGliteClient,
  private embeddingModel: EmbeddingModel,
  private schemaInferrer?: SchemaInferrer,  // NEW: Optional for backward compat
) {
  logger.debug("CapabilityStore initialized", {
    schemaInferrerEnabled: !!schemaInferrer
  });
}
```

2. **Schema inference after embedding (insert after line 86):**

```typescript
// NEW: Infer parameters schema from code (Story 7.2b)
let parametersSchema: JSONSchema | undefined;
if (this.schemaInferrer) {
  try {
    parametersSchema = await this.schemaInferrer.inferSchema(code);
    logger.debug("Schema inferred for capability", {
      codeHash,
      properties: Object.keys(parametersSchema.properties || {}),
    });
  } catch (error) {
    logger.warn("Schema inference failed, continuing without schema", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
```

### SWC AST Structure

**MemberExpression (args.xxx):**

```json
{
  "type": "MemberExpression",
  "object": { "type": "Identifier", "value": "args" },
  "property": { "type": "Identifier", "value": "filePath" }
}
```

**ObjectPattern destructuring (const { a, b } = args):**

```json
{
  "type": "VariableDeclarator",
  "id": {
    "type": "ObjectPattern",
    "properties": [
      { "key": { "type": "Identifier", "value": "a" } },
      { "key": { "type": "Identifier", "value": "b" } }
    ]
  },
  "init": { "type": "Identifier", "value": "args" }
}
```

### SchemaInferrer Implementation Sketch

```typescript
import { parse } from "https://deno.land/x/swc@0.2.1/mod.ts";
import type { PGliteClient } from "../db/client.ts";
import type { JSONSchema } from "./types.ts";

interface ArgsProperty {
  name: string;
  inferredType: string;
  source: "mcp_tool" | "operation" | "comparison" | "unknown";
}

export class SchemaInferrer {
  constructor(private db: PGliteClient) {}

  async inferSchema(code: string): Promise<JSONSchema> {
    try {
      // Wrap in function if needed for parsing
      const wrappedCode = code.includes("function") ? code : `async function _() { ${code} }`;
      const ast = await parse(wrappedCode, { syntax: "typescript" });

      // Find all args accesses
      const argsProps = this.findArgsAccesses(ast);

      // Infer types for each property
      const properties: Record<string, JSONSchema> = {};
      for (const prop of argsProps) {
        const type = await this.inferType(prop, ast);
        properties[prop.name] = type;
      }

      return {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties,
      };
    } catch (error) {
      // Non-critical: return empty schema
      return { type: "object", properties: {} };
    }
  }

  private findArgsAccesses(node: unknown, props: ArgsProperty[] = []): ArgsProperty[] {
    if (!node || typeof node !== "object") return props;
    const n = node as Record<string, unknown>;

    // MemberExpression: args.xxx
    if (n.type === "MemberExpression") {
      const obj = n.object as Record<string, unknown> | undefined;
      const prop = n.property as Record<string, unknown> | undefined;
      if (
        obj?.type === "Identifier" && obj?.value === "args" &&
        prop?.type === "Identifier" && typeof prop?.value === "string"
      ) {
        props.push({ name: prop.value, inferredType: "unknown", source: "unknown" });
      }
    }

    // ObjectPattern: const { a, b } = args
    if (n.type === "VariableDeclarator") {
      const id = n.id as Record<string, unknown> | undefined;
      const init = n.init as Record<string, unknown> | undefined;
      if (id?.type === "ObjectPattern" && init?.type === "Identifier" && init?.value === "args") {
        const objProps = (id.properties || []) as Array<Record<string, unknown>>;
        for (const p of objProps) {
          const key = p.key as Record<string, unknown> | undefined;
          if (key?.type === "Identifier" && typeof key?.value === "string") {
            props.push({ name: key.value, inferredType: "unknown", source: "unknown" });
          }
        }
      }
    }

    // Recurse
    for (const key of Object.keys(n)) {
      const val = n[key];
      if (Array.isArray(val)) {
        for (const item of val) this.findArgsAccesses(item, props);
      } else if (typeof val === "object" && val !== null) {
        this.findArgsAccesses(val, props);
      }
    }

    return props;
  }

  private async inferType(prop: ArgsProperty, ast: unknown): Promise<JSONSchema> {
    // 1. Try to infer from MCP tool call
    const mcpType = await this.inferFromMCPCall(prop.name, ast);
    if (mcpType) return mcpType;

    // 2. Try to infer from operations
    const opType = this.inferFromOperations(prop.name, ast);
    if (opType) return opType;

    // 3. Fallback
    return { type: "unknown" };
  }

  private async inferFromMCPCall(propName: string, ast: unknown): Promise<JSONSchema | null> {
    // Find CallExpression where args.propName is passed
    // Query tool_schema for parameter type
    // ... implementation
    return null;
  }

  private inferFromOperations(propName: string, ast: unknown): JSONSchema | null {
    // Analyze how the property is used:
    // - .length → array
    // - === true/false → boolean
    // - > / < / + - * / → number
    // - .toLowerCase() → string
    return null;
  }
}
```

### File Structure

```
src/capabilities/
├── capability-store.ts   # MODIFY: Add schemaInferrer to constructor + saveCapability
├── types.ts              # EXISTING: JSONSchema type (sufficient)
├── hash.ts               # EXISTING: hashCode function
├── schema-inferrer.ts    # NEW: SchemaInferrer class (~150 LOC)
└── mod.ts                # MODIFY: Export SchemaInferrer

tests/unit/capabilities/
├── capability_store_test.ts    # EXISTING: 32 tests (patterns to follow)
└── schema_inferrer_test.ts     # NEW: Schema inference tests
```

---

## Execution Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  WorkerBridge.execute() (worker-bridge.ts:113-238)                           │
│       │                                                                      │
│       │ After successful execution (line 183-203):                           │
│       ▼                                                                      │
│  capabilityStore.saveCapability({ code, intent, toolsUsed, ... })           │
└─────────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  CapabilityStore.saveCapability() (capability-store.ts:68-167)               │
│       │                                                                      │
│       ├──► hashCode(code) → codeHash                                         │
│       ├──► embeddingModel.encode(intent) → embedding                         │
│       │                                                                      │
│       └──► 🎯 schemaInferrer.inferSchema(code) → parametersSchema            │
│                    │                                                         │
│                    │   ┌────────────────────────────────────────────────┐   │
│                    └──►│ SchemaInferrer.inferSchema(code)               │   │
│                        │                                                │   │
│                        │ 1. parse(code, { syntax: "typescript" })      │   │
│                        │    └─ SWC WASM (Rust, ~2MB, fast)             │   │
│                        │                                                │   │
│                        │ 2. findArgsAccesses(ast)                      │   │
│                        │    └─ MemberExpression: args.xxx              │   │
│                        │    └─ ObjectPattern: const {a} = args         │   │
│                        │                                                │   │
│                        │ 3. inferType(prop, ast)                       │   │
│                        │    └─ Query tool_schema for MCP params        │   │
│                        │    └─ Analyze operations for type hints       │   │
│                        │                                                │   │
│                        │ 4. Build JSON Schema                          │   │
│                        │    └─ { type: "object", properties: {...} }   │   │
│                        └────────────────────────────────────────────────┘   │
│       │                                                                      │
│       ▼                                                                      │
│  INSERT INTO workflow_pattern (..., parameters_schema)                       │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Key Files Reference

| File                                               | Lines         | Purpose              | Changes                  |
| -------------------------------------------------- | ------------- | -------------------- | ------------------------ |
| `src/capabilities/capability-store.ts`             | 50-56, 68-167 | Core storage class   | Add schemaInferrer param |
| `src/capabilities/types.ts`                        | 13-20         | JSONSchema interface | No changes               |
| `src/capabilities/mod.ts`                          | 1-20          | Module exports       | Add SchemaInferrer       |
| `src/capabilities/schema-inferrer.ts`              | NEW           | Schema inference     | ~150 LOC                 |
| `src/sandbox/worker-bridge.ts`                     | 183-203       | Eager learning       | No changes               |
| `tests/unit/capabilities/capability_store_test.ts` | 1-580         | Test patterns        | Reference                |

---

## Dev Notes

### Critical Implementation Details

1. **SWC Import:** Direct URL import, no deno.json modification needed
2. **Code Wrapping:** Wrap code in function if not already (for valid parsing)
3. **Recursive Traversal:** SWC AST is plain objects, simple recursive walk
4. **Non-Critical:** Schema inference failure should never fail capability save

### Edge Cases

| Pattern                 | AST Node                | Inferred Type       |
| ----------------------- | ----------------------- | ------------------- |
| `args.filePath`         | MemberExpression        | From MCP or unknown |
| `const { a } = args`    | ObjectPattern           | From usage          |
| `args.config.timeout`   | Nested MemberExpression | `config: object`    |
| `args?.field`           | OptionalChaining        | Optional property   |
| `args.enabled === true` | BinaryExpression        | `boolean`           |
| `args.items.length`     | MemberExpression chain  | `items: array`      |

### Performance

- SWC parse: <10ms for typical code
- AST traversal: <1ms
- DB query per unique tool: ~5ms
- Total: <50ms expected

---

## References

- [SWC Deno](https://deno.land/x/swc@0.2.1) - Validated in POC
- [SWC Documentation](https://swc.rs/docs/usage/core)
- Story 7.2a: `docs/stories/7-2a-capability-storage-migration-eager-learning.md`
- ADR-028: `docs/adrs/ADR-028-emergent-capabilities-system.md`

## Estimation

- **Effort:** 2-3 jours (actual: multi-source inference added complexity)
- **LOC:** ~692 net (schema-inferrer.ts) + 395 tests = 1087 total
  - Initial estimate was ~150 LOC but scope expanded with MCP tool inference
  - Multi-source type inference (MCP tools, operations, comparisons) added significant logic
- **Risk:** Low (SWC validated, simple AST traversal)

---

## Dev Agent Record

### Context Reference

- `src/capabilities/capability-store.ts:50-167` - Integration point
- `src/sandbox/worker-bridge.ts:183-203` - Eager learning caller
- `src/db/migrations/011_capability_storage_migration.ts:38-41` - Column definition
- `tests/unit/capabilities/capability_store_test.ts` - Test patterns
- POC: `/home/ubuntu/CascadeProjects/Casys PML/test-swc.ts` - Validated

### File List

- [x] `src/capabilities/schema-inferrer.ts` - NEW (692 LOC)
- [x] `src/capabilities/capability-store.ts` - MODIFY constructor + saveCapability
- [x] `src/capabilities/mod.ts` - MODIFY exports
- [x] `src/capabilities/types.ts` - MODIFY JSONSchema interface ($schema field)
- [x] `tests/unit/capabilities/schema_inferrer_test.ts` - NEW (19 tests, all passing)
- [x] `src/web/posts/2025-12-06-automatic-schema-inference-swc.md` - NEW (blog post FR, 490 LOC)
