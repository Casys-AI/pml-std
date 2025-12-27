/**
 * Unit tests for EventBus
 * Story 6.5: EventBus with BroadcastChannel (ADR-036)
 *
 * Tests:
 * - Event emission and subscription
 * - Wildcard subscriptions
 * - Unsubscribe functionality
 * - Handler error isolation
 * - Close/reset behavior
 * - Performance requirements
 */

import { assertEquals, assertExists } from "@std/assert";
import { EventBus } from "../../../src/events/event-bus.ts";
import type {
  EventType,
  PmlEvent,
  ToolEndPayload,
  ToolStartPayload,
} from "../../../src/events/types.ts";

Deno.test("EventBus", async (t) => {
  await t.step("creates instance with BroadcastChannel", () => {
    const bus = new EventBus();
    assertExists(bus);
    assertEquals(bus.isClosed(), false);
    bus.close();
  });

  await t.step("emits and receives events via on()", async () => {
    const bus = new EventBus();
    const received: PmlEvent[] = [];

    const unsubscribe = bus.on("tool.start", (event) => {
      received.push(event);
    });

    bus.emit<"tool.start">({
      type: "tool.start",
      source: "test",
      payload: {
        toolId: "github:list_repos",
        traceId: "trace-123",
      } as ToolStartPayload,
    });

    // Allow async dispatch
    await new Promise((r) => setTimeout(r, 10));

    assertEquals(received.length, 1);
    assertEquals(received[0].type, "tool.start");
    assertEquals(received[0].source, "test");
    assertEquals((received[0].payload as ToolStartPayload).toolId, "github:list_repos");
    assertExists(received[0].timestamp);

    unsubscribe();
    bus.close();
  });

  await t.step("supports wildcard subscription '*'", async () => {
    const bus = new EventBus();
    const received: string[] = [];

    const unsubscribe = bus.on("*", (event) => {
      received.push(event.type);
    });

    bus.emit({ type: "tool.start", source: "test", payload: {} });
    bus.emit({ type: "tool.end", source: "test", payload: {} });
    bus.emit({ type: "dag.started", source: "test", payload: {} });

    await new Promise((r) => setTimeout(r, 10));

    assertEquals(received.length, 3);
    assertEquals(received[0], "tool.start");
    assertEquals(received[1], "tool.end");
    assertEquals(received[2], "dag.started");

    unsubscribe();
    bus.close();
  });

  await t.step("unsubscribe function removes handler", async () => {
    const bus = new EventBus();
    const received: PmlEvent[] = [];

    const unsubscribe = bus.on("tool.start", (event) => {
      received.push(event);
    });

    bus.emit({ type: "tool.start", source: "test1", payload: {} });
    await new Promise((r) => setTimeout(r, 10));
    assertEquals(received.length, 1);

    // Unsubscribe
    unsubscribe();

    bus.emit({ type: "tool.start", source: "test2", payload: {} });
    await new Promise((r) => setTimeout(r, 10));
    assertEquals(received.length, 1); // Still 1, not 2

    bus.close();
  });

  await t.step("off() method removes handler", async () => {
    const bus = new EventBus();
    const received: PmlEvent[] = [];

    const handler = (event: PmlEvent) => {
      received.push(event);
    };

    bus.on("tool.start", handler);
    bus.emit({ type: "tool.start", source: "test1", payload: {} });
    await new Promise((r) => setTimeout(r, 10));
    assertEquals(received.length, 1);

    // Remove via off()
    bus.off("tool.start", handler);

    bus.emit({ type: "tool.start", source: "test2", payload: {} });
    await new Promise((r) => setTimeout(r, 10));
    assertEquals(received.length, 1); // Still 1

    bus.close();
  });

  await t.step("once() subscribes for single event only", async () => {
    const bus = new EventBus();
    const received: PmlEvent[] = [];

    bus.once("tool.start", (event) => {
      received.push(event);
    });

    bus.emit({ type: "tool.start", source: "test1", payload: {} });
    bus.emit({ type: "tool.start", source: "test2", payload: {} });
    bus.emit({ type: "tool.start", source: "test3", payload: {} });

    await new Promise((r) => setTimeout(r, 10));
    assertEquals(received.length, 1);
    assertEquals(received[0].source, "test1");

    bus.close();
  });

  await t.step("handler errors do not affect other handlers", async () => {
    const bus = new EventBus();
    const received: string[] = [];

    bus.on("tool.start", () => {
      throw new Error("Handler 1 error");
    });

    bus.on("tool.start", (event) => {
      received.push(event.source);
    });

    bus.emit({ type: "tool.start", source: "test", payload: {} });
    await new Promise((r) => setTimeout(r, 10));

    assertEquals(received.length, 1);
    assertEquals(received[0], "test");

    bus.close();
  });

  await t.step("async handler errors are caught", async () => {
    const bus = new EventBus();
    const received: string[] = [];

    bus.on("tool.start", async () => {
      await new Promise((r) => setTimeout(r, 5));
      throw new Error("Async handler error");
    });

    bus.on("tool.start", (event) => {
      received.push(event.source);
    });

    bus.emit({ type: "tool.start", source: "test", payload: {} });
    await new Promise((r) => setTimeout(r, 20));

    assertEquals(received.length, 1);

    bus.close();
  });

  await t.step("adds timestamp automatically if not provided", async () => {
    const bus = new EventBus();
    const received: PmlEvent[] = [];

    bus.on("tool.start", (event) => {
      received.push(event);
    });

    const beforeEmit = Date.now();
    bus.emit({ type: "tool.start", source: "test", payload: {} });
    const afterEmit = Date.now();

    await new Promise((r) => setTimeout(r, 10));

    assertEquals(received.length, 1);
    const timestamp = received[0].timestamp;
    assertEquals(timestamp >= beforeEmit, true);
    assertEquals(timestamp <= afterEmit, true);

    bus.close();
  });

  await t.step("preserves provided timestamp", async () => {
    const bus = new EventBus();
    const received: PmlEvent[] = [];

    bus.on("tool.start", (event) => {
      received.push(event);
    });

    const customTimestamp = 1234567890;
    bus.emit({ type: "tool.start", source: "test", payload: {}, timestamp: customTimestamp });

    await new Promise((r) => setTimeout(r, 10));

    assertEquals(received.length, 1);
    assertEquals(received[0].timestamp, customTimestamp);

    bus.close();
  });

  await t.step("hasHandlers() returns correct status", () => {
    const bus = new EventBus();

    assertEquals(bus.hasHandlers("tool.start"), false);

    const unsubscribe = bus.on("tool.start", () => {});
    assertEquals(bus.hasHandlers("tool.start"), true);

    unsubscribe();
    assertEquals(bus.hasHandlers("tool.start"), false);

    bus.close();
  });

  await t.step("getHandlerCount() returns correct count", () => {
    const bus = new EventBus();

    assertEquals(bus.getHandlerCount("tool.start"), 0);

    const unsub1 = bus.on("tool.start", () => {});
    assertEquals(bus.getHandlerCount("tool.start"), 1);

    const unsub2 = bus.on("tool.start", () => {});
    assertEquals(bus.getHandlerCount("tool.start"), 2);

    unsub1();
    assertEquals(bus.getHandlerCount("tool.start"), 1);

    unsub2();
    assertEquals(bus.getHandlerCount("tool.start"), 0);

    bus.close();
  });

  await t.step("getEmitCount() tracks emitted events", () => {
    const bus = new EventBus();

    assertEquals(bus.getEmitCount(), 0);

    bus.emit({ type: "tool.start", source: "test", payload: {} });
    assertEquals(bus.getEmitCount(), 1);

    bus.emit({ type: "tool.end", source: "test", payload: {} });
    bus.emit({ type: "dag.started", source: "test", payload: {} });
    assertEquals(bus.getEmitCount(), 3);

    bus.close();
  });

  await t.step("getRegisteredTypes() returns registered event types", () => {
    const bus = new EventBus();

    assertEquals(bus.getRegisteredTypes(), []);

    bus.on("tool.start", () => {});
    bus.on("tool.end", () => {});
    bus.on("*", () => {}); // Wildcard not included

    const types = bus.getRegisteredTypes();
    assertEquals(types.length, 2);
    assertEquals(types.includes("tool.start" as EventType), true);
    assertEquals(types.includes("tool.end" as EventType), true);

    bus.close();
  });

  await t.step("close() prevents further operations", async () => {
    const bus = new EventBus();
    const received: PmlEvent[] = [];

    bus.on("tool.start", (event) => {
      received.push(event);
    });

    bus.close();

    assertEquals(bus.isClosed(), true);

    // Emit after close should be ignored
    bus.emit({ type: "tool.start", source: "test", payload: {} });
    await new Promise((r) => setTimeout(r, 10));
    assertEquals(received.length, 0);

    // on() after close should return no-op unsubscribe
    const unsub = bus.on("tool.end", () => {});
    assertEquals(typeof unsub, "function");
    unsub(); // Should not throw
  });

  await t.step("reset() re-initializes EventBus", () => {
    const bus = new EventBus();

    bus.emit({ type: "tool.start", source: "test", payload: {} });
    bus.emit({ type: "tool.end", source: "test", payload: {} });
    assertEquals(bus.getEmitCount(), 2);

    bus.close();
    assertEquals(bus.isClosed(), true);

    bus.reset();
    assertEquals(bus.isClosed(), false);
    assertEquals(bus.getEmitCount(), 0);

    bus.close();
  });

  await t.step("multiple handlers for same event type", async () => {
    const bus = new EventBus();
    const results: number[] = [];

    bus.on("tool.start", () => {
      results.push(1);
    });
    bus.on("tool.start", () => {
      results.push(2);
    });
    bus.on("tool.start", () => {
      results.push(3);
    });

    bus.emit({ type: "tool.start", source: "test", payload: {} });
    await new Promise((r) => setTimeout(r, 10));

    assertEquals(results.length, 3);
    assertEquals(results.includes(1), true);
    assertEquals(results.includes(2), true);
    assertEquals(results.includes(3), true);

    bus.close();
  });

  await t.step("PERFORMANCE: emit overhead < 1ms", async () => {
    const bus = new EventBus();
    const iterations = 1000;

    // Warmup
    for (let i = 0; i < 100; i++) {
      bus.emit({ type: "tool.start", source: "warmup", payload: {} });
    }

    bus.reset(); // Reset counter

    // Measure
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      bus.emit({ type: "tool.start", source: "perf-test", payload: { i } });
    }
    const elapsed = performance.now() - start;

    const avgPerEmit = elapsed / iterations;
    console.log(`EventBus emit: ${avgPerEmit.toFixed(3)}ms avg (${iterations} iterations)`);

    // Requirement: < 1ms per emit
    assertEquals(
      avgPerEmit < 1,
      true,
      `Emit overhead ${avgPerEmit.toFixed(3)}ms exceeds 1ms limit`,
    );

    bus.close();
  });

  await t.step("correctly types event payloads", () => {
    const bus = new EventBus();

    // This is a compile-time check - if types are wrong, TypeScript will error
    bus.on("tool.start", (event) => {
      const payload = event.payload as ToolStartPayload;
      // Access typed properties - use void to suppress unused warnings
      void (payload.toolId as string);
      void (payload.traceId as string);
    });

    bus.on("tool.end", (event) => {
      const payload = event.payload as ToolEndPayload;
      void (payload.success as boolean);
      void (payload.durationMs as number);
    });

    bus.close();
  });
});

// Integration test with singleton
Deno.test("eventBus singleton", async (t) => {
  const { eventBus } = await import("../../../src/events/mod.ts");

  await t.step("is accessible via module export", () => {
    assertExists(eventBus);
    assertEquals(eventBus.isClosed(), false);
  });

  await t.step("can emit and receive events", async () => {
    const received: string[] = [];

    const unsubscribe = eventBus.on("system.startup", (event) => {
      received.push(event.source);
    });

    eventBus.emit({ type: "system.startup", source: "singleton-test", payload: {} });
    await new Promise((r) => setTimeout(r, 10));

    assertEquals(received.length, 1);
    assertEquals(received[0], "singleton-test");

    unsubscribe();
  });
});
