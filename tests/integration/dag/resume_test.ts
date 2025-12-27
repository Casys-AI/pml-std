/**
 * Integration tests for Resume from Checkpoint
 *
 * Tests:
 * - Resume from checkpoint restores state correctly
 * - Completed layers skipped (no re-execution)
 * - Execution continues from correct layer
 * - State consistency verified (tasks.length preserved)
 * - Multi-turn conversation restored (messages[] intact)
 *
 * @module tests/integration/dag/resume_test
 */

import { assertEquals, assertExists } from "@std/assert";
import { PGliteClient } from "../../../src/db/client.ts";
import { ControlledExecutor } from "../../../src/dag/controlled-executor.ts";
import type { DAGStructure } from "../../../src/graphrag/types.ts";
import type { ExecutionEvent } from "../../../src/dag/types.ts";
import { getAllMigrations, MigrationRunner } from "../../../src/db/migrations.ts";

/**
 * Setup test database with migrations
 */
async function setupTestDb(): Promise<PGliteClient> {
  const db = new PGliteClient(":memory:");
  await db.connect();
  const runner = new MigrationRunner(db);
  await runner.runUp(getAllMigrations());
  return db;
}

/**
 * Mock tool executor for testing
 */
let executedTasks: string[] = [];

async function mockToolExecutor(
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  executedTasks.push(tool);
  await new Promise((resolve) => setTimeout(resolve, 5));
  return { tool, args, result: `executed ${tool}` };
}

Deno.test("Resume from Checkpoint", async (t) => {
  let db: PGliteClient;

  try {
    db = await setupTestDb();
  } finally {
    // Cleanup in substeps
  }

  await t.step("resume from checkpoint restores state correctly", async () => {
    executedTasks = [];

    const executor = new ControlledExecutor(mockToolExecutor);
    executor.setCheckpointManager(db, false);

    // Create 5-layer DAG
    const dag: DAGStructure = {
      tasks: [
        { id: "task1", tool: "tool1", arguments: {}, dependsOn: [] },
        { id: "task2", tool: "tool2", arguments: {}, dependsOn: ["task1"] },
        { id: "task3", tool: "tool3", arguments: {}, dependsOn: ["task2"] },
        { id: "task4", tool: "tool4", arguments: {}, dependsOn: ["task3"] },
        { id: "task5", tool: "tool5", arguments: {}, dependsOn: ["task4"] },
      ],
    };

    // Execute first 3 layers, collect checkpoint from layer 2
    let checkpoint_id: string | null = null;
    let layerCount = 0;

    for await (const event of executor.executeStream(dag, "resume-test-1")) {
      if (event.type === "checkpoint" && event.layerIndex === 2) {
        checkpoint_id = event.checkpointId;
      }
      if (event.type === "layer_start") {
        layerCount++;
      }
    }

    assertExists(checkpoint_id);
    assertEquals(layerCount, 5);
    assertEquals(executedTasks.length, 5);

    // Resume from layer 2 checkpoint
    executedTasks = [];
    const executor2 = new ControlledExecutor(mockToolExecutor);
    executor2.setCheckpointManager(db, false);

    layerCount = 0;
    for await (const event of executor2.resumeFromCheckpoint(dag, checkpoint_id!)) {
      if (event.type === "layer_start") {
        layerCount++;
      }
    }

    // Should execute layers 3 and 4 (indices 3, 4)
    assertEquals(layerCount, 2);
    assertEquals(executedTasks.length, 2);
    assertEquals(executedTasks[0], "tool4");
    assertEquals(executedTasks[1], "tool5");

    // Verify state consistency
    const finalState = executor2.getState();
    assertExists(finalState);
    assertEquals(finalState.tasks.length, 5); // All 5 tasks completed
    assertEquals(finalState.currentLayer, 4); // Final layer is 4
  });

  await t.step("completed layers skipped (no re-execution)", async () => {
    executedTasks = [];

    const executor = new ControlledExecutor(mockToolExecutor);
    executor.setCheckpointManager(db, false);

    const dag: DAGStructure = {
      tasks: [
        { id: "task1", tool: "tool1", arguments: {}, dependsOn: [] },
        { id: "task2", tool: "tool2", arguments: {}, dependsOn: ["task1"] },
        { id: "task3", tool: "tool3", arguments: {}, dependsOn: ["task2"] },
      ],
    };

    // Execute and checkpoint at layer 0
    let checkpoint_id: string | null = null;
    for await (const event of executor.executeStream(dag, "resume-test-2")) {
      if (event.type === "checkpoint" && event.layerIndex === 0) {
        checkpoint_id = event.checkpointId;
      }
    }

    assertExists(checkpoint_id);
    assertEquals(executedTasks.includes("tool1"), true);
    assertEquals(executedTasks.includes("tool2"), true);
    assertEquals(executedTasks.includes("tool3"), true);

    // Resume from layer 0 - should skip layer 0, execute layers 1 and 2
    executedTasks = [];
    const executor2 = new ControlledExecutor(mockToolExecutor);
    executor2.setCheckpointManager(db, false);

    for await (const _ of executor2.resumeFromCheckpoint(dag, checkpoint_id!)) {
      // Consume events
    }

    // tool1 should NOT be re-executed (layer 0 skipped)
    assertEquals(executedTasks.includes("tool1"), false);
    // tool2 and tool3 should be executed
    assertEquals(executedTasks.includes("tool2"), true);
    assertEquals(executedTasks.includes("tool3"), true);
    assertEquals(executedTasks.length, 2);
  });

  await t.step("execution continues from correct layer", async () => {
    executedTasks = [];

    const executor = new ControlledExecutor(mockToolExecutor);
    executor.setCheckpointManager(db, false);

    const dag: DAGStructure = {
      tasks: [
        { id: "task1", tool: "tool1", arguments: {}, dependsOn: [] },
        { id: "task2", tool: "tool2", arguments: {}, dependsOn: ["task1"] },
        { id: "task3", tool: "tool3", arguments: {}, dependsOn: ["task2"] },
        { id: "task4", tool: "tool4", arguments: {}, dependsOn: ["task3"] },
      ],
    };

    // Execute and get checkpoint from layer 1
    let checkpoint_id: string | null = null;
    for await (const event of executor.executeStream(dag, "resume-test-3")) {
      if (event.type === "checkpoint" && event.layerIndex === 1) {
        checkpoint_id = event.checkpointId;
      }
    }

    assertExists(checkpoint_id);

    // Resume should continue from layer 2 (index 2)
    const executor2 = new ControlledExecutor(mockToolExecutor);
    executor2.setCheckpointManager(db, false);

    executedTasks = [];
    const events: ExecutionEvent[] = [];

    for await (const event of executor2.resumeFromCheckpoint(dag, checkpoint_id!)) {
      events.push(event);
    }

    // Find first layer_start event
    const layerStartEvents = events.filter((e) => e.type === "layer_start");
    assertEquals(layerStartEvents.length, 2);

    // First layer should be layer 2
    if (layerStartEvents[0].type === "layer_start") {
      assertEquals(layerStartEvents[0].layerIndex, 2);
    }

    // Second layer should be layer 3
    if (layerStartEvents[1].type === "layer_start") {
      assertEquals(layerStartEvents[1].layerIndex, 3);
    }
  });

  await t.step("state consistency verified post-resume", async () => {
    executedTasks = [];

    const executor = new ControlledExecutor(mockToolExecutor);
    executor.setCheckpointManager(db, false);

    const dag: DAGStructure = {
      tasks: [
        { id: "task1", tool: "tool1", arguments: {}, dependsOn: [] },
        { id: "task2", tool: "tool2", arguments: {}, dependsOn: ["task1"] },
        { id: "task3", tool: "tool3", arguments: {}, dependsOn: ["task2"] },
      ],
    };

    // Execute and get checkpoint from layer 1
    let checkpoint_id: string | null = null;
    for await (const event of executor.executeStream(dag, "resume-test-4")) {
      if (event.type === "checkpoint" && event.layerIndex === 1) {
        checkpoint_id = event.checkpointId;
      }
    }

    const stateBeforeResume = executor.getState();
    assertExists(stateBeforeResume);

    // Resume from checkpoint
    const executor2 = new ControlledExecutor(mockToolExecutor);
    executor2.setCheckpointManager(db, false);

    for await (const _ of executor2.resumeFromCheckpoint(dag, checkpoint_id!)) {
      // Consume events
    }

    const stateAfterResume = executor2.getState();
    assertExists(stateAfterResume);

    // Verify state structure preserved
    assertEquals(stateAfterResume.workflowId, "resume-test-4");
    assertEquals(stateAfterResume.tasks.length, 3); // All 3 tasks
    assertEquals(stateAfterResume.currentLayer, 2); // Final layer
    assertEquals(stateAfterResume.messages.length, 0); // No messages in this test
    assertEquals(stateAfterResume.decisions.length, 0); // No decisions
  });

  await db.close();
});
