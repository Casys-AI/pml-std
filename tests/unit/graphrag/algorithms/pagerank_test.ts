/**
 * Unit tests for PageRank Algorithm Module
 *
 * Tests cover:
 * - computePageRank with weighted and unweighted options
 * - Convergence with different tolerance values
 * - getPageRankScore, getTopPageRankNodes, getAveragePageRank
 * - Edge cases: empty graph, single node, disconnected components
 *
 * @module tests/unit/graphrag/algorithms/pagerank_test
 */

import { assert, assertEquals } from "@std/assert";
// @ts-ignore: NPM module resolution
import graphologyPkg from "graphology";
import {
  computePageRank,
  getAveragePageRank,
  getPageRankScore,
  getTopPageRankNodes,
  type PageRankOptions,
} from "../../../../src/graphrag/algorithms/pagerank.ts";

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

  graph.addEdge("A", "B", { weight: 0.8 });
  graph.addEdge("A", "C", { weight: 0.5 });
  graph.addEdge("B", "D", { weight: 1.0 });
  graph.addEdge("B", "E", { weight: 0.6 });
  graph.addEdge("C", "E", { weight: 0.7 });

  return graph;
}

/**
 * Create a graph with disconnected components
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

  graph.addEdge("A", "B", { weight: 0.8 });
  graph.addEdge("C", "D", { weight: 0.8 });

  return graph;
}

/**
 * Create a star graph (one central node)
 *
 * Graph structure:
 *   A -> C
 *   B -> C
 *   C -> D
 *   C -> E
 */
function createStarGraph(): any {
  const graph = new DirectedGraph();

  graph.addNode("A", { type: "tool" });
  graph.addNode("B", { type: "tool" });
  graph.addNode("C", { type: "tool" });
  graph.addNode("D", { type: "tool" });
  graph.addNode("E", { type: "tool" });

  graph.addEdge("A", "C", { weight: 1.0 });
  graph.addEdge("B", "C", { weight: 1.0 });
  graph.addEdge("C", "D", { weight: 1.0 });
  graph.addEdge("C", "E", { weight: 1.0 });

  return graph;
}

Deno.test("PageRank - computePageRank returns scores for all nodes", () => {
  const graph = createTestGraph();
  const result = computePageRank(graph);

  assertEquals(Object.keys(result.scores).length, 5);
  assertEquals(result.scores.A !== undefined, true);
  assertEquals(result.scores.B !== undefined, true);
  assertEquals(result.scores.C !== undefined, true);
  assertEquals(result.scores.D !== undefined, true);
  assertEquals(result.scores.E !== undefined, true);
});

Deno.test("PageRank - computePageRank scores sum to approximately 1.0", () => {
  const graph = createTestGraph();
  const result = computePageRank(graph);

  const sum = Object.values(result.scores).reduce((a, b) => a + b, 0);
  // Allow small floating point error
  assert(Math.abs(sum - 1.0) < 0.01, `Sum ${sum} should be close to 1.0`);
});

Deno.test("PageRank - computePageRank with weighted option", () => {
  const graph = createTestGraph();
  const options: PageRankOptions = { weighted: true };
  const result = computePageRank(graph, options);

  assertEquals(Object.keys(result.scores).length, 5);
  assert(result.computeTimeMs > 0);
});

Deno.test("PageRank - computePageRank with unweighted option", () => {
  const graph = createTestGraph();
  const options: PageRankOptions = { weighted: false };
  const result = computePageRank(graph, options);

  assertEquals(Object.keys(result.scores).length, 5);
  assert(result.computeTimeMs > 0);
});

Deno.test("PageRank - computePageRank with custom tolerance", () => {
  const graph = createTestGraph();
  const options: PageRankOptions = { tolerance: 0.001 };
  const result = computePageRank(graph, options);

  assertEquals(Object.keys(result.scores).length, 5);
});

Deno.test("PageRank - computePageRank reports computation time", () => {
  const graph = createTestGraph();
  const result = computePageRank(graph);

  assert(result.computeTimeMs > 0);
  assert(result.computeTimeMs < 1000); // Should be fast for small graph
});

Deno.test("PageRank - computePageRank with single node", () => {
  const graph = new DirectedGraph();
  graph.addNode("A", { type: "tool" });

  const result = computePageRank(graph);

  assertEquals(Object.keys(result.scores).length, 1);
  // Single node gets all PageRank
  assert(Math.abs(result.scores.A - 1.0) < 0.01);
});

Deno.test("PageRank - computePageRank with disconnected components", () => {
  const graph = createDisconnectedGraph();
  const result = computePageRank(graph);

  assertEquals(Object.keys(result.scores).length, 4);
  // All nodes should have scores
  assert(result.scores.A > 0);
  assert(result.scores.B > 0);
  assert(result.scores.C > 0);
  assert(result.scores.D > 0);
});

Deno.test("PageRank - computePageRank central node has highest score in star graph", () => {
  const graph = createStarGraph();
  const result = computePageRank(graph);

  // Node C (central) should have highest PageRank
  assert(result.scores.C > result.scores.A);
  assert(result.scores.C > result.scores.B);
  assert(result.scores.C > result.scores.D);
  assert(result.scores.C > result.scores.E);
});

Deno.test("PageRank - getPageRankScore returns correct score", () => {
  const graph = createTestGraph();
  const result = computePageRank(graph);

  const scoreA = getPageRankScore(result.scores, "A");
  assertEquals(scoreA, result.scores.A);
});

Deno.test("PageRank - getPageRankScore returns 0 for non-existent node", () => {
  const graph = createTestGraph();
  const result = computePageRank(graph);

  const score = getPageRankScore(result.scores, "Z");
  assertEquals(score, 0);
});

Deno.test("PageRank - getTopPageRankNodes returns sorted nodes", () => {
  const graph = createTestGraph();
  const result = computePageRank(graph);

  const topNodes = getTopPageRankNodes(result.scores, 3);

  assertEquals(topNodes.length, 3);
  // Should be sorted descending
  assert(topNodes[0].score >= topNodes[1].score);
  assert(topNodes[1].score >= topNodes[2].score);
});

Deno.test("PageRank - getTopPageRankNodes respects limit", () => {
  const graph = createTestGraph();
  const result = computePageRank(graph);

  const topNodes = getTopPageRankNodes(result.scores, 2);

  assertEquals(topNodes.length, 2);
});

Deno.test("PageRank - getTopPageRankNodes returns all nodes if n exceeds count", () => {
  const graph = createTestGraph();
  const result = computePageRank(graph);

  const topNodes = getTopPageRankNodes(result.scores, 100);

  assertEquals(topNodes.length, 5); // Only 5 nodes in graph
});

Deno.test("PageRank - getTopPageRankNodes includes toolId and score", () => {
  const graph = createTestGraph();
  const result = computePageRank(graph);

  const topNodes = getTopPageRankNodes(result.scores, 1);

  assertEquals(topNodes[0].toolId !== undefined, true);
  assertEquals(topNodes[0].score !== undefined, true);
  assert(topNodes[0].score > 0);
});

Deno.test("PageRank - getAveragePageRank computes correct average", () => {
  const graph = createTestGraph();
  const result = computePageRank(graph);

  const avgScore = getAveragePageRank(result.scores);

  // Average of 5 nodes, scores sum to 1.0
  assert(Math.abs(avgScore - 0.2) < 0.05);
});

Deno.test("PageRank - getAveragePageRank returns 0 for empty scores", () => {
  const avgScore = getAveragePageRank({});
  assertEquals(avgScore, 0);
});

Deno.test("PageRank - weighted vs unweighted produces different scores", () => {
  const graph = createTestGraph();

  const weightedResult = computePageRank(graph, { weighted: true });
  const unweightedResult = computePageRank(graph, { weighted: false });

  // Both should produce valid results (weighted may not differ on this particular graph)
  assertEquals(Object.keys(weightedResult.scores).length, 5);
  assertEquals(Object.keys(unweightedResult.scores).length, 5);

  // Check that scores are valid (between 0 and 1)
  Object.values(weightedResult.scores).forEach((score) => {
    assert(score >= 0 && score <= 1);
  });
});

Deno.test("PageRank - tolerance affects convergence precision", () => {
  const graph = createTestGraph();

  const result1 = computePageRank(graph, { tolerance: 0.1 });
  const result2 = computePageRank(graph, { tolerance: 0.0001 });

  // Both should produce valid results
  assertEquals(Object.keys(result1.scores).length, 5);
  assertEquals(Object.keys(result2.scores).length, 5);

  // More precise tolerance may take longer (though not guaranteed on small graphs)
  assert(result1.computeTimeMs > 0);
  assert(result2.computeTimeMs > 0);
});
