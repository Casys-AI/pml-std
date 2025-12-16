/**
 * Integration tests for /api/metrics endpoint - Story 6.3, ADR-048
 *
 * Tests the metrics API endpoint served by the Casys PML gateway server.
 *
 * ADR-048: adaptiveAlpha is deprecated, use localAlpha instead for new code.
 */

import { assert, assertEquals, assertExists } from "@std/assert";
import { PGliteClient } from "../../src/db/client.ts";
import { getAllMigrations, MigrationRunner } from "../../src/db/migrations.ts";
import { GraphRAGEngine } from "../../src/graphrag/graph-engine.ts";

const TEST_PORT_BASE = 3100; // Use different port range to avoid conflicts
let portCounter = 0;

function getNextPort(): number {
  return TEST_PORT_BASE + portCounter++;
}

interface MockGatewayConfig {
  graphEngine: GraphRAGEngine;
  port: number;
}

async function createMockGateway(db: PGliteClient): Promise<MockGatewayConfig> {
  const graphEngine = new GraphRAGEngine(db);
  await graphEngine.syncFromDatabase();

  const port = getNextPort();

  return { graphEngine, port };
}

async function createTestDb(): Promise<PGliteClient> {
  const db = new PGliteClient("memory://");
  await db.connect();

  const migrationRunner = new MigrationRunner(db);
  await migrationRunner.runUp(getAllMigrations());

  return db;
}

// =============================================================================
// /api/metrics Endpoint Tests
// =============================================================================

Deno.test("GET /api/metrics - GraphRAGEngine.getMetrics returns valid structure", async () => {
  const db = await createTestDb();
  const { graphEngine } = await createMockGateway(db);

  // Test the engine directly (simulating what the endpoint does)
  const metrics = await graphEngine.getMetrics("24h");

  // Verify structure
  assertExists(metrics);
  assertExists(metrics.current);
  assertExists(metrics.timeseries);
  assertExists(metrics.period);

  // Verify current metrics types
  assertEquals(typeof metrics.current.nodeCount, "number");
  assertEquals(typeof metrics.current.edgeCount, "number");
  assertEquals(typeof metrics.current.density, "number");
  assertEquals(typeof metrics.current.adaptiveAlpha, "number");
  assertEquals(typeof metrics.current.communitiesCount, "number");
  assertEquals(Array.isArray(metrics.current.pagerankTop10), true);

  // Verify timeseries arrays
  assertEquals(Array.isArray(metrics.timeseries.edgeCount), true);
  assertEquals(Array.isArray(metrics.timeseries.avgConfidence), true);
  assertEquals(Array.isArray(metrics.timeseries.workflowRate), true);

  // Verify period stats
  assertEquals(metrics.period.range, "24h");
  assertEquals(typeof metrics.period.workflowsExecuted, "number");
  assertEquals(typeof metrics.period.workflowsSuccessRate, "number");
  assertEquals(typeof metrics.period.newEdgesCreated, "number");
  assertEquals(typeof metrics.period.newNodesAdded, "number");

  await db.close();
});

Deno.test("GET /api/metrics - range parameter 1h", async () => {
  const db = await createTestDb();
  const { graphEngine } = await createMockGateway(db);

  const metrics = await graphEngine.getMetrics("1h");

  assertEquals(metrics.period.range, "1h");

  await db.close();
});

Deno.test("GET /api/metrics - range parameter 7d", async () => {
  const db = await createTestDb();
  const { graphEngine } = await createMockGateway(db);

  const metrics = await graphEngine.getMetrics("7d");

  assertEquals(metrics.period.range, "7d");

  await db.close();
});

Deno.test("GET /api/metrics - empty graph returns sensible defaults", async () => {
  const db = await createTestDb();
  const { graphEngine } = await createMockGateway(db);

  const metrics = await graphEngine.getMetrics("24h");

  // Empty graph should have zero nodes/edges
  assertEquals(metrics.current.nodeCount, 0);
  assertEquals(metrics.current.edgeCount, 0);
  assertEquals(metrics.current.density, 0);

  // Alpha should be 1.0 (pure semantic) for empty graph
  assertEquals(metrics.current.adaptiveAlpha, 1.0);

  // No communities
  assertEquals(metrics.current.communitiesCount, 0);

  // Empty PageRank list
  assertEquals(metrics.current.pagerankTop10.length, 0);

  // Empty timeseries (no historical data)
  assertEquals(metrics.timeseries.edgeCount.length, 0);
  assertEquals(metrics.timeseries.avgConfidence.length, 0);
  assertEquals(metrics.timeseries.workflowRate.length, 0);

  await db.close();
});

Deno.test("GET /api/metrics - with graph data", async () => {
  const db = await createTestDb();
  const { graphEngine } = await createMockGateway(db);

  // Add graph data directly to the engine
  const engine = graphEngine as any;
  if (engine.graph) {
    engine.graph.addNode("tool1");
    engine.graph.addNode("tool2");
    engine.graph.addNode("tool3");
    engine.graph.addEdge("tool1", "tool2", { weight: 0.8, count: 1 });
    engine.graph.addEdge("tool2", "tool3", { weight: 0.7, count: 2 });
    engine.pageRanks = { "tool1": 0.4, "tool2": 0.35, "tool3": 0.25 };
    engine.communities = { "tool1": "a", "tool2": "a", "tool3": "b" };
  }

  const metrics = await graphEngine.getMetrics("24h");

  // Should reflect graph data
  assertEquals(metrics.current.nodeCount, 3);
  assertEquals(metrics.current.edgeCount, 2);
  assert(metrics.current.density > 0, "Density should be > 0");
  assert(metrics.current.adaptiveAlpha < 1.0, "Alpha should be < 1.0 for graph with edges");
  assertEquals(metrics.current.communitiesCount, 2);
  assertEquals(metrics.current.pagerankTop10.length, 3);

  // Verify PageRank ordering (descending)
  assertEquals(metrics.current.pagerankTop10[0].toolId, "tool1");
  assertEquals(metrics.current.pagerankTop10[0].score, 0.4);

  await db.close();
});

Deno.test("GET /api/metrics - pagerank_top_10 is sorted descending", async () => {
  const db = await createTestDb();
  const { graphEngine } = await createMockGateway(db);

  // Add PageRank values
  const engine = graphEngine as any;
  engine.pageRanks = {
    "tool_low": 0.1,
    "tool_high": 0.9,
    "tool_medium": 0.5,
  };

  const metrics = await graphEngine.getMetrics("24h");
  const pageranks = metrics.current.pagerankTop10;

  assertEquals(pageranks[0].toolId, "tool_high");
  assertEquals(pageranks[1].toolId, "tool_medium");
  assertEquals(pageranks[2].toolId, "tool_low");

  await db.close();
});

// ADR-048: This test remains for backward compatibility (adaptiveAlpha is deprecated)
Deno.test("GET /api/metrics - adaptive_alpha in valid range (deprecated)", async () => {
  const db = await createTestDb();
  const { graphEngine } = await createMockGateway(db);

  // Test with various graph configurations
  const configs = [
    { nodes: 0, edges: 0 },
    { nodes: 1, edges: 0 },
    { nodes: 2, edges: 1 },
    { nodes: 5, edges: 10 },
  ];

  for (const config of configs) {
    const engine = graphEngine as any;
    engine.graph.clear();

    for (let i = 0; i < config.nodes; i++) {
      engine.graph.addNode(`tool${i}`);
    }

    let edgesAdded = 0;
    for (let i = 0; i < config.nodes && edgesAdded < config.edges; i++) {
      for (let j = 0; j < config.nodes && edgesAdded < config.edges; j++) {
        if (i !== j) {
          try {
            engine.graph.addEdge(`tool${i}`, `tool${j}`, { weight: 0.5, count: 1 });
            edgesAdded++;
          } catch {
            // Edge might already exist
          }
        }
      }
    }

    const metrics = await graphEngine.getMetrics("24h");

    assert(
      metrics.current.adaptiveAlpha >= 0.5,
      `Alpha should be >= 0.5, got ${metrics.current.adaptiveAlpha}`,
    );
    assert(
      metrics.current.adaptiveAlpha <= 1.0,
      `Alpha should be <= 1.0, got ${metrics.current.adaptiveAlpha}`,
    );
  }

  await db.close();
});

Deno.test("GET /api/metrics - success_rate is percentage (0-100)", async () => {
  const db = await createTestDb();
  const { graphEngine } = await createMockGateway(db);

  const metrics = await graphEngine.getMetrics("24h");

  assert(
    metrics.period.workflowsSuccessRate >= 0,
    "Success rate should be >= 0",
  );
  assert(
    metrics.period.workflowsSuccessRate <= 100,
    "Success rate should be <= 100",
  );

  await db.close();
});

// =============================================================================
// localAlpha Tests (ADR-048)
// =============================================================================

Deno.test("GET /api/metrics - localAlpha is undefined without algorithm traces", async () => {
  const db = await createTestDb();
  const { graphEngine } = await createMockGateway(db);

  const metrics = await graphEngine.getMetrics("24h");

  // Without algorithm traces, localAlpha should be undefined
  assertEquals(metrics.current.localAlpha, undefined);

  await db.close();
});

Deno.test("GET /api/metrics - localAlpha structure with traces", async () => {
  const db = await createTestDb();
  const { graphEngine } = await createMockGateway(db);

  // Insert test algorithm traces with local alpha data
  await db.query(`
    INSERT INTO algorithm_traces (algorithm_mode, target_type, params, signals, final_score, decision)
    VALUES
      ('active_search', 'tool', '{"alpha": 0.65}', '{"graphDensity": 0.1, "alphaAlgorithm": "embeddings_hybrides", "coldStart": false}', 0.85, 'accepted'),
      ('passive_suggestion', 'tool', '{"alpha": 0.80}', '{"graphDensity": 0.1, "alphaAlgorithm": "heat_diffusion", "coldStart": false}', 0.75, 'accepted')
  `);

  const metrics = await graphEngine.getMetrics("24h");

  // localAlpha should now exist
  assertExists(metrics.current.localAlpha, "localAlpha should exist with traces");

  const la = metrics.current.localAlpha!;

  // Verify structure
  assertEquals(typeof la.avgAlpha, "number");
  assertExists(la.byMode);
  assertExists(la.algorithmDistribution);
  assertEquals(typeof la.coldStartPercentage, "number");

  // Verify values are in valid ranges
  assert(la.avgAlpha >= 0.5 && la.avgAlpha <= 1.0, `avgAlpha should be in [0.5, 1.0]`);
  assert(la.coldStartPercentage >= 0 && la.coldStartPercentage <= 100, "coldStartPercentage should be 0-100");

  await db.close();
});

Deno.test("GET /api/metrics - localAlpha byMode values", async () => {
  const db = await createTestDb();
  const { graphEngine } = await createMockGateway(db);

  // Insert traces with different modes
  await db.query(`
    INSERT INTO algorithm_traces (algorithm_mode, target_type, params, signals, final_score, decision)
    VALUES
      ('active_search', 'tool', '{"alpha": 0.60}', '{"graphDensity": 0.1, "alphaAlgorithm": "embeddings_hybrides"}', 0.85, 'accepted'),
      ('active_search', 'tool', '{"alpha": 0.70}', '{"graphDensity": 0.1, "alphaAlgorithm": "embeddings_hybrides"}', 0.80, 'accepted'),
      ('passive_suggestion', 'tool', '{"alpha": 0.85}', '{"graphDensity": 0.1, "alphaAlgorithm": "heat_diffusion"}', 0.75, 'accepted'),
      ('passive_suggestion', 'capability', '{"alpha": 0.95}', '{"graphDensity": 0.1, "alphaAlgorithm": "heat_hierarchical"}', 0.70, 'accepted')
  `);

  const metrics = await graphEngine.getMetrics("24h");

  assertExists(metrics.current.localAlpha);
  const la = metrics.current.localAlpha!;

  // activeSearch average: (0.60 + 0.70) / 2 = 0.65
  assertEquals(la.byMode.activeSearch, 0.65, "activeSearch alpha should be average of 0.60 and 0.70");

  // passiveSuggestion average: (0.85 + 0.95) / 2 = 0.90
  assertEquals(la.byMode.passiveSuggestion, 0.90, "passiveSuggestion alpha should be average of 0.85 and 0.95");

  await db.close();
});

Deno.test("GET /api/metrics - localAlpha algorithmDistribution", async () => {
  const db = await createTestDb();
  const { graphEngine } = await createMockGateway(db);

  // Insert traces with different algorithms
  await db.query(`
    INSERT INTO algorithm_traces (algorithm_mode, target_type, params, signals, final_score, decision)
    VALUES
      ('active_search', 'tool', '{"alpha": 0.65}', '{"graphDensity": 0.1, "alphaAlgorithm": "embeddings_hybrides"}', 0.85, 'accepted'),
      ('active_search', 'tool', '{"alpha": 0.65}', '{"graphDensity": 0.1, "alphaAlgorithm": "embeddings_hybrides"}', 0.85, 'accepted'),
      ('passive_suggestion', 'tool', '{"alpha": 0.80}', '{"graphDensity": 0.1, "alphaAlgorithm": "heat_diffusion"}', 0.75, 'accepted'),
      ('passive_suggestion', 'capability', '{"alpha": 0.90}', '{"graphDensity": 0.1, "alphaAlgorithm": "heat_hierarchical"}', 0.70, 'accepted'),
      ('active_search', 'tool', '{"alpha": 1.0}', '{"graphDensity": 0.0, "alphaAlgorithm": "bayesian", "coldStart": true}', 0.60, 'accepted')
  `);

  const metrics = await graphEngine.getMetrics("24h");

  assertExists(metrics.current.localAlpha);
  const la = metrics.current.localAlpha!;

  assertEquals(la.algorithmDistribution.embeddingsHybrides, 2);
  assertEquals(la.algorithmDistribution.heatDiffusion, 1);
  assertEquals(la.algorithmDistribution.heatHierarchical, 1);
  assertEquals(la.algorithmDistribution.bayesian, 1);

  await db.close();
});
