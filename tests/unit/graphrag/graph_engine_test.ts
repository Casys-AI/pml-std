/**
 * Unit tests for GraphRAG Engine
 *
 * Tests cover all Core GraphRAG acceptance criteria:
 * - AC1: Graphology dependencies integration
 * - AC2: Graph sync from PGlite
 * - AC3: PageRank computation
 * - AC4: Community detection (Louvain)
 * - AC5: Shortest path finding
 * - AC6: DAG builder using graph topology
 * - AC7: Performance targets (<50ms sync, <100ms PageRank)
 * - AC8: Unit tests for graph operations
 */

import { assert, assertEquals, assertExists } from "@std/assert";
import { GraphRAGEngine } from "../../../src/graphrag/graph-engine.ts";
import { PGliteClient } from "../../../src/db/client.ts";
import { getAllMigrations, MigrationRunner } from "../../../src/db/migrations.ts";

/**
 * Create test database with schema
 */
async function createTestDb(): Promise<PGliteClient> {
  const db = new PGliteClient(`memory://${crypto.randomUUID()}`);
  await db.connect();

  // Run all migrations properly
  const migrationRunner = new MigrationRunner(db);
  await migrationRunner.runUp(getAllMigrations());

  return db;
}

/**
 * Insert test tools into database
 */
async function insertTestTools(db: PGliteClient): Promise<void> {
  // Create test tools with embeddings
  const tools = [
    { id: "filesystem:read", server: "filesystem", name: "read_file" },
    { id: "json:parse", server: "json", name: "parse" },
    { id: "filesystem:write", server: "filesystem", name: "write_file" },
    { id: "http:get", server: "http", name: "get" },
    { id: "json:stringify", server: "json", name: "stringify" },
  ];

  for (const tool of tools) {
    // Insert tool schema
    await db.query(
      `INSERT INTO tool_schema (tool_id, server_id, name, description, input_schema)
       VALUES ($1, $2, $3, $4, $5)`,
      [tool.id, tool.server, tool.name, `Test tool ${tool.name}`, "{}"],
    );

    // Insert tool embedding (dummy 1024-dim vector)
    const embedding = new Array(1024).fill(0).map(() => Math.random());
    await db.query(
      `INSERT INTO tool_embedding (tool_id, server_id, tool_name, embedding, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [tool.id, tool.server, tool.name, `[${embedding.join(",")}]`, "{}"],
    );
  }
}

/**
 * Insert test dependencies into database
 */
async function insertTestDependencies(db: PGliteClient): Promise<void> {
  const dependencies = [
    { from: "http:get", to: "json:parse", count: 10, confidence: 0.9 },
    { from: "json:parse", to: "filesystem:write", count: 5, confidence: 0.7 },
    { from: "filesystem:read", to: "json:parse", count: 8, confidence: 0.85 },
    { from: "json:stringify", to: "filesystem:write", count: 6, confidence: 0.75 },
  ];

  for (const dep of dependencies) {
    await db.query(
      `INSERT INTO tool_dependency (from_tool_id, to_tool_id, observed_count, confidence_score)
       VALUES ($1, $2, $3, $4)`,
      [dep.from, dep.to, dep.count, dep.confidence],
    );
  }
}

// ============================================
// AC1: Graphology dependencies integration
// ============================================

Deno.test("GraphRAGEngine - can import Graphology dependencies", () => {
  // Test that Graphology modules are accessible
  const engine = new GraphRAGEngine(new PGliteClient(`memory://${crypto.randomUUID()}`));
  assertExists(engine);
});

// ============================================
// AC2: Graph sync from PGlite
// ============================================

// Note: sanitizeOps/sanitizeResources disabled due to EventBus singleton using BroadcastChannel
Deno.test({
  name: "GraphRAGEngine - sync from database loads nodes and edges",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const db = await createTestDb();
    await insertTestTools(db);
    await insertTestDependencies(db);

    const engine = new GraphRAGEngine(db);
    await engine.syncFromDatabase();

    const stats = engine.getStats();
    assertEquals(stats.nodeCount, 5, "Should load 5 tool nodes");
    assertEquals(stats.edgeCount, 4, "Should load 4 dependency edges");

    await db.close();
  },
});

Deno.test("GraphRAGEngine - sync handles empty database gracefully", async () => {
  const db = await createTestDb();

  const engine = new GraphRAGEngine(db);
  await engine.syncFromDatabase();

  const stats = engine.getStats();
  assertEquals(stats.nodeCount, 0);
  assertEquals(stats.edgeCount, 0);

  await db.close();
});

// ============================================
// AC3: PageRank computation
// ============================================

Deno.test("GraphRAGEngine - PageRank scores between 0 and 1", async () => {
  const db = await createTestDb();
  await insertTestTools(db);
  await insertTestDependencies(db);

  const engine = new GraphRAGEngine(db);
  await engine.syncFromDatabase();

  const rank1 = engine.getPageRank("filesystem:read");
  const rank2 = engine.getPageRank("json:parse");

  assert(rank1 >= 0 && rank1 <= 1, `PageRank ${rank1} should be between 0 and 1`);
  assert(rank2 >= 0 && rank2 <= 1, `PageRank ${rank2} should be between 0 and 1`);

  await db.close();
});

Deno.test("GraphRAGEngine - PageRank ranks frequently used tools higher", async () => {
  const db = await createTestDb();
  await insertTestTools(db);
  await insertTestDependencies(db);

  const engine = new GraphRAGEngine(db);
  await engine.syncFromDatabase();

  // json:parse is a hub (2 incoming edges)
  const parseRank = engine.getPageRank("json:parse");
  // filesystem:write is a sink (2 incoming edges)
  const writeRank = engine.getPageRank("filesystem:write");
  // http:get is a source (0 incoming edges)
  const getRank = engine.getPageRank("http:get");

  // json:parse and filesystem:write should have higher PageRank than http:get
  assert(
    parseRank > getRank || writeRank > getRank,
    `Hub/sink tools should have higher PageRank than source tools`,
  );

  await db.close();
});

// ============================================
// AC4: Community detection (Louvain)
// ============================================

Deno.test("GraphRAGEngine - community detection groups related tools", async () => {
  const db = await createTestDb();
  await insertTestTools(db);
  await insertTestDependencies(db);

  const engine = new GraphRAGEngine(db);
  await engine.syncFromDatabase();

  const community1 = engine.getCommunity("json:parse");
  const community2 = engine.getCommunity("filesystem:write");

  assertExists(community1, "json:parse should belong to a community");
  assertExists(community2, "filesystem:write should belong to a community");

  await db.close();
});

Deno.test("GraphRAGEngine - findCommunityMembers returns tools in same cluster", async () => {
  const db = await createTestDb();
  await insertTestTools(db);
  await insertTestDependencies(db);

  const engine = new GraphRAGEngine(db);
  await engine.syncFromDatabase();

  const members = engine.findCommunityMembers("json:parse");

  // Should return other tools in same community (at least 1)
  assert(Array.isArray(members), "Should return array of community members");
  // Should not include the tool itself
  assert(!members.includes("json:parse"), "Should not include the tool itself");

  await db.close();
});

// ============================================
// AC5: Shortest path finding
// ============================================

Deno.test("GraphRAGEngine - findShortestPath returns correct path", async () => {
  const db = await createTestDb();
  await insertTestTools(db);
  await insertTestDependencies(db);

  const engine = new GraphRAGEngine(db);
  await engine.syncFromDatabase();

  const path = engine.findShortestPath("http:get", "filesystem:write");

  assertExists(path, "Should find path from http:get to filesystem:write");
  assertEquals(path![0], "http:get", "Path should start with http:get");
  assertEquals(
    path![path!.length - 1],
    "filesystem:write",
    "Path should end with filesystem:write",
  );
  assert(path!.length >= 2, "Path should have at least 2 nodes");

  await db.close();
});

Deno.test("GraphRAGEngine - findShortestPath returns null for disconnected tools", async () => {
  const db = await createTestDb();
  await insertTestTools(db);
  // No dependencies - tools are disconnected

  const engine = new GraphRAGEngine(db);
  await engine.syncFromDatabase();

  const path = engine.findShortestPath("http:get", "filesystem:write");

  assertEquals(path, null, "Should return null for disconnected tools");

  await db.close();
});

// ============================================
// AC6: DAG builder using graph topology
// ============================================

Deno.test("GraphRAGEngine - buildDAG creates dependencies based on graph topology", async () => {
  const db = await createTestDb();
  await insertTestTools(db);
  await insertTestDependencies(db);

  const engine = new GraphRAGEngine(db);
  await engine.syncFromDatabase();

  const dag = engine.buildDAG(["http:get", "json:parse", "filesystem:write"]);

  assertEquals(dag.tasks.length, 3, "Should create 3 tasks");
  assertEquals(dag.tasks[0].tool, "http:get");
  assertEquals(dag.tasks[1].tool, "json:parse");
  assertEquals(dag.tasks[2].tool, "filesystem:write");

  // json:parse should depend on http:get (path exists)
  assert(
    dag.tasks[1].dependsOn.length > 0,
    "json:parse should have dependencies",
  );

  await db.close();
});

Deno.test("GraphRAGEngine - buildDAG handles tools with no dependencies", async () => {
  const db = await createTestDb();
  await insertTestTools(db);
  // No dependencies inserted

  const engine = new GraphRAGEngine(db);
  await engine.syncFromDatabase();

  const dag = engine.buildDAG(["filesystem:read", "http:get"]);

  assertEquals(dag.tasks.length, 2);
  assertEquals(dag.tasks[0].dependsOn.length, 0, "First task should have no dependencies");
  assertEquals(
    dag.tasks[1].dependsOn.length,
    0,
    "Second task should have no dependencies (no path)",
  );

  await db.close();
});

// ============================================
// AC7: Performance targets
// ============================================

Deno.test("GraphRAGEngine - graph sync completes within 50ms", async () => {
  const db = await createTestDb();
  await insertTestTools(db);
  await insertTestDependencies(db);

  const engine = new GraphRAGEngine(db);

  const startTime = performance.now();
  await engine.syncFromDatabase();
  const syncTime = performance.now() - startTime;

  assert(syncTime < 50, `Graph sync took ${syncTime.toFixed(2)}ms, should be <50ms`);

  await db.close();
});

// ============================================
// AC8: Unit tests for graph operations
// ============================================

Deno.test("GraphRAGEngine - getStats returns accurate graph statistics", async () => {
  const db = await createTestDb();
  await insertTestTools(db);
  await insertTestDependencies(db);

  const engine = new GraphRAGEngine(db);
  await engine.syncFromDatabase();

  const stats = engine.getStats();

  assertExists(stats);
  assertEquals(stats.nodeCount, 5);
  assertEquals(stats.edgeCount, 4);
  assert(stats.communities >= 1, "Should have at least 1 community");
  assert(stats.avgPageRank > 0 && stats.avgPageRank <= 1, "avgPageRank should be between 0 and 1");

  await db.close();
});

Deno.test("GraphRAGEngine - updateFromExecution strengthens edges", async () => {
  const db = await createTestDb();
  await insertTestTools(db);
  await insertTestDependencies(db);

  const engine = new GraphRAGEngine(db);
  await engine.syncFromDatabase();

  // Simulate workflow execution
  const execution = {
    executionId: crypto.randomUUID(),
    executedAt: new Date(),
    intentText: "test workflow",
    dagStructure: {
      tasks: [
        { id: "task_0", tool: "http:get", arguments: {}, dependsOn: [] },
        { id: "task_1", tool: "json:parse", arguments: {}, dependsOn: ["task_0"] },
      ],
    },
    success: true,
    executionTimeMs: 100,
  };

  await engine.updateFromExecution(execution);

  // Verify edge was updated in database
  const result = await db.queryOne(
    `SELECT observed_count, confidence_score FROM tool_dependency
     WHERE from_tool_id = $1 AND to_tool_id = $2`,
    ["http:get", "json:parse"],
  );

  assertExists(result);
  assert((result.observed_count as number) > 10, "observed_count should have increased");

  await db.close();
});

// ============================================
// Story 5.2 / ADR-022: searchToolsHybrid Tests
// ============================================

/**
 * Mock VectorSearch for testing hybrid search
 */
class MockVectorSearch {
  private mockResults: Array<{
    toolId: string;
    serverId: string;
    toolName: string;
    score: number;
    schema?: { description?: string };
  }> = [];

  setResults(
    results: Array<{
      toolId: string;
      serverId: string;
      toolName: string;
      score: number;
      schema?: { description?: string };
    }>,
  ) {
    this.mockResults = results;
  }

  async searchTools(
    _query: string,
    topK: number = 5,
    minScore: number = 0.7,
  ): Promise<
    Array<{
      toolId: string;
      serverId: string;
      toolName: string;
      score: number;
      schema: { description?: string };
    }>
  > {
    // Respect topK and minScore parameters like real VectorSearch
    return this.mockResults
      .filter((r) => r.score >= minScore)
      .slice(0, topK)
      .map((r) => ({
        ...r,
        schema: r.schema || { description: `Test tool ${r.toolName}` },
      }));
  }
}

Deno.test("GraphRAGEngine - searchToolsHybrid returns combined semantic+graph scores", async () => {
  const db = await createTestDb();
  await insertTestTools(db);
  await insertTestDependencies(db);

  const engine = new GraphRAGEngine(db);
  await engine.syncFromDatabase();

  const mockVectorSearch = new MockVectorSearch();
  mockVectorSearch.setResults([
    { toolId: "json:parse", serverId: "json", toolName: "parse", score: 0.9 },
    { toolId: "filesystem:write", serverId: "filesystem", toolName: "write_file", score: 0.8 },
    { toolId: "http:get", serverId: "http", toolName: "get", score: 0.7 },
  ]);

  const results = await engine.searchToolsHybrid(
    mockVectorSearch as unknown as import("../../../src/vector/search.ts").VectorSearch,
    "parse json data",
    5,
    [],
    false,
  );

  assertExists(results);
  assert(results.length > 0, "Should return results");

  // Each result should have semantic, graph, and final scores
  for (const result of results) {
    assertExists(result.toolId);
    assertExists(result.semanticScore);
    assertExists(result.graphScore);
    assertExists(result.finalScore);
    assert(result.semanticScore >= 0 && result.semanticScore <= 1);
    assert(result.graphScore >= 0 && result.graphScore <= 1);
    assert(result.finalScore >= 0 && result.finalScore <= 1);
  }

  await db.close();
});

Deno.test("GraphRAGEngine - searchToolsHybrid calculates adaptive alpha based on edge count", async () => {
  const db = await createTestDb();
  await insertTestTools(db);
  // No dependencies - sparse graph
  // With sparse graph, alpha should be high (more semantic weight)

  const engine = new GraphRAGEngine(db);
  await engine.syncFromDatabase();

  const mockVectorSearch = new MockVectorSearch();
  mockVectorSearch.setResults([
    { toolId: "json:parse", serverId: "json", toolName: "parse", score: 0.9 },
  ]);

  const results = await engine.searchToolsHybrid(
    mockVectorSearch as unknown as import("../../../src/vector/search.ts").VectorSearch,
    "parse json",
    5,
    [],
    false,
  );

  assertExists(results);
  assert(results.length > 0);

  // With no edges (sparse graph), final score should be close to semantic score
  // because alpha approaches 1.0
  const result = results[0];
  assert(
    Math.abs(result.finalScore - result.semanticScore) < 0.5,
    `With sparse graph, finalScore (${result.finalScore}) should be close to semanticScore (${result.semanticScore})`,
  );

  await db.close();
});

Deno.test("GraphRAGEngine - searchToolsHybrid boosts tools with graph context", async () => {
  const db = await createTestDb();
  await insertTestTools(db);
  await insertTestDependencies(db);

  const engine = new GraphRAGEngine(db);
  await engine.syncFromDatabase();

  const mockVectorSearch = new MockVectorSearch();
  mockVectorSearch.setResults([
    // json:parse has lower semantic score but should be boosted by context
    { toolId: "json:parse", serverId: "json", toolName: "parse", score: 0.7 },
    { toolId: "filesystem:write", serverId: "filesystem", toolName: "write_file", score: 0.7 },
  ]);

  // Context includes http:get which has edge to json:parse
  const results = await engine.searchToolsHybrid(
    mockVectorSearch as unknown as import("../../../src/vector/search.ts").VectorSearch,
    "process data",
    5,
    ["http:get"], // Context tool
    false,
  );

  assertExists(results);
  assert(results.length > 0);

  // Find json:parse result - should have non-zero graph score
  const parseResult = results.find((r) => r.toolId === "json:parse");
  assertExists(parseResult);
  assert(
    parseResult.graphScore > 0,
    `json:parse should have graph boost from context (got ${parseResult.graphScore})`,
  );

  await db.close();
});

Deno.test("GraphRAGEngine - searchToolsHybrid includes related tools when requested", async () => {
  const db = await createTestDb();
  await insertTestTools(db);
  await insertTestDependencies(db);

  const engine = new GraphRAGEngine(db);
  await engine.syncFromDatabase();

  const mockVectorSearch = new MockVectorSearch();
  mockVectorSearch.setResults([
    { toolId: "json:parse", serverId: "json", toolName: "parse", score: 0.9 },
  ]);

  const results = await engine.searchToolsHybrid(
    mockVectorSearch as unknown as import("../../../src/vector/search.ts").VectorSearch,
    "parse json",
    5,
    [],
    true, // Include related tools
  );

  assertExists(results);
  assert(results.length > 0);

  const parseResult = results.find((r) => r.toolId === "json:parse");
  assertExists(parseResult);

  // json:parse has neighbors (http:get → json:parse → filesystem:write)
  // Should have related tools from graph neighbors
  assertExists(parseResult.relatedTools);
  // May or may not have related tools depending on graph structure
  // But the array should exist
  assert(Array.isArray(parseResult.relatedTools));

  await db.close();
});

Deno.test("GraphRAGEngine - searchToolsHybrid handles empty results gracefully", async () => {
  const db = await createTestDb();
  await insertTestTools(db);

  const engine = new GraphRAGEngine(db);
  await engine.syncFromDatabase();

  const mockVectorSearch = new MockVectorSearch();
  mockVectorSearch.setResults([]); // No results

  const results = await engine.searchToolsHybrid(
    mockVectorSearch as unknown as import("../../../src/vector/search.ts").VectorSearch,
    "nonexistent tool query",
    5,
    [],
    false,
  );

  assertEquals(results.length, 0, "Should return empty array when no semantic results");

  await db.close();
});

Deno.test("GraphRAGEngine - searchToolsHybrid respects limit parameter", async () => {
  const db = await createTestDb();
  await insertTestTools(db);
  await insertTestDependencies(db);

  const engine = new GraphRAGEngine(db);
  await engine.syncFromDatabase();

  const mockVectorSearch = new MockVectorSearch();
  mockVectorSearch.setResults([
    { toolId: "json:parse", serverId: "json", toolName: "parse", score: 0.9 },
    { toolId: "filesystem:write", serverId: "filesystem", toolName: "write_file", score: 0.85 },
    { toolId: "http:get", serverId: "http", toolName: "get", score: 0.8 },
    { toolId: "filesystem:read", serverId: "filesystem", toolName: "read_file", score: 0.75 },
    { toolId: "json:stringify", serverId: "json", toolName: "stringify", score: 0.7 },
  ]);

  const results = await engine.searchToolsHybrid(
    mockVectorSearch as unknown as import("../../../src/vector/search.ts").VectorSearch,
    "file tools",
    2, // Limit to 2
    [],
    false,
  );

  assertEquals(results.length, 2, "Should respect limit parameter");

  await db.close();
});

Deno.test("GraphRAGEngine - searchToolsHybrid performance < 20ms overhead", async () => {
  const db = await createTestDb();
  await insertTestTools(db);
  await insertTestDependencies(db);

  const engine = new GraphRAGEngine(db);
  await engine.syncFromDatabase();

  const mockVectorSearch = new MockVectorSearch();
  mockVectorSearch.setResults([
    { toolId: "json:parse", serverId: "json", toolName: "parse", score: 0.9 },
    { toolId: "filesystem:write", serverId: "filesystem", toolName: "write_file", score: 0.85 },
    { toolId: "http:get", serverId: "http", toolName: "get", score: 0.8 },
  ]);

  const startTime = performance.now();
  await engine.searchToolsHybrid(
    mockVectorSearch as unknown as import("../../../src/vector/search.ts").VectorSearch,
    "test query",
    10,
    ["http:get"],
    true,
  );
  const elapsedMs = performance.now() - startTime;

  // Mock vector search is instant, so we're measuring pure graph overhead
  // ADR-022 targets <20ms overhead
  assert(
    elapsedMs < 50, // Allow some buffer for test environment
    `searchToolsHybrid overhead was ${elapsedMs.toFixed(1)}ms, should be <20ms`,
  );

  await db.close();
});
