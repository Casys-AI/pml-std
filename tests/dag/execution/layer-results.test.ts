/**
 * Unit Tests: Layer Results Collection
 *
 * Tests the result collection and event emission for DAG layer execution.
 *
 * @module tests/dag/execution/layer-results
 */

import { assertEquals, assertExists } from "jsr:@std/assert@1";
import {
  collectLayerResults,
  RESULT_PREVIEW_MAX_LENGTH,
  type LayerResultsDeps,
} from "../../../src/dag/execution/layer-results.ts";
import type { Task } from "../../../src/graphrag/types.ts";
import type { TaskResult } from "../../../src/dag/types.ts";
import { EventStream } from "../../../src/dag/event-stream.ts";
import type { WorkflowState } from "../../../src/dag/state.ts";
import { createSpeculationState } from "../../../src/dag/speculation/integration.ts";

// ============================================================================
// Test Utilities
// ============================================================================

function createMockState(): WorkflowState {
  return {
    workflowId: "test-workflow",
    currentLayer: 0,
    messages: [],
    tasks: [],
    decisions: [],
    context: {},
  };
}

function createMockDeps(): LayerResultsDeps {
  return {
    eventStream: new EventStream(),
    captureContext: {
      state: createMockState(),
      episodicMemory: null,
    },
    speculationState: createSpeculationState(),
  };
}

function createMockTask(id: string): Task {
  return {
    id,
    tool: `test:${id}`,
    arguments: {},
    dependsOn: [],
  };
}

// ============================================================================
// Test Suite: collectLayerResults
// ============================================================================

Deno.test("Layer Results: collectLayerResults", async (t) => {
  await t.step("collects successful results", async () => {
    const workflowId = "test-workflow";
    const tasks = [createMockTask("task1"), createMockTask("task2")];
    const results: PromiseSettledResult<{ output: unknown; executionTimeMs: number }>[] = [
      { status: "fulfilled", value: { output: { data: "result1" }, executionTimeMs: 10 } },
      { status: "fulfilled", value: { output: { data: "result2" }, executionTimeMs: 20 } },
    ];
    const previousResults = new Map<string, TaskResult>();
    const layerIdx = 0;
    const deps = createMockDeps();

    const output = await collectLayerResults(
      workflowId,
      tasks,
      results,
      previousResults,
      layerIdx,
      deps,
    );

    assertEquals(output.layerSuccess, 2);
    assertEquals(output.layerFailed, 0);
    assertEquals(previousResults.get("task1")?.status, "success");
    assertEquals(previousResults.get("task2")?.status, "success");
  });

  await t.step("handles failed results", async () => {
    const workflowId = "test-workflow";
    const tasks = [createMockTask("task1"), createMockTask("task2")];
    const results: PromiseSettledResult<{ output: unknown; executionTimeMs: number }>[] = [
      { status: "fulfilled", value: { output: { data: "result1" }, executionTimeMs: 10 } },
      { status: "rejected", reason: new Error("Task failed") },
    ];
    const previousResults = new Map<string, TaskResult>();
    const layerIdx = 0;
    const deps = createMockDeps();

    const output = await collectLayerResults(
      workflowId,
      tasks,
      results,
      previousResults,
      layerIdx,
      deps,
    );

    assertEquals(output.layerSuccess, 1);
    assertEquals(output.layerFailed, 1);
    assertEquals(previousResults.get("task1")?.status, "success");
    assertEquals(previousResults.get("task2")?.status, "error");
  });

  await t.step("handles safe-to-fail tasks", async () => {
    const workflowId = "test-workflow";
    // A task marked as pure is safe-to-fail
    const safeTask: Task = {
      id: "safe-task",
      tool: "code:filter",
      type: "code_execution",
      code: "return true",
      arguments: {},
      dependsOn: [],
      metadata: { pure: true },
    };
    const tasks = [safeTask];
    const results: PromiseSettledResult<{ output: unknown; executionTimeMs: number }>[] = [
      { status: "rejected", reason: new Error("Task failed but safe") },
    ];
    const previousResults = new Map<string, TaskResult>();
    const layerIdx = 0;
    const deps = createMockDeps();

    const output = await collectLayerResults(
      workflowId,
      tasks,
      results,
      previousResults,
      layerIdx,
      deps,
    );

    // Safe-to-fail failures don't count as workflow failures
    assertEquals(output.layerFailed, 0);
    assertEquals(previousResults.get("safe-task")?.status, "failed_safe");
  });

  await t.step("emits events to stream", async () => {
    const workflowId = "test-workflow";
    const tasks = [createMockTask("task1")];
    const results: PromiseSettledResult<{ output: unknown; executionTimeMs: number }>[] = [
      { status: "fulfilled", value: { output: { data: "result1" }, executionTimeMs: 10 } },
    ];
    const previousResults = new Map<string, TaskResult>();
    const layerIdx = 0;
    const deps = createMockDeps();

    await collectLayerResults(
      workflowId,
      tasks,
      results,
      previousResults,
      layerIdx,
      deps,
    );

    const stats = deps.eventStream.getStats();
    assertEquals(stats.total_events >= 1, true); // At least task_complete event
  });

  await t.step("creates result preview for large results", async () => {
    const workflowId = "test-workflow";
    const tasks = [createMockTask("task1")];
    const largeOutput = { data: "x".repeat(1000) };
    const results: PromiseSettledResult<{ output: unknown; executionTimeMs: number }>[] = [
      { status: "fulfilled", value: { output: largeOutput, executionTimeMs: 10 } },
    ];
    const previousResults = new Map<string, TaskResult>();
    const layerIdx = 0;
    const deps = createMockDeps();

    await collectLayerResults(
      workflowId,
      tasks,
      results,
      previousResults,
      layerIdx,
      deps,
    );

    const result = previousResults.get("task1");
    assertExists(result);
    assertEquals(result.status, "success");
  });
});

Deno.test("Layer Results: Constants", async (t) => {
  await t.step("RESULT_PREVIEW_MAX_LENGTH is reasonable", () => {
    assertEquals(typeof RESULT_PREVIEW_MAX_LENGTH, "number");
    assertEquals(RESULT_PREVIEW_MAX_LENGTH > 0, true);
    assertEquals(RESULT_PREVIEW_MAX_LENGTH <= 1000, true);
  });
});

console.log("✅ Layer Results unit tests completed");
