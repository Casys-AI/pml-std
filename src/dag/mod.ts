/**
 * DAG Execution Module
 *
 * Provides parallel and controlled execution of DAG workflows with:
 * - Automatic parallelization based on dependencies
 * - SSE streaming for progressive results
 * - Checkpoint/resume for long-running workflows
 * - State management with reducers
 *
 * @module dag
 */

// Core executors
export { ParallelExecutor } from "./executor.ts";
export { ControlledExecutor } from "./controlled-executor.ts";

// Checkpoint management
export { CheckpointManager } from "./checkpoint-manager.ts";
export type { Checkpoint } from "./types.ts";

// Command queue
export { AsyncQueue, CommandQueue, isValidCommand } from "./command-queue.ts";
export type { Command } from "./types.ts";

// Event streaming
export { EventStream } from "./event-stream.ts";
export type { EventStreamStats } from "./event-stream.ts";

// SSE Streaming
export { BufferedEventStream, StreamingExecutor } from "./streaming.ts";
export type {
  BufferedStreamConfig,
  ErrorEvent,
  ExecutionCompleteEvent,
  SSEEvent,
  TaskCompleteEvent,
  TaskStartEvent,
} from "./streaming.ts";

// State management
export {
  contextReducer,
  createInitialState,
  decisionsReducer,
  getStateSnapshot,
  messagesReducer,
  tasksReducer,
  updateState,
  validateStateInvariants,
} from "./state.ts";
export type { Decision, Message, StateUpdate, WorkflowState } from "./state.ts";

// Core types
export type {
  DAGExecutionResult,
  ExecutionEvent,
  ExecutorConfig,
  TaskError,
  TaskResult,
  ToolExecutor,
} from "./types.ts";

// Story 10.5: Static Structure to DAG Conversion
export {
  estimateParallelLayers,
  getToolsFromStaticStructure,
  isValidForDagConversion,
  staticStructureToDag,
} from "./static-to-dag-converter.ts";
export type {
  ConditionalDAGStructure,
  ConditionalTask,
  ConversionOptions,
  TaskCondition,
} from "./static-to-dag-converter.ts";

// Story 10.5: Argument Resolution at Runtime
export {
  buildResolutionSummary,
  mergeArguments,
  resolveArguments,
  validateRequiredArguments,
} from "./argument-resolver.ts";
export type { ExecutionContext } from "./argument-resolver.ts";

// Story 10.5 AC10/AC11: WorkerBridge-based Tool Executor
export {
  cleanupWorkerBridgeExecutor,
  createSimpleToolExecutorViaWorker,
  createToolExecutorViaWorker,
} from "./execution/workerbridge-executor.ts";
export type {
  ExecutorContext,
  WorkerBridgeExecutorConfig,
} from "./execution/workerbridge-executor.ts";
