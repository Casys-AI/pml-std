/**
 * Replan Workflow Use Case
 *
 * Adds new tasks to a running workflow based on new requirements.
 *
 * @example
 * ```typescript
 * const useCase = new ReplanWorkflowUseCase(workflowRepo, dagSuggester, eventBus);
 * const result = await useCase.execute({
 *   workflowId: "wf-123",
 *   newRequirement: "Also parse the XML files we found"
 * });
 * ```
 *
 * @module application/use-cases/workflows/replan-workflow
 */

import * as log from "@std/log";
import type { IEventBus } from "../../../domain/interfaces/event-bus.ts";
import type { DAGStructure } from "../../../graphrag/types.ts";
import type { UseCaseResult } from "../shared/types.ts";
import type {
  ReplanWorkflowRequest,
  ReplanWorkflowResult,
} from "./types.ts";

/**
 * Repository interface for workflow state
 */
export interface IWorkflowRepository {
  getActiveWorkflow(workflowId: string): Promise<ActiveWorkflowState | null>;
  getStoredDAG(workflowId: string): Promise<DAGStructure | null>;
  updateDAG(workflowId: string, dag: DAGStructure): Promise<void>;
}

/**
 * Active workflow state
 *
 * Uses looser types for compatibility with actual implementations.
 */
export interface ActiveWorkflowState {
  workflowId: string;
  dag: DAGStructure;
  layerResults: Array<{ taskId: string; status: string; output?: unknown }>;
  executor?: {
    enqueueCommand(cmd: unknown): void;
  };
}

/**
 * DAG Suggester interface for replanning
 */
export interface IDAGSuggester {
  replanDAG(
    currentDag: DAGStructure,
    context: {
      completedTasks: Array<{ taskId: string; status: string; output: unknown }>;
      newRequirement: string;
      availableContext: Record<string, unknown>;
    },
  ): Promise<DAGStructure>;
}

/**
 * Use case for replanning a workflow
 */
export class ReplanWorkflowUseCase {
  constructor(
    private readonly workflowRepo: IWorkflowRepository,
    private readonly dagSuggester: IDAGSuggester,
    private readonly eventBus: IEventBus,
  ) {}

  /**
   * Execute the replan workflow use case
   */
  async execute(
    request: ReplanWorkflowRequest,
  ): Promise<UseCaseResult<ReplanWorkflowResult>> {
    const { workflowId, newRequirement, availableContext = {} } = request;

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

    if (!newRequirement) {
      return {
        success: false,
        error: {
          code: "MISSING_NEW_REQUIREMENT",
          message: "Missing required parameter: newRequirement",
        },
      };
    }

    log.info(
      `ReplanWorkflowUseCase: workflowId=${workflowId}, newRequirement=${newRequirement}`,
    );

    // Get current DAG
    const currentDag = await this.workflowRepo.getStoredDAG(workflowId);
    if (!currentDag) {
      return {
        success: false,
        error: {
          code: "WORKFLOW_NOT_FOUND",
          message: `Workflow ${workflowId} not found or expired`,
          details: { workflowId },
        },
      };
    }

    // Get active workflow state
    const activeWorkflow = await this.workflowRepo.getActiveWorkflow(workflowId);
    const completedTasks = activeWorkflow?.layerResults ?? [];

    try {
      // Replan via DAGSuggester
      const augmentedDAG = await this.dagSuggester.replanDAG(currentDag, {
        completedTasks: completedTasks.map((t) => ({
          taskId: t.taskId,
          status: t.status,
          output: t.output,
        })),
        newRequirement,
        availableContext,
      });

      // Calculate new tasks added
      const newTasksCount = augmentedDAG.tasks.length - currentDag.tasks.length;
      const newTaskIds = augmentedDAG.tasks
        .filter((t) => !currentDag.tasks.some((ct) => ct.id === t.id))
        .map((t) => t.id);

      // Update DAG in repository
      await this.workflowRepo.updateDAG(workflowId, augmentedDAG);

      // Notify active executor if exists
      if (activeWorkflow?.executor) {
        activeWorkflow.executor.enqueueCommand({
          type: "replan_dag",
          newRequirement,
          availableContext,
        });
      }

      // Emit event
      this.eventBus.emit({
        type: "dag.replanned" as const,
        source: "replan-workflow-use-case",
        payload: {
          workflowId,
          newRequirement,
          newTasksAdded: newTasksCount,
          newTaskIds,
          totalTasks: augmentedDAG.tasks.length,
        },
      });

      log.info(`Workflow ${workflowId} replanned: ${newTasksCount} new tasks`);

      return {
        success: true,
        data: {
          workflowId,
          newRequirement,
          newTasksAdded: newTasksCount,
          newTaskIds,
          totalTasks: augmentedDAG.tasks.length,
          updatedDag: augmentedDAG,
        },
      };
    } catch (error) {
      log.error(`Replan failed: ${error}`);
      return {
        success: false,
        error: {
          code: "REPLAN_FAILED",
          message: error instanceof Error ? error.message : String(error),
          details: { workflowId },
        },
      };
    }
  }
}
