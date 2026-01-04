/**
 * Algorithm API - Unified logic for algorithm feedback and statistics
 *
 * Core business logic for algorithm tracing, moved from Fresh routes.
 * Fresh routes become thin wrappers calling these functions.
 * Emits OTEL spans for observability.
 *
 * @module api/algorithm
 */

import { getDb } from "../db/mod.ts";
import {
  AlgorithmTracer,
  type UserAction,
} from "../telemetry/algorithm-tracer.ts";
import { recordAlgorithmDecision } from "../telemetry/otel.ts";

// ============================================================================
// Types
// ============================================================================

export interface FeedbackRequest {
  traceId: string;
  userAction: UserAction;
  executionSuccess?: boolean;
  durationMs?: number;
}

export interface FeedbackResult {
  success: boolean;
  message: string;
  traceId: string;
}

export interface AlphaStatsResult {
  success: boolean;
  windowHours: number;
  stats: Awaited<ReturnType<AlgorithmTracer["getAlphaStats"]>>;
}

export interface TracesResult {
  success: boolean;
  traces: unknown[];
  count: number;
}

export interface MetricsResult {
  success: boolean;
  windowHours: number;
  mode: string;
  metrics: Awaited<ReturnType<AlgorithmTracer["getMetrics"]>>;
}

// ============================================================================
// Validation
// ============================================================================

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_USER_ACTIONS: UserAction[] = [
  "selected",
  "ignored",
  "explicit_rejection",
];
const VALID_MODES = ["active_search", "passive_suggestion"] as const;

export function isValidUserAction(action: unknown): action is UserAction {
  return VALID_USER_ACTIONS.includes(action as UserAction);
}

export function isValidMode(
  mode: unknown,
): mode is (typeof VALID_MODES)[number] {
  return VALID_MODES.includes(mode as (typeof VALID_MODES)[number]);
}

export function isValidUUID(uuid: string): boolean {
  return UUID_REGEX.test(uuid);
}

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Record algorithm feedback (user action on suggestion)
 *
 * Emits OTEL span for observability.
 */
export async function recordFeedback(
  request: FeedbackRequest,
): Promise<FeedbackResult> {
  const db = await getDb();
  const tracer = new AlgorithmTracer(db);

  // Emit OTEL span for feedback (fire-and-forget)
  recordAlgorithmDecision("feedback", {
    "algorithm.name": "feedback",
    "algorithm.mode": "user_feedback",
    "algorithm.intent": `User action: ${request.userAction}`,
    "algorithm.target_type": "trace",
    "algorithm.final_score": request.executionSuccess ? 1 : 0,
    "algorithm.threshold": 0,
    "algorithm.decision": request.userAction,
    "algorithm.target_id": request.traceId,
  }, request.userAction === "selected");

  await tracer.updateOutcome(request.traceId, {
    userAction: request.userAction,
    executionSuccess: request.executionSuccess,
    durationMs: request.durationMs,
  });

  return {
    success: true,
    message: "Feedback recorded",
    traceId: request.traceId,
  };
}

/**
 * Get alpha statistics for a time window
 */
export async function getAlphaStats(
  windowHours: number,
): Promise<AlphaStatsResult> {
  const db = await getDb();
  const tracer = new AlgorithmTracer(db);

  const stats = await tracer.getAlphaStats(windowHours);

  return {
    success: true,
    windowHours,
    stats,
  };
}

/**
 * Get algorithm metrics for a time window
 */
export async function getAlgorithmMetrics(
  windowHours: number,
  mode?: (typeof VALID_MODES)[number],
): Promise<MetricsResult> {
  const db = await getDb();
  const tracer = new AlgorithmTracer(db);

  const metrics = await tracer.getMetrics(windowHours, mode);

  return {
    success: true,
    windowHours,
    mode: mode || "all",
    metrics,
  };
}

/**
 * Get recent algorithm traces
 */
export async function getRecentTraces(
  limit: number,
  since?: string,
): Promise<TracesResult> {
  const db = await getDb();
  const tracer = new AlgorithmTracer(db);

  const traces = await tracer.getRecentTraces(limit, since);

  // Map to snake_case for external API
  const mappedTraces = traces.map((t) => ({
    trace_id: t.traceId,
    timestamp: t.timestamp.toISOString(),
    correlation_id: t.correlationId ?? null,
    algorithm_name: t.algorithmName ?? null,
    algorithm_mode: t.algorithmMode,
    target_type: t.targetType,
    intent: t.intent,
    context_hash: t.contextHash,
    signals: {
      semantic_score: t.signals.semanticScore,
      graph_score: t.signals.graphScore,
      success_rate: t.signals.successRate,
      pagerank: t.signals.pagerank,
      graph_density: t.signals.graphDensity,
      spectral_cluster_match: t.signals.spectralClusterMatch,
      adamic_adar: t.signals.adamicAdar,
      local_alpha: t.signals.localAlpha,
      alpha_algorithm: t.signals.alphaAlgorithm,
      cold_start: t.signals.coldStart,
      num_heads: t.signals.numHeads,
      avg_head_score: t.signals.avgHeadScore,
      head_scores: t.signals.headScores,
      head_weights: t.signals.headWeights,
      recursive_contribution: t.signals.recursiveContribution,
      feature_contrib_semantic: t.signals.featureContribSemantic,
      feature_contrib_structure: t.signals.featureContribStructure,
      feature_contrib_temporal: t.signals.featureContribTemporal,
      feature_contrib_reliability: t.signals.featureContribReliability,
      target_id: t.signals.targetId,
      target_name: t.signals.targetName,
      target_success_rate: t.signals.targetSuccessRate,
      target_usage_count: t.signals.targetUsageCount,
      reliability_mult: t.signals.reliabilityMult,
      path_found: t.signals.pathFound,
      path_length: t.signals.pathLength,
      path_weight: t.signals.pathWeight,
      pure: t.signals.pure,
    },
    params: {
      alpha: t.params.alpha,
      reliability_factor: t.params.reliabilityFactor,
      structural_boost: t.params.structuralBoost,
    },
    final_score: t.finalScore,
    threshold_used: t.thresholdUsed,
    decision: t.decision,
    outcome: t.outcome
      ? {
        user_action: t.outcome.userAction,
        execution_success: t.outcome.executionSuccess,
        duration_ms: t.outcome.durationMs,
      }
      : null,
  }));

  return {
    success: true,
    traces: mappedTraces,
    count: mappedTraces.length,
  };
}
