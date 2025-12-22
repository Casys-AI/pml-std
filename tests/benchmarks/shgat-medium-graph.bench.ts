/**
 * SHGAT Medium Graph Benchmark
 *
 * Tests SHGAT with real BGE-M3 embeddings on a richer dataset:
 * - 50 tools
 * - 10 capabilities
 * - 3 meta-capabilities
 * - 28 test queries
 *
 * Run manually:
 *   deno run --allow-all tests/benchmarks/shgat-medium-graph.bench.ts
 *
 * @module tests/benchmarks/shgat-medium-graph
 */

import {
  createSHGATFromCapabilities,
  type HypergraphFeatures,
} from "../../src/graphrag/algorithms/shgat.ts";
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

async function runBenchmark() {
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║       SHGAT Medium Graph Benchmark (BGE-M3)                ║");
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
    // Generate embeddings for tools
    // ========================================================================
    console.log("📊 Generating embeddings for tools...");
    const startTools = performance.now();

    const toolEmbeddings = new Map<string, number[]>();
    for (const tool of fixtureData.nodes.tools as ToolNode[]) {
      // Convert tool ID to description: "fs__read" → "filesystem read"
      const description = tool.id.replace(/__/g, " ").replace(/_/g, " ");
      const embedding = await embedder.encode(description);
      toolEmbeddings.set(tool.id, embedding);
    }

    console.log(`   ✓ ${toolEmbeddings.size} tools in ${((performance.now() - startTools) / 1000).toFixed(1)}s`);

    // ========================================================================
    // Generate embeddings for capabilities
    // ========================================================================
    console.log("📊 Generating embeddings for capabilities...");
    const startCaps = performance.now();

    const capabilities: Array<{
      id: string;
      embedding: number[];
      toolsUsed: string[];
      successRate: number;
      hypergraphFeatures?: HypergraphFeatures;
    }> = [];

    for (const cap of fixtureData.nodes.capabilities as CapabilityNode[]) {
      // Use rich description from fixture (much better for semantic matching)
      const embedding = await embedder.encode(cap.description);

      // Use hypergraph features from fixture (realistic, differentiated values)
      capabilities.push({
        id: cap.id,
        embedding,
        toolsUsed: cap.toolsUsed,
        successRate: cap.successRate,
        hypergraphFeatures: cap.hypergraphFeatures,
      });
    }

    console.log(`   ✓ ${capabilities.length} capabilities in ${((performance.now() - startCaps) / 1000).toFixed(1)}s`);

    // ========================================================================
    // Build hypergraph
    // ========================================================================
    console.log("🔨 Building hypergraph...");

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
    console.log(`   ✓ ${stats.registeredTools} tools, ${stats.registeredCapabilities} capabilities`);
    console.log(`   ✓ ${stats.incidenceNonZeros} incidence connections`);
    console.log(`   ✓ ${stats.paramCount.toLocaleString()} parameters\n`);

    // ========================================================================
    // Build DR-DSP from edges
    // ========================================================================
    console.log("🔨 Building DR-DSP hypergraph...");

    // Convert edges to hyperedges
    const hyperedges: Hyperedge[] = [];
    const edges = fixtureData.edges as EdgeData[];

    // Group edges by capability (tools that work together)
    for (const cap of fixtureData.nodes.capabilities as CapabilityNode[]) {
      // Find edges within this capability's tools
      const capEdges = edges.filter(
        (e) => cap.toolsUsed.includes(e.source) || cap.toolsUsed.includes(e.target)
      );

      if (capEdges.length > 0) {
        // Create hyperedge: sources are entry tools, targets are exit tools
        const sources = new Set<string>();
        const targets = new Set<string>();

        for (const edge of capEdges) {
          if (cap.toolsUsed.includes(edge.source)) sources.add(edge.source);
          if (cap.toolsUsed.includes(edge.target)) targets.add(edge.target);
        }

        // If all tools are sources or targets, split them
        if (sources.size === 0) {
          cap.toolsUsed.slice(0, Math.ceil(cap.toolsUsed.length / 2)).forEach((t) => sources.add(t));
        }
        if (targets.size === 0) {
          cap.toolsUsed.slice(Math.ceil(cap.toolsUsed.length / 2)).forEach((t) => targets.add(t));
        }

        hyperedges.push({
          id: cap.id,
          sources: Array.from(sources),
          targets: Array.from(targets),
          weight: 1 / cap.successRate, // Lower weight = better path
        });
      } else {
        // No edges found, use default split
        const mid = Math.ceil(cap.toolsUsed.length / 2);
        hyperedges.push({
          id: cap.id,
          sources: cap.toolsUsed.slice(0, mid),
          targets: cap.toolsUsed.slice(mid),
          weight: 1 / cap.successRate,
        });
      }
    }

    // Also add direct tool-to-tool edges from the fixture
    for (const edge of edges) {
      hyperedges.push({
        id: `edge_${edge.source}_${edge.target}`,
        sources: [edge.source],
        targets: [edge.target],
        weight: 1 / edge.weight, // Convert weight to cost
      });
    }

    const drdsp = new DRDSP(hyperedges);
    const drdspStats = drdsp.getStats();
    console.log(`   ✓ ${drdspStats.hyperedgeCount} hyperedges (10 caps + ${edges.length} edges)`);
    console.log(`   ✓ ${drdspStats.nodeCount} nodes connected`);
    console.log(`   ✓ Avg hyperedge size: ${drdspStats.avgHyperedgeSize.toFixed(1)}\n`);

    // ========================================================================
    // Run inference on test queries
    // ========================================================================
    console.log("🔍 Testing semantic inference on 28 queries...");
    console.log("─".repeat(70));

    const testQueries = fixtureData.testQueries as TestQuery[];

    let correctTop1 = 0;
    let correctTop2 = 0;
    let correctTop3 = 0;

    // Group by expected capability for display
    const resultsByCapability = new Map<string, {
      queries: string[];
      top1: number;
      top2: number;
      top3: number;
    }>();

    for (const { intent, expectedCapability } of testQueries) {
      const queryEmb = await embedder.encode(intent);
      const results = shgat.scoreAllCapabilities(queryEmb);

      const rank = results.findIndex(r => r.capabilityId === expectedCapability) + 1;
      const isTop1 = rank === 1;
      const isTop2 = rank <= 2;
      const isTop3 = rank <= 3;

      if (isTop1) correctTop1++;
      if (isTop2) correctTop2++;
      if (isTop3) correctTop3++;

      // Track by capability
      if (!resultsByCapability.has(expectedCapability)) {
        resultsByCapability.set(expectedCapability, { queries: [], top1: 0, top2: 0, top3: 0 });
      }
      const capResults = resultsByCapability.get(expectedCapability)!;
      capResults.queries.push(intent);
      if (isTop1) capResults.top1++;
      if (isTop2) capResults.top2++;
      if (isTop3) capResults.top3++;

      const emoji = isTop1 ? "✅" : isTop2 ? "🔶" : isTop3 ? "🟡" : "❌";
      const rankStr = rank > 10 ? ">10" : rank.toString();

      console.log(`  ${emoji} [${rankStr.padStart(2)}] "${intent.substring(0, 45).padEnd(45)}" → ${expectedCapability}`);
    }

    console.log("\n" + "─".repeat(70));

    // Summary by capability
    console.log("\n📊 Results by Capability:");
    console.log("─".repeat(50));

    for (const [capId, data] of [...resultsByCapability.entries()].sort()) {
      const pct = (data.top1 / data.queries.length * 100).toFixed(0);
      console.log(`   ${capId.padEnd(22)} ${data.top1}/${data.queries.length} Top-1 (${pct}%)`);
    }

    // Overall metrics
    console.log("\n" + "═".repeat(70));
    console.log("📊 Overall Precision:");
    console.log(`   Top-1: ${correctTop1}/${testQueries.length} (${(correctTop1 / testQueries.length * 100).toFixed(1)}%)`);
    console.log(`   Top-2: ${correctTop2}/${testQueries.length} (${(correctTop2 / testQueries.length * 100).toFixed(1)}%)`);
    console.log(`   Top-3: ${correctTop3}/${testQueries.length} (${(correctTop3 / testQueries.length * 100).toFixed(1)}%)`);
    console.log("═".repeat(70));

    // MRR (Mean Reciprocal Rank)
    let mrrSum = 0;
    for (const { intent, expectedCapability } of testQueries) {
      const queryEmb = await embedder.encode(intent);
      const results = shgat.scoreAllCapabilities(queryEmb);
      const rank = results.findIndex(r => r.capabilityId === expectedCapability) + 1;
      if (rank > 0) {
        mrrSum += 1 / rank;
      }
    }
    const mrr = mrrSum / testQueries.length;
    console.log(`\n📊 Mean Reciprocal Rank (MRR): ${mrr.toFixed(4)}`);

    // Qualitative assessment
    const top1Pct = correctTop1 / testQueries.length * 100;
    let assessment = "";
    if (top1Pct >= 85) {
      assessment = "🏆 EXCELLENT - Production ready";
    } else if (top1Pct >= 70) {
      assessment = "✅ GOOD - Needs minor tuning";
    } else if (top1Pct >= 50) {
      assessment = "⚠️ ACCEPTABLE - Needs improvement";
    } else {
      assessment = "❌ POOR - Requires significant work";
    }
    console.log(`\n${assessment}\n`);

    // ========================================================================
    // DR-DSP Pathfinding Tests
    // ========================================================================
    console.log("\n🛤️  Testing DR-DSP pathfinding...");
    console.log("─".repeat(70));

    // Test paths between different tool communities
    const pathTests = [
      { from: "fs__read", to: "json__parse", desc: "File → JSON parsing" },
      { from: "http__get", to: "db__insert", desc: "HTTP → DB insert (cross-cap)" },
      { from: "auth__login", to: "http__get", desc: "Auth → HTTP (dependency)" },
      { from: "cache__get", to: "db__query", desc: "Cache miss → DB query" },
      { from: "crypto__encrypt", to: "storage__upload", desc: "Encrypt → Upload" },
      { from: "queue__subscribe", to: "json__parse", desc: "Queue → JSON parsing" },
    ];

    let pathsFound = 0;
    for (const { from, to, desc } of pathTests) {
      const path = drdsp.findShortestHyperpath(from, to);
      const status = path.found ? "✅" : "❌";
      pathsFound += path.found ? 1 : 0;

      console.log(`  ${status} ${desc}`);
      if (path.found) {
        console.log(`     Path: ${path.nodeSequence.join(" → ")}`);
        console.log(`     Weight: ${path.totalWeight.toFixed(2)}, Hyperedges: ${path.path.length}`);
      }
    }

    console.log(`\n📊 Pathfinding: ${pathsFound}/${pathTests.length} paths found`);

    // ========================================================================
    // Combined Pipeline: SHGAT → DR-DSP
    // ========================================================================
    console.log("\n🔗 Testing combined SHGAT + DR-DSP pipeline...");
    console.log("─".repeat(70));

    // Simulate predictNextNode for a subset of queries
    const pipelineTests = testQueries.slice(0, 10); // First 10 queries
    let pipelineSuccess = 0;

    for (const { intent, expectedCapability } of pipelineTests) {
      const queryEmb = await embedder.encode(intent);

      // Step 1: SHGAT scores capabilities
      const results = shgat.scoreAllCapabilities(queryEmb);
      const bestCap = results[0];

      // Step 2: Get capability's tools
      const cap = (fixtureData.nodes.capabilities as CapabilityNode[]).find(
        (c) => c.id === bestCap.capabilityId
      );

      if (!cap) continue;

      // Step 3: DR-DSP finds path within capability (first to last tool)
      const firstTool = cap.toolsUsed[0];
      const lastTool = cap.toolsUsed[cap.toolsUsed.length - 1];
      const path = drdsp.findShortestHyperpath(firstTool, lastTool);

      // Step 4: Determine next tool suggestion
      const nextTool = path.found && path.nodeSequence.length > 1
        ? path.nodeSequence[1]
        : cap.toolsUsed[1] || cap.toolsUsed[0];

      const capCorrect = bestCap.capabilityId === expectedCapability;
      if (capCorrect) pipelineSuccess++;

      const emoji = capCorrect ? "✅" : "❌";
      console.log(`  ${emoji} "${intent.substring(0, 40).padEnd(40)}"`);
      console.log(`     Cap: ${bestCap.capabilityId} → Next: ${nextTool}`);
    }

    console.log(`\n📊 Pipeline: ${pipelineSuccess}/${pipelineTests.length} correct capability predictions`);

    // ========================================================================
    // Final Summary
    // ========================================================================
    console.log("\n" + "═".repeat(70));
    console.log("📊 FINAL SUMMARY (SHGAT + DR-DSP):");
    console.log(`   SHGAT Capability Precision:`);
    console.log(`     Top-1: ${correctTop1}/${testQueries.length} (${(correctTop1 / testQueries.length * 100).toFixed(1)}%)`);
    console.log(`     Top-3: ${correctTop3}/${testQueries.length} (${(correctTop3 / testQueries.length * 100).toFixed(1)}%)`);
    console.log(`     MRR: ${mrr.toFixed(4)}`);
    console.log(`   DR-DSP Pathfinding: ${pathsFound}/${pathTests.length} paths found`);
    console.log(`   Combined Pipeline: ${pipelineSuccess}/${pipelineTests.length} correct`);
    console.log("═".repeat(70));

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
