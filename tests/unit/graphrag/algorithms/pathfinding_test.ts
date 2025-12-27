/**
 * Unit tests for Path Finding Algorithm Module
 *
 * Tests cover:
 * - findShortestPath with various graph topologies
 * - findAllPaths with cycles, disconnected graphs
 * - calculatePathWeight and calculateAveragePathWeight
 * - hasPathWithinHops boundary conditions
 * - getPathLength
 * - Edge cases: empty graph, single node, no path exists
 *
 * @module tests/unit/graphrag/algorithms/pathfinding_test
 */

import { assertEquals } from "@std/assert";
// @ts-ignore: NPM module resolution
import graphologyPkg from "graphology";
import {
  calculateAveragePathWeight,
  calculatePathWeight,
  findAllPaths,
  findShortestPath,
  getPathLength,
  hasPathWithinHops,
} from "../../../../src/graphrag/algorithms/pathfinding.ts";

const { DirectedGraph } = graphologyPkg as { DirectedGraph: new () => any };

/**
 * Create a simple test graph with weighted edges
 *
 * Graph structure:
 *   A -> B -> D
 *   |    |
 *   v    v
 *   C -> E
 */
function createTestGraph(): any {
  const graph = new DirectedGraph();

  graph.addNode("A", { type: "tool" });
  graph.addNode("B", { type: "tool" });
  graph.addNode("C", { type: "tool" });
  graph.addNode("D", { type: "tool" });
  graph.addNode("E", { type: "tool" });

  graph.addEdge("A", "B", { weight: 0.8, edge_type: "contains", edge_source: "observed" });
  graph.addEdge("A", "C", { weight: 0.5, edge_type: "sequence", edge_source: "inferred" });
  graph.addEdge("B", "D", { weight: 1.0, edge_type: "dependency", edge_source: "observed" });
  graph.addEdge("B", "E", { weight: 0.6, edge_type: "alternative", edge_source: "observed" });
  graph.addEdge("C", "E", { weight: 0.7, edge_type: "contains", edge_source: "inferred" });

  return graph;
}

/**
 * Create a graph with cycles
 *
 * Graph structure:
 *   A -> B -> C
 *   ^         |
 *   +---------+
 */
function createCyclicGraph(): any {
  const graph = new DirectedGraph();

  graph.addNode("A", { type: "tool" });
  graph.addNode("B", { type: "tool" });
  graph.addNode("C", { type: "tool" });

  graph.addEdge("A", "B", { weight: 0.8, edge_type: "sequence", edge_source: "observed" });
  graph.addEdge("B", "C", { weight: 0.8, edge_type: "sequence", edge_source: "observed" });
  graph.addEdge("C", "A", { weight: 0.8, edge_type: "sequence", edge_source: "observed" });

  return graph;
}

/**
 * Create a disconnected graph
 *
 * Graph structure:
 *   A -> B    C -> D
 */
function createDisconnectedGraph(): any {
  const graph = new DirectedGraph();

  graph.addNode("A", { type: "tool" });
  graph.addNode("B", { type: "tool" });
  graph.addNode("C", { type: "tool" });
  graph.addNode("D", { type: "tool" });

  graph.addEdge("A", "B", { weight: 0.8, edge_type: "sequence", edge_source: "observed" });
  graph.addEdge("C", "D", { weight: 0.8, edge_type: "sequence", edge_source: "observed" });

  return graph;
}

Deno.test("Pathfinding - findShortestPath finds direct path", () => {
  const graph = createTestGraph();
  const path = findShortestPath(graph, "A", "B");
  assertEquals(path, ["A", "B"]);
});

Deno.test("Pathfinding - findShortestPath finds multi-hop path", () => {
  const graph = createTestGraph();
  const path = findShortestPath(graph, "A", "D");
  assertEquals(path, ["A", "B", "D"]);
});

Deno.test("Pathfinding - findShortestPath prefers higher weight edges", () => {
  const graph = createTestGraph();
  // Path A -> B -> E has higher total weight than A -> C -> E
  // A -> B (0.8) -> E (0.6) = total cost: 1/0.8 + 1/0.6 = 2.92
  // A -> C (0.5) -> E (0.7) = total cost: 1/0.5 + 1/0.7 = 3.43
  const path = findShortestPath(graph, "A", "E");
  assertEquals(path, ["A", "B", "E"]);
});

Deno.test("Pathfinding - findShortestPath returns null for non-existent source", () => {
  const graph = createTestGraph();
  const path = findShortestPath(graph, "Z", "A");
  assertEquals(path, null);
});

Deno.test("Pathfinding - findShortestPath returns null for non-existent target", () => {
  const graph = createTestGraph();
  const path = findShortestPath(graph, "A", "Z");
  assertEquals(path, null);
});

Deno.test("Pathfinding - findShortestPath returns null for disconnected nodes", () => {
  const graph = createDisconnectedGraph();
  const path = findShortestPath(graph, "A", "C");
  assertEquals(path, null);
});

Deno.test("Pathfinding - findShortestPath with single node (same source and target)", () => {
  const graph = createTestGraph();
  const path = findShortestPath(graph, "A", "A");
  assertEquals(path, ["A"]);
});

Deno.test("Pathfinding - findShortestPath in empty graph", () => {
  const graph = new DirectedGraph();
  const path = findShortestPath(graph, "A", "B");
  assertEquals(path, null);
});

Deno.test("Pathfinding - findAllPaths finds all paths within max length", () => {
  const graph = createTestGraph();
  const paths = findAllPaths(graph, "A", "E", 3);

  // Should find both: A -> B -> E and A -> C -> E
  assertEquals(paths.length, 2);
  assertEquals(paths.some((p) => p.join(",") === "A,B,E"), true);
  assertEquals(paths.some((p) => p.join(",") === "A,C,E"), true);
});

Deno.test("Pathfinding - findAllPaths respects max length constraint", () => {
  const graph = createTestGraph();
  const paths = findAllPaths(graph, "A", "E", 1);

  // Should find no paths (shortest is 2 hops)
  assertEquals(paths.length, 0);
});

Deno.test("Pathfinding - findAllPaths with direct path", () => {
  const graph = createTestGraph();
  const paths = findAllPaths(graph, "A", "B", 3);

  assertEquals(paths.length, 1);
  assertEquals(paths[0], ["A", "B"]);
});

Deno.test("Pathfinding - findAllPaths handles cycles without infinite loop", () => {
  const graph = createCyclicGraph();
  const paths = findAllPaths(graph, "A", "C", 5);

  // Should find paths but not loop infinitely
  assertEquals(paths.length > 0, true);
  assertEquals(paths.every((p) => p.length <= 6), true); // maxLength + 1
});

Deno.test("Pathfinding - findAllPaths returns empty for non-existent nodes", () => {
  const graph = createTestGraph();
  const paths = findAllPaths(graph, "A", "Z", 3);
  assertEquals(paths.length, 0);
});

Deno.test("Pathfinding - findAllPaths returns empty for disconnected nodes", () => {
  const graph = createDisconnectedGraph();
  const paths = findAllPaths(graph, "A", "C", 5);
  assertEquals(paths.length, 0);
});

Deno.test("Pathfinding - calculatePathWeight with valid path", () => {
  const graph = createTestGraph();
  const path = ["A", "B", "D"];
  const weight = calculatePathWeight(graph, path);

  // A -> B (0.8) + B -> D (1.0) = 1.8
  assertEquals(weight, 1.8);
});

Deno.test("Pathfinding - calculatePathWeight with single node returns 0", () => {
  const graph = createTestGraph();
  const path = ["A"];
  const weight = calculatePathWeight(graph, path);
  assertEquals(weight, 0);
});

Deno.test("Pathfinding - calculatePathWeight with empty path returns 0", () => {
  const graph = createTestGraph();
  const path: string[] = [];
  const weight = calculatePathWeight(graph, path);
  assertEquals(weight, 0);
});

Deno.test("Pathfinding - calculatePathWeight sums all edges in path", () => {
  const graph = createTestGraph();
  const path = ["A", "C", "E"];
  const weight = calculatePathWeight(graph, path);

  // A -> C (0.5 sequence/inferred = 0.35) + C -> E (0.7 contains/inferred = 0.56)
  // Note: The edges are created with edge_type/edge_source, not just raw weight
  // So the actual weight depends on getEdgeWeight() calculation
  assertEquals(Math.round(weight * 100) / 100, 0.91);
});

Deno.test("Pathfinding - calculateAveragePathWeight with valid path", () => {
  const graph = createTestGraph();
  const path = ["A", "B", "D"];
  const avgWeight = calculateAveragePathWeight(graph, path);

  // Total weight: 1.8, edges: 2, average: 0.9
  assertEquals(avgWeight, 0.9);
});

Deno.test("Pathfinding - calculateAveragePathWeight with single node returns 0", () => {
  const graph = createTestGraph();
  const path = ["A"];
  const avgWeight = calculateAveragePathWeight(graph, path);
  assertEquals(avgWeight, 0);
});

Deno.test("Pathfinding - hasPathWithinHops returns true for path within limit", () => {
  const graph = createTestGraph();
  const hasPath = hasPathWithinHops(graph, "A", "D", 2);
  assertEquals(hasPath, true);
});

Deno.test("Pathfinding - hasPathWithinHops returns false for path exceeding limit", () => {
  const graph = createTestGraph();
  const hasPath = hasPathWithinHops(graph, "A", "D", 1);
  assertEquals(hasPath, false);
});

Deno.test("Pathfinding - hasPathWithinHops at exact boundary", () => {
  const graph = createTestGraph();
  const hasPath = hasPathWithinHops(graph, "A", "B", 1);
  assertEquals(hasPath, true);
});

Deno.test("Pathfinding - hasPathWithinHops returns false for disconnected nodes", () => {
  const graph = createDisconnectedGraph();
  const hasPath = hasPathWithinHops(graph, "A", "C", 10);
  assertEquals(hasPath, false);
});

Deno.test("Pathfinding - getPathLength with multi-hop path", () => {
  const path = ["A", "B", "C", "D"];
  const length = getPathLength(path);
  assertEquals(length, 3); // 3 edges
});

Deno.test("Pathfinding - getPathLength with direct path", () => {
  const path = ["A", "B"];
  const length = getPathLength(path);
  assertEquals(length, 1); // 1 edge
});

Deno.test("Pathfinding - getPathLength with single node", () => {
  const path = ["A"];
  const length = getPathLength(path);
  assertEquals(length, 0); // 0 edges
});

Deno.test("Pathfinding - getPathLength with null path", () => {
  const length = getPathLength(null);
  assertEquals(length, 0);
});

Deno.test("Pathfinding - getPathLength with empty path", () => {
  const path: string[] = [];
  const length = getPathLength(path);
  assertEquals(length, 0);
});
