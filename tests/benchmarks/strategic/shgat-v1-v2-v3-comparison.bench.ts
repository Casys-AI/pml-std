/**
 * SHGAT v1 vs v2 vs v3 Comparison Benchmark
 *
 * Compares the three SHGAT scoring approaches:
 * - v1: Message passing (V→E→V) + K adaptive heads (numHeads=4-16 based on graph size)
 * - v2: Direct embeddings + Rich TraceFeatures (17 features) + K heads + Fusion MLP
 * - v3: HYBRID - Message passing + TraceFeatures + K heads + Fusion MLP
 *
 * PRIMARY METRICS (Precision-focused):
 * - MRR (Mean Reciprocal Rank): Average 1/rank of correct answer
 * - Hit@1: % of times correct answer is ranked #1
 * - Hit@3: % of times correct answer is in top 3
 * - Hierarchical precision: How well nested capabilities are scored
 *
 * SECONDARY METRICS:
 * - Latency: Time per scoring operation (informational only)
 *
 * Uses BGE-M3 embeddings from medium-graph fixture with real descriptions.
 *
 * Run: deno bench --allow-all tests/benchmarks/strategic/shgat-v1-v2-v3-comparison.bench.ts
 *
 * @module tests/benchmarks/strategic/shgat-v1-v2-v3-comparison
 */

import {
  createSHGATFromCapabilities,
  trainSHGATOnEpisodesKHead,
  type TrainingExample,
} from "../../../src/graphrag/algorithms/shgat.ts";
import {
  DEFAULT_TRACE_STATS,
  type TraceFeatures,
} from "../../../src/graphrag/algorithms/shgat/types.ts";
import { loadScenario } from "../fixtures/scenario-loader.ts";

// ============================================================================
// Setup Test Data with Pre-computed Embeddings
// ============================================================================
// To update production traces from PostgreSQL, run:
//   deno run --allow-all scripts/export-traces-for-benchmark.ts
// This exports execution_trace data to: tests/benchmarks/fixtures/scenarios/production-traces.json

console.log("📦 Loading production-traces scenario (from PostgreSQL)...");
const scenario = await loadScenario("production-traces");

// Type for fixture with embeddings
type CapWithEmb = { id: string; embedding: number[]; toolsUsed: string[]; successRate: number; parents?: string[]; children?: string[]; description?: string; level?: number };
type ToolWithEmb = { id: string; embedding: number[]; pageRank: number; community: number };
type EventWithEmb = { intent: string; intentEmbedding: number[]; contextTools: string[]; selectedCapability: string; outcome: string };
type QueryWithEmb = { intent: string; intentEmbedding: number[]; expectedCapability: string; difficulty: string };

const rawCaps = scenario.nodes.capabilities as CapWithEmb[];
const rawTools = scenario.nodes.tools as ToolWithEmb[];
const rawEvents = (scenario as { episodicEvents?: EventWithEmb[] }).episodicEvents || [];
const rawQueries = (scenario as { testQueries?: QueryWithEmb[] }).testQueries || [];

// Build capabilities array from pre-computed embeddings
console.log("🧮 Loading pre-computed embeddings...");
type RawCap = CapWithEmb & { hypergraphFeatures?: { spectralCluster: number; hypergraphPageRank: number; cooccurrence: number; recency: number; adamicAdar?: number; heatDiffusion?: number } };
const capabilities = (rawCaps as RawCap[]).map(c => ({
  id: c.id,
  embedding: c.embedding,
  toolsUsed: c.toolsUsed,
  successRate: c.successRate,
  parents: c.parents || [],
  children: c.children || [],
  description: c.description || c.id,
  level: c.level,
  hypergraphFeatures: c.hypergraphFeatures, // ← AJOUTÉ
}));

// Build tool embeddings map
const toolEmbeddings = new Map<string, number[]>();
for (const t of rawTools) {
  toolEmbeddings.set(t.id, t.embedding);
}

// Build training data from pre-computed embeddings
console.log("📚 Building training data...");
const trainingExamples: TrainingExample[] = rawEvents.map(event => ({
  intentEmbedding: event.intentEmbedding,
  contextTools: event.contextTools,
  candidateId: event.selectedCapability,
  outcome: event.outcome === "success" ? 1 : 0,
}));

// Create SHGAT instance
console.log("🏗️ Creating SHGAT model...");
const shgat = createSHGATFromCapabilities(capabilities, toolEmbeddings);

// Training with K-head (trains W_q, W_k for multi-head attention scoring)
console.log("🎓 Training SHGAT K-head (30 epochs, batch=16)...");
await trainSHGATOnEpisodesKHead(
  shgat,
  trainingExamples,
  (id) => toolEmbeddings.get(id) || null,
  { epochs: 30, batchSize: 16 },
);
console.log("✅ K-head training complete!");

// Build test queries from pre-computed embeddings
console.log("📝 Loading test queries...");

interface TestQuery {
  intent: number[];
  contextToolIds: string[];
  expectedCapabilityId: string;
  description: string;
  difficulty: string;
}

const testQueries: TestQuery[] = rawQueries.map(q => {
  const cap = capabilities.find(c => c.id === q.expectedCapability);
  return {
    intent: q.intentEmbedding,
    contextToolIds: cap?.toolsUsed.slice(0, 2) || [],
    expectedCapabilityId: q.expectedCapability,
    description: q.intent,
    difficulty: q.difficulty,
  };
});

// Use first query for single-intent tests
const testIntent = testQueries[0]?.intent || new Array(1024).fill(0);
const contextToolIds = testQueries[0]?.contextToolIds || ["fs__read"];

// Build TraceFeatures map for v2 and v3
const traceFeaturesMap = new Map<string, TraceFeatures>();
for (const cap of capabilities) {
  traceFeaturesMap.set(cap.id, {
    intentEmbedding: testIntent,
    candidateEmbedding: cap.embedding,
    contextEmbeddings: contextToolIds.map((id) => toolEmbeddings.get(id)!).filter(Boolean),
    contextAggregated: new Array(1024).fill(0),
    traceStats: {
      ...DEFAULT_TRACE_STATS,
      historicalSuccessRate: cap.successRate,
      contextualSuccessRate: cap.successRate,
    },
  });
}

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
  name: "v1: scoreAllCapabilities (message passing + K heads)",
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
  "v1 (message passing + K heads)".padEnd(50) +
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

// ============================================================================
// Hierarchical Precision Tests (using real fixture data)
// ============================================================================

console.log("\n" + "=".repeat(80));
console.log("HIERARCHICAL CAPABILITY PRECISION TEST");
console.log("=".repeat(80));

// Test with the trained SHGAT using real hierarchical data from fixture
// Query: "orchestrate end-to-end business process" -> expected: cap__full_stack (level 3)
const hierQuery = testQueries.find(q => q.expectedCapabilityId === "cap__full_stack");
if (hierQuery) {
  const hierResults = shgat.scoreAllCapabilities(hierQuery.intent);

  console.log("\nHierarchical Ranking Test:");
  console.log("-".repeat(50));
  console.log(`Intent: "${hierQuery.description}"`);
  console.log("Expected: cap__full_stack (level 3) should rank highest\n");

  hierResults.slice(0, 8).forEach((r, i) => {
    const cap = capabilities.find(c => c.id === r.capabilityId);
    const level = (cap as { level?: number } & typeof cap)?.level ?? "?";
    console.log(`  ${i + 1}. ${r.capabilityId.padEnd(25)} score=${r.score.toFixed(4)} (level ${level})`);
  });

  const topResult = hierResults[0];
  const hierarchyPrecision = topResult.capabilityId === "cap__full_stack" ? "✅ PASS" : "❌ FAIL";
  console.log(`\nHierarchy Precision: ${hierarchyPrecision}`);

  // Test: Parent-Child score relationship (cap__application_core contains cap__data_layer)
  const appCoreScore = hierResults.find((r) => r.capabilityId === "cap__application_core")?.score ?? 0;
  const dataLayerScore = hierResults.find((r) => r.capabilityId === "cap__data_layer")?.score ?? 0;
  const apiLayerScore = hierResults.find((r) => r.capabilityId === "cap__api_layer")?.score ?? 0;

  console.log("\nParent-Child Score Relationship:");
  console.log(`  Parent (cap__application_core, L2): ${appCoreScore.toFixed(4)}`);
  console.log(`  Child (cap__data_layer, L1): ${dataLayerScore.toFixed(4)}`);
  console.log(`  Child (cap__api_layer, L1): ${apiLayerScore.toFixed(4)}`);
}

// Precision by difficulty level
console.log("\n" + "-".repeat(50));
console.log("PRECISION BY DIFFICULTY LEVEL");
console.log("-".repeat(50));

const difficultyGroups = { easy: [] as TestQuery[], medium: [] as TestQuery[], hard: [] as TestQuery[] };
testQueries.forEach(q => {
  if (q.difficulty in difficultyGroups) {
    difficultyGroups[q.difficulty as keyof typeof difficultyGroups].push(q);
  }
});

for (const [difficulty, queries] of Object.entries(difficultyGroups)) {
  if (queries.length === 0) continue;

  let hit1 = 0, hit3 = 0, totalReciprocal = 0;
  for (const q of queries) {
    const results = shgat.scoreAllCapabilities(q.intent);
    const rank = results.findIndex(r => r.capabilityId === q.expectedCapabilityId) + 1;
    if (rank > 0) {
      totalReciprocal += 1 / rank;
      if (rank === 1) hit1++;
      if (rank <= 3) hit3++;
    }
  }
  const mrr = totalReciprocal / queries.length;
  console.log(`  ${difficulty.toUpperCase().padEnd(8)} (${queries.length} queries): MRR=${mrr.toFixed(3)}, Hit@1=${(hit1/queries.length*100).toFixed(1)}%, Hit@3=${(hit3/queries.length*100).toFixed(1)}%`);
}

console.log("=".repeat(80) + "\n");
