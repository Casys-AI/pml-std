/**
 * Episodic Memory Capture Module
 *
 * Handles capturing episodic events during workflow execution.
 * Supports graceful degradation when episodic memory is not available.
 *
 * @module dag/episodic/capture
 */

import type { EpisodicMemoryStore } from "../../learning/episodic-memory-store.ts";
import type { WorkflowState } from "../state.ts";
import { getLogger } from "../../telemetry/logger.ts";

const log = getLogger("default");

/**
 * Context for episodic capture operations
 */
export interface CaptureContext {
  state: WorkflowState | null;
  episodicMemory: EpisodicMemoryStore | null;
}

/**
 * Generate context hash from current workflow state (Story 4.1d)
 *
 * Hash includes workflow type, current layer, and complexity metrics.
 * Used for context-based retrieval of similar episodes.
 *
 * @param state - Current workflow state
 * @returns Context hash string
 */
export function getContextHash(state: WorkflowState | null): string {
  if (!state) return "no-state";

  // Build context for hashing (consistent with EpisodicMemoryStore.hashContext)
  const context = {
    workflowType: "dag-execution",
    domain: "pml",
    complexity: state.tasks.length > 10 ? "high" : state.tasks.length > 5 ? "medium" : "low",
  };

  // Simple hash matching EpisodicMemoryStore pattern
  return ["workflowType", "domain", "complexity"]
    .map((k) => `${k}:${context[k as keyof typeof context] ?? "default"}`)
    .join("|");
}

/**
 * Capture episodic event for task completion (Story 4.1d - Task 2)
 *
 * Non-blocking capture with graceful degradation if episodic memory not set.
 * Includes workflow context hash for later retrieval.
 *
 * @param ctx - Capture context with state and episodic memory
 * @param workflowId - Workflow identifier
 * @param taskId - Task identifier
 * @param status - Task status ('success' | 'error' | 'failed_safe')
 * @param output - Task output (not stored for PII safety, only metadata)
 * @param executionTimeMs - Execution time in milliseconds
 * @param error - Error message if task failed
 */
export function captureTaskComplete(
  ctx: CaptureContext,
  workflowId: string,
  taskId: string,
  status: "success" | "error" | "failed_safe",
  output: unknown,
  executionTimeMs?: number,
  error?: string,
): void {
  if (!ctx.episodicMemory) return; // Graceful degradation

  // Non-blocking capture (fire-and-forget)
  ctx.episodicMemory.capture({
    workflow_id: workflowId, // Map to DB snake_case
    event_type: "task_complete",
    task_id: taskId,
    timestamp: Date.now(),
    context_hash: ctx.state ? getContextHash(ctx.state) : undefined,
    data: {
      result: {
        status: status === "failed_safe" ? "error" : status,
        executionTimeMs,
        errorMessage: error,
        // No output/arguments content for PII safety (ADR-008)
        // Enriched metadata allowed: output_size, output_type
        output: output !== null && output !== undefined
          ? {
            type: typeof output,
            size: typeof output === "string"
              ? output.length
              : Array.isArray(output)
              ? output.length
              : typeof output === "object"
              ? Object.keys(output as object).length
              : undefined,
          }
          : undefined,
      },
      context: ctx.state
        ? {
          currentLayer: ctx.state.currentLayer,
          completedTasksCount: ctx.state.tasks.filter((t) => t.status === "success").length,
          failedTasksCount: ctx.state.tasks.filter((t) => t.status === "error").length,
        }
        : undefined,
    },
  }).catch((err) => {
    // Non-critical: Log but don't fail workflow
    log.error(`Episodic capture failed for task ${taskId}: ${err}`);
  });
}

/**
 * Capture episodic event for AIL decision (Story 4.1d - Task 3)
 *
 * Non-blocking capture with context at decision point.
 *
 * @param ctx - Capture context with state and episodic memory
 * @param workflowId - Workflow identifier
 * @param outcome - Decision outcome (continue, abort, replan_success, etc.)
 * @param reasoning - Decision reasoning/description
 * @param metadata - Additional decision metadata
 */
export function captureAILDecision(
  ctx: CaptureContext,
  workflowId: string,
  outcome: string,
  reasoning: string,
  metadata?: Record<string, unknown>,
): void {
  if (!ctx.episodicMemory) return; // Graceful degradation

  // Non-blocking capture (fire-and-forget)
  ctx.episodicMemory.capture({
    workflow_id: workflowId, // Map to DB snake_case
    event_type: "ail_decision",
    timestamp: Date.now(),
    context_hash: ctx.state ? getContextHash(ctx.state) : undefined,
    data: {
      decision: {
        type: "ail",
        action: outcome,
        reasoning,
      },
      context: ctx.state
        ? {
          currentLayer: ctx.state.currentLayer,
          completedTasksCount: ctx.state.tasks.filter((t) => t.status === "success").length,
          failedTasksCount: ctx.state.tasks.filter((t) => t.status === "error").length,
        }
        : undefined,
      metadata,
    },
  }).catch((err) => {
    log.error(`Episodic capture failed for AIL decision: ${err}`);
  });
}

/**
 * Capture episodic event for HIL decision (Story 4.1d - Task 4)
 *
 * Non-blocking capture with approval data and context.
 *
 * @param ctx - Capture context with state and episodic memory
 * @param workflowId - Workflow identifier
 * @param approved - Whether human approved
 * @param checkpointId - Checkpoint ID for this decision
 * @param feedback - Human feedback/comments
 */
export function captureHILDecision(
  ctx: CaptureContext,
  workflowId: string,
  approved: boolean,
  checkpointId: string,
  feedback?: string,
): void {
  if (!ctx.episodicMemory) return; // Graceful degradation

  // Non-blocking capture (fire-and-forget)
  ctx.episodicMemory.capture({
    workflow_id: workflowId, // Map to DB snake_case
    event_type: "hil_decision",
    timestamp: Date.now(),
    context_hash: ctx.state ? getContextHash(ctx.state) : undefined,
    data: {
      decision: {
        type: "hil",
        action: approved ? "approve" : "reject",
        reasoning: feedback || (approved ? "Human approved" : "Human rejected"),
        approved,
      },
      context: ctx.state
        ? {
          currentLayer: ctx.state.currentLayer,
          completedTasksCount: ctx.state.tasks.filter((t) => t.status === "success").length,
          failedTasksCount: ctx.state.tasks.filter((t) => t.status === "error").length,
        }
        : undefined,
      metadata: {
        checkpointId: checkpointId,
      },
    },
  }).catch((err) => {
    log.error(`Episodic capture failed for HIL decision: ${err}`);
  });
}

/**
 * Capture episodic event for speculation start (Story 4.1d - Task 5)
 *
 * Non-blocking capture with prediction data.
 * Note: wasCorrect field is captured but not currently updated post-validation.
 * Future enhancement: Add updateSpeculationResult() when prediction validation is implemented.
 *
 * @param ctx - Capture context with state and episodic memory
 * @param workflowId - Workflow identifier
 * @param toolId - Tool being speculatively executed
 * @param confidence - Confidence score (0-1) of the speculation
 * @param reasoning - Why this tool was selected speculatively
 */
export function captureSpeculationStart(
  ctx: CaptureContext,
  workflowId: string,
  toolId: string,
  confidence: number,
  reasoning: string,
): void {
  if (!ctx.episodicMemory) return; // Graceful degradation

  // Non-blocking capture (fire-and-forget)
  ctx.episodicMemory.capture({
    workflow_id: workflowId, // Map to DB snake_case
    event_type: "speculation_start",
    timestamp: Date.now(),
    context_hash: ctx.state ? getContextHash(ctx.state) : undefined,
    data: {
      prediction: {
        toolId,
        confidence,
        reasoning,
        wasCorrect: undefined, // Future: Update via updateSpeculationResult() when validation implemented
      },
      context: ctx.state
        ? {
          currentLayer: ctx.state.currentLayer,
          completedTasksCount: ctx.state.tasks.filter((t) => t.status === "success").length,
          failedTasksCount: ctx.state.tasks.filter((t) => t.status === "error").length,
        }
        : undefined,
    },
  }).catch((err) => {
    log.error(`Episodic capture failed for speculation_start: ${err}`);
  });
}
