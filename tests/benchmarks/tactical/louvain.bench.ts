/**
 * Louvain Community Detection Benchmarks
 *
 * Benchmarks for Louvain community detection algorithm.
 * Tests different graph sizes and resolution parameters.
 *
 * Run: deno bench --allow-all tests/benchmarks/tactical/louvain.bench.ts
 *
 * @module tests/benchmarks/tactical/louvain
 */

import { detectCommunities } from "../../../src/graphrag/algorithms/louvain.ts";
import {
  buildGraphFromScenario,
  generateStressGraph,
  loadScenario,
} from "../fixtures/scenario-loader.ts";

// Pre-load scenarios
const smallScenario = await loadScenario("small-graph");
const mediumScenario = await loadScenario("medium-graph");

const smallGraph = buildGraphFromScenario(smallScenario);
const mediumGraph = buildGraphFromScenario(mediumScenario);

// Generate stress graphs of varying density
const sparseStress = generateStressGraph({
  toolCount: 200,
  capabilityCount: 30,
  metaCapabilityCount: 5,
  edgeDensity: 0.05,
  toolsPerCapability: { min: 4, max: 10 },
  capabilitiesPerMeta: { min: 4, max: 8 },
});
const sparseGraph = buildGraphFromScenario(sparseStress);

const denseStress = generateStressGraph({
  toolCount: 200,
  capabilityCount: 30,
  metaCapabilityCount: 5,
  edgeDensity: 0.2,
  toolsPerCapability: { min: 4, max: 10 },
  capabilitiesPerMeta: { min: 4, max: 8 },
});
const denseGraph = buildGraphFromScenario(denseStress);

// ============================================================================
// Benchmarks: Graph Size Scaling
// ============================================================================

Deno.bench({
  name: "Louvain: small graph (10 nodes)",
  group: "louvain-size",
  baseline: true,
  fn: () => {
    detectCommunities(smallGraph);
  },
});

Deno.bench({
  name: "Louvain: medium graph (50 nodes)",
  group: "louvain-size",
  fn: () => {
    detectCommunities(mediumGraph);
  },
});

Deno.bench({
  name: "Louvain: stress graph sparse (200 nodes, 5% density)",
  group: "louvain-size",
  fn: () => {
    detectCommunities(sparseGraph);
  },
});

Deno.bench({
  name: "Louvain: stress graph dense (200 nodes, 20% density)",
  group: "louvain-size",
  fn: () => {
    detectCommunities(denseGraph);
  },
});

// ============================================================================
// Benchmarks: Resolution Parameter
// ============================================================================

Deno.bench({
  name: "Louvain: resolution=1.0 (default)",
  group: "louvain-resolution",
  baseline: true,
  fn: () => {
    detectCommunities(mediumGraph, { resolution: 1.0 });
  },
});

Deno.bench({
  name: "Louvain: resolution=0.5 (fewer communities)",
  group: "louvain-resolution",
  fn: () => {
    detectCommunities(mediumGraph, { resolution: 0.5 });
  },
});

Deno.bench({
  name: "Louvain: resolution=2.0 (more communities)",
  group: "louvain-resolution",
  fn: () => {
    detectCommunities(mediumGraph, { resolution: 2.0 });
  },
});

// ============================================================================
// Cleanup
// ============================================================================

globalThis.addEventListener("unload", () => {
  console.log("\nLouvain Benchmark Summary:");
  console.log(`- Small graph: ${smallGraph.order} nodes, ${smallGraph.size} edges`);
  console.log(`- Medium graph: ${mediumGraph.order} nodes, ${mediumGraph.size} edges`);
  console.log(`- Sparse stress: ${sparseGraph.order} nodes, ${sparseGraph.size} edges`);
  console.log(`- Dense stress: ${denseGraph.order} nodes, ${denseGraph.size} edges`);
});
