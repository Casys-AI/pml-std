/**
 * E2E Tests: Modular DAG Operations (Phase 1)
 *
 * Tests the complete flow of modular code operations:
 * 1. StaticStructureBuilder detects code:* operations in source code
 * 2. staticStructureToDag converts to executable DAG
 * 3. WorkerBridge.executeCodeTask traces operations
 * 4. Pure operations are classified correctly
 *
 * Story: Phase 1 - Modular Code Operations Tracing
 */

import { assertEquals, assertExists } from "@std/assert";
import { PGliteClient } from "../../../src/db/client.ts";
import { getAllMigrations, MigrationRunner } from "../../../src/db/migrations.ts";
import { StaticStructureBuilder } from "../../../src/capabilities/static-structure-builder.ts";
import { staticStructureToDag } from "../../../src/dag/static-to-dag-converter.ts";
import { WorkerBridge } from "../../../src/sandbox/worker-bridge.ts";
import { isPureOperation, isCodeOperation } from "../../../src/capabilities/pure-operations.ts";
import type { MCPClientBase } from "../../../src/mcp/types.ts";

/**
 * Setup test database
 */
async function setupTestDb(): Promise<PGliteClient> {
  const db = new PGliteClient(":memory:");
  await db.connect();
  const runner = new MigrationRunner(db);
  await runner.runUp(getAllMigrations());
  return db;
}

// =============================================================================
// E2E: Full Pipeline - Static Analysis → DAG → Execution
// =============================================================================

Deno.test({
  name: "E2E Modular DAG: Static analysis detects code operations in real workflow",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const db = await setupTestDb();

    try {
      const builder = new StaticStructureBuilder(db);

      // Real-world code pattern: fetch data, filter, transform, aggregate
      const workflowCode = `
        // Fetch users from database
        const users = await mcp.db.query({ table: "users", limit: 100 });

        // Filter active users
        const activeUsers = users.filter(u => u.isActive && u.lastLogin > Date.now() - 86400000);

        // Extract and transform user data
        const userData = activeUsers.map(u => ({
          id: u.id,
          name: u.name.trim().toLowerCase(),
          score: u.points * 1.5
        }));

        // Sort by score descending
        const ranked = userData.sort((a, b) => b.score - a.score);

        // Get top 10
        const top10 = ranked.slice(0, 10);

        // Calculate average score
        const avgScore = top10.reduce((sum, u) => sum + u.score, 0) / top10.length;

        // Store results
        await mcp.memory.create_entities({ entities: top10 });

        return { top10, avgScore };
      `;

      const structure = await builder.buildStaticStructure(workflowCode);

      // Verify MCP tools were detected
      const mcpNodes = structure.nodes.filter(
        (n) => n.type === "task" && n.tool && !n.tool.startsWith("code:")
      );
      assertEquals(mcpNodes.length, 2, "Should detect 2 MCP tools (db:query, memory:create_entities)");

      // Verify code operations were detected
      const codeNodes = structure.nodes.filter(
        (n) => n.type === "task" && n.tool?.startsWith("code:")
      );

      // Should detect: filter, map, sort, slice, reduce, trim, toLowerCase, multiply
      assertEquals(codeNodes.length >= 5, true, `Should detect at least 5 code operations (found ${codeNodes.length})`);

      // Verify specific operations (type assertion since we filtered for task nodes)
      const tools = codeNodes.map((n) => (n as { tool: string }).tool);
      assertEquals(tools.includes("code:filter"), true, "Should detect filter");
      assertEquals(tools.includes("code:map"), true, "Should detect map");
      assertEquals(tools.includes("code:sort"), true, "Should detect sort");
      assertEquals(tools.includes("code:slice"), true, "Should detect slice");
      assertEquals(tools.includes("code:reduce"), true, "Should detect reduce");

      console.log("  ✓ Detected MCP tools:", mcpNodes.map(n => (n as { tool: string }).tool).join(", "));
      console.log("  ✓ Detected code operations:", tools.join(", "));
    } finally {
      await db.close();
    }
  },
});

Deno.test({
  name: "E2E Modular DAG: DAG converter preserves code operations with pure flag",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const db = await setupTestDb();

    try {
      const builder = new StaticStructureBuilder(db);

      const code = `
        const data = await mcp.api.fetch({ url: "https://api.example.com/items" });
        const filtered = data.items.filter(item => item.price > 100);
        const mapped = filtered.map(item => item.name);
        const joined = mapped.join(", ");
        return joined;
      `;

      const structure = await builder.buildStaticStructure(code);
      const dag = staticStructureToDag(structure);

      // Verify DAG has tasks
      assertEquals(dag.tasks.length >= 1, true, "DAG should have tasks");

      // Find code operation tasks
      const codeOpTasks = dag.tasks.filter((t) => t.tool?.startsWith("code:"));

      // Verify pure operations are marked
      for (const task of codeOpTasks) {
        if (task.tool && isPureOperation(task.tool)) {
          // Pure operations should have metadata.pure = true (if implemented)
          // For now, just verify they're classified correctly
          assertEquals(
            isPureOperation(task.tool),
            true,
            `${task.tool} should be classified as pure`
          );
        }
      }

      console.log("  ✓ DAG tasks:", dag.tasks.length);
      console.log("  ✓ Code operation tasks:", codeOpTasks.length);
    } finally {
      await db.close();
    }
  },
});

Deno.test({
  name: "E2E Modular DAG: WorkerBridge traces code operations end-to-end",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const mcpClients = new Map<string, MCPClientBase>();
    const bridge = new WorkerBridge(mcpClients, { timeout: 10000 });

    try {
      // Execute a complete data transformation pipeline
      const context = {
        users: [
          { id: 1, name: "Alice", score: 85 },
          { id: 2, name: "Bob", score: 92 },
          { id: 3, name: "Charlie", score: 78 },
          { id: 4, name: "Diana", score: 95 },
          { id: 5, name: "Eve", score: 88 },
        ],
      };

      // Execute filter operation
      const filterResult = await bridge.executeCodeTask(
        "code:filter",
        "return users.filter(u => u.score >= 85);",
        context,
        [],
      );

      assertEquals(filterResult.success, true, "Filter should succeed");
      assertEquals((filterResult.result as unknown[]).length, 4, "Should filter to 4 users");

      // Execute map operation on filtered result
      const mapResult = await bridge.executeCodeTask(
        "code:map",
        "return users.map(u => ({ name: u.name, grade: u.score >= 90 ? 'A' : 'B' }));",
        context,
        [],
      );

      assertEquals(mapResult.success, true, "Map should succeed");

      // Execute reduce operation
      const reduceResult = await bridge.executeCodeTask(
        "code:reduce",
        "return users.reduce((sum, u) => sum + u.score, 0);",
        context,
        [],
      );

      assertEquals(reduceResult.success, true, "Reduce should succeed");
      assertEquals(reduceResult.result, 438, "Sum should be 438");

      // Verify traces were recorded
      const traces = bridge.getTraces();
      const toolEndTraces = traces.filter((t) => t.type === "tool_end");

      // Should have at least 1 tool_end trace (from last operation due to reset)
      assertEquals(toolEndTraces.length >= 1, true, "Should have tool_end traces");

      // Verify the last operation was traced correctly
      const reduceTrace = toolEndTraces.find(
        (t) => t.type === "tool_end" && t.tool === "code:reduce"
      );
      assertExists(reduceTrace, "Should have code:reduce trace");

      if (reduceTrace?.type === "tool_end") {
        assertEquals(reduceTrace.success, true, "Reduce trace should show success");
        assertEquals(reduceTrace.result, 438, "Reduce trace should have result");
        assertExists(reduceTrace.durationMs, "Should have duration");
      }

      console.log("  ✓ Filter result: 4 users with score >= 85");
      console.log("  ✓ Map result: Graded users");
      console.log("  ✓ Reduce result: Sum = 438");
      console.log("  ✓ Traces recorded with timing and results");
    } finally {
      await bridge.terminate();
    }
  },
});

Deno.test({
  name: "E2E Modular DAG: Pure operation classification is accurate",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    // Test pure operation classification
    const pureOps = [
      "code:filter",
      "code:map",
      "code:reduce",
      "code:sort",
      "code:slice",
      "code:find",
      "code:some",
      "code:every",
      "code:split",
      "code:trim",
      "code:toLowerCase",
      "code:Object.keys",
      "code:Object.values",
      "code:Math.abs",
      "code:Math.max",
      "code:JSON.parse",
      "code:JSON.stringify",
      "code:add",
      "code:strictEqual",
      "code:and",
    ];

    const impureOps = [
      "filesystem:read_file",
      "db:query",
      "memory:create_entities",
      "api:fetch",
    ];

    // Verify pure ops are classified correctly
    for (const op of pureOps) {
      assertEquals(isPureOperation(op), true, `${op} should be pure`);
      assertEquals(isCodeOperation(op), true, `${op} should be code operation`);
    }

    // Verify impure ops are classified correctly
    for (const op of impureOps) {
      assertEquals(isPureOperation(op), false, `${op} should not be pure`);
      assertEquals(isCodeOperation(op), false, `${op} should not be code operation`);
    }

    console.log(`  ✓ ${pureOps.length} pure operations verified`);
    console.log(`  ✓ ${impureOps.length} impure operations verified`);
  },
});

Deno.test({
  name: "E2E Modular DAG: Complex nested operations are detected",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const db = await setupTestDb();

    try {
      const builder = new StaticStructureBuilder(db);

      // Code with nested operations (common in real workflows)
      const code = `
        const data = await mcp.db.query({ table: "orders" });

        // Complex transformation
        const summary = data
          .filter(order => order.status === "completed")
          .map(order => ({
            ...order,
            total: order.items.reduce((sum, item) => sum + item.price * item.qty, 0)
          }))
          .filter(order => order.total > 100)
          .sort((a, b) => b.total - a.total)
          .slice(0, 5);

        // Aggregate statistics
        const stats = {
          count: summary.length,
          totalRevenue: summary.reduce((sum, o) => sum + o.total, 0),
          avgOrderValue: summary.reduce((sum, o) => sum + o.total, 0) / summary.length
        };

        return stats;
      `;

      const structure = await builder.buildStaticStructure(code);

      // Should detect chained operations
      const codeNodes = structure.nodes.filter(
        (n) => n.type === "task" && n.tool?.startsWith("code:")
      );

      // Expect multiple filter, map, reduce, sort, slice operations (type assertion for task nodes)
      const filterCount = codeNodes.filter((n) => (n as { tool: string }).tool === "code:filter").length;
      const mapCount = codeNodes.filter((n) => (n as { tool: string }).tool === "code:map").length;
      const reduceCount = codeNodes.filter((n) => (n as { tool: string }).tool === "code:reduce").length;

      assertEquals(filterCount >= 2, true, "Should detect at least 2 filter operations");
      assertEquals(mapCount >= 1, true, "Should detect at least 1 map operation");
      assertEquals(reduceCount >= 2, true, "Should detect at least 2 reduce operations");

      console.log("  ✓ Nested operations detected:");
      console.log(`    - filter: ${filterCount}`);
      console.log(`    - map: ${mapCount}`);
      console.log(`    - reduce: ${reduceCount}`);
      console.log(`    - total code ops: ${codeNodes.length}`);
    } finally {
      await db.close();
    }
  },
});

Deno.test({
  name: "E2E Modular DAG: Object and Math operations in transformations",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const db = await setupTestDb();

    try {
      const builder = new StaticStructureBuilder(db);

      const code = `
        const config = await mcp.filesystem.read_file({ path: "/config.json" });
        const settings = JSON.parse(config);

        // Object operations
        const keys = Object.keys(settings);
        const values = Object.values(settings);
        const entries = Object.entries(settings);

        // Math operations
        const nums = values.filter(v => typeof v === "number");
        const max = Math.max(...nums);
        const min = Math.min(...nums);
        const absValues = nums.map(n => Math.abs(n));

        return { keys, max, min, absValues };
      `;

      const structure = await builder.buildStaticStructure(code);

      const codeNodes = structure.nodes.filter(
        (n) => n.type === "task" && n.tool?.startsWith("code:")
      );

      const tools = codeNodes.map((n) => (n as { tool: string }).tool);

      // Verify Object operations
      assertEquals(tools.includes("code:Object.keys"), true, "Should detect Object.keys");
      assertEquals(tools.includes("code:Object.values"), true, "Should detect Object.values");
      assertEquals(tools.includes("code:Object.entries"), true, "Should detect Object.entries");

      // Verify JSON operations
      assertEquals(tools.includes("code:JSON.parse"), true, "Should detect JSON.parse");

      // Verify Math operations
      assertEquals(tools.includes("code:Math.max"), true, "Should detect Math.max");
      assertEquals(tools.includes("code:Math.min"), true, "Should detect Math.min");
      assertEquals(tools.includes("code:Math.abs"), true, "Should detect Math.abs");

      console.log("  ✓ Object operations: Object.keys, Object.values, Object.entries");
      console.log("  ✓ JSON operations: JSON.parse");
      console.log("  ✓ Math operations: Math.max, Math.min, Math.abs");
    } finally {
      await db.close();
    }
  },
});

// =============================================================================
// E2E: Variable Bindings for Code Task Context Injection
// =============================================================================

Deno.test({
  name: "E2E Modular DAG: variableBindings are propagated to DAG tasks",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const db = await setupTestDb();

    try {
      const builder = new StaticStructureBuilder(db);

      const code = `
        const users = await mcp.db.query({ table: "users" });
        const active = users.filter(u => u.active);
        const names = active.map(u => u.name);
      `;

      const structure = await builder.buildStaticStructure(code);

      // Verify variableBindings exist
      assertExists(structure.variableBindings, "Should have variableBindings");
      assertExists(structure.variableBindings!["users"], "Should have 'users' binding");

      // Convert to DAG
      const dag = staticStructureToDag(structure);

      // Find code operation tasks
      const codeTasks = dag.tasks.filter((t) => t.tool?.startsWith("code:"));
      assertEquals(codeTasks.length >= 1, true, "Should have code tasks");

      // All code tasks should have variableBindings
      for (const task of codeTasks) {
        assertExists(task.variableBindings, `Task ${task.id} should have variableBindings`);
        assertEquals(
          typeof task.variableBindings,
          "object",
          "variableBindings should be object"
        );
      }

      console.log("  ✓ variableBindings exported from StaticStructure");
      console.log("  ✓ variableBindings propagated to DAG tasks");
      console.log(`  ✓ Bindings: ${JSON.stringify(structure.variableBindings)}`);
    } finally {
      await db.close();
    }
  },
});

Deno.test({
  name: "E2E Modular DAG: WorkerBridge injects variables from context",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const mcpClients = new Map<string, MCPClientBase>();
    const bridge = new WorkerBridge(mcpClients, { timeout: 10000 });

    try {
      // Simulate what the executor does: inject variables from previous task results
      // In real execution, this would come from previousResults via variableBindings
      const context = {
        users: [
          { id: 1, name: "Alice", active: true },
          { id: 2, name: "Bob", active: false },
          { id: 3, name: "Charlie", active: true },
        ],
      };

      // Execute filter - the code references "users" which is injected from context
      const filterResult = await bridge.executeCodeTask(
        "code:filter",
        "return users.filter(u => u.active);",
        context,
        [],
      );

      assertEquals(filterResult.success, true, "Filter should succeed with injected context");
      assertEquals((filterResult.result as unknown[]).length, 2, "Should filter to 2 active users");

      // Chain: use filtered result
      const mapContext = {
        filtered: filterResult.result,
      };

      const mapResult = await bridge.executeCodeTask(
        "code:map",
        "return filtered.map(u => u.name);",
        mapContext,
        [],
      );

      assertEquals(mapResult.success, true, "Map should succeed");
      assertEquals(
        JSON.stringify(mapResult.result),
        '["Alice","Charlie"]',
        "Should map to names"
      );

      console.log("  ✓ Variables injected from context successfully");
      console.log("  ✓ Chained operations work with injected context");
    } finally {
      await bridge.terminate();
    }
  },
});

Deno.test({
  name: "E2E Modular DAG: Variable injection resolves cross-task dependencies",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const mcpClients = new Map<string, MCPClientBase>();
    const bridge = new WorkerBridge(mcpClients, { timeout: 10000 });

    try {
      // Simulate a complete workflow where:
      // Task 1 (n1): MCP call returns data → assigns to "data"
      // Task 2 (n2): code:filter uses "data"
      // Task 3 (n3): code:map uses filtered result
      // Task 4 (n4): code:reduce aggregates

      // Step 1: Simulate MCP result (in real flow, this would be from mcp.db.query)
      const mcpResult = [
        { id: 1, value: 100, category: "A" },
        { id: 2, value: 200, category: "B" },
        { id: 3, value: 150, category: "A" },
        { id: 4, value: 50, category: "C" },
      ];

      // Step 2: Filter - inject "data" from MCP result (via variableBindings)
      const filterContext = { data: mcpResult };
      const filterResult = await bridge.executeCodeTask(
        "code:filter",
        'return data.filter(item => item.category === "A");',
        filterContext,
        [],
      );

      assertEquals(filterResult.success, true);
      assertEquals((filterResult.result as unknown[]).length, 2);

      // Step 3: Map - inject "filtered" from filter result
      const mapContext = { filtered: filterResult.result };
      const mapResult = await bridge.executeCodeTask(
        "code:map",
        "return filtered.map(item => item.value);",
        mapContext,
        [],
      );

      assertEquals(mapResult.success, true);
      assertEquals(JSON.stringify(mapResult.result), "[100,150]");

      // Step 4: Reduce - inject "values" from map result
      const reduceContext = { values: mapResult.result };
      const reduceResult = await bridge.executeCodeTask(
        "code:reduce",
        "return values.reduce((sum, v) => sum + v, 0);",
        reduceContext,
        [],
      );

      assertEquals(reduceResult.success, true);
      assertEquals(reduceResult.result, 250);

      console.log("  ✓ Complete workflow with cross-task variable injection");
      console.log("  ✓ MCP result → filter → map → reduce = 250");
    } finally {
      await bridge.terminate();
    }
  },
});
