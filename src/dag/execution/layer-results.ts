/**
 * Layer Results Collection
 *
 * Collects and processes task results from a DAG execution layer,
 * handling success, error, and safe-to-fail cases.
 *
 * Extracted from controlled-executor.ts for single responsibility.
 *
 * @module dag/execution/layer-results
 */

import type { TaskResult, ExecutionEvent } from "../types.ts";
import type { Task } from "../../graphrag/types.ts";
import type { JsonValue } from "../../capabilities/types.ts";
import type { EventStream } from "../event-stream.ts";
import type { CaptureContext } from "../episodic/capture.ts";
import { captureTaskComplete } from "../episodic/capture.ts";
import { isSafeToFail } from "./task-router.ts";
import type { SpeculationState } from "../speculation/integration.ts";
import { updateLastCompletedTool } from "../speculation/integration.ts";
import * as log from "@std/log";

/**
 * Maximum length for result preview strings in AIL decision making events.
 * Used to truncate large results for SSE streaming efficiency.
 */
export const RESULT_PREVIEW_MAX_LENGTH = 240;

/**
 * Result of collecting layer results
 */
export interface LayerResultsCollection {
  /** Collected task results */
  tasks: TaskResult[];
  /** Events to yield */
  events: ExecutionEvent[];
}

/**
 * Dependencies for layer result collection
 */
export interface LayerResultsDeps {
  /** Event stream for emitting events */
  eventStream: EventStream;
  /** Capture context for episodic memory */
  captureContext: CaptureContext;
  /** Speculation state to update */
  speculationState: SpeculationState;
}

/**
 * Full return value from collectLayerResults
 */
export interface LayerResultsOutput {
  /** Layer task results and events */
  layerTaskResults: LayerResultsCollection;
  /** Count of successful tasks */
  layerSuccess: number;
  /** Count of failed tasks */
  layerFailed: number;
  /** Updated speculation state */
  updatedSpeculationState: SpeculationState;
}

/**
 * Collect and process results from a layer of task executions
 *
 * @param workflowId - Current workflow ID
 * @param layer - Tasks in the layer
 * @param layerResults - Results from Promise.allSettled
 * @param results - Map to store results (mutated)
 * @param layerIdx - Current layer index
 * @param deps - Dependencies for collection
 * @returns Collection results with counts and events
 */
export async function collectLayerResults(
  workflowId: string,
  layer: Task[],
  layerResults: PromiseSettledResult<{ output: unknown; executionTimeMs: number }>[],
  results: Map<string, TaskResult>,
  layerIdx: number,
  deps: LayerResultsDeps,
): Promise<LayerResultsOutput> {
  const tasks: TaskResult[] = [];
  const events: ExecutionEvent[] = [];
  let layerSuccess = 0;
  let layerFailed = 0;
  let speculationState = deps.speculationState;

  for (let i = 0; i < layer.length; i++) {
    const task = layer[i];
    const result = layerResults[i];

    if (result.status === "fulfilled") {
      layerSuccess++;
      const taskResult: TaskResult = {
        taskId: task.id,
        status: "success",
        output: result.value.output,
        executionTimeMs: result.value.executionTimeMs,
        layerIndex: layerIdx,
      };
      results.set(task.id, taskResult);
      tasks.push(taskResult);

      // Generate result preview for AIL decision making
      const resultJson = JSON.stringify(result.value.output);
      const resultSize = new TextEncoder().encode(resultJson).length;
      const resultPreview = resultJson.length > RESULT_PREVIEW_MAX_LENGTH
        ? resultJson.substring(0, RESULT_PREVIEW_MAX_LENGTH) + "..."
        : resultJson;

      const completeEvent: ExecutionEvent = {
        type: "task_complete",
        timestamp: Date.now(),
        workflowId,
        taskId: task.id,
        executionTimeMs: result.value.executionTimeMs,
        layerIndex: layerIdx,
        result: result.value.output as JsonValue,
        resultPreview,
        resultSize,
      };
      await deps.eventStream.emit(completeEvent);
      events.push(completeEvent);

      captureTaskComplete(
        deps.captureContext,
        workflowId,
        task.id,
        "success",
        result.value.output,
        result.value.executionTimeMs,
      );
      speculationState = updateLastCompletedTool(speculationState, task.tool);
    } else {
      const errorMsg = result.reason?.message || String(result.reason);
      const isSafe = isSafeToFail(task);

      if (isSafe) {
        log.warn(`Safe-to-fail task ${task.id} failed (continuing): ${errorMsg}`);
        const taskResult: TaskResult = {
          taskId: task.id,
          status: "failed_safe" as const,
          output: null,
          error: errorMsg,
          layerIndex: layerIdx,
        };
        results.set(task.id, taskResult);
        tasks.push(taskResult);

        const warningEvent: ExecutionEvent = {
          type: "task_warning",
          timestamp: Date.now(),
          workflowId,
          taskId: task.id,
          error: errorMsg,
          message: "Safe-to-fail task failed, workflow continues",
          layerIndex: layerIdx,
        };
        await deps.eventStream.emit(warningEvent);
        events.push(warningEvent);
        captureTaskComplete(deps.captureContext, workflowId, task.id, "failed_safe", null, undefined, errorMsg);
      } else {
        layerFailed++;
        const taskResult: TaskResult = {
          taskId: task.id,
          status: "error",
          error: errorMsg,
          layerIndex: layerIdx,
        };
        results.set(task.id, taskResult);
        tasks.push(taskResult);

        const errorEvent: ExecutionEvent = {
          type: "task_error",
          timestamp: Date.now(),
          workflowId,
          taskId: task.id,
          error: errorMsg,
          layerIndex: layerIdx,
        };
        await deps.eventStream.emit(errorEvent);
        events.push(errorEvent);
        captureTaskComplete(deps.captureContext, workflowId, task.id, "error", null, undefined, errorMsg);
      }
    }
  }

  return {
    layerTaskResults: { tasks, events },
    layerSuccess,
    layerFailed,
    updatedSpeculationState: speculationState,
  };
}
