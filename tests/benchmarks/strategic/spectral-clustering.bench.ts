/**
 * Spectral Clustering Benchmarks
 *
 * Benchmarks for Spectral Clustering on bipartite Tool-Capability graphs.
 * Tests different graph sizes and cluster configurations.
 *
 * Run: deno bench --allow-all tests/benchmarks/strategic/spectral-clustering.bench.ts
 *
 * @module tests/benchmarks/strategic/spectral-clustering
 */

import {
  type ClusterableCapability,
  SpectralClusteringManager,
} from "../../../src/graphrag/spectral-clustering.ts";
import { generateStressGraph, loadScenario } from "../fixtures/scenario-loader.ts";

// ============================================================================
// Setup
// ============================================================================

const smallScenario = await loadScenario("small-graph");
const mediumScenario = await loadScenario("medium-graph");

// Extract capabilities from scenarios
const smallCapabilities: ClusterableCapability[] = smallScenario.nodes.capabilities.map((c) => ({
  id: c.id,
  toolsUsed: c.toolsUsed,
}));

const mediumCapabilities: ClusterableCapability[] = mediumScenario.nodes.capabilities.map((c) => ({
  id: c.id,
  toolsUsed: c.toolsUsed,
}));

// Generate stress scenario
const stressScenario = generateStressGraph({
  toolCount: 200,
  capabilityCount: 30,
  metaCapabilityCount: 5,
  edgeDensity: 0.1,
  toolsPerCapability: { min: 4, max: 10 },
  capabilitiesPerMeta: { min: 4, max: 8 },
});

const stressCapabilities: ClusterableCapability[] = stressScenario.nodes.capabilities.map((c) => ({
  id: c.id,
  toolsUsed: c.toolsUsed,
}));

// Get tool nodes
const smallTools = smallScenario.nodes.tools.map((t) => t.id);
const mediumTools = mediumScenario.nodes.tools.map((t) => t.id);
const stressTools = stressScenario.nodes.tools.map((t) => t.id);

// Create clustering managers
function createManager(): SpectralClusteringManager {
  return new SpectralClusteringManager();
}

// ============================================================================
// Benchmarks: Full Clustering (Build + Assign)
// ============================================================================

Deno.bench({
  name: "Spectral: full clustering (small, 3 caps)",
  group: "spectral-full",
  baseline: true,
  fn: () => {
    const manager = createManager();
    manager.buildBipartiteMatrix(smallTools, smallCapabilities);
    manager.computeClusters(3);
  },
});

Deno.bench({
  name: "Spectral: full clustering (medium, 10 caps)",
  group: "spectral-full",
  fn: () => {
    const manager = createManager();
    manager.buildBipartiteMatrix(mediumTools, mediumCapabilities);
    manager.computeClusters(5);
  },
});

Deno.bench({
  name: "Spectral: full clustering (stress, 30 caps)",
  group: "spectral-full",
  fn: () => {
    const manager = createManager();
    manager.buildBipartiteMatrix(stressTools, stressCapabilities);
    manager.computeClusters(10);
  },
});

// ============================================================================
// Benchmarks: Graph Building Only
// ============================================================================

Deno.bench({
  name: "Spectral: build graph (small)",
  group: "spectral-build",
  baseline: true,
  fn: () => {
    const manager = createManager();
    manager.buildBipartiteMatrix(smallTools, smallCapabilities);
  },
});

Deno.bench({
  name: "Spectral: build graph (medium)",
  group: "spectral-build",
  fn: () => {
    const manager = createManager();
    manager.buildBipartiteMatrix(mediumTools, mediumCapabilities);
  },
});

Deno.bench({
  name: "Spectral: build graph (stress)",
  group: "spectral-build",
  fn: () => {
    const manager = createManager();
    manager.buildBipartiteMatrix(stressTools, stressCapabilities);
  },
});

// ============================================================================
// Benchmarks: Cluster Count Variations
// ============================================================================

Deno.bench({
  name: "Spectral: k=3 clusters",
  group: "spectral-k",
  baseline: true,
  fn: () => {
    const manager = createManager();
    manager.buildBipartiteMatrix(mediumTools, mediumCapabilities);
    manager.computeClusters(3);
  },
});

Deno.bench({
  name: "Spectral: k=5 clusters",
  group: "spectral-k",
  fn: () => {
    const manager = createManager();
    manager.buildBipartiteMatrix(mediumTools, mediumCapabilities);
    manager.computeClusters(5);
  },
});

Deno.bench({
  name: "Spectral: k=10 clusters",
  group: "spectral-k",
  fn: () => {
    const manager = createManager();
    manager.buildBipartiteMatrix(mediumTools, mediumCapabilities);
    manager.computeClusters(10);
  },
});

// ============================================================================
// Benchmarks: Cluster Boost Lookup
// ============================================================================

// Pre-compute clusters for lookup tests
const prebuiltManager = createManager();
prebuiltManager.buildBipartiteMatrix(mediumTools, mediumCapabilities);
prebuiltManager.computeClusters(5);

Deno.bench({
  name: "Spectral: get cluster boost (1 context tool)",
  group: "spectral-boost",
  baseline: true,
  fn: () => {
    const activeCluster = prebuiltManager.identifyActiveCluster([mediumTools[0]]);
    prebuiltManager.getClusterBoost(mediumCapabilities[0], activeCluster);
  },
});

Deno.bench({
  name: "Spectral: get cluster boost (5 context tools)",
  group: "spectral-boost",
  fn: () => {
    const activeCluster = prebuiltManager.identifyActiveCluster(mediumTools.slice(0, 5));
    prebuiltManager.getClusterBoost(mediumCapabilities[0], activeCluster);
  },
});

Deno.bench({
  name: "Spectral: get cluster boost (10 context tools)",
  group: "spectral-boost",
  fn: () => {
    const activeCluster = prebuiltManager.identifyActiveCluster(mediumTools.slice(0, 10));
    prebuiltManager.getClusterBoost(mediumCapabilities[0], activeCluster);
  },
});

// ============================================================================
// Benchmarks: PageRank on Hypergraph
// ============================================================================

Deno.bench({
  name: "Spectral: hypergraph PageRank (small)",
  group: "spectral-pagerank",
  baseline: true,
  fn: () => {
    const manager = createManager();
    manager.buildBipartiteMatrix(smallTools, smallCapabilities);
    manager.computeHypergraphPageRank(smallCapabilities);
  },
});

Deno.bench({
  name: "Spectral: hypergraph PageRank (medium)",
  group: "spectral-pagerank",
  fn: () => {
    const manager = createManager();
    manager.buildBipartiteMatrix(mediumTools, mediumCapabilities);
    manager.computeHypergraphPageRank(mediumCapabilities);
  },
});

Deno.bench({
  name: "Spectral: hypergraph PageRank (stress)",
  group: "spectral-pagerank",
  fn: () => {
    const manager = createManager();
    manager.buildBipartiteMatrix(stressTools, stressCapabilities);
    manager.computeHypergraphPageRank(stressCapabilities);
  },
});

// ============================================================================
// Benchmarks: Cache Effectiveness
// ============================================================================

Deno.bench({
  name: "Spectral: cache miss (fresh computation)",
  group: "spectral-cache",
  baseline: true,
  fn: () => {
    // Clear cache by creating new manager
    const manager = createManager();
    manager.buildBipartiteMatrix(mediumTools, mediumCapabilities);
    manager.computeClusters(5);
  },
});

// Note: Cache hit benchmark requires static cache, which persists between runs
// This tests the effect of caching on repeated calls
Deno.bench({
  name: "Spectral: cache hit (repeated call)",
  group: "spectral-cache",
  fn: () => {
    // Uses same manager, should hit cache
    const activeCluster = prebuiltManager.identifyActiveCluster(mediumTools.slice(0, 5));
    prebuiltManager.getClusterBoost(mediumCapabilities[0], activeCluster);
  },
});

// ============================================================================
// Cleanup
// ============================================================================

globalThis.addEventListener("unload", () => {
  console.log("\nSpectral Clustering Benchmark Summary:");
  console.log(`- Small: ${smallCapabilities.length} caps, ${smallTools.length} tools`);
  console.log(`- Medium: ${mediumCapabilities.length} caps, ${mediumTools.length} tools`);
  console.log(`- Stress: ${stressCapabilities.length} caps, ${stressTools.length} tools`);
});
