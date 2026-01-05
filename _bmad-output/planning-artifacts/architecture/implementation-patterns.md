# Implementation Patterns

## Naming Conventions

**Files & Directories:**

- Files: `kebab-case.ts` (e.g., `vector-search.ts`)
- Directories: `kebab-case/` (e.g., `mcp/`, `dag/`)
- Test files: `*_test.ts` or `*.test.ts` (co-located with source)
- Benchmark files: `*.bench.ts`

**Code Identifiers:**

- Classes: `PascalCase` (e.g., `VectorSearchEngine`)
- Interfaces/Types: `PascalCase` (e.g., `ToolSchema`, `ExecutionMode`)
- Functions: `camelCase` (e.g., `buildDependencyGraph`)
- Constants: `UPPER_SNAKE_CASE` (e.g., `MAX_RETRIES`, `DEFAULT_TIMEOUT`)
- Enums: `PascalCase` name, `PascalCase` values (e.g., `EdgeType.Sequence`)
- Private fields: `_camelCase` with underscore prefix (e.g., `_internalState`)

**Events & API:**

- Event types: `dot.notation` (e.g., `tool.start`, `dag.completed`, `graph.edge.created`)
- Event/API payload fields: `camelCase` (e.g., `toolId`, `executionTimeMs`, `traceId`)
- Event sources: `kebab-case` (e.g., `worker-bridge`, `dag-executor`)

**Database:**

- Tables: `snake_case` singular (e.g., `tool_schema`, `embedding`)
- Columns: `snake_case` (e.g., `tool_id`, `created_at`)
- Indexes: `idx_{table}_{column}` (e.g., `idx_embedding_vector`)

**Conversion Rules:**

When data crosses boundaries:

- **DB → TypeScript**: Convert `snake_case` to `camelCase` (e.g., `tool_id` → `toolId`)
- **TypeScript → DB**: Convert `camelCase` to `snake_case` (e.g., `toolId` → `tool_id`)
- **TypeScript → JSON API**: Keep `camelCase` (no conversion needed)

## Code Organization

**Dependency Pattern:**

```typescript
// deps.ts - ALL external dependencies centralized
export { PGlite } from "npm:@electric-sql/pglite@0.3.11";
export { vector } from "npm:@electric-sql/pglite@0.3.11/vector";
export { Command } from "https://deno.land/x/cliffy@v1.0.0-rc.4/command/mod.ts";
export * as log from "https://deno.land/std@0.224.0/log/mod.ts";
// ... all deps here

// Usage in modules
import { PGlite, vector } from "../../deps.ts";
```

**Module Exports:**

```typescript
// mod.ts - Public API (re-exports)
export { VectorSearch } from "./src/vector/search.ts";
export { MCPGateway } from "./src/mcp/gateway.ts";
export type { Config, ToolSchema } from "./src/types.ts";
```

**Test Organization:**

- Unit tests: Co-located with source (`src/vector/search.test.ts`)
- Integration: `tests/integration/vector-db.test.ts`
- E2E: `tests/e2e/migration-workflow.test.ts`

## Error Handling

**Custom Error Hierarchy:**

```typescript
// src/utils/errors.ts
export class CaiError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = "CaiError";
  }
}

export class MCPServerError extends CaiError {
  constructor(message: string, public serverId: string) {
    super(message, "MCP_SERVER_ERROR");
  }
}

export class VectorSearchError extends CaiError {
  constructor(message: string) {
    super(message, "VECTOR_SEARCH_ERROR");
  }
}

export class DAGExecutionError extends CaiError {
  constructor(message: string, public toolId?: string) {
    super(message, "DAG_EXECUTION_ERROR");
  }
}
```

**Error Handling Pattern:**

```typescript
// All async operations wrapped in try-catch
async function executeWorkflow(tools: Tool[]): Promise<Result> {
  try {
    const dag = buildDAG(tools);
    const results = await executeDag(dag);
    return { success: true, data: results };
  } catch (error) {
    if (error instanceof DAGExecutionError) {
      logger.error(`DAG execution failed: ${error.message}`, { toolId: error.toolId });
      return { success: false, error: error.message, code: error.code };
    }
    throw error; // Re-throw unknown errors
  }
}

// Timeouts enforced (Story 2.6 AC)
const DEFAULT_TIMEOUT = 30_000; // 30s per tool
```

## Logging Strategy

**Log Levels:**

```typescript
// src/telemetry/logger.ts
import * as log from "std/log";

export const logger = log.getLogger();

// Usage:
logger.error("Critical failure", { context: {...} });
logger.warn("Degraded performance detected");
logger.info("Workflow completed", { duration: 4200 });
logger.debug("Vector search query", { query, results });
```

**Structured Format:**

```json
{
  "timestamp": "2025-11-03T10:30:45.123Z",
  "level": "INFO",
  "message": "Workflow completed",
  "context": {
    "duration_ms": 4200,
    "tools_executed": 5,
    "parallel_branches": 2
  }
}
```

**Log Destinations:**

- Console: INFO level (colorized for terminal)
- File: `~/.pml/logs/pml.log` (all levels, rotated daily)

## Cross-Cutting Patterns

**Date/Time Handling:**

- All timestamps: ISO 8601 format (`2025-11-03T10:30:45.123Z`)
- Library: Native `Date` object, no moment.js
- Storage: PostgreSQL `TIMESTAMPTZ` type

**Async Patterns:**

- All I/O operations: `async/await` (no callbacks)
- Parallel operations: `Promise.all()` for independent tasks
- Sequential: `for...of` with `await` for dependent tasks

**Configuration Access:**

```typescript
// Single source of truth
const config = await loadConfig("~/.pml/config.yaml");
// Pass explicitly, no global state
```

**Retries:**

```typescript
// src/utils/retry.ts
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  delayMs = 1000,
): Promise<T> {
  // Exponential backoff: 1s, 2s, 4s
}
```

---
