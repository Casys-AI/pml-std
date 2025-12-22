/**
 * E2E Test 03: Embedding Generation
 *
 * Tests embedding generation with real BGE-M3 model.
 */

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  cleanupTestDatabase,
  generateEmbeddings,
  initializeTestDatabase,
  loadEmbeddingModel,
  storeSchemas,
} from "../fixtures/test-helpers.ts";
import { createMockFilesystemServer } from "../fixtures/mock-mcp-server.ts";

Deno.test({
  name: "E2E 03: Embedding generation with BGE-M3",
  sanitizeResources: false, // ONNX Runtime keeps file handles open for model cache
  sanitizeOps: false, // ONNX Runtime has async ops that don't complete during test
  async fn(t) {
    let testDir: string | undefined;
    let db: any;
    let embeddingModel: any;

    try {
      await t.step("1. Setup test database and load model", async () => {
        testDir = await Deno.makeTempDir({ prefix: "pml_e2e_03_" });
        db = await initializeTestDatabase(testDir);

        console.log("  Loading BGE-M3 model (may take a moment)...");
        embeddingModel = await loadEmbeddingModel();
        assert(embeddingModel, "Embedding model should be loaded");
      });

      await t.step("2. Store test tool schemas", async () => {
        const server = createMockFilesystemServer();
        const tools = await server.listTools();

        await storeSchemas(db, "filesystem", tools);

        const result = await db.query(
          `SELECT COUNT(*) as count FROM tool_schema`,
        );
        assert(result[0].count > 0, "Tools should be stored");
      });

      await t.step("3. Generate embeddings for tools", async () => {
        const startTime = performance.now();

        await generateEmbeddings(db, embeddingModel);

        const duration = performance.now() - startTime;
        console.log(`  Embedding generation took ${duration.toFixed(1)}ms`);

        // Verify embeddings were created
        const result = await db.query(
          `SELECT COUNT(*) as count FROM tool_embedding`,
        );

        assert(
          result[0].count > 0,
          "Embeddings should be generated",
        );
      });

      await t.step("4. Verify embedding dimensions (BGE-M3 = 1024)", async () => {
        const result = await db.query(`
        SELECT embedding
        FROM tool_embedding
        LIMIT 1
      `);

        assert(result.length > 0, "Should have at least one embedding");

        // PGlite vector type - verify it's not null
        assert(result[0].embedding, "Embedding should not be null");

        // Generate a test embedding directly to verify dimensions
        const testText = "test embedding dimension validation";
        const testEmbedding = await embeddingModel.encode(testText);

        assertEquals(
          testEmbedding.length,
          1024,
          "BGE-M3 should generate 1024-dimensional embeddings",
        );

        console.log(`  ✓ Verified embedding dimensions: ${testEmbedding.length}`);
      });

      await t.step("5. Test embedding similarity search", async () => {
        // Generate query embedding
        const queryText = "read a file from disk";
        const queryEmbedding = await embeddingModel.encode(queryText);

        // Search for similar tools using cosine similarity
        const searchResult = await db.query(
          `
        SELECT
          te.tool_name,
          1 - (te.embedding <=> $1::vector) as similarity
        FROM tool_embedding te
        ORDER BY te.embedding <=> $1::vector
        LIMIT 5
      `,
          [`[${queryEmbedding.join(",")}]`],
        );

        assert(searchResult.length > 0, "Should find similar tools");

        // Top result should be the 'read' tool
        const topResult = searchResult[0];
        assert(
          topResult.tool_name === "read",
          `Top result should be 'read' tool, got '${topResult.tool_name}'`,
        );

        console.log(
          `  Top match: ${topResult.tool_name} (similarity: ${topResult.similarity.toFixed(3)})`,
        );
      });

      await t.step("6. Test embedding update (idempotency)", async () => {
        // Generate embeddings again
        await generateEmbeddings(db, embeddingModel);

        // Count should remain the same
        const result = await db.query(
          `SELECT COUNT(*) as count FROM tool_embedding`,
        );

        const toolCount = await db.query(
          `SELECT COUNT(*) as count FROM tool_schema`,
        );

        assertEquals(
          result[0].count,
          toolCount[0].count,
          "Embedding count should match tool count",
        );
      });

      await t.step("7. Test batch embedding generation performance", async () => {
        // Clear existing embeddings
        await db.query(`DELETE FROM tool_embedding`);

        // Add more tools using tool_schema
        for (let i = 0; i < 10; i++) {
          const toolId = `test-server:test_tool_${i}`;
          await db.query(
            `
          INSERT INTO tool_schema (tool_id, server_id, name, description, input_schema)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (tool_id) DO UPDATE SET description = EXCLUDED.description
        `,
            [
              toolId,
              "test-server",
              `test_tool_${i}`,
              `Test tool number ${i} for testing`,
              JSON.stringify({ type: "object" }),
            ],
          );
        }

        const startTime = performance.now();
        await generateEmbeddings(db, embeddingModel);
        const duration = performance.now() - startTime;

        console.log(`  Batch embedding (13 tools) took ${duration.toFixed(1)}ms`);

        // Performance check: should be < 5 seconds for 13 tools
        assert(
          duration < 5000,
          `Embedding generation too slow: ${duration.toFixed(1)}ms`,
        );
      });

      await t.step("8. Test embedding accuracy with known semantic relationships", async () => {
        // Test semantic similarity with known text pairs
        const testCases = [
          {
            text1: "read a file from the filesystem",
            text2: "retrieve file contents from disk",
            expectedSimilarity: 0.7, // Should be highly similar
            description: "Similar file operations",
          },
          {
            text1: "create a new database entry",
            text2: "insert record into database",
            expectedSimilarity: 0.7, // Should be highly similar
            description: "Similar database operations",
          },
          {
            text1: "send email notification",
            text2: "calculate mathematical function",
            expectedSimilarity: 0.58, // Should be dissimilar (max) - BGE-M3 baseline ~0.54-0.62
            description: "Unrelated operations",
            inverse: true, // Expect LOW similarity
          },
        ];

        for (const testCase of testCases) {
          const embedding1 = await embeddingModel.encode(testCase.text1);
          const embedding2 = await embeddingModel.encode(testCase.text2);

          // Calculate cosine similarity manually
          let dotProduct = 0;
          let norm1 = 0;
          let norm2 = 0;

          for (let i = 0; i < embedding1.length; i++) {
            dotProduct += embedding1[i] * embedding2[i];
            norm1 += embedding1[i] * embedding1[i];
            norm2 += embedding2[i] * embedding2[i];
          }

          const cosineSimilarity = dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2));

          console.log(
            `  ${testCase.description}: similarity = ${cosineSimilarity.toFixed(3)} (expected ${
              testCase.inverse ? "<" : ">"
            } ${testCase.expectedSimilarity})`,
          );

          if (testCase.inverse) {
            // For dissimilar texts, similarity should be BELOW threshold
            assert(
              cosineSimilarity < testCase.expectedSimilarity,
              `${testCase.description}: similarity ${
                cosineSimilarity.toFixed(3)
              } should be < ${testCase.expectedSimilarity}`,
            );
          } else {
            // For similar texts, similarity should be ABOVE threshold
            assert(
              cosineSimilarity >= testCase.expectedSimilarity,
              `${testCase.description}: similarity ${
                cosineSimilarity.toFixed(3)
              } should be >= ${testCase.expectedSimilarity}`,
            );
          }
        }

        console.log("  ✓ All semantic accuracy tests passed");
      });

      await t.step("9. Test embedding consistency (deterministic)", async () => {
        // Same text should produce identical embeddings
        const text = "consistent embedding test";

        const embedding1 = await embeddingModel.encode(text);
        const embedding2 = await embeddingModel.encode(text);

        // Check that embeddings are identical (within floating point precision)
        let maxDifference = 0;
        for (let i = 0; i < embedding1.length; i++) {
          const diff = Math.abs(embedding1[i] - embedding2[i]);
          maxDifference = Math.max(maxDifference, diff);
        }

        console.log(`  Max difference between identical texts: ${maxDifference.toExponential(2)}`);

        assert(
          maxDifference < 1e-6,
          `Embeddings should be deterministic, max difference: ${maxDifference}`,
        );

        console.log("  ✓ Embeddings are deterministic");
      });
    } finally {
      if (db && testDir) {
        await cleanupTestDatabase(db, testDir);
      }
    }
  },
});
