/**
 * Algorithm DB Subscriber
 *
 * Subscribes to algorithm.decision events and writes to Postgres.
 * Buffers writes for performance.
 *
 * @module telemetry/subscribers/db-subscriber
 */

import type { DbClient } from "../../db/types.ts";
import type { AlgorithmDecisionPayload, EventHandler } from "../../events/types.ts";
import { eventBus } from "../../events/mod.ts";
import { getLogger } from "../logger.ts";

const logger = getLogger("default");

/**
 * Escape SQL string (simple apostrophe escaping)
 */
function escapeSql(str: string): string {
  return str.replace(/'/g, "''");
}

/**
 * AlgorithmDBSubscriber - Writes algorithm decisions to Postgres
 *
 * Features:
 * - Buffers up to 100 traces before auto-flush
 * - Periodic flush every 5 seconds
 * - Non-blocking event handling
 */
export class AlgorithmDBSubscriber {
  private buffer: Array<AlgorithmDecisionPayload & { timestamp: Date }> = [];
  private readonly BUFFER_SIZE = 100;
  private readonly FLUSH_INTERVAL_MS = 5000;
  private flushPromise: Promise<void> | null = null;
  private flushIntervalId: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(private db: DbClient) {}

  /**
   * Start subscribing to algorithm.decision events
   */
  start(): void {
    // Subscribe to algorithm.decision events
    const handler: EventHandler<"algorithm.decision"> = (event) => {
      this.handleDecision(event.payload as AlgorithmDecisionPayload);
    };
    this.unsubscribe = eventBus.on("algorithm.decision", handler);

    // Start periodic flush
    this.flushIntervalId = setInterval(() => {
      if (this.buffer.length > 0) {
        this.scheduleFlush();
      }
    }, this.FLUSH_INTERVAL_MS);

    logger.info("AlgorithmDBSubscriber started");
  }

  /**
   * Stop subscribing and flush remaining buffer
   */
  async stop(): Promise<void> {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }

    if (this.flushIntervalId) {
      clearInterval(this.flushIntervalId);
      this.flushIntervalId = null;
    }

    await this.flush();
    logger.info("AlgorithmDBSubscriber stopped");
  }

  /**
   * Handle incoming algorithm.decision event
   */
  private handleDecision(payload: AlgorithmDecisionPayload): void {
    this.buffer.push({
      ...payload,
      timestamp: new Date(),
    });

    // Flush immediately for real-time updates
    // This ensures trace is in DB before SSE event triggers client refetch
    this.scheduleFlush();

    logger.debug("Algorithm decision buffered", {
      traceId: payload.traceId,
      bufferSize: this.buffer.length,
    });
  }

  /**
   * Schedule a flush operation (non-blocking)
   */
  private scheduleFlush(): void {
    if (this.flushPromise) return;

    this.flushPromise = this.flush().finally(() => {
      this.flushPromise = null;
    });
  }

  /**
   * Flush all buffered traces to database
   */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const traces = [...this.buffer];
    this.buffer = [];

    const startTime = performance.now();

    try {
      const values = traces.map((t) => {
        const signalsJson = JSON.stringify(t.signals);
        const paramsJson = JSON.stringify(t.params);

        return `(
          '${t.traceId}',
          '${t.timestamp.toISOString()}',
          ${t.correlationId ? `'${t.correlationId}'` : "NULL"},
          ${t.algorithmName ? `'${t.algorithmName}'` : "NULL"},
          '${t.algorithmMode}',
          '${t.targetType}',
          ${t.intent ? `'${escapeSql(t.intent)}'` : "NULL"},
          ${t.contextHash ? `'${escapeSql(t.contextHash)}'` : "NULL"},
          '${signalsJson}'::jsonb,
          '${paramsJson}'::jsonb,
          ${t.finalScore},
          ${t.thresholdUsed},
          '${t.decision}',
          NULL
        )`;
      });

      await this.db.exec(`
        INSERT INTO algorithm_traces (
          trace_id, timestamp, correlation_id, algorithm_name, algorithm_mode, target_type,
          intent, context_hash, signals, params,
          final_score, threshold_used, decision, outcome
        ) VALUES ${values.join(",\n")}
      `);

      const elapsedMs = performance.now() - startTime;
      logger.debug("Algorithm traces flushed to DB", {
        count: traces.length,
        durationMs: elapsedMs.toFixed(1),
      });

      // Emit algorithm.scored events for SSE real-time updates (TracingPanel)
      for (const t of traces) {
        eventBus.emit({
          type: "algorithm.scored",
          source: "algorithm-db-subscriber",
          payload: {
            traceId: t.traceId,
            algorithmName: t.algorithmName,
            algorithmMode: t.algorithmMode,
            targetType: t.targetType,
            finalScore: t.finalScore,
            decision: t.decision,
            correlationId: t.correlationId,
          },
        });
      }
    } catch (error) {
      logger.error("Failed to flush algorithm traces to DB", { error, count: traces.length });
      // Re-add traces to buffer for retry (up to buffer limit)
      this.buffer.push(...traces.slice(0, this.BUFFER_SIZE - this.buffer.length));
    }
  }

  /**
   * Get buffer size (for testing)
   */
  getBufferSize(): number {
    return this.buffer.length;
  }
}
