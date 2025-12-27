/**
 * Integration Tests: Capability Execution in DAG
 *
 * Tests for capability task type routing through ControlledExecutor.
 * Verifies AC3, AC5 from tech-spec-dag-code-execution-integration.md
 */

import { assert, assertEquals, assertExists } from "jsr:@std/assert@1";
import { ControlledExecutor } from "../../src/dag/controlled-executor.ts";
import type { DAGStructure } from "../../src/graphrag/types.ts";
import type { ToolExecutor } from "../../src/dag/types.ts";

Deno.test("DAG capability execution integration", async (t) => {
  // Mock tool executor for MCP tools
  const mockToolExecutor: ToolExecutor = async (
    toolName: string,
    args: Record<string, unknown>,
  ) => {
    // Simulate MCP tool execution
    return { result: `mcp_${toolName}_${JSON.stringify(args)}` };
  };

  await t.step("AC3: capability task with capabilityId executes in sandbox", async () => {
    const executor = new ControlledExecutor(mockToolExecutor, { taskTimeout: 30000 });

    // DAG with capability task (has capabilityId and code)
    const dag: DAGStructure = {
      tasks: [
        {
          id: "capability_task",
          type: "capability",
          tool: "sandbox", // Not used for capability
          capabilityId: "cap-123-abc",
          code: `
            // Capability code receives capabilityId in context
            return {
              executed: true,
              capabilityId: capabilityId,
              computed: 2 + 2
            };
          `,
          arguments: {},
          dependsOn: [],
        },
      ],
    };

    const result = await executor.execute(dag);

    assertEquals(result.errors.length, 0, "Should have no errors");
    assertEquals(result.results.length, 1, "Should have 1 result");

    const taskResult = result.results[0];
    assertEquals(taskResult.status, "success", "Task should succeed");
    assertExists(taskResult.output, "Should have output");

    const output = taskResult.output as { result: unknown; capabilityId: string };
    assertEquals(output.capabilityId, "cap-123-abc", "Should return capabilityId");

    const innerResult = output.result as { executed: boolean; computed: number };
    assert(innerResult.executed, "Capability should execute");
    assertEquals(innerResult.computed, 4, "Capability should compute 2+2=4");

    console.log("  ✓ capability task executed with capabilityId in context");
  });

  await t.step("AC3: capability task receives dependencies", async () => {
    const executor = new ControlledExecutor(mockToolExecutor, { taskTimeout: 30000 });

    // DAG with MCP task followed by capability that depends on it
    const dag: DAGStructure = {
      tasks: [
        {
          id: "fetch_task",
          type: "mcp_tool",
          tool: "api:getData",
          arguments: { key: "test_data" },
          dependsOn: [],
        },
        {
          id: "process_capability",
          type: "capability",
          tool: "sandbox",
          capabilityId: "cap-process-data",
          code: `
            // deps contains results from dependent tasks
            const fetchResult = deps.fetch_task;
            return {
              processed: true,
              inputStatus: fetchResult.status,
              hasData: !!fetchResult.output
            };
          `,
          arguments: {},
          dependsOn: ["fetch_task"],
        },
      ],
    };

    const result = await executor.execute(dag);

    assertEquals(result.errors.length, 0, "Should have no errors");
    assertEquals(result.results.length, 2, "Should have 2 results");

    const capResult = result.results.find((r) => r.taskId === "process_capability");
    assertExists(capResult, "Capability task should exist");
    assertEquals(capResult?.status, "success", "Capability should succeed");

    const output = capResult?.output as { result: { processed: boolean; inputStatus: string } };
    assert(output.result.processed, "Should mark as processed");
    assertEquals(output.result.inputStatus, "success", "Should receive dependency status");

    console.log("  ✓ capability task received dependency results");
  });

  await t.step("AC3: capability task error is properly captured", async () => {
    const executor = new ControlledExecutor(mockToolExecutor, { taskTimeout: 30000 });

    const dag: DAGStructure = {
      tasks: [
        {
          id: "error_capability",
          type: "capability",
          tool: "sandbox",
          capabilityId: "cap-error-test",
          code: `throw new Error("Intentional capability error");`,
          arguments: {},
          dependsOn: [],
        },
      ],
    };

    const result = await executor.execute(dag);

    assertEquals(result.results.length, 1, "Should have 1 result");
    assertEquals(result.errors.length, 1, "Should have 1 error");

    const errorResult = result.results[0];
    assertEquals(errorResult.status, "error", "Task should be marked as error");
    assertExists(errorResult.error, "Should have error message");
    assert(
      errorResult.error?.includes("Intentional capability error"),
      "Error message should be captured",
    );

    console.log("  ✓ capability task error properly captured");
  });

  await t.step("AC3: capability task missing capabilityId fails with clear error", async () => {
    const executor = new ControlledExecutor(mockToolExecutor, { taskTimeout: 30000 });

    const dag: DAGStructure = {
      tasks: [
        {
          id: "missing_id_task",
          type: "capability",
          tool: "sandbox",
          // capabilityId intentionally missing
          code: `return { test: true };`,
          arguments: {},
          dependsOn: [],
        },
      ],
    };

    const result = await executor.execute(dag);

    assertEquals(result.errors.length, 1, "Should have 1 error");

    const errorResult = result.results[0];
    assertEquals(errorResult.status, "error", "Task should fail");
    assert(
      errorResult.error?.includes("capabilityId"),
      "Error should mention missing capabilityId",
    );

    console.log("  ✓ capability task without capabilityId fails with clear error");
  });

  await t.step(
    "AC3: capability task without code and no CapabilityStore fails clearly",
    async () => {
      const executor = new ControlledExecutor(mockToolExecutor, { taskTimeout: 30000 });
      // Note: setLearningDependencies() NOT called - no CapabilityStore configured

      const dag: DAGStructure = {
        tasks: [
          {
            id: "no_code_task",
            type: "capability",
            tool: "sandbox",
            capabilityId: "cap-123-no-store",
            // code intentionally missing - should try to fetch from store
            arguments: {},
            dependsOn: [],
          },
        ],
      };

      const result = await executor.execute(dag);

      assertEquals(result.errors.length, 1, "Should have 1 error");

      const errorResult = result.results[0];
      assertEquals(errorResult.status, "error", "Task should fail");
      assert(
        errorResult.error?.includes("CapabilityStore is not configured"),
        "Error should mention CapabilityStore not configured",
      );

      console.log("  ✓ capability task without code and no store fails with clear error");
    },
  );

  await t.step("AC5: backward compatibility - MCP-only workflow unchanged", async () => {
    const executor = new ControlledExecutor(mockToolExecutor, { taskTimeout: 30000 });

    // Classic MCP-only workflow (no code_execution or capability tasks)
    const dag: DAGStructure = {
      tasks: [
        {
          id: "mcp_task_1",
          type: "mcp_tool",
          tool: "server1:tool_a",
          arguments: { param: "value1" },
          dependsOn: [],
        },
        {
          id: "mcp_task_2",
          type: "mcp_tool",
          tool: "server2:tool_b",
          arguments: { param: "value2" },
          dependsOn: [],
        },
        {
          id: "mcp_task_3",
          tool: "server1:tool_c", // No explicit type = defaults to mcp_tool
          arguments: { input: "test" },
          dependsOn: ["mcp_task_1", "mcp_task_2"],
        },
      ],
    };

    const result = await executor.execute(dag);

    assertEquals(result.errors.length, 0, "Should have no errors");
    assertEquals(result.results.length, 3, "Should have 3 results");

    // All tasks should succeed via MCP tool executor
    for (const taskResult of result.results) {
      assertEquals(taskResult.status, "success", `Task ${taskResult.taskId} should succeed`);
    }

    // Verify parallel execution happened (tasks 1 and 2 in parallel)
    assert(result.parallelizationLayers >= 2, "Should have parallel layers");

    console.log("  ✓ MCP-only workflow executes unchanged (backward compatible)");
  });

  await t.step("mixed MCP, code_execution, and capability tasks", async () => {
    const executor = new ControlledExecutor(mockToolExecutor, { taskTimeout: 30000 });

    // DAG with all three task types
    const dag: DAGStructure = {
      tasks: [
        {
          id: "mcp_fetch",
          type: "mcp_tool",
          tool: "api:fetch",
          arguments: { url: "test" },
          dependsOn: [],
        },
        {
          id: "code_transform",
          type: "code_execution",
          tool: "sandbox",
          code: `
            const input = deps.mcp_fetch;
            return { transformed: true, source: "code_execution" };
          `,
          arguments: {},
          dependsOn: ["mcp_fetch"],
        },
        {
          id: "capability_process",
          type: "capability",
          tool: "sandbox",
          capabilityId: "cap-final-process",
          code: `
            const transformed = deps.code_transform;
            return {
              final: true,
              source: "capability",
              inputSource: transformed.output?.result?.source
            };
          `,
          arguments: {},
          dependsOn: ["code_transform"],
        },
      ],
    };

    const result = await executor.execute(dag);

    assertEquals(result.errors.length, 0, "Should have no errors");
    assertEquals(result.results.length, 3, "Should have 3 results");

    // Verify each task type executed correctly
    const mcpResult = result.results.find((r) => r.taskId === "mcp_fetch");
    const codeResult = result.results.find((r) => r.taskId === "code_transform");
    const capResult = result.results.find((r) => r.taskId === "capability_process");

    assertEquals(mcpResult?.status, "success", "MCP task should succeed");
    assertEquals(codeResult?.status, "success", "Code task should succeed");
    assertEquals(capResult?.status, "success", "Capability task should succeed");

    console.log("  ✓ Mixed MCP, code_execution, and capability tasks all route correctly");
  });
});
