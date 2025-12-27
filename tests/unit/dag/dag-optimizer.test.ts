/**
 * Unit tests for DAG Optimizer (Phase 2)
 *
 * Tests the fusion logic for sequential code operations.
 */

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  canFuseTasks,
  fuseTasks,
  optimizeDAG,
  type OptimizedDAGStructure,
} from "../../../src/dag/dag-optimizer.ts";
import type { DAGStructure, Task } from "../../../src/graphrag/types.ts";

// =============================================================================
// Test: canFuseTasks
// =============================================================================

Deno.test("canFuseTasks - returns true for fusible tasks", () => {
  const tasks: Task[] = [
    {
      id: "task_c1",
      type: "code_execution",
      tool: "code:filter",
      code: "data.filter(x => x.active)",
      arguments: {},
      dependsOn: [],
      sandboxConfig: { permissionSet: "minimal" },
      metadata: { pure: true },
    },
    {
      id: "task_c2",
      type: "code_execution",
      tool: "code:map",
      code: "data.map(x => x.name)",
      arguments: {},
      dependsOn: ["task_c1"],
      sandboxConfig: { permissionSet: "minimal" },
      metadata: { pure: true },
    },
  ];

  assert(canFuseTasks(tasks), "Should be able to fuse pure code tasks");
});

Deno.test("canFuseTasks - returns false for MCP tasks", () => {
  const tasks: Task[] = [
    {
      id: "task_n1",
      type: "mcp_tool",
      tool: "db:query",
      arguments: {},
      dependsOn: [],
    },
    {
      id: "task_c1",
      type: "code_execution",
      tool: "code:filter",
      code: "data.filter(x => x.active)",
      arguments: {},
      dependsOn: ["task_n1"],
    },
  ];

  assertEquals(canFuseTasks(tasks), false, "Should not fuse MCP tasks");
});

Deno.test("canFuseTasks - returns false for tasks with MCP calls in code", () => {
  const tasks: Task[] = [
    {
      id: "task_c1",
      type: "code_execution",
      tool: "code:filter",
      code: "await mcp.db.query()", // ← MCP call in code!
      arguments: {},
      dependsOn: [],
      sandboxConfig: { permissionSet: "minimal" },
    },
  ];

  assertEquals(canFuseTasks(tasks), false, "Should not fuse tasks with MCP calls");
});

Deno.test("canFuseTasks - returns false for different permission sets", () => {
  const tasks: Task[] = [
    {
      id: "task_c1",
      type: "code_execution",
      tool: "code:filter",
      code: "data.filter(x => x.active)",
      arguments: {},
      dependsOn: [],
      sandboxConfig: { permissionSet: "minimal" },
    },
    {
      id: "task_c2",
      type: "code_execution",
      tool: "code:map",
      code: "data.map(x => x.name)",
      arguments: {},
      dependsOn: ["task_c1"],
      sandboxConfig: { permissionSet: "full" }, // ← Different!
    },
  ];

  assertEquals(canFuseTasks(tasks), false, "Should not fuse tasks with different permissions");
});

// =============================================================================
// Test: fuseTasks
// =============================================================================

Deno.test("fuseTasks - creates fused task with combined code", () => {
  const tasks: Task[] = [
    {
      id: "task_c1",
      type: "code_execution",
      tool: "code:filter",
      code: "const active = data.filter(x => x.active);",
      arguments: {},
      dependsOn: ["task_n1"],
      sandboxConfig: { permissionSet: "minimal" },
    },
    {
      id: "task_c2",
      type: "code_execution",
      tool: "code:map",
      code: "const names = active.map(x => x.name);",
      arguments: {},
      dependsOn: ["task_c1"],
      sandboxConfig: { permissionSet: "minimal" },
    },
  ];

  const fused = fuseTasks(tasks);

  assertEquals(fused.id, "fused_task_c1");
  assertEquals(fused.type, "code_execution");
  assertEquals(fused.tool, "code:computation");
  assert(fused.code?.includes("filter"), "Should include filter code");
  assert(fused.code?.includes("map"), "Should include map code");
  assertEquals(fused.dependsOn, ["task_n1"], "Should preserve external dependencies");
  assertEquals(fused.metadata?.fusedFrom, ["task_c1", "task_c2"]);
  assertEquals(fused.metadata?.logicalTools, ["code:filter", "code:map"]);
});

Deno.test("fuseTasks - preserves external dependencies", () => {
  const tasks: Task[] = [
    {
      id: "task_c1",
      type: "code_execution",
      tool: "code:filter",
      code: "data.filter(x => x.active)",
      arguments: {},
      dependsOn: ["task_n1"], // External dependency
      sandboxConfig: { permissionSet: "minimal" },
    },
    {
      id: "task_c2",
      type: "code_execution",
      tool: "code:map",
      code: "data.map(x => x.name)",
      arguments: {},
      dependsOn: ["task_c1"], // Internal dependency
      sandboxConfig: { permissionSet: "minimal" },
    },
    {
      id: "task_c3",
      type: "code_execution",
      tool: "code:sort",
      code: "data.sort()",
      arguments: {},
      dependsOn: ["task_c2", "task_n2"], // Mixed: internal + external
      sandboxConfig: { permissionSet: "minimal" },
    },
  ];

  const fused = fuseTasks(tasks);

  // Should only have external dependencies
  assertEquals(fused.dependsOn.sort(), ["task_n1", "task_n2"].sort());
});

// =============================================================================
// Test: optimizeDAG
// =============================================================================

Deno.test("optimizeDAG - fuses sequential code tasks", () => {
  const logicalDAG: DAGStructure = {
    tasks: [
      {
        id: "task_n1",
        type: "mcp_tool",
        tool: "db:query",
        arguments: {},
        dependsOn: [],
      },
      {
        id: "task_c1",
        type: "code_execution",
        tool: "code:filter",
        code: "data.filter(x => x.active)",
        arguments: {},
        dependsOn: ["task_n1"],
        sandboxConfig: { permissionSet: "minimal" },
        metadata: { pure: true },
      },
      {
        id: "task_c2",
        type: "code_execution",
        tool: "code:map",
        code: "data.map(x => x.name)",
        arguments: {},
        dependsOn: ["task_c1"],
        sandboxConfig: { permissionSet: "minimal" },
        metadata: { pure: true },
      },
      {
        id: "task_c3",
        type: "code_execution",
        tool: "code:sort",
        code: "data.sort()",
        arguments: {},
        dependsOn: ["task_c2"],
        sandboxConfig: { permissionSet: "minimal" },
        metadata: { pure: true },
      },
    ],
  };

  const optimized = optimizeDAG(logicalDAG);

  // Should have 2 physical tasks: MCP + fused code
  assertEquals(optimized.tasks.length, 2);

  // First task should be MCP (unchanged)
  assertEquals(optimized.tasks[0].id, "task_n1");
  assertEquals(optimized.tasks[0].type, "mcp_tool");

  // Second task should be fused
  assertEquals(optimized.tasks[1].id, "fused_task_c1");
  assertEquals(optimized.tasks[1].type, "code_execution");
  assertEquals(optimized.tasks[1].metadata?.fusedFrom, ["task_c1", "task_c2", "task_c3"]);

  // Check mappings
  assertEquals(optimized.logicalToPhysical.get("task_c1"), "fused_task_c1");
  assertEquals(optimized.logicalToPhysical.get("task_c2"), "fused_task_c1");
  assertEquals(optimized.logicalToPhysical.get("task_c3"), "fused_task_c1");

  assertEquals(optimized.physicalToLogical.get("fused_task_c1"), ["task_c1", "task_c2", "task_c3"]);
});

Deno.test("optimizeDAG - keeps MCP tasks separate", () => {
  const logicalDAG: DAGStructure = {
    tasks: [
      {
        id: "task_n1",
        type: "mcp_tool",
        tool: "db:query",
        arguments: {},
        dependsOn: [],
      },
      {
        id: "task_c1",
        type: "code_execution",
        tool: "code:filter",
        code: "data.filter(x => x.active)",
        arguments: {},
        dependsOn: ["task_n1"],
        sandboxConfig: { permissionSet: "minimal" },
      },
      {
        id: "task_n2",
        type: "mcp_tool",
        tool: "db:insert",
        arguments: {},
        dependsOn: ["task_c1"],
      },
    ],
  };

  const optimized = optimizeDAG(logicalDAG);

  // Should have 3 tasks: MCP, code (single, can't fuse), MCP
  assertEquals(optimized.tasks.length, 3);
  assertEquals(optimized.tasks[0].type, "mcp_tool");
  assertEquals(optimized.tasks[1].type, "code_execution");
  assertEquals(optimized.tasks[2].type, "mcp_tool");
});

Deno.test("optimizeDAG - handles fork points correctly", () => {
  const logicalDAG: DAGStructure = {
    tasks: [
      {
        id: "task_c1",
        type: "code_execution",
        tool: "code:filter",
        code: "data.filter(x => x.active)",
        arguments: {},
        dependsOn: [],
        sandboxConfig: { permissionSet: "minimal" },
      },
      {
        id: "task_c2",
        type: "code_execution",
        tool: "code:map",
        code: "data.map(x => x.name)",
        arguments: {},
        dependsOn: ["task_c1"], // Depends on c1
        sandboxConfig: { permissionSet: "minimal" },
      },
      {
        id: "task_c3",
        type: "code_execution",
        tool: "code:reduce",
        code: "data.reduce((a,b) => a+b, 0)",
        arguments: {},
        dependsOn: ["task_c1"], // Also depends on c1 → FORK!
        sandboxConfig: { permissionSet: "minimal" },
      },
    ],
  };

  const optimized = optimizeDAG(logicalDAG);

  // Should NOT fuse c1→c2→c3 because c1 has two dependents (fork)
  // Should have 3 separate tasks
  assertEquals(optimized.tasks.length, 3);
});

Deno.test("optimizeDAG - disabled optimization returns logical DAG", () => {
  const logicalDAG: DAGStructure = {
    tasks: [
      {
        id: "task_c1",
        type: "code_execution",
        tool: "code:filter",
        code: "data.filter(x => x.active)",
        arguments: {},
        dependsOn: [],
        sandboxConfig: { permissionSet: "minimal" },
      },
    ],
  };

  const optimized = optimizeDAG(logicalDAG, { enabled: false });

  assertEquals(optimized.tasks.length, 1);
  assertEquals(optimized.tasks[0].id, "task_c1");
  assertEquals(optimized.logicalToPhysical.get("task_c1"), "task_c1");
});

Deno.test("optimizeDAG - respects maxFusionSize", () => {
  const logicalDAG: DAGStructure = {
    tasks: Array.from({ length: 20 }, (_, i) => ({
      id: `task_c${i + 1}`,
      type: "code_execution" as const,
      tool: "code:map",
      code: `data.map(x => x.field${i})`,
      arguments: {},
      dependsOn: i === 0 ? [] : [`task_c${i}`],
      sandboxConfig: { permissionSet: "minimal" as const },
      metadata: { pure: true },
    })),
  };

  const optimized = optimizeDAG(logicalDAG, { maxFusionSize: 5 });

  // Should create multiple fused tasks, each with max 5 logical tasks
  assert(optimized.tasks.length >= 4, "Should create multiple fused chunks");
  assert(optimized.tasks.length < 20, "Should fuse some tasks");
});
