/**
 * Worker Runner
 *
 * Wrapper around WorkerBridge for sandbox code execution.
 * Provides a consistent interface for the executor facade.
 *
 * @module sandbox/execution/worker-runner
 */

import type { MCPClientBase } from "../../mcp/types.ts";
import type { ToolDefinition, ExecutionResult, TraceEvent } from "../types.ts";
import type { CapabilityStore } from "../../capabilities/capability-store.ts";
import type { CapabilityRegistry } from "../../capabilities/capability-registry.ts";
import type { GraphRAGEngine } from "../../graphrag/graph-engine.ts";
import { WorkerBridge } from "../worker-bridge.ts";
import { getLogger } from "../../telemetry/logger.ts";

const logger = getLogger("default");

/**
 * Configuration for WorkerRunner
 */
export interface WorkerRunnerConfig {
  /** Maximum execution time in milliseconds */
  timeout: number;
  /** Optional CapabilityStore for eager learning */
  capabilityStore?: CapabilityStore;
  /** Optional GraphRAGEngine for trace learning */
  graphRAG?: GraphRAGEngine;
  /** Optional CapabilityRegistry for capability routing */
  capabilityRegistry?: CapabilityRegistry;
}

/**
 * Extended execution result with traces
 */
export interface WorkerExecutionResult extends ExecutionResult {
  traces?: TraceEvent[];
  toolsCalled?: string[];
}

/**
 * Worker Runner
 *
 * Executes code in a Worker sandbox via WorkerBridge RPC bridge.
 * This is the recommended execution mode for MCP tool support.
 *
 * Benefits:
 * - MCP tools work via RPC proxy (no serialization issues)
 * - Native tracing (no stdout parsing)
 * - 100% I/O traceability
 * - Faster than subprocess (~33ms vs ~54ms)
 *
 * @example
 * ```typescript
 * const runner = new WorkerRunner({
 *   timeout: 30000,
 *   capabilityStore: store,
 * });
 * const result = await runner.execute(code, toolDefs, context);
 * console.log(result.toolsCalled); // ["filesystem:read_file", "json:parse"]
 * ```
 */
export class WorkerRunner {
  private config: WorkerRunnerConfig;
  private lastBridge: WorkerBridge | null = null;

  constructor(config: WorkerRunnerConfig) {
    this.config = config;

    logger.debug("WorkerRunner initialized", {
      timeout: config.timeout,
      capabilityStoreEnabled: !!config.capabilityStore,
      graphRAGEnabled: !!config.graphRAG,
    });
  }

  /**
   * Execute code in Worker sandbox
   *
   * @param code - TypeScript code to execute
   * @param mcpClients - Map of MCP clients for tool calls
   * @param toolDefinitions - Tool definitions for proxy generation
   * @param context - Optional context variables to inject
   * @param capabilityContext - Optional capability code for injection
   * @returns Execution result with traces
   */
  async execute(
    code: string,
    mcpClients: Map<string, MCPClientBase>,
    toolDefinitions: ToolDefinition[] = [],
    context?: Record<string, unknown>,
    capabilityContext?: string,
  ): Promise<WorkerExecutionResult> {
    // Create new bridge for execution
    const bridge = new WorkerBridge(mcpClients, {
      timeout: this.config.timeout,
      capabilityStore: this.config.capabilityStore,
      graphRAG: this.config.graphRAG,
      capabilityRegistry: this.config.capabilityRegistry,
    });

    this.lastBridge = bridge;

    try {
      const result = await bridge.execute(code, toolDefinitions, context, capabilityContext);

      return {
        ...result,
        traces: bridge.getTraces(),
        toolsCalled: bridge.getToolsCalled(),
      };
    } finally {
      // Note: bridge.terminate() is called in execute() finally block
      // Don't call cleanup() here as traces may still be needed
    }
  }

  /**
   * Execute code with minimal tool definitions
   *
   * Convenience method for simple executions without MCP tools.
   *
   * @param code - TypeScript code to execute
   * @param context - Optional context variables
   * @returns Execution result
   */
  async executeSimple(
    code: string,
    context?: Record<string, unknown>,
  ): Promise<ExecutionResult> {
    const bridge = new WorkerBridge(new Map(), {
      timeout: this.config.timeout,
      capabilityStore: this.config.capabilityStore,
      graphRAG: this.config.graphRAG,
      capabilityRegistry: this.config.capabilityRegistry,
    });

    this.lastBridge = bridge;

    return bridge.execute(code, [], context);
  }

  /**
   * Get traces from last execution
   */
  getLastTraces(): TraceEvent[] {
    return this.lastBridge?.getTraces() ?? [];
  }

  /**
   * Get tools called in last execution
   */
  getLastToolsCalled(): string[] {
    return this.lastBridge?.getToolsCalled() ?? [];
  }

  /**
   * Cleanup resources from last execution
   */
  cleanup(): void {
    if (this.lastBridge) {
      this.lastBridge.cleanup();
      this.lastBridge = null;
    }
  }
}
