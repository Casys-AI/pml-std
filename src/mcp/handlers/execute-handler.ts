/**
 * Execute Handler (Story 10.7)
 *
 * Unified execution API: `pml_execute`
 *
 * Two modes:
 * - **Direct** (`intent + code`): Execute code → Create capability with trace
 * - **Suggestion** (`intent` only): DR-DSP search → Execute if confident, else suggestions
 *
 * Key differences from pml_execute_code:
 * - Mode Direct always creates capability after successful execution
 * - Mode Suggestion reuses existing capabilities (no new capability created)
 * - DR-DSP for hypergraph pathfinding (replaces Dijkstra)
 * - SHGAT for context-free capability scoring
 *
 * @module mcp/handlers/execute-handler
 */

import * as log from "@std/log";
import type { MCPErrorResponse, MCPToolResponse, ResolvedGatewayConfig } from "../server/types.ts";
import type { MCPClientBase } from "../types.ts";
import type { GraphRAGEngine } from "../../graphrag/graph-engine.ts";
import type { VectorSearch } from "../../vector/search.ts";
import type { CapabilityStore } from "../../capabilities/capability-store.ts";
import type { AdaptiveThresholdManager } from "../adaptive-threshold.ts";
import type { PGliteClient } from "../../db/client.ts";
import type { ContextBuilder } from "../../sandbox/context-builder.ts";
import type { DRDSP } from "../../graphrag/algorithms/dr-dsp.ts";
import type { SHGAT } from "../../graphrag/algorithms/shgat.ts";
import type { JsonValue, TraceTaskResult } from "../../capabilities/types.ts";
import type { DagScoringConfig } from "../../graphrag/dag-scoring-config.ts";
import type { EmbeddingModelInterface } from "../../vector/embeddings.ts";

import { formatMCPToolError } from "../server/responses.ts";
import { ServerDefaults } from "../server/constants.ts";
import { StaticStructureBuilder } from "../../capabilities/static-structure-builder.ts";
// DenoSandboxExecutor removed - no fallback, code must produce valid DAG
import { addBreadcrumb, startTransaction } from "../../telemetry/sentry.ts";

// Story 10.5: DAG Execution imports
import {
  cleanupWorkerBridgeExecutor,
  createToolExecutorViaWorker,
  isValidForDagConversion,
  staticStructureToDag,
} from "../../dag/mod.ts";
import { ControlledExecutor } from "../../dag/controlled-executor.ts";
import type { CheckpointManager } from "../../dag/checkpoint-manager.ts";
import { handleWorkflowExecution } from "./workflow-execution-handler.ts";
import type { WorkflowHandlerDependencies } from "./workflow-handler-types.ts";
import { buildToolDefinitionsFromStaticStructure } from "./shared/tool-definitions.ts";

/**
 * Dependencies required for execute handler
 */
export interface ExecuteDependencies {
  vectorSearch: VectorSearch;
  graphEngine: GraphRAGEngine;
  mcpClients: Map<string, MCPClientBase>;
  capabilityStore: CapabilityStore;
  adaptiveThresholdManager?: AdaptiveThresholdManager;
  config: ResolvedGatewayConfig;
  contextBuilder: ContextBuilder;
  toolSchemaCache: Map<string, string>;
  db: PGliteClient;
  scoringConfig?: DagScoringConfig;
  /** DR-DSP instance for hypergraph pathfinding (Story 10.7a) */
  drdsp?: DRDSP;
  /** SHGAT instance for context-free scoring (Story 10.7b) */
  shgat?: SHGAT;
  /** Embedding model for SHGAT intent scoring */
  embeddingModel?: EmbeddingModelInterface;
  /** Checkpoint manager for per-layer validation (AC7) */
  checkpointManager?: CheckpointManager;
  /** Workflow handler deps for per_layer_validation delegation (AC7) */
  workflowDeps?: WorkflowHandlerDependencies;
}

/**
 * Execute request arguments
 */
export interface ExecuteArgs {
  /** Natural language description of the intent (REQUIRED) */
  intent: string;
  /** TypeScript code to execute (OPTIONAL - triggers Mode Direct) */
  code?: string;
  /** Execution options */
  options?: {
    timeout?: number;
    per_layer_validation?: boolean;
  };
}

/**
 * Execute response format
 */
export interface ExecuteResponse {
  status: "success" | "approval_required" | "suggestions";

  // Mode success
  result?: JsonValue;
  capabilityId?: string;
  /** "direct" = code provided, "speculation" = capability reused (Epic-12, disabled) */
  mode?: "direct" | "speculation";
  executionTimeMs?: number;

  // Mode approval_required (per-layer validation)
  workflowId?: string;
  checkpointId?: string;
  pendingLayer?: number;
  layerResults?: unknown[];

  // Mode suggestions (low confidence)
  suggestions?: {
    suggestedDag?: { tasks: unknown[] };
    confidence: number;
    tools?: Array<{
      id: string;
      name: string;
      description: string;
      input_schema?: Record<string, unknown>;
      score: number;
    }>;
    capabilities?: Array<{
      id: string;
      name: string;
      description: string;
      score: number;
    }>;
  };

  // Errors
  tool_failures?: Array<{ tool: string; error: string }>;

  // DAG metadata
  dag?: {
    mode: "dag" | "sandbox";
    tasksCount?: number;
    layersCount?: number;
    speedup?: number;
    toolsDiscovered?: string[];
  };
}

/**
 * Handle pml:execute request (Story 10.7)
 *
 * Unified execution API with two modes:
 * - **Direct** (intent + code): Execute → Create capability with trace
 * - **Suggestion** (intent only): DR-DSP → Execute or return suggestions
 *
 * @param args - Execute arguments (intent required, code optional)
 * @param deps - Handler dependencies
 * @returns Execution result or suggestions
 */
export async function handleExecute(
  args: unknown,
  deps: ExecuteDependencies,
): Promise<MCPToolResponse | MCPErrorResponse> {
  const transaction = startTransaction("mcp.execute", "mcp");
  const startTime = performance.now();

  try {
    const params = args as ExecuteArgs;

    // Validate required intent parameter
    if (!params.intent || typeof params.intent !== "string" || !params.intent.trim()) {
      transaction.finish();
      return formatMCPToolError(
        "Missing or empty required parameter: 'intent' must be a non-empty string",
      );
    }

    const intent = params.intent.trim();
    const code = params.code?.trim();
    const options = params.options ?? {};

    transaction.setData("intent", intent.substring(0, 100));
    transaction.setData("mode", code ? "direct" : "suggestion");
    addBreadcrumb("mcp", "Processing execute request", {
      intent: intent.substring(0, 50),
      hasCode: !!code,
    });

    log.info(
      `pml:execute: intent="${intent.substring(0, 50)}...", mode=${code ? "direct" : "suggestion"}`,
    );

    // Route to appropriate mode
    if (code) {
      // Mode Direct: Execute code → Create capability
      const result = await executeDirectMode(intent, code, options, deps, startTime);
      transaction.finish();
      return result;
    } else {
      // Mode Suggestion: DR-DSP → Execute or suggestions
      const result = await executeSuggestionMode(intent, options, deps, startTime);
      transaction.finish();
      return result;
    }
  } catch (error) {
    log.error(`pml:execute error: ${error}`);
    transaction.finish();
    return formatMCPToolError(
      `Execution failed: ${(error as Error).message}`,
    );
  }
}

/**
 * Mode Direct: Execute code and create capability
 *
 * Flow:
 * 1. Validate code size
 * 2. Static analysis via StaticStructureBuilder
 * 3. Execute via WorkerBridge
 * 4. Create capability with traceData (Unit of Work pattern)
 *
 * @param intent - Natural language description
 * @param code - TypeScript code to execute
 * @param options - Execution options
 * @param deps - Dependencies
 * @param startTime - Start timestamp for metrics
 */
async function executeDirectMode(
  intent: string,
  code: string,
  options: ExecuteArgs["options"],
  deps: ExecuteDependencies,
  startTime: number,
): Promise<MCPToolResponse | MCPErrorResponse> {
  // Validate code size
  const codeSizeBytes = new TextEncoder().encode(code).length;
  if (codeSizeBytes > ServerDefaults.maxCodeSizeBytes) {
    return formatMCPToolError(
      `Code size exceeds maximum: ${codeSizeBytes} bytes (max: ${ServerDefaults.maxCodeSizeBytes})`,
    );
  }

  const perLayerValidation = options?.per_layer_validation === true;

  log.info("[pml:execute] Mode Direct - executing code", {
    codeSize: codeSizeBytes,
    intent: intent.substring(0, 50),
    perLayerValidation,
  });

  // Step 1: Static analysis via SWC (before execution)
  const structureBuilder = new StaticStructureBuilder(deps.db);
  const staticStructure = await structureBuilder.buildStaticStructure(code);

  log.debug("[pml:execute] Static structure built", {
    nodeCount: staticStructure.nodes.length,
    edgeCount: staticStructure.edges.length,
  });

  // Step 2: Build tool definitions for discovered tools
  const toolDefs = await buildToolDefinitionsFromStaticStructure(staticStructure, deps);

  // Step 3: Create WorkerBridge executor
  const [toolExecutor, executorContext] = createToolExecutorViaWorker({
    mcpClients: deps.mcpClients,
    toolDefinitions: toolDefs,
    capabilityStore: deps.capabilityStore,
    graphRAG: deps.graphEngine,
  });

  try {
    // Step 4: Check if we can convert to DAG for ControlledExecutor
    if (isValidForDagConversion(staticStructure)) {
      // Convert static structure to DAG
      const dag = staticStructureToDag(staticStructure, {
        taskIdPrefix: "task_",
        includeDecisionTasks: false,
      });

      if (dag.tasks.length > 0) {
        log.info("[pml:execute] Executing via ControlledExecutor (DAG mode)", {
          tasksCount: dag.tasks.length,
          tools: dag.tasks.map((t) => t.tool),
          perLayerValidation,
        });

        // Create ControlledExecutor
        const controlledExecutor = new ControlledExecutor(toolExecutor, {
          maxConcurrency: 5,
          taskTimeout: options?.timeout ?? 30000,
        });

        // Set up checkpoint manager for per-layer validation
        if (deps.checkpointManager) {
          controlledExecutor.setCheckpointManager(deps.db, true);
        }

        // Set up learning dependencies
        if (deps.capabilityStore || deps.graphEngine) {
          controlledExecutor.setLearningDependencies(deps.capabilityStore, deps.graphEngine);
        }

        // AC7: Per-layer validation - delegate to workflow-handler
        if (perLayerValidation) {
          if (!deps.workflowDeps) {
            return formatMCPToolError(
              "per_layer_validation requires workflowDeps. " +
                "Ensure gateway is properly configured.",
            );
          }

          log.info("[pml:execute] per_layer_validation: delegating to workflow-handler", {
            tasksCount: dag.tasks.length,
            tools: dag.tasks.map((t) => t.tool),
          });

          // Delegate to handleWorkflowExecution with the inferred DAG
          return await handleWorkflowExecution(
            {
              workflow: dag,
              intent,
              config: { per_layer_validation: true },
            },
            deps.workflowDeps,
          );
        }

        // Execute full DAG via ControlledExecutor
        const executionResult = await controlledExecutor.execute(dag);
        const executionTimeMs = performance.now() - startTime;

        // Extract tool calls from results
        const toolsCalled = executionResult.results
          .filter((r) => r.status === "success")
          .map((r) => dag.tasks.find((t) => t.id === r.taskId)?.tool ?? "unknown");

        // Build task results for trace
        const taskResults: TraceTaskResult[] = executionResult.results.map((r) => {
          const task = dag.tasks.find((t) => t.id === r.taskId);
          return {
            taskId: r.taskId,
            tool: task?.tool ?? "unknown",
            args: (task?.arguments ?? {}) as Record<string, JsonValue>,
            result: r.output as JsonValue ?? null,
            success: r.status === "success",
            durationMs: r.executionTimeMs ?? 0,
          };
        });

        // Handle execution failure
        if (executionResult.failedTasks > 0 && executionResult.successfulTasks === 0) {
          const firstError = executionResult.errors[0];
          return formatMCPToolError(
            `DAG execution failed: ${firstError?.error ?? "Unknown error"}`,
            {
              failedTasks: executionResult.failedTasks,
              errors: executionResult.errors,
              executionTimeMs,
            },
          );
        }

        // Create capability with trace data
        const { capability, trace } = await deps.capabilityStore.saveCapability({
          code,
          intent,
          durationMs: Math.round(executionTimeMs),
          success: executionResult.failedTasks === 0,
          toolsUsed: toolsCalled,
          traceData: {
            executedPath: toolsCalled,
            taskResults,
            decisions: [],
            initialContext: { intent },
          },
        });

        // Update DR-DSP with new capability
        updateDRDSP(deps.drdsp, capability, staticStructure);

        // Update SHGAT with new capability (Story 10.7: live learning)
        const wasSuccessful = executionResult.failedTasks === 0;
        await updateSHGAT(deps.shgat, deps.embeddingModel, capability, toolsCalled, intent, wasSuccessful);

        // Build response
        const successOutputs = executionResult.results
          .filter((r) => r.status === "success")
          .map((r) => r.output);

        const response: ExecuteResponse = {
          status: "success",
          result: (successOutputs.length === 1 ? successOutputs[0] : successOutputs) as JsonValue,
          capabilityId: capability.id,
          mode: "direct",
          executionTimeMs,
          dag: {
            mode: "dag",
            tasksCount: dag.tasks.length,
            layersCount: executionResult.parallelizationLayers,
            speedup: controlledExecutor.calculateSpeedup(executionResult),
            toolsDiscovered: toolsCalled,
          },
        };

        // Add tool failures if any
        if (executionResult.failedTasks > 0) {
          response.tool_failures = executionResult.errors.map((e) => ({
            tool: e.taskId,
            error: e.error,
          }));
        }

        log.info("[pml:execute] Mode Direct completed (ControlledExecutor)", {
          capabilityId: capability.id,
          traceId: trace?.id,
          executionTimeMs: executionTimeMs.toFixed(2),
          toolsCalled: toolsCalled.length,
          layers: executionResult.parallelizationLayers,
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify(response, null, 2),
          }],
        };
      }
    }

    // NO FALLBACK - Code must be parseable as a valid DAG
    // If static analysis didn't find MCP tools, reject the code
    log.error(
      "[pml:execute] Code cannot be converted to DAG - no MCP tools found in static structure",
    );

    return formatMCPToolError(
      "Code must use MCP tools (e.g., mcp.server.tool()) to be executable. " +
        "No valid DAG could be created from the provided code.",
      {
        hint:
          "Ensure your code calls MCP tools like: const result = await mcp.filesystem.read_file({ path: '...' });",
        staticStructure: staticStructure
          ? {
            nodes: staticStructure.nodes?.length ?? 0,
            edges: staticStructure.edges?.length ?? 0,
          }
          : null,
      },
    );
  } finally {
    cleanupWorkerBridgeExecutor(executorContext);
  }
}

/**
 * Update DR-DSP with a newly created capability
 */
function updateDRDSP(
  drdsp: DRDSP | undefined,
  capability: { id: string; successRate: number },
  staticStructure: { nodes: Array<{ type: string; tool?: string }> },
): void {
  if (!drdsp || staticStructure.nodes.length === 0) return;

  try {
    const tools = staticStructure.nodes
      .filter((n): n is typeof n & { type: "task"; tool: string } => n.type === "task")
      .map((n) => n.tool);

    // Hyperedge: sources (prerequisites) → targets (what it provides)
    drdsp.applyUpdate({
      type: "edge_add",
      hyperedgeId: `cap__${capability.id}`,
      newEdge: {
        id: `cap__${capability.id}`,
        sources: tools.length > 0 ? [tools[0]] : ["intent"],
        targets: tools.length > 1 ? tools.slice(1) : [`cap__${capability.id}`],
        weight: 1.0 - capability.successRate,
        metadata: {
          capabilityId: capability.id,
          tools,
          successRate: capability.successRate,
        },
      },
    });
    log.debug("[pml:execute] DR-DSP updated with new capability", { capabilityId: capability.id });
  } catch (error) {
    log.warn("[pml:execute] Failed to update DR-DSP", { error: String(error) });
  }
}

/**
 * Update SHGAT with new capability and train on trace (live learning)
 *
 * 1. Registers the capability and any new tools
 * 2. Trains SHGAT on the execution outcome (success/failure)
 */
async function updateSHGAT(
  shgat: SHGAT | undefined,
  embeddingModel: EmbeddingModelInterface | undefined,
  capability: { id: string; toolsUsed?: string[]; successRate: number },
  toolsCalled: string[],
  intent: string,
  success: boolean = true,
): Promise<void> {
  if (!shgat || !embeddingModel) {
    log.debug("[pml:execute] SHGAT or embeddingModel not available - skipping SHGAT update");
    return;
  }

  try {
    // Generate embedding for the capability from intent
    const embedding = await embeddingModel.encode(intent);

    // Register any new tools (with generated embeddings)
    for (const toolId of toolsCalled) {
      if (!shgat.hasToolNode(toolId)) {
        // Generate tool embedding from tool ID
        const toolEmbedding = await embeddingModel.encode(toolId.replace(":", " "));
        shgat.registerTool({ id: toolId, embedding: toolEmbedding });
        log.debug("[pml:execute] SHGAT: registered new tool", { toolId });
      }
    }

    // Register the capability
    shgat.registerCapability({
      id: capability.id,
      embedding,
      toolsUsed: capability.toolsUsed ?? toolsCalled,
      successRate: capability.successRate,
      parents: [],
      children: [],
    });

    // Train SHGAT on this trace (online learning)
    const trainingExample = {
      intentEmbedding: embedding,
      contextTools: toolsCalled,
      candidateId: capability.id,
      outcome: success ? 1 : 0,
    };

    // Single-example training (online learning)
    shgat.trainOnExample(trainingExample);

    log.info("[pml:execute] SHGAT updated and trained", {
      capabilityId: capability.id,
      toolsCount: toolsCalled.length,
      outcome: success ? "success" : "failure",
    });
  } catch (error) {
    log.warn("[pml:execute] Failed to update SHGAT", { error: String(error) });
  }
}

/**
 * Mode Suggestion: Use DR-DSP to find capability or return suggestions
 *
 * Flow:
 * 1. DR-DSP.findShortestHyperpath() for capability search
 * 2. SHGAT scoring for confidence
 * 3. If high confidence + canSpeculate() → Execute capability
 * 4. Else → Return suggestions with tools + capabilities
 *
 * @param intent - Natural language description
 * @param options - Execution options
 * @param deps - Dependencies
 * @param startTime - Start timestamp for metrics
 */
async function executeSuggestionMode(
  intent: string,
  _options: ExecuteArgs["options"], // Reserved for Epic-12 speculation
  deps: ExecuteDependencies,
  startTime: number,
): Promise<MCPToolResponse | MCPErrorResponse> {
  log.info("[pml:execute] Mode Suggestion - SHGAT + DR-DSP search", {
    intent: intent.substring(0, 50),
    hasSHGAT: !!deps.shgat,
    hasDRDSP: !!deps.drdsp,
  });

  // Speculation thresholds - use adaptive threshold if available
  const adaptiveThresholds = deps.adaptiveThresholdManager?.getThresholds();
  const SPECULATION_SCORE_THRESHOLD = adaptiveThresholds?.suggestionThreshold ?? 0.7;
  const SPECULATION_SUCCESS_RATE_THRESHOLD = 0.8;

  // =========================================================================
  // PHASE 1: SHGAT scores all capabilities and tools
  // =========================================================================
  if (!deps.shgat || !deps.embeddingModel) {
    log.warn("[pml:execute] SHGAT or embeddingModel not available - cannot score");
    return {
      content: [{
        type: "text",
        text: JSON.stringify(
          {
            status: "suggestions",
            suggestions: { tools: [], capabilities: [], confidence: 0 },
            executionTimeMs: performance.now() - startTime,
          } as ExecuteResponse,
          null,
          2,
        ),
      }],
    };
  }

  // Generate intent embedding
  const intentEmbedding = await deps.embeddingModel.encode(intent);
  if (!intentEmbedding || intentEmbedding.length === 0) {
    log.error("[pml:execute] Failed to generate intent embedding");
    return formatMCPToolError("Failed to generate intent embedding");
  }

  // Score all capabilities and tools with SHGAT
  const shgatCapabilities = deps.shgat.scoreAllCapabilities(intentEmbedding);
  const shgatTools = deps.shgat.scoreAllTools(intentEmbedding);

  log.debug("[pml:execute] SHGAT scored", {
    capabilitiesCount: shgatCapabilities.length,
    toolsCount: shgatTools.length,
    topCapabilities: shgatCapabilities.slice(0, 3).map((r) => ({
      id: r.capabilityId,
      score: r.score.toFixed(3),
    })),
    topTools: shgatTools.slice(0, 3).map((r) => ({ id: r.toolId, score: r.score.toFixed(3) })),
  });

  if (shgatCapabilities.length === 0) {
    log.info("[pml:execute] No capabilities found - returning tool suggestions");
    const suggestions = await getSuggestions(deps, { shgatCapabilities, shgatTools });
    return {
      content: [{
        type: "text",
        text: JSON.stringify(
          {
            status: "suggestions",
            suggestions: { ...suggestions, confidence: 0 },
            executionTimeMs: performance.now() - startTime,
          } as ExecuteResponse,
          null,
          2,
        ),
      }],
    };
  }

  // Best capability is first (sorted by score)
  const bestMatch = shgatCapabilities[0];

  // =========================================================================
  // PHASE 2: Fetch capability and check thresholds
  // =========================================================================
  const capability = await deps.capabilityStore.findById(bestMatch.capabilityId);

  if (!capability) {
    log.warn("[pml:execute] Best capability not found in store", { id: bestMatch.capabilityId });
    // Still pass bestMatch for DR-DSP backward attempt (may have partial data)
    const suggestions = await getSuggestions(deps, { shgatCapabilities, shgatTools }, {
      id: bestMatch.capabilityId,
      score: bestMatch.score,
    });
    return {
      content: [{
        type: "text",
        text: JSON.stringify(
          {
            status: "suggestions",
            suggestions: { ...suggestions, confidence: bestMatch.score },
            executionTimeMs: performance.now() - startTime,
          } as ExecuteResponse,
          null,
          2,
        ),
      }],
    };
  }

  log.debug("[pml:execute] Capability found", {
    capabilityId: capability.id,
    shgatScore: bestMatch.score,
    successRate: capability.successRate,
  });

  // Check if we can speculate (execute without explicit approval)
  const canSpeculate = bestMatch.score >= SPECULATION_SCORE_THRESHOLD &&
    capability.successRate >= SPECULATION_SUCCESS_RATE_THRESHOLD;

  if (canSpeculate) {
    // =========================================================================
    // PHASE 3 (optional): DR-DSP validates path if available
    // =========================================================================
    if (deps.drdsp && capability.toolsUsed && capability.toolsUsed.length > 1) {
      const startTool = capability.toolsUsed[0];
      const endTool = capability.toolsUsed[capability.toolsUsed.length - 1];
      const pathResult = deps.drdsp.findShortestHyperpath(startTool, endTool);

      log.debug("[pml:execute] DR-DSP path validation", {
        from: startTool,
        to: endTool,
        found: pathResult.found,
        weight: pathResult.found ? pathResult.totalWeight : null,
      });
    }

    // TODO(Epic-12): Speculative execution disabled - no context/cache for argument resolution
    // When we have runtime argument binding (parameterized capabilities), we can enable this.
    // For now, return suggestions so the agent can adapt the code to the new intent.
    log.info("[pml:execute] High confidence match found, but speculation disabled (Epic-12)", {
      capabilityId: capability.id,
      shgatScore: bestMatch.score,
      successRate: capability.successRate,
    });

    // Return as suggestion instead of executing
    const suggestions = await getSuggestions(deps, { shgatCapabilities, shgatTools }, {
      id: bestMatch.capabilityId,
      score: bestMatch.score,
    });

    const response: ExecuteResponse = {
      status: "suggestions",
      suggestions: {
        ...suggestions,
        confidence: bestMatch.score,
      },
      executionTimeMs: performance.now() - startTime,
    };

    return {
      content: [{
        type: "text",
        text: JSON.stringify(response, null, 2),
      }],
    };
  }

  // Low confidence → Return suggestions with DR-DSP backward pathfinding
  log.info("[pml:execute] Low confidence - returning suggestions with DR-DSP backward", {
    shgatScore: bestMatch.score,
    successRate: capability.successRate,
    thresholds: {
      score: SPECULATION_SCORE_THRESHOLD,
      successRate: SPECULATION_SUCCESS_RATE_THRESHOLD,
    },
  });

  // Pass bestMatch to getSuggestions for DR-DSP backward pathfinding
  const suggestions = await getSuggestions(deps, { shgatCapabilities, shgatTools }, {
    id: bestMatch.capabilityId,
    score: bestMatch.score,
  });

  const response: ExecuteResponse = {
    status: "suggestions",
    suggestions: {
      ...suggestions,
      confidence: bestMatch.score,
    },
    executionTimeMs: performance.now() - startTime,
  };

  return {
    content: [{
      type: "text",
      text: JSON.stringify(response, null, 2),
    }],
  };
}

// TODO(Epic-12): executeCapability function removed - speculative execution disabled
// until we have runtime argument binding (parameterized capabilities).
// The static_structure has hardcoded arguments from the original execution.
// See: docs/sprint-artifacts/10-7-pml-execute-api.md for Epic-12 roadmap.

/**
 * Get suggestions from SHGAT results
 *
 * Uses SHGAT scores for tools/capabilities + DR-DSP backward for suggestedDag.
 * NO FALLBACKS - pure SHGAT + DR-DSP.
 */
async function getSuggestions(
  deps: ExecuteDependencies,
  shgatResults: {
    shgatCapabilities: Array<{ capabilityId: string; score: number }>;
    shgatTools: Array<{ toolId: string; score: number }>;
  },
  bestCapability?: { id: string; score: number },
): Promise<{
  tools?: Array<
    {
      id: string;
      name: string;
      description: string;
      input_schema?: Record<string, unknown>;
      score: number;
    }
  >;
  capabilities?: Array<{ id: string; name: string; description: string; score: number }>;
  suggestedDag?: { tasks: Array<{ id: string; tool: string; dependsOn: string[] }> };
}> {
  // Build tool suggestions from SHGAT scores (fetch metadata from graph)
  const tools: Array<
    {
      id: string;
      name: string;
      description: string;
      input_schema?: Record<string, unknown>;
      score: number;
    }
  > = [];
  for (const t of shgatResults.shgatTools.slice(0, 5)) {
    const toolNode = deps.graphEngine.getToolNode(t.toolId);
    if (toolNode) {
      tools.push({
        id: t.toolId,
        name: toolNode.name,
        description: toolNode.description,
        input_schema: toolNode.schema?.inputSchema as Record<string, unknown> | undefined,
        score: t.score,
      });
    }
  }

  // Build capability suggestions from SHGAT scores (fetch metadata from store)
  const capabilities: Array<{ id: string; name: string; description: string; score: number }> = [];
  for (const c of shgatResults.shgatCapabilities.slice(0, 3)) {
    const cap = await deps.capabilityStore.findById(c.capabilityId);
    if (cap) {
      capabilities.push({
        id: c.capabilityId,
        name: cap.name ?? c.capabilityId.substring(0, 8),
        description: cap.description ?? "",
        score: c.score,
      });
    }
  }

  // =========================================================================
  // DR-DSP Backward: Build suggestedDag from hyperpath (POC pattern)
  // =========================================================================
  let suggestedDag: { tasks: Array<{ id: string; tool: string; dependsOn: string[] }> } | undefined;

  // DR-DSP backward pathfinding - ONLY if we have bestCapability from SHGAT
  if (deps.drdsp && bestCapability) {
    const cap = await deps.capabilityStore.findById(bestCapability.id);

    if (cap && cap.toolsUsed && cap.toolsUsed.length > 1) {
      // DR-DSP backward: find hyperpath through this capability
      const startTool = cap.toolsUsed[0];
      const endTool = cap.toolsUsed[cap.toolsUsed.length - 1];
      const pathResult = deps.drdsp.findShortestHyperpath(startTool, endTool);

      if (pathResult.found && pathResult.nodeSequence.length > 0) {
        // Convert hyperpath to DAG structure
        suggestedDag = {
          tasks: pathResult.nodeSequence.map((tool, i) => ({
            id: `task_${i}`,
            tool,
            dependsOn: i > 0 ? [`task_${i - 1}`] : [],
          })),
        };

        log.debug("[pml:execute] DR-DSP backward built suggestedDag", {
          capabilityId: bestCapability.id,
          pathLength: pathResult.nodeSequence.length,
          pathWeight: pathResult.totalWeight,
          tools: pathResult.nodeSequence,
        });
      }
    }
  }

  return { tools, capabilities, suggestedDag };
}

// TODO(Epic-12): buildToolDefinitionsForCapability removed with executeCapability

// extractToolFailures removed - ControlledExecutor provides errors directly via executionResult.errors
