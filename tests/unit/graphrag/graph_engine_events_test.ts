/**
 * Unit tests for GraphRAGEngine event emission
 * Story 6.1: Real-time Events Stream (SSE)
 */

import { assertEquals, assertExists } from "@std/assert";
import { GraphRAGEngine } from "../../../src/graphrag/graph-engine.ts";
import type { GraphEvent } from "../../../src/graphrag/events.ts";
import type { PGliteClient } from "../../../src/db/client.ts";

// Create in-memory mock database
function createMockDB(): PGliteClient {
  const mockData = {
    tools: [] as unknown[],
    dependencies: [] as unknown[],
  };

  return {
    query: async (sql: string, _params?: unknown[]) => {
      if (sql.includes("FROM tool_embedding")) {
        return mockData.tools;
      }
      if (sql.includes("FROM tool_dependency")) {
        return mockData.dependencies;
      }
      return [];
    },
  } as PGliteClient;
}

Deno.test({
  name: "GraphRAGEngine - on/off subscription",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () => {
    const db = createMockDB();
    const engine = new GraphRAGEngine(db);

    let eventReceived = false;
    const listener = (event: GraphEvent) => {
      eventReceived = true;
      assertEquals(event.type, "heartbeat");
    };

    // Subscribe
    engine.on("graph_event", listener);

    // Unsubscribe
    engine.off("graph_event", listener);

    // Event should not be received after unsubscription
    assertEquals(eventReceived, false);
  },
});

Deno.test({
  name: "GraphRAGEngine - graph_synced event on syncFromDatabase",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const db = createMockDB();
    const engine = new GraphRAGEngine(db);

    const eventsReceived: GraphEvent[] = [];
    engine.on("graph_event", (event) => {
      eventsReceived.push(event);
    });

    await engine.syncFromDatabase();

    // Should receive one graph_synced event
    const syncedEvents = eventsReceived.filter((e) => e.type === "graph_synced");
    assertEquals(syncedEvents.length, 1);

    const syncEvent = syncedEvents[0];
    assertEquals(syncEvent.type, "graph_synced");
    assertExists(syncEvent.data.nodeCount);
    assertExists(syncEvent.data.edgeCount);
    assertExists(syncEvent.data.syncDurationMs);
    assertExists(syncEvent.data.timestamp);

    // Timestamp should be valid ISO8601
    const timestamp = new Date(syncEvent.data.timestamp);
    assertEquals(timestamp instanceof Date && !isNaN(timestamp.getTime()), true);
  },
});

Deno.test({
  name: "GraphRAGEngine - event payload structure",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const db = createMockDB();
    const engine = new GraphRAGEngine(db);

    const eventsReceived: GraphEvent[] = [];
    engine.on("graph_event", (event) => {
      eventsReceived.push(event);
    });

    await engine.syncFromDatabase();

    const event = eventsReceived[0];

    // Verify all required fields exist
    assertExists(event.type);
    assertExists(event.data);
    assertExists(event.data.timestamp);

    // Timestamp should be ISO8601 format
    const timestampRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    assertEquals(timestampRegex.test(event.data.timestamp), true);
  },
});

Deno.test({
  name: "GraphRAGEngine - multiple listeners",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const db = createMockDB();
    const engine = new GraphRAGEngine(db);

    let listener1Called = false;
    let listener2Called = false;

    engine.on("graph_event", () => {
      listener1Called = true;
    });

    engine.on("graph_event", () => {
      listener2Called = true;
    });

    await engine.syncFromDatabase();

    assertEquals(listener1Called, true);
    assertEquals(listener2Called, true);
  },
});

Deno.test({
  name: "GraphRAGEngine - unsubscribe one listener",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const db = createMockDB();
    const engine = new GraphRAGEngine(db);

    let listener1CallCount = 0;
    let listener2CallCount = 0;

    const listener1 = () => {
      listener1CallCount++;
    };

    const listener2 = () => {
      listener2CallCount++;
    };

    engine.on("graph_event", listener1);
    engine.on("graph_event", listener2);

    await engine.syncFromDatabase();

    assertEquals(listener1CallCount, 1);
    assertEquals(listener2CallCount, 1);

    // Unsubscribe listener1
    engine.off("graph_event", listener1);

    await engine.syncFromDatabase();

    // listener1 should not be called again
    assertEquals(listener1CallCount, 1);
    // listener2 should be called again
    assertEquals(listener2CallCount, 2);
  },
});
