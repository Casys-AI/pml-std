/**
 * Unit tests for Migration 035: pml_registry VIEW (Story 13.8)
 *
 * Tests cover:
 * - AC1: code_url and routing columns added to tool_schema
 * - AC2: pml_registry VIEW created with UNION
 * - AC4: Migration up/down works correctly
 */

import { assertEquals, assertExists } from "@std/assert";
import { createPmlRegistryViewMigration } from "../../../../src/db/migrations/035_pml_registry_view.ts";
import { PGliteClient } from "../../../../src/db/client.ts";
import { getAllMigrations, MigrationRunner } from "../../../../src/db/migrations.ts";

// Helper to create unique test database using in-memory databases
function getTestDbPath(testName: string): string {
  return `memory://${testName}-${crypto.randomUUID()}`;
}

// Helper to insert test data after migrations
async function insertTestData(db: PGliteClient): Promise<{
  toolId: string;
  capabilityId: string;
  patternId: string;
}> {
  // Insert tool
  const toolId = "filesystem:read_file";
  await db.exec(`
    INSERT INTO tool_schema (tool_id, server_id, name, description, input_schema)
    VALUES ('${toolId}', 'filesystem', 'read_file', 'Read a file', '{}')
    ON CONFLICT (tool_id) DO NOTHING
  `);

  // Insert workflow_pattern (requires pattern_hash, dag_structure, intent_embedding NOT NULL)
  const patternHash = crypto.randomUUID().substring(0, 8);
  // Create a dummy 1024-dimension vector (all zeros is fine for testing)
  const dummyEmbedding = `[${Array(1024).fill("0").join(",")}]`;

  const patternResult = await db.query(`
    INSERT INTO workflow_pattern (description, pattern_hash, dag_structure, intent_embedding)
    VALUES ('Test capability', '${patternHash}', '{"nodes": [], "edges": []}', '${dummyEmbedding}')
    RETURNING pattern_id
  `);
  const patternId = patternResult[0].pattern_id as string;

  // Insert capability_records
  const capResult = await db.query(`
    INSERT INTO capability_records (org, project, namespace, action, hash, workflow_pattern_id)
    VALUES ('local', 'default', 'fs', 'read_json', 'a7f3', '${patternId}')
    RETURNING id
  `);
  const capabilityId = capResult[0].id as string;

  return { toolId, capabilityId, patternId };
}

Deno.test("Migration 031 - AC1: adds code_url column to tool_schema", async () => {
  const client = new PGliteClient(getTestDbPath("ac1-code-url"));
  await client.connect();

  try {
    // Run all migrations including 031
    const runner = new MigrationRunner(client);
    await runner.runUp(getAllMigrations());

    // Check code_url column exists
    const result = await client.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'tool_schema' AND column_name = 'code_url'
    `);

    assertEquals(result.length, 1);
    assertEquals(result[0].column_name, "code_url");
    assertEquals(result[0].data_type, "text");
  } finally {
    await client.close();
  }
});

Deno.test("Migration 031 - AC1: adds routing column to tool_schema with default 'local'", async () => {
  const client = new PGliteClient(getTestDbPath("ac1-routing"));
  await client.connect();

  try {
    const runner = new MigrationRunner(client);
    await runner.runUp(getAllMigrations());

    // Check routing column exists with default
    const result = await client.query(`
      SELECT column_name, column_default
      FROM information_schema.columns
      WHERE table_name = 'tool_schema' AND column_name = 'routing'
    `);

    assertEquals(result.length, 1);
    assertEquals(result[0].column_name, "routing");
    // Default should be 'local' for security
    assertExists(result[0].column_default);
  } finally {
    await client.close();
  }
});

Deno.test("Migration 031 - AC2: pml_registry VIEW returns MCP tools", async () => {
  const client = new PGliteClient(getTestDbPath("ac2-mcp-tools"));
  await client.connect();

  try {
    const runner = new MigrationRunner(client);
    await runner.runUp(getAllMigrations());

    const { toolId } = await insertTestData(client);

    // Query the VIEW
    const result = await client.query(`
      SELECT record_type, id, name, description, routing, server_id
      FROM pml_registry
      WHERE record_type = 'mcp-tool'
    `);

    assertEquals(result.length, 1);
    assertEquals(result[0].record_type, "mcp-tool");
    assertEquals(result[0].id, toolId);
    assertEquals(result[0].name, "read_file");
    assertEquals(result[0].description, "Read a file");
    assertEquals(result[0].routing, "local");
    assertEquals(result[0].server_id, "filesystem");
  } finally {
    await client.close();
  }
});

Deno.test("Migration 031 - AC2: pml_registry VIEW returns capabilities", async () => {
  const client = new PGliteClient(getTestDbPath("ac2-capabilities"));
  await client.connect();

  try {
    const runner = new MigrationRunner(client);
    await runner.runUp(getAllMigrations());

    const { capabilityId, patternId } = await insertTestData(client);

    // Query the VIEW
    const result = await client.query(`
      SELECT record_type, id, name, description, routing, workflow_pattern_id, org, project, namespace, action
      FROM pml_registry
      WHERE record_type = 'capability'
    `);

    assertEquals(result.length, 1);
    assertEquals(result[0].record_type, "capability");
    assertEquals(result[0].id, capabilityId);
    assertEquals(result[0].name, "fs:read_json");
    assertEquals(result[0].description, "Test capability");
    assertEquals(result[0].routing, "local");
    assertEquals(result[0].workflow_pattern_id, patternId);
    assertEquals(result[0].org, "local");
    assertEquals(result[0].project, "default");
    assertEquals(result[0].namespace, "fs");
    assertEquals(result[0].action, "read_json");
  } finally {
    await client.close();
  }
});

Deno.test("Migration 031 - AC2: pml_registry VIEW returns both types with UNION", async () => {
  const client = new PGliteClient(getTestDbPath("ac2-union"));
  await client.connect();

  try {
    const runner = new MigrationRunner(client);
    await runner.runUp(getAllMigrations());

    await insertTestData(client);

    // Query all records
    const result = await client.query(`
      SELECT record_type, name
      FROM pml_registry
      ORDER BY record_type
    `);

    assertEquals(result.length, 2);

    // Should have both types
    const types = result.map((r) => r.record_type);
    assertEquals(types.includes("capability"), true);
    assertEquals(types.includes("mcp-tool"), true);
  } finally {
    await client.close();
  }
});

Deno.test("Migration 031 - AC2: pml_registry VIEW supports name search", async () => {
  const client = new PGliteClient(getTestDbPath("ac2-search"));
  await client.connect();

  try {
    const runner = new MigrationRunner(client);
    await runner.runUp(getAllMigrations());

    await insertTestData(client);

    // Search by name pattern
    const result = await client.query(`
      SELECT record_type, name
      FROM pml_registry
      WHERE name ILIKE '%read%'
    `);

    // Both tool (read_file) and capability (fs:read_json) should match
    assertEquals(result.length, 2);
  } finally {
    await client.close();
  }
});

Deno.test("Migration 031 - rollback removes VIEW and columns", async () => {
  const client = new PGliteClient(getTestDbPath("rollback"));
  await client.connect();

  try {
    const runner = new MigrationRunner(client);
    await runner.runUp(getAllMigrations());

    // Verify VIEW exists
    const viewBefore = await client.query(`
      SELECT table_name FROM information_schema.views
      WHERE table_name = 'pml_registry'
    `);
    assertEquals(viewBefore.length, 1);

    // Get migration for rollback
    const migration = createPmlRegistryViewMigration();

    // Rollback just migration 031
    await migration.down(client);

    // Verify VIEW is gone
    const viewAfter = await client.query(`
      SELECT table_name FROM information_schema.views
      WHERE table_name = 'pml_registry'
    `);
    assertEquals(viewAfter.length, 0);

    // Verify columns are gone
    const columns = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'tool_schema' AND column_name IN ('code_url', 'routing')
    `);
    assertEquals(columns.length, 0);
  } finally {
    await client.close();
  }
});
