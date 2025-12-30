/**
 * Shared Emergence Metrics Types
 *
 * Types used by both backend API (src/mcp/routing/handlers/emergence.ts)
 * and frontend components (src/web/islands/EmergencePanel.tsx).
 *
 * Based on SYMBIOSIS/ODI framework (arxiv:2503.13754) and Holland's CAS theory.
 *
 * @module shared/emergence.types
 */

/**
 * Time range for emergence metrics queries
 */
export type EmergenceTimeRange = "1h" | "24h" | "7d" | "30d";

/**
 * Trend direction for metrics
 */
export type Trend = "rising" | "falling" | "stable";

/**
 * Phase transition type per SYMBIOSIS/ODI
 * - expansion: System exploring new patterns, entropy rising
 * - consolidation: System stabilizing, entropy falling
 * - none: No significant phase change detected
 */
export interface PhaseTransition {
  detected: boolean;
  type: "expansion" | "consolidation" | "none";
  confidence: number;
  description: string;
}

/**
 * Recommendation from emergence analysis
 */
export interface Recommendation {
  type: "warning" | "info" | "success";
  metric: string;
  message: string;
  action?: string;
}

/**
 * Tensor entropy metrics from graph analysis
 * Based on Chen & Rajapakse (2020) and arxiv:2503.18852
 * Story 6.6: Added semantic and dual entropy
 */
export interface TensorEntropyMetrics {
  /** Von Neumann entropy from Laplacian spectrum (0-1) */
  vonNeumann: number;
  /** Structural entropy from degree distribution (0-1, normalized by log2(n)) */
  structural: number;
  /** Weighted combination of structural + hyperedge entropy (0-1) - PRIMARY metric */
  normalized: number;
  /** Semantic entropy from embedding diversity (0-1), undefined if no embeddings */
  semantic?: number;
  /** Semantic diversity score (0-1), undefined if no embeddings */
  semanticDiversity?: number;
  /** Dual entropy: α*structural + (1-α)*semantic, α=0.6 (0-1) */
  dual?: number;
  /** Health classification based on size-adjusted thresholds */
  health: "rigid" | "healthy" | "chaotic";
  /** Size-adjusted thresholds used for health classification */
  thresholds: {
    low: number;
    high: number;
  };
  /** Graph size context */
  graphSize: {
    nodes: number;
    edges: number;
    hyperedges: number;
  };
  /** Number of embeddings used for semantic entropy (tools + capabilities) */
  embeddingCount?: number;
}

/**
 * Current metric values
 */
export interface EmergenceCurrentMetrics {
  /** Von Neumann graph entropy (0-1) - replaces old Shannon entropy */
  graphEntropy: number;
  /** Louvain community consistency via Jaccard similarity (0-1) */
  clusterStability: number;
  /** Unique patterns / total patterns ratio (0-1) */
  capabilityDiversity: number;
  /** New edges created per hour */
  learningVelocity: number;
  /** Correct predictions / total predictions (0-1) */
  speculationAccuracy: number;
  /** Adaptive threshold stability (0-1) */
  thresholdConvergence: number;
  /** Total capability count */
  capabilityCount: number;
  /** Parallel workflow rate (0-1) */
  parallelizationRate: number;
  /** Full tensor entropy analysis */
  tensorEntropy?: TensorEntropyMetrics;
}

/**
 * Trend indicators for main metrics
 */
export interface EmergenceTrends {
  graphEntropy: Trend;
  clusterStability: Trend;
  capabilityDiversity: Trend;
  learningVelocity: Trend;
  speculationAccuracy: Trend;
}

/**
 * Timeseries data point
 */
export interface TimeseriesPoint {
  timestamp: string;
  value: number;
}

/**
 * Timeseries data for charts
 * Story 6.6: Added semantic and dual entropy series
 */
export interface EmergenceTimeseries {
  /** Normalized structural entropy over time */
  entropy: TimeseriesPoint[];
  /** Semantic entropy from embeddings (may have gaps if no embeddings) */
  semanticEntropy?: TimeseriesPoint[];
  /** Dual entropy (structural + semantic combined) */
  dualEntropy?: TimeseriesPoint[];
  /** Cluster stability over time */
  stability: TimeseriesPoint[];
  /** Execution velocity over time */
  velocity: TimeseriesPoint[];
}

/**
 * Health thresholds for metrics
 */
export interface EmergenceThresholds {
  /** [min, max] healthy range for entropy (size-adjusted) */
  entropyHealthy: [number, number];
  /** Minimum healthy stability value */
  stabilityHealthy: number;
  /** Minimum healthy diversity value */
  diversityHealthy: number;
  /** Whether thresholds are size-adjusted (vs static defaults) */
  isAdjusted?: boolean;
}

/**
 * Complete emergence metrics API response
 * Aligned with SYMBIOSIS/ODI framework (arxiv:2503.13754)
 */
export interface EmergenceMetricsResponse {
  current: EmergenceCurrentMetrics;
  trends: EmergenceTrends;
  phaseTransition: PhaseTransition;
  recommendations: Recommendation[];
  timeseries: EmergenceTimeseries;
  thresholds: EmergenceThresholds;
}
