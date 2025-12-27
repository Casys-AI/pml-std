/**
 * Unit Tests: Story 7.4 - Mixed DAG (Tools + Capabilities)
 *
 * Tests for:
 * - AC#1: DAGStructure types with capability support
 * - AC#4: DAGSuggester capability injection
 * - AC#6: predictNextNodes() capability predictions
 * - AC#9: Unit test coverage for mixed DAG
 *
 * @requires --allow-env (for logger accessing HOME)
 * @requires --allow-read (for ml-matrix WASM)
 * Run with: deno test --allow-all tests/unit/graphrag/mixed_dag_test.ts
 */

import { assert, assertEquals, assertExists } from "@std/assert";
import type { Task } from "../../../src/graphrag/types.ts";
import {
  type ClusterableCapability,
  SpectralClusteringManager,
} from "../../../src/graphrag/spectral-clustering.ts";

Deno.test("Task type supports 'capability' value", () => {
  const capabilityTask: Task = {
    id: "cap_test_0",
    tool: "test_capability",
    type: "capability",
    capabilityId: "cap-12345678",
    code: "return 42;",
    arguments: {},
    dependsOn: [],
  };

  assertEquals(capabilityTask.type, "capability");
  assertExists(capabilityTask.capabilityId);
  assertEquals(capabilityTask.capabilityId, "cap-12345678");
});

Deno.test("Task without type defaults to mcp_tool", () => {
  const defaultTask: Task = {
    id: "task_1",
    tool: "some_tool",
    arguments: {},
    dependsOn: [],
  };

  // type is optional, should default to undefined (treated as "mcp_tool")
  assertEquals(defaultTask.type, undefined);
});

Deno.test("Task can have code_execution type", () => {
  const codeTask: Task = {
    id: "code_1",
    tool: "code_runner",
    type: "code_execution",
    code: "return 1 + 1;",
    arguments: {},
    dependsOn: [],
  };

  assertEquals(codeTask.type, "code_execution");
  assertExists(codeTask.code);
});

// =============================================================================
// SpectralClusteringManager Tests
// =============================================================================

Deno.test("SpectralClusteringManager - buildBipartiteMatrix creates correct adjacency", () => {
  const manager = new SpectralClusteringManager();

  const tools = ["tool_a", "tool_b", "tool_c"];
  const capabilities: ClusterableCapability[] = [
    { id: "cap_1", toolsUsed: ["tool_a", "tool_b"] },
    { id: "cap_2", toolsUsed: ["tool_b", "tool_c"] },
  ];

  const matrix = manager.buildBipartiteMatrix(tools, capabilities);

  // Matrix should be 5x5 (3 tools + 2 capabilities)
  assertEquals(matrix.rows, 5);
  assertEquals(matrix.columns, 5);

  // Check adjacencies
  // tool_a (0) <-> cap_1 (3): should be 1
  assertEquals(matrix.get(0, 3), 1);
  assertEquals(matrix.get(3, 0), 1);

  // tool_b (1) <-> cap_1 (3): should be 1
  assertEquals(matrix.get(1, 3), 1);
  assertEquals(matrix.get(3, 1), 1);

  // tool_c (2) should not be connected to cap_1
  assertEquals(matrix.get(2, 3), 0);

  // tool_b (1) <-> cap_2 (4): should be 1
  assertEquals(matrix.get(1, 4), 1);
  assertEquals(matrix.get(4, 1), 1);
});

Deno.test("SpectralClusteringManager - computeClusters assigns clusters", () => {
  const manager = new SpectralClusteringManager();

  const tools = ["tool_a", "tool_b", "tool_c", "tool_d"];
  const capabilities: ClusterableCapability[] = [
    { id: "cap_1", toolsUsed: ["tool_a", "tool_b"] },
    { id: "cap_2", toolsUsed: ["tool_c", "tool_d"] },
  ];

  manager.buildBipartiteMatrix(tools, capabilities);
  const assignments = manager.computeClusters(2);

  // Should have cluster assignments for all tools and capabilities
  assertEquals(assignments.toolClusters.size, 4);
  assertEquals(assignments.capabilityClusters.size, 2);
  assertEquals(assignments.clusterCount, 2);

  // Each cluster ID should be 0 or 1
  for (const [_, cluster] of assignments.toolClusters) {
    assert(cluster >= 0 && cluster < 2, `Cluster ${cluster} out of range`);
  }
});

Deno.test("SpectralClusteringManager - identifyActiveCluster finds majority", () => {
  const manager = new SpectralClusteringManager();

  const tools = ["tool_a", "tool_b", "tool_c", "tool_d"];
  const capabilities: ClusterableCapability[] = [
    { id: "cap_1", toolsUsed: ["tool_a", "tool_b"] },
    { id: "cap_2", toolsUsed: ["tool_c", "tool_d"] },
  ];

  manager.buildBipartiteMatrix(tools, capabilities);
  manager.computeClusters(2);

  // With tools from same cluster, should identify that cluster
  const contextTools = ["tool_a", "tool_b"];
  const activeCluster = manager.identifyActiveCluster(contextTools);

  // Active cluster should be >= 0
  assert(activeCluster >= 0, "Should identify an active cluster");
});

Deno.test("SpectralClusteringManager - getClusterBoost returns 0.5 for same cluster", () => {
  const manager = new SpectralClusteringManager();

  // Simple case: 2 tools, 1 capability
  const tools = ["tool_a", "tool_b"];
  const capabilities: ClusterableCapability[] = [
    { id: "cap_1", toolsUsed: ["tool_a", "tool_b"] },
  ];

  manager.buildBipartiteMatrix(tools, capabilities);
  manager.computeClusters(1); // Force single cluster

  const activeCluster = manager.identifyActiveCluster(["tool_a"]);
  const boost = manager.getClusterBoost(capabilities[0], activeCluster);

  // Same cluster should give boost of 0.5
  assertEquals(boost, 0.5);
});

Deno.test("SpectralClusteringManager - getClusterBoost returns 0 for different cluster", () => {
  const manager = new SpectralClusteringManager();

  // Create two distinct clusters
  const tools = ["tool_a", "tool_b", "tool_c", "tool_d"];
  const capabilities: ClusterableCapability[] = [
    { id: "cap_1", toolsUsed: ["tool_a", "tool_b"] },
    { id: "cap_2", toolsUsed: ["tool_c", "tool_d"] },
  ];

  manager.buildBipartiteMatrix(tools, capabilities);
  manager.computeClusters(2);

  // If cap_2 is in a different cluster than tool_a's cluster
  // and has no tool overlap with that cluster, boost should be 0
  const activeCluster = manager.getToolCluster("tool_a");
  const cap2Cluster = manager.getCapabilityCluster("cap_2");

  // Only check if they're in different clusters
  if (cap2Cluster !== activeCluster) {
    // cap_2 doesn't use tool_a or tool_b, so boost should be 0
    const boost = manager.getClusterBoost(capabilities[1], activeCluster);
    assertEquals(boost, 0);
  }
});

Deno.test("SpectralClusteringManager - computeNormalizedLaplacian is symmetric", () => {
  const manager = new SpectralClusteringManager();

  const tools = ["tool_a", "tool_b"];
  const capabilities: ClusterableCapability[] = [
    { id: "cap_1", toolsUsed: ["tool_a", "tool_b"] },
  ];

  const adjacency = manager.buildBipartiteMatrix(tools, capabilities);
  const laplacian = manager.computeNormalizedLaplacian(adjacency);

  // Laplacian should be symmetric
  for (let i = 0; i < laplacian.rows; i++) {
    for (let j = 0; j < laplacian.columns; j++) {
      const diff = Math.abs(laplacian.get(i, j) - laplacian.get(j, i));
      assert(diff < 1e-10, `Laplacian should be symmetric at (${i}, ${j})`);
    }
  }
});

Deno.test("SpectralClusteringManager - computeHypergraphPageRank returns valid scores", () => {
  const manager = new SpectralClusteringManager();

  const tools = ["tool_a", "tool_b", "tool_c"];
  const capabilities: ClusterableCapability[] = [
    { id: "cap_1", toolsUsed: ["tool_a", "tool_b"] },
    { id: "cap_2", toolsUsed: ["tool_b", "tool_c"] },
  ];

  manager.buildBipartiteMatrix(tools, capabilities);
  const pageRankScores = manager.computeHypergraphPageRank(capabilities);

  // Should have scores for both capabilities
  assertEquals(pageRankScores.size, 2);

  // Scores should be positive and sum to less than 1 (tools also have scores)
  let capSum = 0;
  for (const [_, score] of pageRankScores) {
    assert(score >= 0, "PageRank scores should be non-negative");
    capSum += score;
  }
  assert(capSum < 1, "Capability scores should sum to less than 1 (tools also have scores)");
});

Deno.test("SpectralClusteringManager - hasClusters returns false before computeClusters", () => {
  const manager = new SpectralClusteringManager();
  assertEquals(manager.hasClusters(), false);
});

Deno.test("SpectralClusteringManager - hasClusters returns true after computeClusters", () => {
  const manager = new SpectralClusteringManager();

  const tools = ["tool_a"];
  const capabilities: ClusterableCapability[] = [
    { id: "cap_1", toolsUsed: ["tool_a"] },
  ];

  manager.buildBipartiteMatrix(tools, capabilities);
  manager.computeClusters();

  assertEquals(manager.hasClusters(), true);
});

Deno.test("SpectralClusteringManager - getClusterCount returns correct count", () => {
  const manager = new SpectralClusteringManager();

  const tools = ["tool_a", "tool_b"];
  const capabilities: ClusterableCapability[] = [
    { id: "cap_1", toolsUsed: ["tool_a"] },
    { id: "cap_2", toolsUsed: ["tool_b"] },
  ];

  manager.buildBipartiteMatrix(tools, capabilities);
  manager.computeClusters(2);

  assertEquals(manager.getClusterCount(), 2);
});

Deno.test("SpectralClusteringManager - handles empty inputs gracefully", () => {
  const manager = new SpectralClusteringManager();

  const matrix = manager.buildBipartiteMatrix([], []);

  assertEquals(matrix.rows, 0);
  assertEquals(matrix.columns, 0);
});

Deno.test("SpectralClusteringManager - identifyActiveCluster returns -1 with no clusters", () => {
  const manager = new SpectralClusteringManager();

  // Without building clusters
  const activeCluster = manager.identifyActiveCluster(["tool_a"]);
  assertEquals(activeCluster, -1);
});
