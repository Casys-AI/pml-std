# Phase 3.2: DI Container Expansion (P1 - Critical)

**Parent:** [index.md](./index.md)
**Priority:** P1 - Critical
**Effort:** Medium (3-5 days)
**Depends On:** Phase 2.1 (DI Container basics), Phase 3.1 (Use Cases pattern)

---

## Objective

Expand DI container usage from 6 registered services to 20+ core services, eliminating direct `new` instantiation in handlers.

---

## Current State

### Container Registration (6 services)

```typescript
// src/infrastructure/di/container.ts
container.register(DbClient).use(DbClientImpl);
container.register(EventBus).use(EventBusImpl);
container.register(Logger).use(LoggerImpl);
// ... 3 more
```

### Direct Instantiation (Problem)

```typescript
// src/mcp/handlers/execute-handler.ts - ANTI-PATTERN
const builder = new StaticStructureBuilder(deps.db);
const executor = new ControlledExecutor(deps);
const shgat = new SHGAT(deps.graphEngine, deps.db);
```

---

## Target State

### Services to Register

| Service | Interface | Implementation | Priority |
|---------|-----------|----------------|----------|
| `ICodeAnalyzer` | `domain/interfaces` | `StaticStructureBuilder` | **P1** |
| `ICodeExecutor` | `domain/interfaces` | `DenoSandboxExecutor` | **P1** |
| `IDAGExecutor` | `domain/interfaces` | `ControlledExecutor` | **P1** |
| `IDAGSuggester` | `domain/interfaces` | `DAGSuggester` | **P1** |
| `IGraphEngine` | `domain/interfaces` | `GraphRAGEngine` | **P1** |
| `ISHGATTrainer` | `domain/interfaces` | `SHGAT` | **P1** |
| `ICapabilityRepository` | `domain/interfaces` | `CapabilityStore` | **P1** |
| `IWorkflowRepository` | `domain/interfaces` | `WorkflowRepository` | **P1** |
| `ICheckpointManager` | `domain/interfaces` | `CheckpointManager` | **P2** |
| `IWorkerBridge` | `domain/interfaces` | `WorkerBridge` | **P2** |
| `IPermissionMapper` | `domain/interfaces` | `PermissionMapper` | **P2** |
| `IDRDSPAlgorithm` | `domain/interfaces` | `DRDSP` | **P2** |
| `ISpectralClustering` | `domain/interfaces` | `SpectralClustering` | **P2** |
| `IToolMapper` | `domain/interfaces` | `ToolMapper` | **P2** |
| `ITraceCollector` | `domain/interfaces` | `TraceCollector` | **P3** |
| `IMCPClientRegistry` | `domain/interfaces` | `MCPClientRegistry` | **P3** |

---

## Container Configuration

### New Container Setup

```typescript
// src/infrastructure/di/container.ts

import { Container, Injectable } from "diod";

// Create container builder
const builder = new ContainerBuilder();

// === Infrastructure Layer ===
builder.registerAndUse(DbClientImpl).asSingleton();
builder.registerAndUse(EventBusImpl).asSingleton();
builder.registerAndUse(LoggerImpl).asSingleton();

// === Domain Interfaces → Infrastructure Adapters ===
builder.register(ICodeAnalyzer).use(StaticStructureBuilderAdapter).asSingleton();
builder.register(ICodeExecutor).use(SandboxExecutorAdapter).asSingleton();
builder.register(IDAGExecutor).use(ControlledExecutorAdapter).asSingleton();
builder.register(IDAGSuggester).use(DAGSuggesterAdapter).asSingleton();
builder.register(IGraphEngine).use(GraphRAGEngineAdapter).asSingleton();
builder.register(ISHGATTrainer).use(SHGATAdapter).asSingleton();

// === Repositories ===
builder.register(ICapabilityRepository).use(CapabilityRepositoryImpl).asSingleton();
builder.register(IWorkflowRepository).use(WorkflowRepositoryImpl).asSingleton();

// === Application Use Cases ===
builder.registerAndUse(ExecuteDirectUseCase);
builder.registerAndUse(ExecuteSuggestionUseCase);
builder.registerAndUse(ContinueWorkflowUseCase);
builder.registerAndUse(TrainSHGATUseCase);

// Build container
export const container = builder.build();
```

---

## Adapter Pattern

Each infrastructure class needs an adapter implementing the domain interface:

```typescript
// src/infrastructure/di/adapters/static-structure-builder.adapter.ts

import type { ICodeAnalyzer } from "@/domain/interfaces/code-analyzer.ts";
import { StaticStructureBuilder } from "@/capabilities/static-structure-builder.ts";

@Injectable()
export class StaticStructureBuilderAdapter implements ICodeAnalyzer {
  private builder: StaticStructureBuilder;

  constructor(db: DbClient) {
    this.builder = new StaticStructureBuilder(db);
  }

  async analyze(code: string): Promise<StaticStructure> {
    return this.builder.buildStaticStructure(code);
  }

  async extractDependencies(code: string): Promise<Dependency[]> {
    const structure = await this.builder.buildStaticStructure(code);
    return structure.dependencies;
  }
}
```

```typescript
// src/infrastructure/di/adapters/sandbox-executor.adapter.ts

import type { ICodeExecutor } from "@/domain/interfaces/code-executor.ts";
import { DenoSandboxExecutor } from "@/sandbox/executor.ts";

@Injectable()
export class SandboxExecutorAdapter implements ICodeExecutor {
  private executor: DenoSandboxExecutor;

  constructor(config: SandboxConfig) {
    this.executor = new DenoSandboxExecutor(config);
  }

  async execute(code: string, context: ExecutionContext): Promise<ExecutionResult> {
    return this.executor.executeWithTools(code, {
      toolDefinitions: context.toolDefinitions,
      mcpClients: context.mcpClients,
    }, context.variables);
  }
}
```

---

## Handler Refactoring

### Before (Anti-pattern)

```typescript
// src/mcp/handlers/execute-handler.ts
export async function handleExecute(deps: ExecuteDependencies, request: ExecuteRequest) {
  // Direct instantiation - BAD
  const builder = new StaticStructureBuilder(deps.db);
  const executor = new ControlledExecutor({
    db: deps.db,
    eventBus: deps.eventBus,
    // ... 10 more dependencies
  });

  // Use them
  const structure = await builder.buildStaticStructure(request.code);
  const result = await executor.execute(dag);
}
```

### After (DI Pattern)

```typescript
// src/mcp/handlers/execute-handler.ts
import { container } from "@/infrastructure/di/container.ts";

export async function handleExecute(request: ExecuteRequest) {
  // Get from container - GOOD
  const executeUseCase = container.get(ExecuteDirectUseCase);

  // Use case handles everything
  return executeUseCase.execute({
    code: request.code,
    intent: request.intent,
  });
}
```

---

## Interface Definitions

### Core Interfaces to Create

```typescript
// src/domain/interfaces/code-analyzer.ts
export interface ICodeAnalyzer {
  analyze(code: string): Promise<StaticStructure>;
  extractDependencies(code: string): Promise<Dependency[]>;
  extractToolCalls(code: string): Promise<ToolCall[]>;
}

// src/domain/interfaces/code-executor.ts
export interface ICodeExecutor {
  execute(code: string, context: ExecutionContext): Promise<ExecutionResult>;
  executeWithTracing(code: string, context: ExecutionContext): Promise<ExecutionResultWithTraces>;
}

// src/domain/interfaces/dag-executor.ts
export interface IDAGExecutor {
  execute(dag: DAGDefinition, context: ExecutionContext): Promise<DAGResult>;
  pause(executionId: string): Promise<void>;
  resume(executionId: string): Promise<DAGResult>;
}

// src/domain/interfaces/dag-suggester.ts
export interface IDAGSuggester {
  suggest(intent: string, tools: ToolDefinition[]): Promise<DAGSuggestion>;
  refine(suggestion: DAGSuggestion, feedback: Feedback): Promise<DAGSuggestion>;
}

// src/domain/interfaces/graph-engine.ts
export interface IGraphEngine {
  sync(): Promise<void>;
  query(query: GraphQuery): Promise<GraphResult>;
  updateFromExecution(traces: TraceEvent[]): Promise<void>;
}

// src/domain/interfaces/shgat-trainer.ts
export interface ISHGATTrainer {
  train(traces: TraceEvent[]): Promise<void>;
  predict(context: PredictionContext): Promise<Prediction[]>;
  shouldTrain(): boolean;
}

// src/domain/interfaces/capability-repository.ts
export interface ICapabilityRepository {
  save(capability: Capability): Promise<string>;
  findById(id: string): Promise<Capability | null>;
  findByIntent(intent: string): Promise<Capability[]>;
  search(query: string, limit?: number): Promise<Capability[]>;
}

// src/domain/interfaces/workflow-repository.ts
export interface IWorkflowRepository {
  save(workflow: WorkflowState): Promise<string>;
  get(id: string): Promise<WorkflowState | null>;
  update(id: string, state: Partial<WorkflowState>): Promise<void>;
  listActive(): Promise<WorkflowState[]>;
}
```

---

## Migration Steps

### Step 1: Create Missing Interfaces (Day 1)
- [ ] Create `ICodeAnalyzer`
- [ ] Create `IDAGExecutor`
- [ ] Create `IDAGSuggester`
- [ ] Create `ISHGATTrainer`
- [ ] Create `IWorkflowRepository`

### Step 2: Create Adapters (Day 2)
- [ ] Create `StaticStructureBuilderAdapter`
- [ ] Create `ControlledExecutorAdapter`
- [ ] Create `DAGSuggesterAdapter`
- [ ] Create `SHGATAdapter`
- [ ] Create `WorkflowRepositoryImpl`

### Step 3: Update Container (Day 3)
- [ ] Register all adapters in container
- [ ] Register all use cases
- [ ] Add factory methods for complex dependencies

### Step 4: Refactor Handlers (Day 4-5)
- [ ] Update `execute-handler.ts` to use container
- [ ] Update `tool-handler.ts` to use container
- [ ] Update `capability-handler.ts` to use container
- [ ] Update `graph-handler.ts` to use container

### Step 5: Cleanup (Day 5)
- [ ] Remove `ExecuteDependencies` interface (replaced by DI)
- [ ] Remove manual dependency passing
- [ ] Update tests

---

## Acceptance Criteria

- [ ] 20+ services registered in DI container
- [ ] No `new` for registered services in handlers
- [ ] All handlers use `container.get()` for dependencies
- [ ] Each interface has adapter implementation
- [ ] All existing tests pass
- [ ] Container startup validation passes

---

## Benefits

| Metric | Before | After |
|--------|--------|-------|
| Direct `new` in handlers | ~15 | 0 |
| Constructor params in handlers | 10-15 | 0-2 |
| Testability | Mock everything manually | Inject mocks via DI |
| Coupling | High (concrete types) | Low (interfaces) |
| Service initialization | Scattered | Centralized |
