/**
 * SHGAT Real Embedding Benchmark
 *
 * Tests SHGAT with real BGE-M3 embeddings.
 * This is separate from unit/integration tests - run manually:
 *
 *   deno run --allow-all tests/benchmarks/shgat-embeddings.bench.ts
 *
 * @module tests/benchmarks/shgat-embeddings
 */

import { assertGreater } from "@std/assert";
import {
  createSHGATFromCapabilities,
  trainSHGATOnEpisodes,
  type TrainingExample,
} from "../../src/graphrag/algorithms/shgat.ts";
import { EmbeddingModel } from "../../src/vector/embeddings.ts";

// Load fixture
const fixtureData = JSON.parse(
  await Deno.readTextFile("tests/benchmarks/fixtures/scenarios/episodic-training.json")
);

async function runBenchmark() {
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║       SHGAT Real Embedding Benchmark                       ║");
  console.log("╚════════════════════════════════════════════════════════════╝\n");

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
    for (const tool of fixtureData.nodes.tools) {
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
    }> = [];

    for (const cap of fixtureData.nodes.capabilities) {
      // Use rich description if available, otherwise fallback to ID
      const description = cap.description || cap.id.replace("cap__", "").replace(/_/g, " ");
      const embedding = await embedder.encode(description);

      capabilities.push({
        id: cap.id,
        embedding,
        toolsUsed: cap.toolsUsed,
        successRate: cap.successRate,
      });
    }

    console.log(`   ✓ ${capabilities.length} capabilities in ${((performance.now() - startCaps) / 1000).toFixed(1)}s`);

    // ========================================================================
    // Build hypergraph using factory function
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

    // Update hypergraph features
    for (const cap of fixtureData.nodes.capabilities) {
      const toolNodes = fixtureData.nodes.tools.filter((t: { id: string }) =>
        cap.toolsUsed.includes(t.id)
      );
      const avgPageRank = toolNodes.length > 0
        ? toolNodes.reduce((sum: number, t: { pageRank: number }) => sum + t.pageRank, 0) / toolNodes.length
        : 0.01;

      shgat.updateHypergraphFeatures(cap.id, {
        spectralCluster: toolNodes[0]?.community || 0,
        hypergraphPageRank: avgPageRank,
        cooccurrence: 0.5,
        recency: 0.5,
      });
    }

    const stats = shgat.getStats();
    console.log(`   ✓ ${stats.registeredTools} tools, ${stats.registeredCapabilities} capabilities`);
    console.log(`   ✓ ${stats.incidenceNonZeros} incidence connections`);
    console.log(`   ✓ ${stats.paramCount.toLocaleString()} parameters\n`);

    // ========================================================================
    // Create training samples
    // ========================================================================
    console.log("📊 Creating training samples with real intent embeddings...");
    const startSamples = performance.now();

    // toolEmbeddings is already a Map, use directly
    const getEmbedding = (id: string) => toolEmbeddings.get(id) || null;

    const trainingExamples: TrainingExample[] = [];
    for (const event of fixtureData.episodicEvents) {
      const intentEmbedding = await embedder.encode(event.intent);
      trainingExamples.push({
        intentEmbedding,
        contextTools: event.contextTools,
        candidateId: event.selectedCapability,
        outcome: event.outcome === "success" ? 1 : 0,
      });
    }

    console.log(`   ✓ ${trainingExamples.length} samples in ${((performance.now() - startSamples) / 1000).toFixed(1)}s\n`);

    // ========================================================================
    // Training
    // ========================================================================
    console.log("🏋️ Training SHGAT...");
    console.log("─".repeat(60));

    const startTrain = performance.now();

    const result = await trainSHGATOnEpisodes(shgat, trainingExamples, getEmbedding, {
      epochs: 20,
      batchSize: 4,
      onEpoch: (epoch, loss, accuracy) => {
        const bar = "█".repeat(Math.floor(accuracy * 20)) + "░".repeat(20 - Math.floor(accuracy * 20));
        console.log(`  Epoch ${epoch.toString().padStart(2)}: loss=${loss.toFixed(4)} [${bar}] acc=${(accuracy * 100).toFixed(0)}%`);
      },
    });

    console.log("─".repeat(60));
    console.log(`\n✅ Training complete in ${((performance.now() - startTrain) / 1000).toFixed(1)}s`);
    console.log(`   Final loss: ${result.finalLoss.toFixed(4)}`);
    console.log(`   Final accuracy: ${(result.finalAccuracy * 100).toFixed(1)}%\n`);

    // ========================================================================
    // Inference tests
    // ========================================================================
    console.log("🔍 Testing semantic inference...");
    console.log("─".repeat(60));

    const testQueries = [
      { query: "complete purchase for customer", expected: "cap__checkout_flow" },
      { query: "cancel an order", expected: "cap__order_cancellation" },
      { query: "browse products catalog", expected: "cap__product_browse" },
      { query: "view user profile settings", expected: "cap__user_profile" },
    ];

    let correctTop1 = 0;
    let correctTop2 = 0;

    for (const { query, expected } of testQueries) {
      const queryEmb = await embedder.encode(query);
      const results = shgat.scoreAllCapabilities(queryEmb, []);

      const rank = results.findIndex(r => r.capabilityId === expected) + 1;
      const isTop1 = rank === 1;
      const isTop2 = rank <= 2;

      if (isTop1) correctTop1++;
      if (isTop2) correctTop2++;

      const emoji = isTop1 ? "✅" : isTop2 ? "🔶" : "❌";

      console.log(`\n  ${emoji} "${query}"`);
      console.log(`     Expected: ${expected} (rank: ${rank})`);
      console.log(`     Top 3:`);
      for (const r of results.slice(0, 3)) {
        const marker = r.capabilityId === expected ? " ←" : "";
        console.log(`       ${r.score.toFixed(4)} ${r.capabilityId}${marker}`);
      }
    }

    console.log("\n" + "─".repeat(60));
    console.log(`📊 Results: ${correctTop1}/${testQueries.length} Top-1, ${correctTop2}/${testQueries.length} Top-2`);

    // ========================================================================
    // Assertions
    // ========================================================================
    console.log("\n🧪 Running assertions...");

    // Should achieve better than random accuracy
    assertGreater(result.finalAccuracy, 0.3, "Accuracy should be > 30%");
    console.log("   ✓ Training accuracy > 30%");

    // At least half should be top-2
    assertGreater(correctTop2, testQueries.length / 2, "At least half should be top-2");
    console.log("   ✓ At least half queries top-2 correct");

    console.log("\n╔════════════════════════════════════════════════════════════╗");
    console.log("║                    BENCHMARK PASSED                        ║");
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
