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
  createSHGATFromCapabilities,
  type TrainingExample,
  trainSHGATOnEpisodes,
} from "../../../src/graphrag/algorithms/shgat.ts";
import {
  DEFAULT_TRACE_STATS,
  getAdaptiveConfig,
  type TraceFeatures,
} from "../../../src/graphrag/algorithms/shgat/types.ts";
import { SpectralClusteringManager } from "../../../src/graphrag/spectral-clustering.ts";
import { loadScenario } from "../fixtures/scenario-loader.ts";

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

// Pre-create SHGAT instances with different head counts for Phase 5 v2 benchmarks
// Head counts scaled to match trace volume: {4, 8, 12, 16} per tech-spec
const heads4Shgat = createSHGATFromCapabilities(
  [mediumCapabilities[0]],
  toolEmbeddings,
  { numHeads: 4, hiddenDim: 64 }, // Conservative (<1K traces)
);
const heads8Shgat = createSHGATFromCapabilities(
  [mediumCapabilities[0]],
  toolEmbeddings,
  { numHeads: 8, hiddenDim: 128 }, // Default (1K-10K traces)
);
const heads12Shgat = createSHGATFromCapabilities(
  [mediumCapabilities[0]],
  toolEmbeddings,
  { numHeads: 12, hiddenDim: 192 }, // Scale up (10K-100K traces)
);
const heads16Shgat = createSHGATFromCapabilities(
  [mediumCapabilities[0]],
  toolEmbeddings,
  { numHeads: 16, hiddenDim: 256 }, // Full capacity (100K+ traces)
);

Deno.bench({
  name: "SHGAT: single score (4 heads, hiddenDim=64)",
  group: "shgat-inference",
  baseline: true,
  fn: () => {
    heads4Shgat.computeAttention(testIntent, testContext, mediumCapabilities[0].id);
  },
});

Deno.bench({
  name: "SHGAT: single score (8 heads, hiddenDim=128)",
  group: "shgat-inference",
  fn: () => {
    heads8Shgat.computeAttention(testIntent, testContext, mediumCapabilities[0].id);
  },
});

Deno.bench({
  name: "SHGAT: single score (12 heads, hiddenDim=192)",
  group: "shgat-inference",
  fn: () => {
    heads12Shgat.computeAttention(testIntent, testContext, mediumCapabilities[0].id);
  },
});

Deno.bench({
  name: "SHGAT: single score (16 heads, hiddenDim=256)",
  group: "shgat-inference",
  fn: () => {
    heads16Shgat.computeAttention(testIntent, testContext, mediumCapabilities[0].id);
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
    const freshShgat = createSHGATFromCapabilities(mediumCapabilities, toolEmbeddings);
    freshShgat.trainBatch(mockEpisodicEvents.slice(0, 16));
  },
});

Deno.bench({
  name: "SHGAT: train batch (32 examples)",
  group: "shgat-training",
  fn: () => {
    const freshShgat = createSHGATFromCapabilities(mediumCapabilities, toolEmbeddings);
    freshShgat.trainBatch(mockEpisodicEvents.slice(0, 32));
  },
});

Deno.bench({
  name: "SHGAT: train epoch (100 examples, batch=16)",
  group: "shgat-training",
  fn: async () => {
    const freshShgat = createSHGATFromCapabilities(mediumCapabilities, toolEmbeddings);
    await trainSHGATOnEpisodes(
      freshShgat,
      mockEpisodicEvents,
      (_id: string) => null, // Deprecated param, kept for API compat
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
// Benchmarks: SHGAT v1 vs v2 Scoring (Phase 5)
// ============================================================================

// Build TraceFeatures for v2 scoring (proper type with all required fields)
function buildMockTraceFeatures(embedding: number[]): TraceFeatures {
  return {
    intentEmbedding: testIntent,
    candidateEmbedding: embedding,
    contextEmbeddings: testContext,
    contextAggregated: testContext.length > 0
      ? testContext[0].map((_, i) =>
        testContext.reduce((sum, ctx) => sum + ctx[i], 0) / testContext.length
      )
      : new Array(1024).fill(0),
    traceStats: {
      ...DEFAULT_TRACE_STATS,
      historicalSuccessRate: 0.8,
      contextualSuccessRate: 0.75,
      cooccurrenceWithContext: 0.6,
      recencyScore: 0.9,
      usageFrequency: 0.5,
    },
  };
}

const mockTraceFeaturesMap = new Map<string, TraceFeatures>();
mediumCapabilities.forEach((cap) => {
  mockTraceFeaturesMap.set(cap.id, buildMockTraceFeatures(cap.embedding));
});

const mockToolTraceFeaturesMap = new Map<string, TraceFeatures>();
mediumScenario.nodes.tools.forEach((t) => {
  const embedding = toolEmbeddings.get(t.id) || generateMockEmbedding(999);
  mockToolTraceFeaturesMap.set(t.id, buildMockTraceFeatures(embedding));
});

Deno.bench({
  name: "SHGAT v1: scoreAllCapabilities (hypergraph features)",
  group: "shgat-v1-vs-v2",
  baseline: true,
  fn: () => {
    pretrainedShgat.scoreAllCapabilities(testIntent);
  },
});

Deno.bench({
  name: "SHGAT v2: scoreAllCapabilitiesV2 (trace features)",
  group: "shgat-v1-vs-v2",
  fn: () => {
    pretrainedShgat.scoreAllCapabilitiesV2(testIntent, mockTraceFeaturesMap);
  },
});

Deno.bench({
  name: "SHGAT v1: scoreAllTools (graph features)",
  group: "shgat-v1-vs-v2",
  fn: () => {
    pretrainedShgat.scoreAllTools(testIntent);
  },
});

Deno.bench({
  name: "SHGAT v2: scoreAllToolsV2 (trace features)",
  group: "shgat-v1-vs-v2",
  fn: () => {
    pretrainedShgat.scoreAllToolsV2(testIntent, mockToolTraceFeaturesMap);
  },
});

// ============================================================================
// Benchmarks: MRR/Hit@1 Accuracy (Phase 5)
// ============================================================================

// Ranking accuracy helpers (adapted for AttentionResult which has capabilityId)
function computeMRRForAttention(
  predicted: Array<{ capabilityId: string; score: number }>,
  groundTruth: string,
): number {
  const sorted = [...predicted].sort((a, b) => b.score - a.score);
  const rank = sorted.findIndex((p) => p.capabilityId === groundTruth) + 1;
  return rank > 0 ? 1 / rank : 0;
}

function computeHitAtKForAttention(
  predicted: Array<{ capabilityId: string; score: number }>,
  groundTruth: string,
  k: number,
): number {
  const sorted = [...predicted].sort((a, b) => b.score - a.score);
  const topK = sorted.slice(0, k);
  return topK.some((p) => p.capabilityId === groundTruth) ? 1 : 0;
}

// Pre-generate test cases for accuracy benchmarks (deterministic)
const accuracyTestCases = mockEpisodicEvents.slice(0, 20).map((e, idx) => ({
  intent: e.intentEmbedding,
  groundTruth: e.candidateId,
  context: [generateMockEmbedding(2000 + idx), generateMockEmbedding(2001 + idx)],
}));

Deno.bench({
  name: "SHGAT: MRR computation (20 queries)",
  group: "shgat-accuracy",
  baseline: true,
  fn: () => {
    let totalMRR = 0;
    for (const tc of accuracyTestCases) {
      const scores = pretrainedShgat.scoreAllCapabilities(tc.intent);
      totalMRR += computeMRRForAttention(scores, tc.groundTruth);
    }
    // Just compute, don't assert (benchmark only)
    void (totalMRR / accuracyTestCases.length);
  },
});

Deno.bench({
  name: "SHGAT: Hit@1 computation (20 queries)",
  group: "shgat-accuracy",
  fn: () => {
    let hits = 0;
    for (const tc of accuracyTestCases) {
      const scores = pretrainedShgat.scoreAllCapabilities(tc.intent);
      hits += computeHitAtKForAttention(scores, tc.groundTruth, 1);
    }
    void (hits / accuracyTestCases.length);
  },
});

Deno.bench({
  name: "SHGAT: Hit@3 computation (20 queries)",
  group: "shgat-accuracy",
  fn: () => {
    let hits = 0;
    for (const tc of accuracyTestCases) {
      const scores = pretrainedShgat.scoreAllCapabilities(tc.intent);
      hits += computeHitAtKForAttention(scores, tc.groundTruth, 3);
    }
    void (hits / accuracyTestCases.length);
  },
});

// ============================================================================
// Benchmarks: Adaptive Config Scaling (Phase 5)
// ============================================================================

Deno.bench({
  name: "getAdaptiveConfig: <1K traces",
  group: "shgat-adaptive",
  baseline: true,
  fn: () => {
    getAdaptiveConfig(500);
  },
});

Deno.bench({
  name: "getAdaptiveConfig: 1K-10K traces",
  group: "shgat-adaptive",
  fn: () => {
    getAdaptiveConfig(5_000);
  },
});

Deno.bench({
  name: "getAdaptiveConfig: 10K-100K traces",
  group: "shgat-adaptive",
  fn: () => {
    getAdaptiveConfig(50_000);
  },
});

Deno.bench({
  name: "getAdaptiveConfig: 100K+ traces",
  group: "shgat-adaptive",
  fn: () => {
    getAdaptiveConfig(200_000);
  },
});

// ============================================================================
// Benchmarks: Memory Usage by Config (Phase 5)
// ============================================================================

// Note: Deno benchmarks don't have built-in memory profiling, so we measure
// creation time as proxy (more params = more allocation time)

Deno.bench({
  name: "SHGAT create: 4 heads, 64 dim (~50K params)",
  group: "shgat-memory",
  baseline: true,
  fn: () => {
    const config = getAdaptiveConfig(500);
    createSHGATFromCapabilities([mediumCapabilities[0]], toolEmbeddings, config);
  },
});

Deno.bench({
  name: "SHGAT create: 8 heads, 128 dim (~200K params)",
  group: "shgat-memory",
  fn: () => {
    const config = getAdaptiveConfig(5_000);
    createSHGATFromCapabilities([mediumCapabilities[0]], toolEmbeddings, config);
  },
});

Deno.bench({
  name: "SHGAT create: 12 heads, 192 dim (~450K params)",
  group: "shgat-memory",
  fn: () => {
    const config = getAdaptiveConfig(50_000);
    createSHGATFromCapabilities([mediumCapabilities[0]], toolEmbeddings, config);
  },
});

Deno.bench({
  name: "SHGAT create: 16 heads, 256 dim (~800K params)",
  group: "shgat-memory",
  fn: () => {
    const config = getAdaptiveConfig(200_000);
    createSHGATFromCapabilities([mediumCapabilities[0]], toolEmbeddings, config);
  },
});

// ============================================================================
// Cleanup
// ============================================================================

globalThis.addEventListener("unload", () => {
  const stats = pretrainedShgat.getStats();

  console.log("\n=== SHGAT Benchmark Summary ===");
  console.log(`Num heads: ${stats.numHeads}`);
  console.log(`Hidden dim: ${stats.hiddenDim}`);
  console.log(`Param count: ${stats.paramCount.toLocaleString()}`);
  console.log(`Registered capabilities: ${stats.registeredCapabilities}`);
  console.log(`Training examples: ${mockEpisodicEvents.length}`);

  // Compute final accuracy metrics
  let totalMRR = 0;
  let hit1 = 0;
  let hit3 = 0;
  for (const tc of accuracyTestCases) {
    const scores = pretrainedShgat.scoreAllCapabilities(tc.intent);
    totalMRR += computeMRRForAttention(scores, tc.groundTruth);
    hit1 += computeHitAtKForAttention(scores, tc.groundTruth, 1);
    hit3 += computeHitAtKForAttention(scores, tc.groundTruth, 3);
  }
  console.log(`\n=== Accuracy Metrics (${accuracyTestCases.length} queries) ===`);
  console.log(`MRR: ${(totalMRR / accuracyTestCases.length).toFixed(3)}`);
  console.log(`Hit@1: ${((hit1 / accuracyTestCases.length) * 100).toFixed(1)}%`);
  console.log(`Hit@3: ${((hit3 / accuracyTestCases.length) * 100).toFixed(1)}%`);
});
