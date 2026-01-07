/**
 * Stream Orchestrator Interface
 *
 * Defines the contract for DAG workflow stream execution.
 * Implementations: DAGStreamOrchestrator
 *
 * @module domain/interfaces/stream-orchestrator
 */

import type { DAGStructure, Task } from "../../graphrag/types.ts";
import type { ExecutionEvent } from "../../dag/types.ts";
import type { WorkflowState } from "../../dag/state.ts";

/**
 * Dependencies for stream execution
 */
export interface IStreamOrchestratorDeps {
  readonly eventStream: unknown;
  readonly commandQueue: unknown;
  readonly checkpointManager: unknown | null;
  readonly episodicMemory: unknown | null;
  readonly dagSuggester: unknown | null;
  readonly workerBridge: unknown | null;
  readonly toolDefinitions: unknown[];
  readonly executionArgs: Record<string, unknown>;
  readonly config: unknown;
  readonly userId: string;
  readonly speculationState: unknown;
  readonly topologicalSort: (dag: DAGStructure) => Task[][];
  readonly executeTask: (task: Task, results: Map<string, unknown>) => Promise<{ output: unknown; executionTimeMs: number }>;
  readonly updateGraphRAG: (workflowId: string, dag: DAGStructure, totalTime: number, failedTasks: number) => void;
}

/**
 * Interface for stream-based DAG workflow execution
 *
 * Note: Uses method syntax (not property syntax) for diod compatibility
 */
export interface IStreamOrchestrator {
  /**
   * Execute a DAG workflow as an async event stream
   */
  executeStream(
    dag: DAGStructure,
    deps: IStreamOrchestratorDeps,
    workflowId?: string,
  ): AsyncGenerator<ExecutionEvent, WorkflowState, void>;

  /**
   * Resume workflow from a checkpoint
   */
  resumeFromCheckpoint(
    dag: DAGStructure,
    checkpointId: string,
    deps: IStreamOrchestratorDeps,
  ): AsyncGenerator<ExecutionEvent, WorkflowState, void>;
}
