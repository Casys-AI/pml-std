/**
 * Algorithm Tracer Service (Story 7.6 - ADR-039)
 *
 * Provides observability for scoring algorithms (ADR-038).
 * Buffers traces for batch writes and supports async outcome updates.
 *
 * Usage:
 * ```typescript
 * const tracer = new AlgorithmTracer(db);
 * const traceId = await tracer.logTrace({
 *   algorithmMode: "active_search",
 *   targetType: "capability",
 *   signals: { semanticScore: 0.85, graphDensity: 0.02, spectralClusterMatch: true },
 *   params: { alpha: 0.65, reliabilityFactor: 1.0, structuralBoost: 0.0 },
 *   finalScore: 0.78,
 *   thresholdUsed: 0.70,
 *   decision: "accepted"
 * });
 *
 * // Later, when user selects the suggestion:
 * await tracer.updateOutcome(traceId, {
 *   userAction: "selected",
 *   executionSuccess: true,
 *   durationMs: 150
 * });
 * ```
 *
 * @module telemetry/algorithm-tracer
 */

import type { DbClient } from "../db/types.ts";
import { getLogger } from "./logger.ts";

const logger = getLogger("default");

/**
 * Algorithm mode: active_search (intent-based) or passive_suggestion (context-based)
 */
export type AlgorithmMode = "active_search" | "passive_suggestion";

/**
 * Target type: tool or capability
 */
export type TargetType = "tool" | "capability";

/**
 * Decision outcome
 */
export type DecisionType = "accepted" | "rejected_by_threshold" | "filtered_by_reliability";

/**
 * User action outcome
 */
export type UserAction = "selected" | "ignored" | "explicit_rejection";

/**
 * Input signals for algorithm tracing (camelCase - internal TypeScript)
 *
 * Maps to snake_case in DB via JSON serialization
 */
export interface AlgorithmSignals {
  semanticScore?: number;
  graphScore?: number; // Graph relatedness score (Adamic-Adar / direct edges)
  toolsOverlap?: number;
  successRate?: number;
  pagerank?: number;
  cooccurrence?: number;
  graphDensity: number;
  spectralClusterMatch: boolean;
  adamicAdar?: number;
  // ADR-048: Local adaptive alpha signals
  localAlpha?: number;
  alphaAlgorithm?:
    | "embeddings_hybrides"
    | "heat_diffusion"
    | "heat_hierarchical"
    | "bayesian"
    | "none";
  coldStart?: boolean;
}

/**
 * Algorithm parameters used (camelCase - internal TypeScript)
 */
export interface AlgorithmParams {
  alpha: number; // Semantic vs Graph balance
  reliabilityFactor: number; // Impact of success_rate
  structuralBoost: number; // Impact of cluster match
}

/**
 * Outcome data (updated async) - camelCase internal TypeScript
 */
export interface TraceOutcome {
  userAction: UserAction;
  executionSuccess?: boolean;
  durationMs?: number;
}

/**
 * Full algorithm trace record (camelCase - internal TypeScript)
 *
 * DB column mapping (handled in SQL queries):
 * - traceId → trace_id
 * - algorithmMode → algorithm_mode
 * - targetType → target_type
 * - contextHash → context_hash
 * - finalScore → final_score
 * - thresholdUsed → threshold_used
 */
export interface AlgorithmTraceRecord {
  traceId: string;
  timestamp: Date;
  algorithmMode: AlgorithmMode;
  targetType: TargetType;
  intent?: string;
  contextHash?: string;
  signals: AlgorithmSignals;
  params: AlgorithmParams;
  finalScore: number;
  thresholdUsed: number;
  decision: DecisionType;
  outcome?: TraceOutcome;
}

/**
 * Input for logTrace (without auto-generated fields)
 */
export type TraceInput = Omit<AlgorithmTraceRecord, "traceId" | "timestamp">;

/**
 * Algorithm metrics (camelCase - internal TypeScript)
 */
export interface AlgorithmMetrics {
  avgFinalScore: { tool: number; capability: number };
  conversionRate: number;
  spectralRelevance: number;
  decisionDistribution: {
    accepted: number;
    rejectedByThreshold: number;
    filteredByReliability: number;
  };
}

/**
 * Alpha statistics for ADR-048 (camelCase - internal TypeScript)
 */
export interface AlphaStats {
  /** Average alpha by mode */
  avgAlphaByMode: {
    activeSearch: number;
    passiveSuggestion: number;
  };
  /** Alpha distribution histogram (buckets: 0.5-0.6, 0.6-0.7, 0.7-0.8, 0.8-0.9, 0.9-1.0) */
  alphaDistribution: {
    bucket05_06: number;
    bucket06_07: number;
    bucket07_08: number;
    bucket08_09: number;
    bucket09_10: number;
  };
  /** Algorithm usage distribution */
  algorithmDistribution: {
    embeddingsHybrides: number;
    heatDiffusion: number;
    heatHierarchical: number;
    bayesian: number;
    none: number;
  };
  /** Cold start statistics */
  coldStartStats: {
    total: number;
    percentage: number;
  };
  /** Alpha impact on scores (correlation-like metric) */
  alphaImpact: {
    lowAlphaAvgScore: number; // avg score when alpha < 0.7
    highAlphaAvgScore: number; // avg score when alpha >= 0.7
  };
}

/**
 * Escape SQL string (simple apostrophe escaping)
 */
function escapeSql(str: string): string {
  return str.replace(/'/g, "''");
}

/**
 * AlgorithmTracer - Buffered trace logging for algorithm observability
 *
 * Key features:
 * - Buffers up to 100 traces before auto-flush
 * - Non-blocking logTrace() for minimal latency impact
 * - Async outcome updates for user feedback
 * - 7-day retention cleanup
 */
export class AlgorithmTracer {
  private buffer: AlgorithmTraceRecord[] = [];
  private readonly BUFFER_SIZE = 100;
  private readonly FLUSH_INTERVAL_MS = 5000; // Flush every 5 seconds
  private flushPromise: Promise<void> | null = null;
  private flushIntervalId: ReturnType<typeof setInterval> | null = null;

  constructor(private db: DbClient) {
    // Auto-start periodic flush
    this.startPeriodicFlush();
  }

  /**
   * Start periodic flush interval
   */
  private startPeriodicFlush(): void {
    if (this.flushIntervalId) return;
    this.flushIntervalId = setInterval(() => {
      if (this.buffer.length > 0) {
        this.scheduleFlush();
      }
    }, this.FLUSH_INTERVAL_MS);
    // Note: Deno.unrefTimer() could be used if needed, but setInterval
    // with unref behavior isn't critical for this use case
  }

  /**
   * Stop periodic flush and flush remaining buffer
   */
  async stop(): Promise<void> {
    if (this.flushIntervalId) {
      clearInterval(this.flushIntervalId);
      this.flushIntervalId = null;
    }
    await this.flush();
  }

  /**
   * Log an algorithm trace (buffered)
   *
   * This method is designed to be non-blocking (< 1ms).
   * Traces are buffered and flushed in batches.
   *
   * @param record - Trace data (traceId and timestamp auto-generated)
   * @returns Trace ID for later outcome update
   */
  async logTrace(record: TraceInput): Promise<string> {
    const traceId = crypto.randomUUID();
    const trace: AlgorithmTraceRecord = {
      ...record,
      traceId,
      timestamp: new Date(),
    };

    this.buffer.push(trace);

    // Auto-flush when buffer is full
    if (this.buffer.length >= this.BUFFER_SIZE) {
      // Don't await to keep it non-blocking
      this.scheduleFlush();
    }

    logger.debug("Algorithm trace buffered", {
      traceId,
      mode: record.algorithmMode,
      targetType: record.targetType,
      decision: record.decision,
      bufferSize: this.buffer.length,
    });

    return traceId;
  }

  /**
   * Schedule a flush operation (non-blocking)
   */
  private scheduleFlush(): void {
    if (this.flushPromise) return; // Already scheduled

    this.flushPromise = this.flush().finally(() => {
      this.flushPromise = null;
    });
  }

  /**
   * Flush all buffered traces to database
   *
   * Uses batch INSERT for performance (< 50ms for 100 traces).
   * DB columns use snake_case, TypeScript uses camelCase.
   */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const traces = [...this.buffer];
    this.buffer = [];

    const startTime = performance.now();

    try {
      // Build VALUES clause for batch insert
      // Map camelCase TypeScript to snake_case DB columns
      const values = traces.map((t) => {
        const signalsJson = JSON.stringify(t.signals);
        const paramsJson = JSON.stringify(t.params);
        const outcomeJson = t.outcome ? JSON.stringify(t.outcome) : null;

        return `(
          '${t.traceId}',
          '${t.timestamp.toISOString()}',
          '${t.algorithmMode}',
          '${t.targetType}',
          ${t.intent ? `'${escapeSql(t.intent)}'` : "NULL"},
          ${t.contextHash ? `'${escapeSql(t.contextHash)}'` : "NULL"},
          '${signalsJson}'::jsonb,
          '${paramsJson}'::jsonb,
          ${t.finalScore},
          ${t.thresholdUsed},
          '${t.decision}',
          ${outcomeJson ? `'${outcomeJson}'::jsonb` : "NULL"}
        )`;
      });

      // DB columns are snake_case
      await this.db.exec(`
        INSERT INTO algorithm_traces (
          trace_id, timestamp, algorithm_mode, target_type,
          intent, context_hash, signals, params,
          final_score, threshold_used, decision, outcome
        ) VALUES ${values.join(",\n")}
      `);

      const elapsedMs = performance.now() - startTime;
      logger.debug("Algorithm traces flushed", {
        count: traces.length,
        durationMs: elapsedMs.toFixed(1),
      });
    } catch (error) {
      logger.error("Failed to flush algorithm traces", { error, count: traces.length });
      // Re-add traces to buffer for retry (up to buffer limit)
      this.buffer.push(...traces.slice(0, this.BUFFER_SIZE - this.buffer.length));
    }
  }

  /**
   * Update trace outcome (async feedback)
   *
   * Called when user selects/ignores a suggestion.
   *
   * @param traceId - Trace ID to update
   * @param outcome - Outcome data (camelCase TypeScript)
   */
  async updateOutcome(traceId: string, outcome: TraceOutcome): Promise<void> {
    try {
      // First check if trace is still in buffer
      const bufferedIndex = this.buffer.findIndex((t) => t.traceId === traceId);
      if (bufferedIndex >= 0) {
        this.buffer[bufferedIndex].outcome = outcome;
        logger.debug("Updated outcome in buffer", { traceId });
        return;
      }

      // Update in database (outcome column stores camelCase JSON)
      const outcomeJson = JSON.stringify(outcome);
      await this.db.exec(`
        UPDATE algorithm_traces
        SET outcome = '${outcomeJson}'::jsonb
        WHERE trace_id = '${traceId}'
      `);

      logger.debug("Updated trace outcome", { traceId, outcome });
    } catch (error) {
      logger.error("Failed to update trace outcome", { error, traceId });
    }
  }

  /**
   * Cleanup old traces (retention policy)
   *
   * @param olderThanDays - Delete traces older than this (default: 7)
   * @returns Number of deleted traces
   */
  async cleanup(olderThanDays: number = 7): Promise<number> {
    try {
      const result = await this.db.query(`
        DELETE FROM algorithm_traces
        WHERE timestamp < NOW() - INTERVAL '${olderThanDays} days'
        RETURNING trace_id
      `);

      const deletedCount = result.length;
      logger.info("Algorithm traces cleanup", { deletedCount, olderThanDays });
      return deletedCount;
    } catch (error) {
      logger.error("Failed to cleanup algorithm traces", { error });
      return 0;
    }
  }

  /**
   * Get algorithm metrics (AC#7)
   *
   * @param windowHours - Query window (default: 24 hours)
   * @param modeFilter - Optional filter by algorithm mode
   * @returns Aggregated metrics
   */
  async getMetrics(
    windowHours: number = 24,
    modeFilter?: AlgorithmMode,
  ): Promise<AlgorithmMetrics> {
    const modeClause = modeFilter ? `AND algorithm_mode = '${modeFilter}'` : "";

    try {
      // Average final scores by target type (snake_case DB columns)
      const avgScoresResult = await this.db.query(`
        SELECT
          target_type,
          AVG(final_score) as avg_score
        FROM algorithm_traces
        WHERE timestamp > NOW() - INTERVAL '${windowHours} hours'
        ${modeClause}
        GROUP BY target_type
      `);

      const avgFinalScore = {
        tool: 0,
        capability: 0,
      };

      for (const row of avgScoresResult) {
        if (row.target_type === "tool") {
          avgFinalScore.tool = Number(row.avg_score) || 0;
        } else if (row.target_type === "capability") {
          avgFinalScore.capability = Number(row.avg_score) || 0;
        }
      }

      // Conversion rate (accepted / total)
      const conversionResult = await this.db.query(`
        SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE decision = 'accepted') as accepted
        FROM algorithm_traces
        WHERE timestamp > NOW() - INTERVAL '${windowHours} hours'
        ${modeClause}
      `);

      const total = Number(conversionResult[0]?.total) || 0;
      const accepted = Number(conversionResult[0]?.accepted) || 0;
      const conversionRate = total > 0 ? accepted / total : 0;

      // Spectral relevance (avg score when spectralClusterMatch=true)
      // Note: signals JSONB stores camelCase keys from TypeScript
      const spectralResult = await this.db.query(`
        SELECT AVG(final_score) as avg_score
        FROM algorithm_traces
        WHERE timestamp > NOW() - INTERVAL '${windowHours} hours'
        AND (signals->>'spectralClusterMatch')::boolean = true
        ${modeClause}
      `);

      const spectralRelevance = Number(spectralResult[0]?.avg_score) || 0;

      // Decision distribution
      const decisionResult = await this.db.query(`
        SELECT
          decision,
          COUNT(*) as count
        FROM algorithm_traces
        WHERE timestamp > NOW() - INTERVAL '${windowHours} hours'
        ${modeClause}
        GROUP BY decision
      `);

      const decisionDistribution = {
        accepted: 0,
        rejectedByThreshold: 0,
        filteredByReliability: 0,
      };

      for (const row of decisionResult) {
        if (row.decision === "accepted") {
          decisionDistribution.accepted = Number(row.count) || 0;
        } else if (row.decision === "rejected_by_threshold") {
          decisionDistribution.rejectedByThreshold = Number(row.count) || 0;
        } else if (row.decision === "filtered_by_reliability") {
          decisionDistribution.filteredByReliability = Number(row.count) || 0;
        }
      }

      return {
        avgFinalScore,
        conversionRate,
        spectralRelevance,
        decisionDistribution,
      };
    } catch (error) {
      logger.error("Failed to get algorithm metrics", { error });
      return {
        avgFinalScore: { tool: 0, capability: 0 },
        conversionRate: 0,
        spectralRelevance: 0,
        decisionDistribution: {
          accepted: 0,
          rejectedByThreshold: 0,
          filteredByReliability: 0,
        },
      };
    }
  }

  /**
   * Get alpha statistics (ADR-048)
   *
   * Returns statistics about local adaptive alpha usage:
   * - Average alpha by mode (active_search vs passive_suggestion)
   * - Alpha distribution histogram
   * - Algorithm usage distribution
   * - Cold start statistics
   * - Alpha impact on scores
   *
   * @param windowHours - Query window (default: 24 hours)
   * @returns AlphaStats with comprehensive alpha metrics
   */
  async getAlphaStats(windowHours: number = 24): Promise<AlphaStats> {
    const emptyStats: AlphaStats = {
      avgAlphaByMode: { activeSearch: 0, passiveSuggestion: 0 },
      alphaDistribution: {
        bucket05_06: 0,
        bucket06_07: 0,
        bucket07_08: 0,
        bucket08_09: 0,
        bucket09_10: 0,
      },
      algorithmDistribution: {
        embeddingsHybrides: 0,
        heatDiffusion: 0,
        heatHierarchical: 0,
        bayesian: 0,
        none: 0,
      },
      coldStartStats: { total: 0, percentage: 0 },
      alphaImpact: { lowAlphaAvgScore: 0, highAlphaAvgScore: 0 },
    };

    try {
      // 1. Average alpha by mode
      const avgAlphaResult = await this.db.query(`
        SELECT
          algorithm_mode,
          AVG((params->>'alpha')::float) as avg_alpha
        FROM algorithm_traces
        WHERE timestamp > NOW() - INTERVAL '${windowHours} hours'
        AND params->>'alpha' IS NOT NULL
        GROUP BY algorithm_mode
      `);

      const avgAlphaByMode = { activeSearch: 0, passiveSuggestion: 0 };
      for (const row of avgAlphaResult) {
        if (row.algorithm_mode === "active_search") {
          avgAlphaByMode.activeSearch = Number(row.avg_alpha) || 0;
        } else if (row.algorithm_mode === "passive_suggestion") {
          avgAlphaByMode.passiveSuggestion = Number(row.avg_alpha) || 0;
        }
      }

      // 2. Alpha distribution histogram
      const distributionResult = await this.db.query(`
        SELECT
          CASE
            WHEN (params->>'alpha')::float >= 0.5 AND (params->>'alpha')::float < 0.6 THEN 'bucket05_06'
            WHEN (params->>'alpha')::float >= 0.6 AND (params->>'alpha')::float < 0.7 THEN 'bucket06_07'
            WHEN (params->>'alpha')::float >= 0.7 AND (params->>'alpha')::float < 0.8 THEN 'bucket07_08'
            WHEN (params->>'alpha')::float >= 0.8 AND (params->>'alpha')::float < 0.9 THEN 'bucket08_09'
            WHEN (params->>'alpha')::float >= 0.9 AND (params->>'alpha')::float <= 1.0 THEN 'bucket09_10'
          END as bucket,
          COUNT(*) as count
        FROM algorithm_traces
        WHERE timestamp > NOW() - INTERVAL '${windowHours} hours'
        AND params->>'alpha' IS NOT NULL
        GROUP BY bucket
      `);

      const alphaDistribution = {
        bucket05_06: 0,
        bucket06_07: 0,
        bucket07_08: 0,
        bucket08_09: 0,
        bucket09_10: 0,
      };

      for (const row of distributionResult) {
        const bucket = row.bucket as keyof typeof alphaDistribution;
        if (bucket && bucket in alphaDistribution) {
          alphaDistribution[bucket] = Number(row.count) || 0;
        }
      }

      // 3. Algorithm usage distribution
      const algorithmResult = await this.db.query(`
        SELECT
          signals->>'alphaAlgorithm' as algorithm,
          COUNT(*) as count
        FROM algorithm_traces
        WHERE timestamp > NOW() - INTERVAL '${windowHours} hours'
        AND signals->>'alphaAlgorithm' IS NOT NULL
        GROUP BY signals->>'alphaAlgorithm'
      `);

      const algorithmDistribution = {
        embeddingsHybrides: 0,
        heatDiffusion: 0,
        heatHierarchical: 0,
        bayesian: 0,
        none: 0,
      };

      const algorithmMapping: Record<string, keyof typeof algorithmDistribution> = {
        embeddings_hybrides: "embeddingsHybrides",
        heat_diffusion: "heatDiffusion",
        heat_hierarchical: "heatHierarchical",
        bayesian: "bayesian",
        none: "none",
      };

      for (const row of algorithmResult) {
        const key = algorithmMapping[row.algorithm as string];
        if (key) {
          algorithmDistribution[key] = Number(row.count) || 0;
        }
      }

      // 4. Cold start statistics
      const coldStartResult = await this.db.query(`
        SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE (signals->>'coldStart')::boolean = true) as cold_start_count
        FROM algorithm_traces
        WHERE timestamp > NOW() - INTERVAL '${windowHours} hours'
      `);

      const total = Number(coldStartResult[0]?.total) || 0;
      const coldStartCount = Number(coldStartResult[0]?.cold_start_count) || 0;
      const coldStartStats = {
        total: coldStartCount,
        percentage: total > 0 ? (coldStartCount / total) * 100 : 0,
      };

      // 5. Alpha impact on scores
      const alphaImpactResult = await this.db.query(`
        SELECT
          CASE
            WHEN (params->>'alpha')::float < 0.7 THEN 'low'
            ELSE 'high'
          END as alpha_level,
          AVG(final_score) as avg_score
        FROM algorithm_traces
        WHERE timestamp > NOW() - INTERVAL '${windowHours} hours'
        AND params->>'alpha' IS NOT NULL
        GROUP BY alpha_level
      `);

      const alphaImpact = { lowAlphaAvgScore: 0, highAlphaAvgScore: 0 };
      for (const row of alphaImpactResult) {
        if (row.alpha_level === "low") {
          alphaImpact.lowAlphaAvgScore = Number(row.avg_score) || 0;
        } else if (row.alpha_level === "high") {
          alphaImpact.highAlphaAvgScore = Number(row.avg_score) || 0;
        }
      }

      return {
        avgAlphaByMode,
        alphaDistribution,
        algorithmDistribution,
        coldStartStats,
        alphaImpact,
      };
    } catch (error) {
      logger.error("Failed to get alpha stats", { error });
      return emptyStats;
    }
  }

  /**
   * Get buffer size (for testing)
   */
  getBufferSize(): number {
    return this.buffer.length;
  }
}
