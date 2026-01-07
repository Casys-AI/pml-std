/**
 * DAG Layer Executor - Concrete Template Method implementation
 *
 * Extends LayerExecutionTemplate with DAG-specific behavior.
 *
 * @module dag/execution/dag-layer-executor
 */

import { LayerExecutionTemplate } from "../../infrastructure/patterns/template-method/mod.ts";
import type { Task, DAGStructure } from "../../graphrag/types.ts";
import type { TaskResult, ExecutionEvent } from "../types.ts";
import type { WorkflowState } from "../state.ts";
import type { EventStream } from "../event-stream.ts";
import type { CommandQueue } from "../command-queue.ts";
import type { CheckpointManager } from "../checkpoint-manager.ts";
import type { EpisodicMemoryStore } from "../../learning/episodic-memory-store.ts";
import type { WorkerBridge } from "../../sandbox/worker-bridge.ts";
import type { ToolDefinition } from "../../sandbox/types.ts";
import type { SpeculationState } from "../speculation/integration.ts";
import type { IDecisionStrategy } from "../../infrastructure/patterns/strategy/mod.ts";
import { prepareEscalations, processEscalationResponses } from "../permissions/layer-escalation.ts";
import { collectLayerResults } from "./layer-results.ts";
import { saveCheckpointAfterLayer } from "../checkpoints/integration.ts";
import * as log from "@std/log";

/**
 * Execution context for DAG layer execution
 */
export interface DAGExecutionContext {
  workflowId: string;
  state: WorkflowState;
  speculationState: SpeculationState;
  results: Map<string, TaskResult>;
  eventStream: EventStream;
  commandQueue: CommandQueue;
  checkpointManager: CheckpointManager | null;
  episodicMemory: EpisodicMemoryStore | null;
  workerBridge: WorkerBridge | null;
  toolDefinitions: ToolDefinition[];
  executionArgs: Record<string, unknown>;
  config: import("../types.ts").ExecutorConfig;
}

/**
 * Task execution function signature
 */
export type TaskExecutorFn = (
  task: Task,
  results: Map<string, TaskResult>,
) => Promise<{ output: unknown; executionTimeMs: number }>;

/**
 * DAG Layer Executor - Concrete implementation of LayerExecutionTemplate
 */
export class DAGLayerExecutor extends LayerExecutionTemplate<
  DAGExecutionContext,
  Task,
  { output: unknown; executionTimeMs: number },
  ExecutionEvent
> {
  private taskExecutor: TaskExecutorFn;
  private decisionHandler: IDecisionStrategy<DAGExecutionContext, ExecutionEvent, Task[][]>;
  private topologicalSort: (dag: DAGStructure) => Task[][];

  constructor(
    taskExecutor: TaskExecutorFn,
    decisionHandler: IDecisionStrategy<DAGExecutionContext, ExecutionEvent, Task[][]>,
    topologicalSort: (dag: DAGStructure) => Task[][],
  ) {
    super();
    this.taskExecutor = taskExecutor;
    this.decisionHandler = decisionHandler;
    this.topologicalSort = topologicalSort;
  }

  protected async onLayerStart(
    ctx: DAGExecutionContext,
    layer: Task[],
    layerIdx: number,
  ): Promise<ExecutionEvent> {
    const event: ExecutionEvent = {
      type: "layer_start",
      timestamp: Date.now(),
      workflowId: ctx.workflowId,
      layerIndex: layerIdx,
      tasksCount: layer.length,
    };
    await ctx.eventStream.emit(event);
    return event;
  }

  protected async onPreExecutionCheck(ctx: DAGExecutionContext): Promise<void> {
    const commands = await ctx.commandQueue.processCommandsByType(["abort", "pause"]);
    for (const cmd of commands) {
      if (cmd.type === "abort") {
        throw new Error(`Workflow aborted by agent: ${cmd.reason}`);
      }
    }
  }

  protected async filterTasks(_ctx: DAGExecutionContext, layer: Task[]): Promise<Task[]> {
    const executable = layer.filter((task) => task.metadata?.executable !== false);
    if (executable.length < layer.length) {
      log.debug("Skipping non-executable nested tasks", {
        total: layer.length,
        executable: executable.length,
      });
    }
    return executable;
  }

  protected async onTaskStart(ctx: DAGExecutionContext, task: Task): Promise<ExecutionEvent> {
    const event: ExecutionEvent = {
      type: "task_start",
      timestamp: Date.now(),
      workflowId: ctx.workflowId,
      taskId: task.id,
      tool: task.tool,
    };
    await ctx.eventStream.emit(event);
    return event;
  }

  protected async executeTasks(
    ctx: DAGExecutionContext,
    tasks: Task[],
  ): Promise<PromiseSettledResult<{ output: unknown; executionTimeMs: number }>[]> {
    return Promise.allSettled(
      tasks.map((task) => this.taskExecutor(task, ctx.results)),
    );
  }

  protected async handleEscalations(
    ctx: DAGExecutionContext,
    tasks: Task[],
    results: PromiseSettledResult<{ output: unknown; executionTimeMs: number }>[],
  ): Promise<ExecutionEvent[]> {
    const events: ExecutionEvent[] = [];

    // Phase 1: Prepare escalation events
    const escalationPrep = prepareEscalations(ctx.workflowId, tasks, results);

    // Emit and collect events
    for (const event of escalationPrep.events) {
      await ctx.eventStream.emit(event);
      events.push(event);
    }

    // Phase 2: Process responses if any
    if (escalationPrep.escalations.length > 0) {
      await processEscalationResponses(
        tasks,
        results,
        ctx.results,
        escalationPrep.escalations,
        ctx.commandQueue,
        300000, // HIL timeout (5 minutes)
        {
          workerBridge: ctx.workerBridge!,
          toolDefinitions: ctx.toolDefinitions,
          executionArgs: ctx.executionArgs,
        },
      );
    }

    return events;
  }

  protected async collectResults(
    ctx: DAGExecutionContext,
    tasks: Task[],
    results: PromiseSettledResult<{ output: unknown; executionTimeMs: number }>[],
    layerIdx: number,
  ): Promise<{ resultEvents: ExecutionEvent[]; successCount: number; failedCount: number }> {
    const collectionResult = await collectLayerResults(
      ctx.workflowId,
      tasks,
      results,
      ctx.results,
      layerIdx,
      {
        eventStream: ctx.eventStream,
        captureContext: {
          state: ctx.state,
          episodicMemory: ctx.episodicMemory,
        },
        speculationState: ctx.speculationState,
      },
    );

    // Update speculation state
    ctx.speculationState = collectionResult.updatedSpeculationState;

    return {
      resultEvents: collectionResult.layerTaskResults.events,
      successCount: collectionResult.layerSuccess,
      failedCount: collectionResult.layerFailed,
    };
  }

  protected async onStateUpdate(
    ctx: DAGExecutionContext,
    layerIdx: number,
  ): Promise<ExecutionEvent> {
    log.debug(`Layer ${layerIdx} state update for workflow ${ctx.workflowId}`);

    const event: ExecutionEvent = {
      type: "state_updated",
      timestamp: Date.now(),
      workflowId: ctx.workflowId,
      updates: { tasksAdded: 0 }, // Layer completion marker
    };
    await ctx.eventStream.emit(event);
    return event;
  }

  protected async onCheckpoint(
    ctx: DAGExecutionContext,
    layerIdx: number,
  ): Promise<ExecutionEvent | null> {
    if (!ctx.checkpointManager) return null;

    const checkpointId = await saveCheckpointAfterLayer(
      ctx.checkpointManager,
      ctx.workflowId,
      layerIdx,
      ctx.state,
    );

    if (!checkpointId) return null;

    const event: ExecutionEvent = {
      type: "checkpoint",
      timestamp: Date.now(),
      workflowId: ctx.workflowId,
      checkpointId,
      layerIndex: layerIdx,
    };
    await ctx.eventStream.emit(event);
    return event;
  }

  protected async handleDecisions(
    ctx: DAGExecutionContext,
    layer: Task[],
    layerIdx: number,
    hasErrors: boolean,
  ): Promise<ExecutionEvent[]> {
    const events: ExecutionEvent[] = [];

    // AIL decision
    const ailPrep = await this.decisionHandler.prepareAILDecision(ctx, layerIdx, hasErrors);
    if (ailPrep.event) {
      events.push(ailPrep.event);
    }
    if (ailPrep.needsResponse) {
      await this.decisionHandler.waitForAILResponse(ctx, this.topologicalSort);
    }

    // HIL approval
    const hilPrep = await this.decisionHandler.prepareHILApproval(ctx, layerIdx, layer);
    if (hilPrep.event) {
      events.push(hilPrep.event);
    }
    if (hilPrep.needsResponse) {
      await this.decisionHandler.waitForHILResponse(ctx, layerIdx);
    }

    return events;
  }
}
