/**
 * End-to-End Pipeline Benchmark: BGE + Node2Vec+ + SHGAT V1
 *
 * Tests the complete capability matching pipeline:
 * 1. BGE-M3 embeddings (semantic similarity)
 * 2. Node2Vec+ embeddings (structural graph patterns with edge weights)
 * 3. Hybrid embedding fusion (weighted combination)
 * 4. SHGAT V1 K-head attention scoring
 *
 * Metrics: MRR, Hit@1, Hit@3, Hit@5
 *
 * Run: deno run --allow-all tests/benchmarks/e2e-pipeline.bench.ts
 */

import { loadScenario } from "./fixtures/scenario-loader.ts";
import {
  createSHGATFromCapabilities,
  seedRng as seedSHGATRng,
  trainSHGATOnEpisodesKHead,
} from "../../src/graphrag/algorithms/shgat.ts";
import Graph from "npm:graphology";
import { Matrix, SingularValueDecomposition } from "npm:ml-matrix";

// ============================================================================
// Seeded PRNG for reproducibility (mulberry32)
// ============================================================================
let rngState = 42; // Default seed

function seedRng(seed: number): void {
  rngState = seed;
}

function random(): number {
  rngState |= 0;
  rngState = (rngState + 0x6D2B79F5) | 0;
  let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// Reset seed for each benchmark run (both Node2Vec and SHGAT)
seedRng(42);
seedSHGATRng(42);

console.log("╔════════════════════════════════════════════════════════════════════╗");
console.log("║    END-TO-END PIPELINE BENCHMARK: BGE + Node2Vec+ + SHGAT V1       ║");
console.log("╚════════════════════════════════════════════════════════════════════╝\n");

// ============================================================================
// Load Data
// ============================================================================

const scenario = await loadScenario("production-traces");

interface Cap {
  id: string;
  embedding?: number[];
  toolsUsed?: string[];
  successRate?: number;
  parents?: string[];
  children?: string[];
}

interface Event {
  intentEmbedding?: number[];
  contextTools?: string[];
  selectedCapability: string;
  outcome: string;
}

interface Query {
  intentEmbedding?: number[];
  expectedCapability: string;
  intent?: string;
}

const allCaps: Cap[] = scenario.nodes.capabilities.filter(
  (c: Cap) => c.embedding?.length
);
const allEvents: Event[] = (scenario as unknown as { episodicEvents?: Event[] }).episodicEvents || [];

// Use all capabilities (no filtering)
const caps = allCaps;
const events = allEvents;

// Convert ALL events to evaluation queries (no train/test split)
// This gives us 122 evaluation points instead of 24
const queries: Query[] = allEvents
  .filter((e) => e.intentEmbedding?.length && e.outcome === "success")
  .map((e) => ({
    intentEmbedding: e.intentEmbedding,
    expectedCapability: e.selectedCapability,
  }));

// Build tool index with co-occurrence counts (edge weights)
const allTools = new Set<string>();
const toolCooccurrence = new Map<string, Map<string, number>>();

caps.forEach((c) => {
  const tools = c.toolsUsed || [];
  tools.forEach((t) => allTools.add(t));

  // Count tool co-occurrences within capability
  for (let i = 0; i < tools.length; i++) {
    for (let j = i + 1; j < tools.length; j++) {
      const t1 = tools[i];
      const t2 = tools[j];
      if (!toolCooccurrence.has(t1)) toolCooccurrence.set(t1, new Map());
      if (!toolCooccurrence.has(t2)) toolCooccurrence.set(t2, new Map());
      toolCooccurrence.get(t1)!.set(t2, (toolCooccurrence.get(t1)!.get(t2) || 0) + 1);
      toolCooccurrence.get(t2)!.set(t1, (toolCooccurrence.get(t2)!.get(t1) || 0) + 1);
    }
  }
});

// Add edge weights from episodic events (sequential co-occurrence)
for (const event of events) {
  const tools = event.contextTools || [];
  for (let i = 0; i < tools.length - 1; i++) {
    const t1 = tools[i];
    const t2 = tools[i + 1];
    if (!toolCooccurrence.has(t1)) toolCooccurrence.set(t1, new Map());
    if (!toolCooccurrence.has(t2)) toolCooccurrence.set(t2, new Map());
    toolCooccurrence.get(t1)!.set(t2, (toolCooccurrence.get(t1)!.get(t2) || 0) + 1);
    toolCooccurrence.get(t2)!.set(t1, (toolCooccurrence.get(t2)!.get(t1) || 0) + 1);
  }
}

const toolList = [...allTools];
const edgeWeightCount = [...toolCooccurrence.values()].reduce((s, m) => s + m.size, 0);

console.log("📊 Dataset Summary:");
console.log(`   Capabilities: ${caps.length}`);
console.log(`   Tools: ${toolList.length}`);
console.log(`   Events: ${events.length}`);
console.log(`   Test queries: ${queries.length}`);
console.log(`   Edge weights: ${edgeWeightCount} tool-tool pairs\n`);

// ============================================================================
// Node2Vec+ Implementation (Edge Weight-Aware)
// ============================================================================

interface NodeStats {
  mean: number;
  std: number;
}

function computeNodeStats(graph: Graph, nodeId: string): NodeStats {
  const neighbors = graph.neighbors(nodeId);
  if (neighbors.length === 0) return { mean: 0, std: 0 };

  const weights: number[] = [];
  for (const neighbor of neighbors) {
    const weight = graph.getEdgeAttribute(nodeId, neighbor, "weight") || 1;
    weights.push(weight);
  }

  const mean = weights.reduce((a, b) => a + b, 0) / weights.length;
  const variance = weights.reduce((sum, w) => sum + (w - mean) ** 2, 0) / weights.length;
  const std = Math.sqrt(variance);

  return { mean, std };
}

function normalizedWeight(
  weight: number,
  nodeStats: NodeStats,
  gamma: number,
  epsilon: number = 1e-6
): number {
  return weight / Math.max(nodeStats.mean + gamma * nodeStats.std, epsilon);
}

interface Node2VecPlusConfig {
  walkLength: number;
  walksPerNode: number;
  windowSize: number;
  embeddingDim: number;
  p: number;
  q: number;
  gamma: number;
}

function generateNode2VecPlusEmbeddings(config: Node2VecPlusConfig): Map<string, number[]> {
  const { walkLength, walksPerNode, windowSize, embeddingDim, p, q, gamma } = config;

  // Build weighted graph
  const graph = new Graph({ multi: false, type: "undirected" });

  for (const tool of toolList) graph.addNode(tool, { type: "tool" });
  for (const cap of caps) graph.addNode(cap.id, { type: "capability" });

  // Add edges between capabilities and tools
  for (const cap of caps) {
    for (const tool of cap.toolsUsed || []) {
      if (graph.hasNode(tool)) {
        try {
          graph.addEdge(cap.id, tool, { weight: 1 });
        } catch { /* edge exists */ }
      }
    }
  }

  // Add weighted edges between tools (from co-occurrence)
  for (const [t1, neighbors] of toolCooccurrence) {
    if (!graph.hasNode(t1)) continue;
    for (const [t2, weight] of neighbors) {
      if (!graph.hasNode(t2)) continue;
      try {
        graph.addEdge(t1, t2, { weight });
      } catch {
        const existing = graph.getEdgeAttribute(t1, t2, "weight") || 0;
        graph.setEdgeAttribute(t1, t2, "weight", existing + weight);
      }
    }
  }

  // Pre-compute node stats for Node2Vec+
  const nodeStatsCache = new Map<string, NodeStats>();
  graph.forEachNode((node: string) => {
    nodeStatsCache.set(node, computeNodeStats(graph, node));
  });

  // Biased random walk with Node2Vec+ edge weight awareness
  function biasedRandomWalk(startNode: string): string[] {
    const walk = [startNode];
    let current = startNode;
    let prev: string | null = null;

    for (let i = 0; i < walkLength - 1; i++) {
      const neighbors = graph.neighbors(current);
      if (neighbors.length === 0) break;

      const weights: number[] = [];
      const currentStats = nodeStatsCache.get(current)!;

      for (const neighbor of neighbors) {
        const edgeWeight = graph.getEdgeAttribute(current, neighbor, "weight") || 1;

        let bias: number;
        if (prev && neighbor === prev) {
          // Return to previous node
          bias = 1 / p;
        } else if (prev && graph.hasEdge(prev, neighbor)) {
          // Connected to previous
          const w_tilde = normalizedWeight(
            graph.getEdgeAttribute(prev, neighbor, "weight") || 1,
            currentStats,
            gamma
          );
          if (w_tilde >= 1) {
            bias = 1; // Strongly connected
          } else {
            // Node2Vec+ interpolation
            bias = 1 / q + (1 - 1 / q) * w_tilde;
          }
        } else {
          // Not connected - DFS-like
          bias = 1 / q;
        }

        weights.push(edgeWeight * bias);
      }

      const totalWeight = weights.reduce((a, b) => a + b, 0);
      if (totalWeight === 0) break;

      const rand = random() * totalWeight;
      let cumSum = 0;
      let selectedIdx = 0;
      for (let j = 0; j < weights.length; j++) {
        cumSum += weights[j];
        if (rand < cumSum) {
          selectedIdx = j;
          break;
        }
      }

      prev = current;
      current = neighbors[selectedIdx];
      walk.push(current);
    }

    return walk;
  }

  // Build co-occurrence matrix from walks
  const capIdx = new Map<string, number>();
  caps.forEach((c, i) => capIdx.set(c.id, i));

  const cooccurrence = new Map<string, Map<string, number>>();
  for (const cap of caps) cooccurrence.set(cap.id, new Map());

  for (const cap of caps) {
    for (let w = 0; w < walksPerNode; w++) {
      const walk = biasedRandomWalk(cap.id);
      for (let i = 0; i < walk.length; i++) {
        if (walk[i] !== cap.id) continue;
        for (let j = Math.max(0, i - windowSize); j < Math.min(walk.length, i + windowSize + 1); j++) {
          if (i === j) continue;
          const other = walk[j];
          if (capIdx.has(other)) {
            const current = cooccurrence.get(cap.id)!.get(other) || 0;
            cooccurrence.get(cap.id)!.set(other, current + 1);
          }
        }
      }
    }
  }

  // PMI matrix and SVD
  const capList = caps.map((c) => c.id);
  const coocMatrix = new Array(caps.length).fill(0).map(() => new Array(caps.length).fill(0));
  let totalCooc = 0;

  for (let i = 0; i < caps.length; i++) {
    const cooc = cooccurrence.get(capList[i])!;
    for (let j = 0; j < caps.length; j++) {
      const count = cooc.get(capList[j]) || 0;
      coocMatrix[i][j] = count;
      totalCooc += count;
    }
  }

  const rowSums = coocMatrix.map((row) => row.reduce((a, b) => a + b, 0));
  const colSums = new Array(caps.length).fill(0);
  for (let j = 0; j < caps.length; j++) {
    for (let i = 0; i < caps.length; i++) {
      colSums[j] += coocMatrix[i][j];
    }
  }

  const pmiMatrix = new Array(caps.length).fill(0).map(() => new Array(caps.length).fill(0));
  for (let i = 0; i < caps.length; i++) {
    for (let j = 0; j < caps.length; j++) {
      if (coocMatrix[i][j] > 0 && rowSums[i] > 0 && colSums[j] > 0 && totalCooc > 0) {
        const pxy = coocMatrix[i][j] / totalCooc;
        const px = rowSums[i] / totalCooc;
        const py = colSums[j] / totalCooc;
        pmiMatrix[i][j] = Math.max(0, Math.log(pxy / (px * py)));
      }
    }
  }

  // SVD for embeddings
  const pmiMat = new Matrix(pmiMatrix);
  const svd = new SingularValueDecomposition(pmiMat);
  const U = svd.leftSingularVectors;
  const S = svd.diagonal;

  const embeddings = new Map<string, number[]>();
  for (let i = 0; i < caps.length; i++) {
    const emb: number[] = [];
    for (let d = 0; d < Math.min(embeddingDim, S.length); d++) {
      emb.push(U.get(i, d) * Math.sqrt(S[d]));
    }
    while (emb.length < embeddingDim) emb.push(0);
    const norm = Math.sqrt(emb.reduce((s, v) => s + v * v, 0)) || 1;
    embeddings.set(capList[i], emb.map((v) => v / norm));
  }

  return embeddings;
}

// ============================================================================
// Hybrid Embedding Builder
// ============================================================================

function buildHybridEmbeddings(
  n2vEmbeddings: Map<string, number[]>,
  bgeWeight: number,
  n2vDim: number
): Array<{
  id: string;
  embedding: number[];
  toolsUsed: string[];
  successRate: number;
  parents: string[];
  children: string[];
}> {
  const n2vWeight = 1 - bgeWeight;

  return caps.map((c) => {
    const bgeEmb = c.embedding!;
    const n2vEmb = n2vEmbeddings.get(c.id) || new Array(n2vDim).fill(0);
    const n2vPadded = [...n2vEmb, ...new Array(1024 - n2vEmb.length).fill(0)];
    const hybrid = bgeEmb.map((v, i) => v * bgeWeight + n2vPadded[i] * n2vWeight);
    const norm = Math.sqrt(hybrid.reduce((s, v) => s + v * v, 0)) || 1;
    return {
      id: c.id,
      embedding: hybrid.map((v) => v / norm),
      toolsUsed: c.toolsUsed || [],
      successRate: c.successRate || 0.5,
      parents: [] as string[],
      children: [] as string[],
    };
  });
}

// ============================================================================
// Evaluation Metrics
// ============================================================================

interface EvalResult {
  mrr: number;
  hit1: number;
  hit3: number;
  hit5: number;
  avgRank: number;
}

// Custom scoring using ORIGINAL embeddings (1024-dim) instead of propagated (64-dim)
function scoreWithOriginalEmbeddings(
  shgat: ReturnType<typeof createSHGATFromCapabilities>,
  intentEmbedding: number[],
  caps: Array<{ id: string; embedding: number[] }>
): Array<{ id: string; score: number }> {
  // Get head params for K-head scoring
  const headParams = (shgat as any).params.headParams;
  const numHeads = headParams.length;
  const hiddenDim = 64;

  const results: Array<{ id: string; score: number }> = [];

  for (const cap of caps) {
    const headScores: number[] = [];

    for (let h = 0; h < numHeads; h++) {
      const W_q = headParams[h].W_q; // [64][1024]
      const W_k = headParams[h].W_k; // [64][1024]

      // Q = W_q @ intent (use FULL 1024-dim intent)
      const Q = new Array(hiddenDim).fill(0);
      for (let i = 0; i < hiddenDim; i++) {
        for (let j = 0; j < intentEmbedding.length; j++) {
          Q[i] += W_q[i][j] * intentEmbedding[j];
        }
      }

      // K = W_k @ capEmbedding (use FULL 1024-dim original embedding)
      const K = new Array(hiddenDim).fill(0);
      for (let i = 0; i < hiddenDim; i++) {
        for (let j = 0; j < cap.embedding.length; j++) {
          K[i] += W_k[i][j] * cap.embedding[j];
        }
      }

      // score = sigmoid(Q·K / sqrt(dim))
      const dot = Q.reduce((s, v, i) => s + v * K[i], 0);
      const score = 1 / (1 + Math.exp(-dot / Math.sqrt(hiddenDim)));
      headScores.push(score);
    }

    const avgScore = headScores.reduce((a, b) => a + b, 0) / numHeads;
    results.push({ id: cap.id, score: avgScore });
  }

  return results.sort((a, b) => b.score - a.score);
}

function evaluateSHGAT(
  shgatCaps: Array<{
    id: string;
    embedding: number[];
    toolsUsed: string[];
    successRate: number;
    parents: string[];
    children: string[];
  }>,
  epochs: number = 1,
  learningRate: number = 0.001,
  useOriginalEmbeddings: boolean = false
): EvalResult {
  // Reset SHGAT seed for reproducible training
  seedSHGATRng(42);

  const shgat = createSHGATFromCapabilities(shgatCaps, new Map(), {
    numHeads: 4,
    hiddenDim: 64,
  });

  // Train on episodic events using K-head attention (V1 architecture)
  const trainingExamples = events
    .filter((e) => e.intentEmbedding?.length)
    .map((e) => ({
      intentEmbedding: e.intentEmbedding!,
      contextTools: e.contextTools || [],
      candidateId: e.selectedCapability,
      outcome: e.outcome === "success" ? 1 : 0,
    }));

  trainSHGATOnEpisodesKHead(shgat, trainingExamples, () => null, {
    epochs,
    learningRate,
  });

  // Evaluate on test queries
  let hits1 = 0, hits3 = 0, hits5 = 0, mrrSum = 0, rankSum = 0, evaluated = 0;

  // Debug: track score statistics
  let allScores: number[] = [];

  for (const query of queries) {
    if (!query.intentEmbedding?.length) continue;

    // Use original embeddings (1024-dim) or propagated (64-dim)?
    let sorted: Array<{ id: string; score: number }>;
    if (useOriginalEmbeddings) {
      sorted = scoreWithOriginalEmbeddings(shgat, query.intentEmbedding, shgatCaps);
      allScores.push(...sorted.map(r => r.score));
    } else {
      const results = shgat.scoreAllCapabilities(query.intentEmbedding);
      allScores.push(...results.map(r => r.score));
      sorted = results
        .map((r) => ({ id: r.capabilityId, score: r.score }))
        .sort((a, b) => b.score - a.score);
    }

    const idx = sorted.findIndex((s) => s.id === query.expectedCapability);
    const rank = idx >= 0 ? idx + 1 : shgatCaps.length;

    if (rank === 1) hits1++;
    if (rank <= 3) hits3++;
    if (rank <= 5) hits5++;
    if (idx >= 0) mrrSum += 1 / rank;
    rankSum += rank;
    evaluated++;
  }

  // Debug: print score stats for first eval only
  if (allScores.length > 0) {
    const minScore = Math.min(...allScores);
    const maxScore = Math.max(...allScores);
    const avgScore = allScores.reduce((a, b) => a + b, 0) / allScores.length;
    console.log(`      scores: min=${minScore.toFixed(4)}, max=${maxScore.toFixed(4)}, avg=${avgScore.toFixed(4)}`);
  }

  return {
    mrr: evaluated > 0 ? mrrSum / evaluated : 0,
    hit1: evaluated > 0 ? (hits1 / evaluated) * 100 : 0,
    hit3: evaluated > 0 ? (hits3 / evaluated) * 100 : 0,
    hit5: evaluated > 0 ? (hits5 / evaluated) * 100 : 0,
    avgRank: evaluated > 0 ? rankSum / evaluated : caps.length,
  };
}

// ============================================================================
// Run Benchmarks
// ============================================================================

interface BenchResult {
  name: string;
  mrr: number;
  hit1: number;
  hit3: number;
  hit5: number;
}

const results: BenchResult[] = [];

console.log("═".repeat(80));
console.log("                              BENCHMARK RESULTS");
console.log("═".repeat(80));
console.log(
  `${"Configuration".padEnd(45)} │ ${"MRR".padStart(6)} │ ${"H@1".padStart(6)} │ ${"H@3".padStart(6)} │ ${"H@5".padStart(6)}`
);
console.log("─".repeat(80));

function logResult(name: string, r: EvalResult) {
  console.log(
    `${name.padEnd(45)} │ ${r.mrr.toFixed(3).padStart(6)} │ ${(r.hit1.toFixed(1) + "%").padStart(6)} │ ${(r.hit3.toFixed(1) + "%").padStart(6)} │ ${(r.hit5.toFixed(1) + "%").padStart(6)}`
  );
  results.push({ name, ...r });
}

// ============================================================================
// 1. BGE-M3 Only (Baseline)
// ============================================================================

console.log("\n── BASELINE: BGE-M3 Only ──");

const bgeCaps = caps.map((c) => ({
  id: c.id,
  embedding: c.embedding!,
  toolsUsed: c.toolsUsed || [],
  successRate: c.successRate || 0.5,
  parents: [] as string[],
  children: [] as string[],
}));

// Debug: BGE embedding variance
const bgeEmbs = bgeCaps.map(c => c.embedding);
let bgeMinSim = 1, bgeMaxSim = -1, bgeAvgSim = 0, bgeSimCount = 0;
for (let i = 0; i < bgeEmbs.length; i++) {
  for (let j = i + 1; j < bgeEmbs.length; j++) {
    const dot = bgeEmbs[i].reduce((s, v, k) => s + v * bgeEmbs[j][k], 0);
    bgeMinSim = Math.min(bgeMinSim, dot);
    bgeMaxSim = Math.max(bgeMaxSim, dot);
    bgeAvgSim += dot;
    bgeSimCount++;
  }
}
bgeAvgSim /= bgeSimCount;
console.log(`   🔍 BGE embeddings sim range: [${bgeMinSim.toFixed(3)}, ${bgeMaxSim.toFixed(3)}], avg: ${bgeAvgSim.toFixed(3)}`);

const bgeResult = evaluateSHGAT(bgeCaps);
logResult("BGE-M3 only (baseline)", bgeResult);

// ============================================================================
// 2. Standard Node2Vec (No Edge Weights in Bias)
// ============================================================================

console.log("\n── Standard Node2Vec (uniform bias) ──");

// Reset seed for fair comparison
seedRng(42);

function generateStandardNode2VecEmbeddings(config: Omit<Node2VecPlusConfig, 'gamma'>): Map<string, number[]> {
  const { walkLength, walksPerNode, windowSize, embeddingDim, p, q } = config;

  // Build graph (same as Node2Vec+)
  const graph = new Graph({ multi: false, type: "undirected" });

  for (const tool of toolList) graph.addNode(tool, { type: "tool" });
  for (const cap of caps) graph.addNode(cap.id, { type: "capability" });

  for (const cap of caps) {
    for (const tool of cap.toolsUsed || []) {
      if (graph.hasNode(tool)) {
        try { graph.addEdge(cap.id, tool, { weight: 1 }); } catch { /* edge exists */ }
      }
    }
  }

  for (const [t1, neighbors] of toolCooccurrence) {
    if (!graph.hasNode(t1)) continue;
    for (const [t2, weight] of neighbors) {
      if (!graph.hasNode(t2)) continue;
      try { graph.addEdge(t1, t2, { weight }); } catch {
        const existing = graph.getEdgeAttribute(t1, t2, "weight") || 0;
        graph.setEdgeAttribute(t1, t2, "weight", existing + weight);
      }
    }
  }

  // Standard Node2Vec: bias based on connection only, NOT edge weight
  function standardRandomWalk(startNode: string): string[] {
    const walk = [startNode];
    let current = startNode;
    let prev: string | null = null;

    for (let i = 0; i < walkLength - 1; i++) {
      const neighbors = graph.neighbors(current);
      if (neighbors.length === 0) break;

      const weights: number[] = [];
      for (const neighbor of neighbors) {
        const edgeWeight = graph.getEdgeAttribute(current, neighbor, "weight") || 1;

        let bias: number;
        if (prev && neighbor === prev) {
          bias = 1 / p; // Return
        } else if (prev && graph.hasEdge(prev, neighbor)) {
          bias = 1; // Connected - ALWAYS 1, ignores edge weight
        } else {
          bias = 1 / q; // Not connected
        }

        weights.push(edgeWeight * bias);
      }

      const totalWeight = weights.reduce((a, b) => a + b, 0);
      if (totalWeight === 0) break;

      const rand = random() * totalWeight;
      let cumSum = 0;
      let selectedIdx = 0;
      for (let j = 0; j < weights.length; j++) {
        cumSum += weights[j];
        if (rand < cumSum) { selectedIdx = j; break; }
      }

      prev = current;
      current = neighbors[selectedIdx];
      walk.push(current);
    }
    return walk;
  }

  // Build co-occurrence matrix from walks
  const capIdx = new Map<string, number>();
  caps.forEach((c, i) => capIdx.set(c.id, i));

  const cooccurrence = new Map<string, Map<string, number>>();
  for (const cap of caps) cooccurrence.set(cap.id, new Map());

  for (const cap of caps) {
    for (let w = 0; w < walksPerNode; w++) {
      const walk = standardRandomWalk(cap.id);
      for (let i = 0; i < walk.length; i++) {
        if (walk[i] !== cap.id) continue;
        for (let j = Math.max(0, i - windowSize); j < Math.min(walk.length, i + windowSize + 1); j++) {
          if (i === j) continue;
          const other = walk[j];
          if (capIdx.has(other)) {
            const current = cooccurrence.get(cap.id)!.get(other) || 0;
            cooccurrence.get(cap.id)!.set(other, current + 1);
          }
        }
      }
    }
  }

  // PMI matrix and SVD (same as Node2Vec+)
  const capList = caps.map((c) => c.id);
  const coocMatrix = new Array(caps.length).fill(0).map(() => new Array(caps.length).fill(0));
  let totalCooc = 0;

  for (let i = 0; i < caps.length; i++) {
    const cooc = cooccurrence.get(capList[i])!;
    for (let j = 0; j < caps.length; j++) {
      const count = cooc.get(capList[j]) || 0;
      coocMatrix[i][j] = count;
      totalCooc += count;
    }
  }

  const rowSums = coocMatrix.map((row) => row.reduce((a, b) => a + b, 0));
  const colSums = new Array(caps.length).fill(0);
  for (let j = 0; j < caps.length; j++) {
    for (let i = 0; i < caps.length; i++) { colSums[j] += coocMatrix[i][j]; }
  }

  // Debug: check co-occurrence matrix
  const nonZeroCooc = coocMatrix.flat().filter(v => v > 0).length;
  console.log(`   🔍 Debug: totalCooc=${totalCooc}, non-zero pairs=${nonZeroCooc}`);

  const pmiMatrix = new Array(caps.length).fill(0).map(() => new Array(caps.length).fill(0));
  for (let i = 0; i < caps.length; i++) {
    for (let j = 0; j < caps.length; j++) {
      if (coocMatrix[i][j] > 0 && rowSums[i] > 0 && colSums[j] > 0 && totalCooc > 0) {
        const pxy = coocMatrix[i][j] / totalCooc;
        const px = rowSums[i] / totalCooc;
        const py = colSums[j] / totalCooc;
        pmiMatrix[i][j] = Math.max(0, Math.log(pxy / (px * py)));
      }
    }
  }

  const pmiMat = new Matrix(pmiMatrix);
  const svd = new SingularValueDecomposition(pmiMat);
  const U = svd.leftSingularVectors;
  const S = svd.diagonal;

  const embeddings = new Map<string, number[]>();
  for (let i = 0; i < caps.length; i++) {
    const emb: number[] = [];
    for (let d = 0; d < Math.min(embeddingDim, S.length); d++) {
      emb.push(U.get(i, d) * Math.sqrt(S[d]));
    }
    while (emb.length < embeddingDim) emb.push(0);
    const norm = Math.sqrt(emb.reduce((s, v) => s + v * v, 0)) || 1;
    embeddings.set(capList[i], emb.map((v) => v / norm));
  }

  return embeddings;
}

// Standard Node2Vec with same p/q as Node2Vec+
const n2vStandardConfig = { walkLength: 15, walksPerNode: 30, windowSize: 5, embeddingDim: 32, p: 2.0, q: 0.5 };
const n2vStandardEmb = generateStandardNode2VecEmbeddings(n2vStandardConfig);

// Debug: check Node2Vec embeddings variance
const embValues = [...n2vStandardEmb.values()];
const nonZeroCount = embValues.filter(e => e.some(v => Math.abs(v) > 0.001)).length;
const avgNorm = embValues.reduce((s, e) => s + Math.sqrt(e.reduce((a, b) => a + b*b, 0)), 0) / embValues.length;

// Check variance between embeddings (are they all the same?)
let minSim = 1, maxSim = -1, avgSim = 0, simCount = 0;
for (let i = 0; i < embValues.length; i++) {
  for (let j = i + 1; j < embValues.length; j++) {
    const dot = embValues[i].reduce((s, v, k) => s + v * embValues[j][k], 0);
    minSim = Math.min(minSim, dot);
    maxSim = Math.max(maxSim, dot);
    avgSim += dot;
    simCount++;
  }
}
avgSim /= simCount;
console.log(`   🔍 Debug: ${nonZeroCount}/${embValues.length} embeddings, sim range: [${minSim.toFixed(3)}, ${maxSim.toFixed(3)}], avg: ${avgSim.toFixed(3)}`);

for (const bgeWeight of [0.8, 0.7, 0.6]) {
  const hybridCaps = buildHybridEmbeddings(n2vStandardEmb, bgeWeight, n2vStandardConfig.embeddingDim);

  // Debug hybrid embeddings
  if (bgeWeight === 0.7) {
    const hybridEmbs = hybridCaps.map(c => c.embedding);
    let hMinSim = 1, hMaxSim = -1, hAvgSim = 0, hCount = 0;
    for (let i = 0; i < hybridEmbs.length; i++) {
      for (let j = i + 1; j < hybridEmbs.length; j++) {
        const dot = hybridEmbs[i].reduce((s, v, k) => s + v * hybridEmbs[j][k], 0);
        hMinSim = Math.min(hMinSim, dot);
        hMaxSim = Math.max(hMaxSim, dot);
        hAvgSim += dot;
        hCount++;
      }
    }
    hAvgSim /= hCount;
    console.log(`   🔍 Hybrid 70/30 sim range: [${hMinSim.toFixed(3)}, ${hMaxSim.toFixed(3)}], avg: ${hAvgSim.toFixed(3)}`);
  }

  const result = evaluateSHGAT(hybridCaps);
  logResult(`BGE=${(bgeWeight * 100).toFixed(0)}% + Node2Vec=${((1 - bgeWeight) * 100).toFixed(0)}%`, result);
}

// ============================================================================
// 3. Node2Vec+ Configurations (Edge Weight-Aware)
// ============================================================================

console.log("\n── Node2Vec+ (Edge Weight-Aware) ──");

// Reset seed for fair comparison (same as Node2Vec standard)
seedRng(42);

// Test with gamma=0 (disables Node2Vec+ weight normalization)
const n2vPlusConfig: Node2VecPlusConfig = {
  walkLength: 15,
  walksPerNode: 30,
  windowSize: 5,
  embeddingDim: 32,
  p: 2.0,
  q: 0.5,
  gamma: 0.0,
};

const n2vPlusEmb = generateNode2VecPlusEmbeddings(n2vPlusConfig);

// Test different BGE/N2V weight ratios
for (const bgeWeight of [0.8, 0.7, 0.6, 0.5]) {
  const hybridCaps = buildHybridEmbeddings(n2vPlusEmb, bgeWeight, n2vPlusConfig.embeddingDim);
  const result = evaluateSHGAT(hybridCaps);
  logResult(`BGE=${(bgeWeight * 100).toFixed(0)}% + Node2Vec+=${((1 - bgeWeight) * 100).toFixed(0)}%`, result);
}

// ============================================================================
// 3. Full Pipeline with Training Epochs
// ============================================================================

console.log("\n── Full Pipeline: BGE + Node2Vec+ + SHGAT V1 K-head ──");

// Best hybrid config
const bestHybridCaps = buildHybridEmbeddings(n2vPlusEmb, 0.7, n2vPlusConfig.embeddingDim);

// Optimal config: epochs=1, lr=0.001 (from investigation)
const optimalResult = evaluateSHGAT(bestHybridCaps, 1, 0.001);
logResult("Full pipeline (optimal: e=1, lr=0.001)", optimalResult);

// Compare with more epochs
for (const epochs of [2, 3]) {
  const result = evaluateSHGAT(bestHybridCaps, epochs, 0.001);
  logResult(`Full pipeline (epochs=${epochs}, lr=0.001)`, result);
}

// ============================================================================
// 4. Node2Vec+ Parameter Variations
// ============================================================================

console.log("\n── Node2Vec+ Parameter Tuning ──");

// Reset seed for each config test
const paramConfigs = [
  { p: 1.0, q: 1.0, gamma: 0.0, desc: "balanced γ=0" },
  { p: 2.0, q: 0.5, gamma: 0.0, desc: "DFS-like γ=0" },
  { p: 2.0, q: 0.5, gamma: 1.0, desc: "DFS-like γ=1" },
];

for (const { p, q, gamma, desc } of paramConfigs) {
  seedRng(42); // Reset for fair comparison
  const config: Node2VecPlusConfig = { ...n2vPlusConfig, p, q, gamma };
  const emb = generateNode2VecPlusEmbeddings(config);
  const hybrid = buildHybridEmbeddings(emb, 0.7, config.embeddingDim);
  const result = evaluateSHGAT(hybrid);
  logResult(`N2V+ p=${p} q=${q} γ=${gamma} (${desc})`, result);
}

// ============================================================================
// 5. SHGAT V1 K-head Training Validation
// ============================================================================

console.log("\n── 🔬 SHGAT V1 K-head Validation ──");

// Compare no training vs optimal training
const noTrainResult = evaluateSHGAT(bestHybridCaps, 0, 0);
logResult("SHGAT no training", noTrainResult);

// Optimal: 1 epoch, lr=0.001
const optimal1 = evaluateSHGAT(bestHybridCaps, 1, 0.001);
logResult("SHGAT optimal (e=1, lr=0.001)", optimal1);

// Test overfitting with more epochs
const overfit3 = evaluateSHGAT(bestHybridCaps, 3, 0.001);
logResult("SHGAT overfit check (e=3)", overfit3);

// ============================================================================
// 6. 🧪 SPIKE: Original vs Propagated Embeddings for K-head Scoring
// ============================================================================

console.log("\n── 🧪 SPIKE: Original (1024-dim) vs Propagated (64-dim) Embeddings ──");

// Test with ORIGINAL embeddings (1024-dim) - uses full Node2Vec + BGE info
const origNoTrain = evaluateSHGAT(bestHybridCaps, 0, 0, true);
logResult("ORIGINAL emb (1024-dim), no training", origNoTrain);

const origTrained = evaluateSHGAT(bestHybridCaps, 1, 0.001, true);
logResult("ORIGINAL emb (1024-dim), trained e=1", origTrained);

// Test with scaled W_q/W_k (x100 instead of x10)
console.log("\n── 🧪 SPIKE: Testing higher scale factors ──");

function evaluateWithScaledWeights(
  shgatCaps: typeof bestHybridCaps,
  scaleFactor: number
): EvalResult {
  // Reset BOTH seeds for fair comparison
  seedRng(42);
  seedSHGATRng(42);

  const shgat = createSHGATFromCapabilities(shgatCaps, new Map(), {
    numHeads: 4,
    hiddenDim: 64,
  });

  // Re-initialize W_q/W_k with higher scale using SEEDED PRNG
  seedRng(42); // Reset again for weight init
  const headParams = (shgat as any).params.headParams;
  const hiddenDim = 64, embDim = 1024;
  const xavierScale = Math.sqrt(2.0 / (hiddenDim + embDim)) * scaleFactor;

  for (const hp of headParams) {
    for (let i = 0; i < hiddenDim; i++) {
      for (let j = 0; j < embDim; j++) {
        hp.W_q[i][j] = (random() - 0.5) * 2 * xavierScale;
        hp.W_k[i][j] = (random() - 0.5) * 2 * xavierScale;
      }
    }
  }

  // Score with original embeddings
  let hits1 = 0, hits3 = 0, hits5 = 0, mrrSum = 0, evaluated = 0;
  let allScores: number[] = [];

  for (const query of queries) {
    if (!query.intentEmbedding?.length) continue;
    const sorted = scoreWithOriginalEmbeddings(shgat, query.intentEmbedding, shgatCaps);
    allScores.push(...sorted.map(r => r.score));
    const idx = sorted.findIndex((s) => s.id === query.expectedCapability);
    const rank = idx >= 0 ? idx + 1 : shgatCaps.length;
    if (rank === 1) hits1++;
    if (rank <= 3) hits3++;
    if (rank <= 5) hits5++;
    if (idx >= 0) mrrSum += 1 / rank;
    evaluated++;
  }

  const minS = Math.min(...allScores), maxS = Math.max(...allScores);
  console.log(`      scores: min=${minS.toFixed(4)}, max=${maxS.toFixed(4)}, range=${(maxS-minS).toFixed(4)}`);

  return {
    mrr: mrrSum / evaluated,
    hit1: (hits1 / evaluated) * 100,
    hit3: (hits3 / evaluated) * 100,
    hit5: (hits5 / evaluated) * 100,
    avgRank: 0,
  };
}

for (const scale of [10, 50, 100, 500]) {
  const result = evaluateWithScaledWeights(bestHybridCaps, scale);
  logResult(`ORIGINAL + Xavier x${scale}`, result);
}

// Test: Pure cosine similarity (no K-head, no SHGAT)
console.log("\n── 🧪 SPIKE: Pure Cosine Similarity (no K-head) ──");

function evaluateCosineSimilarity(
  shgatCaps: typeof bestHybridCaps
): EvalResult {
  let hits1 = 0, hits3 = 0, hits5 = 0, mrrSum = 0, evaluated = 0;

  for (const query of queries) {
    if (!query.intentEmbedding?.length) continue;

    // Pure cosine similarity between intent and capability embeddings
    const scores = shgatCaps.map(cap => {
      const dot = query.intentEmbedding!.reduce((s, v, i) => s + v * cap.embedding[i], 0);
      const normA = Math.sqrt(query.intentEmbedding!.reduce((s, v) => s + v * v, 0));
      const normB = Math.sqrt(cap.embedding.reduce((s, v) => s + v * v, 0));
      return { id: cap.id, score: dot / (normA * normB) };
    }).sort((a, b) => b.score - a.score);

    const idx = scores.findIndex((s) => s.id === query.expectedCapability);
    const rank = idx >= 0 ? idx + 1 : shgatCaps.length;
    if (rank === 1) hits1++;
    if (rank <= 3) hits3++;
    if (rank <= 5) hits5++;
    if (idx >= 0) mrrSum += 1 / rank;
    evaluated++;
  }

  const allScores = shgatCaps.map(c => {
    const q = queries[0].intentEmbedding!;
    const dot = q.reduce((s, v, i) => s + v * c.embedding[i], 0);
    const normA = Math.sqrt(q.reduce((s, v) => s + v * v, 0));
    const normB = Math.sqrt(c.embedding.reduce((s, v) => s + v * v, 0));
    return dot / (normA * normB);
  });
  console.log(`      scores: min=${Math.min(...allScores).toFixed(4)}, max=${Math.max(...allScores).toFixed(4)}, range=${(Math.max(...allScores) - Math.min(...allScores)).toFixed(4)}`);

  return {
    mrr: mrrSum / evaluated,
    hit1: (hits1 / evaluated) * 100,
    hit3: (hits3 / evaluated) * 100,
    hit5: (hits5 / evaluated) * 100,
    avgRank: 0,
  };
}

// Test on BGE-only
const bgeOnlyCaps = caps.map((c) => ({
  id: c.id,
  embedding: c.embedding!,
  toolsUsed: c.toolsUsed || [],
  successRate: c.successRate || 0.5,
  parents: [] as string[],
  children: [] as string[],
}));
logResult("Cosine BGE-only (no SHGAT)", evaluateCosineSimilarity(bgeOnlyCaps));

// Test on hybrid (BGE + Node2Vec)
logResult("Cosine Hybrid 70/30 (no SHGAT)", evaluateCosineSimilarity(bestHybridCaps));

// DEBUG: Investigate MESSAGE PASSING output
console.log("\n── 🔬 DEBUG: Message Passing Analysis ──");

{
  seedRng(42);
  seedSHGATRng(42);
  const shgat = createSHGATFromCapabilities(bgeOnlyCaps, new Map(), {
    numHeads: 4,
    hiddenDim: 64,
  });

  // Get embeddings BEFORE and AFTER message passing
  const originalEmbs = bgeOnlyCaps.map(c => c.embedding);
  const results = shgat.scoreAllCapabilities(queries[0].intentEmbedding!);

  // Access propagated embeddings via forward()
  const forwardResult = (shgat as any).forward();
  const propagatedEmbs = forwardResult.E;

  console.log(`\n   📐 Dimensions:`);
  console.log(`      Original embeddings: ${originalEmbs[0].length}-dim (${originalEmbs.length} caps)`);
  console.log(`      Propagated embeddings: ${propagatedEmbs[0].length}-dim (${propagatedEmbs.length} caps)`);

  // Check incidence matrix - it's on graphBuilder, not shgat directly
  const graphBuilder = (shgat as any).graphBuilder;
  const incidence = graphBuilder?.incidenceMatrix;
  const numTools = graphBuilder?.toolNodes?.size || shgat.getToolCount();
  const numCaps = graphBuilder?.capabilityNodes?.size || shgat.getCapabilityCount();
  const incidenceSum = incidence ? incidence.flat().reduce((a: number, b: number) => a + b, 0) : 0;
  console.log(`      Incidence matrix: ${incidence?.length || 0} x ${incidence?.[0]?.length || 0} (sum=${incidenceSum})`);
  console.log(`      Tools: ${numTools}, Capabilities: ${numCaps}`);

  // Also check multi-level incidence
  const multiLevel = (shgat as any).multiLevelIncidence;
  const toolToCapSize = multiLevel?.toolToCapIncidence?.size || 0;
  console.log(`      Multi-level toolToCapIncidence: ${toolToCapSize} tools mapped`);

  // Check similarity variance BEFORE message passing
  let origMinSim = 1, origMaxSim = -1;
  for (let i = 0; i < Math.min(10, originalEmbs.length); i++) {
    for (let j = i + 1; j < Math.min(10, originalEmbs.length); j++) {
      const dot = originalEmbs[i].reduce((s: number, v: number, k: number) => s + v * originalEmbs[j][k], 0);
      const na = Math.sqrt(originalEmbs[i].reduce((s: number, v: number) => s + v * v, 0));
      const nb = Math.sqrt(originalEmbs[j].reduce((s: number, v: number) => s + v * v, 0));
      const sim = dot / (na * nb);
      origMinSim = Math.min(origMinSim, sim);
      origMaxSim = Math.max(origMaxSim, sim);
    }
  }

  // Check similarity variance AFTER message passing
  let propMinSim = 1, propMaxSim = -1;
  for (let i = 0; i < Math.min(10, propagatedEmbs.length); i++) {
    for (let j = i + 1; j < Math.min(10, propagatedEmbs.length); j++) {
      const dot = propagatedEmbs[i].reduce((s: number, v: number, k: number) => s + v * propagatedEmbs[j][k], 0);
      const na = Math.sqrt(propagatedEmbs[i].reduce((s: number, v: number) => s + v * v, 0));
      const nb = Math.sqrt(propagatedEmbs[j].reduce((s: number, v: number) => s + v * v, 0));
      const sim = dot / (na * nb);
      propMinSim = Math.min(propMinSim, sim);
      propMaxSim = Math.max(propMaxSim, sim);
    }
  }

  console.log(`\n   📊 Cosine similarity range (first 10 caps):`);
  console.log(`      BEFORE message passing: [${origMinSim.toFixed(4)}, ${origMaxSim.toFixed(4)}] range=${(origMaxSim-origMinSim).toFixed(4)}`);
  console.log(`      AFTER message passing:  [${propMinSim.toFixed(4)}, ${propMaxSim.toFixed(4)}] range=${(propMaxSim-propMinSim).toFixed(4)}`);

  // Check norms before and after
  const origNorms = originalEmbs.slice(0, 5).map((e: number[]) => Math.sqrt(e.reduce((s: number, v: number) => s + v * v, 0)));
  const propNorms = propagatedEmbs.slice(0, 5).map((e: number[]) => Math.sqrt(e.reduce((s: number, v: number) => s + v * v, 0)));
  console.log(`\n   📏 Original embedding norms (first 5): ${origNorms.map((n: number) => n.toFixed(3)).join(', ')}`);
  console.log(`   📏 Propagated embedding norms (first 5): ${propNorms.map((n: number) => n.toFixed(3)).join(', ')}`);

  // Check first few values of propagated embeddings
  console.log(`   🔢 Propagated[0] first 5 values: ${propagatedEmbs[0].slice(0, 5).map((v: number) => v.toFixed(4)).join(', ')}`);
  console.log(`   🔢 Propagated[1] first 5 values: ${propagatedEmbs[1].slice(0, 5).map((v: number) => v.toFixed(4)).join(', ')}`);
}

// DEBUG: Investigate K-head attention breakdown
console.log("\n── 🔬 DEBUG: K-head Attention Breakdown ──");

{
  seedRng(42);
  seedSHGATRng(42);
  const shgat = createSHGATFromCapabilities(bgeOnlyCaps, new Map(), {
    numHeads: 4,
    hiddenDim: 64,
  });

  const headParams = (shgat as any).params.headParams;
  const query = queries[0];
  const intent = query.intentEmbedding!;
  const correctCap = bgeOnlyCaps.find(c => c.id === query.expectedCapability)!;
  const wrongCap = bgeOnlyCaps.find(c => c.id !== query.expectedCapability)!;

  console.log(`\n   Query: expects "${correctCap.id}"`);

  // 1. Raw cosine similarity (should be high for correct, lower for wrong)
  const cosSim = (a: number[], b: number[]) => {
    const dot = a.reduce((s, v, i) => s + v * b[i], 0);
    const na = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
    const nb = Math.sqrt(b.reduce((s, v) => s + v * v, 0));
    return dot / (na * nb);
  };

  console.log(`\n   Raw cosine similarity (no projection):`);
  console.log(`      intent ↔ correct: ${cosSim(intent, correctCap.embedding).toFixed(4)}`);
  console.log(`      intent ↔ wrong:   ${cosSim(intent, wrongCap.embedding).toFixed(4)}`);

  // 2. After W_q/W_k projection
  const hiddenDim = 64;
  for (let h = 0; h < 1; h++) { // Just head 0 for brevity
    const W_q = headParams[h].W_q;
    const W_k = headParams[h].W_k;

    // Project intent → Q
    const Q = new Array(hiddenDim).fill(0);
    for (let i = 0; i < hiddenDim; i++) {
      for (let j = 0; j < intent.length; j++) {
        Q[i] += W_q[i][j] * intent[j];
      }
    }

    // Project correct cap → K_correct
    const K_correct = new Array(hiddenDim).fill(0);
    for (let i = 0; i < hiddenDim; i++) {
      for (let j = 0; j < correctCap.embedding.length; j++) {
        K_correct[i] += W_k[i][j] * correctCap.embedding[j];
      }
    }

    // Project wrong cap → K_wrong
    const K_wrong = new Array(hiddenDim).fill(0);
    for (let i = 0; i < hiddenDim; i++) {
      for (let j = 0; j < wrongCap.embedding.length; j++) {
        K_wrong[i] += W_k[i][j] * wrongCap.embedding[j];
      }
    }

    const qNorm = Math.sqrt(Q.reduce((s, v) => s + v * v, 0));
    const kCorrectNorm = Math.sqrt(K_correct.reduce((s, v) => s + v * v, 0));
    const kWrongNorm = Math.sqrt(K_wrong.reduce((s, v) => s + v * v, 0));

    const dotCorrect = Q.reduce((s, v, i) => s + v * K_correct[i], 0);
    const dotWrong = Q.reduce((s, v, i) => s + v * K_wrong[i], 0);

    console.log(`\n   Head ${h} projections:`);
    console.log(`      |Q| = ${qNorm.toFixed(4)}, |K_correct| = ${kCorrectNorm.toFixed(4)}, |K_wrong| = ${kWrongNorm.toFixed(4)}`);
    console.log(`      Q·K_correct = ${dotCorrect.toFixed(4)} → sigmoid(${(dotCorrect/8).toFixed(4)}) = ${(1/(1+Math.exp(-dotCorrect/8))).toFixed(4)}`);
    console.log(`      Q·K_wrong   = ${dotWrong.toFixed(4)} → sigmoid(${(dotWrong/8).toFixed(4)}) = ${(1/(1+Math.exp(-dotWrong/8))).toFixed(4)}`);
    console.log(`      Cosine Q↔K_correct = ${(dotCorrect/(qNorm*kCorrectNorm)).toFixed(4)}`);
    console.log(`      Cosine Q↔K_wrong   = ${(dotWrong/(qNorm*kWrongNorm)).toFixed(4)}`);
  }

  // 3. Check W_q and W_k stats
  const W_q = headParams[0].W_q;
  const W_k = headParams[0].W_k;
  const wqFlat = W_q.flat();
  const wkFlat = W_k.flat();
  console.log(`\n   W_q stats: min=${Math.min(...wqFlat).toFixed(4)}, max=${Math.max(...wqFlat).toFixed(4)}, mean=${(wqFlat.reduce((a,b)=>a+b,0)/wqFlat.length).toFixed(6)}`);
  console.log(`   W_k stats: min=${Math.min(...wkFlat).toFixed(4)}, max=${Math.max(...wkFlat).toFixed(4)}, mean=${(wkFlat.reduce((a,b)=>a+b,0)/wkFlat.length).toFixed(6)}`);
}

// Compare with propagated (current behavior)
const propNoTrain = evaluateSHGAT(bestHybridCaps, 0, 0, false);
logResult("PROPAGATED emb (64-dim), no training", propNoTrain);

const propTrained = evaluateSHGAT(bestHybridCaps, 1, 0.001, false);
logResult("PROPAGATED emb (64-dim), trained e=1", propTrained);

// ============================================================================
// 7. 🧪 SPIKE: Alternative Initialization Strategies for K-head
// ============================================================================

console.log("\n── 🧪 SPIKE: Alternative W_q/W_k Initialization Strategies ──");

// Strategy 1: Truncation (just use first 64 dims - identity projection)
function evaluateTruncation(
  shgatCaps: typeof bestHybridCaps
): EvalResult {
  const hiddenDim = 64;
  let hits1 = 0, hits3 = 0, hits5 = 0, mrrSum = 0, evaluated = 0;
  let allScores: number[] = [];

  for (const query of queries) {
    if (!query.intentEmbedding?.length) continue;

    // Truncate intent to first 64 dims
    const intentTrunc = query.intentEmbedding.slice(0, hiddenDim);
    const intentNorm = Math.sqrt(intentTrunc.reduce((s, v) => s + v * v, 0));

    // Score each capability using truncated embeddings
    const scores = shgatCaps.map(cap => {
      const capTrunc = cap.embedding.slice(0, hiddenDim);
      const capNorm = Math.sqrt(capTrunc.reduce((s, v) => s + v * v, 0));
      const dot = intentTrunc.reduce((s, v, i) => s + v * capTrunc[i], 0);
      return { id: cap.id, score: dot / (intentNorm * capNorm + 1e-8) };
    }).sort((a, b) => b.score - a.score);

    allScores.push(...scores.map(r => r.score));
    const idx = scores.findIndex((s) => s.id === query.expectedCapability);
    const rank = idx >= 0 ? idx + 1 : shgatCaps.length;
    if (rank === 1) hits1++;
    if (rank <= 3) hits3++;
    if (rank <= 5) hits5++;
    if (idx >= 0) mrrSum += 1 / rank;
    evaluated++;
  }

  const minS = Math.min(...allScores), maxS = Math.max(...allScores);
  console.log(`      scores: min=${minS.toFixed(4)}, max=${maxS.toFixed(4)}, range=${(maxS-minS).toFixed(4)}`);

  return {
    mrr: mrrSum / evaluated,
    hit1: (hits1 / evaluated) * 100,
    hit3: (hits3 / evaluated) * 100,
    hit5: (hits5 / evaluated) * 100,
    avgRank: 0,
  };
}

logResult("Truncation (first 64 dims) - BGE", evaluateTruncation(bgeOnlyCaps));
logResult("Truncation (first 64 dims) - Hybrid", evaluateTruncation(bestHybridCaps));

// Strategy 2: Shared projection (W_q = W_k = same random matrix)
function evaluateSharedProjection(
  shgatCaps: typeof bestHybridCaps
): EvalResult {
  seedRng(42);

  const hiddenDim = 64;
  const embDim = 1024;

  // Create a single random projection matrix W (used for both Q and K)
  const xavierScale = Math.sqrt(2.0 / (hiddenDim + embDim));
  const W: number[][] = Array.from({ length: hiddenDim }, () =>
    Array.from({ length: embDim }, () => (random() - 0.5) * 2 * xavierScale)
  );

  let hits1 = 0, hits3 = 0, hits5 = 0, mrrSum = 0, evaluated = 0;
  let allScores: number[] = [];

  for (const query of queries) {
    if (!query.intentEmbedding?.length) continue;

    // Project intent: Q = W @ intent
    const Q = new Array(hiddenDim).fill(0);
    for (let i = 0; i < hiddenDim; i++) {
      for (let j = 0; j < embDim; j++) {
        Q[i] += W[i][j] * query.intentEmbedding[j];
      }
    }
    const qNorm = Math.sqrt(Q.reduce((s, v) => s + v * v, 0));

    // Score each capability
    const scores = shgatCaps.map(cap => {
      // Project capability: K = W @ cap (SAME W!)
      const K = new Array(hiddenDim).fill(0);
      for (let i = 0; i < hiddenDim; i++) {
        for (let j = 0; j < embDim; j++) {
          K[i] += W[i][j] * cap.embedding[j];
        }
      }
      const kNorm = Math.sqrt(K.reduce((s, v) => s + v * v, 0));
      const dot = Q.reduce((s, v, i) => s + v * K[i], 0);
      return { id: cap.id, score: dot / (qNorm * kNorm + 1e-8) };
    }).sort((a, b) => b.score - a.score);

    allScores.push(...scores.map(r => r.score));
    const idx = scores.findIndex((s) => s.id === query.expectedCapability);
    const rank = idx >= 0 ? idx + 1 : shgatCaps.length;
    if (rank === 1) hits1++;
    if (rank <= 3) hits3++;
    if (rank <= 5) hits5++;
    if (idx >= 0) mrrSum += 1 / rank;
    evaluated++;
  }

  const minS = Math.min(...allScores), maxS = Math.max(...allScores);
  console.log(`      scores: min=${minS.toFixed(4)}, max=${maxS.toFixed(4)}, range=${(maxS-minS).toFixed(4)}`);

  return {
    mrr: mrrSum / evaluated,
    hit1: (hits1 / evaluated) * 100,
    hit3: (hits3 / evaluated) * 100,
    hit5: (hits5 / evaluated) * 100,
    avgRank: 0,
  };
}

logResult("Shared projection W_q=W_k - BGE", evaluateSharedProjection(bgeOnlyCaps));
logResult("Shared projection W_q=W_k - Hybrid", evaluateSharedProjection(bestHybridCaps));

// Strategy 3: Random orthogonal projection (preserves norms and approximate distances)
function evaluateOrthogonalProjection(
  shgatCaps: typeof bestHybridCaps
): EvalResult {
  seedRng(42);

  const hiddenDim = 64;
  const embDim = 1024;

  // Generate random matrix and orthogonalize via Gram-Schmidt
  const W: number[][] = Array.from({ length: hiddenDim }, () =>
    Array.from({ length: embDim }, () => random() - 0.5)
  );

  // Gram-Schmidt orthogonalization
  for (let i = 0; i < hiddenDim; i++) {
    // Subtract projections onto previous vectors
    for (let j = 0; j < i; j++) {
      const dot = W[i].reduce((s, v, k) => s + v * W[j][k], 0);
      for (let k = 0; k < embDim; k++) {
        W[i][k] -= dot * W[j][k];
      }
    }
    // Normalize
    const norm = Math.sqrt(W[i].reduce((s, v) => s + v * v, 0));
    if (norm > 1e-8) {
      for (let k = 0; k < embDim; k++) {
        W[i][k] /= norm;
      }
    }
  }

  let hits1 = 0, hits3 = 0, hits5 = 0, mrrSum = 0, evaluated = 0;
  let allScores: number[] = [];

  for (const query of queries) {
    if (!query.intentEmbedding?.length) continue;

    // Project intent: Q = W @ intent
    const Q = new Array(hiddenDim).fill(0);
    for (let i = 0; i < hiddenDim; i++) {
      for (let j = 0; j < embDim; j++) {
        Q[i] += W[i][j] * query.intentEmbedding[j];
      }
    }
    const qNorm = Math.sqrt(Q.reduce((s, v) => s + v * v, 0));

    // Score each capability
    const scores = shgatCaps.map(cap => {
      const K = new Array(hiddenDim).fill(0);
      for (let i = 0; i < hiddenDim; i++) {
        for (let j = 0; j < embDim; j++) {
          K[i] += W[i][j] * cap.embedding[j];
        }
      }
      const kNorm = Math.sqrt(K.reduce((s, v) => s + v * v, 0));
      const dot = Q.reduce((s, v, i) => s + v * K[i], 0);
      return { id: cap.id, score: dot / (qNorm * kNorm + 1e-8) };
    }).sort((a, b) => b.score - a.score);

    allScores.push(...scores.map(r => r.score));
    const idx = scores.findIndex((s) => s.id === query.expectedCapability);
    const rank = idx >= 0 ? idx + 1 : shgatCaps.length;
    if (rank === 1) hits1++;
    if (rank <= 3) hits3++;
    if (rank <= 5) hits5++;
    if (idx >= 0) mrrSum += 1 / rank;
    evaluated++;
  }

  const minS = Math.min(...allScores), maxS = Math.max(...allScores);
  console.log(`      scores: min=${minS.toFixed(4)}, max=${maxS.toFixed(4)}, range=${(maxS-minS).toFixed(4)}`);

  return {
    mrr: mrrSum / evaluated,
    hit1: (hits1 / evaluated) * 100,
    hit3: (hits3 / evaluated) * 100,
    hit5: (hits5 / evaluated) * 100,
    avgRank: 0,
  };
}

logResult("Orthogonal projection - BGE", evaluateOrthogonalProjection(bgeOnlyCaps));
logResult("Orthogonal projection - Hybrid", evaluateOrthogonalProjection(bestHybridCaps));

// ============================================================================
// 8. 🧪 SPIKE: Dual-Path Scoring (Semantic + Structure)
// ============================================================================

console.log("\n── 🧪 SPIKE: Dual-Path Scoring (Option D) ──");
console.log("   Path 1 (Semantic): Original 1024-dim embeddings");
console.log("   Path 2 (Structure): Propagated 64-dim embeddings from message passing");
console.log("   Fusion: final_score = α × semantic + (1-α) × structure\n");

/**
 * Dual-path scoring: combines semantic (1024-dim) and structure (64-dim) paths
 *
 * @param alpha - Weight for semantic path (1.0 = pure semantic, 0.0 = pure structure)
 */
function evaluateDualPath(
  shgatCaps: typeof bestHybridCaps,
  alpha: number
): EvalResult {
  seedRng(42);
  seedSHGATRng(42);

  const shgat = createSHGATFromCapabilities(shgatCaps, new Map(), {
    numHeads: 4,
    hiddenDim: 64,
  });

  const headParams = (shgat as any).params.headParams;
  const numHeads = headParams.length;
  const hiddenDim = 64;

  // Get propagated embeddings from message passing
  const { E: propagatedEmbs } = (shgat as any).forward();

  // Build cap index
  const capIdx = new Map<string, number>();
  shgatCaps.forEach((c, i) => capIdx.set(c.id, i));

  let hits1 = 0, hits3 = 0, hits5 = 0, mrrSum = 0, evaluated = 0;
  let allScores: number[] = [];
  let semanticScores: number[] = [];
  let structureScores: number[] = [];

  for (const query of queries) {
    if (!query.intentEmbedding?.length) continue;

    const scores = shgatCaps.map((cap, cIdx) => {
      let semanticHeadScores: number[] = [];
      let structureHeadScores: number[] = [];

      for (let h = 0; h < numHeads; h++) {
        const W_q = headParams[h].W_q; // [64][1024]
        const W_k = headParams[h].W_k; // [64][1024]

        // === SEMANTIC PATH: Original 1024-dim embeddings ===
        // Q = W_q @ intent (full 1024-dim)
        const Q_sem = new Array(hiddenDim).fill(0);
        for (let i = 0; i < hiddenDim; i++) {
          for (let j = 0; j < query.intentEmbedding!.length; j++) {
            Q_sem[i] += W_q[i][j] * query.intentEmbedding![j];
          }
        }

        // K = W_k @ cap.embedding (full 1024-dim)
        const K_sem = new Array(hiddenDim).fill(0);
        for (let i = 0; i < hiddenDim; i++) {
          for (let j = 0; j < cap.embedding.length; j++) {
            K_sem[i] += W_k[i][j] * cap.embedding[j];
          }
        }

        const dot_sem = Q_sem.reduce((s, v, i) => s + v * K_sem[i], 0);
        const score_sem = 1 / (1 + Math.exp(-dot_sem / Math.sqrt(hiddenDim)));
        semanticHeadScores.push(score_sem);

        // === STRUCTURE PATH: Propagated 64-dim embeddings ===
        // Use first 64 columns of W_q/W_k for the 64-dim structure path
        // (This simulates having separate W_q_struct/W_k_struct [64][64])
        const Q_struct = new Array(hiddenDim).fill(0);
        const propIntent = propagatedEmbs[0]; // Use first tool as proxy (or project intent)
        // Actually, for intent we don't have propagated - use W_intent projection
        const W_intent = (shgat as any).params.W_intent; // [64][1024]
        const intentProj = new Array(hiddenDim).fill(0);
        for (let i = 0; i < hiddenDim; i++) {
          for (let j = 0; j < query.intentEmbedding!.length; j++) {
            intentProj[i] += W_intent[i][j] * query.intentEmbedding![j];
          }
        }

        // Q_struct from projected intent (64-dim)
        for (let i = 0; i < hiddenDim; i++) {
          for (let j = 0; j < hiddenDim; j++) { // Only first 64 cols
            Q_struct[i] += W_q[i][j] * intentProj[j];
          }
        }

        // K_struct from propagated cap embedding (64-dim)
        const K_struct = new Array(hiddenDim).fill(0);
        const propCap = propagatedEmbs[cIdx];
        for (let i = 0; i < hiddenDim; i++) {
          for (let j = 0; j < Math.min(hiddenDim, propCap.length); j++) {
            K_struct[i] += W_q[i][j] * propCap[j]; // Use W_q since W_q=W_k (shared)
          }
        }

        const dot_struct = Q_struct.reduce((s, v, i) => s + v * K_struct[i], 0);
        const score_struct = 1 / (1 + Math.exp(-dot_struct / Math.sqrt(hiddenDim)));
        structureHeadScores.push(score_struct);
      }

      // Average across heads
      const avgSemantic = semanticHeadScores.reduce((a, b) => a + b, 0) / numHeads;
      const avgStructure = structureHeadScores.reduce((a, b) => a + b, 0) / numHeads;

      // Dual-path fusion
      const fusedScore = alpha * avgSemantic + (1 - alpha) * avgStructure;

      semanticScores.push(avgSemantic);
      structureScores.push(avgStructure);

      return { id: cap.id, score: fusedScore };
    }).sort((a, b) => b.score - a.score);

    allScores.push(...scores.map(r => r.score));
    const idx = scores.findIndex((s) => s.id === query.expectedCapability);
    const rank = idx >= 0 ? idx + 1 : shgatCaps.length;
    if (rank === 1) hits1++;
    if (rank <= 3) hits3++;
    if (rank <= 5) hits5++;
    if (idx >= 0) mrrSum += 1 / rank;
    evaluated++;
  }

  // Debug stats
  const semMin = Math.min(...semanticScores), semMax = Math.max(...semanticScores);
  const strMin = Math.min(...structureScores), strMax = Math.max(...structureScores);
  console.log(`      α=${alpha.toFixed(1)} | semantic=[${semMin.toFixed(3)},${semMax.toFixed(3)}] structure=[${strMin.toFixed(3)},${strMax.toFixed(3)}]`);

  return {
    mrr: mrrSum / evaluated,
    hit1: (hits1 / evaluated) * 100,
    hit3: (hits3 / evaluated) * 100,
    hit5: (hits5 / evaluated) * 100,
    avgRank: 0,
  };
}

// Test different alpha values
for (const alpha of [1.0, 0.9, 0.8, 0.7, 0.6, 0.5]) {
  const result = evaluateDualPath(bgeOnlyCaps, alpha);
  const label = alpha === 1.0 ? "pure semantic" : alpha === 0.5 ? "50/50 mix" : "";
  logResult(`Dual-path α=${alpha.toFixed(1)} ${label}`.trim(), result);
}

// Test with adaptive alpha simulation (per-capability based on degree)
console.log("\n── 🧪 SPIKE: Adaptive Alpha (degree-based simulation) ──");

function evaluateDualPathAdaptive(
  shgatCaps: typeof bestHybridCaps
): EvalResult {
  seedRng(42);
  seedSHGATRng(42);

  const shgat = createSHGATFromCapabilities(shgatCaps, new Map(), {
    numHeads: 4,
    hiddenDim: 64,
  });

  const headParams = (shgat as any).params.headParams;
  const numHeads = headParams.length;
  const hiddenDim = 64;

  // Get propagated embeddings and graph info
  const { E: propagatedEmbs } = (shgat as any).forward();
  const graphBuilder = (shgat as any).graphBuilder;

  // Build cap index and compute degrees
  const capIdx = new Map<string, number>();
  const capDegrees = new Map<string, number>();
  let maxDegree = 1;

  shgatCaps.forEach((c, i) => {
    capIdx.set(c.id, i);
    const degree = c.toolsUsed?.length || 0;
    capDegrees.set(c.id, degree);
    if (degree > maxDegree) maxDegree = degree;
  });

  let hits1 = 0, hits3 = 0, hits5 = 0, mrrSum = 0, evaluated = 0;
  let alphaUsed: number[] = [];

  for (const query of queries) {
    if (!query.intentEmbedding?.length) continue;

    const scores = shgatCaps.map((cap, cIdx) => {
      // Adaptive alpha based on degree (simulating Local Alpha)
      // High degree = more graph info = lower alpha (trust structure more)
      // Low degree = cold start = higher alpha (trust semantic)
      const degree = capDegrees.get(cap.id) || 0;
      const normalizedDegree = degree / maxDegree;
      // alpha in [0.5, 1.0]: 0.5 = max graph trust, 1.0 = pure semantic
      const alpha = 1.0 - normalizedDegree * 0.5;
      alphaUsed.push(alpha);

      let semanticHeadScores: number[] = [];
      let structureHeadScores: number[] = [];

      for (let h = 0; h < numHeads; h++) {
        const W_q = headParams[h].W_q;
        const W_k = headParams[h].W_k;

        // Semantic path (1024-dim)
        const Q_sem = new Array(hiddenDim).fill(0);
        for (let i = 0; i < hiddenDim; i++) {
          for (let j = 0; j < query.intentEmbedding!.length; j++) {
            Q_sem[i] += W_q[i][j] * query.intentEmbedding![j];
          }
        }
        const K_sem = new Array(hiddenDim).fill(0);
        for (let i = 0; i < hiddenDim; i++) {
          for (let j = 0; j < cap.embedding.length; j++) {
            K_sem[i] += W_k[i][j] * cap.embedding[j];
          }
        }
        const dot_sem = Q_sem.reduce((s, v, i) => s + v * K_sem[i], 0);
        semanticHeadScores.push(1 / (1 + Math.exp(-dot_sem / Math.sqrt(hiddenDim))));

        // Structure path (64-dim)
        const W_intent = (shgat as any).params.W_intent;
        const intentProj = new Array(hiddenDim).fill(0);
        for (let i = 0; i < hiddenDim; i++) {
          for (let j = 0; j < query.intentEmbedding!.length; j++) {
            intentProj[i] += W_intent[i][j] * query.intentEmbedding![j];
          }
        }
        const Q_struct = new Array(hiddenDim).fill(0);
        for (let i = 0; i < hiddenDim; i++) {
          for (let j = 0; j < hiddenDim; j++) {
            Q_struct[i] += W_q[i][j] * intentProj[j];
          }
        }
        const K_struct = new Array(hiddenDim).fill(0);
        const propCap = propagatedEmbs[cIdx];
        for (let i = 0; i < hiddenDim; i++) {
          for (let j = 0; j < Math.min(hiddenDim, propCap.length); j++) {
            K_struct[i] += W_q[i][j] * propCap[j];
          }
        }
        const dot_struct = Q_struct.reduce((s, v, i) => s + v * K_struct[i], 0);
        structureHeadScores.push(1 / (1 + Math.exp(-dot_struct / Math.sqrt(hiddenDim))));
      }

      const avgSemantic = semanticHeadScores.reduce((a, b) => a + b, 0) / numHeads;
      const avgStructure = structureHeadScores.reduce((a, b) => a + b, 0) / numHeads;
      const fusedScore = alpha * avgSemantic + (1 - alpha) * avgStructure;

      return { id: cap.id, score: fusedScore };
    }).sort((a, b) => b.score - a.score);

    const idx = scores.findIndex((s) => s.id === query.expectedCapability);
    const rank = idx >= 0 ? idx + 1 : shgatCaps.length;
    if (rank === 1) hits1++;
    if (rank <= 3) hits3++;
    if (rank <= 5) hits5++;
    if (idx >= 0) mrrSum += 1 / rank;
    evaluated++;
  }

  const avgAlpha = alphaUsed.reduce((a, b) => a + b, 0) / alphaUsed.length;
  const minAlpha = Math.min(...alphaUsed), maxAlpha = Math.max(...alphaUsed);
  console.log(`      Adaptive α: min=${minAlpha.toFixed(2)}, max=${maxAlpha.toFixed(2)}, avg=${avgAlpha.toFixed(2)}`);

  return {
    mrr: mrrSum / evaluated,
    hit1: (hits1 / evaluated) * 100,
    hit3: (hits3 / evaluated) * 100,
    hit5: (hits5 / evaluated) * 100,
    avgRank: 0,
  };
}

logResult("Dual-path ADAPTIVE (degree-based α)", evaluateDualPathAdaptive(bgeOnlyCaps));

// ============================================================================
// 9. 🧪 SPIKE: Message Passing with d=1024 (like HGAT paper)
// ============================================================================

console.log("\n── 🧪 SPIKE: Message Passing d=1024 (HGAT paper spec) ──");
console.log("   HGAT paper: H^(l), E^(l) ∈ R^(N×d) - SAME dimension throughout");
console.log("   Current impl: 1024 → 64 (compression loses discriminability)");
console.log("   This spike: Keep d=1024 throughout message passing\n");

/**
 * Message passing with 1024 dimensions throughout (no compression)
 * Following HGAT paper: E^(l+1) = σ(A^T H^(l))
 */
function evaluateMessagePassing1024(
  shgatCaps: typeof bestHybridCaps
): EvalResult {
  seedRng(42);
  seedSHGATRng(42);

  const inputDim = 1024;
  const numHeads = 4;

  // Build tool→cap incidence matrix A
  const toolSet = new Set<string>();
  shgatCaps.forEach(c => (c.toolsUsed || []).forEach(t => toolSet.add(t)));
  const tools = Array.from(toolSet);
  const toolIdx = new Map(tools.map((t, i) => [t, i]));

  const numTools = tools.length;
  const numCaps = shgatCaps.length;

  // Incidence matrix A[t][c] = 1 if tool t used by cap c
  const A: number[][] = Array.from({ length: numTools }, () =>
    new Array(numCaps).fill(0)
  );
  shgatCaps.forEach((c, cIdx) => {
    (c.toolsUsed || []).forEach(t => {
      const tIdx = toolIdx.get(t);
      if (tIdx !== undefined) A[tIdx][cIdx] = 1;
    });
  });

  // Initialize H (tools) and E (caps) with original 1024-dim embeddings
  // H[t] = mean of all caps that use tool t
  const H: number[][] = tools.map((_, tIdx) => {
    const capEmbeddings: number[][] = [];
    shgatCaps.forEach((c, cIdx) => {
      if (A[tIdx][cIdx] === 1 && c.embedding) {
        capEmbeddings.push(c.embedding);
      }
    });
    if (capEmbeddings.length === 0) {
      return new Array(inputDim).fill(0);
    }
    const mean = new Array(inputDim).fill(0);
    for (const emb of capEmbeddings) {
      for (let i = 0; i < inputDim; i++) {
        mean[i] += emb[i] / capEmbeddings.length;
      }
    }
    return mean;
  });

  // E = original cap embeddings
  let E: number[][] = shgatCaps.map(c => [...(c.embedding || new Array(inputDim).fill(0))]);

  // --- W_child, W_parent as [1024][1024] identity-like projections ---
  // Using identity-like: W = I + small random perturbation
  const createIdentityLike = (): number[][] => {
    return Array.from({ length: inputDim }, (_, i) =>
      Array.from({ length: inputDim }, (_, j) =>
        i === j ? 1.0 : (random() - 0.5) * 0.01
      )
    );
  };

  const W_child = createIdentityLike();
  const W_parent = createIdentityLike();

  // --- Message Passing: 1 upward + 1 downward pass ---
  // Upward: E → H (aggregate caps to tools)
  // H^(l+1) = σ(A @ W_child @ E^(l))

  // Project E
  const E_proj: number[][] = E.map(e => {
    const out = new Array(inputDim).fill(0);
    for (let i = 0; i < inputDim; i++) {
      for (let j = 0; j < inputDim; j++) {
        out[i] += W_child[i][j] * e[j];
      }
    }
    return out;
  });

  // Aggregate: H_new = A @ E_proj (mean pooling per tool)
  const H_new: number[][] = tools.map((_, tIdx) => {
    const msg = new Array(inputDim).fill(0);
    let count = 0;
    for (let cIdx = 0; cIdx < numCaps; cIdx++) {
      if (A[tIdx][cIdx] === 1) {
        for (let i = 0; i < inputDim; i++) {
          msg[i] += E_proj[cIdx][i];
        }
        count++;
      }
    }
    if (count > 0) {
      for (let i = 0; i < inputDim; i++) msg[i] /= count;
    }
    // LeakyReLU
    return msg.map(v => v > 0 ? v : 0.2 * v);
  });

  // Downward: H → E (aggregate tools to caps)
  // E^(l+1) = σ(A^T @ W_parent @ H^(l+1))

  // Project H
  const H_proj: number[][] = H_new.map(h => {
    const out = new Array(inputDim).fill(0);
    for (let i = 0; i < inputDim; i++) {
      for (let j = 0; j < inputDim; j++) {
        out[i] += W_parent[i][j] * h[j];
      }
    }
    return out;
  });

  // Aggregate: E_new = A^T @ H_proj (mean pooling per cap)
  const E_new: number[][] = shgatCaps.map((_, cIdx) => {
    const msg = new Array(inputDim).fill(0);
    let count = 0;
    for (let tIdx = 0; tIdx < numTools; tIdx++) {
      if (A[tIdx][cIdx] === 1) {
        for (let i = 0; i < inputDim; i++) {
          msg[i] += H_proj[tIdx][i];
        }
        count++;
      }
    }
    if (count > 0) {
      for (let i = 0; i < inputDim; i++) msg[i] /= count;
    }
    // LeakyReLU
    return msg.map(v => v > 0 ? v : 0.2 * v);
  });

  // Residual connection: E_final = E_new + 0.5 * E_original
  const E_final: number[][] = E_new.map((e, cIdx) =>
    e.map((v, i) => v + 0.5 * E[cIdx][i])
  );

  // Normalize
  const normalize = (vec: number[]): number[] => {
    const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0));
    return norm > 0 ? vec.map(x => x / norm) : vec;
  };
  const E_normalized = E_final.map(normalize);

  // Debug: check variance
  const allEVals = E_normalized.flat();
  const eMin = Math.min(...allEVals), eMax = Math.max(...allEVals);
  console.log(`   Propagated 1024-dim: range=[${eMin.toFixed(4)}, ${eMax.toFixed(4)}]`);

  // --- K-head scoring with propagated 1024-dim embeddings ---
  // W_q = W_k as [64][1024] for scoring (same as SHGAT)
  const shgat = createSHGATFromCapabilities(shgatCaps, new Map(), {
    numHeads,
    hiddenDim: 64,
  });
  const headParams = (shgat as any).params.headParams;
  const hiddenDim = 64;

  let hits1 = 0, hits3 = 0, hits5 = 0, mrrSum = 0, evaluated = 0;
  let allScores: number[] = [];

  for (const query of queries) {
    if (!query.intentEmbedding?.length) continue;

    const scores = shgatCaps.map((cap, cIdx) => {
      let headScores: number[] = [];

      for (let h = 0; h < numHeads; h++) {
        const W_q = headParams[h].W_q; // [64][1024]

        // Q = W_q @ intent (1024-dim)
        const Q = new Array(hiddenDim).fill(0);
        for (let i = 0; i < hiddenDim; i++) {
          for (let j = 0; j < inputDim; j++) {
            Q[i] += W_q[i][j] * query.intentEmbedding![j];
          }
        }

        // K = W_q @ propagated_cap (1024-dim) - using W_q since W_q=W_k
        const K = new Array(hiddenDim).fill(0);
        const propCap = E_normalized[cIdx];
        for (let i = 0; i < hiddenDim; i++) {
          for (let j = 0; j < inputDim; j++) {
            K[i] += W_q[i][j] * propCap[j];
          }
        }

        const dotProduct = Q.reduce((s, v, i) => s + v * K[i], 0);
        const score = 1 / (1 + Math.exp(-dotProduct / Math.sqrt(hiddenDim)));
        headScores.push(score);
      }

      const avgScore = headScores.reduce((a, b) => a + b, 0) / numHeads;
      return { id: cap.id, score: avgScore };
    }).sort((a, b) => b.score - a.score);

    allScores.push(...scores.map(r => r.score));
    const idx = scores.findIndex(s => s.id === query.expectedCapability);
    const rank = idx >= 0 ? idx + 1 : shgatCaps.length;
    if (rank === 1) hits1++;
    if (rank <= 3) hits3++;
    if (rank <= 5) hits5++;
    if (idx >= 0) mrrSum += 1 / rank;
    evaluated++;
  }

  const minS = Math.min(...allScores), maxS = Math.max(...allScores);
  console.log(`   K-head scores: min=${minS.toFixed(4)}, max=${maxS.toFixed(4)}, range=${(maxS-minS).toFixed(4)}`);

  return {
    mrr: mrrSum / evaluated,
    hit1: (hits1 / evaluated) * 100,
    hit3: (hits3 / evaluated) * 100,
    hit5: (hits5 / evaluated) * 100,
    avgRank: 0,
  };
}

logResult("Message Passing d=1024 (HGAT paper)", evaluateMessagePassing1024(bgeOnlyCaps));

// Test with different residual weights
console.log("\n   Testing residual weights for 1024-dim message passing:");

function evaluateMessagePassing1024WithResidual(
  shgatCaps: typeof bestHybridCaps,
  residualWeight: number
): EvalResult {
  seedRng(42);
  const inputDim = 1024;
  const numHeads = 4;

  // Build tool→cap incidence
  const toolSet = new Set<string>();
  shgatCaps.forEach(c => (c.toolsUsed || []).forEach(t => toolSet.add(t)));
  const tools = Array.from(toolSet);
  const toolIdx = new Map(tools.map((t, i) => [t, i]));
  const numTools = tools.length;
  const numCaps = shgatCaps.length;

  const A: number[][] = Array.from({ length: numTools }, () => new Array(numCaps).fill(0));
  shgatCaps.forEach((c, cIdx) => {
    (c.toolsUsed || []).forEach(t => {
      const tIdx = toolIdx.get(t);
      if (tIdx !== undefined) A[tIdx][cIdx] = 1;
    });
  });

  // H = mean of caps per tool
  const H: number[][] = tools.map((_, tIdx) => {
    const embs: number[][] = [];
    shgatCaps.forEach((c, cIdx) => {
      if (A[tIdx][cIdx] === 1 && c.embedding) embs.push(c.embedding);
    });
    if (embs.length === 0) return new Array(inputDim).fill(0);
    const mean = new Array(inputDim).fill(0);
    for (const e of embs) {
      for (let i = 0; i < inputDim; i++) mean[i] += e[i] / embs.length;
    }
    return mean;
  });

  let E: number[][] = shgatCaps.map(c => [...(c.embedding || new Array(inputDim).fill(0))]);
  const E_original = E.map(e => [...e]);

  // Identity-like projections [1024][1024]
  const createIdentityLike = (): number[][] =>
    Array.from({ length: inputDim }, (_, i) =>
      Array.from({ length: inputDim }, (_, j) => (i === j ? 1.0 : (random() - 0.5) * 0.01))
    );
  const W_child = createIdentityLike();
  const W_parent = createIdentityLike();

  // Upward pass
  const E_proj = E.map(e => {
    const out = new Array(inputDim).fill(0);
    for (let i = 0; i < inputDim; i++)
      for (let j = 0; j < inputDim; j++) out[i] += W_child[i][j] * e[j];
    return out;
  });

  const H_new = tools.map((_, tIdx) => {
    const msg = new Array(inputDim).fill(0);
    let count = 0;
    for (let cIdx = 0; cIdx < numCaps; cIdx++) {
      if (A[tIdx][cIdx] === 1) {
        for (let i = 0; i < inputDim; i++) msg[i] += E_proj[cIdx][i];
        count++;
      }
    }
    if (count > 0) for (let i = 0; i < inputDim; i++) msg[i] /= count;
    return msg.map(v => (v > 0 ? v : 0.2 * v));
  });

  // Downward pass
  const H_proj = H_new.map(h => {
    const out = new Array(inputDim).fill(0);
    for (let i = 0; i < inputDim; i++)
      for (let j = 0; j < inputDim; j++) out[i] += W_parent[i][j] * h[j];
    return out;
  });

  const E_new = shgatCaps.map((_, cIdx) => {
    const msg = new Array(inputDim).fill(0);
    let count = 0;
    for (let tIdx = 0; tIdx < numTools; tIdx++) {
      if (A[tIdx][cIdx] === 1) {
        for (let i = 0; i < inputDim; i++) msg[i] += H_proj[tIdx][i];
        count++;
      }
    }
    if (count > 0) for (let i = 0; i < inputDim; i++) msg[i] /= count;
    return msg.map(v => (v > 0 ? v : 0.2 * v));
  });

  // Residual: E_final = (1-r)*E_new + r*E_original
  const E_final = E_new.map((e, cIdx) =>
    e.map((v, i) => (1 - residualWeight) * v + residualWeight * E_original[cIdx][i])
  );

  const normalize = (vec: number[]) => {
    const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0));
    return norm > 0 ? vec.map(x => x / norm) : vec;
  };
  const E_normalized = E_final.map(normalize);

  // K-head scoring
  seedSHGATRng(42);
  const shgat = createSHGATFromCapabilities(shgatCaps, new Map(), { numHeads, hiddenDim: 64 });
  const headParams = (shgat as any).params.headParams;
  const hiddenDim = 64;

  let hits1 = 0, hits3 = 0, hits5 = 0, mrrSum = 0, evaluated = 0;

  for (const query of queries) {
    if (!query.intentEmbedding?.length) continue;
    const scores = shgatCaps.map((cap, cIdx) => {
      let headScores: number[] = [];
      for (let h = 0; h < numHeads; h++) {
        const W_q = headParams[h].W_q;
        const Q = new Array(hiddenDim).fill(0);
        for (let i = 0; i < hiddenDim; i++)
          for (let j = 0; j < inputDim; j++) Q[i] += W_q[i][j] * query.intentEmbedding![j];
        const K = new Array(hiddenDim).fill(0);
        const propCap = E_normalized[cIdx];
        for (let i = 0; i < hiddenDim; i++)
          for (let j = 0; j < inputDim; j++) K[i] += W_q[i][j] * propCap[j];
        const dot = Q.reduce((s, v, i) => s + v * K[i], 0);
        headScores.push(1 / (1 + Math.exp(-dot / Math.sqrt(hiddenDim))));
      }
      return { id: cap.id, score: headScores.reduce((a, b) => a + b, 0) / numHeads };
    }).sort((a, b) => b.score - a.score);

    const idx = scores.findIndex(s => s.id === query.expectedCapability);
    const rank = idx >= 0 ? idx + 1 : shgatCaps.length;
    if (rank === 1) hits1++;
    if (rank <= 3) hits3++;
    if (rank <= 5) hits5++;
    if (idx >= 0) mrrSum += 1 / rank;
    evaluated++;
  }

  return {
    mrr: mrrSum / evaluated,
    hit1: (hits1 / evaluated) * 100,
    hit3: (hits3 / evaluated) * 100,
    hit5: (hits5 / evaluated) * 100,
    avgRank: 0,
  };
}

for (const r of [0.0, 0.2, 0.4, 0.6, 0.8, 1.0]) {
  const result = evaluateMessagePassing1024WithResidual(bgeOnlyCaps, r);
  const label = r === 0.0 ? "pure propagated" : r === 1.0 ? "pure original" : "";
  logResult(`MP d=1024 residual=${r.toFixed(1)} ${label}`.trim(), result);
}

// Test with Node2Vec hybrid embeddings
console.log("\n   Testing with Node2Vec hybrid embeddings (BGE 70% + Node2Vec 30%):");

logResult("MP d=1024 + Node2Vec hybrid", evaluateMessagePassing1024(bestHybridCaps));

for (const r of [0.0, 0.3, 0.5]) {
  const result = evaluateMessagePassing1024WithResidual(bestHybridCaps, r);
  const label = r === 0.0 ? "pure propagated" : "";
  logResult(`MP d=1024 + N2V residual=${r.toFixed(1)} ${label}`.trim(), result);
}

// ============================================================================
// 10. 🧪 SPIKE: Production SHGAT with preserveDim=true
// ============================================================================

console.log("\n── 🧪 SPIKE: Production SHGAT preserveDim=true ──");

/**
 * Evaluate production SHGAT with preserveDim=true
 *
 * Uses the actual SHGAT class with forward() which applies:
 * - Identity-like projections (preserves semantic structure)
 * - Residual connection to original embeddings (default 0.3)
 * - L2 normalization
 */
function evaluatePreserveDimSHGAT(shgatCaps: typeof bestHybridCaps): EvalResult {
  seedRng(42);
  seedSHGATRng(42);

  // Create SHGAT with preserveDim=true (production config)
  // This uses identity-like init + residual connection in forward()
  const shgat = createSHGATFromCapabilities(shgatCaps, new Map(), {
    preserveDim: true,
    preserveDimResidual: 0.3,  // 70% propagated + 30% original
  });

  const config = (shgat as any).config;
  console.log(`   Config: numHeads=${config.numHeads}, hiddenDim=${config.hiddenDim}, preserveDim=${config.preserveDim}`);

  // Run forward pass - this applies message passing + residual + normalization
  const { E } = shgat.forward();
  console.log(`   Propagated dim: ${E[0]?.length || 0}`);

  // Score using scoreAllCapabilities (uses K-head attention)
  let hits1 = 0, hits3 = 0, hits5 = 0, mrrSum = 0, evaluated = 0;

  for (const query of queries) {
    if (!query.intentEmbedding?.length) continue;

    const results = shgat.scoreAllCapabilities(query.intentEmbedding);
    const sorted = [...results].sort((a, b) => b.score - a.score);

    const idx = sorted.findIndex(s => s.capabilityId === query.expectedCapability);
    const rank = idx >= 0 ? idx + 1 : shgatCaps.length;
    if (rank === 1) hits1++;
    if (rank <= 3) hits3++;
    if (rank <= 5) hits5++;
    if (idx >= 0) mrrSum += 1 / rank;
    evaluated++;
  }

  return {
    mrr: mrrSum / evaluated,
    hit1: (hits1 / evaluated) * 100,
    hit3: (hits3 / evaluated) * 100,
    hit5: (hits5 / evaluated) * 100,
    avgRank: 0,
  };
}

logResult("SHGAT preserveDim=true (production)", evaluatePreserveDimSHGAT(bgeOnlyCaps));

// ============================================================================
// Summary
// ============================================================================

console.log("\n" + "═".repeat(90));
console.log("                              SUMMARY");
console.log("═".repeat(90));

// Find best results
const sortedByMRR = [...results].sort((a, b) => b.mrr - a.mrr);
const baseline = results.find((r) => r.name.includes("baseline"))!;
const best = sortedByMRR[0];

console.log("\n📊 Best Configuration:");
console.log(`   ${best.name}`);
console.log(`   MRR: ${best.mrr.toFixed(3)} (${((best.mrr / baseline.mrr - 1) * 100).toFixed(1)}% vs baseline)`);
console.log(`   Hit@1: ${best.hit1.toFixed(1)}%`);
console.log(`   Hit@3: ${best.hit3.toFixed(1)}%`);
console.log(`   Hit@5: ${best.hit5.toFixed(1)}%`);

console.log("\n🏆 Top 5 Configurations:");
console.log("─".repeat(70));
for (let i = 0; i < Math.min(5, sortedByMRR.length); i++) {
  const r = sortedByMRR[i];
  const delta = ((r.mrr / baseline.mrr - 1) * 100).toFixed(1);
  const emoji = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : "  ";
  console.log(
    `${emoji} ${(i + 1).toString().padStart(2)}. ${r.name.padEnd(38)} MRR=${r.mrr.toFixed(3)} (${delta}%)`
  );
}

// Node2Vec vs Node2Vec+ comparison
console.log("\n🔬 Node2Vec vs Node2Vec+ (Edge Weight-Aware):");
console.log("─".repeat(70));

const n2vStandardResult = results.find((r) => r.name === "BGE=70% + Node2Vec=30%");
const n2vPlusResult = results.find((r) => r.name === "BGE=70% + Node2Vec+=30%");

if (n2vStandardResult && n2vPlusResult) {
  const improvement = ((n2vPlusResult.mrr / n2vStandardResult.mrr - 1) * 100).toFixed(1);
  console.log(`   Node2Vec  (standard):   MRR=${n2vStandardResult.mrr.toFixed(3)} H@3=${n2vStandardResult.hit3.toFixed(1)}%`);
  console.log(`   Node2Vec+ (weighted):   MRR=${n2vPlusResult.mrr.toFixed(3)} H@3=${n2vPlusResult.hit3.toFixed(1)}%`);
  console.log(`   ─────────────────────────────────────────────────`);
  console.log(`   🎯 Node2Vec+ improvement over Node2Vec: ${improvement}%`);
}

// Pipeline comparison
console.log("\n📈 Pipeline Component Analysis:");
console.log("─".repeat(70));

const pipelineConfigs = [
  { name: "BGE only (baseline)", result: results.find((r) => r.name.includes("baseline"))! },
  { name: "BGE + Node2Vec (70/30)", result: n2vStandardResult },
  { name: "BGE + Node2Vec+ (70/30)", result: n2vPlusResult },
];

for (const { name, result: r } of pipelineConfigs) {
  if (r) {
    const delta = ((r.mrr / baseline.mrr - 1) * 100).toFixed(1);
    console.log(`   ${name.padEnd(30)} MRR=${r.mrr.toFixed(3)} H@3=${r.hit3.toFixed(1)}% (${delta}%)`);
  }
}

console.log("\n" + "═".repeat(90));
console.log("                         BENCHMARK COMPLETE");
console.log("═".repeat(90));
console.log("\n");
