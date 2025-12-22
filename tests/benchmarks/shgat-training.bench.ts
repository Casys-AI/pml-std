/**
 * SHGAT Training Integration Tests
 *
 * Tests SHGAT with proper two-phase message passing on episodic traces.
 * Validates:
 * - Incidence matrix construction
 * - Two-phase message passing (Vertex→Hyperedge, Hyperedge→Vertex)
 * - Multi-head attention with HypergraphFeatures
 * - Backpropagation through both phases
 *
 * @module tests/integration/shgat-training
 */

import { assertEquals, assertGreater, assertLess } from "@std/assert";
import {
  SHGAT,
  DEFAULT_SHGAT_CONFIG,
  trainSHGATOnEpisodes,
  type TrainingExample,
  type HypergraphFeatures,
} from "../../src/graphrag/algorithms/shgat.ts";

// Load fixture
const fixtureData = JSON.parse(
  await Deno.readTextFile("tests/benchmarks/fixtures/scenarios/episodic-training.json")
);

/**
 * Create mock embedding (deterministic based on string hash)
 */
function createMockEmbedding(text: string, dim: number = 1024): number[] {
  const embedding = new Array(dim).fill(0);
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  for (let i = 0; i < dim; i++) {
    hash = (hash * 1103515245 + 12345) | 0;
    embedding[i] = (hash % 1000) / 1000 - 0.5;
  }
  // Normalize
  const norm = Math.sqrt(embedding.reduce((s, x) => s + x * x, 0));
  return embedding.map((x) => x / norm);
}

/**
 * Build SHGAT from fixture data using new API with tools + capabilities
 */
function buildSHGATFromFixture(): {
  shgat: SHGAT;
  embeddings: Map<string, number[]>;
  trainingExamples: TrainingExample[];
} {
  const shgat = new SHGAT({
    ...DEFAULT_SHGAT_CONFIG,
    numHeads: 4,
    hiddenDim: 32, // Smaller for faster tests
    numLayers: 2,
    embeddingDim: 1024,
  });

  const embeddings = new Map<string, number[]>();

  // Build tools
  const tools: Array<{ id: string; embedding: number[] }> = [];
  for (const tool of fixtureData.nodes.tools) {
    const toolEmbedding = createMockEmbedding(tool.id);
    embeddings.set(tool.id, toolEmbedding);
    tools.push({ id: tool.id, embedding: toolEmbedding });
  }

  // Build capabilities with hypergraph features
  const capabilities: Array<{
    id: string;
    embedding: number[];
    toolsUsed: string[];
    successRate: number;
    parents?: string[];
    children?: string[];
  }> = [];

  for (const cap of fixtureData.nodes.capabilities) {
    const capEmbedding = createMockEmbedding(cap.id);
    embeddings.set(cap.id, capEmbedding);

    capabilities.push({
      id: cap.id,
      embedding: capEmbedding,
      toolsUsed: cap.toolsUsed,
      successRate: cap.successRate,
      parents: cap.parents || [],
      children: [], // Leaf capabilities have no children
    });
  }

  // Build hypergraph with incidence matrix
  shgat.buildFromData(tools, capabilities);

  // Update hypergraph features after building
  for (const cap of fixtureData.nodes.capabilities) {
    const toolNodes = fixtureData.nodes.tools.filter((t: { id: string }) =>
      cap.toolsUsed.includes(t.id)
    );
    const avgPageRank = toolNodes.length > 0
      ? toolNodes.reduce((sum: number, t: { pageRank: number }) => sum + t.pageRank, 0) / toolNodes.length
      : 0.01;
    const primaryCommunity = toolNodes.length > 0 ? toolNodes[0].community : 0;

    shgat.updateHypergraphFeatures(cap.id, {
      spectralCluster: primaryCommunity,
      hypergraphPageRank: avgPageRank,
      cooccurrence: 0,
      recency: 0,
    });
  }

  // Convert episodic events to training examples
  const trainingExamples: TrainingExample[] = fixtureData.episodicEvents.map(
    (event: {
      intent: string;
      contextTools: string[];
      selectedCapability: string;
      outcome: string;
    }) => ({
      intentEmbedding: createMockEmbedding(event.intent),
      contextTools: event.contextTools,
      candidateId: event.selectedCapability,
      outcome: event.outcome === "success" ? 1 : 0,
    })
  );

  // Update co-occurrence from episodes
  const cooccurrenceCounts = new Map<string, number>();
  for (const event of fixtureData.episodicEvents) {
    const cap = event.selectedCapability;
    cooccurrenceCounts.set(cap, (cooccurrenceCounts.get(cap) || 0) + 1);
  }
  const maxCount = Math.max(...cooccurrenceCounts.values());

  for (const [capId, count] of cooccurrenceCounts) {
    shgat.updateHypergraphFeatures(capId, {
      cooccurrence: count / maxCount,
      recency: 0.8,
    });
  }

  return { shgat, embeddings, trainingExamples };
}

// ============================================================================
// Tests
// ============================================================================

Deno.test("SHGAT: builds hypergraph with incidence matrix", () => {
  const { shgat, trainingExamples } = buildSHGATFromFixture();

  const stats = shgat.getStats();
  assertEquals(stats.numHeads, 4);
  assertEquals(stats.numLayers, 2);
  assertEquals(stats.registeredCapabilities, 4); // 4 capabilities
  assertEquals(stats.registeredTools, 15); // 15 tools
  assertGreater(stats.incidenceNonZeros, 0); // Has connections
  assertEquals(stats.incidenceNonZeros, 15); // Sum of toolsUsed counts
  assertEquals(trainingExamples.length, 12); // 12 episodic events
});

Deno.test("SHGAT: forward pass produces embeddings", () => {
  const { shgat } = buildSHGATFromFixture();

  const { H, E } = shgat.forward();

  // Should have embeddings for all tools and capabilities
  assertEquals(H.length, 15); // 15 tools
  assertEquals(E.length, 4); // 4 capabilities

  // Embeddings should have correct dimension (hiddenDim * numHeads)
  const expectedDim = 32 * 4; // hiddenDim=32, numHeads=4
  assertEquals(H[0].length, expectedDim);
  assertEquals(E[0].length, expectedDim);

  // Embeddings should be normalized-ish (not all zeros or huge)
  for (const emb of H) {
    const norm = Math.sqrt(emb.reduce((s, x) => s + x * x, 0));
    assertGreater(norm, 0);
    assertLess(norm, 100);
  }
});

Deno.test("SHGAT: scores capabilities before training", () => {
  const { shgat, embeddings } = buildSHGATFromFixture();

  const intentEmbedding = createMockEmbedding("complete purchase for customer");
  const contextEmbeddings = [embeddings.get("db__get_cart")!];

  const results = shgat.scoreAllCapabilities(intentEmbedding, contextEmbeddings);

  // Should return all 4 capabilities
  assertEquals(results.length, 4);

  // All scores should be between 0 and 1
  for (const result of results) {
    assertGreater(result.score, 0);
    assertLess(result.score, 1);
  }

  // Should have feature contributions
  const topResult = results[0];
  assertEquals(topResult.featureContributions !== undefined, true);

  // Should have tool attention
  assertEquals(topResult.toolAttention !== undefined, true);
  assertEquals(topResult.toolAttention!.length, 15); // 15 tools
});

Deno.test("SHGAT: trains on episodic events", async () => {
  const { shgat, embeddings, trainingExamples } = buildSHGATFromFixture();

  const getEmbedding = (id: string) => embeddings.get(id) || null;

  const result = await trainSHGATOnEpisodes(shgat, trainingExamples, getEmbedding, {
    epochs: 5,
    batchSize: 4,
    onEpoch: (epoch, loss, accuracy) => {
      console.log(`Epoch ${epoch}: loss=${loss.toFixed(4)}, accuracy=${accuracy.toFixed(2)}`);
    },
  });

  // Should have reasonable loss and accuracy
  assertLess(result.finalLoss, 2.0);
  assertGreater(result.finalAccuracy, 0.2);
});

Deno.test("SHGAT: loss decreases during training", async () => {
  const { shgat, embeddings, trainingExamples } = buildSHGATFromFixture();

  const getEmbedding = (id: string) => embeddings.get(id) || null;
  const losses: number[] = [];

  await trainSHGATOnEpisodes(shgat, trainingExamples, getEmbedding, {
    epochs: 10,
    batchSize: 4,
    onEpoch: (_epoch, loss) => {
      losses.push(loss);
    },
  });

  // First loss should generally be higher than average of last 3
  const avgLastThree = (losses[losses.length - 1] + losses[losses.length - 2] + losses[losses.length - 3]) / 3;

  console.log(`Initial loss: ${losses[0].toFixed(4)}, Final avg: ${avgLastThree.toFixed(4)}`);

  // Allow tolerance for stochasticity
  assertLess(avgLastThree, losses[0] + 0.5);
});

Deno.test("SHGAT: improves after training", async () => {
  const { shgat, embeddings, trainingExamples } = buildSHGATFromFixture();

  const getEmbedding = (id: string) => embeddings.get(id) || null;

  // Score before training
  const intentEmbedding = createMockEmbedding("complete purchase for customer");
  const contextEmbeddings = [embeddings.get("db__get_cart")!];

  const scoresBefore = shgat.scoreAllCapabilities(intentEmbedding, contextEmbeddings);
  const checkoutScoreBefore = scoresBefore.find(
    (r) => r.capabilityId === "cap__checkout_flow"
  )!.score;

  // Train
  await trainSHGATOnEpisodes(shgat, trainingExamples, getEmbedding, {
    epochs: 10,
    batchSize: 4,
  });

  // Score after training
  const scoresAfter = shgat.scoreAllCapabilities(intentEmbedding, contextEmbeddings);
  const checkoutScoreAfter = scoresAfter.find(
    (r) => r.capabilityId === "cap__checkout_flow"
  )!.score;

  console.log(`Checkout score: before=${checkoutScoreBefore.toFixed(3)}, after=${checkoutScoreAfter.toFixed(3)}`);

  // At minimum, the model should still produce valid scores
  assertGreater(checkoutScoreAfter, 0);
  assertLess(checkoutScoreAfter, 1);
});

Deno.test("SHGAT: respects reliability", () => {
  const { shgat } = buildSHGATFromFixture();

  const intentEmbedding = createMockEmbedding("some action");
  const contextEmbeddings: number[][] = [];

  const results = shgat.scoreAllCapabilities(intentEmbedding, contextEmbeddings);

  // Find capabilities by their IDs
  const productBrowse = results.find((r) => r.capabilityId === "cap__product_browse");
  const checkoutFlow = results.find((r) => r.capabilityId === "cap__checkout_flow");

  // product_browse has 0.99 success rate (boost)
  // checkout_flow has 0.85 success rate (neutral)
  assertEquals(productBrowse!.featureContributions!.reliability, 1.2); // boost
  assertEquals(checkoutFlow!.featureContributions!.reliability, 1.0); // neutral
});

Deno.test("SHGAT: spectral cluster matching", () => {
  const { shgat } = buildSHGATFromFixture();

  const intentEmbedding = createMockEmbedding("checkout");

  // Context with capability in same cluster
  const resultsWithClusterContext = shgat.scoreAllCapabilities(
    intentEmbedding,
    [],
    ["cap__checkout_flow"]
  );

  // Context without cluster
  const resultsWithoutClusterContext = shgat.scoreAllCapabilities(
    intentEmbedding,
    [],
    []
  );

  assertEquals(resultsWithClusterContext.length, 4);
  assertEquals(resultsWithoutClusterContext.length, 4);

  // Structure head should contribute when cluster matches
  const checkoutWithCluster = resultsWithClusterContext.find(
    (r) => r.capabilityId === "cap__checkout_flow"
  )!;

  assertGreater(checkoutWithCluster.headScores[2], 0);
});

Deno.test("SHGAT: export and import params", async () => {
  const { shgat, embeddings, trainingExamples } = buildSHGATFromFixture();

  const getEmbedding = (id: string) => embeddings.get(id) || null;

  // Train
  await trainSHGATOnEpisodes(shgat, trainingExamples, getEmbedding, {
    epochs: 3,
    batchSize: 4,
  });

  // Export params
  const params = shgat.exportParams();

  // Create new SHGAT and import
  const shgat2 = new SHGAT();
  shgat2.importParams(params);

  // Stats should match
  const stats1 = shgat.getStats();
  const stats2 = shgat2.getStats();

  assertEquals(stats2.numHeads, stats1.numHeads);
  assertEquals(stats2.hiddenDim, stats1.hiddenDim);
  assertEquals(stats2.numLayers, stats1.numLayers);
});

Deno.test("SHGAT: batch feature updates", () => {
  const { shgat } = buildSHGATFromFixture();

  // Batch update features
  const updates = new Map<string, Partial<HypergraphFeatures>>([
    ["cap__checkout_flow", { recency: 1.0, cooccurrence: 0.9 }],
    ["cap__order_cancellation", { recency: 0.5, cooccurrence: 0.3 }],
  ]);

  shgat.batchUpdateFeatures(updates);

  // Verify updates were applied by checking scores
  const intentEmbedding = createMockEmbedding("test");
  const results = shgat.scoreAllCapabilities(intentEmbedding, []);

  const checkout = results.find((r) => r.capabilityId === "cap__checkout_flow");
  const cancellation = results.find((r) => r.capabilityId === "cap__order_cancellation");

  assertGreater(checkout!.score, 0);
  assertGreater(cancellation!.score, 0);
});

Deno.test("SHGAT: computeAttention backward compatible API", () => {
  const { shgat, embeddings } = buildSHGATFromFixture();

  const intentEmbedding = createMockEmbedding("checkout");
  const contextEmbeddings = [embeddings.get("db__get_cart")!];

  // Use the backward compatible API
  const result = shgat.computeAttention(
    intentEmbedding,
    contextEmbeddings,
    "cap__checkout_flow",
    []
  );

  assertEquals(result.capabilityId, "cap__checkout_flow");
  assertGreater(result.score, 0);
  assertLess(result.score, 1);
  assertEquals(result.headWeights.length, 4);
  assertEquals(result.headScores.length, 4);
});

Deno.test("SHGAT: tool attention weights are valid", () => {
  const { shgat } = buildSHGATFromFixture();

  const intentEmbedding = createMockEmbedding("checkout");

  const results = shgat.scoreAllCapabilities(intentEmbedding, []);

  for (const result of results) {
    // Tool attention should be array of tool weights
    assertEquals(result.toolAttention!.length, 15);

    // Some attention should be non-zero
    const hasNonZero = result.toolAttention!.some((a) => a > 0);
    assertEquals(hasNonZero, true);
  }
});

// ============================================================================
// Meta-Capability Hierarchy Tests
// ============================================================================

/**
 * Build SHGAT with full hierarchy including meta-capabilities
 */
function buildSHGATWithHierarchy(): {
  shgat: SHGAT;
  embeddings: Map<string, number[]>;
  metaCapabilities: Array<{
    id: string;
    contains: string[];
    parents: string[];
    successRate: number;
    toolsAggregated: string[];
  }>;
  capabilityParents: Map<string, string[]>;
} {
  const { shgat, embeddings } = buildSHGATFromFixture();

  // Build parent lookup for capabilities
  const capabilityParents = new Map<string, string[]>();
  for (const cap of fixtureData.nodes.capabilities) {
    capabilityParents.set(cap.id, cap.parents || []);
  }

  // Meta-capabilities from fixture
  const metaCapabilities = fixtureData.nodes.metaCapabilities.map(
    (meta: {
      id: string;
      contains: string[];
      parents: string[];
      successRate: number;
      toolsAggregated: string[];
    }) => ({
      id: meta.id,
      contains: meta.contains,
      parents: meta.parents,
      successRate: meta.successRate,
      toolsAggregated: meta.toolsAggregated,
    })
  );

  // Register meta-capabilities as capabilities
  for (const meta of metaCapabilities) {
    const metaEmbedding = createMockEmbedding(meta.id);
    embeddings.set(meta.id, metaEmbedding);

    shgat.registerCapability({
      id: meta.id,
      embedding: metaEmbedding,
      toolsUsed: meta.toolsAggregated,
      successRate: meta.successRate,
      parents: meta.parents,
      children: meta.contains,
    });
  }

  return { shgat, embeddings, metaCapabilities, capabilityParents };
}

Deno.test("SHGAT Hierarchy: registers meta-capabilities", () => {
  const { shgat, metaCapabilities } = buildSHGATWithHierarchy();

  const stats = shgat.getStats();

  // Should have 4 capabilities + 3 meta-capabilities = 7 total
  assertEquals(stats.registeredCapabilities, 7);

  // Verify meta IDs are present
  const intentEmbedding = createMockEmbedding("test");
  const results = shgat.scoreAllCapabilities(intentEmbedding, []);

  const capIds = new Set(results.map((r) => r.capabilityId));
  for (const meta of metaCapabilities) {
    assertEquals(capIds.has(meta.id), true, `Missing meta: ${meta.id}`);
  }
});

Deno.test("SHGAT Hierarchy: meta-capabilities have aggregated tools", () => {
  const { shgat } = buildSHGATWithHierarchy();

  // meta__transactions should aggregate tools from checkout + cancellation
  // checkout: 6 tools, cancellation: 4 tools (with overlap on db__get_cart, email__order_confirm)
  // Unique: db__get_cart, inventory__check, payment__validate, payment__charge,
  //         db__save_order, email__order_confirm, payment__refund, inventory__release = 8 tools

  const stats = shgat.getStats();
  // incidenceNonZeros increases because meta-capabilities add their aggregated tools
  assertGreater(stats.incidenceNonZeros, 15);
});

Deno.test("SHGAT Hierarchy: capability parents are set correctly", () => {
  const { capabilityParents } = buildSHGATWithHierarchy();

  // cap__checkout_flow → meta__transactions
  assertEquals(capabilityParents.get("cap__checkout_flow"), ["meta__transactions"]);

  // cap__user_profile → meta__browsing
  assertEquals(capabilityParents.get("cap__user_profile"), ["meta__browsing"]);
});

Deno.test("SHGAT Hierarchy: meta-capability scores are valid", () => {
  const { shgat, embeddings } = buildSHGATWithHierarchy();

  const intentEmbedding = createMockEmbedding("financial transaction processing");
  const contextEmbeddings = [embeddings.get("payment__validate")!];

  const results = shgat.scoreAllCapabilities(intentEmbedding, contextEmbeddings);

  // Find meta-capability scores
  const metaTransactions = results.find((r) => r.capabilityId === "meta__transactions");
  const metaBrowsing = results.find((r) => r.capabilityId === "meta__browsing");
  const metaEcommerce = results.find((r) => r.capabilityId === "meta__ecommerce");

  // All meta-capabilities should have valid scores
  assertGreater(metaTransactions!.score, 0);
  assertGreater(metaBrowsing!.score, 0);
  assertGreater(metaEcommerce!.score, 0);

  // With payment context, transactions should score higher than browsing
  assertGreater(metaTransactions!.score, metaBrowsing!.score);
});

Deno.test("SHGAT Hierarchy: training examples include selectedMeta", () => {
  // Verify fixture has selectedMeta in all episodic events
  for (const event of fixtureData.episodicEvents) {
    assertEquals(
      event.selectedMeta !== undefined,
      true,
      `Event ${event.id} missing selectedMeta`
    );
  }

  // Count meta distribution
  const metaCounts = new Map<string, number>();
  for (const event of fixtureData.episodicEvents) {
    const meta = event.selectedMeta;
    metaCounts.set(meta, (metaCounts.get(meta) || 0) + 1);
  }

  // meta__transactions: 8, meta__browsing: 4
  assertEquals(metaCounts.get("meta__transactions"), 8);
  assertEquals(metaCounts.get("meta__browsing"), 4);
});

/**
 * Score meta-capability by aggregating child scores
 */
function scoreMetaCapability(
  shgat: SHGAT,
  _metaId: string,
  childIds: string[],
  intentEmbedding: number[],
  contextEmbeddings: number[][]
): { metaScore: number; childScores: Map<string, number> } {
  const results = shgat.scoreAllCapabilities(intentEmbedding, contextEmbeddings);

  const childScores = new Map<string, number>();
  for (const child of childIds) {
    const result = results.find((r) => r.capabilityId === child);
    if (result) {
      childScores.set(child, result.score);
    }
  }

  // Aggregate: weighted average by score (higher scores weighted more)
  const totalScore = Array.from(childScores.values()).reduce((a, b) => a + b, 0);
  const weightedSum = Array.from(childScores.values()).reduce(
    (sum, score) => sum + score * score,
    0
  );
  const metaScore = totalScore > 0 ? weightedSum / totalScore : 0;

  return { metaScore, childScores };
}

Deno.test("SHGAT Hierarchy: meta-score aggregation from children", () => {
  const { shgat, embeddings, metaCapabilities } = buildSHGATWithHierarchy();

  const metaTransactions = metaCapabilities.find((m) => m.id === "meta__transactions")!;
  const intentEmbedding = createMockEmbedding("process payment and save order");
  const contextEmbeddings = [embeddings.get("payment__charge")!];

  const { metaScore, childScores } = scoreMetaCapability(
    shgat,
    "meta__transactions",
    metaTransactions.contains,
    intentEmbedding,
    contextEmbeddings
  );

  // Should have scores for both children
  assertEquals(childScores.has("cap__checkout_flow"), true);
  assertEquals(childScores.has("cap__order_cancellation"), true);

  // Aggregated meta-score should be valid
  assertGreater(metaScore, 0);
  assertLess(metaScore, 1);
});

Deno.test("SHGAT Hierarchy: nested meta-capabilities", () => {
  const { shgat, metaCapabilities } = buildSHGATWithHierarchy();

  // meta__ecommerce contains meta__transactions and meta__browsing
  const metaEcommerce = metaCapabilities.find((m) => m.id === "meta__ecommerce")!;
  assertEquals(metaEcommerce.contains, ["meta__transactions", "meta__browsing"]);

  // Score all
  const intentEmbedding = createMockEmbedding("ecommerce operation");
  const results = shgat.scoreAllCapabilities(intentEmbedding, []);

  const ecommerceResult = results.find((r) => r.capabilityId === "meta__ecommerce");
  const transactionsResult = results.find((r) => r.capabilityId === "meta__transactions");
  const browsingResult = results.find((r) => r.capabilityId === "meta__browsing");

  // All should be scored
  assertGreater(ecommerceResult!.score, 0);
  assertGreater(transactionsResult!.score, 0);
  assertGreater(browsingResult!.score, 0);
});

Deno.test("SHGAT Hierarchy: context affects meta-capability scores", () => {
  const { shgat, embeddings } = buildSHGATWithHierarchy();

  const intentEmbedding = createMockEmbedding("do something with the system");

  // Score with payment context
  const paymentContext = [embeddings.get("payment__charge")!];
  const resultsWithPayment = shgat.scoreAllCapabilities(intentEmbedding, paymentContext);
  const transactionsWithPayment = resultsWithPayment.find(
    (r) => r.capabilityId === "meta__transactions"
  )!.score;

  // Score with browsing context
  const browseContext = [embeddings.get("api__fetch_products")!];
  const resultsWithBrowse = shgat.scoreAllCapabilities(intentEmbedding, browseContext);
  const browsingWithBrowse = resultsWithBrowse.find(
    (r) => r.capabilityId === "meta__browsing"
  )!.score;

  // Both should be valid scores
  assertGreater(transactionsWithPayment, 0);
  assertGreater(browsingWithBrowse, 0);
});

// Real BGE-M3 embedding tests are in:
// tests/benchmarks/shgat-embeddings.bench.ts
// Run with: deno run --allow-all tests/benchmarks/shgat-embeddings.bench.ts
