/**
 * Unit tests for AlgorithmTracer
 *
 * Story 7.6: Algorithm Observability (ADR-039)
 *
 * Tests:
 * - logTrace() buffers traces
 * - flush() writes to database
 * - updateOutcome() updates buffer or database
 * - cleanup() removes old traces
 * - getMetrics() returns aggregated metrics
 *
 * @module tests/unit/telemetry/algorithm_tracer_test
 */

import { assertAlmostEquals, assertEquals, assertExists } from "@std/assert";
import { PGliteClient } from "../../../src/db/client.ts";
import { getAllMigrations, MigrationRunner } from "../../../src/db/migrations.ts";
import { AlgorithmTracer, type TraceInput } from "../../../src/telemetry/algorithm-tracer.ts";

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
 * Create a valid trace input for testing
 */
function createTestTrace(overrides: Partial<TraceInput> = {}): TraceInput {
  return {
    algorithmMode: "active_search",
    targetType: "capability",
    intent: "Test intent",
    signals: {
      semanticScore: 0.85,
      successRate: 0.90,
      graphDensity: 0.05,
      spectralClusterMatch: true,
    },
    params: {
      alpha: 0.65,
      reliabilityFactor: 1.2,
      structuralBoost: 0.1,
    },
    finalScore: 0.78,
    thresholdUsed: 0.70,
    decision: "accepted",
    ...overrides,
  };
}

Deno.test("AlgorithmTracer - logTrace() buffers traces and returns traceId", async () => {
  const db = await setupTestDb();
  const tracer = new AlgorithmTracer(db);

  const traceId = await tracer.logTrace(createTestTrace());

  assertExists(traceId);
  assertEquals(typeof traceId, "string");
  assertEquals(traceId.length, 36); // UUID format
  assertEquals(tracer.getBufferSize(), 1);

  await tracer.stop();
  await db.close();
});

Deno.test("AlgorithmTracer - flush() writes buffered traces to database", async () => {
  const db = await setupTestDb();
  const tracer = new AlgorithmTracer(db);

  // Add multiple traces
  await tracer.logTrace(createTestTrace({ intent: "Test 1" }));
  await tracer.logTrace(createTestTrace({ intent: "Test 2" }));
  await tracer.logTrace(createTestTrace({ intent: "Test 3" }));

  assertEquals(tracer.getBufferSize(), 3);

  // Flush to database
  await tracer.flush();

  assertEquals(tracer.getBufferSize(), 0);

  // Verify in database
  const result = await db.query("SELECT COUNT(*) as count FROM algorithm_traces");
  assertEquals(Number(result[0]?.count), 3);

  await tracer.stop();
  await db.close();
});

Deno.test("AlgorithmTracer - updateOutcome() updates trace in buffer", async () => {
  const db = await setupTestDb();
  const tracer = new AlgorithmTracer(db);

  const traceId = await tracer.logTrace(createTestTrace());

  // Update outcome while still in buffer
  await tracer.updateOutcome(traceId, {
    userAction: "selected",
    executionSuccess: true,
    durationMs: 150,
  });

  // Flush and verify outcome is preserved
  await tracer.flush();

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

Deno.test("AlgorithmTracer - updateOutcome() updates trace in database", async () => {
  const db = await setupTestDb();
  const tracer = new AlgorithmTracer(db);

  const traceId = await tracer.logTrace(createTestTrace());
  await tracer.flush();

  // Update outcome in database (buffer is empty)
  await tracer.updateOutcome(traceId, {
    userAction: "ignored",
  });

  const result = await db.query(
    `SELECT outcome FROM algorithm_traces WHERE trace_id = $1`,
    [traceId],
  );

  const outcome = result[0].outcome as { userAction: string };
  assertEquals(outcome.userAction, "ignored");

  await tracer.stop();
  await db.close();
});

Deno.test("AlgorithmTracer - cleanup() removes old traces", async () => {
  const db = await setupTestDb();
  const tracer = new AlgorithmTracer(db);

  // Add trace and flush
  await tracer.logTrace(createTestTrace());
  await tracer.flush();

  // Verify trace exists
  let result = await db.query("SELECT COUNT(*) as count FROM algorithm_traces");
  assertEquals(Number(result[0]?.count), 1);

  // Manually update timestamp to make it old (8 days ago)
  await db.exec(`
    UPDATE algorithm_traces
    SET timestamp = NOW() - INTERVAL '8 days'
  `);

  // Cleanup with 7-day retention
  const deleted = await tracer.cleanup(7);
  assertEquals(deleted, 1);

  // Verify trace is deleted
  result = await db.query("SELECT COUNT(*) as count FROM algorithm_traces");
  assertEquals(Number(result[0]?.count), 0);

  await tracer.stop();
  await db.close();
});

Deno.test("AlgorithmTracer - getMetrics() returns aggregated metrics", async () => {
  const db = await setupTestDb();
  const tracer = new AlgorithmTracer(db);

  // Add varied traces
  await tracer.logTrace(createTestTrace({
    targetType: "tool",
    finalScore: 0.80,
    decision: "accepted",
    signals: { graphDensity: 0.1, spectralClusterMatch: true },
  }));
  await tracer.logTrace(createTestTrace({
    targetType: "capability",
    finalScore: 0.60,
    decision: "rejected_by_threshold",
    signals: { graphDensity: 0.1, spectralClusterMatch: false },
  }));
  await tracer.logTrace(createTestTrace({
    targetType: "capability",
    finalScore: 0.75,
    decision: "accepted",
    signals: { graphDensity: 0.1, spectralClusterMatch: true },
  }));

  await tracer.flush();

  const metrics = await tracer.getMetrics(24);

  // Verify conversion rate: 2 accepted / 3 total = 0.666...
  assertEquals(metrics.conversionRate > 0.6 && metrics.conversionRate < 0.7, true);

  // Verify decision distribution
  assertEquals(metrics.decisionDistribution.accepted, 2);
  assertEquals(metrics.decisionDistribution.rejectedByThreshold, 1);
  assertEquals(metrics.decisionDistribution.filteredByReliability, 0);

  // Verify avg final scores (use assertAlmostEquals for float precision)
  assertAlmostEquals(metrics.avgFinalScore.tool, 0.80, 0.001);
  assertEquals(
    metrics.avgFinalScore.capability > 0.6 && metrics.avgFinalScore.capability < 0.7,
    true,
  );

  await tracer.stop();
  await db.close();
});

Deno.test("AlgorithmTracer - getMetrics() filters by mode", async () => {
  const db = await setupTestDb();
  const tracer = new AlgorithmTracer(db);

  // Add traces with different modes
  await tracer.logTrace(createTestTrace({
    algorithmMode: "active_search",
    decision: "accepted",
  }));
  await tracer.logTrace(createTestTrace({
    algorithmMode: "passive_suggestion",
    decision: "accepted",
  }));
  await tracer.logTrace(createTestTrace({
    algorithmMode: "passive_suggestion",
    decision: "rejected_by_threshold",
  }));

  await tracer.flush();

  // Get metrics for active_search only
  const activeMetrics = await tracer.getMetrics(24, "active_search");
  assertEquals(activeMetrics.decisionDistribution.accepted, 1);

  // Get metrics for passive_suggestion only
  const passiveMetrics = await tracer.getMetrics(24, "passive_suggestion");
  assertEquals(passiveMetrics.decisionDistribution.accepted, 1);
  assertEquals(passiveMetrics.decisionDistribution.rejectedByThreshold, 1);

  await tracer.stop();
  await db.close();
});

Deno.test("AlgorithmTracer - spectralRelevance metric tracks cluster matches", async () => {
  const db = await setupTestDb();
  const tracer = new AlgorithmTracer(db);

  // Add traces with spectral cluster match
  await tracer.logTrace(createTestTrace({
    finalScore: 0.90,
    signals: { graphDensity: 0.1, spectralClusterMatch: true },
  }));
  await tracer.logTrace(createTestTrace({
    finalScore: 0.80,
    signals: { graphDensity: 0.1, spectralClusterMatch: true },
  }));

  // Add trace without cluster match (should not affect spectralRelevance)
  await tracer.logTrace(createTestTrace({
    finalScore: 0.50,
    signals: { graphDensity: 0.1, spectralClusterMatch: false },
  }));

  await tracer.flush();

  const metrics = await tracer.getMetrics(24);

  // Spectral relevance should be average of cluster-matched traces: (0.90 + 0.80) / 2 = 0.85
  assertAlmostEquals(metrics.spectralRelevance, 0.85, 0.001);

  await tracer.stop();
  await db.close();
});

Deno.test("AlgorithmTracer - handles SQL injection in intent field", async () => {
  const db = await setupTestDb();
  const tracer = new AlgorithmTracer(db);

  // Attempt SQL injection via intent field
  const traceId = await tracer.logTrace(createTestTrace({
    intent: "Test'; DROP TABLE algorithm_traces; --",
  }));

  await tracer.flush();

  // Table should still exist and have the trace
  const result = await db.query("SELECT intent FROM algorithm_traces WHERE trace_id = $1", [
    traceId,
  ]);
  assertExists(result[0]);
  assertEquals(result[0].intent, "Test'; DROP TABLE algorithm_traces; --");

  await tracer.stop();
  await db.close();
});
