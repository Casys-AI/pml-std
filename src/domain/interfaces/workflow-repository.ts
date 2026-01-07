/**
 * Workflow Repository Interface
 *
 * Defines the contract for workflow state persistence.
 * Implementations: In-memory Map + CheckpointManager
 *
 * Phase 3.1: Execute Handler → Use Cases refactoring
 *
 * @module domain/interfaces/workflow-repository
 */

import type { DAGStructure } from "../../graphrag/types.ts";
import type { JsonValue } from "../../capabilities/types/mod.ts";

/**
 * Workflow status states
 */
export type WorkflowStatus =
  | "created"
  | "running"
  | "paused"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "aborted";

/**
 * Task result in a workflow
 */
export interface WorkflowTaskResult {
  taskId: string;
  status: "success" | "error" | "failed_safe" | "pending";
  output?: JsonValue;
  error?: string;
  executionTimeMs?: number;
  layerIndex?: number;
}

/**
 * Workflow state stored in repository
 */
export interface WorkflowState {
  workflowId: string;
  status: WorkflowStatus;
  /** Original intent that created this workflow */
  intent?: string;
  /** DAG being executed */
  dag?: DAGStructure;
  /** Current layer being executed (0-indexed) */
  currentLayer: number;
  /** Total number of layers */
  totalLayers: number;
  /** Results from completed tasks */
  results: WorkflowTaskResult[];
  /** Latest checkpoint ID for resume */
  latestCheckpointId?: string;
  /** When workflow was created */
  createdAt: Date;
  /** When workflow was last updated */
  updatedAt: Date;
  /** Learning context for capability creation after HIL approval */
  learningContext?: {
    code: string;
    intent: string;
    staticStructure: unknown;
  };
}

/**
 * Input for creating a new workflow
 */
export interface CreateWorkflowInput {
  /** Optional workflow ID (generated if not provided) */
  workflowId?: string;
  intent: string;
  dag: DAGStructure;
  learningContext?: WorkflowState["learningContext"];
}

/**
 * Input for updating workflow state
 */
export interface UpdateWorkflowInput {
  status?: WorkflowStatus;
  currentLayer?: number;
  results?: WorkflowTaskResult[];
  latestCheckpointId?: string;
}

/**
 * Interface for workflow state persistence
 *
 * This interface abstracts the workflow storage layer,
 * allowing for different implementations (in-memory, Redis, etc.)
 * and easy mocking in tests.
 */
export interface IWorkflowRepository {
  /**
   * Create a new workflow
   */
  create(input: CreateWorkflowInput): Promise<WorkflowState>;

  /**
   * Get workflow by ID
   */
  get(workflowId: string): Promise<WorkflowState | null>;

  /**
   * Update workflow state
   */
  update(workflowId: string, input: UpdateWorkflowInput): Promise<WorkflowState>;

  /**
   * Delete a workflow (cleanup)
   */
  delete(workflowId: string): Promise<void>;

  /**
   * List active workflows (for monitoring)
   */
  listActive(): Promise<WorkflowState[]>;

  /**
   * Get workflows awaiting approval
   */
  listAwaitingApproval(): Promise<WorkflowState[]>;
}
