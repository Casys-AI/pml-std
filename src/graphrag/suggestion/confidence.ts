/**
 * Confidence Calculation Module
 *
 * Extracted from dag-suggester.ts for modular confidence scoring.
 * Handles path confidence, adaptive weights, and hybrid confidence calculations.
 *
 * @module graphrag/suggestion/confidence
 */

import * as log from "@std/log";
import type { DagScoringConfig } from "../dag-scoring-config.ts";
import type { DependencyPath } from "../types.ts";

/**
 * Confidence calculation result breakdown
 */
export interface ConfidenceBreakdown {
  confidence: number;
  semanticScore: number;
  pageRankScore: number;
  pathStrength: number;
}

/**
 * Adaptive weight configuration for confidence calculation
 */
export interface AdaptiveWeights {
  hybrid: number;
  pageRank: number;
  path: number;
}

/**
 * Candidate with scoring information for confidence calculation
 */
export interface ScoredCandidate {
  score: number;
  semanticScore: number;
  graphScore: number;
  pageRank: number;
  combinedScore: number;
}

/**
 * Calculate path confidence based on hop count
 *
 * Direct paths (1 hop) have highest confidence, decreasing with distance.
 *
 * @param hops - Number of hops in the path
 * @param config - Scoring configuration
 * @returns Confidence score between 0 and 1
 */
export function calculatePathConfidence(hops: number, config: DagScoringConfig): number {
  const { hop1, hop2, hop3, hop4Plus } = config.hopConfidence;
  if (hops === 1) return hop1;
  if (hops === 2) return hop2;
  if (hops === 3) return hop3;
  return hop4Plus;
}

/**
 * Get adaptive weights for confidence calculation based on local alpha (ADR-048)
 *
 * Replaces global density-based approach (ADR-026) with local adaptive alpha.
 * Alpha indicates trust in graph signals:
 * - alpha = 0.5 → high trust in graph → use more graph weight
 * - alpha = 1.0 → low trust in graph → rely on semantic
 *
 * Weight formula (linear interpolation based on alpha):
 * - hybrid: 0.55 + (alpha - 0.5) * 0.60 → [0.55, 0.85]
 * - pageRank: 0.30 - (alpha - 0.5) * 0.50 → [0.05, 0.30]
 * - path: 0.15 - (alpha - 0.5) * 0.10 → [0.10, 0.15]
 *
 * @param avgAlpha - Average local alpha across candidates (0.5-1.0)
 * @param config - Scoring configuration
 * @returns Weight configuration for confidence calculation
 */
export function getAdaptiveWeightsFromAlpha(
  avgAlpha: number,
  config: DagScoringConfig,
): AdaptiveWeights {
  // Clamp alpha to valid range
  const alpha = Math.max(0.5, Math.min(1.0, avgAlpha));
  const factor = (alpha - 0.5) * 2; // Normalize to 0-1 range

  const { confidenceBase, confidenceScaling } = config.weights;

  // Linear interpolation: high alpha → trust semantic, low alpha → trust graph
  const hybrid = confidenceBase.hybrid + factor * confidenceScaling.hybridDelta;
  const pageRank = confidenceBase.pagerank - factor * confidenceScaling.pagerankDelta;
  const path = confidenceBase.path - factor * confidenceScaling.pathDelta;

  log.debug(
    `[confidence] Adaptive weights from alpha=${alpha.toFixed(2)}: hybrid=${
      hybrid.toFixed(2)
    }, pageRank=${pageRank.toFixed(2)}, path=${path.toFixed(2)}`,
  );

  return { hybrid, pageRank, path };
}

/**
 * Calculate confidence for hybrid search candidates (ADR-022, ADR-048)
 *
 * Uses the already-computed hybrid finalScore which includes both semantic and graph scores.
 * This provides a more accurate confidence since graph context is already factored in.
 *
 * ADR-048: Uses adaptive weights based on local alpha (replaces ADR-026 global density).
 *
 * @param candidates - Ranked candidates with hybrid scores
 * @param dependencyPaths - Extracted dependency paths
 * @param config - Scoring configuration
 * @param avgAlpha - Average local alpha across candidates (0.5-1.0)
 * @returns Confidence breakdown
 */
export function calculateConfidenceHybrid(
  candidates: ScoredCandidate[],
  dependencyPaths: DependencyPath[],
  config: DagScoringConfig,
  avgAlpha?: number,
): ConfidenceBreakdown {
  const effectiveAlpha = avgAlpha ?? config.defaults.alpha;

  if (candidates.length === 0) {
    return { confidence: 0, semanticScore: 0, pageRankScore: 0, pathStrength: 0 };
  }

  // Use the hybrid finalScore as base (already includes semantic + graph)
  const hybridScore = candidates[0].score;
  const semanticScore = candidates[0].semanticScore;

  // PageRank score (average of top 3)
  const top3Count = Math.min(config.limits.alternatives, candidates.length);
  const pageRankScore = candidates.slice(0, top3Count).reduce((sum, c) => sum + c.pageRank, 0) /
    top3Count;

  // Path strength (average confidence of all paths)
  const pathStrength = dependencyPaths.length > 0
    ? dependencyPaths.reduce(
      (sum, p) => sum + (p.confidence || config.defaults.pathConfidence),
      0,
    ) / dependencyPaths.length
    : config.defaults.pathConfidence;

  // ADR-048: Use adaptive weights based on local alpha
  const weights = getAdaptiveWeightsFromAlpha(effectiveAlpha, config);
  const confidence = hybridScore * weights.hybrid + pageRankScore * weights.pageRank +
    pathStrength * weights.path;

  return { confidence, semanticScore, pageRankScore, pathStrength };
}

/**
 * Calculate confidence for community-based prediction
 *
 * @param pageRank - PageRank score of target tool
 * @param edgeWeight - Optional edge weight (if direct edge exists)
 * @param adamicAdarScore - Optional Adamic-Adar similarity score
 * @param config - Scoring configuration
 * @returns Confidence score (0-1)
 */
export function calculateCommunityConfidence(
  pageRank: number,
  edgeWeight: number | null,
  adamicAdarScore: number,
  config: DagScoringConfig,
): number {
  const {
    baseConfidence,
    pagerankMultiplier,
    pagerankBoostCap,
    edgeWeightBoostCap,
    adamicAdarBoostCap,
  } = config.community;

  // Base confidence for community membership
  let confidence = baseConfidence;

  // Boost by PageRank (up to configured cap)
  confidence += Math.min(pageRank * pagerankMultiplier, pagerankBoostCap);

  // Boost if direct edge exists (historical pattern)
  if (edgeWeight !== null) {
    const edgeWeightMultiplier = config.community.edgeWeightMultiplier;
    confidence += Math.min(edgeWeight * edgeWeightMultiplier, edgeWeightBoostCap);
  }

  // Boost by Adamic-Adar similarity (indirect patterns)
  if (adamicAdarScore > 0) {
    const adamicAdarMultiplier = config.community.adamicAdarMultiplier;
    confidence += Math.min(adamicAdarScore * adamicAdarMultiplier, adamicAdarBoostCap);
  }

  return Math.min(confidence, config.caps.maxConfidence);
}

/**
 * Calculate confidence for co-occurrence-based prediction
 *
 * @param edgeWeight - Edge weight from graph
 * @param edgeCount - Observation count
 * @param recencyBoost - Boost if tool was used recently (default: 0)
 * @param config - Scoring configuration
 * @returns Confidence score (0-1)
 */
export function calculateCooccurrenceConfidence(
  edgeWeight: number | null,
  edgeCount: number,
  recencyBoost: number = 0,
  config: DagScoringConfig,
): number {
  const { countBoostFactor, countBoostCap, recencyBoostCap } = config.cooccurrence;

  if (edgeWeight === null) return config.caps.edgeConfidenceFloor;

  // Base: edge weight (confidence_score from DB) - Max configured (ADR-038)
  let confidence = Math.min(edgeWeight, config.caps.edgeWeightMax);

  // Boost by observation count (diminishing returns)
  const countBoost = Math.min(Math.log2(edgeCount + 1) * countBoostFactor, countBoostCap);
  confidence += countBoost;

  // Boost by recency
  confidence += Math.min(recencyBoost, recencyBoostCap);

  return Math.min(confidence, config.caps.maxConfidence);
}
