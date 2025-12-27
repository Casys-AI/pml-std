/**
 * DR-DSP (Directed Relationship Dynamic Shortest Path) Benchmarks
 *
 * Benchmarks for the DR-DSP hypergraph shortest path algorithm.
 * Compares performance against Dijkstra for capability-aware pathfinding.
 *
 * See spike: 2025-12-21-capability-pathfinding-dijkstra.md
 *
 * Run: deno bench --allow-all tests/benchmarks/pathfinding/dr-dsp.bench.ts
 *
 * @module tests/benchmarks/pathfinding/dr-dsp
 */

import { findShortestPath } from "../../../src/graphrag/algorithms/pathfinding.ts";
import {
  buildDRDSPFromCapabilities,
  DRDSP,
  type Hyperedge,
} from "../../../src/graphrag/algorithms/dr-dsp.ts";
import {
  buildGraphFromScenario,
  type CapabilityNode,
  generateStressGraph,
  loadScenario,
} from "../fixtures/scenario-loader.ts";

// ============================================================================
// Setup
// ============================================================================

const mediumScenario = await loadScenario("medium-graph");
const mediumGraph = buildGraphFromScenario(mediumScenario);

// Generate stress scenario with many capabilities (hyperedges)
const stressScenario = generateStressGraph({
  toolCount: 200,
  capabilityCount: 50,
  metaCapabilityCount: 10,
  edgeDensity: 0.1,
  toolsPerCapability: { min: 4, max: 10 },
  capabilitiesPerMeta: { min: 4, max: 8 },
});
const stressGraph = buildGraphFromScenario(stressScenario);

// Get tool nodes for testing
const mediumTools = Array.from(mediumGraph.nodes()).filter((n) =>
  mediumGraph.getNodeAttribute(n, "type") === "tool"
);
const stressTools = Array.from(stressGraph.nodes()).filter((n) =>
  stressGraph.getNodeAttribute(n, "type") === "tool"
);

// Build DR-DSP instances from capabilities
const mediumDRDSP = buildDRDSPFromCapabilities(
  mediumScenario.nodes.capabilities.map((c) => ({
    id: c.id,
    toolsUsed: c.toolsUsed,
    successRate: c.successRate,
  })),
);

const stressDRDSP = buildDRDSPFromCapabilities(
  stressScenario.nodes.capabilities.map((c) => ({
    id: c.id,
    toolsUsed: c.toolsUsed,
    successRate: c.successRate,
  })),
);

// ============================================================================
// Benchmarks: DR-DSP vs Dijkstra (Single Pair)
// ============================================================================

Deno.bench({
  name: "Dijkstra: baseline single pair (medium)",
  group: "drdsp-vs-dijkstra",
  baseline: true,
  fn: () => {
    if (mediumTools.length >= 2) {
      findShortestPath(mediumGraph, mediumTools[0], mediumTools[10] || mediumTools[1]);
    }
  },
});

Deno.bench({
  name: "DR-DSP: single hyperpath (medium)",
  group: "drdsp-vs-dijkstra",
  fn: () => {
    if (mediumTools.length >= 2) {
      mediumDRDSP.findShortestHyperpath(mediumTools[0], mediumTools[10] || mediumTools[1]);
    }
  },
});

// ============================================================================
// Benchmarks: Stress Graph Comparison
// ============================================================================

Deno.bench({
  name: "Dijkstra: stress single pair",
  group: "drdsp-stress",
  baseline: true,
  fn: () => {
    if (stressTools.length >= 2) {
      findShortestPath(stressGraph, stressTools[0], stressTools[50] || stressTools[1]);
    }
  },
});

Deno.bench({
  name: "DR-DSP: stress hyperpath",
  group: "drdsp-stress",
  fn: () => {
    if (stressTools.length >= 2) {
      stressDRDSP.findShortestHyperpath(stressTools[0], stressTools[50] || stressTools[1]);
    }
  },
});

// ============================================================================
// Benchmarks: N×N Hyperpath (Full DAG Building)
// ============================================================================

Deno.bench({
  name: "Dijkstra: N×N (10 nodes, medium)",
  group: "drdsp-nxn",
  baseline: true,
  fn: () => {
    const nodes = mediumTools.slice(0, 10);
    for (const from of nodes) {
      for (const to of nodes) {
        if (from !== to) {
          findShortestPath(mediumGraph, from, to);
        }
      }
    }
  },
});

Deno.bench({
  name: "DR-DSP: N×N hyperpaths (10 nodes)",
  group: "drdsp-nxn",
  fn: () => {
    const nodes = mediumTools.slice(0, 10);
    for (const from of nodes) {
      for (const to of nodes) {
        if (from !== to) {
          mediumDRDSP.findShortestHyperpath(from, to);
        }
      }
    }
  },
});

// ============================================================================
// Benchmarks: DR-DSP SSSP (Single Source Shortest Path)
// ============================================================================

Deno.bench({
  name: "DR-DSP: SSSP from single source (medium)",
  group: "drdsp-sssp",
  baseline: true,
  fn: () => {
    if (mediumTools.length >= 1) {
      mediumDRDSP.findAllShortestPaths(mediumTools[0]);
    }
  },
});

Deno.bench({
  name: "DR-DSP: SSSP from single source (stress)",
  group: "drdsp-sssp",
  fn: () => {
    if (stressTools.length >= 1) {
      stressDRDSP.findAllShortestPaths(stressTools[0]);
    }
  },
});

// ============================================================================
// Benchmarks: Dynamic Updates
// ============================================================================

Deno.bench({
  name: "Dijkstra: recompute after edge change (must recalc)",
  group: "drdsp-dynamic",
  baseline: true,
  fn: () => {
    // Dijkstra must recompute from scratch
    if (mediumTools.length >= 2) {
      findShortestPath(mediumGraph, mediumTools[0], mediumTools[10] || mediumTools[1]);
    }
  },
});

Deno.bench({
  name: "DR-DSP: apply update + recompute",
  group: "drdsp-dynamic",
  fn: () => {
    if (mediumTools.length >= 2) {
      // Apply a weight update
      mediumDRDSP.applyUpdate({
        type: "weight_decrease",
        hyperedgeId: mediumScenario.nodes.capabilities[0]?.id || "cap_0",
        newWeight: 0.5,
      });
      // Recompute path
      mediumDRDSP.findShortestHyperpath(mediumTools[0], mediumTools[10] || mediumTools[1]);
    }
  },
});

// ============================================================================
// Benchmarks: Hyperedge Density
// ============================================================================

// Create DR-DSP with different hyperedge counts
const sparseHyperedges: Hyperedge[] = mediumScenario.nodes.capabilities.slice(0, 3).map((c) => ({
  id: c.id,
  sources: c.toolsUsed.slice(0, 2),
  targets: c.toolsUsed.slice(2),
  weight: 1 / c.successRate,
}));
const sparseDRDSP = new DRDSP(sparseHyperedges);

const denseHyperedges: Hyperedge[] = stressScenario.nodes.capabilities.map((c) => ({
  id: c.id,
  sources: c.toolsUsed.slice(0, Math.ceil(c.toolsUsed.length / 2)),
  targets: c.toolsUsed.slice(Math.ceil(c.toolsUsed.length / 2)),
  weight: 1 / c.successRate,
}));
const denseDRDSP = new DRDSP(denseHyperedges);

Deno.bench({
  name: "DR-DSP: sparse hyperedges (3)",
  group: "drdsp-density",
  baseline: true,
  fn: () => {
    if (mediumTools.length >= 2) {
      sparseDRDSP.findShortestHyperpath(mediumTools[0], mediumTools[5] || mediumTools[1]);
    }
  },
});

Deno.bench({
  name: "DR-DSP: dense hyperedges (50)",
  group: "drdsp-density",
  fn: () => {
    if (stressTools.length >= 2) {
      denseDRDSP.findShortestHyperpath(stressTools[0], stressTools[20] || stressTools[1]);
    }
  },
});

// ============================================================================
// Benchmarks: Graph Statistics
// ============================================================================

Deno.bench({
  name: "DR-DSP: get stats (medium)",
  group: "drdsp-stats",
  baseline: true,
  fn: () => {
    mediumDRDSP.getStats();
  },
});

Deno.bench({
  name: "DR-DSP: get stats (stress)",
  group: "drdsp-stats",
  fn: () => {
    stressDRDSP.getStats();
  },
});

// ============================================================================
// Cleanup
// ============================================================================

globalThis.addEventListener("unload", () => {
  const mediumStats = mediumDRDSP.getStats();
  const stressStats = stressDRDSP.getStats();

  console.log("\nDR-DSP Benchmark Summary:");
  console.log(
    `- Medium graph: ${mediumStats.hyperedgeCount} hyperedges, ${mediumStats.nodeCount} nodes`,
  );
  console.log(
    `- Stress graph: ${stressStats.hyperedgeCount} hyperedges, ${stressStats.nodeCount} nodes`,
  );
  console.log(
    `- Avg hyperedge size: ${mediumStats.avgHyperedgeSize.toFixed(1)} (medium), ${
      stressStats.avgHyperedgeSize.toFixed(1)
    } (stress)`,
  );
});
