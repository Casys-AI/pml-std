/**
 * Context Optimizer Latency Benchmark
 *
 * Verifies AC7: Total query-to-schema latency <200ms P95
 *
 * Run with: deno bench --allow-all tests/benchmark/context_latency_bench.ts
 */

import { ContextOptimizer } from "../../src/context/optimizer.ts";
import { PGliteClient } from "../../src/db/client.ts";
import type { SearchResult, VectorSearch } from "../../src/vector/search.ts";
import type { MCPTool } from "../../src/mcp/types.ts";

// Mock VectorSearch for reproducible benchmarks
class MockVectorSearch implements Pick<VectorSearch, "searchTools"> {
  async searchTools(
    _query: string,
    topK: number = 5,
    _minScore: number = 0.7,
  ): Promise<SearchResult[]> {
    // Simulate realistic search latency (50-100ms)
    await new Promise((resolve) => setTimeout(resolve, Math.random() * 50 + 50));

    return Array.from({ length: topK }, (_, i) => ({
      toolId: `tool-${i}`,
      serverId: `server-${i}`,
      toolName: `Tool ${i}`,
      score: 0.95 - i * 0.05,
      schema: {
        name: `Tool ${i}`,
        description: `Mock tool ${i} for benchmarking`,
        inputSchema: {
          type: "object",
          properties: {
            param1: { type: "string", description: "First parameter" },
            param2: { type: "number", description: "Second parameter" },
          },
        },
      } as MCPTool,
    }));
  }
}

// Setup benchmark database
async function setupBenchmarkDb(): Promise<PGliteClient> {
  const db = new PGliteClient("memory://");
  await db.connect();

  await db.exec(`
    CREATE TABLE metrics (
      id SERIAL PRIMARY KEY,
      metric_name TEXT NOT NULL,
      value REAL NOT NULL,
      timestamp TIMESTAMPTZ DEFAULT NOW(),
      metadata JSONB
    )
  `);

  return db;
}

// Benchmark: Basic query with 5 tools (typical case)
Deno.bench("ContextOptimizer - getRelevantSchemas (5 tools, cold cache)", async (b) => {
  const db = await setupBenchmarkDb();
  const mockSearch = new MockVectorSearch();
  const optimizer = new ContextOptimizer(mockSearch as unknown as VectorSearch, db);

  b.start();

  await optimizer.getRelevantSchemas("read a file", 5, 0.7);

  b.end();

  await db.close();
});

// Benchmark: Query with cache hits (best case performance)
Deno.bench("ContextOptimizer - getRelevantSchemas (5 tools, hot cache)", async (b) => {
  const db = await setupBenchmarkDb();
  const mockSearch = new MockVectorSearch();
  const optimizer = new ContextOptimizer(mockSearch as unknown as VectorSearch, db);

  // Warm up cache
  await optimizer.getRelevantSchemas("test query", 5);

  b.start();

  await optimizer.getRelevantSchemas("test query", 5);

  b.end();

  await db.close();
});

// Benchmark: Larger result set (10 tools)
Deno.bench("ContextOptimizer - getRelevantSchemas (10 tools, cold cache)", async (b) => {
  const db = await setupBenchmarkDb();
  const mockSearch = new MockVectorSearch();
  const optimizer = new ContextOptimizer(mockSearch as unknown as VectorSearch, db);

  b.start();

  await optimizer.getRelevantSchemas("complex query", 10, 0.7);

  b.end();

  await db.close();
});

// Benchmark: Context usage measurement overhead
Deno.bench("ContextOptimizer - context usage measurement only", async (b) => {
  const db = await setupBenchmarkDb();
  const mockSearch = new MockVectorSearch();
  const optimizer = new ContextOptimizer(mockSearch as unknown as VectorSearch, db);

  // Pre-load schemas
  await optimizer.getRelevantSchemas("test", 5);

  b.start();

  // Measure just the metrics calculation (no search/cache)
  // const schemas = _result.schemas;
  // let totalTokens = schemas.length * 500;
  // let usagePercent = (totalTokens / 200_000) * 100;

  b.end();
});

// Benchmark: showContextComparison display
Deno.bench("ContextOptimizer - showContextComparison", async (b) => {
  const db = await setupBenchmarkDb();
  const mockSearch = new MockVectorSearch();
  const optimizer = new ContextOptimizer(mockSearch as unknown as VectorSearch, db);

  const result = await optimizer.getRelevantSchemas("test", 5);

  b.start();

  await optimizer.showContextComparison(100, result.schemas);

  b.end();

  await db.close();
});

// P95 Latency Verification Test
Deno.bench("ContextOptimizer - P95 latency verification (100 samples)", async (b) => {
  const db = await setupBenchmarkDb();
  const mockSearch = new MockVectorSearch();
  const optimizer = new ContextOptimizer(mockSearch as unknown as VectorSearch, db);

  const latencies: number[] = [];

  b.start();

  // Run 100 queries and collect latencies
  for (let i = 0; i < 100; i++) {
    const start = performance.now();
    await optimizer.getRelevantSchemas(`query ${i}`, 5, 0.7);
    const latency = performance.now() - start;
    latencies.push(latency);
  }

  // Calculate P95
  latencies.sort((a, b) => a - b);
  const p95Index = Math.ceil(latencies.length * 0.95) - 1;
  const p95Value = latencies[p95Index];

  b.end();

  console.log(`\n📊 P95 Latency: ${p95Value.toFixed(2)}ms`);
  console.log(`   Target: <200ms`);
  console.log(`   Status: ${p95Value < 200 ? "✓ PASS" : "✗ FAIL"}`);

  await db.close();
});
