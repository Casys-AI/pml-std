/**
 * Unit tests for GraphRAGEngine metrics methods - Story 6.3, ADR-048
 *
 * Tests critiques pour valider getMetrics(), getAdaptiveAlpha() et localAlpha
 * méthodes utilisées par le MetricsPanel dashboard.
 *
 * ADR-048: getAdaptiveAlpha() is deprecated, use localAlpha from getMetrics() instead.
 */

import { assert, assertEquals, assertExists } from "@std/assert";
import { PGliteClient } from "../../../src/db/client.ts";
import { getAllMigrations, MigrationRunner } from "../../../src/db/migrations.ts";
import { GraphRAGEngine } from "../../../src/graphrag/graph-engine.ts";

async function createTestDb(): Promise<PGliteClient> {
  const db = new PGliteClient(`memory://${crypto.randomUUID()}`);
  await db.connect();

  const migrationRunner = new MigrationRunner(db);
  await migrationRunner.runUp(getAllMigrations());

  return db;
}

// =============================================================================
// getAdaptiveAlpha() Tests (DEPRECATED - backward compatibility)
// ADR-048: These tests remain for backward compatibility.
// Use localAlpha from getMetrics() for new code.
// =============================================================================

Deno.test({
  name: "GraphRAGEngine.getAdaptiveAlpha - empty graph returns 1.0 (deprecated)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const db = await createTestDb();
    const engine = new GraphRAGEngine(db);
    await engine.syncFromDatabase();

    const alpha = engine.getAdaptiveAlpha();

    assertEquals(alpha, 1.0, "Empty graph should return alpha=1.0 (pure semantic)");

    await db.close();
  },
});

Deno.test({
  name: "GraphRAGEngine.getAdaptiveAlpha - single node returns 1.0",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const db = await createTestDb();
    const engine = new GraphRAGEngine(db);
    await engine.syncFromDatabase();

    // Add a single node
    const graphEngine = engine as any;
    if (graphEngine.graph) {
      graphEngine.graph.addNode("mcp__filesystem__read_file");
    }

    const alpha = engine.getAdaptiveAlpha();

    assertEquals(alpha, 1.0, "Single node graph should return alpha=1.0");

    await db.close();
  },
});

Deno.test({
  name: "GraphRAGEngine.getAdaptiveAlpha - returns value in [0.5, 1.0] range",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const db = await createTestDb();
    const engine = new GraphRAGEngine(db);
    await engine.syncFromDatabase();

    // Add multiple nodes and edges to create some density
    const graphEngine = engine as any;
    if (graphEngine.graph) {
      graphEngine.graph.addNode("tool1");
      graphEngine.graph.addNode("tool2");
      graphEngine.graph.addNode("tool3");
      graphEngine.graph.addEdge("tool1", "tool2", { weight: 0.8, count: 1 });
      graphEngine.graph.addEdge("tool2", "tool3", { weight: 0.9, count: 1 });
    }

    const alpha = engine.getAdaptiveAlpha();

    assert(alpha >= 0.5, `Alpha should be >= 0.5, got ${alpha}`);
    assert(alpha <= 1.0, `Alpha should be <= 1.0, got ${alpha}`);

    await db.close();
  },
});

Deno.test({
  name: "GraphRAGEngine.getAdaptiveAlpha - dense graph lowers alpha",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const db = await createTestDb();
    const engine = new GraphRAGEngine(db);
    await engine.syncFromDatabase();

    // Create a very dense graph (all nodes connected)
    const graphEngine = engine as any;
    if (graphEngine.graph) {
      graphEngine.graph.addNode("tool1");
      graphEngine.graph.addNode("tool2");
      graphEngine.graph.addNode("tool3");
      // Add all possible edges (6 for 3 nodes in directed graph)
      graphEngine.graph.addEdge("tool1", "tool2", { weight: 0.8, count: 1 });
      graphEngine.graph.addEdge("tool1", "tool3", { weight: 0.8, count: 1 });
      graphEngine.graph.addEdge("tool2", "tool1", { weight: 0.8, count: 1 });
      graphEngine.graph.addEdge("tool2", "tool3", { weight: 0.8, count: 1 });
      graphEngine.graph.addEdge("tool3", "tool1", { weight: 0.8, count: 1 });
      graphEngine.graph.addEdge("tool3", "tool2", { weight: 0.8, count: 1 });
    }

    const alpha = engine.getAdaptiveAlpha();

    // With 100% density, alpha should be 0.5 (minimum)
    assertEquals(alpha, 0.5, "Dense graph should return alpha=0.5 (max graph weight)");

    await db.close();
  },
});

// =============================================================================
// getGraphDensity() Tests
// =============================================================================

Deno.test({
  name: "GraphRAGEngine.getGraphDensity - empty graph returns 0",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const db = await createTestDb();
    const engine = new GraphRAGEngine(db);
    await engine.syncFromDatabase();

    const density = engine.getGraphDensity();

    assertEquals(density, 0, "Empty graph should have density 0");

    await db.close();
  },
});

Deno.test({
  name: "GraphRAGEngine.getGraphDensity - sparse graph has low density",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const db = await createTestDb();
    const engine = new GraphRAGEngine(db);
    await engine.syncFromDatabase();

    // Add nodes with one edge
    const graphEngine = engine as any;
    if (graphEngine.graph) {
      graphEngine.graph.addNode("tool1");
      graphEngine.graph.addNode("tool2");
      graphEngine.graph.addNode("tool3");
      graphEngine.graph.addEdge("tool1", "tool2", { weight: 0.5, count: 1 });
    }

    const density = engine.getGraphDensity();

    // 1 edge out of 6 possible = ~0.167
    assert(density > 0, "Sparse graph should have density > 0");
    assert(density < 0.5, "Sparse graph should have density < 0.5");

    await db.close();
  },
});

// =============================================================================
// getPageRankTop() Tests
// =============================================================================

Deno.test({
  name: "GraphRAGEngine.getPageRankTop - returns sorted results",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const db = await createTestDb();
    const engine = new GraphRAGEngine(db);
    await engine.syncFromDatabase();

    // Set up PageRank values manually
    const graphEngine = engine as any;
    graphEngine.pageRanks = {
      "tool1": 0.3,
      "tool2": 0.5,
      "tool3": 0.2,
    };

    const top10 = engine.getPageRankTop(10);

    assertEquals(top10.length, 3, "Should return 3 tools");
    assertEquals(top10[0].toolId, "tool2", "Highest PageRank should be first");
    assertEquals(top10[0].score, 0.5);
    assertEquals(top10[1].toolId, "tool1", "Second highest should be second");
    assertEquals(top10[2].toolId, "tool3", "Lowest should be last");

    await db.close();
  },
});

Deno.test({
  name: "GraphRAGEngine.getPageRankTop - respects limit",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const db = await createTestDb();
    const engine = new GraphRAGEngine(db);
    await engine.syncFromDatabase();

    // Set up more than 10 PageRank values
    const graphEngine = engine as any;
    graphEngine.pageRanks = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`tool${i}`, Math.random()]),
    );

    const top5 = engine.getPageRankTop(5);

    assertEquals(top5.length, 5, "Should respect limit of 5");

    await db.close();
  },
});

Deno.test({
  name: "GraphRAGEngine.getPageRankTop - empty when no PageRanks",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const db = await createTestDb();
    const engine = new GraphRAGEngine(db);
    await engine.syncFromDatabase();

    const top10 = engine.getPageRankTop(10);

    assertEquals(top10.length, 0, "Should return empty array for empty graph");

    await db.close();
  },
});

// =============================================================================
// getTotalCommunities() Tests
// =============================================================================

Deno.test({
  name: "GraphRAGEngine.getTotalCommunities - returns 0 for empty graph",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const db = await createTestDb();
    const engine = new GraphRAGEngine(db);
    await engine.syncFromDatabase();

    const count = engine.getTotalCommunities();

    assertEquals(count, 0, "Empty graph should have 0 communities");

    await db.close();
  },
});

Deno.test({
  name: "GraphRAGEngine.getTotalCommunities - counts unique communities",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const db = await createTestDb();
    const engine = new GraphRAGEngine(db);
    await engine.syncFromDatabase();

    // Set up community assignments manually
    const graphEngine = engine as any;
    graphEngine.communities = {
      "tool1": "community_a",
      "tool2": "community_a",
      "tool3": "community_b",
      "tool4": "community_c",
    };

    const count = engine.getTotalCommunities();

    assertEquals(count, 3, "Should count 3 unique communities");

    await db.close();
  },
});

// =============================================================================
// getMetrics() Tests
// =============================================================================

Deno.test({
  name: "GraphRAGEngine.getMetrics - returns correct structure",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const db = await createTestDb();
    const engine = new GraphRAGEngine(db);
    await engine.syncFromDatabase();

    const metrics = await engine.getMetrics("24h");

    // Verify structure exists
    assertExists(metrics.current, "should have current metrics");
    assertExists(metrics.timeseries, "should have timeseries data");
    assertExists(metrics.period, "should have period stats");

    // Verify current metrics
    assertEquals(typeof metrics.current.nodeCount, "number");
    assertEquals(typeof metrics.current.edgeCount, "number");
    assertEquals(typeof metrics.current.density, "number");
    assertEquals(typeof metrics.current.adaptiveAlpha, "number");
    assertEquals(typeof metrics.current.communitiesCount, "number");
    assertEquals(Array.isArray(metrics.current.pagerankTop10), true);

    // Verify timeseries structure
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
  },
});

Deno.test({
  name: "GraphRAGEngine.getMetrics - empty graph returns zeros",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const db = await createTestDb();
    const engine = new GraphRAGEngine(db);
    await engine.syncFromDatabase();

    const metrics = await engine.getMetrics("1h");

    assertEquals(metrics.current.nodeCount, 0);
    assertEquals(metrics.current.edgeCount, 0);
    assertEquals(metrics.current.density, 0);
    assertEquals(metrics.current.adaptiveAlpha, 1.0);
    assertEquals(metrics.current.communitiesCount, 0);
    assertEquals(metrics.current.pagerankTop10.length, 0);

    await db.close();
  },
});

Deno.test({
  name: "GraphRAGEngine.getMetrics - handles all range values",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const db = await createTestDb();
    const engine = new GraphRAGEngine(db);
    await engine.syncFromDatabase();

    const ranges: Array<"1h" | "24h" | "7d"> = ["1h", "24h", "7d"];

    for (const range of ranges) {
      const metrics = await engine.getMetrics(range);
      assertEquals(metrics.period.range, range, `Range should be ${range}`);
    }

    await db.close();
  },
});

Deno.test({
  name: "GraphRAGEngine.getMetrics - with graph data",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const db = await createTestDb();
    const engine = new GraphRAGEngine(db);
    await engine.syncFromDatabase();

    // Add some graph data
    const graphEngine = engine as any;
    if (graphEngine.graph) {
      graphEngine.graph.addNode("tool1");
      graphEngine.graph.addNode("tool2");
      graphEngine.graph.addEdge("tool1", "tool2", { weight: 0.8, count: 1 });
      graphEngine.pageRanks = { "tool1": 0.6, "tool2": 0.4 };
      graphEngine.communities = { "tool1": "a", "tool2": "a" };
    }

    const metrics = await engine.getMetrics("24h");

    assertEquals(metrics.current.nodeCount, 2);
    assertEquals(metrics.current.edgeCount, 1);
    assert(metrics.current.density > 0);
    assert(metrics.current.adaptiveAlpha < 1.0);
    assertEquals(metrics.current.communitiesCount, 1);
    assertEquals(metrics.current.pagerankTop10.length, 2);

    await db.close();
  },
});

// =============================================================================
// localAlpha Tests (ADR-048)
// =============================================================================

Deno.test({
  name: "GraphRAGEngine.getMetrics - localAlpha is undefined without traces",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const db = await createTestDb();
    const engine = new GraphRAGEngine(db);
    await engine.syncFromDatabase();

    const metrics = await engine.getMetrics("24h");

    // Without algorithm traces, localAlpha should be undefined
    assertEquals(
      metrics.current.localAlpha,
      undefined,
      "localAlpha should be undefined without traces",
    );

    await db.close();
  },
});

Deno.test({
  name: "GraphRAGEngine.getMetrics - localAlpha structure is correct with traces",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const db = await createTestDb();
    const engine = new GraphRAGEngine(db);
    await engine.syncFromDatabase();

    // Insert test algorithm traces with local alpha data
    await db.query(`
      INSERT INTO algorithm_traces (algorithm_mode, target_type, params, signals, final_score, threshold_used, decision)
      VALUES
        ('active_search', 'tool', '{"alpha": 0.65}', '{"graphDensity": 0.1, "alphaAlgorithm": "embeddings_hybrides", "coldStart": false}', 0.85, 0.70, 'accepted'),
        ('active_search', 'tool', '{"alpha": 0.70}', '{"graphDensity": 0.1, "alphaAlgorithm": "embeddings_hybrides", "coldStart": false}', 0.80, 0.70, 'accepted'),
        ('passive_suggestion', 'tool', '{"alpha": 0.80}', '{"graphDensity": 0.1, "alphaAlgorithm": "heat_diffusion", "coldStart": false}', 0.75, 0.70, 'accepted'),
        ('passive_suggestion', 'capability', '{"alpha": 0.90}', '{"graphDensity": 0.1, "alphaAlgorithm": "heat_hierarchical", "coldStart": true}', 0.70, 0.70, 'accepted')
    `);

    const metrics = await engine.getMetrics("24h");

    // localAlpha should now exist
    assertExists(metrics.current.localAlpha, "localAlpha should exist with traces");

    const la = metrics.current.localAlpha!;

    // Verify structure
    assertEquals(typeof la.avgAlpha, "number", "avgAlpha should be a number");
    assertExists(la.byMode, "byMode should exist");
    assertEquals(typeof la.byMode.activeSearch, "number");
    assertEquals(typeof la.byMode.passiveSuggestion, "number");
    assertExists(la.algorithmDistribution, "algorithmDistribution should exist");
    assertEquals(typeof la.coldStartPercentage, "number");

    // Verify values
    assert(
      la.avgAlpha >= 0.5 && la.avgAlpha <= 1.0,
      `avgAlpha should be in [0.5, 1.0], got ${la.avgAlpha}`,
    );
    assert(la.byMode.activeSearch > 0, "activeSearch alpha should be > 0");
    assert(la.byMode.passiveSuggestion > 0, "passiveSuggestion alpha should be > 0");
    assertEquals(
      la.algorithmDistribution.embeddingsHybrides,
      2,
      "Should have 2 embeddings_hybrides traces",
    );
    assertEquals(la.algorithmDistribution.heatDiffusion, 1, "Should have 1 heat_diffusion trace");
    assertEquals(
      la.algorithmDistribution.heatHierarchical,
      1,
      "Should have 1 heat_hierarchical trace",
    );
    assert(
      la.coldStartPercentage >= 0 && la.coldStartPercentage <= 100,
      "coldStartPercentage should be 0-100",
    );

    await db.close();
  },
});

Deno.test({
  name: "GraphRAGEngine.getMetrics - localAlpha avgAlpha is in valid range",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const db = await createTestDb();
    const engine = new GraphRAGEngine(db);
    await engine.syncFromDatabase();

    // Insert traces with various alpha values
    await db.query(`
      INSERT INTO algorithm_traces (algorithm_mode, target_type, params, signals, final_score, threshold_used, decision)
      VALUES
        ('active_search', 'tool', '{"alpha": 0.5}', '{"graphDensity": 0.5, "alphaAlgorithm": "embeddings_hybrides"}', 0.9, 0.70, 'accepted'),
        ('active_search', 'tool', '{"alpha": 1.0}', '{"graphDensity": 0.0, "alphaAlgorithm": "bayesian", "coldStart": true}', 0.6, 0.70, 'accepted')
    `);

    const metrics = await engine.getMetrics("24h");

    assertExists(metrics.current.localAlpha);
    const la = metrics.current.localAlpha!;

    // avgAlpha should be between 0.5 and 1.0
    assert(la.avgAlpha >= 0.5, `avgAlpha should be >= 0.5, got ${la.avgAlpha}`);
    assert(la.avgAlpha <= 1.0, `avgAlpha should be <= 1.0, got ${la.avgAlpha}`);

    // Average of 0.5 and 1.0 should be 0.75
    assertEquals(la.avgAlpha, 0.75, "avgAlpha should be 0.75 (average of 0.5 and 1.0)");

    await db.close();
  },
});
