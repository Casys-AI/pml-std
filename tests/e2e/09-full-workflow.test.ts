/**
 * E2E Test 09: Complete User Journey
 *
 * Tests the full end-to-end workflow from initialization to execution.
 * This is the comprehensive integration test that validates the entire system.
 */

import { assert, assertEquals, assertExists } from "jsr:@std/assert@1";
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
import { ParallelExecutor } from "../../src/dag/executor.ts";
import type { DAGStructure } from "../../src/graphrag/types.ts";
import type { ToolExecutor } from "../../src/dag/types.ts";

Deno.test("E2E 09: Complete user journey", async (t) => {
  let testDir: string | undefined;
  let db: any;
  let embeddingModel: any;
  let vectorSearch: VectorSearch;
  let graphEngine: GraphRAGEngine;
  let executor: ParallelExecutor;
  const mcpServers = new Map<string, MockMCPServer>();

  try {
    // =================================================================
    // Phase 1: System Initialization
    // =================================================================

    await t.step("1. Initialize and discover servers", async () => {
      // Create test database
      testDir = await Deno.makeTempDir({ prefix: "pml_e2e_full_" });
      db = await initializeTestDatabase(testDir);

      // Create mock MCP servers
      const filesystemServer = createMockFilesystemServer();
      const jsonServer = createMockJsonServer();

      mcpServers.set("filesystem", filesystemServer);
      mcpServers.set("json", jsonServer);

      // Discover tools from servers
      for (const [serverId, server] of mcpServers.entries()) {
        const tools = await server.listTools();
        await storeSchemas(db, serverId, tools);
      }

      // Verify discovery
      const count = await db.query(`SELECT COUNT(*) as count FROM tool_schema`);
      assert(count[0].count >= 5, "Should discover multiple tools");

      console.log(`  ✓ Discovered ${count[0].count} tools from ${mcpServers.size} servers`);
    });

    // =================================================================
    // Phase 2: Embedding Generation
    // =================================================================

    await t.step("2. Generate embeddings", async () => {
      embeddingModel = await loadMockEmbeddingModel();
      await generateEmbeddings(db, embeddingModel);

      const count = await db.query(
        `SELECT COUNT(*) as count FROM tool_embedding`,
      );
      assert(count[0].count >= 5, "Should generate embeddings for all tools");

      console.log(`  ✓ Generated ${count[0].count} embeddings`);
    });

    // =================================================================
    // Phase 3: Vector Search
    // =================================================================

    await t.step("3. Vector search", async () => {
      vectorSearch = new VectorSearch(db, embeddingModel);

      const results = await vectorSearch.searchTools("read a file", 5, 0.5);

      assert(results.length > 0, "Should find relevant tools");
      assert(results[0].toolName.includes("read"), "Top result should be 'read' tool");

      console.log(`  ✓ Found ${results.length} relevant tools via semantic search`);
    });

    // =================================================================
    // Phase 4: Graph Construction
    // =================================================================

    await t.step("4. Build graph", async () => {
      graphEngine = new GraphRAGEngine(db);
      await graphEngine.syncFromDatabase();

      const stats = graphEngine.getStats();
      assert(stats.nodeCount >= 5, "Graph should have nodes");

      console.log(`  ✓ Built graph: ${stats.nodeCount} nodes, ${stats.edgeCount} edges`);
    });

    // =================================================================
    // Phase 5: Workflow Execution
    // =================================================================

    await t.step("5. Execute workflow", async () => {
      // Create tool executor
      const toolExecutor: ToolExecutor = async (toolName: string, args: any) => {
        const [serverId, tool] = toolName.split(":");
        const server = mcpServers.get(serverId);

        if (!server) {
          throw new Error(`Server not found: ${serverId}`);
        }

        return await server.callTool(tool, args);
      };

      executor = new ParallelExecutor(toolExecutor);

      // Define workflow: read file → parse JSON → write result
      const workflow: DAGStructure = {
        tasks: [
          {
            id: "read",
            tool: "filesystem:read",
            arguments: { path: "/data.json" },
            dependsOn: [],
          },
          {
            id: "parse",
            tool: "json:parse",
            arguments: { json: '{"test": "value"}' },
            dependsOn: ["read"],
          },
          {
            id: "write",
            tool: "filesystem:write",
            arguments: {
              path: "/output.json",
              content: "$OUTPUT[parse].data",
            },
            dependsOn: ["parse"],
          },
        ],
      };

      const result = await executor.execute(workflow);

      assertEquals(result.totalTasks, 3, "Should execute all tasks");
      assertEquals(result.errors.length, 0, "Should have no errors");
      assert(result.parallelizationLayers === 3, "Should have 3 sequential layers");

      console.log(
        `  ✓ Executed workflow: ${result.totalTasks} tasks, ${result.executionTimeMs.toFixed(1)}ms`,
      );
    });

    // =================================================================
    // Phase 6: Gateway Integration
    // =================================================================

    await t.step("6. Gateway integration", async () => {
      // Simulate tools/list request
      const listResults = await vectorSearch.searchTools("file operations", 10, 0.5);

      assert(listResults.length > 0, "Gateway should list tools");

      // Simulate tools/call request
      const filesystemServer = mcpServers.get("filesystem")!;
      const callResult = await filesystemServer.callTool("read", {
        path: "/test.txt",
      });

      assertExists(callResult, "Gateway should execute tools");

      console.log(`  ✓ Gateway: listed ${listResults.length} tools, executed 1 tool`);
    });

    // =================================================================
    // Phase 7: Performance Validation
    // =================================================================

    await t.step("7. Performance validation", async () => {
      const metrics = {
        searchLatencies: [] as number[],
        executionTime: 0,
      };

      // Measure search latency (10 samples)
      for (let i = 0; i < 10; i++) {
        const start = performance.now();
        await vectorSearch.searchTools("test query", 5, 0.5);
        metrics.searchLatencies.push(performance.now() - start);
      }

      // Calculate P95
      metrics.searchLatencies.sort((a, b) => a - b);
      const p95 = metrics.searchLatencies[Math.floor(metrics.searchLatencies.length * 0.95)];

      // Measure workflow execution
      const toolExecutor: ToolExecutor = async (toolName: string, args: any) => {
        const [serverId, tool] = toolName.split(":");
        const server = mcpServers.get(serverId);
        if (!server) throw new Error(`Server not found: ${serverId}`);
        return await server.callTool(tool, args);
      };

      const testExecutor = new ParallelExecutor(toolExecutor);
      const testWorkflow: DAGStructure = {
        tasks: Array.from({ length: 5 }, (_, i) => ({
          id: `task${i}`,
          tool: "filesystem:read",
          arguments: { path: `/file${i}.txt` },
          dependsOn: i > 0 ? [`task${i - 1}`] : [],
        })),
      };

      const start = performance.now();
      await testExecutor.execute(testWorkflow);
      metrics.executionTime = performance.now() - start;

      console.log(`  ✓ Performance metrics:`);
      console.log(`    - Vector search P95: ${p95.toFixed(1)}ms (target: <100ms)`);
      console.log(`    - Workflow execution: ${metrics.executionTime.toFixed(1)}ms (target: <3s)`);

      // Validate against NFRs
      assert(p95 < 100, `Search P95 too high: ${p95.toFixed(1)}ms`);
      assert(
        metrics.executionTime < 3000,
        `Execution too slow: ${metrics.executionTime.toFixed(1)}ms`,
      );
    });

    // =================================================================
    // Phase 8: Reliability Check
    // =================================================================

    await t.step("8. Reliability check (no crashes)", async () => {
      let successCount = 0;
      let errorCount = 0;

      // Run 50 random operations
      for (let i = 0; i < 50; i++) {
        try {
          const operations = [
            () => vectorSearch.searchTools("random query", 5, 0.5),
            () => graphEngine.getStats(),
            async () => {
              const server = mcpServers.get("filesystem")!;
              await server.callTool("read", { path: "/test.txt" });
            },
          ];

          const randomOp = operations[Math.floor(Math.random() * operations.length)];
          await randomOp();

          successCount++;
        } catch (error) {
          errorCount++;
        }
      }

      const successRate = (successCount / 50) * 100;

      console.log(`  ✓ Reliability: ${successRate.toFixed(1)}% success rate (${successCount}/50)`);

      // Target: >99% success rate (NFR003)
      assert(successRate >= 99, `Success rate too low: ${successRate.toFixed(1)}%`);
    });

    // =================================================================
    // Phase 9: Load Testing
    // =================================================================

    await t.step("9. Load testing (parallel requests)", async () => {
      const concurrentRequests = 20;
      const requests = [];

      for (let i = 0; i < concurrentRequests; i++) {
        requests.push(
          vectorSearch.searchTools(`query ${i}`, 5, 0.5),
        );
      }

      const start = performance.now();
      const results = await Promise.all(requests);
      const duration = performance.now() - start;

      assertEquals(results.length, concurrentRequests, "All requests should complete");

      console.log(
        `  ✓ Load test: ${concurrentRequests} concurrent requests in ${duration.toFixed(1)}ms`,
      );

      // Should handle load efficiently
      assert(duration < 2000, `Load test too slow: ${duration.toFixed(1)}ms`);
    });

    // =================================================================
    // Phase 10: Final Validation
    // =================================================================

    await t.step("10. Final validation", async () => {
      // Verify all components are functional
      const validations = {
        database: db !== null,
        embeddings: embeddingModel !== null,
        vectorSearch: vectorSearch !== null,
        graphEngine: graphEngine !== null,
        executor: executor !== null,
        servers: mcpServers.size === 2,
      };

      const allValid = Object.values(validations).every((v) => v);

      assert(allValid, "All components should be functional");

      console.log(`  ✓ System validation complete:`);
      console.log(`    - Database: ${validations.database ? "✓" : "✗"}`);
      console.log(`    - Embeddings: ${validations.embeddings ? "✓" : "✗"}`);
      console.log(`    - Vector Search: ${validations.vectorSearch ? "✓" : "✗"}`);
      console.log(`    - Graph Engine: ${validations.graphEngine ? "✓" : "✗"}`);
      console.log(`    - DAG Executor: ${validations.executor ? "✓" : "✗"}`);
      console.log(`    - MCP Servers: ${validations.servers ? "✓" : "✗"}`);
      console.log("");
      console.log("  🎉 Complete user journey successful!");
    });
  } finally {
    if (db && testDir) {
      await cleanupTestDatabase(db, testDir);
    }
    mcpServers.clear();
  }
});
