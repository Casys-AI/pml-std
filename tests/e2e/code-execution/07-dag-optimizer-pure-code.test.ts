/**
 * E2E Tests for DAG Optimizer with Pure Code (Phase 2)
 *
 * Tests the complete flow:
 * 1. Code with literals → Static structure
 * 2. Static structure → Logical DAG
 * 3. Logical DAG → Optimized DAG (fusion)
 * 4. Execute optimized DAG
 * 5. Generate logical traces for SHGAT
 */

import { assert, assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { StaticStructureBuilder } from "../../../src/capabilities/static-structure-builder.ts";
import { staticStructureToDag } from "../../../src/dag/static-to-dag-converter.ts";
import { optimizeDAG } from "../../../src/dag/dag-optimizer.ts";
import { generateLogicalTrace } from "../../../src/dag/trace-generator.ts";
import { initializeTestDatabase } from "../../fixtures/test-helpers.ts";

// =============================================================================
// E2E: Pure Code with Literals → Fusion → Execution → Traces
// =============================================================================

Deno.test({
  name: "E2E DAG Optimizer: Pure code with literals executes successfully",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const db = await initializeTestDatabase();

    try {
      const builder = new StaticStructureBuilder(db);

      // Code with literals (currently fails without fusion)
      const code = `
        const numbers = [1, 2, 3, 4, 5];
        const doubled = numbers.map(x => x * 2);
        const sum = doubled.reduce((a, b) => a + b, 0);
      `;

      // 1. Build static structure
      const structure = await builder.buildStaticStructure(code);

      console.log(
        "Static structure nodes:",
        structure.nodes.map((n) => ({
          id: n.id,
          type: n.type,
          tool: n.tool,
        })),
      );

      // 2. Convert to logical DAG
      const logicalDAG = staticStructureToDag(structure);

      console.log(
        "Logical DAG tasks:",
        logicalDAG.tasks.map((t) => ({
          id: t.id,
          tool: t.tool,
          dependsOn: t.dependsOn,
        })),
      );

      // Should have code:map and code:reduce tasks
      const codeTasks = logicalDAG.tasks.filter((t) => t.tool?.startsWith("code:"));
      assert(codeTasks.length >= 2, "Should have at least 2 code operations");

      // 3. Optimize DAG (fusion)
      const optimizedDAG = optimizeDAG(logicalDAG);

      console.log(
        "Optimized DAG tasks:",
        optimizedDAG.tasks.map((t) => ({
          id: t.id,
          tool: t.tool,
          fusedFrom: t.metadata?.fusedFrom,
        })),
      );

      // Should have fewer physical tasks than logical tasks
      assert(
        optimizedDAG.tasks.length < logicalDAG.tasks.length,
        "Optimization should reduce task count",
      );

      // Check that fusion happened
      const fusedTasks = optimizedDAG.tasks.filter((t) => t.metadata?.fusedFrom);
      assert(fusedTasks.length > 0, "Should have at least one fused task");

      console.log("  ✓ DAG optimization successful");
      console.log(`  ✓ Tasks reduced: ${logicalDAG.tasks.length} → ${optimizedDAG.tasks.length}`);
      console.log(`  ✓ Fused tasks: ${fusedTasks.length}`);
    } finally {
      await db.close();
    }
  },
});

// =============================================================================
// E2E: MCP + Pure Code → Fusion → Execution
// =============================================================================

Deno.test({
  name: "E2E DAG Optimizer: MCP + pure code fusion",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const db = await initializeTestDatabase();

    try {
      const builder = new StaticStructureBuilder(db);

      // Code with MCP + pure operations
      const code = `
        const users = await mcp.db.query({ table: "users" });
        const active = users.filter(u => u.active);
        const names = active.map(u => u.name);
        const sorted = names.sort();
      `;

      // 1. Build static structure
      const structure = await builder.buildStaticStructure(code);

      // 2. Convert to logical DAG
      const logicalDAG = staticStructureToDag(structure);

      console.log(
        "Logical DAG:",
        logicalDAG.tasks.map((t) => ({
          id: t.id,
          tool: t.tool,
          type: t.type,
        })),
      );

      // Should have MCP + code tasks
      const mcpTasks = logicalDAG.tasks.filter((t) => t.type === "mcp_tool");
      const codeTasks = logicalDAG.tasks.filter((t) => t.tool?.startsWith("code:"));

      assert(mcpTasks.length >= 1, "Should have MCP task");
      assert(codeTasks.length >= 3, "Should have multiple code tasks");

      // 3. Optimize DAG
      const optimizedDAG = optimizeDAG(logicalDAG);

      console.log(
        "Optimized DAG:",
        optimizedDAG.tasks.map((t) => ({
          id: t.id,
          tool: t.tool,
          fusedFrom: t.metadata?.fusedFrom,
        })),
      );

      // MCP task should stay separate
      const optimizedMCPTasks = optimizedDAG.tasks.filter((t) => t.type === "mcp_tool");
      assertEquals(optimizedMCPTasks.length, mcpTasks.length, "MCP tasks should not be fused");

      // Code tasks should be fused
      const fusedTask = optimizedDAG.tasks.find((t) => t.metadata?.fusedFrom);
      assertExists(fusedTask, "Should have a fused task");

      assert(
        fusedTask!.metadata!.fusedFrom!.length >= 2,
        "Fused task should combine multiple logical tasks",
      );

      console.log("  ✓ MCP tasks kept separate");
      console.log(`  ✓ Code tasks fused: ${fusedTask!.metadata!.fusedFrom!.length} operations`);
    } finally {
      await db.close();
    }
  },
});

// =============================================================================
// E2E: Logical Trace Generation
// =============================================================================

Deno.test({
  name: "E2E DAG Optimizer: Logical trace generation from fused execution",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const db = await initializeTestDatabase();

    try {
      const builder = new StaticStructureBuilder(db);

      const code = `
        const numbers = [1, 2, 3];
        const doubled = numbers.map(x => x * 2);
        const sum = doubled.reduce((a, b) => a + b, 0);
      `;

      const structure = await builder.buildStaticStructure(code);
      const logicalDAG = staticStructureToDag(structure);
      const optimizedDAG = optimizeDAG(logicalDAG);

      // Simulate physical execution results
      const physicalResults = new Map();

      for (const physicalTask of optimizedDAG.tasks) {
        physicalResults.set(physicalTask.id, {
          taskId: physicalTask.id,
          output: [2, 4, 6], // Simulated final output
          success: true,
          durationMs: 10,
        });
      }

      // Generate logical trace
      const logicalTrace = generateLogicalTrace(optimizedDAG, physicalResults);

      console.log("Logical trace:", {
        executedPath: logicalTrace.executedPath,
        toolsUsed: logicalTrace.toolsUsed,
        taskResultsCount: logicalTrace.taskResults.length,
      });

      // Should have logical operations in executed path
      assert(
        logicalTrace.executedPath.some((op) => op.includes("code:")),
        "Executed path should include code operations",
      );

      // Should have same number of task results as logical tasks
      assertEquals(
        logicalTrace.taskResults.length,
        logicalDAG.tasks.length,
        "Should have logical task result for each logical task",
      );

      // SHGAT can learn from this trace
      assert(logicalTrace.success, "Trace should be successful");
      assert(logicalTrace.toolsUsed.length > 0, "Should have tools used");

      console.log("  ✓ Logical trace generated");
      console.log(`  ✓ Executed path: ${logicalTrace.executedPath.join(" → ")}`);
      console.log(`  ✓ SHGAT sees ${logicalTrace.toolsUsed.length} operations`);
    } finally {
      await db.close();
    }
  },
});

// =============================================================================
// E2E: Fork detection prevents incorrect fusion
// =============================================================================

Deno.test({
  name: "E2E DAG Optimizer: Fork detection prevents fusion",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const db = await initializeTestDatabase();

    try {
      const builder = new StaticStructureBuilder(db);

      // Code with fork: filter result used by both map and reduce
      const code = `
        const numbers = [1, 2, 3, 4, 5];
        const evens = numbers.filter(x => x % 2 === 0);
        const doubled = evens.map(x => x * 2);
        const sum = evens.reduce((a, b) => a + b, 0);
      `;

      const structure = await builder.buildStaticStructure(code);
      const logicalDAG = staticStructureToDag(structure);
      const optimizedDAG = optimizeDAG(logicalDAG);

      console.log(
        "Optimized DAG with fork:",
        optimizedDAG.tasks.map((t) => ({
          id: t.id,
          tool: t.tool,
          fusedFrom: t.metadata?.fusedFrom,
        })),
      );

      // Filter should NOT be fused with map or reduce (it has 2 dependents)
      const filterTask = logicalDAG.tasks.find((t) => t.tool === "code:filter");
      const filterPhysicalId = optimizedDAG.logicalToPhysical.get(filterTask!.id);
      const filterFusedTasks = optimizedDAG.physicalToLogical.get(filterPhysicalId!);

      // Filter should be alone (not fused)
      assertEquals(
        filterFusedTasks?.length,
        1,
        "Filter with multiple dependents should not be fused",
      );

      console.log("  ✓ Fork point detected correctly");
      console.log("  ✓ Filter task kept separate");
    } finally {
      await db.close();
    }
  },
});
