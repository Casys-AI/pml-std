# Tech Spec: Inline Literal Parameterization (Story 10.2d)

**Date**: 2025-12-30
**Author**: Claude
**Status**: Implemented

## Problem Statement

When users write capability code with inline literals:

```typescript
mcp.std.psql_query({
  host: "localhost",
  port: 5432,
  database: "casys",
  user: "casys",
  password: "changeme_in_prod",
  query: "SELECT * FROM users"
});
```

The capability is saved with hardcoded values, making it:
1. **Not reusable** - tied to specific database credentials
2. **Not shareable** - credentials leak when shared
3. **Not configurable** - can't adapt to different environments

## Solution

Extend the literal parameterization system to extract inline literals from function call arguments and transform them to `args.xxx` references.

### Before (hardcoded)
```typescript
mcp.std.psql_query({
  host: "localhost",
  port: 5432,
  database: "casys",
  password: "changeme_in_prod"
});
```

### After (parameterized)
```typescript
mcp.std.psql_query({
  host: args.host,
  port: args.port,
  database: args.database,
  password: args.password
});
```

### Generated Schema
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "host": { "type": "string", "examples": ["localhost"] },
    "port": { "type": "integer", "examples": [5432] },
    "database": { "type": "string" },
    "password": { "type": "string" }
  },
  "required": ["host", "port", "database", "password"]
}
```

## Implementation

### 1. Static Structure Builder (`src/capabilities/static-structure-builder.ts`)

Modified `extractArguments()` to track inline literals in `literalBindings`:

```typescript
if (argValue.type === "literal" && argValue.value !== null) {
  // Only track primitive values (not nested objects/arrays)
  const val = argValue.value;
  if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
    this.literalBindings.set(keyName, val);
  }
}
```

### 2. Code Transformer (`src/capabilities/code-transformer.ts`)

Added new interface and function:

```typescript
interface InlineLiteralPosition {
  propertyName: string;
  value: JsonValue;
  start: number;
  end: number;
}

function findInlineLiteralPositions(
  node: any,
  literalBindings: Record<string, JsonValue>,
  results: InlineLiteralPosition[],
): void {
  // Traverse AST looking for KeyValueProperty in ObjectExpression
  // where key matches literalBindings and value is a matching literal
}
```

Modified `transformLiteralsToArgs()` to:
1. Find inline literals via `findInlineLiteralPositions()`
2. Replace inline literal values with `args.propertyName`

### 3. Existing Flow (unchanged)

```
Code Execution
    ↓
StaticStructureBuilder.buildFromCode()
    ↓ literalBindings includes inline literals
CapabilityStore.saveCapability()
    ↓
transformLiteralsToArgs(code, literalBindings)
    ↓ replaces inline literals with args.xxx
Save parameterized code to DB
```

## Data Flow

```
User Code:
  mcp.tool({ host: "localhost", port: 5432 })
       ↓
StaticStructureBuilder:
  literalBindings = { host: "localhost", port: 5432 }
       ↓
transformLiteralsToArgs:
  findInlineLiteralPositions → [{propertyName: "host", start: X, end: Y}, ...]
  replace "localhost" with args.host
  replace 5432 with args.port
       ↓
Saved Code:
  mcp.tool({ host: args.host, port: args.port })
       ↓
Generated Schema:
  { properties: { host: {type: "string"}, port: {type: "integer"} } }
```

## Scope

### Included
- String literals in object properties
- Number literals in object properties
- Boolean literals in object properties

### Excluded (for now)
- Nested object literals (complex types)
- Array literals (would need special handling)
- Computed property names

## Files Changed

| File | Change |
|------|--------|
| `src/capabilities/static-structure-builder.ts` | Added inline literal tracking in `extractArguments()` |
| `src/capabilities/code-transformer.ts` | Added `InlineLiteralPosition`, `findInlineLiteralPositions()`, and inline replacement logic |

## Testing

Existing tests pass. New behavior tested via:
- Manual verification with psql_query
- Integration test with capability save flow

## Backward Compatibility

- Existing capabilities unchanged (already saved)
- New capabilities will be parameterized
- Old literal-binding flow (variable declarations) still works

## Future Enhancements

1. **Nested object support** - Extract and flatten nested properties
2. **Array support** - Parameterize array literals
3. **Sensitive value detection** - Flag password/secret/token properties
4. **Default value preservation** - Keep original values as schema defaults
