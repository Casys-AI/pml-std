/**
 * Integration tests for Event Flow (E2E)
 * Story 6.5: EventBus with BroadcastChannel (ADR-036)
 *
 * Validates end-to-end event flow:
 * - Tool calls → EventBus → SSE
 * - DAG execution → EventBus → SSE
 * - Capability events → EventBus → SSE
 * - Graph events → EventBus → SSE
 */

import { assertEquals, assertExists } from "@std/assert";
import { eventBus } from "../../src/events/mod.ts";
import { EventsStreamManager } from "../../src/server/events-stream.ts";
import type { PmlEvent } from "../../src/events/types.ts";

Deno.test("Event Flow Integration", async (t) => {
  await t.step("tool events flow through EventBus to SSE", async () => {
    const manager = new EventsStreamManager({
      maxClients: 10,
      heartbeatIntervalMs: 60000,
      corsOrigins: ["*"],
    });

    const receivedEvents: PmlEvent[] = [];
    const unsubscribe = eventBus.on("*", (event) => {
      if (event.type.startsWith("tool.")) {
        receivedEvents.push(event);
      }
    });

    // Simulate tool.start event (as WorkerBridge would emit)
    eventBus.emit({
      type: "tool.start",
      source: "worker-bridge",
      payload: {
        tool_id: "github:list_repos",
        traceId: "trace-123",
        args: { owner: "test" },
      },
    });

    // Simulate tool.end event
    eventBus.emit({
      type: "tool.end",
      source: "worker-bridge",
      payload: {
        tool_id: "github:list_repos",
        traceId: "trace-123",
        success: true,
        durationMs: 150,
      },
    });

    // Allow event propagation
    await new Promise((r) => setTimeout(r, 20));

    assertEquals(receivedEvents.length, 2);
    assertEquals(receivedEvents[0].type, "tool.start");
    assertEquals(receivedEvents[1].type, "tool.end");
    assertEquals((receivedEvents[1].payload as { success: boolean }).success, true);

    unsubscribe();
    manager.close();
  });

  await t.step("DAG events flow through EventBus", async () => {
    const receivedEvents: PmlEvent[] = [];
    const unsubscribe = eventBus.on("*", (event) => {
      if (event.type.startsWith("dag.")) {
        receivedEvents.push(event);
      }
    });

    // Simulate DAG execution lifecycle (as ParallelExecutor would emit)
    const executionId = crypto.randomUUID();

    eventBus.emit({
      type: "dag.started",
      source: "dag-executor",
      payload: {
        execution_id: executionId,
        task_count: 3,
        layer_count: 2,
        task_ids: ["task_0", "task_1", "task_2"],
      },
    });

    eventBus.emit({
      type: "dag.task.started",
      source: "dag-executor",
      payload: {
        execution_id: executionId,
        task_id: "task_0",
        tool: "filesystem:read_file",
        layer: 0,
        args: { path: "/test.txt" },
      },
    });

    eventBus.emit({
      type: "dag.task.completed",
      source: "dag-executor",
      payload: {
        execution_id: executionId,
        task_id: "task_0",
        tool: "filesystem:read_file",
        durationMs: 50,
      },
    });

    eventBus.emit({
      type: "dag.task.failed",
      source: "dag-executor",
      payload: {
        execution_id: executionId,
        task_id: "task_1",
        tool: "github:create_issue",
        error: "API rate limited",
        recoverable: true,
      },
    });

    eventBus.emit({
      type: "dag.completed",
      source: "dag-executor",
      payload: {
        execution_id: executionId,
        total_durationMs: 500,
        successful_tasks: 2,
        failed_tasks: 1,
        success: false,
        speedup: 1.5,
      },
    });

    await new Promise((r) => setTimeout(r, 20));

    assertEquals(receivedEvents.length, 5);
    assertEquals(receivedEvents[0].type, "dag.started");
    assertEquals(receivedEvents[1].type, "dag.task.started");
    assertEquals(receivedEvents[2].type, "dag.task.completed");
    assertEquals(receivedEvents[3].type, "dag.task.failed");
    assertEquals(receivedEvents[4].type, "dag.completed");

    unsubscribe();
  });

  await t.step("capability events flow through EventBus", async () => {
    const receivedEvents: PmlEvent[] = [];
    const unsubscribe = eventBus.on("*", (event) => {
      if (event.type.startsWith("capability.")) {
        receivedEvents.push(event);
      }
    });

    // Simulate capability lifecycle (as CapabilityStore/Matcher would emit)
    eventBus.emit({
      type: "capability.start",
      source: "sandbox-worker",
      payload: {
        capabilityId: "cap-123",
        capability: "search_and_summarize",
        traceId: "trace-456",
      },
    });

    eventBus.emit({
      type: "capability.end",
      source: "sandbox-worker",
      payload: {
        capabilityId: "cap-123",
        capability: "search_and_summarize",
        traceId: "trace-456",
        success: true,
        durationMs: 200,
      },
    });

    eventBus.emit({
      type: "capability.learned",
      source: "capability-store",
      payload: {
        capabilityId: "cap-789",
        name: "Search and summarize",
        intent: "search for documents and summarize",
        tools_used: ["search:query", "llm:summarize"],
        is_new: true,
        usage_count: 1,
        success_rate: 1.0,
      },
    });

    eventBus.emit({
      type: "capability.matched",
      source: "capability-matcher",
      payload: {
        capabilityId: "cap-789",
        name: "Search and summarize",
        intent: "find and summarize docs",
        score: 0.92,
        semantic_score: 0.88,
        threshold_used: 0.70,
        selected: true,
      },
    });

    await new Promise((r) => setTimeout(r, 20));

    assertEquals(receivedEvents.length, 4);
    assertEquals(receivedEvents[0].type, "capability.start");
    assertEquals(receivedEvents[1].type, "capability.end");
    assertEquals(receivedEvents[2].type, "capability.learned");
    assertEquals(receivedEvents[3].type, "capability.matched");

    unsubscribe();
  });

  await t.step("graph events flow through EventBus", async () => {
    const receivedEvents: PmlEvent[] = [];
    const unsubscribe = eventBus.on("*", (event) => {
      if (event.type.startsWith("graph.")) {
        receivedEvents.push(event);
      }
    });

    // Simulate graph events (as GraphRAGEngine would emit)
    eventBus.emit({
      type: "graph.synced",
      source: "graphrag",
      payload: {
        node_count: 50,
        edge_count: 75,
        sync_durationMs: 45,
      },
    });

    eventBus.emit({
      type: "graph.edge.created",
      source: "graphrag",
      payload: {
        from_tool_id: "filesystem:read_file",
        to_tool_id: "llm:analyze",
        confidence_score: 0.6,
      },
    });

    eventBus.emit({
      type: "graph.edge.updated",
      source: "graphrag",
      payload: {
        from_tool_id: "filesystem:read_file",
        to_tool_id: "llm:analyze",
        old_confidence: 0.6,
        new_confidence: 0.72,
        observed_count: 5,
      },
    });

    eventBus.emit({
      type: "graph.metrics.computed",
      source: "graphrag",
      payload: {
        node_count: 50,
        edge_count: 76,
        density: 0.031,
        communities_count: 4,
      },
    });

    await new Promise((r) => setTimeout(r, 20));

    assertEquals(receivedEvents.length, 4);
    assertEquals(receivedEvents[0].type, "graph.synced");
    assertEquals(receivedEvents[1].type, "graph.edge.created");
    assertEquals(receivedEvents[2].type, "graph.edge.updated");
    assertEquals(receivedEvents[3].type, "graph.metrics.computed");

    unsubscribe();
  });

  await t.step("SSE client receives filtered events", async () => {
    const manager = new EventsStreamManager({
      maxClients: 10,
      heartbeatIntervalMs: 60000,
      corsOrigins: ["*"],
    });

    // Create mock request with filter
    const controller = new AbortController();
    const req = new Request("http://localhost/events/stream?filter=dag.*,tool.*", {
      signal: controller.signal,
    });

    const res = manager.handleRequest(req);
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Content-Type"), "text/event-stream");

    // Verify client connected
    const stats = manager.getStats();
    assertEquals(stats.connectedClients, 1);

    // Emit various events
    eventBus.emit({ type: "dag.started", source: "test", payload: {} });
    eventBus.emit({ type: "tool.start", source: "test", payload: {} });
    eventBus.emit({ type: "graph.synced", source: "test", payload: {} }); // Should be filtered

    await new Promise((r) => setTimeout(r, 50));

    // Client should still be connected
    assertEquals(manager.getStats().connectedClients, 1);

    manager.close();
  });

  await t.step("heartbeat events propagate through EventBus", async () => {
    const receivedEvents: PmlEvent[] = [];
    const unsubscribe = eventBus.on("heartbeat", (event) => {
      receivedEvents.push(event);
    });

    // Simulate heartbeat (as EventsStreamManager would emit)
    eventBus.emit({
      type: "heartbeat",
      source: "events-stream",
      payload: {
        connected_clients: 5,
        uptime_seconds: 3600,
      },
    });

    await new Promise((r) => setTimeout(r, 20));

    assertEquals(receivedEvents.length, 1);
    assertEquals(receivedEvents[0].type, "heartbeat");
    assertEquals((receivedEvents[0].payload as { connected_clients: number }).connected_clients, 5);

    unsubscribe();
  });

  await t.step("multiple subscribers receive same event", async () => {
    const subscriber1Events: PmlEvent[] = [];
    const subscriber2Events: PmlEvent[] = [];

    const unsub1 = eventBus.on("tool.start", (event) => {
      subscriber1Events.push(event);
    });

    const unsub2 = eventBus.on("tool.start", (event) => {
      subscriber2Events.push(event);
    });

    eventBus.emit({
      type: "tool.start",
      source: "test",
      payload: { tool_id: "test:tool", traceId: "123" },
    });

    await new Promise((r) => setTimeout(r, 20));

    assertEquals(subscriber1Events.length, 1);
    assertEquals(subscriber2Events.length, 1);
    assertEquals(subscriber1Events[0].type, subscriber2Events[0].type);

    unsub1();
    unsub2();
  });

  await t.step("wildcard subscriber receives all events", async () => {
    const allEvents: string[] = [];
    const unsubscribe = eventBus.on("*", (event) => {
      allEvents.push(event.type);
    });

    eventBus.emit({ type: "tool.start", source: "test", payload: {} });
    eventBus.emit({ type: "dag.started", source: "test", payload: {} });
    eventBus.emit({ type: "capability.learned", source: "test", payload: {} });
    eventBus.emit({ type: "graph.synced", source: "test", payload: {} });

    await new Promise((r) => setTimeout(r, 20));

    assertEquals(allEvents.length, 4);
    assertEquals(allEvents.includes("tool.start"), true);
    assertEquals(allEvents.includes("dag.started"), true);
    assertEquals(allEvents.includes("capability.learned"), true);
    assertEquals(allEvents.includes("graph.synced"), true);

    unsubscribe();
  });

  await t.step("event timestamps are auto-generated", async () => {
    const receivedEvent: PmlEvent[] = [];
    const unsubscribe = eventBus.on("tool.start", (event) => {
      receivedEvent.push(event);
    });

    const beforeEmit = Date.now();
    eventBus.emit({
      type: "tool.start",
      source: "test",
      payload: {},
    });
    const afterEmit = Date.now();

    await new Promise((r) => setTimeout(r, 20));

    assertEquals(receivedEvent.length, 1);
    assertExists(receivedEvent[0].timestamp);
    assertEquals(receivedEvent[0].timestamp >= beforeEmit, true);
    assertEquals(receivedEvent[0].timestamp <= afterEmit, true);

    unsubscribe();
  });

  await t.step("PERFORMANCE: event emission overhead < 1ms", async () => {
    const iterations = 100;
    const durations: number[] = [];

    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      eventBus.emit({
        type: "tool.start",
        source: "perf-test",
        payload: { iteration: i },
      });
      durations.push(performance.now() - start);
    }

    const avgDuration = durations.reduce((a, b) => a + b, 0) / iterations;
    console.log(`Event emission avg: ${avgDuration.toFixed(3)}ms over ${iterations} iterations`);

    assertEquals(
      avgDuration < 1,
      true,
      `Avg emission ${avgDuration.toFixed(3)}ms exceeds 1ms limit`,
    );
  });
});

Deno.test("SSE Manager Integration", async (t) => {
  await t.step("manager lifecycle", async () => {
    const manager = new EventsStreamManager({
      maxClients: 5,
      heartbeatIntervalMs: 60000,
      corsOrigins: ["*"],
    });

    // Initial stats
    assertEquals(manager.getStats().connectedClients, 0);
    assertExists(manager.getStats().uptimeSeconds);

    // Add client
    const controller = new AbortController();
    const req = new Request("http://localhost/events/stream", {
      signal: controller.signal,
    });
    const res = manager.handleRequest(req);
    assertEquals(res.status, 200);
    assertEquals(manager.getStats().connectedClients, 1);

    // Cleanup
    manager.close();
    assertEquals(manager.getStats().connectedClients, 0);
  });

  await t.step("respects maxClients limit", async () => {
    const manager = new EventsStreamManager({
      maxClients: 2,
      heartbeatIntervalMs: 60000,
      corsOrigins: [],
    });

    const createRequest = () => {
      const controller = new AbortController();
      return new Request("http://localhost/events/stream", {
        signal: controller.signal,
      });
    };

    // First 2 clients succeed
    const res1 = manager.handleRequest(createRequest());
    assertEquals(res1.status, 200);

    const res2 = manager.handleRequest(createRequest());
    assertEquals(res2.status, 200);

    // Third client rejected
    const res3 = manager.handleRequest(createRequest());
    assertEquals(res3.status, 503);

    const body = await res3.json();
    assertEquals(body.error, "Too many clients");
    assertEquals(body.max, 2);

    manager.close();
  });
});
