/**
 * Result Mapper
 *
 * Maps execution results between use case format and handler format.
 *
 * Phase 3.1: Execute Handler → Use Cases refactoring
 *
 * @module application/use-cases/execute/shared/result-mapper
 */

import type { JsonValue, TraceTaskResult, LogicalOperation } from "../../../../capabilities/types/mod.ts";
import type { ExecuteResponse, ExecuteDirectResult, ExecuteSuggestionResult } from "../types.ts";

/**
 * Physical task result from DAG execution
 */
export interface PhysicalTaskResult {
  taskId: string;
  status: "success" | "error" | "failed_safe" | "pending" | "skipped";
  output?: unknown;
  error?: string;
  executionTimeMs?: number;
  layerIndex?: number;
}

/**
 * DAG execution results
 */
export interface DAGExecutionResults {
  results: PhysicalTaskResult[];
  successfulTasks: number;
  failedTasks: number;
  errors: Array<{ taskId: string; error: string }>;
  parallelizationLayers: number;
}

/**
 * Optimized DAG with logical mapping
 */
export interface OptimizedDAG {
  tasks: Array<{
    id: string;
    tool: string;
    metadata?: {
      loopId?: string;
      loopType?: string;
      loopCondition?: string;
    };
  }>;
  physicalToLogical: Map<string, string[]>;
  logicalDAG: { tasks: Array<{ id: string; tool: string }> };
}

/**
 * Unwrap code execution result from checkpoint wrapper
 *
 * Code executor wraps results for checkpoint persistence.
 * This extracts the actual result.
 */
export function unwrapCodeResult(output: unknown): unknown {
  if (output && typeof output === "object" && "result" in output && "state" in output) {
    return (output as { result: unknown }).result;
  }
  return output;
}

/**
 * Build task results from physical execution for trace storage
 *
 * @param physicalResults - Results from DAG execution
 * @param optimizedDAG - Optimized DAG with logical mapping
 * @param toolCallCounts - Tool call counts from traces
 * @returns Task results for trace storage
 */
export function buildTaskResults(
  physicalResults: DAGExecutionResults,
  optimizedDAG: OptimizedDAG,
  toolCallCounts: Map<string, number>,
): TraceTaskResult[] {
  return physicalResults.results.map((physicalResult) => {
    const physicalTask = optimizedDAG.tasks.find((t) => t.id === physicalResult.taskId);
    const logicalTaskIds = optimizedDAG.physicalToLogical.get(physicalResult.taskId) || [];
    const fused = logicalTaskIds.length > 1;

    let logicalOps: LogicalOperation[] | undefined;
    if (fused) {
      // Extract logical operations for fused task
      const estimatedDuration = (physicalResult.executionTimeMs || 0) / logicalTaskIds.length;
      logicalOps = logicalTaskIds.map((logicalId) => {
        const logicalTask = optimizedDAG.logicalDAG.tasks.find((t) => t.id === logicalId);
        return {
          toolId: logicalTask?.tool || "unknown",
          durationMs: estimatedDuration,
        };
      });
    }

    // Loop abstraction: get iteration count from actual traces
    const toolName = physicalTask?.tool || "unknown";
    const loopId = physicalTask?.metadata?.loopId as string | undefined;
    const loopIterations = loopId ? (toolCallCounts.get(toolName) || 1) : undefined;

    return {
      taskId: physicalResult.taskId,
      tool: toolName,
      args: {} as Record<string, JsonValue>,
      result: physicalResult.output as JsonValue ?? null,
      success: physicalResult.status === "success",
      durationMs: physicalResult.executionTimeMs || 0,
      layerIndex: physicalResult.layerIndex,
      // Phase 2a: Fusion metadata
      isFused: fused,
      logicalOperations: logicalOps,
      // Loop abstraction
      loopId,
      loopIteration: loopIterations,
      loopType: physicalTask?.metadata?.loopType as TraceTaskResult["loopType"],
      loopCondition: physicalTask?.metadata?.loopCondition as string | undefined,
    };
  });
}

/**
 * Map ExecuteDirectResult to ExecuteResponse
 */
export function mapDirectResultToResponse(result: ExecuteDirectResult): ExecuteResponse {
  return {
    status: "success",
    result: result.result,
    capabilityId: result.capabilityId,
    capabilityName: result.capabilityName,
    capabilityFqdn: result.capabilityFqdn,
    mode: "direct",
    executionTimeMs: result.executionTimeMs,
    dag: result.dag,
    toolFailures: result.toolFailures,
  };
}

/**
 * Map ExecuteSuggestionResult to ExecuteResponse
 */
export function mapSuggestionResultToResponse(result: ExecuteSuggestionResult): ExecuteResponse {
  return {
    status: "suggestions",
    suggestions: {
      suggestedDag: result.suggestedDag,
      confidence: result.confidence,
    },
    executionTimeMs: result.executionTimeMs,
  };
}

/**
 * Extract success outputs from execution results
 */
export function extractSuccessOutputs(results: PhysicalTaskResult[]): JsonValue[] {
  return results
    .filter((r) => r.status === "success")
    .map((r) => unwrapCodeResult(r.output) as JsonValue);
}

/**
 * Check if execution has any failures (including safe failures)
 */
export function hasAnyFailure(results: DAGExecutionResults): boolean {
  const failedSafeTasks = results.results.filter(
    (r) => r.status === "failed_safe",
  ).length;
  return results.failedTasks > 0 || failedSafeTasks > 0;
}

/**
 * Build tool failures array from execution results
 */
export function buildToolFailures(
  results: DAGExecutionResults,
): Array<{ tool: string; error: string }> {
  return results.errors.map((e) => ({
    tool: e.taskId,
    error: e.error,
  }));
}
