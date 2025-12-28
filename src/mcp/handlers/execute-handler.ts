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
import { type AdaptiveThresholdManager } from "../adaptive-threshold.ts";
import type { DbClient } from "../../db/types.ts";
import type { ContextBuilder } from "../../sandbox/context-builder.ts";
import type { DRDSP } from "../../graphrag/algorithms/dr-dsp.ts";
import type { SHGAT } from "../../graphrag/algorithms/shgat.ts";
import type { JsonValue, LogicalOperation, TraceTaskResult } from "../../capabilities/types.ts";
import type { DagScoringConfig } from "../../graphrag/dag-scoring-config.ts";
import type { EmbeddingModelInterface } from "../../vector/embeddings.ts";
import type { ExecutionTraceStore } from "../../capabilities/execution-trace-store.ts";
import {
  type CapabilityRegistry,
  type Scope,
  getCapabilityDisplayName,
  getCapabilityFqdn,
} from "../../capabilities/capability-registry.ts";
import type { AlgorithmTracer } from "../../telemetry/algorithm-tracer.ts";

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
// Phase 2a: DAG Optimizer imports
import { optimizeDAG } from "../../dag/dag-optimizer.ts";
import { generateLogicalTrace } from "../../dag/trace-generator.ts";
import { ControlledExecutor } from "../../dag/controlled-executor.ts";
import type { CheckpointManager } from "../../dag/checkpoint-manager.ts";
import { handleWorkflowExecution, requiresValidation } from "./workflow-execution-handler.ts";
import type { WorkflowHandlerDependencies } from "./workflow-handler-types.ts";
import { buildToolDefinitionsFromStaticStructure } from "./shared/tool-definitions.ts";

// Story 11.6: PER Training imports
import { trainSHGATOnPathTracesSubprocess } from "../../graphrag/learning/mod.ts";

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
  db: DbClient;
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
  /** Execution trace store for PER training (Story 11.6) */
  traceStore?: ExecutionTraceStore;
  /** Capability registry for naming support (Story 13.2) */
  capabilityRegistry?: CapabilityRegistry;
  /** Algorithm tracer for observability (Story 7.6+) */
  algorithmTracer?: AlgorithmTracer;
  /** Callback to save SHGAT params after PER training */
  onSHGATParamsUpdated?: () => Promise<void>;
}

/**
 * Execute request arguments
 *
 * Three execution modes:
 * 1. **Direct** (intent + code): Execute code → Create capability with trace
 * 2. **Call-by-Name** (intent + capability): Execute existing named capability
 * 3. **Suggestion** (intent only): DR-DSP search → Execute or return suggestions
 *
 * @example Direct mode (create new capability)
 * ```typescript
 * pml_execute({
 *   intent: "read JSON config",
 *   code: "const config = await mcp.filesystem.read_file({ path: 'config.json' });"
 * })
 * // Capability deduplicated by code_hash - same code = same capability
 * // Naming done separately via cap:name API
 * ```
 *
 * @example Call-by-Name mode (reuse existing)
 * ```typescript
 * pml_execute({
 *   intent: "read JSON config",
 *   capability: "my-config-reader",
 *   args: { path: "other-config.json" }
 * })
 * ```
 */
export interface ExecuteArgs {
  /** Natural language description of the intent (REQUIRED) */
  intent: string;
  /** TypeScript code to execute (OPTIONAL - triggers Mode Direct) */
  code?: string;
  /**
   * Name of existing capability to execute (triggers Mode Call-by-Name)
   *
   * When provided, looks up the capability by name and executes its code.
   * Mutually exclusive with `code` parameter.
   *
   * Name format: MCP-compatible with double underscores
   * @example "mcp__filesystem__read_json", "mcp__github__create_issue"
   */
  capability?: string;
  /**
   * Arguments for capability execution (Mode Call-by-Name only)
   *
   * These args are merged with the capability's default parameters.
   * Args override defaults when both are present.
   */
  args?: Record<string, JsonValue>;
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
  /**
   * User-friendly capability name (Story 13.2 AC4)
   * For named capabilities: the display_name
   * For unnamed: "unnamed_<hash>" format
   */
  capabilityName?: string;
  /**
   * Full FQDN of the capability (Story 13.2 AC4)
   * Format: <org>.<project>.<namespace>.<action>.<hash>
   * Example: "local.default.fs.read_json.a7f3"
   */
  capabilityFqdn?: string;
  /** "direct" = code provided, "speculation" = capability reused (Epic-12, disabled) */
  mode?: "direct" | "speculation" | "call_by_name";
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
 * Default scope for local development (Story 13.2)
 */
const DEFAULT_SCOPE: Scope = {
  org: "local",
  project: "default",
};

/**
 * Handle pml:execute request (Story 10.7 + Story 13.2)
 *
 * Unified execution API with three modes:
 * - **Direct** (intent + code): Execute → Create capability with trace
 * - **Call-by-Name** (intent + capability): Execute existing named capability
 * - **Suggestion** (intent only): DR-DSP → Execute or return suggestions
 *
 * @param args - Execute arguments (intent required, code/capability optional)
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
    const capabilityName = params.capability?.trim();
    const providedArgs = params.args ?? {};
    const options = params.options ?? {};

    // Determine execution mode
    const mode = capabilityName ? "call_by_name" : code ? "direct" : "suggestion";

    transaction.setData("intent", intent.substring(0, 100));
    transaction.setData("mode", mode);
    addBreadcrumb("mcp", "Processing execute request", {
      intent: intent.substring(0, 50),
      hasCode: !!code,
      hasCapability: !!capabilityName,
    });

    log.info(
      `pml:execute: intent="${intent.substring(0, 50)}...", mode=${mode}`,
    );

    // Validate mutual exclusivity (capability and code cannot both be present)
    if (capabilityName && code) {
      transaction.finish();
      return formatMCPToolError(
        "Cannot use both 'code' and 'capability' parameters. " +
          "Use 'code' for new execution or 'capability' to call existing.",
      );
    }

    // Route to appropriate mode
    if (capabilityName) {
      // Mode Call-by-Name: Execute existing capability by name
      const result = await executeByNameMode(
        intent,
        capabilityName,
        providedArgs,
        options,
        deps,
        startTime,
      );
      transaction.finish();
      return result;
    } else if (code) {
      // Mode Direct: Execute code → Create capability (deduplicated by code_hash)
      const result = await executeDirectMode(
        intent,
        code,
        options,
        deps,
        startTime,
      );
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
 * Mode Direct: Execute code and create capability (Story 10.7 + Story 13.2)
 *
 * Flow:
 * 1. Validate code size
 * 2. Static analysis via StaticStructureBuilder
 * 3. Execute via WorkerBridge
 * 4. Create capability with traceData (Unit of Work pattern)
 *    - Deduplicated by code_hash (same code = same capability)
 *    - Naming done separately via cap:name API
 *
 * @param intent - Natural language description
 * @param code - TypeScript code to execute
 * @param options - Execution options
 * @param deps - Dependencies
 * @param startTime - Start timestamp for metrics
 */

/**
 * Unwrap code execution result from {result, state, executionTimeMs} wrapper
 *
 * Code executor wraps results for checkpoint persistence, but we need
 * to return just the actual result to the caller.
 */
function unwrapCodeResult(output: unknown): unknown {
  if (output && typeof output === "object" && "result" in output && "state" in output) {
    return (output as { result: unknown }).result;
  }
  return output;
}

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
    capabilityRegistry: deps.capabilityRegistry,
  });

  try {
    // Step 4: Check if we can convert to DAG for ControlledExecutor
    if (isValidForDagConversion(staticStructure)) {
      // Convert static structure to DAG (logical DAG)
      const logicalDAG = staticStructureToDag(staticStructure, {
        taskIdPrefix: "task_",
        includeDecisionTasks: false,
      });

      if (logicalDAG.tasks.length > 0) {
        // Phase 2a: Optimize DAG (fuse sequential pure operations)
        const optimizedDAG = optimizeDAG(logicalDAG);

        log.info("[pml:execute] Executing via ControlledExecutor (DAG mode)", {
          logicalTasksCount: logicalDAG.tasks.length,
          physicalTasksCount: optimizedDAG.tasks.length,
          fusionRate: Math.round((1 - optimizedDAG.tasks.length / logicalDAG.tasks.length) * 100),
          tools: optimizedDAG.tasks.map((t) => t.tool),
          perLayerValidation,
        });

        // Create ControlledExecutor
        const controlledExecutor = new ControlledExecutor(toolExecutor, {
          maxConcurrency: 5,
          taskTimeout: options?.timeout ?? 30000,
        });

        // Set WorkerBridge for code execution tracing (Story 10.5)
        controlledExecutor.setWorkerBridge(executorContext.bridge);

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
            tasksCount: optimizedDAG.tasks.length,
            tools: optimizedDAG.tasks.map((t) => t.tool),
          });

          // Delegate to handleWorkflowExecution with the physical DAG
          return await handleWorkflowExecution(
            {
              workflow: { tasks: optimizedDAG.tasks },
              intent,
              config: { per_layer_validation: true },
            },
            deps.workflowDeps,
          );
        }

        // Check if any tool requires HIL approval (unknown or approvalMode: hil)
        const needsApproval = await requiresValidation(
          { tasks: optimizedDAG.tasks },
          deps.capabilityStore,
        );
        if (needsApproval) {
          log.info("[pml:execute] DAG contains tools requiring approval, delegating to HIL", {
            tools: optimizedDAG.tasks.map((t) => t.tool),
          });

          if (!deps.workflowDeps) {
            return formatMCPToolError(
              "DAG contains tools requiring human approval but workflowDeps not configured.",
            );
          }

          return await handleWorkflowExecution(
            {
              workflow: { tasks: optimizedDAG.tasks },
              intent,
              config: { per_layer_validation: true },
            },
            deps.workflowDeps,
          );
        }

        // Execute optimized (physical) DAG via ControlledExecutor (all tools auto-approved)
        const physicalResults = await controlledExecutor.execute({ tasks: optimizedDAG.tasks });
        const executionTimeMs = performance.now() - startTime;

        // Phase 2a: Generate logical traces from physical execution
        // Map physical task results to a format compatible with generateLogicalTrace
        const physicalResultsMap = new Map(
          physicalResults.results.map((r) => [r.taskId, {
            taskId: r.taskId,
            status: r.status,
            output: r.output,
            executionTimeMs: r.executionTimeMs ?? 0,
          }]),
        );

        const logicalTrace = generateLogicalTrace(optimizedDAG, physicalResultsMap);

        log.debug("[pml:execute] Logical trace generated", {
          physicalTasksExecuted: physicalResults.results.length,
          logicalOperations: logicalTrace.executedPath.length,
          toolsUsed: logicalTrace.toolsUsed,
        });

        // Extract tool calls from logical trace (for SHGAT learning)
        const toolsCalled = logicalTrace.executedPath;

        // Build task results for trace (using physical tasks with logical detail)
        // Phase 2a: Include fusion metadata for UI display
        const taskResults: TraceTaskResult[] = physicalResults.results.map((physicalResult) => {
          const physicalTask = optimizedDAG.tasks.find((t) => t.id === physicalResult.taskId);
          const logicalTaskIds = optimizedDAG.physicalToLogical.get(physicalResult.taskId) || [];
          const fused = logicalTaskIds.length > 1;

          let logicalOps: LogicalOperation[] | undefined;
          if (fused) {
            // Extract logical operations for fused task
            const estimatedDuration = (physicalResult.executionTimeMs || 0) / logicalTaskIds.length;
            logicalOps = logicalTaskIds.map((logicalId) => {
              const logicalTask = optimizedDAG.logicalDAG.tasks.find((t) => t.id === logicalId);
              return {
                toolId: logicalTask?.tool || "unknown",
                durationMs: estimatedDuration,
              };
            });
          }

          return {
            taskId: physicalResult.taskId,
            tool: physicalTask?.tool || "unknown",
            args: {} as Record<string, JsonValue>,
            result: physicalResult.output as JsonValue ?? null,
            success: physicalResult.status === "success",
            durationMs: physicalResult.executionTimeMs || 0,
            layerIndex: physicalResult.layerIndex,
            // Phase 2a: Fusion metadata
            isFused: fused,
            logicalOperations: logicalOps,
          };
        });

        // Handle execution failure
        if (physicalResults.failedTasks > 0 && physicalResults.successfulTasks === 0) {
          const firstError = physicalResults.errors[0];
          return formatMCPToolError(
            `DAG execution failed: ${firstError?.error ?? "Unknown error"}`,
            {
              failedTasks: physicalResults.failedTasks,
              errors: physicalResults.errors,
              executionTimeMs,
            },
          );
        }

        // Count failed_safe tasks (these are NOT counted in failedTasks but still represent failures)
        // Pure code operations like code:filter are safe-to-fail but should NOT save as success
        const failedSafeTasks = physicalResults.results.filter(
          (r) => r.status === "failed_safe",
        ).length;
        const hasAnyFailure = physicalResults.failedTasks > 0 || failedSafeTasks > 0;

        // Fix: Do NOT save capability when any task fails (including safe-to-fail)
        // Capabilities should only be saved for successful executions
        if (hasAnyFailure) {
          const failedResults = physicalResults.results.filter(
            (r) => r.status === "error" || r.status === "failed_safe",
          );
          const firstError = failedResults[0]?.error ?? physicalResults.errors[0]?.error ?? "Unknown error";

          log.info("[pml:execute] Execution failed, NOT saving capability", {
            failedSafeTasks,
            failedTasks: physicalResults.failedTasks,
            firstError,
          });

          return formatMCPToolError(
            `Code execution failed: ${firstError}`,
            {
              failedTasks: physicalResults.failedTasks,
              failedSafeTasks,
              errors: physicalResults.errors,
              executionTimeMs,
            },
          );
        }

        // Create capability with trace data
        // Story 11.2: Infer branch decisions from executed path vs static structure
        const inferredDecisions = StaticStructureBuilder.inferDecisions(
          staticStructure,
          toolsCalled,
        );

        // Generate intent embedding for trace (SHGAT v2 intentSimilarSuccessRate)
        let intentEmbedding: number[] | undefined;
        if (deps.embeddingModel) {
          try {
            intentEmbedding = await deps.embeddingModel.encode(intent);
          } catch (embError) {
            log.warn("[pml:execute] Failed to generate intent embedding for trace", {
              error: String(embError),
            });
          }
        }

        // At this point, all tasks succeeded (we returned early on failure above)
        const { capability, trace } = await deps.capabilityStore.saveCapability({
          code,
          intent,
          durationMs: Math.round(executionTimeMs),
          success: true, // Only save successful executions
          toolsUsed: toolsCalled,
          traceData: {
            executedPath: toolsCalled,
            taskResults,
            decisions: inferredDecisions,
            initialContext: { intent },
            intentEmbedding,
          },
          // Story 10.1: Pass staticStructure for nested capability detection
          staticStructure,
        });

        // Story 13.2: Register in CapabilityRegistry with auto-generated FQDN
        // Naming (displayName) done separately via cap:name API (Story 13.3)
        // Migration 023: Links to workflow_pattern via workflowPatternId FK
        let capabilityFqdn: string | undefined;
        let autoDisplayName: string | undefined;
        if (deps.capabilityRegistry) {
          try {
            // Infer namespace from first tool's server (e.g., "filesystem:read" -> "filesystem")
            const firstTool = toolsCalled[0] ?? "misc";
            const namespace = firstTool.includes(":") ? firstTool.split(":")[0] : "code";
            // Auto-generate action from code hash
            const codeHash = capability.codeHash;
            const action = `exec_${codeHash.substring(0, 8)}`;
            // 4-char hash for FQDN
            const hash = codeHash.substring(0, 4);
            // Auto displayName until user names it via cap:name
            autoDisplayName = `unnamed_${codeHash.substring(0, 8)}`;

            const record = await deps.capabilityRegistry.create({
              displayName: autoDisplayName,
              org: DEFAULT_SCOPE.org,
              project: DEFAULT_SCOPE.project,
              namespace,
              action,
              workflowPatternId: capability.id,
              hash,
              createdBy: "pml_execute",
            });

            capabilityFqdn = record.id;

            log.info("[pml:execute] Capability registered with auto FQDN", {
              displayName: autoDisplayName,
              fqdn: capabilityFqdn,
            });
          } catch (registryError) {
            // Log but don't fail - capability was still created
            log.warn("[pml:execute] Failed to register capability in registry", {
              error: String(registryError),
            });
          }
        }

        // Update DR-DSP with new capability
        updateDRDSP(deps.drdsp, capability, staticStructure);

        // Register capability in SHGAT graph (nodes only, training via PER)
        await registerSHGATNodes(deps.shgat, deps.embeddingModel, capability, toolsCalled, intent);

        // Story 10.7c: Update Thompson Sampling with execution outcomes
        updateThompsonSampling(deps.adaptiveThresholdManager, taskResults);

        // Story 11.6: PER batch training (every execution)
        // Run in background (non-blocking) per ADR-053
        runPERBatchTraining(deps).catch((err) =>
          log.warn("[pml:execute] PER training failed", { error: String(err) })
        );

        // Story 11.4 AC11: Learn fan-in/fan-out edges from layerIndex
        const tasksWithLayer = taskResults
          .filter((t): t is TraceTaskResult & { layerIndex: number } => t.layerIndex !== undefined);
        if (tasksWithLayer.length > 0) {
          await deps.graphEngine.learnFromTaskResults(tasksWithLayer);
        }

        // Build response - unwrap code execution results from {result, state, executionTimeMs} wrapper
        log.info("[DEBUG] physicalResults.results raw:", {
          count: physicalResults.results.length,
          results: physicalResults.results.map((r) => ({
            taskId: r.taskId,
            status: r.status,
            outputType: typeof r.output,
            outputKeys: r.output && typeof r.output === "object"
              ? Object.keys(r.output as object)
              : null,
            output: r.output,
          })),
        });

        const successOutputs = physicalResults.results
          .filter((r) => r.status === "success")
          .map((r) => unwrapCodeResult(r.output));

        log.info("[DEBUG] successOutputs after unwrap:", { successOutputs });

        const response: ExecuteResponse = {
          status: "success",
          result: (successOutputs.length === 1 ? successOutputs[0] : successOutputs) as JsonValue,
          capabilityId: capability.id,
          capabilityName: autoDisplayName ?? capability.name, // Auto-generated, rename via cap:name
          capabilityFqdn, // Auto-generated FQDN
          mode: "direct",
          executionTimeMs,
          dag: {
            mode: "dag",
            tasksCount: logicalDAG.tasks.length, // Report logical task count (what SHGAT sees)
            layersCount: physicalResults.parallelizationLayers,
            speedup: controlledExecutor.calculateSpeedup(physicalResults),
            toolsDiscovered: toolsCalled,
          },
        };

        // Add tool failures if any
        if (physicalResults.failedTasks > 0) {
          response.tool_failures = physicalResults.errors.map((e) => ({
            tool: e.taskId,
            error: e.error,
          }));
        }

        log.info("[pml:execute] Mode Direct completed (ControlledExecutor + DAG Optimizer)", {
          capabilityId: capability.id,
          capabilityName: autoDisplayName ?? capability.name,
          capabilityFqdn,
          traceId: trace?.id,
          executionTimeMs: executionTimeMs.toFixed(2),
          toolsCalled: toolsCalled.length,
          logicalTasks: logicalDAG.tasks.length,
          physicalTasks: optimizedDAG.tasks.length,
          layers: physicalResults.parallelizationLayers,
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
 * Mode Call-by-Name: Execute existing capability by name (Story 13.2)
 *
 * Flow:
 * 1. Resolve capability name via CapabilityRegistry
 * 2. Merge provided args with capability defaults
 * 3. Execute capability code via WorkerBridge
 * 4. Record usage metrics
 *
 * @param intent - Natural language description
 * @param capabilityName - Name of capability to execute
 * @param args - Arguments to pass to capability
 * @param options - Execution options
 * @param deps - Dependencies
 * @param startTime - Start timestamp for metrics
 */
async function executeByNameMode(
  intent: string,
  capabilityName: string,
  args: Record<string, JsonValue>,
  options: ExecuteArgs["options"],
  deps: ExecuteDependencies,
  startTime: number,
): Promise<MCPToolResponse | MCPErrorResponse> {
  // AC6, AC9: Check if registry is available
  if (!deps.capabilityRegistry) {
    return formatMCPToolError(
      "Call-by-name mode requires CapabilityRegistry. " +
        "Ensure gateway is properly configured with capabilityRegistry dependency.",
    );
  }

  log.info("[pml:execute] Mode Call-by-Name - resolving capability", {
    capabilityName,
    argsKeys: Object.keys(args),
  });

  // AC7: Resolve name to capability record
  const record = await deps.capabilityRegistry.resolveByName(capabilityName, DEFAULT_SCOPE);

  if (!record) {
    // AC9: Not found error
    return formatMCPToolError(
      `Capability not found: ${capabilityName}`,
    );
  }

  // Migration 023: Fetch code from workflow_pattern via FK
  if (!record.workflowPatternId) {
    return formatMCPToolError(
      `Capability '${capabilityName}' has no linked workflow_pattern. Cannot execute.`,
    );
  }

  // Fetch code and parameters from workflow_pattern
  const wpResult = await deps.db.query(
    `SELECT code_snippet, parameters_schema, description FROM workflow_pattern WHERE pattern_id = $1`,
    [record.workflowPatternId],
  );

  if (wpResult.length === 0) {
    return formatMCPToolError(
      `Capability '${capabilityName}' linked workflow_pattern not found. Cannot execute.`,
    );
  }

  const codeSnippet = wpResult[0].code_snippet as string;
  const parametersSchema = wpResult[0].parameters_schema
    ? (typeof wpResult[0].parameters_schema === "string"
      ? JSON.parse(wpResult[0].parameters_schema as string)
      : wpResult[0].parameters_schema)
    : undefined;

  if (!codeSnippet) {
    return formatMCPToolError(
      `Capability '${capabilityName}' has no code snippet stored. Cannot execute.`,
    );
  }

  log.debug("[pml:execute] Capability resolved", {
    displayName: getCapabilityDisplayName(record),
    fqdn: getCapabilityFqdn(record),
    workflowPatternId: record.workflowPatternId,
    hasParametersSchema: !!parametersSchema,
  });

  // AC8: Merge args with defaults from parametersSchema
  const mergedArgs = mergeArgsWithDefaults(args, parametersSchema);

  log.debug("[pml:execute] Args merged", {
    providedKeys: Object.keys(args),
    mergedKeys: Object.keys(mergedArgs),
  });

  // Execute the capability code
  const perLayerValidation = options?.per_layer_validation === true;

  // Step 1: Static analysis via SWC
  const structureBuilder = new StaticStructureBuilder(deps.db);
  const staticStructure = await structureBuilder.buildStaticStructure(codeSnippet);

  // Step 2: Build tool definitions
  const toolDefs = await buildToolDefinitionsFromStaticStructure(staticStructure, deps);

  // Step 3: Create WorkerBridge executor
  const [toolExecutor, executorContext] = createToolExecutorViaWorker({
    mcpClients: deps.mcpClients,
    toolDefinitions: toolDefs,
    capabilityStore: deps.capabilityStore,
    graphRAG: deps.graphEngine,
    capabilityRegistry: deps.capabilityRegistry,
  });

  try {
    // Step 4: Check if we can convert to DAG
    if (isValidForDagConversion(staticStructure)) {
      // Convert to logical DAG
      const logicalDAG = staticStructureToDag(staticStructure, {
        taskIdPrefix: "task_",
        includeDecisionTasks: false,
      });

      if (logicalDAG.tasks.length > 0) {
        // Phase 2a: Optimize DAG (fuse sequential pure operations)
        const optimizedDAG = optimizeDAG(logicalDAG);

        log.info("[pml:execute] Executing capability via ControlledExecutor (DAG mode)", {
          capabilityName: getCapabilityDisplayName(record),
          fqdn: getCapabilityFqdn(record),
          logicalTasksCount: logicalDAG.tasks.length,
          physicalTasksCount: optimizedDAG.tasks.length,
          fusionRate: Math.round((1 - optimizedDAG.tasks.length / logicalDAG.tasks.length) * 100),
        });

        // Create ControlledExecutor
        const controlledExecutor = new ControlledExecutor(toolExecutor, {
          maxConcurrency: 5,
          taskTimeout: options?.timeout ?? 30000,
        });

        // Set WorkerBridge for code execution tracing (Story 10.5)
        controlledExecutor.setWorkerBridge(executorContext.bridge);

        // Per-layer validation check
        if (perLayerValidation && deps.workflowDeps) {
          return await handleWorkflowExecution(
            {
              workflow: { tasks: optimizedDAG.tasks },
              intent,
              config: { per_layer_validation: true },
            },
            deps.workflowDeps,
          );
        }

        // Execute optimized (physical) DAG
        const physicalResults = await controlledExecutor.execute({ tasks: optimizedDAG.tasks });
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

        // Extract tool calls from logical trace
        const toolsCalled = logicalTrace.executedPath;

        // Handle execution failure
        if (physicalResults.failedTasks > 0 && physicalResults.successfulTasks === 0) {
          const firstError = physicalResults.errors[0];

          // AC10: Record failed usage
          await deps.capabilityRegistry.recordUsage(record.id, false, executionTimeMs);

          return formatMCPToolError(
            `Capability execution failed: ${firstError?.error ?? "Unknown error"}`,
            {
              capabilityName: getCapabilityDisplayName(record),
              fqdn: getCapabilityFqdn(record),
              failedTasks: physicalResults.failedTasks,
              errors: physicalResults.errors,
              executionTimeMs,
            },
          );
        }

        // AC10: Record successful usage
        await deps.capabilityRegistry.recordUsage(record.id, true, executionTimeMs);

        // Build response - unwrap code execution results from {result, state, executionTimeMs} wrapper
        const successOutputs = physicalResults.results
          .filter((r) => r.status === "success")
          .map((r) => unwrapCodeResult(r.output));

        const response: ExecuteResponse = {
          status: "success",
          result: (successOutputs.length === 1 ? successOutputs[0] : successOutputs) as JsonValue,
          capabilityId: record.id,
          capabilityName: getCapabilityDisplayName(record),
          capabilityFqdn: getCapabilityFqdn(record),
          mode: "call_by_name",
          executionTimeMs,
          dag: {
            mode: "dag",
            tasksCount: logicalDAG.tasks.length, // Report logical task count (what SHGAT sees)
            layersCount: physicalResults.parallelizationLayers,
            speedup: controlledExecutor.calculateSpeedup(physicalResults),
            toolsDiscovered: toolsCalled,
          },
        };

        // Add tool failures if any
        if (physicalResults.failedTasks > 0) {
          response.tool_failures = physicalResults.errors.map((e) => ({
            tool: e.taskId,
            error: e.error,
          }));
        }

        log.info("[pml:execute] Mode Call-by-Name completed", {
          capabilityName: getCapabilityDisplayName(record),
          fqdn: getCapabilityFqdn(record),
          executionTimeMs: executionTimeMs.toFixed(2),
          toolsCalled: toolsCalled.length,
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify(response, null, 2),
          }],
        };
      }
    }

    // No valid DAG - fail
    return formatMCPToolError(
      `Capability '${capabilityName}' code cannot be executed - no MCP tools found.`,
      {
        fqdn: getCapabilityFqdn(record),
        hint: "The capability may have been created with code that doesn't use MCP tools.",
      },
    );
  } finally {
    cleanupWorkerBridgeExecutor(executorContext);
  }
}

/**
 * Merge provided args with defaults from JSON Schema (Story 13.2 AC8)
 *
 * Algorithm:
 * 1. Start with provided args
 * 2. For each property in schema, if not in args and has default, add default
 *
 * @param providedArgs - User-provided arguments
 * @param schema - JSON Schema with defaults
 * @returns Merged arguments
 */
function mergeArgsWithDefaults(
  providedArgs: Record<string, JsonValue>,
  schema: { properties?: Record<string, { default?: JsonValue }> } | undefined,
): Record<string, JsonValue> {
  const merged = { ...providedArgs };

  if (schema?.properties) {
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      if (!(key in merged) && propSchema.default !== undefined) {
        merged[key] = propSchema.default;
      }
    }
  }

  return merged;
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
 * Register capability and tools in SHGAT graph
 *
 * Adds new nodes to the graph. Training is done separately via PER.
 */
async function registerSHGATNodes(
  shgat: SHGAT | undefined,
  embeddingModel: EmbeddingModelInterface | undefined,
  capability: { id: string; toolsUsed?: string[]; successRate: number },
  toolsCalled: string[],
  intent: string,
): Promise<void> {
  if (!shgat || !embeddingModel) {
    return;
  }

  try {
    // Generate embedding for the capability from intent
    const embedding = await embeddingModel.encode(intent);

    // Register any new tools (with generated embeddings)
    for (const toolId of toolsCalled) {
      if (!shgat.hasToolNode(toolId)) {
        const toolEmbedding = await embeddingModel.encode(toolId.replace(":", " "));
        shgat.registerTool({ id: toolId, embedding: toolEmbedding });
      }
    }

    // Register the capability with new SHGAT v1 structure
    const toolMembers = (capability.toolsUsed ?? toolsCalled).map((id) => ({
      type: "tool" as const,
      id,
    }));
    shgat.registerCapability({
      id: capability.id,
      embedding,
      members: toolMembers,
      hierarchyLevel: 0, // Tools only = level 0
      successRate: capability.successRate,
    });

    log.debug("[pml:execute] SHGAT nodes registered", {
      capabilityId: capability.id,
      toolsCount: toolsCalled.length,
    });
  } catch (error) {
    log.warn("[pml:execute] Failed to register SHGAT nodes", { error: String(error) });
  }
}

/** Training lock to prevent concurrent training */
let isTrainingInProgress = false;

/**
 * Capability row from database
 */
interface CapabilityRow {
  id: string;
  embedding: number[] | string | null;
  tools_used: string[] | null;
  success_rate: number;
}

/**
 * Run PER batch training (Story 11.6)
 *
 * Called after every execution to train SHGAT on high-priority traces.
 * Uses subprocess for non-blocking execution.
 * Skips if another training is already in progress (prevents race conditions).
 */
async function runPERBatchTraining(deps: ExecuteDependencies): Promise<void> {
  // Skip if training already in progress (prevents concurrent training issues)
  if (isTrainingInProgress) {
    log.debug("[pml:execute] Skipping PER training - another training in progress");
    return;
  }

  // Check required dependencies
  if (!deps.shgat || !deps.traceStore || !deps.embeddingModel || !deps.db) {
    return;
  }

  isTrainingInProgress = true;
  try {
    // Create embedding provider wrapper
    const embeddingProvider = {
      getEmbedding: async (text: string) => deps.embeddingModel!.encode(text),
    };

    // Fetch capabilities with embeddings for subprocess
    const rows = await deps.db.query(
      `SELECT
        pattern_id as id,
        intent_embedding as embedding,
        dag_structure->'tools_used' as tools_used,
        success_rate
      FROM workflow_pattern
      WHERE code_snippet IS NOT NULL
        AND intent_embedding IS NOT NULL
      LIMIT 500`,
    ) as unknown as CapabilityRow[];

    // Parse embeddings (handle pgvector string format)
    const capabilities = rows
      .map((c) => {
        let embedding: number[];
        if (Array.isArray(c.embedding)) {
          embedding = c.embedding;
        } else if (typeof c.embedding === "string") {
          try {
            embedding = JSON.parse(c.embedding);
          } catch {
            return null;
          }
        } else {
          return null;
        }
        if (!Array.isArray(embedding) || embedding.length === 0) return null;
        return {
          id: c.id,
          embedding,
          toolsUsed: c.tools_used ?? [],
          successRate: c.success_rate,
        };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);

    if (capabilities.length === 0) {
      log.debug("[pml:execute] No capabilities with embeddings for PER training");
      return;
    }

    // Run path-level training with PER sampling in subprocess
    const result = await trainSHGATOnPathTracesSubprocess(
      deps.shgat,
      deps.traceStore,
      embeddingProvider,
      {
        capabilities,
        minTraces: 1,
        maxTraces: 50,
        batchSize: 16,
        epochs: 1, // Live mode: single epoch
      },
    );

    if (!result.fallback && result.tracesProcessed > 0) {
      log.debug("[pml:execute] PER training completed", {
        traces: result.tracesProcessed,
        examples: result.examplesGenerated,
        loss: result.loss.toFixed(4),
        priorities: result.prioritiesUpdated,
      });
      // Save params after successful PER training
      if (deps.onSHGATParamsUpdated) {
        await deps.onSHGATParamsUpdated();
      }
    }
  } catch (error) {
    log.warn("[pml:execute] PER training failed", { error: String(error) });
  } finally {
    isTrainingInProgress = false;
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
  // Generate correlationId to group all traces from this operation
  const correlationId = crypto.randomUUID();

  log.info("[pml:execute] Mode Suggestion - SHGAT + DR-DSP search", {
    correlationId,
    intent: intent.substring(0, 50),
    hasSHGAT: !!deps.shgat,
    hasDRDSP: !!deps.drdsp,
    hasThompson: !!deps.adaptiveThresholdManager,
  });

  // Story 10.7c: Use Thompson Sampling for per-tool thresholds
  // Note: SPECULATION_SCORE_THRESHOLD is now used as global fallback only
  // Per-tool thresholds are calculated by smartHILCheck using Thompson Sampling
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

  // Score capabilities with SHGAT v1 K-head (trained on execution traces)
  // V1 won benchmark: MRR=0.214 vs V2=0.198
  // Note: Tools use semantic search (cosine), not K-head - see getSuggestions()
  const shgatCapabilities = deps.shgat.scoreAllCapabilities(intentEmbedding);

  log.debug("[pml:execute] SHGAT scored capabilities", {
    capabilitiesCount: shgatCapabilities.length,
    topCapabilities: shgatCapabilities.slice(0, 3).map((r) => ({
      id: r.capabilityId,
      score: r.score.toFixed(3),
    })),
  });

  // Story 7.6+: Trace SHGAT scoring decisions with rich K-head info
  for (const cap of shgatCapabilities.slice(0, 10)) {
    const threshold = deps.adaptiveThresholdManager?.getThresholds().explicitThreshold ?? 0.6;
    // Lookup capability for additional context
    const capInfo = await deps.capabilityStore.findById(cap.capabilityId);
    const numHeads = cap.headScores?.length ?? 0;
    const avgHeadScore = numHeads > 0 ? cap.headScores!.reduce((a, b) => a + b, 0) / numHeads : 0;

    deps.algorithmTracer?.logTrace({
      correlationId,
      algorithmName: "SHGAT",
      algorithmMode: "active_search",
      targetType: "capability",
      intent: intent.substring(0, 200),
      signals: {
        semanticScore: avgHeadScore, // Raw avg before reliability
        graphDensity: 0, // N/A for SHGAT V1
        spectralClusterMatch: false, // N/A for SHGAT V1
        // SHGAT V1 K-head attention details
        numHeads,
        avgHeadScore,
        headScores: cap.headScores, // All K individual scores
        headWeights: cap.headWeights, // Per-head fusion weights
        recursiveContribution: cap.recursiveContribution,
        // Feature contributions (if available)
        featureContribSemantic: cap.featureContributions?.semantic,
        featureContribStructure: cap.featureContributions?.structure,
        featureContribTemporal: cap.featureContributions?.temporal,
        featureContribReliability: cap.featureContributions?.reliability,
        // Target identification
        targetId: cap.capabilityId,
        targetName: capInfo?.name ?? cap.capabilityId.substring(0, 8),
        // Reliability context
        targetSuccessRate: capInfo?.successRate,
        targetUsageCount: capInfo?.usageCount,
      },
      params: {
        alpha: 0, // N/A - SHGAT uses learned K-head attention, not alpha blending
        reliabilityFactor: capInfo?.successRate ?? 1.0,
        structuralBoost: cap.recursiveContribution ?? 0,
      },
      finalScore: cap.score,
      thresholdUsed: threshold,
      decision: cap.score >= threshold ? "accepted" : "rejected_by_threshold",
    });
  }

  if (shgatCapabilities.length === 0) {
    log.info("[pml:execute] No capabilities found - returning tool suggestions");
    const suggestions = await getSuggestions(
      deps,
      intent,
      { shgatCapabilities },
      undefined,
      correlationId,
    );
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
    const suggestions = await getSuggestions(deps, intent, { shgatCapabilities }, {
      id: bestMatch.capabilityId,
      score: bestMatch.score,
    }, correlationId);
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

      // Story 7.6: Trace DRDSP path validation
      deps.algorithmTracer?.logTrace({
        correlationId,
        algorithmName: "DRDSP",
        algorithmMode: "active_search",
        targetType: "tool",
        intent: intent.substring(0, 200),
        signals: {
          graphDensity: 0,
          spectralClusterMatch: false,
          pathFound: pathResult.found,
          pathLength: pathResult.found ? pathResult.nodeSequence.length : 0,
          pathWeight: pathResult.found ? pathResult.totalWeight : 0,
          targetId: endTool, // Auto-detects pure in AlgorithmTracer
        },
        params: {
          alpha: 0, // N/A for pathfinding
          reliabilityFactor: 1.0,
          structuralBoost: 0,
        },
        finalScore: pathResult.found ? (1.0 / (1 + pathResult.totalWeight)) : 0,
        thresholdUsed: 0,
        decision: pathResult.found ? "accepted" : "rejected_by_threshold",
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
    const suggestions = await getSuggestions(deps, intent, { shgatCapabilities }, {
      id: bestMatch.capabilityId,
      score: bestMatch.score,
    }, correlationId);

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
  const suggestions = await getSuggestions(deps, intent, { shgatCapabilities }, {
    id: bestMatch.capabilityId,
    score: bestMatch.score,
  }, correlationId);

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
 * Get suggestions from SHGAT + semantic search
 *
 * - Capabilities: SHGAT K-head scores (trained on execution traces)
 * - Tools: Semantic search (cosine on embeddings) - K-head not trained for tools
 * - suggestedDag: DR-DSP backward pathfinding
 */
async function getSuggestions(
  deps: ExecuteDependencies,
  intent: string,
  shgatResults: {
    shgatCapabilities: Array<{ capabilityId: string; score: number }>;
  },
  bestCapability?: { id: string; score: number },
  correlationId?: string,
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
  // Build tool suggestions from SEMANTIC SEARCH (not K-head)
  // K-head is trained on capabilities, not tools - cosine works better for tools
  const tools: Array<
    {
      id: string;
      name: string;
      description: string;
      input_schema?: Record<string, unknown>;
      score: number;
    }
  > = [];

  const hybridResults = await deps.graphEngine.searchToolsHybrid(
    deps.vectorSearch,
    intent,
    5, // limit
  );

  for (const result of hybridResults) {
    const toolNode = deps.graphEngine.getToolNode(result.toolId);
    if (toolNode) {
      tools.push({
        id: result.toolId,
        name: toolNode.name,
        description: toolNode.description,
        input_schema: toolNode.schema?.inputSchema as Record<string, unknown> | undefined,
        score: result.finalScore,
      });
    }
  }

  // Build capability suggestions from SHGAT K-head scores (trained for this)
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

        // Story 7.6: Trace DRDSP backward pathfinding
        deps.algorithmTracer?.logTrace({
          correlationId,
          algorithmName: "DRDSP",
          algorithmMode: "passive_suggestion",
          targetType: "capability",
          intent: intent.substring(0, 200),
          signals: {
            graphDensity: 0,
            spectralClusterMatch: false,
            pathFound: true,
            pathLength: pathResult.nodeSequence.length,
            pathWeight: pathResult.totalWeight,
            targetId: bestCapability.id,
          },
          params: {
            alpha: 0, // N/A for pathfinding
            reliabilityFactor: 1.0,
            structuralBoost: 0,
          },
          finalScore: 1.0 / (1 + pathResult.totalWeight),
          thresholdUsed: 0,
          decision: "accepted",
        });
      }
    }
  }

  return { tools, capabilities, suggestedDag };
}

// TODO(Epic-12): buildToolDefinitionsForCapability removed with executeCapability

// extractToolFailures removed - ControlledExecutor provides errors directly via executionResult.errors

/**
 * Update Thompson Sampling with execution outcomes (Story 10.7c AC6)
 *
 * Records success/failure for each tool executed, updating the Beta distributions
 * in the Thompson Sampler for future threshold calculations.
 *
 * @param thresholdManager - AdaptiveThresholdManager with Thompson Sampler
 * @param taskResults - Task execution results with tool IDs and success status
 */
export function updateThompsonSampling(
  thresholdManager: AdaptiveThresholdManager | undefined,
  taskResults: TraceTaskResult[],
): void {
  if (!thresholdManager) {
    log.debug("[pml:execute] Thompson update skipped - no threshold manager");
    return;
  }

  let updated = 0;
  for (const result of taskResults) {
    if (result.tool && result.tool !== "unknown") {
      thresholdManager.recordToolOutcome(result.tool, result.success);
      updated++;
    }
  }

  log.debug("[pml:execute] Thompson Sampling updated", {
    toolsUpdated: updated,
    totalResults: taskResults.length,
  });
}
