/**
 * Decision Strategy - Abstract strategy interface for decision handling
 *
 * Defines the contract for AIL/HIL decision handlers.
 * Concrete implementations can be DAG-specific or custom.
 *
 * @module infrastructure/patterns/strategy/decision-strategy
 */

/**
 * Decision event with metadata
 *
 * Compatible with IExecutionEvent (has index signature for template method pattern)
 */
export interface DecisionEvent {
  type: "decision_required";
  timestamp: number;
  workflowId: string;
  decisionType: "AIL" | "HIL";
  description: string;
  checkpointId?: string;
  context?: Record<string, unknown>;
  /** Index signature for IExecutionEvent compatibility */
  [key: string]: unknown;
}

/**
 * Result of decision preparation (non-blocking phase)
 */
export interface DecisionPreparation<E = DecisionEvent> {
  event: E | null;
  needsResponse: boolean;
}

/**
 * Result of AIL response processing
 */
export interface AILResponseResult<T = unknown[]> {
  newLayers?: T;
  newDag?: unknown;
}

/**
 * Abstract decision strategy interface (Strategy Pattern)
 *
 * Separates the algorithm for handling decisions from the executor.
 * Allows different decision strategies (AIL, HIL, Auto, Custom).
 *
 * @typeParam TContext - Execution context type
 * @typeParam TEvent - Event type
 * @typeParam TLayers - Layers type
 */
export interface IDecisionStrategy<TContext, TEvent = DecisionEvent, TLayers = unknown[]> {
  /**
   * Prepare AIL decision event (non-blocking)
   */
  prepareAILDecision(
    ctx: TContext,
    layerIdx: number,
    hasErrors: boolean,
  ): Promise<DecisionPreparation<TEvent>>;

  /**
   * Wait for AIL response and process (blocking)
   * @param ctx - Execution context
   * @param topologicalSort - Function to sort DAG into layers (implementation defines dag type)
   */
  waitForAILResponse(
    ctx: TContext,
    // deno-lint-ignore no-explicit-any
    topologicalSort: (dag: any) => TLayers,
  ): Promise<AILResponseResult<TLayers>>;

  /**
   * Prepare HIL approval event (non-blocking)
   */
  prepareHILApproval(
    ctx: TContext,
    layerIdx: number,
    layer: unknown[],
  ): Promise<DecisionPreparation<TEvent>>;

  /**
   * Wait for HIL response (blocking, throws on rejection)
   */
  waitForHILResponse(
    ctx: TContext,
    layerIdx: number,
  ): Promise<void>;
}

/**
 * No-op strategy for testing or auto-approve mode
 */
export class NullDecisionStrategy<TContext> implements IDecisionStrategy<TContext> {
  async prepareAILDecision(): Promise<DecisionPreparation> {
    return { event: null, needsResponse: false };
  }

  async waitForAILResponse(): Promise<AILResponseResult> {
    return {};
  }

  async prepareHILApproval(): Promise<DecisionPreparation> {
    return { event: null, needsResponse: false };
  }

  async waitForHILResponse(): Promise<void> {
    // No-op
  }
}
