/**
 * Unit tests for TraceFeatureExtractor (Story 11.8)
 *
 * Tests trace feature extraction from execution history.
 *
 * Tests:
 * - extractTraceFeatures() returns complete TraceFeatures
 * - getTraceStats() computes correct statistics
 * - Cold start returns DEFAULT_TRACE_STATS
 * - Cache layer works correctly
 * - Batch extraction is efficient
 * - Mean pooling for context embeddings
 *
 * @module tests/unit/graphrag/algorithms/trace_feature_extractor_test
 */

import {
  assertAlmostEquals,
  assertEquals,
  assertExists,
  assertGreater,
  assertLessOrEqual,
} from "@std/assert";
import { PGliteClient } from "../../../../src/db/client.ts";
import { getAllMigrations, MigrationRunner } from "../../../../src/db/migrations.ts";
import {
  DEFAULT_EXTRACTOR_CONFIG,
  TraceFeatureExtractor,
} from "../../../../src/graphrag/algorithms/trace-feature-extractor.ts";
import { DEFAULT_TRACE_STATS } from "../../../../src/graphrag/algorithms/shgat.ts";

// ============================================================================
// Test Setup
// ============================================================================

/**
 * Setup test database with migrations
 */
async function setupTestDb(): Promise<PGliteClient> {
  const db = new PGliteClient(":memory:");
  await db.connect();

  const runner = new MigrationRunner(db);
  await runner.runUp(getAllMigrations());

  return db;
}

/**
 * Insert test execution traces
 */
async function insertTestTraces(
  db: PGliteClient,
  traces: Array<{
    executedPath: string[];
    success: boolean;
    durationMs: number;
    executedAt?: Date;
  }>,
): Promise<void> {
  for (const trace of traces) {
    await db.query(
      `
      INSERT INTO execution_trace (
        executed_path, success, duration_ms, executed_at
      ) VALUES ($1, $2, $3, $4)
    `,
      [
        trace.executedPath,
        trace.success,
        trace.durationMs,
        trace.executedAt ?? new Date(),
      ],
    );
  }
}

/**
 * Create mock embedding (1024-dim)
 */
function mockEmbedding(seed: number = 0): number[] {
  return Array.from({ length: 1024 }, (_, i) => Math.sin(seed + i) * 0.5 + 0.5);
}

// ============================================================================
// Cold Start Tests
// ============================================================================

Deno.test("TraceFeatureExtractor - cold start returns defaults", async () => {
  const db = await setupTestDb();
  const extractor = new TraceFeatureExtractor(db);

  // No traces in database
  const stats = await extractor.getTraceStats("nonexistent-tool");

  // Should return default stats
  assertEquals(stats.historicalSuccessRate, DEFAULT_TRACE_STATS.historicalSuccessRate);
  assertEquals(stats.contextualSuccessRate, DEFAULT_TRACE_STATS.contextualSuccessRate);
  assertEquals(stats.recencyScore, DEFAULT_TRACE_STATS.recencyScore);

  await db.close();
});

Deno.test("TraceFeatureExtractor - extractTraceFeatures returns complete structure", async () => {
  const db = await setupTestDb();
  const extractor = new TraceFeatureExtractor(db);

  const intentEmb = mockEmbedding(1);
  const candidateEmb = mockEmbedding(2);
  const contextEmbs = [mockEmbedding(3), mockEmbedding(4)];

  const features = await extractor.extractTraceFeatures(
    "tool-123",
    intentEmb,
    candidateEmb,
    ["context-1", "context-2"],
    contextEmbs,
  );

  // Check structure
  assertExists(features.intentEmbedding);
  assertExists(features.candidateEmbedding);
  assertExists(features.contextEmbeddings);
  assertExists(features.contextAggregated);
  assertExists(features.traceStats);

  // Check dimensions
  assertEquals(features.intentEmbedding.length, 1024);
  assertEquals(features.candidateEmbedding.length, 1024);
  assertEquals(features.contextEmbeddings.length, 2);
  assertEquals(features.contextAggregated.length, 1024);

  await db.close();
});

// ============================================================================
// Statistics Computation Tests
// ============================================================================

Deno.test("TraceFeatureExtractor - computes historical success rate", async () => {
  const db = await setupTestDb();
  const extractor = new TraceFeatureExtractor(db, { minTracesForStats: 3 });

  // Insert traces: 4 success, 1 failure = 80% success rate
  await insertTestTraces(db, [
    { executedPath: ["tool-A", "tool-B"], success: true, durationMs: 100 },
    { executedPath: ["tool-A", "tool-C"], success: true, durationMs: 150 },
    { executedPath: ["tool-A"], success: true, durationMs: 50 },
    { executedPath: ["tool-A", "tool-D"], success: true, durationMs: 200 },
    { executedPath: ["tool-A", "tool-E"], success: false, durationMs: 300 },
  ]);

  const stats = await extractor.getTraceStats("tool-A");

  // 4/5 = 0.8 success rate
  assertAlmostEquals(stats.historicalSuccessRate, 0.8, 0.01);

  await db.close();
});

Deno.test("TraceFeatureExtractor - computes recency score", async () => {
  const db = await setupTestDb();
  const extractor = new TraceFeatureExtractor(db, {
    minTracesForStats: 1,
    recencyHalfLifeHours: 24,
  });

  // Insert trace from 12 hours ago (half life = 24h, so recency ~0.7)
  const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000);
  await insertTestTraces(db, [
    { executedPath: ["tool-recent"], success: true, durationMs: 100, executedAt: twelveHoursAgo },
  ]);

  const stats = await extractor.getTraceStats("tool-recent");

  // exp(-12 * ln(2) / 24) ≈ 0.707
  assertGreater(stats.recencyScore, 0.6);
  assertLessOrEqual(stats.recencyScore, 0.8);

  await db.close();
});

Deno.test("TraceFeatureExtractor - computes usage frequency normalized", async () => {
  const db = await setupTestDb();
  const extractor = new TraceFeatureExtractor(db, { minTracesForStats: 1 });

  // Tool A: 5 uses, Tool B: 2 uses
  await insertTestTraces(db, [
    { executedPath: ["tool-A"], success: true, durationMs: 100 },
    { executedPath: ["tool-A"], success: true, durationMs: 100 },
    { executedPath: ["tool-A"], success: true, durationMs: 100 },
    { executedPath: ["tool-A"], success: true, durationMs: 100 },
    { executedPath: ["tool-A"], success: true, durationMs: 100 },
    { executedPath: ["tool-B"], success: true, durationMs: 100 },
    { executedPath: ["tool-B"], success: true, durationMs: 100 },
  ]);

  const statsA = await extractor.getTraceStats("tool-A");
  const statsB = await extractor.getTraceStats("tool-B");

  // Tool A has max usage, so frequency = 1.0
  assertEquals(statsA.usageFrequency, 1.0);

  // Tool B has 2/5 = 0.4 frequency
  assertAlmostEquals(statsB.usageFrequency, 0.4, 0.01);

  await db.close();
});

// ============================================================================
// Cache Tests
// ============================================================================

Deno.test("TraceFeatureExtractor - cache returns same stats", async () => {
  const db = await setupTestDb();
  const extractor = new TraceFeatureExtractor(db, {
    minTracesForStats: 1,
    cacheTtlMs: 60000, // 1 minute TTL
  });

  await insertTestTraces(db, [
    { executedPath: ["cached-tool"], success: true, durationMs: 100 },
  ]);

  // First call computes
  const stats1 = await extractor.getTraceStats("cached-tool");

  // Second call should return cached
  const stats2 = await extractor.getTraceStats("cached-tool");

  assertEquals(stats1.historicalSuccessRate, stats2.historicalSuccessRate);
  assertEquals(stats1.recencyScore, stats2.recencyScore);

  await db.close();
});

Deno.test("TraceFeatureExtractor - invalidateCache forces recompute", async () => {
  const db = await setupTestDb();
  const extractor = new TraceFeatureExtractor(db, {
    minTracesForStats: 1,
    cacheTtlMs: 60000,
  });

  // Insert initial trace (success)
  await insertTestTraces(db, [
    { executedPath: ["invalidate-tool"], success: true, durationMs: 100 },
  ]);

  const stats1 = await extractor.getTraceStats("invalidate-tool");
  assertEquals(stats1.historicalSuccessRate, 1.0);

  // Insert failure trace
  await insertTestTraces(db, [
    { executedPath: ["invalidate-tool"], success: false, durationMs: 100 },
  ]);

  // Without invalidation, would return cached (1.0)
  const stats2 = await extractor.getTraceStats("invalidate-tool");
  assertEquals(stats2.historicalSuccessRate, 1.0); // Still cached

  // Invalidate and recompute
  extractor.invalidateCache("invalidate-tool");
  const stats3 = await extractor.getTraceStats("invalidate-tool");

  // Now should be 0.5 (1 success, 1 failure)
  assertAlmostEquals(stats3.historicalSuccessRate, 0.5, 0.01);

  await db.close();
});

Deno.test("TraceFeatureExtractor - clearCache clears all entries", async () => {
  const db = await setupTestDb();
  const extractor = new TraceFeatureExtractor(db, { minTracesForStats: 1 });

  await insertTestTraces(db, [
    { executedPath: ["tool-1"], success: true, durationMs: 100 },
    { executedPath: ["tool-2"], success: true, durationMs: 100 },
  ]);

  // Populate cache
  await extractor.getTraceStats("tool-1");
  await extractor.getTraceStats("tool-2");

  const beforeClear = extractor.getCacheStats();
  assertEquals(beforeClear.size, 2);

  extractor.clearCache();

  const afterClear = extractor.getCacheStats();
  assertEquals(afterClear.size, 0);

  await db.close();
});

// ============================================================================
// Batch Extraction Tests
// ============================================================================

Deno.test("TraceFeatureExtractor - batchExtractTraceStats returns all tools", async () => {
  const db = await setupTestDb();
  const extractor = new TraceFeatureExtractor(db, { minTracesForStats: 1 });

  await insertTestTraces(db, [
    { executedPath: ["batch-1"], success: true, durationMs: 100 },
    { executedPath: ["batch-2"], success: false, durationMs: 200 },
    { executedPath: ["batch-3"], success: true, durationMs: 150 },
  ]);

  const toolIds = ["batch-1", "batch-2", "batch-3", "nonexistent"];
  const batchStats = await extractor.batchExtractTraceStats(toolIds);

  assertEquals(batchStats.size, 4);
  assertExists(batchStats.get("batch-1"));
  assertExists(batchStats.get("batch-2"));
  assertExists(batchStats.get("batch-3"));
  assertExists(batchStats.get("nonexistent")); // Returns defaults

  // Check computed values
  assertEquals(batchStats.get("batch-1")!.historicalSuccessRate, 1.0);
  assertEquals(batchStats.get("batch-2")!.historicalSuccessRate, 0.0);
  assertEquals(batchStats.get("batch-3")!.historicalSuccessRate, 1.0);

  // Nonexistent returns defaults
  assertEquals(
    batchStats.get("nonexistent")!.historicalSuccessRate,
    DEFAULT_TRACE_STATS.historicalSuccessRate,
  );

  await db.close();
});

Deno.test("TraceFeatureExtractor - batch uses cache for already computed", async () => {
  const db = await setupTestDb();
  const extractor = new TraceFeatureExtractor(db, { minTracesForStats: 1 });

  await insertTestTraces(db, [
    { executedPath: ["pre-cached"], success: true, durationMs: 100 },
    { executedPath: ["not-cached"], success: true, durationMs: 100 },
  ]);

  // Pre-cache one tool
  await extractor.getTraceStats("pre-cached");
  assertEquals(extractor.getCacheStats().size, 1);

  // Batch should use cache for pre-cached
  await extractor.batchExtractTraceStats(["pre-cached", "not-cached"]);

  // Both should now be cached
  assertEquals(extractor.getCacheStats().size, 2);

  await db.close();
});

// ============================================================================
// Mean Pooling Tests
// ============================================================================

Deno.test("TraceFeatureExtractor - mean pools context embeddings correctly", async () => {
  const db = await setupTestDb();
  const extractor = new TraceFeatureExtractor(db);

  // Create embeddings where mean is predictable
  const emb1 = new Array(1024).fill(0.2);
  const emb2 = new Array(1024).fill(0.8);
  // Mean should be 0.5

  const features = await extractor.extractTraceFeatures(
    "tool-1",
    mockEmbedding(1),
    mockEmbedding(2),
    ["ctx-1", "ctx-2"],
    [emb1, emb2],
  );

  // All values in contextAggregated should be 0.5
  for (const val of features.contextAggregated) {
    assertAlmostEquals(val, 0.5, 0.001);
  }

  await db.close();
});

Deno.test("TraceFeatureExtractor - handles empty context embeddings", async () => {
  const db = await setupTestDb();
  const extractor = new TraceFeatureExtractor(db);

  const features = await extractor.extractTraceFeatures(
    "tool-1",
    mockEmbedding(1),
    mockEmbedding(2),
    [], // No context
    [], // No embeddings
  );

  // Should return zero vector for context aggregated
  assertEquals(features.contextAggregated.length, 1024);
  for (const val of features.contextAggregated) {
    assertEquals(val, 0);
  }

  await db.close();
});

// ============================================================================
// Configuration Tests
// ============================================================================

Deno.test("TraceFeatureExtractor - respects minTracesForStats", async () => {
  const db = await setupTestDb();
  const extractor = new TraceFeatureExtractor(db, { minTracesForStats: 5 });

  // Only 3 traces (below threshold of 5)
  await insertTestTraces(db, [
    { executedPath: ["below-threshold"], success: true, durationMs: 100 },
    { executedPath: ["below-threshold"], success: true, durationMs: 100 },
    { executedPath: ["below-threshold"], success: false, durationMs: 100 },
  ]);

  const stats = await extractor.getTraceStats("below-threshold");

  // Should return defaults because not enough traces
  assertEquals(stats.historicalSuccessRate, DEFAULT_TRACE_STATS.historicalSuccessRate);

  await db.close();
});

Deno.test("TraceFeatureExtractor - default config is valid", () => {
  assertEquals(DEFAULT_EXTRACTOR_CONFIG.cacheTtlMs, 5 * 60 * 1000);
  assertEquals(DEFAULT_EXTRACTOR_CONFIG.maxCacheEntries, 1000);
  assertEquals(DEFAULT_EXTRACTOR_CONFIG.minTracesForStats, 5);
  assertEquals(DEFAULT_EXTRACTOR_CONFIG.recencyHalfLifeHours, 24);
  assertEquals(DEFAULT_EXTRACTOR_CONFIG.maxContextTools, 10);
});

// ============================================================================
// Edge Case Tests: Cache Hit/Miss Tracking
// ============================================================================

Deno.test("TraceFeatureExtractor - cache miss increments on first access", async () => {
  const db = await setupTestDb();
  const extractor = new TraceFeatureExtractor(db, { minTracesForStats: 1 });

  await insertTestTraces(db, [
    { executedPath: ["tool-miss-test"], success: true, durationMs: 100 },
  ]);

  extractor.resetCacheStats();
  const statsBefore = extractor.getCacheStats();
  assertEquals(statsBefore.hits, 0);
  assertEquals(statsBefore.misses, 0);

  await extractor.getTraceStats("tool-miss-test");

  const statsAfter = extractor.getCacheStats();
  assertEquals(statsAfter.misses, 1);
  assertEquals(statsAfter.hits, 0);

  await db.close();
});

Deno.test("TraceFeatureExtractor - cache hit increments on second access", async () => {
  const db = await setupTestDb();
  const extractor = new TraceFeatureExtractor(db, { minTracesForStats: 1 });

  await insertTestTraces(db, [
    { executedPath: ["tool-hit-test"], success: true, durationMs: 100 },
  ]);

  await extractor.getTraceStats("tool-hit-test"); // First access (miss)
  extractor.resetCacheStats();

  await extractor.getTraceStats("tool-hit-test"); // Second access (hit)

  const stats = extractor.getCacheStats();
  assertEquals(stats.hits, 1);
  assertEquals(stats.misses, 0);
  assertAlmostEquals(stats.hitRate, 1.0, 0.001);

  await db.close();
});

Deno.test("TraceFeatureExtractor - hitRate computes correctly", async () => {
  const db = await setupTestDb();
  const extractor = new TraceFeatureExtractor(db, { minTracesForStats: 1 });

  await insertTestTraces(db, [
    { executedPath: ["tool-A"], success: true, durationMs: 100 },
    { executedPath: ["tool-B"], success: true, durationMs: 100 },
  ]);

  extractor.resetCacheStats();
  await extractor.getTraceStats("tool-A"); // miss
  await extractor.getTraceStats("tool-B"); // miss
  await extractor.getTraceStats("tool-A"); // hit
  await extractor.getTraceStats("tool-A"); // hit

  const stats = extractor.getCacheStats();
  assertEquals(stats.hits, 2);
  assertEquals(stats.misses, 2);
  assertAlmostEquals(stats.hitRate, 0.5, 0.001); // 2/4 = 0.5

  await db.close();
});

// ============================================================================
// Edge Case Tests: Intent Similarity
// ============================================================================

Deno.test("TraceFeatureExtractor - intentSimilarSuccessRate returns null when no embeddings", async () => {
  const db = await setupTestDb();
  const extractor = new TraceFeatureExtractor(db, { minTracesForStats: 1 });

  // Insert traces WITHOUT intent_embedding
  await insertTestTraces(db, [
    { executedPath: ["tool-no-embed"], success: true, durationMs: 100 },
    { executedPath: ["tool-no-embed"], success: true, durationMs: 100 },
  ]);

  const rate = await extractor.queryIntentSimilarSuccessRate(
    "tool-no-embed",
    mockEmbedding(42),
    50,
    0.7,
  );

  // Should return null due to no embeddings in DB
  assertEquals(rate, null);

  await db.close();
});

Deno.test("TraceFeatureExtractor - getTraceStatsWithIntent falls back to default", async () => {
  const db = await setupTestDb();
  const extractor = new TraceFeatureExtractor(db, { minTracesForStats: 1 });

  await insertTestTraces(db, [
    { executedPath: ["tool-fallback"], success: true, durationMs: 100 },
  ]);

  const stats = await extractor.getTraceStatsWithIntent(
    "tool-fallback",
    mockEmbedding(1),
    [],
  );

  // intentSimilarSuccessRate should remain at default (no embeddings in DB)
  assertEquals(stats.intentSimilarSuccessRate, DEFAULT_TRACE_STATS.intentSimilarSuccessRate);
  // But historicalSuccessRate should be computed
  assertEquals(stats.historicalSuccessRate, 1.0);

  await db.close();
});

// ============================================================================
// Edge Case Tests: Sequence Position
// ============================================================================

Deno.test("TraceFeatureExtractor - sequencePosition with single-tool paths returns default", async () => {
  const db = await setupTestDb();
  const extractor = new TraceFeatureExtractor(db, { minTracesForStats: 1 });

  // Insert single-tool paths (cannot compute position)
  await insertTestTraces(db, [
    { executedPath: ["solo-tool"], success: true, durationMs: 100 },
    { executedPath: ["solo-tool"], success: true, durationMs: 100 },
  ]);

  const batchStats = await extractor.batchExtractTraceStats(["solo-tool"]);
  const stats = batchStats.get("solo-tool")!;

  // sequencePosition should be default since all paths have length 1
  assertEquals(stats.sequencePosition, DEFAULT_TRACE_STATS.sequencePosition);

  await db.close();
});

Deno.test("TraceFeatureExtractor - sequencePosition normalizes correctly", async () => {
  const db = await setupTestDb();
  const extractor = new TraceFeatureExtractor(db, { minTracesForStats: 1 });

  // Tool always at position 1 of 3 -> (0/2) = 0.0
  await insertTestTraces(db, [
    { executedPath: ["first-tool", "middle", "last"], success: true, durationMs: 100 },
    { executedPath: ["first-tool", "other", "end"], success: true, durationMs: 100 },
  ]);

  const batchStats = await extractor.batchExtractTraceStats(["first-tool"]);
  const stats = batchStats.get("first-tool")!;

  // Position 1 of 3 -> normalized = (1-1)/(3-1) = 0.0
  assertAlmostEquals(stats.sequencePosition, 0.0, 0.01);

  await db.close();
});

Deno.test("TraceFeatureExtractor - sequencePosition at end normalizes to 1.0", async () => {
  const db = await setupTestDb();
  const extractor = new TraceFeatureExtractor(db, { minTracesForStats: 1 });

  // Tool always at last position
  await insertTestTraces(db, [
    { executedPath: ["start", "middle", "last-tool"], success: true, durationMs: 100 },
    { executedPath: ["A", "B", "last-tool"], success: true, durationMs: 100 },
  ]);

  const batchStats = await extractor.batchExtractTraceStats(["last-tool"]);
  const stats = batchStats.get("last-tool")!;

  // Position 3 of 3 -> normalized = (3-1)/(3-1) = 1.0
  assertAlmostEquals(stats.sequencePosition, 1.0, 0.01);

  await db.close();
});

// ============================================================================
// Edge Case Tests: Path Variance and Length
// ============================================================================

Deno.test("TraceFeatureExtractor - pathVariance is 0 for consistent paths", async () => {
  const db = await setupTestDb();
  const extractor = new TraceFeatureExtractor(db, { minTracesForStats: 1 });

  // All paths have tool at same position from end (steps_to_end = 1)
  await insertTestTraces(db, [
    { executedPath: ["A", "B", "consistent-tool"], success: true, durationMs: 100 },
    { executedPath: ["X", "Y", "consistent-tool"], success: true, durationMs: 100 },
    { executedPath: ["1", "2", "consistent-tool"], success: true, durationMs: 100 },
  ]);

  const batchStats = await extractor.batchExtractTraceStats(["consistent-tool"]);
  const stats = batchStats.get("consistent-tool")!;

  // All steps_to_end = 1, variance should be 0
  assertEquals(stats.pathVariance, 0);
  assertEquals(stats.avgPathLengthToSuccess, 1);

  await db.close();
});

Deno.test("TraceFeatureExtractor - pathVariance computed for variable paths", async () => {
  const db = await setupTestDb();
  const extractor = new TraceFeatureExtractor(db, { minTracesForStats: 1 });

  // Varied steps_to_end: 1, 2, 3
  await insertTestTraces(db, [
    { executedPath: ["var-tool"], success: true, durationMs: 100 }, // steps=1
    { executedPath: ["var-tool", "X"], success: true, durationMs: 100 }, // steps=2
    { executedPath: ["var-tool", "X", "Y"], success: true, durationMs: 100 }, // steps=3
  ]);

  const batchStats = await extractor.batchExtractTraceStats(["var-tool"]);
  const stats = batchStats.get("var-tool")!;

  // avg = (1+2+3)/3 = 2
  assertAlmostEquals(stats.avgPathLengthToSuccess, 2.0, 0.01);
  // variance = ((1-2)^2 + (2-2)^2 + (3-2)^2) / 3 = (1+0+1)/3 = 0.667
  assertGreater(stats.pathVariance, 0.5);

  await db.close();
});

Deno.test("TraceFeatureExtractor - avgPathLengthToSuccess only considers successful traces", async () => {
  const db = await setupTestDb();
  const extractor = new TraceFeatureExtractor(db, { minTracesForStats: 1 });

  await insertTestTraces(db, [
    { executedPath: ["success-only-tool", "end"], success: true, durationMs: 100 }, // steps=2
    { executedPath: ["success-only-tool", "fail"], success: false, durationMs: 100 }, // ignored
  ]);

  const batchStats = await extractor.batchExtractTraceStats(["success-only-tool"]);
  const stats = batchStats.get("success-only-tool")!;

  // Only 1 successful trace with steps=2
  assertEquals(stats.avgPathLengthToSuccess, 2);

  await db.close();
});

// ============================================================================
// Edge Case Tests: Batch Extraction
// ============================================================================

Deno.test("TraceFeatureExtractor - batch with empty array returns empty map", async () => {
  const db = await setupTestDb();
  const extractor = new TraceFeatureExtractor(db);

  const batchStats = await extractor.batchExtractTraceStats([]);
  assertEquals(batchStats.size, 0);

  await db.close();
});

Deno.test("TraceFeatureExtractor - batch with duplicate tool IDs deduplicates", async () => {
  const db = await setupTestDb();
  const extractor = new TraceFeatureExtractor(db, { minTracesForStats: 1 });

  await insertTestTraces(db, [
    { executedPath: ["dup-tool"], success: true, durationMs: 100 },
  ]);

  const batchStats = await extractor.batchExtractTraceStats(["dup-tool", "dup-tool", "dup-tool"]);

  // Should still work and return 1 entry (or 3 with same values)
  assertExists(batchStats.get("dup-tool"));
  assertEquals(batchStats.get("dup-tool")!.historicalSuccessRate, 1.0);

  await db.close();
});

Deno.test("TraceFeatureExtractor - batch populates cache for future single queries", async () => {
  const db = await setupTestDb();
  const extractor = new TraceFeatureExtractor(db, { minTracesForStats: 1 });

  await insertTestTraces(db, [
    { executedPath: ["batch-cached-1"], success: true, durationMs: 100 },
    { executedPath: ["batch-cached-2"], success: true, durationMs: 100 },
  ]);

  // Batch extraction populates cache
  await extractor.batchExtractTraceStats(["batch-cached-1", "batch-cached-2"]);
  extractor.resetCacheStats();

  // Single query should hit cache
  await extractor.getTraceStats("batch-cached-1");

  const stats = extractor.getCacheStats();
  assertEquals(stats.hits, 1);
  assertEquals(stats.misses, 0);

  await db.close();
});

// ============================================================================
// Edge Case Tests: Recency with Very Old Traces
// ============================================================================

Deno.test("TraceFeatureExtractor - very old traces have near-zero recency", async () => {
  const db = await setupTestDb();
  const extractor = new TraceFeatureExtractor(db, {
    minTracesForStats: 1,
    recencyHalfLifeHours: 24,
  });

  // Trace from 30 days ago
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  await insertTestTraces(db, [
    { executedPath: ["old-tool"], success: true, durationMs: 100, executedAt: thirtyDaysAgo },
  ]);

  const stats = await extractor.getTraceStats("old-tool");

  // exp(-30*24 * ln(2) / 24) = exp(-30*ln(2)) ≈ 0
  assertLessOrEqual(stats.recencyScore, 0.001);

  await db.close();
});

Deno.test("TraceFeatureExtractor - brand new trace has recency near 1.0", async () => {
  const db = await setupTestDb();
  const extractor = new TraceFeatureExtractor(db, {
    minTracesForStats: 1,
    recencyHalfLifeHours: 24,
  });

  // Trace from just now
  await insertTestTraces(db, [
    { executedPath: ["fresh-tool"], success: true, durationMs: 100, executedAt: new Date() },
  ]);

  const stats = await extractor.getTraceStats("fresh-tool");

  // Very recent, recency should be close to 1.0
  assertGreater(stats.recencyScore, 0.99);

  await db.close();
});

// ============================================================================
// Edge Case Tests: Tool Appearing Multiple Times in Path
// ============================================================================

Deno.test("TraceFeatureExtractor - tool appearing multiple times in path", async () => {
  const db = await setupTestDb();
  const extractor = new TraceFeatureExtractor(db, { minTracesForStats: 1 });

  // Tool appears multiple times in same path
  await insertTestTraces(db, [
    {
      executedPath: ["repeat-tool", "other", "repeat-tool", "end"],
      success: true,
      durationMs: 100,
    },
  ]);

  // Should not crash, stats should be computed
  const batchStats = await extractor.batchExtractTraceStats(["repeat-tool"]);
  assertExists(batchStats.get("repeat-tool"));

  await db.close();
});
