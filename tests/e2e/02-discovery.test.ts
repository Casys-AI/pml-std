/**
 * E2E Test 02: MCP Server Discovery
 *
 * Tests MCP server discovery and tool extraction.
 */

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  cleanupTestDatabase,
  initializeTestDatabase,
  storeSchemas,
} from "../fixtures/test-helpers.ts";
import {
  createMockApiServer,
  createMockFilesystemServer,
  createMockJsonServer,
} from "../fixtures/mock-mcp-server.ts";

Deno.test("E2E 02: MCP server discovery and tool extraction", async (t) => {
  let testDir: string | undefined;
  let db: any;

  try {
    await t.step("1. Setup test database", async () => {
      testDir = await Deno.makeTempDir({ prefix: "pml_e2e_02_" });
      db = await initializeTestDatabase(testDir);
    });

    await t.step("2. Create mock MCP servers", async () => {
      // Mock servers are created successfully
      const filesystemServer = createMockFilesystemServer();
      const jsonServer = createMockJsonServer();
      const apiServer = createMockApiServer();

      assertEquals(filesystemServer.serverId, "filesystem");
      assertEquals(jsonServer.serverId, "json");
      assertEquals(apiServer.serverId, "api");
    });

    await t.step("3. Discover tools from filesystem server", async () => {
      const server = createMockFilesystemServer();
      const tools = await server.listTools();

      assert(tools.length > 0, "Filesystem server should have tools");
      assertEquals(tools.length, 3); // read, write, list

      // Verify tool schema structure
      const readTool = tools.find((t) => t.name === "read");
      assert(readTool, "read tool should exist");
      assertEquals(readTool.name, "read");
      assert(readTool.description, "Tool should have description");
      assert(readTool.inputSchema, "Tool should have input schema");
    });

    await t.step("4. Store discovered schemas in database", async () => {
      const server = createMockFilesystemServer();
      const tools = await server.listTools();

      await storeSchemas(db, "filesystem", tools);

      const result = await db.query(
        `SELECT COUNT(*) as count FROM tool_schema WHERE server_id = $1`,
        ["filesystem"],
      );

      assertEquals(result[0].count, 3);
    });

    await t.step("5. Verify tool schemas are retrievable", async () => {
      const result = await db.query(
        `SELECT name, description, input_schema FROM tool_schema WHERE server_id = $1`,
        ["filesystem"],
      );

      assertEquals(result.length, 3);

      for (const row of result) {
        assert(row.name, "Schema should have name");
        assert(row.description, "Schema should have description");
        const inputSchema = typeof row.input_schema === "string"
          ? JSON.parse(row.input_schema)
          : row.input_schema;
        assert(inputSchema, "Schema should have inputSchema");
      }
    });

    await t.step("6. Discover and store multiple servers", async () => {
      const servers = [
        createMockFilesystemServer(),
        createMockJsonServer(),
        createMockApiServer(),
      ];

      for (const server of servers) {
        const tools = await server.listTools();
        await storeSchemas(db, server.serverId, tools);
      }

      const result = await db.query(`SELECT COUNT(*) as count FROM tool_schema`);

      // 3 (filesystem) + 2 (json) + 2 (api) = 7 tools
      assert(result[0].count >= 7, "All tools should be stored");
    });

    await t.step("7. Test conflict handling (re-discovery)", async () => {
      const server = createMockFilesystemServer();
      const tools = await server.listTools();

      // Store schemas twice
      await storeSchemas(db, "filesystem", tools);
      await storeSchemas(db, "filesystem", tools);

      const result = await db.query(
        `SELECT COUNT(*) as count FROM tool_schema WHERE server_id = $1`,
        ["filesystem"],
      );

      // Should still be 3 (not duplicated)
      assertEquals(result[0].count, 3);
    });

    await t.step("8. Query tools by server", async () => {
      const result = await db.query(
        `
        SELECT server_id, COUNT(*) as tool_count
        FROM tool_schema
        GROUP BY server_id
        ORDER BY server_id
      `,
      );

      assert(result.length >= 3, "Should have at least 3 servers");

      // Verify each server has tools
      for (const row of result) {
        assert(row.tool_count > 0, `Server ${row.server_id} should have tools`);
      }
    });
  } finally {
    if (db && testDir) {
      await cleanupTestDatabase(db, testDir);
    }
  }
});
