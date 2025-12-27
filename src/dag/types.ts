/**
 * DAG Executor Types
 *
 * @module dag/types
 */

import type { JsonValue } from "../capabilities/types.ts";

/**
 * Result of a single task execution
 *
 * Status values (Story 3.5):
 * - "success": Task completed successfully
 * - "error": Critical failure, halts workflow
 * - "failed_safe": Safe-to-fail task failed, workflow continues
 */
export interface TaskResult {
  taskId: string;
  status: "success" | "error" | "failed_safe";
  output?: unknown;
  error?: string;
  executionTimeMs?: number;
  /**
   * DAG layer index (Story 11.4)
   * Tasks in the same layer execute in parallel.
   */
  layerIndex?: number;
}

/**
 * Error information for a failed task
 */
export interface TaskError {
  taskId: string;
  error: string;
  status: "error";
}

/**
 * Error thrown when a task needs permission escalation (Deferred Escalation Pattern)
 *
 * Instead of blocking inside Promise.allSettled waiting for HIL approval,
 * tasks throw this error which is caught at the layer boundary where the
 * generator can properly yield decision_required events.
 *
 * @see tech-spec-hil-permission-escalation-fix.md
 */
export class PermissionEscalationNeeded extends Error {
  constructor(
    public readonly taskId: string,
    public readonly taskIndex: number,
    public readonly currentSet: string,
    public readonly requestedSet: string,
    public readonly detectedOperation: string,
    public readonly originalError: string,
    public readonly taskType: "code" | "capability",
    public readonly capabilityId?: string,
  ) {
    super(`Permission escalation needed for task ${taskId}: ${currentSet} -> ${requestedSet}`);
    this.name = "PermissionEscalationNeeded";
  }
}

/**
 * Complete execution result with aggregated metrics
 */
export interface DAGExecutionResult {
  results: TaskResult[];
  executionTimeMs: number;
  parallelizationLayers: number;
  errors: TaskError[];
  totalTasks: number;
  successfulTasks: number;
  failedTasks: number;
}

/**
 * Configuration for the parallel executor
 */
export interface ExecutorConfig {
  /**
   * Maximum concurrent tasks per layer (default: unlimited)
   */
  maxConcurrency?: number;

  /**
   * Timeout for individual task execution in ms (default: 30000)
   */
  taskTimeout?: number;

  /**
   * Enable verbose logging
   */
  verbose?: boolean;

  /**
   * Agent-in-the-Loop (AIL) configuration (Story 2.5-3)
   *
   * Enables adaptive decision points where the AI agent can:
   * - Continue execution normally
   * - Trigger DAG replanning based on discoveries
   * - Abort workflow execution
   *
   * Decision point triggers:
   * - per_layer: After each DAG layer execution
   * - on_error: Only when a task fails
   * - manual: Only when explicitly triggered via command
   */
  ail?: {
    enabled: boolean;
    decision_points: "per_layer" | "on_error" | "manual";
  };

  /**
   * Human-in-the-Loop (HIL) configuration (Story 2.5-3)
   *
   * Enables approval checkpoints where a human operator must
   * approve workflow continuation before proceeding.
   *
   * Approval triggers:
   * - always: Require approval after every layer
   * - critical_only: Only for tasks with side_effects flag
   * - never: Disabled (fully automated)
   */
  hil?: {
    enabled: boolean;
    approval_required: "always" | "critical_only" | "never";
  };

  /**
   * User ID for multi-tenant isolation (Story 9.5)
   * Passed to workflow_execution INSERT for data isolation.
   * Defaults to "local" for backward compatibility.
   */
  userId?: string;

  /**
   * Configurable timeouts for decision loops (Story 2.5-3)
   *
   * Allows deployment-specific timeout configuration instead of hardcoded values.
   */
  timeouts?: {
    /** HIL (Human-in-the-Loop) approval timeout in ms (default: 300000 = 5 minutes) */
    hil?: number;
    /** AIL (Agent-in-the-Loop) decision timeout in ms (default: 60000 = 1 minute) */
    ail?: number;
    /** Poll interval for legacy polling mode in ms (default: 100) */
    pollInterval?: number;
  };

  /**
   * Per-layer validation mode (Story 10.7c fix)
   *
   * When enabled, the executor pauses after each layer's checkpoint
   * and waits for a "continue" command before proceeding to the next layer.
   * This is the primary pause mechanism for per_layer_validation workflows.
   */
  perLayerValidation?: boolean;
}

/**
 * Mock tool executor function signature for testing
 */
export type ToolExecutor = (
  tool: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

// ============================================================================
// Story 2.5-1: Event Stream & Command Queue Types
// ============================================================================

/**
 * Execution event types for real-time observability
 *
 * 10 event types covering workflow lifecycle (Story 3.5 adds task_warning):
 * - workflow_start/complete: Workflow boundaries
 * - layer_start: Layer execution start
 * - task_start/complete/error/warning: Individual task lifecycle
 * - state_updated: State changes via reducers
 * - checkpoint: Checkpoint created (Story 2.5-2)
 * - decision_required: AIL/HIL decision needed (Story 2.5-3)
 */
export type ExecutionEvent =
  | {
    type: "workflow_start";
    timestamp: number;
    workflowId: string;
    totalLayers: number;
  }
  | {
    type: "layer_start";
    timestamp: number;
    workflowId: string;
    layerIndex: number;
    tasksCount: number;
  }
  | {
    type: "task_start";
    timestamp: number;
    workflowId: string;
    taskId: string;
    tool: string;
  }
  | {
    type: "task_complete";
    timestamp: number;
    workflowId: string;
    taskId: string;
    executionTimeMs: number;
    /** DAG layer index (Story 11.4) */
    layerIndex?: number;
    /** Full result (stored for retrieval via pml_get_task_result) */
    result?: JsonValue;
    /** Preview of result (first 500 chars of JSON stringified) */
    resultPreview?: string;
    /** Size of full result in bytes */
    resultSize?: number;
  }
  | {
    type: "task_error";
    timestamp: number;
    workflowId: string;
    taskId: string;
    error: string;
    /** DAG layer index (Story 11.4) */
    layerIndex?: number;
  }
  | {
    type: "task_warning";
    timestamp: number;
    workflowId: string;
    taskId: string;
    /** DAG layer index (Story 11.4) */
    layerIndex?: number;
    error: string;
    message: string;
  }
  | {
    type: "state_updated";
    timestamp: number;
    workflowId: string;
    updates: {
      messagesAdded?: number;
      tasksAdded?: number;
      decisionsAdded?: number;
      contextKeys?: string[];
    };
  }
  | {
    type: "checkpoint";
    timestamp: number;
    workflowId: string;
    checkpointId: string;
    layerIndex: number;
  }
  | {
    type: "decision_required";
    timestamp: number;
    workflowId: string;
    decisionType: "AIL" | "HIL";
    description: string;
    /** Checkpoint ID for approval_response (Story 2.5-3 HIL fix) */
    checkpointId?: string;
    /** Additional context for the decision (e.g., permission escalation details) */
    context?: Record<string, unknown>;
  }
  | {
    type: "workflow_complete";
    timestamp: number;
    workflowId: string;
    totalTimeMs: number;
    successfulTasks: number;
    failedTasks: number;
  }
  | {
    type: "workflow_abort";
    timestamp: number;
    workflowId: string;
    reason: string;
    totalTimeMs: number;
    successfulTasks: number;
    failedTasks: number;
  };

// ============================================================================
// Story 2.5-2: Checkpoint & Resume Types
// ============================================================================

/**
 * Checkpoint interface for WorkflowState persistence
 *
 * Stores a snapshot of workflow execution state to enable recovery from failures.
 * Checkpoints are saved to PGlite after each layer execution.
 *
 * Retention policy: Keep 5 most recent checkpoints per workflow.
 * Performance target: Save <50ms P95 (async, non-blocking).
 */
export interface Checkpoint {
  /** UUID v4 identifier (generated via crypto.randomUUID()) */
  id: string;

  /** Workflow instance this checkpoint belongs to */
  workflowId: string;

  /** Timestamp when checkpoint was created */
  timestamp: Date;

  /** DAG layer index to resume from (0-indexed) */
  layer: number;

  /** WorkflowState snapshot (serialized to JSONB in PGlite) */
  state: import("./state.ts").WorkflowState;
}

// ============================================================================
// Command Queue Types
// ============================================================================

/**
 * Command types for dynamic workflow control
 *
 * 8 command types for runtime control:
 * - continue: Continue execution (AIL decision - Story 2.5-3)
 * - abort: Stop workflow execution
 * - inject_tasks: Add tasks dynamically
 * - replan_dag: Rebuild DAG structure
 * - skip_layer: Skip entire layer
 * - modify_args: Change task arguments
 * - checkpoint_response: Resume from checkpoint (Story 2.5-2)
 * - approval_response: Human approval for HIL checkpoint (Story 2.5-3)
 */
export type Command =
  | {
    type: "continue";
    /** Optional: Reason why agent chose to continue (for logging/audit) */
    reason?: string;
  }
  | {
    type: "abort";
    reason: string;
  }
  | {
    type: "inject_tasks";
    tasks: Array<{
      id: string;
      tool: string;
      arguments: Record<string, unknown>;
      dependsOn: string[];
    }>;
    targetLayer: number;
  }
  | {
    type: "replan_dag";
    newRequirement: string; // Natural language description of new requirement
    availableContext: Record<string, unknown>; // Current execution context
  }
  | {
    type: "skip_layer";
    layerIndex: number;
    reason: string;
  }
  | {
    type: "modify_args";
    taskId: string;
    updates: Record<string, unknown>;
  }
  | {
    type: "checkpoint_response";
    checkpointId: string;
    decision: "continue" | "rollback" | "modify";
    modifications?: Record<string, unknown>;
  }
  | {
    type: "approval_response";
    checkpointId: string; // References the checkpoint being approved/rejected
    approved: boolean; // true = continue, false = abort
    feedback?: string; // Optional human feedback
  }
  | {
    type: "permission_escalation_response";
    capabilityId: string; // UUID of capability requesting escalation
    approved: boolean; // true = approve escalation, false = reject
    feedback?: string; // Optional human feedback
  };
