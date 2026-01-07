/**
 * DAG Decision Handler - Concrete Strategy implementation
 *
 * Implements IDecisionStrategy for DAG execution AIL/HIL decisions.
 *
 * @module dag/execution/dag-decision-handler
 */

import type {
  IDecisionStrategy,
  DecisionPreparation,
  AILResponseResult,
  DecisionEvent,
} from "../../infrastructure/patterns/strategy/mod.ts";
import type { Task, DAGStructure } from "../../graphrag/types.ts";
import type { ExecutorConfig } from "../types.ts";
import type { CommandQueue } from "../command-queue.ts";
import type { EventStream } from "../event-stream.ts";
import type { WorkflowState } from "../state.ts";
import type { EpisodicMemoryStore } from "../../learning/episodic-memory-store.ts";
import type { DAGSuggester } from "../../graphrag/dag-suggester.ts";
import { shouldTriggerAIL, MAX_REPLANS } from "../loops/ail-handler.ts";
import { shouldRequireApproval, generateHILSummary } from "../loops/hil-handler.ts";
import { waitForDecisionCommand } from "../loops/decision-waiter.ts";
import { captureAILDecision, captureHILDecision } from "../episodic/capture.ts";
import * as log from "@std/log";

/**
 * Context required for decision handling
 */
export interface DecisionContext {
  workflowId: string;
  state: WorkflowState;
  layers: Task[][];
  dag: DAGStructure;
  config: ExecutorConfig;
  eventStream: EventStream;
  commandQueue: CommandQueue;
  episodicMemory: EpisodicMemoryStore | null;
  dagSuggester: DAGSuggester | null;
  replanCount: number;
  timeouts: {
    hil: number;
    ail: number;
  };
}

/**
 * DAG Decision Handler - Implements strategy for AIL/HIL decisions
 *
 * Uses DecisionEvent (from strategy pattern) which is structurally identical
 * to the decision_required variant of ExecutionEvent, enabling safe casting
 * when emitting to EventStream.
 */
export class DAGDecisionHandler
  implements IDecisionStrategy<DecisionContext, DecisionEvent, Task[][]> {
  /**
   * Prepare AIL decision event (non-blocking)
   */
  async prepareAILDecision(
    ctx: DecisionContext,
    layerIdx: number,
    hasErrors: boolean,
  ): Promise<DecisionPreparation<DecisionEvent>> {
    if (!shouldTriggerAIL(ctx.config, layerIdx, hasErrors)) {
      return { event: null, needsResponse: false };
    }

    log.debug(`Preparing AIL decision for layer ${layerIdx}`);

    const ailEvent: DecisionEvent = {
      type: "decision_required",
      timestamp: Date.now(),
      workflowId: ctx.workflowId,
      decisionType: "AIL",
      description: `Layer ${layerIdx} completed. Agent decision required.`,
    };
    // DecisionEvent is part of ExecutionEvent union (no cast needed)
    await ctx.eventStream.emit(ailEvent);

    return { event: ailEvent, needsResponse: true };
  }

  /**
   * Wait for AIL response and process replan if requested
   */
  async waitForAILResponse(
    ctx: DecisionContext,
    topologicalSort: (dag: DAGStructure) => Task[][],
  ): Promise<AILResponseResult<Task[][]>> {
    const captureCtx = {
      state: ctx.state,
      episodicMemory: ctx.episodicMemory,
    };

    const command = await waitForDecisionCommand(
      ctx.commandQueue,
      "AIL",
      ctx.timeouts.ail,
    );

    if (!command || command.type === "continue") {
      captureAILDecision(captureCtx, ctx.workflowId, "continue", "Agent decision: continue", {
        reason: command?.reason || "default",
      });
      return {};
    }

    if (command.type === "abort") {
      log.info(`AIL abort decision for workflow ${ctx.workflowId}: ${command.reason}`);
      captureAILDecision(captureCtx, ctx.workflowId, "abort", "Agent decision: abort", {
        reason: command.reason,
      });
      throw new Error(`Workflow aborted by agent: ${command.reason}`);
    }

    if (command.type === "replan_dag" && ctx.dagSuggester) {
      if (ctx.replanCount >= MAX_REPLANS) {
        captureAILDecision(captureCtx, ctx.workflowId, "replan_rejected", "Rate limit reached", {
          max_replans: MAX_REPLANS,
        });
        return {};
      }

      try {
        const augmentedDAG = await ctx.dagSuggester.replanDAG(ctx.dag, {
          completedTasks: ctx.state.tasks,
          newRequirement: command.new_requirement ?? "",
          availableContext: (command.available_context ?? {}) as Record<string, unknown>,
        });

        if (augmentedDAG.tasks.length !== ctx.dag.tasks.length) {
          const newLayers = topologicalSort(augmentedDAG);
          log.info(`DAG replanned: ${ctx.dag.tasks.length} → ${augmentedDAG.tasks.length} tasks`);
          captureAILDecision(captureCtx, ctx.workflowId, "replan_success", "DAG replanned", {
            replan_count: ctx.replanCount + 1,
          });
          return { newLayers, newDag: augmentedDAG };
        }
      } catch (error) {
        captureAILDecision(captureCtx, ctx.workflowId, "replan_failed", "Replan failed", {
          error: String(error),
        });
      }
    }

    return {};
  }

  /**
   * Prepare HIL approval event (non-blocking)
   */
  async prepareHILApproval(
    ctx: DecisionContext,
    layerIdx: number,
    layer: Task[],
  ): Promise<DecisionPreparation<DecisionEvent>> {
    if (!shouldRequireApproval(ctx.config, layerIdx, layer)) {
      return { event: null, needsResponse: false };
    }

    const summary = generateHILSummary(ctx.state, layerIdx, ctx.layers);
    const hilEvent: DecisionEvent = {
      type: "decision_required",
      timestamp: Date.now(),
      workflowId: ctx.workflowId,
      decisionType: "HIL",
      description: summary,
    };
    // DecisionEvent is part of ExecutionEvent union (no cast needed)
    await ctx.eventStream.emit(hilEvent);

    return { event: hilEvent, needsResponse: true };
  }

  /**
   * Wait for HIL response (throws on timeout or rejection)
   */
  async waitForHILResponse(
    ctx: DecisionContext,
    layerIdx: number,
  ): Promise<void> {
    const captureCtx = {
      state: ctx.state,
      episodicMemory: ctx.episodicMemory,
    };

    const command = await waitForDecisionCommand(
      ctx.commandQueue,
      "HIL",
      ctx.timeouts.hil,
    );

    if (!command) {
      captureHILDecision(captureCtx, ctx.workflowId, false, `layer-${layerIdx}`, "timeout");
      throw new Error("Workflow aborted: HIL approval timeout");
    }

    if (command.type === "approval_response") {
      if (command.approved) {
        captureHILDecision(captureCtx, ctx.workflowId, true, `layer-${layerIdx}`, command.feedback);
      } else {
        captureHILDecision(captureCtx, ctx.workflowId, false, `layer-${layerIdx}`, command.feedback);
        throw new Error(`Workflow aborted by human: ${command.feedback || "no reason provided"}`);
      }
    }
  }
}

// Singleton instance
export const dagDecisionHandler = new DAGDecisionHandler();
