/**
 * Load Testing: 15 Servers, 100+ Tools
 *
 * Tests system scalability with realistic production loads.
 * Run with: deno test --allow-all tests/load/
 */

import { assert } from "jsr:@std/assert@1";
import {
  calculatePercentile,
  cleanupTestDatabase,
  generateEmbeddings,
  initializeTestDatabase,
  loadEmbeddingModel,
  storeSchemas,
} from "../fixtures/test-helpers.ts";
import { MockMCPServer } from "../fixtures/mock-mcp-server.ts";
import { VectorSearch } from "../../src/vector/search.ts";

Deno.test("Load test: 15 servers, 100+ tools", async (t) => {
  let testDir: string | undefined;
  let db: any;
  let embeddingModel: any;
  let vectorSearch: VectorSearch;
  const servers: MockMCPServer[] = [];

  try {
    await t.step("1. Setup test database", async () => {
      testDir = await Deno.makeTempDir({ prefix: "load_test_" });
      db = await initializeTestDatabase(testDir);
      console.log("  ✓ Database initialized");
    });

    await t.step("2. Create 15 mock MCP servers with 100+ tools", async () => {
      // Create 15 servers with 6-7 tools each (~100 total)
      for (let i = 0; i < 15; i++) {
        const server = new MockMCPServer(`server-${i}`);
        const toolCount = i % 2 === 0 ? 7 : 6; // Alternate between 6 and 7

        for (let j = 0; j < toolCount; j++) {
          server.addTool(
            `tool-${j}`,
            (_args: any) => ({ result: `output-${j}`, server: `server-${i}` }),
            50, // 50ms delay to simulate real MCP server
            `Tool ${j} from server ${i} - performs operation ${j}`,
          );
        }

        servers.push(server);
      }

      const totalTools = servers.reduce((sum, s) => sum + s.getToolCount(), 0);
      console.log(`  ✓ Created ${servers.length} servers with ${totalTools} tools`);

      assert(totalTools >= 100, "Should have at least 100 tools");
    });

    await t.step("3. Discover all servers and tools", async () => {
      const startDiscovery = performance.now();

      for (const server of servers) {
        const tools = await server.listTools();
        await storeSchemas(db, server.serverId, tools);
      }

      const discoveryTime = performance.now() - startDiscovery;

      const count = await db.query(`SELECT COUNT(*) as count FROM tool_schema`);
      console.log(`  ✓ Discovery completed in ${discoveryTime.toFixed(1)}ms`);
      console.log(`  ✓ Stored ${count[0].count} tool schemas`);

      // Performance target: < 5 seconds
      assert(discoveryTime < 5000, `Discovery too slow: ${discoveryTime.toFixed(1)}ms`);
    });

    await t.step("4. Generate embeddings for all tools", async () => {
      embeddingModel = await loadEmbeddingModel();

      const startEmbeddings = performance.now();
      await generateEmbeddings(db, embeddingModel);
      const embeddingsTime = performance.now() - startEmbeddings;

      const count = await db.query(
        `SELECT COUNT(*) as count FROM tool_embedding`,
      );

      console.log(
        `  ✓ Generated ${count[0].count} embeddings in ${(embeddingsTime / 1000).toFixed(1)}s`,
      );

      // Performance target: < 2 minutes for 100+ tools
      assert(
        embeddingsTime < 120000,
        `Embeddings too slow: ${(embeddingsTime / 1000).toFixed(1)}s`,
      );
    });

    await t.step("5. Test vector search performance at scale", async () => {
      vectorSearch = new VectorSearch(db, embeddingModel);

      const latencies: number[] = [];

      // Run 100 searches
      for (let i = 0; i < 100; i++) {
        const start = performance.now();
        await vectorSearch.searchTools(`query ${i}`, 5, 0.7);
        latencies.push(performance.now() - start);
      }

      latencies.sort((a, b) => a - b);

      const p50 = calculatePercentile(latencies, 0.50);
      const p95 = calculatePercentile(latencies, 0.95);
      const p99 = calculatePercentile(latencies, 0.99);

      console.log(`  ✓ Vector search latency (100 queries):`);
      console.log(`    - P50: ${p50.toFixed(1)}ms`);
      console.log(`    - P95: ${p95.toFixed(1)}ms`);
      console.log(`    - P99: ${p99.toFixed(1)}ms`);

      // Performance target: P95 < 100ms
      assert(p95 < 100, `Vector search P95 too high: ${p95.toFixed(1)}ms`);
    });

    await t.step("6. Test concurrent tool executions", async () => {
      const concurrentCalls = 50;
      const calls = [];

      for (let i = 0; i < concurrentCalls; i++) {
        const serverIdx = i % servers.length;
        const server = servers[serverIdx];
        const toolIdx = i % server.getToolCount();

        calls.push(
          server.callTool(`tool-${toolIdx}`, { input: `test-${i}` }),
        );
      }

      const start = performance.now();
      const results = await Promise.all(calls);
      const duration = performance.now() - start;

      console.log(
        `  ✓ Executed ${concurrentCalls} concurrent tool calls in ${duration.toFixed(1)}ms`,
      );

      assert(results.length === concurrentCalls, "All calls should complete");
      assert(duration < 5000, `Concurrent execution too slow: ${duration.toFixed(1)}ms`);
    });

    await t.step("7. Test database query performance at scale", async () => {
      const queries = [
        () => db.query(`SELECT COUNT(*) FROM tool_schema`),
        () => db.query(`SELECT COUNT(*) FROM tool_embedding`),
        () => db.query(`SELECT * FROM tool_schema LIMIT 10`),
        () =>
          db.query(
            `SELECT server_id, COUNT(*) as count FROM tool_schema GROUP BY server_id`,
          ),
      ];

      const latencies: number[] = [];

      for (let i = 0; i < 100; i++) {
        const query = queries[i % queries.length];

        const start = performance.now();
        await query();
        latencies.push(performance.now() - start);
      }

      const avgLatency = latencies.reduce((sum, l) => sum + l, 0) / latencies.length;

      console.log(`  ✓ Average DB query latency: ${avgLatency.toFixed(2)}ms`);

      assert(avgLatency < 50, `DB queries too slow: ${avgLatency.toFixed(2)}ms`);
    });

    await t.step("8. Test memory usage under load", async () => {
      if ((globalThis as any).gc) {
        (globalThis as any).gc();
      }

      const initialMemory = Deno.memoryUsage().heapUsed;

      // Perform 500 operations
      for (let i = 0; i < 500; i++) {
        await vectorSearch.searchTools(`load test ${i}`, 5, 0.7);

        if (i % 100 === 0 && (globalThis as any).gc) {
          (globalThis as any).gc();
        }
      }

      if ((globalThis as any).gc) {
        (globalThis as any).gc();
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      const finalMemory = Deno.memoryUsage().heapUsed;
      const memoryGrowth = finalMemory - initialMemory;

      console.log(
        `  ✓ Memory usage after 500 ops: +${(memoryGrowth / 1024 / 1024).toFixed(2)}MB`,
      );

      assert(
        memoryGrowth < 100 * 1024 * 1024,
        `Excessive memory growth: ${(memoryGrowth / 1024 / 1024).toFixed(2)}MB`,
      );
    });

    await t.step("9. Test sustained load (stress test)", async () => {
      const duration = 30000; // 30 seconds
      const startTime = Date.now();
      let operationCount = 0;
      const errors: Error[] = [];

      console.log("  ⏳ Running 30-second stress test...");

      while (Date.now() - startTime < duration) {
        try {
          await vectorSearch.searchTools(`stress ${operationCount}`, 5, 0.7);
          operationCount++;

          // Brief pause to avoid overwhelming the system
          if (operationCount % 50 === 0) {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        } catch (error) {
          errors.push(error as Error);
        }
      }

      const actualDuration = Date.now() - startTime;
      const opsPerSecond = (operationCount / actualDuration) * 1000;

      console.log(`  ✓ Stress test completed:`);
      console.log(`    - Operations: ${operationCount}`);
      console.log(`    - Duration: ${(actualDuration / 1000).toFixed(1)}s`);
      console.log(`    - Throughput: ${opsPerSecond.toFixed(1)} ops/sec`);
      console.log(`    - Errors: ${errors.length}`);

      assert(errors.length === 0, `Stress test had ${errors.length} errors`);
      assert(operationCount > 100, "Should complete significant number of operations");
    });

    await t.step("10. Verify system stability after load", async () => {
      // Verify database is still functional
      const toolCount = await db.query(`SELECT COUNT(*) FROM tool_schema`);
      assert(toolCount[0].count >= 100, "Database should still have tools");

      // Verify search still works
      const searchResults = await vectorSearch.searchTools("test", 5, 0.7);
      assert(searchResults.length > 0, "Search should still return results");

      console.log("  ✓ System stable after load testing");
    });
  } finally {
    if (db && testDir) {
      await cleanupTestDatabase(db, testDir);
    }
    servers.forEach((s) => s.reset());
  }
});
