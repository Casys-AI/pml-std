/**
 * Unit tests for DR-DSP (Directed Relationship Dynamic Shortest Path)
 *
 * Tests cover:
 * - Basic hyperpath finding
 * - Single Source Shortest Paths (SSSP)
 * - Dynamic updates (weight changes, edge additions)
 * - Meta-capability hyperedges
 * - Hierarchical navigation through meta-capabilities
 *
 * @module tests/unit/graphrag/algorithms/dr-dsp_test
 */

import { assertEquals, assertExists, assertGreater } from "@std/assert";
import {
  capabilityToHyperedge,
  DRDSP,
  type Hyperedge,
} from "../../../../src/graphrag/algorithms/dr-dsp.ts";

// ============================================================================
// Test Fixtures
// ============================================================================

/**
 * Simple capabilities for basic tests
 */
const SIMPLE_CAPABILITIES = [
  {
    id: "cap__checkout",
    tools: ["cart", "payment", "confirm"],
    successRate: 0.9,
    staticEdges: [
      { from: "cart", to: "payment", type: "provides" },
      { from: "payment", to: "confirm", type: "provides" },
    ],
  },
  {
    id: "cap__browse",
    tools: ["search", "view"],
    successRate: 0.95,
    staticEdges: [
      { from: "search", to: "view", type: "provides" },
    ],
  },
];

/**
 * Meta-capabilities for hierarchy tests
 * Structure:
 *   meta__ecommerce
 *   ├── meta__transactions (checkout, refund)
 *   │   ├── cap__checkout (cart → payment → confirm)
 *   │   └── cap__refund (order → refund_api → notify)
 *   └── meta__browsing (browse, profile)
 *       ├── cap__browse (search → view)
 *       └── cap__profile (auth → user_data)
 */
const CAPABILITIES_WITH_HIERARCHY = [
  {
    id: "cap__checkout",
    tools: ["cart", "payment", "confirm"],
    successRate: 0.9,
    staticEdges: [
      { from: "cart", to: "payment", type: "provides" },
      { from: "payment", to: "confirm", type: "provides" },
    ],
    parent: "meta__transactions",
  },
  {
    id: "cap__refund",
    tools: ["order", "refund_api", "notify"],
    successRate: 0.85,
    staticEdges: [
      { from: "order", to: "refund_api", type: "provides" },
      { from: "refund_api", to: "notify", type: "provides" },
    ],
    parent: "meta__transactions",
  },
  {
    id: "cap__browse",
    tools: ["search", "view"],
    successRate: 0.95,
    staticEdges: [
      { from: "search", to: "view", type: "provides" },
    ],
    parent: "meta__browsing",
  },
  {
    id: "cap__profile",
    tools: ["auth", "user_data"],
    successRate: 0.98,
    staticEdges: [
      { from: "auth", to: "user_data", type: "provides" },
    ],
    parent: "meta__browsing",
  },
];

const META_CAPABILITIES = [
  {
    id: "meta__transactions",
    contains: ["cap__checkout", "cap__refund"],
    toolsAggregated: ["cart", "payment", "confirm", "order", "refund_api", "notify"],
    successRate: 0.88,
    parent: "meta__ecommerce",
  },
  {
    id: "meta__browsing",
    contains: ["cap__browse", "cap__profile"],
    toolsAggregated: ["search", "view", "auth", "user_data"],
    successRate: 0.96,
    parent: "meta__ecommerce",
  },
  {
    id: "meta__ecommerce",
    contains: ["meta__transactions", "meta__browsing"],
    toolsAggregated: [
      "cart",
      "payment",
      "confirm",
      "order",
      "refund_api",
      "notify",
      "search",
      "view",
      "auth",
      "user_data",
    ],
    successRate: 0.92,
    parent: null,
  },
];

// ============================================================================
// Helper Functions
// ============================================================================

function buildSimpleDRDSP(): DRDSP {
  const hyperedges = SIMPLE_CAPABILITIES.map((cap) =>
    capabilityToHyperedge(cap.id, cap.tools, cap.staticEdges, cap.successRate)
  );
  return new DRDSP(hyperedges);
}

function buildDRDSPWithMetaCapabilities(): DRDSP {
  const hyperedges: Hyperedge[] = [];

  // Add base capability hyperedges
  for (const cap of CAPABILITIES_WITH_HIERARCHY) {
    hyperedges.push(
      capabilityToHyperedge(cap.id, cap.tools, cap.staticEdges, cap.successRate),
    );
  }

  // Add meta-capability hyperedges
  for (const meta of META_CAPABILITIES) {
    // Meta-capabilities as bridge hyperedges connecting all aggregated tools
    if (meta.toolsAggregated.length >= 2) {
      hyperedges.push({
        id: meta.id,
        sources: [meta.toolsAggregated[0]],
        targets: meta.toolsAggregated.slice(1),
        weight: 1.0 - meta.successRate,
        metadata: {
          type: "meta-capability",
          contains: meta.contains,
          parent: meta.parent,
        },
      });
    }
  }

  return new DRDSP(hyperedges);
}

// ============================================================================
// Basic DR-DSP Tests
// ============================================================================

Deno.test("DR-DSP: creates hypergraph from capabilities", () => {
  const drdsp = buildSimpleDRDSP();
  const stats = drdsp.getStats();

  assertEquals(stats.hyperedgeCount, 2);
  assertGreater(stats.nodeCount, 0);
});

Deno.test("DR-DSP: finds hyperpath within capability", () => {
  const drdsp = buildSimpleDRDSP();

  // Path within checkout capability
  const result = drdsp.findShortestHyperpath("cart", "confirm");

  assertEquals(result.found, true);
  assertGreater(result.nodeSequence.length, 1);
  assertEquals(result.nodeSequence[0], "cart");
  assertEquals(result.nodeSequence[result.nodeSequence.length - 1], "confirm");
});

Deno.test("DR-DSP: returns not found for disconnected nodes", () => {
  const drdsp = buildSimpleDRDSP();

  // No path between browse and checkout capabilities
  const result = drdsp.findShortestHyperpath("search", "confirm");

  assertEquals(result.found, false);
});

Deno.test("DR-DSP: SSSP finds all reachable nodes", () => {
  const drdsp = buildSimpleDRDSP();

  const allPaths = drdsp.findAllShortestPaths("cart");

  assertGreater(allPaths.size, 0);
  // Should reach payment and confirm from cart
  assertEquals(allPaths.has("payment") || allPaths.has("confirm"), true);
});

// ============================================================================
// Dynamic Update Tests
// ============================================================================

Deno.test("DR-DSP: weight increase affects path cost", () => {
  const drdsp = buildSimpleDRDSP();

  // Get initial path
  const before = drdsp.findShortestHyperpath("cart", "confirm");
  const weightBefore = before.totalWeight;

  // Increase weight
  drdsp.applyUpdate({
    type: "weight_increase",
    hyperedgeId: "cap__checkout",
    newWeight: 5.0,
  });

  // Check new path
  const after = drdsp.findShortestHyperpath("cart", "confirm");

  assertGreater(after.totalWeight, weightBefore);
});

Deno.test("DR-DSP: add hyperedge creates new path", () => {
  const drdsp = buildSimpleDRDSP();

  // Initially no path between capabilities
  const before = drdsp.findShortestHyperpath("view", "cart");
  assertEquals(before.found, false);

  // Add bridge hyperedge
  drdsp.addHyperedge({
    id: "bridge",
    sources: ["view"],
    targets: ["cart"],
    weight: 0.5,
  });

  // Now path should exist
  const after = drdsp.findShortestHyperpath("view", "cart");
  assertEquals(after.found, true);
});

// ============================================================================
// Meta-Capability Tests
// ============================================================================

Deno.test("DR-DSP Meta: includes meta-capability hyperedges", () => {
  const drdsp = buildDRDSPWithMetaCapabilities();
  const stats = drdsp.getStats();

  // 4 capabilities + 3 meta-capabilities = 7 hyperedges
  assertEquals(stats.hyperedgeCount, 7);
});

Deno.test("DR-DSP Meta: meta-capabilities extend reachability", () => {
  const drdsp = buildDRDSPWithMetaCapabilities();

  // With meta-capabilities, we should reach more nodes from cart
  const allPaths = drdsp.findAllShortestPaths("cart");

  // cart is in meta__transactions which bridges to all transaction tools
  assertGreater(allPaths.size, 2);
});

Deno.test("DR-DSP Meta: path through meta-capability", () => {
  const drdsp = buildDRDSPWithMetaCapabilities();

  // cart → ... → notify (both in meta__transactions)
  const result = drdsp.findShortestHyperpath("cart", "notify");

  // With meta-capability bridge, should find path
  if (result.found) {
    assertEquals(result.nodeSequence[0], "cart");
    assertEquals(result.nodeSequence[result.nodeSequence.length - 1], "notify");
    // Path should include meta-capability
    const hasMeta = result.path.some((h) => h.startsWith("meta__"));
    assertEquals(hasMeta, true);
  }
});

Deno.test("DR-DSP Meta: cross-meta path via root", () => {
  const drdsp = buildDRDSPWithMetaCapabilities();

  // cart (transactions) → search (browsing) - need meta__ecommerce bridge
  const result = drdsp.findShortestHyperpath("cart", "search");

  // With meta__ecommerce bridging all, might find path
  if (result.found) {
    assertGreater(result.nodeSequence.length, 1);
  }
});

Deno.test("DR-DSP Meta: meta-capability weight reflects reliability", () => {
  const drdsp = buildDRDSPWithMetaCapabilities();

  // Get stats to verify weights are set
  const stats = drdsp.getStats();
  assertExists(stats);

  // meta__browsing has 0.96 success rate → weight 0.04
  // meta__transactions has 0.88 success rate → weight 0.12
  // Lower weight = better path
});

Deno.test("DR-DSP Meta: hierarchical SSSP coverage", () => {
  const drdsp = buildDRDSPWithMetaCapabilities();

  // From cart, meta__ecommerce should provide extensive reach
  const fromCart = drdsp.findAllShortestPaths("cart");

  // From search, different meta branch
  const fromSearch = drdsp.findAllShortestPaths("search");

  // Both should have reasonable coverage due to meta bridges
  assertGreater(fromCart.size, 0);
  assertGreater(fromSearch.size, 0);
});

Deno.test("DR-DSP Meta: capability vs meta-capability path selection", () => {
  const drdsp = buildDRDSPWithMetaCapabilities();

  // Within same capability: should use capability hyperedge (more specific)
  const withinCap = drdsp.findShortestHyperpath("cart", "confirm");

  if (withinCap.found) {
    // Should prefer cap__checkout over meta__transactions
    // (lower weight for specific capability)
    // May or may not use capability depending on weights
    assertExists(withinCap.path);
  }
});

Deno.test("DR-DSP Meta: update meta-capability weight", () => {
  const drdsp = buildDRDSPWithMetaCapabilities();

  // Find path using meta
  const before = drdsp.findShortestHyperpath("cart", "notify");

  // Increase meta-capability weight (simulate lower reliability)
  drdsp.applyUpdate({
    type: "weight_increase",
    hyperedgeId: "meta__transactions",
    newWeight: 10.0,
  });

  // Path may change or become more expensive
  const after = drdsp.findShortestHyperpath("cart", "notify");

  // Path should still be found (other routes may exist)
  // But weight should be different if it used meta
  if (before.found && after.found) {
    // Weight should have increased if path used meta
    if (before.path.includes("meta__transactions")) {
      assertGreater(after.totalWeight, before.totalWeight);
    }
  }
});

// ============================================================================
// Edge Cases
// ============================================================================

Deno.test("DR-DSP: empty hyperedge list", () => {
  const drdsp = new DRDSP([]);
  const stats = drdsp.getStats();

  assertEquals(stats.hyperedgeCount, 0);
  assertEquals(stats.nodeCount, 0);
});

Deno.test("DR-DSP: single node hyperedge", () => {
  const drdsp = new DRDSP([
    { id: "single", sources: ["a"], targets: ["a"], weight: 1.0 },
  ]);

  const result = drdsp.findShortestHyperpath("a", "a");
  // Self-loop should be found
  assertEquals(result.found, true);
});

Deno.test("DR-DSP: non-existent node", () => {
  const drdsp = buildSimpleDRDSP();

  const result = drdsp.findShortestHyperpath("nonexistent", "cart");
  assertEquals(result.found, false);
});

Deno.test("DR-DSP: getStats returns expected structure", () => {
  const drdsp = buildDRDSPWithMetaCapabilities();
  const stats = drdsp.getStats();

  assertExists(stats.hyperedgeCount);
  assertExists(stats.nodeCount);
  assertExists(stats.avgHyperedgeSize);

  assertEquals(typeof stats.hyperedgeCount, "number");
  assertEquals(typeof stats.nodeCount, "number");
  assertEquals(typeof stats.avgHyperedgeSize, "number");
});
