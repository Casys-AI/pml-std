/**
 * Emergence Metrics Unit Tests
 *
 * Tests for CAS (Complex Adaptive Systems) metrics computation.
 * Based on SYMBIOSIS/ODI framework (arxiv:2503.13754).
 *
 * @module tests/unit/mcp/routing/emergence
 */

import { assertEquals, assertAlmostEquals } from "jsr:@std/assert@1";
import { _internals } from "../../../../src/api/emergence.ts";

const {
  computeGraphEntropy,
  computeJaccardStability,
  computeTrend,
  detectPhaseTransition,
  generateRecommendations,
} = _internals;

Deno.test("computeGraphEntropy - Shannon entropy computation", async (t) => {
  await t.step("returns 0 for empty array", () => {
    assertEquals(computeGraphEntropy([]), 0);
  });

  await t.step("returns 0 for all-zero weights", () => {
    assertEquals(computeGraphEntropy([0, 0, 0]), 0);
  });

  await t.step("returns 0 for single element (no diversity)", () => {
    assertEquals(computeGraphEntropy([1]), 0);
  });

  await t.step("returns 1 for uniform distribution", () => {
    // All equal weights = maximum entropy
    const result = computeGraphEntropy([1, 1, 1, 1]);
    assertAlmostEquals(result, 1, 0.001);
  });

  await t.step("returns low entropy for skewed distribution", () => {
    // One dominant weight = low entropy
    const result = computeGraphEntropy([100, 1, 1, 1]);
    assertEquals(result < 0.5, true);
  });

  await t.step("normalizes to 0-1 range", () => {
    const result = computeGraphEntropy([1, 2, 3, 4, 5]);
    assertEquals(result >= 0, true);
    assertEquals(result <= 1, true);
  });
});

Deno.test("computeJaccardStability - Community stability", async (t) => {
  await t.step("returns 1.0 for empty previous communities", () => {
    const current = new Map([["a", 0], ["b", 0]]);
    const prev = new Map<string, number>();
    assertEquals(computeJaccardStability(current, prev), 1.0);
  });

  await t.step("returns 1.0 for identical communities", () => {
    const current = new Map([["a", 0], ["b", 0], ["c", 1], ["d", 1]]);
    const prev = new Map([["a", 0], ["b", 0], ["c", 1], ["d", 1]]);
    assertEquals(computeJaccardStability(current, prev), 1.0);
  });

  await t.step("returns < 1 for different communities", () => {
    const current = new Map([["a", 0], ["b", 1], ["c", 1]]);
    const prev = new Map([["a", 0], ["b", 0], ["c", 1]]);
    const result = computeJaccardStability(current, prev);
    assertEquals(result < 1, true);
    assertEquals(result >= 0, true);
  });

  await t.step("returns 0 for completely different clustering", () => {
    // 4 nodes: prev all same cluster, current all different
    const current = new Map([["a", 0], ["b", 1], ["c", 2], ["d", 3]]);
    const prev = new Map([["a", 0], ["b", 0], ["c", 0], ["d", 0]]);
    const result = computeJaccardStability(current, prev);
    assertEquals(result, 0);
  });
});

Deno.test("computeTrend - Trend detection", async (t) => {
  await t.step("returns 'rising' for > 5% increase", () => {
    assertEquals(computeTrend(0.6, 0.5), "rising");
  });

  await t.step("returns 'falling' for > 5% decrease", () => {
    assertEquals(computeTrend(0.4, 0.5), "falling");
  });

  await t.step("returns 'stable' for < 5% change", () => {
    assertEquals(computeTrend(0.52, 0.5), "stable");
    assertEquals(computeTrend(0.48, 0.5), "stable");
  });

  await t.step("handles edge case at threshold", () => {
    // Note: computeTrend uses absolute delta comparison (delta > 0.05)
    // Due to floating-point precision, 0.55 - 0.5 ≈ 0.05000000000000004
    // So 0.55 is technically "just above" threshold
    assertEquals(computeTrend(0.55, 0.5), "rising"); // just above 5% due to FP precision
    assertEquals(computeTrend(0.549, 0.5), "stable"); // 4.9% < 5% threshold
  });
});

Deno.test("detectPhaseTransition - Phase transition detection", async (t) => {
  await t.step("returns not detected for < 10 data points", () => {
    const history = Array(5).fill({ entropy: 0.5 });
    const result = detectPhaseTransition(history);
    assertEquals(result.detected, false);
    assertEquals(result.type, "none");
  });

  await t.step("returns 'expansion' for rising entropy", () => {
    // Create history where recent entropy is much higher
    const history = [
      ...Array(5).fill({ entropy: 0.3 }), // older
      ...Array(5).fill({ entropy: 0.7 }), // recent (delta = 0.4 > 0.2)
    ];
    const result = detectPhaseTransition(history);
    assertEquals(result.detected, true);
    assertEquals(result.type, "expansion");
    assertEquals(result.confidence > 0, true);
  });

  await t.step("returns 'consolidation' for falling entropy", () => {
    const history = [
      ...Array(5).fill({ entropy: 0.7 }), // older
      ...Array(5).fill({ entropy: 0.3 }), // recent (delta = -0.4 < -0.2)
    ];
    const result = detectPhaseTransition(history);
    assertEquals(result.detected, true);
    assertEquals(result.type, "consolidation");
  });

  await t.step("returns not detected for stable entropy", () => {
    const history = Array(10).fill({ entropy: 0.5 });
    const result = detectPhaseTransition(history);
    assertEquals(result.detected, false);
  });

  await t.step("confidence is capped at 1.0", () => {
    const history = [
      ...Array(5).fill({ entropy: 0.1 }),
      ...Array(5).fill({ entropy: 0.9 }), // delta = 0.8 > 0.3 threshold
    ];
    const result = detectPhaseTransition(history);
    assertEquals(result.confidence <= 1.0, true);
  });
});

Deno.test("generateRecommendations - Metric recommendations", async (t) => {
  await t.step("warns for high entropy (> 0.7)", () => {
    const metrics = {
      graphEntropy: 0.8,
      clusterStability: 0.9,
      capabilityDiversity: 0.5,
      learningVelocity: 1,
      speculationAccuracy: 0.5,
      thresholdConvergence: 0.5,
      capabilityCount: 10,
      parallelizationRate: 0.3,
    };
    const recs = generateRecommendations(metrics);
    assertEquals(recs.some((r) => r.metric === "graphEntropy" && r.type === "warning"), true);
  });

  await t.step("warns for low entropy (< 0.3)", () => {
    const metrics = {
      graphEntropy: 0.2,
      clusterStability: 0.9,
      capabilityDiversity: 0.5,
      learningVelocity: 1,
      speculationAccuracy: 0.5,
      thresholdConvergence: 0.5,
      capabilityCount: 10,
      parallelizationRate: 0.3,
    };
    const recs = generateRecommendations(metrics);
    assertEquals(recs.some((r) => r.metric === "graphEntropy" && r.type === "warning"), true);
  });

  await t.step("warns for low cluster stability (< 0.8)", () => {
    const metrics = {
      graphEntropy: 0.5,
      clusterStability: 0.6,
      capabilityDiversity: 0.5,
      learningVelocity: 1,
      speculationAccuracy: 0.5,
      thresholdConvergence: 0.5,
      capabilityCount: 10,
      parallelizationRate: 0.3,
    };
    const recs = generateRecommendations(metrics);
    assertEquals(recs.some((r) => r.metric === "clusterStability" && r.type === "warning"), true);
  });

  await t.step("success for high speculation accuracy (> 0.8)", () => {
    const metrics = {
      graphEntropy: 0.5,
      clusterStability: 0.9,
      capabilityDiversity: 0.5,
      learningVelocity: 1,
      speculationAccuracy: 0.9,
      thresholdConvergence: 0.5,
      capabilityCount: 10,
      parallelizationRate: 0.3,
    };
    const recs = generateRecommendations(metrics);
    assertEquals(recs.some((r) => r.metric === "speculationAccuracy" && r.type === "success"), true);
  });

  await t.step("success for high diversity (> 0.7)", () => {
    const metrics = {
      graphEntropy: 0.5,
      clusterStability: 0.9,
      capabilityDiversity: 0.8,
      learningVelocity: 1,
      speculationAccuracy: 0.5,
      thresholdConvergence: 0.5,
      capabilityCount: 10,
      parallelizationRate: 0.3,
    };
    const recs = generateRecommendations(metrics);
    assertEquals(recs.some((r) => r.metric === "capabilityDiversity" && r.type === "success"), true);
  });

  await t.step("returns empty array for healthy metrics", () => {
    const metrics = {
      graphEntropy: 0.5, // in healthy range
      clusterStability: 0.9, // above 0.8
      capabilityDiversity: 0.6, // between 0.3 and 0.7
      learningVelocity: 1,
      speculationAccuracy: 0.7, // between 0.5 and 0.8
      thresholdConvergence: 0.5,
      capabilityCount: 10,
      parallelizationRate: 0.3,
    };
    const recs = generateRecommendations(metrics);
    // Should only have no warnings (might have success)
    assertEquals(recs.filter((r) => r.type === "warning").length, 0);
  });
});
