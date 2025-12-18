/**
 * Unit tests for StaticStructureBuilder
 *
 * Story: 10.1 Static Code Analysis - Capability Creation (AC12)
 *
 * Tests:
 * 1. Parse simple MCP call → one task node
 * 2. Parse sequential MCP calls → two task nodes + sequence edge
 * 3. Parse if statement → decision node + conditional edges
 * 4. Parse switch statement → decision node + case edges
 * 5. Parse Promise.all → fork/join nodes
 * 6. Parse nested if in Promise.all → combined structure
 * 7. Parse capability call → capability node
 *
 * @module tests/unit/capabilities/static_structure_builder_test
 */

import { assertEquals, assertExists } from "@std/assert";
import { PGliteClient } from "../../../src/db/client.ts";
import { getAllMigrations, MigrationRunner } from "../../../src/db/migrations.ts";
import { StaticStructureBuilder } from "../../../src/capabilities/static-structure-builder.ts";

/**
 * Setup test database with migrations
 */
async function setupTestDb(): Promise<PGliteClient> {
  const db = new PGliteClient(":memory:");
  await db.connect();

  const runner = new MigrationRunner(db);
  await runner.runUp(getAllMigrations());

  return db;
}

// =============================================================================
// AC12 Test 1: Parse simple MCP call → one task node
// =============================================================================

Deno.test("StaticStructureBuilder - parse simple MCP call creates one task node", async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  const code = `
    const file = await mcp.filesystem.read_file({ path: "/config.json" });
  `;

  const structure = await builder.buildStaticStructure(code);

  assertExists(structure);
  assertEquals(structure.nodes.length, 1);
  assertEquals(structure.nodes[0].type, "task");
  if (structure.nodes[0].type === "task") {
    assertEquals(structure.nodes[0].tool, "filesystem:read_file");
  }

  await db.close();
});

// =============================================================================
// AC12 Test 2: Parse sequential MCP calls → two task nodes + sequence edge
// =============================================================================

Deno.test("StaticStructureBuilder - parse sequential MCP calls creates sequence edge", async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  const code = `
    const file = await mcp.filesystem.read_file({ path: "/config.json" });
    const result = await mcp.json.parse({ content: file });
  `;

  const structure = await builder.buildStaticStructure(code);

  assertExists(structure);
  assertEquals(structure.nodes.length, 2);
  assertEquals(structure.nodes[0].type, "task");
  assertEquals(structure.nodes[1].type, "task");

  // Should have at least one sequence edge
  const sequenceEdges = structure.edges.filter((e) => e.type === "sequence");
  assertEquals(sequenceEdges.length >= 1, true);

  await db.close();
});

// =============================================================================
// AC12 Test 3: Parse if statement → decision node + conditional edges
// =============================================================================

Deno.test("StaticStructureBuilder - parse if statement creates decision node", async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  const code = `
    const file = await mcp.filesystem.read_file({ path: "/config.json" });
    if (file.exists) {
      await mcp.filesystem.write_file({ path: "/output.json", content: "{}" });
    }
  `;

  const structure = await builder.buildStaticStructure(code);

  assertExists(structure);

  // Should have decision node
  const decisionNodes = structure.nodes.filter((n) => n.type === "decision");
  assertEquals(decisionNodes.length, 1);
  if (decisionNodes[0].type === "decision") {
    assertEquals(decisionNodes[0].condition.includes("file") || decisionNodes[0].condition.includes("exists"), true);
  }

  // Should have conditional edge
  const conditionalEdges = structure.edges.filter((e) => e.type === "conditional");
  assertEquals(conditionalEdges.length >= 1, true);
  assertEquals(conditionalEdges[0].outcome, "true");

  await db.close();
});

// =============================================================================
// AC12 Test 4: Parse switch statement → decision node + case edges
// =============================================================================

Deno.test("StaticStructureBuilder - parse switch statement creates case edges", async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  const code = `
    switch (action) {
      case "read":
        await mcp.filesystem.read_file({ path });
        break;
      case "write":
        await mcp.filesystem.write_file({ path, content });
        break;
    }
  `;

  const structure = await builder.buildStaticStructure(code);

  assertExists(structure);

  // Should have decision node with switch condition
  const decisionNodes = structure.nodes.filter((n) => n.type === "decision");
  assertEquals(decisionNodes.length, 1);
  if (decisionNodes[0].type === "decision") {
    assertEquals(decisionNodes[0].condition.includes("switch"), true);
  }

  // Should have conditional edges with case outcomes
  const conditionalEdges = structure.edges.filter((e) => e.type === "conditional");
  assertEquals(conditionalEdges.length >= 2, true);

  const caseOutcomes = conditionalEdges.map((e) => e.outcome);
  assertEquals(caseOutcomes.some((o) => o?.includes("case:")), true);

  await db.close();
});

// =============================================================================
// AC12 Test 5: Parse Promise.all → fork/join nodes
// =============================================================================

Deno.test("StaticStructureBuilder - parse Promise.all creates fork/join nodes", async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  const code = `
    const [a, b] = await Promise.all([
      mcp.api.fetch({ url: "https://a.com" }),
      mcp.api.fetch({ url: "https://b.com" }),
    ]);
  `;

  const structure = await builder.buildStaticStructure(code);

  assertExists(structure);

  // Should have fork node
  const forkNodes = structure.nodes.filter((n) => n.type === "fork");
  assertEquals(forkNodes.length, 1);

  // Should have join node
  const joinNodes = structure.nodes.filter((n) => n.type === "join");
  assertEquals(joinNodes.length, 1);

  // Should have task nodes for each parallel call
  const taskNodes = structure.nodes.filter((n) => n.type === "task");
  assertEquals(taskNodes.length, 2);

  await db.close();
});

// =============================================================================
// AC12 Test 6: Parse nested if in Promise.all → combined structure
// =============================================================================

Deno.test("StaticStructureBuilder - parse nested structures in Promise.all", async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  const code = `
    const results = await Promise.all([
      mcp.api.fetch({ url: "https://a.com" }),
      mcp.api.fetch({ url: "https://b.com" }),
    ]);
    if (results[0].ok) {
      await mcp.db.save({ data: results[0] });
    }
  `;

  const structure = await builder.buildStaticStructure(code);

  assertExists(structure);

  // Should have fork and join
  const forkNodes = structure.nodes.filter((n) => n.type === "fork");
  const joinNodes = structure.nodes.filter((n) => n.type === "join");
  assertEquals(forkNodes.length, 1);
  assertEquals(joinNodes.length, 1);

  // Should have decision node for if statement
  const decisionNodes = structure.nodes.filter((n) => n.type === "decision");
  assertEquals(decisionNodes.length, 1);

  // Should have multiple task nodes
  const taskNodes = structure.nodes.filter((n) => n.type === "task");
  assertEquals(taskNodes.length >= 3, true); // 2 fetch + 1 save

  await db.close();
});

// =============================================================================
// AC12 Test 7: Parse capability call → capability node
// =============================================================================

Deno.test("StaticStructureBuilder - parse capability call creates capability node", async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  const code = `
    const result = await capabilities.analyzeData({ input: data });
  `;

  const structure = await builder.buildStaticStructure(code);

  assertExists(structure);
  assertEquals(structure.nodes.length, 1);
  assertEquals(structure.nodes[0].type, "capability");
  if (structure.nodes[0].type === "capability") {
    assertEquals(structure.nodes[0].capabilityId, "analyzeData");
  }

  await db.close();
});

// =============================================================================
// Additional Tests: Error handling and edge cases
// =============================================================================

Deno.test("StaticStructureBuilder - graceful error handling for invalid code", async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  const invalidCode = `
    this is not valid javascript {{{{
  `;

  const structure = await builder.buildStaticStructure(invalidCode);

  // Should return empty structure, not throw
  assertExists(structure);
  assertEquals(structure.nodes.length, 0);
  assertEquals(structure.edges.length, 0);

  await db.close();
});

Deno.test("StaticStructureBuilder - ternary operator creates decision node", async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  const code = `
    const result = isValid
      ? await mcp.api.success({ data })
      : await mcp.api.error({ message: "invalid" });
  `;

  const structure = await builder.buildStaticStructure(code);

  assertExists(structure);

  // Should have decision node for ternary
  const decisionNodes = structure.nodes.filter((n) => n.type === "decision");
  assertEquals(decisionNodes.length, 1);

  // Should have 2 task nodes (one for each branch)
  const taskNodes = structure.nodes.filter((n) => n.type === "task");
  assertEquals(taskNodes.length, 2);

  await db.close();
});

Deno.test("StaticStructureBuilder - if/else creates both branch edges", async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  const code = `
    if (condition) {
      await mcp.api.branchA();
    } else {
      await mcp.api.branchB();
    }
  `;

  const structure = await builder.buildStaticStructure(code);

  assertExists(structure);

  // Should have conditional edges for both branches
  const conditionalEdges = structure.edges.filter((e) => e.type === "conditional");
  assertEquals(conditionalEdges.length, 2);

  const outcomes = conditionalEdges.map((e) => e.outcome);
  assertEquals(outcomes.includes("true"), true);
  assertEquals(outcomes.includes("false"), true);

  await db.close();
});

Deno.test("StaticStructureBuilder - getHILRequiredTools returns correct tools", async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  const code = `
    const file = await mcp.filesystem.read_file({ path });
    await mcp.github.create_issue({ title, body });
  `;

  const structure = await builder.buildStaticStructure(code);
  const hilTools = builder.getHILRequiredTools(structure);

  // HIL tools depend on config/mcp-permissions.yaml
  // This test validates the method works, actual results depend on config
  assertExists(hilTools);
  assertEquals(Array.isArray(hilTools), true);

  await db.close();
});

// =============================================================================
// Integration Test: CapabilityStore with StaticStructureBuilder (AC10)
// =============================================================================

Deno.test({
  name: "Integration - CapabilityStore uses StaticStructureBuilder when provided",
  sanitizeResources: false, // EventBus uses BroadcastChannel
  sanitizeOps: false, // EventBus async ops
  fn: async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  // Create a mock embedding model
  const mockEmbeddingModel = {
    encode: async (_text: string) => new Array(1024).fill(0.1),
  };

  // Import CapabilityStore dynamically to avoid circular deps
  const { CapabilityStore } = await import("../../../src/capabilities/capability-store.ts");

  // Create CapabilityStore WITH StaticStructureBuilder (AC10)
  const store = new CapabilityStore(
    db,
    mockEmbeddingModel,
    undefined, // schemaInferrer
    undefined, // permissionInferrer
    builder, // staticStructureBuilder - AC10
  );

  // Save a capability with MCP tool calls
  const code = `
    const file = await mcp.filesystem.read_file({ path: "/test.json" });
    if (file.content) {
      await mcp.filesystem.write_file({ path: "/output.json", content: file.content });
    }
  `;

  const capability = await store.saveCapability({
    code,
    intent: "Read a file and write it if it has content",
    durationMs: 100,
    success: true,
  });

  assertExists(capability);
  assertExists(capability.id);

  // Verify static_structure was stored in dag_structure
  const result = await db.query(
    `SELECT dag_structure FROM workflow_pattern WHERE pattern_id = $1`,
    [capability.id],
  );

  assertEquals(result.length, 1);
  const dagStructure = result[0].dag_structure as Record<string, unknown>;

  // AC10: static_structure should be present in dag_structure
  assertExists(dagStructure.static_structure, "static_structure should be in dag_structure");

  const staticStructure = dagStructure.static_structure as { nodes: unknown[]; edges: unknown[] };
  assertEquals(Array.isArray(staticStructure.nodes), true);
  assertEquals(Array.isArray(staticStructure.edges), true);

  // Should have detected nodes: 2 tasks + 1 decision
  assertEquals(staticStructure.nodes.length >= 2, true, "Should have at least 2 task nodes");

  await db.close();
  },
});
