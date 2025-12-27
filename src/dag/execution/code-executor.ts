/**
 * Code Executor Module
 *
 * Executes code_execution tasks in a Deno sandbox.
 * Handles dependency resolution, permission escalation, and retry logic.
 *
 * @module dag/execution/code-executor
 */

import type { Task } from "../../graphrag/types.ts";
import type { TaskResult } from "../types.ts";
import type { PermissionSet } from "../../capabilities/types.ts";
import type { CapabilityStore } from "../../capabilities/capability-store.ts";
import type { GraphRAGEngine } from "../../graphrag/graph-engine.ts";
import { DenoSandboxExecutor } from "../../sandbox/executor.ts";
import { getLogger } from "../../telemetry/logger.ts";
import { resolveDependencies } from "./dependency-resolver.ts";
import { isPermissionError } from "../permissions/escalation-integration.ts";

const log = getLogger("default");

/**
 * Check if an error is deterministic (won't change on retry)
 *
 * Deterministic errors include:
 * - Variable not defined (scope/context issue)
 * - Syntax errors
 * - Type errors
 *
 * These errors indicate bugs in code or missing context,
 * not transient failures that could succeed on retry.
 */
function isDeterministicError(message: string): boolean {
  const deterministicPatterns = [
    /is not defined/i, // Variable/function not in scope
    /SyntaxError/i, // Invalid code syntax
    /TypeError/i, // Type mismatch
    /ReferenceError/i, // Reference to undefined variable
    /Cannot read propert/i, // Property access on undefined
    /is not a function/i, // Calling non-function
    /Unexpected token/i, // Parse error
  ];

  return deterministicPatterns.some((pattern) => pattern.test(message));
}

/**
 * Dependencies for code execution
 */
export interface CodeExecutorDeps {
  capabilityStore?: CapabilityStore;
  graphRAG?: GraphRAGEngine;
}

/**
 * Execute code task in sandbox (Story 3.4)
 *
 * Process:
 * 1. Resolve dependencies from previousResults
 * 2. Execute code in sandbox with context and permissionSet
 * 3. Return result for checkpoint persistence
 *
 * @param task - Code execution task
 * @param previousResults - Results from previous tasks
 * @param deps - Code executor dependencies
 * @param permissionSet - Permission set to use (default: from task.sandboxConfig or "minimal")
 * @returns Execution result
 */
export async function executeCodeTask(
  task: Task,
  previousResults: Map<string, TaskResult>,
  deps: CodeExecutorDeps,
  permissionSet?: PermissionSet,
): Promise<{ output: unknown; executionTimeMs: number }> {
  const startTime = performance.now();
  // Get permission set from parameter, sandboxConfig, or default to "minimal"
  const currentPermissionSet: PermissionSet = permissionSet ??
    (task.sandboxConfig?.permissionSet as PermissionSet) ?? "minimal";

  log.debug(`Executing code task: ${task.id}`, { permissionSet: currentPermissionSet });

  // Validate task structure
  if (!task.code) {
    throw new Error(
      `Code execution task ${task.id} missing required 'code' field`,
    );
  }

  // Build execution context: merge deps + custom context
  const executionContext: Record<string, unknown> = {
    ...task.arguments, // Custom context from task
  };

  // Pass intent to WorkerBridge for eager learning (Story 7.2a)
  if (task.intent) {
    executionContext.intent = task.intent;
  }

  // Resolve dependencies: $OUTPUT[dep_id] → actual results
  // Story 3.5: Pass full TaskResult to enable resilient patterns
  executionContext.deps = resolveDependencies(task.dependsOn, previousResults);

  // Configure sandbox
  const sandboxConfig = task.sandboxConfig || {};
  const executor = new DenoSandboxExecutor({
    timeout: sandboxConfig.timeout ?? 30000,
    memoryLimit: sandboxConfig.memoryLimit ?? 512,
    allowedReadPaths: sandboxConfig.allowedReadPaths ?? [],
    capabilityStore: deps.capabilityStore,
    graphRAG: deps.graphRAG,
  });

  // Execute code in sandbox with permissionSet
  const result = await executor.execute(task.code, executionContext, currentPermissionSet);

  if (!result.success) {
    const error = result.error!;
    throw new Error(`${error.type}: ${error.message}`);
  }

  const executionTimeMs = performance.now() - startTime;

  log.info(`Code task ${task.id} succeeded`, {
    executionTimeMs: executionTimeMs.toFixed(2),
    resultType: typeof result.result,
    permissionSet: currentPermissionSet,
  });

  // Return result for checkpoint persistence
  return {
    output: {
      result: result.result,
      state: executionContext, // For checkpoint compatibility
      executionTimeMs: result.executionTimeMs,
    },
    executionTimeMs,
  };
}

/**
 * Execute safe-to-fail task with retry logic (Story 3.5 - Task 7)
 *
 * Retry strategy:
 * - Max 3 attempts
 * - Exponential backoff: 100ms, 200ms, 400ms
 * - Only for safe-to-fail tasks (idempotent)
 *
 * @param task - Safe-to-fail task
 * @param previousResults - Results from previous tasks
 * @param deps - Code executor dependencies
 * @returns Execution result
 */
export async function executeWithRetry(
  task: Task,
  previousResults: Map<string, TaskResult>,
  deps: CodeExecutorDeps,
): Promise<{ output: unknown; executionTimeMs: number }> {
  const maxAttempts = 3;
  const baseDelay = 100; // ms
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      log.debug(`Executing safe-to-fail task ${task.id} (attempt ${attempt}/${maxAttempts})`);
      return await executeCodeTask(task, previousResults, deps);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Don't retry permission errors - they need escalation, not retry
      if (isPermissionError(lastError.message)) {
        log.info(`Permission error detected for task ${task.id}, skipping retry for escalation`);
        throw lastError;
      }

      // Don't retry deterministic errors - they won't change on retry
      if (isDeterministicError(lastError.message)) {
        log.info(`Deterministic error for task ${task.id}, skipping retry: ${lastError.message}`);
        throw lastError;
      }

      if (attempt < maxAttempts) {
        // Exponential backoff: 100ms, 200ms, 400ms
        const delay = baseDelay * Math.pow(2, attempt - 1);
        log.warn(
          `Safe-to-fail task ${task.id} failed (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms: ${lastError.message}`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else {
        log.error(
          `Safe-to-fail task ${task.id} failed after ${maxAttempts} attempts: ${lastError.message}`,
        );
      }
    }
  }

  // All retries exhausted, throw the last error
  throw lastError!;
}
