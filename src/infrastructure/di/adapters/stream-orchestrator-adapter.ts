/**
 * Stream Orchestrator Adapter
 *
 * Adapts DAGStreamOrchestrator to the IStreamOrchestrator interface for DI.
 *
 * @module infrastructure/di/adapters/stream-orchestrator-adapter
 */

import type { IStreamOrchestratorDeps } from "../../../domain/interfaces/stream-orchestrator.ts";
import type { DAGStructure } from "../../../graphrag/types.ts";
import type { ExecutionEvent } from "../../../dag/types.ts";
import type { WorkflowState } from "../../../dag/state.ts";
import { DAGStreamOrchestrator, type OrchestratorDeps } from "../../../dag/execution/dag-stream-orchestrator.ts";
import { StreamOrchestrator } from "../container.ts";

/**
 * Adapter implementing StreamOrchestrator token
 */
export class StreamOrchestratorAdapter extends StreamOrchestrator {
  private readonly orchestrator: DAGStreamOrchestrator;

  constructor() {
    super();
    this.orchestrator = new DAGStreamOrchestrator();
  }

  executeStream(
    dag: DAGStructure,
    deps: IStreamOrchestratorDeps,
    workflowId?: string,
  ): AsyncGenerator<ExecutionEvent, WorkflowState, void> {
    // Cast deps to concrete type (adapter responsibility)
    return this.orchestrator.executeStream(dag, deps as OrchestratorDeps, workflowId);
  }

  resumeFromCheckpoint(
    dag: DAGStructure,
    checkpointId: string,
    deps: IStreamOrchestratorDeps,
  ): AsyncGenerator<ExecutionEvent, WorkflowState, void> {
    return this.orchestrator.resumeFromCheckpoint(dag, checkpointId, deps as OrchestratorDeps);
  }
}

/**
 * Factory function for DI registration
 */
export function createStreamOrchestrator(): StreamOrchestrator {
  return new StreamOrchestratorAdapter();
}
