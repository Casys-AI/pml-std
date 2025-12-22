/**
 * Metrics Collector Module
 *
 * Collects and aggregates graph metrics for dashboard display.
 * Story 6.3: Live Metrics & Analytics Panel
 *
 * @module graphrag/metrics/collector
 */

import * as log from "@std/log";
import type { PGliteClient } from "../../db/client.ts";
import type {
  GraphMetricsResponse,
  MetricsTimeRange,
  TimeSeriesPoint,
} from "../types.ts";

/**
 * Collect comprehensive metrics for dashboard
 *
 * Aggregates current snapshot, time series data, and period statistics.
 *
 * @param db - PGlite database client
 * @param currentMetrics - Current graph metrics
 * @param range - Time range for historical data
 * @returns Complete metrics response for dashboard
 */
export async function collectMetrics(
  db: PGliteClient,
  currentMetrics: {
    nodeCount: number;
    edgeCount: number;
    density: number;
    adaptiveAlpha: number;
    communitiesCount: number;
    pagerankTop10: Array<{ toolId: string; score: number }>;
  },
  range: MetricsTimeRange
): Promise<GraphMetricsResponse> {
  const startTime = performance.now();

  // Calculate interval for time range
  const intervalHours = range === "1h" ? 1 : range === "24h" ? 24 : 168; // 7d = 168h
  const intervalMs = intervalHours * 60 * 60 * 1000;
  const startDate = new Date(Date.now() - intervalMs);

  // Extended counts
  const [capCount, embCount, depCount] = await Promise.all([
    db.query("SELECT COUNT(*) as cnt FROM workflow_pattern").then((r) => Number(r[0]?.cnt) || 0).catch(() => 0),
    db.query("SELECT COUNT(*) as cnt FROM tool_embedding").then((r) => Number(r[0]?.cnt) || 0).catch(() => 0),
    db.query("SELECT COUNT(*) as cnt FROM tool_dependency").then((r) => Number(r[0]?.cnt) || 0).catch(() => 0),
  ]);

  // ADR-048: Fetch local alpha stats from recent traces
  const localAlphaStats = await getLocalAlphaStats(db, startDate);

  const current = {
    ...currentMetrics,
    capabilitiesCount: capCount,
    embeddingsCount: embCount,
    dependenciesCount: depCount,
    localAlpha: localAlphaStats,
  };

  // Fetch time series data
  const timeseries = await getMetricsTimeSeries(db, range, startDate);

  // Fetch period statistics
  const period = await getPeriodStats(db, range, startDate);

  // Fetch algorithm tracing statistics
  const algorithm = await getAlgorithmStats(db, startDate);

  const elapsed = performance.now() - startTime;
  log.debug(`[collectMetrics] Collected metrics in ${elapsed.toFixed(1)}ms (range=${range})`);

  return {
    current,
    timeseries,
    period,
    algorithm,
  };
}

/**
 * Get local alpha statistics from recent traces (ADR-048)
 */
async function getLocalAlphaStats(
  db: PGliteClient,
  startDate: Date
): Promise<GraphMetricsResponse["current"]["localAlpha"]> {
  const isoDate = startDate.toISOString();

  try {
    const result = await db.query(
      `
      SELECT
        AVG((params->>'alpha')::float) as avg_alpha,
        AVG((params->>'alpha')::float) FILTER (WHERE algorithm_mode = 'active_search') as avg_alpha_active,
        AVG((params->>'alpha')::float) FILTER (WHERE algorithm_mode = 'passive_suggestion') as avg_alpha_passive,
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE (signals->>'coldStart')::boolean = true) as cold_start_count,
        COUNT(*) FILTER (WHERE signals->>'alphaAlgorithm' = 'embeddings_hybrides') as emb_hybrides,
        COUNT(*) FILTER (WHERE signals->>'alphaAlgorithm' = 'heat_diffusion') as heat_diff,
        COUNT(*) FILTER (WHERE signals->>'alphaAlgorithm' = 'heat_hierarchical') as heat_hier,
        COUNT(*) FILTER (WHERE signals->>'alphaAlgorithm' = 'bayesian') as bayesian,
        COUNT(*) FILTER (WHERE signals->>'alphaAlgorithm' = 'none' OR signals->>'alphaAlgorithm' IS NULL) as none_algo
      FROM algorithm_traces
      WHERE timestamp >= $1
      AND params->>'alpha' IS NOT NULL
      `,
      [isoDate]
    );

    const row = result[0];
    if (!row || Number(row.total) === 0) {
      return undefined;
    }

    const total = Number(row.total) || 1;

    return {
      avgAlpha: Number(row.avg_alpha) || 0.75,
      byMode: {
        activeSearch: Number(row.avg_alpha_active) || 0,
        passiveSuggestion: Number(row.avg_alpha_passive) || 0,
      },
      algorithmDistribution: {
        embeddingsHybrides: Number(row.emb_hybrides) || 0,
        heatDiffusion: Number(row.heat_diff) || 0,
        heatHierarchical: Number(row.heat_hier) || 0,
        bayesian: Number(row.bayesian) || 0,
        none: Number(row.none_algo) || 0,
      },
      coldStartPercentage: (Number(row.cold_start_count) / total) * 100,
    };
  } catch (error) {
    log.error(`[getLocalAlphaStats] Failed: ${error}`);
    return undefined;
  }
}

/**
 * Get time series data for metrics charts
 */
async function getMetricsTimeSeries(
  db: PGliteClient,
  range: MetricsTimeRange,
  startDate: Date
): Promise<{
  edgeCount: TimeSeriesPoint[];
  avgConfidence: TimeSeriesPoint[];
  workflowRate: TimeSeriesPoint[];
}> {
  const bucketMinutes = range === "1h" ? 5 : range === "24h" ? 60 : 360;

  try {
    const edgeCountResult = await db.query(
      `
      SELECT
        date_trunc('hour', timestamp) +
        (EXTRACT(minute FROM timestamp)::int / $1) * interval '1 minute' * $1 as bucket,
        AVG(value) as avg_value
      FROM metrics
      WHERE metric_name = 'graph_edge_count'
        AND timestamp >= $2
      GROUP BY bucket
      ORDER BY bucket
      `,
      [bucketMinutes, startDate.toISOString()]
    );

    const avgConfidenceResult = await db.query(
      `
      SELECT
        date_trunc('hour', timestamp) +
        (EXTRACT(minute FROM timestamp)::int / $1) * interval '1 minute' * $1 as bucket,
        AVG(value) as avg_value
      FROM metrics
      WHERE metric_name = 'avg_confidence_score'
        AND timestamp >= $2
      GROUP BY bucket
      ORDER BY bucket
      `,
      [bucketMinutes, startDate.toISOString()]
    );

    // Story 11.2: Query execution_trace instead of workflow_execution
    const workflowRateResult = await db.query(
      `
      SELECT
        date_trunc('hour', executed_at) as bucket,
        COUNT(*) as count
      FROM execution_trace
      WHERE executed_at >= $1
      GROUP BY bucket
      ORDER BY bucket
      `,
      [startDate.toISOString()]
    );

    return {
      edgeCount: edgeCountResult.map((row: Record<string, unknown>) => ({
        timestamp: String(row.bucket),
        value: Number(row.avg_value) || 0,
      })),
      avgConfidence: avgConfidenceResult.map((row: Record<string, unknown>) => ({
        timestamp: String(row.bucket),
        value: Number(row.avg_value) || 0,
      })),
      workflowRate: workflowRateResult.map((row: Record<string, unknown>) => ({
        timestamp: String(row.bucket),
        value: Number(row.count) || 0,
      })),
    };
  } catch (error) {
    log.warn(`[getMetricsTimeSeries] Query failed: ${error}`);
    return {
      edgeCount: [],
      avgConfidence: [],
      workflowRate: [],
    };
  }
}

/**
 * Get period statistics
 */
async function getPeriodStats(
  db: PGliteClient,
  range: MetricsTimeRange,
  startDate: Date
): Promise<{
  range: MetricsTimeRange;
  workflowsExecuted: number;
  workflowsSuccessRate: number;
  newEdgesCreated: number;
  newNodesAdded: number;
}> {
  try {
    // Story 11.2: Query execution_trace instead of workflow_execution
    const workflowStats = await db.query(
      `
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN success THEN 1 ELSE 0 END) as successful
      FROM execution_trace
      WHERE executed_at >= $1
      `,
      [startDate.toISOString()]
    );

    const total = Number(workflowStats[0]?.total) || 0;
    const successful = Number(workflowStats[0]?.successful) || 0;
    const successRate = total > 0 ? (successful / total) * 100 : 0;

    const newEdges = await db.query(
      `
      SELECT COUNT(*) as count
      FROM tool_dependency
      WHERE last_observed >= $1
      `,
      [startDate.toISOString()]
    );

    const newNodes = await db.query(
      `
      SELECT COUNT(DISTINCT metadata->>'tool_id') as count
      FROM metrics
      WHERE metric_name = 'tool_embedded'
        AND timestamp >= $1
      `,
      [startDate.toISOString()]
    );

    return {
      range,
      workflowsExecuted: total,
      workflowsSuccessRate: Math.round(successRate * 10) / 10,
      newEdgesCreated: Number(newEdges[0]?.count) || 0,
      newNodesAdded: Number(newNodes[0]?.count) || 0,
    };
  } catch (error) {
    log.warn(`[getPeriodStats] Query failed: ${error}`);
    return {
      range,
      workflowsExecuted: 0,
      workflowsSuccessRate: 0,
      newEdgesCreated: 0,
      newNodesAdded: 0,
    };
  }
}

/**
 * Get algorithm tracing statistics (Story 7.6, ADR-039)
 */
async function getAlgorithmStats(
  db: PGliteClient,
  startDate: Date
): Promise<GraphMetricsResponse["algorithm"]> {
  const isoDate = startDate.toISOString();

  try {
    // Base stats query
    const statsResult = await db.query(
      `
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE decision = 'accepted') as accepted,
        COUNT(*) FILTER (WHERE decision LIKE 'filtered%') as filtered,
        COUNT(*) FILTER (WHERE decision LIKE 'rejected%') as rejected,
        COUNT(*) FILTER (WHERE target_type = 'tool') as tools,
        COUNT(*) FILTER (WHERE target_type = 'capability') as capabilities,
        AVG(final_score) as avg_final,
        AVG((signals->>'semanticScore')::float) as avg_semantic,
        AVG((signals->>'graphScore')::float) as avg_graph
      FROM algorithm_traces
      WHERE timestamp >= $1
      `,
      [isoDate]
    );

    const stats = statsResult[0] || {};
    const total = Number(stats.total) || 0;

    // Graph vs Hypergraph stats (ADR-039)
    const graphTypeResult = await db.query(
      `
      SELECT
        CASE
          WHEN target_type = 'capability' OR signals->>'spectralClusterMatch' IS NOT NULL
          THEN 'hypergraph'
          ELSE 'graph'
        END as graph_type,
        COUNT(*) as count,
        AVG(final_score) as avg_score,
        COUNT(*) FILTER (WHERE decision = 'accepted')::float / NULLIF(COUNT(*), 0) as acceptance_rate,
        AVG((signals->>'pagerank')::float) as avg_pagerank,
        AVG((signals->>'adamicAdar')::float) as avg_adamic_adar,
        AVG((signals->>'cooccurrence')::float) as avg_cooccurrence
      FROM algorithm_traces
      WHERE timestamp >= $1
      GROUP BY graph_type
      `,
      [isoDate]
    );

    const graphStats = { count: 0, avgScore: 0, acceptanceRate: 0, topSignals: { pagerank: 0, adamicAdar: 0, cooccurrence: 0 } };
    const hypergraphStats = { count: 0, avgScore: 0, acceptanceRate: 0 };

    for (const row of graphTypeResult) {
      if (row.graph_type === "graph") {
        graphStats.count = Number(row.count) || 0;
        graphStats.avgScore = Number(row.avg_score) || 0;
        graphStats.acceptanceRate = Number(row.acceptance_rate) || 0;
        graphStats.topSignals = {
          pagerank: Number(row.avg_pagerank) || 0,
          adamicAdar: Number(row.avg_adamic_adar) || 0,
          cooccurrence: Number(row.avg_cooccurrence) || 0,
        };
      } else if (row.graph_type === "hypergraph") {
        hypergraphStats.count = Number(row.count) || 0;
        hypergraphStats.avgScore = Number(row.avg_score) || 0;
        hypergraphStats.acceptanceRate = Number(row.acceptance_rate) || 0;
      }
    }

    // Spectral relevance (hypergraph only)
    const spectralResult = await db.query(
      `
      SELECT
        COALESCE((signals->>'spectralClusterMatch')::boolean, false) as cluster_match,
        COUNT(*) as count,
        AVG(final_score) as avg_score,
        COUNT(*) FILTER (WHERE outcome->>'userAction' = 'selected')::float / NULLIF(COUNT(*), 0) as selected_rate
      FROM algorithm_traces
      WHERE timestamp >= $1
        AND (target_type = 'capability' OR signals->>'spectralClusterMatch' IS NOT NULL)
      GROUP BY cluster_match
      `,
      [isoDate]
    );

    const spectralRelevance = {
      withClusterMatch: { count: 0, avgScore: 0, selectedRate: 0 },
      withoutClusterMatch: { count: 0, avgScore: 0, selectedRate: 0 },
    };

    for (const row of spectralResult) {
      const target = row.cluster_match ? spectralRelevance.withClusterMatch : spectralRelevance.withoutClusterMatch;
      target.count = Number(row.count) || 0;
      target.avgScore = Number(row.avg_score) || 0;
      target.selectedRate = Number(row.selected_rate) || 0;
    }

    // Score distribution by graph type
    const distributionResult = await db.query(
      `
      SELECT
        CASE
          WHEN target_type = 'capability' OR signals->>'spectralClusterMatch' IS NOT NULL
          THEN 'hypergraph'
          ELSE 'graph'
        END as graph_type,
        CONCAT(FLOOR(final_score * 10)::int / 10.0, '-', (FLOOR(final_score * 10)::int + 1) / 10.0) as bucket,
        COUNT(*) as count
      FROM algorithm_traces
      WHERE timestamp >= $1
      GROUP BY graph_type, FLOOR(final_score * 10)
      ORDER BY graph_type, FLOOR(final_score * 10)
      `,
      [isoDate]
    );

    const scoreDistribution: { graph: Array<{ bucket: string; count: number }>; hypergraph: Array<{ bucket: string; count: number }> } = {
      graph: [],
      hypergraph: [],
    };

    for (const row of distributionResult) {
      const entry = { bucket: String(row.bucket), count: Number(row.count) || 0 };
      if (row.graph_type === "graph") {
        scoreDistribution.graph.push(entry);
      } else {
        scoreDistribution.hypergraph.push(entry);
      }
    }

    // Stats by mode
    const modeResult = await db.query(
      `
      SELECT
        algorithm_mode,
        COUNT(*) as count,
        AVG(final_score) as avg_score,
        COUNT(*) FILTER (WHERE decision = 'accepted')::float / NULLIF(COUNT(*), 0) as acceptance_rate
      FROM algorithm_traces
      WHERE timestamp >= $1
      GROUP BY algorithm_mode
      `,
      [isoDate]
    );

    const byMode = {
      activeSearch: { count: 0, avgScore: 0, acceptanceRate: 0 },
      passiveSuggestion: { count: 0, avgScore: 0, acceptanceRate: 0 },
    };

    for (const row of modeResult) {
      const mode = String(row.algorithm_mode || "").toLowerCase();
      if (mode === "active_search" || mode === "activesearch") {
        byMode.activeSearch = {
          count: Number(row.count) || 0,
          avgScore: Number(row.avg_score) || 0,
          acceptanceRate: Number(row.acceptance_rate) || 0,
        };
      } else if (mode === "passive_suggestion" || mode === "passivesuggestion") {
        byMode.passiveSuggestion = {
          count: Number(row.count) || 0,
          avgScore: Number(row.avg_score) || 0,
          acceptanceRate: Number(row.acceptance_rate) || 0,
        };
      }
    }

    // Threshold efficiency
    const thresholdResult = await db.query(
      `
      SELECT
        COUNT(*) as total_evaluated,
        COUNT(*) FILTER (WHERE decision LIKE 'rejected%' OR decision LIKE 'filtered%') as rejected_by_threshold
      FROM algorithm_traces
      WHERE timestamp >= $1
      `,
      [isoDate]
    );

    const thresholdStats = thresholdResult[0] || {};
    const totalEvaluated = Number(thresholdStats.total_evaluated) || 0;
    const rejectedByThreshold = Number(thresholdStats.rejected_by_threshold) || 0;

    return {
      tracesCount: total,
      acceptanceRate: total > 0 ? (Number(stats.accepted) || 0) / total : 0,
      avgFinalScore: Number(stats.avg_final) || 0,
      avgSemanticScore: Number(stats.avg_semantic) || 0,
      avgGraphScore: Number(stats.avg_graph) || 0,
      byDecision: {
        accepted: Number(stats.accepted) || 0,
        filtered: Number(stats.filtered) || 0,
        rejected: Number(stats.rejected) || 0,
      },
      byTargetType: {
        tool: Number(stats.tools) || 0,
        capability: Number(stats.capabilities) || 0,
      },
      byGraphType: {
        graph: graphStats,
        hypergraph: {
          ...hypergraphStats,
          spectralRelevance,
        },
      },
      thresholdEfficiency: {
        rejectedByThreshold,
        totalEvaluated,
        rejectionRate: totalEvaluated > 0 ? rejectedByThreshold / totalEvaluated : 0,
      },
      scoreDistribution,
      byMode,
    };
  } catch (error) {
    log.warn(`[getAlgorithmStats] Query failed: ${error}`);
    return {
      tracesCount: 0,
      acceptanceRate: 0,
      avgFinalScore: 0,
      avgSemanticScore: 0,
      avgGraphScore: 0,
      byDecision: { accepted: 0, filtered: 0, rejected: 0 },
      byTargetType: { tool: 0, capability: 0 },
      byGraphType: {
        graph: { count: 0, avgScore: 0, acceptanceRate: 0, topSignals: { pagerank: 0, adamicAdar: 0, cooccurrence: 0 } },
        hypergraph: {
          count: 0,
          avgScore: 0,
          acceptanceRate: 0,
          spectralRelevance: {
            withClusterMatch: { count: 0, avgScore: 0, selectedRate: 0 },
            withoutClusterMatch: { count: 0, avgScore: 0, selectedRate: 0 },
          },
        },
      },
      thresholdEfficiency: { rejectedByThreshold: 0, totalEvaluated: 0, rejectionRate: 0 },
      scoreDistribution: { graph: [], hypergraph: [] },
      byMode: {
        activeSearch: { count: 0, avgScore: 0, acceptanceRate: 0 },
        passiveSuggestion: { count: 0, avgScore: 0, acceptanceRate: 0 },
      },
    };
  }
}
