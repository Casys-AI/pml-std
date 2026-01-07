/**
 * Decision Strategy Adapter
 *
 * Adapts DAGDecisionHandler to the IDecisionStrategy interface for DI.
 *
 * @module infrastructure/di/adapters/decision-strategy-adapter
 */

import { DAGDecisionHandler, type DecisionContext } from "../../../dag/execution/dag-decision-handler.ts";
import type { Task } from "../../../graphrag/types.ts";
import type { DecisionPreparation, AILResponseResult, DecisionEvent } from "../../patterns/strategy/mod.ts";
import { DecisionStrategy } from "../container.ts";

/**
 * Adapter implementing DecisionStrategy token
 */
export class DecisionStrategyAdapter extends DecisionStrategy {
  private readonly handler: DAGDecisionHandler;

  constructor() {
    super();
    this.handler = new DAGDecisionHandler();
  }

  prepareAILDecision(
    ctx: unknown,
    layerIdx: number,
    hasErrors: boolean,
  ): Promise<DecisionPreparation<DecisionEvent>> {
    return this.handler.prepareAILDecision(ctx as DecisionContext, layerIdx, hasErrors);
  }

  waitForAILResponse(
    ctx: unknown,
    topologicalSort: (dag: unknown) => unknown[],
  ): Promise<AILResponseResult> {
    return this.handler.waitForAILResponse(
      ctx as DecisionContext,
      topologicalSort as (dag: unknown) => Task[][],
    );
  }

  prepareHILApproval(
    ctx: unknown,
    layerIdx: number,
    layer: unknown[],
  ): Promise<DecisionPreparation<DecisionEvent>> {
    return this.handler.prepareHILApproval(ctx as DecisionContext, layerIdx, layer as Task[]);
  }

  waitForHILResponse(ctx: unknown, layerIdx: number): Promise<void> {
    return this.handler.waitForHILResponse(ctx as DecisionContext, layerIdx);
  }
}

/**
 * Factory function for DI registration
 */
export function createDecisionStrategy(): DecisionStrategy {
  return new DecisionStrategyAdapter();
}
