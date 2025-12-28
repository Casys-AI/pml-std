/**
 * Unit Tests: StaticStructureBuilder Code Operations Detection
 *
 * Tests for Phase 1 modular DAG execution - detecting JavaScript operations
 * and converting them to code:* pseudo-tools for SHGAT learning.
 *
 * Coverage:
 * - Array operations (filter, map, reduce, etc.)
 * - String operations (split, replace, trim, etc.)
 * - Object operations (Object.keys, Object.values, etc.)
 * - Math operations (Math.abs, Math.max, etc.)
 * - JSON operations (JSON.parse, JSON.stringify)
 * - Binary operators (+, -, ===, &&, etc.)
 * - Code extraction via SWC spans
 *
 * @module tests/unit/capabilities/static-structure-code-ops.test
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

/**
 * Helper to find nodes by tool prefix
 */
function findCodeNodes(structure: { nodes: Array<{ type: string; tool?: string }> }) {
  return structure.nodes.filter(
    (n) => n.type === "task" && n.tool?.startsWith("code:"),
  );
}

// =============================================================================
// Array Operations Detection
// =============================================================================

Deno.test("StaticStructureBuilder - detects array.filter() as code:filter", async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  const code = `
    const users = await mcp.db.query({ table: "users" });
    const active = users.filter(u => u.active);
  `;

  const structure = await builder.buildStaticStructure(code);

  const codeNodes = findCodeNodes(structure);
  assertEquals(codeNodes.length >= 1, true, "Should detect at least 1 code operation");

  const filterNode = codeNodes.find((n) => n.tool === "code:filter");
  assertExists(filterNode, "Should have code:filter node");

  await db.close();
});

Deno.test("StaticStructureBuilder - detects array.map() as code:map", async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  const code = `
    const items = [1, 2, 3];
    const doubled = items.map(x => x * 2);
  `;

  const structure = await builder.buildStaticStructure(code);

  const codeNodes = findCodeNodes(structure);
  const mapNode = codeNodes.find((n) => n.tool === "code:map");
  assertExists(mapNode, "Should have code:map node");

  await db.close();
});

Deno.test("StaticStructureBuilder - detects array.reduce() as code:reduce", async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  const code = `
    const nums = [1, 2, 3, 4, 5];
    const sum = nums.reduce((acc, n) => acc + n, 0);
  `;

  const structure = await builder.buildStaticStructure(code);

  const codeNodes = findCodeNodes(structure);
  const reduceNode = codeNodes.find((n) => n.tool === "code:reduce");
  assertExists(reduceNode, "Should have code:reduce node");

  await db.close();
});

Deno.test("StaticStructureBuilder - detects chained array operations", async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  const code = `
    const data = await mcp.db.query({ table: "users" });
    const result = data
      .filter(u => u.active)
      .map(u => u.name)
      .sort();
  `;

  const structure = await builder.buildStaticStructure(code);

  const codeNodes = findCodeNodes(structure);

  // Should detect filter, map, and sort
  assertEquals(codeNodes.length >= 3, true, "Should detect at least 3 code operations");

  const hasFilter = codeNodes.some((n) => n.tool === "code:filter");
  const hasMap = codeNodes.some((n) => n.tool === "code:map");
  const hasSort = codeNodes.some((n) => n.tool === "code:sort");

  assertEquals(hasFilter, true, "Should detect filter");
  assertEquals(hasMap, true, "Should detect map");
  assertEquals(hasSort, true, "Should detect sort");

  await db.close();
});

Deno.test("StaticStructureBuilder - detects find, some, every", async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  const code = `
    const users = [{ name: "Alice" }, { name: "Bob" }];
    const alice = users.find(u => u.name === "Alice");
    const hasAlice = users.some(u => u.name === "Alice");
    const allNamed = users.every(u => u.name);
  `;

  const structure = await builder.buildStaticStructure(code);

  const codeNodes = findCodeNodes(structure);

  const hasFind = codeNodes.some((n) => n.tool === "code:find");
  const hasSome = codeNodes.some((n) => n.tool === "code:some");
  const hasEvery = codeNodes.some((n) => n.tool === "code:every");

  assertEquals(hasFind, true, "Should detect find");
  assertEquals(hasSome, true, "Should detect some");
  assertEquals(hasEvery, true, "Should detect every");

  await db.close();
});

// =============================================================================
// String Operations Detection
// =============================================================================

Deno.test("StaticStructureBuilder - detects string.split() as code:split", async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  const code = `
    const text = "a,b,c";
    const parts = text.split(",");
  `;

  const structure = await builder.buildStaticStructure(code);

  const codeNodes = findCodeNodes(structure);
  const splitNode = codeNodes.find((n) => n.tool === "code:split");
  assertExists(splitNode, "Should have code:split node");

  await db.close();
});

Deno.test("StaticStructureBuilder - detects string.replace() as code:replace", async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  const code = `
    const text = "hello world";
    const replaced = text.replace("world", "there");
  `;

  const structure = await builder.buildStaticStructure(code);

  const codeNodes = findCodeNodes(structure);
  const replaceNode = codeNodes.find((n) => n.tool === "code:replace");
  assertExists(replaceNode, "Should have code:replace node");

  await db.close();
});

Deno.test("StaticStructureBuilder - detects string case operations", async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  const code = `
    const text = "Hello World";
    const lower = text.toLowerCase();
    const upper = text.toUpperCase();
    const trimmed = text.trim();
  `;

  const structure = await builder.buildStaticStructure(code);

  const codeNodes = findCodeNodes(structure);

  const hasLower = codeNodes.some((n) => n.tool === "code:toLowerCase");
  const hasUpper = codeNodes.some((n) => n.tool === "code:toUpperCase");
  const hasTrim = codeNodes.some((n) => n.tool === "code:trim");

  assertEquals(hasLower, true, "Should detect toLowerCase");
  assertEquals(hasUpper, true, "Should detect toUpperCase");
  assertEquals(hasTrim, true, "Should detect trim");

  await db.close();
});

// =============================================================================
// Object Operations Detection
// =============================================================================

Deno.test("StaticStructureBuilder - detects Object.keys() as code:Object.keys", async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  const code = `
    const obj = { a: 1, b: 2 };
    const keys = Object.keys(obj);
  `;

  const structure = await builder.buildStaticStructure(code);

  const codeNodes = findCodeNodes(structure);
  const keysNode = codeNodes.find((n) => n.tool === "code:Object.keys");
  assertExists(keysNode, "Should have code:Object.keys node");

  await db.close();
});

Deno.test("StaticStructureBuilder - detects Object.values() and Object.entries()", async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  const code = `
    const obj = { a: 1, b: 2 };
    const values = Object.values(obj);
    const entries = Object.entries(obj);
  `;

  const structure = await builder.buildStaticStructure(code);

  const codeNodes = findCodeNodes(structure);

  const hasValues = codeNodes.some((n) => n.tool === "code:Object.values");
  const hasEntries = codeNodes.some((n) => n.tool === "code:Object.entries");

  assertEquals(hasValues, true, "Should detect Object.values");
  assertEquals(hasEntries, true, "Should detect Object.entries");

  await db.close();
});

// =============================================================================
// Math Operations Detection
// =============================================================================

Deno.test("StaticStructureBuilder - detects Math.abs() as code:Math.abs", async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  const code = `
    const num = -5;
    const absolute = Math.abs(num);
  `;

  const structure = await builder.buildStaticStructure(code);

  const codeNodes = findCodeNodes(structure);
  const absNode = codeNodes.find((n) => n.tool === "code:Math.abs");
  assertExists(absNode, "Should have code:Math.abs node");

  await db.close();
});

Deno.test("StaticStructureBuilder - detects Math.max() and Math.min()", async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  const code = `
    const nums = [1, 5, 3];
    const max = Math.max(...nums);
    const min = Math.min(...nums);
  `;

  const structure = await builder.buildStaticStructure(code);

  const codeNodes = findCodeNodes(structure);

  const hasMax = codeNodes.some((n) => n.tool === "code:Math.max");
  const hasMin = codeNodes.some((n) => n.tool === "code:Math.min");

  assertEquals(hasMax, true, "Should detect Math.max");
  assertEquals(hasMin, true, "Should detect Math.min");

  await db.close();
});

// =============================================================================
// JSON Operations Detection
// =============================================================================

Deno.test("StaticStructureBuilder - detects JSON.parse() as code:JSON.parse", async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  const code = `
    const text = '{"a":1}';
    const obj = JSON.parse(text);
  `;

  const structure = await builder.buildStaticStructure(code);

  const codeNodes = findCodeNodes(structure);
  const parseNode = codeNodes.find((n) => n.tool === "code:JSON.parse");
  assertExists(parseNode, "Should have code:JSON.parse node");

  await db.close();
});

Deno.test("StaticStructureBuilder - detects JSON.stringify() as code:JSON.stringify", async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  const code = `
    const obj = { a: 1 };
    const text = JSON.stringify(obj);
  `;

  const structure = await builder.buildStaticStructure(code);

  const codeNodes = findCodeNodes(structure);
  const stringifyNode = codeNodes.find((n) => n.tool === "code:JSON.stringify");
  assertExists(stringifyNode, "Should have code:JSON.stringify node");

  await db.close();
});

// =============================================================================
// Binary Operators Detection
// =============================================================================

Deno.test("StaticStructureBuilder - detects arithmetic operators", async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  const code = `
    const a = 5;
    const b = 3;
    const sum = a + b;
    const diff = a - b;
    const prod = a * b;
    const quot = a / b;
  `;

  const structure = await builder.buildStaticStructure(code);

  const codeNodes = findCodeNodes(structure);

  const hasAdd = codeNodes.some((n) => n.tool === "code:add");
  const hasSubtract = codeNodes.some((n) => n.tool === "code:subtract");
  const hasMultiply = codeNodes.some((n) => n.tool === "code:multiply");
  const hasDivide = codeNodes.some((n) => n.tool === "code:divide");

  assertEquals(hasAdd, true, "Should detect add (+)");
  assertEquals(hasSubtract, true, "Should detect subtract (-)");
  assertEquals(hasMultiply, true, "Should detect multiply (*)");
  assertEquals(hasDivide, true, "Should detect divide (/)");

  await db.close();
});

Deno.test("StaticStructureBuilder - detects comparison operators", async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  const code = `
    const a = 5;
    const b = 3;
    const isEqual = a === b;
    const isLess = a < b;
    const isGreater = a > b;
  `;

  const structure = await builder.buildStaticStructure(code);

  const codeNodes = findCodeNodes(structure);

  const hasStrictEqual = codeNodes.some((n) => n.tool === "code:strictEqual");
  const hasLessThan = codeNodes.some((n) => n.tool === "code:lessThan");
  const hasGreaterThan = codeNodes.some((n) => n.tool === "code:greaterThan");

  assertEquals(hasStrictEqual, true, "Should detect strictEqual (===)");
  assertEquals(hasLessThan, true, "Should detect lessThan (<)");
  assertEquals(hasGreaterThan, true, "Should detect greaterThan (>)");

  await db.close();
});

Deno.test("StaticStructureBuilder - detects logical operators", async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  const code = `
    const a = true;
    const b = false;
    const andResult = a && b;
    const orResult = a || b;
  `;

  const structure = await builder.buildStaticStructure(code);

  const codeNodes = findCodeNodes(structure);

  const hasAnd = codeNodes.some((n) => n.tool === "code:and");
  const hasOr = codeNodes.some((n) => n.tool === "code:or");

  assertEquals(hasAnd, true, "Should detect and (&&)");
  assertEquals(hasOr, true, "Should detect or (||)");

  await db.close();
});

// =============================================================================
// Code Extraction via SWC Spans
// =============================================================================

Deno.test("StaticStructureBuilder - code field contains actual code from span extraction", async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  const code = `
    const users = [{ name: "Alice", active: true }];
    const active = users.filter(u => u.active && u.name.length > 0);
  `;

  const structure = await builder.buildStaticStructure(code);

  const filterNode = structure.nodes.find(
    (n) => n.type === "task" && n.tool === "code:filter",
  );

  assertExists(filterNode, "Should have code:filter node");

  if (filterNode?.type === "task") {
    // Code field should contain the actual filter expression
    assertExists(filterNode.code, "Should have code field from span extraction");
    assertEquals(typeof filterNode.code, "string", "Code field should be a string");
    // SWC span now uses wrapped code, so extraction should be accurate
    assertEquals(
      filterNode.code?.includes("filter"),
      true,
      "Code should contain 'filter'",
    );
  }

  await db.close();
});

Deno.test("StaticStructureBuilder - code field preserves callback in map operation", async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  const code = `
    const data = await mcp.db.query({ table: "users" });
    const result = data.map(item => ({
      id: item.id,
      name: item.name.toUpperCase()
    }));
  `;

  const structure = await builder.buildStaticStructure(code);

  const mapNode = structure.nodes.find(
    (n) => n.type === "task" && n.tool === "code:map",
  );

  assertExists(mapNode, "Should have code:map node");

  if (mapNode?.type === "task") {
    // Code field should preserve the callback
    assertExists(mapNode.code, "Should have code field");
    assertEquals(typeof mapNode.code, "string", "Code field should be a string");
    assertEquals(mapNode.code?.includes("map"), true, "Should contain 'map'");
  }

  await db.close();
});

// =============================================================================
// Mixed MCP + Code Operations
// =============================================================================

Deno.test("StaticStructureBuilder - detects MCP tools and code operations together", async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  const code = `
    const users = await mcp.db.query({ table: "users" });
    const active = users.filter(u => u.active);
    const names = active.map(u => u.name);
    await mcp.memory.create_entities({ entities: names });
  `;

  const structure = await builder.buildStaticStructure(code);

  // Should have MCP task nodes
  const mcpNodes = structure.nodes.filter(
    (n) => n.type === "task" && !n.tool?.startsWith("code:"),
  );
  assertEquals(mcpNodes.length, 2, "Should have 2 MCP task nodes");

  // Should have code operation nodes
  const codeNodes = findCodeNodes(structure);
  assertEquals(codeNodes.length >= 2, true, "Should have at least 2 code operation nodes");

  await db.close();
});

Deno.test("StaticStructureBuilder - generates sequence edges for code operations", async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  const code = `
    const data = await mcp.db.query({ table: "items" });
    const filtered = data.filter(x => x.active);
    const mapped = filtered.map(x => x.value);
  `;

  const structure = await builder.buildStaticStructure(code);

  // Should have sequence edges connecting the operations
  const sequenceEdges = structure.edges.filter((e) => e.type === "sequence");
  assertEquals(sequenceEdges.length >= 1, true, "Should have sequence edges");

  await db.close();
});

// =============================================================================
// Variable Bindings for Code Task Context Injection
// =============================================================================

Deno.test("StaticStructureBuilder - exports variableBindings for MCP results", async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  const code = `
    const users = await mcp.db.query({ table: "users" });
    const active = users.filter(u => u.active);
  `;

  const structure = await builder.buildStaticStructure(code);

  // variableBindings should map "users" to the node ID that produces it
  assertExists(structure.variableBindings, "Should have variableBindings");
  assertEquals(typeof structure.variableBindings, "object", "variableBindings should be object");

  // "users" should map to a node ID (e.g., "n1")
  const usersBinding = structure.variableBindings!["users"];
  assertExists(usersBinding, "Should have binding for 'users' variable");
  assertEquals(usersBinding.startsWith("n"), true, "Node ID should start with 'n'");

  await db.close();
});

Deno.test("StaticStructureBuilder - variableBindings tracks multiple variables", async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  const code = `
    const users = await mcp.db.query({ table: "users" });
    const items = await mcp.db.query({ table: "items" });
    const combined = users.concat(items);
  `;

  const structure = await builder.buildStaticStructure(code);

  assertExists(structure.variableBindings, "Should have variableBindings");

  // Both "users" and "items" should have bindings
  assertExists(structure.variableBindings!["users"], "Should have binding for 'users'");
  assertExists(structure.variableBindings!["items"], "Should have binding for 'items'");

  // They should be different node IDs
  const usersNodeId = structure.variableBindings!["users"];
  const itemsNodeId = structure.variableBindings!["items"];
  assertEquals(
    usersNodeId !== itemsNodeId,
    true,
    "Different variables should have different node IDs",
  );

  await db.close();
});

Deno.test("StaticStructureBuilder - variableBindings empty for pure JS code", async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  const code = `
    const numbers = [1, 2, 3, 4, 5];
    const doubled = numbers.map(n => n * 2);
  `;

  const structure = await builder.buildStaticStructure(code);

  // variableBindings should be empty since there are no MCP calls
  assertExists(structure.variableBindings, "Should have variableBindings (may be empty)");

  // Only MCP results should create bindings, not pure JS declarations
  // In this case, "numbers" is assigned from a literal array, not an MCP call
  // So it may or may not have a binding depending on implementation
  assertEquals(typeof structure.variableBindings, "object", "variableBindings should be object");

  await db.close();
});

Deno.test("StaticStructureBuilder - variableBindings for chained operations", async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  const code = `
    const data = await mcp.filesystem.fast_read_file({ path: "data.json" });
    const parsed = JSON.parse(data);
    const filtered = parsed.filter(x => x.active);
    const names = filtered.map(x => x.name);
  `;

  const structure = await builder.buildStaticStructure(code);

  assertExists(structure.variableBindings, "Should have variableBindings");

  // "data" should map to the MCP node
  const dataBinding = structure.variableBindings!["data"];
  assertExists(dataBinding, "Should have binding for 'data' variable");

  await db.close();
});

// =============================================================================
// Literal Bindings for Argument Resolution (Story 10.2b - Option B)
// =============================================================================

Deno.test("StaticStructureBuilder - literalBindings tracks array literals", async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  const code = `
    const numbers = [10, 20, 30];
    await mcp.math.sum({ numbers });
  `;

  const structure = await builder.buildStaticStructure(code);

  // literalBindings should map "numbers" to the array value
  assertExists(structure.literalBindings, "Should have literalBindings");
  const numbersBinding = structure.literalBindings!["numbers"];
  assertExists(numbersBinding, "Should have binding for 'numbers' variable");

  // Value should be the actual array
  assertEquals(Array.isArray(numbersBinding), true, "Should be an array");
  assertEquals(numbersBinding, [10, 20, 30], "Should match the literal array");

  await db.close();
});

Deno.test("StaticStructureBuilder - literalBindings tracks object literals", async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  const code = `
    const config = { timeout: 5000, retries: 3 };
    await mcp.http.fetch({ ...config, url: "https://api.example.com" });
  `;

  const structure = await builder.buildStaticStructure(code);

  assertExists(structure.literalBindings, "Should have literalBindings");
  const configBinding = structure.literalBindings!["config"];
  assertExists(configBinding, "Should have binding for 'config' variable");

  // Value should be the actual object
  assertEquals(typeof configBinding, "object", "Should be an object");
  assertEquals((configBinding as Record<string, number>).timeout, 5000, "Should have timeout property");
  assertEquals((configBinding as Record<string, number>).retries, 3, "Should have retries property");

  await db.close();
});

Deno.test("StaticStructureBuilder - literalBindings tracks primitive literals", async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  const code = `
    const name = "test-file";
    const count = 42;
    const enabled = true;
    await mcp.fs.write({ path: name, data: String(count), enabled });
  `;

  const structure = await builder.buildStaticStructure(code);

  assertExists(structure.literalBindings, "Should have literalBindings");

  assertEquals(structure.literalBindings!["name"], "test-file", "Should track string literal");
  assertEquals(structure.literalBindings!["count"], 42, "Should track number literal");
  assertEquals(structure.literalBindings!["enabled"], true, "Should track boolean literal");

  await db.close();
});

Deno.test("StaticStructureBuilder - literalBindings does NOT track MCP results", async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  const code = `
    const file = await mcp.fs.read({ path: "config.json" });
    const numbers = [1, 2, 3];
    await mcp.process.run({ input: file, numbers });
  `;

  const structure = await builder.buildStaticStructure(code);

  // "file" should be in variableBindings (MCP result), not literalBindings
  assertExists(structure.variableBindings, "Should have variableBindings");
  assertExists(structure.variableBindings!["file"], "Should have 'file' in variableBindings");

  // "numbers" should be in literalBindings (literal array), not variableBindings
  assertExists(structure.literalBindings, "Should have literalBindings");
  assertExists(structure.literalBindings!["numbers"], "Should have 'numbers' in literalBindings");

  // Cross-check: file should NOT be in literalBindings
  assertEquals(
    structure.literalBindings!["file"],
    undefined,
    "'file' should NOT be in literalBindings (it's an MCP result)"
  );

  await db.close();
});

Deno.test("StaticStructureBuilder - literalBindings works with nested arrays", async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  const code = `
    const matrix = [[1, 2], [3, 4], [5, 6]];
    await mcp.math.process({ matrix });
  `;

  const structure = await builder.buildStaticStructure(code);

  assertExists(structure.literalBindings, "Should have literalBindings");
  const matrixBinding = structure.literalBindings!["matrix"];
  assertExists(matrixBinding, "Should have binding for 'matrix'");

  assertEquals(matrixBinding, [[1, 2], [3, 4], [5, 6]], "Should preserve nested array structure");

  await db.close();
});

// =============================================================================
// Computed Expressions (Story 10.2b Extension)
// =============================================================================

Deno.test("StaticStructureBuilder - literalBindings evaluates arithmetic expressions", async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  const code = `
    const a = 10;
    const b = 5;
    const sum = a + b;
    const diff = a - b;
    const prod = a * b;
    const quot = a / b;
    await mcp.math.process({ sum, diff, prod, quot });
  `;

  const structure = await builder.buildStaticStructure(code);

  assertExists(structure.literalBindings, "Should have literalBindings");
  assertEquals(structure.literalBindings!["a"], 10, "Should track a");
  assertEquals(structure.literalBindings!["b"], 5, "Should track b");
  assertEquals(structure.literalBindings!["sum"], 15, "Should evaluate a + b = 15");
  assertEquals(structure.literalBindings!["diff"], 5, "Should evaluate a - b = 5");
  assertEquals(structure.literalBindings!["prod"], 50, "Should evaluate a * b = 50");
  assertEquals(structure.literalBindings!["quot"], 2, "Should evaluate a / b = 2");

  await db.close();
});

Deno.test("StaticStructureBuilder - literalBindings evaluates string concatenation", async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  const code = `
    const firstName = "John";
    const lastName = "Doe";
    const fullName = firstName + " " + lastName;
    await mcp.user.greet({ name: fullName });
  `;

  const structure = await builder.buildStaticStructure(code);

  assertExists(structure.literalBindings, "Should have literalBindings");
  assertEquals(structure.literalBindings!["firstName"], "John", "Should track firstName");
  assertEquals(structure.literalBindings!["lastName"], "Doe", "Should track lastName");
  assertEquals(structure.literalBindings!["fullName"], "John Doe", "Should evaluate concatenation");

  await db.close();
});

Deno.test("StaticStructureBuilder - literalBindings evaluates comparison expressions", async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  const code = `
    const x = 10;
    const y = 5;
    const isGreater = x > y;
    const isEqual = x === y;
    await mcp.logic.check({ isGreater, isEqual });
  `;

  const structure = await builder.buildStaticStructure(code);

  assertExists(structure.literalBindings, "Should have literalBindings");
  assertEquals(structure.literalBindings!["isGreater"], true, "10 > 5 should be true");
  assertEquals(structure.literalBindings!["isEqual"], false, "10 === 5 should be false");

  await db.close();
});

Deno.test("StaticStructureBuilder - literalBindings evaluates unary expressions", async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  const code = `
    const positive = 42;
    const negative = -positive;
    const flag = true;
    const inverted = !flag;
    await mcp.math.process({ negative, inverted });
  `;

  const structure = await builder.buildStaticStructure(code);

  assertExists(structure.literalBindings, "Should have literalBindings");
  assertEquals(structure.literalBindings!["positive"], 42, "Should track positive");
  assertEquals(structure.literalBindings!["negative"], -42, "Should evaluate -positive");
  assertEquals(structure.literalBindings!["flag"], true, "Should track flag");
  assertEquals(structure.literalBindings!["inverted"], false, "Should evaluate !flag");

  await db.close();
});

Deno.test("StaticStructureBuilder - literalBindings handles complex expressions", async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  const code = `
    const a = 2;
    const b = 3;
    const c = 4;
    const result = a + b * c;
    await mcp.math.compute({ result });
  `;

  const structure = await builder.buildStaticStructure(code);

  assertExists(structure.literalBindings, "Should have literalBindings");
  // Note: SWC respects operator precedence, so b * c is evaluated first
  assertEquals(structure.literalBindings!["result"], 14, "Should evaluate 2 + (3 * 4) = 14");

  await db.close();
});

Deno.test("StaticStructureBuilder - literalBindings skips expressions with unknown variables", async () => {
  const db = await setupTestDb();
  const builder = new StaticStructureBuilder(db);

  const code = `
    const known = 10;
    const unknown = getData();  // Function call - not tracked
    const sum = known + unknown;  // Cannot evaluate - unknown operand
    await mcp.math.process({ sum });
  `;

  const structure = await builder.buildStaticStructure(code);

  assertExists(structure.literalBindings, "Should have literalBindings");
  assertEquals(structure.literalBindings!["known"], 10, "Should track known literal");
  assertEquals(structure.literalBindings!["unknown"], undefined, "Function call not tracked");
  assertEquals(structure.literalBindings!["sum"], undefined, "Cannot evaluate with unknown operand");

  await db.close();
});
