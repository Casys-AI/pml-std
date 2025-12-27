/**
 * Capability Matcher (Story 7.3a)
 *
 * Helper class for DAGSuggester to find capabilities matching a user intent.
 * Implements the "Active Search" algorithm from ADR-038.
 *
 * Algorithm:
 * Score = SemanticSimilarity * ReliabilityFactor
 *
 * Reliability Factor:
 * - success_rate < 0.5 => 0.1 (Penalty)
 * - success_rate > 0.9 => 1.2 (Boost)
 * - otherwise => 1.0
 *
 * ADR-042 §3: Transitive reliability propagation.
 * If Capability A depends on B, A's reliability = min(A.successRate, B.successRate)
 * Chain is as strong as its weakest link.
 *
 * @module capabilities/matcher
 */

import type { CapabilityStore } from "./capability-store.ts";
import type { AdaptiveThresholdManager } from "../mcp/adaptive-threshold.ts";
import type { Capability, CapabilityMatch } from "./types.ts";
import { getLogger } from "../telemetry/logger.ts";
// Story 6.5: EventBus integration (ADR-036)
import { eventBus } from "../events/mod.ts";
// Story 7.6: Algorithm tracing (ADR-039)
import type { AlgorithmTracer, DecisionType } from "../telemetry/algorithm-tracer.ts";
import type { DagScoringConfig } from "../graphrag/dag-scoring-config.ts";

const logger = getLogger("default");

export class CapabilityMatcher {
  private algorithmTracer: AlgorithmTracer | null = null;
  /** Cache for transitive reliability to avoid repeated DB queries */
  private transitiveReliabilityCache: Map<string, number> = new Map();
  /** Cache TTL in milliseconds (1 minute) */
  private static readonly CACHE_TTL_MS = 60_000;
  private cacheTimestamp = 0;
  private scoringConfig: DagScoringConfig | null = null;

  constructor(
    private capabilityStore: CapabilityStore,
    private adaptiveThresholds: AdaptiveThresholdManager,
    algorithmTracer?: AlgorithmTracer,
  ) {
    this.algorithmTracer = algorithmTracer || null;
  }

  /**
   * Set scoring config for intent search threshold
   *
   * @param config - DagScoringConfig instance
   */
  setScoringConfig(config: DagScoringConfig): void {
    this.scoringConfig = config;
    logger.debug("Scoring config set for CapabilityMatcher", {
      intentSearchThreshold: config.thresholds.intentSearch,
    });
  }

  /**
   * Set algorithm tracer for observability (Story 7.6 - ADR-039)
   *
   * @param tracer - AlgorithmTracer instance
   */
  setAlgorithmTracer(tracer: AlgorithmTracer): void {
    this.algorithmTracer = tracer;
    logger.debug("Algorithm tracer configured for CapabilityMatcher");
  }

  /**
   * Compute transitive reliability for a capability (ADR-042 §3)
   *
   * If Capability A depends on B, the reliability of A depends on B:
   * transitiveReliability = min(A.successRate, B.successRate, ...)
   *
   * Chain is as strong as its weakest link.
   *
   * @param capability - The capability to compute reliability for
   * @returns Transitive reliability factor (0.0 - 1.0)
   */
  private async computeTransitiveReliability(capability: Capability): Promise<number> {
    // Check cache validity
    const now = Date.now();
    if (now - this.cacheTimestamp > CapabilityMatcher.CACHE_TTL_MS) {
      this.transitiveReliabilityCache.clear();
      this.cacheTimestamp = now;
    }

    // Check cache
    const cached = this.transitiveReliabilityCache.get(capability.id);
    if (cached !== undefined) {
      return cached;
    }

    try {
      // Get outgoing dependencies (what this capability depends on)
      const deps = await this.capabilityStore.getDependencies(capability.id, "from");

      // Filter only 'dependency' type edges (not 'contains', 'alternative', 'sequence')
      const dependencyEdges = deps.filter((d) => d.edgeType === "dependency");

      if (dependencyEdges.length === 0) {
        // No dependencies: transitive reliability is 1.0 (no reduction)
        this.transitiveReliabilityCache.set(capability.id, 1.0);
        return 1.0;
      }

      // Minimum reliability across all dependencies (weakest link)
      let minReliability = 1.0;

      for (const dep of dependencyEdges) {
        const depCap = await this.capabilityStore.findById(dep.toCapabilityId);
        if (depCap) {
          minReliability = Math.min(minReliability, depCap.successRate);
        }
      }

      // Cache and return
      this.transitiveReliabilityCache.set(capability.id, minReliability);

      logger.debug("Computed transitive reliability (ADR-042)", {
        capabilityId: capability.id,
        baseSuccessRate: capability.successRate,
        transitiveReliability: minReliability,
        dependencyCount: dependencyEdges.length,
      });

      return minReliability;
    } catch (error) {
      logger.warn("Failed to compute transitive reliability, using 1.0", {
        capabilityId: capability.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return 1.0; // Graceful degradation
    }
  }

  /**
   * Find the best capability matching the intent
   *
   * ADR-042 §3: Now uses transitive reliability when computing final score.
   *
   * @param intent - User intent (natural language)
   * @param correlationId - Optional ID to group traces from same operation
   * @returns Best match or null if no match above threshold
   */
  async findMatch(intent: string, correlationId?: string): Promise<CapabilityMatch | null> {
    // 1. Get adaptive threshold for "capability_matching" context
    // Note: Story 7.3a specifies using suggestionThreshold
    const thresholds = this.adaptiveThresholds.getThresholds();
    const threshold = thresholds.suggestionThreshold || 0.70;

    // 2. Semantic Search (Vector Similarity)
    // We fetch top 5 candidates to filter them
    // Use config threshold or fallback to 0.65
    const minSemanticScore = this.scoringConfig?.thresholds.intentSearch ?? 0.65;
    const candidates = await this.capabilityStore.searchByIntent(intent, 5, minSemanticScore);

    if (candidates.length === 0) {
      return null;
    }

    let bestMatch: CapabilityMatch | null = null;

    // Get reliability thresholds from config (ADR-038 §3.1)
    const reliability = this.scoringConfig?.reliability ?? {
      penaltyThreshold: 0.50,
      penaltyFactor: 0.10,
      boostThreshold: 0.90,
      boostFactor: 1.20,
      filterThreshold: 0.20,
    };

    for (const candidate of candidates) {
      // 3. Calculate Reliability Factor (ADR-038)
      let baseReliabilityFactor = 1.0;
      if (candidate.capability.successRate < reliability.penaltyThreshold) {
        baseReliabilityFactor = reliability.penaltyFactor; // Penalize unreliable
      } else if (candidate.capability.successRate > reliability.boostThreshold) {
        baseReliabilityFactor = reliability.boostFactor; // Boost highly reliable
      }

      // ADR-042 §3: Apply transitive reliability
      // Chain is as strong as its weakest link
      const transitiveReliability = await this.computeTransitiveReliability(candidate.capability);
      const reliabilityFactor = baseReliabilityFactor * transitiveReliability;

      // 4. Calculate Final Score (semanticScore harmonized with HybridSearchResult)
      let score = candidate.semanticScore * reliabilityFactor;

      // Cap at 0.95 (ADR-038 Global Cap)
      score = Math.min(score, 0.95);

      // 5. Determine decision for tracing
      let decision: DecisionType;
      if (reliabilityFactor < reliability.filterThreshold && score < threshold) {
        decision = "filtered_by_reliability";
      } else if (score >= threshold) {
        decision = "accepted";
      } else {
        decision = "rejected_by_threshold";
      }

      logger.debug("Capability candidate scored", {
        id: candidate.capability.id,
        semanticScore: candidate.semanticScore.toFixed(2),
        baseReliability: baseReliabilityFactor,
        transitiveReliability: transitiveReliability.toFixed(2),
        finalReliability: reliabilityFactor.toFixed(2),
        final: score.toFixed(2),
        threshold,
        decision,
      });

      // Story 7.6: Log trace for each candidate (fire-and-forget)
      this.algorithmTracer?.logTrace({
        correlationId,
        algorithmName: "CapabilityMatcher",
        algorithmMode: "active_search",
        targetType: "capability",
        intent: intent.substring(0, 200),
        signals: {
          semanticScore: candidate.semanticScore,
          successRate: candidate.capability.successRate,
          graphDensity: 0, // Not used in active search
          spectralClusterMatch: false, // Not used in active search
        },
        params: {
          alpha: 1.0, // Pure semantic for active search
          reliabilityFactor,
          structuralBoost: transitiveReliability, // Repurposed to show transitive
        },
        finalScore: score,
        thresholdUsed: threshold,
        decision,
      });

      // Story 7.6: Emit algorithm.scored event for real-time tracing UI
      eventBus.emit({
        type: "algorithm.scored",
        source: "capability-matcher",
        payload: {
          itemId: candidate.capability.id,
          itemName: candidate.capability.name ?? candidate.capability.id.slice(0, 8),
          itemType: "capability",
          intent: intent.substring(0, 100),
          signals: {
            semanticScore: candidate.semanticScore,
            successRate: candidate.capability.successRate,
          },
          finalScore: score,
          threshold,
          decision: decision === "accepted" ? "accepted" : "filtered",
        },
      });

      // 6. Check against Threshold
      if (score >= threshold) {
        // Keep the best one
        if (!bestMatch || score > bestMatch.score) {
          bestMatch = {
            capability: candidate.capability,
            score,
            semanticScore: candidate.semanticScore,
            thresholdUsed: threshold,
            parametersSchema: candidate.capability.parametersSchema || null,
          };
        }
      }
    }

    if (bestMatch) {
      logger.info("Capability match found", {
        id: bestMatch.capability.id,
        score: bestMatch.score.toFixed(2),
        intent,
      });

      // Story 6.5: Emit capability.matched event (ADR-036)
      // Convention: camelCase for event payload fields (per implementation-patterns.md)
      eventBus.emit({
        type: "capability.matched",
        source: "capability-matcher",
        payload: {
          capabilityId: bestMatch.capability.id,
          name: bestMatch.capability.name ?? "unknown",
          intent: intent.substring(0, 100),
          score: bestMatch.score,
          semanticScore: bestMatch.semanticScore,
          thresholdUsed: bestMatch.thresholdUsed,
          selected: true,
        },
      });
    } else {
      logger.debug("No capability match above threshold", { intent, threshold });
    }

    return bestMatch;
  }

  /**
   * Invalidate the transitive reliability cache
   *
   * Call this when capability dependencies change to force recomputation.
   */
  invalidateCache(): void {
    this.transitiveReliabilityCache.clear();
    this.cacheTimestamp = 0;
    logger.debug("Transitive reliability cache invalidated");
  }
}
