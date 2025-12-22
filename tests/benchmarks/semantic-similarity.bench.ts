/**
 * Semantic Similarity Benchmark: Cosine vs Transformer Attention
 *
 * Compares SHGAT with cosine semantic heads vs SHGAT with transformer semantic heads.
 *
 * Run with:
 *   deno run --allow-all tests/benchmarks/semantic-similarity.bench.ts
 *
 * Metrics:
 * - Accuracy: % correct top-1 predictions
 * - MRR: Mean Reciprocal Rank
 * - Latency: Time per inference
 *
 * @module tests/benchmarks/semantic-similarity
 */

import { EmbeddingModel } from "../../src/vector/embeddings.ts";
import {
  createSHGATFromCapabilities,
  trainSHGATOnEpisodes,
  type TrainingExample,
} from "../../src/graphrag/algorithms/shgat.ts";
import {
  createSHGATTransformerFromCapabilities,
  trainSHGATTransformerOnEpisodes,
} from "../../src/graphrag/algorithms/shgat-transformer.ts";

// ============================================================================
// Types
// ============================================================================

interface BenchmarkResult {
  name: string;
  accuracy: number;
  mrr: number;
  latencyMs: number;
  trainTimeMs: number;
  paramCount?: number;
}

// ============================================================================
// Benchmark Runner
// ============================================================================

async function runBenchmark() {
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║   SHGAT Cosine vs Transformer Semantic Heads Benchmark     ║");
  console.log("╚════════════════════════════════════════════════════════════╝\n");

  // Load fixture
  const fixtureData = JSON.parse(
    await Deno.readTextFile("tests/benchmarks/fixtures/scenarios/episodic-training.json")
  );

  console.log("🔄 Loading BGE-M3 model...");
  const embedder = new EmbeddingModel();
  await embedder.load();
  console.log("✓ Model loaded\n");

  try {
    // ========================================================================
    // Generate embeddings
    // ========================================================================
    console.log("📊 Generating embeddings...");

    const capabilityEmbeddings = new Map<string, number[]>();
    for (const cap of fixtureData.nodes.capabilities) {
      const description = cap.description || cap.id.replace("cap__", "").replace(/_/g, " ");
      capabilityEmbeddings.set(cap.id, await embedder.encode(description));
    }

    const toolEmbeddings = new Map<string, number[]>();
    for (const tool of fixtureData.nodes.tools) {
      const desc = tool.id.replace(/__/g, " ").replace(/_/g, " ");
      toolEmbeddings.set(tool.id, await embedder.encode(desc));
    }

    console.log(`   ✓ ${capabilityEmbeddings.size} capabilities, ${toolEmbeddings.size} tools`);

    // Build capability data
    const capabilities: Array<{
      id: string;
      embedding: number[];
      toolsUsed: string[];
      successRate: number;
    }> = [];

    for (const cap of fixtureData.nodes.capabilities) {
      capabilities.push({
        id: cap.id,
        embedding: capabilityEmbeddings.get(cap.id)!,
        toolsUsed: cap.toolsUsed,
        successRate: cap.successRate,
      });
    }

    // Create training examples
    const trainingExamples: TrainingExample[] = [];
    for (const event of fixtureData.episodicEvents) {
      trainingExamples.push({
        intentEmbedding: await embedder.encode(event.intent),
        contextTools: event.contextTools,
        candidateId: event.selectedCapability,
        outcome: event.outcome === "success" ? 1 : 0,
      });
    }

    console.log(`   ✓ ${trainingExamples.length} training examples\n`);

    // Create test queries
    const testQueries: Array<{ intent: string; intentEmb: number[]; expected: string }> = [];
    for (const event of fixtureData.episodicEvents) {
      testQueries.push({
        intent: event.intent,
        intentEmb: await embedder.encode(event.intent),
        expected: event.selectedCapability,
      });
    }

    const results: BenchmarkResult[] = [];

    // ========================================================================
    // 1. SHGAT with Cosine (baseline)
    // ========================================================================
    console.log("📏 Testing SHGAT with Cosine semantic heads (baseline)...");

    const shgatCosine = createSHGATFromCapabilities(capabilities, toolEmbeddings, {
      numHeads: 4,
      hiddenDim: 64,
      numLayers: 2,
      embeddingDim: 1024,
    });

    // Update features
    for (const cap of fixtureData.nodes.capabilities) {
      const toolNodes = fixtureData.nodes.tools.filter((t: { id: string }) =>
        cap.toolsUsed.includes(t.id)
      );
      const avgPageRank = toolNodes.length > 0
        ? toolNodes.reduce((sum: number, t: { pageRank: number }) => sum + t.pageRank, 0) / toolNodes.length
        : 0.01;
      shgatCosine.updateHypergraphFeatures(cap.id, {
        spectralCluster: toolNodes[0]?.community || 0,
        hypergraphPageRank: avgPageRank,
        cooccurrence: 0.5,
        recency: 0.5,
      });
    }

    const startTrainCosine = performance.now();
    await trainSHGATOnEpisodes(shgatCosine, trainingExamples, (id) => toolEmbeddings.get(id) || null, {
      epochs: 20,
      batchSize: 4,
    });
    const trainTimeCosine = performance.now() - startTrainCosine;

    // Evaluate
    let correctCosine = 0;
    let mrrCosine = 0;
    let latencyCosine = 0;

    for (const query of testQueries) {
      const start = performance.now();
      const results = shgatCosine.scoreAllCapabilities(query.intentEmb, []);
      latencyCosine += performance.now() - start;

      const rank = results.findIndex(r => r.capabilityId === query.expected) + 1;
      if (rank === 1) correctCosine++;
      mrrCosine += 1 / rank;
    }

    const cosineStats = shgatCosine.getStats();
    results.push({
      name: "SHGAT + Cosine",
      accuracy: correctCosine / testQueries.length,
      mrr: mrrCosine / testQueries.length,
      latencyMs: latencyCosine / testQueries.length,
      trainTimeMs: trainTimeCosine,
      paramCount: cosineStats.paramCount,
    });

    console.log(`   Train: ${trainTimeCosine.toFixed(0)}ms | Acc: ${(correctCosine / testQueries.length * 100).toFixed(1)}% | MRR: ${(mrrCosine / testQueries.length).toFixed(4)}\n`);

    // ========================================================================
    // 2. SHGAT with Transformer semantic heads
    // ========================================================================
    console.log("🔷 Testing SHGAT with Transformer semantic heads...");

    const shgatTransformer = createSHGATTransformerFromCapabilities(capabilities, toolEmbeddings, {
      numHeads: 4,
      hiddenDim: 64,
      numLayers: 2,
      embeddingDim: 1024,
      useTransformerSemantic: true,
      semanticProjectionDim: 128,
      learningRate: 0.001,
      l2Lambda: 0.0001,
    });

    // Update features
    for (const cap of fixtureData.nodes.capabilities) {
      const toolNodes = fixtureData.nodes.tools.filter((t: { id: string }) =>
        cap.toolsUsed.includes(t.id)
      );
      const avgPageRank = toolNodes.length > 0
        ? toolNodes.reduce((sum: number, t: { pageRank: number }) => sum + t.pageRank, 0) / toolNodes.length
        : 0.01;
      shgatTransformer.updateHypergraphFeatures(cap.id, {
        spectralCluster: toolNodes[0]?.community || 0,
        hypergraphPageRank: avgPageRank,
        cooccurrence: 0.5,
        recency: 0.5,
      });
    }

    const startTrainTransformer = performance.now();
    await trainSHGATTransformerOnEpisodes(shgatTransformer, trainingExamples, (id) => toolEmbeddings.get(id) || null, {
      epochs: 50, // More epochs for transformer
      batchSize: 4,
      onEpoch: (epoch, loss, acc) => {
        if (epoch % 10 === 0) {
          console.log(`   Epoch ${epoch}: loss=${loss.toFixed(4)}, acc=${(acc * 100).toFixed(0)}%`);
        }
      },
    });
    const trainTimeTransformer = performance.now() - startTrainTransformer;

    // Evaluate
    let correctTransformer = 0;
    let mrrTransformer = 0;
    let latencyTransformer = 0;

    for (const query of testQueries) {
      const start = performance.now();
      const results = shgatTransformer.scoreAllCapabilities(query.intentEmb, []);
      latencyTransformer += performance.now() - start;

      const rank = results.findIndex(r => r.capabilityId === query.expected) + 1;
      if (rank === 1) correctTransformer++;
      mrrTransformer += 1 / rank;
    }

    const transformerStats = shgatTransformer.getTransformerStats();
    const baseStats = shgatTransformer.getStats();
    results.push({
      name: "SHGAT + Transformer",
      accuracy: correctTransformer / testQueries.length,
      mrr: mrrTransformer / testQueries.length,
      latencyMs: latencyTransformer / testQueries.length,
      trainTimeMs: trainTimeTransformer,
      paramCount: baseStats.paramCount + transformerStats.semanticParamCount,
    });

    console.log(`   Train: ${trainTimeTransformer.toFixed(0)}ms | Acc: ${(correctTransformer / testQueries.length * 100).toFixed(1)}% | MRR: ${(mrrTransformer / testQueries.length).toFixed(4)}\n`);

    // ========================================================================
    // 3. SHGAT with Transformer (more training)
    // ========================================================================
    console.log("🔷 Testing SHGAT + Transformer (100 epochs)...");

    const shgatTransformer100 = createSHGATTransformerFromCapabilities(capabilities, toolEmbeddings, {
      numHeads: 4,
      hiddenDim: 64,
      numLayers: 2,
      embeddingDim: 1024,
      useTransformerSemantic: true,
      semanticProjectionDim: 128,
      learningRate: 0.0005, // Lower LR for more epochs
      l2Lambda: 0.001, // More regularization
    });

    for (const cap of fixtureData.nodes.capabilities) {
      const toolNodes = fixtureData.nodes.tools.filter((t: { id: string }) =>
        cap.toolsUsed.includes(t.id)
      );
      const avgPageRank = toolNodes.length > 0
        ? toolNodes.reduce((sum: number, t: { pageRank: number }) => sum + t.pageRank, 0) / toolNodes.length
        : 0.01;
      shgatTransformer100.updateHypergraphFeatures(cap.id, {
        spectralCluster: toolNodes[0]?.community || 0,
        hypergraphPageRank: avgPageRank,
        cooccurrence: 0.5,
        recency: 0.5,
      });
    }

    const startTrainTransformer100 = performance.now();
    await trainSHGATTransformerOnEpisodes(shgatTransformer100, trainingExamples, (id) => toolEmbeddings.get(id) || null, {
      epochs: 100,
      batchSize: 4,
      onEpoch: (epoch, loss, acc) => {
        if (epoch % 25 === 0) {
          console.log(`   Epoch ${epoch}: loss=${loss.toFixed(4)}, acc=${(acc * 100).toFixed(0)}%`);
        }
      },
    });
    const trainTimeTransformer100 = performance.now() - startTrainTransformer100;

    let correctTransformer100 = 0;
    let mrrTransformer100 = 0;
    let latencyTransformer100 = 0;

    for (const query of testQueries) {
      const start = performance.now();
      const results = shgatTransformer100.scoreAllCapabilities(query.intentEmb, []);
      latencyTransformer100 += performance.now() - start;

      const rank = results.findIndex(r => r.capabilityId === query.expected) + 1;
      if (rank === 1) correctTransformer100++;
      mrrTransformer100 += 1 / rank;
    }

    results.push({
      name: "SHGAT + Transformer (100ep)",
      accuracy: correctTransformer100 / testQueries.length,
      mrr: mrrTransformer100 / testQueries.length,
      latencyMs: latencyTransformer100 / testQueries.length,
      trainTimeMs: trainTimeTransformer100,
      paramCount: baseStats.paramCount + transformerStats.semanticParamCount,
    });

    console.log(`   Train: ${trainTimeTransformer100.toFixed(0)}ms | Acc: ${(correctTransformer100 / testQueries.length * 100).toFixed(1)}% | MRR: ${(mrrTransformer100 / testQueries.length).toFixed(4)}\n`);

    // ========================================================================
    // Summary Table
    // ========================================================================
    console.log("═".repeat(80));
    console.log("                              RESULTS SUMMARY");
    console.log("═".repeat(80));
    console.log(
      "Method".padEnd(30) +
      "Accuracy".padStart(10) +
      "MRR".padStart(10) +
      "Latency".padStart(12) +
      "Train".padStart(12) +
      "Params".padStart(10)
    );
    console.log("─".repeat(80));

    for (const r of results) {
      console.log(
        r.name.padEnd(30) +
        `${(r.accuracy * 100).toFixed(1)}%`.padStart(10) +
        r.mrr.toFixed(4).padStart(10) +
        `${r.latencyMs.toFixed(2)}ms`.padStart(12) +
        `${(r.trainTimeMs / 1000).toFixed(1)}s`.padStart(12) +
        (r.paramCount ? `${(r.paramCount / 1000).toFixed(0)}K` : "N/A").padStart(10)
      );
    }
    console.log("═".repeat(80));

    // ========================================================================
    // Analysis
    // ========================================================================
    console.log("\n📊 Analysis:");

    const cosineResult = results.find(r => r.name.includes("Cosine"))!;
    const bestTransformer = results
      .filter(r => r.name.includes("Transformer"))
      .sort((a, b) => b.accuracy - a.accuracy)[0];

    const improvement = ((bestTransformer.accuracy - cosineResult.accuracy) / (cosineResult.accuracy || 0.01)) * 100;

    if (cosineResult.accuracy === 1.0) {
      console.log("   ⚠️  Cosine already at 100% - dataset too easy to compare");
      console.log("   → Need harder test cases or more capabilities");
    } else if (improvement > 5) {
      console.log(`   ✅ Transformer shows ${improvement.toFixed(1)}% improvement over cosine`);
      console.log("   → Recommend integrating in 10.7b");
    } else if (improvement > 0) {
      console.log(`   🔶 Transformer shows ${improvement.toFixed(1)}% marginal improvement`);
    } else {
      console.log(`   ❌ Transformer shows no improvement (${improvement.toFixed(1)}%)`);
    }

    const latencyRatio = bestTransformer.latencyMs / cosineResult.latencyMs;
    console.log(`   ⏱️  Latency: Transformer is ${latencyRatio.toFixed(1)}x vs Cosine`);

    const paramRatio = (bestTransformer.paramCount || 0) / (cosineResult.paramCount || 1);
    console.log(`   📦 Params: Transformer has ${paramRatio.toFixed(1)}x more parameters`);

    console.log("\n╔════════════════════════════════════════════════════════════╗");
    console.log("║                    BENCHMARK COMPLETE                      ║");
    console.log("╚════════════════════════════════════════════════════════════╝\n");

  } finally {
    await embedder.dispose();
  }
}

// Run
if (import.meta.main) {
  await runBenchmark();
}
