/**
 * E2E Test 04: Vector Search
 *
 * Tests semantic search functionality with real embeddings.
 */

import { assert, assertEquals, assertExists } from "jsr:@std/assert@1";
import {
  calculatePercentile,
  cleanupTestDatabase,
  generateEmbeddings,
  initializeTestDatabase,
  loadMockEmbeddingModel,
  storeSchemas,
} from "../fixtures/test-helpers.ts";
import {
  createMockApiServer,
  createMockFilesystemServer,
  createMockJsonServer,
} from "../fixtures/mock-mcp-server.ts";
import { VectorSearch } from "../../src/vector/search.ts";

Deno.test("E2E 04: Vector search and semantic retrieval", async (t) => {
  let testDir: string | undefined;
  let db: any;
  let embeddingModel: any;
  let vectorSearch: VectorSearch;

  try {
    await t.step("1. Setup test environment", async () => {
      testDir = await Deno.makeTempDir({ prefix: "pml_e2e_04_" });
      db = await initializeTestDatabase(testDir);
      embeddingModel = await loadMockEmbeddingModel();
    });

    await t.step("2. Populate database with tools", async () => {
      const servers = [
        createMockFilesystemServer(),
        createMockJsonServer(),
        createMockApiServer(),
      ];

      for (const server of servers) {
        const tools = await server.listTools();
        await storeSchemas(db, server.serverId, tools);
      }

      const count = await db.query(`SELECT COUNT(*) as count FROM tool_schema`);
      assert(count[0].count >= 7, "Tools should be stored");
    });

    await t.step("3. Generate embeddings", async () => {
      await generateEmbeddings(db, embeddingModel);

      const count = await db.query(
        `SELECT COUNT(*) as count FROM tool_embedding`,
      );
      assert(count[0].count >= 7, "Embeddings should be generated");
    });

    await t.step("4. Initialize vector search", () => {
      vectorSearch = new VectorSearch(db, embeddingModel);
      assertExists(vectorSearch);
    });

    await t.step("5. Test semantic search for file operations", async () => {
      const results = await vectorSearch.searchTools("read a file", 5, 0.5);

      assert(results.length > 0, "Should find relevant tools");

      // Top result should be related to file reading
      const topResult = results[0];
      assert(
        topResult.toolName.includes("read") || topResult.toolName.includes("file"),
        `Top result should be file-related, got: ${topResult.toolName}`,
      );

      console.log(
        `  Found ${results.length} results, top: ${topResult.toolName} (score: ${
          topResult.score.toFixed(3)
        })`,
      );
    });

    await t.step("6. Test semantic search for JSON operations", async () => {
      const results = await vectorSearch.searchTools("parse JSON data", 5, 0.5);

      assert(results.length > 0, "Should find JSON-related tools");

      const topResult = results[0];
      assert(
        topResult.toolName.includes("parse") || topResult.toolName.includes("json"),
        `Top result should be JSON-related, got: ${topResult.toolName}`,
      );

      console.log(
        `  Top JSON result: ${topResult.toolName} (score: ${topResult.score.toFixed(3)})`,
      );
    });

    await t.step("7. Test search with custom topK", async () => {
      const results1 = await vectorSearch.searchTools("file operations", 1, 0.5);
      const results5 = await vectorSearch.searchTools("file operations", 5, 0.5);

      assertEquals(results1.length, 1, "Should respect topK=1");
      assert(results5.length <= 5, "Should respect topK=5");
    });

    await t.step("8. Test search with similarity threshold", async () => {
      const lowThreshold = await vectorSearch.searchTools("database query", 10, 0.3);
      const highThreshold = await vectorSearch.searchTools("database query", 10, 0.8);

      // High threshold should return fewer results
      assert(
        highThreshold.length <= lowThreshold.length,
        "High threshold should filter more results",
      );

      console.log(`  Low threshold (0.3): ${lowThreshold.length} results`);
      console.log(`  High threshold (0.8): ${highThreshold.length} results`);
    });

    await t.step("9. Test search performance (P95 latency)", async () => {
      const latencies: number[] = [];

      // Run 20 searches to measure latency distribution
      for (let i = 0; i < 20; i++) {
        const start = performance.now();
        await vectorSearch.searchTools("test query", 5, 0.5);
        latencies.push(performance.now() - start);
      }

      latencies.sort((a, b) => a - b);
      const p95 = calculatePercentile(latencies, 0.95);

      console.log(`  Search latency P95: ${p95.toFixed(1)}ms`);

      // P95 should be < 100ms (performance requirement)
      assert(p95 < 100, `Search P95 too high: ${p95.toFixed(1)}ms`);
    });

    await t.step("10. Test empty query handling", async () => {
      const results = await vectorSearch.searchTools("", 5, 0.5);
      assertEquals(results.length, 0, "Empty query should return empty results");
    });

    await t.step("11. Verify results are sorted by score", async () => {
      const results = await vectorSearch.searchTools("read write files", 5, 0.5);

      if (results.length > 1) {
        // Verify descending order
        for (let i = 1; i < results.length; i++) {
          assert(
            results[i - 1].score >= results[i].score,
            `Results should be sorted by score (descending)`,
          );
        }
      }
    });
  } finally {
    if (db && testDir) {
      await cleanupTestDatabase(db, testDir);
    }
  }
});
