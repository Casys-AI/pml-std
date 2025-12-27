/**
 * Alternative Suggestions Module
 *
 * Extracted from dag-suggester.ts for suggesting alternative capabilities
 * based on dependency edges.
 *
 * @module graphrag/prediction/alternatives
 */

import * as log from "@std/log";
import type { DagScoringConfig } from "../dag-scoring-config.ts";
import type { PredictedNode } from "../types.ts";
import type { Capability } from "../../capabilities/types.ts";
import type { CapabilityStore } from "../../capabilities/capability-store.ts";
import type { AlgorithmTracer } from "../../telemetry/algorithm-tracer.ts";
import type { GraphRAGEngine } from "../graph-engine.ts";
import type { EpisodeStatsMap } from "./types.ts";
import { adjustConfidenceFromEpisodes } from "./capabilities.ts";

/**
 * Dependencies for alternative suggestions
 */
export interface AlternativeSuggestionDeps {
  capabilityStore: CapabilityStore | null;
  graphEngine: GraphRAGEngine;
  algorithmTracer: AlgorithmTracer | null;
  config: DagScoringConfig;
}

/**
 * Suggest alternative capabilities for a matched capability (ADR-042 §4)
 *
 * Uses `alternative` edges from capability_dependency table to find
 * interchangeable capabilities that respond to the same intent.
 *
 * @param matchedCapability - The primary matched capability
 * @param matchedScore - Score of the primary match
 * @param seenTools - Tools already in predictions (for deduplication)
 * @param episodeStats - Episode statistics for adjustment
 * @param deps - Suggestion dependencies
 * @returns Array of PredictedNode with source="capability"
 */
export async function suggestAlternatives(
  matchedCapability: Capability,
  matchedScore: number,
  seenTools: Set<string>,
  episodeStats: EpisodeStatsMap,
  deps: AlternativeSuggestionDeps,
): Promise<PredictedNode[]> {
  if (!deps.capabilityStore) {
    return [];
  }

  const alternatives: PredictedNode[] = [];

  try {
    // Get both directions for 'alternative' edges (symmetric relationship)
    const allDeps = await deps.capabilityStore.getDependencies(matchedCapability.id, "both");
    const alternativeEdges = allDeps.filter((d) => d.edgeType === "alternative");

    if (alternativeEdges.length === 0) {
      return [];
    }

    for (const alt of alternativeEdges) {
      // Determine the alternative capability ID (could be either from or to)
      const altCapId = alt.fromCapabilityId === matchedCapability.id
        ? alt.toCapabilityId
        : alt.fromCapabilityId;

      const altCapToolId = `capability:${altCapId}`;

      // Skip if already suggested
      if (seenTools.has(altCapToolId)) continue;

      // Fetch the alternative capability
      const altCap = await deps.capabilityStore.findById(altCapId);
      if (!altCap) continue;

      // ADR-042: Only suggest alternatives with success rate above threshold
      if (altCap.successRate <= deps.config.thresholds.alternativeSuccessRate) {
        log.debug(
          `[alternatives] Skipping ${altCapId} due to low success rate: ${altCap.successRate}`,
        );
        continue;
      }

      // ADR-042: Score is reduced by multiplier (slight reduction for alternatives)
      const baseConfidence = matchedScore * deps.config.alternatives.scoreMultiplier;

      // Apply episodic learning adjustments
      const adjusted = adjustConfidenceFromEpisodes(
        baseConfidence,
        altCapToolId,
        episodeStats,
        deps.config,
      );

      if (!adjusted) continue; // Excluded due to high failure rate

      alternatives.push({
        toolId: altCapToolId,
        confidence: adjusted.confidence,
        reasoning: `Alternative to ${
          matchedCapability.name ?? matchedCapability.id.substring(0, 8)
        } (${(altCap.successRate * 100).toFixed(0)}% success rate)`,
        source: "capability",
        capabilityId: altCapId,
      });

      // Log trace for alternative suggestion (fire-and-forget)
      deps.algorithmTracer?.logTrace({
        algorithmMode: "passive_suggestion",
        targetType: "capability",
        signals: {
          successRate: altCap.successRate,
          graphDensity: deps.graphEngine.getGraphDensity(),
          spectralClusterMatch: false,
        },
        params: {
          alpha: deps.config.alternatives.penaltyFactor,
          reliabilityFactor: 1.0,
          structuralBoost: 0,
        },
        finalScore: adjusted.confidence,
        thresholdUsed: deps.config.thresholds.alternativeSuccessRate,
        decision: "accepted",
      });

      seenTools.add(altCapToolId);
    }

    if (alternatives.length > 0) {
      log.debug(
        `[alternatives] Found ${alternatives.length} alternative capabilities for ${matchedCapability.id}`,
      );
    }
  } catch (error) {
    log.error(`[alternatives] Failed: ${error}`);
  }

  return alternatives;
}
