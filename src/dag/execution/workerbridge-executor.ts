/**
 * WorkerBridge-based Tool Executor for DAG Execution
 *
 * Story 10.5 AC10/AC11: Creates ToolExecutor that routes all MCP tool calls
 * through WorkerBridge for 100% traçabilité RPC.
 *
 * DESIGN DECISION (2025-12-19):
 * All tool execution MUST go through WorkerBridge. This ensures:
 * 1. Complete tracing of all operations (tool_start/tool_end events)
 * 2. Centralized permission control in Worker sandbox
 * 3. Consistent execution model across all handlers
 *
 * @module dag/execution/workerbridge-executor
 */

import type { ToolExecutor } from "../types.ts";
import type { TraceEvent } from "../../sandbox/types.ts";
import type { ToolDefinition } from "../../sandbox/types.ts";
import { WorkerBridge, type WorkerBridgeConfig } from "../../sandbox/worker-bridge.ts";
import type { MCPClientBase } from "../../mcp/types.ts";
import * as log from "@std/log";

/**
 * Configuration for WorkerBridge-based executor
 */
export interface WorkerBridgeExecutorConfig {
  /** MCP clients for tool execution */
  mcpClients: Map<string, MCPClientBase>;
  /** Tool definitions for schema context */
  toolDefinitions?: ToolDefinition[];
  /** Optional CapabilityStore for eager learning */
  capabilityStore?: WorkerBridgeConfig["capabilityStore"];
  /** Optional GraphRAGEngine for trace learning */
  graphRAG?: WorkerBridgeConfig["graphRAG"];
  /** Optional CapabilityRegistry for routing to capabilities when MCP server not found */
  capabilityRegistry?: WorkerBridgeConfig["capabilityRegistry"];
  /** Execution timeout in ms (default: 30000) */
  timeout?: number;
}

/**
 * Context passed to executor with accumulated traces
 */
export interface ExecutorContext {
  /** Accumulated traces from all tool executions */
  traces: TraceEvent[];
  /** WorkerBridge instance (reused for performance) */
  bridge: WorkerBridge;
}

/**
 * Creates a ToolExecutor that routes calls through WorkerBridge
 *
 * Each tool call generates TypeScript code that calls the tool via MCP proxy,
 * then executes it in the Worker sandbox. This ensures all calls are traced.
 *
 * @param config - Executor configuration
 * @returns Tuple of [ToolExecutor, ExecutorContext]
 *
 * @example
 * ```typescript
 * const [executor, ctx] = createToolExecutorViaWorker({
 *   mcpClients,
 *   toolDefinitions: buildToolDefinitions(searchResults),
 * });
 *
 * const result = await executor("filesystem:read_file", { path: "/tmp/test.txt" });
 *
 * // Access traces
 * const traces = ctx.traces;
 * // or
 * const traces = ctx.bridge.getTraces();
 * ```
 */
export function createToolExecutorViaWorker(
  config: WorkerBridgeExecutorConfig,
): [ToolExecutor, ExecutorContext] {
  const { mcpClients, toolDefinitions = [], capabilityStore, graphRAG, capabilityRegistry, timeout = 30000 } = config;

  // Create persistent WorkerBridge for all tool calls
  const bridge = new WorkerBridge(mcpClients, {
    timeout,
    capabilityStore,
    graphRAG,
    capabilityRegistry,
  });

  const context: ExecutorContext = {
    traces: [],
    bridge,
  };

  const executor: ToolExecutor = async (
    tool: string,
    args: Record<string, unknown>,
  ): Promise<unknown> => {
    // Parse tool ID: "server:toolName"
    const colonIndex = tool.indexOf(":");
    if (colonIndex === -1) {
      throw new Error(`Invalid tool format: "${tool}". Expected "server:toolName"`);
    }

    const server = tool.substring(0, colonIndex);
    const toolName = tool.substring(colonIndex + 1);

    log.debug(`[WorkerBridgeExecutor] Executing tool via Worker`, {
      server,
      toolName,
      argsKeys: Object.keys(args),
    });

    // Generate TypeScript code that calls the tool via MCP proxy
    // The Worker has access to `mcp.server.toolName()` functions
    const argsJson = JSON.stringify(args);
    const code = `return await mcp.${server}.${toolName}(${argsJson});`;

    // Find tool definition for schema context
    const toolDef = toolDefinitions.find(
      (t) => t.server === server && t.name === toolName,
    );
    const toolDefs = toolDef ? [toolDef] : [];

    // Execute via WorkerBridge (100% traced!)
    const result = await bridge.execute(code, toolDefs, {});

    // Accumulate traces for later retrieval
    context.traces.push(...bridge.getTraces());

    if (!result.success) {
      const errorMessage = result.error?.message ?? "Tool execution failed";
      log.warn(`[WorkerBridgeExecutor] Tool execution failed`, {
        tool,
        error: errorMessage,
      });
      throw new Error(errorMessage);
    }

    log.debug(`[WorkerBridgeExecutor] Tool execution succeeded`, {
      tool,
      executionTimeMs: result.executionTimeMs.toFixed(2),
    });

    return result.result;
  };

  return [executor, context];
}

/**
 * Creates a simple ToolExecutor without context tracking
 *
 * For cases where trace accumulation isn't needed.
 * Use createToolExecutorViaWorker for full trace support.
 *
 * @param mcpClients - MCP clients for tool execution
 * @param toolDefinitions - Tool definitions for schema context
 * @returns ToolExecutor function
 */
export function createSimpleToolExecutorViaWorker(
  mcpClients: Map<string, MCPClientBase>,
  toolDefinitions: ToolDefinition[] = [],
): ToolExecutor {
  const [executor] = createToolExecutorViaWorker({
    mcpClients,
    toolDefinitions,
  });
  return executor;
}

/**
 * Cleanup function to properly close WorkerBridge resources
 *
 * Call this when done with the executor to free resources.
 *
 * @param context - Executor context from createToolExecutorViaWorker
 */
export function cleanupWorkerBridgeExecutor(context: ExecutorContext): void {
  context.bridge.cleanup();
}
