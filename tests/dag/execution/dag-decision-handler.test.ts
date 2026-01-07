/**
 * Unit Tests: DAGDecisionHandler
 *
 * Tests the AIL/HIL decision strategy implementation.
 *
 * @module tests/dag/execution/dag-decision-handler
 */

import { assertEquals, assertExists } from "jsr:@std/assert@1";
import { DAGDecisionHandler, type DecisionContext } from "../../../src/dag/execution/dag-decision-handler.ts";
import { EventStream } from "../../../src/dag/event-stream.ts";
import { CommandQueue } from "../../../src/dag/command-queue.ts";
import type { WorkflowState } from "../../../src/dag/state.ts";
import type { DAGStructure, Task } from "../../../src/graphrag/types.ts";
import type { ExecutorConfig } from "../../../src/dag/types.ts";

// ============================================================================
// Test Utilities
// ============================================================================

function createMockState(): WorkflowState {
  return {
    workflowId: "test-workflow",
    currentLayer: 0,
    messages: [],
    tasks: [],
    decisions: [],
    context: {},
  };
}

function createMockDAG(): DAGStructure {
  return {
    tasks: [
      { id: "task1", tool: "test:tool1", arguments: {}, dependsOn: [] },
      { id: "task2", tool: "test:tool2", arguments: {}, dependsOn: ["task1"] },
    ],
  };
}

function createMockLayers(): Task[][] {
  const dag = createMockDAG();
  return [[dag.tasks[0]], [dag.tasks[1]]];
}

function createTestContext(overrides?: Partial<DecisionContext>): DecisionContext {
  return {
    workflowId: "test-workflow-123",
    state: createMockState(),
    layers: createMockLayers(),
    dag: createMockDAG(),
    config: {},
    eventStream: new EventStream(),
    commandQueue: new CommandQueue(),
    episodicMemory: null,
    dagSuggester: null,
    replanCount: 0,
    timeouts: { hil: 5000, ail: 5000 },
    ...overrides,
  };
}

// ============================================================================
// Test Suite: prepareAILDecision
// ============================================================================

Deno.test("DAGDecisionHandler: prepareAILDecision", async (t) => {
  await t.step("returns no event when AIL is disabled", async () => {
    const handler = new DAGDecisionHandler();
    const ctx = createTestContext({ config: {} }); // AIL not enabled

    const result = await handler.prepareAILDecision(ctx, 0, false);

    assertEquals(result.event, null);
    assertEquals(result.needsResponse, false);
  });

  await t.step("returns event when AIL per_layer is enabled", async () => {
    const handler = new DAGDecisionHandler();
    const config: ExecutorConfig = {
      ail: { enabled: true, decision_points: "per_layer" },
    };
    const ctx = createTestContext({ config });

    const result = await handler.prepareAILDecision(ctx, 0, false);

    assertExists(result.event);
    assertEquals(result.event?.type, "decision_required");
    assertEquals(result.event?.decisionType, "AIL");
    assertEquals(result.needsResponse, true);
  });

  await t.step("returns no event when AIL on_error but no errors", async () => {
    const handler = new DAGDecisionHandler();
    const config: ExecutorConfig = {
      ail: { enabled: true, decision_points: "on_error" },
    };
    const ctx = createTestContext({ config });

    const result = await handler.prepareAILDecision(ctx, 0, false);

    assertEquals(result.event, null);
    assertEquals(result.needsResponse, false);
  });

  await t.step("returns event when AIL on_error and has errors", async () => {
    const handler = new DAGDecisionHandler();
    const config: ExecutorConfig = {
      ail: { enabled: true, decision_points: "on_error" },
    };
    const ctx = createTestContext({ config });

    const result = await handler.prepareAILDecision(ctx, 0, true); // hasErrors = true

    assertExists(result.event);
    assertEquals(result.event?.type, "decision_required");
    assertEquals(result.event?.decisionType, "AIL");
    assertEquals(result.needsResponse, true);
  });

  await t.step("emits event to eventStream", async () => {
    const handler = new DAGDecisionHandler();
    const config: ExecutorConfig = {
      ail: { enabled: true, decision_points: "per_layer" },
    };
    const eventStream = new EventStream();
    const ctx = createTestContext({ config, eventStream });

    await handler.prepareAILDecision(ctx, 0, false);

    // Check stats to verify emission
    const stats = eventStream.getStats();
    assertEquals(stats.total_events, 1);
  });
});

// ============================================================================
// Test Suite: prepareHILApproval
// ============================================================================

Deno.test("DAGDecisionHandler: prepareHILApproval", async (t) => {
  await t.step("returns no event when HIL is disabled", async () => {
    const handler = new DAGDecisionHandler();
    const ctx = createTestContext({ config: {} }); // HIL not enabled
    const layer = createMockLayers()[0];

    const result = await handler.prepareHILApproval(ctx, 0, layer);

    assertEquals(result.event, null);
    assertEquals(result.needsResponse, false);
  });

  await t.step("returns event when HIL always is enabled", async () => {
    const handler = new DAGDecisionHandler();
    const config: ExecutorConfig = {
      hil: { enabled: true, approval_required: "always" },
    };
    const ctx = createTestContext({ config });
    const layer = createMockLayers()[0];

    const result = await handler.prepareHILApproval(ctx, 0, layer);

    assertExists(result.event);
    assertEquals(result.event?.type, "decision_required");
    assertEquals(result.event?.decisionType, "HIL");
    assertEquals(result.needsResponse, true);
  });

  await t.step("returns no event when HIL never", async () => {
    const handler = new DAGDecisionHandler();
    const config: ExecutorConfig = {
      hil: { enabled: true, approval_required: "never" },
    };
    const ctx = createTestContext({ config });
    const layer = createMockLayers()[0];

    const result = await handler.prepareHILApproval(ctx, 0, layer);

    assertEquals(result.event, null);
    assertEquals(result.needsResponse, false);
  });
});

// ============================================================================
// Test Suite: waitForAILResponse
// ============================================================================

Deno.test({
  name: "DAGDecisionHandler: waitForAILResponse",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async (t) => {
  await t.step("returns empty result on continue command", async () => {
    const handler = new DAGDecisionHandler();
    const commandQueue = new CommandQueue();
    const ctx = createTestContext({ commandQueue });

    // Enqueue continue command before waiting
    commandQueue.enqueue({ type: "continue", reason: "test" });

    const mockTopologicalSort = (_dag: unknown) => createMockLayers();
    const result = await handler.waitForAILResponse(ctx, mockTopologicalSort);

    assertEquals(result.newLayers, undefined);
    assertEquals(result.newDag, undefined);
  });

  await t.step("returns empty result on timeout (null command)", async () => {
    const handler = new DAGDecisionHandler();
    const commandQueue = new CommandQueue();
    const ctx = createTestContext({
      commandQueue,
      timeouts: { hil: 100, ail: 100 }, // Short timeout
    });

    const mockTopologicalSort = (_dag: unknown) => createMockLayers();

    // Don't enqueue any command - should timeout
    const result = await handler.waitForAILResponse(ctx, mockTopologicalSort);

    assertEquals(result.newLayers, undefined);
    assertEquals(result.newDag, undefined);
  });
  },
});

// ============================================================================
// Test Suite: waitForHILResponse
// ============================================================================

Deno.test({
  name: "DAGDecisionHandler: waitForHILResponse",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async (t) => {
  await t.step("resolves on approval_response with approved=true", async () => {
    const handler = new DAGDecisionHandler();
    const commandQueue = new CommandQueue();
    const ctx = createTestContext({ commandQueue });

    // Enqueue approval command before waiting
    commandQueue.enqueue({
      type: "approval_response",
      checkpointId: "test-checkpoint",
      approved: true,
    });

    // Should resolve without throwing
    await handler.waitForHILResponse(ctx, 0);
  });

  await t.step("throws on approval_response with approved=false", async () => {
    const handler = new DAGDecisionHandler();
    const commandQueue = new CommandQueue();
    const ctx = createTestContext({ commandQueue });

    // Enqueue rejection command before waiting
    commandQueue.enqueue({
      type: "approval_response",
      checkpointId: "test-checkpoint",
      approved: false,
      feedback: "Test rejection",
    });

    let threw = false;
    try {
      await handler.waitForHILResponse(ctx, 0);
    } catch (error) {
      threw = true;
      assertEquals(error instanceof Error, true);
      assertEquals((error as Error).message.includes("Workflow aborted"), true);
    }

    assertEquals(threw, true);
  });

  await t.step("throws on timeout", async () => {
    const handler = new DAGDecisionHandler();
    const commandQueue = new CommandQueue();
    const ctx = createTestContext({
      commandQueue,
      timeouts: { hil: 100, ail: 100 }, // Short timeout
    });

    // Don't enqueue any command - should timeout
    let threw = false;
    try {
      await handler.waitForHILResponse(ctx, 0);
    } catch (error) {
      threw = true;
      assertEquals(error instanceof Error, true);
      assertEquals((error as Error).message.includes("timeout"), true);
    }

    assertEquals(threw, true);
  });
  },
});

console.log("✅ DAGDecisionHandler unit tests completed");
