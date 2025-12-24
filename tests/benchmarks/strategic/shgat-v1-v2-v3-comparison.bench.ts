/**
 * SHGAT v1 vs v2 vs v3 Comparison Benchmark
 *
 * Compares the three SHGAT scoring approaches:
 * - v1: Message passing (V→E→V) + 3 specialized heads (semantic/structure/temporal)
 * - v2: Direct embeddings + Rich TraceFeatures (17 features) + K heads + Fusion MLP
 * - v3: HYBRID - Message passing + TraceFeatures + K heads + Fusion MLP
 *
 * Metrics:
 * - MRR (Mean Reciprocal Rank): Average 1/rank of correct answer
 * - Hit@1: % of times correct answer is ranked #1
 * - Hit@3: % of times correct answer is in top 3
 * - Latency: Time per scoring operation
 *
 * Run: deno bench --allow-all tests/benchmarks/strategic/shgat-v1-v2-v3-comparison.bench.ts
 *
 * @module tests/benchmarks/strategic/shgat-v1-v2-v3-comparison
 */

import {
  createSHGATFromCapabilities,
  trainSHGATOnEpisodes,
  type TrainingExample,
} from "../../../src/graphrag/algorithms/shgat.ts";
import {
  DEFAULT_TRACE_STATS,
  type TraceFeatures,
} from "../../../src/graphrag/algorithms/shgat-types.ts";
import { loadScenario } from "../fixtures/scenario-loader.ts";

// ============================================================================
// Setup Test Data
// ============================================================================

const scenario = await loadScenario("medium-graph");

// Generate deterministic embeddings
function generateMockEmbedding(seed: number = 0): number[] {
  const embedding: number[] = [];
  for (let i = 0; i < 1024; i++) {
    embedding.push(Math.sin(seed * 1000 + i) * 0.5);
  }
  return embedding;
}

// Create capabilities with embeddings
const capabilities = scenario.nodes.capabilities.map((c, idx) => ({
  id: c.id,
  embedding: generateMockEmbedding(idx),
  toolsUsed: c.toolsUsed,
  successRate: c.successRate,
  parents: [] as string[],
  children: [] as string[],
}));

// Create tool embeddings map
const toolEmbeddings = new Map<string, number[]>();
scenario.nodes.tools.forEach((t, idx) => {
  toolEmbeddings.set(t.id, generateMockEmbedding(100 + idx));
});

// Generate mock episodic events for training
const mockEpisodicEvents: TrainingExample[] = [];
for (let i = 0; i < 100; i++) {
  const cap = capabilities[i % capabilities.length];
  const contextTools = cap.toolsUsed.slice(0, 2);

  mockEpisodicEvents.push({
    intentEmbedding: generateMockEmbedding(1000 + i),
    contextTools,
    candidateId: cap.id,
    outcome: Math.random() > 0.3 ? 1 : 0, // 70% success rate
  });
}

// Create SHGAT instances
const shgat = createSHGATFromCapabilities(capabilities, toolEmbeddings);

// Extended training (was: 3 epochs, 50 examples)
await trainSHGATOnEpisodes(
  shgat,
  mockEpisodicEvents, // All 100 examples
  (id) => toolEmbeddings.get(id) || null,
  { epochs: 15, batchSize: 16 }, // Increase to 25+ for better v2 results
);

// Test intent and context
const testIntent = generateMockEmbedding(9999);
const contextToolIds = capabilities[0].toolsUsed.slice(0, 2);

// Build TraceFeatures map for v2 and v3
const traceFeaturesMap = new Map<string, TraceFeatures>();
capabilities.forEach((cap) => {
  traceFeaturesMap.set(cap.id, {
    intentEmbedding: testIntent,
    candidateEmbedding: cap.embedding,
    contextEmbeddings: contextToolIds.map((id) => toolEmbeddings.get(id)!),
    contextAggregated: new Array(1024).fill(0),
    traceStats: {
      ...DEFAULT_TRACE_STATS,
      historicalSuccessRate: cap.successRate,
      contextualSuccessRate: cap.successRate,
    },
  });
});

// ============================================================================
// Test Queries with Ground Truth
// ============================================================================

interface TestQuery {
  intent: number[];
  contextToolIds: string[];
  expectedCapabilityId: string;
  description: string;
}

const testQueries: TestQuery[] = [
  {
    intent: generateMockEmbedding(8001),
    contextToolIds: capabilities[0].toolsUsed.slice(0, 2),
    expectedCapabilityId: capabilities[0].id,
    description: "Query 1: First capability",
  },
  {
    intent: generateMockEmbedding(8002),
    contextToolIds: capabilities[5].toolsUsed.slice(0, 2),
    expectedCapabilityId: capabilities[5].id,
    description: "Query 2: Mid capability",
  },
  {
    intent: generateMockEmbedding(8003),
    contextToolIds: capabilities[Math.min(10, capabilities.length - 1)].toolsUsed.slice(0, 2),
    expectedCapabilityId: capabilities[Math.min(10, capabilities.length - 1)].id,
    description: "Query 3: Later capability",
  },
];

// ============================================================================
// Accuracy Metrics Computation
// ============================================================================

interface AccuracyMetrics {
  mrr: number;
  hit1: number;
  hit3: number;
}

function computeAccuracyMetrics(
  queries: TestQuery[],
  scoreFn: (intent: number[], traceFeaturesMap: Map<string, TraceFeatures>, contextToolIds: string[]) => Array<{ capabilityId: string; score: number }>,
): AccuracyMetrics {
  let totalReciprocal = 0;
  let hit1Count = 0;
  let hit3Count = 0;

  for (const query of queries) {
    const results = scoreFn(query.intent, traceFeaturesMap, query.contextToolIds);
    const rank = results.findIndex((r) => r.capabilityId === query.expectedCapabilityId) + 1;

    if (rank > 0) {
      totalReciprocal += 1 / rank;
      if (rank === 1) hit1Count++;
      if (rank <= 3) hit3Count++;
    }
  }

  return {
    mrr: totalReciprocal / queries.length,
    hit1: hit1Count / queries.length,
    hit3: hit3Count / queries.length,
  };
}

// ============================================================================
// Benchmarks: Latency
// ============================================================================

Deno.bench({
  name: "v1: scoreAllCapabilities (message passing + 3 heads)",
  group: "shgat-versions-latency",
  baseline: true,
  fn: () => {
    shgat.scoreAllCapabilities(testIntent);
  },
});

Deno.bench({
  name: "v2: scoreAllCapabilitiesV2 (direct + K heads + MLP)",
  group: "shgat-versions-latency",
  fn: () => {
    shgat.scoreAllCapabilitiesV2(testIntent, traceFeaturesMap, contextToolIds);
  },
});

Deno.bench({
  name: "v3: scoreAllCapabilitiesV3 (HYBRID: message passing + K heads + MLP)",
  group: "shgat-versions-latency",
  fn: () => {
    shgat.scoreAllCapabilitiesV3(testIntent, traceFeaturesMap, contextToolIds);
  },
});

// ============================================================================
// Accuracy Comparison (runs once, prints results)
// ============================================================================

// Compute accuracy for each version
const v1Accuracy = computeAccuracyMetrics(
  testQueries,
  (intent, _, __) => shgat.scoreAllCapabilities(intent).map((r) => ({ capabilityId: r.capabilityId, score: r.score })),
);

const v2Accuracy = computeAccuracyMetrics(
  testQueries,
  (intent, traceFeaturesMap, contextToolIds) =>
    shgat.scoreAllCapabilitiesV2(intent, traceFeaturesMap, contextToolIds).map((r) => ({ capabilityId: r.capabilityId, score: r.score })),
);

const v3Accuracy = computeAccuracyMetrics(
  testQueries,
  (intent, traceFeaturesMap, contextToolIds) =>
    shgat.scoreAllCapabilitiesV3(intent, traceFeaturesMap, contextToolIds).map((r) => ({ capabilityId: r.capabilityId, score: r.score })),
);

// Print accuracy comparison table
console.log("\n" + "=".repeat(80));
console.log("SHGAT VERSION COMPARISON - ACCURACY METRICS");
console.log("=".repeat(80));
console.log("Test Queries:", testQueries.length);
console.log("Capabilities:", capabilities.length);
console.log("-".repeat(80));
console.log(
  "Version".padEnd(50) +
    "MRR".padEnd(10) +
    "Hit@1".padEnd(10) +
    "Hit@3".padEnd(10),
);
console.log("-".repeat(80));
console.log(
  "v1 (message passing + 3 heads)".padEnd(50) +
    v1Accuracy.mrr.toFixed(3).padEnd(10) +
    (v1Accuracy.hit1 * 100).toFixed(1).padEnd(10) +
    (v1Accuracy.hit3 * 100).toFixed(1).padEnd(10),
);
console.log(
  "v2 (direct + K heads + MLP)".padEnd(50) +
    v2Accuracy.mrr.toFixed(3).padEnd(10) +
    (v2Accuracy.hit1 * 100).toFixed(1).padEnd(10) +
    (v2Accuracy.hit3 * 100).toFixed(1).padEnd(10),
);
console.log(
  "v3 (HYBRID: message passing + K heads + MLP)".padEnd(50) +
    v3Accuracy.mrr.toFixed(3).padEnd(10) +
    (v3Accuracy.hit1 * 100).toFixed(1).padEnd(10) +
    (v3Accuracy.hit3 * 100).toFixed(1).padEnd(10),
);
console.log("-".repeat(80));

// Determine winner
const versions = [
  { name: "v1", accuracy: v1Accuracy },
  { name: "v2", accuracy: v2Accuracy },
  { name: "v3", accuracy: v3Accuracy },
];
const winner = versions.reduce((best, current) =>
  current.accuracy.mrr > best.accuracy.mrr ? current : best
);

console.log(`\n🏆 WINNER (by MRR): ${winner.name} with MRR=${winner.accuracy.mrr.toFixed(3)}`);
console.log("=".repeat(80) + "\n");
