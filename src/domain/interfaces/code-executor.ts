/**
 * Code Executor Interface
 *
 * Defines the contract for code execution in sandbox environments.
 * Implementations: SandboxExecutor via WorkerBridge
 *
 * Phase 3.1: Execute Handler → Use Cases refactoring
 *
 * @module domain/interfaces/code-executor
 */

import type { JsonValue } from "../../capabilities/types/mod.ts";

/**
 * Trace event from code execution
 */
export interface ExecutionTraceEvent {
  type: "tool_start" | "tool_end" | "code_start" | "code_end" | "error";
  tool?: string;
  success?: boolean;
  error?: string;
  timestamp?: number;
}

/**
 * Result from code execution
 */
export interface CodeExecutionResult {
  success: boolean;
  result?: JsonValue;
  error?: {
    type: string;
    message: string;
    stack?: string;
  };
  executionTimeMs: number;
  toolsCalled?: string[];
  traces?: ExecutionTraceEvent[];
}

/**
 * Context for code execution
 *
 * Note: Named CodeExecutionContext to avoid collision with ExecutionContext from dag-executor.ts
 */
export interface CodeExecutionContext {
  intent?: string;
  timeout?: number;
  args?: Record<string, JsonValue>;
  /** Additional context data */
  [key: string]: unknown;
}

/**
 * Tool definition for injection into sandbox
 */
export interface ExecutorToolDefinition {
  id: string;
  name: string;
  description?: string;
  inputSchema?: unknown;
  serverId?: string;
}

/**
 * Interface for code execution in sandbox
 *
 * This interface abstracts the sandbox execution layer,
 * allowing for different implementations (Worker, Deno subprocess, etc.)
 * and easy mocking in tests.
 */
export interface ICodeExecutor {
  /**
   * Execute code with injected tools
   *
   * @param code - TypeScript/JavaScript code to execute
   * @param context - Execution context with intent, timeout, args
   * @param toolDefinitions - Tools to inject into the sandbox
   * @returns Execution result with traces
   */
  execute(
    code: string,
    context: CodeExecutionContext,
    toolDefinitions: ExecutorToolDefinition[],
  ): Promise<CodeExecutionResult>;

  /**
   * Cleanup any resources (worker bridges, etc.)
   */
  cleanup?(): Promise<void>;
}
