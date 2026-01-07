/**
 * Layer-Level Permission Escalation Handling
 *
 * Implements the Deferred Escalation Pattern for permission errors that occur
 * during parallel task execution. Instead of blocking inside Promise.allSettled,
 * we collect escalation errors and handle them at the layer boundary where
 * the generator can properly yield decision_required events.
 *
 * Extracted from controlled-executor.ts for single responsibility.
 *
 * @module dag/permissions/layer-escalation
 */

import type { TaskResult, ExecutionEvent } from "../types.ts";
import { PermissionEscalationNeeded } from "../types.ts";
import type { Task } from "../../graphrag/types.ts";
import type { PermissionSet } from "../../capabilities/types.ts";
import type { CommandQueue } from "../command-queue.ts";
import { waitForDecisionCommand } from "../loops/decision-waiter.ts";
import { executeCodeTask, type CodeTaskExecutorDeps } from "../execution/code-task-executor.ts";
import * as log from "@std/log";

/**
 * Escalation preparation result
 */
export interface EscalationPreparation {
  /** Escalation entries with events */
  escalations: EscalationEntry[];
  /** Events to yield to generator */
  events: ExecutionEvent[];
}

/**
 * Single escalation entry
 */
export interface EscalationEntry {
  /** Index in layer results */
  index: number;
  /** The escalation error */
  error: PermissionEscalationNeeded;
  /** The event to emit */
  event: ExecutionEvent;
}

/**
 * Permission suggestion based on detected operation
 */
const PERMISSION_SUGGESTIONS: Record<string, string> = {
  net: "Use primitives:http_get or primitives:http_post for HTTP requests.",
  read: "Use filesystem:read_file for file access.",
  write: "Use filesystem:write_file for file writing.",
  env: "Environment variable access is restricted in sandbox mode.",
  run: "Subprocess execution is not allowed in sandbox mode.",
  ffi: "FFI calls are not allowed in sandbox mode.",
};

/**
 * Get helpful suggestion for permission errors
 */
export function getPermissionSuggestion(detectedOperation: string): string {
  return PERMISSION_SUGGESTIONS[detectedOperation] ?? "Consider using an authorized MCP tool instead.";
}

/**
 * Phase 1: Prepare escalation events without blocking.
 *
 * Scans layer results for PermissionEscalationNeeded errors and creates
 * decision_required events to be yielded by the generator.
 *
 * Deferred Escalation Pattern: Separate event creation from blocking wait
 * so the generator can yield the events before waiting for responses.
 *
 * @param workflowId - Current workflow ID
 * @param layer - Tasks in the current layer
 * @param layerResults - Results from Promise.allSettled
 * @returns Escalation preparation with events to yield
 */
export function prepareEscalations(
  workflowId: string,
  layer: Task[],
  layerResults: PromiseSettledResult<{ output: unknown; executionTimeMs: number }>[],
): EscalationPreparation {
  const escalations: EscalationEntry[] = [];
  const events: ExecutionEvent[] = [];

  for (let i = 0; i < layerResults.length; i++) {
    const result = layerResults[i];
    // Use name check instead of instanceof (ES modules in Deno can break instanceof)
    if (result.status === "rejected" && result.reason?.name === "PermissionEscalationNeeded") {
      const error = result.reason as PermissionEscalationNeeded;
      const task = layer[i];

      // Build helpful suggestion based on detected operation
      const suggestion = getPermissionSuggestion(error.detectedOperation);

      const escalationEvent: ExecutionEvent = {
        type: "decision_required",
        timestamp: Date.now(),
        workflowId,
        decisionType: "HIL",
        description:
          `[Task: ${task.id}] Permission denied: ${error.detectedOperation} access requires ${error.requestedSet}. ${suggestion}`,
        checkpointId: `perm-esc-${task.id}`,
        context: {
          taskId: task.id,
          currentSet: error.currentSet,
          requestedSet: error.requestedSet,
          detectedOperation: error.detectedOperation,
          originalError: error.originalError,
          suggestion,
        },
      };

      escalations.push({ index: i, error, event: escalationEvent });
      events.push(escalationEvent);
    }
  }

  if (escalations.length > 0) {
    log.info(`Found ${escalations.length} permission escalation(s) to handle at layer boundary`);
  }

  return { escalations, events };
}

/**
 * Phase 2: Wait for escalation responses and re-execute tasks.
 *
 * Called AFTER the generator has yielded the escalation events.
 * Now we can safely block because the MCP handler has received
 * the events and can send approval.
 *
 * @param layer - Tasks in the current layer
 * @param layerResults - Original layer results
 * @param previousResults - Previous task results for dependency resolution
 * @param escalations - Escalation entries from prepareEscalations
 * @param commandQueue - Command queue for receiving responses
 * @param hilTimeout - Timeout for HIL responses
 * @param codeTaskDeps - Dependencies for code task execution
 * @returns Updated layer results with re-executed tasks
 */
export async function processEscalationResponses(
  layer: Task[],
  layerResults: PromiseSettledResult<{ output: unknown; executionTimeMs: number }>[],
  previousResults: Map<string, TaskResult>,
  escalations: EscalationEntry[],
  commandQueue: CommandQueue,
  hilTimeout: number,
  codeTaskDeps: CodeTaskExecutorDeps,
): Promise<PromiseSettledResult<{ output: unknown; executionTimeMs: number }>[]> {
  if (escalations.length === 0) {
    return layerResults;
  }

  const updatedResults = [...layerResults];

  for (const { index, error } of escalations) {
    const task = layer[index];

    log.info(`Waiting for HIL approval for task ${task.id} permission escalation`);

    const command = await waitForDecisionCommand(
      commandQueue,
      "HIL",
      hilTimeout,
    );

    if (!command) {
      log.warn(`Permission escalation timeout for task ${task.id}`);
      updatedResults[index] = {
        status: "rejected",
        reason: new Error(`Permission escalation timeout for task ${task.id}`),
      };
      continue;
    }

    if (
      (command.type === "permission_escalation_response" ||
        command.type === "approval_response") &&
      command.approved
    ) {
      log.info(
        `Permission escalation approved for task ${task.id}, re-executing with ${error.requestedSet}`,
      );

      try {
        const updatedTask: Task = {
          ...task,
          sandboxConfig: {
            ...task.sandboxConfig,
            permissionSet: error.requestedSet as PermissionSet,
          },
        };

        const result = await executeCodeTask(
          updatedTask,
          previousResults,
          codeTaskDeps,
        );
        updatedResults[index] = { status: "fulfilled", value: result };
        log.info(`Task ${task.id} re-execution successful after escalation`);
      } catch (retryError) {
        log.error(`Task ${task.id} re-execution failed after escalation: ${retryError}`);
        updatedResults[index] = {
          status: "rejected",
          reason: retryError,
        };
      }
    } else {
      log.info(`Permission escalation rejected for task ${task.id}`);
      updatedResults[index] = {
        status: "rejected",
        reason: new Error(
          `Permission escalation rejected for task ${task.id}: ${
            command.feedback ?? "User rejected"
          }`,
        ),
      };
    }
  }

  return updatedResults;
}
