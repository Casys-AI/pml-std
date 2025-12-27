/**
 * Trace Feature Extractor (Story 11.8)
 *
 * Extracts rich TraceFeatures from execution_trace table for SHGAT v2.
 * Provides statistics computed from historical execution data:
 * - Success patterns (overall, contextual, intent-similar)
 * - Co-occurrence patterns (sequence position, tool following)
 * - Temporal patterns (recency, frequency, duration)
 * - Error patterns (recovery rate)
 * - Path patterns (length to success, variance)
 *
 * Features caching layer for performance:
 * - In-memory LRU cache with configurable TTL
 * - Batch prefetching for common tools
 *
 * @module graphrag/algorithms/trace-feature-extractor
 */

import type { PGliteClient, Row } from "../../db/client.ts";
import { DEFAULT_TRACE_STATS, type TraceFeatures, type TraceStats } from "./shgat.ts";
import { ERROR_TYPES } from "../../db/migrations/024_error_type_column.ts";
import { getLogger } from "../../telemetry/logger.ts";

const logger = getLogger("default");

// ============================================================================
// Configuration
// ============================================================================

/**
 * Configuration for trace feature extraction
 */
export interface TraceFeatureExtractorConfig {
  /** Cache TTL in milliseconds (default: 5 minutes) */
  cacheTtlMs: number;
  /** Maximum cache entries (default: 1000) */
  maxCacheEntries: number;
  /** Minimum traces needed for reliable statistics (default: 5) */
  minTracesForStats: number;
  /** Recency decay half-life in hours (default: 24) */
  recencyHalfLifeHours: number;
  /** Maximum context tools to consider (default: 10) */
  maxContextTools: number;
}

export const DEFAULT_EXTRACTOR_CONFIG: TraceFeatureExtractorConfig = {
  cacheTtlMs: 5 * 60 * 1000, // 5 minutes
  maxCacheEntries: 1000,
  minTracesForStats: 5,
  recencyHalfLifeHours: 24,
  maxContextTools: 10,
};

// ============================================================================
// Cache Types
// ============================================================================

interface CacheEntry {
  stats: TraceStats;
  timestamp: number;
  traceCount: number;
}

// ============================================================================
// Main Class
// ============================================================================

/**
 * TraceFeatureExtractor - Extracts trace statistics from execution history
 *
 * Queries execution_trace table to compute per-tool statistics for SHGAT v2.
 * Implements in-memory caching with TTL to avoid repeated expensive queries.
 *
 * @example
 * ```typescript
 * const extractor = new TraceFeatureExtractor(db);
 *
 * // Extract features for a tool
 * const features = await extractor.extractTraceFeatures(
 *   toolId,
 *   intentEmbedding,
 *   contextToolIds
 * );
 *
 * // Batch extract for multiple tools
 * const batchFeatures = await extractor.batchExtractTraceStats(toolIds);
 * ```
 */
export class TraceFeatureExtractor {
  private cache: Map<string, CacheEntry> = new Map();
  private config: TraceFeatureExtractorConfig;
  private globalStats: {
    maxUsageCount: number;
    maxDurationMs: number;
    lastUpdated: number;
  } | null = null;

  // Cache hit/miss tracking for observability
  private cacheHits = 0;
  private cacheMisses = 0;

  constructor(
    private db: DbClient,
    config: Partial<TraceFeatureExtractorConfig> = {},
  ) {
    this.config = { ...DEFAULT_EXTRACTOR_CONFIG, ...config };
    logger.debug("TraceFeatureExtractor initialized", { config: this.config });
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Extract complete TraceFeatures for a tool/capability
   *
   * Combines:
   * - Provided embeddings (intent, candidate, context)
   * - Computed trace statistics from execution history
   *
   * @param toolId - Tool or capability ID to extract features for
   * @param intentEmbedding - Current user intent embedding
   * @param candidateEmbedding - Tool/capability embedding
   * @param contextToolIds - Recent tools in current session
   * @param contextEmbeddings - Embeddings of context tools (optional)
   * @returns Complete TraceFeatures for SHGAT v2
   */
  async extractTraceFeatures(
    toolId: string,
    intentEmbedding: number[],
    candidateEmbedding: number[],
    contextToolIds: string[] = [],
    contextEmbeddings: number[][] = [],
  ): Promise<TraceFeatures> {
    // Get trace stats (from cache or compute)
    const traceStats = await this.getTraceStats(toolId, contextToolIds);

    // Compute context aggregated embedding (mean pooling)
    const contextAggregated = this.meanPool(
      contextEmbeddings.length > 0
        ? contextEmbeddings
        : [new Array(intentEmbedding.length).fill(0)],
    );

    return {
      intentEmbedding,
      candidateEmbedding,
      contextEmbeddings,
      contextAggregated,
      traceStats,
    };
  }

  /**
   * Get trace statistics for a tool/capability
   *
   * Returns cached stats if available and fresh, otherwise computes from DB.
   * Handles cold start by returning DEFAULT_TRACE_STATS if no history.
   *
   * @param toolId - Tool or capability ID
   * @param contextToolIds - Context tools for contextual metrics
   * @returns TraceStats with all computed metrics
   */
  async getTraceStats(
    toolId: string,
    contextToolIds: string[] = [],
  ): Promise<TraceStats> {
    // Check cache first
    const cached = this.getCachedStats(toolId);
    if (cached) {
      return cached;
    }

    // Compute from database
    const stats = await this.computeTraceStats(toolId, contextToolIds);

    // Cache the result
    this.setCachedStats(toolId, stats);

    return stats;
  }

  /**
   * Batch extract trace stats for multiple tools
   *
   * More efficient than individual calls - uses single queries with IN clauses.
   *
   * @param toolIds - Array of tool IDs to extract
   * @returns Map of toolId → TraceStats
   */
  async batchExtractTraceStats(toolIds: string[]): Promise<Map<string, TraceStats>> {
    const result = new Map<string, TraceStats>();
    const uncachedIds: string[] = [];

    // Check cache first
    for (const toolId of toolIds) {
      const cached = this.getCachedStats(toolId);
      if (cached) {
        result.set(toolId, cached);
      } else {
        uncachedIds.push(toolId);
      }
    }

    // Batch compute uncached
    if (uncachedIds.length > 0) {
      const batchStats = await this.computeBatchTraceStats(uncachedIds);
      for (const [toolId, stats] of batchStats) {
        result.set(toolId, stats);
        this.setCachedStats(toolId, stats);
      }
    }

    return result;
  }

  /**
   * Invalidate cache for a tool (call after new trace saved)
   */
  invalidateCache(toolId: string): void {
    this.cache.delete(toolId);
    this.globalStats = null; // Reset global stats too
  }

  /**
   * Clear all cached stats
   */
  clearCache(): void {
    this.cache.clear();
    this.globalStats = null;
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; hitRate: number; hits: number; misses: number } {
    const total = this.cacheHits + this.cacheMisses;
    return {
      size: this.cache.size,
      hitRate: total > 0 ? this.cacheHits / total : 0,
      hits: this.cacheHits,
      misses: this.cacheMisses,
    };
  }

  /**
   * Reset cache statistics (for testing/benchmarking)
   */
  resetCacheStats(): void {
    this.cacheHits = 0;
    this.cacheMisses = 0;
  }

  // ==========================================================================
  // Private: Statistics Computation
  // ==========================================================================

  /**
   * Compute all trace statistics for a single tool
   */
  private async computeTraceStats(
    toolId: string,
    contextToolIds: string[],
  ): Promise<TraceStats> {
    try {
      // Ensure we have global stats for normalization
      await this.ensureGlobalStats();

      // Query all metrics in parallel
      const [
        basicStats,
        contextualStats,
        sequenceStats,
        temporalStats,
        pathStats,
        errorTypeStats,
      ] = await Promise.all([
        this.queryBasicStats(toolId),
        this.queryContextualStats(toolId, contextToolIds),
        this.querySequenceStats(toolId),
        this.queryTemporalStats(toolId),
        this.queryPathStats(toolId),
        this.queryErrorTypeAffinity(toolId),
      ]);

      // Merge results with defaults for missing values
      return {
        historicalSuccessRate: basicStats.successRate ?? DEFAULT_TRACE_STATS.historicalSuccessRate,
        contextualSuccessRate: contextualStats.successRate ??
          DEFAULT_TRACE_STATS.contextualSuccessRate,
        intentSimilarSuccessRate: DEFAULT_TRACE_STATS.intentSimilarSuccessRate, // Computed separately when intentEmbedding provided
        cooccurrenceWithContext: contextualStats.cooccurrence ??
          DEFAULT_TRACE_STATS.cooccurrenceWithContext,
        sequencePosition: sequenceStats.avgPosition ?? DEFAULT_TRACE_STATS.sequencePosition,
        recencyScore: temporalStats.recency ?? DEFAULT_TRACE_STATS.recencyScore,
        usageFrequency: temporalStats.frequency ?? DEFAULT_TRACE_STATS.usageFrequency,
        avgExecutionTime: temporalStats.avgDuration ?? DEFAULT_TRACE_STATS.avgExecutionTime,
        errorRecoveryRate: contextualStats.errorRecovery ?? DEFAULT_TRACE_STATS.errorRecoveryRate,
        avgPathLengthToSuccess: pathStats.avgLength ?? DEFAULT_TRACE_STATS.avgPathLengthToSuccess,
        pathVariance: pathStats.variance ?? DEFAULT_TRACE_STATS.pathVariance,
        errorTypeAffinity: errorTypeStats,
      };
    } catch (error) {
      logger.warn("Failed to compute trace stats, using defaults", { toolId, error });
      return { ...DEFAULT_TRACE_STATS };
    }
  }

  /**
   * Query basic success rate statistics
   */
  private async queryBasicStats(
    toolId: string,
  ): Promise<{ successRate: number | null; count: number }> {
    const result = await this.db.queryOne(
      `
      SELECT
        AVG(CASE WHEN success THEN 1.0 ELSE 0.0 END) as success_rate,
        COUNT(*) as trace_count
      FROM execution_trace
      WHERE $1 = ANY(executed_path)
    `,
      [toolId],
    ) as Row | null;

    const count = Number(result?.trace_count ?? 0);
    if (count < this.config.minTracesForStats) {
      return { successRate: null, count };
    }

    return {
      successRate: Number(result?.success_rate ?? 0.5),
      count,
    };
  }

  /**
   * Query contextual statistics (when used after specific tools)
   */
  private async queryContextualStats(
    toolId: string,
    contextToolIds: string[],
  ): Promise<{
    successRate: number | null;
    cooccurrence: number | null;
    errorRecovery: number | null;
  }> {
    if (contextToolIds.length === 0) {
      return { successRate: null, cooccurrence: null, errorRecovery: null };
    }

    const limitedContext = contextToolIds.slice(-this.config.maxContextTools);

    // Contextual success rate: success rate when this tool appears after context tools
    const contextualResult = await this.db.queryOne(
      `
      WITH context_sessions AS (
        SELECT DISTINCT id, executed_path, success
        FROM execution_trace
        WHERE executed_path && $1::text[]
      )
      SELECT
        AVG(CASE WHEN success AND $2 = ANY(executed_path) THEN 1.0 ELSE 0.0 END) as success_rate,
        COUNT(*) FILTER (WHERE $2 = ANY(executed_path)) as cooccur_count,
        COUNT(*) as total_count
      FROM context_sessions
    `,
      [limitedContext, toolId],
    ) as Row | null;

    const totalCount = Number(contextualResult?.total_count ?? 0);
    const cooccurCount = Number(contextualResult?.cooccur_count ?? 0);

    // Error recovery rate: success after context tools failed
    const errorRecoveryResult = await this.db.queryOne(
      `
      WITH error_sessions AS (
        SELECT id, executed_path
        FROM execution_trace
        WHERE success = false
          AND executed_path && $1::text[]
      ),
      recovery_attempts AS (
        SELECT et.id, et.success
        FROM execution_trace et
        JOIN error_sessions es ON et.parent_trace_id = es.id
        WHERE $2 = ANY(et.executed_path)
      )
      SELECT AVG(CASE WHEN success THEN 1.0 ELSE 0.0 END) as recovery_rate
      FROM recovery_attempts
    `,
      [limitedContext, toolId],
    ) as Row | null;

    return {
      successRate: totalCount >= this.config.minTracesForStats
        ? Number(contextualResult?.success_rate ?? null)
        : null,
      cooccurrence: totalCount > 0 ? cooccurCount / totalCount : null,
      errorRecovery: errorRecoveryResult?.recovery_rate != null
        ? Number(errorRecoveryResult.recovery_rate)
        : null,
    };
  }

  /**
   * Query sequence position statistics
   */
  private async querySequenceStats(toolId: string): Promise<{ avgPosition: number | null }> {
    const result = await this.db.queryOne(
      `
      WITH tool_positions AS (
        SELECT
          array_position(executed_path, $1) as pos,
          array_length(executed_path, 1) as total_len
        FROM execution_trace
        WHERE $1 = ANY(executed_path)
          AND array_length(executed_path, 1) > 0
      )
      SELECT AVG((pos - 1.0) / NULLIF(total_len - 1, 0)) as avg_position
      FROM tool_positions
      WHERE total_len > 1
    `,
      [toolId],
    ) as Row | null;

    return {
      avgPosition: result?.avg_position != null ? Number(result.avg_position) : null,
    };
  }

  /**
   * Query temporal statistics (recency, frequency, duration)
   */
  private async queryTemporalStats(toolId: string): Promise<{
    recency: number | null;
    frequency: number | null;
    avgDuration: number | null;
  }> {
    // Recency: exponential decay based on last use
    const recencyResult = await this.db.queryOne(
      `
      SELECT
        MAX(executed_at) as last_used,
        COUNT(*) as usage_count,
        AVG(duration_ms) as avg_duration
      FROM execution_trace
      WHERE $1 = ANY(executed_path)
    `,
      [toolId],
    ) as Row | null;

    let recency: number | null = null;
    if (recencyResult?.last_used) {
      const lastUsed = new Date(recencyResult.last_used as string).getTime();
      const hoursSinceUse = (Date.now() - lastUsed) / (1000 * 60 * 60);
      const halfLife = this.config.recencyHalfLifeHours;
      recency = Math.exp(-hoursSinceUse * Math.LN2 / halfLife);
    }

    // Frequency: normalized by max usage
    let frequency: number | null = null;
    const usageCount = Number(recencyResult?.usage_count ?? 0);
    if (usageCount > 0 && this.globalStats) {
      frequency = usageCount / Math.max(1, this.globalStats.maxUsageCount);
    }

    // Duration: normalized by max duration
    let avgDuration: number | null = null;
    const rawDuration = Number(recencyResult?.avg_duration ?? 0);
    if (rawDuration > 0 && this.globalStats) {
      avgDuration = rawDuration / Math.max(1, this.globalStats.maxDurationMs);
    }

    return { recency, frequency, avgDuration };
  }

  /**
   * Query path pattern statistics
   */
  private async queryPathStats(toolId: string): Promise<{
    avgLength: number | null;
    variance: number | null;
  }> {
    const result = await this.db.queryOne(
      `
      WITH successful_traces AS (
        SELECT
          array_length(executed_path, 1) - array_position(executed_path, $1) + 1 as steps_to_end
        FROM execution_trace
        WHERE success = true
          AND $1 = ANY(executed_path)
          AND array_length(executed_path, 1) > 0
      )
      SELECT
        AVG(steps_to_end) as avg_length,
        COALESCE(VARIANCE(steps_to_end), 0) as variance
      FROM successful_traces
    `,
      [toolId],
    ) as Row | null;

    return {
      avgLength: result?.avg_length != null ? Number(result.avg_length) : null,
      variance: result?.variance != null ? Number(result.variance) : null,
    };
  }

  /**
   * Query intent-similar success rate using vector similarity search
   *
   * Finds traces with similar intent embeddings and computes success rate
   * for the given tool when used in those similar contexts.
   *
   * Uses HNSW index for fast approximate nearest neighbor search.
   *
   * @param toolId - Tool to compute success rate for
   * @param intentEmbedding - Current intent embedding for similarity search
   * @param topK - Number of similar traces to consider (default: 50)
   * @param similarityThreshold - Minimum cosine similarity (default: 0.7)
   * @returns Success rate for similar intents, or null if insufficient data
   */
  async queryIntentSimilarSuccessRate(
    toolId: string,
    intentEmbedding: number[],
    topK = 50,
    similarityThreshold = 0.7,
  ): Promise<number | null> {
    try {
      // Format embedding as PostgreSQL vector
      const embeddingStr = `[${intentEmbedding.join(",")}]`;

      // Use vector cosine similarity search to find similar intents
      // Filter by: has intent_embedding, tool in executed_path, similarity >= threshold
      const result = await this.db.queryOne(
        `
        WITH similar_traces AS (
          SELECT
            id,
            success,
            1 - (intent_embedding <=> $1::vector) as similarity
          FROM execution_trace
          WHERE intent_embedding IS NOT NULL
            AND $2 = ANY(executed_path)
            AND 1 - (intent_embedding <=> $1::vector) >= $3
          ORDER BY intent_embedding <=> $1::vector
          LIMIT $4
        )
        SELECT
          AVG(CASE WHEN success THEN 1.0 ELSE 0.0 END) as success_rate,
          COUNT(*) as count,
          AVG(similarity) as avg_similarity
        FROM similar_traces
      `,
        [embeddingStr, toolId, similarityThreshold, topK],
      ) as Row | null;

      const count = Number(result?.count ?? 0);
      if (count < this.config.minTracesForStats) {
        logger.debug("Insufficient similar traces for intentSimilarSuccessRate", {
          toolId,
          count,
          minRequired: this.config.minTracesForStats,
        });
        return null;
      }

      const successRate = Number(result?.success_rate ?? 0.5);
      logger.debug("Computed intentSimilarSuccessRate", {
        toolId,
        successRate,
        count,
        avgSimilarity: Number(result?.avg_similarity ?? 0),
      });

      return successRate;
    } catch (error) {
      logger.warn("Failed to query intentSimilarSuccessRate", { toolId, error });
      return null;
    }
  }

  /**
   * Get trace statistics with intent similarity (enhanced version)
   *
   * Like getTraceStats() but also computes intentSimilarSuccessRate when
   * an intent embedding is provided.
   *
   * @param toolId - Tool or capability ID
   * @param intentEmbedding - Current intent embedding for similarity search
   * @param contextToolIds - Context tools for contextual metrics
   * @returns TraceStats with intentSimilarSuccessRate populated
   */
  async getTraceStatsWithIntent(
    toolId: string,
    intentEmbedding: number[],
    contextToolIds: string[] = [],
  ): Promise<TraceStats> {
    // Get base stats
    const stats = await this.getTraceStats(toolId, contextToolIds);

    // Compute intent-similar success rate
    const intentSimilarSuccessRate = await this.queryIntentSimilarSuccessRate(
      toolId,
      intentEmbedding,
    );

    // Override with computed value if available
    if (intentSimilarSuccessRate !== null) {
      stats.intentSimilarSuccessRate = intentSimilarSuccessRate;
    }

    return stats;
  }

  /**
   * Query error type affinity statistics
   *
   * Computes success rate per error type when this tool follows a failed execution.
   * Returns array of 6 values: [TIMEOUT, PERMISSION, NOT_FOUND, VALIDATION, NETWORK, UNKNOWN]
   */
  private async queryErrorTypeAffinity(toolId: string): Promise<number[]> {
    // Query success rate per error type
    const result = await this.db.query(
      `
      WITH error_contexts AS (
        -- Find traces where an error occurred, then this tool was used
        SELECT
          parent.error_type,
          child.success
        FROM execution_trace parent
        JOIN execution_trace child ON child.parent_trace_id = parent.id
        WHERE parent.success = false
          AND parent.error_type IS NOT NULL
          AND $1 = ANY(child.executed_path)
      )
      SELECT
        error_type,
        AVG(CASE WHEN success THEN 1.0 ELSE 0.0 END) as success_rate,
        COUNT(*) as count
      FROM error_contexts
      GROUP BY error_type
    `,
      [toolId],
    ) as Row[];

    // Build affinity array in ERROR_TYPES order
    const affinityMap = new Map<string, number>();
    for (const row of result) {
      if (row.error_type && Number(row.count) >= this.config.minTracesForStats) {
        affinityMap.set(row.error_type as string, Number(row.success_rate));
      }
    }

    // Return array in fixed order, defaulting to 0.5 (neutral) if no data
    return ERROR_TYPES.map((errorType) => affinityMap.get(errorType) ?? 0.5);
  }

  /**
   * Compute stats for multiple tools in batch
   */
  private async computeBatchTraceStats(toolIds: string[]): Promise<Map<string, TraceStats>> {
    const result = new Map<string, TraceStats>();

    // Ensure global stats
    await this.ensureGlobalStats();

    // Batch query basic stats
    const basicStatsRows = await this.db.query(
      `
      SELECT
        tool_id,
        AVG(CASE WHEN success THEN 1.0 ELSE 0.0 END) as success_rate,
        COUNT(*) as trace_count,
        MAX(executed_at) as last_used,
        AVG(duration_ms) as avg_duration
      FROM execution_trace, UNNEST(executed_path) as tool_id
      WHERE tool_id = ANY($1::text[])
      GROUP BY tool_id
    `,
      [toolIds],
    ) as Row[];

    const statsMap = new Map<string, Row>();
    for (const row of basicStatsRows) {
      statsMap.set(row.tool_id as string, row);
    }

    // Batch query sequence positions (normalized 0-1, where 0=first, 1=last)
    const sequenceRows = await this.db.query(
      `
      WITH tool_positions AS (
        SELECT
          tool_id,
          array_position(executed_path, tool_id) as pos,
          array_length(executed_path, 1) as total_len
        FROM execution_trace, UNNEST(executed_path) as tool_id
        WHERE tool_id = ANY($1::text[])
          AND array_length(executed_path, 1) > 1
      )
      SELECT
        tool_id,
        AVG((pos - 1.0) / NULLIF(total_len - 1, 0)) as avg_position,
        COUNT(*) as count
      FROM tool_positions
      WHERE total_len > 1
      GROUP BY tool_id
    `,
      [toolIds],
    ) as Row[];

    const sequenceMap = new Map<string, number>();
    for (const row of sequenceRows) {
      if (Number(row.count) >= this.config.minTracesForStats && row.avg_position != null) {
        sequenceMap.set(row.tool_id as string, Number(row.avg_position));
      }
    }

    // Batch query path stats (avgPathLengthToSuccess, pathVariance)
    const pathStatsRows = await this.db.query(
      `
      WITH successful_paths AS (
        SELECT
          tool_id,
          array_length(executed_path, 1) - array_position(executed_path, tool_id) + 1 as steps_to_end
        FROM execution_trace, UNNEST(executed_path) as tool_id
        WHERE success = true
          AND tool_id = ANY($1::text[])
          AND array_length(executed_path, 1) > 0
      )
      SELECT
        tool_id,
        AVG(steps_to_end) as avg_length,
        COALESCE(VARIANCE(steps_to_end), 0) as variance,
        COUNT(*) as count
      FROM successful_paths
      GROUP BY tool_id
    `,
      [toolIds],
    ) as Row[];

    const pathStatsMap = new Map<string, { avgLength: number; variance: number }>();
    for (const row of pathStatsRows) {
      if (Number(row.count) >= this.config.minTracesForStats) {
        pathStatsMap.set(row.tool_id as string, {
          avgLength: Number(row.avg_length ?? 0),
          variance: Number(row.variance ?? 0),
        });
      }
    }

    // Build result for each tool
    for (const toolId of toolIds) {
      const row = statsMap.get(toolId);
      if (!row || Number(row.trace_count) < this.config.minTracesForStats) {
        result.set(toolId, { ...DEFAULT_TRACE_STATS });
        continue;
      }

      // Compute recency
      let recency = DEFAULT_TRACE_STATS.recencyScore;
      if (row.last_used) {
        const lastUsed = new Date(row.last_used as string).getTime();
        const hoursSinceUse = (Date.now() - lastUsed) / (1000 * 60 * 60);
        const halfLife = this.config.recencyHalfLifeHours;
        recency = Math.exp(-hoursSinceUse * Math.LN2 / halfLife);
      }

      // Compute frequency
      const usageCount = Number(row.trace_count ?? 0);
      const frequency = this.globalStats
        ? usageCount / Math.max(1, this.globalStats.maxUsageCount)
        : DEFAULT_TRACE_STATS.usageFrequency;

      // Compute normalized duration
      const rawDuration = Number(row.avg_duration ?? 0);
      const avgDuration = this.globalStats && rawDuration > 0
        ? rawDuration / Math.max(1, this.globalStats.maxDurationMs)
        : DEFAULT_TRACE_STATS.avgExecutionTime;

      result.set(toolId, {
        historicalSuccessRate: Number(
          row.success_rate ?? DEFAULT_TRACE_STATS.historicalSuccessRate,
        ),
        contextualSuccessRate: DEFAULT_TRACE_STATS.contextualSuccessRate, // Requires context
        intentSimilarSuccessRate: DEFAULT_TRACE_STATS.intentSimilarSuccessRate,
        cooccurrenceWithContext: DEFAULT_TRACE_STATS.cooccurrenceWithContext,
        sequencePosition: sequenceMap.get(toolId) ?? DEFAULT_TRACE_STATS.sequencePosition,
        recencyScore: recency,
        usageFrequency: frequency,
        avgExecutionTime: avgDuration,
        errorRecoveryRate: DEFAULT_TRACE_STATS.errorRecoveryRate,
        avgPathLengthToSuccess: pathStatsMap.get(toolId)?.avgLength ??
          DEFAULT_TRACE_STATS.avgPathLengthToSuccess,
        pathVariance: pathStatsMap.get(toolId)?.variance ?? DEFAULT_TRACE_STATS.pathVariance,
        errorTypeAffinity: [...DEFAULT_TRACE_STATS.errorTypeAffinity], // TODO: Add batch error type query
      });
    }

    return result;
  }

  // ==========================================================================
  // Private: Global Stats & Caching
  // ==========================================================================

  /**
   * Ensure global normalization stats are loaded
   */
  private async ensureGlobalStats(): Promise<void> {
    // Refresh if stale (older than cache TTL)
    if (this.globalStats && (Date.now() - this.globalStats.lastUpdated) < this.config.cacheTtlMs) {
      return;
    }

    const result = await this.db.queryOne(`
      SELECT
        MAX(usage_count) as max_usage,
        MAX(duration_ms) as max_duration
      FROM (
        SELECT
          tool_id,
          COUNT(*) as usage_count,
          MAX(duration_ms) as duration_ms
        FROM execution_trace, UNNEST(executed_path) as tool_id
        GROUP BY tool_id
      ) tool_stats
    `) as Row | null;

    this.globalStats = {
      maxUsageCount: Math.max(1, Number(result?.max_usage ?? 1)),
      maxDurationMs: Math.max(1, Number(result?.max_duration ?? 1000)),
      lastUpdated: Date.now(),
    };

    logger.debug("Global stats refreshed", this.globalStats);
  }

  /**
   * Get cached stats if fresh
   */
  private getCachedStats(toolId: string): TraceStats | null {
    const entry = this.cache.get(toolId);
    if (!entry) {
      this.cacheMisses++;
      return null;
    }

    // Check if still fresh
    if ((Date.now() - entry.timestamp) > this.config.cacheTtlMs) {
      this.cache.delete(toolId);
      this.cacheMisses++;
      return null;
    }

    this.cacheHits++;
    return entry.stats;
  }

  /**
   * Cache stats for a tool
   */
  private setCachedStats(toolId: string, stats: TraceStats, traceCount = 0): void {
    // Evict oldest entries if cache is full
    if (this.cache.size >= this.config.maxCacheEntries) {
      const oldest = Array.from(this.cache.entries())
        .sort((a, b) => a[1].timestamp - b[1].timestamp)[0];
      if (oldest) {
        this.cache.delete(oldest[0]);
      }
    }

    this.cache.set(toolId, {
      stats,
      timestamp: Date.now(),
      traceCount,
    });
  }

  // ==========================================================================
  // Private: Utilities
  // ==========================================================================

  /**
   * Mean pooling for context embeddings
   */
  private meanPool(embeddings: number[][]): number[] {
    if (embeddings.length === 0) {
      return [];
    }

    const dim = embeddings[0].length;
    const result = new Array(dim).fill(0);

    for (const emb of embeddings) {
      for (let i = 0; i < dim; i++) {
        result[i] += emb[i];
      }
    }

    for (let i = 0; i < dim; i++) {
      result[i] /= embeddings.length;
    }

    return result;
  }
}

// ============================================================================
// Exports
// ============================================================================

export { DEFAULT_TRACE_STATS };
