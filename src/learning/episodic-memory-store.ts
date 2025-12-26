/**
 * Episodic Memory Store
 *
 * Manages episodic event storage with buffered async writes and context-based retrieval.
 * Implements ADR-008 Phase 1: Storage layer independent of Loop integrations.
 *
 * Key features:
 * - Non-blocking event capture (<1ms overhead)
 * - Buffered batch writes (configurable buffer size)
 * - Context hash-based retrieval (MVP strategy)
 * - Automatic pruning (retention policy)
 *
 * @module learning/episodic-memory-store
 */

import * as log from "@std/log";
import type { DbClient } from "../db/types.ts";
import type {
  EpisodicEvent,
  EpisodicEventInput,
  EpisodicEventType,
  EpisodicMemoryStats,
  RetrieveOptions,
  ThresholdContext,
} from "./types.ts";

/**
 * Configuration for EpisodicMemoryStore
 */
export interface EpisodicMemoryConfig {
  /** Buffer size before auto-flush (default: 50) */
  bufferSize: number;
  /** Retention period in days (default: 30) */
  retentionDays: number;
  /** Maximum events to keep (default: 10000) */
  maxEvents: number;
  /** Auto-flush interval in ms (default: 5000) */
  flushIntervalMs: number;
}

const DEFAULT_CONFIG: EpisodicMemoryConfig = {
  bufferSize: 50,
  retentionDays: 30,
  maxEvents: 10000,
  flushIntervalMs: 5000,
};

/**
 * Episodic Memory Store
 *
 * Provides non-blocking event capture with buffered writes to PGlite.
 */
export class EpisodicMemoryStore {
  private buffer: EpisodicEvent[] = [];
  private config: EpisodicMemoryConfig;
  private flushTimer: number | null = null;
  private isShuttingDown = false;

  constructor(
    private db: DbClient,
    config: Partial<EpisodicMemoryConfig> = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.startAutoFlush();
  }

  /**
   * Capture an episodic event (non-blocking, buffered)
   *
   * @param event - Event to capture (without id)
   * @returns Generated event ID
   */
  async capture(event: EpisodicEventInput): Promise<string> {
    const fullEvent: EpisodicEvent = {
      id: crypto.randomUUID(),
      ...event,
      context_hash: event.context_hash || this.hashContext(event.data.context || {}),
    };

    this.buffer.push(fullEvent);

    // Trigger async flush if buffer is full (non-blocking)
    if (this.buffer.length >= this.config.bufferSize) {
      this.flush().catch((err) => log.error(`[EpisodicMemory] Flush error: ${err}`));
    }

    return fullEvent.id;
  }

  /**
   * Flush buffer to PGlite (batched insert)
   *
   * Safe to call multiple times - handles empty buffer gracefully.
   */
  async flush(): Promise<number> {
    if (this.buffer.length === 0) return 0;

    const toFlush = [...this.buffer];
    this.buffer = []; // Clear buffer immediately to avoid duplicates

    try {
      await this.db.transaction(async (tx) => {
        for (const event of toFlush) {
          // Use query instead of exec for parameterized inserts (PGlite limitation)
          await tx.query(
            `INSERT INTO episodic_events (id, workflow_id, event_type, task_id, timestamp, context_hash, data)
             VALUES ($1, $2, $3, $4, to_timestamp($5), $6, $7)`,
            [
              event.id,
              event.workflow_id,
              event.event_type,
              event.task_id || null,
              event.timestamp / 1000, // Convert ms to seconds for to_timestamp
              event.context_hash || null,
              JSON.stringify(event.data),
            ],
          );
        }
      });

      log.debug(`[EpisodicMemory] Flushed ${toFlush.length} events`);
      return toFlush.length;
    } catch (error) {
      // On error, restore events to buffer for retry
      this.buffer = [...toFlush, ...this.buffer];
      log.error(
        `[EpisodicMemory] Flush failed, ${toFlush.length} events restored to buffer: ${error}`,
      );
      throw error;
    }
  }

  /**
   * Retrieve events relevant to a context (hash-based matching)
   *
   * @param context - Context for similarity matching
   * @param options - Retrieval options
   * @returns Matching episodic events
   */
  async retrieveRelevant(
    context: ThresholdContext,
    options: RetrieveOptions = {},
  ): Promise<EpisodicEvent[]> {
    const { limit = 100, eventTypes, afterTimestamp } = options;
    const contextHash = this.hashContext(context);

    let query = `
      SELECT id, workflow_id, event_type, task_id,
             EXTRACT(EPOCH FROM timestamp) * 1000 as timestamp,
             context_hash, data
      FROM episodic_events
      WHERE context_hash = $1
    `;
    const params: unknown[] = [contextHash];
    let paramIndex = 2;

    if (eventTypes && eventTypes.length > 0) {
      query += ` AND event_type = ANY($${paramIndex})`;
      params.push(eventTypes);
      paramIndex++;
    }

    if (afterTimestamp) {
      query += ` AND timestamp > to_timestamp($${paramIndex})`;
      params.push(afterTimestamp / 1000);
      paramIndex++;
    }

    query += ` ORDER BY timestamp DESC LIMIT $${paramIndex}`;
    params.push(limit);

    const rows = await this.db.query(query, params);

    return rows.map((row) => this.deserializeEvent(row));
  }

  /**
   * Get all events for a specific workflow
   *
   * @param workflowId - Workflow ID
   * @returns Events ordered by timestamp
   */
  async getWorkflowEvents(workflowId: string): Promise<EpisodicEvent[]> {
    const rows = await this.db.query(
      `SELECT id, workflow_id, event_type, task_id,
              EXTRACT(EPOCH FROM timestamp) * 1000 as timestamp,
              context_hash, data
       FROM episodic_events
       WHERE workflow_id = $1
       ORDER BY timestamp ASC`,
      [workflowId],
    );

    return rows.map((row) => this.deserializeEvent(row));
  }

  /**
   * Get events by type (useful for analytics)
   *
   * @param eventType - Event type to filter
   * @param limit - Maximum events to return
   * @returns Events of specified type
   */
  async getEventsByType(
    eventType: EpisodicEventType,
    limit = 100,
  ): Promise<EpisodicEvent[]> {
    const rows = await this.db.query(
      `SELECT id, workflow_id, event_type, task_id,
              EXTRACT(EPOCH FROM timestamp) * 1000 as timestamp,
              context_hash, data
       FROM episodic_events
       WHERE event_type = $1
       ORDER BY timestamp DESC
       LIMIT $2`,
      [eventType, limit],
    );

    return rows.map((row) => this.deserializeEvent(row));
  }

  /**
   * Prune old events based on retention policy
   *
   * Deletes events older than retentionDays OR exceeding maxEvents limit.
   *
   * @returns Number of pruned events
   */
  async prune(): Promise<number> {
    const { retentionDays, maxEvents } = this.config;

    // First, prune by age
    const ageResult = await this.db.query(
      `DELETE FROM episodic_events
       WHERE timestamp < NOW() - INTERVAL '${retentionDays} days'
       RETURNING id`,
    );
    const prunedByAge = ageResult.length;

    // Then, prune by count if still over limit
    const countResult = await this.db.query(
      `SELECT COUNT(*) as count FROM episodic_events`,
    );
    const totalCount = Number(countResult[0]?.count || 0);

    let prunedByCount = 0;
    if (totalCount > maxEvents) {
      const toDelete = totalCount - maxEvents;
      const deleteResult = await this.db.query(
        `DELETE FROM episodic_events
         WHERE id IN (
           SELECT id FROM episodic_events
           ORDER BY timestamp ASC
           LIMIT $1
         )
         RETURNING id`,
        [toDelete],
      );
      prunedByCount = deleteResult.length;
    }

    const totalPruned = prunedByAge + prunedByCount;
    if (totalPruned > 0) {
      log.info(
        `[EpisodicMemory] Pruned ${totalPruned} events (${prunedByAge} by age, ${prunedByCount} by count)`,
      );
    }

    return totalPruned;
  }

  /**
   * Get episodic memory statistics
   *
   * @returns Statistics about stored events
   */
  async getStats(): Promise<EpisodicMemoryStats> {
    const [countResult, typeResult, timeResult, workflowResult] = await Promise.all([
      this.db.query(`SELECT COUNT(*) as count FROM episodic_events`),
      this.db.query(
        `SELECT event_type, COUNT(*) as count
         FROM episodic_events
         GROUP BY event_type`,
      ),
      this.db.query(
        `SELECT
           MIN(EXTRACT(EPOCH FROM timestamp) * 1000) as oldest,
           MAX(EXTRACT(EPOCH FROM timestamp) * 1000) as newest
         FROM episodic_events`,
      ),
      this.db.query(
        `SELECT COUNT(DISTINCT workflow_id) as count FROM episodic_events`,
      ),
    ]);

    const eventsByType: Record<EpisodicEventType, number> = {
      speculation_start: 0,
      task_complete: 0,
      ail_decision: 0,
      hil_decision: 0,
      workflow_start: 0,
      workflow_complete: 0,
    };

    for (const row of typeResult) {
      const type = row.event_type as EpisodicEventType;
      eventsByType[type] = Number(row.count);
    }

    return {
      totalEvents: Number(countResult[0]?.count || 0),
      eventsByType,
      oldestEventTimestamp: timeResult[0]?.oldest ? Number(timeResult[0].oldest) : null,
      newestEventTimestamp: timeResult[0]?.newest ? Number(timeResult[0].newest) : null,
      uniqueWorkflows: Number(workflowResult[0]?.count || 0),
    };
  }

  /**
   * Get buffer status (for monitoring)
   */
  getBufferStatus(): { size: number; maxSize: number } {
    return {
      size: this.buffer.length,
      maxSize: this.config.bufferSize,
    };
  }

  /**
   * Graceful shutdown - flush remaining events
   */
  async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    this.stopAutoFlush();

    if (this.buffer.length > 0) {
      log.info(`[EpisodicMemory] Shutting down, flushing ${this.buffer.length} remaining events`);
      await this.flush();
    }
  }

  /**
   * Hash context for exact-match retrieval (MVP strategy per ADR-008)
   *
   * @param context - Context object
   * @returns Hash string
   */
  hashContext(context: Record<string, unknown>): string {
    const keys = ["workflowType", "domain", "complexity"];
    return keys
      .map((k) => `${k}:${context[k] ?? "default"}`)
      .join("|");
  }

  /**
   * Start auto-flush timer
   */
  private startAutoFlush(): void {
    if (this.flushTimer) return;

    this.flushTimer = setInterval(() => {
      if (!this.isShuttingDown && this.buffer.length > 0) {
        this.flush().catch((err) => log.error(`[EpisodicMemory] Auto-flush error: ${err}`));
      }
    }, this.config.flushIntervalMs);
  }

  /**
   * Stop auto-flush timer
   */
  private stopAutoFlush(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /**
   * Deserialize database row to EpisodicEvent
   */
  private deserializeEvent(row: Record<string, unknown>): EpisodicEvent {
    return {
      id: row.id as string,
      workflow_id: row.workflow_id as string,
      event_type: row.event_type as EpisodicEventType,
      task_id: row.task_id as string | undefined,
      timestamp: Number(row.timestamp),
      context_hash: row.context_hash as string | undefined,
      data: typeof row.data === "string" ? JSON.parse(row.data) : row.data,
    };
  }
}
