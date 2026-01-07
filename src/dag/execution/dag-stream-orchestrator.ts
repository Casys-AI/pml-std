/**
 * DAG Stream Orchestrator - Coordinates layer execution with event streaming
 *
 * Uses DAGLayerExecutor (Template Method) and DAGDecisionHandler (Strategy)
 * to execute DAG workflows as async generators.
 *
 * @module dag/execution/dag-stream-orchestrator
 */

import type { DAGStructure, Task, CompletedTask } from "../../graphrag/types.ts";
import type { ExecutionEvent, TaskResult, ExecutorConfig } from "../types.ts";
import type { WorkflowState } from "../state.ts";
import type { EventStream } from "../event-stream.ts";
import type { CommandQueue } from "../command-queue.ts";
import type { CheckpointManager } from "../checkpoint-manager.ts";
import type { EpisodicMemoryStore } from "../../learning/episodic-memory-store.ts";
import type { DAGSuggester } from "../../graphrag/dag-suggester.ts";
import type { WorkerBridge } from "../../sandbox/worker-bridge.ts";
import type { ToolDefinition } from "../../sandbox/types.ts";
import { createInitialState, updateState, type StateUpdate } from "../state.ts";
import { DAGDecisionHandler, type DecisionContext } from "./dag-decision-handler.ts";
import { waitForDecisionCommand } from "../loops/decision-waiter.ts";
import { saveCheckpointAfterLayer, loadCheckpoint, calculateResumeProgress } from "../checkpoints/integration.ts";
import { startSpeculativeExecution, type SpeculationState } from "../speculation/integration.ts";
import { captureSpeculationStart } from "../episodic/capture.ts";
import { prepareEscalations, processEscalationResponses } from "../permissions/layer-escalation.ts";
import { collectLayerResults, type LayerResultsDeps } from "./layer-results.ts";
import { getToolPermissionConfig } from "../../capabilities/permission-inferrer.ts";
import * as log from "@std/log";

/**
 * Check if a task requires Human-in-the-Loop approval before execution.
 */
function taskRequiresHIL(task: Task): boolean {
  if (!task.tool) return false;
  if (task.metadata?.pure === true) return false;
  const prefix = task.tool.split(":")[0];
  const config = getToolPermissionConfig(prefix);
  return !config || config.approvalMode === "hil";
}

/**
 * Dependencies for the orchestrator
 */
export interface OrchestratorDeps {
  eventStream: EventStream;
  commandQueue: CommandQueue;
  checkpointManager: CheckpointManager | null;
  episodicMemory: EpisodicMemoryStore | null;
  dagSuggester: DAGSuggester | null;
  workerBridge: WorkerBridge | null;
  toolDefinitions: ToolDefinition[];
  executionArgs: Record<string, unknown>;
  config: ExecutorConfig;
  userId: string;
  speculationState: SpeculationState;
  topologicalSort: (dag: DAGStructure) => Task[][];
  executeTask: (task: Task, results: Map<string, TaskResult>) => Promise<{ output: unknown; executionTimeMs: number }>;
  updateGraphRAG: (workflowId: string, dag: DAGStructure, totalTime: number, failedTasks: number) => void;
}

/**
 * DAG Stream Orchestrator - Manages workflow execution streams
 */
export class DAGStreamOrchestrator {
  private decisionHandler = new DAGDecisionHandler();
  private replanCount = 0;

  /**
   * Execute a DAG workflow as an async event stream
   */
  async *executeStream(
    dag: DAGStructure,
    deps: OrchestratorDeps,
    workflowId?: string,
  ): AsyncGenerator<ExecutionEvent, WorkflowState, void> {
    const wfId = workflowId ?? `workflow-${Date.now()}`;
    const startTime = performance.now();

    const state = createInitialState(wfId);
    let layers = deps.topologicalSort(dag);
    let speculationState = deps.speculationState;

    // Emit workflow start
    const startEvent: ExecutionEvent = {
      type: "workflow_start",
      timestamp: Date.now(),
      workflowId: wfId,
      totalLayers: layers.length,
    };
    await deps.eventStream.emit(startEvent);
    yield startEvent;

    const results = new Map<string, TaskResult>();
    let successfulTasks = 0;
    let failedTasks = 0;
    let currentState = state;

    for (let layerIdx = 0; layerIdx < layers.length; layerIdx++) {
      const layerOutput = yield* this.executeLayer(
        wfId,
        dag,
        layers,
        layerIdx,
        results,
        currentState,
        speculationState,
        deps,
        startTime,
        successfulTasks,
        failedTasks,
      );

      if (!layerOutput) {
        // Workflow aborted
        return currentState;
      }

      currentState = layerOutput.state;
      speculationState = layerOutput.speculationState;
      successfulTasks = layerOutput.successfulTasks;
      failedTasks = layerOutput.failedTasks;
      if (layerOutput.layers) layers = layerOutput.layers;
      if (layerOutput.dag) dag = layerOutput.dag;
    }

    // Workflow complete
    const totalTime = performance.now() - startTime;
    const completeEvent: ExecutionEvent = {
      type: "workflow_complete",
      timestamp: Date.now(),
      workflowId: wfId,
      totalTimeMs: totalTime,
      successfulTasks,
      failedTasks,
    };
    await deps.eventStream.emit(completeEvent);
    yield completeEvent;

    deps.updateGraphRAG(wfId, dag, totalTime, failedTasks);
    await deps.eventStream.close();

    return currentState;
  }

  /**
   * Resume workflow from a checkpoint
   */
  async *resumeFromCheckpoint(
    dag: DAGStructure,
    checkpointId: string,
    deps: OrchestratorDeps,
  ): AsyncGenerator<ExecutionEvent, WorkflowState, void> {
    const checkpoint = await loadCheckpoint(deps.checkpointManager, checkpointId);
    if (!checkpoint) throw new Error(`Checkpoint ${checkpointId} not found`);

    const startTime = performance.now();
    const workflowId = checkpoint.workflowId;
    let currentState = checkpoint.state;
    let speculationState = deps.speculationState;

    let layers = deps.topologicalSort(dag);
    const { completedCount } = calculateResumeProgress(checkpoint.layer, layers.length);
    const remainingLayers = layers.slice(completedCount);

    log.info(`Resuming workflow ${workflowId} from layer ${checkpoint.layer}`);

    // Emit workflow start
    const startEvent: ExecutionEvent = {
      type: "workflow_start",
      timestamp: Date.now(),
      workflowId,
      totalLayers: layers.length,
    };
    await deps.eventStream.emit(startEvent);
    yield startEvent;

    // Restore previous results
    const results = new Map<string, TaskResult>();
    for (const task of currentState.tasks) results.set(task.taskId, task);

    let successfulTasks = currentState.tasks.filter((t) => t.status === "success").length;
    let failedTasks = currentState.tasks.filter((t) => t.status === "error").length;

    for (let i = 0; i < remainingLayers.length; i++) {
      const actualLayerIdx = completedCount + i;
      const layerOutput = yield* this.executeLayer(
        workflowId,
        dag,
        layers,
        actualLayerIdx,
        results,
        currentState,
        speculationState,
        deps,
        startTime,
        successfulTasks,
        failedTasks,
        i === 0 ? remainingLayers[i] : undefined, // Use remaining layer for first iteration
      );

      if (!layerOutput) {
        return currentState;
      }

      currentState = layerOutput.state;
      speculationState = layerOutput.speculationState;
      successfulTasks = layerOutput.successfulTasks;
      failedTasks = layerOutput.failedTasks;
      if (layerOutput.layers) layers = layerOutput.layers;
      if (layerOutput.dag) dag = layerOutput.dag;
    }

    const totalTime = performance.now() - startTime;
    const completeEvent: ExecutionEvent = {
      type: "workflow_complete",
      timestamp: Date.now(),
      workflowId,
      totalTimeMs: totalTime,
      successfulTasks,
      failedTasks,
    };
    await deps.eventStream.emit(completeEvent);
    yield completeEvent;

    deps.updateGraphRAG(workflowId, dag, totalTime, failedTasks);
    await deps.eventStream.close();

    return currentState;
  }

  /**
   * Execute a single layer with all hooks (events, escalations, decisions)
   */
  private async *executeLayer(
    workflowId: string,
    dag: DAGStructure,
    layers: Task[][],
    layerIdx: number,
    results: Map<string, TaskResult>,
    state: WorkflowState,
    speculationState: SpeculationState,
    deps: OrchestratorDeps,
    startTime: number,
    successfulTasks: number,
    failedTasks: number,
    overrideLayer?: Task[],
  ): AsyncGenerator<
    ExecutionEvent,
    {
      state: WorkflowState;
      speculationState: SpeculationState;
      successfulTasks: number;
      failedTasks: number;
      layers?: Task[][];
      dag?: DAGStructure;
    } | null,
    void
  > {
    const layer = overrideLayer ?? layers[layerIdx];

    // Layer start
    const layerStartEvent: ExecutionEvent = {
      type: "layer_start",
      timestamp: Date.now(),
      workflowId,
      layerIndex: layerIdx,
      tasksCount: layer.length,
    };
    await deps.eventStream.emit(layerStartEvent);
    yield layerStartEvent;

    // Process control commands
    const commands = await deps.commandQueue.processCommandsByType(["abort", "pause"]);
    for (const cmd of commands) {
      if (cmd.type === "abort") {
        throw new Error(`Workflow aborted by agent: ${cmd.reason}`);
      }
    }

    // Start speculation
    this.startSpeculation(state, dag, workflowId, deps);

    // Filter executable tasks
    const executableTasks = layer.filter((task) => task.metadata?.executable !== false);
    if (executableTasks.length < layer.length) {
      log.debug("Skipping non-executable nested tasks", {
        layerIdx,
        total: layer.length,
        executable: executableTasks.length,
      });
    }

    // Pre-execution HIL check
    const hilAborted = yield* this.handlePreExecutionHIL(
      workflowId,
      executableTasks,
      layerIdx,
      layers.length,
      deps,
      startTime,
      successfulTasks,
      failedTasks,
    );
    if (hilAborted) return null;
    const layerHadHILCheck = deps.config.hil?.enabled && executableTasks.some(taskRequiresHIL);

    // Emit task starts
    for (const task of executableTasks) {
      const event: ExecutionEvent = {
        type: "task_start",
        timestamp: Date.now(),
        workflowId,
        taskId: task.id,
        tool: task.tool,
      };
      await deps.eventStream.emit(event);
      yield event;
    }

    // Execute tasks
    let layerResults = await Promise.allSettled(
      executableTasks.map((task) => deps.executeTask(task, results)),
    );

    // Handle escalations
    const escalationPrep = prepareEscalations(workflowId, executableTasks, layerResults);
    for (const event of escalationPrep.events) {
      await deps.eventStream.emit(event);
      yield event;
    }

    if (escalationPrep.escalations.length > 0) {
      layerResults = await processEscalationResponses(
        executableTasks,
        layerResults,
        results,
        escalationPrep.escalations,
        deps.commandQueue,
        deps.config.timeouts?.hil ?? 300000,
        {
          workerBridge: deps.workerBridge!,
          toolDefinitions: deps.toolDefinitions,
          executionArgs: deps.executionArgs,
        },
      );
    }

    // Collect results
    const resultsDeps: LayerResultsDeps = {
      eventStream: deps.eventStream,
      captureContext: { state, episodicMemory: deps.episodicMemory },
      speculationState,
    };
    const collectionOutput = await collectLayerResults(
      workflowId,
      executableTasks,
      layerResults,
      results,
      layerIdx,
      resultsDeps,
    );

    for (const event of collectionOutput.layerTaskResults.events) yield event;

    // Update state
    const stateUpdate: StateUpdate = {
      currentLayer: layerIdx,
      tasks: collectionOutput.layerTaskResults.tasks,
    };
    const newState = updateState(state, stateUpdate);

    const stateEvent: ExecutionEvent = {
      type: "state_updated",
      timestamp: Date.now(),
      workflowId,
      updates: { tasksAdded: collectionOutput.layerTaskResults.tasks.length },
    };
    await deps.eventStream.emit(stateEvent);
    yield stateEvent;

    // Checkpoint
    const checkpointEvent = await this.saveCheckpoint(
      deps.checkpointManager,
      workflowId,
      layerIdx,
      newState,
      deps.eventStream,
    );
    if (checkpointEvent) yield checkpointEvent;

    // Per-layer validation pause
    if (deps.config.perLayerValidation && layerIdx < layers.length - 1 && !layerHadHILCheck) {
      yield* this.handlePerLayerValidation(
        workflowId,
        deps,
        startTime,
        successfulTasks + collectionOutput.layerSuccess,
        failedTasks + collectionOutput.layerFailed,
        layerIdx,
      );
    }

    // AIL/HIL decisions
    const decisionCtx = this.buildDecisionContext(workflowId, dag, layers, newState, deps);
    const decisions = yield* this.handleDecisions(
      decisionCtx,
      layerIdx,
      collectionOutput.layerFailed > 0,
      layer,
      deps,
    );

    return {
      state: newState,
      speculationState: collectionOutput.updatedSpeculationState,
      successfulTasks: successfulTasks + collectionOutput.layerSuccess,
      failedTasks: failedTasks + collectionOutput.layerFailed,
      layers: decisions.newLayers,
      dag: decisions.newDag,
    };
  }

  private startSpeculation(
    state: WorkflowState,
    dag: DAGStructure,
    workflowId: string,
    deps: OrchestratorDeps,
  ): void {
    const completedTasks: CompletedTask[] = state.tasks.map((t) => ({
      taskId: t.taskId,
      tool: dag.tasks.find((dt) => dt.id === t.taskId)?.tool ?? "unknown",
      status: t.status as "success" | "error" | "failed_safe",
      executionTimeMs: t.executionTimeMs,
    }));

    startSpeculativeExecution(
      deps.speculationState,
      deps.dagSuggester,
      completedTasks,
      {},
      workflowId,
      (wId, toolId, confidence, reasoning) => {
        captureSpeculationStart(
          { state, episodicMemory: deps.episodicMemory },
          wId,
          toolId,
          confidence,
          reasoning,
        );
      },
    ).catch((err) => log.debug(`Speculation failed: ${err}`));
  }

  private async *handlePreExecutionHIL(
    workflowId: string,
    executableTasks: Task[],
    layerIdx: number,
    totalLayers: number,
    deps: OrchestratorDeps,
    startTime: number,
    successfulTasks: number,
    failedTasks: number,
  ): AsyncGenerator<ExecutionEvent, boolean, void> {
    // Skip if HIL is not enabled in config
    if (!deps.config.hil?.enabled) return false;

    const hilTasks = executableTasks.filter(taskRequiresHIL);
    if (hilTasks.length === 0) return false;

    const approvalEvent: ExecutionEvent = {
      type: "decision_required",
      timestamp: Date.now(),
      workflowId,
      decisionType: "HIL",
      description: `Approval required before executing ${hilTasks.length} task(s)`,
      checkpointId: `pre-exec-${workflowId}-layer${layerIdx}`,
      context: {
        tasks: hilTasks.map((t) => ({
          id: t.id,
          tool: t.tool,
          arguments: t.arguments ?? t.staticArguments ?? {},
        })),
        layerIndex: layerIdx,
        totalLayers,
      },
    };
    await deps.eventStream.emit(approvalEvent);
    yield approvalEvent;

    log.info(`[HIL] Waiting for approval before executing layer ${layerIdx}`);
    const cmd = await waitForDecisionCommand(
      deps.commandQueue,
      "HIL",
      deps.config.timeouts?.hil ?? 300000,
    );

    if (!cmd || cmd.type === "abort") {
      log.info(`[HIL] User aborted before execution`);
      const abortEvent: ExecutionEvent = {
        type: "workflow_abort",
        timestamp: Date.now(),
        workflowId,
        reason: "User rejected pre-execution approval",
        totalTimeMs: performance.now() - startTime,
        successfulTasks,
        failedTasks,
      };
      await deps.eventStream.emit(abortEvent);
      yield abortEvent;
      await deps.eventStream.close();
      return true;
    }

    log.info(`[HIL] User approved, proceeding with execution`);
    return false;
  }

  private async *handlePerLayerValidation(
    workflowId: string,
    deps: OrchestratorDeps,
    startTime: number,
    successfulTasks: number,
    failedTasks: number,
    layerIdx: number,
  ): AsyncGenerator<ExecutionEvent, void, void> {
    log.debug(`[perLayerValidation] Waiting for continue command after layer ${layerIdx}`);
    const cmd = await waitForDecisionCommand(
      deps.commandQueue,
      "HIL",
      deps.config.timeouts?.hil ?? 300000,
    );

    const isValidContinue = cmd && (
      cmd.type === "continue" ||
      (cmd.type === "approval_response" && cmd.approved === true)
    );

    if (!isValidContinue) {
      log.warn(`[perLayerValidation] Unexpected command: ${cmd?.type}, treating as abort`);
      const abortEvent: ExecutionEvent = {
        type: "workflow_complete",
        timestamp: Date.now(),
        workflowId,
        totalTimeMs: performance.now() - startTime,
        successfulTasks,
        failedTasks,
      };
      await deps.eventStream.emit(abortEvent);
      yield abortEvent;
      await deps.eventStream.close();
    }

    log.debug(`[perLayerValidation] Continue command received, proceeding to layer ${layerIdx + 1}`);
  }

  private async saveCheckpoint(
    checkpointManager: CheckpointManager | null,
    workflowId: string,
    layerIdx: number,
    state: WorkflowState,
    eventStream: EventStream,
  ): Promise<ExecutionEvent | null> {
    if (!checkpointManager) return null;

    const checkpointId = await saveCheckpointAfterLayer(checkpointManager, workflowId, layerIdx, state);
    if (checkpointId === "") return null;

    const finalCheckpointId = checkpointId ?? `failed-${workflowId}-layer${layerIdx}`;
    const checkpointEvent: ExecutionEvent = {
      type: "checkpoint",
      timestamp: Date.now(),
      workflowId,
      checkpointId: finalCheckpointId,
      layerIndex: layerIdx,
    };
    await eventStream.emit(checkpointEvent);
    return checkpointEvent;
  }

  private buildDecisionContext(
    workflowId: string,
    dag: DAGStructure,
    layers: Task[][],
    state: WorkflowState,
    deps: OrchestratorDeps,
  ): DecisionContext {
    return {
      workflowId,
      state,
      layers,
      dag,
      config: deps.config,
      eventStream: deps.eventStream,
      commandQueue: deps.commandQueue,
      episodicMemory: deps.episodicMemory,
      dagSuggester: deps.dagSuggester,
      replanCount: this.replanCount,
      timeouts: {
        hil: deps.config.timeouts?.hil ?? 300000,
        ail: deps.config.timeouts?.ail ?? 60000,
      },
    };
  }

  private async *handleDecisions(
    ctx: DecisionContext,
    layerIdx: number,
    hasErrors: boolean,
    layer: Task[],
    deps: OrchestratorDeps,
  ): AsyncGenerator<ExecutionEvent, { newLayers?: Task[][]; newDag?: DAGStructure }, void> {
    // AIL Decision
    const ailPrep = await this.decisionHandler.prepareAILDecision(ctx, layerIdx, hasErrors);
    if (ailPrep.event) yield ailPrep.event;

    let newLayers: Task[][] | undefined;
    let newDag: DAGStructure | undefined;

    if (ailPrep.needsResponse) {
      const result = await this.decisionHandler.waitForAILResponse(ctx, deps.topologicalSort);
      if (result.newLayers) {
        this.replanCount++;
        newLayers = result.newLayers;
        newDag = result.newDag as DAGStructure | undefined;
      }
    }

    // HIL Approval
    const hilPrep = await this.decisionHandler.prepareHILApproval(ctx, layerIdx, layer);
    if (hilPrep.event) yield hilPrep.event;

    if (hilPrep.needsResponse) {
      await this.decisionHandler.waitForHILResponse(ctx, layerIdx);
    }

    return { newLayers, newDag };
  }
}

// Singleton for convenience
export const dagStreamOrchestrator = new DAGStreamOrchestrator();
