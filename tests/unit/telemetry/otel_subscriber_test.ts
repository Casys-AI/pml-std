/**
 * Unit tests for AlgorithmOTELSubscriber
 *
 * Tests EventBus subscription and OTEL span emission.
 *
 * @module tests/unit/telemetry/otel_subscriber_test
 */

import { assertEquals, assertExists } from "@std/assert";
import { AlgorithmOTELSubscriber } from "../../../src/telemetry/subscribers/otel-subscriber.ts";
import { eventBus } from "../../../src/events/mod.ts";
import type { AlgorithmDecisionPayload } from "../../../src/events/types.ts";

/**
 * Create a test algorithm decision payload
 */
function createTestPayload(overrides: Partial<AlgorithmDecisionPayload> = {}): AlgorithmDecisionPayload {
  return {
    traceId: crypto.randomUUID(),
    correlationId: crypto.randomUUID(),
    algorithmName: "TestAlgorithm",
    algorithmMode: "active_search",
    targetType: "tool",
    intent: "Test intent for OTEL subscriber",
    signals: {
      semanticScore: 0.85,
      graphDensity: 0.1,
      spectralClusterMatch: true,
      targetId: "test:tool",
    },
    params: {
      alpha: 0.7,
      reliabilityFactor: 1.0,
      structuralBoost: 0.1,
    },
    finalScore: 0.82,
    thresholdUsed: 0.7,
    decision: "accepted",
    ...overrides,
  };
}

Deno.test("AlgorithmOTELSubscriber - can be instantiated", () => {
  const subscriber = new AlgorithmOTELSubscriber();
  assertExists(subscriber);
});

Deno.test("AlgorithmOTELSubscriber - isActive() returns false before start", () => {
  const subscriber = new AlgorithmOTELSubscriber();
  assertEquals(subscriber.isActive(), false);
});

Deno.test("AlgorithmOTELSubscriber - start() subscribes to events when OTEL enabled", () => {
  // Save original env
  const originalOtelDeno = Deno.env.get("OTEL_DENO");

  try {
    // Enable OTEL
    Deno.env.set("OTEL_DENO", "true");

    const subscriber = new AlgorithmOTELSubscriber();
    subscriber.start();

    assertEquals(subscriber.isActive(), true);

    subscriber.stop();
  } finally {
    // Restore env
    if (originalOtelDeno) {
      Deno.env.set("OTEL_DENO", originalOtelDeno);
    } else {
      Deno.env.delete("OTEL_DENO");
    }
  }
});

Deno.test({
  name: "AlgorithmOTELSubscriber - start() does not subscribe when OTEL disabled",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () => {
    // Save original env
    const originalOtelDeno = Deno.env.get("OTEL_DENO");

    try {
      // Disable OTEL
      Deno.env.delete("OTEL_DENO");

      const subscriber = new AlgorithmOTELSubscriber();
      subscriber.start();

      // Should not be active when OTEL is disabled
      assertEquals(subscriber.isActive(), false);

      subscriber.stop();
    } finally {
      // Restore env
      if (originalOtelDeno) {
        Deno.env.set("OTEL_DENO", originalOtelDeno);
      }
    }
  },
});

Deno.test("AlgorithmOTELSubscriber - stop() unsubscribes from events", () => {
  // Save original env
  const originalOtelDeno = Deno.env.get("OTEL_DENO");

  try {
    Deno.env.set("OTEL_DENO", "true");

    const subscriber = new AlgorithmOTELSubscriber();
    subscriber.start();
    assertEquals(subscriber.isActive(), true);

    subscriber.stop();
    assertEquals(subscriber.isActive(), false);
  } finally {
    if (originalOtelDeno) {
      Deno.env.set("OTEL_DENO", originalOtelDeno);
    } else {
      Deno.env.delete("OTEL_DENO");
    }
  }
});

Deno.test("AlgorithmOTELSubscriber - handles algorithm.decision events", async () => {
  // Save original env
  const originalOtelDeno = Deno.env.get("OTEL_DENO");

  try {
    Deno.env.set("OTEL_DENO", "true");

    const subscriber = new AlgorithmOTELSubscriber();
    subscriber.start();

    // Emit an event - should not throw
    eventBus.emit({
      type: "algorithm.decision",
      source: "test",
      payload: createTestPayload({
        algorithmName: "SHGAT",
        decision: "accepted",
      }),
    });

    // Give the event handler time to process
    await new Promise((resolve) => setTimeout(resolve, 10));

    subscriber.stop();
  } finally {
    if (originalOtelDeno) {
      Deno.env.set("OTEL_DENO", originalOtelDeno);
    } else {
      Deno.env.delete("OTEL_DENO");
    }
  }
});

Deno.test("AlgorithmOTELSubscriber - handles rejected decisions", async () => {
  const originalOtelDeno = Deno.env.get("OTEL_DENO");

  try {
    Deno.env.set("OTEL_DENO", "true");

    const subscriber = new AlgorithmOTELSubscriber();
    subscriber.start();

    // Emit rejected decision
    eventBus.emit({
      type: "algorithm.decision",
      source: "test",
      payload: createTestPayload({
        algorithmName: "HybridSearch",
        decision: "rejected_by_threshold",
        finalScore: 0.45,
      }),
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    subscriber.stop();
  } finally {
    if (originalOtelDeno) {
      Deno.env.set("OTEL_DENO", originalOtelDeno);
    } else {
      Deno.env.delete("OTEL_DENO");
    }
  }
});

Deno.test("AlgorithmOTELSubscriber - handles filtered decisions", async () => {
  const originalOtelDeno = Deno.env.get("OTEL_DENO");

  try {
    Deno.env.set("OTEL_DENO", "true");

    const subscriber = new AlgorithmOTELSubscriber();
    subscriber.start();

    // Emit filtered decision
    eventBus.emit({
      type: "algorithm.decision",
      source: "test",
      payload: createTestPayload({
        algorithmName: "CapabilityMatcher",
        decision: "filtered_by_reliability",
        finalScore: 0.3,
      }),
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    subscriber.stop();
  } finally {
    if (originalOtelDeno) {
      Deno.env.set("OTEL_DENO", originalOtelDeno);
    } else {
      Deno.env.delete("OTEL_DENO");
    }
  }
});

Deno.test("AlgorithmOTELSubscriber - handles missing algorithmName", async () => {
  const originalOtelDeno = Deno.env.get("OTEL_DENO");

  try {
    Deno.env.set("OTEL_DENO", "true");

    const subscriber = new AlgorithmOTELSubscriber();
    subscriber.start();

    // Emit with undefined algorithmName
    const testPayload = createTestPayload();
    testPayload.algorithmName = undefined;

    eventBus.emit({
      type: "algorithm.decision",
      source: "test",
      payload: testPayload,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    subscriber.stop();
  } finally {
    if (originalOtelDeno) {
      Deno.env.set("OTEL_DENO", originalOtelDeno);
    } else {
      Deno.env.delete("OTEL_DENO");
    }
  }
});

Deno.test("AlgorithmOTELSubscriber - handles missing intent", async () => {
  const originalOtelDeno = Deno.env.get("OTEL_DENO");

  try {
    Deno.env.set("OTEL_DENO", "true");

    const subscriber = new AlgorithmOTELSubscriber();
    subscriber.start();

    // Emit with undefined intent
    const testPayload = createTestPayload();
    testPayload.intent = undefined;

    eventBus.emit({
      type: "algorithm.decision",
      source: "test",
      payload: testPayload,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    subscriber.stop();
  } finally {
    if (originalOtelDeno) {
      Deno.env.set("OTEL_DENO", originalOtelDeno);
    } else {
      Deno.env.delete("OTEL_DENO");
    }
  }
});

Deno.test("AlgorithmOTELSubscriber - handles rapid event burst", async () => {
  const originalOtelDeno = Deno.env.get("OTEL_DENO");

  try {
    Deno.env.set("OTEL_DENO", "true");

    const subscriber = new AlgorithmOTELSubscriber();
    subscriber.start();

    // Rapid fire 10 events
    for (let i = 0; i < 10; i++) {
      eventBus.emit({
        type: "algorithm.decision",
        source: "test",
        payload: createTestPayload({
          algorithmName: `Algorithm${i}`,
          finalScore: Math.random(),
          decision: Math.random() > 0.5 ? "accepted" : "rejected",
        }),
      });
    }

    await new Promise((resolve) => setTimeout(resolve, 50));

    subscriber.stop();
  } finally {
    if (originalOtelDeno) {
      Deno.env.set("OTEL_DENO", originalOtelDeno);
    } else {
      Deno.env.delete("OTEL_DENO");
    }
  }
});

Deno.test("AlgorithmOTELSubscriber - multiple start/stop cycles work", () => {
  const originalOtelDeno = Deno.env.get("OTEL_DENO");

  try {
    Deno.env.set("OTEL_DENO", "true");

    const subscriber = new AlgorithmOTELSubscriber();

    // Cycle 1
    subscriber.start();
    assertEquals(subscriber.isActive(), true);
    subscriber.stop();
    assertEquals(subscriber.isActive(), false);

    // Cycle 2
    subscriber.start();
    assertEquals(subscriber.isActive(), true);
    subscriber.stop();
    assertEquals(subscriber.isActive(), false);

    // Cycle 3
    subscriber.start();
    assertEquals(subscriber.isActive(), true);
    subscriber.stop();
    assertEquals(subscriber.isActive(), false);
  } finally {
    if (originalOtelDeno) {
      Deno.env.set("OTEL_DENO", originalOtelDeno);
    } else {
      Deno.env.delete("OTEL_DENO");
    }
  }
});

Deno.test("AlgorithmOTELSubscriber - different target types handled", async () => {
  const originalOtelDeno = Deno.env.get("OTEL_DENO");

  try {
    Deno.env.set("OTEL_DENO", "true");

    const subscriber = new AlgorithmOTELSubscriber();
    subscriber.start();

    // Tool target
    eventBus.emit({
      type: "algorithm.decision",
      source: "test",
      payload: createTestPayload({
        targetType: "tool",
        algorithmName: "HybridSearch",
      }),
    });

    // Capability target
    eventBus.emit({
      type: "algorithm.decision",
      source: "test",
      payload: createTestPayload({
        targetType: "capability",
        algorithmName: "CapabilityMatcher",
      }),
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    subscriber.stop();
  } finally {
    if (originalOtelDeno) {
      Deno.env.set("OTEL_DENO", originalOtelDeno);
    } else {
      Deno.env.delete("OTEL_DENO");
    }
  }
});

Deno.test("AlgorithmOTELSubscriber - different algorithm modes handled", async () => {
  const originalOtelDeno = Deno.env.get("OTEL_DENO");

  try {
    Deno.env.set("OTEL_DENO", "true");

    const subscriber = new AlgorithmOTELSubscriber();
    subscriber.start();

    // Active search
    eventBus.emit({
      type: "algorithm.decision",
      source: "test",
      payload: createTestPayload({
        algorithmMode: "active_search",
      }),
    });

    // Passive suggestion
    eventBus.emit({
      type: "algorithm.decision",
      source: "test",
      payload: createTestPayload({
        algorithmMode: "passive_suggestion",
      }),
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    subscriber.stop();
  } finally {
    if (originalOtelDeno) {
      Deno.env.set("OTEL_DENO", originalOtelDeno);
    } else {
      Deno.env.delete("OTEL_DENO");
    }
  }
});
