/**
 * Execution Trace Store (Story 11.2)
 *
 * Persists execution traces for learning with TD Error + PER + SHGAT.
 * Separation from capabilities:
 * - Capability (workflow_pattern): static structure, immutable after creation
 * - Trace (execution_trace): runtime data, created per execution
 *
 * @module capabilities/execution-trace-store
 */

import type { DbClient } from "../db/types.ts";
import type { Row } from "../db/client.ts";
import {
  DEFAULT_TRACE_PRIORITY,
  type BranchDecision,
  type ExecutionTrace,
  type HierarchyNode,
  type JsonValue,
  type TraceTaskResult,
} from "./types.ts";
import { sanitizeForStorage } from "../utils/sanitize-for-storage.ts";
import { eventBus } from "../events/mod.ts";
import { getLogger } from "../telemetry/logger.ts";

const logger = getLogger("default");

// Note: DEFAULT_TRACE_PRIORITY imported from types.ts

/**
 * Input type for saving a trace (id is auto-generated)
 */
export type SaveTraceInput = Omit<ExecutionTrace, "id">;

/**
 * ExecutionTraceStore - Persistence layer for execution traces
 *
 * Implements CRUD operations for traces with:
 * - Sanitization of sensitive data before storage
 * - Priority-based sampling for PER
 * - FK relationship to capabilities (workflow_pattern)
 *
 * @example
 * ```typescript
 * const traceStore = new ExecutionTraceStore(db);
 *
 * // Save after execution
 * const trace = await traceStore.saveTrace({
 *   capabilityId: "cap-uuid",
 *   intentText: "Search for users",
 *   success: true,
 *   durationMs: 150,
 *   decisions: [],
 *   taskResults: [{ taskId: "t1", tool: "db:query", ... }],
 *   priority: 0.5,
 * });
 *
 * // Sample high-priority traces for learning
 * const learningBatch = await traceStore.sampleByPriority(32, 0.3);
 * ```
 */
export class ExecutionTraceStore {
  constructor(private db: DbClient) {
    logger.debug("ExecutionTraceStore initialized");
  }

  /**
   * Save an execution trace after execution
   *
   * Sanitizes sensitive data and large payloads before storage.
   * Emits execution.trace.saved event for observability.
   *
   * @param trace - Trace data (id will be auto-generated)
   * @returns The saved trace with generated id
   */
  async saveTrace(trace: SaveTraceInput): Promise<ExecutionTrace> {
    // Sanitize large/sensitive data before storage (AC #11)
    const sanitizedContext = sanitizeForStorage(trace.initialContext ?? {}) as Record<string, JsonValue>;
    const sanitizedResults = trace.taskResults.map((r) => ({
      ...r,
      args: sanitizeForStorage(r.args) as Record<string, JsonValue>,
      result: sanitizeForStorage(r.result),
    }));

    logger.debug("Saving execution trace", {
      capabilityId: trace.capabilityId ?? "standalone",
      success: trace.success,
      durationMs: trace.durationMs,
      decisionsCount: trace.decisions.length,
      taskResultsCount: trace.taskResults.length,
    });

    // Format intent embedding as PostgreSQL vector if provided
    const intentEmbeddingValue = trace.intentEmbedding
      ? `[${trace.intentEmbedding.join(",")}]`
      : null;

    const result = await this.db.query(
      `INSERT INTO execution_trace (
        capability_id, intent_text, intent_embedding, initial_context, success, duration_ms,
        error_message, user_id, created_by, executed_path, decisions,
        task_results, priority, parent_trace_id
      ) VALUES ($1, $2, $3::vector, $4::jsonb, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13, $14)
      RETURNING *`,
      [
        trace.capabilityId ?? null,
        trace.intentText ?? null,
        intentEmbeddingValue,
        sanitizedContext, // postgres.js auto-serializes to JSONB
        trace.success,
        trace.durationMs,
        trace.errorMessage ?? null,
        trace.userId ?? "local",
        trace.createdBy ?? "local",
        trace.executedPath ?? [],
        trace.decisions, // postgres.js auto-serializes to JSONB
        sanitizedResults, // postgres.js auto-serializes to JSONB
        trace.priority ?? DEFAULT_TRACE_PRIORITY,
        trace.parentTraceId ?? null,
      ],
    );

    if (result.length === 0) {
      throw new Error("Failed to save execution trace - no result returned");
    }

    const savedTrace = this.rowToTrace(result[0] as Row);

    logger.info("Execution trace saved", {
      traceId: savedTrace.id,
      capabilityId: savedTrace.capabilityId ?? "standalone",
      success: savedTrace.success,
      priority: savedTrace.priority,
    });

    // Emit event for observability (ADR-036)
    eventBus.emit({
      type: "execution.trace.saved",
      source: "execution-trace-store",
      payload: {
        trace_id: savedTrace.id,
        capability_id: savedTrace.capabilityId ?? null,
        success: savedTrace.success,
        duration_ms: savedTrace.durationMs,
        priority: savedTrace.priority,
        tasks_count: savedTrace.taskResults.length,
      },
    });

    return savedTrace;
  }

  /**
   * Get a trace by ID
   *
   * @param traceId - UUID of the trace
   * @returns Trace if found, null otherwise
   */
  async getTraceById(traceId: string): Promise<ExecutionTrace | null> {
    const result = await this.db.query(
      `SELECT * FROM execution_trace WHERE id = $1`,
      [traceId],
    );

    if (result.length === 0) {
      return null;
    }

    return this.rowToTrace(result[0] as Row);
  }

  /**
   * Get traces for a specific capability
   *
   * Returns traces ordered by execution time (most recent first).
   *
   * @param capabilityId - UUID of the capability
   * @param limit - Maximum results (default: 50)
   * @returns Traces for the capability
   */
  async getTraces(capabilityId: string, limit = 50): Promise<ExecutionTrace[]> {
    const result = await this.db.query(
      `SELECT * FROM execution_trace
       WHERE capability_id = $1
       ORDER BY executed_at DESC
       LIMIT $2`,
      [capabilityId, limit],
    );

    return result.map((row) => this.rowToTrace(row as Row));
  }

  /**
   * Get high priority traces for learning (PER sampling)
   *
   * Returns traces ordered by priority descending (most surprising first).
   * Used for training SHGAT on high-value experiences.
   *
   * @param limit - Maximum results (default: 100)
   * @returns High priority traces
   */
  async getHighPriorityTraces(limit = 100): Promise<ExecutionTrace[]> {
    const result = await this.db.query(
      `SELECT * FROM execution_trace
       ORDER BY priority DESC, executed_at DESC
       LIMIT $1`,
      [limit],
    );

    return result.map((row) => this.rowToTrace(row as Row));
  }

  /**
   * Update the priority of a trace (Story 11.3)
   *
   * Called after TD error calculation to update PER priority.
   * Priority = |td_error| where:
   * - 0.0 = trace was predicted correctly (expected)
   * - 1.0 = trace was very surprising (high learning value)
   *
   * @param traceId - UUID of the trace
   * @param priority - New priority value (0.0-1.0)
   */
  async updatePriority(traceId: string, priority: number): Promise<void> {
    // Clamp priority to valid range
    const clampedPriority = Math.max(0, Math.min(1, priority));

    await this.db.query(
      `UPDATE execution_trace
       SET priority = $1, updated_by = 'td_error'
       WHERE id = $2`,
      [clampedPriority, traceId],
    );

    logger.debug("Trace priority updated", { traceId, priority: clampedPriority });

    // Emit event for observability
    eventBus.emit({
      type: "execution.trace.priority.updated",
      source: "execution-trace-store",
      payload: {
        trace_id: traceId,
        priority: clampedPriority,
      },
    });
  }

  /**
   * Sample traces by priority with weighted sampling (PER - Schaul et al. 2015)
   *
   * Implements Prioritized Experience Replay (PER) sampling.
   * Formula: P(i) ∝ priority_i^α where α controls prioritization strength.
   *
   * - α = 0: Uniform random sampling (ignore priorities)
   * - α = 1: Fully prioritized (sample proportional to priority)
   * - α = 0.6: Recommended balance (PER paper default)
   *
   * Cold start handling: If all priorities are near-equal (variance < 0.001),
   * falls back to uniform sampling to avoid degenerate distributions.
   *
   * @param limit - Number of traces to sample
   * @param minPriority - Minimum priority threshold (default: 0.1)
   * @param alpha - Priority exponent (default: 0.6, range 0-1)
   * @returns Weighted sample of traces (without replacement)
   */
  async sampleByPriority(
    limit: number,
    minPriority = 0.1,
    alpha = 0.6,
  ): Promise<ExecutionTrace[]> {
    // Fetch eligible traces (fetch more than needed for proper sampling)
    const fetchLimit = Math.min(limit * 3, 500);
    const result = await this.db.query(
      `SELECT * FROM execution_trace
       WHERE priority >= $1
       ORDER BY priority DESC
       LIMIT $2`,
      [minPriority, fetchLimit],
    );

    const available = result.map((row) => this.rowToTrace(row as Row));

    if (available.length === 0) {
      logger.debug("No traces available for PER sampling", { minPriority });
      return [];
    }

    // If we have fewer traces than requested, return all
    if (available.length <= limit) {
      logger.debug("PER sampling: returning all available traces", {
        requested: limit,
        available: available.length,
      });
      return available;
    }

    // Apply true PER weighted sampling without replacement
    const sampled = this.weightedSampleWithoutReplacement(available, limit, alpha);

    logger.debug("PER sampling completed", {
      requested: limit,
      returned: sampled.length,
      minPriority,
      alpha,
      poolSize: available.length,
    });

    return sampled;
  }

  /**
   * Weighted sampling without replacement using PER formula
   *
   * Recomputes probabilities after each selection to maintain correct distribution.
   * Handles cold start by detecting near-uniform priorities.
   *
   * @param traces - Pool of traces to sample from
   * @param n - Number of samples to draw
   * @param alpha - Priority exponent (0-1)
   * @returns Sampled traces
   */
  private weightedSampleWithoutReplacement(
    traces: ExecutionTrace[],
    n: number,
    alpha: number,
  ): ExecutionTrace[] {
    const pool = [...traces];
    const sampled: ExecutionTrace[] = [];

    while (sampled.length < n && pool.length > 0) {
      // Compute priority^alpha for each remaining trace
      const priorities = pool.map((t) => Math.pow(t.priority, alpha));
      const total = priorities.reduce((a, b) => a + b, 0);

      // Cold start detection: if all priorities are nearly equal, use uniform
      const variance = this.computeVariance(priorities);
      if (total === 0 || variance < 0.001) {
        // Uniform random selection
        const idx = Math.floor(Math.random() * pool.length);
        sampled.push(pool[idx]);
        pool.splice(idx, 1);
        continue;
      }

      // Compute probabilities
      const probs = priorities.map((p) => p / total);

      // Weighted random selection
      const rand = Math.random();
      let cumSum = 0;
      let selectedIdx = pool.length - 1; // Fallback to last

      for (let i = 0; i < pool.length; i++) {
        cumSum += probs[i];
        if (rand <= cumSum) {
          selectedIdx = i;
          break;
        }
      }

      sampled.push(pool[selectedIdx]);
      pool.splice(selectedIdx, 1);
    }

    return sampled;
  }

  /**
   * Compute variance of an array of numbers
   */
  private computeVariance(values: number[]): number {
    if (values.length === 0) return 0;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const squaredDiffs = values.map((v) => Math.pow(v - mean, 2));
    return squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
  }

  /**
   * Get trace count for a capability
   *
   * @param capabilityId - UUID of the capability (optional, all if not provided)
   * @returns Number of traces
   */
  async getTraceCount(capabilityId?: string): Promise<number> {
    let result;
    if (capabilityId) {
      result = await this.db.queryOne(
        `SELECT COUNT(*) as count FROM execution_trace WHERE capability_id = $1`,
        [capabilityId],
      );
    } else {
      result = await this.db.queryOne(
        `SELECT COUNT(*) as count FROM execution_trace`,
      );
    }
    return Number(result?.count ?? 0);
  }

  /**
   * Get trace statistics
   *
   * @returns Aggregate statistics about traces
   */
  async getStats(): Promise<{
    totalTraces: number;
    successfulTraces: number;
    avgDurationMs: number;
    avgPriority: number;
  }> {
    const result = await this.db.queryOne(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN success THEN 1 ELSE 0 END) as successful,
        COALESCE(AVG(duration_ms), 0) as avg_duration,
        COALESCE(AVG(priority), 0.5) as avg_priority
      FROM execution_trace`,
    );

    return {
      totalTraces: Number(result?.total ?? 0),
      successfulTraces: Number(result?.successful ?? 0),
      avgDurationMs: Number(result?.avg_duration ?? 0),
      avgPriority: Number(result?.avg_priority ?? DEFAULT_TRACE_PRIORITY),
    };
  }

  /**
   * Get traces by user (multi-tenancy support)
   *
   * @param userId - User identifier
   * @param limit - Maximum results (default: 50)
   * @returns Traces for the user
   */
  async getTracesByUser(userId: string, limit = 50): Promise<ExecutionTrace[]> {
    const result = await this.db.query(
      `SELECT * FROM execution_trace
       WHERE user_id = $1
       ORDER BY executed_at DESC
       LIMIT $2`,
      [userId, limit],
    );

    return result.map((row) => this.rowToTrace(row as Row));
  }

  /**
   * Get child traces (hierarchical traces - ADR-041)
   *
   * @param parentTraceId - UUID of the parent trace
   * @returns Child traces
   */
  async getChildTraces(parentTraceId: string): Promise<ExecutionTrace[]> {
    const result = await this.db.query(
      `SELECT * FROM execution_trace
       WHERE parent_trace_id = $1
       ORDER BY executed_at ASC`,
      [parentTraceId],
    );

    return result.map((row) => this.rowToTrace(row as Row));
  }

  // NOTE: pruneOldTraces() was removed - traces are precious for learning
  // and should not be automatically deleted. If storage becomes an issue,
  // consider archiving to cold storage instead of deletion.

  /**
   * Anonymize traces for a user (GDPR compliance)
   *
   * @param userId - User ID to anonymize
   * @returns Number of anonymized traces
   */
  async anonymizeUserTraces(userId: string): Promise<number> {
    const result = await this.db.query(
      `UPDATE execution_trace
       SET user_id = 'anonymized',
           created_by = 'anonymized',
           updated_by = 'anonymized',
           intent_text = NULL,
           initial_context = '{}'::jsonb
       WHERE user_id = $1
       RETURNING id`,
      [userId],
    );

    const anonymizedCount = result.length;

    if (anonymizedCount > 0) {
      logger.info("Anonymized user traces", { userId, anonymizedCount });
    }

    return anonymizedCount;
  }

  /**
   * Build hierarchy tree from flat traces using parentTraceId
   *
   * Reconstructs the hierarchical execution structure from traces
   * that have parentTraceId linking them together.
   *
   * @param traces Flat list of execution traces
   * @returns Array of root hierarchy nodes
   * @see 08-migration.md for spec details
   */
  buildHierarchy(traces: ExecutionTrace[]): HierarchyNode[] {
    const traceMap = new Map<string, HierarchyNode>();
    const roots: HierarchyNode[] = [];

    // Build node map
    for (const trace of traces) {
      traceMap.set(trace.id, { trace, children: [] });
    }

    // Link children to parents
    for (const trace of traces) {
      const node = traceMap.get(trace.id)!;

      if (!trace.parentTraceId) {
        // Root node (no parent)
        roots.push(node);
      } else {
        // Child node: attach to parent
        const parent = traceMap.get(trace.parentTraceId);
        if (parent) {
          parent.children.push(node);
        } else {
          // Parent not in result set: treat as root
          roots.push(node);
        }
      }
    }

    return roots;
  }

  /**
   * Convert database row to ExecutionTrace object
   */
  private rowToTrace(row: Row): ExecutionTrace {
    // Parse decisions JSONB
    let decisions: BranchDecision[] = [];
    if (row.decisions) {
      try {
        decisions = typeof row.decisions === "string"
          ? JSON.parse(row.decisions)
          : (row.decisions as BranchDecision[]);
      } catch {
        logger.warn("Failed to parse decisions JSONB", { traceId: row.id });
      }
    }

    // Parse task_results JSONB
    let taskResults: TraceTaskResult[] = [];
    if (row.task_results) {
      try {
        taskResults = typeof row.task_results === "string"
          ? JSON.parse(row.task_results)
          : (row.task_results as TraceTaskResult[]);
      } catch {
        logger.warn("Failed to parse task_results JSONB", { traceId: row.id });
      }
    }

    // Parse initial_context JSONB
    let initialContext: Record<string, JsonValue> | undefined;
    if (row.initial_context) {
      try {
        initialContext = typeof row.initial_context === "string"
          ? JSON.parse(row.initial_context)
          : (row.initial_context as Record<string, JsonValue>);
      } catch {
        // Ignore parse errors
      }
    }

    // Parse executed_path (TEXT[] array)
    let executedPath: string[] | undefined;
    if (row.executed_path) {
      if (Array.isArray(row.executed_path)) {
        executedPath = row.executed_path as string[];
      } else if (typeof row.executed_path === "string") {
        // PGlite may return array as string like "{a,b,c}"
        const pathStr = row.executed_path as string;
        if (pathStr.startsWith("{") && pathStr.endsWith("}")) {
          executedPath = pathStr.slice(1, -1).split(",").filter(Boolean);
        }
      }
    }

    // Parse intent_embedding (vector column)
    let intentEmbedding: number[] | undefined;
    if (row.intent_embedding) {
      try {
        // PGlite returns vector as string "[0.1,0.2,...]" or as array
        if (Array.isArray(row.intent_embedding)) {
          intentEmbedding = row.intent_embedding as number[];
        } else if (typeof row.intent_embedding === "string") {
          const embStr = row.intent_embedding as string;
          // Handle "[0.1,0.2,...]" format
          const cleaned = embStr.replace(/^\[|\]$/g, "");
          intentEmbedding = cleaned.split(",").map(Number);
        }
      } catch {
        logger.warn("Failed to parse intent_embedding", { traceId: row.id });
      }
    }

    return {
      id: row.id as string,
      capabilityId: (row.capability_id as string) || undefined,
      intentText: (row.intent_text as string) || undefined,
      intentEmbedding,
      initialContext,
      executedAt: new Date(row.executed_at as string),
      success: row.success as boolean,
      durationMs: row.duration_ms as number,
      errorMessage: (row.error_message as string) || undefined,
      executedPath,
      decisions,
      taskResults,
      priority: (row.priority as number) ?? DEFAULT_TRACE_PRIORITY,
      parentTraceId: (row.parent_trace_id as string) || undefined,
      userId: (row.user_id as string) || undefined,
      createdBy: (row.created_by as string) || undefined,
    };
  }
}
