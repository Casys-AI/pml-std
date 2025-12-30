/**
 * Abort Workflow Use Case
 *
 * Stops a running workflow and returns partial results.
 *
 * @example
 * ```typescript
 * const useCase = new AbortWorkflowUseCase(workflowRepo, eventBus);
 * const result = await useCase.execute({
 *   workflowId: "wf-123",
 *   reason: "User cancelled"
 * });
 * ```
 *
 * @module application/use-cases/workflows/abort-workflow
 */

import * as log from "@std/log";
import type { IEventBus } from "../../../domain/interfaces/event-bus.ts";
import type { UseCaseResult } from "../shared/types.ts";
import type {
  AbortWorkflowRequest,
  AbortWorkflowResult,
} from "./types.ts";

/**
 * Repository interface for workflow state
 */
export interface IWorkflowRepository {
  getActiveWorkflow(workflowId: string): Promise<ActiveWorkflowState | null>;
  deleteWorkflow(workflowId: string): Promise<void>;
  getStoredDAG(workflowId: string): Promise<unknown | null>;
}

/**
 * Active workflow state from repository
 *
 * Uses looser types for compatibility with actual implementations.
 */
export interface ActiveWorkflowState {
  workflowId: string;
  status: string;
  currentLayer: number;
  layerResults: Array<{ taskId: string; status: string; output?: unknown }>;
  executor?: {
    enqueueCommand(cmd: unknown): void;
  };
}

/**
 * Use case for aborting a running workflow
 */
export class AbortWorkflowUseCase {
  constructor(
    private readonly workflowRepo: IWorkflowRepository,
    private readonly eventBus: IEventBus,
  ) {}

  /**
   * Execute the abort workflow use case
   */
  async execute(
    request: AbortWorkflowRequest,
  ): Promise<UseCaseResult<AbortWorkflowResult>> {
    const { workflowId, reason } = request;

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

    if (!reason) {
      return {
        success: false,
        error: {
          code: "MISSING_REASON",
          message: "Missing required parameter: reason",
        },
      };
    }

    log.info(`AbortWorkflowUseCase: workflowId=${workflowId}, reason=${reason}`);

    // Check if workflow exists
    const activeWorkflow = await this.workflowRepo.getActiveWorkflow(workflowId);
    const storedDag = await this.workflowRepo.getStoredDAG(workflowId);

    if (!activeWorkflow && !storedDag) {
      return {
        success: false,
        error: {
          code: "WORKFLOW_NOT_FOUND",
          message: `Workflow ${workflowId} not found or expired`,
          details: { workflowId },
        },
      };
    }

    // Send abort command if workflow is active
    if (activeWorkflow?.executor) {
      activeWorkflow.executor.enqueueCommand({
        type: "abort",
        reason,
      });
    }

    // Collect partial results
    const partialResults = activeWorkflow?.layerResults ?? [];
    const completedLayers = activeWorkflow?.currentLayer ?? 0;

    // Clean up resources
    await this.workflowRepo.deleteWorkflow(workflowId);

    // Emit event (dag.completed with aborted status)
    this.eventBus.emit({
      type: "dag.completed" as const,
      source: "abort-workflow-use-case",
      payload: {
        workflowId,
        status: "aborted",
        reason,
        completedLayers,
        partialResultsCount: partialResults.length,
      },
    });

    log.info(`Workflow ${workflowId} aborted: ${reason}`);

    // Map status to valid WorkflowTaskResult status
    const mapStatus = (status: string): "success" | "error" | "failed_safe" => {
      switch (status) {
        case "completed":
        case "success":
          return "success";
        case "failed":
        case "error":
          return "error";
        default:
          return "failed_safe";
      }
    };

    return {
      success: true,
      data: {
        workflowId,
        reason,
        completedLayers,
        partialResults: partialResults.map((r) => ({
          taskId: r.taskId,
          status: mapStatus(r.status),
          output: r.output,
        })),
      },
    };
  }
}
