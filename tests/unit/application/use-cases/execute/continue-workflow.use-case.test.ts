/**
 * ContinueWorkflowUseCase Unit Tests
 *
 * Phase 3.1: Execute Handler → Use Cases refactoring
 *
 * @module tests/unit/application/use-cases/execute/continue-workflow
 */

import { assertEquals, assertExists } from "@std/assert";
import {
  ContinueWorkflowUseCase,
  type ContinueWorkflowDependencies,
} from "../../../../../src/application/use-cases/execute/continue-workflow.use-case.ts";
import type { IWorkflowRepository, WorkflowState } from "../../../../../src/domain/interfaces/workflow-repository.ts";

// ============================================================================
// Mock Factories
// ============================================================================

function createMockWorkflow(overrides?: Partial<WorkflowState>): WorkflowState {
  return {
    workflowId: "wf-123",
    status: "paused",
    intent: "test workflow",
    currentLayer: 1,
    totalLayers: 3,
    results: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function createMockWorkflowRepository(workflow?: WorkflowState | null): IWorkflowRepository {
  const store = new Map<string, WorkflowState>();
  if (workflow) {
    store.set(workflow.workflowId, workflow);
  }

  return {
    create: async (input) => {
      const wf = createMockWorkflow({
        workflowId: input.workflowId ?? crypto.randomUUID(),
        intent: input.intent,
        dag: input.dag,
      });
      store.set(wf.workflowId, wf);
      return wf;
    },
    get: async (id) => store.get(id) ?? null,
    update: async (id, input) => {
      const wf = store.get(id);
      if (!wf) throw new Error(`Workflow ${id} not found`);
      const updated = { ...wf, ...input, updatedAt: new Date() };
      store.set(id, updated);
      return updated;
    },
    delete: async (id) => { store.delete(id); },
    listActive: async () => Array.from(store.values()).filter((w) => w.status === "running" || w.status === "paused"),
    listAwaitingApproval: async () => Array.from(store.values()).filter((w) => w.status === "paused" || w.status === "awaiting_approval"),
  };
}

function createMockDependencies(workflow?: WorkflowState | null): ContinueWorkflowDependencies {
  return {
    workflowRepo: createMockWorkflowRepository(workflow),
  };
}

// ============================================================================
// Tests
// ============================================================================

Deno.test({
  name: "ContinueWorkflowUseCase - rejects missing workflow ID",
  async fn() {
    const deps = createMockDependencies();
    const useCase = new ContinueWorkflowUseCase(deps);

    const result = await useCase.execute({
      workflowId: "",
      approved: true,
    });

    assertEquals(result.success, false);
    assertEquals(result.error?.code, "MISSING_WORKFLOW_ID");
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "ContinueWorkflowUseCase - rejects non-existent workflow",
  async fn() {
    const deps = createMockDependencies(); // No workflow in store
    const useCase = new ContinueWorkflowUseCase(deps);

    const result = await useCase.execute({
      workflowId: "non-existent",
      approved: true,
    });

    assertEquals(result.success, false);
    assertEquals(result.error?.code, "WORKFLOW_NOT_FOUND");
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "ContinueWorkflowUseCase - rejects workflow not in paused state",
  async fn() {
    const workflow = createMockWorkflow({ status: "running" });
    const deps = createMockDependencies(workflow);
    const useCase = new ContinueWorkflowUseCase(deps);

    const result = await useCase.execute({
      workflowId: workflow.workflowId,
      approved: true,
    });

    assertEquals(result.success, false);
    assertEquals(result.error?.code, "INVALID_WORKFLOW_STATE");
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "ContinueWorkflowUseCase - handles rejection (abort)",
  async fn() {
    const workflow = createMockWorkflow({ status: "paused" });
    const deps = createMockDependencies(workflow);
    const useCase = new ContinueWorkflowUseCase(deps);

    const result = await useCase.execute({
      workflowId: workflow.workflowId,
      approved: false,
    });

    assertEquals(result.success, true);
    assertExists(result.data);
    assertEquals(result.data.status, "aborted");
    assertEquals(result.data.success, false);
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "ContinueWorkflowUseCase - requires executor for approval",
  async fn() {
    const workflow = createMockWorkflow({ status: "paused" });
    const deps = createMockDependencies(workflow);
    // No getActiveWorkflow or approvalHandler
    const useCase = new ContinueWorkflowUseCase(deps);

    const result = await useCase.execute({
      workflowId: workflow.workflowId,
      approved: true,
    });

    assertEquals(result.success, false);
    assertEquals(result.error?.code, "NO_EXECUTOR");
  },
  sanitizeOps: false,
  sanitizeResources: false,
});
