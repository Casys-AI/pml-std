/**
 * SHGAT vs Unified Search Benchmark
 *
 * Compares the accuracy of:
 * - Unified Search (ADR-050): score = semantic × reliability
 * - SHGAT: multi-head attention (semantic + structure + temporal)
 *
 * Uses the medium-graph dataset (10 capabilities, 50 tools, 28 queries).
 *
 * Run manually:
 *   deno run --allow-all tests/benchmarks/shgat-vs-unified-search.bench.ts
 *
 * @module tests/benchmarks/shgat-vs-unified-search
 */

import { createSHGATFromCapabilities } from "../../src/graphrag/algorithms/shgat.ts";
import { DRDSP, type Hyperedge } from "../../src/graphrag/algorithms/dr-dsp.ts";
import { EmbeddingModel } from "../../src/vector/embeddings.ts";

// Load fixture
const fixtureData = JSON.parse(
  await Deno.readTextFile("tests/benchmarks/fixtures/scenarios/medium-graph.json")
);

interface ToolNode {
  id: string;
  pageRank: number;
  community: number;
}

interface CapabilityNode {
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
}

interface TestQuery {
  intent: string;
  expectedCapability: string;
}

interface EdgeData {
  source: string;
  target: string;
  type: string;
  weight: number;
}

/**
 * Unified Search (Simplified per ADR-050)
 *
 * score = cosineSim(query, capability) × reliabilityFactor
 *
 * No graph score (contextNodes is empty in Search mode).
 */
function unifiedSearchScore(
  queryEmbedding: number[],
  capabilityEmbedding: number[],
  successRate: number
): number {
  // Cosine similarity
  let dot = 0, normQ = 0, normC = 0;
  for (let i = 0; i < queryEmbedding.length; i++) {
    dot += queryEmbedding[i] * capabilityEmbedding[i];
    normQ += queryEmbedding[i] * queryEmbedding[i];
    normC += capabilityEmbedding[i] * capabilityEmbedding[i];
  }
  const semantic = dot / (Math.sqrt(normQ) * Math.sqrt(normC) + 1e-8);

  // Reliability factor (ADR-038)
  let reliabilityFactor = 1.0;
  if (successRate < 0.5) reliabilityFactor = 0.1;
  else if (successRate > 0.9) reliabilityFactor = 1.2;

  return Math.min(semantic * reliabilityFactor, 0.95);
}

async function runBenchmark() {
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║       SHGAT vs Unified Search Benchmark                    ║");
  console.log("╚════════════════════════════════════════════════════════════╝\n");

  console.log(`📋 Dataset: ${fixtureData.name}`);
  console.log(`   ${fixtureData.description}\n`);

  console.log("🔄 Loading BGE-M3 model (may take 60-90s first time)...");
  const startLoad = performance.now();

  const embedder = new EmbeddingModel();
  await embedder.load();

  console.log(`✓ Model loaded in ${((performance.now() - startLoad) / 1000).toFixed(1)}s\n`);

  try {
    // ========================================================================
    // Generate embeddings for capabilities
    // ========================================================================
    console.log("📊 Generating embeddings for capabilities...");
    const startCaps = performance.now();

    const capabilities: Array<{
      id: string;
      embedding: number[];
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
    }> = [];

    for (const cap of fixtureData.nodes.capabilities as CapabilityNode[]) {
      const embedding = await embedder.encode(cap.description);
      capabilities.push({
        id: cap.id,
        embedding,
        description: cap.description,
        toolsUsed: cap.toolsUsed,
        successRate: cap.successRate,
        hypergraphFeatures: cap.hypergraphFeatures,
      });
    }

    console.log(`   ✓ ${capabilities.length} capabilities in ${((performance.now() - startCaps) / 1000).toFixed(1)}s`);

    // ========================================================================
    // Generate embeddings for tools (needed for SHGAT)
    // ========================================================================
    console.log("📊 Generating embeddings for tools...");
    const startTools = performance.now();

    const toolEmbeddings = new Map<string, number[]>();
    for (const tool of fixtureData.nodes.tools as ToolNode[]) {
      const description = tool.id.replace(/__/g, " ").replace(/_/g, " ");
      const embedding = await embedder.encode(description);
      toolEmbeddings.set(tool.id, embedding);
    }

    console.log(`   ✓ ${toolEmbeddings.size} tools in ${((performance.now() - startTools) / 1000).toFixed(1)}s`);

    // ========================================================================
    // Build SHGAT
    // ========================================================================
    console.log("🔨 Building SHGAT...");

    const shgat = createSHGATFromCapabilities(
      capabilities,
      toolEmbeddings,
      {
        numHeads: 4,
        hiddenDim: 64,
        numLayers: 2,
        embeddingDim: 1024,
      },
    );

    const stats = shgat.getStats();
    console.log(`   ✓ ${stats.registeredCapabilities} capabilities, ${stats.paramCount.toLocaleString()} parameters\n`);

    // ========================================================================
    // Run comparison on test queries
    // ========================================================================
    console.log("🔍 Testing on 28 queries...\n");
    console.log("─".repeat(85));
    console.log(`  ${"Query".padEnd(45)} | ${"Expected".padEnd(18)} | US | SHGAT`);
    console.log("─".repeat(85));

    const testQueries = fixtureData.testQueries as TestQuery[];

    let usCorrectTop1 = 0;
    let usCorrectTop3 = 0;
    let shgatCorrectTop1 = 0;
    let shgatCorrectTop3 = 0;

    // Track per-capability results
    const perCapability = new Map<string, { us: number; shgat: number; total: number }>();

    for (const { intent, expectedCapability } of testQueries) {
      const queryEmb = await embedder.encode(intent);

      // --- Unified Search ---
      const usScores = capabilities.map(cap => ({
        id: cap.id,
        score: unifiedSearchScore(queryEmb, cap.embedding, cap.successRate),
      }));
      usScores.sort((a, b) => b.score - a.score);
      const usRank = usScores.findIndex(r => r.id === expectedCapability) + 1;

      // --- SHGAT ---
      const shgatResults = shgat.scoreAllCapabilities(queryEmb);
      const shgatRank = shgatResults.findIndex(r => r.capabilityId === expectedCapability) + 1;

      // Track results
      const usTop1 = usRank === 1;
      const usTop3 = usRank <= 3;
      const shgatTop1 = shgatRank === 1;
      const shgatTop3 = shgatRank <= 3;

      if (usTop1) usCorrectTop1++;
      if (usTop3) usCorrectTop3++;
      if (shgatTop1) shgatCorrectTop1++;
      if (shgatTop3) shgatCorrectTop3++;

      // Per-capability tracking
      if (!perCapability.has(expectedCapability)) {
        perCapability.set(expectedCapability, { us: 0, shgat: 0, total: 0 });
      }
      const capStats = perCapability.get(expectedCapability)!;
      capStats.total++;
      if (usTop1) capStats.us++;
      if (shgatTop1) capStats.shgat++;

      // Display row
      const usEmoji = usTop1 ? "✅" : usTop3 ? "🔶" : "❌";
      const shgatEmoji = shgatTop1 ? "✅" : shgatTop3 ? "🔶" : "❌";
      const shortIntent = intent.length > 43 ? intent.substring(0, 40) + "..." : intent;

      console.log(`  ${shortIntent.padEnd(45)} | ${expectedCapability.padEnd(18)} | ${usEmoji} | ${shgatEmoji}`);
    }

    console.log("─".repeat(85));

    // ========================================================================
    // Summary
    // ========================================================================
    console.log("\n" + "═".repeat(85));
    console.log("📊 OVERALL RESULTS:");
    console.log("═".repeat(85));

    const usTop1Pct = (usCorrectTop1 / testQueries.length * 100).toFixed(1);
    const usTop3Pct = (usCorrectTop3 / testQueries.length * 100).toFixed(1);
    const shgatTop1Pct = (shgatCorrectTop1 / testQueries.length * 100).toFixed(1);
    const shgatTop3Pct = (shgatCorrectTop3 / testQueries.length * 100).toFixed(1);

    console.log(`\n  ${"Algorithm".padEnd(20)} | ${"Top-1".padEnd(12)} | ${"Top-3".padEnd(12)}`);
    console.log("  " + "─".repeat(50));
    console.log(`  ${"Unified Search".padEnd(20)} | ${`${usCorrectTop1}/${testQueries.length} (${usTop1Pct}%)`.padEnd(12)} | ${`${usCorrectTop3}/${testQueries.length} (${usTop3Pct}%)`.padEnd(12)}`);
    console.log(`  ${"SHGAT".padEnd(20)} | ${`${shgatCorrectTop1}/${testQueries.length} (${shgatTop1Pct}%)`.padEnd(12)} | ${`${shgatCorrectTop3}/${testQueries.length} (${shgatTop3Pct}%)`.padEnd(12)}`);

    // Improvement
    const improvement = shgatCorrectTop1 - usCorrectTop1;
    const improvementPct = ((shgatCorrectTop1 - usCorrectTop1) / usCorrectTop1 * 100).toFixed(1);
    console.log(`\n  📈 SHGAT improvement: ${improvement > 0 ? "+" : ""}${improvement} queries (${improvement > 0 ? "+" : ""}${improvementPct}%)`);

    // ========================================================================
    // Per-capability breakdown
    // ========================================================================
    console.log("\n" + "═".repeat(85));
    console.log("📊 PER-CAPABILITY BREAKDOWN:");
    console.log("═".repeat(85));

    console.log(`\n  ${"Capability".padEnd(22)} | ${"US Top-1".padEnd(12)} | ${"SHGAT Top-1".padEnd(12)} | Winner`);
    console.log("  " + "─".repeat(60));

    for (const [capId, stats] of [...perCapability.entries()].sort()) {
      const usPct = (stats.us / stats.total * 100).toFixed(0);
      const shgatPct = (stats.shgat / stats.total * 100).toFixed(0);
      let winner = "Tie";
      if (stats.shgat > stats.us) winner = "SHGAT ✅";
      else if (stats.us > stats.shgat) winner = "US ⚠️";

      console.log(`  ${capId.padEnd(22)} | ${`${stats.us}/${stats.total} (${usPct}%)`.padEnd(12)} | ${`${stats.shgat}/${stats.total} (${shgatPct}%)`.padEnd(12)} | ${winner}`);
    }

    // ========================================================================
    // MRR Comparison
    // ========================================================================
    console.log("\n" + "═".repeat(85));
    console.log("📊 MEAN RECIPROCAL RANK (MRR):");
    console.log("═".repeat(85));

    let usMrr = 0;
    let shgatMrr = 0;

    for (const { intent, expectedCapability } of testQueries) {
      const queryEmb = await embedder.encode(intent);

      // US
      const usScores = capabilities.map(cap => ({
        id: cap.id,
        score: unifiedSearchScore(queryEmb, cap.embedding, cap.successRate),
      }));
      usScores.sort((a, b) => b.score - a.score);
      const usRank = usScores.findIndex(r => r.id === expectedCapability) + 1;
      if (usRank > 0) usMrr += 1 / usRank;

      // SHGAT
      const shgatResults = shgat.scoreAllCapabilities(queryEmb);
      const shgatRank = shgatResults.findIndex(r => r.capabilityId === expectedCapability) + 1;
      if (shgatRank > 0) shgatMrr += 1 / shgatRank;
    }

    usMrr /= testQueries.length;
    shgatMrr /= testQueries.length;

    console.log(`\n  Unified Search MRR: ${usMrr.toFixed(4)}`);
    console.log(`  SHGAT MRR:          ${shgatMrr.toFixed(4)}`);
    console.log(`  Improvement:        ${shgatMrr > usMrr ? "+" : ""}${((shgatMrr - usMrr) / usMrr * 100).toFixed(1)}%`);

    // ========================================================================
    // SUGGESTION MODE (Backward) - SHGAT + DR-DSP
    // ========================================================================
    console.log("\n" + "═".repeat(85));
    console.log("📊 SUGGESTION MODE (SHGAT + DR-DSP backward paths):");
    console.log("═".repeat(85));
    console.log("\n  In Suggestion mode, we score capabilities AND provide execution paths.");
    console.log("  SHGAT uses graph structure features (pageRank, spectral, adamicAdar)");
    console.log("  to prefer well-connected capabilities with better paths.\n");

    // Build DR-DSP hypergraph
    const hyperedges: Hyperedge[] = [];
    const edges = fixtureData.edges as EdgeData[];

    // Add capability hyperedges
    for (const cap of capabilities) {
      const mid = Math.ceil(cap.toolsUsed.length / 2);
      hyperedges.push({
        id: cap.id,
        sources: cap.toolsUsed.slice(0, mid),
        targets: cap.toolsUsed.slice(mid),
        weight: 1 / cap.successRate,
      });
    }

    // Add tool-to-tool edges
    for (const edge of edges) {
      hyperedges.push({
        id: `edge_${edge.source}_${edge.target}`,
        sources: [edge.source],
        targets: [edge.target],
        weight: 1 / edge.weight,
      });
    }

    const drdsp = new DRDSP(hyperedges);

    // Test suggestion mode: capability + path quality
    let suggestionShgatWins = 0;
    let suggestionUsWins = 0;
    let suggestionTies = 0;

    console.log(`  ${"Query".padEnd(40)} | US → Path | SHGAT → Path | Winner`);
    console.log("  " + "─".repeat(70));

    for (const { intent, expectedCapability } of testQueries.slice(0, 14)) {
      const queryEmb = await embedder.encode(intent);

      // Unified Search pick
      const usScores = capabilities.map(cap => ({
        id: cap.id,
        score: unifiedSearchScore(queryEmb, cap.embedding, cap.successRate),
        tools: cap.toolsUsed,
      }));
      usScores.sort((a, b) => b.score - a.score);
      const usBest = usScores[0];

      // SHGAT pick
      const shgatResults = shgat.scoreAllCapabilities(queryEmb);
      const shgatBest = shgatResults[0];
      const shgatCap = capabilities.find(c => c.id === shgatBest.capabilityId)!;

      // Check if DR-DSP can find paths for both
      const usPath = drdsp.findShortestHyperpath(usBest.tools[0], usBest.tools[usBest.tools.length - 1]);
      const shgatPath = drdsp.findShortestHyperpath(shgatCap.toolsUsed[0], shgatCap.toolsUsed[shgatCap.toolsUsed.length - 1]);

      // Score: correct capability + valid path
      const usCorrect = usBest.id === expectedCapability;
      const shgatCorrect = shgatBest.capabilityId === expectedCapability;

      // Combined score: capability correctness + path quality
      const usScore = (usCorrect ? 2 : 0) + (usPath.found ? 1 : 0);
      const shgatScore = (shgatCorrect ? 2 : 0) + (shgatPath.found ? 1 : 0);

      let winner = "Tie";
      if (shgatScore > usScore) {
        suggestionShgatWins++;
        winner = "SHGAT ✅";
      } else if (usScore > shgatScore) {
        suggestionUsWins++;
        winner = "US ⚠️";
      } else {
        suggestionTies++;
      }

      const shortIntent = intent.length > 38 ? intent.substring(0, 35) + "..." : intent;
      const usStatus = `${usCorrect ? "✓" : "✗"}/${usPath.found ? "✓" : "✗"}`;
      const shgatStatus = `${shgatCorrect ? "✓" : "✗"}/${shgatPath.found ? "✓" : "✗"}`;

      console.log(`  ${shortIntent.padEnd(40)} | ${usStatus.padEnd(9)} | ${shgatStatus.padEnd(12)} | ${winner}`);
    }

    console.log("\n  Legend: Cap/Path (✓=correct/found, ✗=wrong/not found)");
    console.log(`\n  Suggestion Mode Results (first 14 queries):`);
    console.log(`    SHGAT wins: ${suggestionShgatWins}`);
    console.log(`    US wins:    ${suggestionUsWins}`);
    console.log(`    Ties:       ${suggestionTies}`);

    // ========================================================================
    // TOOL SCORING: Cosine vs SHGAT Multi-Head Attention
    // ========================================================================
    console.log("\n" + "═".repeat(85));
    console.log("📊 TOOL SCORING: Cosine Baseline vs SHGAT Multi-Head Attention");
    console.log("═".repeat(85));
    console.log("\n  SHGAT for tools uses ToolGraphFeatures (simple graph algorithms):");
    console.log("  - Head 2 (Structure): PageRank + Louvain + AdamicAdar");
    console.log("  - Head 3 (Temporal): Cooccurrence + Recency\n");

    // Tool test queries - map intent to expected tool
    const toolQueries = [
      { intent: "read a file from disk", expectedTool: "fs__read" },
      { intent: "write content to a file", expectedTool: "fs__write" },
      { intent: "list directory contents", expectedTool: "fs__list" },
      { intent: "delete a file", expectedTool: "fs__delete" },
      { intent: "copy a file", expectedTool: "fs__copy" },
      { intent: "execute a git command", expectedTool: "git__run" },
      { intent: "commit changes to git", expectedTool: "git__commit" },
      { intent: "run npm install", expectedTool: "npm__install" },
      { intent: "execute shell command", expectedTool: "shell__exec" },
      { intent: "search for text in files", expectedTool: "search__grep" },
    ];

    // Filter to tools that exist in fixture
    const toolIds = (fixtureData.nodes.tools as ToolNode[]).map(t => t.id);
    const validToolQueries = toolQueries.filter(q => toolIds.includes(q.expectedTool));

    if (validToolQueries.length === 0) {
      console.log("  ⚠️ No matching tool queries found in fixture - skipping tool benchmark");
    } else {
      // Populate tool features in SHGAT
      for (const tool of fixtureData.nodes.tools as ToolNode[]) {
        shgat.updateToolFeatures(tool.id, {
          pageRank: tool.pageRank,
          louvainCommunity: tool.community,
          adamicAdar: 0.1,
          cooccurrence: 0.2,
          recency: 0.5,
        });
      }

      let cosineCorrect = 0;
      let shgatToolCorrect = 0;

      console.log(`  ${"Query".padEnd(35)} | ${"Expected".padEnd(15)} | Cos | SHGAT`);
      console.log("  " + "─".repeat(70));

      for (const { intent, expectedTool } of validToolQueries) {
        const queryEmb = await embedder.encode(intent);

        // Cosine baseline
        const cosineScores: Array<{ id: string; score: number }> = [];
        for (const [toolId, toolEmb] of toolEmbeddings) {
          let dot = 0, normQ = 0, normT = 0;
          for (let i = 0; i < queryEmb.length; i++) {
            dot += queryEmb[i] * toolEmb[i];
            normQ += queryEmb[i] * queryEmb[i];
            normT += toolEmb[i] * toolEmb[i];
          }
          cosineScores.push({ id: toolId, score: dot / (Math.sqrt(normQ) * Math.sqrt(normT) + 1e-8) });
        }
        cosineScores.sort((a, b) => b.score - a.score);
        const cosineTop1 = cosineScores[0]?.id === expectedTool;
        if (cosineTop1) cosineCorrect++;

        // SHGAT multi-head
        const shgatToolResults = shgat.scoreAllTools(queryEmb);
        const shgatTop1 = shgatToolResults[0]?.toolId === expectedTool;
        if (shgatTop1) shgatToolCorrect++;

        const cosEmoji = cosineTop1 ? "✅" : "❌";
        const shgatEmoji = shgatTop1 ? "✅" : "❌";
        console.log(`  ${intent.padEnd(35)} | ${expectedTool.padEnd(15)} | ${cosEmoji}  | ${shgatEmoji}`);
      }

      console.log("  " + "─".repeat(70));
      console.log(`\n  Tool Scoring Results (${validToolQueries.length} queries):`);
      console.log(`    Cosine Baseline:    ${cosineCorrect}/${validToolQueries.length} (${(cosineCorrect/validToolQueries.length*100).toFixed(0)}%)`);
      console.log(`    SHGAT Multi-Head:   ${shgatToolCorrect}/${validToolQueries.length} (${(shgatToolCorrect/validToolQueries.length*100).toFixed(0)}%)`);

      const toolImprovement = shgatToolCorrect - cosineCorrect;
      if (toolImprovement > 0) {
        console.log(`    📈 SHGAT improvement: +${toolImprovement} queries`);
      } else if (toolImprovement < 0) {
        console.log(`    ⚠️ Cosine wins by: ${-toolImprovement} queries`);
      } else {
        console.log(`    🤝 Tie`);
      }
    }

    // ========================================================================
    // Assessment
    // ========================================================================
    console.log("\n" + "═".repeat(85));

    if (shgatCorrectTop1 > usCorrectTop1) {
      console.log("🏆 SHGAT outperforms Unified Search");
      console.log("   SHGAT's multi-head attention (semantic + structure + temporal) provides");
      console.log("   better capability matching than pure semantic × reliability.");
    } else if (shgatCorrectTop1 === usCorrectTop1) {
      console.log("🤝 SHGAT matches Unified Search");
      console.log("   Both algorithms perform equally well on this dataset.");
    } else {
      console.log("⚠️ Unified Search outperforms SHGAT");
      console.log("   The simpler formula works better for this dataset.");
    }

    console.log("═".repeat(85));

    console.log("\n╔════════════════════════════════════════════════════════════╗");
    console.log("║                    BENCHMARK COMPLETE                      ║");
    console.log("╚════════════════════════════════════════════════════════════╝\n");

  } finally {
    console.log("🧹 Disposing embedding model...");
    await embedder.dispose();
  }
}

// Run benchmark
if (import.meta.main) {
  await runBenchmark();
}
