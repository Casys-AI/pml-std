/**
 * GraphSyncController Unit Tests
 *
 * Tests for event-driven incremental graph updates.
 *
 * @module tests/unit/mcp/graph-sync/controller
 */

import { assertEquals } from "jsr:@std/assert@1";
import {
  GraphSyncController,
  type CapabilityZoneCreatedPayload,
  type CapabilityZoneUpdatedPayload,
  type CapabilityMergedPayload,
} from "../../../../src/mcp/graph-sync/controller.ts";
import { eventBus } from "../../../../src/events/mod.ts";

// Mock types
interface MockGraphEngine {
  addCapabilityNode: (id: string, toolIds: string[]) => void;
  syncFromDatabase: () => Promise<void>;
  getGraphSnapshot: () => { nodes: string[]; edges: Array<{ from: string; to: string }> };
}

interface MockDbClient {
  query: (sql: string, params?: unknown[]) => Promise<unknown[]>;
}

interface MockSHGAT {
  registerCapability: (cap: unknown) => void;
}

// Helper to create controller with mocks
function createTestController(options?: {
  graphEngine?: MockGraphEngine | null;
  shgat?: MockSHGAT | null;
  dbQueryResult?: unknown[];
}): {
  controller: GraphSyncController;
  mocks: {
    graphEngine: MockGraphEngine | null;
    db: MockDbClient;
    shgat: MockSHGAT | null;
    calls: {
      addCapabilityNode: Array<{ id: string; toolIds: string[] }>;
      syncFromDatabase: number;
      registerCapability: unknown[];
      dbQuery: Array<{ sql: string; params?: unknown[] }>;
    };
  };
} {
  const calls = {
    addCapabilityNode: [] as Array<{ id: string; toolIds: string[] }>,
    syncFromDatabase: 0,
    registerCapability: [] as unknown[],
    dbQuery: [] as Array<{ sql: string; params?: unknown[] }>,
  };

  const mockGraphEngine: MockGraphEngine | null = options?.graphEngine === null ? null : {
    addCapabilityNode: (id: string, toolIds: string[]) => {
      calls.addCapabilityNode.push({ id, toolIds });
    },
    syncFromDatabase: async () => {
      calls.syncFromDatabase++;
    },
    getGraphSnapshot: () => ({ nodes: [], edges: [] }),
  };

  const mockDb: MockDbClient = {
    query: async (sql: string, params?: unknown[]) => {
      calls.dbQuery.push({ sql, params });
      return options?.dbQueryResult ?? [];
    },
  };

  const mockSHGAT: MockSHGAT | null = options?.shgat === null ? null : {
    registerCapability: (cap: unknown) => {
      calls.registerCapability.push(cap);
    },
  };

  const controller = new GraphSyncController(
    mockGraphEngine as unknown as import("../../../../src/graphrag/graph-engine.ts").GraphRAGEngine,
    mockDb as unknown as import("../../../../src/db/types.ts").DbClient,
    () => mockSHGAT as import("../../../../src/graphrag/algorithms/shgat.ts").SHGAT | null,
  );

  return {
    controller,
    mocks: {
      graphEngine: mockGraphEngine,
      db: mockDb,
      shgat: mockSHGAT,
      calls,
    },
  };
}

Deno.test("GraphSyncController - start and stop", async (t) => {
  await t.step("start() subscribes to capability events", () => {
    const { controller } = createTestController();

    // Should not throw
    controller.start();
    controller.stop();
  });

  await t.step("stop() unsubscribes from all events", async () => {
    const { controller, mocks } = createTestController();

    controller.start();
    controller.stop();

    // Emit event after stop - should not trigger handlers
    eventBus.emit({
      type: "capability.zone.created",
      source: "test",
      timestamp: Date.now(),
      payload: { capabilityId: "test", toolIds: [] },
    });

    await new Promise((r) => setTimeout(r, 50));

    // Graph engine should not have been called
    assertEquals(mocks.calls.addCapabilityNode.length, 0);
  });

  await t.step("multiple starts are safe (idempotent)", () => {
    const { controller } = createTestController();

    controller.start();
    controller.start(); // Second start should be safe
    controller.stop();
  });

  await t.step("multiple stops are safe", () => {
    const { controller } = createTestController();

    controller.start();
    controller.stop();
    controller.stop(); // Second stop should be safe
  });
});

Deno.test("GraphSyncController - handleCapabilityCreated", async (t) => {
  await t.step("updates graph engine with new capability", async () => {
    const { controller, mocks } = createTestController();
    controller.start();

    const payload: CapabilityZoneCreatedPayload = {
      capabilityId: "cap-123",
      toolIds: ["tool:a", "tool:b"],
      label: "Test Capability",
    };

    eventBus.emit({
      type: "capability.zone.created",
      source: "test",
      timestamp: Date.now(),
      payload,
    });

    await new Promise((r) => setTimeout(r, 100));

    assertEquals(mocks.calls.addCapabilityNode.length, 1);
    assertEquals(mocks.calls.addCapabilityNode[0].id, "cap-123");
    assertEquals(mocks.calls.addCapabilityNode[0].toolIds, ["tool:a", "tool:b"]);

    controller.stop();
  });

  await t.step("handles missing graph engine gracefully", async () => {
    const { controller } = createTestController({ graphEngine: null });
    controller.start();

    const payload: CapabilityZoneCreatedPayload = {
      capabilityId: "cap-123",
      toolIds: ["tool:a"],
    };

    // Should not throw
    eventBus.emit({
      type: "capability.zone.created",
      source: "test",
      timestamp: Date.now(),
      payload,
    });

    await new Promise((r) => setTimeout(r, 50));
    controller.stop();
  });
});

Deno.test("GraphSyncController - handleCapabilityUpdated", async (t) => {
  await t.step("updates graph engine with updated capability", async () => {
    const { controller, mocks } = createTestController();
    controller.start();

    const payload: CapabilityZoneUpdatedPayload = {
      capabilityId: "cap-456",
      toolIds: ["tool:a", "tool:b", "tool:c"],
    };

    eventBus.emit({
      type: "capability.zone.updated",
      source: "test",
      timestamp: Date.now(),
      payload,
    });

    await new Promise((r) => setTimeout(r, 100));

    assertEquals(mocks.calls.addCapabilityNode.length, 1);
    assertEquals(mocks.calls.addCapabilityNode[0].id, "cap-456");

    controller.stop();
  });
});

Deno.test("GraphSyncController - handleCapabilityMerged", async (t) => {
  await t.step("triggers graph resync after merge", async () => {
    const { controller, mocks } = createTestController();
    controller.start();

    const payload: CapabilityMergedPayload = {
      sourceId: "cap-old",
      sourceName: "Old Capability",
      sourcePatternId: "pattern-old",
      targetId: "cap-new",
      targetName: "New Capability",
      targetPatternId: "pattern-new",
    };

    eventBus.emit({
      type: "capability.merged",
      source: "test",
      timestamp: Date.now(),
      payload,
    });

    await new Promise((r) => setTimeout(r, 200));

    // Verify syncFromDatabase was called at least once
    // (May be called multiple times due to eventBus being global)
    assertEquals(mocks.calls.syncFromDatabase >= 1, true);

    controller.stop();
  });

  await t.step("handles null sourcePatternId gracefully", async () => {
    const { controller } = createTestController();
    controller.start();

    const payload: CapabilityMergedPayload = {
      sourceId: "cap-old",
      sourceName: "Old Capability",
      sourcePatternId: null,
      targetId: "cap-new",
      targetName: "New Capability",
      targetPatternId: "pattern-new",
    };

    // Should not throw
    eventBus.emit({
      type: "capability.merged",
      source: "test",
      timestamp: Date.now(),
      payload,
    });

    await new Promise((r) => setTimeout(r, 100));
    controller.stop();
  });
});

Deno.test("GraphSyncController - SHGAT registration", async (t) => {
  await t.step("registers capability in SHGAT when embedding exists", async () => {
    const { controller, mocks } = createTestController({
      dbQueryResult: [{ intent_embedding: [0.1, 0.2, 0.3] }],
    });
    controller.start();

    const payload: CapabilityZoneCreatedPayload = {
      capabilityId: "cap-with-embedding",
      toolIds: ["tool:a"],
    };

    eventBus.emit({
      type: "capability.zone.created",
      source: "test",
      timestamp: Date.now(),
      payload,
    });

    await new Promise((r) => setTimeout(r, 150));

    assertEquals(mocks.calls.registerCapability.length, 1);

    controller.stop();
  });

  await t.step("skips SHGAT registration when no embedding", async () => {
    const { controller, mocks } = createTestController({
      dbQueryResult: [],
    });
    controller.start();

    const payload: CapabilityZoneCreatedPayload = {
      capabilityId: "cap-no-embedding",
      toolIds: ["tool:a"],
    };

    eventBus.emit({
      type: "capability.zone.created",
      source: "test",
      timestamp: Date.now(),
      payload,
    });

    await new Promise((r) => setTimeout(r, 100));

    assertEquals(mocks.calls.registerCapability.length, 0);

    controller.stop();
  });

  await t.step("handles null SHGAT gracefully", async () => {
    const { controller } = createTestController({ shgat: null });
    controller.start();

    const payload: CapabilityZoneCreatedPayload = {
      capabilityId: "cap-123",
      toolIds: ["tool:a"],
    };

    // Should not throw
    eventBus.emit({
      type: "capability.zone.created",
      source: "test",
      timestamp: Date.now(),
      payload,
    });

    await new Promise((r) => setTimeout(r, 50));
    controller.stop();
  });

  await t.step("handles string embedding (JSON format)", async () => {
    const { controller, mocks } = createTestController({
      dbQueryResult: [{ intent_embedding: "[0.1, 0.2, 0.3]" }],
    });
    controller.start();

    const payload: CapabilityZoneCreatedPayload = {
      capabilityId: "cap-string-embedding",
      toolIds: ["tool:a"],
    };

    eventBus.emit({
      type: "capability.zone.created",
      source: "test",
      timestamp: Date.now(),
      payload,
    });

    await new Promise((r) => setTimeout(r, 150));

    assertEquals(mocks.calls.registerCapability.length, 1);

    controller.stop();
  });
});
