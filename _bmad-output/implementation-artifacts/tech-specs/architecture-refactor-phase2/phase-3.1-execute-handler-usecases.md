# Phase 3.1: Execute Handler → Use Cases (P1 - Critical)

**Parent:** [index.md](./index.md)
**Priority:** P1 - Critical
**Effort:** Large (1-2 weeks)
**Depends On:** Phase 2.1 (DI Container basics)

---

## Objective

Split `src/mcp/handlers/execute-handler.ts` (1,803 lines) into focused Use Cases following Clean Architecture.

---

## Current State

```
src/mcp/handlers/execute-handler.ts (1,803 lines)
├── Direct execution mode
├── Suggestion mode
├── Workflow continuation
├── SHGAT training
├── Capability learning
├── Error handling
├── Tracing
└── Multiple helper methods
```

**Problems:**
- Violates Single Responsibility Principle
- Hard to test individual execution paths
- Tight coupling to infrastructure (StaticStructureBuilder, SHGAT, etc.)
- 15+ dependencies in constructor/execution context

---

## Target Structure

```
src/application/use-cases/execute/
├── mod.ts                           # Re-exports
├── types.ts                         # Shared types (~50 lines)
├── execute-direct.use-case.ts       # Direct code execution (~200 lines)
├── execute-suggestion.use-case.ts   # Suggestion mode (~250 lines)
├── continue-workflow.use-case.ts    # Workflow continuation (~150 lines)
├── train-shgat.use-case.ts          # SHGAT training trigger (~100 lines)
└── shared/
    ├── execution-context.ts         # Context builder (~80 lines)
    └── result-mapper.ts             # Response mapping (~60 lines)

src/mcp/handlers/
├── execute-handler.ts               # Facade only (~150 lines)
└── execute-handler.test.ts          # Handler tests
```

---

## Use Case Specifications

### 1. ExecuteDirectUseCase (~200 lines)

**Responsibility:** Execute code directly without suggestion flow.

```typescript
// src/application/use-cases/execute/execute-direct.use-case.ts

import type { ICodeExecutor } from "@/domain/interfaces/code-executor.ts";
import type { ICapabilityRepository } from "@/domain/interfaces/capability-repository.ts";
import type { ITraceCollector } from "@/domain/interfaces/trace-collector.ts";

export interface ExecuteDirectInput {
  code: string;
  intent?: string;
  context?: Record<string, unknown>;
  mcpClients: Map<string, MCPClientBase>;
  toolDefinitions: ToolDefinition[];
}

export interface ExecuteDirectOutput {
  success: boolean;
  result?: JsonValue;
  error?: StructuredError;
  traces: TraceEvent[];
  capabilityId?: string;
}

export class ExecuteDirectUseCase {
  constructor(
    private executor: ICodeExecutor,
    private capabilityRepo: ICapabilityRepository,
    private traceCollector: ITraceCollector,
  ) {}

  async execute(input: ExecuteDirectInput): Promise<ExecuteDirectOutput> {
    // 1. Execute code via sandbox
    // 2. Collect traces
    // 3. Save capability if successful
    // 4. Return structured result
  }
}
```

### 2. ExecuteSuggestionUseCase (~250 lines)

**Responsibility:** Generate DAG suggestions from intent.

```typescript
// src/application/use-cases/execute/execute-suggestion.use-case.ts

export interface ExecuteSuggestionInput {
  intent: string;
  availableTools: ToolDefinition[];
  graphContext?: GraphContext;
}

export interface ExecuteSuggestionOutput {
  workflowId: string;
  suggestedDag: DAGDefinition;
  confidence: number;
  reasoning: string;
  requiresApproval: boolean;
}

export class ExecuteSuggestionUseCase {
  constructor(
    private dagSuggester: IDAGSuggester,
    private graphEngine: IGraphEngine,
    private workflowRepo: IWorkflowRepository,
  ) {}

  async execute(input: ExecuteSuggestionInput): Promise<ExecuteSuggestionOutput> {
    // 1. Get graph context
    // 2. Generate DAG suggestion
    // 3. Store workflow state
    // 4. Return suggestion for approval
  }
}
```

### 3. ContinueWorkflowUseCase (~150 lines)

**Responsibility:** Continue an approved workflow.

```typescript
// src/application/use-cases/execute/continue-workflow.use-case.ts

export interface ContinueWorkflowInput {
  workflowId: string;
  approved: boolean;
  modifications?: DAGModification[];
}

export interface ContinueWorkflowOutput {
  success: boolean;
  result?: JsonValue;
  status: "completed" | "paused" | "failed";
  checkpointId?: string;
}

export class ContinueWorkflowUseCase {
  constructor(
    private workflowRepo: IWorkflowRepository,
    private dagExecutor: IDAGExecutor,
    private checkpointManager: ICheckpointManager,
  ) {}

  async execute(input: ContinueWorkflowInput): Promise<ContinueWorkflowOutput> {
    // 1. Load workflow state
    // 2. Apply modifications if any
    // 3. Execute DAG
    // 4. Handle checkpoints
  }
}
```

### 4. TrainSHGATUseCase (~100 lines)

**Responsibility:** Trigger SHGAT training from execution traces.

```typescript
// src/application/use-cases/execute/train-shgat.use-case.ts

export interface TrainSHGATInput {
  traces: TraceEvent[];
  success: boolean;
  executionTimeMs: number;
}

export class TrainSHGATUseCase {
  constructor(
    private shgatTrainer: ISHGATTrainer,
    private graphEngine: IGraphEngine,
  ) {}

  async execute(input: TrainSHGATInput): Promise<void> {
    // 1. Extract features from traces
    // 2. Update graph with execution data
    // 3. Trigger async training if threshold met
  }
}
```

---

## Handler Facade

```typescript
// src/mcp/handlers/execute-handler.ts (~150 lines)

import { ExecuteDirectUseCase } from "@/application/use-cases/execute/execute-direct.use-case.ts";
import { ExecuteSuggestionUseCase } from "@/application/use-cases/execute/execute-suggestion.use-case.ts";
import { ContinueWorkflowUseCase } from "@/application/use-cases/execute/continue-workflow.use-case.ts";

export class ExecuteHandler {
  constructor(
    private executeDirectUC: ExecuteDirectUseCase,
    private executeSuggestionUC: ExecuteSuggestionUseCase,
    private continueWorkflowUC: ContinueWorkflowUseCase,
  ) {}

  async handle(request: ExecuteRequest): Promise<ExecuteResponse> {
    // Route to appropriate use case
    if (request.continue_workflow) {
      return this.handleContinuation(request);
    }
    if (request.code) {
      return this.handleDirect(request);
    }
    return this.handleSuggestion(request);
  }

  private async handleDirect(request: ExecuteRequest): Promise<ExecuteResponse> {
    const result = await this.executeDirectUC.execute({
      code: request.code!,
      intent: request.intent,
      context: request.context,
      mcpClients: this.deps.mcpClients,
      toolDefinitions: this.deps.toolDefinitions,
    });
    return this.mapToResponse(result);
  }

  // ... other handlers
}
```

---

## Required Interfaces

Create these in `src/domain/interfaces/`:

```typescript
// src/domain/interfaces/code-executor.ts
export interface ICodeExecutor {
  execute(code: string, context: ExecutionContext): Promise<ExecutionResult>;
}

// src/domain/interfaces/dag-suggester.ts
export interface IDAGSuggester {
  suggest(intent: string, tools: ToolDefinition[]): Promise<DAGSuggestion>;
}

// src/domain/interfaces/workflow-repository.ts
export interface IWorkflowRepository {
  save(workflow: WorkflowState): Promise<string>;
  get(id: string): Promise<WorkflowState | null>;
  update(id: string, state: Partial<WorkflowState>): Promise<void>;
}

// src/domain/interfaces/shgat-trainer.ts
export interface ISHGATTrainer {
  train(traces: TraceEvent[]): Promise<void>;
  shouldTrain(): boolean;
}
```

---

## Migration Steps

### Step 1: Create Interfaces (Day 1)
- [ ] Create `ICodeExecutor` interface
- [ ] Create `IDAGSuggester` interface
- [ ] Create `IWorkflowRepository` interface
- [ ] Create `ISHGATTrainer` interface

### Step 2: Create Use Cases (Day 2-3)
- [ ] Create `ExecuteDirectUseCase`
- [ ] Create `ExecuteSuggestionUseCase`
- [ ] Create `ContinueWorkflowUseCase`
- [ ] Create `TrainSHGATUseCase`
- [ ] Create shared types and utilities

### Step 3: Create Adapters (Day 4)
- [ ] Create `SandboxExecutorAdapter` implementing `ICodeExecutor`
- [ ] Create `DAGSuggesterAdapter` implementing `IDAGSuggester`
- [ ] Create `WorkflowRepository` implementing `IWorkflowRepository`

### Step 4: Register in DI (Day 5)
- [ ] Register use cases in container
- [ ] Register adapters in container
- [ ] Wire up handler to use injected use cases

### Step 5: Refactor Handler (Day 6-7)
- [ ] Reduce handler to facade (~150 lines)
- [ ] Remove direct infrastructure imports
- [ ] Update tests

### Step 6: Cleanup (Day 8)
- [ ] Remove dead code from old handler
- [ ] Verify all tests pass
- [ ] Update imports across codebase

---

## Acceptance Criteria

- [ ] `execute-handler.ts` reduced to < 200 lines
- [ ] Each use case < 300 lines
- [ ] Use cases have no infrastructure imports
- [ ] All existing tests pass
- [ ] New unit tests for each use case
- [ ] Handler uses DI-injected use cases

---

## Test Strategy

```typescript
// tests/unit/application/use-cases/execute-direct.use-case.test.ts

Deno.test("ExecuteDirectUseCase - executes code successfully", async () => {
  const mockExecutor = createMockExecutor({ success: true, result: 42 });
  const mockCapabilityRepo = createMockCapabilityRepo();
  const mockTraceCollector = createMockTraceCollector();

  const useCase = new ExecuteDirectUseCase(
    mockExecutor,
    mockCapabilityRepo,
    mockTraceCollector,
  );

  const result = await useCase.execute({
    code: "1 + 1",
    mcpClients: new Map(),
    toolDefinitions: [],
  });

  assertEquals(result.success, true);
  assertEquals(result.result, 42);
});
```

---

## Dependencies

**Requires:**
- Phase 2.1: DI Container setup
- Interfaces in `src/domain/interfaces/`

**Enables:**
- Phase 3.2: DI Expansion (more services to register)
- Phase 3.3: God Classes Round 2 (pattern to follow)
