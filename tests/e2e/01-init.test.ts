/**
 * E2E Test 01: Initialization and Migrations
 *
 * Tests database initialization, migrations, and schema setup.
 * Story 11.0: Updated to use tool_schema instead of mcp_tool/mcp_server.
 */

import { assert, assertEquals } from "jsr:@std/assert@1";
import { cleanupTestDatabase, initializeTestDatabase } from "../fixtures/test-helpers.ts";

Deno.test("E2E 01: Database initialization and migrations", async (t) => {
  let testDir: string | undefined;
  let db: any;

  try {
    await t.step("1. Create temporary directory", async () => {
      testDir = await Deno.makeTempDir({ prefix: "pml_e2e_01_" });
      assert(testDir, "Test directory should be created");
    });

    await t.step("2. Initialize database with migrations", async () => {
      db = await initializeTestDatabase(testDir!);
      assert(db, "Database should be initialized");
    });

    await t.step("3. Verify tool_schema table exists", async () => {
      const result = await db.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_name = 'tool_schema'
        )
      `);
      assertEquals(result[0].exists, true);
    });

    await t.step("4. Verify tool_embedding table exists", async () => {
      const result = await db.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_name = 'tool_embedding'
        )
      `);
      assertEquals(result[0].exists, true);
    });

    await t.step("5. Verify pgvector extension is enabled", async () => {
      const result = await db.query(`
        SELECT EXISTS (
          SELECT FROM pg_extension
          WHERE extname = 'vector'
        )
      `);
      assertEquals(result[0].exists, true);
    });

    await t.step("6. Verify HNSW index exists on embeddings", async () => {
      const result = await db.query(`
        SELECT indexname
        FROM pg_indexes
        WHERE tablename = 'tool_embedding'
        AND indexname LIKE '%hnsw%'
      `);
      assert(result.length > 0, "HNSW index should exist");
    });

    await t.step("7. Test basic insert into tool_schema", async () => {
      const toolId = "test-server:test_tool";
      await db.query(
        `
        INSERT INTO tool_schema (tool_id, server_id, name, description, input_schema)
        VALUES ($1, $2, $3, $4, $5)
      `,
        [
          toolId,
          "test-server",
          "test_tool",
          "A test tool",
          JSON.stringify({ type: "object" }),
        ],
      );

      const result = await db.query(
        `SELECT * FROM tool_schema WHERE tool_id = $1`,
        [toolId],
      );

      assertEquals(result.length, 1);
      assertEquals(result[0].name, "test_tool");
      assertEquals(result[0].server_id, "test-server");
    });

    await t.step("8. Test vector insert into tool_embedding", async () => {
      const toolId = "test-server:test_tool";

      // Create a test vector (1024 dimensions for BGE-M3)
      const testVector = Array(1024).fill(0).map((_, i) => i / 1024);

      await db.query(
        `
        INSERT INTO tool_embedding (tool_id, server_id, tool_name, embedding)
        VALUES ($1, $2, $3, $4::vector)
      `,
        [toolId, "test-server", "test_tool", `[${testVector.join(",")}]`],
      );

      const result = await db.query(
        `SELECT * FROM tool_embedding WHERE tool_id = $1`,
        [toolId],
      );

      assertEquals(result.length, 1);
      assert(result[0].embedding, "Embedding should be stored");
    });

    await t.step("9. Verify tool_dependency table exists", async () => {
      const result = await db.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_name = 'tool_dependency'
        )
      `);
      assertEquals(result[0].exists, true);
    });

    await t.step("10. Verify workflow_pattern table exists", async () => {
      const result = await db.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_name = 'workflow_pattern'
        )
      `);
      assertEquals(result[0].exists, true);
    });
  } finally {
    // Cleanup
    if (db && testDir) {
      await cleanupTestDatabase(db, testDir);
    }
  }
});
