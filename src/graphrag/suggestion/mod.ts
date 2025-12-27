/**
 * Suggestion Module Exports
 *
 * Provides confidence calculation, rationale generation, and candidate ranking
 * for DAG suggestions.
 *
 * @module graphrag/suggestion
 */

export {
  type AdaptiveWeights,
  calculateCommunityConfidence,
  calculateConfidenceHybrid,
  calculateCooccurrenceConfidence,
  calculatePathConfidence,
  type ConfidenceBreakdown,
  getAdaptiveWeightsFromAlpha,
  type ScoredCandidate,
} from "./confidence.ts";

export {
  explainPath,
  generatePredictionReasoning,
  generateRationaleHybrid,
  type RationaleCandidate,
} from "./rationale.ts";

export {
  calculateAverageAlpha,
  type CandidateAlpha,
  extractDependencyPaths,
  rankCandidates,
  type RankedCandidate,
} from "./ranking.ts";
