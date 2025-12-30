/**
 * Emergence Metrics API Route Handler
 *
 * Handles /api/metrics/emergence endpoint for CAS (Complex Adaptive Systems) metrics.
 * Based on SYMBIOSIS/ODI framework (arxiv:2503.13754) and Holland's CAS theory.
 *
 * Story 9.8: Added scope filtering for per-user dashboard metrics.
 *
 * @module mcp/routing/handlers/emergence
 */

import * as log from "@std/log";
import type { RouteContext } from "../types.ts";
import { errorResponse, jsonResponse } from "../types.ts";
import type {
  EmergenceCurrentMetrics,
  EmergenceMetricsResponse,
  EmergenceTimeRange,
  PhaseTransition,
  Recommendation,
  Trend,
} from "../../../shared/emergence.types.ts";
import {
  filterSnapshotByExecution,
  getExecutedToolIds,
  type Scope,
} from "../../../graphrag/user-usage.ts";
import type { DbClient } from "../../../db/types.ts";
import {
  computeDualEntropy,
  computeSemanticEntropy,
  computeTensorEntropy,
  getEntropyHistory,
  saveEntropySnapshot,
  snapshotToEntropyInput,
  type TensorEntropyResult,
  type EntropyGraphInput,
  type SemanticEntropyResult,
} from "../../../graphrag/algorithms/tensor-entropy.ts";
import type { TensorEntropyMetrics } from "../../../shared/emergence.types.ts";
import { getCachedHyperedges } from "../../../cache/hyperedge-cache.ts";

// Re-export types for consumers of this module
export type {
  EmergenceMetricsResponse,
  EmergenceTimeRange,
  PhaseTransition,
  Recommendation,
  Trend,
} from "../../../shared/emergence.types.ts";

// History for phase transition detection and trend computation (in-memory, resets on restart)
// CR-2: TODO - Persist to database for real historical data across restarts
interface EmergenceSnapshot {
  timestamp: number;
  entropy: number;
  stability: number;
  diversity: number;
  velocity: number;
  accuracy: number;
}
const emergenceHistory: EmergenceSnapshot[] = [];
const MAX_HISTORY_SIZE = 20;

// Previous community assignments for Jaccard stability calculation
let previousCommunities: Map<string, number> = new Map();

/**
 * Compute Jaccard similarity between two community assignments
 * Used for cluster stability: how consistent are community groupings over time?
 * CR-1: Real Jaccard implementation replacing placeholder formula
 */
function computeJaccardStability(
  currentCommunities: Map<string, number>,
  prevCommunities: Map<string, number>,
): number {
  if (prevCommunities.size === 0) return 1.0; // First run, assume stable

  // Count pairs that are in same community in both assignments
  const nodes = Array.from(currentCommunities.keys());
  let sameInBoth = 0;
  let sameInEither = 0;

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const nodeA = nodes[i];
      const nodeB = nodes[j];

      const currSame = currentCommunities.get(nodeA) === currentCommunities.get(nodeB);
      const prevSame = prevCommunities.get(nodeA) === prevCommunities.get(nodeB);

      if (currSame && prevSame) sameInBoth++;
      if (currSame || prevSame) sameInEither++;
    }
  }

  // Jaccard index: intersection / union
  return sameInEither > 0 ? sameInBoth / sameInEither : 1.0;
}

/**
 * Compute Shannon entropy of edge weight distribution
 */
function computeGraphEntropy(edgeWeights: number[]): number {
  if (edgeWeights.length === 0) return 0;

  const total = edgeWeights.reduce((sum, w) => sum + w, 0);
  if (total === 0) return 0;

  const probs = edgeWeights.map((w) => w / total);
  const entropy = -probs.reduce((h, p) => h + (p > 0 ? p * Math.log2(p) : 0), 0);

  // Normalize to 0-1 range
  const maxEntropy = Math.log2(edgeWeights.length);
  return maxEntropy > 0 ? entropy / maxEntropy : 0;
}

/**
 * Determine health classification from dual entropy
 * Story 6.6: Uses dual entropy (structural + semantic) for health
 */
function determineHealthFromDualEntropy(
  dualEntropy: number,
  thresholds: { low: number; high: number },
): "rigid" | "healthy" | "chaotic" {
  if (dualEntropy < thresholds.low) return "rigid";
  if (dualEntropy > thresholds.high) return "chaotic";
  return "healthy";
}

/**
 * Convert TensorEntropyResult to API-friendly TensorEntropyMetrics
 * Story 6.6: Now includes semantic and dual entropy
 */
function toTensorEntropyMetrics(
  result: TensorEntropyResult,
  semanticResult?: SemanticEntropyResult,
  dualEntropy?: number,
): TensorEntropyMetrics {
  // Story 6.6: Use dual entropy for health classification when available
  const health = (dualEntropy !== undefined)
    ? determineHealthFromDualEntropy(dualEntropy, result.adjustedThresholds)
    : result.health;

  return {
    vonNeumann: result.vonNeumannEntropy,
    structural: result.structuralEntropy,
    normalized: result.normalized,
    semantic: semanticResult?.semanticEntropy,
    semanticDiversity: semanticResult?.semanticDiversity,
    dual: dualEntropy,
    health,
    thresholds: {
      low: result.adjustedThresholds.low,
      high: result.adjustedThresholds.high,
    },
    graphSize: {
      nodes: result.meta.nodeCount,
      edges: result.meta.edgeCount,
      hyperedges: result.meta.hyperedgeCount,
    },
    embeddingCount: semanticResult?.stats.nodeCount,
  };
}

/**
 * Compute trend from current vs previous value
 */
function computeTrend(current: number, previous: number): Trend {
  const threshold = 0.05; // 5% change threshold
  const delta = current - previous;

  if (delta > threshold) return "rising";
  if (delta < -threshold) return "falling";
  return "stable";
}

/**
 * Detect phase transition per ODI paper (arxiv:2503.13754)
 */
function detectPhaseTransition(
  history: Array<{ entropy: number }>,
): PhaseTransition {
  if (history.length < 10) {
    return { detected: false, type: "none", confidence: 0, description: "" };
  }

  const recent = history.slice(-5);
  const older = history.slice(-10, -5);

  const recentAvg = recent.reduce((s, m) => s + m.entropy, 0) / recent.length;
  const olderAvg = older.reduce((s, m) => s + m.entropy, 0) / older.length;
  const entropyDelta = recentAvg - olderAvg;

  if (Math.abs(entropyDelta) > 0.2) {
    return {
      detected: true,
      type: entropyDelta > 0 ? "expansion" : "consolidation",
      confidence: Math.min(Math.abs(entropyDelta) / 0.3, 1),
      description: entropyDelta > 0
        ? "System expanding - new patterns emerging"
        : "System consolidating - patterns stabilizing",
    };
  }

  return { detected: false, type: "none", confidence: 0, description: "" };
}

/**
 * Generate recommendations based on metrics
 */
function generateRecommendations(
  metrics: EmergenceCurrentMetrics,
): Recommendation[] {
  const recs: Recommendation[] = [];

  // Entropy warnings
  if (metrics.graphEntropy > 0.7) {
    recs.push({
      type: "warning",
      metric: "graphEntropy",
      message: `Entropy high (${metrics.graphEntropy.toFixed(2)}), system may be chaotic`,
      action: "Consider pruning stale edges or consolidating capabilities",
    });
  }
  if (metrics.graphEntropy < 0.3 && metrics.graphEntropy > 0) {
    recs.push({
      type: "warning",
      metric: "graphEntropy",
      message: `Entropy low (${metrics.graphEntropy.toFixed(2)}), system may be rigid`,
      action: "Encourage exploration of new tool combinations",
    });
  }

  // Stability warnings
  if (metrics.clusterStability < 0.8 && metrics.clusterStability > 0) {
    recs.push({
      type: "warning",
      metric: "clusterStability",
      message: `Cluster stability low (${metrics.clusterStability.toFixed(2)})`,
      action: "Patterns not yet mature, continue observation",
    });
  }

  // Success indicators
  if (metrics.speculationAccuracy > 0.8) {
    recs.push({
      type: "success",
      metric: "speculationAccuracy",
      message: `Speculation accuracy excellent (${(metrics.speculationAccuracy * 100).toFixed(0)}%)`,
    });
  }

  // Diversity info
  if (metrics.capabilityDiversity > 0.7) {
    recs.push({
      type: "success",
      metric: "capabilityDiversity",
      message: `High pattern diversity (${metrics.capabilityDiversity.toFixed(2)})`,
    });
  }

  return recs;
}

/**
 * Fetch real timeseries data from database
 * Uses execution_trace for velocity and algorithm_traces for accuracy
 * Story 9.8: Respects scope filter (user vs system)
 */
async function fetchRealTimeseries(
  db: DbClient | undefined,
  range: EmergenceTimeRange,
  currentEntropy: number,
  currentStability: number,
  scope: Scope,
  userId: string,
): Promise<EmergenceMetricsResponse["timeseries"]> {
  if (!db) {
    // Fallback to current values as flat line
    return generateFlatTimeseries(range, currentEntropy, currentStability, 0);
  }

  const intervalHours = range === "1h" ? 1 : range === "24h" ? 24 : range === "7d" ? 168 : 720;
  const bucketMinutes = range === "1h" ? 5 : range === "24h" ? 60 : range === "7d" ? 360 : 1440;
  const startDate = new Date(Date.now() - intervalHours * 60 * 60 * 1000);

  try {
    // Story 9.8: Filter by user scope
    const userFilter = scope === "user" ? "AND user_id = $3" : "";
    const velocityParams = scope === "user"
      ? [bucketMinutes, startDate.toISOString(), userId]
      : [bucketMinutes, startDate.toISOString()];

    // Velocity: executions per time bucket from execution_trace
    const velocityResult = await db.query(
      `SELECT
        date_trunc('hour', executed_at) +
        (EXTRACT(minute FROM executed_at)::int / $1) * interval '1 minute' * $1 as bucket,
        COUNT(*) as count
       FROM execution_trace
       WHERE executed_at >= $2 ${userFilter}
       GROUP BY bucket
       ORDER BY bucket`,
      velocityParams,
    );

    // Stability proxy: algorithm acceptance rate per bucket from algorithm_traces
    // Note: algorithm_traces doesn't have user_id, so we use all data for now
    const stabilityResult = await db.query(
      `SELECT
        date_trunc('hour', timestamp) +
        (EXTRACT(minute FROM timestamp)::int / $1) * interval '1 minute' * $1 as bucket,
        COUNT(*) FILTER (WHERE decision = 'accepted')::float / NULLIF(COUNT(*), 0) as acceptance_rate
       FROM algorithm_traces
       WHERE timestamp >= $2
       GROUP BY bucket
       ORDER BY bucket`,
      [bucketMinutes, startDate.toISOString()],
    );

    // Build timeseries arrays
    const velocity = velocityResult.map((row: Record<string, unknown>) => ({
      timestamp: row.bucket ? new Date(row.bucket as string).toISOString() : new Date().toISOString(),
      value: Number(row.count) || 0,
    }));

    const stability = stabilityResult.map((row: Record<string, unknown>) => ({
      timestamp: row.bucket ? new Date(row.bucket as string).toISOString() : new Date().toISOString(),
      value: Number(row.acceptance_rate) || 0,
    }));

    // Entropy: fetch from entropy_history table
    // Story 9.8: Filter by user if scope is "user"
    // Story 6.6: Now includes semantic and dual entropy timeseries
    const entropyHistory = await getEntropyHistory(db, {
      limit: 100,
      userId: scope === "user" ? userId : undefined,
      since: startDate,
    });

    // Convert to timeseries format (reverse to chronological order)
    let entropy: Array<{ timestamp: string; value: number }>;
    let semanticEntropy: Array<{ timestamp: string; value: number }> | undefined;
    let dualEntropy: Array<{ timestamp: string; value: number }> | undefined;

    if (entropyHistory.length > 0) {
      const chronological = entropyHistory.reverse(); // oldest first

      // Primary entropy: use normalized (structural) entropy
      entropy = chronological.map((record) => ({
        timestamp: record.recordedAt.toISOString(),
        value: record.normalizedEntropy,
      }));

      // Story 6.6: Semantic entropy (filter out undefined values)
      const semanticPoints = chronological
        .filter((record) => record.semanticEntropy !== undefined && record.semanticEntropy !== null)
        .map((record) => ({
          timestamp: record.recordedAt.toISOString(),
          value: record.semanticEntropy!,
        }));
      if (semanticPoints.length > 0) {
        semanticEntropy = semanticPoints;
      }

      // Story 6.6: Dual entropy (filter out undefined values)
      const dualPoints = chronological
        .filter((record) => record.dualEntropy !== undefined && record.dualEntropy !== null)
        .map((record) => ({
          timestamp: record.recordedAt.toISOString(),
          value: record.dualEntropy!,
        }));
      if (dualPoints.length > 0) {
        dualEntropy = dualPoints;
      }

      log.debug(
        `[fetchRealTimeseries] Found ${entropyHistory.length} entropy records ` +
        `(semantic: ${semanticPoints.length}, dual: ${dualPoints.length})`,
      );
    } else {
      // Fallback to current value if no history
      entropy = velocity.length > 0
        ? velocity.map((v) => ({ timestamp: v.timestamp, value: currentEntropy }))
        : [{ timestamp: new Date().toISOString(), value: currentEntropy }];
      log.debug(`[fetchRealTimeseries] No entropy history, using current value`);
    }

    return { entropy, semanticEntropy, dualEntropy, stability, velocity };
  } catch (error) {
    log.warn(`[fetchRealTimeseries] Query failed: ${error}`);
    return generateFlatTimeseries(range, currentEntropy, currentStability, 0);
  }
}

/**
 * Generate flat timeseries (fallback when no DB or no data)
 */
function generateFlatTimeseries(
  range: EmergenceTimeRange,
  currentEntropy: number,
  currentStability: number,
  currentVelocity: number,
): EmergenceMetricsResponse["timeseries"] {
  const now = Date.now();
  const points = range === "1h" ? 12 : range === "24h" ? 24 : range === "7d" ? 28 : 30;
  const interval =
    range === "1h"
      ? 5 * 60 * 1000
      : range === "24h"
        ? 60 * 60 * 1000
        : range === "7d"
          ? 6 * 60 * 60 * 1000
          : 24 * 60 * 60 * 1000;

  const entropy: Array<{ timestamp: string; value: number }> = [];
  const stability: Array<{ timestamp: string; value: number }> = [];
  const velocity: Array<{ timestamp: string; value: number }> = [];

  for (let i = points - 1; i >= 0; i--) {
    const timestamp = new Date(now - i * interval).toISOString();
    entropy.push({ timestamp, value: currentEntropy });
    stability.push({ timestamp, value: currentStability });
    velocity.push({ timestamp, value: currentVelocity });
  }

  return { entropy, stability, velocity };
}

/**
 * GET /api/metrics/emergence
 *
 * Returns CAS emergence metrics for the specified time range
 *
 * Query params:
 * - range: Time range (1h, 24h, 7d, 30d) (default: 24h)
 * - scope: Scope filter "user" | "system" (default: user) (Story 9.8)
 */
export async function handleEmergenceMetrics(
  _req: Request,
  url: URL,
  ctx: RouteContext,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  try {
    const range = (url.searchParams.get("range") || "24h") as EmergenceTimeRange;
    const scope = (url.searchParams.get("scope") || "user") as Scope;

    // Validate range parameter
    if (!["1h", "24h", "7d", "30d"].includes(range)) {
      return errorResponse(
        `Invalid range parameter: ${range}. Must be one of: 1h, 24h, 7d, 30d`,
        400,
        corsHeaders,
      );
    }

    // Validate scope parameter (Story 9.8 AC #7)
    if (!["user", "system"].includes(scope)) {
      return errorResponse(
        `Invalid scope parameter: ${scope}. Must be one of: user, system`,
        400,
        corsHeaders,
      );
    }

    // Get base metrics from graph engine
    const baseMetrics = await ctx.graphEngine.getMetrics(
      range === "30d" ? "7d" : range,
    );

    // Story 9.8: userId for per-user filtering
    const userId = ctx.userId || "local";

    // Get full graph snapshot
    const fullSnapshot = ctx.graphEngine.getGraphSnapshot();

    // Story 9.8: Filter snapshot by execution scope
    let snapshot = fullSnapshot;
    if (ctx.db) {
      const executedToolIds = await getExecutedToolIds(ctx.db, scope, userId);

      // Only filter if we have executed tools (avoid empty graph)
      if (executedToolIds.size > 0) {
        snapshot = filterSnapshotByExecution(fullSnapshot, executedToolIds);
        log.debug(`[emergence] Scope=${scope}, userId=${userId}: filtered ${fullSnapshot.nodes.length} → ${snapshot.nodes.length} nodes`);
      } else {
        log.debug(`[emergence] Scope=${scope}, userId=${userId}: no executed tools found, using full snapshot`);
      }
    }

    // Compute emergence metrics using Tensor Entropy (Chen & Rajapakse 2020)
    // This replaces the naive Shannon entropy which always gives ~1.0 for large graphs
    const baseInput = snapshotToEntropyInput(snapshot);

    // Inject cached hyperedges from KV (populated by SHGAT at startup)
    const cachedHyperedges = await getCachedHyperedges();
    const entropyInput: EntropyGraphInput = {
      ...baseInput,
      hyperedges: cachedHyperedges.length > 0
        ? cachedHyperedges.map((he) => ({
            id: he.capabilityId,
            members: he.members,
            weight: 1,
          }))
        : undefined,
    };
    const tensorEntropyResult = computeTensorEntropy(entropyInput);

    // Story 6.6: Compute semantic entropy from tool + capability embeddings
    let semanticEntropyResult: SemanticEntropyResult | undefined;
    if (ctx.db && snapshot.nodes.length > 0) {
      try {
        const embeddings = new Map<string, number[]>();
        const nodeIds = snapshot.nodes.map((n) => n.id);

        // 1. Fetch tool embeddings
        const toolEmbeddings = await ctx.db.query(
          `SELECT tool_id, embedding
           FROM tool_embedding
           WHERE tool_id = ANY($1)
           AND embedding IS NOT NULL`,
          [nodeIds],
        );

        for (const row of toolEmbeddings) {
          const toolId = row.tool_id as string;
          let embedding = row.embedding;
          if (typeof embedding === "string") {
            try { embedding = JSON.parse(embedding); } catch { continue; }
          }
          if (Array.isArray(embedding)) {
            embeddings.set(toolId, embedding);
          }
        }

        // 2. Fetch capability embeddings (from workflow_pattern)
        // Capability IDs in graph are prefixed with "capability:"
        const capabilityIds = nodeIds
          .filter((id) => id.startsWith("capability:"))
          .map((id) => id.replace("capability:", ""));

        if (capabilityIds.length > 0) {
          const capEmbeddings = await ctx.db.query(
            `SELECT pattern_id, intent_embedding
             FROM workflow_pattern
             WHERE pattern_id = ANY($1)
             AND intent_embedding IS NOT NULL`,
            [capabilityIds],
          );

          for (const row of capEmbeddings) {
            const capId = `capability:${row.pattern_id as string}`;
            let embedding = row.intent_embedding;
            if (typeof embedding === "string") {
              try { embedding = JSON.parse(embedding); } catch { continue; }
            }
            if (Array.isArray(embedding)) {
              embeddings.set(capId, embedding);
            }
          }
        }

        if (embeddings.size >= 2) {
          semanticEntropyResult = computeSemanticEntropy(embeddings);
          log.debug(
            `[emergence] Semantic entropy: ${semanticEntropyResult.semanticEntropy.toFixed(3)}, ` +
            `diversity=${semanticEntropyResult.semanticDiversity.toFixed(3)}, ` +
            `embeddings=${embeddings.size}/${snapshot.nodes.length} (tools+caps)`,
          );
        }
      } catch (err) {
        log.warn(`[emergence] Failed to compute semantic entropy: ${err}`);
      }
    }

    // Use normalized structural entropy as primary metric (Story 6.6)
    // This is more meaningful for sparse graphs than Von Neumann
    const graphEntropy = tensorEntropyResult.normalized;

    // Compute dual entropy if semantic is available
    const dualEntropy = semanticEntropyResult
      ? computeDualEntropy(tensorEntropyResult.normalized, semanticEntropyResult.semanticEntropy)
      : tensorEntropyResult.normalized;

    log.debug(
      `[emergence] Entropy: structural=${tensorEntropyResult.structuralEntropy.toFixed(3)}, ` +
        `VN=${tensorEntropyResult.vonNeumannEntropy.toFixed(3)}, ` +
        `normalized=${tensorEntropyResult.normalized.toFixed(3)}, ` +
        `semantic=${semanticEntropyResult?.semanticEntropy.toFixed(3) ?? "N/A"}, ` +
        `dual=${dualEntropy.toFixed(3)}, health=${tensorEntropyResult.health}`,
    );

    // CR-1: Real cluster stability using Jaccard similarity
    // Build current community assignments from snapshot
    const currentCommunities = new Map<string, number>();
    if (snapshot.nodes && Array.isArray(snapshot.nodes)) {
      for (const node of snapshot.nodes) {
        // communityId is string, convert to number for stability calculation
        if (node.id && node.communityId) {
          const communityNum = parseInt(node.communityId, 10);
          if (!isNaN(communityNum)) {
            currentCommunities.set(node.id, communityNum);
          }
        }
      }
    }

    // If no communities detected, use a hash-based fallback (node ID modulo)
    // This provides some baseline stability tracking even without Louvain
    if (currentCommunities.size === 0 && snapshot.nodes.length > 0) {
      log.debug(`[emergence] No communityId in snapshot, using hash-based fallback`);
      for (const node of snapshot.nodes) {
        if (node.id) {
          // Simple hash: sum of char codes modulo 5 (creates ~5 pseudo-communities)
          const hash = node.id.split("").reduce((sum, c) => sum + c.charCodeAt(0), 0) % 5;
          currentCommunities.set(node.id, hash);
        }
      }
    }

    const clusterStability = computeJaccardStability(currentCommunities, previousCommunities);
    log.debug(
      `[emergence] Stability: current=${currentCommunities.size} nodes, ` +
        `previous=${previousCommunities.size} nodes, jaccard=${clusterStability.toFixed(3)}`,
    );
    // Update previous for next call
    previousCommunities = currentCommunities;

    const capabilityCount = baseMetrics.current?.capabilitiesCount || 0;

    // Compute real diversity: Shannon entropy of community size distribution
    // High diversity = nodes spread across many communities
    // Low diversity = most nodes in one community
    const communitySizes = new Map<number, number>();
    for (const communityId of currentCommunities.values()) {
      communitySizes.set(communityId, (communitySizes.get(communityId) || 0) + 1);
    }
    const totalNodes = currentCommunities.size || 1;
    let capabilityDiversity = 0;
    if (communitySizes.size > 1) {
      // Shannon entropy normalized by max entropy (log2 of community count)
      let entropy = 0;
      for (const size of communitySizes.values()) {
        const p = size / totalNodes;
        if (p > 0) entropy -= p * Math.log2(p);
      }
      const maxEntropy = Math.log2(communitySizes.size);
      capabilityDiversity = maxEntropy > 0 ? entropy / maxEntropy : 0;
    } else if (communitySizes.size === 1) {
      // Single community = no diversity
      capabilityDiversity = 0;
    }

    const learningVelocity = baseMetrics.period?.newEdgesCreated || 0;
    const speculationAccuracy = baseMetrics.algorithm?.acceptanceRate || 0;
    const thresholdConvergence = baseMetrics.current?.adaptiveAlpha || 0.5;
    // CR-7: TODO - Compute from workflow_executions table when available
    // Currently using default value until parallel workflow tracking is implemented
    const parallelizationRate = 0.3;

    // Build tensor entropy metrics for API response (Story 6.6: includes semantic/dual)
    const tensorEntropyMetrics = toTensorEntropyMetrics(
      tensorEntropyResult,
      semanticEntropyResult,
      dualEntropy,
    );

    const currentMetrics = {
      graphEntropy,
      clusterStability,
      capabilityDiversity,
      learningVelocity,
      speculationAccuracy,
      thresholdConvergence,
      capabilityCount,
      parallelizationRate,
      tensorEntropy: tensorEntropyMetrics,
    };

    // Update history for phase transition detection and trend computation
    // CR-4: Store all metrics for comprehensive trend analysis
    emergenceHistory.push({
      timestamp: Date.now(),
      entropy: graphEntropy,
      stability: clusterStability,
      diversity: capabilityDiversity,
      velocity: learningVelocity,
      accuracy: speculationAccuracy,
    });
    if (emergenceHistory.length > MAX_HISTORY_SIZE) {
      emergenceHistory.shift();
    }

    // CR-4: Compute trends for ALL 5 main metrics (not just 2)
    const prevEntry = emergenceHistory[emergenceHistory.length - 2];
    const trends = {
      graphEntropy: computeTrend(graphEntropy, prevEntry?.entropy ?? graphEntropy),
      clusterStability: computeTrend(clusterStability, prevEntry?.stability ?? clusterStability),
      capabilityDiversity: computeTrend(capabilityDiversity, prevEntry?.diversity ?? capabilityDiversity),
      learningVelocity: computeTrend(learningVelocity, prevEntry?.velocity ?? learningVelocity),
      speculationAccuracy: computeTrend(speculationAccuracy, prevEntry?.accuracy ?? speculationAccuracy),
    };

    const phaseTransition = detectPhaseTransition(emergenceHistory);
    const recommendations = generateRecommendations(currentMetrics);

    // Fetch real timeseries from database (execution_trace, algorithm_traces)
    // Story 9.8: Pass scope and userId for per-user filtering
    const timeseries = await fetchRealTimeseries(
      ctx.db,
      range,
      graphEntropy,
      clusterStability,
      scope,
      userId,
    );

    // Use size-adjusted thresholds from tensor entropy
    const entropyThresholds = tensorEntropyResult.adjustedThresholds;

    const response: EmergenceMetricsResponse = {
      current: currentMetrics,
      trends,
      phaseTransition,
      recommendations,
      timeseries,
      thresholds: {
        entropyHealthy: [entropyThresholds.low, entropyThresholds.high],
        stabilityHealthy: 0.8,
        diversityHealthy: 0.5,
        isAdjusted: true,
      },
    };

    // Save entropy snapshot to history (fire-and-forget, don't block response)
    // Story 6.6: Now saves semantic entropy result for timeseries
    if (ctx.db) {
      saveEntropySnapshot(ctx.db, tensorEntropyResult, semanticEntropyResult, userId).catch((err) => {
        log.warn(`[emergence] Failed to save entropy snapshot: ${err}`);
      });
    }

    return jsonResponse(response, 200, corsHeaders);
  } catch (error) {
    log.error(`Failed to get emergence metrics: ${error}`);
    return errorResponse(`Failed to get emergence metrics: ${error}`, 500, corsHeaders);
  }
}

/**
 * Route /api/metrics/emergence requests
 */
export async function handleEmergenceRoutes(
  req: Request,
  url: URL,
  ctx: RouteContext,
  corsHeaders: Record<string, string>,
): Promise<Response | null> {
  if (url.pathname === "/api/metrics/emergence" && req.method === "GET") {
    return await handleEmergenceMetrics(req, url, ctx, corsHeaders);
  }
  return null;
}

// Export pure functions for testing
export const _internals = {
  computeGraphEntropy,
  computeJaccardStability,
  computeTrend,
  detectPhaseTransition,
  generateRecommendations,
};
