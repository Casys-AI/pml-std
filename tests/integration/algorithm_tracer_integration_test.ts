/**
 * Algorithm Tracer Integration Tests (Story 7.6 - ADR-039)
 *
 * Tests the integration of AlgorithmTracer with:
 * - CapabilityMatcher (active_search tracing)
 * - DAGSuggester (passive_suggestion tracing)
 * - Feedback API route
 *
 * @module tests/integration/algorithm_tracer_integration_test
 */

import { assertAlmostEquals, assertEquals, assertExists, assertGreater } from "@std/assert";
import { PGliteClient } from "../../src/db/client.ts";
import { getAllMigrations, MigrationRunner } from "../../src/db/migrations.ts";
import { AlgorithmTracer } from "../../src/telemetry/algorithm-tracer.ts";
import { CapabilityMatcher } from "../../src/capabilities/matcher.ts";
import { CapabilityStore } from "../../src/capabilities/capability-store.ts";
import type { AdaptiveThresholdManager } from "../../src/mcp/adaptive-threshold.ts";

/**
 * Mock embedding model for tests
 *
 * Generates similar embeddings for texts containing common keywords
 * to ensure semantic matching works in tests.
 */
class MockEmbeddingModel {
  async load(): Promise<void> {}

  async encode(text: string): Promise<number[]> {
    // Generate embeddings based on keyword presence for similarity
    // Words like "fetch", "example", "website", "data" will generate similar embeddings
    const embedding = new Array(1024).fill(0.1);

    // Common keywords that should match
    const keywords = ["fetch", "example", "website", "data", "http", "url"];

    // Set embedding values based on keyword presence
    const lowerText = text.toLowerCase();
    for (let i = 0; i < keywords.length; i++) {
      if (lowerText.includes(keywords[i])) {
        // Set a cluster of values for this keyword
        for (let j = 0; j < 100; j++) {
          embedding[i * 100 + j] = 0.9;
        }
      }
    }

    // Normalize slightly
    for (let i = 0; i < embedding.length; i++) {
      embedding[i] = embedding[i] + (Math.random() * 0.01);
    }

    return embedding;
  }

  isLoaded(): boolean {
    return true;
  }
}

/**
 * Mock adaptive threshold manager
 */
function createMockThresholdManager(): AdaptiveThresholdManager {
  return {
    getThresholds: () => ({
      suggestionThreshold: 0.70,
      explicitThreshold: 0.90,
    }),
    setContext: () => {},
    getContext: () => ({}),
    updateFromFeedback: async () => {},
  } as unknown as AdaptiveThresholdManager;
}

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

Deno.test("Integration: CapabilityMatcher logs traces via AlgorithmTracer", async () => {
  const db = await setupTestDb();
  const tracer = new AlgorithmTracer(db);
  const model = new MockEmbeddingModel();
  const store = new CapabilityStore(db, model as any);
  const thresholds = createMockThresholdManager();

  // Create matcher with tracer
  const matcher = new CapabilityMatcher(store, thresholds, tracer);

  // Add a capability to the store
  await store.saveCapability({
    code: 'return await tools.fetch({url: "https://example.com"});',
    intent: "Fetch data from example.com website",
    durationMs: 100,
    success: true,
    description: "Fetches data from example.com",
  });

  // Perform a search (should log traces)
  // Result may be null if no match found, but traces are still logged
  await matcher.findMatch("fetch example website data");

  // Flush tracer buffer
  await tracer.flush();

  // Verify traces were logged
  const traces = await db.query("SELECT * FROM algorithm_traces");
  assertGreater(traces.length, 0, "Should have logged at least one trace");

  // Verify trace content
  const trace = traces[0];
  assertEquals(trace.algorithm_mode, "active_search");
  assertEquals(trace.target_type, "capability");
  assertExists(trace.signals);
  assertExists(trace.params);
  assertExists(trace.final_score);
  assertExists(trace.threshold_used);
  assertExists(trace.decision);

  await tracer.stop();
  await db.close();
});

Deno.test("Integration: AlgorithmTracer metrics aggregate correctly after multiple traces", async () => {
  const db = await setupTestDb();
  const tracer = new AlgorithmTracer(db);

  // Log multiple traces with different decisions and modes
  const traces = [
    {
      mode: "active_search" as const,
      targetType: "capability" as const,
      decision: "accepted" as const,
      score: 0.85,
    },
    {
      mode: "active_search" as const,
      targetType: "tool" as const,
      decision: "accepted" as const,
      score: 0.78,
    },
    {
      mode: "passive_suggestion" as const,
      targetType: "tool" as const,
      decision: "rejected_by_threshold" as const,
      score: 0.55,
    },
    {
      mode: "passive_suggestion" as const,
      targetType: "capability" as const,
      decision: "filtered_by_reliability" as const,
      score: 0.30,
    },
    {
      mode: "active_search" as const,
      targetType: "capability" as const,
      decision: "rejected_by_threshold" as const,
      score: 0.65,
    },
  ];

  for (const t of traces) {
    await tracer.logTrace({
      algorithmMode: t.mode,
      targetType: t.targetType,
      signals: { graphDensity: 0.1, spectralClusterMatch: false },
      params: { alpha: 0.5, reliabilityFactor: 1.0, structuralBoost: 0 },
      finalScore: t.score,
      thresholdUsed: 0.70,
      decision: t.decision,
    });
  }

  await tracer.flush();

  // Get all metrics
  const allMetrics = await tracer.getMetrics(24);
  assertEquals(allMetrics.decisionDistribution.accepted, 2);
  assertEquals(allMetrics.decisionDistribution.rejectedByThreshold, 2);
  assertEquals(allMetrics.decisionDistribution.filteredByReliability, 1);

  // Conversion rate: 2 accepted / 5 total = 0.4
  assertAlmostEquals(allMetrics.conversionRate, 0.4, 0.01);

  // Get active_search only
  const activeMetrics = await tracer.getMetrics(24, "active_search");
  assertEquals(activeMetrics.decisionDistribution.accepted, 2);
  assertEquals(activeMetrics.decisionDistribution.rejectedByThreshold, 1);
  // Conversion: 2/3 = 0.666...
  assertGreater(activeMetrics.conversionRate, 0.65);

  await tracer.stop();
  await db.close();
});

Deno.test("Integration: Feedback updates trace outcomes correctly", async () => {
  const db = await setupTestDb();
  const tracer = new AlgorithmTracer(db);

  // Log a trace
  const traceId = await tracer.logTrace({
    algorithmMode: "active_search",
    targetType: "capability",
    intent: "Test intent for feedback",
    signals: { graphDensity: 0.1, spectralClusterMatch: true },
    params: { alpha: 0.65, reliabilityFactor: 1.0, structuralBoost: 0.1 },
    finalScore: 0.85,
    thresholdUsed: 0.70,
    decision: "accepted",
  });

  await tracer.flush();

  // Update outcome (simulating user selection)
  await tracer.updateOutcome(traceId, {
    userAction: "selected",
    executionSuccess: true,
    durationMs: 150,
  });

  // Verify outcome was stored
  const result = await db.query(
    `SELECT outcome FROM algorithm_traces WHERE trace_id = $1`,
    [traceId],
  );

  assertExists(result[0]?.outcome);
  const outcome = result[0].outcome as {
    userAction: string;
    executionSuccess: boolean;
    durationMs: number;
  };
  assertEquals(outcome.userAction, "selected");
  assertEquals(outcome.executionSuccess, true);
  assertEquals(outcome.durationMs, 150);

  await tracer.stop();
  await db.close();
});

Deno.test("Integration: Spectral cluster match is properly tracked", async () => {
  const db = await setupTestDb();
  const tracer = new AlgorithmTracer(db);

  // Log traces with different spectral cluster match values
  await tracer.logTrace({
    algorithmMode: "passive_suggestion",
    targetType: "capability",
    signals: { graphDensity: 0.1, spectralClusterMatch: true },
    params: { alpha: 0.5, reliabilityFactor: 1.0, structuralBoost: 0.2 },
    finalScore: 0.90,
    thresholdUsed: 0.70,
    decision: "accepted",
  });

  await tracer.logTrace({
    algorithmMode: "passive_suggestion",
    targetType: "capability",
    signals: { graphDensity: 0.1, spectralClusterMatch: true },
    params: { alpha: 0.5, reliabilityFactor: 1.0, structuralBoost: 0.15 },
    finalScore: 0.80,
    thresholdUsed: 0.70,
    decision: "accepted",
  });

  await tracer.logTrace({
    algorithmMode: "passive_suggestion",
    targetType: "capability",
    signals: { graphDensity: 0.1, spectralClusterMatch: false },
    params: { alpha: 0.5, reliabilityFactor: 1.0, structuralBoost: 0 },
    finalScore: 0.60,
    thresholdUsed: 0.70,
    decision: "rejected_by_threshold",
  });

  await tracer.flush();

  const metrics = await tracer.getMetrics(24);

  // Spectral relevance should only average cluster-matched traces: (0.90 + 0.80) / 2 = 0.85
  assertAlmostEquals(metrics.spectralRelevance, 0.85, 0.01);

  await tracer.stop();
  await db.close();
});

Deno.test("Integration: 7-day retention cleanup works correctly", async () => {
  const db = await setupTestDb();
  const tracer = new AlgorithmTracer(db);

  // Log a recent trace
  await tracer.logTrace({
    algorithmMode: "active_search",
    targetType: "tool",
    signals: { graphDensity: 0.1, spectralClusterMatch: false },
    params: { alpha: 0.5, reliabilityFactor: 1.0, structuralBoost: 0 },
    finalScore: 0.75,
    thresholdUsed: 0.70,
    decision: "accepted",
  });

  await tracer.flush();

  // Create an old trace (simulate 8 days ago)
  await db.exec(`
    INSERT INTO algorithm_traces (
      trace_id, timestamp, algorithm_mode, target_type,
      signals, params, final_score, threshold_used, decision
    ) VALUES (
      gen_random_uuid(),
      NOW() - INTERVAL '8 days',
      'passive_suggestion',
      'capability',
      '{}'::jsonb,
      '{}'::jsonb,
      0.5,
      0.7,
      'rejected_by_threshold'
    )
  `);

  // Verify we have 2 traces
  let result = await db.query("SELECT COUNT(*) as count FROM algorithm_traces");
  assertEquals(Number(result[0]?.count), 2);

  // Run cleanup with 7-day retention
  const deleted = await tracer.cleanup(7);
  assertEquals(deleted, 1);

  // Verify only recent trace remains
  result = await db.query("SELECT COUNT(*) as count FROM algorithm_traces");
  assertEquals(Number(result[0]?.count), 1);

  await tracer.stop();
  await db.close();
});
