/**
 * Unit tests for MetricsCollector
 * Story 6.5: EventBus with BroadcastChannel (ADR-036)
 */

import { assertEquals, assertExists } from "@std/assert";
import { MetricsCollector } from "../../../src/telemetry/metrics-collector.ts";
import { eventBus } from "../../../src/events/mod.ts";

Deno.test("MetricsCollector", async (t) => {
  await t.step("initializes with zero counters", () => {
    const collector = new MetricsCollector();
    const metrics = collector.getMetrics();

    assertEquals(metrics.counters.tool_calls_total, 0);
    assertEquals(metrics.counters.capability_learned_total, 0);
    assertEquals(metrics.counters.dag_executions_total, 0);
    assertExists(metrics.collected_at);
    assertExists(metrics.uptime_seconds);

    collector.close();
  });

  await t.step("counts tool.start events", async () => {
    const collector = new MetricsCollector();

    eventBus.emit({
      type: "tool.start",
      source: "test",
      payload: { toolId: "test:tool", traceId: "123" },
    });

    // Allow event propagation
    await new Promise((r) => setTimeout(r, 10));

    const metrics = collector.getMetrics();
    assertEquals(metrics.counters.tool_calls_total, 1);

    collector.close();
  });

  await t.step("counts tool.end events with success/failure", async () => {
    const collector = new MetricsCollector();

    // Success
    eventBus.emit({
      type: "tool.end",
      source: "test",
      payload: { toolId: "test:tool", traceId: "123", success: true, durationMs: 50 },
    });

    // Failure
    eventBus.emit({
      type: "tool.end",
      source: "test",
      payload: { toolId: "test:tool2", traceId: "456", success: false, durationMs: 100 },
    });

    await new Promise((r) => setTimeout(r, 10));

    const metrics = collector.getMetrics();
    assertEquals(metrics.counters.tool_calls_success, 1);
    assertEquals(metrics.counters.tool_calls_failed, 1);
    assertEquals(metrics.histograms.tool_call_duration_ms.count, 2);
    assertEquals(metrics.histograms.tool_call_duration_ms.sum, 150);

    collector.close();
  });

  await t.step("counts capability events", async () => {
    const collector = new MetricsCollector();

    eventBus.emit({
      type: "capability.start",
      source: "test",
      payload: { capability_id: "cap1", capability: "test", traceId: "123" },
    });

    eventBus.emit({
      type: "capability.learned",
      source: "test",
      payload: {
        capability_id: "cap1",
        name: "test",
        intent: "do something",
        tools_used: [],
        is_new: true,
        usage_count: 1,
        success_rate: 1.0,
      },
    });

    eventBus.emit({
      type: "capability.matched",
      source: "test",
      payload: {
        capability_id: "cap1",
        name: "test",
        intent: "do something",
        score: 0.9,
        semantic_score: 0.85,
        threshold_used: 0.7,
        selected: true,
      },
    });

    await new Promise((r) => setTimeout(r, 10));

    const metrics = collector.getMetrics();
    assertEquals(metrics.counters.capability_executions_total, 1);
    assertEquals(metrics.counters.capability_learned_total, 1);
    assertEquals(metrics.counters.capability_matched_total, 1);

    collector.close();
  });

  await t.step("tracks DAG execution lifecycle", async () => {
    const collector = new MetricsCollector();

    // DAG started
    eventBus.emit({
      type: "dag.started",
      source: "test",
      payload: {
        executionId: "dag-1",
        task_count: 3,
        layer_count: 2,
        task_ids: ["t1", "t2", "t3"],
      },
    });

    await new Promise((r) => setTimeout(r, 10));

    let metrics = collector.getMetrics();
    assertEquals(metrics.counters.dag_executions_total, 1);
    assertEquals(metrics.gauges.active_dag_executions, 1);

    // Task completed
    eventBus.emit({
      type: "dag.task.completed",
      source: "test",
      payload: { executionId: "dag-1", taskId: "t1", tool: "test:tool", durationMs: 100 },
    });

    // Task failed
    eventBus.emit({
      type: "dag.task.failed",
      source: "test",
      payload: {
        executionId: "dag-1",
        taskId: "t2",
        tool: "test:tool2",
        error: "timeout",
        recoverable: true,
      },
    });

    await new Promise((r) => setTimeout(r, 10));

    metrics = collector.getMetrics();
    assertEquals(metrics.counters.dag_tasks_completed, 1);
    assertEquals(metrics.counters.dag_tasks_failed, 1);

    // DAG completed
    eventBus.emit({
      type: "dag.completed",
      source: "test",
      payload: {
        executionId: "dag-1",
        totalDurationMs: 500,
        successfulTasks: 2,
        failedTasks: 1,
        success: false,
      },
    });

    await new Promise((r) => setTimeout(r, 10));

    metrics = collector.getMetrics();
    assertEquals(metrics.gauges.active_dag_executions, 0);
    assertEquals(metrics.histograms.dag_execution_duration_ms.count, 1);
    assertEquals(metrics.histograms.dag_execution_duration_ms.sum, 500);

    collector.close();
  });

  await t.step("counts graph events", async () => {
    const collector = new MetricsCollector();

    eventBus.emit({
      type: "graph.edge.created",
      source: "test",
      payload: { from_toolId: "a", to_toolId: "b", confidence_score: 0.8 },
    });

    eventBus.emit({
      type: "graph.edge.updated",
      source: "test",
      payload: {
        from_toolId: "a",
        to_toolId: "b",
        old_confidence: 0.8,
        new_confidence: 0.9,
        observed_count: 2,
      },
    });

    eventBus.emit({
      type: "graph.synced",
      source: "test",
      payload: { nodeCount: 10, edgeCount: 15, sync_durationMs: 50 },
    });

    await new Promise((r) => setTimeout(r, 10));

    const metrics = collector.getMetrics();
    assertEquals(metrics.counters.graph_edges_created, 1);
    assertEquals(metrics.counters.graph_edges_updated, 1);
    assertEquals(metrics.counters.graph_syncs_total, 1);

    collector.close();
  });

  await t.step("tracks SSE clients via heartbeat", async () => {
    const collector = new MetricsCollector();

    eventBus.emit({
      type: "heartbeat",
      source: "test",
      payload: { connectedClients: 5, uptimeSeconds: 100 },
    });

    await new Promise((r) => setTimeout(r, 10));

    const metrics = collector.getMetrics();
    assertEquals(metrics.gauges.connected_sse_clients, 5);

    collector.close();
  });

  await t.step("reset() clears all metrics", async () => {
    const collector = new MetricsCollector();

    eventBus.emit({ type: "tool.start", source: "test", payload: { toolId: "t", traceId: "1" } });
    eventBus.emit({ type: "capability.learned", source: "test", payload: {} });
    await new Promise((r) => setTimeout(r, 10));

    let metrics = collector.getMetrics();
    assertEquals(metrics.counters.tool_calls_total, 1);
    assertEquals(metrics.counters.capability_learned_total, 1);

    collector.reset();

    metrics = collector.getMetrics();
    assertEquals(metrics.counters.tool_calls_total, 0);
    assertEquals(metrics.counters.capability_learned_total, 0);

    collector.close();
  });

  await t.step("toPrometheusFormat() generates valid format", async () => {
    const collector = new MetricsCollector();

    eventBus.emit({ type: "tool.start", source: "test", payload: { toolId: "t", traceId: "1" } });
    eventBus.emit({
      type: "tool.end",
      source: "test",
      payload: { toolId: "t", traceId: "1", success: true, durationMs: 50 },
    });
    await new Promise((r) => setTimeout(r, 10));

    const prometheus = collector.toPrometheusFormat();

    // Check format (prefix renamed from cai_ to pml_)
    assertEquals(prometheus.includes("# HELP pml_tool_calls_total"), true);
    assertEquals(prometheus.includes("# TYPE pml_tool_calls_total counter"), true);
    assertEquals(prometheus.includes("pml_tool_calls_total 1"), true);
    assertEquals(prometheus.includes("pml_tool_call_duration_ms_bucket"), true);

    collector.close();
  });

  await t.step("histogram buckets accumulate correctly", async () => {
    const collector = new MetricsCollector();

    // Emit events with different durations
    const durations = [5, 15, 30, 75, 150, 300, 600, 1200, 3000, 6000, 12000];

    for (const duration of durations) {
      eventBus.emit({
        type: "tool.end",
        source: "test",
        payload: { toolId: "t", traceId: String(duration), success: true, durationMs: duration },
      });
    }

    await new Promise((r) => setTimeout(r, 20));

    const metrics = collector.getMetrics();
    const hist = metrics.histograms.tool_call_duration_ms;

    // Verify count and sum
    assertEquals(hist.count, 11);
    assertEquals(hist.sum, durations.reduce((a, b) => a + b, 0));

    // Verify bucket counts (each bucket counts values <= its le)
    // buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000]
    // values:  [5, 15, 30, 75, 150, 300, 600, 1200, 3000, 6000, 12000]
    assertEquals(hist.buckets[0].count, 1); // le=5:    [5]
    assertEquals(hist.buckets[1].count, 1); // le=10:   [5]
    assertEquals(hist.buckets[2].count, 2); // le=25:   [5, 15]
    assertEquals(hist.buckets[3].count, 3); // le=50:   [5, 15, 30]
    assertEquals(hist.buckets[4].count, 4); // le=100:  [5, 15, 30, 75]
    assertEquals(hist.buckets[5].count, 5); // le=250:  [5, 15, 30, 75, 150]
    assertEquals(hist.buckets[6].count, 6); // le=500:  [5, 15, 30, 75, 150, 300]
    assertEquals(hist.buckets[7].count, 7); // le=1000: [5, 15, 30, 75, 150, 300, 600]
    assertEquals(hist.buckets[8].count, 8); // le=2500: [5, 15, 30, 75, 150, 300, 600, 1200]
    assertEquals(hist.buckets[9].count, 9); // le=5000: [5, 15, 30, 75, 150, 300, 600, 1200, 3000]
    assertEquals(hist.buckets[10].count, 10); // le=10000:[5, 15, 30, 75, 150, 300, 600, 1200, 3000, 6000]

    collector.close();
  });
});
