# Phase 2.6: Testing Architecture (P2 - Medium)

**Parent:** [index.md](./index.md)
**Priority:** P2 - Medium
**Timeline:** Weeks 11-12
**Depends On:** Phase 2.5 (Patterns implemented)

---

## Objective

Establish comprehensive testing strategy with test pyramid and architecture tests.

---

## Current State

- Some unit tests exist
- No integration test strategy
- No architecture tests
- Manual testing predominant
- Coverage: ~60%

---

## Target Test Structure

```
tests/
├── unit/                          # Fast, isolated
│   ├── domain/                    # Pure business logic
│   ├── use-cases/                 # Use cases with mocked deps
│   └── utils/
├── integration/                   # Medium speed, real deps
│   ├── repositories/              # Test with real DB
│   ├── workflows/                 # End-to-end workflow tests
│   └── api/
├── architecture/                  # Validate architecture rules
│   ├── file-size.test.ts
│   ├── circular-deps.test.ts
│   ├── layers.test.ts
│   └── interfaces.test.ts
└── e2e/                           # Slow, full system
    └── scenarios/
```

---

## Test Pyramid

```
        /\
       /  \      E2E Tests (10%)
      /----\     - Full system scenarios
     /      \    - Slow, expensive
    /--------\
   /          \  Integration Tests (30%)
  /            \ - Real dependencies
 /--------------\- Medium speed
/                \
/------------------\ Unit Tests (60%)
                    - Fast, isolated
                    - Mocked dependencies
```

---

## Architecture Tests

See [quick-wins.md](./quick-wins.md#qw-5-architecture-tests-guard-rails-2-3-days) for implementation details.

### Test Categories

| Test File | Purpose | Blocks |
|-----------|---------|--------|
| `file-size.test.ts` | No file > 600 lines | Re-inflation |
| `circular-deps.test.ts` | No circular imports | Coupling |
| `layers.test.ts` | No upward dependencies | Architecture violations |
| `interfaces.test.ts` | All interfaces implemented | Missing implementations |

### Run Command

```bash
deno task test:arch
```

---

## Unit Test Strategy

### Domain Layer Tests

```typescript
// tests/unit/domain/workflow-state-machine.test.ts
import { assertEquals, assertThrows } from "@std/assert";
import { WorkflowState, WorkflowStateMachine } from "@/domain/workflow/state-machine.ts";

Deno.test("WorkflowStateMachine", async (t) => {
  await t.step("allows valid transitions", () => {
    const sm = new WorkflowStateMachine(WorkflowState.CREATED);
    sm.transition(WorkflowState.RUNNING);
    assertEquals(sm.currentState, WorkflowState.RUNNING);
  });

  await t.step("rejects invalid transitions", () => {
    const sm = new WorkflowStateMachine(WorkflowState.COMPLETED);
    assertThrows(() => sm.transition(WorkflowState.RUNNING));
  });
});
```

### Use Case Tests (with mocks)

```typescript
// tests/unit/use-cases/execute-workflow.test.ts
import { assertEquals } from "@std/assert";
import { ExecuteWorkflowUseCase } from "@/application/use-cases/workflows/execute-workflow.ts";
import { buildTestContainer } from "@/infrastructure/di/testing.ts";

Deno.test("ExecuteWorkflowUseCase", async (t) => {
  await t.step("executes workflow successfully", async () => {
    const mockExecutor = createMockDAGExecutor({
      execute: async () => ({ success: true, result: {} })
    });

    const container = buildTestContainer({ dagExecutor: mockExecutor });
    const useCase = container.get(ExecuteWorkflowUseCase);

    const result = await useCase.execute({ intent: "test workflow" });

    assertEquals(result.success, true);
  });

  await t.step("returns error for invalid request", async () => {
    const container = buildTestContainer();
    const useCase = container.get(ExecuteWorkflowUseCase);

    const result = await useCase.execute({ intent: "" });

    assertEquals(result.success, false);
    assertEquals(result.errors?.[0], "Intent is required");
  });
});
```

---

## Integration Test Strategy

### Repository Tests

```typescript
// tests/integration/repositories/capability-repository.test.ts
import { assertEquals } from "@std/assert";
import { CapabilityRepository } from "@/capabilities/storage/repository.ts";
import { createTestDatabase, cleanupTestDatabase } from "../helpers/db.ts";

Deno.test("CapabilityRepository", async (t) => {
  const db = await createTestDatabase();
  const repo = new CapabilityRepository(db);

  await t.step("saves and retrieves capability", async () => {
    const capability = createTestCapability();
    await repo.save(capability);

    const retrieved = await repo.findById(capability.id);
    assertEquals(retrieved?.name, capability.name);
  });

  await t.step("searches by intent", async () => {
    const capabilities = await repo.findByIntent("read file");
    assertEquals(capabilities.length > 0, true);
  });

  await cleanupTestDatabase(db);
});
```

### Workflow Tests

```typescript
// tests/integration/workflows/dag-execution.test.ts
import { assertEquals } from "@std/assert";
import { ControlledExecutor } from "@/dag/controlled-executor.ts";
import { buildIntegrationContainer } from "../helpers/container.ts";

Deno.test("DAG Execution", async (t) => {
  const container = buildIntegrationContainer();
  const executor = container.get(IDAGExecutor);

  await t.step("executes simple sequential DAG", async () => {
    const dag = createSequentialDAG(3);
    const result = await executor.execute(dag);

    assertEquals(result.status, "completed");
    assertEquals(result.tasksCompleted, 3);
  });

  await t.step("handles parallel tasks", async () => {
    const dag = createParallelDAG(5);
    const result = await executor.execute(dag);

    assertEquals(result.status, "completed");
    assertEquals(result.tasksCompleted, 5);
  });
});
```

---

## E2E Test Strategy

```typescript
// tests/e2e/scenarios/full-workflow.test.ts
import { assertEquals } from "@std/assert";
import { startTestServer, stopTestServer } from "../helpers/server.ts";

Deno.test("Full Workflow E2E", async (t) => {
  const server = await startTestServer();

  await t.step("discovers tools, builds DAG, executes", async () => {
    // 1. Call pml:discover
    const discoverResult = await server.call("pml:discover", {
      intent: "read a file and count lines"
    });
    assertEquals(discoverResult.tools.length > 0, true);

    // 2. Call pml:execute
    const executeResult = await server.call("pml:execute", {
      intent: "read package.json and count lines"
    });
    assertEquals(executeResult.success, true);
  });

  await stopTestServer(server);
});
```

---

## Test Tasks in deno.json

```json
{
  "tasks": {
    "test": "deno test --allow-all tests/",
    "test:unit": "deno test --allow-all tests/unit/",
    "test:unit:fast": "deno test --allow-all --parallel tests/unit/",
    "test:integration": "deno test --allow-all tests/integration/",
    "test:e2e": "deno test --allow-all tests/e2e/",
    "test:arch": "deno test --allow-read --allow-run tests/architecture/",
    "test:all": "deno task test:unit && deno task test:integration && deno task test:arch",
    "test:coverage": "deno test --allow-all --coverage=coverage/ && deno coverage coverage/"
  }
}
```

---

## Coverage Goals

| Layer | Current | Target |
|-------|---------|--------|
| Domain | ~50% | >95% |
| Use Cases | ~40% | >90% |
| Infrastructure | ~60% | >80% |
| Overall | ~60% | >85% |

---

## Acceptance Criteria

- [ ] Test structure reorganized per pyramid
- [ ] Architecture tests in CI (blocking)
- [ ] Unit test coverage > 85%
- [ ] Integration tests for all repositories
- [ ] E2E tests for critical paths
- [ ] Coverage report generated in CI
