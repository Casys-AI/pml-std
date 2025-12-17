/**
 * ControlledExecutor - DAG Executor with Adaptive Feedback Loops
 *
 * Extends ParallelExecutor with:
 * - Event stream for real-time observability
 * - Command queue for dynamic control
 * - WorkflowState management with reducers
 * - Zero breaking changes to Epic 2 code
 *
 * @module dag/controlled-executor
 */

import { ParallelExecutor } from "./executor.ts";
import type { DAGStructure, Task } from "../graphrag/types.ts";
import { PermissionEscalationNeeded, type DAGExecutionResult, type ExecutionEvent, type ExecutorConfig, type TaskError, type TaskResult, type ToolExecutor } from "./types.ts";
import { EventStream, type EventStreamStats } from "./event-stream.ts";
import { CommandQueue, type CommandQueueStats } from "./command-queue.ts";
import {
  createInitialState,
  getStateSnapshot,
  type StateUpdate,
  updateState,
  type WorkflowState,
} from "./state.ts";
import { CheckpointManager } from "./checkpoint-manager.ts";
import type { PGliteClient } from "../db/client.ts";
import { getLogger } from "../telemetry/logger.ts";
import type { DAGSuggester } from "../graphrag/dag-suggester.ts";
import type { EpisodicMemoryStore } from "../learning/episodic-memory-store.ts";
import type { CompletedTask, SpeculationCache, SpeculationConfig, SpeculationMetrics } from "../graphrag/types.ts";
import type { PermissionEscalationRequest, PermissionSet } from "../capabilities/types.ts";
import type { PermissionAuditStore } from "../capabilities/permission-audit-store.ts";
import { PermissionEscalationHandler, formatEscalationRequest } from "../capabilities/permission-escalation-handler.ts";
import { suggestEscalation } from "../capabilities/permission-escalation.ts";
import type { CapabilityStore } from "../capabilities/capability-store.ts";
import type { GraphRAGEngine } from "../graphrag/graph-engine.ts";
import type { Command } from "./types.ts";

// Import extracted modules
import {
  type CaptureContext,
  captureTaskComplete,
  captureAILDecision,
  captureHILDecision,
  captureSpeculationStart,
} from "./episodic/capture.ts";
import { waitForDecisionCommand } from "./loops/decision-waiter.ts";
import { shouldRequireApproval, generateHILSummary } from "./loops/hil-handler.ts";
import { shouldTriggerAIL, MAX_REPLANS } from "./loops/ail-handler.ts";
import {
  type SpeculationState,
  createSpeculationState,
  enableSpeculation as enableSpeculationState,
  disableSpeculation as disableSpeculationState,
  startSpeculativeExecution,
  checkSpeculativeCache,
  consumeSpeculation as consumeSpeculationFromState,
  getSpeculationMetrics as getSpeculationMetricsFromState,
  updateLastCompletedTool,
} from "./speculation/integration.ts";
import { saveCheckpointAfterLayer, loadCheckpoint, calculateResumeProgress } from "./checkpoints/integration.ts";
import { isSafeToFail, getTaskType } from "./execution/task-router.ts";
import { executeCodeTask, executeWithRetry, type CodeExecutorDeps } from "./execution/code-executor.ts";
import { executeCapabilityTask, getCapabilityPermissionSet } from "./execution/capability-executor.ts";
import { isPermissionError } from "./permissions/escalation-integration.ts";

const log = getLogger("controlled-executor");

/**
 * ControlledExecutor extends ParallelExecutor with adaptive feedback loops
 *
 * Features:
 * - executeStream() async generator yields events in real-time
 * - Event stream for observability (<5ms emission overhead)
 * - Command queue for dynamic control (<10ms injection latency)
 * - WorkflowState with MessagesState-inspired reducers
 * - Backward compatible (ParallelExecutor.execute() still works)
 * - Preserves 5x speedup from parallel execution
 */
export class ControlledExecutor extends ParallelExecutor {
  private state: WorkflowState | null = null;
  private eventStream: EventStream;
  private commandQueue: CommandQueue;
  private checkpointManager: CheckpointManager | null = null;
  private dagSuggester: DAGSuggester | null = null;
  private replanCount: number = 0;
  private episodicMemory: EpisodicMemoryStore | null = null;
  private speculationState: SpeculationState;
  private userId: string = "local";
  private capabilityStore?: CapabilityStore;
  private graphRAG?: GraphRAGEngine;
  private permissionEscalationHandler: PermissionEscalationHandler | null = null;
  private _permissionAuditStore: PermissionAuditStore | null = null;

  constructor(toolExecutor: ToolExecutor, config: ExecutorConfig = {}) {
    super(toolExecutor, config);
    this.eventStream = new EventStream();
    this.commandQueue = new CommandQueue();
    this.userId = config.userId ?? "local";
    this.speculationState = createSpeculationState();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Configuration Methods
  // ═══════════════════════════════════════════════════════════════════════════

  setCheckpointManager(db: PGliteClient, autoPrune: boolean = true): void {
    this.checkpointManager = new CheckpointManager(db, autoPrune);
  }

  setDAGSuggester(dagSuggester: DAGSuggester): void {
    this.dagSuggester = dagSuggester;
  }

  setLearningDependencies(
    capabilityStore?: CapabilityStore,
    graphRAG?: GraphRAGEngine,
  ): void {
    this.capabilityStore = capabilityStore;
    this.graphRAG = graphRAG;
    log.debug("Learning dependencies set", { hasCapabilityStore: !!capabilityStore, hasGraphRAG: !!graphRAG });
  }

  setPermissionEscalationDependencies(auditStore: PermissionAuditStore): void {
    this._permissionAuditStore = auditStore;
    if (this.capabilityStore && auditStore) {
      this.permissionEscalationHandler = new PermissionEscalationHandler(
        this.capabilityStore,
        auditStore,
        async (request: PermissionEscalationRequest) => this.requestPermissionEscalation(request),
        this.userId,
      );
      log.debug("Permission escalation handler configured", { userId: this.userId });
    }
  }

  setEpisodicMemoryStore(store: EpisodicMemoryStore): void {
    this.episodicMemory = store;
    log.debug("Episodic memory capture enabled");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Speculation Methods
  // ═══════════════════════════════════════════════════════════════════════════

  enableSpeculation(config?: Partial<SpeculationConfig>): void {
    this.speculationState = enableSpeculationState(this.speculationState, this.dagSuggester, config);
  }

  disableSpeculation(): void {
    this.speculationState = disableSpeculationState(this.speculationState);
  }

  checkSpeculativeCache(toolId: string): SpeculationCache | null {
    return checkSpeculativeCache(this.speculationState, toolId);
  }

  async consumeSpeculation(toolId: string): Promise<SpeculationCache | null> {
    return await consumeSpeculationFromState(this.speculationState, toolId);
  }

  getSpeculationMetrics(): SpeculationMetrics | null {
    return getSpeculationMetricsFromState(this.speculationState);
  }

  getSpeculationConfig(): SpeculationConfig {
    return { ...this.speculationState.config };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Permission Escalation
  // ═══════════════════════════════════════════════════════════════════════════

  async requestPermissionEscalation(
    request: PermissionEscalationRequest,
  ): Promise<{ approved: boolean; feedback?: string }> {
    const workflowId = this.state?.workflowId ?? "unknown";
    const description = formatEscalationRequest(request);

    const escalationEvent: ExecutionEvent = {
      type: "decision_required",
      timestamp: Date.now(),
      workflowId,
      decisionType: "HIL",
      description,
    };
    await this.eventStream.emit(escalationEvent);

    log.info("Permission escalation requested, waiting for HIL approval", {
      capabilityId: request.capabilityId,
      currentSet: request.currentSet,
      requestedSet: request.requestedSet,
    });

    const command = await waitForDecisionCommand(this.commandQueue, "HIL", this.getTimeout("hil"));
    if (!command) {
      log.warn("Permission escalation timeout - rejecting");
      return { approved: false, feedback: "Escalation request timed out" };
    }

    if (command.type === "permission_escalation_response" || command.type === "approval_response") {
      const approved = command.approved === true;
      log.info(`Permission escalation ${approved ? "approved" : "rejected"}`, {
        capabilityId: request.capabilityId,
        feedback: command.feedback,
      });

      const ctx = this.getCaptureContext();
      captureHILDecision(
        ctx,
        workflowId,
        approved,
        `perm-esc-${request.capabilityId}`,
        command.feedback ?? `Escalation ${request.currentSet} -> ${request.requestedSet}`,
      );

      return { approved, feedback: command.feedback };
    }

    log.warn(`Unexpected command type for permission escalation: ${command.type}`);
    return { approved: false, feedback: `Unexpected response: ${command.type}` };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Timeout Configuration
  // ═══════════════════════════════════════════════════════════════════════════

  /** Default timeout values */
  private static readonly DEFAULT_TIMEOUTS = {
    hil: 300000, // 5 minutes
    ail: 60000, // 1 minute
    pollInterval: 100, // 100ms (legacy, not used with new async wait)
  };

  /** Get configured timeout or default */
  private getTimeout(type: "hil" | "ail" | "pollInterval"): number {
    return this.config.timeouts?.[type] ?? ControlledExecutor.DEFAULT_TIMEOUTS[type];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // State & Queue Access
  // ═══════════════════════════════════════════════════════════════════════════

  enqueueCommand(command: Command): void {
    this.commandQueue.enqueue(command);
  }

  getState(): Readonly<WorkflowState> | null {
    return this.state ? getStateSnapshot(this.state) : null;
  }

  updateState(update: StateUpdate): void {
    if (!this.state) throw new Error("State not initialized - call executeStream() first");
    this.state = updateState(this.state, update);
  }

  getEventStreamStats(): EventStreamStats {
    return this.eventStream.getStats();
  }

  getCommandQueueStats(): CommandQueueStats {
    return this.commandQueue.getStats();
  }

  getPermissionAuditStore(): PermissionAuditStore | null {
    return this._permissionAuditStore;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Core Execution
  // ═══════════════════════════════════════════════════════════════════════════

  async *executeStream(
    dag: DAGStructure,
    workflow_id?: string,
  ): AsyncGenerator<ExecutionEvent, WorkflowState, void> {
    const workflowId = workflow_id ?? `workflow-${Date.now()}`;
    const startTime = performance.now();

    this.state = createInitialState(workflowId);
    let layers = this.topologicalSort(dag);

    const startEvent: ExecutionEvent = {
      type: "workflow_start",
      timestamp: Date.now(),
      workflowId,
      totalLayers: layers.length,
    };
    await this.eventStream.emit(startEvent);
    yield startEvent;

    const results = new Map<string, TaskResult>();
    let successfulTasks = 0;
    let failedTasks = 0;

    for (let layerIdx = 0; layerIdx < layers.length; layerIdx++) {
      const layer = layers[layerIdx];

      // Layer start event
      const layerStartEvent: ExecutionEvent = {
        type: "layer_start",
        timestamp: Date.now(),
        workflowId,
        layerIndex: layerIdx,
        tasksCount: layer.length,
      };
      await this.eventStream.emit(layerStartEvent);
      yield layerStartEvent;

      // Process control commands
      const commands = await this.commandQueue.processCommandsByType(["abort", "pause"]);
      for (const cmd of commands) {
        if (cmd.type === "abort") {
          throw new Error(`Workflow aborted by agent: ${cmd.reason}`);
        }
      }

      // Start speculation
      const completedTasksForPrediction: CompletedTask[] = this.state.tasks.map((t) => ({
        taskId: t.taskId,
        tool: dag.tasks.find((dt) => dt.id === t.taskId)?.tool ?? "unknown",
        status: t.status as "success" | "error" | "failed_safe",
        executionTimeMs: t.executionTimeMs,
      }));

      startSpeculativeExecution(
        this.speculationState,
        this.dagSuggester,
        completedTasksForPrediction,
        {},
        workflowId,
        (wId, toolId, confidence, reasoning) => {
          captureSpeculationStart(this.getCaptureContext(), wId, toolId, confidence, reasoning);
        },
      ).catch((err) => log.debug(`Speculation failed: ${err}`));

      // Execute layer
      for (const task of layer) yield* this.emitTaskStart(workflowId, task);

      let layerResults = await Promise.allSettled(
        layer.map((task) => this.executeTask(task, results)),
      );

      // Handle deferred permission escalations (Deferred Escalation Pattern)
      // Phase 1: Prepare escalation events (non-blocking)
      const escalationPrep = this.prepareEscalations(workflowId, layer, layerResults);

      // Yield escalation events BEFORE waiting for responses
      for (const event of escalationPrep.events) {
        await this.eventStream.emit(event);
        yield event;
      }

      // Phase 2: Wait for responses and re-execute (only if there are escalations)
      if (escalationPrep.escalations.length > 0) {
        layerResults = await this.processEscalationResponses(
          layer,
          layerResults,
          results,
          escalationPrep.escalations,
        );
      }

      // Collect results
      const { layerTaskResults, layerSuccess, layerFailed } = await this.collectLayerResults(
        workflowId,
        layer,
        layerResults,
        results,
      );

      for (const event of layerTaskResults.events) yield event;
      successfulTasks += layerSuccess;
      failedTasks += layerFailed;

      // Update state
      const stateUpdate: StateUpdate = { currentLayer: layerIdx, tasks: layerTaskResults.tasks };
      this.state = updateState(this.state, stateUpdate);

      const stateEvent: ExecutionEvent = {
        type: "state_updated",
        timestamp: Date.now(),
        workflowId,
        updates: { tasksAdded: layerTaskResults.tasks.length },
      };
      await this.eventStream.emit(stateEvent);
      yield stateEvent;

      // Checkpoint
      const checkpointEvent = await this.saveCheckpoint(workflowId, layerIdx);
      if (checkpointEvent) yield checkpointEvent;

      // AIL Decision Point (Deferred Pattern: yield event BEFORE waiting for response)
      const ailPrep = await this.prepareAILDecision(workflowId, layerIdx, failedTasks > 0);
      if (ailPrep.event) yield ailPrep.event;
      if (ailPrep.needsResponse) {
        const ailResult = await this.waitForAILResponse(workflowId, dag);
        if (ailResult.newLayers) layers = ailResult.newLayers;
        if (ailResult.newDag) dag = ailResult.newDag;
      }

      // HIL Approval (Deferred Pattern: yield event BEFORE waiting for response)
      // Note: Currently disabled - config.hil not passed, but code kept for future use
      const hilPrep = await this.prepareHILApproval(workflowId, layerIdx, layer, layers);
      if (hilPrep.event) yield hilPrep.event;
      if (hilPrep.needsResponse) {
        await this.waitForHILResponse(workflowId, layerIdx);
      }
    }

    // Workflow complete
    const totalTime = performance.now() - startTime;
    const completeEvent: ExecutionEvent = {
      type: "workflow_complete",
      timestamp: Date.now(),
      workflowId,
      totalTimeMs: totalTime,
      successfulTasks,
      failedTasks,
    };
    await this.eventStream.emit(completeEvent);
    yield completeEvent;

    // GraphRAG feedback
    this.updateGraphRAG(workflowId, dag, totalTime, failedTasks);

    await this.eventStream.close();
    return this.state;
  }

  /**
   * Execute DAG workflow (override to wrap executeStream for HIL support)
   *
   * This ensures execute() uses the same code path as executeStream(),
   * so HIL/AIL decision points work consistently everywhere.
   *
   * When HIL is disabled, decision_required events are auto-approved.
   * When HIL is enabled, this method will throw if no approval is given
   * (use executeStream() directly for interactive approval flows).
   */
  override async execute(dag: DAGStructure): Promise<DAGExecutionResult> {
    const startTime = performance.now();
    const results: TaskResult[] = [];
    const errors: TaskError[] = [];

    for await (const event of this.executeStream(dag)) {
      // Collect task results
      if (event.type === "task_complete") {
        results.push({
          taskId: event.taskId,
          status: "success",
          output: { executionTimeMs: event.executionTimeMs },
          executionTimeMs: event.executionTimeMs,
        });
      } else if (event.type === "task_error") {
        const taskError: TaskError = {
          taskId: event.taskId,
          error: event.error,
          status: "error",
        };
        errors.push(taskError);
        results.push({
          taskId: event.taskId,
          status: "error",
          error: event.error,
        });
      } else if (event.type === "task_warning") {
        // Safe-to-fail task - mark as failed_safe
        results.push({
          taskId: event.taskId,
          status: "failed_safe",
          error: event.error,
        });
      } else if (event.type === "decision_required") {
        // execute() is non-interactive - return error result instead of blocking
        // Use executeStream() for interactive approval flows
        const approvalError: TaskError = {
          taskId: "workflow",
          error: `Workflow requires approval: ${event.description}. ` +
            `Use executeStream() for interactive mode or enable per_layer_validation.`,
          status: "error",
        };
        errors.push(approvalError);

        // Return early with the error
        const totalTime = performance.now() - startTime;
        return {
          results,
          executionTimeMs: totalTime,
          parallelizationLayers: 0,
          errors,
          totalTasks: results.length,
          successfulTasks: results.filter(r => r.status === "success").length,
          failedTasks: results.filter(r => r.status === "error").length + 1, // +1 for approval error
        };
      }
    }

    const totalTime = performance.now() - startTime;
    const layers = this.topologicalSort(dag);

    return {
      results,
      executionTimeMs: totalTime,
      parallelizationLayers: layers.length,
      errors,
      totalTasks: dag.tasks.length,
      successfulTasks: results.filter((r) => r.status === "success").length,
      failedTasks: errors.length,
    };
  }

  async *resumeFromCheckpoint(
    dag: DAGStructure,
    checkpoint_id: string,
  ): AsyncGenerator<ExecutionEvent, WorkflowState, void> {
    const checkpoint = await loadCheckpoint(this.checkpointManager, checkpoint_id);
    if (!checkpoint) throw new Error(`Checkpoint ${checkpoint_id} not found`);

    const startTime = performance.now();
    this.state = checkpoint.state;
    const workflowId = checkpoint.workflowId;

    this.eventStream = new EventStream();
    this.commandQueue = new CommandQueue();

    let layers = this.topologicalSort(dag);
    const { completedCount } = calculateResumeProgress(checkpoint.layer, layers.length);
    const remainingLayers = layers.slice(completedCount);

    log.info(`Resuming workflow ${workflowId} from layer ${checkpoint.layer}`);

    const startEvent: ExecutionEvent = {
      type: "workflow_start",
      timestamp: Date.now(),
      workflowId,
      totalLayers: layers.length,
    };
    await this.eventStream.emit(startEvent);
    yield startEvent;

    const results = new Map<string, TaskResult>();
    for (const task of this.state!.tasks) results.set(task.taskId, task);

    let successfulTasks = this.state!.tasks.filter((t) => t.status === "success").length;
    let failedTasks = this.state!.tasks.filter((t) => t.status === "error").length;

    for (let i = 0; i < remainingLayers.length; i++) {
      const layer = remainingLayers[i];
      const actualLayerIdx = completedCount + i;

      const layerStartEvent: ExecutionEvent = {
        type: "layer_start",
        timestamp: Date.now(),
        workflowId,
        layerIndex: actualLayerIdx,
        tasksCount: layer.length,
      };
      await this.eventStream.emit(layerStartEvent);
      yield layerStartEvent;

      // Process control commands (same as executeStream)
      const commands = await this.commandQueue.processCommandsByType(["abort", "pause"]);
      for (const cmd of commands) {
        if (cmd.type === "abort") {
          throw new Error(`Workflow aborted by agent: ${cmd.reason}`);
        }
      }

      for (const task of layer) yield* this.emitTaskStart(workflowId, task);

      let layerResults = await Promise.allSettled(
        layer.map((task) => this.executeTask(task, results)),
      );

      // Handle deferred permission escalations (Deferred Escalation Pattern)
      // Phase 1: Prepare escalation events (non-blocking)
      const escalationPrep = this.prepareEscalations(workflowId, layer, layerResults);

      // Yield escalation events BEFORE waiting for responses
      for (const event of escalationPrep.events) {
        await this.eventStream.emit(event);
        yield event;
      }

      // Phase 2: Wait for responses and re-execute (only if there are escalations)
      if (escalationPrep.escalations.length > 0) {
        layerResults = await this.processEscalationResponses(
          layer,
          layerResults,
          results,
          escalationPrep.escalations,
        );
      }

      const { layerTaskResults, layerSuccess, layerFailed } = await this.collectLayerResults(
        workflowId,
        layer,
        layerResults,
        results,
      );

      for (const event of layerTaskResults.events) yield event;
      successfulTasks += layerSuccess;
      failedTasks += layerFailed;

      const stateUpdate: StateUpdate = { currentLayer: actualLayerIdx, tasks: layerTaskResults.tasks };
      this.state = updateState(this.state!, stateUpdate);

      const stateEvent: ExecutionEvent = {
        type: "state_updated",
        timestamp: Date.now(),
        workflowId,
        updates: { tasksAdded: layerTaskResults.tasks.length },
      };
      await this.eventStream.emit(stateEvent);
      yield stateEvent;

      const checkpointEvent = await this.saveCheckpoint(workflowId, actualLayerIdx);
      if (checkpointEvent) yield checkpointEvent;

      // AIL Decision Point (SECURITY: Must include on resume to prevent bypass)
      // Deferred Pattern: yield event BEFORE waiting for response
      const ailPrep = await this.prepareAILDecision(workflowId, actualLayerIdx, layerFailed > 0);
      if (ailPrep.event) yield ailPrep.event;
      if (ailPrep.needsResponse) {
        const ailResult = await this.waitForAILResponse(workflowId, dag);
        if (ailResult.newLayers) layers = ailResult.newLayers;
        if (ailResult.newDag) dag = ailResult.newDag;
      }

      // HIL Approval (SECURITY: Must include on resume to prevent bypass)
      // Note: Currently disabled - config.hil not passed, but code kept for future use
      const hilPrep = await this.prepareHILApproval(workflowId, actualLayerIdx, layer, layers);
      if (hilPrep.event) yield hilPrep.event;
      if (hilPrep.needsResponse) {
        await this.waitForHILResponse(workflowId, actualLayerIdx);
      }
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
    await this.eventStream.emit(completeEvent);
    yield completeEvent;

    // GraphRAG feedback (same as executeStream)
    this.updateGraphRAG(workflowId, dag, totalTime, failedTasks);

    await this.eventStream.close();
    return this.state!;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Task Execution
  // ═══════════════════════════════════════════════════════════════════════════

  protected override async executeTask(
    task: Task,
    previousResults: Map<string, TaskResult>,
  ): Promise<{ output: unknown; executionTimeMs: number }> {
    const taskType = getTaskType(task);
    const deps: CodeExecutorDeps = { capabilityStore: this.capabilityStore, graphRAG: this.graphRAG };

    if (taskType === "code_execution") {
      // Both safe-to-fail and regular tasks go through escalation handler
      // (executeWithRetry already skips retry for permission errors)
      try {
        if (isSafeToFail(task)) return await executeWithRetry(task, previousResults, deps);
        return await executeCodeTask(task, previousResults, deps);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (isPermissionError(errorMessage)) {
          this.handleCodeTaskPermissionEscalation(task, errorMessage);
        }
        throw error;
      }
    } else if (taskType === "capability") {
      return await this.executeCapabilityTaskWithEscalation(task, previousResults, deps);
    } else {
      return await super.executeTask(task, previousResults);
    }
  }

  private async executeCapabilityTaskWithEscalation(
    task: Task,
    previousResults: Map<string, TaskResult>,
    deps: CodeExecutorDeps,
  ): Promise<{ output: unknown; executionTimeMs: number }> {
    try {
      return await executeCapabilityTask(task, previousResults, deps);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (
        isPermissionError(errorMessage) &&
        this.permissionEscalationHandler &&
        this.capabilityStore &&
        task.capabilityId
      ) {
        const currentSet = await getCapabilityPermissionSet(this.capabilityStore, task.capabilityId);
        const executionId = `${this.state?.workflowId ?? "unknown"}-${task.id}`;
        const result = await this.permissionEscalationHandler.handlePermissionError(
          task.capabilityId,
          currentSet,
          errorMessage,
          executionId,
        );

        if (result.handled && result.approved) {
          log.info(`Permission escalation approved for ${task.capabilityId}, retrying`);
          return await this.executeCapabilityTaskWithEscalation(task, previousResults, deps);
        } else if (result.handled) {
          throw new Error(`Permission escalation rejected: ${result.feedback ?? result.error}`);
        }
      }
      throw error;
    }
  }

  /**
   * Handle permission escalation for code tasks using Deferred Escalation Pattern.
   *
   * Instead of blocking with waitForDecisionCommand (which causes deadlock inside
   * Promise.allSettled), we throw PermissionEscalationNeeded which is caught at
   * the layer boundary where the generator can properly yield.
   *
   * @throws PermissionEscalationNeeded if escalation is possible
   * @returns null if no escalation suggestion (error should be re-thrown by caller)
   */
  private handleCodeTaskPermissionEscalation(
    task: Task,
    errorMessage: string,
  ): null {
    const currentPermissionSet: PermissionSet =
      (task.sandboxConfig?.permissionSet as PermissionSet) ?? "minimal";
    log.info(`[HIL-DEBUG] Checking escalation for task ${task.id}, currentSet=${currentPermissionSet}`);
    const suggestion = suggestEscalation(errorMessage, task.id, currentPermissionSet);

    if (!suggestion) {
      log.info(`[HIL-DEBUG] No escalation suggestion for task ${task.id}`);
      return null;
    }
    log.info(`[HIL-DEBUG] Escalation suggested: ${currentPermissionSet} -> ${suggestion.requestedSet}`);

    // Throw instead of blocking - will be caught at layer boundary
    throw new PermissionEscalationNeeded(
      task.id,
      -1, // Index will be determined at layer boundary
      suggestion.currentSet,
      suggestion.requestedSet,
      suggestion.detectedOperation,
      errorMessage,
      "code",
    );
  }

  /**
   * Phase 1: Prepare escalation events without blocking.
   * Returns events to be yielded by the generator.
   *
   * Deferred Escalation Pattern: Separate event creation from blocking wait
   * so the generator can yield the events before waiting for responses.
   */
  private prepareEscalations(
    workflowId: string,
    layer: Task[],
    layerResults: PromiseSettledResult<{ output: unknown; executionTimeMs: number }>[],
  ): {
    escalations: { index: number; error: PermissionEscalationNeeded; event: ExecutionEvent }[];
    events: ExecutionEvent[];
  } {
    const escalations: { index: number; error: PermissionEscalationNeeded; event: ExecutionEvent }[] = [];
    const events: ExecutionEvent[] = [];

    for (let i = 0; i < layerResults.length; i++) {
      const result = layerResults[i];
      // Use name check instead of instanceof (ES modules in Deno can break instanceof)
      if (result.status === "rejected" && result.reason?.name === "PermissionEscalationNeeded") {
        const error = result.reason as PermissionEscalationNeeded;
        const task = layer[i];

        // Build helpful suggestion based on detected operation
        const suggestion = this.getPermissionSuggestion(error.detectedOperation);

        const escalationEvent: ExecutionEvent = {
          type: "decision_required",
          timestamp: Date.now(),
          workflowId,
          decisionType: "HIL",
          description: `[Task: ${task.id}] Permission denied: ${error.detectedOperation} access requires ${error.requestedSet}. ${suggestion}`,
          checkpointId: `perm-esc-${task.id}`,
          context: {
            taskId: task.id,
            currentSet: error.currentSet,
            requestedSet: error.requestedSet,
            detectedOperation: error.detectedOperation,
            originalError: error.originalError,
            suggestion,
          },
        };

        escalations.push({ index: i, error, event: escalationEvent });
        events.push(escalationEvent);
      }
    }

    if (escalations.length > 0) {
      log.info(`Found ${escalations.length} permission escalation(s) to handle at layer boundary`);
    }

    return { escalations, events };
  }

  /**
   * Get helpful suggestion for permission errors
   */
  private getPermissionSuggestion(detectedOperation: string): string {
    const suggestions: Record<string, string> = {
      net: "Use primitives:http_get or primitives:http_post for HTTP requests.",
      read: "Use filesystem:read_file for file access.",
      write: "Use filesystem:write_file for file writing.",
      env: "Environment variable access is restricted in sandbox mode.",
      run: "Subprocess execution is not allowed in sandbox mode.",
      ffi: "FFI calls are not allowed in sandbox mode.",
    };
    return suggestions[detectedOperation] ?? "Consider using an authorized MCP tool instead.";
  }

  /**
   * Phase 2: Wait for escalation responses and re-execute tasks.
   * Called AFTER the generator has yielded the escalation events.
   *
   * Deferred Escalation Pattern: Now we can safely block because
   * the MCP handler has received the events and can send approval.
   */
  private async processEscalationResponses(
    layer: Task[],
    layerResults: PromiseSettledResult<{ output: unknown; executionTimeMs: number }>[],
    previousResults: Map<string, TaskResult>,
    escalations: { index: number; error: PermissionEscalationNeeded; event: ExecutionEvent }[],
  ): Promise<PromiseSettledResult<{ output: unknown; executionTimeMs: number }>[]> {
    if (escalations.length === 0) {
      return layerResults;
    }

    const updatedResults = [...layerResults];

    for (const { index, error } of escalations) {
      const task = layer[index];

      log.info(`Waiting for HIL approval for task ${task.id} permission escalation`);

      const command = await waitForDecisionCommand(this.commandQueue, "HIL", this.getTimeout("hil"));

      if (!command) {
        log.warn(`Permission escalation timeout for task ${task.id}`);
        updatedResults[index] = {
          status: "rejected",
          reason: new Error(`Permission escalation timeout for task ${task.id}`),
        };
        continue;
      }

      if (
        (command.type === "permission_escalation_response" || command.type === "approval_response") &&
        command.approved
      ) {
        log.info(`Permission escalation approved for task ${task.id}, re-executing with ${error.requestedSet}`);

        try {
          const deps: CodeExecutorDeps = {
            capabilityStore: this.capabilityStore,
            graphRAG: this.graphRAG,
          };

          const updatedTask = {
            ...task,
            sandboxConfig: {
              ...task.sandboxConfig,
              permissionSet: error.requestedSet as PermissionSet,
            },
          };

          const result = await executeCodeTask(updatedTask, previousResults, deps, error.requestedSet as PermissionSet);
          updatedResults[index] = { status: "fulfilled", value: result };
          log.info(`Task ${task.id} re-execution successful after escalation`);
        } catch (retryError) {
          log.error(`Task ${task.id} re-execution failed after escalation: ${retryError}`);
          updatedResults[index] = {
            status: "rejected",
            reason: retryError,
          };
        }
      } else {
        log.info(`Permission escalation rejected for task ${task.id}`);
        updatedResults[index] = {
          status: "rejected",
          reason: new Error(`Permission escalation rejected for task ${task.id}: ${command.feedback ?? "User rejected"}`),
        };
      }
    }

    return updatedResults;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Helper Methods
  // ═══════════════════════════════════════════════════════════════════════════

  private getCaptureContext(): CaptureContext {
    return { state: this.state, episodicMemory: this.episodicMemory };
  }

  private async *emitTaskStart(workflowId: string, task: Task): AsyncGenerator<ExecutionEvent> {
    const event: ExecutionEvent = {
      type: "task_start",
      timestamp: Date.now(),
      workflowId,
      taskId: task.id,
      tool: task.tool,
    };
    await this.eventStream.emit(event);
    yield event;
  }

  private async collectLayerResults(
    workflowId: string,
    layer: Task[],
    layerResults: PromiseSettledResult<{ output: unknown; executionTimeMs: number }>[],
    results: Map<string, TaskResult>,
  ): Promise<{
    layerTaskResults: { tasks: TaskResult[]; events: ExecutionEvent[] };
    layerSuccess: number;
    layerFailed: number;
  }> {
    const tasks: TaskResult[] = [];
    const events: ExecutionEvent[] = [];
    let layerSuccess = 0;
    let layerFailed = 0;
    const ctx = this.getCaptureContext();

    for (let i = 0; i < layer.length; i++) {
      const task = layer[i];
      const result = layerResults[i];

      if (result.status === "fulfilled") {
        layerSuccess++;
        const taskResult: TaskResult = {
          taskId: task.id,
          status: "success",
          output: result.value.output,
          executionTimeMs: result.value.executionTimeMs,
        };
        results.set(task.id, taskResult);
        tasks.push(taskResult);

        // Generate result preview for AIL decision making
        const resultJson = JSON.stringify(result.value.output);
        const resultSize = new TextEncoder().encode(resultJson).length;
        const resultPreview = resultJson.length > 240
          ? resultJson.substring(0, 240) + "..."
          : resultJson;

        const completeEvent: ExecutionEvent = {
          type: "task_complete",
          timestamp: Date.now(),
          workflowId,
          taskId: task.id,
          executionTimeMs: result.value.executionTimeMs,
          result: result.value.output,
          resultPreview,
          resultSize,
        };
        await this.eventStream.emit(completeEvent);
        events.push(completeEvent);

        captureTaskComplete(ctx, workflowId, task.id, "success", result.value.output, result.value.executionTimeMs);
        this.speculationState = updateLastCompletedTool(this.speculationState, task.tool);
      } else {
        const errorMsg = result.reason?.message || String(result.reason);
        const isSafe = isSafeToFail(task);

        if (isSafe) {
          log.warn(`Safe-to-fail task ${task.id} failed (continuing): ${errorMsg}`);
          const taskResult: TaskResult = { taskId: task.id, status: "failed_safe" as const, output: null, error: errorMsg };
          results.set(task.id, taskResult);
          tasks.push(taskResult);

          const warningEvent: ExecutionEvent = {
            type: "task_warning",
            timestamp: Date.now(),
            workflowId,
            taskId: task.id,
            error: errorMsg,
            message: "Safe-to-fail task failed, workflow continues",
          };
          await this.eventStream.emit(warningEvent);
          events.push(warningEvent);
          captureTaskComplete(ctx, workflowId, task.id, "failed_safe", null, undefined, errorMsg);
        } else {
          layerFailed++;
          const taskResult: TaskResult = { taskId: task.id, status: "error", error: errorMsg };
          results.set(task.id, taskResult);
          tasks.push(taskResult);

          const errorEvent: ExecutionEvent = {
            type: "task_error",
            timestamp: Date.now(),
            workflowId,
            taskId: task.id,
            error: errorMsg,
          };
          await this.eventStream.emit(errorEvent);
          events.push(errorEvent);
          captureTaskComplete(ctx, workflowId, task.id, "error", null, undefined, errorMsg);
        }
      }
    }

    return { layerTaskResults: { tasks, events }, layerSuccess, layerFailed };
  }

  private async saveCheckpoint(workflowId: string, layerIdx: number): Promise<ExecutionEvent | null> {
    if (!this.checkpointManager || !this.state) return null;
    const checkpointId = await saveCheckpointAfterLayer(
      this.checkpointManager,
      workflowId,
      layerIdx,
      this.state,
    );
    // "" = no manager (already checked above)
    if (checkpointId === "") return null;

    // null = save failed - emit event with "failed-" prefix for observability
    const finalCheckpointId = checkpointId ?? `failed-${workflowId}-layer${layerIdx}`;

    const checkpointEvent: ExecutionEvent = {
      type: "checkpoint",
      timestamp: Date.now(),
      workflowId,
      checkpointId: finalCheckpointId,
      layerIndex: layerIdx,
    };
    await this.eventStream.emit(checkpointEvent);
    return checkpointEvent;
  }

  /**
   * Prepare AIL decision event (non-blocking).
   * Returns the event to yield; caller must then call waitForAILResponse.
   *
   * Deferred AIL Pattern: Separate event creation from blocking wait
   * so the generator can yield the event before waiting for response.
   */
  private async prepareAILDecision(
    workflowId: string,
    layerIdx: number,
    hasErrors: boolean,
  ): Promise<{ event: ExecutionEvent | null; needsResponse: boolean }> {
    if (!shouldTriggerAIL(this.config, layerIdx, hasErrors)) {
      return { event: null, needsResponse: false };
    }

    const ailEvent: ExecutionEvent = {
      type: "decision_required",
      timestamp: Date.now(),
      workflowId,
      decisionType: "AIL",
      description: `Layer ${layerIdx} completed. Agent decision required.`,
    };
    await this.eventStream.emit(ailEvent);

    return { event: ailEvent, needsResponse: true };
  }

  /**
   * Wait for AIL response after event has been yielded.
   * Returns new layers/dag if replan occurred, throws if aborted.
   */
  private async waitForAILResponse(
    workflowId: string,
    dag: DAGStructure,
  ): Promise<{ newLayers?: Task[][]; newDag?: DAGStructure }> {
    const ctx = this.getCaptureContext();
    const command = await waitForDecisionCommand(this.commandQueue, "AIL", this.getTimeout("ail"));

    if (!command || command.type === "continue") {
      captureAILDecision(ctx, workflowId, "continue", "Agent decision: continue", { reason: command?.reason || "default" });
      return {};
    }

    if (command.type === "abort") {
      captureAILDecision(ctx, workflowId, "abort", "Agent decision: abort", { reason: command.reason });
      throw new Error(`Workflow aborted by agent: ${command.reason}`);
    }

    if (command.type === "replan_dag" && this.dagSuggester) {
      if (this.replanCount >= MAX_REPLANS) {
        captureAILDecision(ctx, workflowId, "replan_rejected", "Rate limit reached", { max_replans: MAX_REPLANS });
        return {};
      }

      try {
        const augmentedDAG = await this.dagSuggester.replanDAG(dag, {
          completedTasks: this.state!.tasks,
          newRequirement: command.new_requirement ?? "",
          availableContext: (command.available_context ?? {}) as Record<string, unknown>,
        });

        if (augmentedDAG.tasks.length !== dag.tasks.length) {
          const newLayers = this.topologicalSort(augmentedDAG);
          this.replanCount++;
          captureAILDecision(ctx, workflowId, "replan_success", "DAG replanned", { replan_count: this.replanCount });
          return { newLayers, newDag: augmentedDAG };
        }
      } catch (error) {
        captureAILDecision(ctx, workflowId, "replan_failed", "Replan failed", { error: String(error) });
      }
    }

    return {};
  }

  /**
   * Prepare HIL approval event (non-blocking).
   * Returns the event to yield; caller must then call waitForHILResponse.
   *
   * Deferred HIL Pattern: Separate event creation from blocking wait
   * so the generator can yield the event before waiting for response.
   */
  private async prepareHILApproval(
    workflowId: string,
    layerIdx: number,
    layer: Task[],
    layers: Array<Array<{ id: string; tool: string; depends_on?: string[] }>>,
  ): Promise<{ event: ExecutionEvent | null; needsResponse: boolean }> {
    if (!shouldRequireApproval(this.config, layerIdx, layer)) {
      return { event: null, needsResponse: false };
    }

    const summary = generateHILSummary(this.state, layerIdx, layers);
    const hilEvent: ExecutionEvent = {
      type: "decision_required",
      timestamp: Date.now(),
      workflowId,
      decisionType: "HIL",
      description: summary,
    };
    await this.eventStream.emit(hilEvent);

    return { event: hilEvent, needsResponse: true };
  }

  /**
   * Wait for HIL response after event has been yielded.
   * Throws if timeout or rejected.
   */
  private async waitForHILResponse(workflowId: string, layerIdx: number): Promise<void> {
    const ctx = this.getCaptureContext();
    const command = await waitForDecisionCommand(this.commandQueue, "HIL", this.getTimeout("hil"));

    if (!command) {
      captureHILDecision(ctx, workflowId, false, `layer-${layerIdx}`, "timeout");
      throw new Error("Workflow aborted: HIL approval timeout");
    }

    if (command.type === "approval_response") {
      if (command.approved) {
        captureHILDecision(ctx, workflowId, true, `layer-${layerIdx}`, command.feedback);
      } else {
        captureHILDecision(ctx, workflowId, false, `layer-${layerIdx}`, command.feedback);
        throw new Error(`Workflow aborted by human: ${command.feedback || "no reason provided"}`);
      }
    }
  }

  private updateGraphRAG(workflowId: string, dag: DAGStructure, totalTime: number, failedTasks: number): void {
    if (!this.dagSuggester) return;

    try {
      const graphEngine = this.dagSuggester.getGraphEngine();
      graphEngine.updateFromExecution({
        executionId: workflowId,
        executedAt: new Date(),
        intentText: "workflow-execution",
        dagStructure: dag,
        success: failedTasks === 0,
        executionTimeMs: totalTime,
        errorMessage: failedTasks > 0 ? `${failedTasks} tasks failed` : undefined,
        userId: this.userId,
      }).catch((error) => log.error(`GraphRAG feedback loop failed: ${error}`));
    } catch (error) {
      log.error(`GraphRAG feedback loop failed: ${error}`);
    }
  }
}
