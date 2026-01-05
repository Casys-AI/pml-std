# Phase 2.1: Break Circular Dependencies (P0 - Critical)

**Parent:** [index.md](./index.md)
**Priority:** P0 - Critical
**Timeline:** Weeks 1-2
**Depends On:** QW-3 (Create service interfaces)

---

## Objective

Break circular dependencies between `mcp ↔ capabilities ↔ dag ↔ graphrag` by:

1. Extracting shared types to domain layer
2. Defining service interfaces
3. Setting up diod DI container

---

## Step 1: Extract Core Domain Types

**Create:** `src/domain/types/`

```
src/domain/
├── types/
│   ├── capability.ts       # Capability, CapabilityMatch
│   ├── workflow.ts         # DAGStructure, Task, TaskResult
│   ├── execution.ts        # ExecutionTrace, ExecutionResult
│   ├── permission.ts       # PermissionSet, PermissionConfig
│   └── mod.ts              # Re-exports
```

### Migration Steps

1. Identify shared types used across modules
2. Move to `src/domain/types/`
3. Update imports: `import type { Capability } from "@/domain/types/capability.ts"`
4. Remove duplicate definitions

### Acceptance Criteria

- [ ] No type file > 300 lines
- [ ] Zero circular type dependencies
- [ ] All imports use `import type { }` for types

---

## Step 2: Define Service Interfaces

**Create:** `src/domain/interfaces/`

```typescript
// src/domain/interfaces/capability-repository.ts
export interface ICapabilityRepository {
  save(capability: Capability): Promise<void>;
  findById(id: string): Promise<Capability | null>;
  findByIntent(intent: string): Promise<Capability[]>;
  updateUsage(id: string, success: boolean): Promise<void>;
}

// src/domain/interfaces/dag-executor.ts
export interface IDAGExecutor {
  execute(dag: DAGStructure, context?: ExecutionContext): Promise<DAGExecutionResult>;
  resume(workflowId: string): Promise<DAGExecutionResult>;
  abort(workflowId: string): Promise<void>;
}

// src/domain/interfaces/graph-engine.ts
export interface IGraphEngine {
  addToolDependency(from: string, to: string): Promise<void>;
  findRelatedTools(toolId: string, limit?: number): Promise<string[]>;
  suggestWorkflow(intent: string): Promise<DAGSuggestion>;
}

// src/domain/interfaces/mcp-client-registry.ts
export interface IMCPClientRegistry {
  getClient(serverId: string): IMCPClient;
  getAllClients(): IMCPClient[];
  register(serverId: string, client: IMCPClient): void;
}
```

### Benefits

- `mcp/` imports interfaces, not implementations
- Test with mocks easily
- Swap implementations without changing consumers

### Acceptance Criteria

- [ ] Top 5 services have interfaces
- [ ] Gateway server depends only on interfaces
- [ ] Unit tests use mocked interfaces

---

## Step 3: Dependency Injection Setup with diod

**Library:** [diod](https://github.com/artberri/diod) - Mature DI container with dependency graph resolution

### Why diod

- Automatic dependency graph construction and cycle detection at build time
- Singleton/transient/scoped lifetime management
- Service tagging for grouped resolution
- Auto-wiring based on constructor types
- ~2KB, zero dependencies

### Install

```json
// deno.json - add to imports
"diod": "npm:diod@^3.0.0"
```

### Create Container

```typescript
// src/infrastructure/di/container.ts
import { ContainerBuilder } from "diod";
import type { ICapabilityRepository } from "@/domain/interfaces/capability-repository.ts";
import type { IDAGExecutor } from "@/domain/interfaces/dag-executor.ts";
import type { IGraphEngine } from "@/domain/interfaces/graph-engine.ts";
import type { IMCPClientRegistry } from "@/domain/interfaces/mcp-client-registry.ts";

/**
 * Build the DI container with all service registrations.
 *
 * diod validates the dependency graph at build time:
 * - Detects circular dependencies
 * - Ensures all dependencies are registered
 * - Validates lifetime compatibility
 */
export function buildContainer(config: AppConfig) {
  const builder = new ContainerBuilder();

  // Infrastructure layer (singletons)
  builder.register(DbClient).useFactory(() => createDefaultClient(config.dbPath)).asSingleton();
  builder.register(VectorSearch).useFactory((c) => new VectorSearch(c.get(DbClient))).asSingleton();
  builder.register(EmbeddingModel).useFactory(() => createEmbeddingModel(config)).asSingleton();

  // Domain services (singletons)
  builder.registerAndUse(CapabilityStore).asSingleton();
  builder.registerAndUse(GraphRAGEngine).asSingleton();
  builder.registerAndUse(ControlledExecutor).asSingleton();

  // Registries
  builder.registerAndUse(MCPClientRegistry).asSingleton();
  builder.registerAndUse(CapabilityRegistry).asSingleton();

  // Interface bindings (for dependency inversion)
  builder.register(ICapabilityRepository).useFactory((c) => c.get(CapabilityStore));
  builder.register(IDAGExecutor).useFactory((c) => c.get(ControlledExecutor));
  builder.register(IGraphEngine).useFactory((c) => c.get(GraphRAGEngine));
  builder.register(IMCPClientRegistry).useFactory((c) => c.get(MCPClientRegistry));

  // Build validates graph - throws if cycles or missing deps
  return builder.build();
}

// Application bootstrap
export const container = buildContainer(loadConfig());

// Type-safe service access
export function getCapabilityRepository(): ICapabilityRepository {
  return container.get(ICapabilityRepository);
}

export function getDAGExecutor(): IDAGExecutor {
  return container.get(IDAGExecutor);
}
```

### Create Test Container

```typescript
// src/infrastructure/di/testing.ts
import { ContainerBuilder } from "diod";

/**
 * Create a test container with mocked dependencies
 */
export function buildTestContainer(overrides?: Partial<TestOverrides>) {
  const builder = new ContainerBuilder();

  // Use mocks by default
  builder.register(ICapabilityRepository).useInstance(overrides?.capabilityRepo ?? createMockCapabilityRepo());
  builder.register(IDAGExecutor).useInstance(overrides?.dagExecutor ?? createMockDAGExecutor());
  builder.register(IGraphEngine).useInstance(overrides?.graphEngine ?? createMockGraphEngine());

  return builder.build();
}
```

### Acceptance Criteria

- [ ] diod container bootstraps all services
- [ ] Dependency graph validated at startup (no runtime surprises)
- [ ] No direct `new ClassName()` in business logic
- [ ] Test setup uses `buildTestContainer()` with mocks
- [ ] Circular dependencies detected at build time

---

## Deliverables

| Item | Location |
|------|----------|
| Domain types | `src/domain/types/` (5 files) |
| Service interfaces | `src/domain/interfaces/` (4 files) |
| DI container | `src/infrastructure/di/container.ts` |
| Test container | `src/infrastructure/di/testing.ts` |

---

## Risk Mitigation

### Risk: Circular Dependency Uncovered at Runtime

**Mitigation:**
- diod validates at build time (not runtime)
- Audit dependency graph before migration
- Use lazy loading for optional dependencies
- Break cycles with event bus pattern (already exists)
