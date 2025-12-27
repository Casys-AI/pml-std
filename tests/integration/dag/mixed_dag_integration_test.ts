/**
 * Integration Tests: Story 7.4 - Mixed DAG (Tools + Capabilities)
 *
 * End-to-end tests for:
 * - AC#7: ControlledExecutor capability task execution
 * - AC#10: Integration test with tool + capability DAG
 * - AC#11: Checkpoint includes capability task results
 *
 * @requires --allow-all (database, network, env access)
 * Run with: deno test --allow-all tests/integration/dag/mixed_dag_integration_test.ts
 */

import { assert, assertEquals, assertExists } from "@std/assert";
import type { DAGStructure, PredictedNode, Task } from "../../../src/graphrag/types.ts";
import type { ExecutionEvent } from "../../../src/dag/types.ts";
import { createTestExecutor } from "../../e2e/test-helpers.ts";

Deno.test("Integration: Mixed DAG structure with tools and capabilities", async () => {
  // Create a DAG with mixed task types
  const mixedDAG: DAGStructure = {
    tasks: [
      // Tool task
      {
        id: "task_1",
        tool: "file_read",
        type: "mcp_tool",
        arguments: { path: "/tmp/test.txt" },
        dependsOn: [],
      },
      // Capability task that depends on tool task
      {
        id: "cap_task_1",
        tool: "data_transform",
        type: "capability",
        capabilityId: "cap-transform-123",
        code: `
          // Access deps from previous task
          const fileData = deps.task_1?.output;
          return { transformed: true, source: fileData };
        `,
        arguments: {},
        dependsOn: ["task_1"],
      },
      // Another tool task that depends on capability
      {
        id: "task_2",
        tool: "file_write",
        type: "mcp_tool",
        arguments: { path: "/tmp/output.txt" },
        dependsOn: ["cap_task_1"],
      },
    ],
  };

  // Verify DAG structure
  assertEquals(mixedDAG.tasks.length, 3);

  // Verify task types
  assertEquals(mixedDAG.tasks[0].type, "mcp_tool");
  assertEquals(mixedDAG.tasks[1].type, "capability");
  assertEquals(mixedDAG.tasks[2].type, "mcp_tool");

  // Verify capability task has required fields
  const capTask = mixedDAG.tasks[1];
  assertExists(capTask.capabilityId);
  assertExists(capTask.code);
  assertEquals(capTask.capabilityId, "cap-transform-123");

  // Verify dependencies are correct
  assert(capTask.dependsOn.includes("task_1"));
  assert(mixedDAG.tasks[2].dependsOn.includes("cap_task_1"));
});

Deno.test("Integration: Task dependency chain preserves order", () => {
  // Create a complex mixed DAG
  const dag: DAGStructure = {
    tasks: [
      { id: "t1", tool: "tool1", arguments: {}, dependsOn: [] },
      { id: "t2", tool: "tool2", arguments: {}, dependsOn: ["t1"] },
      {
        id: "c1",
        tool: "cap1",
        type: "capability",
        capabilityId: "cap-1",
        code: "return 1;",
        arguments: {},
        dependsOn: ["t1", "t2"],
      },
      { id: "t3", tool: "tool3", arguments: {}, dependsOn: ["c1"] },
      {
        id: "c2",
        tool: "cap2",
        type: "capability",
        capabilityId: "cap-2",
        code: "return 2;",
        arguments: {},
        dependsOn: ["c1", "t3"],
      },
    ],
  };

  // Topological sort validation
  const visited = new Set<string>();
  const order: string[] = [];

  function visit(taskId: string) {
    if (visited.has(taskId)) return;
    const task = dag.tasks.find((t) => t.id === taskId);
    if (!task) return;

    for (const dep of task.dependsOn) {
      visit(dep);
    }

    visited.add(taskId);
    order.push(taskId);
  }

  for (const task of dag.tasks) {
    visit(task.id);
  }

  // Verify order respects dependencies
  assertEquals(order.length, 5);
  assertEquals(order[0], "t1"); // First (no deps)
  assertEquals(order[1], "t2"); // After t1

  // c1 should come after t1 and t2
  const c1Index = order.indexOf("c1");
  assert(c1Index > order.indexOf("t1"));
  assert(c1Index > order.indexOf("t2"));

  // t3 should come after c1
  const t3Index = order.indexOf("t3");
  assert(t3Index > c1Index);

  // c2 should be last
  assertEquals(order[4], "c2");
});

Deno.test("Integration: Capability task has valid code field", () => {
  const capabilityTask: Task = {
    id: "cap_test",
    tool: "my_capability",
    type: "capability",
    capabilityId: "cap-abc-123",
    code: `
      // This is capability code
      const input = deps.previous?.output;
      const processed = input ? input.toUpperCase() : "DEFAULT";
      return { result: processed, timestamp: Date.now() };
    `,
    arguments: { config: "value" },
    dependsOn: ["previous"],
  };

  // Validate structure
  assertEquals(capabilityTask.type, "capability");
  assertExists(capabilityTask.capabilityId);
  assertExists(capabilityTask.code);

  // Code should be valid JavaScript
  assert(capabilityTask.code.includes("return"));
  assert(capabilityTask.code.includes("deps.previous"));
});

Deno.test("Integration: PredictedNode can have capability source", () => {
  // Create a capability prediction
  const prediction: PredictedNode = {
    toolId: "capability:cap-12345",
    confidence: 0.75,
    reasoning: "Capability matches context (85% overlap)",
    source: "capability",
    capabilityId: "cap-12345",
  };

  assertEquals(prediction.source, "capability");
  assertExists(prediction.capabilityId);
  assertEquals(prediction.capabilityId, "cap-12345");
  assert(prediction.confidence >= 0.4 && prediction.confidence <= 0.85);
});

Deno.test("Integration: Mixed DAG validation - no cycles allowed", () => {
  // This DAG has a cycle: t1 -> c1 -> t2 -> t1
  const cyclicDAG: DAGStructure = {
    tasks: [
      { id: "t1", tool: "tool1", arguments: {}, dependsOn: ["t2"] }, // Creates cycle
      {
        id: "c1",
        tool: "cap1",
        type: "capability",
        capabilityId: "cap-1",
        code: "return 1;",
        arguments: {},
        dependsOn: ["t1"],
      },
      { id: "t2", tool: "tool2", arguments: {}, dependsOn: ["c1"] },
    ],
  };

  // Attempt topological sort to detect cycle
  function hasCycle(dag: DAGStructure): boolean {
    const inDegree = new Map<string, number>();
    const adjList = new Map<string, string[]>();

    for (const task of dag.tasks) {
      inDegree.set(task.id, task.dependsOn.length);
      for (const dep of task.dependsOn) {
        if (!adjList.has(dep)) adjList.set(dep, []);
        adjList.get(dep)!.push(task.id);
      }
    }

    const queue: string[] = [];
    for (const [taskId, degree] of inDegree.entries()) {
      if (degree === 0) queue.push(taskId);
    }

    let sorted = 0;
    while (queue.length > 0) {
      const current = queue.shift()!;
      sorted++;

      for (const neighbor of adjList.get(current) || []) {
        const newDegree = inDegree.get(neighbor)! - 1;
        inDegree.set(neighbor, newDegree);
        if (newDegree === 0) queue.push(neighbor);
      }
    }

    return sorted !== dag.tasks.length;
  }

  // Cyclic DAG should be detected
  assertEquals(hasCycle(cyclicDAG), true);

  // Valid DAG should pass
  const validDAG: DAGStructure = {
    tasks: [
      { id: "t1", tool: "tool1", arguments: {}, dependsOn: [] },
      {
        id: "c1",
        tool: "cap1",
        type: "capability",
        capabilityId: "cap-1",
        code: "return 1;",
        arguments: {},
        dependsOn: ["t1"],
      },
      { id: "t2", tool: "tool2", arguments: {}, dependsOn: ["c1"] },
    ],
  };

  assertEquals(hasCycle(validDAG), false);
});

Deno.test("Integration: Capability task result structure for checkpoint", () => {
  // Simulate a capability task result (as returned by executeCapabilityTask)
  const capabilityResult = {
    output: {
      result: { data: [1, 2, 3], processed: true },
      capabilityId: "cap-xyz-789",
      executionTimeMs: 42.5,
    },
    executionTimeMs: 42.5,
  };

  // Verify result structure includes capability metadata
  assertExists(capabilityResult.output);
  assertExists(capabilityResult.output.capabilityId);
  assertEquals(capabilityResult.output.capabilityId, "cap-xyz-789");
  assertExists(capabilityResult.output.executionTimeMs);
  assert(capabilityResult.output.executionTimeMs > 0);
});

// =============================================================================
// AC#7: ControlledExecutor capability task execution (Issue #3 fix)
// =============================================================================

Deno.test({
  name: "Integration: ControlledExecutor executes capability task (AC#7)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    // Mock tool executor
    const mockToolExecutor = async (tool: string, _args: Record<string, unknown>) => {
      if (tool === "mock:get_numbers") {
        return { numbers: [10, 20, 30] };
      }
      return {};
    };

    const executor = await createTestExecutor(mockToolExecutor);

    // Build mixed DAG: MCP tool → capability task
    const dag: DAGStructure = {
      tasks: [
        // Layer 0: Fetch data via MCP tool
        {
          id: "fetch_numbers",
          tool: "mock:get_numbers",
          arguments: {},
          dependsOn: [],
          type: "mcp_tool",
        },
        // Layer 1: Process via capability (uses code field like code_execution)
        {
          id: "cap_process",
          tool: "transform_numbers",
          type: "capability",
          capabilityId: "cap-transform-001",
          code: `
            const data = deps.fetch_numbers.output;
            const doubled = data.numbers.map(n => n * 2);
            return { doubled, original: data.numbers, capabilityId: "cap-transform-001" };
          `,
          arguments: {},
          dependsOn: ["fetch_numbers"],
        },
      ],
    };

    // Execute DAG and collect events
    const events: ExecutionEvent[] = [];
    for await (const event of executor.executeStream(dag)) {
      events.push(event);
    }

    // Verify workflow completed
    const workflowComplete = events.find((e) => e.type === "workflow_complete") as any;
    assertExists(workflowComplete, "Workflow should complete");
    assertEquals(workflowComplete.successfulTasks, 2, "Both tasks should succeed");

    // Verify capability task result
    const state = executor.getState();
    assertExists(state, "State should exist");

    const capResult = state.tasks.find((t) => t.taskId === "cap_process");
    assertExists(capResult, "Capability task result should exist");
    assertEquals(capResult.status, "success", "Capability task should succeed");

    // Verify output structure includes capability metadata (AC#11)
    const output = capResult.output as any;
    assertExists(output.result, "Result should exist");
    assertEquals(output.result.doubled, [20, 40, 60], "Doubled values should be correct");
    assertExists(output.capabilityId, "Capability ID should be in output");
  },
});

Deno.test({
  name: "Integration: Mixed DAG with checkpoint persistence (AC#11)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const mockToolExecutor = async (_tool: string, _args: Record<string, unknown>) => {
      return { value: 42 };
    };

    const executor = await createTestExecutor(mockToolExecutor);

    const dag: DAGStructure = {
      tasks: [
        {
          id: "tool_task",
          tool: "mock:get_value",
          arguments: {},
          dependsOn: [],
          type: "mcp_tool",
        },
        {
          id: "cap_task",
          tool: "process_value",
          type: "capability",
          capabilityId: "cap-proc-002",
          code: `
            const val = deps.tool_task.output.value;
            return { processed: val * 10, capabilityId: "cap-proc-002" };
          `,
          arguments: {},
          dependsOn: ["tool_task"],
        },
      ],
    };

    const events: ExecutionEvent[] = [];
    for await (const event of executor.executeStream(dag)) {
      events.push(event);
    }

    // Verify checkpoint was created
    const checkpointEvent = events.find((e) => e.type === "checkpoint");
    assertExists(checkpointEvent, "Checkpoint should be created");

    // Verify capability result is in state (for checkpoint persistence)
    const state = executor.getState();
    assertExists(state, "State should exist");
    const capTask = state!.tasks.find((t) => t.taskId === "cap_task");
    assertExists(capTask, "Capability task should be in state");
    assertEquals(capTask.status, "success");

    const capOutput = capTask.output as any;
    assertEquals(capOutput.result.processed, 420, "Processed value should be correct");
    assertExists(capOutput.capabilityId, "Capability ID should be persisted");
  },
});
