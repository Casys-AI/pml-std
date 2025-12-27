/**
 * Capability Match Benchmarks
 *
 * Benchmarks for capability matching (semantic * reliability).
 * Tests vector search integration and reliability filtering.
 *
 * Run: deno bench --allow-all tests/benchmarks/strategic/capability-match.bench.ts
 *
 * @module tests/benchmarks/strategic/capability-match
 */

import { generateStressGraph, loadScenario } from "../fixtures/scenario-loader.ts";

// ============================================================================
// Setup
// ============================================================================

const smallScenario = await loadScenario("small-graph");
const mediumScenario = await loadScenario("medium-graph");

// Mock capability data with varying success rates
interface MockCapability {
  id: string;
  description: string;
  toolsUsed: string[];
  successRate: number;
  embedding?: number[];
}

// Create mock capabilities with embeddings (1024-dim for BGE-M3)
function generateMockEmbedding(): number[] {
  return Array(1024).fill(0).map(() => Math.random() - 0.5);
}

const smallCapabilities: MockCapability[] = smallScenario.nodes.capabilities.map((c) => ({
  id: c.id,
  description: `Capability for ${c.id.replace("cap__", "")}`,
  toolsUsed: c.toolsUsed,
  successRate: c.successRate,
  embedding: generateMockEmbedding(),
}));

const mediumCapabilities: MockCapability[] = mediumScenario.nodes.capabilities.map((c) => ({
  id: c.id,
  description: `Capability for ${c.id.replace("cap__", "")}`,
  toolsUsed: c.toolsUsed,
  successRate: c.successRate,
  embedding: generateMockEmbedding(),
}));

// Generate stress capabilities
const stressScenario = generateStressGraph({
  toolCount: 200,
  capabilityCount: 50,
  metaCapabilityCount: 10,
  edgeDensity: 0.1,
  toolsPerCapability: { min: 4, max: 10 },
  capabilitiesPerMeta: { min: 4, max: 8 },
});

const stressCapabilities: MockCapability[] = stressScenario.nodes.capabilities.map((c) => ({
  id: c.id,
  description: `Generated capability ${c.id}`,
  toolsUsed: c.toolsUsed,
  successRate: c.successRate,
  embedding: generateMockEmbedding(),
}));

// ============================================================================
// Mock Functions (simulating real capability matching)
// ============================================================================

function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

function calculateReliabilityFactor(successRate: number): number {
  if (successRate < 0.5) return 0.1; // Disqualification
  if (successRate > 0.9) return 1.2; // Bonus
  return 0.5 + (successRate - 0.5) * 1.5; // Linear interpolation
}

function mockCapabilityMatch(
  intentEmbedding: number[],
  capabilities: MockCapability[],
  threshold: number = 0.6,
): MockCapability | null {
  let bestMatch: MockCapability | null = null;
  let bestScore = threshold;

  for (const cap of capabilities) {
    if (!cap.embedding) continue;

    const semanticScore = cosineSimilarity(intentEmbedding, cap.embedding);
    const reliabilityFactor = calculateReliabilityFactor(cap.successRate);
    const finalScore = semanticScore * reliabilityFactor;

    if (finalScore > bestScore) {
      bestScore = finalScore;
      bestMatch = cap;
    }
  }

  return bestMatch;
}

function mockFindTopMatches(
  intentEmbedding: number[],
  capabilities: MockCapability[],
  k: number = 5,
): Array<{ capability: MockCapability; score: number }> {
  const scored = capabilities
    .filter((c) => c.embedding)
    .map((cap) => {
      const semanticScore = cosineSimilarity(intentEmbedding, cap.embedding!);
      const reliabilityFactor = calculateReliabilityFactor(cap.successRate);
      return { capability: cap, score: semanticScore * reliabilityFactor };
    })
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, k);
}

// ============================================================================
// Benchmarks: Single Match
// ============================================================================

const testIntent = generateMockEmbedding();

Deno.bench({
  name: "CapabilityMatch: single match (small, 3 caps)",
  group: "match-single",
  baseline: true,
  fn: () => {
    mockCapabilityMatch(testIntent, smallCapabilities);
  },
});

Deno.bench({
  name: "CapabilityMatch: single match (medium, 10 caps)",
  group: "match-single",
  fn: () => {
    mockCapabilityMatch(testIntent, mediumCapabilities);
  },
});

Deno.bench({
  name: "CapabilityMatch: single match (stress, 50 caps)",
  group: "match-single",
  fn: () => {
    mockCapabilityMatch(testIntent, stressCapabilities);
  },
});

// ============================================================================
// Benchmarks: Top-K Matches
// ============================================================================

Deno.bench({
  name: "CapabilityMatch: top-3 (medium)",
  group: "match-topk",
  baseline: true,
  fn: () => {
    mockFindTopMatches(testIntent, mediumCapabilities, 3);
  },
});

Deno.bench({
  name: "CapabilityMatch: top-5 (medium)",
  group: "match-topk",
  fn: () => {
    mockFindTopMatches(testIntent, mediumCapabilities, 5);
  },
});

Deno.bench({
  name: "CapabilityMatch: top-10 (stress)",
  group: "match-topk",
  fn: () => {
    mockFindTopMatches(testIntent, stressCapabilities, 10);
  },
});

// ============================================================================
// Benchmarks: Threshold Variations
// ============================================================================

Deno.bench({
  name: "CapabilityMatch: threshold=0.5 (lenient)",
  group: "match-threshold",
  baseline: true,
  fn: () => {
    mockCapabilityMatch(testIntent, mediumCapabilities, 0.5);
  },
});

Deno.bench({
  name: "CapabilityMatch: threshold=0.7 (default)",
  group: "match-threshold",
  fn: () => {
    mockCapabilityMatch(testIntent, mediumCapabilities, 0.7);
  },
});

Deno.bench({
  name: "CapabilityMatch: threshold=0.9 (strict)",
  group: "match-threshold",
  fn: () => {
    mockCapabilityMatch(testIntent, mediumCapabilities, 0.9);
  },
});

// ============================================================================
// Benchmarks: Reliability Factor Impact
// ============================================================================

// Create capabilities with varying success rates
const lowReliabilityCaps = mediumCapabilities.map((c) => ({ ...c, successRate: 0.4 }));
const highReliabilityCaps = mediumCapabilities.map((c) => ({ ...c, successRate: 0.95 }));

Deno.bench({
  name: "CapabilityMatch: low reliability caps",
  group: "match-reliability",
  baseline: true,
  fn: () => {
    mockCapabilityMatch(testIntent, lowReliabilityCaps);
  },
});

Deno.bench({
  name: "CapabilityMatch: high reliability caps",
  group: "match-reliability",
  fn: () => {
    mockCapabilityMatch(testIntent, highReliabilityCaps);
  },
});

Deno.bench({
  name: "CapabilityMatch: mixed reliability caps",
  group: "match-reliability",
  fn: () => {
    mockCapabilityMatch(testIntent, mediumCapabilities);
  },
});

// ============================================================================
// Benchmarks: Cosine Similarity Only (baseline)
// ============================================================================

Deno.bench({
  name: "CosineSimilarity: 1024-dim vectors",
  group: "similarity",
  baseline: true,
  fn: () => {
    const a = generateMockEmbedding();
    const b = generateMockEmbedding();
    cosineSimilarity(a, b);
  },
});

Deno.bench({
  name: "CosineSimilarity: batch (10 comparisons)",
  group: "similarity",
  fn: () => {
    const intent = generateMockEmbedding();
    for (let i = 0; i < 10; i++) {
      const cap = generateMockEmbedding();
      cosineSimilarity(intent, cap);
    }
  },
});

// ============================================================================
// Cleanup
// ============================================================================

globalThis.addEventListener("unload", () => {
  console.log("\nCapability Match Benchmark Summary:");
  console.log(`- Small: ${smallCapabilities.length} capabilities`);
  console.log(`- Medium: ${mediumCapabilities.length} capabilities`);
  console.log(`- Stress: ${stressCapabilities.length} capabilities`);
  console.log(`- Embedding dimension: 1024 (BGE-M3)`);
});
