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
 * Current metric values
 */
export interface EmergenceCurrentMetrics {
  /** Shannon entropy of edge weight distribution (0-1) */
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
 */
export interface EmergenceTimeseries {
  entropy: TimeseriesPoint[];
  stability: TimeseriesPoint[];
  velocity: TimeseriesPoint[];
}

/**
 * Health thresholds for metrics
 */
export interface EmergenceThresholds {
  /** [min, max] healthy range for entropy */
  entropyHealthy: [number, number];
  /** Minimum healthy stability value */
  stabilityHealthy: number;
  /** Minimum healthy diversity value */
  diversityHealthy: number;
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
