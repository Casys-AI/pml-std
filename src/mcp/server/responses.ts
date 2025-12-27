/**
 * MCP Response Formatting Utilities
 *
 * Helpers for creating MCP-compliant responses.
 *
 * @module mcp/server/responses
 */

import * as log from "@std/log";
import type { MCPErrorResponse, MCPToolResponse } from "./types.ts";
import type { MCPErrorCode } from "./constants.ts";

/**
 * Format JSON-RPC level error response (transport errors)
 *
 * @param code - JSON-RPC error code
 * @param message - Error message
 * @param data - Optional error data
 * @returns Error response object
 */
export function formatMCPError(
  code: MCPErrorCode | number,
  message: string,
  data?: unknown,
): MCPErrorResponse {
  const error: { code: number; message: string; data?: unknown } = {
    code,
    message,
  };
  if (data !== undefined) {
    error.data = data;
  }
  return { error };
}

/**
 * Format MCP tool error response (tool execution failed)
 *
 * Use this for errors that should be visible to the LLM client.
 * Uses { isError: true, content: [...] } format per MCP spec.
 * Also logs the error for observability (Promtail/Loki).
 *
 * @param message - Error message
 * @param data - Optional error data (will be JSON stringified)
 * @returns Tool error response object
 */
export function formatMCPToolError(
  message: string,
  data?: unknown,
): { isError: true; content: Array<{ type: string; text: string }> } {
  const errorData = data
    ? { error: message, ...data as Record<string, unknown> }
    : { error: message };

  // Log for observability (Promtail/Loki)
  log.error(`[MCP_TOOL_ERROR] ${message}`, data ? { data } : undefined);

  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify(errorData, null, 2),
      },
    ],
  };
}

/**
 * Format successful MCP tool response
 *
 * @param data - Response data (will be JSON stringified)
 * @returns Tool response object
 */
export function formatMCPSuccess(data: unknown): MCPToolResponse {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

/**
 * Format layer complete status for per-layer validation
 */
export function formatLayerComplete(
  workflowId: string,
  checkpointId: string | null,
  layerIndex: number,
  totalLayers: number,
  layerResults: unknown[],
  hasNextLayer: boolean,
): MCPToolResponse {
  return formatMCPSuccess({
    status: "layer_complete",
    workflow_id: workflowId,
    checkpoint_id: checkpointId,
    layer_index: layerIndex,
    total_layers: totalLayers,
    layer_results: layerResults,
    next_layer_preview: hasNextLayer ? { layer_index: layerIndex + 1 } : null,
    options: ["continue", "replan", "abort"],
  });
}

/**
 * Format workflow complete status
 */
export function formatWorkflowComplete(
  workflowId: string,
  totalTimeMs: number,
  successfulTasks: number,
  failedTasks: number,
  results: unknown[],
): MCPToolResponse {
  return formatMCPSuccess({
    status: "complete",
    workflow_id: workflowId,
    total_time_ms: totalTimeMs,
    successful_tasks: successfulTasks,
    failed_tasks: failedTasks,
    results,
  });
}

/**
 * Format approval required status for HIL
 */
export function formatApprovalRequired(
  workflowId: string,
  checkpointId: string | undefined,
  decisionType: string | undefined,
  description: string | undefined,
  context: unknown,
): MCPToolResponse {
  return formatMCPSuccess({
    status: "approval_required",
    workflow_id: workflowId,
    checkpoint_id: checkpointId,
    decision_type: decisionType,
    description,
    context,
    options: ["approve", "reject"],
  });
}

/**
 * Format abort confirmation
 */
export function formatAbortConfirmation(
  workflowId: string,
  reason: string,
  completedLayers: number,
  partialResults: unknown[],
): MCPToolResponse {
  return formatMCPSuccess({
    status: "aborted",
    workflow_id: workflowId,
    reason,
    completed_layers: completedLayers,
    partial_results: partialResults,
  });
}

/**
 * Format rejection confirmation
 */
export function formatRejectionConfirmation(
  workflowId: string,
  checkpointId: string,
  feedback: string | undefined,
  completedLayers: number,
  partialResults: unknown[],
): MCPToolResponse {
  return formatMCPSuccess({
    status: "rejected",
    workflow_id: workflowId,
    checkpoint_id: checkpointId,
    feedback,
    completed_layers: completedLayers,
    partial_results: partialResults,
  });
}

/**
 * Format replan confirmation
 */
export function formatReplanConfirmation(
  workflowId: string,
  newRequirement: string,
  newTasksCount: number,
  newTaskIds: string[],
  totalTasks: number,
): MCPToolResponse {
  return formatMCPSuccess({
    status: "replanned",
    workflow_id: workflowId,
    new_requirement: newRequirement,
    new_tasks_count: newTasksCount,
    new_task_ids: newTaskIds,
    total_tasks: totalTasks,
    options: ["continue", "abort"],
  });
}
