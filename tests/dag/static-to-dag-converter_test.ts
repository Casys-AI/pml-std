/**
 * Tests for Static Structure to DAG Converter (Story 10.5)
 *
 * @module tests/dag/static-to-dag-converter_test
 */

import { assertEquals, assertExists } from "@std/assert";
import {
  estimateParallelLayers,
  getToolsFromStaticStructure,
  isValidForDagConversion,
  staticStructureToDag,
} from "../../src/dag/static-to-dag-converter.ts";
import type { StaticStructure } from "../../src/capabilities/types.ts";

// =============================================================================
// Test Data Fixtures
// =============================================================================

const simpleSequentialStructure: StaticStructure = {
  nodes: [
    { id: "n1", type: "task", tool: "fs:read_file" },
    { id: "n2", type: "task", tool: "json:parse" },
    { id: "n3", type: "task", tool: "db:insert" },
  ],
  edges: [
    { from: "n1", to: "n2", type: "sequence" },
    { from: "n2", to: "n3", type: "sequence" },
  ],
};

const parallelStructure: StaticStructure = {
  nodes: [
    { id: "f1", type: "fork" },
    { id: "n1", type: "task", tool: "api:fetch_users" },
    { id: "n2", type: "task", tool: "api:fetch_posts" },
    { id: "n3", type: "task", tool: "api:fetch_comments" },
    { id: "j1", type: "join" },
  ],
  edges: [
    { from: "f1", to: "n1", type: "sequence" },
    { from: "f1", to: "n2", type: "sequence" },
    { from: "f1", to: "n3", type: "sequence" },
    { from: "n1", to: "j1", type: "sequence" },
    { from: "n2", to: "j1", type: "sequence" },
    { from: "n3", to: "j1", type: "sequence" },
  ],
};

const conditionalStructure: StaticStructure = {
  nodes: [
    { id: "n1", type: "task", tool: "api:get_user" },
    { id: "d1", type: "decision", condition: "user.isAdmin" },
    { id: "n2", type: "task", tool: "admin:dashboard" },
    { id: "n3", type: "task", tool: "user:profile" },
  ],
  edges: [
    { from: "n1", to: "d1", type: "sequence" },
    { from: "d1", to: "n2", type: "conditional", outcome: "true" },
    { from: "d1", to: "n3", type: "conditional", outcome: "false" },
  ],
};

const capabilityStructure: StaticStructure = {
  nodes: [
    { id: "n1", type: "task", tool: "fs:read_file" },
    { id: "c1", type: "capability", capabilityId: "parse-json-safely" },
    { id: "n2", type: "task", tool: "db:insert" },
  ],
  edges: [
    { from: "n1", to: "c1", type: "provides" },
    { from: "c1", to: "n2", type: "sequence" },
  ],
};

const emptyStructure: StaticStructure = {
  nodes: [],
  edges: [],
};

const forkJoinOnlyStructure: StaticStructure = {
  nodes: [
    { id: "f1", type: "fork" },
    { id: "j1", type: "join" },
  ],
  edges: [{ from: "f1", to: "j1", type: "sequence" }],
};

// =============================================================================
// AC1: staticStructureToDag Conversion Tests
// =============================================================================

Deno.test("staticStructureToDag - converts simple sequential structure", () => {
  const dag = staticStructureToDag(simpleSequentialStructure);

  assertEquals(dag.tasks.length, 3);
  assertEquals(dag.tasks[0].tool, "fs:read_file");
  assertEquals(dag.tasks[1].tool, "json:parse");
  assertEquals(dag.tasks[2].tool, "db:insert");

  // Check dependencies
  assertEquals(dag.tasks[0].dependsOn, []);
  assertEquals(dag.tasks[1].dependsOn, ["task_n1"]);
  assertEquals(dag.tasks[2].dependsOn, ["task_n2"]);
});

Deno.test("staticStructureToDag - converts parallel fork/join structure", () => {
  const dag = staticStructureToDag(parallelStructure);

  // Fork and join are not tasks, only the 3 actual tasks
  assertEquals(dag.tasks.length, 3);

  const tools = dag.tasks.map((t) => t.tool);
  assertEquals(tools.includes("api:fetch_users"), true);
  assertEquals(tools.includes("api:fetch_posts"), true);
  assertEquals(tools.includes("api:fetch_comments"), true);
});

Deno.test("staticStructureToDag - converts capability nodes", () => {
  const dag = staticStructureToDag(capabilityStructure);

  assertEquals(dag.tasks.length, 3);

  const capabilityTask = dag.tasks.find((t) => t.type === "capability");
  assertExists(capabilityTask);
  assertEquals(capabilityTask.capabilityId, "parse-json-safely");
});

Deno.test("staticStructureToDag - handles conditional branches (AC4)", () => {
  const dag = staticStructureToDag(conditionalStructure);

  // Decision node is not a task by default
  assertEquals(dag.tasks.length, 3);

  // Find tasks with conditions
  const adminTask = dag.tasks.find((t) => t.tool === "admin:dashboard");
  const userTask = dag.tasks.find((t) => t.tool === "user:profile");

  assertExists(adminTask);
  assertExists(userTask);

  // Both should have conditions
  assertExists(adminTask.condition);
  assertEquals(adminTask.condition?.requiredOutcome, "true");

  assertExists(userTask.condition);
  assertEquals(userTask.condition?.requiredOutcome, "false");
});

Deno.test("staticStructureToDag - respects taskIdPrefix option", () => {
  const dag = staticStructureToDag(simpleSequentialStructure, {
    taskIdPrefix: "exec_",
  });

  assertEquals(dag.tasks[0].id, "exec_n1");
  assertEquals(dag.tasks[1].id, "exec_n2");
  assertEquals(dag.tasks[1].dependsOn, ["exec_n1"]);
});

Deno.test("staticStructureToDag - can include decision tasks", () => {
  const dag = staticStructureToDag(conditionalStructure, {
    includeDecisionTasks: true,
  });

  // Now includes decision node as a task
  const decisionTask = dag.tasks.find((t) => t.tool === "internal:decision");
  assertExists(decisionTask);
});

// =============================================================================
// AC6: isValidForDagConversion Tests
// =============================================================================

Deno.test("isValidForDagConversion - returns true for valid structure", () => {
  assertEquals(isValidForDagConversion(simpleSequentialStructure), true);
  assertEquals(isValidForDagConversion(parallelStructure), true);
  assertEquals(isValidForDagConversion(capabilityStructure), true);
});

Deno.test("isValidForDagConversion - returns false for empty structure", () => {
  assertEquals(isValidForDagConversion(emptyStructure), false);
});

Deno.test("isValidForDagConversion - returns false for structure with only fork/join", () => {
  assertEquals(isValidForDagConversion(forkJoinOnlyStructure), false);
});

// =============================================================================
// Utility Function Tests
// =============================================================================

Deno.test("getToolsFromStaticStructure - extracts tool IDs", () => {
  const tools = getToolsFromStaticStructure(simpleSequentialStructure);

  assertEquals(tools.length, 3);
  assertEquals(tools, ["fs:read_file", "json:parse", "db:insert"]);
});

Deno.test("estimateParallelLayers - sequential structure", () => {
  const layers = estimateParallelLayers(simpleSequentialStructure);
  assertEquals(layers, 3); // 3 tasks = 3 layers in sequential
});

Deno.test("estimateParallelLayers - parallel structure", () => {
  const layers = estimateParallelLayers(parallelStructure);
  // Layer 1: 3 parallel tasks (n1, n2, n3) after fork
  // Layer 2: join point (j1) waits for all parallel tasks
  // Fork/join nodes don't add layers, they structure parallelism
  assertEquals(layers, 2);
});
