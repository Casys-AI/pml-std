/**
 * Trace Generator - Logical Trace Generation from Physical Execution
 *
 * Maps physical execution results back to logical operations for SHGAT learning.
 * This allows SHGAT to see atomic operations even when they were executed as fused tasks.
 *
 * Example:
 * - Physical: 1 fused task executed
 * - Logical: 3 operations traced (filter → map → sort)
 * - SHGAT learns: The 3-operation pattern
 *
 * See: docs/tech-specs/modular-dag-execution/two-level-dag-architecture.md
 *
 * @module dag/trace-generator
 */

import type { TaskResult } from "./types.ts";
import type { OptimizedDAGStructure } from "./dag-optimizer.ts";
import { getLogger } from "../telemetry/logger.ts";

const log = getLogger("trace-generator");

/**
 * Logical trace for SHGAT learning
 */
export interface LogicalTrace {
  /** Executed path with all logical operations */
  executedPath: string[];

  /** All tools used (logical, deduplicated) */
  toolsUsed: string[];

  /** Task results mapped to logical tasks */
  taskResults: LogicalTaskResult[];

  /** Overall success */
  success: boolean;

  /** Total duration */
  totalDurationMs: number;
}

/**
 * Logical task result for SHGAT learning
 */
export interface LogicalTaskResult {
  /** Logical task ID */
  taskId: string;

  /** Logical tool name */
  tool: string;

  /** Output (same as physical for non-fused, inferred for fused) */
  output?: unknown;

  /** Success */
  success: boolean;

  /** Duration (divided among logical tasks for fused) */
  durationMs: number;
}

/**
 * Generate logical trace from physical execution results
 *
 * Maps physical task results back to logical operations using the
 * optimized DAG's logical-to-physical mapping.
 *
 * @param optimizedDAG Optimized DAG structure with mappings
 * @param physicalResults Results from physical task execution
 * @returns Logical trace for SHGAT learning
 */
export function generateLogicalTrace(
  optimizedDAG: OptimizedDAGStructure,
  physicalResults: Map<string, TaskResult>,
): LogicalTrace {
  const executedPath: string[] = [];
  const taskResults: LogicalTaskResult[] = [];
  const toolsUsed = new Set<string>();

  let totalSuccess = true;
  let totalDurationMs = 0;

  log.debug("Generating logical trace", {
    physicalResultsCount: physicalResults.size,
    logicalTasksCount: optimizedDAG.logicalDAG.tasks.length,
  });

  // Process each logical task in order
  for (const logicalTask of optimizedDAG.logicalDAG.tasks) {
    const physicalTaskId = optimizedDAG.logicalToPhysical.get(logicalTask.id);

    if (!physicalTaskId) {
      log.warn("No physical task mapping for logical task", {
        logicalTaskId: logicalTask.id,
      });
      continue;
    }

    const physicalResult = physicalResults.get(physicalTaskId);

    if (!physicalResult) {
      log.warn("No physical result found", {
        logicalTaskId: logicalTask.id,
        physicalTaskId,
      });
      continue;
    }

    // Check if this was a fused task
    const logicalTaskIds = optimizedDAG.physicalToLogical.get(physicalTaskId);
    const wasFused = logicalTaskIds && logicalTaskIds.length > 1;

    if (wasFused) {
      // Fused task: Decompose into logical operations
      const fusedTaskIndex = logicalTaskIds!.indexOf(logicalTask.id);
      const totalLogicalTasks = logicalTaskIds!.length;

      // Add logical operation to executed path
      if (logicalTask.tool) {
        executedPath.push(logicalTask.tool);
        toolsUsed.add(logicalTask.tool);
      }

      // Create logical task result
      // Duration is divided equally among fused tasks (approximation)
      const logicalDuration = (physicalResult.executionTimeMs || 0) / totalLogicalTasks;
      const isSuccess = physicalResult.status === "success";

      taskResults.push({
        taskId: logicalTask.id,
        tool: logicalTask.tool || "unknown",
        output: extractIntermediateResult(physicalResult, fusedTaskIndex, totalLogicalTasks),
        success: isSuccess,
        durationMs: logicalDuration,
      });

      totalDurationMs += logicalDuration;
      if (!isSuccess) totalSuccess = false;
    } else {
      // Non-fused task: Map 1:1
      if (logicalTask.tool) {
        executedPath.push(logicalTask.tool);
        toolsUsed.add(logicalTask.tool);
      }

      const isSuccess = physicalResult.status === "success";
      taskResults.push({
        taskId: logicalTask.id,
        tool: logicalTask.tool || "unknown",
        output: physicalResult.output,
        success: isSuccess,
        durationMs: physicalResult.executionTimeMs || 0,
      });

      totalDurationMs += physicalResult.executionTimeMs || 0;
      if (!isSuccess) totalSuccess = false;
    }
  }

  const trace: LogicalTrace = {
    executedPath,
    toolsUsed: Array.from(toolsUsed),
    taskResults,
    success: totalSuccess,
    totalDurationMs,
  };

  log.debug("Logical trace generated", {
    executedPathLength: executedPath.length,
    toolsUsedCount: toolsUsed.size,
    success: totalSuccess,
  });

  return trace;
}

/**
 * Extract intermediate result from fused task execution
 *
 * Phase 2a (simple): Returns final output for all logical tasks
 * Phase 2b+ (advanced): Could extract intermediate values if we instrument the code
 *
 * @param physicalResult Physical task result
 * @param index Index of logical task within fused group
 * @param total Total number of logical tasks in fused group
 * @returns Output for this logical task (approximation)
 */
function extractIntermediateResult(
  physicalResult: TaskResult,
  index: number,
  total: number,
): unknown {
  // Phase 2a: Return final output for all logical tasks
  // This is an approximation - intermediate values aren't captured
  //
  // Phase 2b+ could:
  // - Instrument fused code to capture intermediate values
  // - Store them in metadata
  // - Return actual intermediate results here

  if (index === total - 1) {
    // Last task in chain gets the final output
    return physicalResult.output;
  }

  // Intermediate tasks: We don't have actual intermediate values
  // Return undefined to indicate "result used by next operation"
  return undefined;
}

/**
 * Check if a physical task is fused
 */
export function isFusedTask(
  taskId: string,
  optimizedDAG: OptimizedDAGStructure,
): boolean {
  const logicalTasks = optimizedDAG.physicalToLogical.get(taskId);
  return logicalTasks !== undefined && logicalTasks.length > 1;
}

/**
 * Get logical tasks for a physical task
 */
export function getLogicalTasks(
  physicalTaskId: string,
  optimizedDAG: OptimizedDAGStructure,
): string[] {
  return optimizedDAG.physicalToLogical.get(physicalTaskId) || [];
}
