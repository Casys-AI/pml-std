/**
 * Execution Module Exports
 *
 * Re-exports task routing and execution functionality.
 *
 * @module dag/execution
 */

export {
  getTaskType,
  isMCPTool,
  isSafeToFail,
  requiresSandbox,
  type TaskType,
} from "./task-router.ts";

export { type CodeExecutorDeps, executeCodeTask, executeWithRetry } from "./code-executor.ts";

export {
  type CapabilityExecutorDeps,
  executeCapabilityTask,
  getCapabilityPermissionSet,
} from "./capability-executor.ts";

export { resolveDependencies } from "./dependency-resolver.ts";

// Code task executor (extracted from controlled-executor.ts)
export {
  executeCodeTask as executeCodeTaskViaWorkerBridge,
  type CodeTaskExecutorDeps,
  type CodeTaskResult,
} from "./code-task-executor.ts";

// Layer results collection (extracted from controlled-executor.ts)
export {
  collectLayerResults,
  RESULT_PREVIEW_MAX_LENGTH,
  type LayerResultsCollection,
  type LayerResultsDeps,
  type LayerResultsOutput,
} from "./layer-results.ts";

// WorkerBridge executor
export {
  createToolExecutorViaWorker,
  createSimpleToolExecutorViaWorker,
  cleanupWorkerBridgeExecutor,
  type WorkerBridgeExecutorConfig,
  type ExecutorContext,
} from "./workerbridge-executor.ts";

// DAG Layer Executor (Template Method implementation)
export { DAGLayerExecutor, type DAGExecutionContext, type TaskExecutorFn } from "./dag-layer-executor.ts";

// DAG Decision Handler (Strategy implementation)
export { DAGDecisionHandler, dagDecisionHandler, type DecisionContext } from "./dag-decision-handler.ts";

// DAG Stream Orchestrator
export { DAGStreamOrchestrator, dagStreamOrchestrator, type OrchestratorDeps } from "./dag-stream-orchestrator.ts";
