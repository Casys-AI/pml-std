/**
 * Unit tests for Execution Learning Module
 *
 * Tests cover:
 * - updateFromCodeExecution with tool_end and capability_end traces
 * - Parent-child mapping and 'contains' edge creation
 * - Sibling 'sequence' edge creation
 * - createOrUpdateEdge - new edge vs update existing
 * - Count-based source upgrade (inferred → observed)
 * - Edge cases: empty traces, self-loops, duplicate traces
 *
 * @module tests/unit/graphrag/dag/execution_learning_test
 */

import { assertEquals } from "@std/assert";
// @ts-ignore: NPM module resolution
import graphologyPkg from "graphology";
import {
  createOrUpdateEdge,
  type EdgeEventEmitter,
  type ExecutionLearningGraph,
  updateFromCodeExecution,
} from "../../../../src/graphrag/dag/execution-learning.ts";

const { DirectedGraph } = graphologyPkg as { DirectedGraph: new () => any };
import type { TraceEvent } from "../../../../src/sandbox/types.ts";
import { PGliteClient } from "../../../../src/db/client.ts";
import { getAllMigrations, MigrationRunner } from "../../../../src/db/migrations.ts";

/**
 * Create test database with schema
 */
async function createTestDb(): Promise<PGliteClient> {
  const db = new PGliteClient(`memory://${crypto.randomUUID()}`);
  await db.connect();

  const migrationRunner = new MigrationRunner(db);
  await migrationRunner.runUp(getAllMigrations());

  return db;
}

/**
 * Create mock event emitter for testing
 */
function createMockEventEmitter(): EdgeEventEmitter & {
  createdEvents: any[];
  updatedEvents: any[];
} {
  const createdEvents: any[] = [];
  const updatedEvents: any[] = [];

  return {
    createdEvents,
    updatedEvents,
    emitEdgeCreated(data) {
      createdEvents.push(data);
    },
    emitEdgeUpdated(data) {
      updatedEvents.push(data);
    },
  };
}

Deno.test("Execution Learning - updateFromCodeExecution with empty traces", async () => {
  const graph = new DirectedGraph() as ExecutionLearningGraph;
  const db = await createTestDb();
  const traces: TraceEvent[] = [];

  const result = await updateFromCodeExecution(graph, db, traces);

  assertEquals(result.nodesCreated, 0);
  assertEquals(result.edgesCreated, 0);
  assertEquals(result.edgesUpdated, 0);

  await db.close();
});

Deno.test("Execution Learning - updateFromCodeExecution creates node from tool_end", async () => {
  const graph = new DirectedGraph() as ExecutionLearningGraph;
  const db = await createTestDb();

  const traces: TraceEvent[] = [
    {
      type: "tool_end",
      tool: "filesystem:read",
      traceId: "trace-1",
      ts: Date.now(),
      success: true,
      durationMs: 10,
    },
  ];

  const result = await updateFromCodeExecution(graph, db, traces);

  assertEquals(result.nodesCreated, 1);
  assertEquals(graph.hasNode("filesystem:read"), true);
  // Use type assertion since DirectedGraph has getNodeAttributes but interface doesn't expose it
  assertEquals((graph as any).getNodeAttributes("filesystem:read").type, "tool");

  await db.close();
});

Deno.test("Execution Learning - updateFromCodeExecution creates node from capability_end", async () => {
  const graph = new DirectedGraph() as ExecutionLearningGraph;
  const db = await createTestDb();

  const traces: TraceEvent[] = [
    {
      type: "capability_end",
      capability: "read_file",
      capabilityId: "cap-123",
      traceId: "trace-1",
      ts: Date.now(),
      success: true,
      durationMs: 20,
    },
  ];

  const result = await updateFromCodeExecution(graph, db, traces);

  assertEquals(result.nodesCreated, 1);
  assertEquals(graph.hasNode("capability:cap-123"), true);
  // Use type assertion since DirectedGraph has getNodeAttributes but interface doesn't expose it
  assertEquals((graph as any).getNodeAttributes("capability:cap-123").type, "capability");

  await db.close();
});

Deno.test("Execution Learning - updateFromCodeExecution ignores tool_start events", async () => {
  const graph = new DirectedGraph() as ExecutionLearningGraph;
  const db = await createTestDb();

  const traces: TraceEvent[] = [
    {
      type: "tool_start",
      tool: "filesystem:read",
      traceId: "trace-1",
      ts: Date.now(),
    },
  ];

  const result = await updateFromCodeExecution(graph, db, traces);

  assertEquals(result.nodesCreated, 0);
  assertEquals(graph.hasNode("filesystem:read"), false);

  await db.close();
});

Deno.test("Execution Learning - updateFromCodeExecution creates contains edge parent to child", async () => {
  const graph = new DirectedGraph() as ExecutionLearningGraph;
  const db = await createTestDb();

  const traces: TraceEvent[] = [
    {
      type: "capability_end",
      capability: "parent_cap",
      capabilityId: "cap-parent",
      traceId: "trace-parent",
      ts: Date.now(),
      success: true,
      durationMs: 50,
    },
    {
      type: "tool_end",
      tool: "filesystem:read",
      traceId: "trace-child",
      parentTraceId: "trace-parent",
      ts: Date.now(),
      success: true,
      durationMs: 10,
    },
  ];

  const result = await updateFromCodeExecution(graph, db, traces);

  assertEquals(result.nodesCreated, 2);
  assertEquals(result.edgesCreated, 1);
  assertEquals(graph.hasEdge("capability:cap-parent", "filesystem:read"), true);

  const edgeAttrs = graph.getEdgeAttributes("capability:cap-parent", "filesystem:read");
  assertEquals(edgeAttrs.edge_type, "contains");
  assertEquals(edgeAttrs.edge_source, "inferred");
  assertEquals(edgeAttrs.count, 1);

  await db.close();
});

Deno.test("Execution Learning - updateFromCodeExecution creates sequence edges between siblings", async () => {
  const graph = new DirectedGraph() as ExecutionLearningGraph;
  const db = await createTestDb();

  const traces: TraceEvent[] = [
    {
      type: "capability_end",
      capability: "parent_cap",
      capabilityId: "cap-parent",
      traceId: "trace-parent",
      ts: Date.now(),
      success: true,
      durationMs: 100,
    },
    {
      type: "tool_end",
      tool: "filesystem:read",
      traceId: "trace-child-1",
      parentTraceId: "trace-parent",
      ts: Date.now(),
      success: true,
      durationMs: 10,
    },
    {
      type: "tool_end",
      tool: "json:parse",
      traceId: "trace-child-2",
      parentTraceId: "trace-parent",
      ts: Date.now() + 10,
      success: true,
      durationMs: 5,
    },
  ];

  const result = await updateFromCodeExecution(graph, db, traces);

  assertEquals(result.nodesCreated, 3);
  // Contains edges: parent -> child1, parent -> child2
  // Sequence edge: child1 -> child2
  assertEquals(result.edgesCreated, 3);
  assertEquals(graph.hasEdge("filesystem:read", "json:parse"), true);

  const edgeAttrs = graph.getEdgeAttributes("filesystem:read", "json:parse");
  assertEquals(edgeAttrs.edge_type, "sequence");

  await db.close();
});

Deno.test("Execution Learning - updateFromCodeExecution prevents self-loops", async () => {
  const graph = new DirectedGraph() as ExecutionLearningGraph;
  const db = await createTestDb();

  // Create a trace that references itself as parent (edge case)
  const traces: TraceEvent[] = [
    {
      type: "tool_end",
      tool: "filesystem:read",
      traceId: "trace-1",
      parentTraceId: "trace-1", // Self-reference
      ts: Date.now(),
      success: true,
      durationMs: 10,
    },
  ];

  const result = await updateFromCodeExecution(graph, db, traces);

  assertEquals(result.nodesCreated, 1);
  assertEquals(result.edgesCreated, 0); // Should skip self-loop
  assertEquals(graph.hasEdge("filesystem:read", "filesystem:read"), false);

  await db.close();
});

Deno.test("Execution Learning - updateFromCodeExecution skips duplicate sibling sequences", async () => {
  const graph = new DirectedGraph() as ExecutionLearningGraph;
  const db = await createTestDb();

  const traces: TraceEvent[] = [
    {
      type: "capability_end",
      capability: "parent_cap",
      capabilityId: "cap-parent",
      traceId: "trace-parent",
      ts: Date.now(),
      success: true,
      durationMs: 100,
    },
    {
      type: "tool_end",
      tool: "filesystem:read",
      traceId: "trace-child-1",
      parentTraceId: "trace-parent",
      ts: Date.now(),
      success: true,
      durationMs: 10,
    },
    {
      type: "tool_end",
      tool: "filesystem:read", // Same tool again
      traceId: "trace-child-2",
      parentTraceId: "trace-parent",
      ts: Date.now() + 10,
      success: true,
      durationMs: 10,
    },
  ];

  const result = await updateFromCodeExecution(graph, db, traces);

  assertEquals(result.nodesCreated, 2);
  // Contains edges: parent -> child (only 1, updated on second trace)
  // Sequence edge: child -> child (should be skipped)
  // Note: The same parent->child edge is updated, not created twice
  assertEquals(result.edgesCreated, 1);
  assertEquals(result.edgesUpdated, 1);
  assertEquals(graph.hasEdge("filesystem:read", "filesystem:read"), false);

  await db.close();
});

Deno.test("Execution Learning - createOrUpdateEdge creates new edge with inferred source", async () => {
  const graph = new DirectedGraph() as ExecutionLearningGraph;
  graph.addNode("A", {});
  graph.addNode("B", {});
  const emitter = createMockEventEmitter();

  const result = await createOrUpdateEdge(graph, "A", "B", "contains", emitter);

  assertEquals(result, "created");
  assertEquals(graph.hasEdge("A", "B"), true);

  const edgeAttrs = graph.getEdgeAttributes("A", "B");
  assertEquals(edgeAttrs.edge_type, "contains");
  assertEquals(edgeAttrs.edge_source, "inferred");
  assertEquals(edgeAttrs.count, 1);
  assertEquals(Math.round((edgeAttrs.weight as number) * 100) / 100, 0.56); // 0.8 × 0.7

  assertEquals(emitter.createdEvents.length, 1);
  assertEquals(emitter.createdEvents[0].edgeType, "contains");
  assertEquals(emitter.createdEvents[0].edgeSource, "inferred");
});

Deno.test("Execution Learning - createOrUpdateEdge updates existing edge count", async () => {
  const graph = new DirectedGraph() as ExecutionLearningGraph;
  graph.addNode("A", {});
  graph.addNode("B", {});
  const emitter = createMockEventEmitter();

  // Create initial edge
  await createOrUpdateEdge(graph, "A", "B", "contains", emitter);

  // Update it
  const result = await createOrUpdateEdge(graph, "A", "B", "contains", emitter);

  assertEquals(result, "updated");

  const edgeAttrs = graph.getEdgeAttributes("A", "B");
  assertEquals(edgeAttrs.count, 2);
  assertEquals(edgeAttrs.edge_source, "inferred"); // Still inferred (count < 3)

  assertEquals(emitter.updatedEvents.length, 1);
  assertEquals(emitter.updatedEvents[0].observedCount, 2);
});

Deno.test("Execution Learning - createOrUpdateEdge upgrades source to observed at threshold", async () => {
  const graph = new DirectedGraph() as ExecutionLearningGraph;
  graph.addNode("A", {});
  graph.addNode("B", {});
  const emitter = createMockEventEmitter();

  // Create and update edge to reach threshold
  await createOrUpdateEdge(graph, "A", "B", "contains", emitter);
  await createOrUpdateEdge(graph, "A", "B", "contains", emitter);
  const result = await createOrUpdateEdge(graph, "A", "B", "contains", emitter);

  assertEquals(result, "updated");

  const edgeAttrs = graph.getEdgeAttributes("A", "B");
  assertEquals(edgeAttrs.count, 3);
  assertEquals(edgeAttrs.edge_source, "observed"); // Upgraded!
  assertEquals(edgeAttrs.weight, 0.8); // 0.8 × 1.0

  assertEquals(emitter.updatedEvents[1].edgeSource, "observed");
});

Deno.test("Execution Learning - createOrUpdateEdge keeps observed source", async () => {
  const graph = new DirectedGraph() as ExecutionLearningGraph;
  graph.addNode("A", {});
  graph.addNode("B", {});
  const emitter = createMockEventEmitter();

  // Create edge and upgrade to observed
  await createOrUpdateEdge(graph, "A", "B", "contains", emitter);
  await createOrUpdateEdge(graph, "A", "B", "contains", emitter);
  await createOrUpdateEdge(graph, "A", "B", "contains", emitter);

  // Further updates keep observed
  await createOrUpdateEdge(graph, "A", "B", "contains", emitter);

  const edgeAttrs = graph.getEdgeAttributes("A", "B");
  assertEquals(edgeAttrs.count, 4);
  assertEquals(edgeAttrs.edge_source, "observed");
  assertEquals(edgeAttrs.weight, 0.8);
});

Deno.test("Execution Learning - createOrUpdateEdge with dependency edge type", async () => {
  const graph = new DirectedGraph() as ExecutionLearningGraph;
  graph.addNode("A", {});
  graph.addNode("B", {});

  await createOrUpdateEdge(graph, "A", "B", "dependency");

  const edgeAttrs = graph.getEdgeAttributes("A", "B");
  assertEquals(edgeAttrs.edge_type, "dependency");
  assertEquals(edgeAttrs.weight, 0.7); // 1.0 × 0.7 (inferred)
});

Deno.test("Execution Learning - createOrUpdateEdge with sequence edge type", async () => {
  const graph = new DirectedGraph() as ExecutionLearningGraph;
  graph.addNode("A", {});
  graph.addNode("B", {});

  await createOrUpdateEdge(graph, "A", "B", "sequence");

  const edgeAttrs = graph.getEdgeAttributes("A", "B");
  assertEquals(edgeAttrs.edge_type, "sequence");
  assertEquals(edgeAttrs.weight, 0.35); // 0.5 × 0.7 (inferred)
});

Deno.test("Execution Learning - createOrUpdateEdge with provides edge type", async () => {
  const graph = new DirectedGraph() as ExecutionLearningGraph;
  graph.addNode("A", {});
  graph.addNode("B", {});

  await createOrUpdateEdge(graph, "A", "B", "provides");

  const edgeAttrs = graph.getEdgeAttributes("A", "B");
  assertEquals(edgeAttrs.edge_type, "provides");
  assertEquals(Math.round((edgeAttrs.weight as number) * 100) / 100, 0.49); // 0.7 × 0.7 (inferred) - Story 10.3
});

Deno.test("Execution Learning - createOrUpdateEdge emits correct event data", async () => {
  const graph = new DirectedGraph() as ExecutionLearningGraph;
  graph.addNode("tool:A", {});
  graph.addNode("tool:B", {});
  const emitter = createMockEventEmitter();

  await createOrUpdateEdge(graph, "tool:A", "tool:B", "contains", emitter);

  assertEquals(emitter.createdEvents.length, 1);
  assertEquals(emitter.createdEvents[0].fromToolId, "tool:A");
  assertEquals(emitter.createdEvents[0].toToolId, "tool:B");
  assertEquals(Math.round(emitter.createdEvents[0].confidenceScore * 100) / 100, 0.56);
  assertEquals(emitter.createdEvents[0].observedCount, 1);
  assertEquals(emitter.createdEvents[0].edgeType, "contains");
  assertEquals(emitter.createdEvents[0].edgeSource, "inferred");
});

Deno.test("Execution Learning - updateFromCodeExecution with complex hierarchy", async () => {
  const graph = new DirectedGraph() as ExecutionLearningGraph;
  const db = await createTestDb();

  // Test hierarchy without capability->capability edges (which require DB persistence)
  // Focus on tool hierarchy which is the core functionality
  const traces: TraceEvent[] = [
    {
      type: "tool_end",
      tool: "parent:tool",
      traceId: "trace-parent",
      ts: Date.now(),
      success: true,
      durationMs: 200,
    },
    {
      type: "tool_end",
      tool: "filesystem:read",
      traceId: "trace-tool-1",
      parentTraceId: "trace-parent",
      ts: Date.now() + 10,
      success: true,
      durationMs: 10,
    },
    {
      type: "tool_end",
      tool: "json:parse",
      traceId: "trace-tool-2",
      parentTraceId: "trace-parent",
      ts: Date.now() + 20,
      success: true,
      durationMs: 5,
    },
  ];

  const result = await updateFromCodeExecution(graph, db, traces);

  assertEquals(result.nodesCreated, 3);
  // Edges: parent->tool1 (contains), parent->tool2 (contains), tool1->tool2 (sequence)
  assertEquals(result.edgesCreated, 3);

  assertEquals(graph.hasEdge("parent:tool", "filesystem:read"), true);
  assertEquals(graph.hasEdge("parent:tool", "json:parse"), true);
  assertEquals(graph.hasEdge("filesystem:read", "json:parse"), true);

  await db.close();
});

Deno.test("Execution Learning - updateFromCodeExecution with multiple parents", async () => {
  const graph = new DirectedGraph() as ExecutionLearningGraph;
  const db = await createTestDb();

  const traces: TraceEvent[] = [
    {
      type: "capability_end",
      capability: "parent1",
      capabilityId: "cap-p1",
      traceId: "trace-p1",
      ts: Date.now(),
      success: true,
      durationMs: 50,
    },
    {
      type: "capability_end",
      capability: "parent2",
      capabilityId: "cap-p2",
      traceId: "trace-p2",
      ts: Date.now(),
      success: true,
      durationMs: 50,
    },
    {
      type: "tool_end",
      tool: "tool:A",
      traceId: "trace-a",
      parentTraceId: "trace-p1",
      ts: Date.now() + 10,
      success: true,
      durationMs: 5,
    },
    {
      type: "tool_end",
      tool: "tool:B",
      traceId: "trace-b",
      parentTraceId: "trace-p2",
      ts: Date.now() + 10,
      success: true,
      durationMs: 5,
    },
  ];

  const result = await updateFromCodeExecution(graph, db, traces);

  assertEquals(result.nodesCreated, 4);
  assertEquals(result.edgesCreated, 2); // Two separate parent->child edges

  assertEquals(graph.hasEdge("capability:cap-p1", "tool:A"), true);
  assertEquals(graph.hasEdge("capability:cap-p2", "tool:B"), true);
  // No sequence edge between tool:A and tool:B (different parents)
  assertEquals(graph.hasEdge("tool:A", "tool:B"), false);

  await db.close();
});

Deno.test({
  name: "Execution Learning - updateFromCodeExecution handles missing parent gracefully",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const graph = new DirectedGraph() as ExecutionLearningGraph;
    const db = await createTestDb();

    const traces: TraceEvent[] = [
      {
        type: "tool_end",
        tool: "orphan:tool",
        traceId: "trace-child",
        parentTraceId: "trace-nonexistent", // Parent not in traces
        ts: Date.now(),
        success: true,
        durationMs: 10,
      },
    ];

    const result = await updateFromCodeExecution(graph, db, traces);

    assertEquals(result.nodesCreated, 1);
    assertEquals(result.edgesCreated, 0); // No edge created (parent missing)
    assertEquals(graph.hasNode("orphan:tool"), true);

    await db.close();
  },
});

Deno.test("Execution Learning - createOrUpdateEdge weight calculation precision", async () => {
  const graph = new DirectedGraph() as ExecutionLearningGraph;
  graph.addNode("A", {});
  graph.addNode("B", {});

  await createOrUpdateEdge(graph, "A", "B", "provides");

  const edgeAttrs = graph.getEdgeAttributes("A", "B");
  // provides: 0.7, inferred: 0.7, weight: 0.7 × 0.7 = 0.49 (Story 10.3)
  assertEquals(Math.round((edgeAttrs.weight as number) * 100) / 100, 0.49);
});
