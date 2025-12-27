/**
 * Integration Tests: Code Execution in DAG
 *
 * Tests for code_execution task type routing through ControlledExecutor.
 * Verifies AC1, AC2, AC4 from tech-spec.
 */

import { assert, assertEquals, assertExists } from "jsr:@std/assert@1";
import { ControlledExecutor } from "../../src/dag/controlled-executor.ts";
import type { DAGStructure } from "../../src/graphrag/types.ts";
import type { ToolExecutor } from "../../src/dag/types.ts";

Deno.test("DAG code_execution integration", async (t) => {
  // Mock tool executor for MCP tools
  const mockToolExecutor: ToolExecutor = async (
    toolName: string,
    args: Record<string, unknown>,
  ) => {
    // Simulate MCP tool execution
    return { result: `mcp_${toolName}_${JSON.stringify(args)}` };
  };

  await t.step("AC1: code_execution task routes to sandbox", async () => {
    const executor = new ControlledExecutor(mockToolExecutor, { taskTimeout: 30000 });

    // DAG with code_execution task
    const dag: DAGStructure = {
      tasks: [
        {
          id: "code_task",
          type: "code_execution",
          tool: "sandbox", // Not used for code_execution
          code: "return { computed: 1 + 1 };",
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

    const output = taskResult.output as { result: unknown };
    assertEquals(
      (output.result as { computed: number }).computed,
      2,
      "Sandbox should compute 1+1=2",
    );

    console.log("  ✓ code_execution task executed in sandbox");
  });

  await t.step("AC2: mixed task types route correctly", async () => {
    const executor = new ControlledExecutor(mockToolExecutor, { taskTimeout: 30000 });

    // DAG with mixed task types: MCP tool + code_execution
    const dag: DAGStructure = {
      tasks: [
        {
          id: "mcp_task",
          type: "mcp_tool", // Explicitly MCP
          tool: "test_server:get_data",
          arguments: { key: "test" },
          dependsOn: [],
        },
        {
          id: "process_task",
          type: "code_execution",
          tool: "sandbox",
          code: `
            const mcpResult = deps.mcp_task;
            return { processed: true, input: mcpResult.output };
          `,
          arguments: {},
          dependsOn: ["mcp_task"],
        },
      ],
    };

    const result = await executor.execute(dag);

    assertEquals(result.errors.length, 0, "Should have no errors");
    assertEquals(result.results.length, 2, "Should have 2 results");

    // Verify MCP task
    const mcpResult = result.results.find((r) => r.taskId === "mcp_task");
    assertExists(mcpResult, "MCP task should exist");
    assertEquals(mcpResult?.status, "success", "MCP task should succeed");

    // Verify code_execution task
    const codeResult = result.results.find((r) => r.taskId === "process_task");
    assertExists(codeResult, "Code task should exist");
    assertEquals(codeResult?.status, "success", "Code task should succeed");

    console.log("  ✓ Mixed MCP and code_execution tasks routed correctly");
  });

  await t.step("code_execution with dependencies receives context", async () => {
    const executor = new ControlledExecutor(mockToolExecutor, { taskTimeout: 30000 });

    // DAG where code_execution depends on MCP result
    const dag: DAGStructure = {
      tasks: [
        {
          id: "fetch_data",
          type: "mcp_tool",
          tool: "api:fetch",
          arguments: { url: "test" },
          dependsOn: [],
        },
        {
          id: "transform_data",
          type: "code_execution",
          tool: "sandbox",
          code: `
            // deps contains results from dependent tasks
            if (!deps.fetch_data) {
              throw new Error("Missing dependency: fetch_data");
            }
            const data = deps.fetch_data;
            return {
              transformed: true,
              status: data.status,
              hasOutput: !!data.output
            };
          `,
          arguments: {},
          dependsOn: ["fetch_data"],
        },
      ],
    };

    const result = await executor.execute(dag);

    assertEquals(result.errors.length, 0, "Should have no errors");

    const transformResult = result.results.find((r) => r.taskId === "transform_data");
    assertExists(transformResult, "Transform task should exist");
    assertEquals(transformResult?.status, "success", "Transform should succeed");

    const output = transformResult?.output as {
      result: { transformed: boolean; hasOutput: boolean };
    };
    assert(output.result.transformed, "Should mark as transformed");
    assert(output.result.hasOutput, "Should have received dependency output");

    console.log("  ✓ code_execution task received dependency context");
  });

  await t.step("code_execution error is properly captured", async () => {
    const executor = new ControlledExecutor(mockToolExecutor, { taskTimeout: 30000 });

    const dag: DAGStructure = {
      tasks: [
        {
          id: "error_task",
          type: "code_execution",
          tool: "sandbox",
          code: `throw new Error("Intentional test error");`,
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
      errorResult.error?.includes("Intentional test error"),
      "Error message should be captured",
    );

    console.log("  ✓ code_execution error properly captured");
  });
});
