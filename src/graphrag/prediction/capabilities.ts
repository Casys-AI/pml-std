/**
 * Capability Prediction Module
 *
 * Extracted from dag-suggester.ts for predicting capabilities based on
 * context tools and managing capability injection into DAGs.
 *
 * @module graphrag/prediction/capabilities
 */

import * as log from "@std/log";
import type { DagScoringConfig } from "../dag-scoring-config.ts";
import type { DAGStructure, PredictedNode } from "../types.ts";
import type {
  ArgumentsStructure,
  Capability,
  StaticStructure,
  StaticStructureNode,
} from "../../capabilities/types.ts";
import type { CapabilityStore } from "../../capabilities/capability-store.ts";
import type { AlgorithmTracer } from "../../telemetry/algorithm-tracer.ts";
import type { GraphRAGEngine } from "../graph-engine.ts";
import type { LocalAlphaCalculator, NodeType } from "../local-alpha.ts";
import type { AlphaResult, CapabilityContextMatch, EpisodeStatsMap } from "./types.ts";

/**
 * Dependencies for capability prediction
 */
export interface CapabilityPredictionDeps {
  capabilityStore: CapabilityStore | null;
  graphEngine: GraphRAGEngine;
  algorithmTracer: AlgorithmTracer | null;
  localAlphaCalculator: LocalAlphaCalculator | null;
  config: DagScoringConfig;
}

/**
 * Apply local alpha to adjust graph-based confidence (ADR-048)
 *
 * For passive suggestions, local alpha modulates how much we trust graph signals:
 * - alpha = 0.5 → full trust in graph → no adjustment
 * - alpha = 1.0 → low trust in graph → reduce confidence by 50%
 *
 * Formula: adjustedConfidence = baseConfidence * (1.5 - alpha)
 */
export function applyLocalAlpha(
  baseConfidence: number,
  targetId: string,
  nodeType: NodeType,
  contextNodes: string[],
  localAlphaCalculator: LocalAlphaCalculator | null,
  config: DagScoringConfig,
): AlphaResult {
  // If no calculator configured, return unchanged
  if (!localAlphaCalculator) {
    return { confidence: baseConfidence, alpha: config.defaults.alpha, algorithm: "none" };
  }

  const result = localAlphaCalculator.getLocalAlphaWithBreakdown(
    "passive",
    targetId,
    nodeType,
    contextNodes,
  );

  // Apply alpha adjustment: higher alpha = less trust in graph
  // graphTrustFactor ranges from 1.0 (alpha=0.5) to 0.5 (alpha=1.0)
  const graphTrustFactor = 1.5 - result.alpha;
  const adjustedConfidence = Math.min(config.caps.maxConfidence, baseConfidence * graphTrustFactor);

  log.debug(
    `[capabilities] Local alpha applied: ${targetId} base=${baseConfidence.toFixed(2)} alpha=${
      result.alpha.toFixed(2)
    } → ${adjustedConfidence.toFixed(2)} (${result.algorithm})`,
  );

  return {
    confidence: adjustedConfidence,
    alpha: result.alpha,
    algorithm: result.algorithm,
  };
}

/**
 * Adjust confidence based on episodic memory patterns (Story 4.1e)
 *
 * Returns null if tool should be excluded due to high failure rate.
 */
export function adjustConfidenceFromEpisodes(
  baseConfidence: number,
  toolId: string,
  episodeStats: EpisodeStatsMap,
  config: DagScoringConfig,
): { confidence: number; adjustment: number } | null {
  const stats = episodeStats.get(toolId);

  // No historical data: return base confidence unchanged
  if (!stats || stats.total === 0) {
    return { confidence: baseConfidence, adjustment: 0 };
  }

  const {
    successBoostFactor,
    successBoostCap,
    failurePenaltyFactor,
    failurePenaltyCap,
    failureExclusionRate,
    adjustmentLogThreshold,
  } = config.episodic;

  // Exclude if failure rate above threshold
  if (stats.failureRate > failureExclusionRate) {
    log.debug(
      `[capabilities] Excluding ${toolId} due to high failure rate: ${
        (stats.failureRate * 100).toFixed(0)
      }% (${stats.failures}/${stats.total})`,
    );
    return null;
  }

  // Calculate boost for successful patterns
  const boost = Math.min(successBoostCap, stats.successRate * successBoostFactor);

  // Calculate penalty for failed patterns
  const penalty = Math.min(failurePenaltyCap, stats.failureRate * failurePenaltyFactor);

  // Net adjustment
  const adjustment = boost - penalty;

  // Apply adjustment with clamping
  const adjustedConfidence = Math.max(0, Math.min(1.0, baseConfidence + adjustment));

  // Log adjustments for observability
  if (Math.abs(adjustment) > adjustmentLogThreshold) {
    log.debug(
      `[capabilities] Confidence adjusted for ${toolId}: ${baseConfidence.toFixed(2)} → ${
        adjustedConfidence.toFixed(2)
      } (boost: +${boost.toFixed(2)}, penalty: -${
        penalty.toFixed(2)
      }, stats: ${stats.successes}/${stats.total} success)`,
    );
  }

  return { confidence: adjustedConfidence, adjustment };
}

/**
 * Extract literal arguments from static_structure for speculative execution (Story 10.2)
 *
 * Iterates through task nodes in the static structure and extracts only
 * literal arguments that can be used immediately for speculative execution.
 * References and parameters are logged but not included (require runtime resolution).
 *
 * @param staticStructure - Static structure from capability analysis
 * @returns Record of tool arguments, keyed by tool ID, containing only literal values
 */
export function extractArgumentsFromStaticStructure(
  staticStructure: StaticStructure | null,
): Record<string, Record<string, unknown>> {
  if (!staticStructure || !staticStructure.nodes) {
    return {};
  }

  const result: Record<string, Record<string, unknown>> = {};

  for (const node of staticStructure.nodes) {
    // Only task nodes have arguments
    if (node.type !== "task") {
      continue;
    }

    const taskNode = node as StaticStructureNode & { type: "task" };
    if (!taskNode.arguments) {
      continue;
    }

    const toolArgs: Record<string, unknown> = {};
    let hasLiterals = false;

    for (const [argName, argValue] of Object.entries(taskNode.arguments as ArgumentsStructure)) {
      // Only include literal values that can be used immediately
      if (argValue.type === "literal") {
        toolArgs[argName] = argValue.value;
        hasLiterals = true;
      } // Log references and parameters for debugging (future: runtime resolution)
      else if (argValue.type === "reference") {
        log.debug(
          `[extractArguments] Reference argument ${argName} for ${taskNode.tool}: ${argValue.expression} (needs runtime resolution)`,
        );
      } else if (argValue.type === "parameter") {
        log.debug(
          `[extractArguments] Parameter argument ${argName} for ${taskNode.tool}: ${argValue.parameterName} (needs intent extraction)`,
        );
      }
    }

    // Only add to result if we have some literal arguments
    if (hasLiterals) {
      result[taskNode.tool] = toolArgs;
    }
  }

  return result;
}

/**
 * Predict capabilities based on context tools (Story 7.4 AC#6)
 *
 * Uses CapabilityStore.searchByContext() to find capabilities
 * whose tools_used overlap with the current context.
 *
 * Story 10.2: Now populates PredictedNode.arguments from static_structure
 * when capability source is used.
 *
 * @param contextTools - Tools currently executed in workflow
 * @param seenTools - Tools already in predictions (for deduplication)
 * @param episodeStats - Episode statistics for adjustment
 * @param clusterBoosts - Map of capability ID to cluster boost
 * @param deps - Prediction dependencies
 * @param suggestAlternativesFn - Function to suggest alternatives
 * @returns Array of PredictedNode with source="capability"
 */
export async function predictCapabilities(
  contextTools: string[],
  seenTools: Set<string>,
  episodeStats: EpisodeStatsMap,
  clusterBoosts: Map<string, number>,
  deps: CapabilityPredictionDeps,
  suggestAlternativesFn: (
    cap: Capability,
    score: number,
    seen: Set<string>,
    stats: EpisodeStatsMap,
  ) => Promise<PredictedNode[]>,
): Promise<PredictedNode[]> {
  if (!deps.capabilityStore || contextTools.length === 0) {
    return [];
  }

  const predictions: PredictedNode[] = [];

  try {
    // Search for capabilities matching context tools
    const matches: CapabilityContextMatch[] = await deps.capabilityStore.searchByContext(
      contextTools,
      deps.config.limits.contextSearch,
      deps.config.thresholds.contextSearch,
    );

    if (matches.length === 0) {
      return [];
    }

    for (const match of matches) {
      const capability = match.capability;
      const capabilityToolId = `capability:${capability.id}`;

      // Skip if already seen
      if (seenTools.has(capabilityToolId)) continue;

      // ADR-038: Strategic Discovery uses MULTIPLICATIVE formula
      const clusterBoost = clusterBoosts.get(capability.id) ?? 0;
      const discoveryScore = match.overlapScore * (1 + clusterBoost);

      // Scale to configured confidence range
      const { confidenceFloor, confidenceCeiling, scoreScaling } = deps.config.capability;
      const baseConfidence = Math.min(
        confidenceCeiling,
        confidenceFloor + discoveryScore * scoreScaling,
      );

      // ADR-048: Apply local alpha adjustment for capability
      const alphaResult = applyLocalAlpha(
        baseConfidence,
        capabilityToolId,
        "capability",
        contextTools,
        deps.localAlphaCalculator,
        deps.config,
      );

      // Apply episodic learning adjustments
      const adjusted = adjustConfidenceFromEpisodes(
        alphaResult.confidence,
        capabilityToolId,
        episodeStats,
        deps.config,
      );

      if (!adjusted) continue; // Excluded due to high failure rate

      // Story 10.2: Extract arguments from static_structure for speculative execution
      let predictedArguments: Record<string, unknown> | undefined;
      try {
        const staticStructure = await deps.capabilityStore.getStaticStructure(capability.id);
        if (staticStructure) {
          const toolArguments = extractArgumentsFromStaticStructure(staticStructure);
          // Flatten all tool arguments into a single object for the capability
          // (first tool's literals are most relevant for capability invocation)
          const allArgs: Record<string, unknown> = {};
          for (const toolArgs of Object.values(toolArguments)) {
            Object.assign(allArgs, toolArgs);
          }
          if (Object.keys(allArgs).length > 0) {
            predictedArguments = allArgs;
            log.debug(
              `[predictCapabilities] Extracted ${
                Object.keys(allArgs).length
              } literal arguments for capability ${capability.id}`,
            );
          }
        }
      } catch (error) {
        log.debug(
          `[predictCapabilities] Failed to extract arguments for ${capability.id}: ${error}`,
        );
      }

      predictions.push({
        toolId: capabilityToolId,
        confidence: adjusted.confidence,
        reasoning: `Capability matches context (${(match.overlapScore * 100).toFixed(0)}% overlap${
          clusterBoost > 0 ? `, +${(clusterBoost * 100).toFixed(0)}% cluster boost` : ""
        }, α=${alphaResult.alpha.toFixed(2)})`,
        source: "capability",
        capabilityId: capability.id,
        // Story 10.2: Include extracted arguments for speculative execution
        ...(predictedArguments ? { arguments: predictedArguments } : {}),
      });

      // Log trace for capability prediction (fire-and-forget)
      deps.algorithmTracer?.logTrace({
        algorithmMode: "passive_suggestion",
        targetType: "capability",
        signals: {
          toolsOverlap: match.overlapScore,
          successRate: capability.successRate,
          graphDensity: deps.graphEngine.getGraphDensity(),
          spectralClusterMatch: clusterBoost > 0,
          localAlpha: alphaResult.alpha,
          alphaAlgorithm: alphaResult.algorithm as
            | "heat_diffusion"
            | "heat_hierarchical"
            | "bayesian"
            | "none",
        },
        params: {
          alpha: alphaResult.alpha,
          reliabilityFactor: 1.0,
          structuralBoost: clusterBoost,
        },
        finalScore: adjusted.confidence,
        thresholdUsed: 0.3,
        decision: "accepted",
      });

      seenTools.add(capabilityToolId);

      // Suggest alternative capabilities
      const alternativePredictions = await suggestAlternativesFn(
        capability,
        adjusted.confidence,
        seenTools,
        episodeStats,
      );
      predictions.push(...alternativePredictions);
    }

    if (predictions.length > 0) {
      log.debug(
        `[predictCapabilities] Found ${predictions.length} capability predictions (incl. alternatives)`,
      );
    }
  } catch (error) {
    log.error(`[predictCapabilities] Failed: ${error}`);
  }

  return predictions;
}

/**
 * Extract tools_used from capability (Story 7.4)
 *
 * @param capability - Capability to extract from
 * @returns Array of tool IDs used by the capability
 */
export function getCapabilityToolsUsed(capability: Capability): string[] {
  return capability.toolsUsed ?? [];
}

/**
 * Create a capability task for DAG insertion (Story 7.4 AC#5)
 *
 * @param capability - Capability to convert to task
 * @param dag - Current DAG structure (for ID generation)
 * @returns Task with type="capability"
 */
export function createCapabilityTask(
  capability: Capability,
  dag: DAGStructure,
): DAGStructure["tasks"][0] {
  const taskId = `cap_${capability.id.substring(0, 8)}_${dag.tasks.length}`;

  // Determine dependencies: find tasks that provide the capability's required tools
  const dependsOn: string[] = [];
  const capToolsUsed = getCapabilityToolsUsed(capability);

  for (const existingTask of dag.tasks) {
    // If existing task's tool is in capability's tools_used, add dependency
    if (capToolsUsed.includes(existingTask.tool)) {
      dependsOn.push(existingTask.id);
    }
  }

  // If no dependencies found, depend on the last tool task (sequential insertion)
  if (dependsOn.length === 0 && dag.tasks.length > 0) {
    const lastTask = dag.tasks[dag.tasks.length - 1];
    dependsOn.push(lastTask.id);
  }

  return {
    id: taskId,
    tool: capability.name ?? `capability_${capability.id.substring(0, 8)}`,
    type: "capability",
    capabilityId: capability.id,
    code: capability.codeSnippet,
    arguments: {},
    dependsOn,
  };
}

/**
 * Inject matching capabilities into DAG (Story 7.4 AC#4, AC#5, AC#7)
 *
 * @param dag - DAG structure to augment (modified in place)
 * @param contextTools - Tools already in the DAG
 * @param clusterBoosts - Map of capability ID to cluster boost
 * @param deps - Prediction dependencies
 */
export async function injectMatchingCapabilities(
  dag: DAGStructure,
  contextTools: string[],
  clusterBoosts: Map<string, number>,
  deps: CapabilityPredictionDeps,
): Promise<void> {
  if (!deps.capabilityStore || contextTools.length === 0) {
    return;
  }

  const startTime = performance.now();

  try {
    // Search for capabilities matching context tools
    const matches: CapabilityContextMatch[] = await deps.capabilityStore.searchByContext(
      contextTools,
      deps.config.limits.capabilityMatches,
      deps.config.thresholds.contextSearch,
    );

    if (matches.length === 0) {
      log.debug("[capabilities] No matching capabilities for context tools");
      return;
    }

    log.debug(`[capabilities] Found ${matches.length} matching capabilities for context`);

    // Create capability tasks and insert into DAG
    for (const match of matches) {
      const capability = match.capability;
      const clusterBoost = clusterBoosts.get(capability.id) ?? 0;
      const finalScore = match.overlapScore * (1 + clusterBoost);

      // Skip low-scoring capabilities
      if (finalScore < deps.config.caps.finalScoreMinimum) {
        log.debug(
          `[capabilities] Skipping capability ${capability.id} (score: ${finalScore.toFixed(2)})`,
        );
        continue;
      }

      // Create and add capability task
      const capabilityTask = createCapabilityTask(capability, dag);
      dag.tasks.push(capabilityTask);

      log.info(
        `[capabilities] Injected capability task ${capabilityTask.id} (overlap: ${
          match.overlapScore.toFixed(2)
        }, boost: ${clusterBoost.toFixed(2)})`,
      );
    }

    const elapsedMs = performance.now() - startTime;
    log.debug(`[capabilities] Capability injection complete (${elapsedMs.toFixed(1)}ms)`);
  } catch (error) {
    log.error(`[capabilities] Capability injection failed: ${error}`);
  }
}
