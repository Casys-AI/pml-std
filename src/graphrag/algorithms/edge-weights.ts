/**
 * Edge Weight Configuration Module
 *
 * ADR-041: Defines edge type weights and source modifiers for graph algorithms.
 * Combined weight formula: final_weight = type_weight × source_modifier
 *
 * @module graphrag/algorithms/edge-weights
 */

/**
 * Edge types representing relationship semantics
 *
 * - dependency: Explicit DAG dependencies from templates
 * - contains: Parent-child hierarchy (capability → tool)
 * - provides: Data flow (A's output feeds B's input) (Story 10.3)
 * - sequence: Temporal order between siblings
 */
export type EdgeType = "dependency" | "contains" | "provides" | "sequence";

/**
 * Edge sources indicating confidence level
 *
 * - observed: Confirmed by 3+ executions
 * - inferred: 1-2 observations
 * - template: Bootstrap, not yet confirmed
 */
export type EdgeSource = "observed" | "inferred" | "template";

/**
 * Edge type weights for algorithms
 *
 * Higher weight = stronger relationship = preferred in path finding
 * ADR-050: alternative removed (not used), provides added (Story 10.3)
 */
export const EDGE_TYPE_WEIGHTS: Record<EdgeType, number> = {
  dependency: 1.0,   // Explicit DAG from templates
  contains: 0.8,     // Parent-child hierarchy (capability → tool)
  provides: 0.7,     // Data flow (A's output feeds B's input) (Story 10.3)
  sequence: 0.5,     // Temporal order between siblings
};

/**
 * Edge source weight modifiers (multiplied with type weight)
 *
 * Higher modifier = more reliable observation
 */
export const EDGE_SOURCE_MODIFIERS: Record<EdgeSource, number> = {
  observed: 1.0,   // Confirmed by 3+ executions
  inferred: 0.7,   // 1-2 observations
  template: 0.5,   // Bootstrap, not yet confirmed
};

/**
 * Observation threshold for edge_source upgrade
 * Edge transitions from 'inferred' to 'observed' after this many observations
 */
export const OBSERVED_THRESHOLD = 3;

/**
 * Get combined edge weight (type × source modifier)
 *
 * Examples of combined weights:
 * - dependency + observed = 1.0 × 1.0 = 1.0 (strongest)
 * - contains + observed   = 0.8 × 1.0 = 0.8
 * - contains + inferred   = 0.8 × 0.7 = 0.56
 * - sequence + inferred   = 0.5 × 0.7 = 0.35
 * - sequence + template   = 0.5 × 0.5 = 0.25 (weakest)
 *
 * For Dijkstra shortest path: cost = 1/weight
 * Higher weight = lower cost = preferred path
 *
 * @param edgeType - Edge type
 * @param edgeSource - Edge source
 * @returns Combined weight for algorithms
 */
export function getEdgeWeight(edgeType: EdgeType | string, edgeSource: EdgeSource | string): number {
  const typeWeight = EDGE_TYPE_WEIGHTS[edgeType as EdgeType] || 0.5;
  const sourceModifier = EDGE_SOURCE_MODIFIERS[edgeSource as EdgeSource] || 0.7;
  return typeWeight * sourceModifier;
}

/**
 * Determine the appropriate edge source based on observation count
 *
 * @param observedCount - Number of times the edge has been observed
 * @param currentSource - Current edge source
 * @returns Updated edge source
 */
export function determineEdgeSource(
  observedCount: number,
  currentSource: EdgeSource | string
): EdgeSource {
  if (observedCount >= OBSERVED_THRESHOLD && currentSource === "inferred") {
    return "observed";
  }
  return currentSource as EdgeSource;
}

/**
 * Calculate weight for a new edge
 *
 * New edges start as 'inferred' unless specified otherwise.
 *
 * @param edgeType - Edge type
 * @param edgeSource - Edge source (default: 'inferred')
 * @returns Initial edge weight
 */
export function calculateInitialWeight(
  edgeType: EdgeType,
  edgeSource: EdgeSource = "inferred"
): number {
  return getEdgeWeight(edgeType, edgeSource);
}
