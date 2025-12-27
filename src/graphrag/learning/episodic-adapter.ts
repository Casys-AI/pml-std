/**
 * Episodic Memory Adapter Module
 *
 * Extracted from dag-suggester.ts for episodic memory integration.
 * Handles retrieval and parsing of historical episodes for learning-enhanced predictions.
 *
 * @module graphrag/learning/episodic-adapter
 */

import * as log from "@std/log";
import type { DagScoringConfig } from "../dag-scoring-config.ts";
import type { WorkflowPredictionState } from "../types.ts";
import type { EpisodicMemoryStore } from "../../learning/episodic-memory-store.ts";
import type { EpisodeStats, EpisodeStatsMap } from "../prediction/types.ts";
import type { EpisodicEvent, PredictionData } from "../../learning/types.ts";

// Re-export EpisodicEvent from canonical source (snake_case external convention)
export type { EpisodicEvent } from "../../learning/types.ts";

/**
 * Type guard for PredictionData in episodic events
 */
function hasPredictionData(
  data: unknown,
): data is { prediction: PredictionData } {
  return (
    typeof data === "object" &&
    data !== null &&
    "prediction" in data &&
    typeof (data as { prediction: unknown }).prediction === "object" &&
    (data as { prediction: { toolId: unknown } }).prediction !== null &&
    typeof (data as { prediction: { toolId: unknown } }).prediction.toolId === "string"
  );
}

/**
 * Generate context hash for episodic memory retrieval (Story 4.1e)
 *
 * Consistent with EpisodicMemoryStore.hashContext() pattern.
 * Hash includes workflow type, domain, and complexity for context matching.
 *
 * @param workflowState - Current workflow state
 * @returns Context hash string
 */
export function getContextHash(workflowState: WorkflowPredictionState | null): string {
  if (!workflowState) return "no-state";

  // Extract from context field or use defaults
  const ctx = workflowState.context || {};
  const workflowType = (ctx.workflowType as string) || "unknown";
  const domain = (ctx.domain as string) || "general";
  const complexity = workflowState.completedTasks?.length.toString() || "0";

  return `workflowType:${workflowType}|domain:${domain}|complexity:${complexity}`;
}

/**
 * Retrieve relevant historical episodes for context (Story 4.1e Task 2)
 *
 * Queries episodic memory for similar past workflows based on context hash.
 * Returns empty array if episodic memory not configured (graceful degradation).
 *
 * @param workflowState - Current workflow state
 * @param episodicMemory - Episodic memory store (may be null)
 * @param config - Scoring configuration
 * @returns Array of relevant episodic events
 */
export async function retrieveRelevantEpisodes(
  workflowState: WorkflowPredictionState | null,
  episodicMemory: EpisodicMemoryStore | null,
  config: DagScoringConfig,
): Promise<EpisodicEvent[]> {
  if (!episodicMemory || !workflowState) return [];

  const startTime = performance.now();
  const contextHash = getContextHash(workflowState);

  try {
    const ctx = workflowState.context || {};
    const context = {
      workflowType: (ctx.workflowType as string) || "unknown",
      domain: (ctx.domain as string) || "general",
      complexity: workflowState.completedTasks?.length.toString() || "0",
    };

    const episodes = await episodicMemory.retrieveRelevant(context, {
      limit: config.limits.episodeRetrieval,
      eventTypes: ["speculation_start", "task_complete"],
    });

    const retrievalTime = performance.now() - startTime;
    log.debug(
      `[episodic-adapter] Retrieved ${episodes.length} episodes for context ${contextHash} (${
        retrievalTime.toFixed(1)
      }ms)`,
    );

    return episodes;
  } catch (error) {
    log.error(`[episodic-adapter] Episode retrieval failed: ${error}`);
    return [];
  }
}

/**
 * Parse episodes to extract success/failure statistics per tool (Story 4.1e Task 2.3)
 *
 * Analyzes historical episodes to compute success rates for each tool.
 *
 * @param episodes - Retrieved episodic events
 * @returns Map of toolId to episode statistics
 */
export function parseEpisodeStatistics(episodes: EpisodicEvent[]): EpisodeStatsMap {
  const stats: EpisodeStatsMap = new Map();

  for (const episode of episodes) {
    let toolId: string | undefined;
    let success = false;

    // Extract toolId and outcome from different event types
    if (episode.event_type === "speculation_start" && hasPredictionData(episode.data)) {
      toolId = episode.data.prediction.toolId;
      success = episode.data.prediction.wasCorrect === true;
    } else if (episode.event_type === "task_complete" && episode.data.result) {
      // For task_complete events, we'd need task_id mapped to toolId (simplified here)
      // In practice, you might need to correlate with speculation_start events
      continue; // Skip for now, focus on speculation_start
    }

    if (!toolId) continue;

    const current: EpisodeStats = stats.get(toolId) || {
      total: 0,
      successes: 0,
      failures: 0,
      successRate: 0,
      failureRate: 0,
    };

    current.total++;
    if (success) {
      current.successes++;
    } else {
      current.failures++;
    }

    current.successRate = current.total > 0 ? current.successes / current.total : 0;
    current.failureRate = current.total > 0 ? current.failures / current.total : 0;

    stats.set(toolId, current);
  }

  return stats;
}

/**
 * Load episode statistics for a workflow state
 *
 * Convenience function that combines retrieval and parsing.
 *
 * @param workflowState - Current workflow state
 * @param episodicMemory - Episodic memory store (may be null)
 * @param config - Scoring configuration
 * @returns Episode statistics map
 */
export async function loadEpisodeStatistics(
  workflowState: WorkflowPredictionState | null,
  episodicMemory: EpisodicMemoryStore | null,
  config: DagScoringConfig,
): Promise<EpisodeStatsMap> {
  const episodes = await retrieveRelevantEpisodes(workflowState, episodicMemory, config);
  const stats = parseEpisodeStatistics(episodes);

  if (stats.size > 0) {
    log.debug(
      `[episodic-adapter] Loaded episode statistics for ${stats.size} tools from ${episodes.length} episodes`,
    );
  }

  return stats;
}
