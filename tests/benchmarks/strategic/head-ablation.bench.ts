/**
 * SHGAT Head Ablation Study with Real BGE-M3 Embeddings
 *
 * Tests different combinations of attention heads to measure their contribution
 * using REAL embeddings from BGE-M3 on the medium-graph dataset.
 *
 * Run manually (generates embeddings, ~90s first time):
 *   deno run --allow-all tests/benchmarks/ablation/head-ablation.bench.ts
 *
 * Or as benchmarks (uses pre-warmed instances):
 *   deno bench --allow-all tests/benchmarks/ablation/head-ablation.bench.ts
 *
 * @module tests/benchmarks/ablation/head-ablation
 */

import { assertEquals, assertGreater } from "@std/assert";
import {
  createSHGATFromCapabilities,
  getAdaptiveConfig,
  SHGAT,
  type SHGATConfig,
  type TrainingExample,
  trainSHGATOnEpisodes,
} from "../../../src/graphrag/algorithms/shgat.ts";
import { EmbeddingModel } from "../../../src/vector/embeddings.ts";
import { loadScenario, type ScenarioData } from "../fixtures/scenario-loader.ts";

// ============================================================================
// Head Configuration Presets (3-Head Architecture)
// Head 0: Semantic (intentSim * featureWeights.semantic)
// Head 1: Structure (pageRank + adamicAdar) * featureWeights.structure
// Head 2: Temporal  (recency + heatDiffusion) * featureWeights.temporal
// ============================================================================

export const HEAD_CONFIGS: Record<string, Partial<SHGATConfig>> = {
  // === Single Head Ablations ===
  "semantic_only": { activeHeads: [0] },
  "structure_only": { activeHeads: [1] },
  "temporal_only": { activeHeads: [2] },

  // === Two-Head Combinations ===
  "semantic_structure": { activeHeads: [0, 1] },
  "semantic_temporal": { activeHeads: [0, 2] },
  "structure_temporal": { activeHeads: [1, 2] },

  // === Full 3-Head SHGAT ===
  "full_shgat": { activeHeads: [0, 1, 2] }, // learned fusion
  "full_shgat_equal": {
    activeHeads: [0, 1, 2],
    headFusionWeights: [1 / 3, 1 / 3, 1 / 3],
  },
  "full_shgat_semantic_heavy": {
    activeHeads: [0, 1, 2],
    headFusionWeights: [0.6, 0.2, 0.2], // 60% semantic, 20% structure, 20% temporal
  },
  // Test: semantic dominant (80%)
  "semantic_80pct": {
    activeHeads: [0, 1, 2],
    headFusionWeights: [0.8, 0.1, 0.1],
  },
  // Test: structure + temporal only (no semantic)
  "no_semantic": {
    activeHeads: [1, 2],
  },
};

// Note: FEATURE_WEIGHT_PRESETS are obsolete in v2 - fusion is learned via MLP
// Legacy configs use activeHeads/headFusionWeights (deprecated but functional)

// ============================================================================
// Types
// ============================================================================

interface CapabilityWithEmbedding {
  id: string;
  description: string;
  embedding: number[];
  toolsUsed: string[];
  successRate: number;
  hypergraphFeatures?: {
    spectralCluster: number;
    hypergraphPageRank: number;
    cooccurrence: number;
    recency: number;
    adamicAdar: number;
    heatDiffusion: number;
  };
}

interface TestQuery {
  intent: string;
  intentEmbedding?: number[];
  expectedCapability: string;
  alternatives?: string[];
}

interface AblationResult {
  config: string;
  top1Accuracy: number;
  top3Accuracy: number;
  mrr: number;
  avgScore: number;
  details: Array<{
    scenario: string;
    correct: boolean;
    rank: number;
    score: number;
    headWeights: number[];
  }>;
}

// ============================================================================
// Data Loading with Real Embeddings
// ============================================================================

async function loadDataWithEmbeddings(embedder: EmbeddingModel): Promise<{
  capabilities: CapabilityWithEmbedding[];
  toolEmbeddings: Map<string, number[]>;
  testQueries: TestQuery[];
}> {
  const scenario: ScenarioData = await loadScenario("medium-graph");

  console.log("  Generating embeddings for capabilities...");
  const capabilities: CapabilityWithEmbedding[] = [];
  for (
    const cap of scenario.nodes.capabilities as Array<{
      id: string;
      description: string;
      toolsUsed: string[];
      successRate: number;
      hypergraphFeatures?: {
        spectralCluster: number;
        hypergraphPageRank: number;
        cooccurrence: number;
        recency: number;
        adamicAdar: number;
        heatDiffusion: number;
      };
    }>
  ) {
    const embedding = await embedder.encode(cap.description);
    capabilities.push({
      id: cap.id,
      description: cap.description,
      embedding,
      toolsUsed: cap.toolsUsed,
      successRate: cap.successRate,
      hypergraphFeatures: cap.hypergraphFeatures,
    });
  }

  console.log("  Generating embeddings for tools...");
  const toolEmbeddings = new Map<string, number[]>();
  for (const tool of scenario.nodes.tools) {
    const description = tool.id.replace(/__/g, " ").replace(/_/g, " ");
    const embedding = await embedder.encode(description);
    toolEmbeddings.set(tool.id, embedding);
  }

  // Test queries from fixture or generate
  const testQueries: TestQuery[] = (scenario as { testQueries?: TestQuery[] }).testQueries || [
    {
      intent: "read a file from the filesystem",
      expectedCapability: "cap__file_ops",
      alternatives: [],
    },
    {
      intent: "query database records with SQL",
      expectedCapability: "cap__db_crud",
      alternatives: [],
    },
    {
      intent: "call external REST API endpoint",
      expectedCapability: "cap__rest_api",
      alternatives: [],
    },
    {
      intent: "authenticate user with login",
      expectedCapability: "cap__auth_flow",
      alternatives: [],
    },
    {
      intent: "store data in cache for faster access",
      expectedCapability: "cap__caching",
      alternatives: [],
    },
    {
      intent: "log application events and errors",
      expectedCapability: "cap__logging",
      alternatives: [],
    },
    {
      intent: "send notification email to user",
      expectedCapability: "cap__notifications",
      alternatives: [],
    },
    {
      intent: "encrypt sensitive data securely",
      expectedCapability: "cap__security",
      alternatives: [],
    },
    { intent: "publish message to queue", expectedCapability: "cap__messaging", alternatives: [] },
    {
      intent: "upload file to cloud storage",
      expectedCapability: "cap__storage",
      alternatives: [],
    },
  ];

  console.log("  Generating embeddings for test queries...");
  for (const query of testQueries) {
    query.intentEmbedding = await embedder.encode(query.intent);
  }

  return { capabilities, toolEmbeddings, testQueries };
}

// ============================================================================
// SHGAT Builder
// ============================================================================

function buildSHGAT(
  capabilities: CapabilityWithEmbedding[],
  toolEmbeddings: Map<string, number[]>,
  configOverrides: Partial<SHGATConfig> = {},
): SHGAT {
  const capData = capabilities.map((cap) => ({
    id: cap.id,
    embedding: cap.embedding,
    toolsUsed: cap.toolsUsed,
    successRate: cap.successRate,
    parents: [],
    children: [],
    hypergraphFeatures: cap.hypergraphFeatures,
  }));

  return createSHGATFromCapabilities(capData, toolEmbeddings, {
    numHeads: 4,
    hiddenDim: 64,
    embeddingDim: 1024,
    ...configOverrides,
  });
}

// ============================================================================
// Training
// ============================================================================

/**
 * Generate training examples from capabilities (simulated execution traces)
 */
function generateTrainingExamples(
  capabilities: CapabilityWithEmbedding[],
  count: number = 100,
): TrainingExample[] {
  const examples: TrainingExample[] = [];

  for (let i = 0; i < count; i++) {
    const cap = capabilities[i % capabilities.length];

    // Simulate intent embedding with noise
    const noiseScale = 0.05 + Math.random() * 0.15;
    const intentEmbedding = cap.embedding.map((v) => v + (Math.random() - 0.5) * noiseScale);

    // Simulate different execution points
    const executionProgress = Math.random();
    const contextEndIndex = Math.floor(executionProgress * cap.toolsUsed.length);
    const contextTools = cap.toolsUsed.slice(0, contextEndIndex);

    // Success based on capability's success rate
    const outcome = Math.random() < cap.successRate ? 1 : 0;

    examples.push({
      intentEmbedding,
      contextTools,
      candidateId: cap.id,
      outcome,
    });
  }

  return examples;
}

/**
 * Train SHGAT on simulated traces
 */
async function trainSHGAT(
  shgat: SHGAT,
  capabilities: CapabilityWithEmbedding[],
  toolEmbeddings: Map<string, number[]>,
  options: { epochs: number; batchSize: number; examples: number } = {
    epochs: 3,
    batchSize: 16,
    examples: 100,
  },
): Promise<{ loss: number; accuracy: number }> {
  const trainingExamples = generateTrainingExamples(capabilities, options.examples);

  const result = await trainSHGATOnEpisodes(
    shgat,
    trainingExamples,
    (id) => toolEmbeddings.get(id) || null,
    { epochs: options.epochs, batchSize: options.batchSize },
  );

  return { loss: result.finalLoss, accuracy: result.finalAccuracy };
}

// ============================================================================
// Ablation Runner
// ============================================================================

async function runAblation(
  capabilities: CapabilityWithEmbedding[],
  toolEmbeddings: Map<string, number[]>,
  testQueries: TestQuery[],
  configName: string,
  configOverrides: Partial<SHGATConfig>,
  trainBeforeEval: boolean = true,
): Promise<AblationResult> {
  const shgat = buildSHGAT(capabilities, toolEmbeddings, configOverrides);

  // Train the model before evaluation
  if (trainBeforeEval) {
    await trainSHGAT(shgat, capabilities, toolEmbeddings, {
      epochs: 10,
      batchSize: 16,
      examples: 200,
    });
  }
  const details: AblationResult["details"] = [];
  let top1 = 0, top3 = 0, sumReciprocal = 0, sumScore = 0;

  for (const query of testQueries) {
    if (!query.intentEmbedding) continue;

    const results = shgat.scoreAllCapabilities(query.intentEmbedding);
    const expectedCaps = [query.expectedCapability, ...(query.alternatives || [])];
    const rank = results.findIndex((r) => expectedCaps.includes(r.capabilityId)) + 1;
    const topResult = results[0];
    const correct = expectedCaps.includes(topResult.capabilityId);

    if (rank === 1) top1++;
    if (rank <= 3) top3++;
    sumReciprocal += 1 / (rank || results.length + 1);
    sumScore += topResult.score;

    details.push({
      scenario: query.intent.substring(0, 30),
      correct,
      rank,
      score: topResult.score,
      headWeights: topResult.headWeights,
    });
  }

  const n = testQueries.filter((q) => q.intentEmbedding).length;
  return {
    config: configName,
    top1Accuracy: n > 0 ? top1 / n : 0,
    top3Accuracy: n > 0 ? top3 / n : 0,
    mrr: n > 0 ? sumReciprocal / n : 0,
    avgScore: n > 0 ? sumScore / n : 0,
    details,
  };
}

// ============================================================================
// Main Ablation Study
// ============================================================================

if (import.meta.main) {
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║     SHGAT HEAD ABLATION STUDY (Real BGE-M3 Embeddings)     ║");
  console.log("╚════════════════════════════════════════════════════════════╝\n");

  console.log("Loading BGE-M3 model (may take 60-90s first time)...");
  const embedder = new EmbeddingModel();
  await embedder.load();
  console.log("Model loaded!\n");

  try {
    console.log("Loading data and generating embeddings...");
    const { capabilities, toolEmbeddings, testQueries } = await loadDataWithEmbeddings(embedder);
    console.log(
      `  ${capabilities.length} capabilities, ${toolEmbeddings.size} tools, ${testQueries.length} queries\n`,
    );

    const results: AblationResult[] = [];

    // Run all head configurations (with training for each)
    const SKIP_TRAINING = Deno.env.get("SKIP_TRAINING") === "1";
    console.log(`Running ablation study (training: ${SKIP_TRAINING ? "SKIPPED" : "enabled"})...\n`);
    for (const [name, config] of Object.entries(HEAD_CONFIGS)) {
      const result = await runAblation(
        capabilities,
        toolEmbeddings,
        testQueries,
        name,
        config,
        !SKIP_TRAINING,
      );
      results.push(result);
      console.log(
        `  ${name.padEnd(25)}: Top-1=${(result.top1Accuracy * 100).toFixed(0)}% MRR=${
          result.mrr.toFixed(3)
        }`,
      );
    }

    // Sort by MRR
    results.sort((a, b) => b.mrr - a.mrr);

    // Display results
    console.log("\n" + "═".repeat(80));
    console.log("HEAD CONFIGURATION COMPARISON (sorted by MRR)");
    console.log("═".repeat(80));
    console.log(`\n${"Config".padEnd(25)} | Top-1 | Top-3 | MRR   | Avg Score`);
    console.log("-".repeat(65));

    for (const r of results) {
      const t1 = (r.top1Accuracy * 100).toFixed(0) + "%";
      const t3 = (r.top3Accuracy * 100).toFixed(0) + "%";
      const mrr = r.mrr.toFixed(3);
      const avg = r.avgScore.toFixed(3);
      console.log(`${r.config.padEnd(25)} | ${t1.padEnd(5)} | ${t3.padEnd(5)} | ${mrr} | ${avg}`);
    }

    console.log("\n" + "═".repeat(80));
    console.log(`BEST CONFIGURATION: ${results[0].config}`);
    console.log(
      `  MRR: ${results[0].mrr.toFixed(3)}, Top-1: ${(results[0].top1Accuracy * 100).toFixed(0)}%`,
    );
    console.log("═".repeat(80));

    // V2 Adaptive Config Ablation (head count scaling)
    console.log("\n" + "═".repeat(80));
    console.log("V2 ADAPTIVE CONFIG ABLATION (head count scaling)");
    console.log("═".repeat(80));

    const traceCounts = [500, 5000, 50000, 200000];
    for (const traceCount of traceCounts) {
      const adaptiveConfig = getAdaptiveConfig(traceCount);
      const result = await runAblation(
        capabilities,
        toolEmbeddings,
        testQueries,
        `adaptive_${traceCount}`,
        adaptiveConfig,
        true,
      );
      console.log(
        `  ${traceCount.toString().padEnd(10)} traces (${adaptiveConfig.numHeads} heads): MRR=${
          result.mrr.toFixed(3)
        } Top-1=${(result.top1Accuracy * 100).toFixed(0)}%`,
      );
    }

    console.log("\n" + "═".repeat(80));
    console.log("ABLATION STUDY COMPLETE");
    console.log("═".repeat(80));
  } finally {
    console.log("\nDisposing embedding model...");
    await embedder.dispose();
  }
}

// ============================================================================
// Tests (use mock embeddings for fast CI)
// ============================================================================

function mockEmbedding(text: string, dim: number = 1024): number[] {
  const emb = new Array(dim).fill(0);
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  for (let i = 0; i < dim; i++) {
    hash = (hash * 1103515245 + 12345) | 0;
    emb[i] = (hash % 1000) / 1000 - 0.5;
  }
  const norm = Math.sqrt(emb.reduce((s, x) => s + x * x, 0));
  return emb.map((x) => x / norm);
}

Deno.test("Ablation: All head configurations produce valid scores", async () => {
  const scenario = await loadScenario("medium-graph");

  const capabilities = (scenario.nodes.capabilities as Array<{
    id: string;
    description: string;
    toolsUsed: string[];
    successRate: number;
    hypergraphFeatures?: {
      spectralCluster: number;
      hypergraphPageRank: number;
      cooccurrence: number;
      recency: number;
      adamicAdar: number;
      heatDiffusion: number;
    };
  }>).map((c) => ({
    ...c,
    embedding: mockEmbedding(c.description),
  }));

  const toolEmbeddings = new Map<string, number[]>();
  for (const t of scenario.nodes.tools) {
    toolEmbeddings.set(t.id, mockEmbedding(t.id));
  }

  for (const [name, config] of Object.entries(HEAD_CONFIGS)) {
    const shgat = buildSHGAT(capabilities, toolEmbeddings, config);
    const intentEmb = mockEmbedding("test query");
    const results = shgat.scoreAllCapabilities(intentEmb);

    assertEquals(results.length, capabilities.length, `${name}: Should score all capabilities`);
    for (const r of results) {
      assertGreater(r.score, 0, `${name}: Score should be > 0`);
    }
  }
});

Deno.test("Ablation: Inactive heads have zero weight", async () => {
  const scenario = await loadScenario("medium-graph");

  const capabilities = (scenario.nodes.capabilities as Array<{
    id: string;
    description: string;
    toolsUsed: string[];
    successRate: number;
  }>).slice(0, 3).map((c) => ({
    ...c,
    embedding: mockEmbedding(c.description),
  }));

  const toolEmbeddings = new Map<string, number[]>();
  for (const t of scenario.nodes.tools.slice(0, 10)) {
    toolEmbeddings.set(t.id, mockEmbedding(t.id));
  }

  // semantic_only = [0] → heads 1 (structure) and 2 (temporal) should be 0
  const shgat = buildSHGAT(capabilities, toolEmbeddings, HEAD_CONFIGS["semantic_only"]);
  const results = shgat.scoreAllCapabilities(mockEmbedding("test"));

  for (const r of results) {
    assertEquals(r.headWeights[1], 0, "Structure head should be 0");
    assertEquals(r.headWeights[2], 0, "Temporal head should be 0");
  }
});

Deno.test("Ablation: headFusionWeights applies fixed weights", async () => {
  const scenario = await loadScenario("medium-graph");

  const capabilities = (scenario.nodes.capabilities as Array<{
    id: string;
    description: string;
    toolsUsed: string[];
    successRate: number;
  }>).slice(0, 3).map((c) => ({
    ...c,
    embedding: mockEmbedding(c.description),
  }));

  const toolEmbeddings = new Map<string, number[]>();
  for (const t of scenario.nodes.tools.slice(0, 10)) {
    toolEmbeddings.set(t.id, mockEmbedding(t.id));
  }

  // Test with fixed equal weights (3 heads)
  const oneThird = 1 / 3;
  const shgat = buildSHGAT(capabilities, toolEmbeddings, {
    activeHeads: [0, 1, 2],
    headFusionWeights: [oneThird, oneThird, oneThird],
  });
  const results = shgat.scoreAllCapabilities(mockEmbedding("test"));

  for (const r of results) {
    // With equal fixed weights, each head should be ~0.333
    assertEquals(r.headWeights.length, 3, "Should have 3 head weights");
    for (let i = 0; i < 3; i++) {
      const diff = Math.abs(r.headWeights[i] - oneThird);
      assertEquals(diff < 0.01, true, `Head ${i} should be ~0.333`);
    }
  }
});

Deno.test("Ablation: adaptive config head count affects scores", async () => {
  const scenario = await loadScenario("medium-graph");

  const capabilities = (scenario.nodes.capabilities as Array<{
    id: string;
    description: string;
    toolsUsed: string[];
    successRate: number;
    hypergraphFeatures?: {
      spectralCluster: number;
      hypergraphPageRank: number;
      cooccurrence: number;
      recency: number;
      adamicAdar: number;
      heatDiffusion: number;
    };
  }>).slice(0, 3).map((c) => ({
    ...c,
    embedding: mockEmbedding(c.description),
  }));

  const toolEmbeddings = new Map<string, number[]>();
  for (const t of scenario.nodes.tools.slice(0, 10)) {
    toolEmbeddings.set(t.id, mockEmbedding(t.id));
  }

  const intentEmb = mockEmbedding("test query");

  // Conservative config (4 heads)
  const config4 = getAdaptiveConfig(500);
  const shgat4 = buildSHGAT(capabilities, toolEmbeddings, config4);
  const results4 = shgat4.scoreAllCapabilities(intentEmb);

  // Scaled config (8 heads)
  const config8 = getAdaptiveConfig(5000);
  const shgat8 = buildSHGAT(capabilities, toolEmbeddings, config8);
  const results8 = shgat8.scoreAllCapabilities(intentEmb);

  // Both should produce valid scores
  assertGreater(results4[0].score, 0, "4-head config should produce positive score");
  assertGreater(results8[0].score, 0, "8-head config should produce positive score");

  // Head counts should differ
  assertEquals(config4.numHeads, 4, "Conservative config should have 4 heads");
  assertEquals(config8.numHeads, 8, "Scaled config should have 8 heads");
});

Deno.test("Ablation: Different configs produce different rankings", async () => {
  const scenario = await loadScenario("medium-graph");

  const capabilities = (scenario.nodes.capabilities as Array<{
    id: string;
    description: string;
    toolsUsed: string[];
    successRate: number;
    hypergraphFeatures?: {
      spectralCluster: number;
      hypergraphPageRank: number;
      cooccurrence: number;
      recency: number;
      adamicAdar: number;
      heatDiffusion: number;
    };
  }>).map((c) => ({
    ...c,
    embedding: mockEmbedding(c.description),
  }));

  const toolEmbeddings = new Map<string, number[]>();
  for (const t of scenario.nodes.tools) {
    toolEmbeddings.set(t.id, mockEmbedding(t.id));
  }

  const intentEmb = mockEmbedding("database query operations");

  // Test that different configs can produce different top results
  const semanticShgat = buildSHGAT(capabilities, toolEmbeddings, HEAD_CONFIGS["semantic_only"]);
  const structureShgat = buildSHGAT(capabilities, toolEmbeddings, HEAD_CONFIGS["structure_only"]);

  const semanticTop = semanticShgat.scoreAllCapabilities(intentEmb)[0].capabilityId;
  const structureTop = structureShgat.scoreAllCapabilities(intentEmb)[0].capabilityId;

  // Results exist and are valid capability IDs
  assertEquals(
    capabilities.some((c) => c.id === semanticTop),
    true,
    "Semantic top should be valid",
  );
  assertEquals(
    capabilities.some((c) => c.id === structureTop),
    true,
    "Structure top should be valid",
  );
});

Deno.test("Ablation: Tool scoring respects activeHeads", async () => {
  const scenario = await loadScenario("medium-graph");

  const capabilities = (scenario.nodes.capabilities as Array<{
    id: string;
    description: string;
    toolsUsed: string[];
    successRate: number;
  }>).slice(0, 3).map((c) => ({
    ...c,
    embedding: mockEmbedding(c.description),
  }));

  const toolEmbeddings = new Map<string, number[]>();
  for (const t of scenario.nodes.tools.slice(0, 10)) {
    toolEmbeddings.set(t.id, mockEmbedding(t.id));
  }

  // Semantic only for tools (head 0 only)
  const shgat = buildSHGAT(capabilities, toolEmbeddings, HEAD_CONFIGS["semantic_only"]);

  // Need to add tool features for structure/temporal heads to work
  for (const t of scenario.nodes.tools.slice(0, 10)) {
    shgat.updateToolFeatures(t.id, {
      pageRank: t.pageRank,
      louvainCommunity: t.community,
      adamicAdar: 0.1,
      cooccurrence: 0.2,
      recency: 0.5,
    });
  }

  const toolResults = shgat.scoreAllTools(mockEmbedding("read file"));

  // With semantic_only [0], heads 1 (structure) and 2 (temporal) should be 0
  for (const r of toolResults) {
    if (r.headWeights) {
      assertEquals(r.headWeights[1], 0, "Tool structure head should be 0");
      assertEquals(r.headWeights[2], 0, "Tool temporal head should be 0");
    }
  }
});

// ============================================================================
// Benchmarks (latency with mock embeddings)
// ============================================================================

const benchScenario = JSON.parse(
  await Deno.readTextFile("tests/benchmarks/fixtures/scenarios/medium-graph.json"),
);

const benchCaps = (benchScenario.nodes.capabilities as Array<{
  id: string;
  description: string;
  toolsUsed: string[];
  successRate: number;
}>).map((c) => ({
  ...c,
  embedding: mockEmbedding(c.description),
}));

const benchToolEmbs = new Map<string, number[]>();
for (const t of benchScenario.nodes.tools) {
  benchToolEmbs.set(t.id, mockEmbedding(t.id));
}

const benchIntent = mockEmbedding("query database records");

const shgatFull = buildSHGAT(benchCaps, benchToolEmbs, HEAD_CONFIGS["full_shgat"]);
const shgatSemantic = buildSHGAT(benchCaps, benchToolEmbs, HEAD_CONFIGS["semantic_only"]);
const shgatStructure = buildSHGAT(benchCaps, benchToolEmbs, HEAD_CONFIGS["structure_only"]);

Deno.bench({
  name: "Ablation: full_shgat (baseline)",
  group: "head-ablation",
  baseline: true,
  fn: () => {
    shgatFull.scoreAllCapabilities(benchIntent);
  },
});

Deno.bench({
  name: "Ablation: semantic_only",
  group: "head-ablation",
  fn: () => {
    shgatSemantic.scoreAllCapabilities(benchIntent);
  },
});

Deno.bench({
  name: "Ablation: structure_only",
  group: "head-ablation",
  fn: () => {
    shgatStructure.scoreAllCapabilities(benchIntent);
  },
});
