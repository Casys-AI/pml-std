/**
 * DAG Suggester Adapter
 *
 * Adapts existing SHGAT + DR-DSP infrastructure to the IDAGSuggester interface.
 *
 * Phase 3.1: Execute Handler → Use Cases refactoring
 *
 * @module infrastructure/di/adapters/execute/dag-suggester-adapter
 */

import * as log from "@std/log";
import type {
  IDAGSuggester,
  SuggestionResult,
  CapabilityMatch,
  DAGSuggestion,
} from "../../../../domain/interfaces/dag-suggester.ts";
import type { ICapabilityRepository } from "../../../../domain/interfaces/capability-repository.ts";

/**
 * SHGAT scorer interface (from existing infrastructure)
 */
export interface SHGATScorerInfra {
  scoreAllCapabilities(intentEmbedding: number[]): Array<{
    capabilityId: string;
    score: number;
    headScores?: number[];
    headWeights?: number[];
    recursiveContribution?: number;
    featureContributions?: {
      semantic?: number;
      structure?: number;
      temporal?: number;
      reliability?: number;
    };
  }>;
}

/**
 * DR-DSP pathfinder interface (from existing infrastructure)
 */
export interface DRDSPInfra {
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
export interface EmbeddingModelInfra {
  encode(text: string): Promise<number[]>;
}

/**
 * Dependencies for DAGSuggesterAdapter
 */
export interface DAGSuggesterAdapterDeps {
  shgat?: SHGATScorerInfra;
  drdsp?: DRDSPInfra;
  embeddingModel?: EmbeddingModelInfra;
  capabilityRepo: ICapabilityRepository;
}

/**
 * Adapts SHGAT + DR-DSP to IDAGSuggester interface
 */
export class DAGSuggesterAdapter implements IDAGSuggester {
  constructor(private readonly deps: DAGSuggesterAdapterDeps) {}

  /**
   * Generate DAG suggestion from natural language intent
   */
  async suggest(intent: string, correlationId?: string): Promise<SuggestionResult> {
    if (!this.deps.shgat || !this.deps.embeddingModel) {
      return { confidence: 0 };
    }

    try {
      // Generate intent embedding
      const intentEmbedding = await this.deps.embeddingModel.encode(intent);
      if (!intentEmbedding || intentEmbedding.length === 0) {
        return { confidence: 0 };
      }

      // Score capabilities with SHGAT
      const shgatResults = this.deps.shgat.scoreAllCapabilities(intentEmbedding);
      if (shgatResults.length === 0) {
        return { confidence: 0 };
      }

      // Get best match
      const bestResult = shgatResults[0];
      const bestMatch: CapabilityMatch = {
        capabilityId: bestResult.capabilityId,
        score: bestResult.score,
        headScores: bestResult.headScores,
        headWeights: bestResult.headWeights,
        recursiveContribution: bestResult.recursiveContribution,
        featureContributions: bestResult.featureContributions,
      };

      // Get capability details for DAG construction
      const capability = await this.deps.capabilityRepo.findById(bestMatch.capabilityId);
      if (!capability) {
        return { confidence: bestMatch.score, bestMatch };
      }

      // Build suggested DAG using DR-DSP if available
      let suggestedDag: DAGSuggestion | undefined;

      if (this.deps.drdsp && capability.toolsUsed && capability.toolsUsed.length > 1) {
        const startTool = capability.toolsUsed[0];
        const endTool = capability.toolsUsed[capability.toolsUsed.length - 1];
        const pathResult = this.deps.drdsp.findShortestHyperpath(startTool, endTool);

        if (pathResult.found && pathResult.nodeSequence.length > 0) {
          suggestedDag = this.buildDAGFromPath(pathResult.nodeSequence);
          log.debug("[DAGSuggesterAdapter] Built DAG from DR-DSP path", {
            correlationId,
            pathLength: pathResult.nodeSequence.length,
            tasksCount: suggestedDag.tasks.length,
          });
        }
      }

      // Fallback: build simple sequence from tools used
      if (!suggestedDag && capability.toolsUsed && capability.toolsUsed.length > 0) {
        suggestedDag = this.buildSequenceDAG(capability.toolsUsed);
      }

      // Determine if speculation is possible
      const canSpeculate = bestMatch.score >= 0.7 && capability.successRate >= 0.8;

      return {
        suggestedDag,
        confidence: bestMatch.score,
        bestMatch,
        canSpeculate,
      };
    } catch (error) {
      log.error(`[DAGSuggesterAdapter] Suggestion failed: ${error}`);
      return { confidence: 0 };
    }
  }

  /**
   * Score all capabilities for an intent (raw SHGAT scoring)
   */
  scoreCapabilities(intentEmbedding: number[]): CapabilityMatch[] {
    if (!this.deps.shgat) {
      return [];
    }

    return this.deps.shgat.scoreAllCapabilities(intentEmbedding).map((r) => ({
      capabilityId: r.capabilityId,
      score: r.score,
      headScores: r.headScores,
      headWeights: r.headWeights,
      recursiveContribution: r.recursiveContribution,
      featureContributions: r.featureContributions,
    }));
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  private buildDAGFromPath(nodeSequence: string[]): DAGSuggestion {
    const tasks = nodeSequence.map((nodeId, index) => ({
      id: `task_${index}`,
      callName: nodeId,
      type: "tool" as const,
      inputSchema: undefined,
      dependsOn: index > 0 ? [`task_${index - 1}`] : [],
    }));

    return { tasks };
  }

  private buildSequenceDAG(toolsUsed: string[]): DAGSuggestion {
    const tasks = toolsUsed.map((tool, index) => ({
      id: `task_${index}`,
      callName: tool,
      type: "tool" as const,
      inputSchema: undefined,
      dependsOn: index > 0 ? [`task_${index - 1}`] : [],
    }));

    return { tasks };
  }
}
