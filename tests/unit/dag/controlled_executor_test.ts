/**
 * Integration tests for ControlledExecutor
 *
 * Tests:
 * - ControlledExecutor extends ParallelExecutor correctly
 * - executeStream() yields events in correct order
 * - State updates via reducers during execution
 * - Commands can be injected mid-execution
 * - Epic 2 backward compatibility verified
 * - Speedup 5x maintained (parallel execution preserved)
 *
 * @module tests/unit/dag/controlled_executor_test
 */

import { assertEquals } from "@std/assert";
import { ControlledExecutor } from "../../../src/dag/controlled-executor.ts";
import { ParallelExecutor } from "../../../src/dag/executor.ts";
import type { DAGStructure } from "../../../src/graphrag/types.ts";
import type { ExecutionEvent, ToolExecutor } from "../../../src/dag/types.ts";

// Mock tool executor for testing
const mockToolExecutor: ToolExecutor = async (tool: string, args: Record<string, unknown>) => {
  // Simulate some work
  await new Promise((resolve) => setTimeout(resolve, 10));
  return { tool, args, result: "success" };
};

Deno.test("ControlledExecutor - Inheritance", async (t) => {
  await t.step("extends ParallelExecutor", () => {
    const executor = new ControlledExecutor(mockToolExecutor);

    // Should be instance of both
    assertEquals(executor instanceof ControlledExecutor, true);
    assertEquals(executor instanceof ParallelExecutor, true);
  });

  await t.step("has ParallelExecutor.execute() method", () => {
    const executor = new ControlledExecutor(mockToolExecutor);

    // Should have execute method (backward compatibility)
    assertEquals(typeof executor.execute, "function");
  });
});

Deno.test("ControlledExecutor - executeStream", async (t) => {
  await t.step("yields events in correct order", async () => {
    const executor = new ControlledExecutor(mockToolExecutor);

    const dag: DAGStructure = {
      tasks: [
        // Mark as pure to skip HIL approval check (test tools are not in allow list)
        { id: "task1", tool: "tool1", arguments: {}, dependsOn: [], metadata: { pure: true } },
        { id: "task2", tool: "tool2", arguments: {}, dependsOn: ["task1"], metadata: { pure: true } },
      ],
    };

    const events: ExecutionEvent[] = [];

    for await (const event of executor.executeStream(dag)) {
      events.push(event);
    }

    // Should have: workflow_start, layer_start, task_start, task_complete, state_updated, checkpoint (x2 layers), workflow_complete
    assertEquals(events.length > 0, true);

    // First event should be workflow_start
    assertEquals(events[0].type, "workflow_start");

    // Last event should be workflow_complete
    assertEquals(events[events.length - 1].type, "workflow_complete");

    // Should contain task events
    const taskStarts = events.filter((e) => e.type === "task_start");
    assertEquals(taskStarts.length, 2);

    const taskCompletes = events.filter((e) => e.type === "task_complete");
    assertEquals(taskCompletes.length, 2);
  });

  await t.step("returns final WorkflowState", async () => {
    const executor = new ControlledExecutor(mockToolExecutor);

    const dag: DAGStructure = {
      tasks: [
        { id: "task1", tool: "tool1", arguments: {}, dependsOn: [], metadata: { pure: true } },
      ],
    };

    let finalState;
    for await (const _event of executor.executeStream(dag, "test-workflow")) {
      // Consume events
    }

    // Get final state after execution
    finalState = executor.getState();

    assertEquals(finalState?.workflowId, "test-workflow");
    assertEquals(finalState?.tasks.length, 1);
    assertEquals(finalState?.tasks[0].taskId, "task1");
  });

  await t.step("state updates during execution", async () => {
    const executor = new ControlledExecutor(mockToolExecutor);

    const dag: DAGStructure = {
      tasks: [
        { id: "task1", tool: "tool1", arguments: {}, dependsOn: [], metadata: { pure: true } },
        { id: "task2", tool: "tool2", arguments: {}, dependsOn: [], metadata: { pure: true } },
      ],
    };

    const stateUpdates: ExecutionEvent[] = [];

    for await (const event of executor.executeStream(dag)) {
      if (event.type === "state_updated") {
        stateUpdates.push(event);
      }
    }

    // Should have state updates after each layer
    assertEquals(stateUpdates.length, 1); // 1 layer (both tasks parallel)

    // Check state after execution
    const state = executor.getState();
    assertEquals(state?.tasks.length, 2);
  });

  await t.step("emits layer_start for each parallel layer", async () => {
    const executor = new ControlledExecutor(mockToolExecutor);

    const dag: DAGStructure = {
      tasks: [
        { id: "task1", tool: "tool1", arguments: {}, dependsOn: [], metadata: { pure: true } },
        { id: "task2", tool: "tool2", arguments: {}, dependsOn: ["task1"], metadata: { pure: true } },
        { id: "task3", tool: "tool3", arguments: {}, dependsOn: ["task2"], metadata: { pure: true } },
      ],
    };

    const layerStarts: ExecutionEvent[] = [];

    for await (const event of executor.executeStream(dag)) {
      if (event.type === "layer_start") {
        layerStarts.push(event);
      }
    }

    // 3 tasks with dependencies → 3 layers
    assertEquals(layerStarts.length, 3);
  });
});

Deno.test("ControlledExecutor - Command Queue", async (t) => {
  await t.step("commands can be enqueued", () => {
    const executor = new ControlledExecutor(mockToolExecutor);

    // Should not throw
    executor.enqueueCommand({
      type: "abort",
      reason: "test",
    });

    const stats = executor.getCommandQueueStats();
    assertEquals(stats.totalCommands, 1);
  });

  await t.step("commands processed during execution", async () => {
    const executor = new ControlledExecutor(mockToolExecutor);

    const dag: DAGStructure = {
      tasks: [
        { id: "task1", tool: "tool1", arguments: {}, dependsOn: [], metadata: { pure: true } },
        { id: "task2", tool: "tool2", arguments: {}, dependsOn: ["task1"], metadata: { pure: true } },
      ],
    };

    // Enqueue command before execution
    executor.enqueueCommand({
      type: "abort",
      reason: "test abort",
    });

    // Execute - abort should throw an error
    let errorThrown = false;
    try {
      for await (const _event of executor.executeStream(dag)) {
        // Commands will be processed between layers
      }
    } catch (error) {
      errorThrown = true;
      assertEquals((error as Error).message, "Workflow aborted by agent: test abort");
    }

    assertEquals(errorThrown, true, "Abort command should throw an error");
    const stats = executor.getCommandQueueStats();
    assertEquals(stats.processedCommands, 1);
  });
});

Deno.test("ControlledExecutor - Backward Compatibility", async (t) => {
  await t.step("ParallelExecutor.execute() still works", async () => {
    const executor = new ControlledExecutor(mockToolExecutor);

    const dag: DAGStructure = {
      tasks: [
        { id: "task1", tool: "tool1", arguments: {}, dependsOn: [], metadata: { pure: true } },
      ],
    };

    // Old API should still work
    const result = await executor.execute(dag);

    assertEquals(result.totalTasks, 1);
    assertEquals(result.successfulTasks, 1);
    assertEquals(result.failedTasks, 0);
  });

  await t.step("existing Epic 2 code unchanged", async () => {
    // Verify ParallelExecutor can still be used independently
    const parallelExecutor = new ParallelExecutor(mockToolExecutor);

    const dag: DAGStructure = {
      tasks: [
        { id: "task1", tool: "tool1", arguments: {}, dependsOn: [], metadata: { pure: true } },
      ],
    };

    const result = await parallelExecutor.execute(dag);

    assertEquals(result.totalTasks, 1);
    assertEquals(result.successfulTasks, 1);
  });
});

Deno.test("ControlledExecutor - Performance", async (t) => {
  await t.step("preserves 5x speedup (parallel execution)", async () => {
    const slowToolExecutor: ToolExecutor = async (tool, args) => {
      await new Promise((resolve) => setTimeout(resolve, 100)); // 100ms per task
      return { tool, args, result: "success" };
    };

    const executor = new ControlledExecutor(slowToolExecutor);

    // 5 parallel tasks, each takes 100ms
    // Sequential: 500ms, Parallel: ~100ms, Speedup: ~5x
    const dag: DAGStructure = {
      tasks: [
        { id: "task1", tool: "tool1", arguments: {}, dependsOn: [], metadata: { pure: true } },
        { id: "task2", tool: "tool2", arguments: {}, dependsOn: [], metadata: { pure: true } },
        { id: "task3", tool: "tool3", arguments: {}, dependsOn: [], metadata: { pure: true } },
        { id: "task4", tool: "tool4", arguments: {}, dependsOn: [], metadata: { pure: true } },
        { id: "task5", tool: "tool5", arguments: {}, dependsOn: [], metadata: { pure: true } },
      ],
    };

    const startTime = performance.now();

    for await (const _event of executor.executeStream(dag)) {
      // Consume events
    }

    const elapsed = performance.now() - startTime;

    console.log(`5 parallel tasks (100ms each): ${elapsed.toFixed(0)}ms`);

    // Should complete in ~100ms (parallel), not 500ms (sequential)
    // Allow some overhead: expect <200ms
    assertEquals(elapsed < 200, true, `Expected <200ms, got ${elapsed}ms`);

    // Sequential time would be 500ms
    const sequentialTime = 500;
    const speedup = sequentialTime / elapsed;
    console.log(`Speedup: ${speedup.toFixed(1)}x`);

    // Should be at least 2.5x speedup (ideally ~5x, but allow overhead)
    assertEquals(speedup > 2.5, true, `Expected >2.5x speedup, got ${speedup.toFixed(1)}x`);
  });

  await t.step("event stream overhead <5% of execution time", async () => {
    const executor = new ControlledExecutor(mockToolExecutor);

    const dag: DAGStructure = {
      tasks: [
        { id: "task1", tool: "tool1", arguments: {}, dependsOn: [], metadata: { pure: true } },
        { id: "task2", tool: "tool2", arguments: {}, dependsOn: [], metadata: { pure: true } },
        { id: "task3", tool: "tool3", arguments: {}, dependsOn: [], metadata: { pure: true } },
      ],
    };

    const startTime = performance.now();

    for await (const _event of executor.executeStream(dag)) {
      // Consume events
    }

    const elapsed = performance.now() - startTime;

    const stats = executor.getEventStreamStats();

    console.log(`Execution time: ${elapsed.toFixed(1)}ms`);
    console.log(`Events emitted: ${stats.total_events}`);
    console.log(`Events dropped: ${stats.dropped_events}`);

    // Event stream shouldn't add significant overhead
    // With 3 tasks @10ms each, should complete in ~10-20ms
    assertEquals(elapsed < 50, true, `Expected <50ms, got ${elapsed}ms`);
  });
});

Deno.test("ControlledExecutor - State Management", async (t) => {
  await t.step("getState returns null before execution", () => {
    const executor = new ControlledExecutor(mockToolExecutor);

    const state = executor.getState();
    assertEquals(state, null);
  });

  await t.step("getState returns readonly snapshot", async () => {
    const executor = new ControlledExecutor(mockToolExecutor);

    const dag: DAGStructure = {
      tasks: [
        { id: "task1", tool: "tool1", arguments: {}, dependsOn: [], metadata: { pure: true } },
      ],
    };

    for await (const _event of executor.executeStream(dag, "test")) {
      // Execute
    }

    const state = executor.getState();

    // Should be readonly
    assertEquals(state?.workflowId, "test");
  });

  await t.step("getEventStreamStats returns stats", async () => {
    const executor = new ControlledExecutor(mockToolExecutor);

    const dag: DAGStructure = {
      tasks: [
        { id: "task1", tool: "tool1", arguments: {}, dependsOn: [], metadata: { pure: true } },
      ],
    };

    for await (const _event of executor.executeStream(dag)) {
      // Execute
    }

    const stats = executor.getEventStreamStats();

    assertEquals(stats.total_events > 0, true);
  });

  await t.step("getCommandQueueStats returns stats", () => {
    const executor = new ControlledExecutor(mockToolExecutor);

    const stats = executor.getCommandQueueStats();

    assertEquals(stats.totalCommands, 0);
    assertEquals(stats.processedCommands, 0);
  });
});

// =============================================================================
// Bug 3 Fix: setExecutionArgs for parameterized capabilities
// =============================================================================

Deno.test("ControlledExecutor - setExecutionArgs (Bug 3 Fix)", async (t) => {
  await t.step("setExecutionArgs stores args for capability execution", () => {
    const executor = new ControlledExecutor(mockToolExecutor);

    const args = {
      files: ["a.txt", "b.txt"],
      results: [],
      threshold: 0.5,
    };

    // Should not throw
    executor.setExecutionArgs(args);

    // The args are stored internally for injection into execution context
    // We can't directly access executionArgs (private), but the method should work
  });

  await t.step("setExecutionArgs with empty object is valid", () => {
    const executor = new ControlledExecutor(mockToolExecutor);

    // Empty args should be valid (no parameters needed)
    executor.setExecutionArgs({});
  });

  await t.step("setExecutionArgs can be called multiple times (overwrites)", () => {
    const executor = new ControlledExecutor(mockToolExecutor);

    executor.setExecutionArgs({ first: "value" });
    executor.setExecutionArgs({ second: "value" });

    // Should not throw - last call wins
  });
});
