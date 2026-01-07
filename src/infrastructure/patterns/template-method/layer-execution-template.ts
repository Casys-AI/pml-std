/**
 * Layer Execution Template - Template Method pattern
 *
 * Defines the skeleton of layer execution algorithm.
 * Subclasses/implementations provide concrete steps.
 *
 * Template Method Pattern:
 * - Defines algorithm skeleton in base class
 * - Defers some steps to subclasses
 * - Lets subclasses redefine steps without changing structure
 *
 * @module infrastructure/patterns/template-method/layer-execution-template
 */

/**
 * Generic execution event interface
 */
export interface IExecutionEvent {
  type: string;
  timestamp: number;
  workflowId: string;
  [key: string]: unknown;
}

/**
 * Layer execution result
 */
export interface LayerExecutionResult<TEvent = IExecutionEvent> {
  events: TEvent[];
  successCount: number;
  failedCount: number;
  metadata?: Record<string, unknown>;
}

/**
 * Abstract Layer Execution Template
 *
 * Implements Template Method pattern for executing a layer of tasks.
 * Concrete implementations provide specific behavior for each step.
 *
 * @typeParam TContext - Execution context type
 * @typeParam TTask - Task type
 * @typeParam TResult - Task result type
 * @typeParam TEvent - Event type
 */
export abstract class LayerExecutionTemplate<
  TContext,
  TTask,
  TResult,
  TEvent extends IExecutionEvent = IExecutionEvent,
> {
  /**
   * Template method - executes a layer following the defined algorithm
   *
   * This is the invariant part of the algorithm.
   * Hook methods are called at each step.
   */
  async *execute(
    ctx: TContext,
    layer: TTask[],
    layerIdx: number,
  ): AsyncGenerator<TEvent, LayerExecutionResult<TEvent>, void> {
    const events: TEvent[] = [];

    // Step 1: Layer start
    const startEvent = await this.onLayerStart(ctx, layer, layerIdx);
    if (startEvent) {
      yield startEvent;
      events.push(startEvent);
    }

    // Step 2: Pre-execution check (abort, pause, etc.)
    await this.onPreExecutionCheck(ctx);

    // Step 3: Filter tasks
    const executableTasks = await this.filterTasks(ctx, layer);

    // Step 4: Emit task start events
    for (const task of executableTasks) {
      const taskStartEvent = await this.onTaskStart(ctx, task);
      if (taskStartEvent) {
        yield taskStartEvent;
        events.push(taskStartEvent);
      }
    }

    // Step 5: Execute tasks
    const taskResults = await this.executeTasks(ctx, executableTasks);

    // Step 6: Handle escalations (permission errors, etc.)
    const escalationEvents = await this.handleEscalations(ctx, executableTasks, taskResults);
    for (const event of escalationEvents) {
      yield event;
      events.push(event);
    }

    // Step 7: Collect results
    const { resultEvents, successCount, failedCount } = await this.collectResults(
      ctx,
      executableTasks,
      taskResults,
      layerIdx,
    );
    for (const event of resultEvents) {
      yield event;
      events.push(event);
    }

    // Step 8: Update state
    const stateEvent = await this.onStateUpdate(ctx, layerIdx);
    if (stateEvent) {
      yield stateEvent;
      events.push(stateEvent);
    }

    // Step 9: Checkpoint
    const checkpointEvent = await this.onCheckpoint(ctx, layerIdx);
    if (checkpointEvent) {
      yield checkpointEvent;
      events.push(checkpointEvent);
    }

    // Step 10: Decision points (AIL/HIL)
    const decisionEvents = await this.handleDecisions(ctx, layer, layerIdx, failedCount > 0);
    for (const event of decisionEvents) {
      yield event;
      events.push(event);
    }

    return { events, successCount, failedCount };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Hook Methods - Override in subclasses
  // ═══════════════════════════════════════════════════════════════════════════

  /** Called at layer start. Return event to emit or null. */
  protected abstract onLayerStart(
    ctx: TContext,
    layer: TTask[],
    layerIdx: number,
  ): Promise<TEvent | null>;

  /** Called before execution. Throw to abort. */
  protected abstract onPreExecutionCheck(ctx: TContext): Promise<void>;

  /** Filter tasks to execute (skip non-executable). */
  protected abstract filterTasks(ctx: TContext, layer: TTask[]): Promise<TTask[]>;

  /** Called for each task start. Return event to emit or null. */
  protected abstract onTaskStart(ctx: TContext, task: TTask): Promise<TEvent | null>;

  /** Execute all tasks in parallel. Return settled results. */
  protected abstract executeTasks(
    ctx: TContext,
    tasks: TTask[],
  ): Promise<PromiseSettledResult<TResult>[]>;

  /** Handle escalations (permissions, errors). Return events to yield. */
  protected abstract handleEscalations(
    ctx: TContext,
    tasks: TTask[],
    results: PromiseSettledResult<TResult>[],
  ): Promise<TEvent[]>;

  /** Collect and process results. Return events and counts. */
  protected abstract collectResults(
    ctx: TContext,
    tasks: TTask[],
    results: PromiseSettledResult<TResult>[],
    layerIdx: number,
  ): Promise<{ resultEvents: TEvent[]; successCount: number; failedCount: number }>;

  /** Called after state update. Return event or null. */
  protected abstract onStateUpdate(ctx: TContext, layerIdx: number): Promise<TEvent | null>;

  /** Called for checkpoint. Return event or null. */
  protected abstract onCheckpoint(ctx: TContext, layerIdx: number): Promise<TEvent | null>;

  /** Handle AIL/HIL decisions. Return events to yield. */
  protected abstract handleDecisions(
    ctx: TContext,
    layer: TTask[],
    layerIdx: number,
    hasErrors: boolean,
  ): Promise<TEvent[]>;
}
