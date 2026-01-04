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
  getCapabilityDisplayName,
  getCapabilityFqdn,
  type Scope,
} from "../../capabilities/capability-registry.ts";
import type { AlgorithmTracer } from "../../telemetry/algorithm-tracer.ts";
import { TelemetryAdapter } from "../../telemetry/decision-logger.ts";
import { getSuggestion, type SuggestedDag } from "./suggestion-handler.ts";

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
import { handleApprovalResponse } from "./control-commands-handler.ts";
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
 * Build SuggestionDependencies from ExecuteDependencies
 * Adapts algorithmTracer to IDecisionLogger via TelemetryAdapter
 */
function buildSuggestionDeps(deps: ExecuteDependencies) {
  return {
    drdsp: deps.drdsp,
    capabilityStore: deps.capabilityStore,
    graphEngine: deps.graphEngine,
    capabilityRegistry: deps.capabilityRegistry,
    decisionLogger: new TelemetryAdapter(),
  };
}

/**
 * Execute request arguments
 *
 * Two primary execution modes:
 * 1. **Direct** (intent + code): Execute code → Create capability with trace
 * 2. **Suggestion** (intent only): DR-DSP search → Return suggestions
 *
 * Two response patterns (to previous execute responses):
 * 3. **Accept Suggestion**: Execute a capability/tool from suggestedDag
 * 4. **Continue Workflow**: Resume a paused workflow (approval_required)
 *
 * @example Direct mode (create new capability)
 * ```typescript
 * pml_execute({
 *   intent: "read JSON config",
 *   code: "const config = await mcp.filesystem.read_file({ path: 'config.json' });"
 * })
 * ```
 *
 * @example Suggestion mode → Accept flow
 * ```typescript
 * // Step 1: Get suggestions
 * pml_execute({ intent: "read JSON config" })
 * // Response: { status: "suggestions", suggestions: { suggestedDag: { tasks: [{ callName: "fs:read_json", inputSchema: {...} }] } } }
 *
 * // Step 2: Accept the suggestion
 * pml_execute({
 *   accept_suggestion: { callName: "fs:read_json", args: { path: "config.json" } }
 * })
 * ```
 *
 * @example Continue paused workflow
 * ```typescript
 * // Response with status="approval_required" includes workflow_id
 * pml_execute({
 *   continue_workflow: { workflow_id: "abc-123", approved: true }
 * })
 * ```
 */
export interface ExecuteArgs {
  /**
   * Natural language description of the intent
   *
   * REQUIRED for Direct and Suggestion modes.
   * OPTIONAL for response patterns (accept_suggestion, continue_workflow).
   */
  intent?: string;
  /** TypeScript code to execute (OPTIONAL - triggers Mode Direct) */
  code?: string;
  /** Execution options */
  options?: {
    timeout?: number;
    per_layer_validation?: boolean;
  };

  // =========================================================================
  // Response Patterns (to previous execute responses)
  // =========================================================================

  /**
   * Accept a suggestion from a previous Suggestion mode response
   *
   * Used to execute a capability/tool that was suggested by the system.
   * The callName comes from suggestedDag.tasks[n].callName in the previous response.
   *
   * @example
   * ```typescript
   * pml_execute({
   *   accept_suggestion: {
   *     callName: "fs:read_json",  // From suggestedDag.tasks[0].callName
   *     args: { path: "config.json" }  // Built according to inputSchema
   *   }
   * })
   * ```
   */
  accept_suggestion?: {
    /** Call name from suggestedDag (e.g., "fs:read_json", "namespace:action") */
    callName: string;
    /** Arguments for execution, built according to the inputSchema */
    args?: Record<string, JsonValue>;
  };

  /**
   * Continue a paused workflow
   *
   * Used to respond to a previous execution that returned status="approval_required".
   * The workflow_id comes from the previous response's workflowId field.
   *
   * @example
   * ```typescript
   * pml_execute({
   *   continue_workflow: {
   *     workflow_id: "abc-123",  // From previous response
   *     approved: true  // true = continue, false = abort
   *   }
   * })
   * ```
   */
  continue_workflow?: {
    /** Workflow ID from the previous response */
    workflow_id: string;
    /** Approval decision: true to continue, false to abort */
    approved: boolean;
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
  /** "direct" = code provided, "speculation" = capability reused (Epic-12, disabled), "accept_suggestion" = executed from suggestion */
  mode?: "direct" | "speculation" | "accept_suggestion";
  executionTimeMs?: number;

  // Mode approval_required (per-layer validation)
  workflowId?: string;
  checkpointId?: string;
  pendingLayer?: number;
  layerResults?: unknown[];

  // Mode suggestions (low confidence)
  suggestions?: {
    suggestedDag?: SuggestedDag;
    confidence: number;
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
 * Unified execution API with two primary modes and two response patterns:
 *
 * Primary modes:
 * - **Direct** (intent + code): Execute → Create capability with trace
 * - **Suggestion** (intent only): DR-DSP → Return suggestions
 *
 * Response patterns (to previous execute responses):
 * - **Accept Suggestion**: Execute a capability/tool from suggestedDag
 * - **Continue Workflow**: Resume a paused workflow (approval_required)
 *
 * @param args - Execute arguments
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

    // =========================================================================
    // Response Pattern: Continue Workflow (approval_required response)
    // =========================================================================
    if (params.continue_workflow) {
      const { workflow_id, approved } = params.continue_workflow;

      if (!workflow_id || typeof workflow_id !== "string") {
        transaction.finish();
        return formatMCPToolError(
          "Invalid continue_workflow: 'workflow_id' must be a non-empty string.",
        );
      }

      if (approved === undefined || typeof approved !== "boolean") {
        transaction.finish();
        return formatMCPToolError(
          "Invalid continue_workflow: 'approved' must be a boolean (true or false).",
        );
      }

      if (!deps.workflowDeps) {
        transaction.finish();
        return formatMCPToolError("Continue workflow requires workflowDeps configuration.");
      }

      log.info(`pml:execute: continue_workflow ${workflow_id}, approved=${approved}`);
      transaction.setData("mode", "continue_workflow");

      // Delegate to existing approval handler
      const result = await handleApprovalResponse(
        {
          workflow_id,
          checkpoint_id: deps.workflowDeps.activeWorkflows.get(workflow_id)?.latestCheckpointId,
          approved,
        },
        deps.workflowDeps,
      );
      transaction.finish();
      return result;
    }

    // =========================================================================
    // Response Pattern: Accept Suggestion (suggestions response)
    // =========================================================================
    if (params.accept_suggestion) {
      const { callName, args: providedArgs } = params.accept_suggestion;

      if (!callName || typeof callName !== "string") {
        transaction.finish();
        return formatMCPToolError(
          "Invalid accept_suggestion: 'callName' must be a non-empty string.",
        );
      }

      log.info(`pml:execute: accept_suggestion callName="${callName}"`);
      transaction.setData("mode", "accept_suggestion");

      const result = await executeAcceptedSuggestion(
        callName,
        providedArgs ?? {},
        params.options ?? {},
        deps,
        startTime,
      );
      transaction.finish();
      return result;
    }

    // =========================================================================
    // Primary Modes: Direct and Suggestion (require intent)
    // =========================================================================

    // Validate required intent parameter for primary modes
    if (!params.intent || typeof params.intent !== "string" || !params.intent.trim()) {
      transaction.finish();
      return formatMCPToolError(
        "Missing or empty required parameter: 'intent' must be a non-empty string. " +
          "Use 'accept_suggestion' or 'continue_workflow' for response patterns.",
      );
    }

    const intent = params.intent.trim();
    const code = params.code?.trim();
    const options = params.options ?? {};

    // Determine execution mode
    const mode = code ? "direct" : "suggestion";

    transaction.setData("intent", intent.substring(0, 100));
    transaction.setData("mode", mode);
    addBreadcrumb("mcp", "Processing execute request", {
      intent: intent.substring(0, 50),
      hasCode: !!code,
    });

    log.info(
      `pml:execute: intent="${intent.substring(0, 50)}...", mode=${mode}`,
    );

    // Route to appropriate mode
    if (code) {
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
      // Mode Suggestion: DR-DSP → Return suggestions
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

        // Loop Fix: Set tool definitions for loop code that contains MCP calls
        controlledExecutor.setToolDefinitions(toolDefs);

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
          // Pass learningContext so capability can be saved after HIL approval
          return await handleWorkflowExecution(
            {
              workflow: { tasks: optimizedDAG.tasks },
              intent,
              config: { per_layer_validation: true },
              learningContext: {
                code,
                intent,
                staticStructure,
              },
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

          // Pass learningContext so capability can be saved after HIL approval
          return await handleWorkflowExecution(
            {
              workflow: { tasks: optimizedDAG.tasks },
              intent,
              config: { per_layer_validation: true },
              learningContext: {
                code,
                intent,
                staticStructure,
              },
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

        // Loop Abstraction: Count actual tool calls from traces to determine iterations
        // Tasks inside loops will have loopId set - we count how many times each tool was called
        const toolCallCounts = new Map<string, number>();
        for (const trace of executorContext.traces) {
          if (trace.type === "tool_start" && trace.tool) {
            const count = toolCallCounts.get(trace.tool) || 0;
            toolCallCounts.set(trace.tool, count + 1);
          }
        }

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

          // Loop Abstraction: Get iteration count from actual tool call traces
          const toolName = physicalTask?.tool || "unknown";
          const loopId = physicalTask?.metadata?.loopId as string | undefined;
          const loopIterations = loopId ? (toolCallCounts.get(toolName) || 1) : undefined;

          return {
            taskId: physicalResult.taskId,
            tool: toolName,
            args: {} as Record<string, JsonValue>,
            result: physicalResult.output as JsonValue ?? null,
            success: physicalResult.status === "success",
            durationMs: physicalResult.executionTimeMs || 0,
            layerIndex: physicalResult.layerIndex,
            // Phase 2a: Fusion metadata
            isFused: fused,
            logicalOperations: logicalOps,
            // Loop Abstraction: propagate loop info from task metadata + iteration count
            loopId,
            loopIteration: loopIterations, // Total iterations counted from traces
            loopType: physicalTask?.metadata?.loopType as TraceTaskResult["loopType"],
            loopCondition: physicalTask?.metadata?.loopCondition as string | undefined,
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
          const firstError = failedResults[0]?.error ?? physicalResults.errors[0]?.error ??
            "Unknown error";

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
            const codeHash = capability.codeHash;

            // Check if capability_records already exists for this code_hash in scope
            // Prevents duplicates after rename (dedup by code_hash + scope)
            const existingRecord = await deps.capabilityRegistry.getByCodeHash(
              codeHash,
              DEFAULT_SCOPE,
            );

            if (existingRecord) {
              // Reuse existing capability_records (possibly renamed)
              capabilityFqdn = existingRecord.id;
              autoDisplayName = `${existingRecord.namespace}:${existingRecord.action}`;
              log.info("[pml:execute] Reusing existing capability (dedup by code_hash)", {
                name: autoDisplayName,
                fqdn: capabilityFqdn,
              });
            } else {
              // Create new capability_records
              // Infer namespace from first tool's server (e.g., "filesystem:read" -> "filesystem")
              const firstTool = toolsCalled[0] ?? "misc";
              const namespace = firstTool.includes(":") ? firstTool.split(":")[0] : "code";
              // Auto-generate action from code hash
              const action = `exec_${codeHash.substring(0, 8)}`;
              // 4-char hash for FQDN
              const hash = codeHash.substring(0, 4);
              // Migration 028: displayName removed, use namespace:action instead
              autoDisplayName = `${namespace}:${action}`;

              const record = await deps.capabilityRegistry.create({
                org: DEFAULT_SCOPE.org,
                project: DEFAULT_SCOPE.project,
                namespace,
                action,
                workflowPatternId: capability.id,
                hash,
                createdBy: "pml_execute",
                toolsUsed: toolsCalled, // Story 13.9: routing inference
              });

              capabilityFqdn = record.id;

              log.info("[pml:execute] Capability registered with auto FQDN", {
                name: autoDisplayName,
                fqdn: capabilityFqdn,
              });
            }
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
        const successOutputs = physicalResults.results
          .filter((r) => r.status === "success")
          .map((r) => unwrapCodeResult(r.output));

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
 * Execute accepted suggestion: Execute a capability/tool from suggestedDag
 *
 * Flow:
 * 1. Resolve callName via CapabilityRegistry (namespace:action format)
 * 2. Merge provided args with capability defaults
 * 3. Execute capability code via WorkerBridge
 * 4. Record usage metrics
 *
 * @param callName - Call name from suggestedDag (e.g., "fs:read_json", "namespace:action")
 * @param args - Arguments to pass to capability
 * @param options - Execution options
 * @param deps - Dependencies
 * @param startTime - Start timestamp for metrics
 */
async function executeAcceptedSuggestion(
  callName: string,
  args: Record<string, JsonValue>,
  options: ExecuteArgs["options"],
  deps: ExecuteDependencies,
  startTime: number,
): Promise<MCPToolResponse | MCPErrorResponse> {
  // Check if registry is available
  if (!deps.capabilityRegistry) {
    return formatMCPToolError(
      "Accept suggestion requires CapabilityRegistry. " +
        "Ensure gateway is properly configured with capabilityRegistry dependency.",
    );
  }

  log.info("[pml:execute] Accept Suggestion - resolving callName", {
    callName,
    argsKeys: Object.keys(args),
  });

  // Resolve callName to capability record
  const record = await deps.capabilityRegistry.resolveByName(callName, DEFAULT_SCOPE);

  if (!record) {
    return formatMCPToolError(
      `Capability not found for callName: ${callName}. ` +
        "Ensure the callName matches a capability from the suggestedDag.",
    );
  }

  // Migration 023: Fetch code from workflow_pattern via FK
  if (!record.workflowPatternId) {
    return formatMCPToolError(
      `Capability '${callName}' has no linked workflow_pattern. Cannot execute.`,
    );
  }

  // Fetch code and parameters from workflow_pattern
  const wpResult = await deps.db.query(
    `SELECT code_snippet, parameters_schema, description FROM workflow_pattern WHERE pattern_id = $1`,
    [record.workflowPatternId],
  );

  if (wpResult.length === 0) {
    return formatMCPToolError(
      `Capability '${callName}' linked workflow_pattern not found. Cannot execute.`,
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
      `Capability '${callName}' has no code snippet stored. Cannot execute.`,
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

        // Bug 3 fix: Inject merged args for parameterized capabilities
        // When capability code has been transformed to use args.xxx references,
        // the args need to be available in the execution context
        if (Object.keys(mergedArgs).length > 0) {
          controlledExecutor.setExecutionArgs(mergedArgs);
        }

        // Per-layer validation check
        if (perLayerValidation && deps.workflowDeps) {
          return await handleWorkflowExecution(
            {
              workflow: { tasks: optimizedDAG.tasks },
              intent: `Execute capability: ${callName}`,
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
          mode: "accept_suggestion",
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

        log.info("[pml:execute] Accept Suggestion completed", {
          callName,
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
      `Capability '${callName}' code cannot be executed - no MCP tools found.`,
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
 * Story 10.1: Also includes children (contained capabilities) for hierarchy.
 */
async function registerSHGATNodes(
  shgat: SHGAT | undefined,
  embeddingModel: EmbeddingModelInterface | undefined,
  capability: {
    id: string;
    toolsUsed?: string[];
    successRate: number;
    children?: string[];
    parents?: string[];
    hierarchyLevel?: number;
  },
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

    // Build members: tools + child capabilities (Story 10.1)
    const toolMembers = (capability.toolsUsed ?? toolsCalled).map((id) => ({
      type: "tool" as const,
      id,
    }));
    const capabilityMembers = (capability.children ?? []).map((id) => ({
      type: "capability" as const,
      id,
    }));
    const allMembers = [...toolMembers, ...capabilityMembers];

    // Register the capability with hierarchy info
    shgat.registerCapability({
      id: capability.id,
      embedding,
      members: allMembers,
      hierarchyLevel: capability.hierarchyLevel ?? 0,
      successRate: capability.successRate,
      children: capability.children,
      parents: capability.parents,
    });

    log.debug("[pml:execute] SHGAT nodes registered", {
      capabilityId: capability.id,
      toolsCount: toolsCalled.length,
      childrenCount: capability.children?.length ?? 0,
      hierarchyLevel: capability.hierarchyLevel ?? 0,
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
  // Note: SHGAT K-head trained on capabilities, DR-DSP for suggested DAG
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
        targetName: capInfo?.name ?? capInfo?.description?.substring(0, 30) ??
          cap.capabilityId.substring(0, 8),
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
    log.info("[pml:execute] No capabilities found - returning suggestions");
    return {
      content: [{
        type: "text",
        text: JSON.stringify(
          {
            status: "suggestions",
            suggestions: { confidence: 0 },
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
    // Still attempt DR-DSP backward (may have partial data)
    const suggestion = await getSuggestion(buildSuggestionDeps(deps), intent, {
      id: bestMatch.capabilityId,
      score: bestMatch.score,
    }, correlationId);
    return {
      content: [{
        type: "text",
        text: JSON.stringify(
          {
            status: "suggestions",
            suggestions: suggestion,
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
    const suggestion = await getSuggestion(buildSuggestionDeps(deps), intent, {
      id: bestMatch.capabilityId,
      score: bestMatch.score,
    }, correlationId);

    return {
      content: [{
        type: "text",
        text: JSON.stringify(
          {
            status: "suggestions",
            suggestions: suggestion,
            executionTimeMs: performance.now() - startTime,
          } as ExecuteResponse,
          null,
          2,
        ),
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

  const suggestion = await getSuggestion(buildSuggestionDeps(deps), intent, {
    id: bestMatch.capabilityId,
    score: bestMatch.score,
  }, correlationId);

  return {
    content: [{
      type: "text",
      text: JSON.stringify(
        {
          status: "suggestions",
          suggestions: suggestion,
          executionTimeMs: performance.now() - startTime,
        } as ExecuteResponse,
        null,
        2,
      ),
    }],
  };
}

// TODO(Epic-12): executeCapability function removed - speculative execution disabled
// until we have runtime argument binding (parameterized capabilities).
// The static_structure has hardcoded arguments from the original execution.
// See: docs/sprint-artifacts/10-7-pml-execute-api.md for Epic-12 roadmap.

// getSuggestion moved to suggestion-handler.ts (thin) + GetSuggestionUseCase

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
