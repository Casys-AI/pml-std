/**
 * Confidence Calculation Tests
 *
 * Comprehensive unit tests for the confidence calculation module.
 * Tests path confidence, adaptive weights, and hybrid confidence calculations.
 *
 * @module tests/unit/graphrag/suggestion/confidence.test
 */

import { assertAlmostEquals, assertEquals, assertExists } from "jsr:@std/assert@1";
import {
  calculateCommunityConfidence,
  calculateConfidenceHybrid,
  calculateCooccurrenceConfidence,
  calculatePathConfidence,
  getAdaptiveWeightsFromAlpha,
} from "../../../../src/graphrag/suggestion/confidence.ts";
import type { ScoredCandidate } from "../../../../src/graphrag/suggestion/confidence.ts";
import type { DependencyPath } from "../../../../src/graphrag/types.ts";
import { DEFAULT_DAG_SCORING_CONFIG } from "../../../../src/graphrag/dag-scoring-config.ts";

// Test configuration
const config = DEFAULT_DAG_SCORING_CONFIG;

Deno.test("calculatePathConfidence - Happy Path", async (t) => {
  await t.step("returns hop1 confidence for 1-hop paths", () => {
    const confidence = calculatePathConfidence(1, config);
    assertEquals(confidence, config.hopConfidence.hop1);
    assertEquals(confidence, 0.95);
  });

  await t.step("returns hop2 confidence for 2-hop paths", () => {
    const confidence = calculatePathConfidence(2, config);
    assertEquals(confidence, config.hopConfidence.hop2);
    assertEquals(confidence, 0.80);
  });

  await t.step("returns hop3 confidence for 3-hop paths", () => {
    const confidence = calculatePathConfidence(3, config);
    assertEquals(confidence, config.hopConfidence.hop3);
    assertEquals(confidence, 0.65);
  });

  await t.step("returns hop4Plus confidence for 4+ hop paths", () => {
    assertEquals(calculatePathConfidence(4, config), config.hopConfidence.hop4Plus);
    assertEquals(calculatePathConfidence(5, config), config.hopConfidence.hop4Plus);
    assertEquals(calculatePathConfidence(10, config), config.hopConfidence.hop4Plus);
  });
});

Deno.test("calculatePathConfidence - Edge Cases", async (t) => {
  await t.step("handles 0-hop paths (same node)", () => {
    const confidence = calculatePathConfidence(0, config);
    assertEquals(confidence, config.hopConfidence.hop4Plus);
  });

  await t.step("handles negative hop counts", () => {
    const confidence = calculatePathConfidence(-1, config);
    assertEquals(confidence, config.hopConfidence.hop4Plus);
  });

  await t.step("handles very large hop counts", () => {
    const confidence = calculatePathConfidence(1000, config);
    assertEquals(confidence, config.hopConfidence.hop4Plus);
  });
});

Deno.test("getAdaptiveWeightsFromAlpha - Happy Path", async (t) => {
  await t.step("returns base weights for alpha=0.5 (high graph trust)", () => {
    const weights = getAdaptiveWeightsFromAlpha(0.5, config);

    assertAlmostEquals(weights.hybrid, config.weights.confidenceBase.hybrid, 0.01);
    assertAlmostEquals(weights.pageRank, config.weights.confidenceBase.pagerank, 0.01);
    assertAlmostEquals(weights.path, config.weights.confidenceBase.path, 0.01);

    // Expected: hybrid=0.55, pageRank=0.30, path=0.15
    assertAlmostEquals(weights.hybrid, 0.55, 0.01);
    assertAlmostEquals(weights.pageRank, 0.30, 0.01);
    assertAlmostEquals(weights.path, 0.15, 0.01);
  });

  await t.step("returns maximum weights for alpha=1.0 (low graph trust)", () => {
    const weights = getAdaptiveWeightsFromAlpha(1.0, config);

    const expectedHybrid = config.weights.confidenceBase.hybrid +
      config.weights.confidenceScaling.hybridDelta;
    const expectedPageRank = config.weights.confidenceBase.pagerank -
      config.weights.confidenceScaling.pagerankDelta;
    const expectedPath = config.weights.confidenceBase.path -
      config.weights.confidenceScaling.pathDelta;

    assertAlmostEquals(weights.hybrid, expectedHybrid, 0.01);
    assertAlmostEquals(weights.pageRank, expectedPageRank, 0.01);
    assertAlmostEquals(weights.path, expectedPath, 0.01);

    // Expected: hybrid=0.85, pageRank=0.05, path=0.10
    assertAlmostEquals(weights.hybrid, 0.85, 0.01);
    assertAlmostEquals(weights.pageRank, 0.05, 0.01);
    assertAlmostEquals(weights.path, 0.10, 0.01);
  });

  await t.step("returns mid-range weights for alpha=0.75 (default)", () => {
    const weights = getAdaptiveWeightsFromAlpha(0.75, config);

    // alpha=0.75 → factor=0.5 → midpoint between base and base+delta
    const expectedHybrid = config.weights.confidenceBase.hybrid +
      0.5 * config.weights.confidenceScaling.hybridDelta;
    const expectedPageRank = config.weights.confidenceBase.pagerank -
      0.5 * config.weights.confidenceScaling.pagerankDelta;
    const expectedPath = config.weights.confidenceBase.path -
      0.5 * config.weights.confidenceScaling.pathDelta;

    assertAlmostEquals(weights.hybrid, expectedHybrid, 0.01);
    assertAlmostEquals(weights.pageRank, expectedPageRank, 0.01);
    assertAlmostEquals(weights.path, expectedPath, 0.01);

    // Expected: hybrid=0.70, pageRank=0.175, path=0.125
    assertAlmostEquals(weights.hybrid, 0.70, 0.01);
    assertAlmostEquals(weights.pageRank, 0.175, 0.01);
    assertAlmostEquals(weights.path, 0.125, 0.01);
  });

  await t.step("interpolates linearly between min and max alpha", () => {
    const weights60 = getAdaptiveWeightsFromAlpha(0.6, config);
    const weights70 = getAdaptiveWeightsFromAlpha(0.7, config);
    const weights80 = getAdaptiveWeightsFromAlpha(0.8, config);

    // Hybrid should increase with alpha
    assert(weights60.hybrid < weights70.hybrid);
    assert(weights70.hybrid < weights80.hybrid);

    // PageRank should decrease with alpha
    assert(weights60.pageRank > weights70.pageRank);
    assert(weights70.pageRank > weights80.pageRank);

    // Path should decrease with alpha
    assert(weights60.path > weights70.path);
    assert(weights70.path > weights80.path);
  });
});

Deno.test("getAdaptiveWeightsFromAlpha - Edge Cases", async (t) => {
  await t.step("clamps alpha below 0.5 to 0.5", () => {
    const weights0 = getAdaptiveWeightsFromAlpha(0.0, config);
    const weights05 = getAdaptiveWeightsFromAlpha(0.5, config);

    assertEquals(weights0.hybrid, weights05.hybrid);
    assertEquals(weights0.pageRank, weights05.pageRank);
    assertEquals(weights0.path, weights05.path);
  });

  await t.step("clamps alpha above 1.0 to 1.0", () => {
    const weights10 = getAdaptiveWeightsFromAlpha(1.0, config);
    const weights20 = getAdaptiveWeightsFromAlpha(2.0, config);

    assertEquals(weights20.hybrid, weights10.hybrid);
    assertEquals(weights20.pageRank, weights10.pageRank);
    assertEquals(weights20.path, weights10.path);
  });

  await t.step("handles negative alpha values", () => {
    const weights = getAdaptiveWeightsFromAlpha(-0.5, config);

    // Should clamp to 0.5
    assertAlmostEquals(weights.hybrid, 0.55, 0.01);
    assertAlmostEquals(weights.pageRank, 0.30, 0.01);
    assertAlmostEquals(weights.path, 0.15, 0.01);
  });

  await t.step("handles NaN alpha", () => {
    const weights = getAdaptiveWeightsFromAlpha(NaN, config);

    // NaN comparisons should result in clamping to 0.5
    assertExists(weights.hybrid);
    assertExists(weights.pageRank);
    assertExists(weights.path);
  });
});

Deno.test("calculateConfidenceHybrid - Happy Path", async (t) => {
  await t.step("calculates confidence for single candidate with paths", () => {
    const candidates: ScoredCandidate[] = [{
      score: 0.85,
      semanticScore: 0.80,
      graphScore: 0.05,
      pageRank: 0.10,
      combinedScore: 0.87,
    }];

    const paths: DependencyPath[] = [
      {
        from: "tool1",
        to: "tool2",
        path: ["tool1", "tool2"],
        hops: 1,
        explanation: "Direct dependency",
        confidence: 0.95,
      },
    ];

    const result = calculateConfidenceHybrid(candidates, paths, config, 0.75);

    assertExists(result);
    assertEquals(result.semanticScore, 0.80);
    assertEquals(result.pageRankScore, 0.10);
    assertEquals(result.pathStrength, 0.95);

    // Confidence should be weighted combination
    assert(result.confidence > 0);
    assert(result.confidence <= 1.0);
  });

  await t.step("calculates confidence for multiple candidates", () => {
    const candidates: ScoredCandidate[] = [
      {
        score: 0.85,
        semanticScore: 0.80,
        graphScore: 0.05,
        pageRank: 0.15,
        combinedScore: 0.87,
      },
      {
        score: 0.70,
        semanticScore: 0.65,
        graphScore: 0.05,
        pageRank: 0.12,
        combinedScore: 0.71,
      },
      {
        score: 0.60,
        semanticScore: 0.55,
        graphScore: 0.05,
        pageRank: 0.08,
        combinedScore: 0.61,
      },
    ];

    const paths: DependencyPath[] = [];

    const result = calculateConfidenceHybrid(candidates, paths, config, 0.75);

    // Should use top candidate for hybrid and semantic
    assertEquals(result.semanticScore, 0.80);

    // Should average top 3 for pageRank
    const expectedPageRank = (0.15 + 0.12 + 0.08) / 3;
    assertAlmostEquals(result.pageRankScore, expectedPageRank, 0.001);
  });

  await t.step("uses default path confidence when no paths provided", () => {
    const candidates: ScoredCandidate[] = [{
      score: 0.85,
      semanticScore: 0.80,
      graphScore: 0.05,
      pageRank: 0.10,
      combinedScore: 0.87,
    }];

    const result = calculateConfidenceHybrid(candidates, [], config);

    assertEquals(result.pathStrength, config.defaults.pathConfidence);
    assertEquals(result.pathStrength, 0.50);
  });

  await t.step("averages path confidence when multiple paths exist", () => {
    const candidates: ScoredCandidate[] = [{
      score: 0.85,
      semanticScore: 0.80,
      graphScore: 0.05,
      pageRank: 0.10,
      combinedScore: 0.87,
    }];

    const paths: DependencyPath[] = [
      {
        from: "tool1",
        to: "tool2",
        path: ["tool1", "tool2"],
        hops: 1,
        explanation: "Direct",
        confidence: 0.95,
      },
      {
        from: "tool1",
        to: "tool3",
        path: ["tool1", "mid", "tool3"],
        hops: 2,
        explanation: "Indirect",
        confidence: 0.80,
      },
      {
        from: "tool2",
        to: "tool3",
        path: ["tool2", "tool3"],
        hops: 1,
        explanation: "Direct",
        confidence: 0.95,
      },
    ];

    const result = calculateConfidenceHybrid(candidates, paths, config);

    const expectedPathStrength = (0.95 + 0.80 + 0.95) / 3;
    assertAlmostEquals(result.pathStrength, expectedPathStrength, 0.001);
  });
});

Deno.test("calculateConfidenceHybrid - Edge Cases", async (t) => {
  await t.step("returns zero confidence for empty candidates", () => {
    const result = calculateConfidenceHybrid([], [], config);

    assertEquals(result.confidence, 0);
    assertEquals(result.semanticScore, 0);
    assertEquals(result.pageRankScore, 0);
    assertEquals(result.pathStrength, 0);
  });

  await t.step("handles candidates with missing optional fields", () => {
    const candidates: ScoredCandidate[] = [{
      score: 0.85,
      semanticScore: 0.80,
      graphScore: 0.05,
      pageRank: 0.10,
      combinedScore: 0.87,
    }];

    const paths: DependencyPath[] = [{
      from: "tool1",
      to: "tool2",
      path: ["tool1", "tool2"],
      hops: 1,
      explanation: "Direct",
      // No confidence field
    }];

    const result = calculateConfidenceHybrid(candidates, paths, config);

    assertExists(result);
    // Should use default path confidence
    assertEquals(result.pathStrength, config.defaults.pathConfidence);
  });

  await t.step("handles fewer candidates than alternatives limit", () => {
    const candidates: ScoredCandidate[] = [
      {
        score: 0.85,
        semanticScore: 0.80,
        graphScore: 0.05,
        pageRank: 0.15,
        combinedScore: 0.87,
      },
      {
        score: 0.70,
        semanticScore: 0.65,
        graphScore: 0.05,
        pageRank: 0.12,
        combinedScore: 0.71,
      },
    ];

    const result = calculateConfidenceHybrid(candidates, [], config);

    // Should average only 2 candidates (not throw error)
    const expectedPageRank = (0.15 + 0.12) / 2;
    assertAlmostEquals(result.pageRankScore, expectedPageRank, 0.001);
  });

  await t.step("uses default alpha when not provided", () => {
    const candidates: ScoredCandidate[] = [{
      score: 0.85,
      semanticScore: 0.80,
      graphScore: 0.05,
      pageRank: 0.10,
      combinedScore: 0.87,
    }];

    const result = calculateConfidenceHybrid(candidates, [], config);

    // Should use config.defaults.alpha (0.75)
    assertExists(result.confidence);
    assert(result.confidence > 0);
  });

  await t.step("handles paths without confidence values", () => {
    const candidates: ScoredCandidate[] = [{
      score: 0.85,
      semanticScore: 0.80,
      graphScore: 0.05,
      pageRank: 0.10,
      combinedScore: 0.87,
    }];

    const paths: DependencyPath[] = [
      {
        from: "tool1",
        to: "tool2",
        path: ["tool1", "tool2"],
        hops: 1,
        explanation: "Direct",
      },
      {
        from: "tool2",
        to: "tool3",
        path: ["tool2", "tool3"],
        hops: 1,
        explanation: "Direct",
      },
    ];

    const result = calculateConfidenceHybrid(candidates, paths, config);

    // Should use default path confidence for all paths
    assertEquals(result.pathStrength, config.defaults.pathConfidence);
  });
});

Deno.test("calculateCommunityConfidence - Happy Path", async (t) => {
  await t.step("calculates base confidence without boosts", () => {
    const confidence = calculateCommunityConfidence(0, null, 0, config);

    assertEquals(confidence, config.community.baseConfidence);
    assertEquals(confidence, 0.40);
  });

  await t.step("adds PageRank boost", () => {
    const pageRank = 0.05;
    const confidence = calculateCommunityConfidence(pageRank, null, 0, config);

    const expectedBoost = Math.min(pageRank * 2, config.community.pagerankBoostCap);
    const expected = config.community.baseConfidence + expectedBoost;

    assertAlmostEquals(confidence, expected, 0.001);
  });

  await t.step("adds edge weight boost", () => {
    const edgeWeight = 0.50;
    const confidence = calculateCommunityConfidence(0, edgeWeight, 0, config);

    const expectedBoost = Math.min(edgeWeight * 0.25, config.community.edgeWeightBoostCap);
    const expected = config.community.baseConfidence + expectedBoost;

    assertAlmostEquals(confidence, expected, 0.001);
  });

  await t.step("adds Adamic-Adar boost", () => {
    const adamicAdar = 5.0;
    const confidence = calculateCommunityConfidence(0, null, adamicAdar, config);

    const expectedBoost = Math.min(adamicAdar * 0.1, config.community.adamicAdarBoostCap);
    const expected = config.community.baseConfidence + expectedBoost;

    assertAlmostEquals(confidence, expected, 0.001);
  });

  await t.step("combines all boosts", () => {
    const pageRank = 0.10;
    const edgeWeight = 0.50;
    const adamicAdar = 1.0;

    const confidence = calculateCommunityConfidence(pageRank, edgeWeight, adamicAdar, config);

    const pagerankBoost = Math.min(pageRank * 2, config.community.pagerankBoostCap);
    const edgeBoost = Math.min(edgeWeight * 0.25, config.community.edgeWeightBoostCap);
    const aaBoost = Math.min(adamicAdar * 0.1, config.community.adamicAdarBoostCap);

    const expected = Math.min(
      config.community.baseConfidence + pagerankBoost + edgeBoost + aaBoost,
      config.caps.maxConfidence,
    );

    assertAlmostEquals(confidence, expected, 0.001);
  });

  await t.step("caps confidence at maxConfidence", () => {
    const highPageRank = 1.0;
    const highEdgeWeight = 1.0;
    const highAdamicAdar = 10.0;

    const confidence = calculateCommunityConfidence(
      highPageRank,
      highEdgeWeight,
      highAdamicAdar,
      config,
    );

    assertEquals(confidence, config.caps.maxConfidence);
    assertEquals(confidence, 0.95);
  });
});

Deno.test("calculateCommunityConfidence - Edge Cases", async (t) => {
  await t.step("handles null edge weight", () => {
    const confidence = calculateCommunityConfidence(0.05, null, 0, config);

    // Should only include pageRank boost, not edge weight
    const expectedBoost = Math.min(0.05 * 2, config.community.pagerankBoostCap);
    const expected = config.community.baseConfidence + expectedBoost;

    assertAlmostEquals(confidence, expected, 0.001);
  });

  await t.step("handles negative values", () => {
    const confidence = calculateCommunityConfidence(-0.1, -0.5, -1.0, config);

    // Negative values still contribute (negative * multiplier is negative)
    // But confidence should be at least 0
    assert(confidence >= 0);
  });

  await t.step("respects PageRank boost cap", () => {
    const veryHighPageRank = 10.0;
    const confidence = calculateCommunityConfidence(veryHighPageRank, null, 0, config);

    const expectedBoost = config.community.pagerankBoostCap;
    const expected = config.community.baseConfidence + expectedBoost;

    assertAlmostEquals(confidence, expected, 0.001);
  });

  await t.step("respects edge weight boost cap", () => {
    const veryHighEdgeWeight = 10.0;
    const confidence = calculateCommunityConfidence(0, veryHighEdgeWeight, 0, config);

    const expectedBoost = config.community.edgeWeightBoostCap;
    const expected = config.community.baseConfidence + expectedBoost;

    assertAlmostEquals(confidence, expected, 0.001);
  });

  await t.step("respects Adamic-Adar boost cap", () => {
    const veryHighAdamicAdar = 100.0;
    const confidence = calculateCommunityConfidence(0, null, veryHighAdamicAdar, config);

    const expectedBoost = config.community.adamicAdarBoostCap;
    const expected = config.community.baseConfidence + expectedBoost;

    assertAlmostEquals(confidence, expected, 0.001);
  });
});

Deno.test("calculateCooccurrenceConfidence - Happy Path", async (t) => {
  await t.step("calculates confidence with edge weight only", () => {
    const edgeWeight = 0.50;
    const edgeCount = 1;

    const confidence = calculateCooccurrenceConfidence(edgeWeight, edgeCount, 0, config);

    assert(confidence >= edgeWeight);
    assert(confidence <= config.caps.maxConfidence);
  });

  await t.step("adds count boost for multiple observations", () => {
    const edgeWeight = 0.50;
    const edgeCount = 10;

    const confidence = calculateCooccurrenceConfidence(edgeWeight, edgeCount, 0, config);

    const countBoost = Math.min(
      Math.log2(edgeCount + 1) * config.cooccurrence.countBoostFactor,
      config.cooccurrence.countBoostCap,
    );

    const expected = Math.min(edgeWeight + countBoost, config.caps.maxConfidence);
    assertAlmostEquals(confidence, expected, 0.001);
  });

  await t.step("adds recency boost", () => {
    const edgeWeight = 0.50;
    const edgeCount = 5;
    const recencyBoost = 0.10;

    const confidence = calculateCooccurrenceConfidence(edgeWeight, edgeCount, recencyBoost, config);

    assert(confidence > edgeWeight);
  });

  await t.step("combines edge weight, count boost, and recency boost", () => {
    const edgeWeight = 0.50;
    const edgeCount = 20;
    const recencyBoost = 0.10;

    const confidence = calculateCooccurrenceConfidence(edgeWeight, edgeCount, recencyBoost, config);

    const countBoost = Math.min(
      Math.log2(edgeCount + 1) * config.cooccurrence.countBoostFactor,
      config.cooccurrence.countBoostCap,
    );
    const cappedRecency = Math.min(recencyBoost, config.cooccurrence.recencyBoostCap);

    const expected = Math.min(
      edgeWeight + countBoost + cappedRecency,
      config.caps.maxConfidence,
    );

    assertAlmostEquals(confidence, expected, 0.001);
  });

  await t.step("caps confidence at maxConfidence", () => {
    const highEdgeWeight = 0.60; // Already at edgeWeightMax cap
    const highEdgeCount = 1000;
    const highRecency = 0.50; // Will be capped at recencyBoostCap (0.10)

    const confidence = calculateCooccurrenceConfidence(
      highEdgeWeight,
      highEdgeCount,
      highRecency,
      config,
    );

    // Edge weight (0.60) + count boost (0.20 cap) + recency (0.10 cap) = 0.90
    // Should be capped at maxConfidence
    assertAlmostEquals(confidence, 0.90, 0.01);
  });
});

Deno.test("calculateCooccurrenceConfidence - Edge Cases", async (t) => {
  await t.step("returns floor confidence for null edge weight", () => {
    const confidence = calculateCooccurrenceConfidence(null, 10, 0, config);

    assertEquals(confidence, config.caps.edgeConfidenceFloor);
    assertEquals(confidence, 0.30);
  });

  await t.step("handles zero edge count", () => {
    const edgeWeight = 0.50;
    const confidence = calculateCooccurrenceConfidence(edgeWeight, 0, 0, config);

    // log2(0 + 1) = 0, so no count boost
    assertAlmostEquals(confidence, edgeWeight, 0.001);
  });

  await t.step("handles very large edge count", () => {
    const edgeWeight = 0.50;
    const largeCount = 1000000;

    const confidence = calculateCooccurrenceConfidence(edgeWeight, largeCount, 0, config);

    // Count boost should be capped
    const maxCountBoost = config.cooccurrence.countBoostCap;
    const expected = Math.min(edgeWeight + maxCountBoost, config.caps.maxConfidence);

    assertAlmostEquals(confidence, expected, 0.001);
  });

  await t.step("caps edge weight at edgeWeightMax", () => {
    const veryHighEdgeWeight = 0.95;
    const edgeCount = 5;

    const confidence = calculateCooccurrenceConfidence(veryHighEdgeWeight, edgeCount, 0, config);

    // Edge weight should be capped at 0.60
    const cappedWeight = Math.min(veryHighEdgeWeight, config.caps.edgeWeightMax);
    assert(confidence >= cappedWeight);
  });

  await t.step("caps recency boost at recencyBoostCap", () => {
    const edgeWeight = 0.50;
    const edgeCount = 5;
    const veryHighRecency = 0.50;

    const confidence = calculateCooccurrenceConfidence(
      edgeWeight,
      edgeCount,
      veryHighRecency,
      config,
    );

    // Recency boost should be capped at 0.10
    assert(confidence <= config.caps.maxConfidence);
  });

  await t.step("handles negative recency boost", () => {
    const edgeWeight = 0.50;
    const edgeCount = 5;
    const negativeRecency = -0.10;

    const confidence = calculateCooccurrenceConfidence(
      edgeWeight,
      edgeCount,
      negativeRecency,
      config,
    );

    // Negative recency should be treated as 0 (min with cap)
    assert(confidence >= edgeWeight);
  });

  await t.step("handles default recency boost of 0", () => {
    const edgeWeight = 0.50;
    const edgeCount = 5;

    const confidence = calculateCooccurrenceConfidence(edgeWeight, edgeCount, 0, config);

    assertExists(confidence);
    assert(confidence >= edgeWeight);
  });
});

// Helper function for assertions (not in @std/assert)
function assert(condition: boolean, message?: string): asserts condition {
  if (!condition) {
    throw new Error(message || "Assertion failed");
  }
}
