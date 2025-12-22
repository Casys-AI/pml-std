/**
 * SHGAT (SuperHyperGraph Attention Networks) Benchmarks
 *
 * Benchmarks for the SHGAT learned attention algorithm.
 * Tests inference, training, and comparison with static scoring.
 *
 * See spike: 2025-12-17-superhypergraph-hierarchical-structures.md
 *
 * Run: deno bench --allow-all tests/benchmarks/strategic/shgat.bench.ts
 *
 * @module tests/benchmarks/strategic/shgat
 */

import {
  SHGAT,
  createSHGATFromCapabilities,
  trainSHGATOnEpisodes,
  type TrainingExample,
} from "../../../src/graphrag/algorithms/shgat.ts";
import { SpectralClusteringManager } from "../../../src/graphrag/spectral-clustering.ts";
import {
  loadScenario,
} from "../fixtures/scenario-loader.ts";

// ============================================================================
// Setup
// ============================================================================

const mediumScenario = await loadScenario("medium-graph");

// Generate mock embeddings (1024-dim for BGE-M3)
function generateMockEmbedding(seed: number = 0): number[] {
  const embedding: number[] = [];
  for (let i = 0; i < 1024; i++) {
    // Deterministic pseudo-random based on seed and index
    embedding.push(Math.sin(seed * 1000 + i) * 0.5);
  }
  return embedding;
}

// Create capabilities with embeddings
const mediumCapabilities = mediumScenario.nodes.capabilities.map((c, idx) => ({
  id: c.id,
  embedding: generateMockEmbedding(idx),
  toolsUsed: c.toolsUsed,
  successRate: c.successRate,
  parents: [] as string[],
  children: [] as string[],
}));

// Create tool embeddings map
const toolEmbeddings = new Map<string, number[]>();
mediumScenario.nodes.tools.forEach((t, idx) => {
  toolEmbeddings.set(t.id, generateMockEmbedding(100 + idx));
});

// Generate mock episodic events for training
const mockEpisodicEvents: TrainingExample[] = [];
for (let i = 0; i < 100; i++) {
  const cap = mediumCapabilities[i % mediumCapabilities.length];
  const contextTools = cap.toolsUsed.slice(0, 2);

  mockEpisodicEvents.push({
    intentEmbedding: generateMockEmbedding(1000 + i),
    contextTools,
    candidateId: cap.id,
    outcome: Math.random() > 0.3 ? 1 : 0, // 70% success rate
  });
}

// Create SHGAT instance
const shgat = createSHGATFromCapabilities(mediumCapabilities);

// Pre-trained SHGAT (for inference benchmarks)
const pretrainedShgat = createSHGATFromCapabilities(mediumCapabilities);
// Quick pre-training
await trainSHGATOnEpisodes(
  pretrainedShgat,
  mockEpisodicEvents.slice(0, 50),
  (id) => toolEmbeddings.get(id) || null,
  { epochs: 3, batchSize: 16 },
);

// Spectral clustering for comparison
const spectralManager = new SpectralClusteringManager();
const allToolIds = mediumScenario.nodes.tools.map((t) => t.id);
const clusterableCapabilities = mediumCapabilities.map((c) => ({
  id: c.id,
  toolsUsed: c.toolsUsed,
}));
spectralManager.buildBipartiteMatrix(allToolIds, clusterableCapabilities);
spectralManager.computeClusters(5);

// ============================================================================
// Benchmarks: Inference (Scoring)
// ============================================================================

const testIntent = generateMockEmbedding(9999);
const testContext = [generateMockEmbedding(9998), generateMockEmbedding(9997)];

// Pre-create SHGAT instances with different head counts for fair comparison
const singleHeadShgat = createSHGATFromCapabilities(
  [mediumCapabilities[0]],
  toolEmbeddings,
  { numHeads: 1 },
);
const multiHeadShgat = createSHGATFromCapabilities(
  [mediumCapabilities[0]],
  toolEmbeddings,
  { numHeads: 8 },
);

Deno.bench({
  name: "SHGAT: single score (1 head)",
  group: "shgat-inference",
  baseline: true,
  fn: () => {
    singleHeadShgat.computeAttention(testIntent, testContext, mediumCapabilities[0].id);
  },
});

Deno.bench({
  name: "SHGAT: single score (4 heads)",
  group: "shgat-inference",
  fn: () => {
    pretrainedShgat.computeAttention(testIntent, testContext, mediumCapabilities[0].id);
  },
});

Deno.bench({
  name: "SHGAT: single score (8 heads)",
  group: "shgat-inference",
  fn: () => {
    multiHeadShgat.computeAttention(testIntent, testContext, mediumCapabilities[0].id);
  },
});

// ============================================================================
// Benchmarks: Context Size Scaling
// ============================================================================

Deno.bench({
  name: "SHGAT: context size 0",
  group: "shgat-context",
  baseline: true,
  fn: () => {
    pretrainedShgat.computeAttention(testIntent, [], mediumCapabilities[0].id);
  },
});

Deno.bench({
  name: "SHGAT: context size 3",
  group: "shgat-context",
  fn: () => {
    const ctx = [generateMockEmbedding(1), generateMockEmbedding(2), generateMockEmbedding(3)];
    pretrainedShgat.computeAttention(testIntent, ctx, mediumCapabilities[0].id);
  },
});

Deno.bench({
  name: "SHGAT: context size 10",
  group: "shgat-context",
  fn: () => {
    const ctx = Array.from({ length: 10 }, (_, i) => generateMockEmbedding(i));
    pretrainedShgat.computeAttention(testIntent, ctx, mediumCapabilities[0].id);
  },
});

// ============================================================================
// Benchmarks: Score All Capabilities
// ============================================================================

Deno.bench({
  name: "SHGAT: score all (10 capabilities)",
  group: "shgat-all",
  baseline: true,
  fn: () => {
    pretrainedShgat.scoreAllCapabilities(testIntent, testContext);
  },
});

// ============================================================================
// Benchmarks: Training
// ============================================================================

Deno.bench({
  name: "SHGAT: train batch (16 examples)",
  group: "shgat-training",
  baseline: true,
  fn: () => {
    const freshShgat = createSHGATFromCapabilities(mediumCapabilities);
    freshShgat.trainBatch(
      mockEpisodicEvents.slice(0, 16),
      (id) => toolEmbeddings.get(id) || null,
    );
  },
});

Deno.bench({
  name: "SHGAT: train batch (32 examples)",
  group: "shgat-training",
  fn: () => {
    const freshShgat = createSHGATFromCapabilities(mediumCapabilities);
    freshShgat.trainBatch(
      mockEpisodicEvents.slice(0, 32),
      (id) => toolEmbeddings.get(id) || null,
    );
  },
});

Deno.bench({
  name: "SHGAT: train epoch (100 examples, batch=16)",
  group: "shgat-training",
  fn: async () => {
    const freshShgat = createSHGATFromCapabilities(mediumCapabilities);
    await trainSHGATOnEpisodes(
      freshShgat,
      mockEpisodicEvents,
      (id) => toolEmbeddings.get(id) || null,
      { epochs: 1, batchSize: 16 },
    );
  },
});

// ============================================================================
// Benchmarks: Hidden Dimension Scaling
// ============================================================================

// Pre-create SHGAT instances with different hidden dimensions
const smallDimShgat = createSHGATFromCapabilities(
  [mediumCapabilities[0]],
  toolEmbeddings,
  { hiddenDim: 32 },
);
const medDimShgat = createSHGATFromCapabilities(
  [mediumCapabilities[0]],
  toolEmbeddings,
  { hiddenDim: 64 },
);
const largeDimShgat = createSHGATFromCapabilities(
  [mediumCapabilities[0]],
  toolEmbeddings,
  { hiddenDim: 128 },
);

Deno.bench({
  name: "SHGAT: hiddenDim=32",
  group: "shgat-dim",
  baseline: true,
  fn: () => {
    smallDimShgat.computeAttention(testIntent, testContext, mediumCapabilities[0].id);
  },
});

Deno.bench({
  name: "SHGAT: hiddenDim=64",
  group: "shgat-dim",
  fn: () => {
    medDimShgat.computeAttention(testIntent, testContext, mediumCapabilities[0].id);
  },
});

Deno.bench({
  name: "SHGAT: hiddenDim=128",
  group: "shgat-dim",
  fn: () => {
    largeDimShgat.computeAttention(testIntent, testContext, mediumCapabilities[0].id);
  },
});

// ============================================================================
// Benchmarks: SHGAT vs Spectral (Static)
// ============================================================================

const contextToolIds = mediumScenario.nodes.tools.slice(0, 3).map((t) => t.id);

Deno.bench({
  name: "Spectral: baseline cluster boost",
  group: "shgat-vs-spectral",
  baseline: true,
  fn: () => {
    const activeCluster = spectralManager.identifyActiveCluster(contextToolIds);
    spectralManager.getClusterBoost(clusterableCapabilities[0], activeCluster);
  },
});

Deno.bench({
  name: "SHGAT: learned attention score",
  group: "shgat-vs-spectral",
  fn: () => {
    const contextEmbeddings = contextToolIds
      .map((id) => toolEmbeddings.get(id))
      .filter((e): e is number[] => e !== null);
    pretrainedShgat.computeAttention(testIntent, contextEmbeddings, mediumCapabilities[0].id);
  },
});

// ============================================================================
// Benchmarks: Model Stats & Serialization
// ============================================================================

Deno.bench({
  name: "SHGAT: get stats",
  group: "shgat-util",
  baseline: true,
  fn: () => {
    pretrainedShgat.getStats();
  },
});

Deno.bench({
  name: "SHGAT: export params",
  group: "shgat-util",
  fn: () => {
    pretrainedShgat.exportParams();
  },
});

Deno.bench({
  name: "SHGAT: import params",
  group: "shgat-util",
  fn: () => {
    const params = pretrainedShgat.exportParams();
    // Create a fresh SHGAT with same structure, then import params
    const freshShgat = createSHGATFromCapabilities(mediumCapabilities, toolEmbeddings);
    freshShgat.importParams(params);
  },
});

// ============================================================================
// Cleanup
// ============================================================================

globalThis.addEventListener("unload", () => {
  const stats = pretrainedShgat.getStats();

  console.log("\nSHGAT Benchmark Summary:");
  console.log(`- Num heads: ${stats.numHeads}`);
  console.log(`- Hidden dim: ${stats.hiddenDim}`);
  console.log(`- Param count: ${stats.paramCount.toLocaleString()}`);
  console.log(`- Registered capabilities: ${stats.registeredCapabilities}`);
  console.log(`- Training examples: ${mockEpisodicEvents.length}`);
});
