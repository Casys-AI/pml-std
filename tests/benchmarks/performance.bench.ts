/**
 * Performance Regression Tests
 *
 * Benchmarks for critical system components to detect performance regressions.
 * Run with: deno bench --allow-all tests/benchmarks/
 */

import { VectorSearch } from "../../src/vector/search.ts";
import { GraphRAGEngine } from "../../src/graphrag/graph-engine.ts";
import { ParallelExecutor } from "../../src/dag/executor.ts";
import { PGliteClient } from "../../src/db/client.ts";
import { getAllMigrations, MigrationRunner } from "../../src/db/migrations.ts";
import { EmbeddingModel } from "../../src/vector/embeddings.ts";
import {
  createTestDAG,
  generateEmbeddings,
  loadEmbeddingModel,
  storeSchemas,
} from "../fixtures/test-helpers.ts";
import { createMockFilesystemServer } from "../fixtures/mock-mcp-server.ts";

// Global setup (runs once)
let db: PGliteClient;
let embeddingModel: EmbeddingModel;
let vectorSearch: VectorSearch;
let graphEngine: GraphRAGEngine;
let testDir: string;

async function globalSetup() {
  testDir = await Deno.makeTempDir({ prefix: "bench_" });

  db = new PGliteClient(`${testDir}/bench.db`);
  await db.connect();

  const migrationRunner = new MigrationRunner(db);
  await migrationRunner.runUp(getAllMigrations());

  // Populate database
  const server = createMockFilesystemServer();
  const tools = await server.listTools();
  await storeSchemas(db, "filesystem", tools);

  // Load model and generate embeddings
  embeddingModel = await loadEmbeddingModel();
  await generateEmbeddings(db, embeddingModel);

  // Initialize search and graph
  vectorSearch = new VectorSearch(db, embeddingModel);
  graphEngine = new GraphRAGEngine(db);
  await graphEngine.syncFromDatabase();
}

// Run setup before benchmarks
await globalSetup();

// =================================================================
// Vector Search Benchmarks
// =================================================================

Deno.bench("Vector search latency (single query)", async (b) => {
  b.start();
  await vectorSearch.searchTools("read files", 5, 0.7);
  b.end();
});

Deno.bench("Vector search throughput (100 queries)", async (b) => {
  b.start();
  for (let i = 0; i < 100; i++) {
    await vectorSearch.searchTools("test query", 5, 0.7);
  }
  b.end();
});

Deno.bench("Vector search with low similarity threshold", async (b) => {
  b.start();
  await vectorSearch.searchTools("database operations", 10, 0.3);
  b.end();
});

Deno.bench("Vector search with high similarity threshold", async (b) => {
  b.start();
  await vectorSearch.searchTools("database operations", 10, 0.9);
  b.end();
});

// =================================================================
// Graph Engine Benchmarks
// =================================================================

Deno.bench("Graph sync from database (includes PageRank & Louvain)", async (b) => {
  b.start();
  await graphEngine.syncFromDatabase();
  b.end();
});

Deno.bench("Graph statistics retrieval", (b) => {
  b.start();
  graphEngine.getStats();
  b.end();
});

// =================================================================
// DAG Execution Benchmarks
// =================================================================

Deno.bench("Parallel execution (5 tasks, sequential)", async (b) => {
  const executor = new ParallelExecutor(async (_tool: string, _args: any) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { result: "ok" };
  });

  const dag = createTestDAG(5);

  b.start();
  await executor.execute(dag);
  b.end();
});

Deno.bench("Parallel execution (10 tasks, sequential)", async (b) => {
  const executor = new ParallelExecutor(async (_tool: string, _args: any) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { result: "ok" };
  });

  const dag = createTestDAG(10);

  b.start();
  await executor.execute(dag);
  b.end();
});

Deno.bench("Parallel execution (5 tasks, all parallel)", async (b) => {
  const executor = new ParallelExecutor(async (_tool: string, _args: any) => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { result: "ok" };
  });

  const dag = {
    tasks: Array.from({ length: 5 }, (_, i) => ({
      id: `task${i}`,
      tool: `server:tool${i}`,
      arguments: { input: `value${i}` },
      dependsOn: [], // All parallel
    })),
  };

  b.start();
  await executor.execute(dag);
  b.end();
});

// =================================================================
// Database Benchmarks
// =================================================================

Deno.bench("Database query: SELECT all tools", async (b) => {
  b.start();
  await db.query(`SELECT * FROM tool_schema`);
  b.end();
});

Deno.bench("Database query: Vector similarity search", async (b) => {
  const testVector = Array(1024).fill(0).map((_, i) => i / 1024);

  b.start();
  await db.query(
    `
    SELECT tool_id, 1 - (embedding <=> $1::vector) as similarity
    FROM tool_embedding
    ORDER BY embedding <=> $1::vector
    LIMIT 5
  `,
    [`[${testVector.join(",")}]`],
  );
  b.end();
});

Deno.bench("Database insert: New tool", async (b) => {
  const toolId = `bench-server:bench_tool_${Math.random()}`;
  b.start();
  await db.query(
    `
    INSERT INTO tool_schema (tool_id, server_id, name, description, input_schema)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (tool_id) DO UPDATE SET description = EXCLUDED.description
  `,
    [
      toolId,
      "bench-server",
      `bench_tool_${Math.random()}`,
      "Benchmark tool",
      JSON.stringify({ type: "object" }),
    ],
  );
  b.end();
});

// =================================================================
// Embedding Model Benchmarks
// =================================================================

Deno.bench("Embedding generation (single text)", async (b) => {
  b.start();
  await embeddingModel.encode("test query for benchmarking");
  b.end();
});

Deno.bench("Embedding generation (10 texts)", async (b) => {
  const texts = Array.from({ length: 10 }, (_, i) => `test text ${i}`);

  b.start();
  for (const text of texts) {
    await embeddingModel.encode(text);
  }
  b.end();
});

// Cleanup after all benchmarks
globalThis.addEventListener("unload", async () => {
  try {
    await db.close();
    await Deno.remove(testDir, { recursive: true });
  } catch (error) {
    console.error("Cleanup error:", error);
  }
});
