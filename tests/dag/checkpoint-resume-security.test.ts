/**
 * Critical Security Tests: Checkpoint Resume AIL/HIL Enforcement
 *
 * Tests for H4 fix: resumeFromCheckpoint must include AIL/HIL decision points
 * to prevent security bypass where workflows skip human approval after crash resume.
 *
 * @security CRITICAL - These tests validate a security fix
 *
 * ## FIXED BUGS (2025-12-17)
 *
 * The Deferred Pattern has been implemented in controlled-executor.ts:
 * - prepareHILApproval/waitForHILResponse: yield event BEFORE blocking
 * - prepareAILDecision/waitForAILResponse: yield event BEFORE blocking
 *
 * These tests now serve as regression tests to prevent these bugs from returning.
 * See: docs/tech-specs/tech-spec-hil-permission-escalation-fix.md
 */

import { assertEquals, assertExists, assertRejects } from "jsr:@std/assert@1";
import { ControlledExecutor } from "../../src/dag/controlled-executor.ts";
import type { DAGStructure } from "../../src/graphrag/types.ts";
import type { ExecutorConfig, ToolExecutor } from "../../src/dag/types.ts";
import { PGliteClient } from "../../src/db/client.ts";
import { getAllMigrations, MigrationRunner } from "../../src/db/migrations.ts";

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
 * Helper to run workflow with auto-approval for HIL/AIL
 * Returns checkpoint ID from first layer
 */
async function runWorkflowWithAutoApproval(
  executor: ControlledExecutor,
  dag: DAGStructure,
): Promise<string> {
  const streamGen = executor.executeStream(dag);
  let checkpointId: string | undefined;

  for await (const event of streamGen) {
    if (event.type === "checkpoint" && event.layerIndex === 0) {
      checkpointId = event.checkpointId;
    }
    // Auto-approve any decision points during initial execution
    if (event.type === "decision_required") {
      if (event.decisionType === "HIL") {
        executor.enqueueCommand({
          type: "approval_response",
          checkpointId: "auto",
          approved: true,
        });
      } else if (event.decisionType === "AIL") {
        executor.enqueueCommand({ type: "continue", reason: "auto-continue" });
      }
    }
  }

  if (!checkpointId) {
    throw new Error("No checkpoint created during workflow execution");
  }
  return checkpointId;
}

Deno.test({
  name: "Checkpoint Resume Security - AIL/HIL Enforcement",
  sanitizeOps: false, // Timer leaks from CommandQueue.waitForCommand are expected
  sanitizeResources: false,
  fn: async (t) => {
    // Mock tool executor
    const mockToolExecutor: ToolExecutor = async (tool: string, _args: Record<string, unknown>) => {
      await new Promise((resolve) => setTimeout(resolve, 5)); // Small delay
      return { result: `executed_${tool}` };
    };

    await t.step("SECURITY: Resume with HIL enabled requires approval", async () => {
      const config: ExecutorConfig = {
        hil: { enabled: true, approval_required: "always" },
        ail: { enabled: false, decision_points: "manual" }, // Explicitly disable AIL for HIL test
        timeouts: { hil: 5000 },
      };

      const executor = new ControlledExecutor(mockToolExecutor, config);
      const db = await setupTestDb();
      executor.setCheckpointManager(db, false);

      const dag: DAGStructure = {
        tasks: [
          { id: "task1", tool: "server:tool1", arguments: {}, dependsOn: [] },
          { id: "task2", tool: "server:tool2", arguments: {}, dependsOn: ["task1"] },
          { id: "task3", tool: "server:tool3", arguments: {}, dependsOn: ["task2"] },
        ],
      };

      // Execute with auto-approval to get checkpoint
      const checkpointId = await runWorkflowWithAutoApproval(executor, dag);
      assertExists(checkpointId);

      // Resume - should STILL require HIL
      const resumeGen = executor.resumeFromCheckpoint(dag, checkpointId);
      let hilRequiredOnResume = false;
      let resumeCompleted = false;

      for await (const event of resumeGen) {
        if (event.type === "decision_required" && event.decisionType === "HIL") {
          hilRequiredOnResume = true;
          executor.enqueueCommand({
            type: "approval_response",
            checkpointId: "resume",
            approved: true,
          });
        }
        if (event.type === "workflow_complete") {
          resumeCompleted = true;
        }
      }

      assertEquals(
        hilRequiredOnResume,
        true,
        "SECURITY VIOLATION: HIL decision point MUST be triggered on resume (H4 fix validation)",
      );
      assertEquals(resumeCompleted, true, "Workflow should complete after approval");

      await db.close();
    });

    await t.step("SECURITY: Resume with HIL, reject approval → workflow aborted", async () => {
      const config: ExecutorConfig = {
        hil: { enabled: true, approval_required: "always" },
        ail: { enabled: false, decision_points: "manual" }, // Explicitly disable AIL for HIL test
        timeouts: { hil: 5000 },
      };

      const executor = new ControlledExecutor(mockToolExecutor, config);
      const db = await setupTestDb();
      executor.setCheckpointManager(db, false);

      const dag: DAGStructure = {
        tasks: [
          { id: "task1", tool: "server:tool1", arguments: {}, dependsOn: [] },
          { id: "task2", tool: "server:tool2", arguments: {}, dependsOn: ["task1"] },
        ],
      };

      const checkpointId = await runWorkflowWithAutoApproval(executor, dag);
      assertExists(checkpointId);

      // Resume and REJECT - should throw
      const resumeGen = executor.resumeFromCheckpoint(dag, checkpointId);

      await assertRejects(
        async () => {
          for await (const event of resumeGen) {
            if (event.type === "decision_required" && event.decisionType === "HIL") {
              executor.enqueueCommand({
                type: "approval_response",
                checkpointId: "reject",
                approved: false,
                feedback: "Security test: rejecting",
              });
            }
          }
        },
        Error,
        "aborted by human",
      );

      await db.close();
    });

    await t.step("SECURITY: Resume with AIL enabled triggers decision point", async () => {
      const config: ExecutorConfig = {
        ail: { enabled: true, decision_points: "per_layer" },
        hil: { enabled: false, approval_required: "never" }, // Explicitly disable HIL for AIL test
        timeouts: { ail: 3000 },
      };

      const executor = new ControlledExecutor(mockToolExecutor, config);
      const db = await setupTestDb();
      executor.setCheckpointManager(db, false);

      const dag: DAGStructure = {
        tasks: [
          { id: "task1", tool: "server:tool1", arguments: {}, dependsOn: [] },
          { id: "task2", tool: "server:tool2", arguments: {}, dependsOn: ["task1"] },
        ],
      };

      const checkpointId = await runWorkflowWithAutoApproval(executor, dag);
      assertExists(checkpointId);

      // Resume - should trigger AIL again
      const resumeGen = executor.resumeFromCheckpoint(dag, checkpointId);
      let ailTriggeredOnResume = false;

      for await (const event of resumeGen) {
        if (event.type === "decision_required" && event.decisionType === "AIL") {
          ailTriggeredOnResume = true;
          executor.enqueueCommand({ type: "continue", reason: "Resume execution" });
        }
      }

      assertEquals(
        ailTriggeredOnResume,
        true,
        "SECURITY: AIL decision point MUST be triggered on resume (H4 fix validation)",
      );

      await db.close();
    });

    await t.step("SECURITY: Resume with AIL, abort command → workflow stopped", async () => {
      const config: ExecutorConfig = {
        ail: { enabled: true, decision_points: "per_layer" },
        hil: { enabled: false, approval_required: "never" }, // Explicitly disable HIL for AIL test
        timeouts: { ail: 3000 },
      };

      const executor = new ControlledExecutor(mockToolExecutor, config);
      const db = await setupTestDb();
      executor.setCheckpointManager(db, false);

      const dag: DAGStructure = {
        tasks: [
          { id: "task1", tool: "server:tool1", arguments: {}, dependsOn: [] },
          { id: "task2", tool: "server:tool2", arguments: {}, dependsOn: ["task1"] },
        ],
      };

      const checkpointId = await runWorkflowWithAutoApproval(executor, dag);
      assertExists(checkpointId);

      // Resume and abort
      const resumeGen = executor.resumeFromCheckpoint(dag, checkpointId);

      await assertRejects(
        async () => {
          for await (const event of resumeGen) {
            if (event.type === "decision_required" && event.decisionType === "AIL") {
              executor.enqueueCommand({ type: "abort", reason: "Security test: abort" });
            }
          }
        },
        Error,
        "aborted by agent",
      );

      await db.close();
    });

    await t.step(
      "Resume without HIL/AIL → executes normally (backward compatibility)",
      async () => {
        const config: ExecutorConfig = {
          hil: { enabled: false, approval_required: "never" },
          ail: { enabled: false, decision_points: "manual" },
        };

        const executor = new ControlledExecutor(mockToolExecutor, config);
        const db = await setupTestDb();
        executor.setCheckpointManager(db, false);

        const dag: DAGStructure = {
          tasks: [
            { id: "task1", tool: "server:tool1", arguments: {}, dependsOn: [] },
            { id: "task2", tool: "server:tool2", arguments: {}, dependsOn: ["task1"] },
          ],
        };

        // Execute (no approval needed)
        const streamGen = executor.executeStream(dag);
        let checkpointId: string | undefined;

        for await (const event of streamGen) {
          if (event.type === "checkpoint" && event.layerIndex === 0) {
            checkpointId = event.checkpointId;
          }
        }

        assertExists(checkpointId);

        // Resume should complete without waiting
        const resumeGen = executor.resumeFromCheckpoint(dag, checkpointId);
        let completed = false;

        for await (const event of resumeGen) {
          if (event.type === "workflow_complete") {
            completed = true;
          }
        }

        assertEquals(completed, true, "Workflow should complete without HIL/AIL");

        await db.close();
      },
    );

    await t.step("SECURITY: HIL timeout on resume → workflow aborted (no bypass)", async () => {
      const config: ExecutorConfig = {
        hil: { enabled: true, approval_required: "always" },
        ail: { enabled: false, decision_points: "manual" }, // Explicitly disable AIL for HIL test
        timeouts: { hil: 300 }, // Very short timeout (300ms)
      };

      const executor = new ControlledExecutor(mockToolExecutor, config);
      const db = await setupTestDb();
      executor.setCheckpointManager(db, false);

      const dag: DAGStructure = {
        tasks: [
          { id: "task1", tool: "server:tool1", arguments: {}, dependsOn: [] },
          { id: "task2", tool: "server:tool2", arguments: {}, dependsOn: ["task1"] },
        ],
      };

      const checkpointId = await runWorkflowWithAutoApproval(executor, dag);
      assertExists(checkpointId);

      // Resume and DO NOT approve → should timeout
      const resumeGen = executor.resumeFromCheckpoint(dag, checkpointId);

      await assertRejects(
        async () => {
          for await (const _event of resumeGen) {
            // Do not send approval - let it timeout
          }
        },
        Error,
        "timeout",
      );

      await db.close();
    });
  },
});
