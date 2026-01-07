/**
 * Continue Workflow Use Case
 *
 * Continues a paused workflow after user approval.
 * Handles HIL (Human-in-the-Loop) approval responses.
 *
 * Phase 3.1: Execute Handler → Use Cases refactoring
 *
 * @module application/use-cases/execute/continue-workflow
 */

import * as log from "@std/log";
import type { IWorkflowRepository, WorkflowState } from "../../../domain/interfaces/workflow-repository.ts";
import type { ICapabilityRepository } from "../../../domain/interfaces/capability-repository.ts";
import type { IEventBus } from "../../../domain/interfaces/event-bus.ts";
import type { UseCaseResult } from "../shared/types.ts";
import type { ContinueWorkflowRequest, ContinueWorkflowResult } from "./types.ts";
import type { JsonValue } from "../../../capabilities/types/mod.ts";

// ============================================================================
// Interfaces (Clean Architecture - no concrete imports)
// ============================================================================

/**
 * Workflow executor interface
 */
export interface IWorkflowExecutor {
  enqueueCommand(command: { type: string; approved?: boolean; data?: unknown }): void;
}

/**
 * Active workflow state with executor
 */
export interface ActiveWorkflow extends WorkflowState {
  executor?: IWorkflowExecutor;
}

/**
 * Approval handler interface
 */
export interface IApprovalHandler {
  handleApproval(
    workflowId: string,
    checkpointId: string | undefined,
    approved: boolean,
  ): Promise<{
    success: boolean;
    result?: JsonValue;
    status: string;
    checkpointId?: string;
    pendingLayer?: number;
    layerResults?: unknown[];
    error?: string;
  }>;
}

/**
 * Dependencies for ContinueWorkflowUseCase
 */
export interface ContinueWorkflowDependencies {
  workflowRepo: IWorkflowRepository;
  capabilityRepo?: ICapabilityRepository;
  eventBus?: IEventBus;
  approvalHandler?: IApprovalHandler;
  /** Get active workflow with executor */
  getActiveWorkflow?: (workflowId: string) => ActiveWorkflow | undefined;
}

// ============================================================================
// Use Case Implementation
// ============================================================================

/**
 * Continue Workflow Use Case
 *
 * Continues a paused workflow after HIL approval.
 */
export class ContinueWorkflowUseCase {
  constructor(private readonly deps: ContinueWorkflowDependencies) {}

  /**
   * Execute the use case
   */
  async execute(
    request: ContinueWorkflowRequest,
  ): Promise<UseCaseResult<ContinueWorkflowResult>> {
    const { workflowId, approved, checkpointId } = request;
    const startTime = performance.now();

    // Validate request
    if (!workflowId) {
      return {
        success: false,
        error: {
          code: "MISSING_WORKFLOW_ID",
          message: "Missing required parameter: workflowId",
        },
      };
    }

    log.info("[ContinueWorkflowUseCase] Processing continuation", {
      workflowId,
      approved,
      checkpointId,
    });

    try {
      // Step 1: Get workflow state
      const workflow = await this.deps.workflowRepo.get(workflowId);
      if (!workflow) {
        return {
          success: false,
          error: {
            code: "WORKFLOW_NOT_FOUND",
            message: `Workflow ${workflowId} not found or expired`,
            details: { workflowId },
          },
        };
      }

      // Step 2: Validate workflow state
      if (workflow.status !== "paused" && workflow.status !== "awaiting_approval") {
        return {
          success: false,
          error: {
            code: "INVALID_WORKFLOW_STATE",
            message: `Workflow ${workflowId} is not awaiting approval (status: ${workflow.status})`,
            details: { workflowId, currentStatus: workflow.status },
          },
        };
      }

      // Step 3: Handle rejection (abort)
      if (!approved) {
        return await this.handleRejection(workflowId, workflow, startTime);
      }

      // Step 4: Handle approval - delegate to approval handler if available
      if (this.deps.approvalHandler) {
        const result = await this.deps.approvalHandler.handleApproval(
          workflowId,
          checkpointId ?? workflow.latestCheckpointId,
          approved,
        );

        if (!result.success) {
          return {
            success: false,
            error: {
              code: "APPROVAL_FAILED",
              message: result.error ?? "Approval handling failed",
            },
          };
        }

        return {
          success: true,
          data: {
            success: true,
            result: result.result,
            status: result.status as ContinueWorkflowResult["status"],
            executionTimeMs: performance.now() - startTime,
            checkpointId: result.checkpointId,
            pendingLayer: result.pendingLayer,
            layerResults: result.layerResults,
          },
        };
      }

      // Step 5: Direct workflow continuation (if no approval handler)
      const activeWorkflow = this.deps.getActiveWorkflow?.(workflowId);
      if (activeWorkflow?.executor) {
        activeWorkflow.executor.enqueueCommand({
          type: "approve",
          approved: true,
        });

        // Update workflow status
        await this.deps.workflowRepo.update(workflowId, {
          status: "running",
        });

        return {
          success: true,
          data: {
            success: true,
            status: "completed", // Optimistic - actual status will be determined by executor
            executionTimeMs: performance.now() - startTime,
          },
        };
      }

      // No executor available
      return {
        success: false,
        error: {
          code: "NO_EXECUTOR",
          message: "Workflow has no active executor to continue",
          details: { workflowId },
        },
      };
    } catch (error) {
      log.error(`[ContinueWorkflowUseCase] Error: ${error}`);
      return {
        success: false,
        error: {
          code: "CONTINUATION_ERROR",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  private async handleRejection(
    workflowId: string,
    workflow: WorkflowState,
    startTime: number,
  ): Promise<UseCaseResult<ContinueWorkflowResult>> {
    log.info("[ContinueWorkflowUseCase] Workflow rejected, aborting", {
      workflowId,
    });

    // Get active workflow executor to send abort command
    const activeWorkflow = this.deps.getActiveWorkflow?.(workflowId);
    if (activeWorkflow?.executor) {
      activeWorkflow.executor.enqueueCommand({
        type: "abort",
        data: { reason: "User rejected workflow continuation" },
      });
    }

    // Update workflow status
    await this.deps.workflowRepo.update(workflowId, {
      status: "aborted",
    });

    // Emit abort event
    this.deps.eventBus?.emit({
      type: "dag.completed" as const,
      source: "continue-workflow-use-case",
      payload: {
        workflowId,
        status: "aborted",
        reason: "User rejected",
        completedLayers: workflow.currentLayer,
      },
    });

    // Collect partial results
    const partialResults = workflow.results
      .filter((r) => r.status === "success")
      .map((r) => r.output);

    return {
      success: true,
      data: {
        success: false,
        status: "aborted",
        result: partialResults.length > 0 ? partialResults as JsonValue : undefined,
        executionTimeMs: performance.now() - startTime,
      },
    };
  }
}
