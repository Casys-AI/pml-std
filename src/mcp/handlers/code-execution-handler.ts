/**
 * Code Execution Handler
 *
 * Handles pml:execute_code MCP tool requests with sandbox execution,
 * tool discovery, and capability learning.
 *
 * Story 10.5: Execute code via inferred DAG for per-layer validation,
 * parallel execution, checkpoints, and SSE streaming.
 *
 * @module mcp/handlers/code-execution-handler
 */

import * as log from "@std/log";
import type { GraphRAGEngine } from "../../graphrag/graph-engine.ts";
import type { VectorSearch } from "../../vector/search.ts";
import type { CapabilityStore } from "../../capabilities/capability-store.ts";
import type { AdaptiveThresholdManager } from "../adaptive-threshold.ts";
import type { CodeExecutionRequest, CodeExecutionResponse, MCPClientBase } from "../types.ts";
import type { MCPErrorResponse, MCPToolResponse, ResolvedGatewayConfig } from "../server/types.ts";
import { ServerDefaults } from "../server/constants.ts";
import { formatMCPToolError } from "../server/responses.ts";
import { DenoSandboxExecutor, type WorkerExecutionConfig } from "../../sandbox/executor.ts";
import { ContextBuilder } from "../../sandbox/context-builder.ts";
import { CapabilityCodeGenerator } from "../../capabilities/code-generator.ts";
import { hashCode } from "../../capabilities/hash.ts";

// Story 10.5: DAG Execution imports
import { StaticStructureBuilder } from "../../capabilities/static-structure-builder.ts";
import {
  cleanupWorkerBridgeExecutor,
  type ConditionalDAGStructure,
  createToolExecutorViaWorker,
  isValidForDagConversion,
  resolveArguments,
  staticStructureToDag,
} from "../../dag/mod.ts";
// Phase 2a: DAG Optimizer
import { optimizeDAG } from "../../dag/dag-optimizer.ts";
import { generateLogicalTrace } from "../../dag/trace-generator.ts";
import { ControlledExecutor } from "../../dag/controlled-executor.ts";
import type { Task } from "../../graphrag/types.ts";
import type { TaskResult } from "../../dag/types.ts";
import type { DbClient } from "../../db/types.ts";
import {
  type DagScoringConfig,
  DEFAULT_DAG_SCORING_CONFIG,
} from "../../graphrag/dag-scoring-config.ts";
import { buildToolDefinitionsFromDAG } from "./shared/tool-definitions.ts";

/**
 * Dependencies required for code execution handler
 */
export interface CodeExecutionDependencies {
  vectorSearch: VectorSearch;
  graphEngine: GraphRAGEngine;
  mcpClients: Map<string, MCPClientBase>;
  capabilityStore?: CapabilityStore;
  adaptiveThresholdManager?: AdaptiveThresholdManager;
  config: ResolvedGatewayConfig;
  contextBuilder: ContextBuilder;
  toolSchemaCache: Map<string, string>;
  /** PGlite client for DAG checkpoints (Story 10.5) */
  db?: DbClient;
  /** Scoring config for search thresholds */
  scoringConfig?: DagScoringConfig;
}

/**
 * DAG execution mode (Story 10.5)
 *
 * - dag: Code analyzed, converted to DAG, executed via ControlledExecutor
 * - sandbox: Direct sandbox execution (fallback for non-DAG-compatible code)
 */
export type ExecutionMode = "dag" | "sandbox";

/**
 * DAG execution metadata (Story 10.5 AC8)
 *
 * Included in response when code is executed via DAG.
 */
export interface DAGExecutionMetadata {
  /** Whether DAG execution was used */
  mode: ExecutionMode;
  /** Number of tasks in the inferred DAG */
  tasksCount?: number;
  /** Number of parallel layers in the DAG */
  layersCount?: number;
  /** Speedup from parallel execution (1.0 = no speedup) */
  speedup?: number;
  /** Tools discovered in the code */
  toolsDiscovered?: string[];
}

/**
 * Handle code execution request (Story 3.4, Story 10.5)
 *
 * Supports three modes:
 * 1. DAG mode (Story 10.5): Static analysis → DAG → ControlledExecutor
 *    - Enables per-layer validation, parallel execution, checkpoints
 * 2. Intent-based: Natural language → vector search → tool injection → execute
 * 3. Explicit: Direct code execution with provided context
 *
 * @param args - Code execution arguments
 * @param deps - Handler dependencies
 * @returns Execution result with metrics
 */
export async function handleExecuteCode(
  args: unknown,
  deps: CodeExecutionDependencies,
): Promise<MCPToolResponse | MCPErrorResponse> {
  // Story 10.7: Deprecation warning
  log.warn(
    "[DEPRECATED] pml:execute_code is deprecated. Use pml:execute with code parameter for unified execution + automatic capability learning.",
  );

  try {
    const request = args as CodeExecutionRequest;

    // Validate required parameters
    if (!request.code || typeof request.code !== "string") {
      return formatMCPToolError(
        "Missing or invalid required parameter: 'code' must be a non-empty string",
      );
    }

    // Validate code size (max 100KB)
    const codeSizeBytes = new TextEncoder().encode(request.code).length;
    if (codeSizeBytes > ServerDefaults.maxCodeSizeBytes) {
      return formatMCPToolError(
        `Code size exceeds maximum: ${codeSizeBytes} bytes (max: ${ServerDefaults.maxCodeSizeBytes})`,
      );
    }

    log.info("Executing code", {
      intent: request.intent ? `"${request.intent.substring(0, 50)}..."` : "none",
      contextKeys: request.context ? Object.keys(request.context) : [],
      codeSize: codeSizeBytes,
    });

    // Story 10.5 AC2: Try DAG execution first
    const dagResult = await tryDagExecution(request, deps, codeSizeBytes);
    if (dagResult) {
      return dagResult;
    }

    // Fallback to sandbox execution (AC6: empty static_structure or analysis failure)
    log.info("[Story 10.5] Falling back to sandbox execution (no DAG-compatible structure)");
    return await executeSandboxMode(request, deps, codeSizeBytes);
  } catch (error) {
    log.error(`execute_code error: ${error}`);
    return formatMCPToolError(
      `Code execution failed: ${(error as Error).message}`,
    );
  }
}

/**
 * Try to execute code via DAG (Story 10.5)
 *
 * Steps:
 * 1. Static analysis to build StaticStructure
 * 2. Convert to DAGStructure
 * 3. Execute via ControlledExecutor
 *
 * @returns MCPToolResponse if DAG execution succeeded, null to fallback to sandbox
 */
async function tryDagExecution(
  request: CodeExecutionRequest,
  deps: CodeExecutionDependencies,
  codeSizeBytes: number,
): Promise<MCPToolResponse | MCPErrorResponse | null> {
  try {
    // Step 1: Static analysis (Story 10.1)
    // Requires DB for provides edge calculation
    if (!deps.db) {
      log.debug("[Story 10.5] No DB available for static analysis, skipping DAG mode");
      return null;
    }

    const structureBuilder = new StaticStructureBuilder(deps.db);
    const staticStructure = await structureBuilder.buildStaticStructure(request.code);

    // AC6: Check if structure is valid for DAG conversion
    if (!isValidForDagConversion(staticStructure)) {
      log.info("[Story 10.5] Static structure not valid for DAG, falling back", {
        nodeCount: staticStructure.nodes.length,
        edgeCount: staticStructure.edges.length,
      });
      return null;
    }

    // Step 2: Convert to DAG (AC1) - Logical DAG
    const logicalDAG = staticStructureToDag(staticStructure, {
      taskIdPrefix: "task_",
      includeDecisionTasks: false,
    });

    if (logicalDAG.tasks.length === 0) {
      log.info("[Story 10.5] DAG has no tasks, falling back to sandbox");
      return null;
    }

    // Phase 2a: Optimize DAG (fuse sequential pure operations)
    const optimizedDAG = optimizeDAG(logicalDAG);

    log.info("[Story 10.5] DAG inferred from static analysis + optimized", {
      logicalTasksCount: logicalDAG.tasks.length,
      physicalTasksCount: optimizedDAG.tasks.length,
      fusionRate: Math.round((1 - optimizedDAG.tasks.length / logicalDAG.tasks.length) * 100),
      tools: optimizedDAG.tasks.map((t) => t.tool),
    });

    // Step 3: Build tool definitions for WorkerBridge context (AC10)
    const toolDefs = await buildToolDefinitionsFromDAG({ tasks: optimizedDAG.tasks }, deps);

    // Step 4: Create WorkerBridge-based executor for 100% traceability (AC10)
    const [toolExecutor, executorContext] = createToolExecutorViaWorker({
      mcpClients: deps.mcpClients,
      toolDefinitions: toolDefs,
      capabilityStore: deps.capabilityStore,
      graphRAG: deps.graphEngine,
    });

    try {
      // Step 5: Execute via ControlledExecutor (AC2)
      const executor = new ControlledExecutor(toolExecutor, {
        maxConcurrency: 5,
        taskTimeout: request.sandbox_config?.timeout ?? 30000,
      });

      // Set up checkpoints if DB available
      if (deps.db) {
        executor.setCheckpointManager(deps.db, true);
      }

      // Set up learning dependencies
      if (deps.capabilityStore || deps.graphEngine) {
        executor.setLearningDependencies(deps.capabilityStore, deps.graphEngine);
      }

      const startTime = performance.now();

      // Resolve arguments before execution (AC3)
      // Story 10.2b: Include literalBindings from static analysis for variable resolution
      const executionContext = {
        parameters: request.context || {},
        // Spread literal bindings into context so resolveReference fallback can find them
        ...staticStructure.literalBindings,
      };
      const dagWithResolvedArgs = resolveDAGArguments(
        { tasks: optimizedDAG.tasks },
        executionContext,
      );

      // Execute the optimized (physical) DAG
      const physicalResults = await executor.execute(dagWithResolvedArgs);
      const executionTimeMs = performance.now() - startTime;

      // Phase 2a: Generate logical traces from physical execution
      const physicalResultsMap = new Map(
        physicalResults.results.map((r) => [r.taskId, {
          taskId: r.taskId,
          status: r.status,
          output: r.output,
          executionTimeMs: r.executionTimeMs ?? 0,
        }]),
      );

      const logicalTrace = generateLogicalTrace(optimizedDAG, physicalResultsMap);

      // Calculate output size
      const resultData = physicalResults.results
        .filter((r) => r.status === "success")
        .map((r) => r.output);
      const outputSizeBytes = new TextEncoder().encode(
        JSON.stringify(resultData),
      ).length;

      // Build DAG metadata (AC8) - report logical task count (what SHGAT sees)
      const dagMetadata: DAGExecutionMetadata = {
        mode: "dag",
        tasksCount: logicalDAG.tasks.length,
        layersCount: physicalResults.parallelizationLayers,
        speedup: executor.calculateSpeedup(physicalResults),
        toolsDiscovered: logicalTrace.executedPath, // Use logical trace for SHGAT
      };

      // Build response
      const response: CodeExecutionResponse & { dag?: DAGExecutionMetadata } = {
        result: resultData.length === 1
          ? (resultData[0] as import("../../capabilities/types.ts").JsonValue)
          : (resultData as import("../../capabilities/types.ts").JsonValue),
        logs: [],
        metrics: {
          executionTimeMs,
          inputSizeBytes: codeSizeBytes,
          outputSizeBytes,
        },
        state: request.context,
        dag: dagMetadata,
      };

      // Add any errors as tool_failures
      const failures = physicalResults.errors.map((e) => ({
        tool: e.taskId,
        error: e.error,
      }));
      if (failures.length > 0) {
        response.tool_failures = failures;
      }

      log.info("[Story 10.5] DAG execution completed via WorkerBridge + Optimizer", {
        successfulTasks: physicalResults.successfulTasks,
        failedTasks: physicalResults.failedTasks,
        logicalTasks: logicalDAG.tasks.length,
        physicalTasks: optimizedDAG.tasks.length,
        executionTimeMs: executionTimeMs.toFixed(2),
        speedup: dagMetadata.speedup?.toFixed(2),
        tracesCount: executorContext.traces.length,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(response, null, 2),
          },
        ],
      };
    } finally {
      // Cleanup WorkerBridge resources
      cleanupWorkerBridgeExecutor(executorContext);
    }
  } catch (error) {
    // Log but don't fail - fall back to sandbox
    log.warn(`[Story 10.5] DAG execution failed, falling back to sandbox: ${error}`);
    return null;
  }
}

/**
 * Resolve arguments in DAG tasks before execution (Story 10.5 AC3)
 *
 * For each task with staticArguments, resolve them to actual values using
 * the provided context parameters. Explicit arguments in task.arguments
 * take precedence over resolved staticArguments.
 *
 * @param dag - DAG structure with ConditionalTask[] containing staticArguments
 * @param context - Execution context with parameters to resolve references
 * @returns DAGStructure with resolved arguments ready for execution
 *
 * @example
 * ```typescript
 * const resolved = resolveDAGArguments(dag, {
 *   parameters: { userId: "123", fileName: "test.txt" }
 * });
 * // Task with staticArguments: { path: { type: "parameter", ref: "fileName" } }
 * // becomes: { path: "test.txt" }
 * ```
 */
function resolveDAGArguments(
  dag: ConditionalDAGStructure,
  context: { parameters?: Record<string, unknown> },
): import("../../graphrag/types.ts").DAGStructure {
  const previousResults = new Map<string, TaskResult>();

  // Convert ConditionalTask[] to Task[] with resolved arguments
  const tasks: Task[] = dag.tasks.map((task) => {
    const resolved = resolveArguments(
      task.staticArguments,
      context,
      previousResults,
    );

    return {
      ...task,
      arguments: {
        ...resolved,
        ...task.arguments, // Explicit arguments take precedence
      },
    };
  });

  return { tasks };
}

/**
 * Execute code in sandbox mode (fallback)
 *
 * Original execution path when DAG cannot be inferred.
 */
async function executeSandboxMode(
  request: CodeExecutionRequest,
  deps: CodeExecutionDependencies,
  codeSizeBytes: number,
): Promise<MCPToolResponse | MCPErrorResponse> {
  // Build execution context (for non-tool variables)
  // Story 8.3: Include intent in context for capability learning
  const executionContext = {
    ...request.context,
    intent: request.intent,
  };

  // Configure sandbox
  const sandboxConfig = request.sandbox_config || {};
  const executor = new DenoSandboxExecutor({
    timeout: sandboxConfig.timeout ?? 30000,
    memoryLimit: sandboxConfig.memoryLimit ?? 512,
    allowedReadPaths: sandboxConfig.allowedReadPaths ?? [],
    piiProtection: deps.config.piiProtection,
    cacheConfig: deps.config.cacheConfig,
    // Story 8.3: Enable capability learning from code execution
    capabilityStore: deps.capabilityStore,
    graphRAG: deps.graphEngine,
  });

  // Set tool versions for cache key generation (Story 3.7)
  const toolVersions = buildToolVersionsMap(deps.toolSchemaCache);
  executor.setToolVersions(toolVersions);

  // Story 7.1b: Use Worker RPC Bridge for tool execution with native tracing
  let toolDefinitions: import("../../sandbox/types.ts").ToolDefinition[] = [];
  let toolsCalled: string[] = [];
  let matchedCapabilities: Array<{
    capability: import("../../capabilities/types.ts").Capability;
    semanticScore: number;
  }> = [];

  // Capability context for injection (Story 8.3)
  let capabilityContext: string | undefined;

  // Intent-based mode: discover tools AND existing capabilities
  if (request.intent) {
    log.debug("Intent-based mode: discovering relevant tools and capabilities");

    // 1. Search for existing capabilities (Story 8.3: capability reuse)
    if (deps.capabilityStore) {
      try {
        const intentSearchThreshold = deps.scoringConfig?.thresholds.intentSearch ??
          DEFAULT_DAG_SCORING_CONFIG.thresholds.intentSearch;
        matchedCapabilities = await deps.capabilityStore.searchByIntent(
          request.intent,
          3,
          intentSearchThreshold,
        );
        if (matchedCapabilities.length > 0) {
          log.info(`Found ${matchedCapabilities.length} matching capabilities for intent`, {
            topMatch: matchedCapabilities[0].capability.name,
            topScore: matchedCapabilities[0].semanticScore.toFixed(2),
          });

          // Generate capability context for sandbox injection
          const codeGenerator = new CapabilityCodeGenerator();
          const capabilities = matchedCapabilities.map((mc) => mc.capability);
          capabilityContext = codeGenerator.buildCapabilitiesObject(capabilities);

          log.info("[execute_code] Capability context generated", {
            capabilitiesInjected: matchedCapabilities.length,
            capabilityNames: matchedCapabilities.map((c) => c.capability.name),
            contextCodeLength: capabilityContext.length,
          });
        }
      } catch (capError) {
        log.warn(`Capability search failed: ${capError}`);
      }
    }

    // 2. Use hybrid search for tools (ADR-022)
    const hybridResults = await deps.graphEngine.searchToolsHybrid(
      deps.vectorSearch,
      request.intent,
      10,
      [],
      false,
    );

    if (hybridResults.length > 0) {
      log.debug(`Found ${hybridResults.length} relevant tools via hybrid search`);

      // Convert HybridSearchResult to SearchResult format for buildToolDefinitions
      const toolResults = hybridResults.map((hr) => ({
        toolId: hr.toolId,
        serverId: hr.serverId,
        toolName: hr.toolName,
        score: hr.finalScore,
        schema: {
          name: hr.toolName,
          description: hr.description,
          inputSchema: (hr.schema?.inputSchema || {}) as Record<string, unknown>,
        },
      }));

      // Build tool definitions for Worker RPC bridge
      toolDefinitions = deps.contextBuilder.buildToolDefinitions(toolResults);
    } else {
      log.warn("No relevant tools found for intent via hybrid search");
    }
  }

  // Execute code using Worker RPC bridge (Story 7.1b)
  const startTime = performance.now();
  const workerConfig: WorkerExecutionConfig = {
    toolDefinitions,
    mcpClients: deps.mcpClients,
  };

  const result = await executor.executeWithTools(
    request.code,
    workerConfig,
    executionContext,
    capabilityContext,
  );
  const executionTimeMs = performance.now() - startTime;

  // Handle capability feedback (Story 7.3a / AC6)
  if (deps.capabilityStore && deps.adaptiveThresholdManager && result.success) {
    await recordCapabilityFeedback(
      request,
      executionTimeMs,
      deps.capabilityStore,
      deps.adaptiveThresholdManager,
    );
  }

  // Handle execution failure
  if (!result.success) {
    const error = result.error!;
    return formatMCPToolError(
      `Code execution failed: ${error.type} - ${error.message}`,
      {
        error_type: error.type,
        error_message: error.message,
        stack: error.stack,
        executionTimeMs: executionTimeMs,
      },
    );
  }

  // Story 7.1b: Process native traces
  let trackedToolsCount = 0;
  if (result.toolsCalled && result.toolsCalled.length > 0) {
    toolsCalled = result.toolsCalled;
    log.info(`[Story 7.1b] Tracked ${toolsCalled.length} tool calls via native tracing`, {
      tools: toolsCalled,
    });

    // Build WorkflowExecution from traced tool calls
    const tracedDAG = {
      tasks: toolsCalled.map((tool, index) => ({
        id: `traced_${index}`,
        tool,
        arguments: {},
        dependsOn: index > 0 ? [`traced_${index - 1}`] : [],
      })),
    };

    // Update GraphRAG with execution data
    await deps.graphEngine.updateFromExecution({
      executionId: crypto.randomUUID(),
      executedAt: new Date(),
      intentText: request.intent ?? "code_execution",
      dagStructure: tracedDAG,
      success: true,
      executionTimeMs: executionTimeMs,
    });

    trackedToolsCount = toolsCalled.length;
  }

  // Log native trace stats
  if (result.traces && result.traces.length > 0) {
    log.debug(`[Story 7.1b] Captured ${result.traces.length} native trace events`);
  }

  // ADR-043: Extract failed tools from traces
  const toolFailures: Array<{ tool: string; error: string }> = [];
  if (result.traces) {
    for (const trace of result.traces) {
      if (trace.type === "tool_end" && !trace.success && "tool" in trace) {
        const toolTrace = trace as { tool: string; error?: string };
        toolFailures.push({
          tool: toolTrace.tool,
          error: toolTrace.error ?? "Unknown error",
        });
      }
    }
    if (toolFailures.length > 0) {
      log.warn(`[ADR-043] ${toolFailures.length} tool(s) failed during execution`, {
        failedTools: toolFailures.map((f) => f.tool),
      });
    }
  }

  // Calculate output size
  const outputSizeBytes = new TextEncoder().encode(
    JSON.stringify(result.result),
  ).length;

  // Build response
  const response: CodeExecutionResponse = {
    result: result.result ?? null,
    logs: [],
    metrics: {
      executionTimeMs: result.executionTimeMs,
      inputSizeBytes: codeSizeBytes,
      outputSizeBytes,
    },
    state: executionContext,
    matched_capabilities: matchedCapabilities.length > 0
      ? matchedCapabilities.map((mc) => ({
        id: mc.capability.id,
        name: mc.capability.name ?? null,
        code_snippet: mc.capability.codeSnippet,
        semantic_score: mc.semanticScore,
        success_rate: mc.capability.successRate,
        usage_count: mc.capability.usageCount,
      }))
      : undefined,
    tool_failures: toolFailures.length > 0 ? toolFailures : undefined,
  };

  log.info("Code execution succeeded", {
    executionTimeMs: response.metrics.executionTimeMs.toFixed(2),
    outputSize: outputSizeBytes,
    trackedTools: trackedToolsCount,
    matchedCapabilities: matchedCapabilities.length,
  });

  // Story 10.5: Add DAG metadata for sandbox fallback mode
  const responseWithDag: CodeExecutionResponse & { dag?: DAGExecutionMetadata } = {
    ...response,
    dag: {
      mode: "sandbox" as ExecutionMode,
    },
  };

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(responseWithDag, null, 2),
      },
    ],
  };
}

/**
 * Record capability feedback for adaptive learning (Story 7.3a)
 */
async function recordCapabilityFeedback(
  request: CodeExecutionRequest,
  executionTimeMs: number,
  capabilityStore: CapabilityStore,
  adaptiveThresholdManager: AdaptiveThresholdManager,
): Promise<void> {
  try {
    const codeHash = await hashCode(request.code);
    const capability = await capabilityStore.findByCodeHash(codeHash);

    if (capability) {
      // Update usage stats
      await capabilityStore.updateUsage(codeHash, true, executionTimeMs);

      // Record execution for adaptive learning
      const confidence = capability.successRate;

      adaptiveThresholdManager.recordExecution({
        mode: "speculative",
        confidence: confidence,
        success: true,
        executionTime: executionTimeMs,
        timestamp: Date.now(),
      });

      log.info(`[Story 7.3a] Capability feedback recorded`, { id: capability.id });
    }
  } catch (err) {
    log.warn(`[Story 7.3a] Failed to record capability feedback: ${err}`);
  }
}

/**
 * Build tool versions map for cache key generation (Story 3.7)
 */
function buildToolVersionsMap(toolSchemaCache: Map<string, string>): Record<string, string> {
  const versions: Record<string, string> = {};
  for (const [toolKey, schemaHash] of toolSchemaCache.entries()) {
    versions[toolKey] = schemaHash;
  }
  return versions;
}
