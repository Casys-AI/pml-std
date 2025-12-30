/**
 * Execute Code Use Case
 *
 * Executes TypeScript code in a secure sandbox with MCP tool injection.
 * This is the canonical implementation for direct code execution.
 *
 * Features:
 * - Intent-based tool discovery (hybrid search)
 * - Capability matching and reuse
 * - Capability context injection
 * - Native tool call tracing
 * - GraphRAG execution tracking
 * - Adaptive threshold feedback
 *
 * @deprecated The pml:execute_code handler is deprecated.
 *             Use pml:execute with code parameter instead.
 *             This use case remains for internal use and gradual migration.
 *
 * @example
 * ```typescript
 * const useCase = new ExecuteCodeUseCase(deps);
 * const result = await useCase.execute({
 *   code: "return await mcp.filesystem.read_file({ path: 'data.json' });",
 *   intent: "read JSON file"
 * });
 * ```
 *
 * @module application/use-cases/code/execute-code
 */

import * as log from "@std/log";
import type { IEventBus } from "../../../domain/interfaces/event-bus.ts";
import type { UseCaseResult } from "../shared/types.ts";
import type {
  ExecuteCodeRequest,
  ExecuteCodeResult,
  ToolDefinition,
  ToolFailure,
} from "./types.ts";

// ============================================================================
// Interfaces for Dependencies (Clean Architecture)
// ============================================================================

/**
 * Sandbox execution result
 */
export interface SandboxExecutionResult {
  success: boolean;
  result?: unknown;
  error?: { type: string; message: string; stack?: string };
  executionTimeMs: number;
  toolsCalled?: string[];
  traces?: Array<{
    type: string;
    success?: boolean;
    tool?: string;
    error?: string;
  }>;
}

/**
 * Worker execution config for sandbox
 */
export interface WorkerExecutionConfig {
  toolDefinitions: ToolDefinition[];
  mcpClients: Map<string, unknown>;
}

/**
 * Sandbox executor interface
 *
 * Executes code in isolated Deno worker with MCP tool access.
 */
export interface ISandboxExecutor {
  /**
   * Execute code with injected tools
   */
  executeWithTools(
    code: string,
    workerConfig: WorkerExecutionConfig,
    context: Record<string, unknown>,
    capabilityContext?: string,
  ): Promise<SandboxExecutionResult>;

  /**
   * Set tool versions for cache key generation
   */
  setToolVersions(versions: Map<string, string>): void;
}

/**
 * Hybrid search result for tools
 */
export interface HybridToolResult {
  toolId: string;
  serverId: string;
  toolName: string;
  description: string;
  finalScore: number;
  schema?: { inputSchema?: Record<string, unknown> };
}

/**
 * Tool discovery interface
 *
 * Searches for relevant tools based on intent using hybrid search.
 */
export interface IToolDiscovery {
  /**
   * Search tools using hybrid semantic + graph search
   */
  searchToolsHybrid(
    intent: string,
    limit: number,
  ): Promise<HybridToolResult[]>;

  /**
   * Build tool definitions from search results
   */
  buildToolDefinitions(results: HybridToolResult[]): ToolDefinition[];
}

/**
 * Capability with full details for matching
 */
export interface CapabilityDetails {
  id: string;
  name?: string;
  codeSnippet: string;
  successRate: number;
  usageCount: number;
}

/**
 * Capability match result
 */
export interface CapabilityMatchResult {
  capability: CapabilityDetails;
  semanticScore: number;
}

/**
 * Capability matcher interface
 *
 * Searches for existing capabilities that match the intent.
 */
export interface ICapabilityMatcher {
  /**
   * Search capabilities by intent
   */
  searchByIntent(
    intent: string,
    limit: number,
    threshold: number,
  ): Promise<CapabilityMatchResult[]>;

  /**
   * Generate capability context code for injection
   */
  generateCapabilityContext(capabilities: CapabilityDetails[]): string;
}

/**
 * Execution data for graph update
 */
export interface ExecutionData {
  executionId: string;
  executedAt: Date;
  intentText: string;
  dagStructure: {
    tasks: Array<{
      id: string;
      tool: string;
      arguments: Record<string, unknown>;
      dependsOn: string[];
    }>;
  };
  success: boolean;
  executionTimeMs: number;
}

/**
 * Graph updater interface
 *
 * Updates GraphRAG with execution data for learning.
 */
export interface IGraphUpdater {
  /**
   * Update graph with execution data
   */
  updateFromExecution(data: ExecutionData): Promise<void>;
}

/**
 * Capability feedback interface
 *
 * Records feedback for adaptive threshold learning.
 */
export interface ICapabilityFeedback {
  /**
   * Record successful execution feedback
   */
  recordSuccess(intent: string, executionTimeMs: number): Promise<void>;
}

/**
 * Dependencies for ExecuteCodeUseCase
 */
export interface ExecuteCodeDependencies {
  sandbox: ISandboxExecutor;
  toolDiscovery: IToolDiscovery;
  capabilityMatcher: ICapabilityMatcher;
  graphUpdater: IGraphUpdater;
  capabilityFeedback?: ICapabilityFeedback;
  eventBus: IEventBus;
  mcpClients: Map<string, unknown>;
  toolVersions: Map<string, string>;
  /** Intent search threshold (default: 0.7) */
  intentSearchThreshold?: number;
  /** Max code size in bytes (default: 100KB) */
  maxCodeSizeBytes?: number;
}

// ============================================================================
// Use Case Implementation
// ============================================================================

/**
 * Use case for executing code in sandbox
 *
 * This is the canonical implementation for direct code execution.
 * The deprecated handler should delegate to this use case.
 */
export class ExecuteCodeUseCase {
  private readonly deps: ExecuteCodeDependencies;

  constructor(deps: ExecuteCodeDependencies) {
    this.deps = deps;
  }

  /**
   * Execute the code execution use case
   */
  async execute(
    request: ExecuteCodeRequest,
  ): Promise<UseCaseResult<ExecuteCodeResult>> {
    const { code, intent, context = {}, sandboxConfig: _sandboxConfig = {} } = request;

    // Validate code
    if (!code || code.trim().length === 0) {
      return {
        success: false,
        error: {
          code: "MISSING_CODE",
          message: "Missing required parameter: code",
        },
      };
    }

    // Validate code size
    const codeSizeBytes = new TextEncoder().encode(code).length;
    const maxSize = this.deps.maxCodeSizeBytes ?? 100 * 1024;
    if (codeSizeBytes > maxSize) {
      return {
        success: false,
        error: {
          code: "CODE_TOO_LARGE",
          message: `Code size exceeds maximum: ${codeSizeBytes} bytes (max: ${maxSize})`,
        },
      };
    }

    log.debug(`ExecuteCodeUseCase: code length=${code.length}, intent="${intent ?? "none"}"`);

    // Build execution context
    const executionContext = {
      ...context,
      intent,
    };

    // Set tool versions
    this.deps.sandbox.setToolVersions(this.deps.toolVersions);

    // Discover tools and capabilities based on intent
    let toolDefinitions: ToolDefinition[] = [];
    let matchedCapabilities: CapabilityMatchResult[] = [];
    let capabilityContext: string | undefined;

    if (intent) {
      // 1. Search for existing capabilities (capability reuse)
      try {
        const threshold = this.deps.intentSearchThreshold ?? 0.7;
        matchedCapabilities = await this.deps.capabilityMatcher.searchByIntent(
          intent,
          3,
          threshold,
        );

        if (matchedCapabilities.length > 0) {
          log.info(`Found ${matchedCapabilities.length} matching capabilities for intent`);

          // Generate capability context for injection
          const capabilities = matchedCapabilities.map((mc) => mc.capability);
          capabilityContext = this.deps.capabilityMatcher.generateCapabilityContext(capabilities);
        }
      } catch (err) {
        log.warn(`Capability search failed: ${err}`);
      }

      // 2. Search for tools via hybrid search
      try {
        const hybridResults = await this.deps.toolDiscovery.searchToolsHybrid(intent, 10);

        if (hybridResults.length > 0) {
          log.debug(`Found ${hybridResults.length} relevant tools via hybrid search`);
          toolDefinitions = this.deps.toolDiscovery.buildToolDefinitions(hybridResults);
        } else {
          log.warn("No relevant tools found for intent");
        }
      } catch (err) {
        log.warn(`Tool discovery failed: ${err}`);
      }
    }

    // Emit start event
    this.deps.eventBus.emit({
      type: "capability.start" as const,
      source: "execute-code-use-case",
      payload: {
        type: "code_execution",
        codeLength: code.length,
        intent,
        toolCount: toolDefinitions.length,
        capabilityCount: matchedCapabilities.length,
      },
    });

    // Execute in sandbox
    const startTime = performance.now();
    const workerConfig: WorkerExecutionConfig = {
      toolDefinitions,
      mcpClients: this.deps.mcpClients,
    };

    let result: SandboxExecutionResult;
    try {
      result = await this.deps.sandbox.executeWithTools(
        code,
        workerConfig,
        executionContext,
        capabilityContext,
      );
    } catch (err) {
      const executionTimeMs = performance.now() - startTime;

      this.deps.eventBus.emit({
        type: "capability.end" as const,
        source: "execute-code-use-case",
        payload: {
          type: "code_execution",
          success: false,
          executionTimeMs,
          error: err instanceof Error ? err.message : String(err),
        },
      });

      return {
        success: false,
        error: {
          code: "EXECUTION_ERROR",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }

    const executionTimeMs = performance.now() - startTime;

    // Handle execution failure
    if (!result.success) {
      this.deps.eventBus.emit({
        type: "capability.end" as const,
        source: "execute-code-use-case",
        payload: {
          type: "code_execution",
          success: false,
          executionTimeMs,
          error: result.error?.message,
        },
      });

      return {
        success: false,
        error: {
          code: "EXECUTION_FAILED",
          message: `${result.error?.type ?? "Error"}: ${result.error?.message ?? "Unknown error"}`,
        },
        data: {
          output: null,
          success: false,
          error: result.error?.message,
          metrics: {
            executionTimeMs,
            inputSizeBytes: codeSizeBytes,
            outputSizeBytes: 0,
            toolsCalledCount: 0,
          },
          mode: "sandbox",
        },
      };
    }

    // Record capability feedback
    if (this.deps.capabilityFeedback && intent) {
      try {
        await this.deps.capabilityFeedback.recordSuccess(intent, executionTimeMs);
      } catch (err) {
        log.warn(`Capability feedback failed: ${err}`);
      }
    }

    // Process tool calls and update graph
    const toolsCalled = result.toolsCalled ?? [];
    if (toolsCalled.length > 0 && intent) {
      try {
        const tracedDAG = {
          tasks: toolsCalled.map((tool, index) => ({
            id: `traced_${index}`,
            tool,
            arguments: {},
            dependsOn: index > 0 ? [`traced_${index - 1}`] : [],
          })),
        };

        await this.deps.graphUpdater.updateFromExecution({
          executionId: crypto.randomUUID(),
          executedAt: new Date(),
          intentText: intent,
          dagStructure: tracedDAG,
          success: true,
          executionTimeMs,
        });
      } catch (err) {
        log.warn(`Graph update failed: ${err}`);
      }
    }

    // Extract tool failures from traces
    const toolFailures: ToolFailure[] = [];
    if (result.traces) {
      for (const trace of result.traces) {
        if (trace.type === "tool_end" && !trace.success && trace.tool) {
          toolFailures.push({
            tool: trace.tool,
            error: trace.error ?? "Unknown error",
          });
        }
      }
    }

    // Calculate output size
    const outputSizeBytes = new TextEncoder().encode(
      JSON.stringify(result.result),
    ).length;

    // Emit success event
    this.deps.eventBus.emit({
      type: "capability.end" as const,
      source: "execute-code-use-case",
      payload: {
        type: "code_execution",
        success: true,
        executionTimeMs,
        toolsCalledCount: toolsCalled.length,
      },
    });

    log.info(`Code executed successfully in ${executionTimeMs.toFixed(0)}ms`);

    // Build result
    return {
      success: true,
      data: {
        output: result.result,
        success: true,
        metrics: {
          executionTimeMs,
          inputSizeBytes: codeSizeBytes,
          outputSizeBytes,
          toolsCalledCount: toolsCalled.length,
        },
        toolsCalled: toolsCalled.length > 0 ? toolsCalled : undefined,
        matchedCapabilities: matchedCapabilities.length > 0
          ? matchedCapabilities.map((mc) => ({
            id: mc.capability.id,
            name: mc.capability.name ?? null,
            codeSnippet: mc.capability.codeSnippet,
            semanticScore: mc.semanticScore,
            successRate: mc.capability.successRate,
            usageCount: mc.capability.usageCount,
          }))
          : undefined,
        toolFailures: toolFailures.length > 0 ? toolFailures : undefined,
        mode: "sandbox",
      },
    };
  }
}
