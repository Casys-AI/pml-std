/**
 * Execute Suggestion Use Case
 *
 * Generates workflow suggestions using SHGAT for scoring and DR-DSP for pathfinding.
 * Returns suggested DAGs with call names and input schemas for agent execution.
 *
 * Phase 3.1: Execute Handler → Use Cases refactoring
 *
 * @module application/use-cases/execute/execute-suggestion
 */

import * as log from "@std/log";
import type { IDAGSuggester, CapabilityMatch, SuggestionResult } from "../../../domain/interfaces/dag-suggester.ts";
import type { ICapabilityRepository } from "../../../domain/interfaces/capability-repository.ts";
import type { UseCaseResult } from "../shared/types.ts";
import type { ExecuteSuggestionRequest, ExecuteSuggestionResult } from "./types.ts";

// ============================================================================
// Interfaces (Clean Architecture - no concrete imports)
// ============================================================================

/**
 * SHGAT scorer interface
 */
export interface ISHGATScorer {
  scoreAllCapabilities(intentEmbedding: number[]): CapabilityMatch[];
  hasToolNode(toolId: string): boolean;
  registerTool(tool: { id: string; embedding: number[] }): void;
  registerCapability(cap: {
    id: string;
    embedding: number[];
    members: Array<{ type: "tool" | "capability"; id: string }>;
    hierarchyLevel?: number;
    successRate?: number;
    children?: string[];
    parents?: string[];
  }): void;
}

/**
 * DR-DSP pathfinder interface
 */
export interface IDRDSPPathfinder {
  findShortestHyperpath(source: string, target: string): {
    found: boolean;
    path: string[];
    nodeSequence: string[];
    hyperedges: Array<{ id: string }>;
    totalWeight: number;
  };
}

/**
 * Embedding model interface
 */
export interface IEmbeddingModel {
  encode(text: string): Promise<number[]>;
}

/**
 * Algorithm tracer interface for observability
 */
export interface IAlgorithmTracer {
  logTrace(trace: {
    correlationId: string;
    algorithmName: string;
    algorithmMode: string;
    targetType: string;
    intent: string;
    signals: Record<string, unknown>;
    params: Record<string, unknown>;
    finalScore: number;
    thresholdUsed: number;
    decision: string;
  }): void;
}

/**
 * Adaptive threshold manager interface
 */
export interface IAdaptiveThresholdManager {
  getThresholds(): {
    suggestionThreshold?: number;
    explicitThreshold?: number;
  };
}

/**
 * Dependencies for ExecuteSuggestionUseCase
 */
export interface ExecuteSuggestionDependencies {
  shgat?: ISHGATScorer;
  drdsp?: IDRDSPPathfinder;
  dagSuggester?: IDAGSuggester;
  capabilityRepo: ICapabilityRepository;
  embeddingModel?: IEmbeddingModel;
  algorithmTracer?: IAlgorithmTracer;
  thresholdManager?: IAdaptiveThresholdManager;
  /** Speculation score threshold (default: 0.7) */
  speculationScoreThreshold?: number;
  /** Speculation success rate threshold (default: 0.8) */
  speculationSuccessRateThreshold?: number;
}

// ============================================================================
// Use Case Implementation
// ============================================================================

const DEFAULT_SPECULATION_SCORE_THRESHOLD = 0.7;
const DEFAULT_SPECULATION_SUCCESS_RATE_THRESHOLD = 0.8;

/**
 * Execute Suggestion Use Case
 *
 * Generates workflow suggestions using SHGAT + DR-DSP.
 */
export class ExecuteSuggestionUseCase {
  constructor(private readonly deps: ExecuteSuggestionDependencies) {}

  /**
   * Execute the use case
   */
  async execute(
    request: ExecuteSuggestionRequest,
  ): Promise<UseCaseResult<ExecuteSuggestionResult>> {
    const { intent } = request;
    const startTime = performance.now();
    const correlationId = crypto.randomUUID();

    log.info("[ExecuteSuggestionUseCase] Starting suggestion mode", {
      correlationId,
      intent: intent.substring(0, 50),
      hasSHGAT: !!this.deps.shgat,
      hasDRDSP: !!this.deps.drdsp,
    });

    // Check required dependencies
    if (!this.deps.shgat || !this.deps.embeddingModel) {
      log.warn("[ExecuteSuggestionUseCase] SHGAT or embeddingModel not available");
      return {
        success: true,
        data: {
          confidence: 0,
          executionTimeMs: performance.now() - startTime,
        },
      };
    }

    try {
      // Step 1: Generate intent embedding
      const intentEmbedding = await this.deps.embeddingModel.encode(intent);
      if (!intentEmbedding || intentEmbedding.length === 0) {
        return {
          success: false,
          error: {
            code: "EMBEDDING_FAILED",
            message: "Failed to generate intent embedding",
          },
        };
      }

      // Step 2: Score capabilities with SHGAT
      const shgatCapabilities = this.deps.shgat.scoreAllCapabilities(intentEmbedding);

      log.debug("[ExecuteSuggestionUseCase] SHGAT scored capabilities", {
        capabilitiesCount: shgatCapabilities.length,
        topCapabilities: shgatCapabilities.slice(0, 3).map((r) => ({
          id: r.capabilityId,
          score: r.score.toFixed(3),
        })),
      });

      // Log traces for observability
      await this.logSHGATTraces(shgatCapabilities, intent, correlationId);

      if (shgatCapabilities.length === 0) {
        return {
          success: true,
          data: {
            confidence: 0,
            executionTimeMs: performance.now() - startTime,
          },
        };
      }

      // Step 3: Get best match
      const bestMatch = shgatCapabilities[0];
      const capability = await this.deps.capabilityRepo.findById(bestMatch.capabilityId);

      if (!capability) {
        log.warn("[ExecuteSuggestionUseCase] Best capability not found", {
          id: bestMatch.capabilityId,
        });
        // Still return the suggestion using DR-DSP if available
        const suggestion = await this.buildSuggestion(intent, bestMatch, correlationId);
        return {
          success: true,
          data: {
            suggestedDag: suggestion.suggestedDag,
            confidence: bestMatch.score,
            bestCapability: { id: bestMatch.capabilityId, score: bestMatch.score },
            executionTimeMs: performance.now() - startTime,
          },
        };
      }

      // Step 4: Check speculation thresholds
      const thresholds = this.deps.thresholdManager?.getThresholds() ?? {};
      const scoreThreshold = thresholds.suggestionThreshold ??
        this.deps.speculationScoreThreshold ??
        DEFAULT_SPECULATION_SCORE_THRESHOLD;
      const successRateThreshold = this.deps.speculationSuccessRateThreshold ??
        DEFAULT_SPECULATION_SUCCESS_RATE_THRESHOLD;

      const canSpeculate = bestMatch.score >= scoreThreshold &&
        capability.successRate >= successRateThreshold;

      // Step 5: Validate with DR-DSP if speculation possible
      if (canSpeculate && this.deps.drdsp && capability.toolsUsed && capability.toolsUsed.length > 1) {
        const startTool = capability.toolsUsed[0];
        const endTool = capability.toolsUsed[capability.toolsUsed.length - 1];
        const pathResult = this.deps.drdsp.findShortestHyperpath(startTool, endTool);

        log.debug("[ExecuteSuggestionUseCase] DR-DSP path validation", {
          from: startTool,
          to: endTool,
          found: pathResult.found,
          weight: pathResult.found ? pathResult.totalWeight : null,
        });

        this.logDRDSPTrace(pathResult, intent, endTool, bestMatch.capabilityId, correlationId);
      }

      // Note: Epic-12 speculation disabled - return as suggestion
      log.info("[ExecuteSuggestionUseCase] Returning suggestions (speculation disabled)", {
        capabilityId: capability.id,
        score: bestMatch.score,
        successRate: capability.successRate,
        canSpeculate,
      });

      // Step 6: Build suggestion using DR-DSP
      const suggestion = await this.buildSuggestion(intent, bestMatch, correlationId);

      return {
        success: true,
        data: {
          suggestedDag: suggestion.suggestedDag,
          confidence: bestMatch.score,
          bestCapability: { id: bestMatch.capabilityId, score: bestMatch.score },
          executionTimeMs: performance.now() - startTime,
        },
      };
    } catch (error) {
      log.error(`[ExecuteSuggestionUseCase] Error: ${error}`);
      return {
        success: false,
        error: {
          code: "SUGGESTION_ERROR",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  private async buildSuggestion(
    intent: string,
    bestMatch: CapabilityMatch,
    correlationId: string,
  ): Promise<SuggestionResult> {
    // Delegate to DAG suggester if available
    if (this.deps.dagSuggester) {
      return await this.deps.dagSuggester.suggest(intent, correlationId);
    }

    // Fallback: return best match as single capability
    return {
      confidence: bestMatch.score,
      bestMatch,
    };
  }

  private async logSHGATTraces(
    capabilities: CapabilityMatch[],
    intent: string,
    correlationId: string,
  ): Promise<void> {
    if (!this.deps.algorithmTracer) return;

    const threshold = this.deps.thresholdManager?.getThresholds().explicitThreshold ?? 0.6;

    for (const cap of capabilities.slice(0, 10)) {
      const capInfo = await this.deps.capabilityRepo.findById(cap.capabilityId);
      const numHeads = cap.headScores?.length ?? 0;
      const avgHeadScore = numHeads > 0 ? cap.headScores!.reduce((a, b) => a + b, 0) / numHeads : 0;

      this.deps.algorithmTracer.logTrace({
        correlationId,
        algorithmName: "SHGAT",
        algorithmMode: "active_search",
        targetType: "capability",
        intent: intent.substring(0, 200),
        signals: {
          semanticScore: avgHeadScore,
          graphDensity: 0,
          spectralClusterMatch: false,
          numHeads,
          avgHeadScore,
          headScores: cap.headScores,
          headWeights: cap.headWeights,
          recursiveContribution: cap.recursiveContribution,
          featureContribSemantic: cap.featureContributions?.semantic,
          featureContribStructure: cap.featureContributions?.structure,
          featureContribTemporal: cap.featureContributions?.temporal,
          featureContribReliability: cap.featureContributions?.reliability,
          targetId: cap.capabilityId,
          targetName: capInfo?.name ?? cap.capabilityId.substring(0, 8),
          targetSuccessRate: capInfo?.successRate,
          targetUsageCount: capInfo?.usageCount,
        },
        params: {
          alpha: 0,
          reliabilityFactor: capInfo?.successRate ?? 1.0,
          structuralBoost: cap.recursiveContribution ?? 0,
        },
        finalScore: cap.score,
        thresholdUsed: threshold,
        decision: cap.score >= threshold ? "accepted" : "rejected_by_threshold",
      });
    }
  }

  private logDRDSPTrace(
    pathResult: { found: boolean; nodeSequence: string[]; totalWeight: number },
    intent: string,
    endTool: string,
    capabilityId: string,
    correlationId: string,
  ): void {
    if (!this.deps.algorithmTracer) return;

    this.deps.algorithmTracer.logTrace({
      correlationId,
      algorithmName: "DRDSP",
      algorithmMode: "active_search",
      targetType: "tool",
      intent: intent.substring(0, 200),
      signals: {
        graphDensity: 0,
        spectralClusterMatch: false,
        pathFound: pathResult.found,
        pathLength: pathResult.found ? pathResult.nodeSequence.length : 0,
        pathWeight: pathResult.found ? pathResult.totalWeight : 0,
        targetId: endTool,
        capabilityId,
      },
      params: {
        alpha: 0,
        reliabilityFactor: 1.0,
        structuralBoost: 0,
      },
      finalScore: pathResult.found ? (1.0 / (1 + pathResult.totalWeight)) : 0,
      thresholdUsed: 0,
      decision: pathResult.found ? "accepted" : "rejected_by_threshold",
    });
  }
}
