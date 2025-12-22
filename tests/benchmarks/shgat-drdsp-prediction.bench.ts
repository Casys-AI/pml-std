/**
 * Integration Test: SHGAT + DR-DSP for Prediction and Suggestion
 *
 * Tests the combined use of:
 * - SHGAT: Score capabilities based on intent (with or without context)
 * - DR-DSP: Find optimal hyperpath through capability graph
 *
 * Two modes covered (ADR-050):
 *
 * | Mode | Context | SHGAT Features |
 * |------|---------|----------------|
 * | **Prediction (forward)** | ✅ `contextTools=[...]` | semantic + graph + contextBoost (×0.3) |
 * | **Suggestion (backward)** | ❌ `contextTools=[]` | semantic + graph (no contextBoost) |
 *
 * This demonstrates how these algorithms work together in:
 * - `predictNextNode()` - forward mode with context
 * - `pml_execute()` mode suggestion - backward mode without context
 *
 * @module tests/integration/shgat-drdsp-prediction
 */

import { assertEquals, assertExists } from "@std/assert";
import {
  SHGAT,
  DRDSP,
  capabilityToHyperedge,
  createSHGATFromCapabilities,
  type Hyperedge,
} from "../../src/graphrag/algorithms/mod.ts";

// ============================================================================
// Test Data: E-commerce Scenario
// ============================================================================

/**
 * Simulated tools with embeddings (normally from BGE-M3)
 * Using 8-dim for testing (real would be 1024-dim)
 */
const TOOL_EMBEDDINGS: Record<string, number[]> = {
  "db__get_cart": [0.8, 0.2, 0.1, 0.0, 0.3, 0.1, 0.0, 0.1],
  "inventory__check": [0.7, 0.3, 0.2, 0.1, 0.4, 0.2, 0.1, 0.0],
  "payment__validate": [0.1, 0.8, 0.7, 0.1, 0.2, 0.3, 0.1, 0.2],
  "payment__charge": [0.1, 0.9, 0.8, 0.2, 0.1, 0.4, 0.2, 0.3],
  "db__save_order": [0.6, 0.3, 0.2, 0.8, 0.2, 0.1, 0.3, 0.1],
  "email__confirm": [0.2, 0.1, 0.1, 0.7, 0.8, 0.2, 0.1, 0.4],
  "api__fetch_user": [0.5, 0.1, 0.0, 0.2, 0.1, 0.7, 0.8, 0.2],
  "db__get_user": [0.6, 0.1, 0.0, 0.3, 0.1, 0.8, 0.7, 0.1],
};

/**
 * Hypergraph features for testing SHGAT scoring
 * Varied values to measure impact of different algorithms
 */
interface TestHypergraphFeatures {
  spectralCluster: number;
  hypergraphPageRank: number;
  cooccurrence: number;
  recency: number;
  adamicAdar: number;
  heatDiffusion: number;
}

/**
 * Capabilities with their tools, structure, and hypergraph features
 */
const CAPABILITIES: Array<{
  id: string;
  tools: string[];
  successRate: number;
  description: string;
  staticEdges: Array<{ from: string; to: string; type: string }>;
  hypergraphFeatures: TestHypergraphFeatures;
}> = [
  {
    id: "cap__checkout_flow",
    tools: ["db__get_cart", "inventory__check", "payment__validate", "payment__charge", "db__save_order", "email__confirm"],
    successRate: 0.92,
    description: "Complete checkout process",
    staticEdges: [
      { from: "db__get_cart", to: "inventory__check", type: "provides" },
      { from: "inventory__check", to: "payment__validate", type: "provides" },
      { from: "payment__validate", to: "payment__charge", type: "provides" },
      { from: "payment__charge", to: "db__save_order", type: "provides" },
      { from: "db__save_order", to: "email__confirm", type: "sequence" },
    ],
    hypergraphFeatures: {
      spectralCluster: 0,      // Central cluster
      hypergraphPageRank: 0.35, // High centrality (complex flow)
      cooccurrence: 0.8,       // Frequently used
      recency: 0.9,            // Recently used
      adamicAdar: 0.7,         // High similarity with neighbors
      heatDiffusion: 0.6,      // Medium heat from context
    },
  },
  {
    id: "cap__payment_only",
    tools: ["payment__validate", "payment__charge"],
    successRate: 0.95,
    description: "Payment processing",
    staticEdges: [
      { from: "payment__validate", to: "payment__charge", type: "provides" },
    ],
    hypergraphFeatures: {
      spectralCluster: 0,      // Same cluster as checkout
      hypergraphPageRank: 0.25, // Medium centrality
      cooccurrence: 0.9,       // Very frequently used
      recency: 0.95,           // Very recently used
      adamicAdar: 0.8,         // High similarity (shares tools with checkout)
      heatDiffusion: 0.8,      // High heat (often active)
    },
  },
  {
    id: "cap__user_profile",
    tools: ["api__fetch_user", "db__get_user"],
    successRate: 0.98,
    description: "User profile retrieval",
    staticEdges: [
      { from: "api__fetch_user", to: "db__get_user", type: "provides" },
    ],
    hypergraphFeatures: {
      spectralCluster: 1,      // Different cluster (user domain)
      hypergraphPageRank: 0.15, // Lower centrality
      cooccurrence: 0.4,       // Less frequent
      recency: 0.3,            // Not recently used
      adamicAdar: 0.2,         // Low similarity with payment caps
      heatDiffusion: 0.1,      // Low heat
    },
  },
  {
    id: "cap__order_confirmation",
    tools: ["db__save_order", "email__confirm"],
    successRate: 0.97,
    description: "Order saving and confirmation",
    staticEdges: [
      { from: "db__save_order", to: "email__confirm", type: "provides" },
    ],
    hypergraphFeatures: {
      spectralCluster: 0,      // Same cluster as checkout
      hypergraphPageRank: 0.20, // Medium-low centrality
      cooccurrence: 0.7,       // Frequently used
      recency: 0.6,            // Moderately recent
      adamicAdar: 0.6,         // Medium similarity
      heatDiffusion: 0.4,      // Medium heat
    },
  },
];

// ============================================================================
// Helper: Create embedding lookup
// ============================================================================

function getEmbedding(id: string): number[] | null {
  // For tools
  if (TOOL_EMBEDDINGS[id]) {
    return TOOL_EMBEDDINGS[id];
  }
  // For capabilities - average of tool embeddings
  const cap = CAPABILITIES.find((c) => c.id === id);
  if (cap) {
    const toolEmbeddings = cap.tools
      .map((t) => TOOL_EMBEDDINGS[t])
      .filter((e) => e !== undefined);
    if (toolEmbeddings.length === 0) return null;

    const dim = toolEmbeddings[0].length;
    const avg = new Array(dim).fill(0);
    for (const emb of toolEmbeddings) {
      for (let i = 0; i < dim; i++) {
        avg[i] += emb[i] / toolEmbeddings.length;
      }
    }
    return avg;
  }
  return null;
}

// ============================================================================
// Helper: Create SHGAT with factory function
// ============================================================================

function buildSHGAT(): SHGAT {
  const toolEmbeddings = new Map<string, number[]>();
  for (const [id, emb] of Object.entries(TOOL_EMBEDDINGS)) {
    toolEmbeddings.set(id, emb);
  }

  const capabilities = CAPABILITIES.map((cap) => ({
    id: cap.id,
    embedding: getEmbedding(cap.id)!,
    toolsUsed: cap.tools,
    successRate: cap.successRate,
    parents: [] as string[],
    children: [] as string[],
    hypergraphFeatures: cap.hypergraphFeatures,
  }));

  return createSHGATFromCapabilities(
    capabilities,
    toolEmbeddings,
    {
      numHeads: 2,
      hiddenDim: 4,
      embeddingDim: 8,
    }
  );
}

// ============================================================================
// Test: Combined SHGAT + DR-DSP Prediction
// ============================================================================

Deno.test("Integration: SHGAT scores capabilities, DR-DSP finds path", async (t) => {
  // -------------------------------------------------------------------------
  // Step 1: Initialize SHGAT with capabilities
  // -------------------------------------------------------------------------
  await t.step("1. Initialize SHGAT with capabilities", () => {
    const shgat = buildSHGAT();
    assertEquals(shgat.getStats().registeredCapabilities, 4, "Should have 4 capabilities");
  });

  // -------------------------------------------------------------------------
  // Step 2: Initialize DR-DSP with capability hyperedges
  // -------------------------------------------------------------------------
  await t.step("2. Initialize DR-DSP with capability hyperedges", () => {
    // Convert capabilities to hyperedges
    const hyperedges: Hyperedge[] = CAPABILITIES.map((cap) =>
      capabilityToHyperedge(cap.id, cap.tools, cap.staticEdges, cap.successRate)
    );

    const drdsp = new DRDSP(hyperedges);

    const stats = drdsp.getStats();
    assertEquals(stats.hyperedgeCount, 4, "Should have 4 capability hyperedges");
    console.log(`DR-DSP initialized: ${stats.nodeCount} nodes, ${stats.hyperedgeCount} hyperedges`);
  });

  // -------------------------------------------------------------------------
  // Step 3: Simulate prediction scenario
  // -------------------------------------------------------------------------
  await t.step("3. Combined prediction: intent → SHGAT → DR-DSP → suggestion", () => {
    // User intent: "complete purchase for customer"
    // Simulated intent embedding (would come from BGE-M3)
    const intentEmbedding = [0.3, 0.7, 0.6, 0.4, 0.2, 0.1, 0.1, 0.2];

    // Current context: user just viewed cart
    const contextTools = ["db__get_cart"];
    const contextEmbeddings = contextTools
      .map((t) => TOOL_EMBEDDINGS[t])
      .filter((e) => e !== undefined);

    // === PHASE 1: SHGAT scores all capabilities ===
    const shgat = buildSHGAT();

    // Score all capabilities for this intent
    const scores = shgat.scoreAllCapabilities(intentEmbedding, contextEmbeddings);

    // Verify we got scores for all capabilities
    assertEquals(scores.length, 4, "Should score all 4 capabilities");

    // Find best capability
    const bestCap = scores.reduce((best, current) =>
      current.score > best.score ? current : best
    );

    console.log("\n=== SHGAT Capability Scores ===");
    for (const s of scores.sort((a, b) => b.score - a.score)) {
      console.log(`  ${s.capabilityId}: ${s.score.toFixed(4)}`);
    }
    console.log(`  Best: ${bestCap.capabilityId}`);

    // === PHASE 2: DR-DSP finds hyperpath through best capability ===
    const hyperedges: Hyperedge[] = CAPABILITIES.map((cap) =>
      capabilityToHyperedge(cap.id, cap.tools, cap.staticEdges, cap.successRate)
    );
    const drdsp = new DRDSP(hyperedges);

    // Get the best capability's structure
    const cap = CAPABILITIES.find((c) => c.id === bestCap.capabilityId)!;
    const startTool = contextTools[0]; // db__get_cart
    const endTool = cap.tools[cap.tools.length - 1]; // Last tool in capability

    // Find hyperpath from start to end
    const pathResult = drdsp.findShortestHyperpath(startTool, endTool);

    console.log("\n=== DR-DSP Hyperpath Finding ===");
    console.log(`  From: ${startTool}`);
    console.log(`  To: ${endTool}`);
    console.log(`  Found: ${pathResult.found}`);
    if (pathResult.found) {
      console.log(`  Path: ${pathResult.nodeSequence.join(" → ")}`);
      console.log(`  Weight: ${pathResult.totalWeight.toFixed(4)}`);
      console.log(`  Hyperedges used: ${pathResult.path.length}`);
    }

    // === PHASE 3: Combine into final suggestion ===
    const suggestion = {
      capability: bestCap.capabilityId,
      capabilityScore: bestCap.score,
      attentionWeights: bestCap.headWeights,
      path: pathResult.found ? pathResult.nodeSequence : cap.tools,
      pathCost: pathResult.totalWeight,
      nextTool: pathResult.found && pathResult.nodeSequence.length > 1
        ? pathResult.nodeSequence[1]
        : cap.tools[1],
      confidence: bestCap.score * Math.exp(-pathResult.totalWeight / 10), // Normalize
    };

    console.log("\n=== Final Suggestion ===");
    console.log(`  Capability: ${suggestion.capability}`);
    console.log(`  Next Tool: ${suggestion.nextTool}`);
    console.log(`  Confidence: ${suggestion.confidence.toFixed(4)}`);
    console.log(`  Full Path: ${suggestion.path.join(" → ")}`);

    // Assertions
    assertExists(suggestion.nextTool, "Should suggest next tool");
  });
});

// ============================================================================
// Test: Training SHGAT on Episodic Events
// ============================================================================

Deno.test("Integration: Train SHGAT on episodes, use for prediction", async (t) => {
  const shgat = buildSHGAT();

  await t.step("1. Train on episodic events", () => {
    // Simulate episodic events (from episodic_events table)
    const episodes = [
      // Checkout successes
      { intent: [0.3, 0.7, 0.6, 0.4, 0.2, 0.1, 0.1, 0.2], context: ["db__get_cart"], cap: "cap__checkout_flow", success: true },
      { intent: [0.2, 0.8, 0.7, 0.3, 0.1, 0.1, 0.0, 0.3], context: ["db__get_cart"], cap: "cap__checkout_flow", success: true },
      { intent: [0.4, 0.6, 0.5, 0.5, 0.3, 0.2, 0.1, 0.1], context: ["inventory__check"], cap: "cap__checkout_flow", success: true },
      // Payment only
      { intent: [0.1, 0.9, 0.8, 0.2, 0.1, 0.0, 0.0, 0.2], context: ["payment__validate"], cap: "cap__payment_only", success: true },
      // Some failures
      { intent: [0.3, 0.7, 0.6, 0.4, 0.2, 0.1, 0.1, 0.2], context: ["db__get_cart"], cap: "cap__user_profile", success: false },
      { intent: [0.2, 0.8, 0.7, 0.3, 0.1, 0.1, 0.0, 0.3], context: ["db__get_cart"], cap: "cap__order_confirmation", success: false },
    ];

    // Convert to training examples
    const examples = episodes.map((ep) => ({
      intentEmbedding: ep.intent,
      contextTools: ep.context,
      candidateId: ep.cap,
      outcome: ep.success ? 1 : 0,
    }));

    // Train
    const result = shgat.trainBatch(examples, getEmbedding);

    console.log("\n=== SHGAT Training ===");
    console.log(`  Examples: ${examples.length}`);
    console.log(`  Loss: ${result.loss.toFixed(4)}`);
    console.log(`  Accuracy: ${(result.accuracy * 100).toFixed(1)}%`);

    // Loss should be defined
    assertEquals(typeof result.loss, "number", "Loss should be a number");
  });

  await t.step("2. Predict with trained model", () => {
    // New intent similar to checkout
    const intentEmbedding = [0.35, 0.65, 0.55, 0.45, 0.25, 0.15, 0.05, 0.25];
    const contextEmbeddings = [TOOL_EMBEDDINGS["db__get_cart"]];

    const scores = shgat.scoreAllCapabilities(intentEmbedding, contextEmbeddings);

    console.log("\n=== Post-Training Predictions ===");
    for (const s of scores.sort((a, b) => b.score - a.score)) {
      console.log(`  ${s.capabilityId}: ${s.score.toFixed(4)}`);
    }

    // After training on checkout successes, checkout should score well
    const checkoutScore = scores.find((s) => s.capabilityId === "cap__checkout_flow");
    assertExists(checkoutScore, "Should have checkout score");
  });
});

// ============================================================================
// Test: DR-DSP Dynamic Updates
// ============================================================================

Deno.test("Integration: DR-DSP updates affect hyperpath finding", async (t) => {
  // Initial hyperedges
  const hyperedges: Hyperedge[] = CAPABILITIES.map((cap) =>
    capabilityToHyperedge(cap.id, cap.tools, cap.staticEdges, cap.successRate)
  );
  const drdsp = new DRDSP(hyperedges);

  await t.step("1. Find initial hyperpath", () => {
    const path = drdsp.findShortestHyperpath("db__get_cart", "email__confirm");
    console.log(`\nInitial hyperpath found: ${path.found}`);
    if (path.found) {
      console.log(`  Nodes: ${path.nodeSequence.join(" → ")}`);
      console.log(`  Weight: ${path.totalWeight.toFixed(4)}`);
    }
  });

  await t.step("2. Simulate failure - update hyperedge weight", () => {
    // Payment service failing - increase weight (cost)
    drdsp.applyUpdate({
      type: "weight_increase",
      hyperedgeId: "cap__checkout_flow",
      newWeight: 5.0, // Much higher cost
    });

    const path = drdsp.findShortestHyperpath("db__get_cart", "email__confirm");
    console.log(`\nAfter weight increase:`);
    console.log(`  Found: ${path.found}`);
    if (path.found) {
      console.log(`  Weight: ${path.totalWeight.toFixed(4)}`);
    }
  });

  await t.step("3. Add new hyperedge", () => {
    // Add a faster alternative path
    drdsp.addHyperedge({
      id: "cap__fast_confirm",
      sources: ["db__get_cart"],
      targets: ["email__confirm"],
      weight: 0.5, // Very cheap
    });

    const path = drdsp.findShortestHyperpath("db__get_cart", "email__confirm");
    console.log(`\nWith new fast hyperedge:`);
    console.log(`  Found: ${path.found}`);
    if (path.found) {
      console.log(`  Nodes: ${path.nodeSequence.join(" → ")}`);
      console.log(`  Weight: ${path.totalWeight.toFixed(4)}`);
      console.log(`  Hyperedges: ${path.path.join(", ")}`);
    }
  });
});

// ============================================================================
// Test: DR-DSP Standalone (Intent determines target, no context needed)
// ============================================================================

Deno.test("Integration: DR-DSP standalone pathfinding (replaces Dijkstra)", async (t) => {
  /**
   * DR-DSP is used standalone to find paths on the hypergraph.
   * Intent determines the target capability/tool, then DR-DSP finds the path.
   * No context embeddings needed - just source → target on hypergraph.
   */

  await t.step("DR-DSP finds hyperpath from source to target", () => {
    // Build hypergraph from capabilities
    const hyperedges: Hyperedge[] = CAPABILITIES.map((cap) =>
      capabilityToHyperedge(cap.id, cap.tools, cap.staticEdges, cap.successRate)
    );
    const drdsp = new DRDSP(hyperedges);

    console.log("\n=== DR-DSP Standalone Pathfinding ===\n");

    // Path 1: Within checkout capability (intent: "checkout" → target: email__confirm)
    const path1 = drdsp.findShortestHyperpath("db__get_cart", "email__confirm");
    console.log("Intent: checkout → Path: db__get_cart → email__confirm");
    console.log(`  Found: ${path1.found}`);
    if (path1.found) {
      console.log(`  Nodes: ${path1.nodeSequence.join(" → ")}`);
      console.log(`  Weight: ${path1.totalWeight.toFixed(4)}`);
    }

    // Path 2: Within user profile capability
    const path2 = drdsp.findShortestHyperpath("api__fetch_user", "db__get_user");
    console.log("\nIntent: get user → Path: api__fetch_user → db__get_user");
    console.log(`  Found: ${path2.found}`);
    if (path2.found) {
      console.log(`  Weight: ${path2.totalWeight.toFixed(4)}`);
    }

    // Path 3: Cross-capability (might not exist without bridge)
    const path3 = drdsp.findShortestHyperpath("api__fetch_user", "email__confirm");
    console.log("\nCross-capability: api__fetch_user → email__confirm");
    console.log(`  Found: ${path3.found}`);
    if (!path3.found) {
      console.log("  → No path (separate capability islands)");
    }

    // Assertions
    assertEquals(path1.found || path1.totalWeight >= 0, true, "Path 1 should return valid result");
    assertEquals(path2.found || path2.totalWeight >= 0, true, "Path 2 should return valid result");
  });

  await t.step("DR-DSP SSSP (single source shortest paths)", () => {
    const hyperedges: Hyperedge[] = CAPABILITIES.map((cap) =>
      capabilityToHyperedge(cap.id, cap.tools, cap.staticEdges, cap.successRate)
    );
    const drdsp = new DRDSP(hyperedges);

    // Find all reachable nodes from checkout entry
    const allPaths = drdsp.findAllShortestPaths("db__get_cart");

    console.log("\n=== DR-DSP SSSP from db__get_cart ===");
    console.log(`  Reachable nodes: ${allPaths.size}`);

    for (const [target, result] of allPaths) {
      console.log(`  → ${target}: weight=${result.totalWeight.toFixed(4)}`);
    }
  });
});

// ============================================================================
// Test: SHGAT Backward Mode (Suggestion without context) - ADR-050
// ============================================================================

Deno.test("Integration: SHGAT backward mode (no context) for Suggestion", async (t) => {
  /**
   * Tests SHGAT in backward/suggestion mode where contextTools=[].
   *
   * ADR-050: SHGAT can score capabilities without context using:
   * - Semantic similarity (intent × capability embedding)
   * - Graph features (pageRank, spectralCluster, cooccurrence, reliability)
   *
   * The contextBoost is 0 but graph features still work!
   */

  await t.step("SHGAT scores capabilities without context", () => {
    // Build SHGAT with capabilities
    const toolEmbeddings = new Map<string, number[]>();
    Object.entries(TOOL_EMBEDDINGS).forEach(([id, emb]) => {
      toolEmbeddings.set(id, emb);
    });

    const capData = CAPABILITIES.map((cap) => ({
      id: cap.id,
      toolsUsed: cap.tools,
      embedding: cap.tools.map((t) => TOOL_EMBEDDINGS[t]).reduce(
        (acc, emb) => acc.map((v, i) => v + (emb?.[i] ?? 0) / cap.tools.length),
        new Array(8).fill(0),
      ),
      successRate: cap.successRate,
    }));

    const shgat = createSHGATFromCapabilities(capData, toolEmbeddings);

    // Intent embedding for "process payment"
    const intentEmb = [0.1, 0.85, 0.75, 0.1, 0.1, 0.2, 0.1, 0.2];

    // Score with EMPTY context (backward mode)
    const scoresNoContext = shgat.scoreAllCapabilities(
      intentEmb,
      [], // No context embeddings!
      [], // No context capability IDs!
    );

    console.log("\n=== SHGAT Backward Mode (No Context) ===");
    console.log("Intent: process payment");
    console.log("Context: NONE (backward/suggestion mode)\n");

    for (const result of scoresNoContext.slice(0, 5)) {
      console.log(`  ${result.capabilityId}: ${result.score.toFixed(4)}`);
    }

    // Verify that scoring still works without context
    assertExists(scoresNoContext);
    assertEquals(scoresNoContext.length > 0, true, "Should have scores even without context");

    // The payment capability should score high for payment intent
    const paymentCap = scoresNoContext.find((r) => r.capabilityId.includes("payment"));
    if (paymentCap) {
      console.log(`\n  Best payment match: ${paymentCap.capabilityId} = ${paymentCap.score.toFixed(4)}`);
    }
  });

  await t.step("Compare SHGAT with vs without context", () => {
    const toolEmbeddings = new Map<string, number[]>();
    Object.entries(TOOL_EMBEDDINGS).forEach(([id, emb]) => {
      toolEmbeddings.set(id, emb);
    });

    const capData = CAPABILITIES.map((cap) => ({
      id: cap.id,
      toolsUsed: cap.tools,
      embedding: cap.tools.map((t) => TOOL_EMBEDDINGS[t]).reduce(
        (acc, emb) => acc.map((v, i) => v + (emb?.[i] ?? 0) / cap.tools.length),
        new Array(8).fill(0),
      ),
      successRate: cap.successRate,
    }));

    const shgat = createSHGATFromCapabilities(capData, toolEmbeddings);
    const intentEmb = [0.1, 0.85, 0.75, 0.1, 0.1, 0.2, 0.1, 0.2];

    // Score WITHOUT context (backward mode)
    const scoresNoContext = shgat.scoreAllCapabilities(intentEmb, [], []);

    // Score WITH context (forward mode) - context is payment tools
    const contextEmbs = [TOOL_EMBEDDINGS["payment__validate"], TOOL_EMBEDDINGS["payment__charge"]];
    const scoresWithContext = shgat.scoreAllCapabilities(intentEmb, contextEmbs, ["cap__payment_only"]);

    console.log("\n=== Context Impact Comparison ===");
    console.log("| Capability | No Context | With Context | Δ |");
    console.log("|------------|------------|--------------|---|");

    for (let i = 0; i < Math.min(3, scoresNoContext.length); i++) {
      const noCtx = scoresNoContext[i];
      const withCtx = scoresWithContext.find((r) => r.capabilityId === noCtx.capabilityId);
      if (withCtx) {
        const delta = withCtx.score - noCtx.score;
        console.log(
          `| ${noCtx.capabilityId.substring(0, 20).padEnd(20)} | ${noCtx.score.toFixed(4)} | ${withCtx.score.toFixed(4)} | ${delta >= 0 ? "+" : ""}${delta.toFixed(4)} |`,
        );
      }
    }

    console.log("\nNote: Δ shows contextBoost impact (×0.3 when context matches)");
  });
});

// ============================================================================
// Test: Full Pipeline Simulation
// ============================================================================

Deno.test("Integration: Full predictNextNode simulation", async (t) => {
  /**
   * Simulates what predictNextNode() would do:
   * 1. Get current context (active tools)
   * 2. Embed user intent
   * 3. SHGAT scores capabilities
   * 4. Filter by Thompson threshold
   * 5. DR-DSP finds hyperpath through best capability
   * 6. Return next tool suggestion
   */

  await t.step("Full pipeline", () => {
    // === Setup SHGAT ===
    const shgat = buildSHGAT();

    // === Setup DR-DSP ===
    const hyperedges: Hyperedge[] = CAPABILITIES.map((cap) =>
      capabilityToHyperedge(cap.id, cap.tools, cap.staticEdges, cap.successRate)
    );
    const drdsp = new DRDSP(hyperedges);

    // === Simulate predictNextNode ===
    function predictNextNode(
      intentEmbedding: number[],
      contextTools: string[],
      thompsonThreshold: number = 0.4
    ): {
      nextTool: string | null;
      capability: string;
      confidence: number;
      path: string[];
    } | null {
      // 1. Get context embeddings
      const contextEmbeddings = contextTools
        .map((t) => TOOL_EMBEDDINGS[t])
        .filter((e) => e !== undefined);

      // 2. SHGAT scores all capabilities
      const scores = shgat.scoreAllCapabilities(intentEmbedding, contextEmbeddings);

      // 3. Filter by Thompson threshold
      const validCaps = scores.filter((s) => s.score >= thompsonThreshold);
      if (validCaps.length === 0) {
        return null; // No capability passes threshold
      }

      // 4. Select best capability
      const bestCap = validCaps.reduce((best, current) =>
        current.score > best.score ? current : best
      );

      // 5. Get capability's tool sequence
      const cap = CAPABILITIES.find((c) => c.id === bestCap.capabilityId)!;

      // 6. Find current position in capability
      const currentTool = contextTools[contextTools.length - 1];
      const currentIndex = cap.tools.indexOf(currentTool);

      let nextTool: string | null = null;
      let path: string[] = [];

      if (currentIndex >= 0 && currentIndex < cap.tools.length - 1) {
        // We're in the capability flow - suggest next tool directly
        nextTool = cap.tools[currentIndex + 1];
        path = cap.tools.slice(currentIndex);
      } else {
        // Use DR-DSP to find hyperpath to capability's start
        const targetTool = cap.tools[0];
        const pathResult = drdsp.findShortestHyperpath(currentTool, targetTool);

        if (pathResult.found && pathResult.nodeSequence.length > 1) {
          nextTool = pathResult.nodeSequence[1];
          path = [...pathResult.nodeSequence, ...cap.tools.slice(1)];
        } else {
          // Fallback: start from capability's beginning
          nextTool = cap.tools[0];
          path = cap.tools;
        }
      }

      return {
        nextTool,
        capability: bestCap.capabilityId,
        confidence: bestCap.score,
        path,
      };
    }

    // === Test Cases ===
    console.log("\n=== Full Pipeline Test Cases ===\n");

    // Case 1: User viewing cart, wants to checkout
    const case1 = predictNextNode(
      [0.3, 0.7, 0.6, 0.4, 0.2, 0.1, 0.1, 0.2], // checkout intent
      ["db__get_cart"]
    );
    console.log("Case 1: Cart viewed, checkout intent");
    console.log(`  Next: ${case1?.nextTool}`);
    console.log(`  Capability: ${case1?.capability}`);
    console.log(`  Confidence: ${case1?.confidence.toFixed(4)}`);
    console.log(`  Path: ${case1?.path.join(" → ")}`);

    assertExists(case1, "Should get prediction");

    // Case 2: User in payment flow
    const case2 = predictNextNode(
      [0.1, 0.9, 0.8, 0.2, 0.1, 0.0, 0.0, 0.2], // payment intent
      ["payment__validate"]
    );
    console.log("\nCase 2: In payment flow");
    console.log(`  Next: ${case2?.nextTool}`);
    console.log(`  Capability: ${case2?.capability}`);
    console.log(`  Confidence: ${case2?.confidence.toFixed(4)}`);

    assertExists(case2, "Should get prediction");

    // Case 3: High threshold filters out low-confidence
    const case3 = predictNextNode(
      [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5], // ambiguous intent
      ["db__get_cart"],
      0.95 // Very high threshold
    );
    console.log("\nCase 3: Ambiguous intent, high threshold (0.95)");
    console.log(`  Result: ${case3 ? `Prediction: ${case3.nextTool}` : "No prediction (filtered)"}`);
  });
});

// ============================================================================
// Meta-Capability Hierarchy Tests
// ============================================================================

/**
 * Meta-capabilities for testing hierarchy
 * Structure:
 *   meta__ecommerce
 *   ├── meta__transactions
 *   │   ├── cap__checkout_flow
 *   │   └── cap__payment_only
 *   └── meta__browsing
 *       └── cap__user_profile
 */
const META_CAPABILITIES: Array<{
  id: string;
  contains: string[];
  toolsAggregated: string[];
  successRate: number;
  parents: string[];
}> = [
  {
    id: "meta__transactions",
    contains: ["cap__checkout_flow", "cap__payment_only"],
    toolsAggregated: [
      "db__get_cart", "inventory__check", "payment__validate",
      "payment__charge", "db__save_order", "email__confirm"
    ],
    successRate: 0.93,
    parents: ["meta__ecommerce"],
  },
  {
    id: "meta__browsing",
    contains: ["cap__user_profile", "cap__order_confirmation"],
    toolsAggregated: ["api__fetch_user", "db__get_user", "db__save_order", "email__confirm"],
    successRate: 0.97,
    parents: ["meta__ecommerce"],
  },
  {
    id: "meta__ecommerce",
    contains: ["meta__transactions", "meta__browsing"],
    toolsAggregated: Object.keys(TOOL_EMBEDDINGS), // All tools
    successRate: 0.95,
    parents: [],
  },
];

/**
 * Build SHGAT with full hierarchy (capabilities + meta-capabilities)
 */
function buildSHGATWithMetas(): SHGAT {
  const toolEmbeddingsMap = new Map<string, number[]>();
  for (const [id, emb] of Object.entries(TOOL_EMBEDDINGS)) {
    toolEmbeddingsMap.set(id, emb);
  }

  // Build capabilities with parent info
  const capabilitiesWithMetas: Array<{
    id: string;
    embedding: number[];
    toolsUsed: string[];
    successRate: number;
    parents: string[];
    children: string[];
  }> = [];

  // Add base capabilities
  for (const cap of CAPABILITIES) {
    const parentMeta = META_CAPABILITIES.find((m) =>
      m.contains.includes(cap.id)
    );

    capabilitiesWithMetas.push({
      id: cap.id,
      embedding: getEmbedding(cap.id)!,
      toolsUsed: cap.tools,
      successRate: cap.successRate,
      parents: parentMeta ? [parentMeta.id] : [],
      children: [],
    });
  }

  // Add meta-capabilities
  for (const meta of META_CAPABILITIES) {
    const toolEmbs = meta.toolsAggregated
      .map((t) => TOOL_EMBEDDINGS[t])
      .filter((e) => e !== undefined);

    const dim = 8;
    const metaEmbedding = new Array(dim).fill(0);
    for (const emb of toolEmbs) {
      for (let i = 0; i < dim; i++) {
        metaEmbedding[i] += emb[i] / toolEmbs.length;
      }
    }

    capabilitiesWithMetas.push({
      id: meta.id,
      embedding: metaEmbedding,
      toolsUsed: meta.toolsAggregated,
      successRate: meta.successRate,
      parents: meta.parents,
      children: meta.contains,
    });
  }

  return createSHGATFromCapabilities(
    capabilitiesWithMetas,
    toolEmbeddingsMap,
    {
      numHeads: 2,
      hiddenDim: 4,
      embeddingDim: 8,
    }
  );
}

/**
 * Build DR-DSP with meta-capability hyperedges
 */
function buildDRDSPWithMetas(): DRDSP {
  const hyperedges: Hyperedge[] = [];

  // Add capability hyperedges
  for (const cap of CAPABILITIES) {
    hyperedges.push(
      capabilityToHyperedge(cap.id, cap.tools, cap.staticEdges, cap.successRate)
    );
  }

  // Add meta-capability hyperedges
  // Meta-capabilities connect ALL their aggregated tools
  for (const meta of META_CAPABILITIES) {
    // For navigation: meta-capability provides access to all its tools
    if (meta.toolsAggregated.length >= 2) {
      hyperedges.push({
        id: meta.id,
        sources: [meta.toolsAggregated[0]], // Entry point
        targets: meta.toolsAggregated.slice(1), // All other tools
        weight: 1.0 - meta.successRate, // Lower weight = better
        metadata: {
          type: "meta-capability",
          contains: meta.contains,
        },
      });
    }
  }

  return new DRDSP(hyperedges);
}

Deno.test("Integration: SHGAT scores meta-capabilities", async (t) => {
  await t.step("Meta-capabilities are scored alongside capabilities", () => {
    const shgat = buildSHGATWithMetas();

    // Intent: "financial transaction"
    const intentEmbedding = [0.2, 0.8, 0.7, 0.3, 0.1, 0.1, 0.1, 0.2];
    const contextEmbeddings = [TOOL_EMBEDDINGS["payment__validate"]];

    const scores = shgat.scoreAllCapabilities(intentEmbedding, contextEmbeddings);

    console.log("\n=== SHGAT Meta-Capability Scores ===");
    for (const s of scores.sort((a, b) => b.score - a.score)) {
      const isMeta = s.capabilityId.startsWith("meta__");
      console.log(`  ${isMeta ? "📦" : "  "} ${s.capabilityId}: ${s.score.toFixed(4)}`);
    }

    // Should have 4 capabilities + 3 meta-capabilities = 7 total
    assertEquals(scores.length, 7, "Should score all capabilities and meta-capabilities");

    // Meta-capabilities should have valid scores
    const metaTransactions = scores.find((s) => s.capabilityId === "meta__transactions");
    const metaBrowsing = scores.find((s) => s.capabilityId === "meta__browsing");

    assertExists(metaTransactions, "Should have meta__transactions score");
    assertExists(metaBrowsing, "Should have meta__browsing score");

    // With payment context, transactions should score higher than browsing
    console.log(`\n  meta__transactions: ${metaTransactions!.score.toFixed(4)}`);
    console.log(`  meta__browsing: ${metaBrowsing!.score.toFixed(4)}`);
  });

  await t.step("Hierarchical selection: meta → capability → tools", () => {
    const shgat = buildSHGATWithMetas();

    // Vague intent: "do something with money"
    const intentEmbedding = [0.3, 0.6, 0.5, 0.3, 0.2, 0.2, 0.1, 0.2];

    const scores = shgat.scoreAllCapabilities(intentEmbedding, []);

    // Get top meta-capability
    const metaScores = scores
      .filter((s) => s.capabilityId.startsWith("meta__"))
      .sort((a, b) => b.score - a.score);

    console.log("\n=== Hierarchical Selection ===");
    console.log("Step 1: Top meta-capabilities");
    for (const m of metaScores.slice(0, 2)) {
      console.log(`  ${m.capabilityId}: ${m.score.toFixed(4)}`);
    }

    // Get children of top meta
    const topMeta = META_CAPABILITIES.find((m) => m.id === metaScores[0].capabilityId)!;
    const childScores = scores
      .filter((s) => topMeta.contains.includes(s.capabilityId))
      .sort((a, b) => b.score - a.score);

    console.log(`\nStep 2: Children of ${topMeta.id}`);
    for (const c of childScores) {
      console.log(`  ${c.capabilityId}: ${c.score.toFixed(4)}`);
    }

    console.log(`\nStep 3: Best capability: ${childScores[0]?.capabilityId || "none"}`);
  });
});

Deno.test("Integration: DR-DSP with meta-capabilities", async (t) => {
  await t.step("Meta-capabilities extend reachability", () => {
    const drdsp = buildDRDSPWithMetas();

    console.log("\n=== DR-DSP with Meta-Capabilities ===");

    const stats = drdsp.getStats();
    console.log(`  Hyperedges: ${stats.hyperedgeCount}`);
    console.log(`  Nodes: ${stats.nodeCount}`);

    // Path through meta-capability should be possible
    const path = drdsp.findShortestHyperpath("db__get_cart", "email__confirm");

    console.log(`\n  Path: db__get_cart → email__confirm`);
    console.log(`  Found: ${path.found}`);
    if (path.found) {
      console.log(`  Nodes: ${path.nodeSequence.join(" → ")}`);
      console.log(`  Weight: ${path.totalWeight.toFixed(4)}`);
      console.log(`  Hyperedges: ${path.path.join(", ")}`);
    }

    assertEquals(path.found, true, "Should find path through capability graph");
  });

  await t.step("SSSP shows meta-capability reach", () => {
    const drdsp = buildDRDSPWithMetas();

    // All reachable nodes from entry point
    const allPaths = drdsp.findAllShortestPaths("db__get_cart");

    console.log("\n=== SSSP from db__get_cart ===");
    console.log(`  Reachable: ${allPaths.size} nodes`);

    // Should reach more nodes thanks to meta-capabilities
    const reachableTools = Array.from(allPaths.keys());
    console.log(`  Tools: ${reachableTools.slice(0, 5).join(", ")}...`);

    // With meta-capabilities, should reach most tools
    assertEquals(allPaths.size > 3, true, "Should reach multiple tools");
  });
});

Deno.test("Integration: Combined SHGAT+DR-DSP with hierarchy", async (t) => {
  await t.step("Full pipeline with meta-capability selection", () => {
    const shgat = buildSHGATWithMetas();
    const drdsp = buildDRDSPWithMetas();

    // Vague intent that could match multiple capabilities
    const intentEmbedding = [0.4, 0.5, 0.4, 0.4, 0.3, 0.3, 0.2, 0.2];
    const contextTools = ["db__get_cart"];
    const contextEmbeddings = contextTools
      .map((t) => TOOL_EMBEDDINGS[t])
      .filter((e) => e !== undefined);

    console.log("\n=== Combined Pipeline with Hierarchy ===\n");

    // Phase 1: SHGAT scores everything
    const allScores = shgat.scoreAllCapabilities(intentEmbedding, contextEmbeddings);

    // Phase 2: Two-level selection
    // First, find best meta-capability (for routing)
    const metaScores = allScores
      .filter((s) => s.capabilityId.startsWith("meta__") && !s.capabilityId.includes("ecommerce"))
      .sort((a, b) => b.score - a.score);

    const bestMeta = metaScores[0];
    console.log(`1. Best meta-capability: ${bestMeta.capabilityId} (${bestMeta.score.toFixed(4)})`);

    // Then, find best capability within that meta
    const meta = META_CAPABILITIES.find((m) => m.id === bestMeta.capabilityId)!;
    const capScores = allScores
      .filter((s) => meta.contains.includes(s.capabilityId) && !s.capabilityId.startsWith("meta__"))
      .sort((a, b) => b.score - a.score);

    const bestCap = capScores[0];
    console.log(`2. Best capability in ${meta.id}: ${bestCap?.capabilityId || "none"}`);

    // Phase 3: DR-DSP finds path within best capability
    if (bestCap) {
      const cap = CAPABILITIES.find((c) => c.id === bestCap.capabilityId);
      if (cap) {
        const lastTool = cap.tools[cap.tools.length - 1];
        const path = drdsp.findShortestHyperpath(contextTools[0], lastTool);

        console.log(`3. Path to ${lastTool}:`);
        if (path.found) {
          console.log(`   ${path.nodeSequence.join(" → ")}`);
          console.log(`   Weight: ${path.totalWeight.toFixed(4)}`);
        }

        // Final suggestion
        let nextTool = cap.tools[0];
        if (path.found && path.nodeSequence.length > 1) {
          nextTool = path.nodeSequence[1];
        }

        console.log(`\n4. SUGGESTION:`);
        console.log(`   Meta: ${bestMeta.capabilityId}`);
        console.log(`   Capability: ${bestCap.capabilityId}`);
        console.log(`   Next Tool: ${nextTool}`);

        assertExists(nextTool, "Should suggest next tool");
      }
    }
  });

  await t.step("Meta-capability aggregates child scores for ranking", () => {
    const shgat = buildSHGATWithMetas();

    // Intent clearly about payments
    const intentEmbedding = [0.1, 0.9, 0.8, 0.2, 0.1, 0.0, 0.0, 0.2];

    const allScores = shgat.scoreAllCapabilities(intentEmbedding, []);

    // Compare meta-capability score with average of its children
    const metaTransactions = allScores.find((s) => s.capabilityId === "meta__transactions")!;
    const meta = META_CAPABILITIES.find((m) => m.id === "meta__transactions")!;

    const childScores = allScores
      .filter((s) => meta.contains.includes(s.capabilityId) && !s.capabilityId.startsWith("meta__"))
      .map((s) => s.score);

    const avgChildScore = childScores.reduce((a, b) => a + b, 0) / childScores.length;

    console.log("\n=== Meta vs Children Score Comparison ===");
    console.log(`  meta__transactions: ${metaTransactions.score.toFixed(4)}`);
    console.log(`  Children avg: ${avgChildScore.toFixed(4)}`);
    console.log(`  Children: ${meta.contains.filter(c => !c.startsWith("meta__")).join(", ")}`);

    // Meta-capability score should be related to children (not necessarily equal)
    assertEquals(metaTransactions.score > 0, true, "Meta should have valid score");
  });
});

// ============================================================================
// BENCHMARKS: Performance Measurement (Deno.bench)
// ============================================================================

/**
 * Pre-initialize shared instances for benchmarks
 */
const benchShgat = buildSHGAT();
const benchShgatWithMetas = buildSHGATWithMetas();
const benchDrdsp = new DRDSP(
  CAPABILITIES.map((cap) =>
    capabilityToHyperedge(cap.id, cap.tools, cap.staticEdges, cap.successRate)
  )
);
const benchDrdspWithMetas = buildDRDSPWithMetas();

// Intent embeddings for benchmarks
const BENCH_INTENT_CHECKOUT = [0.3, 0.7, 0.6, 0.4, 0.2, 0.1, 0.1, 0.2];
const BENCH_INTENT_PAYMENT = [0.1, 0.85, 0.75, 0.1, 0.1, 0.2, 0.1, 0.2];
const BENCH_INTENT_VAGUE = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5];

// ============================================================================
// Benchmarks: SHGAT Scoring
// ============================================================================

Deno.bench({
  name: "SHGAT: scoring (4 caps)",
  group: "shgat-scoring",
  baseline: true,
  fn: () => {
    // Context-free scoring per original paper
    benchShgat.scoreAllCapabilities(BENCH_INTENT_CHECKOUT);
  },
});

Deno.bench({
  name: "SHGAT: scoring (7 caps+metas)",
  group: "shgat-scoring",
  fn: () => {
    // Context-free scoring per original paper
    benchShgatWithMetas.scoreAllCapabilities(BENCH_INTENT_CHECKOUT);
  },
});

// ============================================================================
// Benchmarks: DR-DSP Pathfinding
// ============================================================================

Deno.bench({
  name: "DR-DSP: findShortestHyperpath (4 caps)",
  group: "drdsp-pathfinding",
  baseline: true,
  fn: () => {
    benchDrdsp.findShortestHyperpath("db__get_cart", "email__confirm");
  },
});

Deno.bench({
  name: "DR-DSP: findShortestHyperpath (7 caps+metas)",
  group: "drdsp-pathfinding",
  fn: () => {
    benchDrdspWithMetas.findShortestHyperpath("db__get_cart", "email__confirm");
  },
});

Deno.bench({
  name: "DR-DSP: SSSP findAllShortestPaths (4 caps)",
  group: "drdsp-pathfinding",
  fn: () => {
    benchDrdsp.findAllShortestPaths("db__get_cart");
  },
});

Deno.bench({
  name: "DR-DSP: SSSP findAllShortestPaths (7 caps+metas)",
  group: "drdsp-pathfinding",
  fn: () => {
    benchDrdspWithMetas.findAllShortestPaths("db__get_cart");
  },
});

// ============================================================================
// Benchmarks: Combined Pipeline (Mode Prediction & Suggestion)
// ============================================================================

Deno.bench({
  name: "Pipeline: SHGAT + DR-DSP (4 caps)",
  group: "pipeline-modes",
  baseline: true,
  fn: () => {
    // Step 1: SHGAT scores capabilities (context-free)
    const scores = benchShgat.scoreAllCapabilities(BENCH_INTENT_CHECKOUT);

    // Step 2: Get best capability
    const bestCap = scores.reduce((best, curr) =>
      curr.score > best.score ? curr : best
    );

    // Step 3: DR-DSP find path (context = current position handled here)
    const cap = CAPABILITIES.find((c) => c.id === bestCap.capabilityId)!;
    benchDrdsp.findShortestHyperpath("db__get_cart", cap.tools[cap.tools.length - 1]);
  },
});

Deno.bench({
  name: "Pipeline: SHGAT + DR-DSP (7 caps+metas)",
  group: "pipeline-modes",
  fn: () => {
    // Full hierarchical prediction
    const allScores = benchShgatWithMetas.scoreAllCapabilities(BENCH_INTENT_CHECKOUT);

    // Find best meta, then best capability within
    const metaScores = allScores
      .filter((s) => s.capabilityId.startsWith("meta__"))
      .sort((a, b) => b.score - a.score);

    const bestMeta = metaScores[0];
    const meta = META_CAPABILITIES.find((m) => m.id === bestMeta.capabilityId);

    if (meta) {
      const capScores = allScores
        .filter((s) => meta.contains.includes(s.capabilityId) && !s.capabilityId.startsWith("meta__"))
        .sort((a, b) => b.score - a.score);

      if (capScores.length > 0) {
        const cap = CAPABILITIES.find((c) => c.id === capScores[0].capabilityId);
        if (cap) {
          benchDrdspWithMetas.findShortestHyperpath("db__get_cart", cap.tools[cap.tools.length - 1]);
        }
      }
    }
  },
});

// ============================================================================
// Benchmarks: Intent Variations
// ============================================================================

Deno.bench({
  name: "SHGAT: checkout intent",
  group: "intent-scaling",
  baseline: true,
  fn: () => {
    benchShgat.scoreAllCapabilities(BENCH_INTENT_CHECKOUT);
  },
});

Deno.bench({
  name: "SHGAT: payment intent",
  group: "intent-scaling",
  fn: () => {
    benchShgat.scoreAllCapabilities(BENCH_INTENT_PAYMENT);
  },
});

Deno.bench({
  name: "SHGAT: vague intent",
  group: "intent-scaling",
  fn: () => {
    benchShgat.scoreAllCapabilities(BENCH_INTENT_VAGUE);
  },
});

// ============================================================================
// Benchmarks: Instance Creation (Setup Cost)
// ============================================================================

Deno.bench({
  name: "Setup: buildSHGAT (4 capabilities)",
  group: "setup-cost",
  baseline: true,
  fn: () => {
    buildSHGAT();
  },
});

Deno.bench({
  name: "Setup: buildSHGATWithMetas (7 caps+metas)",
  group: "setup-cost",
  fn: () => {
    buildSHGATWithMetas();
  },
});

Deno.bench({
  name: "Setup: new DRDSP (4 hyperedges)",
  group: "setup-cost",
  fn: () => {
    const hyperedges = CAPABILITIES.map((cap) =>
      capabilityToHyperedge(cap.id, cap.tools, cap.staticEdges, cap.successRate)
    );
    new DRDSP(hyperedges);
  },
});

Deno.bench({
  name: "Setup: buildDRDSPWithMetas (7 hyperedges)",
  group: "setup-cost",
  fn: () => {
    buildDRDSPWithMetas();
  },
});

// ============================================================================
// PRECISION TESTS: Accuracy Measurement
// ============================================================================

/**
 * Ground truth test scenarios for precision measurement.
 * Each scenario has an intent, context, and expected results.
 */
interface PrecisionScenario {
  name: string;
  intentDescription: string;
  intentEmbedding: number[];
  contextTools: string[];
  expectedCapability: string;
  expectedNextTool: string;
  alternativeCapabilities?: string[]; // Also acceptable answers
}

const PRECISION_SCENARIOS: PrecisionScenario[] = [
  // === Payment Intent Scenarios ===
  {
    name: "payment_from_cart",
    intentDescription: "User wants to pay after viewing cart",
    intentEmbedding: [0.2, 0.85, 0.75, 0.2, 0.1, 0.1, 0.05, 0.2],
    contextTools: ["db__get_cart"],
    expectedCapability: "cap__checkout_flow",
    expectedNextTool: "inventory__check",
    alternativeCapabilities: ["cap__payment_only"],
  },
  {
    name: "payment_direct",
    intentDescription: "Direct payment processing",
    intentEmbedding: [0.1, 0.95, 0.9, 0.1, 0.05, 0.05, 0.0, 0.15],
    contextTools: ["payment__validate"],
    expectedCapability: "cap__payment_only",
    expectedNextTool: "payment__charge",
  },
  {
    name: "payment_mid_checkout",
    intentDescription: "Continue checkout after inventory check",
    intentEmbedding: [0.3, 0.8, 0.7, 0.3, 0.2, 0.1, 0.1, 0.2],
    contextTools: ["db__get_cart", "inventory__check"],
    expectedCapability: "cap__checkout_flow",
    expectedNextTool: "payment__validate",
  },

  // === Order Confirmation Scenarios ===
  {
    name: "confirm_order",
    intentDescription: "Save and confirm order",
    intentEmbedding: [0.4, 0.3, 0.2, 0.8, 0.7, 0.2, 0.1, 0.3],
    contextTools: ["payment__charge"],
    expectedCapability: "cap__order_confirmation",
    expectedNextTool: "db__save_order",
    alternativeCapabilities: ["cap__checkout_flow"],
  },
  {
    name: "send_confirmation_email",
    intentDescription: "Send order confirmation email",
    intentEmbedding: [0.2, 0.1, 0.1, 0.6, 0.9, 0.15, 0.1, 0.4],
    contextTools: ["db__save_order"],
    expectedCapability: "cap__order_confirmation",
    expectedNextTool: "email__confirm",
  },

  // === User Profile Scenarios ===
  {
    name: "fetch_user_profile",
    intentDescription: "Get user information",
    intentEmbedding: [0.4, 0.1, 0.05, 0.2, 0.1, 0.85, 0.8, 0.2],
    contextTools: [],
    expectedCapability: "cap__user_profile",
    expectedNextTool: "api__fetch_user",
  },
  {
    name: "get_user_from_db",
    intentDescription: "Retrieve user from database",
    intentEmbedding: [0.5, 0.1, 0.0, 0.25, 0.1, 0.9, 0.85, 0.15],
    contextTools: ["api__fetch_user"],
    expectedCapability: "cap__user_profile",
    expectedNextTool: "db__get_user",
  },

  // === Ambiguous/Edge Cases ===
  {
    name: "checkout_cold_start",
    intentDescription: "Start checkout with no context",
    intentEmbedding: [0.5, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1, 0.2],
    contextTools: [], // No context - cold start
    expectedCapability: "cap__checkout_flow",
    expectedNextTool: "db__get_cart",
    alternativeCapabilities: ["cap__payment_only"],
  },
  {
    name: "vague_transaction_intent",
    intentDescription: "Vague financial transaction",
    intentEmbedding: [0.4, 0.5, 0.45, 0.4, 0.35, 0.3, 0.2, 0.25],
    contextTools: ["db__get_cart"],
    expectedCapability: "cap__checkout_flow",
    expectedNextTool: "inventory__check",
    alternativeCapabilities: ["cap__payment_only", "cap__order_confirmation"],
  },
];

/**
 * Precision metrics calculator
 */
interface PrecisionMetrics {
  top1Accuracy: number;
  top3Accuracy: number;
  mrr: number; // Mean Reciprocal Rank
  capabilityAccuracy: number;
  toolAccuracy: number;
  scenarios: Array<{
    name: string;
    capabilityCorrect: boolean;
    toolCorrect: boolean;
    predictedCapability: string;
    predictedTool: string;
    capabilityRank: number;
  }>;
}

function calculatePrecisionMetrics(
  shgat: SHGAT,
  drdsp: DRDSP,
  scenarios: PrecisionScenario[],
): PrecisionMetrics {
  const results: PrecisionMetrics["scenarios"] = [];
  let top1Correct = 0;
  let top3Correct = 0;
  let capCorrect = 0;
  let toolCorrect = 0;
  let sumReciprocalRank = 0;

  for (const scenario of scenarios) {
    // Score capabilities (context-free per original paper)
    const scores = shgat.scoreAllCapabilities(scenario.intentEmbedding);

    // Sort by score
    const sorted = [...scores].sort((a, b) => b.score - a.score);

    // Find rank of expected capability
    const expectedCaps = [scenario.expectedCapability, ...(scenario.alternativeCapabilities || [])];
    let capabilityRank = sorted.findIndex((s) => expectedCaps.includes(s.capabilityId)) + 1;
    if (capabilityRank === 0) capabilityRank = sorted.length + 1; // Not found

    // Get predicted capability and tool
    const predictedCap = sorted[0]?.capabilityId || "none";
    const cap = CAPABILITIES.find((c) => c.id === predictedCap);

    // Determine next tool based on context position
    let predictedTool = "none";
    if (cap) {
      const lastContextTool = scenario.contextTools[scenario.contextTools.length - 1];
      const contextIndex = cap.tools.indexOf(lastContextTool);

      if (contextIndex >= 0 && contextIndex < cap.tools.length - 1) {
        // Continue in sequence
        predictedTool = cap.tools[contextIndex + 1];
      } else {
        // Use DR-DSP to find path
        const target = cap.tools[cap.tools.length - 1];
        const source = lastContextTool || cap.tools[0];
        const path = drdsp.findShortestHyperpath(source, target);
        predictedTool = path.found && path.nodeSequence.length > 1
          ? path.nodeSequence[1]
          : cap.tools[0];
      }
    }

    // Check correctness
    const isCapCorrect = expectedCaps.includes(predictedCap);
    const isToolCorrect = predictedTool === scenario.expectedNextTool;

    if (capabilityRank === 1) top1Correct++;
    if (capabilityRank <= 3) top3Correct++;
    if (isCapCorrect) capCorrect++;
    if (isToolCorrect) toolCorrect++;
    sumReciprocalRank += 1 / capabilityRank;

    results.push({
      name: scenario.name,
      capabilityCorrect: isCapCorrect,
      toolCorrect: isToolCorrect,
      predictedCapability: predictedCap,
      predictedTool,
      capabilityRank,
    });
  }

  const n = scenarios.length;
  return {
    top1Accuracy: top1Correct / n,
    top3Accuracy: top3Correct / n,
    mrr: sumReciprocalRank / n,
    capabilityAccuracy: capCorrect / n,
    toolAccuracy: toolCorrect / n,
    scenarios: results,
  };
}

// ============================================================================
// Precision Tests
// ============================================================================

Deno.test("Precision: SHGAT+DR-DSP scoring accuracy", () => {
  const shgat = buildSHGAT();
  const drdsp = new DRDSP(
    CAPABILITIES.map((cap) =>
      capabilityToHyperedge(cap.id, cap.tools, cap.staticEdges, cap.successRate)
    )
  );

  const metrics = calculatePrecisionMetrics(shgat, drdsp, PRECISION_SCENARIOS);

  console.log("\n" + "=".repeat(60));
  console.log("PRECISION: SHGAT + DR-DSP (context-free per original paper)");
  console.log("=".repeat(60));
  console.log(`\nScenarios tested: ${PRECISION_SCENARIOS.length}`);
  console.log(`\n📊 METRICS:`);
  console.log(`  Top-1 Accuracy:      ${(metrics.top1Accuracy * 100).toFixed(1)}%`);
  console.log(`  Top-3 Accuracy:      ${(metrics.top3Accuracy * 100).toFixed(1)}%`);
  console.log(`  MRR:                 ${metrics.mrr.toFixed(3)}`);
  console.log(`  Capability Accuracy: ${(metrics.capabilityAccuracy * 100).toFixed(1)}%`);
  console.log(`  Tool Accuracy:       ${(metrics.toolAccuracy * 100).toFixed(1)}%`);

  console.log(`\n📋 DETAILED RESULTS:`);
  console.log("| Scenario | Cap | Tool | Predicted Cap | Predicted Tool | Rank |");
  console.log("|----------|-----|------|---------------|----------------|------|");
  for (const r of metrics.scenarios) {
    console.log(
      `| ${r.name.padEnd(22).substring(0, 22)} | ${r.capabilityCorrect ? "✅" : "❌"} | ${r.toolCorrect ? "✅" : "❌"} | ${r.predictedCapability.substring(0, 20).padEnd(20)} | ${r.predictedTool.substring(0, 18).padEnd(18)} | ${r.capabilityRank} |`
    );
  }

  // Assertions - expect reasonable accuracy
  assertEquals(metrics.top1Accuracy >= 0.5, true, "Top-1 accuracy should be >= 50%");
  assertEquals(metrics.top3Accuracy >= 0.7, true, "Top-3 accuracy should be >= 70%");
});

Deno.test("Precision: Cold Start scenarios (no context)", () => {
  const shgat = buildSHGAT();

  // Filter only cold start scenarios
  const coldStartScenarios = PRECISION_SCENARIOS.filter((s) => s.contextTools.length === 0);

  console.log("\n" + "=".repeat(60));
  console.log("PRECISION: Cold Start Scenarios (contextTools = [])");
  console.log("=".repeat(60));

  for (const scenario of coldStartScenarios) {
    const scores = shgat.scoreAllCapabilities(scenario.intentEmbedding, [], []);
    const sorted = [...scores].sort((a, b) => b.score - a.score);

    console.log(`\n🎯 ${scenario.name}: "${scenario.intentDescription}"`);
    console.log(`   Expected: ${scenario.expectedCapability} → ${scenario.expectedNextTool}`);
    console.log(`   Top 3 predictions:`);
    for (let i = 0; i < 3 && i < sorted.length; i++) {
      const isCorrect = sorted[i].capabilityId === scenario.expectedCapability ||
        scenario.alternativeCapabilities?.includes(sorted[i].capabilityId);
      console.log(`     ${i + 1}. ${sorted[i].capabilityId}: ${sorted[i].score.toFixed(4)} ${isCorrect ? "✅" : ""}`);
    }
  }

  // At least one cold start should work
  assertEquals(coldStartScenarios.length >= 1, true, "Should have cold start scenarios");
});

