/**
 * Parallel DAG Executor
 *
 * Executes DAG workflows with automatic parallelization based on topological sorting.
 * Independent tasks execute in parallel, dependent tasks execute sequentially.
 *
 * @module dag/executor
 */

import type { DAGStructure, Task } from "../graphrag/types.ts";
import type {
  DAGExecutionResult,
  ExecutorConfig,
  TaskError,
  TaskResult,
  ToolExecutor,
} from "./types.ts";
import { getLogger } from "../telemetry/logger.ts";
import { DAGExecutionError, TimeoutError } from "../errors/error-types.ts";
import { RateLimiter } from "../utils/rate-limiter.ts";
// Story 6.5: EventBus integration (ADR-036)
import { eventBus } from "../events/mod.ts";

const log = getLogger("default");

/**
 * Parallel executor for DAG workflows
 *
 * Features:
 * - Topological sort to identify parallel execution layers
 * - Promise.allSettled for resilient parallel execution
 * - Partial success handling (continues on task failures)
 * - $OUTPUT[task_id] reference resolution
 * - Performance measurement and speedup calculation
 * - Rate limiting to prevent MCP server overload
 */
export class ParallelExecutor {
  protected config: Required<ExecutorConfig>;
  private rateLimiter: RateLimiter;

  /**
   * Create a new parallel executor
   *
   * @param toolExecutor - Function to execute individual tools
   * @param config - Executor configuration
   */
  constructor(
    private toolExecutor: ToolExecutor,
    config: ExecutorConfig = {},
  ) {
    this.config = {
      maxConcurrency: config.maxConcurrency ?? Infinity,
      taskTimeout: config.taskTimeout ?? 30000,
      verbose: config.verbose ?? false,
      // AIL enabled by default with on_error mode for replan support (2025-12-19)
      ail: config.ail ?? { enabled: true, decision_points: "on_error" },
      // HIL disabled - replaced by per_layer_validation via requiresValidation()
      hil: config.hil ?? { enabled: false, approval_required: "never" },
      userId: config.userId ?? "local", // Story 9.5: Multi-tenant isolation
      timeouts: config.timeouts ?? { hil: 300000, ail: 60000, pollInterval: 100 },
      // Story 10.7c fix: Per-layer validation pause (disabled by default)
      perLayerValidation: config.perLayerValidation ?? false,
    };
    // Initialize rate limiter: 10 requests per second per server
    this.rateLimiter = new RateLimiter(10, 1000);
  }

  /**
   * Execute a DAG workflow with automatic parallelization
   * Story 6.5: Emits DAG events to EventBus (ADR-036)
   *
   * @param dag - DAG structure to execute
   * @returns Execution result with metrics
   * @throws Error if circular dependency detected
   */
  async execute(dag: DAGStructure): Promise<DAGExecutionResult> {
    const startTime = performance.now();
    const executionId = crypto.randomUUID();

    if (this.config.verbose) {
      log.info(`Starting DAG execution with ${dag.tasks.length} tasks`);
    }

    // 1. Topological sort to identify parallel execution layers
    const layers = this.topologicalSort(dag);

    // Story 6.5: Emit dag.started event
    eventBus.emit({
      type: "dag.started",
      source: "dag-executor",
      payload: {
        execution_id: executionId,
        task_count: dag.tasks.length,
        layer_count: layers.length,
        task_ids: dag.tasks.map((t) => t.id),
      },
    });

    if (this.config.verbose) {
      log.info(
        `Identified ${layers.length} parallel execution layers: ${
          layers.map((l) => `[${l.map((t) => t.id).join(",")}]`).join(" → ")
        }`,
      );
    }

    // 2. Execute layer by layer
    const results = new Map<string, TaskResult>();
    const errors: TaskError[] = [];

    for (let layerIdx = 0; layerIdx < layers.length; layerIdx++) {
      const layer = layers[layerIdx];

      if (this.config.verbose) {
        log.info(
          `Executing layer ${
            layerIdx + 1
          }/${layers.length} with ${layer.length} task(s) in parallel`,
        );
      }

      // Execute all tasks in this layer in parallel using Promise.allSettled
      // Story 6.5: Emit task events before/after execution
      const layerResults = await Promise.allSettled(
        layer.map(async (task) => {
          // Emit dag.task.started
          eventBus.emit({
            type: "dag.task.started",
            source: "dag-executor",
            payload: {
              execution_id: executionId,
              task_id: task.id,
              tool: task.tool,
              layer: layerIdx,
              args: task.arguments,
            },
          });

          return this.executeTask(task, results);
        }),
      );

      // Collect results and errors
      for (let i = 0; i < layer.length; i++) {
        const task = layer[i];
        const result = layerResults[i];

        if (result.status === "fulfilled") {
          // Task succeeded
          results.set(task.id, {
            taskId: task.id,
            status: "success",
            output: result.value.output,
            executionTimeMs: result.value.executionTimeMs,
          });

          // Story 6.5: Emit dag.task.completed
          eventBus.emit({
            type: "dag.task.completed",
            source: "dag-executor",
            payload: {
              execution_id: executionId,
              task_id: task.id,
              tool: task.tool,
              duration_ms: result.value.executionTimeMs,
            },
          });

          if (this.config.verbose) {
            log.info(
              `✓ Task ${task.id} succeeded (${result.value.executionTimeMs.toFixed(1)}ms)`,
            );
          }
        } else {
          // Task failed - log but continue execution
          const errorMsg = result.reason?.message || String(result.reason);
          const recoverable = result.reason instanceof DAGExecutionError
            ? result.reason.recoverable
            : true;
          const taskError: TaskError = {
            taskId: task.id,
            error: errorMsg,
            status: "error",
          };

          errors.push(taskError);
          results.set(task.id, {
            taskId: task.id,
            status: "error",
            error: errorMsg,
          });

          // Story 6.5: Emit dag.task.failed
          eventBus.emit({
            type: "dag.task.failed",
            source: "dag-executor",
            payload: {
              execution_id: executionId,
              task_id: task.id,
              tool: task.tool,
              error: errorMsg,
              recoverable,
            },
          });

          if (this.config.verbose) {
            log.warn(`✗ Task ${task.id} failed: ${errorMsg}`);
          }
        }
      }
    }

    const totalTime = performance.now() - startTime;

    const executionResult: DAGExecutionResult = {
      results: Array.from(results.values()),
      executionTimeMs: totalTime,
      parallelizationLayers: layers.length,
      errors,
      totalTasks: dag.tasks.length,
      successfulTasks: Array.from(results.values()).filter((r) => r.status === "success").length,
      failedTasks: errors.length,
    };

    // Story 6.5: Emit dag.completed event
    eventBus.emit({
      type: "dag.completed",
      source: "dag-executor",
      payload: {
        execution_id: executionId,
        total_duration_ms: totalTime,
        successful_tasks: executionResult.successfulTasks,
        failed_tasks: executionResult.failedTasks,
        success: executionResult.failedTasks === 0,
        speedup: this.calculateSpeedup(executionResult),
      },
    });

    if (this.config.verbose) {
      log.info(
        `DAG execution complete: ${executionResult.successfulTasks}/${executionResult.totalTasks} tasks succeeded in ${
          totalTime.toFixed(1)
        }ms (${layers.length} layers)`,
      );
    }

    return executionResult;
  }

  /**
   * Topological sort to identify parallel execution layers
   *
   * @param dag - DAG structure
   * @returns Array of layers, where each layer contains tasks that can execute in parallel
   * @throws Error if circular dependency detected
   */
  protected topologicalSort(dag: DAGStructure): Task[][] {
    const layers: Task[][] = [];
    const completed = new Set<string>();
    const remaining = new Map(dag.tasks.map((t) => [t.id, t]));
    const inProgress = new Set<string>();

    while (remaining.size > 0) {
      // Find tasks with all dependencies satisfied
      const ready: Task[] = [];

      for (const [taskId, task] of remaining) {
        // Check if all dependencies are completed
        const allDepsSatisfied = task.dependsOn.every((depId: string) => completed.has(depId));

        if (allDepsSatisfied && !inProgress.has(taskId)) {
          ready.push(task);
          inProgress.add(taskId);
        }
      }

      // Circular dependency check
      if (ready.length === 0 && remaining.size > 0) {
        const remainingIds = Array.from(remaining.keys());
        throw new DAGExecutionError(
          `Circular dependency detected in DAG. Remaining tasks: ${remainingIds.join(", ")}`,
          undefined,
          false, // Not recoverable
        );
      }

      // Add ready tasks as a new parallel execution layer
      layers.push(ready);

      // Mark as completed and remove from remaining
      for (const task of ready) {
        completed.add(task.id);
        remaining.delete(task.id);
        inProgress.delete(task.id);
      }
    }

    return layers;
  }

  /**
   * Execute a single task with timeout and error handling
   *
   * @param task - Task to execute
   * @param previousResults - Results from previously executed tasks
   * @returns Task output and execution time
   */
  protected async executeTask(
    task: Task,
    previousResults: Map<string, TaskResult>,
  ): Promise<{ output: unknown; executionTimeMs: number }> {
    const startTime = performance.now();

    try {
      // 1. Resolve arguments (structured format + legacy $OUTPUT references)
      const resolvedArgs = this.resolveArguments(
        task.arguments,
        previousResults,
        task.staticArguments,
      );

      // 2. Check if dependencies failed
      for (const depId of task.dependsOn) {
        const depResult = previousResults.get(depId);
        if (depResult?.status === "error") {
          throw new DAGExecutionError(
            `Dependency task ${depId} failed: ${depResult.error}`,
            task.id,
            true, // Recoverable - partial success allowed
          );
        }
        if (!depResult) {
          throw new DAGExecutionError(
            `Dependency task ${depId} not found in results`,
            task.id,
            false,
          );
        }
      }

      // 3. Apply rate limiting per tool (BUG-004 fix)
      // Use full tool ID (e.g., "github:list_commits") instead of just serverId
      // This prevents one aggressive tool from exhausting the entire server quota
      if (task.tool) {
        await this.rateLimiter.waitForSlot(task.tool);
      }

      // 4. Execute tool with timeout
      const output = await this.executeWithTimeout(
        task.tool,
        resolvedArgs,
        this.config.taskTimeout,
      );

      const executionTime = performance.now() - startTime;

      return {
        output,
        executionTimeMs: executionTime,
      };
    } catch (error) {
      const executionTime = performance.now() - startTime;

      // Re-throw custom errors as-is
      if (error instanceof DAGExecutionError || error instanceof TimeoutError) {
        throw error;
      }

      throw new DAGExecutionError(
        `Task ${task.id} (${task.tool}) failed after ${executionTime.toFixed(1)}ms: ${
          error instanceof Error ? error.message : String(error)
        }`,
        task.id,
        true, // Default to recoverable for task failures
      );
    }
  }

  /**
   * Execute tool with timeout
   */
  private async executeWithTimeout(
    tool: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    let timeoutId: number | undefined;

    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new TimeoutError(tool, timeoutMs)), timeoutMs);
    });

    const executionPromise = this.toolExecutor(tool, args);

    try {
      const result = await Promise.race([executionPromise, timeoutPromise]);
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
      return result;
    } catch (error) {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
      throw error;
    }
  }

  /**
   * Resolve task arguments from multiple sources (Story 10.5)
   *
   * Resolution priority:
   * 1. staticArguments (structured format from static analysis)
   * 2. args with $OUTPUT[task_id] references (deprecated, for backward compat)
   * 3. Literal values in args
   *
   * Structured format (preferred):
   * - { type: "literal", value: "config.json" }
   * - { type: "reference", expression: "n1.content" }
   * - { type: "parameter", parameterName: "inputFile" }
   *
   * @param args - Raw arguments (may contain $OUTPUT references)
   * @param previousResults - Results from previously executed tasks
   * @param staticArgs - Structured arguments from static analysis (optional)
   * @returns Resolved arguments
   */
  private resolveArguments(
    args: Record<string, unknown>,
    previousResults: Map<string, TaskResult>,
    staticArgs?: import("../capabilities/types.ts").ArgumentsStructure,
  ): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};

    // 1. Resolve from staticArguments (Story 10.5 structured format)
    if (staticArgs) {
      for (const [key, argValue] of Object.entries(staticArgs)) {
        if (argValue.type === "literal") {
          // Literal: value known at static analysis time
          resolved[key] = argValue.value;
        } else if (argValue.type === "reference" && argValue.expression) {
          // Reference: resolve from previous task result
          const resolvedValue = this.resolveStructuredReference(
            argValue.expression,
            previousResults,
          );
          if (resolvedValue !== undefined) {
            resolved[key] = resolvedValue;
          }
        } else if (argValue.type === "parameter") {
          // Parameter: should have been resolved statically, skip if not in args
          // (parameters are resolved before execution in resolveDAGArguments)
        }
      }
    }

    // 2. Resolve from args (legacy $OUTPUT format + literals)
    for (const [key, value] of Object.entries(args)) {
      // Skip if already resolved from staticArgs
      if (key in resolved) continue;

      if (typeof value === "string" && value.startsWith("$OUTPUT[")) {
        // DEPRECATED: $OUTPUT[task_id] format (kept for backward compatibility)
        // Prefer staticArguments with { type: "reference", expression: "..." }
        const match = value.match(/^\$OUTPUT\[([^\]]+)\](\.(.+))?$/);

        if (match) {
          const taskId = match[1];
          const propertyPath = match[3];

          const result = previousResults.get(taskId);

          if (!result) {
            throw new Error(
              `Reference to undefined task output: ${taskId}`,
            );
          }

          if (result.status === "error") {
            throw new Error(
              `Reference to failed task output: ${taskId}`,
            );
          }

          if (propertyPath) {
            resolved[key] = this.getNestedProperty(result.output, propertyPath);
          } else {
            resolved[key] = result.output;
          }
        } else {
          resolved[key] = value;
        }
      } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        // Recursively resolve nested objects
        resolved[key] = this.resolveArguments(
          value as Record<string, unknown>,
          previousResults,
        );
      } else {
        resolved[key] = value;
      }
    }

    return resolved;
  }

  /**
   * Resolve a structured reference expression (Story 10.5)
   *
   * Expression format: "nodeId.property.path" or "nodeId[0].property"
   * Task ID mapping: nodeId → "task_nodeId" (prefix added by staticStructureToDag)
   *
   * @param expression - Reference expression (e.g., "n1.content", "n1.items[0].name")
   * @param previousResults - Results from previously executed tasks
   * @returns Resolved value or undefined if not found
   */
  private resolveStructuredReference(
    expression: string,
    previousResults: Map<string, TaskResult>,
  ): unknown {
    // Handle template literals: `${n1.path}/suffix`
    if (expression.startsWith("`") && expression.endsWith("`")) {
      return this.resolveTemplateLiteral(expression, previousResults);
    }

    // Parse expression: "n1.content.nested" or "n1[0].value"
    // First part is the node ID, rest is the property path
    const firstDot = expression.indexOf(".");
    const firstBracket = expression.indexOf("[");

    let nodeId: string;
    let propertyPath: string | undefined;

    if (firstDot === -1 && firstBracket === -1) {
      // Just node ID, no property path: "n1"
      nodeId = expression;
    } else if (firstBracket !== -1 && (firstDot === -1 || firstBracket < firstDot)) {
      // Array access first: "n1[0].value"
      nodeId = expression.substring(0, firstBracket);
      propertyPath = expression.substring(firstBracket);
    } else {
      // Property access first: "n1.content"
      nodeId = expression.substring(0, firstDot);
      propertyPath = expression.substring(firstDot + 1);
    }

    // Map node ID to task ID (staticStructureToDag uses "task_" prefix)
    const taskId = `task_${nodeId}`;
    const result = previousResults.get(taskId);

    if (!result) {
      log.warn(`Reference to unknown task: ${taskId} (from expression: ${expression})`);
      return undefined;
    }

    if (result.status === "error") {
      log.warn(`Reference to failed task: ${taskId}`);
      return undefined;
    }

    if (!propertyPath) {
      return result.output;
    }

    // Navigate the property path (supports both dot notation and array access)
    return this.getNestedPropertyWithArrays(result.output, propertyPath);
  }

  /**
   * Get nested property supporting both dot notation and array access
   *
   * @param obj - Object to traverse
   * @param path - Property path (e.g., "content", "items[0].name", "[0].value")
   * @returns Property value or undefined
   */
  private getNestedPropertyWithArrays(obj: unknown, path: string): unknown {
    // Split path into segments, handling both dots and brackets
    // "items[0].name" → ["items", "0", "name"]
    const segments = path.split(/\.|\[|\]/).filter((s) => s !== "");

    let current: unknown = obj;

    for (const segment of segments) {
      if (current === null || current === undefined) {
        return undefined;
      }

      if (Array.isArray(current)) {
        const index = parseInt(segment, 10);
        if (isNaN(index)) {
          return undefined;
        }
        current = current[index];
      } else if (typeof current === "object") {
        current = (current as Record<string, unknown>)[segment];
      } else {
        return undefined;
      }
    }

    return current;
  }

  /**
   * Get nested property from object using dot notation
   *
   * @param obj - Object to traverse
   * @param path - Dot-separated property path (e.g., "data.user.name")
   * @returns Property value or undefined
   */
  private getNestedProperty(obj: unknown, path: string): unknown {
    const parts = path.split(".");
    let current: any = obj;

    for (const part of parts) {
      if (current === null || current === undefined) {
        return undefined;
      }
      current = current[part];
    }

    return current;
  }

  /**
   * Calculate speedup compared to sequential execution
   *
   * Speedup = (sum of all task execution times) / (actual parallel execution time)
   *
   * @param result - Execution result
   * @returns Speedup factor (e.g., 3.5x)
   */
  calculateSpeedup(result: DAGExecutionResult): number {
    // Sequential time = sum of all individual task times
    const sequentialTime = result.results.reduce(
      (sum, r) => sum + (r.executionTimeMs || 0),
      0,
    );

    // Parallel time = actual total execution time
    const parallelTime = result.executionTimeMs;

    if (parallelTime === 0) return 1;

    return sequentialTime / parallelTime;
  }

  /**
   * Get execution statistics
   */
  getStats(result: DAGExecutionResult): {
    totalTasks: number;
    successRate: number;
    avgTaskTime: number;
    speedup: number;
    parallelizationLayers: number;
  } {
    const successRate = result.totalTasks > 0
      ? (result.successfulTasks / result.totalTasks) * 100
      : 0;

    const avgTaskTime = result.successfulTasks > 0
      ? result.results
        .filter((r) => r.status === "success")
        .reduce((sum, r) => sum + (r.executionTimeMs || 0), 0) /
        result.successfulTasks
      : 0;

    return {
      totalTasks: result.totalTasks,
      successRate,
      avgTaskTime,
      speedup: this.calculateSpeedup(result),
      parallelizationLayers: result.parallelizationLayers,
    };
  }
}
