/**
 * ControlledExecutor - DAG Executor Facade with Adaptive Feedback Loops
 *
 * Thin facade that coordinates:
 * - DAGStreamOrchestrator for stream execution
 * - Configuration management
 * - Speculation and learning
 *
 * @module dag/controlled-executor
 */

import { ParallelExecutor } from "./executor.ts";
import type { DAGStructure, Task } from "../graphrag/types.ts";
import {
  type DAGExecutionResult,
  type ExecutionEvent,
  type ExecutorConfig,
  PermissionEscalationNeeded,
  type TaskError,
  type TaskResult,
  type ToolExecutor,
} from "./types.ts";
import { EventStream, type EventStreamStats } from "./event-stream.ts";
import { CommandQueue, type CommandQueueStats } from "./command-queue.ts";
import { getStateSnapshot, type StateUpdate, updateState, type WorkflowState } from "./state.ts";
import { CheckpointManager } from "./checkpoint-manager.ts";
import type { DbClient } from "../db/types.ts";
import { getLogger } from "../telemetry/logger.ts";
import type { DAGSuggester } from "../graphrag/dag-suggester.ts";
import type { EpisodicMemoryStore } from "../learning/episodic-memory-store.ts";
import type { SpeculationCache, SpeculationConfig, SpeculationMetrics } from "../graphrag/types.ts";
import type { PermissionEscalationRequest, PermissionSet } from "../capabilities/types.ts";
import type { PermissionAuditStore } from "../capabilities/permission-audit-store.ts";
import { formatEscalationRequest, PermissionEscalationHandler } from "../capabilities/permission-escalation-handler.ts";
import { suggestEscalation } from "../capabilities/permission-escalation.ts";
import type { CapabilityStore } from "../capabilities/capability-store.ts";
import type { GraphRAGEngine } from "../graphrag/graph-engine.ts";
import type { Command } from "./types.ts";

// Episodic and speculation
import { type CaptureContext, captureHILDecision, captureSpeculationStart } from "./episodic/capture.ts";
import { waitForDecisionCommand } from "./loops/decision-waiter.ts";
import {
  checkSpeculativeCache,
  consumeSpeculation as consumeSpeculationFromState,
  createSpeculationState,
  disableSpeculation as disableSpeculationState,
  enableSpeculation as enableSpeculationState,
  getSpeculationMetrics as getSpeculationMetricsFromState,
  type SpeculationState,
} from "./speculation/integration.ts";

// Task execution
import { getTaskType, type CodeExecutorDeps } from "./execution/index.ts";
import { executeCapabilityTask, getCapabilityPermissionSet } from "./execution/capability-executor.ts";
import { isPermissionError } from "./permissions/escalation-integration.ts";
import { executeCodeTask as executeCodeTaskViaWorkerBridgeModule } from "./execution/code-task-executor.ts";

// Orchestrator (Facade target)
import { DAGStreamOrchestrator, type OrchestratorDeps } from "./execution/dag-stream-orchestrator.ts";

const log = getLogger("controlled-executor");

// Re-export for backward compatibility
export { RESULT_PREVIEW_MAX_LENGTH } from "./execution/layer-results.ts";

/**
 * ControlledExecutor - Facade for DAG execution with adaptive feedback loops
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
  private episodicMemory: EpisodicMemoryStore | null = null;
  private speculationState: SpeculationState;
  private userId: string = "local";
  private capabilityStore?: CapabilityStore;
  private graphRAG?: GraphRAGEngine;
  private permissionEscalationHandler: PermissionEscalationHandler | null = null;
  private _permissionAuditStore: PermissionAuditStore | null = null;
  private workerBridge: import("../sandbox/worker-bridge.ts").WorkerBridge | null = null;
  private toolDefinitions: import("../sandbox/types.ts").ToolDefinition[] = [];
  private executionArgs: Record<string, unknown> = {};
  private orchestrator = new DAGStreamOrchestrator();

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

  setCheckpointManager(db: DbClient, autoPrune: boolean = true): void {
    this.checkpointManager = new CheckpointManager(db, autoPrune);
  }

  setDAGSuggester(dagSuggester: DAGSuggester): void {
    this.dagSuggester = dagSuggester;
  }

  setLearningDependencies(capabilityStore?: CapabilityStore, graphRAG?: GraphRAGEngine): void {
    this.capabilityStore = capabilityStore;
    this.graphRAG = graphRAG;
    log.debug("Learning dependencies set", { hasCapabilityStore: !!capabilityStore, hasGraphRAG: !!graphRAG });
  }

  setWorkerBridge(workerBridge: import("../sandbox/worker-bridge.ts").WorkerBridge): void {
    this.workerBridge = workerBridge;
    log.debug("WorkerBridge set for code execution tracing");
  }

  setToolDefinitions(toolDefs: import("../sandbox/types.ts").ToolDefinition[]): void {
    this.toolDefinitions = toolDefs;
    log.debug("Tool definitions set for loop execution", { toolCount: toolDefs.length });
  }

  setExecutionArgs(args: Record<string, unknown>): void {
    this.executionArgs = args;
    log.debug("Execution args set for parameterized capability", { argsKeys: Object.keys(args) });
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

  captureSpeculationStart(workflowId: string, toolId: string, confidence: number, reasoning: string): string | null {
    if (!this.episodicMemory) return null;
    const eventId = crypto.randomUUID();
    captureSpeculationStart(this.getCaptureContext(), workflowId, toolId, confidence, reasoning);
    return eventId;
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

  async requestPermissionEscalation(request: PermissionEscalationRequest): Promise<{ approved: boolean; feedback?: string }> {
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

      captureHILDecision(
        this.getCaptureContext(),
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

  private static readonly DEFAULT_TIMEOUTS = { hil: 300000, ail: 60000, pollInterval: 100 };

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
  // Core Execution (Delegates to Orchestrator)
  // ═══════════════════════════════════════════════════════════════════════════

  async *executeStream(dag: DAGStructure, workflow_id?: string): AsyncGenerator<ExecutionEvent, WorkflowState, void> {
    // Reset event stream for new execution (keep command queue to preserve enqueued commands)
    this.eventStream = new EventStream();

    const deps = this.buildOrchestratorDeps();
    const generator = this.orchestrator.executeStream(dag, deps, workflow_id);

    // Use explicit iteration to capture return value
    let result = await generator.next();
    while (!result.done) {
      yield result.value;
      result = await generator.next();
    }

    // Capture final state from generator return value
    if (result.value) {
      this.state = result.value;
    }
    return this.state!;
  }

  override async execute(dag: DAGStructure): Promise<DAGExecutionResult> {
    const startTime = performance.now();
    const results: TaskResult[] = [];
    const errors: TaskError[] = [];

    for await (const event of this.executeStream(dag)) {
      if (event.type === "task_complete") {
        results.push({
          taskId: event.taskId,
          status: "success",
          output: { executionTimeMs: event.executionTimeMs, result: event.result },
          executionTimeMs: event.executionTimeMs,
          layerIndex: event.layerIndex,
        });
      } else if (event.type === "task_error") {
        errors.push({ taskId: event.taskId, error: event.error, status: "error" });
        results.push({ taskId: event.taskId, status: "error", error: event.error, layerIndex: event.layerIndex });
      } else if (event.type === "task_warning") {
        results.push({ taskId: event.taskId, status: "failed_safe", error: event.error, layerIndex: event.layerIndex });
      } else if (event.type === "decision_required") {
        const approvalError: TaskError = {
          taskId: "workflow",
          error: `Workflow requires approval: ${event.description}. Use executeStream() for interactive mode.`,
          status: "error",
        };
        errors.push(approvalError);

        const totalTime = performance.now() - startTime;
        return {
          results,
          executionTimeMs: totalTime,
          parallelizationLayers: 0,
          errors,
          totalTasks: results.length,
          successfulTasks: results.filter((r) => r.status === "success").length,
          failedTasks: results.filter((r) => r.status === "error").length + 1,
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

  async *resumeFromCheckpoint(dag: DAGStructure, checkpoint_id: string): AsyncGenerator<ExecutionEvent, WorkflowState, void> {
    // Reset event stream for new execution (keep command queue)
    this.eventStream = new EventStream();

    const deps = this.buildOrchestratorDeps();
    const generator = this.orchestrator.resumeFromCheckpoint(dag, checkpoint_id, deps);

    // Use explicit iteration to capture return value
    let result = await generator.next();
    while (!result.done) {
      yield result.value;
      result = await generator.next();
    }

    // Capture final state from generator return value
    if (result.value) {
      this.state = result.value;
    }
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
      if (!this.workerBridge) {
        throw new Error(`WorkerBridge required for code_execution task ${task.id}.`);
      }
      if (!task.tool) {
        throw new Error(`Code execution task ${task.id} missing required 'tool' field`);
      }
      try {
        return await this.executeCodeTaskViaWorkerBridge(task, previousResults);
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

  private executeCodeTaskViaWorkerBridge(
    task: Task,
    previousResults: Map<string, TaskResult>,
  ): Promise<{ output: unknown; executionTimeMs: number }> {
    return executeCodeTaskViaWorkerBridgeModule(task, previousResults, {
      workerBridge: this.workerBridge!,
      toolDefinitions: this.toolDefinitions,
      executionArgs: this.executionArgs,
    });
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
      if (isPermissionError(errorMessage) && this.permissionEscalationHandler && this.capabilityStore && task.capabilityId) {
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

  private handleCodeTaskPermissionEscalation(task: Task, errorMessage: string): null {
    const currentPermissionSet: PermissionSet = (task.sandboxConfig?.permissionSet as PermissionSet) ?? "minimal";
    const suggestion = suggestEscalation(errorMessage, task.id, currentPermissionSet);
    if (!suggestion) return null;

    throw new PermissionEscalationNeeded(
      task.id,
      -1,
      suggestion.currentSet,
      suggestion.requestedSet,
      suggestion.detectedOperation,
      errorMessage,
      "code",
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Helper Methods
  // ═══════════════════════════════════════════════════════════════════════════

  private getCaptureContext(): CaptureContext {
    return { state: this.state, episodicMemory: this.episodicMemory };
  }

  private buildOrchestratorDeps(): OrchestratorDeps {
    return {
      eventStream: this.eventStream,
      commandQueue: this.commandQueue,
      checkpointManager: this.checkpointManager,
      episodicMemory: this.episodicMemory,
      dagSuggester: this.dagSuggester,
      workerBridge: this.workerBridge,
      toolDefinitions: this.toolDefinitions,
      executionArgs: this.executionArgs,
      config: this.config,
      userId: this.userId,
      speculationState: this.speculationState,
      topologicalSort: this.topologicalSort.bind(this),
      executeTask: this.executeTask.bind(this),
      updateGraphRAG: this.updateGraphRAG.bind(this),
    };
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
