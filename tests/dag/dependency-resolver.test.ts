/**
 * Unit Tests: Dependency Resolver
 *
 * Tests for M2 fix: resolveDependencies() shared utility extracted from
 * code-executor and capability-executor to eliminate code duplication.
 *
 * @module tests/dag/dependency-resolver
 */

import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { resolveDependencies } from "../../src/dag/execution/dependency-resolver.ts";
import type { TaskResult } from "../../src/dag/types.ts";

Deno.test("Dependency Resolver - M2 Fix Validation", async (t) => {
  await t.step("All dependencies found and successful → returns map", () => {
    const previousResults = new Map<string, TaskResult>([
      ["task1", {
        taskId: "task1",
        status: "success",
        output: { data: "result1" },
        executionTimeMs: 100,
      }],
      ["task2", {
        taskId: "task2",
        status: "success",
        output: { data: "result2" },
        executionTimeMs: 200,
      }],
    ]);

    const deps = resolveDependencies(["task1", "task2"], previousResults);

    assertEquals(Object.keys(deps).length, 2);
    assertEquals(deps["task1"].status, "success");
    assertEquals(deps["task1"].output, { data: "result1" });
    assertEquals(deps["task2"].status, "success");
    assertEquals(deps["task2"].output, { data: "result2" });
  });

  await t.step("Dependency has status 'error' → throws error", () => {
    const previousResults = new Map<string, TaskResult>([
      ["task1", { taskId: "task1", status: "success", output: { data: "ok" } }],
      ["task2", { taskId: "task2", status: "error", error: "Task failed with timeout" }],
    ]);

    assertThrows(
      () => resolveDependencies(["task1", "task2"], previousResults),
      Error,
      "Dependency task task2 failed: Task failed with timeout",
    );
  });

  await t.step("Dependency not found in results → throws error", () => {
    const previousResults = new Map<string, TaskResult>([
      ["task1", { taskId: "task1", status: "success", output: { data: "ok" } }],
    ]);

    assertThrows(
      () => resolveDependencies(["task1", "task_missing"], previousResults),
      Error,
      "Dependency task task_missing not found in results",
    );
  });

  await t.step("Dependency has status 'failed_safe' → includes in map (resilient)", () => {
    // Story 3.5: Safe-to-fail tasks should be included in dependencies
    const previousResults = new Map<string, TaskResult>([
      ["task1", { taskId: "task1", status: "success", output: { data: "ok" } }],
      ["task2", {
        taskId: "task2",
        status: "failed_safe" as const,
        output: null,
        error: "Optional task failed",
      }],
    ]);

    const deps = resolveDependencies(["task1", "task2"], previousResults);

    assertEquals(Object.keys(deps).length, 2);
    assertEquals(deps["task1"].status, "success");
    assertEquals(deps["task2"].status, "failed_safe");
    assertEquals(deps["task2"].output, null);
    assertEquals(deps["task2"].error, "Optional task failed");
  });

  await t.step("Empty dependsOn array → returns empty map", () => {
    const previousResults = new Map<string, TaskResult>([
      ["task1", { taskId: "task1", status: "success", output: { data: "ok" } }],
    ]);

    const deps = resolveDependencies([], previousResults);

    assertEquals(Object.keys(deps).length, 0);
    assertEquals(deps, {});
  });

  await t.step("Multiple dependencies mixed statuses → correct behavior", () => {
    const previousResults = new Map<string, TaskResult>([
      ["task1", { taskId: "task1", status: "success", output: { data: "ok" } }],
      ["task2", { taskId: "task2", status: "failed_safe" as const, output: null }],
      ["task3", { taskId: "task3", status: "success", output: { data: "good" } }],
    ]);

    const deps = resolveDependencies(["task1", "task2", "task3"], previousResults);

    assertEquals(Object.keys(deps).length, 3);
    assertEquals(deps["task1"].status, "success");
    assertEquals(deps["task2"].status, "failed_safe");
    assertEquals(deps["task3"].status, "success");
  });

  await t.step("First dependency missing → throws before checking others", () => {
    const previousResults = new Map<string, TaskResult>([
      ["task2", { taskId: "task2", status: "success", output: {} }],
    ]);

    assertThrows(
      () => resolveDependencies(["task1_missing", "task2"], previousResults),
      Error,
      "not found in results",
    );
  });

  await t.step("First dependency failed → throws before checking others", () => {
    const previousResults = new Map<string, TaskResult>([
      ["task1", { taskId: "task1", status: "error", error: "First failed" }],
      ["task2", { taskId: "task2", status: "success", output: {} }],
    ]);

    assertThrows(
      () => resolveDependencies(["task1", "task2"], previousResults),
      Error,
      "Dependency task task1 failed",
    );
  });

  await t.step("Dependency with null output → included (valid for failed_safe)", () => {
    const previousResults = new Map<string, TaskResult>([
      ["task1", { taskId: "task1", status: "success", output: null }], // Null output is valid
    ]);

    const deps = resolveDependencies(["task1"], previousResults);

    assertEquals(deps["task1"].output, null);
    assertEquals(deps["task1"].status, "success");
  });

  await t.step("Dependency with complex nested output → preserved", () => {
    const complexOutput = {
      nested: {
        data: [1, 2, 3],
        metadata: { version: "1.0", timestamp: 123456 },
      },
      array: ["a", "b", "c"],
    };

    const previousResults = new Map<string, TaskResult>([
      ["task1", { taskId: "task1", status: "success", output: complexOutput }],
    ]);

    const deps = resolveDependencies(["task1"], previousResults);

    assertEquals(deps["task1"].output, complexOutput);
  });

  await t.step("Preserves full TaskResult structure (not just output)", () => {
    // Story 3.5: Store full TaskResult for resilient patterns
    const previousResults = new Map<string, TaskResult>([
      [
        "task1",
        {
          taskId: "task1",
          status: "success",
          output: { result: "data" },
          executionTimeMs: 500,
        },
      ],
    ]);

    const deps = resolveDependencies(["task1"], previousResults);

    assertEquals(deps["task1"].taskId, "task1");
    assertEquals(deps["task1"].status, "success");
    assertEquals(deps["task1"].output, { result: "data" });
    assertEquals(deps["task1"].executionTimeMs, 500);
  });

  await t.step("Error message includes task ID for debugging", () => {
    const previousResults = new Map<string, TaskResult>([
      ["fetch_user_data", { taskId: "fetch_user_data", status: "error", error: "Network timeout" }],
    ]);

    try {
      resolveDependencies(["fetch_user_data"], previousResults);
      throw new Error("Should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      assertEquals(message.includes("fetch_user_data"), true, "Error should include task ID");
      assertEquals(
        message.includes("Network timeout"),
        true,
        "Error should include original error message",
      );
    }
  });

  await t.step(
    "Duplicate dependency IDs → deduplication not required (caller responsibility)",
    () => {
      // If caller passes duplicates, we don't deduplicate - just process all
      const previousResults = new Map<string, TaskResult>([
        ["task1", { taskId: "task1", status: "success", output: { data: "ok" } }],
      ]);

      const deps = resolveDependencies(["task1", "task1"], previousResults);

      // Both references should point to same TaskResult
      assertEquals(deps["task1"].status, "success");
    },
  );

  await t.step("Real-world: Code execution with MCP dependency", () => {
    const previousResults = new Map<string, TaskResult>([
      [
        "fetch_data",
        {
          taskId: "fetch_data",
          status: "success",
          output: { result: 'mcp_server:getData_{"key":"test"}' },
          executionTimeMs: 150,
        },
      ],
    ]);

    const deps = resolveDependencies(["fetch_data"], previousResults);

    assertEquals(deps["fetch_data"].status, "success");
    assertEquals(typeof deps["fetch_data"].output, "object");
  });

  await t.step("Real-world: Capability with multiple dependencies", () => {
    const previousResults = new Map<string, TaskResult>([
      ["mcp_fetch", { taskId: "mcp_fetch", status: "success", output: { data: [1, 2, 3] } }],
      ["code_transform", {
        taskId: "code_transform",
        status: "success",
        output: { result: { transformed: true } },
      }],
      ["optional_check", {
        taskId: "optional_check",
        status: "failed_safe" as const,
        output: null,
      }],
    ]);

    const deps = resolveDependencies(
      ["mcp_fetch", "code_transform", "optional_check"],
      previousResults,
    );

    assertEquals(Object.keys(deps).length, 3);
    assertEquals(deps["mcp_fetch"].status, "success");
    assertEquals(deps["code_transform"].status, "success");
    assertEquals(deps["optional_check"].status, "failed_safe");
  });
});
