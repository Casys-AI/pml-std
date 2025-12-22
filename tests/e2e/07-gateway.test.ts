/**
 * E2E Test 07: MCP Gateway Integration
 *
 * Tests MCP gateway server functionality with tools/list and tools/call.
 */

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  cleanupTestDatabase,
  generateEmbeddings,
  initializeTestDatabase,
  loadMockEmbeddingModel,
  storeSchemas,
} from "../fixtures/test-helpers.ts";
import {
  createMockFilesystemServer,
  createMockJsonServer,
  MockMCPServer,
} from "../fixtures/mock-mcp-server.ts";
import { VectorSearch } from "../../src/vector/search.ts";
import { GraphRAGEngine } from "../../src/graphrag/graph-engine.ts";

Deno.test("E2E 07: MCP gateway integration", async (t) => {
  let testDir: string | undefined;
  let db: any;
  let embeddingModel: any;
  let vectorSearch: VectorSearch;
  let graphEngine: GraphRAGEngine;
  const mockServers = new Map<string, MockMCPServer>();

  try {
    await t.step("1. Setup test environment", async () => {
      testDir = await Deno.makeTempDir({ prefix: "pml_e2e_07_" });
      db = await initializeTestDatabase(testDir);
      embeddingModel = await loadMockEmbeddingModel();

      // Create mock servers
      mockServers.set("filesystem", createMockFilesystemServer());
      mockServers.set("json", createMockJsonServer());
    });

    await t.step("2. Populate database with tools", async () => {
      for (const [serverId, server] of mockServers.entries()) {
        const tools = await server.listTools();
        await storeSchemas(db, serverId, tools);
      }

      await generateEmbeddings(db, embeddingModel);
    });

    await t.step("3. Initialize components", async () => {
      vectorSearch = new VectorSearch(db, embeddingModel);
      graphEngine = new GraphRAGEngine(db);
      await graphEngine.syncFromDatabase();
    });

    await t.step("4. Test semantic tool discovery", async () => {
      // Simulates tools/list with query parameter
      const query = "read a file";
      const results = await vectorSearch.searchTools(query, 5, 0.5);

      assert(results.length > 0, "Should find relevant tools");

      const topTool = results[0];
      assert(
        topTool.toolName.includes("read"),
        `Top tool should be 'read', got '${topTool.toolName}'`,
      );

      console.log(`  Discovered ${results.length} tools for query: "${query}"`);
    });

    await t.step("5. Test tool execution via mock servers", async () => {
      const filesystemServer = mockServers.get("filesystem")!;

      // Simulate tools/call
      const result = await filesystemServer.callTool("read", {
        path: "/test/file.txt",
      }) as { content: string; size: number };

      assert(result, "Tool execution should return result");
      assert(result.content, "Result should have content");

      console.log(`  Tool execution result: ${JSON.stringify(result).substring(0, 50)}...`);
    });

    await t.step("6. Test multiple tool calls", async () => {
      const filesystemServer = mockServers.get("filesystem")!;

      filesystemServer.reset();

      // Execute multiple tools
      await filesystemServer.callTool("read", { path: "/file1.txt" });
      await filesystemServer.callTool("write", { path: "/file2.txt", content: "test" });
      await filesystemServer.callTool("read", { path: "/file3.txt" });

      assertEquals(filesystemServer.getCallCount("read"), 2, "read should be called twice");
      assertEquals(filesystemServer.getCallCount("write"), 1, "write should be called once");
      assertEquals(filesystemServer.getTotalCallCount(), 3, "Total calls should be 3");
    });

    await t.step("7. Test cross-server tool discovery", async () => {
      // Search for JSON tools
      const jsonResults = await vectorSearch.searchTools("parse JSON", 5, 0.5);

      assert(jsonResults.length > 0, "Should find JSON tools");
      assert(
        jsonResults[0].serverId === "json",
        "Top result should be from json server",
      );

      console.log(`  JSON tools found: ${jsonResults.map((r) => r.toolName).join(", ")}`);
    });

    await t.step("8. Test tool filtering by server", async () => {
      const allToolsResult = await db.query(
        `SELECT DISTINCT server_id FROM tool_schema`,
      );

      const serverIds = allToolsResult.map((r: any) => r.server_id);

      assert(serverIds.length >= 2, "Should have multiple servers");
      assert(serverIds.includes("filesystem"), "Should have filesystem server");
      assert(serverIds.includes("json"), "Should have json server");
    });

    await t.step("9. Test gateway performance (latency)", async () => {
      const latencies: number[] = [];

      for (let i = 0; i < 10; i++) {
        const start = performance.now();
        await vectorSearch.searchTools("test query", 5, 0.5);
        latencies.push(performance.now() - start);
      }

      const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;

      console.log(`  Average gateway latency: ${avgLatency.toFixed(1)}ms`);

      // Performance target: < 200ms P95
      assert(avgLatency < 200, `Gateway latency too high: ${avgLatency.toFixed(1)}ms`);
    });

    await t.step("10. Test error handling for unknown tool", async () => {
      const filesystemServer = mockServers.get("filesystem")!;

      try {
        await filesystemServer.callTool("nonexistent_tool", {});
        assert(false, "Should throw error for unknown tool");
      } catch (error) {
        assert(
          (error as Error).message.includes("Tool not found"),
          "Should throw 'Tool not found' error",
        );
      }
    });
  } finally {
    if (db && testDir) {
      await cleanupTestDatabase(db, testDir);
    }
    mockServers.clear();
  }
});
