/**
 * Task Router Module
 *
 * Routes task execution based on task type (code_execution, capability, mcp_tool).
 * Provides utility functions for task type determination and safe-to-fail checks.
 *
 * @module dag/execution/task-router
 */

import type { Task } from "../../graphrag/types.ts";
import { isPureOperation, isCodeOperation } from "../../capabilities/pure-operations.ts";

/**
 * Task execution types
 */
export type TaskType = "code_execution" | "capability" | "mcp_tool";

/**
 * Get the task type for routing (defaults to mcp_tool)
 *
 * @param task - Task to check
 * @returns Task type for routing
 */
export function getTaskType(task: Task): TaskType {
  return (task.type as TaskType) ?? "mcp_tool";
}

/**
 * Determines if a task is safe-to-fail (Story 3.5)
 *
 * Safe-to-fail tasks:
 * - Are code_execution type (NOT MCP tools)
 * - Have minimal permissions (no elevated access)
 *
 * MCP tools are NEVER safe-to-fail because they have external side effects.
 * Validation for MCP tools is handled by requiresValidation() in workflow-execution-handler.
 *
 * @param task - Task to check
 * @returns true if task can fail safely
 */
export function isSafeToFail(task: Task): boolean {
  // Pure operations are always safe-to-fail (Phase 1)
  if (isCodeOperation(task.tool) && isPureOperation(task.tool)) {
    return true;
  }

  // Only code_execution tasks with minimal permissions are safe-to-fail
  if (task.type !== "code_execution") {
    return false;
  }
  // Check permissionSet directly - minimal means no external access
  const permSet = task.sandboxConfig?.permissionSet ?? "minimal";
  return permSet === "minimal";
}

/**
 * Check if a task requires sandbox execution
 *
 * @param task - Task to check
 * @returns true if task should be executed in sandbox
 */
export function requiresSandbox(task: Task): boolean {
  const type = getTaskType(task);
  return type === "code_execution" || type === "capability";
}

/**
 * Check if a task is an MCP tool call
 *
 * @param task - Task to check
 * @returns true if task is an MCP tool call
 */
export function isMCPTool(task: Task): boolean {
  return getTaskType(task) === "mcp_tool";
}
