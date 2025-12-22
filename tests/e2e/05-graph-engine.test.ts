/**
 * E2E Test 05: GraphRAG Engine
 *
 * Simplified test for graph construction and stats.
 */

import { assert } from "jsr:@std/assert@1";
import {
  cleanupTestDatabase,
  initializeTestDatabase,
  storeSchemas,
} from "../fixtures/test-helpers.ts";
import { createMockFilesystemServer } from "../fixtures/mock-mcp-server.ts";
import { GraphRAGEngine } from "../../src/graphrag/graph-engine.ts";

Deno.test("E2E 05: GraphRAG engine", async (t) => {
  let testDir: string | undefined;
  let db: any;
  let graphEngine: GraphRAGEngine;

  try {
    await t.step("1. Setup and populate", async () => {
      testDir = await Deno.makeTempDir({ prefix: "pml_e2e_05_" });
      db = await initializeTestDatabase(testDir);

      const server = createMockFilesystemServer();
      const tools = await server.listTools();
      await storeSchemas(db, "filesystem", tools);

      const toolResults = await db.query("SELECT tool_id, server_id, name FROM tool_schema");

      for (const tool of toolResults) {
        const embedding = "[" + Array(1024).fill(0).join(",") + "]";
        await db.query(
          "INSERT INTO tool_embedding (tool_id, server_id, tool_name, embedding) VALUES ($1, $2, $3, $4::vector)",
          [tool.tool_id, tool.server_id, tool.name, embedding],
        );
      }
    });

    await t.step("2. Initialize and sync graph", async () => {
      graphEngine = new GraphRAGEngine(db);
      await graphEngine.syncFromDatabase();

      const stats = graphEngine.getStats();
      assert(stats.nodeCount >= 3, "Should have nodes");

      console.log("  Graph stats:", stats.nodeCount, "nodes,", stats.edgeCount, "edges");
    });
  } finally {
    if (db && testDir) {
      await cleanupTestDatabase(db, testDir);
    }
  }
});
