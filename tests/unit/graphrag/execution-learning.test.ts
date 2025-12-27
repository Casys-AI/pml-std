/**
 * Unit Tests for Execution Learning - Operation vs Tool Node Distinction
 *
 * Phase 2a: Tests that operations and tools are created with correct node types
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  learnSequenceEdgesFromTasks,
  type TaskResultWithLayer,
  type ExecutionLearningGraph,
} from "../../../src/graphrag/dag/execution-learning.ts";

/**
 * Mock graph for testing
 */
class MockGraph implements ExecutionLearningGraph {
  private nodes = new Map<string, Record<string, unknown>>();
  private edges = new Map<string, Map<string, Record<string, unknown>>>();

  hasNode(nodeId: string): boolean {
    return this.nodes.has(nodeId);
  }

  hasEdge(source: string, target: string): boolean {
    return this.edges.get(source)?.has(target) ?? false;
  }

  addNode(nodeId: string, attributes: Record<string, unknown>): void {
    this.nodes.set(nodeId, attributes);
  }

  addEdge(source: string, target: string, attributes: Record<string, unknown>): void {
    if (!this.edges.has(source)) {
      this.edges.set(source, new Map());
    }
    this.edges.get(source)!.set(target, attributes);
  }

  getEdgeAttributes(source: string, target: string): Record<string, unknown> {
    return this.edges.get(source)?.get(target) ?? {};
  }

  setEdgeAttribute(source: string, target: string, attr: string, value: unknown): void {
    const edge = this.getEdgeAttributes(source, target);
    edge[attr] = value;
  }

  getNodeAttributes(nodeId: string): Record<string, unknown> | undefined {
    return this.nodes.get(nodeId);
  }
}

// =============================================================================
// Test: Operation nodes have type="operation"
// =============================================================================

Deno.test("learnSequenceEdgesFromTasks - creates operation nodes with type='operation'", async () => {
  const graph = new MockGraph();
  const tasks: TaskResultWithLayer[] = [
    {
      taskId: "task1",
      tool: "code:filter",
      layerIndex: 0,
    },
    {
      taskId: "task2",
      tool: "code:map",
      layerIndex: 1,
    },
  ];

  await learnSequenceEdgesFromTasks(graph, tasks);

  // Verify code:filter node
  const filterNode = graph.getNodeAttributes("code:filter");
  assertEquals(filterNode?.type, "operation", "code:filter should have type='operation'");
  assertEquals(filterNode?.category, "array", "code:filter should have category='array'");
  assertEquals(filterNode?.pure, true, "code:filter should be pure");
  assertEquals(filterNode?.serverId, "code", "code:filter should have serverId='code'");

  // Verify code:map node
  const mapNode = graph.getNodeAttributes("code:map");
  assertEquals(mapNode?.type, "operation", "code:map should have type='operation'");
  assertEquals(mapNode?.category, "array", "code:map should have category='array'");
  assertEquals(mapNode?.pure, true, "code:map should be pure");
});

Deno.test("learnSequenceEdgesFromTasks - creates tool nodes with type='tool'", async () => {
  const graph = new MockGraph();
  const tasks: TaskResultWithLayer[] = [
    {
      taskId: "task1",
      tool: "github:create_issue",
      layerIndex: 0,
    },
    {
      taskId: "task2",
      tool: "filesystem:read",
      layerIndex: 1,
    },
  ];

  await learnSequenceEdgesFromTasks(graph, tasks);

  // Verify github:create_issue node
  const githubNode = graph.getNodeAttributes("github:create_issue");
  assertEquals(githubNode?.type, "tool", "github:create_issue should have type='tool'");
  assert(!githubNode?.category, "MCP tools should not have category attribute");
  assert(!githubNode?.pure, "MCP tools should not have pure attribute");

  // Verify filesystem:read node
  const fsNode = graph.getNodeAttributes("filesystem:read");
  assertEquals(fsNode?.type, "tool", "filesystem:read should have type='tool'");
});

Deno.test("learnSequenceEdgesFromTasks - handles mixed operation and tool nodes", async () => {
  const graph = new MockGraph();
  const tasks: TaskResultWithLayer[] = [
    {
      taskId: "task1",
      tool: "github:search_issues",
      layerIndex: 0,
    },
    {
      taskId: "task2",
      tool: "code:filter",
      layerIndex: 1,
    },
    {
      taskId: "task3",
      tool: "code:map",
      layerIndex: 2,
    },
    {
      taskId: "task4",
      tool: "github:create_comment",
      layerIndex: 3,
    },
  ];

  await learnSequenceEdgesFromTasks(graph, tasks);

  // Verify MCP tool nodes
  assertEquals(graph.getNodeAttributes("github:search_issues")?.type, "tool");
  assertEquals(graph.getNodeAttributes("github:create_comment")?.type, "tool");

  // Verify operation nodes
  assertEquals(graph.getNodeAttributes("code:filter")?.type, "operation");
  assertEquals(graph.getNodeAttributes("code:map")?.type, "operation");

  // Verify edges were created
  assert(graph.hasEdge("github:search_issues", "code:filter"), "Should have edge from MCP to operation");
  assert(graph.hasEdge("code:filter", "code:map"), "Should have edge between operations");
  assert(graph.hasEdge("code:map", "github:create_comment"), "Should have edge from operation to MCP");
});

// =============================================================================
// Test: Different operation categories
// =============================================================================

Deno.test("learnSequenceEdgesFromTasks - assigns correct categories to operations", async () => {
  const graph = new MockGraph();
  const tasks: TaskResultWithLayer[] = [
    { taskId: "t1", tool: "code:filter", layerIndex: 0 }, // array
    { taskId: "t2", tool: "code:split", layerIndex: 1 }, // string
    { taskId: "t3", tool: "code:Object.keys", layerIndex: 2 }, // object
    { taskId: "t4", tool: "code:Math.max", layerIndex: 3 }, // math
    { taskId: "t5", tool: "code:JSON.parse", layerIndex: 4 }, // json
    { taskId: "t6", tool: "code:add", layerIndex: 5 }, // binary
    { taskId: "t7", tool: "code:equal", layerIndex: 6 }, // logical
    { taskId: "t8", tool: "code:bitwiseAnd", layerIndex: 7 }, // bitwise
  ];

  await learnSequenceEdgesFromTasks(graph, tasks);

  assertEquals(graph.getNodeAttributes("code:filter")?.category, "array");
  assertEquals(graph.getNodeAttributes("code:split")?.category, "string");
  assertEquals(graph.getNodeAttributes("code:Object.keys")?.category, "object");
  assertEquals(graph.getNodeAttributes("code:Math.max")?.category, "math");
  assertEquals(graph.getNodeAttributes("code:JSON.parse")?.category, "json");
  assertEquals(graph.getNodeAttributes("code:add")?.category, "binary");
  assertEquals(graph.getNodeAttributes("code:equal")?.category, "logical");
  assertEquals(graph.getNodeAttributes("code:bitwiseAnd")?.category, "bitwise");
});

// =============================================================================
// Test: Node attributes structure
// =============================================================================

Deno.test("learnSequenceEdgesFromTasks - operation node has all required attributes", async () => {
  const graph = new MockGraph();
  // Need at least 2 tasks for learnSequenceEdgesFromTasks to create nodes
  const tasks: TaskResultWithLayer[] = [
    {
      taskId: "task1",
      tool: "code:reduce",
      layerIndex: 0,
    },
    {
      taskId: "task2",
      tool: "code:map",
      layerIndex: 1,
    },
  ];

  await learnSequenceEdgesFromTasks(graph, tasks);

  const node = graph.getNodeAttributes("code:reduce");
  assert(node, "Node should exist");

  // Required attributes
  assertEquals(typeof node.type, "string", "Should have type");
  assertEquals(typeof node.name, "string", "Should have name");
  assertEquals(typeof node.serverId, "string", "Should have serverId");
  assertEquals(typeof node.category, "string", "Should have category");
  assertEquals(typeof node.pure, "boolean", "Should have pure flag");

  // Correct values
  assertEquals(node.type, "operation");
  assertEquals(node.name, "code:reduce");
  assertEquals(node.serverId, "code");
  assertEquals(node.category, "array");
  assertEquals(node.pure, true);
});
