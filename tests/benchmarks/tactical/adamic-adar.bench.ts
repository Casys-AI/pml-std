/**
 * Adamic-Adar Similarity Benchmarks
 *
 * Benchmarks for Adamic-Adar similarity computation.
 * Tests pairwise and batch similarity calculations.
 *
 * NOTE (ADR-050): Adamic-Adar is NO LONGER used in Search mode (no context).
 * It is only relevant for Prediction mode where context nodes are available.
 * In Search mode, the formula is now: score = semantic × reliability
 *
 * See:
 * - ADR-050: Unified Search Simplification
 * - shgat-drdsp-prediction.bench.ts for Prediction benchmarks
 *
 * Run: deno bench --allow-all tests/benchmarks/tactical/adamic-adar.bench.ts
 *
 * @module tests/benchmarks/tactical/adamic-adar
 */

import {
  adamicAdarBetween,
  computeAdamicAdar,
  computeGraphRelatedness,
  findSimilarNodes,
} from "../../../src/graphrag/algorithms/adamic-adar.ts";
import {
  buildGraphFromScenario,
  generateStressGraph,
  loadScenario,
} from "../fixtures/scenario-loader.ts";

// ============================================================================
// Setup
// ============================================================================

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

// Get some node IDs for pairwise tests
const smallNodes = Array.from(smallGraph.nodes()).slice(0, 5);
const mediumNodes = Array.from(mediumGraph.nodes()).slice(0, 10);
const stressNodes = Array.from(stressGraph.nodes()).slice(0, 20);

// ============================================================================
// Benchmarks: Pairwise Similarity
// ============================================================================

Deno.bench({
  name: "Adamic-Adar: single pair (small graph)",
  group: "aa-pairwise",
  baseline: true,
  fn: () => {
    if (smallNodes.length >= 2) {
      adamicAdarBetween(smallGraph, smallNodes[0], smallNodes[1]);
    }
  },
});

Deno.bench({
  name: "Adamic-Adar: single pair (medium graph)",
  group: "aa-pairwise",
  fn: () => {
    if (mediumNodes.length >= 2) {
      adamicAdarBetween(mediumGraph, mediumNodes[0], mediumNodes[1]);
    }
  },
});

Deno.bench({
  name: "Adamic-Adar: single pair (stress graph)",
  group: "aa-pairwise",
  fn: () => {
    if (stressNodes.length >= 2) {
      adamicAdarBetween(stressGraph, stressNodes[0], stressNodes[1]);
    }
  },
});

// ============================================================================
// Benchmarks: Full Graph Computation
// ============================================================================

Deno.bench({
  name: "Adamic-Adar: full computation (small graph)",
  group: "aa-full",
  baseline: true,
  fn: () => {
    computeAdamicAdar(smallGraph);
  },
});

Deno.bench({
  name: "Adamic-Adar: full computation (medium graph)",
  group: "aa-full",
  fn: () => {
    computeAdamicAdar(mediumGraph);
  },
});

// Note: Full AA computation on stress graph is O(n^2) - very slow
// Only run if explicitly needed
Deno.bench({
  name: "Adamic-Adar: full computation (stress graph) [SLOW]",
  group: "aa-full",
  ignore: true, // Enable manually when needed
  fn: () => {
    computeAdamicAdar(stressGraph);
  },
});

// ============================================================================
// Benchmarks: Find Similar Nodes
// ============================================================================

Deno.bench({
  name: "Adamic-Adar: find similar (small, top 3)",
  group: "aa-similar",
  baseline: true,
  fn: () => {
    if (smallNodes.length >= 1) {
      findSimilarNodes(smallGraph, smallNodes[0], 3);
    }
  },
});

Deno.bench({
  name: "Adamic-Adar: find similar (medium, top 5)",
  group: "aa-similar",
  fn: () => {
    if (mediumNodes.length >= 1) {
      findSimilarNodes(mediumGraph, mediumNodes[0], 5);
    }
  },
});

Deno.bench({
  name: "Adamic-Adar: find similar (medium, top 10)",
  group: "aa-similar",
  fn: () => {
    if (mediumNodes.length >= 1) {
      findSimilarNodes(mediumGraph, mediumNodes[0], 10);
    }
  },
});

Deno.bench({
  name: "Adamic-Adar: find similar (stress, top 10)",
  group: "aa-similar",
  fn: () => {
    if (stressNodes.length >= 1) {
      findSimilarNodes(stressGraph, stressNodes[0], 10);
    }
  },
});

// ============================================================================
// Benchmarks: Graph Relatedness (Context-aware)
// ============================================================================

Deno.bench({
  name: "Adamic-Adar: graph relatedness (small, 2 context tools)",
  group: "aa-relatedness",
  baseline: true,
  fn: () => {
    const context = smallNodes.slice(0, 2);
    const target = smallNodes[2] || smallNodes[0];
    computeGraphRelatedness(smallGraph, target, context);
  },
});

Deno.bench({
  name: "Adamic-Adar: graph relatedness (medium, 5 context tools)",
  group: "aa-relatedness",
  fn: () => {
    const context = mediumNodes.slice(0, 5);
    const target = mediumNodes[5] || mediumNodes[0];
    computeGraphRelatedness(mediumGraph, target, context);
  },
});

Deno.bench({
  name: "Adamic-Adar: graph relatedness (stress, 10 context tools)",
  group: "aa-relatedness",
  fn: () => {
    const context = stressNodes.slice(0, 10);
    const target = stressNodes[10] || stressNodes[0];
    computeGraphRelatedness(stressGraph, target, context);
  },
});

// ============================================================================
// Cleanup
// ============================================================================

globalThis.addEventListener("unload", () => {
  console.log("\nAdamic-Adar Benchmark Summary:");
  console.log(`- Small graph: ${smallGraph.order} nodes, ${smallGraph.size} edges`);
  console.log(`- Medium graph: ${mediumGraph.order} nodes, ${mediumGraph.size} edges`);
  console.log(`- Stress graph: ${stressGraph.order} nodes, ${stressGraph.size} edges`);
});
