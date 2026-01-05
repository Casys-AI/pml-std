# Quick Wins - Start Immediately

**Parent:** [index.md](./index.md)
**Timeline:** Can start in parallel, complete in 2 weeks

---

## Overview

| QW | Name | Duration | Impact | Can Parallel |
|----|------|----------|--------|--------------|
| QW-1 | Split `capabilities/types.ts` | 2-3 days | Reduce git conflicts | Yes |
| QW-2 | Extract speculation logic | 3-4 days | -200 LOC from executor | Yes |
| QW-3 | Create service interfaces | 1 week | Foundation for DI | Yes |
| QW-4 | Migrate to Hono | 3-4 days | -170 LOC routing | Yes |
| QW-5 | Architecture Tests | 2-3 days | Protect all refactoring | Yes |

---

## QW-1: Split `capabilities/types.ts` (2-3 days)

**Current:** 1,237 lines, 85+ types in single file
**Target:** 6 domain-specific files, max 300 lines each

### Target Structure

```
src/capabilities/types/
├── capability.ts         # ~150 lines
│   ├── Capability
│   ├── SaveCapabilityInput
│   ├── CapabilityMatch
│   └── CapabilityFilters
│
├── execution.ts          # ~200 lines
│   ├── ExecutionTrace
│   ├── TraceTaskResult
│   └── ExecutionResult
│
├── permission.ts         # ~180 lines
│   ├── PermissionSet
│   ├── PermissionConfig
│   └── PermissionEscalationRequest
│
├── static-analysis.ts    # ~250 lines
│   ├── StaticStructure
│   ├── StaticStructureNode
│   └── ArgumentsStructure
│
├── graph.ts              # ~180 lines
│   ├── GraphNode
│   ├── GraphEdge
│   └── HypergraphOptions
│
├── schema.ts             # ~150 lines
│   ├── JSONSchema
│   └── SchemaProperty
│
└── mod.ts                # Re-exports all types
```

### Migration Steps

1. Create new type files with domain grouping
2. Move types to appropriate files
3. Update imports in all consuming files
4. Delete old `types.ts`
5. Run type check: `deno check src/**/*.ts`

### Acceptance Criteria

- [ ] No type file > 300 lines
- [ ] Zero duplicate type definitions
- [ ] All files type-check successfully
- [ ] All imports updated

---

## QW-2: Extract `controlled-executor` speculation logic (3-4 days)

**Current:** Speculation logic inline in `controlled-executor.ts`
**Target:** Move to `dag/speculation/executor-integration.ts`

### What to Extract

```typescript
// Lines 400-700 in controlled-executor.ts
// Move to: src/dag/speculation/executor-integration.ts

export class SpeculationExecutorIntegration {
  constructor(
    private speculation: SpeculationEngine,
    private executor: IDAGExecutor
  ) {}

  async handleSpeculativeExecution(task: Task): Promise<TaskResult> {
    // Move speculation handling logic here
  }

  async consumeSpeculation(taskId: string): Promise<SpeculationResult | null> {
    // Move speculation consumption logic here
  }
}
```

### Acceptance Criteria

- [ ] Speculation logic moved to dedicated module
- [ ] `controlled-executor.ts` reduced by ~200 lines
- [ ] Existing tests pass
- [ ] No duplicate logic

---

## QW-3: Create service interfaces (1 week)

**Purpose:** Foundation for diod DI container

### Interfaces to Create

```
src/domain/interfaces/
├── capability-repository.ts
├── dag-executor.ts
├── graph-engine.ts
├── mcp-client-registry.ts
└── mod.ts
```

### Example Interface

```typescript
// src/domain/interfaces/capability-repository.ts
import type { Capability, CapabilityMatch } from "@/types/capability";

export interface ICapabilityRepository {
  save(capability: Capability): Promise<void>;
  findById(id: string): Promise<Capability | null>;
  findByIntent(intent: string): Promise<CapabilityMatch[]>;
  updateUsage(id: string, success: boolean): Promise<void>;
  delete(id: string): Promise<void>;
}
```

```typescript
// src/domain/interfaces/dag-executor.ts
import type { DAGStructure, DAGExecutionResult } from "@/types/workflow";

export interface IDAGExecutor {
  execute(dag: DAGStructure, context?: ExecutionContext): Promise<DAGExecutionResult>;
  resume(workflowId: string): Promise<DAGExecutionResult>;
  abort(workflowId: string): Promise<void>;
}
```

### Acceptance Criteria

- [ ] Top 5 services have interfaces
- [ ] Interfaces in `src/domain/interfaces/`
- [ ] No implementation details in interfaces
- [ ] Ready for diod registration

---

## QW-4: Migrate HTTP routing to Hono (3-4 days)

**Library:** [Hono](https://hono.dev) - `jsr:@hono/hono@^4`

### Install

```json
// deno.json - add to imports
"hono": "jsr:@hono/hono@^4",
"hono/": "jsr:@hono/hono@^4/"
```

### Current vs Target

**Current:** ~220 lines across `router.ts` + `dispatcher.ts`

**Target:** ~50 lines with Hono

```typescript
// src/mcp/server/app.ts - NEW
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

export function createApp(container: Container) {
  const app = new Hono();

  // Middleware
  app.use("*", logger());
  app.use("*", cors({ origin: getAllowedOrigins() }));

  // Health (public)
  app.get("/health", (c) => c.json({ status: "ok", timestamp: Date.now() }));

  // API routes
  app.route("/api/graph", createGraphRoutes(container));
  app.route("/api/capabilities", createCapabilityRoutes(container));
  app.route("/api/metrics", createMetricsRoutes(container));

  // MCP JSON-RPC
  app.post("/mcp", async (c) => {
    const body = await c.req.json();
    const result = await handleMcpJsonRpc(body, container);
    return c.json(result);
  });

  // SSE events stream
  app.get("/events/stream", (c) => {
    return streamSSE(c, async (stream) => {
      const eventBus = container.get(EventBus);
      eventBus.subscribe((event) => stream.writeSSE({ data: JSON.stringify(event) }));
    });
  });

  return app;
}
```

### Files to Delete After Migration

- `src/mcp/routing/router.ts`
- `src/mcp/routing/dispatcher.ts`
- `src/mcp/routing/middleware.ts`

### Acceptance Criteria

- [ ] All existing API routes migrated to Hono
- [ ] CORS, auth, rate-limit middleware working
- [ ] Old router files deleted
- [ ] Integration tests passing
- [ ] OpenAPI spec generated for `/api/*` routes

---

## QW-5: Architecture Tests Guard Rails (2-3 days)

**Purpose:** Protect refactoring work from regressions

### Create Test Files

```
tests/architecture/
├── file-size.test.ts
├── circular-deps.test.ts
├── layers.test.ts
└── interfaces.test.ts
```

### Test 1: File Size Limits

```typescript
// tests/architecture/file-size.test.ts
import { assertEquals } from "@std/assert";
import { walk } from "@std/fs";

const MAX_FILE_LINES = 600;
const MAX_TYPE_FILE_LINES = 300;

Deno.test("Architecture: No source file exceeds 600 lines", async () => {
  const violations: string[] = [];

  for await (const entry of walk("src", { exts: [".ts"], skip: [/test\.ts$/] })) {
    const content = await Deno.readTextFile(entry.path);
    const lines = content.split("\n").length;
    if (lines > MAX_FILE_LINES) {
      violations.push(`${entry.path} (${lines} lines)`);
    }
  }

  assertEquals(violations, [], `Files exceeding ${MAX_FILE_LINES} lines:\n${violations.join("\n")}`);
});

Deno.test("Architecture: No type file exceeds 300 lines", async () => {
  const violations: string[] = [];

  for await (const entry of walk("src", { match: [/types\.ts$/] })) {
    const content = await Deno.readTextFile(entry.path);
    const lines = content.split("\n").length;
    if (lines > MAX_TYPE_FILE_LINES) {
      violations.push(`${entry.path} (${lines} lines)`);
    }
  }

  assertEquals(violations, [], `Type files exceeding ${MAX_TYPE_FILE_LINES} lines:\n${violations.join("\n")}`);
});
```

### Test 2: Circular Dependencies

```typescript
// tests/architecture/circular-deps.test.ts
import { assertEquals } from "@std/assert";

Deno.test("Architecture: No circular dependencies", async () => {
  const cmd = new Deno.Command("deno", {
    args: ["info", "--json", "src/main.ts"],
    stdout: "piped",
  });

  const { stdout } = await cmd.output();
  const info = JSON.parse(new TextDecoder().decode(stdout));
  const cycles = findCycles(info.modules);

  assertEquals(cycles, [], `Circular dependencies detected:\n${cycles.join("\n")}`);
});

function findCycles(modules: Array<{ specifier: string; dependencies?: Array<{ specifier: string }> }>): string[] {
  const graph = new Map<string, string[]>();
  for (const mod of modules) {
    const deps = mod.dependencies?.map(d => d.specifier) ?? [];
    graph.set(mod.specifier, deps);
  }

  const cycles: string[] = [];
  const visited = new Set<string>();
  const stack = new Set<string>();

  function dfs(node: string, path: string[]): void {
    if (stack.has(node)) {
      const cycleStart = path.indexOf(node);
      cycles.push(path.slice(cycleStart).join(" → ") + " → " + node);
      return;
    }
    if (visited.has(node)) return;

    visited.add(node);
    stack.add(node);

    for (const dep of graph.get(node) ?? []) {
      if (dep.startsWith("file://") && dep.includes("/src/")) {
        dfs(dep, [...path, node]);
      }
    }

    stack.delete(node);
  }

  for (const mod of graph.keys()) {
    if (mod.startsWith("file://") && mod.includes("/src/")) {
      dfs(mod, []);
    }
  }

  return cycles;
}
```

### Test 3: Layer Dependencies

```typescript
// tests/architecture/layers.test.ts
import { assertEquals } from "@std/assert";
import { walk } from "@std/fs";

const LAYER_ORDER = ["domain", "application", "infrastructure", "mcp", "web"];

Deno.test("Architecture: No upward layer dependencies", async () => {
  const violations: string[] = [];

  for await (const entry of walk("src", { exts: [".ts"] })) {
    const content = await Deno.readTextFile(entry.path);
    const fileLayer = getLayer(entry.path);
    if (!fileLayer) continue;

    const imports = content.matchAll(/from\s+["']([^"']+)["']/g);
    for (const [, importPath] of imports) {
      const importLayer = getLayer(importPath);
      if (importLayer && isUpwardDependency(fileLayer, importLayer)) {
        violations.push(`${entry.path}: imports from ${importPath} (${fileLayer} → ${importLayer})`);
      }
    }
  }

  assertEquals(violations, [], `Layer violations:\n${violations.join("\n")}`);
});

function getLayer(path: string): string | null {
  for (const layer of LAYER_ORDER) {
    if (path.includes(`/${layer}/`) || path.includes(`src/${layer}`)) {
      return layer;
    }
  }
  return null;
}

function isUpwardDependency(from: string, to: string): boolean {
  const fromIndex = LAYER_ORDER.indexOf(from);
  const toIndex = LAYER_ORDER.indexOf(to);
  return fromIndex < toIndex;
}
```

### Test 4: Interface Implementations

```typescript
// tests/architecture/interfaces.test.ts
import { assertEquals } from "@std/assert";
import { walk } from "@std/fs";

Deno.test("Architecture: Services in domain/interfaces have implementations", async () => {
  const interfaces: string[] = [];
  const implementations: string[] = [];

  for await (const entry of walk("src/domain/interfaces", { exts: [".ts"] })) {
    const content = await Deno.readTextFile(entry.path);
    const matches = content.matchAll(/export interface (I\w+)/g);
    for (const [, name] of matches) {
      interfaces.push(name);
    }
  }

  for await (const entry of walk("src", { exts: [".ts"], skip: [/test\.ts$/, /\.d\.ts$/] })) {
    const content = await Deno.readTextFile(entry.path);
    const matches = content.matchAll(/class \w+ implements (I\w+)/g);
    for (const [, name] of matches) {
      implementations.push(name);
    }
  }

  const missing = interfaces.filter(i => !implementations.includes(i));
  assertEquals(missing, [], `Interfaces without implementations:\n${missing.join("\n")}`);
});
```

### Add to deno.json

```json
{
  "tasks": {
    "test:arch": "deno test --allow-read --allow-run tests/architecture/",
    "test:all": "deno task test && deno task test:arch"
  }
}
```

### Acceptance Criteria

- [ ] 4 architecture test files created
- [ ] `deno task test:arch` passes on current codebase
- [ ] CI pipeline runs architecture tests
- [ ] Tests fail on violations (blocking merge)
