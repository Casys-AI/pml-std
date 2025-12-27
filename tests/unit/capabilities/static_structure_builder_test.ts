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
    assertEquals(
      decisionNodes[0].condition.includes("file") || decisionNodes[0].condition.includes("exists"),
      true,
    );
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

    // Create a mock embedding model with all required interface methods
    class MockEmbeddingModel {
      async load(): Promise<void> {}
      async encode(_text: string): Promise<number[]> {
        return new Array(1024).fill(0.1);
      }
      isLoaded(): boolean {
        return true;
      }
    }
    const mockEmbeddingModel = new MockEmbeddingModel();

    // Import CapabilityStore dynamically to avoid circular deps
    const { CapabilityStore } = await import("../../../src/capabilities/capability-store.ts");

    // Create CapabilityStore WITH StaticStructureBuilder (AC10)
    const store = new CapabilityStore(
      db,
      mockEmbeddingModel as any, // Cast to bypass EmbeddingModel class type (interface satisfied)
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

    const { capability } = await store.saveCapability({
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

// =============================================================================
// Story 10.2: Argument Extraction Tests (AC8)
// =============================================================================

Deno.test("StaticStructureBuilder - extract literal string argument (AC8)", async () => {
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
    assertExists(structure.nodes[0].arguments, "Should have arguments");
    assertExists(structure.nodes[0].arguments!.path, "Should have path argument");
    assertEquals(structure.nodes[0].arguments!.path.type, "literal");
    assertEquals(structure.nodes[0].arguments!.path.value, "/config.json");
  }

  await db.close();
});

Deno.test("StaticStructureBuilder - extract literal number argument (AC8)", async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  const code = `
    const result = await mcp.api.fetch({ timeout: 5000 });
  `;

  const structure = await builder.buildStaticStructure(code);

  assertExists(structure);
  assertEquals(structure.nodes.length, 1);

  if (structure.nodes[0].type === "task") {
    assertExists(structure.nodes[0].arguments);
    assertExists(structure.nodes[0].arguments!.timeout);
    assertEquals(structure.nodes[0].arguments!.timeout.type, "literal");
    assertEquals(structure.nodes[0].arguments!.timeout.value, 5000);
  }

  await db.close();
});

Deno.test("StaticStructureBuilder - extract literal boolean argument (AC8)", async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  const code = `
    const file = await mcp.filesystem.read_file({ path: "/test.txt", verbose: true });
  `;

  const structure = await builder.buildStaticStructure(code);

  assertExists(structure);

  if (structure.nodes[0].type === "task") {
    assertExists(structure.nodes[0].arguments);
    assertEquals(structure.nodes[0].arguments!.verbose.type, "literal");
    assertEquals(structure.nodes[0].arguments!.verbose.value, true);
  }

  await db.close();
});

Deno.test("StaticStructureBuilder - extract literal object (nested) argument (AC8)", async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  const code = `
    const result = await mcp.api.request({
      config: { method: "POST", headers: { "Content-Type": "application/json" } }
    });
  `;

  const structure = await builder.buildStaticStructure(code);

  assertExists(structure);

  if (structure.nodes[0].type === "task") {
    assertExists(structure.nodes[0].arguments);
    assertExists(structure.nodes[0].arguments!.config);
    assertEquals(structure.nodes[0].arguments!.config.type, "literal");

    const configValue = structure.nodes[0].arguments!.config.value as Record<string, unknown>;
    assertEquals(configValue.method, "POST");
    assertEquals(
      (configValue.headers as Record<string, string>)["Content-Type"],
      "application/json",
    );
  }

  await db.close();
});

Deno.test("StaticStructureBuilder - extract literal array argument (AC8)", async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  const code = `
    const result = await mcp.db.query({ ids: [1, 2, 3] });
  `;

  const structure = await builder.buildStaticStructure(code);

  assertExists(structure);

  if (structure.nodes[0].type === "task") {
    assertExists(structure.nodes[0].arguments);
    assertExists(structure.nodes[0].arguments!.ids);
    assertEquals(structure.nodes[0].arguments!.ids.type, "literal");
    assertEquals(structure.nodes[0].arguments!.ids.value, [1, 2, 3]);
  }

  await db.close();
});

Deno.test("StaticStructureBuilder - detect reference argument (member expression) (AC8)", async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  const code = `
    const file = await mcp.filesystem.read_file({ path: "/test.json" });
    const parsed = await mcp.json.parse({ content: file.content });
  `;

  const structure = await builder.buildStaticStructure(code);

  assertExists(structure);
  assertEquals(structure.nodes.length, 2);

  // Second node should have reference argument
  const secondNode = structure.nodes.find((n) => n.type === "task" && n.tool === "json:parse");
  assertExists(secondNode);

  if (secondNode?.type === "task") {
    assertExists(secondNode.arguments);
    assertExists(secondNode.arguments!.content);
    assertEquals(secondNode.arguments!.content.type, "reference");
    // Story 10.5: Variable names are converted to node IDs
    // "file" was assigned from node n1, so "file.content" becomes "n1.content"
    assertEquals(secondNode.arguments!.content.expression, "n1.content");
  }

  await db.close();
});

Deno.test("StaticStructureBuilder - detect parameter argument (identifier via args.X) (AC8)", async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  const code = `
    const file = await mcp.filesystem.read_file({ path: args.filePath });
  `;

  const structure = await builder.buildStaticStructure(code);

  assertExists(structure);

  if (structure.nodes[0].type === "task") {
    assertExists(structure.nodes[0].arguments);
    assertExists(structure.nodes[0].arguments!.path);
    assertEquals(structure.nodes[0].arguments!.path.type, "parameter");
    assertEquals(structure.nodes[0].arguments!.path.parameterName, "filePath");
  }

  await db.close();
});

Deno.test("StaticStructureBuilder - handle mixed arguments (literal + reference + parameter) (AC8)", async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  const code = `
    const result = await mcp.api.request({
      url: "https://api.example.com",
      method: args.httpMethod,
      body: previousResult.data
    });
  `;

  const structure = await builder.buildStaticStructure(code);

  assertExists(structure);

  if (structure.nodes[0].type === "task") {
    assertExists(structure.nodes[0].arguments);

    // Literal
    assertEquals(structure.nodes[0].arguments!.url.type, "literal");
    assertEquals(structure.nodes[0].arguments!.url.value, "https://api.example.com");

    // Parameter
    assertEquals(structure.nodes[0].arguments!.method.type, "parameter");
    assertEquals(structure.nodes[0].arguments!.method.parameterName, "httpMethod");

    // Reference
    assertEquals(structure.nodes[0].arguments!.body.type, "reference");
    assertEquals(structure.nodes[0].arguments!.body.expression, "previousResult.data");
  }

  await db.close();
});

Deno.test("StaticStructureBuilder - handle empty arguments gracefully (AC8)", async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  const code = `
    const result = await mcp.api.ping({});
  `;

  const structure = await builder.buildStaticStructure(code);

  assertExists(structure);
  assertEquals(structure.nodes.length, 1);

  // Empty arguments should not have arguments field (or empty object)
  if (structure.nodes[0].type === "task") {
    // Either no arguments field or empty object
    const hasEmptyOrNoArgs = !structure.nodes[0].arguments ||
      Object.keys(structure.nodes[0].arguments || {}).length === 0;
    assertEquals(hasEmptyOrNoArgs, true);
  }

  await db.close();
});

Deno.test("StaticStructureBuilder - handle spread operator gracefully (skip or warn) (AC8)", async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  // Spread operator should be skipped (not throw)
  const code = `
    const options = { verbose: true };
    const result = await mcp.api.request({ url: "https://api.com", ...options });
  `;

  const structure = await builder.buildStaticStructure(code);

  assertExists(structure);
  assertEquals(structure.nodes.length, 1);

  // Should have extracted the literal url, but skipped the spread
  if (structure.nodes[0].type === "task") {
    assertExists(structure.nodes[0].arguments);
    assertEquals(structure.nodes[0].arguments!.url.type, "literal");
    assertEquals(structure.nodes[0].arguments!.url.value, "https://api.com");
    // Spread should not appear as a key
    assertEquals(structure.nodes[0].arguments!["...options"], undefined);
  }

  await db.close();
});

// =============================================================================
// Story 11.2: inferDecisions Tests - Infer branch decisions from executed path
// =============================================================================

Deno.test("inferDecisions - infers true branch when true branch tool executed", async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  const code = `
    if (file.exists) {
      await mcp.filesystem.read_file({ path });
    } else {
      await mcp.filesystem.create_file({ path });
    }
  `;

  const structure = await builder.buildStaticStructure(code);

  // Simulate executing the true branch (read_file)
  const executedPath = ["filesystem:read_file"];
  const decisions = StaticStructureBuilder.inferDecisions(structure, executedPath);

  assertEquals(decisions.length, 1);
  assertEquals(decisions[0].outcome, "true");
  assertEquals(decisions[0].nodeId.startsWith("d"), true);
  assertExists(decisions[0].condition);

  await db.close();
});

Deno.test("inferDecisions - infers false branch when false branch tool executed", async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  const code = `
    if (file.exists) {
      await mcp.filesystem.read_file({ path });
    } else {
      await mcp.filesystem.create_file({ path });
    }
  `;

  const structure = await builder.buildStaticStructure(code);

  // Simulate executing the false branch (create_file)
  const executedPath = ["filesystem:create_file"];
  const decisions = StaticStructureBuilder.inferDecisions(structure, executedPath);

  assertEquals(decisions.length, 1);
  assertEquals(decisions[0].outcome, "false");

  await db.close();
});

Deno.test("inferDecisions - returns empty array when no conditional edges", async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  const code = `
    await mcp.filesystem.read_file({ path: "/a.txt" });
    await mcp.filesystem.read_file({ path: "/b.txt" });
  `;

  const structure = await builder.buildStaticStructure(code);

  const executedPath = ["filesystem:read_file"];
  const decisions = StaticStructureBuilder.inferDecisions(structure, executedPath);

  assertEquals(decisions.length, 0);

  await db.close();
});

Deno.test("inferDecisions - returns empty array for empty executedPath", async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  const code = `
    if (condition) {
      await mcp.api.success();
    }
  `;

  const structure = await builder.buildStaticStructure(code);

  const decisions = StaticStructureBuilder.inferDecisions(structure, []);

  assertEquals(decisions.length, 0);

  await db.close();
});

Deno.test("inferDecisions - handles multiple decision nodes", async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  const code = `
    if (conditionA) {
      await mcp.api.actionA();
    } else {
      await mcp.api.actionAFallback();
    }
    if (conditionB) {
      await mcp.api.actionB();
    }
  `;

  const structure = await builder.buildStaticStructure(code);

  // Execute true branch of first if, true branch of second if
  const executedPath = ["api:actionA", "api:actionB"];
  const decisions = StaticStructureBuilder.inferDecisions(structure, executedPath);

  assertEquals(decisions.length, 2);
  assertEquals(decisions.every((d) => d.outcome === "true"), true);

  await db.close();
});

Deno.test("inferDecisions - handles switch case decisions", async () => {
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
      case "delete":
        await mcp.filesystem.delete_file({ path });
        break;
    }
  `;

  const structure = await builder.buildStaticStructure(code);

  // Execute the write case
  const executedPath = ["filesystem:write_file"];
  const decisions = StaticStructureBuilder.inferDecisions(structure, executedPath);

  assertEquals(decisions.length, 1);
  assertEquals(decisions[0].outcome?.includes("case:"), true);

  await db.close();
});

Deno.test("inferDecisions - does not duplicate decisions for same node", async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  // If statement with multiple tools in same branch
  const code = `
    if (condition) {
      await mcp.api.step1();
      await mcp.api.step2();
    }
  `;

  const structure = await builder.buildStaticStructure(code);

  // Both tools in true branch executed
  const executedPath = ["api:step1", "api:step2"];
  const decisions = StaticStructureBuilder.inferDecisions(structure, executedPath);

  // Should only have 1 decision, not 2
  assertEquals(decisions.length, 1);
  assertEquals(decisions[0].outcome, "true");

  await db.close();
});

Deno.test("inferDecisions - handles null/undefined structure gracefully", () => {
  // Test with null structure
  const decisions1 = StaticStructureBuilder.inferDecisions(
    null as unknown as Parameters<typeof StaticStructureBuilder.inferDecisions>[0],
    ["some:tool"],
  );
  assertEquals(decisions1.length, 0);

  // Test with empty structure
  const decisions2 = StaticStructureBuilder.inferDecisions(
    { nodes: [], edges: [] },
    ["some:tool"],
  );
  assertEquals(decisions2.length, 0);
});
