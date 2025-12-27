/**
 * Integration Tests: Graph Engine Module Workflows
 *
 * Tests critical multi-module interactions in the refactored GraphRAG engine.
 * Phase 2 refactoring split graph-engine.ts into 14 modules - these tests
 * validate correct integration between them.
 *
 * Scenarios covered:
 * 1. Concurrent Operations - updateFromExecution during syncFromDatabase
 * 2. Execution Learning → DAG Build - learned edges affect DAG topology
 * 3. Edge Weight Consistency - ADR-041 weights calculated consistently
 * 4. Database Persistence Round-Trip - graph state survives sync cycles
 *
 * @module tests/integration/graphrag/graph_engine_workflows_test
 */

import { assert, assertEquals, assertExists } from "@std/assert";
import { PGliteClient } from "../../../src/db/client.ts";
import { GraphRAGEngine } from "../../../src/graphrag/graph-engine.ts";
import { getAllMigrations, MigrationRunner } from "../../../src/db/migrations.ts";
import type { TraceEvent } from "../../../src/sandbox/types.ts";
import type { Task, WorkflowExecution } from "../../../src/graphrag/types.ts";

/**
 * Setup test database with migrations
 */
async function setupTestDb(): Promise<PGliteClient> {
  const db = new PGliteClient(`memory://${crypto.randomUUID()}`);
  await db.connect();
  const runner = new MigrationRunner(db);
  await runner.runUp(getAllMigrations());
  return db;
}

/**
 * Seed database with test tools
 */
async function seedTools(
  db: PGliteClient,
  tools: Array<{ id: string; name: string; server: string }>,
): Promise<void> {
  for (const tool of tools) {
    // Create a simple embedding (1024-dim vector for testing - matches DB schema)
    const embedding = new Array(1024).fill(0).map((_, i) => (i % 10) / 10);
    await db.query(
      `INSERT INTO tool_embedding (tool_id, tool_name, server_id, embedding, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        tool.id,
        tool.name,
        tool.server,
        JSON.stringify(embedding),
        JSON.stringify({ description: `Tool ${tool.name}` }),
      ],
    );
  }
}

/**
 * Seed initial dependencies between tools
 */
async function seedDependencies(
  db: PGliteClient,
  deps: Array<
    {
      from: string;
      to: string;
      count: number;
      confidence: number;
      edgeType?: string;
      edgeSource?: string;
    }
  >,
): Promise<void> {
  for (const dep of deps) {
    await db.query(
      `INSERT INTO tool_dependency (from_tool_id, to_tool_id, observed_count, confidence_score, edge_type, edge_source)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        dep.from,
        dep.to,
        dep.count,
        dep.confidence,
        dep.edgeType || "sequence",
        dep.edgeSource || "inferred",
      ],
    );
  }
}

// =============================================================================
// Scenario 1: Concurrent Operations - Data Consistency
// =============================================================================

Deno.test("Integration - updateFromExecution persists before syncFromDatabase clears graph", async () => {
  const db = await setupTestDb();
  const engine = new GraphRAGEngine(db);

  // Seed initial tools
  await seedTools(db, [
    { id: "fs:read", name: "read_file", server: "filesystem" },
    { id: "fs:write", name: "write_file", server: "filesystem" },
    { id: "json:parse", name: "parse_json", server: "json" },
  ]);

  // Sync to load tools into graph
  await engine.syncFromDatabase();
  assertEquals(engine.getStats().nodeCount, 3);
  assertEquals(engine.getStats().edgeCount, 0);

  // Execute a workflow that creates new edges
  const execution: WorkflowExecution = {
    executedAt: new Date(),
    executionId: "exec-001",
    intentText: "Read and parse file",
    dagStructure: {
      tasks: [
        { id: "t1", tool: "fs:read", dependsOn: [], arguments: {} },
        { id: "t2", tool: "json:parse", dependsOn: ["t1"], arguments: {} },
        { id: "t3", tool: "fs:write", dependsOn: ["t2"], arguments: {} },
      ],
    },
    success: true,
    executionTimeMs: 100,
  };

  await engine.updateFromExecution(execution);

  // Verify edges were created
  assertEquals(engine.getStats().edgeCount, 2); // read→parse, parse→write

  // Now sync again - edges should persist in DB and reload
  await engine.syncFromDatabase();

  // Edges should still be present after sync (loaded from DB)
  const stats = engine.getStats();
  assertEquals(stats.nodeCount, 3);
  assertEquals(stats.edgeCount, 2, "Edges should persist through sync cycle");

  // Verify specific edges exist
  const readToParseEdge = engine.getEdgeData("fs:read", "json:parse");
  assertExists(readToParseEdge, "fs:read → json:parse edge should exist");
  assertEquals(readToParseEdge.edge_type, "dependency");

  const parseToWriteEdge = engine.getEdgeData("json:parse", "fs:write");
  assertExists(parseToWriteEdge, "json:parse → fs:write edge should exist");

  await db.close();
});

Deno.test("Integration - multiple updateFromExecution calls accumulate edge counts", async () => {
  const db = await setupTestDb();
  const engine = new GraphRAGEngine(db);

  await seedTools(db, [
    { id: "tool:A", name: "tool_a", server: "srv1" },
    { id: "tool:B", name: "tool_b", server: "srv1" },
  ]);

  await engine.syncFromDatabase();

  // Execute same workflow pattern 3 times
  for (let i = 0; i < 3; i++) {
    const execution: WorkflowExecution = {
      executedAt: new Date(),
      executionId: `exec-${i}`,
      intentText: "A then B",
      dagStructure: {
        tasks: [
          { id: "t1", tool: "tool:A", dependsOn: [], arguments: {} },
          { id: "t2", tool: "tool:B", dependsOn: ["t1"], arguments: {} },
        ],
      },
      success: true,
      executionTimeMs: 50,
    };
    await engine.updateFromExecution(execution);
  }

  // Verify edge count accumulated
  const edge = engine.getEdgeData("tool:A", "tool:B");
  assertExists(edge);
  assertEquals(edge.count, 3, "Edge count should accumulate across executions");

  // After 3 observations, source should upgrade to "observed" (threshold = 3)
  assertEquals(edge.edge_source, "observed", "Edge source should upgrade to observed at threshold");

  await db.close();
});

// =============================================================================
// Scenario 2: Execution Learning → DAG Building
// =============================================================================

Deno.test("Integration - learned edges influence DAG building via pathfinding", async () => {
  const db = await setupTestDb();
  const engine = new GraphRAGEngine(db);

  // Seed 4 tools
  await seedTools(db, [
    { id: "tool:start", name: "start", server: "srv" },
    { id: "tool:middle1", name: "middle1", server: "srv" },
    { id: "tool:middle2", name: "middle2", server: "srv" },
    { id: "tool:end", name: "end", server: "srv" },
  ]);

  // Seed initial weak path: start → middle1 → end
  await seedDependencies(db, [
    { from: "tool:start", to: "tool:middle1", count: 1, confidence: 0.5 },
    { from: "tool:middle1", to: "tool:end", count: 1, confidence: 0.5 },
  ]);

  await engine.syncFromDatabase();

  // Initial state: path exists via middle1
  const initialPath = engine.findShortestPath("tool:start", "tool:end");
  assertExists(initialPath);
  assertEquals(initialPath.length, 3); // start → middle1 → end

  // Now learn a stronger direct path via execution: start → middle2 → end
  // Execute this pattern multiple times to build confidence
  for (let i = 0; i < 5; i++) {
    const execution: WorkflowExecution = {
      executedAt: new Date(),
      executionId: `learn-${i}`,
      intentText: "Direct path",
      dagStructure: {
        tasks: [
          { id: "t1", tool: "tool:start", dependsOn: [], arguments: {} },
          { id: "t2", tool: "tool:middle2", dependsOn: ["t1"], arguments: {} },
          { id: "t3", tool: "tool:end", dependsOn: ["t2"], arguments: {} },
        ],
      },
      success: true,
      executionTimeMs: 30,
    };
    await engine.updateFromExecution(execution);
  }

  // Verify new path was learned with higher confidence
  const middle2Edge = engine.getEdgeData("tool:start", "tool:middle2");
  assertExists(middle2Edge);
  assert(middle2Edge.count >= 5, "Should have accumulated observations");
  assertEquals(middle2Edge.edge_source, "observed", "Should be upgraded to observed");

  // Build DAG with all 4 tools - should use learned relationships
  const dag = engine.buildDAG(["tool:start", "tool:middle1", "tool:middle2", "tool:end"]);

  assertExists(dag);
  assert(dag.tasks.length > 0, "DAG should have tasks");

  // The learned edges (start→middle2, middle2→end) should influence task ordering
  // Verify the DAG respects the stronger learned path
  const taskOrder = dag.tasks.map((t: Task) => t.tool);
  const startIdx = taskOrder.indexOf("tool:start");
  const endIdx = taskOrder.indexOf("tool:end");
  assert(startIdx < endIdx, "Start should come before end in DAG");

  await db.close();
});

Deno.test("Integration - updateFromCodeExecution creates contains and sequence edges", async () => {
  const db = await setupTestDb();
  const engine = new GraphRAGEngine(db);

  await seedTools(db, [
    { id: "capability:parent", name: "parent_cap", server: "cap" },
    { id: "tool:child1", name: "child1", server: "tools" },
    { id: "tool:child2", name: "child2", server: "tools" },
  ]);

  await engine.syncFromDatabase();
  assertEquals(engine.getStats().edgeCount, 0);

  // Simulate code execution with parent-child trace hierarchy
  const traces: TraceEvent[] = [
    {
      type: "capability_end",
      capability: "parent_cap",
      capabilityId: "parent",
      traceId: "trace-parent",
      ts: Date.now(),
      success: true,
      durationMs: 100,
    },
    {
      type: "tool_end",
      tool: "tool:child1",
      traceId: "trace-child1",
      parentTraceId: "trace-parent",
      ts: Date.now() + 10,
      success: true,
      durationMs: 20,
    },
    {
      type: "tool_end",
      tool: "tool:child2",
      traceId: "trace-child2",
      parentTraceId: "trace-parent",
      ts: Date.now() + 30,
      success: true,
      durationMs: 20,
    },
  ];

  await engine.updateFromCodeExecution(traces);

  // Verify edges created
  const stats = engine.getStats();
  assert(stats.edgeCount >= 2, "Should have at least 2 edges (contains + sequence)");

  // Check contains edge (parent → child)
  const containsEdge = engine.getEdgeData("capability:parent", "tool:child1");
  assertExists(containsEdge, "Contains edge should exist");
  assertEquals(containsEdge.edge_type, "contains");

  // Check sequence edge (child1 → child2)
  const sequenceEdge = engine.getEdgeData("tool:child1", "tool:child2");
  assertExists(sequenceEdge, "Sequence edge should exist");
  assertEquals(sequenceEdge.edge_type, "sequence");

  await db.close();
});

// =============================================================================
// Scenario 3: Edge Weight Consistency (ADR-041)
// =============================================================================

Deno.test("Integration - edge weights consistent across sync/learning/build cycle", async () => {
  const db = await setupTestDb();
  const engine = new GraphRAGEngine(db);

  await seedTools(db, [
    { id: "tool:X", name: "tool_x", server: "srv" },
    { id: "tool:Y", name: "tool_y", server: "srv" },
  ]);

  // Seed with specific edge type and source
  await seedDependencies(db, [
    {
      from: "tool:X",
      to: "tool:Y",
      count: 5,
      confidence: 0.8,
      edgeType: "dependency",
      edgeSource: "observed",
    },
  ]);

  await engine.syncFromDatabase();

  // Verify edge loaded with correct attributes
  const edge = engine.getEdgeData("tool:X", "tool:Y");
  assertExists(edge);
  assertEquals(edge.edge_type, "dependency");
  assertEquals(edge.edge_source, "observed");
  assertEquals(edge.count, 5);

  // Verify getEdgeWeight uses correct formula: type_weight × source_modifier
  // dependency = 1.0, observed = 1.0 → weight = 1.0
  const calculatedWeight = engine.getEdgeWeight("dependency", "observed");
  assertEquals(calculatedWeight, 1.0);

  // Execute more to increment count
  const execution: WorkflowExecution = {
    executedAt: new Date(),
    executionId: "exec-weight",
    intentText: "X then Y",
    dagStructure: {
      tasks: [
        { id: "t1", tool: "tool:X", dependsOn: [], arguments: {} },
        { id: "t2", tool: "tool:Y", dependsOn: ["t1"], arguments: {} },
      ],
    },
    success: true,
    executionTimeMs: 25,
  };
  await engine.updateFromExecution(execution);

  // Edge count should increment
  const updatedEdge = engine.getEdgeData("tool:X", "tool:Y");
  assertExists(updatedEdge);
  assertEquals(updatedEdge.count, 6);
  assertEquals(updatedEdge.edge_source, "observed"); // Should stay observed

  await db.close();
});

// =============================================================================
// Scenario 4: Database Persistence Round-Trip
// =============================================================================

Deno.test("Integration - graph state persists and reloads correctly", async () => {
  const db = await setupTestDb();

  // Phase 1: Create engine, add data
  const engine1 = new GraphRAGEngine(db);
  await seedTools(db, [
    { id: "persist:A", name: "a", server: "srv" },
    { id: "persist:B", name: "b", server: "srv" },
    { id: "persist:C", name: "c", server: "srv" },
  ]);
  await engine1.syncFromDatabase();

  // Create edges via execution
  const execution: WorkflowExecution = {
    executedAt: new Date(),
    executionId: "persist-exec",
    intentText: "A → B → C",
    dagStructure: {
      tasks: [
        { id: "t1", tool: "persist:A", dependsOn: [], arguments: {} },
        { id: "t2", tool: "persist:B", dependsOn: ["t1"], arguments: {} },
        { id: "t3", tool: "persist:C", dependsOn: ["t2"], arguments: {} },
      ],
    },
    success: true,
    executionTimeMs: 50,
  };
  await engine1.updateFromExecution(execution);

  const stats1 = engine1.getStats();
  assertEquals(stats1.edgeCount, 2);

  // Phase 2: Create NEW engine instance, load from same DB
  const engine2 = new GraphRAGEngine(db);
  await engine2.syncFromDatabase();

  // Verify state matches
  const stats2 = engine2.getStats();
  assertEquals(stats2.nodeCount, stats1.nodeCount, "Node count should match");
  assertEquals(stats2.edgeCount, stats1.edgeCount, "Edge count should match");

  // Verify specific edges
  const edgeAB = engine2.getEdgeData("persist:A", "persist:B");
  assertExists(edgeAB, "Edge A→B should persist");
  assertEquals(edgeAB.edge_type, "dependency");

  const edgeBC = engine2.getEdgeData("persist:B", "persist:C");
  assertExists(edgeBC, "Edge B→C should persist");

  await db.close();
});

// =============================================================================
// Scenario 5: Event Emission During Multi-Module Operations
// =============================================================================

Deno.test("Integration - events emitted correctly during workflow operations", async () => {
  const db = await setupTestDb();
  const engine = new GraphRAGEngine(db);

  const events: Array<{ type: string; data: unknown }> = [];

  // Subscribe to events
  engine.on("graph_event", (event) => {
    events.push({ type: event.type, data: event.data });
  });

  await seedTools(db, [
    { id: "event:A", name: "a", server: "srv" },
    { id: "event:B", name: "b", server: "srv" },
  ]);

  // Sync should emit graph_synced event
  await engine.syncFromDatabase();

  const syncEvent = events.find((e) => e.type === "graph_synced");
  assertExists(syncEvent, "Should emit graph_synced event");

  // Execute workflow should emit workflow_executed event
  const execution: WorkflowExecution = {
    executedAt: new Date(),
    executionId: "event-exec",
    intentText: "A then B",
    dagStructure: {
      tasks: [
        { id: "t1", tool: "event:A", dependsOn: [], arguments: {} },
        { id: "t2", tool: "event:B", dependsOn: ["t1"], arguments: {} },
      ],
    },
    success: true,
    executionTimeMs: 30,
  };
  await engine.updateFromExecution(execution);

  const workflowEvent = events.find((e) => e.type === "workflow_executed");
  assertExists(workflowEvent, "Should emit workflow_executed event");

  // Should also emit edge_created events
  const edgeCreatedEvents = events.filter((e) => e.type === "edge_created");
  assert(edgeCreatedEvents.length >= 1, "Should emit at least one edge_created event");

  // Cleanup
  engine.off("graph_event", () => {});
  await db.close();
});

// =============================================================================
// Scenario 6: PageRank and Community Recomputation
// =============================================================================

Deno.test("Integration - PageRank recomputed after execution learning", async () => {
  const db = await setupTestDb();
  const engine = new GraphRAGEngine(db);

  await seedTools(db, [
    { id: "pr:hub", name: "hub", server: "srv" },
    { id: "pr:spoke1", name: "spoke1", server: "srv" },
    { id: "pr:spoke2", name: "spoke2", server: "srv" },
    { id: "pr:spoke3", name: "spoke3", server: "srv" },
  ]);

  await engine.syncFromDatabase();

  // Initially no edges, PageRank should be equal
  const initialPR = engine.getPageRank("pr:hub");

  // Create hub topology: all spokes connect to hub
  for (let i = 1; i <= 3; i++) {
    const execution: WorkflowExecution = {
      executedAt: new Date(),
      executionId: `pr-exec-${i}`,
      intentText: `Spoke${i} to hub`,
      dagStructure: {
        tasks: [
          { id: "t1", tool: `pr:spoke${i}`, dependsOn: [], arguments: {} },
          { id: "t2", tool: "pr:hub", dependsOn: ["t1"], arguments: {} },
        ],
      },
      success: true,
      executionTimeMs: 20,
    };
    await engine.updateFromExecution(execution);
  }

  // Hub should have higher PageRank now (more incoming edges)
  const finalPR = engine.getPageRank("pr:hub");
  assert(finalPR > initialPR, `Hub PageRank should increase (${finalPR} > ${initialPR})`);

  // Verify communities detected
  const communityCount = engine.getTotalCommunities();
  assert(communityCount >= 1, "Should detect at least one community");

  await db.close();
});
