/**
 * Metrics Collector - EventBus-based Metrics Aggregation
 * Story 6.5: EventBus with BroadcastChannel (ADR-036)
 *
 * Subscribes to EventBus events and aggregates metrics for monitoring.
 * Provides counts, histograms, and rates for system observability.
 *
 * @module telemetry/metrics-collector
 */

import type { EventType, PmlEvent } from "../events/types.ts";
import { eventBus } from "../events/mod.ts";
import { getLogger } from "./logger.ts";

const logger = getLogger("default");

/**
 * Histogram bucket for latency distribution
 */
interface HistogramBucket {
  le: number; // Less than or equal
  count: number;
}

/**
 * Latency histogram with predefined buckets
 */
interface LatencyHistogram {
  buckets: HistogramBucket[];
  sum: number;
  count: number;
}

/**
 * Aggregated metrics snapshot
 */
export interface MetricsSnapshot {
  // Counters
  counters: {
    tool_calls_total: number;
    tool_calls_success: number;
    tool_calls_failed: number;
    capability_executions_total: number;
    capability_learned_total: number;
    capability_matched_total: number;
    dag_executions_total: number;
    dag_tasks_completed: number;
    dag_tasks_failed: number;
    graph_edges_created: number;
    graph_edges_updated: number;
    graph_syncs_total: number;
  };

  // Histograms
  histograms: {
    tool_call_duration_ms: LatencyHistogram;
    dag_task_duration_ms: LatencyHistogram;
    dag_execution_duration_ms: LatencyHistogram;
  };

  // Gauges (point-in-time values)
  gauges: {
    active_dag_executions: number;
    connected_sse_clients: number;
  };

  // Metadata
  collected_at: number;
  uptime_seconds: number;
}

/**
 * Default histogram buckets (in milliseconds)
 */
const DEFAULT_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

/**
 * Create empty histogram with predefined buckets
 */
function createHistogram(buckets: number[] = DEFAULT_BUCKETS): LatencyHistogram {
  return {
    buckets: buckets.map((le) => ({ le, count: 0 })),
    sum: 0,
    count: 0,
  };
}

/**
 * Add observation to histogram
 */
function observeHistogram(histogram: LatencyHistogram, value: number): void {
  histogram.sum += value;
  histogram.count++;

  // Increment all buckets where value <= le
  for (const bucket of histogram.buckets) {
    if (value <= bucket.le) {
      bucket.count++;
    }
  }
}

/**
 * MetricsCollector - EventBus-based metrics aggregation
 *
 * Subscribes to all events and aggregates metrics for monitoring.
 *
 * @example
 * ```typescript
 * const collector = new MetricsCollector();
 * // ... events flow through EventBus ...
 * const metrics = collector.getMetrics();
 * console.log(`Tool calls: ${metrics.counters.tool_calls_total}`);
 * collector.close();
 * ```
 */
export class MetricsCollector {
  private startTime = Date.now();
  private unsubscribe: (() => void) | null = null;

  // Counters
  private toolCallsTotal = 0;
  private toolCallsSuccess = 0;
  private toolCallsFailed = 0;
  private capabilityExecutionsTotal = 0;
  private capabilityLearnedTotal = 0;
  private capabilityMatchedTotal = 0;
  private dagExecutionsTotal = 0;
  private dagTasksCompleted = 0;
  private dagTasksFailed = 0;
  private graphEdgesCreated = 0;
  private graphEdgesUpdated = 0;
  private graphSyncsTotal = 0;

  // Histograms
  private toolCallDuration = createHistogram();
  private dagTaskDuration = createHistogram();
  private dagExecutionDuration = createHistogram();

  // Gauges
  private activeDagExecutions = 0;
  private connectedSseClients = 0;

  // Track active DAG executions by ID
  private activeDags = new Set<string>();

  constructor() {
    // Subscribe to all events
    this.unsubscribe = eventBus.on("*", (event) => {
      this.handleEvent(event);
    });

    logger.info("MetricsCollector initialized, subscribed to EventBus");
  }

  /**
   * Handle incoming event and update metrics
   */
  private handleEvent(event: PmlEvent): void {
    const eventType = event.type as EventType;
    const payload = event.payload as Record<string, unknown>;

    switch (eventType) {
      // Tool events
      case "tool.start":
        this.toolCallsTotal++;
        break;

      case "tool.end":
        if (payload.success) {
          this.toolCallsSuccess++;
        } else {
          this.toolCallsFailed++;
        }
        if (typeof payload.durationMs === "number") {
          observeHistogram(this.toolCallDuration, payload.durationMs);
        }
        break;

      // Capability events
      case "capability.start":
        this.capabilityExecutionsTotal++;
        break;

      case "capability.learned":
        this.capabilityLearnedTotal++;
        break;

      case "capability.matched":
        this.capabilityMatchedTotal++;
        break;

      // DAG events
      case "dag.started":
        this.dagExecutionsTotal++;
        if (typeof payload.executionId === "string") {
          this.activeDags.add(payload.executionId);
          this.activeDagExecutions = this.activeDags.size;
        }
        break;

      case "dag.task.completed":
        this.dagTasksCompleted++;
        if (typeof payload.durationMs === "number") {
          observeHistogram(this.dagTaskDuration, payload.durationMs);
        }
        break;

      case "dag.task.failed":
        this.dagTasksFailed++;
        break;

      case "dag.completed":
        if (typeof payload.executionId === "string") {
          this.activeDags.delete(payload.executionId);
          this.activeDagExecutions = this.activeDags.size;
        }
        if (typeof payload.totalDurationMs === "number") {
          observeHistogram(this.dagExecutionDuration, payload.totalDurationMs);
        }
        break;

      // Graph events
      case "graph.edge.created":
        this.graphEdgesCreated++;
        break;

      case "graph.edge.updated":
        this.graphEdgesUpdated++;
        break;

      case "graph.synced":
        this.graphSyncsTotal++;
        break;

      // System events
      case "heartbeat":
        if (typeof payload.connectedClients === "number") {
          this.connectedSseClients = payload.connectedClients;
        }
        break;

      default:
        // Ignore other events
        break;
    }
  }

  /**
   * Get current metrics snapshot
   */
  getMetrics(): MetricsSnapshot {
    return {
      counters: {
        tool_calls_total: this.toolCallsTotal,
        tool_calls_success: this.toolCallsSuccess,
        tool_calls_failed: this.toolCallsFailed,
        capability_executions_total: this.capabilityExecutionsTotal,
        capability_learned_total: this.capabilityLearnedTotal,
        capability_matched_total: this.capabilityMatchedTotal,
        dag_executions_total: this.dagExecutionsTotal,
        dag_tasks_completed: this.dagTasksCompleted,
        dag_tasks_failed: this.dagTasksFailed,
        graph_edges_created: this.graphEdgesCreated,
        graph_edges_updated: this.graphEdgesUpdated,
        graph_syncs_total: this.graphSyncsTotal,
      },
      histograms: {
        tool_call_duration_ms: { ...this.toolCallDuration },
        dag_task_duration_ms: { ...this.dagTaskDuration },
        dag_execution_duration_ms: { ...this.dagExecutionDuration },
      },
      gauges: {
        active_dag_executions: this.activeDagExecutions,
        connected_sse_clients: this.connectedSseClients,
      },
      collected_at: Date.now(),
      uptime_seconds: Math.floor((Date.now() - this.startTime) / 1000),
    };
  }

  /**
   * Reset all metrics (useful for testing)
   */
  reset(): void {
    this.toolCallsTotal = 0;
    this.toolCallsSuccess = 0;
    this.toolCallsFailed = 0;
    this.capabilityExecutionsTotal = 0;
    this.capabilityLearnedTotal = 0;
    this.capabilityMatchedTotal = 0;
    this.dagExecutionsTotal = 0;
    this.dagTasksCompleted = 0;
    this.dagTasksFailed = 0;
    this.graphEdgesCreated = 0;
    this.graphEdgesUpdated = 0;
    this.graphSyncsTotal = 0;

    this.toolCallDuration = createHistogram();
    this.dagTaskDuration = createHistogram();
    this.dagExecutionDuration = createHistogram();

    this.activeDagExecutions = 0;
    this.connectedSseClients = 0;
    this.activeDags.clear();

    logger.debug("MetricsCollector reset");
  }

  /**
   * Get Prometheus-compatible text format
   */
  toPrometheusFormat(): string {
    const metrics = this.getMetrics();
    const lines: string[] = [];

    // Counters
    lines.push("# HELP pml_tool_calls_total Total number of tool calls");
    lines.push("# TYPE pml_tool_calls_total counter");
    lines.push(`pml_tool_calls_total ${metrics.counters.tool_calls_total}`);

    lines.push("# HELP pml_tool_calls_success_total Successful tool calls");
    lines.push("# TYPE pml_tool_calls_success_total counter");
    lines.push(`pml_tool_calls_success_total ${metrics.counters.tool_calls_success}`);

    lines.push("# HELP pml_tool_calls_failed_total Failed tool calls");
    lines.push("# TYPE pml_tool_calls_failed_total counter");
    lines.push(`pml_tool_calls_failed_total ${metrics.counters.tool_calls_failed}`);

    lines.push("# HELP pml_capability_learned_total Capabilities learned");
    lines.push("# TYPE pml_capability_learned_total counter");
    lines.push(`pml_capability_learned_total ${metrics.counters.capability_learned_total}`);

    lines.push("# HELP pml_dag_executions_total Total DAG executions");
    lines.push("# TYPE pml_dag_executions_total counter");
    lines.push(`pml_dag_executions_total ${metrics.counters.dag_executions_total}`);

    // Histograms
    lines.push("# HELP pml_tool_call_duration_ms Tool call duration in milliseconds");
    lines.push("# TYPE pml_tool_call_duration_ms histogram");
    for (const bucket of metrics.histograms.tool_call_duration_ms.buckets) {
      lines.push(`pml_tool_call_duration_ms_bucket{le="${bucket.le}"} ${bucket.count}`);
    }
    lines.push(
      `pml_tool_call_duration_ms_bucket{le="+Inf"} ${metrics.histograms.tool_call_duration_ms.count}`,
    );
    lines.push(`pml_tool_call_duration_ms_sum ${metrics.histograms.tool_call_duration_ms.sum}`);
    lines.push(`pml_tool_call_duration_ms_count ${metrics.histograms.tool_call_duration_ms.count}`);

    // Gauges
    lines.push("# HELP pml_active_dag_executions Currently active DAG executions");
    lines.push("# TYPE pml_active_dag_executions gauge");
    lines.push(`pml_active_dag_executions ${metrics.gauges.active_dag_executions}`);

    lines.push("# HELP pml_connected_sse_clients Connected SSE clients");
    lines.push("# TYPE pml_connected_sse_clients gauge");
    lines.push(`pml_connected_sse_clients ${metrics.gauges.connected_sse_clients}`);

    return lines.join("\n");
  }

  /**
   * Cleanup - unsubscribe from EventBus
   */
  close(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    logger.info("MetricsCollector closed");
  }
}

/**
 * Singleton metrics collector instance
 */
let metricsCollectorInstance: MetricsCollector | null = null;

/**
 * Get or create singleton MetricsCollector
 */
export function getMetricsCollector(): MetricsCollector {
  if (!metricsCollectorInstance) {
    metricsCollectorInstance = new MetricsCollector();
  }
  return metricsCollectorInstance;
}

/**
 * Close singleton MetricsCollector
 */
export function closeMetricsCollector(): void {
  if (metricsCollectorInstance) {
    metricsCollectorInstance.close();
    metricsCollectorInstance = null;
  }
}
