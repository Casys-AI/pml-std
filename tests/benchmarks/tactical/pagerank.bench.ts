/**
 * PageRank Algorithm Benchmarks
 *
 * Benchmarks for PageRank centrality computation.
 * Tests different graph sizes and convergence parameters.
 *
 * Run: deno bench --allow-all tests/benchmarks/tactical/pagerank.bench.ts
 *
 * @module tests/benchmarks/tactical/pagerank
 */

import { computePageRank } from "../../../src/graphrag/algorithms/pagerank.ts";
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

// Generate stress graph
const stressScenario = generateStressGraph({
  toolCount: 200,
  capabilityCount: 30,
  metaCapabilityCount: 5,
  edgeDensity: 0.1,
  toolsPerCapability: { min: 4, max: 10 },
  capabilitiesPerMeta: { min: 4, max: 8 },
});
const stressGraph = buildGraphFromScenario(stressScenario);

// ============================================================================
// Benchmarks: Small Graph
// ============================================================================

Deno.bench({
  name: "PageRank: small graph (10 nodes), default params",
  group: "pagerank-size",
  baseline: true,
  fn: () => {
    computePageRank(smallGraph);
  },
});

Deno.bench({
  name: "PageRank: small graph (10 nodes), high precision",
  group: "pagerank-size",
  fn: () => {
    computePageRank(smallGraph, { tolerance: 1e-8 });
  },
});

// ============================================================================
// Benchmarks: Medium Graph
// ============================================================================

Deno.bench({
  name: "PageRank: medium graph (50 nodes), default params",
  group: "pagerank-size",
  fn: () => {
    computePageRank(mediumGraph);
  },
});

Deno.bench({
  name: "PageRank: medium graph (50 nodes), high precision",
  group: "pagerank-size",
  fn: () => {
    computePageRank(mediumGraph, { tolerance: 1e-8 });
  },
});

// ============================================================================
// Benchmarks: Stress Graph
// ============================================================================

Deno.bench({
  name: "PageRank: stress graph (200 nodes), default params",
  group: "pagerank-size",
  fn: () => {
    computePageRank(stressGraph);
  },
});

Deno.bench({
  name: "PageRank: stress graph (200 nodes), fast convergence",
  group: "pagerank-size",
  fn: () => {
    computePageRank(stressGraph, { tolerance: 1e-4 });
  },
});

// ============================================================================
// Benchmarks: Weighted vs Unweighted
// ============================================================================

Deno.bench({
  name: "PageRank: weighted edges",
  group: "pagerank-weighted",
  baseline: true,
  fn: () => {
    computePageRank(mediumGraph, { weighted: true });
  },
});

Deno.bench({
  name: "PageRank: unweighted edges",
  group: "pagerank-weighted",
  fn: () => {
    computePageRank(mediumGraph, { weighted: false });
  },
});

// ============================================================================
// Cleanup
// ============================================================================

globalThis.addEventListener("unload", () => {
  console.log("\nPageRank Benchmark Summary:");
  console.log(`- Small graph: ${smallGraph.order} nodes, ${smallGraph.size} edges`);
  console.log(`- Medium graph: ${mediumGraph.order} nodes, ${mediumGraph.size} edges`);
  console.log(`- Stress graph: ${stressGraph.order} nodes, ${stressGraph.size} edges`);
});
