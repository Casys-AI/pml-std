/**
 * Code Task Executor - Execute code tasks via WorkerBridge
 *
 * This module handles code execution tasks (code:filter, code:map, loop:forOf, etc.)
 * routing them through WorkerBridge for pseudo-tool tracing.
 *
 * Extracted from controlled-executor.ts for single responsibility.
 *
 * @module dag/execution/code-task-executor
 */

import type { TaskResult } from "../types.ts";
import type { Task } from "../../graphrag/types.ts";
import type { WorkerBridge } from "../../sandbox/worker-bridge.ts";
import type { ToolDefinition } from "../../sandbox/types.ts";
import * as log from "@std/log";
import { resolveDependencies } from "./dependency-resolver.ts";

/**
 * Dependencies required for code task execution
 */
export interface CodeTaskExecutorDeps {
  /** WorkerBridge for execution */
  workerBridge: WorkerBridge;
  /** Tool definitions for MCP access in loops */
  toolDefinitions: ToolDefinition[];
  /** Execution args for parameterized capabilities (args.xxx injection) */
  executionArgs: Record<string, unknown>;
}

/**
 * Execution result from code task
 */
export interface CodeTaskResult {
  output: unknown;
  executionTimeMs: number;
}

/**
 * Execute a code task via WorkerBridge for pseudo-tool tracing
 *
 * This function routes code_execution tasks through WorkerBridge.executeCodeTask()
 * to emit tool_start/tool_end traces for SHGAT learning.
 *
 * @param task - Code execution task with tool name (e.g., "code:filter")
 * @param previousResults - Results from previous tasks for dependency resolution
 * @param deps - Dependencies for execution
 * @returns Execution result
 */
export async function executeCodeTask(
  task: Task,
  previousResults: Map<string, TaskResult>,
  deps: CodeTaskExecutorDeps,
): Promise<CodeTaskResult> {
  if (!task.code) {
    throw new Error(`Code execution task ${task.id} missing required 'code' field`);
  }
  if (!task.tool) {
    throw new Error(`Code execution task ${task.id} missing required 'tool' field for tracing`);
  }

  const { workerBridge, toolDefinitions, executionArgs } = deps;

  // Build execution context with dependencies
  const executionContext: Record<string, unknown> = {
    ...task.arguments,
  };

  // Bug 3 fix: Inject capability args (args.files, args.results, etc.)
  if (Object.keys(executionArgs).length > 0) {
    executionContext.args = executionArgs;
    log.debug("Injected execution args into context", {
      argsKeys: Object.keys(executionArgs),
    });
  }

  // Resolve dependencies: $OUTPUT[dep_id] → actual results
  executionContext.deps = resolveDependencies(task.dependsOn, previousResults);

  // Inject variables from variableBindings (Phase 1 Modular Execution)
  if (task.variableBindings) {
    for (const [varName, nodeId] of Object.entries(task.variableBindings)) {
      const taskId = `task_${nodeId}`;
      const depResult = previousResults.get(taskId);
      if (depResult?.output !== undefined) {
        executionContext[varName] = depResult.output;
        log.debug(`Injected variable binding: ${varName} from ${taskId}`);
      }
    }
  }

  // Inject literal bindings from static analysis (Story 10.2c fix)
  if (task.literalBindings) {
    for (const [varName, value] of Object.entries(task.literalBindings)) {
      // Don't override values already set from variableBindings
      if (!(varName in executionContext)) {
        executionContext[varName] = value;
        log.debug(`Injected literal binding: ${varName}`);
      }
    }
  }

  // Loop Fix: For loop tasks, wrap code to return modified context
  let codeToExecute = task.code;
  if (task.tool?.startsWith("loop:")) {
    const contextVars = Object.keys(executionContext).filter(
      (k) => k !== "deps" && k !== "args",
    );
    codeToExecute = `${task.code}\nreturn { ${contextVars.join(", ")} };`;
    log.debug("Wrapped loop code with return statement", {
      contextVars,
      codePreview: codeToExecute.substring(0, 300),
    });
  }

  log.debug(`Executing code task via WorkerBridge`, {
    taskId: task.id,
    tool: task.tool,
    hasDeps: task.dependsOn.length > 0,
    injectedVars: task.variableBindings ? Object.keys(task.variableBindings) : [],
    injectedLiterals: task.literalBindings ? Object.keys(task.literalBindings) : [],
    codePreview: codeToExecute?.substring(0, 200),
    toolDefsCount: toolDefinitions.length,
  });

  // Execute via WorkerBridge (emits tool_start/tool_end traces)
  const loopMetadata = task.tool?.startsWith("loop:")
    ? {
        loopId: task.metadata?.loopId as string | undefined,
        loopCondition: task.metadata?.loopCondition as string | undefined,
        loopType: task.metadata?.loopType as string | undefined,
        bodyTools: task.metadata?.bodyTools as string[] | undefined,
      }
    : undefined;

  const result = await workerBridge.executeCodeTask(
    task.tool,
    codeToExecute,
    executionContext,
    toolDefinitions,
    loopMetadata,
  );

  if (!result.success) {
    const error = result.error!;
    throw new Error(`${error.type}: ${error.message}`);
  }

  log.info(`Code task ${task.id} succeeded via WorkerBridge`, {
    tool: task.tool,
    executionTimeMs: result.executionTimeMs.toFixed(2),
    resultType: typeof result.result,
  });

  return {
    output: {
      result: result.result,
      state: executionContext,
      executionTimeMs: result.executionTimeMs,
    },
    executionTimeMs: result.executionTimeMs,
  };
}
