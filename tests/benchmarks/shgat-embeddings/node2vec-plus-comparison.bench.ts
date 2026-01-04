/**
 * Node2Vec+ vs Node2Vec Comparison Benchmark
 *
 * Tests the impact of edge-weight-aware random walks (Node2Vec+) vs standard
 * uniform random walks (Node2Vec) on SHGAT V1 scoring performance.
 *
 * Node2Vec+ Reference: Liu & Hirn (2023) - "Accurately modeling biased random
 * walks on weighted networks using node2vec+"
 * https://pmc.ncbi.nlm.nih.gov/articles/PMC9891245/
 *
 * Run: deno run --allow-all tests/benchmarks/shgat-embeddings/node2vec-plus-comparison.bench.ts
 */

import { loadScenario } from "../fixtures/scenario-loader.ts";
import {
  createSHGATFromCapabilities,
  trainSHGATOnEpisodes,
} from "../../../src/graphrag/algorithms/shgat.ts";
import Graph from "npm:graphology";
import { Matrix, SingularValueDecomposition } from "npm:ml-matrix";

console.log("=== Node2Vec+ vs Node2Vec Comparison Benchmark ===\n");
console.log("Testing edge-weight-aware random walks for SHGAT V1 embeddings\n");

// ============================================================================
// Load Data
// ============================================================================

const scenario = await loadScenario("medium-graph");

interface Cap {
  id: string;
  embedding?: number[];
  toolsUsed?: string[];
  successRate?: number;
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
}

const allCaps: Cap[] = scenario.nodes.capabilities.filter(
  (c: Cap) => c.embedding?.length
);
const allEvents: Event[] = scenario.episodicEvents || [];
const allQueries: Query[] = scenario.testQueries || [];

// Get top 50 by frequency
const freq = new Map<string, number>();
for (const e of allEvents)
  freq.set(e.selectedCapability, (freq.get(e.selectedCapability) || 0) + 1);
const top50Ids = new Set(
  [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 50)
    .map(([id]) => id)
);

const caps = allCaps.filter((c) => top50Ids.has(c.id));
const events = allEvents.filter((e) => top50Ids.has(e.selectedCapability));
const queries = allQueries.filter((q) => top50Ids.has(q.expectedCapability));

// Build tool index with co-occurrence counts (edge weights)
const allTools = new Set<string>();
const toolCooccurrence = new Map<string, Map<string, number>>();

caps.forEach((c) => {
  const tools = c.toolsUsed || [];
  tools.forEach((t) => allTools.add(t));

  // Count tool co-occurrences within capability (edge weights)
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

console.log(
  `Data: ${caps.length} caps, ${toolList.length} tools, ${events.length} events, ${queries.length} queries`
);
console.log(
  `Edge weights: ${[...toolCooccurrence.values()].reduce((s, m) => s + m.size, 0)} tool-tool pairs with weights\n`
);

// ============================================================================
// Node Stats Calculator (for Node2Vec+)
// ============================================================================

interface NodeStats {
  mean: number;
  std: number;
}

function computeNodeStats(
  graph: Graph,
  nodeId: string
): NodeStats {
  const neighbors = graph.neighbors(nodeId);
  if (neighbors.length === 0) return { mean: 0, std: 0 };

  const weights: number[] = [];
  for (const neighbor of neighbors) {
    const weight = graph.getEdgeAttribute(nodeId, neighbor, "weight") || 1;
    weights.push(weight);
  }

  const mean = weights.reduce((a, b) => a + b, 0) / weights.length;
  const variance =
    weights.reduce((sum, w) => sum + (w - mean) ** 2, 0) / weights.length;
  const std = Math.sqrt(variance);

  return { mean, std };
}

// ============================================================================
// Node2Vec+ Normalized Weight
// ============================================================================

function normalizedWeight(
  weight: number,
  nodeStats: NodeStats,
  gamma: number = 1.0,
  epsilon: number = 1e-6
): number {
  const denominator = Math.max(nodeStats.mean + gamma * nodeStats.std, epsilon);
  return weight / denominator;
}

// ============================================================================
// Node2Vec+ Bias Computation
// ============================================================================

interface BiasParams {
  p: number; // Return parameter
  q: number; // In-out parameter
  gamma: number; // Node2Vec+ scaling factor
}

function computeNode2VecPlusBias(
  graph: Graph,
  prevNode: string | null,
  currentNode: string,
  nextNode: string,
  nodeStatsCache: Map<string, NodeStats>,
  params: BiasParams
): number {
  const { p, q, gamma } = params;

  // Case 1: Return to previous node
  if (prevNode && nextNode === prevNode) {
    return 1 / p;
  }

  // Get node stats for current node
  let currentStats = nodeStatsCache.get(currentNode);
  if (!currentStats) {
    currentStats = computeNodeStats(graph, currentNode);
    nodeStatsCache.set(currentNode, currentStats);
  }

  // Check if prev and next are connected
  const prevNextConnected = prevNode && graph.hasEdge(prevNode, nextNode);

  if (prevNextConnected) {
    // Get edge weight from prev to next
    const edgeWeight = graph.getEdgeAttribute(prevNode!, nextNode, "weight") || 1;
    const w_tilde = normalizedWeight(edgeWeight, currentStats, gamma);

    if (w_tilde >= 1) {
      // Strongly connected - BFS-like (stay local)
      return 1;
    } else {
      // Weakly connected - Node2Vec+ interpolation formula
      // bias = 1/q + (1 - 1/q) * w̃
      return 1 / q + (1 - 1 / q) * w_tilde;
    }
  } else {
    // Not connected to prev - DFS-like (explore)
    return 1 / q;
  }
}

// ============================================================================
// Standard Node2Vec Bias (for comparison)
// ============================================================================

function computeNode2VecBias(
  graph: Graph,
  prevNode: string | null,
  currentNode: string,
  nextNode: string,
  params: { p: number; q: number }
): number {
  const { p, q } = params;

  // Case 1: Return to previous node
  if (prevNode && nextNode === prevNode) {
    return 1 / p;
  }

  // Case 2: Connected to previous node (in-neighbor)
  if (prevNode && graph.hasEdge(prevNode, nextNode)) {
    return 1;
  }

  // Case 3: Not connected (out-neighbor) - DFS-like
  return 1 / q;
}

// ============================================================================
// Node2Vec Generators
// ============================================================================

interface Node2VecConfig {
  walkLength: number;
  walksPerNode: number;
  windowSize: number;
  embeddingDim: number;
  p: number;
  q: number;
}

interface Node2VecPlusConfig extends Node2VecConfig {
  gamma: number; // Node2Vec+ specific
}

function generateNode2VecEmbeddings(
  config: Node2VecConfig,
  usePlus: boolean = false,
  gamma: number = 1.0
): Map<string, number[]> {
  const { walkLength, walksPerNode, windowSize, embeddingDim, p, q } = config;

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
        } catch {
          /* edge exists */
        }
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
        // Edge exists, update weight
        const existing = graph.getEdgeAttribute(t1, t2, "weight") || 0;
        graph.setEdgeAttribute(t1, t2, "weight", existing + weight);
      }
    }
  }

  // Pre-compute node stats for Node2Vec+
  const nodeStatsCache = new Map<string, NodeStats>();
  if (usePlus) {
    graph.forEachNode((node: string) => {
      nodeStatsCache.set(node, computeNodeStats(graph, node));
    });
  }

  // Capability index
  const capIdx = new Map<string, number>();
  caps.forEach((c, i) => capIdx.set(c.id, i));

  // Biased random walk function
  function biasedRandomWalk(startNode: string, length: number): string[] {
    const walk = [startNode];
    let current = startNode;
    let prev: string | null = null;

    for (let i = 0; i < length - 1; i++) {
      const neighbors = graph.neighbors(current);
      if (neighbors.length === 0) break;

      // Compute transition probabilities
      const weights: number[] = [];
      for (const neighbor of neighbors) {
        const edgeWeight = graph.getEdgeAttribute(current, neighbor, "weight") || 1;

        let bias: number;
        if (usePlus) {
          bias = computeNode2VecPlusBias(
            graph,
            prev,
            current,
            neighbor,
            nodeStatsCache,
            { p, q, gamma }
          );
        } else {
          bias = computeNode2VecBias(graph, prev, current, neighbor, { p, q });
        }

        // Final weight = edge_weight * bias
        weights.push(edgeWeight * bias);
      }

      // Normalize and sample
      const totalWeight = weights.reduce((a, b) => a + b, 0);
      if (totalWeight === 0) break;

      const probs = weights.map((w) => w / totalWeight);
      const rand = Math.random();
      let cumSum = 0;
      let selectedIdx = 0;
      for (let j = 0; j < probs.length; j++) {
        cumSum += probs[j];
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
  const cooccurrence = new Map<string, Map<string, number>>();
  for (const cap of caps) cooccurrence.set(cap.id, new Map());

  for (const cap of caps) {
    for (let w = 0; w < walksPerNode; w++) {
      const walk = biasedRandomWalk(cap.id, walkLength);
      for (let i = 0; i < walk.length; i++) {
        if (walk[i] !== cap.id) continue;
        for (
          let j = Math.max(0, i - windowSize);
          j < Math.min(walk.length, i + windowSize + 1);
          j++
        ) {
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

  // PMI matrix
  const capList = caps.map((c) => c.id);
  const coocMatrix = new Array(caps.length)
    .fill(0)
    .map(() => new Array(caps.length).fill(0));
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

  const pmiMatrix = new Array(caps.length)
    .fill(0)
    .map(() => new Array(caps.length).fill(0));
  for (let i = 0; i < caps.length; i++) {
    for (let j = 0; j < caps.length; j++) {
      if (
        coocMatrix[i][j] > 0 &&
        rowSums[i] > 0 &&
        colSums[j] > 0 &&
        totalCooc > 0
      ) {
        const pxy = coocMatrix[i][j] / totalCooc;
        const px = rowSums[i] / totalCooc;
        const py = colSums[j] / totalCooc;
        const pmi = Math.log(pxy / (px * py));
        pmiMatrix[i][j] = Math.max(0, pmi);
      }
    }
  }

  // SVD
  const pmiMat = new Matrix(pmiMatrix);
  const svd = new SingularValueDecomposition(pmiMat);
  const U = svd.leftSingularVectors;
  const S = svd.diagonal;

  // Extract embeddings
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
// Evaluation Function
// ============================================================================

function evaluate(
  shgatCaps: Array<{
    id: string;
    embedding: number[];
    toolsUsed: string[];
    successRate: number;
    parents: string[];
    children: string[];
  }>
): { mrr: number; hit1: number; hit3: number } {
  const shgat = createSHGATFromCapabilities(shgatCaps, new Map(), {
    numHeads: 4,
    hiddenDim: 64,
  });

  const trainingExamples = events
    .filter((e) => e.intentEmbedding?.length)
    .map((e) => ({
      intentEmbedding: e.intentEmbedding!,
      contextTools: e.contextTools || [],
      candidateId: e.selectedCapability,
      outcome: e.outcome === "success" ? 1 : 0,
    }));

  trainSHGATOnEpisodes(shgat, trainingExamples, {
    epochs: 10,
    learningRate: 0.01,
  });

  let hits1 = 0,
    hits3 = 0,
    mrrSum = 0,
    evaluated = 0;

  for (const query of queries) {
    if (!query.intentEmbedding?.length) continue;

    const results = shgat.scoreAllCapabilities(query.intentEmbedding);
    const sorted = results
      .map((r) => ({ id: r.capabilityId, score: r.score }))
      .sort((a, b) => b.score - a.score);
    const idx = sorted.findIndex((s) => s.id === query.expectedCapability);
    const rank = idx >= 0 ? idx + 1 : 0;

    if (rank === 1) hits1++;
    if (rank > 0 && rank <= 3) hits3++;
    if (rank > 0) mrrSum += 1 / rank;
    evaluated++;
  }

  return {
    mrr: evaluated > 0 ? mrrSum / evaluated : 0,
    hit1: evaluated > 0 ? (hits1 / evaluated) * 100 : 0,
    hit3: evaluated > 0 ? (hits3 / evaluated) * 100 : 0,
  };
}

function buildHybridCaps(
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
// Benchmark Results Storage
// ============================================================================

interface BenchResult {
  config: string;
  mrr: number;
  hit1: number;
  hit3: number;
  method: "baseline" | "node2vec" | "node2vec+";
}

const results: BenchResult[] = [];

// Header
console.log(
  "Configuration                              │   MRR  │ Hit@1  │ Hit@3  │"
);
console.log(
  "───────────────────────────────────────────┼────────┼────────┼────────┤"
);

function logResult(
  config: string,
  r: { mrr: number; hit1: number; hit3: number },
  method: "baseline" | "node2vec" | "node2vec+"
) {
  console.log(
    `${config.padEnd(42)} │ ${r.mrr.toFixed(3).padStart(6)} │ ${(r.hit1.toFixed(1) + "%").padStart(6)} │ ${(r.hit3.toFixed(1) + "%").padStart(6)} │`
  );
  results.push({ config, ...r, method });
}

// ============================================================================
// 1. BGE-M3 Baseline
// ============================================================================

console.log("\n── Baseline ──");
const bgeCaps = caps.map((c) => ({
  id: c.id,
  embedding: c.embedding!,
  toolsUsed: c.toolsUsed || [],
  successRate: c.successRate || 0.5,
  parents: [] as string[],
  children: [] as string[],
}));
const bgeResult = evaluate(bgeCaps);
logResult("BGE-M3 only (baseline)", bgeResult, "baseline");

// ============================================================================
// 2. Standard Node2Vec (Current Implementation)
// ============================================================================

console.log("\n── Standard Node2Vec (no edge weights in bias) ──");

const n2vConfig: Node2VecConfig = {
  walkLength: 15,
  walksPerNode: 30,
  windowSize: 5,
  embeddingDim: 32,
  p: 1.0, // Standard p/q
  q: 1.0,
};

const n2vStandard = generateNode2VecEmbeddings(n2vConfig, false);
const hybridStandard = buildHybridCaps(n2vStandard, 0.7, n2vConfig.embeddingDim);
const n2vStandardResult = evaluate(hybridStandard);
logResult("BGE=70% + Node2Vec=30%", n2vStandardResult, "node2vec");

// ============================================================================
// 3. Node2Vec+ (Edge Weight-Aware)
// ============================================================================

console.log("\n── Node2Vec+ (edge weight-aware bias) ──");

// Test different gamma values
for (const gamma of [0.5, 1.0, 1.5, 2.0]) {
  const n2vPlus = generateNode2VecEmbeddings(n2vConfig, true, gamma);
  const hybridPlus = buildHybridCaps(n2vPlus, 0.7, n2vConfig.embeddingDim);
  const result = evaluate(hybridPlus);
  logResult(`BGE=70% + Node2Vec+ (γ=${gamma})`, result, "node2vec+");
}

// ============================================================================
// 4. Node2Vec+ with Different p/q Parameters
// ============================================================================

console.log("\n── Node2Vec+ p/q Tuning (γ=1.0) ──");

const pqCombos = [
  { p: 0.5, q: 2.0, desc: "p=0.5 q=2.0 (BFS-like)" },
  { p: 1.0, q: 1.0, desc: "p=1.0 q=1.0 (balanced)" },
  { p: 2.0, q: 0.5, desc: "p=2.0 q=0.5 (DFS-like)" },
  { p: 1.0, q: 0.5, desc: "p=1.0 q=0.5 (explore)" },
  { p: 0.5, q: 0.5, desc: "p=0.5 q=0.5 (hybrid)" },
];

for (const { p, q, desc } of pqCombos) {
  const config: Node2VecConfig = { ...n2vConfig, p, q };
  const n2vPlus = generateNode2VecEmbeddings(config, true, 1.0);
  const hybridPlus = buildHybridCaps(n2vPlus, 0.7, config.embeddingDim);
  const result = evaluate(hybridPlus);
  logResult(`Node2Vec+ ${desc}`, result, "node2vec+");
}

// ============================================================================
// 5. Best Configuration Search
// ============================================================================

console.log("\n── Optimized Node2Vec+ Configurations ──");

const optimizedConfigs = [
  { bgeWeight: 0.6, walkLength: 20, walksPerNode: 40, windowSize: 5, embeddingDim: 48, p: 1.0, q: 0.5, gamma: 1.0 },
  { bgeWeight: 0.5, walkLength: 15, walksPerNode: 50, windowSize: 5, embeddingDim: 64, p: 0.5, q: 0.5, gamma: 1.5 },
  { bgeWeight: 0.7, walkLength: 10, walksPerNode: 40, windowSize: 3, embeddingDim: 32, p: 1.0, q: 1.0, gamma: 1.0 },
];

for (const cfg of optimizedConfigs) {
  const config: Node2VecConfig = {
    walkLength: cfg.walkLength,
    walksPerNode: cfg.walksPerNode,
    windowSize: cfg.windowSize,
    embeddingDim: cfg.embeddingDim,
    p: cfg.p,
    q: cfg.q,
  };
  const n2vPlus = generateNode2VecEmbeddings(config, true, cfg.gamma);
  const hybridPlus = buildHybridCaps(n2vPlus, cfg.bgeWeight, config.embeddingDim);
  const result = evaluate(hybridPlus);
  logResult(
    `B${(cfg.bgeWeight * 100).toFixed(0)}/L${cfg.walkLength}/W${cfg.walksPerNode}/p${cfg.p}/q${cfg.q}/γ${cfg.gamma}`,
    result,
    "node2vec+"
  );
}

// ============================================================================
// Summary
// ============================================================================

console.log("\n" + "═".repeat(70));
console.log("                           SUMMARY");
console.log("═".repeat(70));

// Group by method
const baselineResults = results.filter((r) => r.method === "baseline");
const node2vecResults = results.filter((r) => r.method === "node2vec");
const node2vecPlusResults = results.filter((r) => r.method === "node2vec+");

const bestBaseline = baselineResults[0];
const bestNode2Vec = [...node2vecResults].sort((a, b) => b.mrr - a.mrr)[0];
const bestNode2VecPlus = [...node2vecPlusResults].sort((a, b) => b.mrr - a.mrr)[0];

console.log("\nBest by Method:");
console.log("─".repeat(70));
console.log(
  `Baseline (BGE-M3):     MRR=${bestBaseline?.mrr.toFixed(3) || "N/A"} Hit@3=${bestBaseline?.hit3.toFixed(1) || "N/A"}%`
);
console.log(
  `Node2Vec (standard):   MRR=${bestNode2Vec?.mrr.toFixed(3) || "N/A"} Hit@3=${bestNode2Vec?.hit3.toFixed(1) || "N/A"}% (+${(((bestNode2Vec?.mrr || 0) / (bestBaseline?.mrr || 1) - 1) * 100).toFixed(0)}%)`
);
console.log(
  `Node2Vec+ (weighted):  MRR=${bestNode2VecPlus?.mrr.toFixed(3) || "N/A"} Hit@3=${bestNode2VecPlus?.hit3.toFixed(1) || "N/A"}% (+${(((bestNode2VecPlus?.mrr || 0) / (bestBaseline?.mrr || 1) - 1) * 100).toFixed(0)}%)`
);

// Improvement of Node2Vec+ over standard Node2Vec
if (bestNode2Vec && bestNode2VecPlus) {
  const improvementVsN2V = ((bestNode2VecPlus.mrr / bestNode2Vec.mrr - 1) * 100).toFixed(1);
  console.log(
    `\n🎯 Node2Vec+ improvement over standard Node2Vec: +${improvementVsN2V}%`
  );
}

// Top 5 overall
console.log("\nTop 5 Configurations (all methods):");
console.log("─".repeat(70));
const sorted = [...results].sort((a, b) => b.mrr - a.mrr);
for (let i = 0; i < Math.min(5, sorted.length); i++) {
  const r = sorted[i];
  const tag = r.method === "node2vec+" ? "🔥" : r.method === "node2vec" ? "📊" : "📌";
  console.log(
    `${(i + 1).toString().padStart(2)}. ${tag} ${r.config.padEnd(38)} MRR=${r.mrr.toFixed(3)} Hit@3=${r.hit3.toFixed(1)}%`
  );
}

// Recommendation
console.log("\n" + "═".repeat(70));
console.log("                        RECOMMENDATION");
console.log("═".repeat(70));

if (bestNode2VecPlus && bestNode2Vec && bestNode2VecPlus.mrr > bestNode2Vec.mrr) {
  console.log("\n✅ Node2Vec+ OUTPERFORMS standard Node2Vec");
  console.log(`   Best config: ${bestNode2VecPlus.config}`);
  console.log(
    `   Update Epic 15 to use Node2Vec+ with edge weights in the Rust implementation`
  );
} else if (bestNode2Vec && bestNode2VecPlus && bestNode2Vec.mrr >= bestNode2VecPlus.mrr) {
  console.log("\n⚠️  Standard Node2Vec performs equally or better");
  console.log("   Edge weights may not provide significant benefit for this graph structure");
} else {
  console.log("\n📊 Inconclusive - need more data points");
}

console.log("\n");
