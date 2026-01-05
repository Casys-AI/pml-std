# Phase 2.7: Deno-Native Patterns (Bonus)

**Parent:** [index.md](./index.md)
**Priority:** Bonus - Ongoing
**Timeline:** Throughout project

---

## Objective

Leverage Deno's built-in features instead of reinventing patterns.

---

## Already Implemented

| Feature | Status | Location |
|---------|--------|----------|
| `deno task test` | ✅ | `deno.json:48-55` |
| `Deno.bench` | ✅ | `tests/benchmarks/` |
| `BroadcastChannel` | ✅ | `src/events/event-bus.ts` |
| `Deno.Kv` | ✅ | `src/cache/kv.ts` |
| `Web Crypto API` | ✅ | `lib/std/crypto.ts` |
| `Import Maps` | ✅ | `deno.json:89-151` |

---

## New Libraries (Phase 2)

Add to `deno.json`:

```json
{
  "imports": {
    "hono": "jsr:@hono/hono@^4",
    "hono/": "jsr:@hono/hono@^4/",
    "diod": "npm:diod@^3.0.0",

    "@/domain/": "./src/domain/",
    "@/application/": "./src/application/",
    "@/infrastructure/": "./src/infrastructure/",

    "@/interfaces/capability": "./src/domain/interfaces/capability-repository.ts",
    "@/interfaces/executor": "./src/domain/interfaces/dag-executor.ts",
    "@/interfaces/graph": "./src/domain/interfaces/graph-engine.ts",
    "@/interfaces/mcp-registry": "./src/domain/interfaces/mcp-client-registry.ts",

    "@/types/capability": "./src/domain/types/capability.ts",
    "@/types/workflow": "./src/domain/types/workflow.ts",
    "@/types/permission": "./src/domain/types/permission.ts"
  }
}
```

| Library | Version | Purpose |
|---------|---------|---------|
| **Hono** | `jsr:@hono/hono@^4` | HTTP routing, middleware, OpenAPI |
| **diod** | `npm:diod@^3.0.0` | DI container with dependency graph |

---

## Import Maps for Architecture Layers

### Benefits

- Clean imports: `import { ICapabilityRepo } from "@/interfaces/capability"`
- Easy refactoring (change path in one place)
- Layer enforcement (can grep for violations)

### Layer Aliases

```json
{
  "@/domain/": "./src/domain/",
  "@/application/": "./src/application/",
  "@/infrastructure/": "./src/infrastructure/"
}
```

### Usage

```typescript
// Clean architecture imports
import type { Capability } from "@/domain/types/capability.ts";
import type { ICapabilityRepository } from "@/domain/interfaces/capability-repository.ts";
import { ExecuteWorkflowUseCase } from "@/application/use-cases/execute-workflow.ts";
import { buildContainer } from "@/infrastructure/di/container.ts";
```

---

## Deno KV for Caching

**Current:** Used for sessions and event signals

**Expand for CQRS read-side:**

```typescript
// src/infrastructure/cache/kv-cache.ts
export class DenoKVCache<T> {
  constructor(private kv: Deno.Kv, private prefix: string) {}

  async get(key: string): Promise<T | null> {
    const result = await this.kv.get<T>([this.prefix, key]);
    return result.value;
  }

  async set(key: string, value: T, ttl?: number): Promise<void> {
    await this.kv.set([this.prefix, key], value, { expireIn: ttl });
  }

  async delete(key: string): Promise<void> {
    await this.kv.delete([this.prefix, key]);
  }

  async compareAndSwap(key: string, oldValue: T, newValue: T): Promise<boolean> {
    const result = await this.kv.atomic()
      .check({ key: [this.prefix, key], versionstamp: null })
      .set([this.prefix, key], newValue)
      .commit();
    return result.ok;
  }
}

// Use cases:
// - Workflow state cache
// - Capability query cache (CQRS read side)
// - Distributed locks for multi-instance deployments
```

---

## Architecture Tests with Deno.test

```typescript
// tests/architecture/rules.test.ts
Deno.test("Architecture Rules", async (t) => {
  await t.step("No circular dependencies", async () => {
    const result = await new Deno.Command("deno", {
      args: ["info", "--json", "src/main.ts"],
    }).output();

    const deps = JSON.parse(new TextDecoder().decode(result.stdout));
    const cycles = findCycles(deps);

    assertEquals(cycles.length, 0, `Circular deps: ${cycles.join(', ')}`);
  });

  await t.step("No upward layer dependencies", () => {
    const violations = checkLayerDependencies();
    assertEquals(violations, [], `Layer violations: ${violations.join(', ')}`);
  });

  await t.step("File size limits", () => {
    const largeFiles = findFilesExceeding(600);
    assertEquals(largeFiles, [], `Large files: ${largeFiles.join(', ')}`);
  });
});
```

---

## Performance Benchmarks

**Current:** 4+ benchmark files in `tests/benchmarks/`

**Add regression tests:**

```typescript
// tests/benchmarks/executor.bench.ts
Deno.bench("DAG Execution - 5 parallel tasks", async () => {
  const executor = new DAGExecutor(mockToolExecutor);
  await executor.execute(createDAGWith5Tasks());
});

Deno.bench("DAG Execution - 10 sequential tasks", async () => {
  const executor = new DAGExecutor(mockToolExecutor);
  await executor.execute(createDAGWith10SequentialTasks());
});
```

**Run with baseline comparison:**

```bash
deno bench --save baseline.json
# After changes
deno bench --compare baseline.json
```

---

## EventBus Decision

**Current:** Custom EventBus with BroadcastChannel

**Recommendation:** Keep custom implementation

**Reasons:**
- Already works well for SSE/dashboard
- BroadcastChannel provides cross-process communication
- EventTarget doesn't support cross-process

---

## To Evaluate (Optional)

| Feature | Status | Notes |
|---------|--------|-------|
| EventBus vs EventTarget | Keep custom | Works with BroadcastChannel |
| Symbol.dispose | Not yet | Wait for Deno stabilization |

---

## Deliverables

- [x] Import maps configured for layers
- [x] Hono added to imports
- [x] diod added to imports
- [ ] Expand Deno KV for CQRS caching
- [ ] Performance baseline created
- [ ] Architecture tests in CI

---

## Success Metrics

| Metric | Current | Target |
|--------|---------|--------|
| Native APIs Used | 6 | 8+ |
| Benchmarks | 4 files | 10+ files |
| Web Standard Compatibility | ~80% | 95% |
