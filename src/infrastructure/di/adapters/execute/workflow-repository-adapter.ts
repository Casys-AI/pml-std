/**
 * Workflow Repository Adapter
 *
 * Adapts existing workflow state management to IWorkflowRepository interface.
 * Uses in-memory storage with CheckpointManager persistence.
 *
 * Phase 3.1: Execute Handler → Use Cases refactoring
 *
 * @module infrastructure/di/adapters/execute/workflow-repository-adapter
 */

import * as log from "@std/log";
import type {
  IWorkflowRepository,
  WorkflowState,
  CreateWorkflowInput,
  UpdateWorkflowInput,
  WorkflowTaskResult,
} from "../../../../domain/interfaces/workflow-repository.ts";
import type { DAGStructure } from "../../../../graphrag/types.ts";

/**
 * In-memory workflow storage
 */
const workflowStore = new Map<string, WorkflowState>();

/**
 * Checkpoint manager interface (from existing infrastructure)
 */
export interface CheckpointManagerInfra {
  saveCheckpoint(workflowId: string, state: unknown): Promise<string>;
  loadCheckpoint(workflowId: string, checkpointId: string): Promise<unknown | null>;
}

/**
 * Dependencies for WorkflowRepositoryAdapter
 */
export interface WorkflowRepositoryAdapterDeps {
  checkpointManager?: CheckpointManagerInfra;
  /** TTL in milliseconds for workflow cleanup */
  workflowTTL?: number;
}

const DEFAULT_WORKFLOW_TTL = 30 * 60 * 1000; // 30 minutes

/**
 * Adapts in-memory + CheckpointManager to IWorkflowRepository interface
 */
export class WorkflowRepositoryAdapter implements IWorkflowRepository {
  constructor(private readonly deps: WorkflowRepositoryAdapterDeps = {}) {}

  /**
   * Create a new workflow
   */
  async create(input: CreateWorkflowInput): Promise<WorkflowState> {
    const workflowId = input.workflowId ?? crypto.randomUUID();
    const now = new Date();

    const workflow: WorkflowState = {
      workflowId,
      status: "created",
      intent: input.intent,
      dag: input.dag,
      currentLayer: 0,
      totalLayers: this.calculateLayers(input.dag),
      results: [],
      createdAt: now,
      updatedAt: now,
      learningContext: input.learningContext,
    };

    workflowStore.set(workflowId, workflow);

    log.debug("[WorkflowRepositoryAdapter] Workflow created", {
      workflowId,
      intent: input.intent.substring(0, 50),
      totalLayers: workflow.totalLayers,
    });

    return workflow;
  }

  /**
   * Get workflow by ID
   */
  async get(workflowId: string): Promise<WorkflowState | null> {
    const workflow = workflowStore.get(workflowId);
    if (!workflow) {
      return null;
    }

    // Check TTL
    const ttl = this.deps.workflowTTL ?? DEFAULT_WORKFLOW_TTL;
    if (Date.now() - workflow.createdAt.getTime() > ttl) {
      workflowStore.delete(workflowId);
      return null;
    }

    return workflow;
  }

  /**
   * Update workflow state
   */
  async update(workflowId: string, input: UpdateWorkflowInput): Promise<WorkflowState> {
    const workflow = await this.get(workflowId);
    if (!workflow) {
      throw new Error(`Workflow ${workflowId} not found`);
    }

    const updated: WorkflowState = {
      ...workflow,
      status: input.status ?? workflow.status,
      currentLayer: input.currentLayer ?? workflow.currentLayer,
      results: input.results ?? workflow.results,
      latestCheckpointId: input.latestCheckpointId ?? workflow.latestCheckpointId,
      updatedAt: new Date(),
    };

    workflowStore.set(workflowId, updated);

    log.debug("[WorkflowRepositoryAdapter] Workflow updated", {
      workflowId,
      status: updated.status,
      currentLayer: updated.currentLayer,
    });

    return updated;
  }

  /**
   * Delete a workflow (cleanup)
   */
  async delete(workflowId: string): Promise<void> {
    workflowStore.delete(workflowId);
    log.debug("[WorkflowRepositoryAdapter] Workflow deleted", { workflowId });
  }

  /**
   * List active workflows (for monitoring)
   */
  async listActive(): Promise<WorkflowState[]> {
    const active: WorkflowState[] = [];
    const ttl = this.deps.workflowTTL ?? DEFAULT_WORKFLOW_TTL;
    const now = Date.now();

    for (const [id, workflow] of workflowStore) {
      // Skip expired workflows
      if (now - workflow.createdAt.getTime() > ttl) {
        workflowStore.delete(id);
        continue;
      }

      if (workflow.status === "running" || workflow.status === "paused") {
        active.push(workflow);
      }
    }

    return active;
  }

  /**
   * Get workflows awaiting approval
   */
  async listAwaitingApproval(): Promise<WorkflowState[]> {
    const awaiting: WorkflowState[] = [];
    const ttl = this.deps.workflowTTL ?? DEFAULT_WORKFLOW_TTL;
    const now = Date.now();

    for (const [id, workflow] of workflowStore) {
      // Skip expired workflows
      if (now - workflow.createdAt.getTime() > ttl) {
        workflowStore.delete(id);
        continue;
      }

      if (workflow.status === "paused" || workflow.status === "awaiting_approval") {
        awaiting.push(workflow);
      }
    }

    return awaiting;
  }

  /**
   * Add result for a task
   */
  async addTaskResult(workflowId: string, result: WorkflowTaskResult): Promise<void> {
    const workflow = await this.get(workflowId);
    if (!workflow) {
      throw new Error(`Workflow ${workflowId} not found`);
    }

    workflow.results.push(result);
    workflow.updatedAt = new Date();
    workflowStore.set(workflowId, workflow);
  }

  /**
   * Clear all workflows (for testing)
   */
  clear(): void {
    workflowStore.clear();
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  private calculateLayers(dag?: DAGStructure): number {
    if (!dag || !dag.tasks || dag.tasks.length === 0) {
      return 0;
    }

    // Simple layer calculation based on dependencies
    const taskLayers = new Map<string, number>();

    for (const task of dag.tasks) {
      const deps = task.dependsOn ?? [];
      if (deps.length === 0) {
        taskLayers.set(task.id, 0);
      } else {
        const maxDepLayer = Math.max(
          ...deps.map((depId) => taskLayers.get(depId) ?? 0),
        );
        taskLayers.set(task.id, maxDepLayer + 1);
      }
    }

    return Math.max(...taskLayers.values()) + 1;
  }
}
