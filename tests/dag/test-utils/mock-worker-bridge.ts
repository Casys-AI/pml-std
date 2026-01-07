/**
 * Mock WorkerBridge for testing
 *
 * Provides a minimal WorkerBridge implementation that executes code
 * synchronously without actual Web Worker isolation.
 *
 * @module tests/dag/test-utils/mock-worker-bridge
 */

import type { ToolDefinition, ExecutionResult, ErrorType } from "../../../src/sandbox/types.ts";

/**
 * Mock WorkerBridge for tests
 *
 * Executes code_execution tasks synchronously without workers.
 */
export class MockWorkerBridge {
  async initialize(_toolDefs: ToolDefinition[]): Promise<void> {
    // No-op for mock
  }

  async executeCodeTask(
    _toolName: string,
    code: string,
    context: Record<string, unknown>,
    _toolDefinitions: ToolDefinition[],
    _loopMetadata?: {
      loopId?: string;
      loopCondition?: string;
      loopType?: string;
      bodyTools?: string[];
    },
  ): Promise<ExecutionResult> {
    const startTime = performance.now();

    try {
      // Create a function from the code and execute it
      // deno-lint-ignore no-explicit-any
      const fn = new Function("deps", "args", "mcp", `
        "use strict";
        ${code}
      `);

      // Mock MCP object for tool calls
      const mockMcp = this.createMockMcp();

      const result = await fn(
        context.deps ?? {},
        context.args ?? {},
        mockMcp,
      );

      const executionTimeMs = performance.now() - startTime;

      return {
        success: true,
        result,
        executionTimeMs,
      };
    } catch (error) {
      const executionTimeMs = performance.now() - startTime;
      const errorType: ErrorType = "RuntimeError";
      return {
        success: false,
        error: {
          type: errorType,
          message: error instanceof Error ? error.message : String(error),
        },
        executionTimeMs,
      };
    }
  }

  private createMockMcp() {
    // Create a proxy that returns mock results for any tool call
    // deno-lint-ignore no-explicit-any
    const handler: ProxyHandler<any> = {
      get: (_target, serverName) => {
        // Return another proxy for the server namespace
        return new Proxy({}, {
          get: (_t, toolName) => {
            // Return a mock function for any tool
            return async (args: Record<string, unknown>) => {
              return { mock: true, server: serverName, tool: toolName, args };
            };
          },
        });
      },
    };
    return new Proxy({}, handler);
  }

  terminate(): void {
    // No-op for mock
  }

  async cleanup(): Promise<void> {
    // No-op for mock
  }
}

/**
 * Create a configured mock WorkerBridge for tests
 */
export function createMockWorkerBridge(): MockWorkerBridge {
  return new MockWorkerBridge();
}
