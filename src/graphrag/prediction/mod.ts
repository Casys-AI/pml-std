/**
 * Prediction Module Exports
 *
 * Provides prediction functionality for next nodes, capabilities,
 * and alternative suggestions.
 *
 * @module graphrag/prediction
 */

export {
  type AlphaResult,
  type CapabilityContextMatch,
  DANGEROUS_OPERATIONS,
  type EdgeData,
  type EpisodeStats,
  type EpisodeStatsMap,
  isDangerousOperation,
} from "./types.ts";

export {
  adjustConfidenceFromEpisodes,
  applyLocalAlpha,
  type CapabilityPredictionDeps,
  createCapabilityTask,
  getCapabilityToolsUsed,
  injectMatchingCapabilities,
  predictCapabilities,
} from "./capabilities.ts";

export { type AlternativeSuggestionDeps, suggestAlternatives } from "./alternatives.ts";
