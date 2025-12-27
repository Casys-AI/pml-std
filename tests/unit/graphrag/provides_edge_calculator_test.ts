/**
 * Tests for Provides Edge Calculator (Story 10.3)
 *
 * Tests the calculation of "provides" edges between tools based on
 * schema compatibility for data flow relationships.
 *
 * @module tests/unit/graphrag/provides_edge_calculator_test
 */

import { assert, assertEquals } from "@std/assert";
import {
  areTypesCompatible,
  computeCoverage,
  type ConsumerInputs,
  createFieldMapping,
} from "../../../src/graphrag/provides-edge-calculator.ts";
import type { JSONSchema } from "../../../src/graphrag/types.ts";

// =============================================================================
// areTypesCompatible Tests
// =============================================================================

Deno.test("areTypesCompatible - exact matches", () => {
  assertEquals(areTypesCompatible("string", "string"), true);
  assertEquals(areTypesCompatible("number", "number"), true);
  assertEquals(areTypesCompatible("boolean", "boolean"), true);
  assertEquals(areTypesCompatible("object", "object"), true);
  assertEquals(areTypesCompatible("array", "array"), true);
});

Deno.test("areTypesCompatible - case insensitive", () => {
  assertEquals(areTypesCompatible("String", "string"), true);
  assertEquals(areTypesCompatible("NUMBER", "number"), true);
});

Deno.test("areTypesCompatible - any type accepts all", () => {
  assertEquals(areTypesCompatible("string", "any"), true);
  assertEquals(areTypesCompatible("number", "any"), true);
  assertEquals(areTypesCompatible("object", "any"), true);
  assertEquals(areTypesCompatible("any", "string"), true);
  assertEquals(areTypesCompatible("any", "number"), true);
});

Deno.test("areTypesCompatible - relaxed rules (stringify)", () => {
  assertEquals(areTypesCompatible("number", "string"), true);
  assertEquals(areTypesCompatible("boolean", "string"), true);
  assertEquals(areTypesCompatible("integer", "string"), true);
});

Deno.test("areTypesCompatible - integer to number", () => {
  assertEquals(areTypesCompatible("integer", "number"), true);
});

Deno.test("areTypesCompatible - array to object", () => {
  assertEquals(areTypesCompatible("array", "object"), true);
});

Deno.test("areTypesCompatible - strict mode only exact matches", () => {
  assertEquals(areTypesCompatible("number", "string", true), false);
  assertEquals(areTypesCompatible("boolean", "string", true), false);
  assertEquals(areTypesCompatible("integer", "number", true), false);
  assertEquals(areTypesCompatible("string", "string", true), true);
  assertEquals(areTypesCompatible("number", "number", true), true);
});

Deno.test("areTypesCompatible - undefined treated as any", () => {
  assertEquals(areTypesCompatible(undefined, "string"), true);
  assertEquals(areTypesCompatible("string", undefined), true);
  assertEquals(areTypesCompatible(undefined, undefined), true);
});

Deno.test("areTypesCompatible - incompatible types", () => {
  assertEquals(areTypesCompatible("string", "number"), false);
  assertEquals(areTypesCompatible("object", "string"), false);
});

// =============================================================================
// computeCoverage Tests
// =============================================================================

Deno.test("computeCoverage - strict when all required covered", () => {
  const providerOutputs = new Set(["content", "path", "size"]);
  const consumerInputs: ConsumerInputs = {
    required: new Set(["content"]),
    optional: new Set(["encoding"]),
  };

  assertEquals(computeCoverage(providerOutputs, consumerInputs), "strict");
});

Deno.test("computeCoverage - strict when multiple required covered", () => {
  const providerOutputs = new Set(["name", "value", "type"]);
  const consumerInputs: ConsumerInputs = {
    required: new Set(["name", "value"]),
    optional: new Set([]),
  };

  assertEquals(computeCoverage(providerOutputs, consumerInputs), "strict");
});

Deno.test("computeCoverage - partial when some required covered", () => {
  const providerOutputs = new Set(["content"]);
  const consumerInputs: ConsumerInputs = {
    required: new Set(["content", "path"]),
    optional: new Set([]),
  };

  assertEquals(computeCoverage(providerOutputs, consumerInputs), "partial");
});

Deno.test("computeCoverage - fs:read -> json:parse no exact match", () => {
  // fs:read_file outputs: { content: string }
  // json:parse inputs: { json: string } (required)
  // No exact name match (semantic matching is in createFieldMapping)
  const providerOutputs = new Set(["content"]);
  const consumerInputs: ConsumerInputs = {
    required: new Set(["json"]),
    optional: new Set([]),
  };

  assertEquals(computeCoverage(providerOutputs, consumerInputs), null);
});

Deno.test("computeCoverage - optional when only optional covered", () => {
  const providerOutputs = new Set(["encoding"]);
  const consumerInputs: ConsumerInputs = {
    required: new Set(["path"]),
    optional: new Set(["encoding"]),
  };

  assertEquals(computeCoverage(providerOutputs, consumerInputs), "optional");
});

Deno.test("computeCoverage - null when no intersection", () => {
  const providerOutputs = new Set(["content"]);
  const consumerInputs: ConsumerInputs = {
    required: new Set(["url"]),
    optional: new Set(["timeout"]),
  };

  assertEquals(computeCoverage(providerOutputs, consumerInputs), null);
});

Deno.test("computeCoverage - null for empty provider", () => {
  const providerOutputs = new Set<string>();
  const consumerInputs: ConsumerInputs = {
    required: new Set(["input"]),
    optional: new Set([]),
  };

  assertEquals(computeCoverage(providerOutputs, consumerInputs), null);
});

Deno.test("computeCoverage - null for empty consumer", () => {
  const providerOutputs = new Set(["output"]);
  const consumerInputs: ConsumerInputs = {
    required: new Set<string>(),
    optional: new Set<string>(),
  };

  assertEquals(computeCoverage(providerOutputs, consumerInputs), null);
});

Deno.test("computeCoverage - partial for json:parse -> http:post", () => {
  // json:parse could output: { body: object }
  // http:post inputs: { url: string (required), body: object (required) }
  const providerOutputs = new Set(["body"]);
  const consumerInputs: ConsumerInputs = {
    required: new Set(["url", "body"]),
    optional: new Set([]),
  };

  assertEquals(computeCoverage(providerOutputs, consumerInputs), "partial");
});

// =============================================================================
// createFieldMapping Tests
// =============================================================================

Deno.test("createFieldMapping - exact field match", () => {
  const providerOutput: JSONSchema = {
    type: "object",
    properties: {
      content: { type: "string" },
      path: { type: "string" },
    },
  };

  const consumerInput: JSONSchema = {
    type: "object",
    properties: {
      content: { type: "string" },
      encoding: { type: "string" },
    },
    required: ["content"],
  };

  const mapping = createFieldMapping(providerOutput, consumerInput);

  assertEquals(mapping.length, 1);
  assertEquals(mapping[0].fromField, "content");
  assertEquals(mapping[0].toField, "content");
  assertEquals(mapping[0].typeCompatible, true);
});

Deno.test("createFieldMapping - semantic match content -> json", () => {
  const providerOutput: JSONSchema = {
    type: "object",
    properties: {
      content: { type: "string" },
    },
  };

  const consumerInput: JSONSchema = {
    type: "object",
    properties: {
      json: { type: "string" },
    },
    required: ["json"],
  };

  const mapping = createFieldMapping(providerOutput, consumerInput);

  assertEquals(mapping.length, 1);
  assertEquals(mapping[0].fromField, "content");
  assertEquals(mapping[0].toField, "json");
  assertEquals(mapping[0].typeCompatible, true);
});

Deno.test("createFieldMapping - semantic match text -> content", () => {
  const providerOutput: JSONSchema = {
    type: "object",
    properties: {
      text: { type: "string" },
    },
  };

  const consumerInput: JSONSchema = {
    type: "object",
    properties: {
      content: { type: "string" },
    },
  };

  const mapping = createFieldMapping(providerOutput, consumerInput);

  assertEquals(mapping.length, 1);
  assertEquals(mapping[0].fromField, "text");
  assertEquals(mapping[0].toField, "content");
});

Deno.test("createFieldMapping - semantic match file -> path", () => {
  const providerOutput: JSONSchema = {
    type: "object",
    properties: {
      file: { type: "string" },
    },
  };

  const consumerInput: JSONSchema = {
    type: "object",
    properties: {
      path: { type: "string" },
    },
  };

  const mapping = createFieldMapping(providerOutput, consumerInput);

  assertEquals(mapping.length, 1);
  assertEquals(mapping[0].fromField, "file");
  assertEquals(mapping[0].toField, "path");
});

Deno.test("createFieldMapping - type compatible when types match", () => {
  const providerOutput: JSONSchema = {
    type: "object",
    properties: {
      count: { type: "number" },
    },
  };

  const consumerInput: JSONSchema = {
    type: "object",
    properties: {
      count: { type: "number" },
    },
  };

  const mapping = createFieldMapping(providerOutput, consumerInput);

  assertEquals(mapping[0].typeCompatible, true);
  assertEquals(mapping[0].fromType, "number");
  assertEquals(mapping[0].toType, "number");
});

Deno.test("createFieldMapping - type compatible for number -> string", () => {
  const providerOutput: JSONSchema = {
    type: "object",
    properties: {
      value: { type: "number" },
    },
  };

  const consumerInput: JSONSchema = {
    type: "object",
    properties: {
      value: { type: "string" },
    },
  };

  const mapping = createFieldMapping(providerOutput, consumerInput);

  assertEquals(mapping[0].typeCompatible, true);
});

Deno.test("createFieldMapping - type incompatible for object -> string", () => {
  const providerOutput: JSONSchema = {
    type: "object",
    properties: {
      data: { type: "object" },
    },
  };

  const consumerInput: JSONSchema = {
    type: "object",
    properties: {
      data: { type: "string" },
    },
  };

  const mapping = createFieldMapping(providerOutput, consumerInput);

  assertEquals(mapping[0].typeCompatible, false);
});

Deno.test("createFieldMapping - empty when no matches", () => {
  const providerOutput: JSONSchema = {
    type: "object",
    properties: {
      foo: { type: "string" },
    },
  };

  const consumerInput: JSONSchema = {
    type: "object",
    properties: {
      bar: { type: "string" },
    },
  };

  const mapping = createFieldMapping(providerOutput, consumerInput);

  assertEquals(mapping.length, 0);
});

Deno.test("createFieldMapping - empty provider output", () => {
  const providerOutput: JSONSchema = {
    type: "object",
    properties: {},
  };

  const consumerInput: JSONSchema = {
    type: "object",
    properties: {
      input: { type: "string" },
    },
  };

  const mapping = createFieldMapping(providerOutput, consumerInput);

  assertEquals(mapping.length, 0);
});

Deno.test("createFieldMapping - missing properties object", () => {
  const providerOutput: JSONSchema = {
    type: "object",
  };

  const consumerInput: JSONSchema = {
    type: "object",
    properties: {
      input: { type: "string" },
    },
  };

  const mapping = createFieldMapping(providerOutput, consumerInput);

  assertEquals(mapping.length, 0);
});

// =============================================================================
// Integration Tests
// =============================================================================

Deno.test("Integration - fs:read_file -> json:parse semantic match", () => {
  const fsReadOutput: JSONSchema = {
    type: "object",
    properties: {
      content: { type: "string" },
    },
  };

  const jsonParseInput: JSONSchema = {
    type: "object",
    properties: {
      json: { type: "string" },
    },
    required: ["json"],
  };

  const mapping = createFieldMapping(fsReadOutput, jsonParseInput);

  assert(mapping.some((m) => m.fromField === "content" && m.toField === "json"));
});

Deno.test("Integration - empty output schema", () => {
  const providerOutput: JSONSchema = {};
  const consumerInput: JSONSchema = {
    type: "object",
    properties: {
      input: { type: "string" },
    },
    required: ["input"],
  };

  const mapping = createFieldMapping(providerOutput, consumerInput);

  assertEquals(mapping.length, 0);
});

Deno.test("Integration - multiple field mappings", () => {
  const providerOutput: JSONSchema = {
    type: "object",
    properties: {
      content: { type: "string" },
      path: { type: "string" },
      size: { type: "number" },
    },
  };

  const consumerInput: JSONSchema = {
    type: "object",
    properties: {
      content: { type: "string" },
      path: { type: "string" },
      limit: { type: "number" },
    },
    required: ["content"],
  };

  const mapping = createFieldMapping(providerOutput, consumerInput);

  assertEquals(mapping.length, 2);
  assert(mapping.some((m) => m.fromField === "content" && m.toField === "content"));
  assert(mapping.some((m) => m.fromField === "path" && m.toField === "path"));
});

// =============================================================================
// DB Persistence Tests (AC10)
// =============================================================================

import { PGliteClient } from "../../../src/db/client.ts";
import { getAllMigrations, MigrationRunner } from "../../../src/db/migrations.ts";
import {
  findDirectProvidesEdge,
  getToolProvidesEdges,
  persistProvidesEdges,
  syncAllProvidesEdges,
  syncProvidesEdgesForTool,
} from "../../../src/graphrag/provides-edge-calculator.ts";
import type { ProvidesEdge } from "../../../src/graphrag/types.ts";

/**
 * Create test database with schema
 */
async function createTestDb(): Promise<PGliteClient> {
  const db = new PGliteClient(`memory://${crypto.randomUUID()}`);
  await db.connect();

  const migrationRunner = new MigrationRunner(db);
  await migrationRunner.runUp(getAllMigrations());

  return db;
}

/**
 * Insert test tool schemas
 * Note: tool_schema table has columns: tool_id, server_id, name, description, input_schema, output_schema
 */
async function insertToolSchemas(db: PGliteClient): Promise<void> {
  // Tool A: has output only (provider)
  await db.query(
    `INSERT INTO tool_schema (tool_id, server_id, name, input_schema, output_schema)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      "fs:read",
      "filesystem",
      "read",
      JSON.stringify({
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      }),
      JSON.stringify({ type: "object", properties: { content: { type: "string" } } }),
    ],
  );

  // Tool B: has input and output (consumer of A, provider to C)
  await db.query(
    `INSERT INTO tool_schema (tool_id, server_id, name, input_schema, output_schema)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      "json:parse",
      "json",
      "parse",
      JSON.stringify({
        type: "object",
        properties: { json: { type: "string" } },
        required: ["json"],
      }),
      JSON.stringify({ type: "object", properties: { parsed: { type: "object" } } }),
    ],
  );

  // Tool C: has input only (consumer)
  await db.query(
    `INSERT INTO tool_schema (tool_id, server_id, name, input_schema, output_schema)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      "http:post",
      "http",
      "post",
      JSON.stringify({
        type: "object",
        properties: { url: { type: "string" }, body: { type: "object" } },
        required: ["url"],
      }),
      null,
    ],
  );
}

Deno.test("DB Persistence - persistProvidesEdges stores edges", async () => {
  const db = await createTestDb();

  const edges: ProvidesEdge[] = [
    {
      from: "tool-a",
      to: "tool-b",
      type: "provides",
      coverage: "strict",
      providerOutputSchema: {},
      consumerInputSchema: {},
      fieldMapping: [],
      weight: 0.7,
    },
    {
      from: "tool-b",
      to: "tool-c",
      type: "provides",
      coverage: "partial",
      providerOutputSchema: {},
      consumerInputSchema: {},
      fieldMapping: [],
      weight: 0.7,
    },
  ];

  const persisted = await persistProvidesEdges(db, edges);
  assertEquals(persisted, 2);

  // Verify they're in the DB
  const rows = await db.query(
    `SELECT from_tool_id, to_tool_id, edge_type, confidence_score FROM tool_dependency WHERE edge_type = 'provides'`,
  ) as unknown as {
    from_tool_id: string;
    to_tool_id: string;
    edge_type: string;
    confidence_score: number;
  }[];

  assertEquals(rows.length, 2);
  assert(rows.some((r) => r.from_tool_id === "tool-a" && r.confidence_score === 1.0)); // strict
  assert(rows.some((r) => r.from_tool_id === "tool-b" && r.confidence_score === 0.7)); // partial

  await db.close();
});

Deno.test("DB Persistence - getToolProvidesEdges queries from DB", async () => {
  const db = await createTestDb();

  // Insert provides edges directly
  await db.query(
    `INSERT INTO tool_dependency (from_tool_id, to_tool_id, edge_type, edge_source, confidence_score)
     VALUES ('a', 'b', 'provides', 'inferred', 1.0),
            ('a', 'c', 'provides', 'inferred', 0.7),
            ('d', 'a', 'provides', 'inferred', 0.4)`,
  );

  // Get edges where 'a' is provider
  const fromEdges = await getToolProvidesEdges(db, "a", "from");
  assertEquals(fromEdges.length, 2);
  assert(fromEdges.every((e) => e.from === "a"));

  // Get edges where 'a' is consumer
  const toEdges = await getToolProvidesEdges(db, "a", "to");
  assertEquals(toEdges.length, 1);
  assertEquals(toEdges[0].from, "d");

  // Get all edges involving 'a'
  const allEdges = await getToolProvidesEdges(db, "a", "both");
  assertEquals(allEdges.length, 3);

  await db.close();
});

Deno.test("DB Persistence - findDirectProvidesEdge returns edge or null", async () => {
  const db = await createTestDb();
  await insertToolSchemas(db);

  // Insert a provides edge
  await db.query(
    `INSERT INTO tool_dependency (from_tool_id, to_tool_id, edge_type, edge_source, confidence_score)
     VALUES ('fs:read', 'json:parse', 'provides', 'inferred', 0.7)`,
  );

  // Should find the edge
  const edge = await findDirectProvidesEdge(db, "fs:read", "json:parse");
  assert(edge !== null);
  assertEquals(edge!.from, "fs:read");
  assertEquals(edge!.to, "json:parse");
  assertEquals(edge!.coverage, "partial"); // 0.7 -> partial

  // Should NOT find reverse edge
  const noEdge = await findDirectProvidesEdge(db, "json:parse", "fs:read");
  assertEquals(noEdge, null);

  await db.close();
});

Deno.test("DB Persistence - syncAllProvidesEdges calculates and stores", async () => {
  const db = await createTestDb();

  // Insert tools with MATCHING field names for exact coverage match
  // Tool A outputs "data", Tool B requires "data" as input
  await db.query(
    `INSERT INTO tool_schema (tool_id, server_id, name, input_schema, output_schema) VALUES
     ('provider:a', 'test', 'provider', $1, $2),
     ('consumer:b', 'test', 'consumer', $3, NULL)`,
    [
      JSON.stringify({ type: "object", properties: { path: { type: "string" } } }),
      JSON.stringify({
        type: "object",
        properties: { data: { type: "string" }, size: { type: "number" } },
      }),
      JSON.stringify({
        type: "object",
        properties: { data: { type: "string" } },
        required: ["data"],
      }),
    ],
  );

  // Sync all
  const count = await syncAllProvidesEdges(db);

  // provider:a -> consumer:b (data matches exactly)
  assert(count >= 1, `Expected at least 1 edge, got ${count}`);

  // Verify edges in DB
  const rows = await db.query(
    `SELECT * FROM tool_dependency WHERE edge_type = 'provides'`,
  ) as unknown[];
  assert(rows.length >= 1);

  await db.close();
});

Deno.test("DB Persistence - syncProvidesEdgesForTool incremental update", async () => {
  const db = await createTestDb();

  // Insert a provider tool with "data" output
  await db.query(
    `INSERT INTO tool_schema (tool_id, server_id, name, input_schema, output_schema) VALUES
     ('source:tool', 'test', 'source', $1, $2)`,
    [
      JSON.stringify({ type: "object", properties: { query: { type: "string" } } }),
      JSON.stringify({ type: "object", properties: { data: { type: "string" } } }),
    ],
  );

  // Sync source tool (no consumers yet, so 0 edges)
  const count1 = await syncProvidesEdgesForTool(db, "source:tool");
  assertEquals(count1, 0);

  // Add a consumer tool that requires "data"
  await db.query(
    `INSERT INTO tool_schema (tool_id, server_id, name, input_schema, output_schema) VALUES
     ('sink:tool', 'test', 'sink', $1, NULL)`,
    [
      JSON.stringify({
        type: "object",
        properties: { data: { type: "string" } },
        required: ["data"],
      }),
    ],
  );

  // Sync source tool again - now it can provide to sink
  const count2 = await syncProvidesEdgesForTool(db, "source:tool");
  assertEquals(count2, 1, "source:tool should now provide to sink:tool");

  // Verify edge exists
  const edge = await findDirectProvidesEdge(db, "source:tool", "sink:tool");
  assert(edge !== null);
  assertEquals(edge!.coverage, "strict"); // "data" covers all required fields

  await db.close();
});

Deno.test("DB Persistence - coverage to confidence mapping", async () => {
  const db = await createTestDb();

  // Test all coverage levels
  const edges: ProvidesEdge[] = [
    {
      from: "a",
      to: "b",
      type: "provides",
      coverage: "strict",
      providerOutputSchema: {},
      consumerInputSchema: {},
      fieldMapping: [],
      weight: 0.7,
    },
    {
      from: "c",
      to: "d",
      type: "provides",
      coverage: "partial",
      providerOutputSchema: {},
      consumerInputSchema: {},
      fieldMapping: [],
      weight: 0.7,
    },
    {
      from: "e",
      to: "f",
      type: "provides",
      coverage: "optional",
      providerOutputSchema: {},
      consumerInputSchema: {},
      fieldMapping: [],
      weight: 0.7,
    },
  ];

  await persistProvidesEdges(db, edges);

  // Query back and check coverage conversion
  const strictEdge = await getToolProvidesEdges(db, "a", "from");
  assertEquals(strictEdge[0].coverage, "strict");

  const partialEdge = await getToolProvidesEdges(db, "c", "from");
  assertEquals(partialEdge[0].coverage, "partial");

  const optionalEdge = await getToolProvidesEdges(db, "e", "from");
  assertEquals(optionalEdge[0].coverage, "optional");

  await db.close();
});
