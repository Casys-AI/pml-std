/**
 * Workflow Execution Handler
 *
 * Handles DAG workflow execution, per-layer validation, and generator processing.
 *
 * @module mcp/handlers/workflow-execution-handler
 */

import * as log from "@std/log";
import type { DAGStructure } from "../../graphrag/types.ts";
import type { ExecutionEvent, TaskResult } from "../../dag/types.ts";
import type { WorkflowState } from "../../dag/state.ts";
import type {
  ActiveWorkflow,
  MCPErrorResponse,
  MCPToolResponse,
  WorkflowExecutionArgs,
} from "../server/types.ts";
import { ServerDefaults } from "../server/constants.ts";
import {
  formatApprovalRequired,
  formatLayerComplete,
  formatMCPSuccess,
  formatMCPToolError,
  formatWorkflowComplete,
} from "../server/responses.ts";
import { ControlledExecutor } from "../../dag/controlled-executor.ts";
import { deleteWorkflowDAG, saveWorkflowDAG } from "../workflow-dag-store.ts";
import type { WorkflowHandlerDependencies } from "./workflow-handler-types.ts";
import { getTaskType } from "../../dag/execution/task-router.ts";
import type { CapabilityStore } from "../../capabilities/capability-store.ts";
import { getToolPermissionConfig } from "../../capabilities/permission-inferrer.ts";
import type { AdaptiveThresholdManager, ThresholdMode } from "../adaptive-threshold.ts";
import { updateThompsonSampling } from "./execute-handler.ts";
// Story 10.5 AC10: WorkerBridge-based executor for 100% traceability
import {
  cleanupWorkerBridgeExecutor,
  createToolExecutorViaWorker,
  type ExecutorContext,
} from "../../dag/execution/workerbridge-executor.ts";
import type { ToolDefinition } from "../../sandbox/types.ts";
import { buildToolDefinitionsFromDAG } from "./shared/tool-definitions.ts";

/**
 * Determine if a DAG requires per-layer validation based on permissions.
 *
 * Server-side decision - client cannot bypass.
 *
 * Validation required when:
 * - code_execution with permissionSet !== "minimal" (elevated permissions)
 * - capability task with non-minimal permissions
 * - mcp_tool with scope !== "minimal", approvalMode === "hil", ffi, or run
 *
 * No validation needed for:
 * - code_execution with minimal permissions (errors are clear, suggest primitives)
 * - pure operations (filter, map, reduce, etc.) - Phase 1
 * - mcp_tool with minimal scope and auto approval (safe by default)
 */
export async function requiresValidation(
  dag: DAGStructure,
  capabilityStore?: CapabilityStore,
): Promise<boolean> {
  for (const task of dag.tasks) {
    const taskType = getTaskType(task);

    // Code execution with elevated permissions → needs validation
    if (taskType === "code_execution") {
      // Phase 2a: Pure operations NEVER require validation (checked via metadata)
      if (task.metadata?.pure === true) {
        log.debug(`Skipping validation for pure operation: ${task.tool}`);
        continue;
      }

      const permSet = task.sandboxConfig?.permissionSet ?? "minimal";
      if (permSet !== "minimal") {
        log.info(`Validation required: task ${task.id} has elevated permissions (${permSet})`);
        return true;
      }
    }

    // Capability with non-minimal permissions → needs validation
    if (taskType === "capability" && task.capabilityId && capabilityStore) {
      try {
        const cap = await capabilityStore.findById(task.capabilityId);
        if (cap?.permissionSet && cap.permissionSet !== "minimal") {
          log.info(
            `Validation required: capability ${task.capabilityId} has permissions (${cap.permissionSet})`,
          );
          return true;
        }
      } catch {
        // Capability not found - skip validation check
      }
    }

    // MCP tool validation check
    if (taskType === "mcp_tool" && task.tool) {
      const toolPrefix = task.tool.split(":")[0]; // "github:create_issue" → "github"
      const permConfig = getToolPermissionConfig(toolPrefix);

      // Unknown tool → requires validation (security: don't auto-approve unknown tools)
      if (!permConfig) {
        log.info(
          `Validation required: MCP tool ${task.tool} is unknown (not in mcp-permissions.yaml)`,
        );
        return true;
      }

      // Explicit HIL → requires validation
      if (permConfig.approvalMode === "hil") {
        log.info(`Validation required: MCP tool ${task.tool} explicitly requires human approval`);
        return true;
      }
    }
  }

  // Known tools with auto approval → no validation needed
  return false;
}

/**
 * Smart HIL: Determine if a DAG requires HIL using Thompson Sampling (Story 10.7c AC5)
 *
 * Checks each tool against Thompson thresholds:
 * 1. If tool requires HIL via approvalMode:hil → always HIL
 * 2. If tool is unknown → always HIL (security)
 * 3. Otherwise, check if Thompson threshold > current confidence → HIL
 *
 * @param dag - DAG structure with tasks
 * @param thresholdManager - AdaptiveThresholdManager with Thompson Sampling
 * @param confidence - Current confidence score (from SHGAT/DR-DSP)
 * @param mode - Threshold mode (active_search, passive_suggestion, speculation)
 * @returns Object with HIL required flag and details
 */
export function smartHILCheck(
  dag: DAGStructure,
  thresholdManager: AdaptiveThresholdManager,
  confidence: number,
  mode: ThresholdMode = "passive_suggestion",
): {
  requiresHIL: boolean;
  reason?: string;
  toolsRequiringHIL: string[];
  thresholdBreakdown: Array<{
    toolId: string;
    thompsonThreshold: number;
    confidence: number;
    requiresHIL: boolean;
    reason: string;
  }>;
} {
  const toolsRequiringHIL: string[] = [];
  const thresholdBreakdown: Array<{
    toolId: string;
    thompsonThreshold: number;
    confidence: number;
    requiresHIL: boolean;
    reason: string;
  }> = [];

  for (const task of dag.tasks) {
    const taskType = getTaskType(task);

    // Only check MCP tools for Thompson thresholds
    if (taskType === "mcp_tool" && task.tool) {
      // Check if tool explicitly requires HIL
      if (thresholdManager.requiresHIL(task.tool)) {
        toolsRequiringHIL.push(task.tool);
        thresholdBreakdown.push({
          toolId: task.tool,
          thompsonThreshold: 1.0, // Always HIL
          confidence,
          requiresHIL: true,
          reason: "approvalMode:hil or unknown tool",
        });
        continue;
      }

      // Get Thompson threshold for this tool
      const thresholdResult = thresholdManager.getThresholdForTool(task.tool, mode);
      const requiresHIL = confidence < thresholdResult.threshold;

      if (requiresHIL) {
        toolsRequiringHIL.push(task.tool);
      }

      thresholdBreakdown.push({
        toolId: task.tool,
        thompsonThreshold: thresholdResult.threshold,
        confidence,
        requiresHIL,
        reason: requiresHIL
          ? `confidence ${confidence.toFixed(3)} < threshold ${
            thresholdResult.threshold.toFixed(3)
          }`
          : `confidence ${confidence.toFixed(3)} >= threshold ${
            thresholdResult.threshold.toFixed(3)
          }`,
      });
    }
  }

  const requiresHIL = toolsRequiringHIL.length > 0;
  const reason = requiresHIL
    ? `${toolsRequiringHIL.length} tool(s) require HIL: ${toolsRequiringHIL.join(", ")}`
    : undefined;

  log.debug("[SmartHIL] Check complete", {
    requiresHIL,
    toolsRequiringHIL,
    confidence,
    mode,
  });

  return {
    requiresHIL,
    reason,
    toolsRequiringHIL,
    thresholdBreakdown,
  };
}

/**
 * Create tool executor using WorkerBridge for 100% traceability
 *
 * Story 10.5 AC10: All MCP tool calls go through WorkerBridge RPC.
 * This ensures complete tracing with tool_start/tool_end events.
 *
 * @deprecated Use createToolExecutorViaWorker directly for new code
 */
function createToolExecutorWithTracing(
  deps: WorkflowHandlerDependencies,
  toolDefs: ToolDefinition[],
): { executor: import("../../dag/types.ts").ToolExecutor; context: ExecutorContext } {
  const [executor, context] = createToolExecutorViaWorker({
    mcpClients: deps.mcpClients,
    toolDefinitions: toolDefs,
    capabilityStore: deps.capabilityStore,
    graphRAG: deps.graphEngine,
  });

  return { executor, context };
}

/**
 * Handle workflow execution request
 *
 * Supports three modes:
 * 1. Intent-based: Natural language → DAG suggestion
 * 2. Explicit: DAG structure → Execute
 * 3. Per-layer validation: Execute with pauses between layers (Story 2.5-4)
 *
 * @param args - Workflow arguments (intent or workflow, optional config)
 * @param deps - Handler dependencies
 * @param userId - Optional user ID for multi-tenant isolation
 * @returns Execution result, suggestion, or layer_complete status
 */
export async function handleWorkflowExecution(
  args: unknown,
  deps: WorkflowHandlerDependencies,
  userId?: string,
): Promise<MCPToolResponse | MCPErrorResponse> {
  // Story 10.7: Deprecation warning
  log.warn(
    "[DEPRECATED] pml:execute_dag is deprecated. Use pml:execute instead for unified execution + automatic capability learning.",
  );

  const workflowArgs = args as WorkflowExecutionArgs;
  const perLayerValidation = workflowArgs.config?.per_layer_validation === true;

  // Case 1: Explicit workflow provided
  if (workflowArgs.workflow) {
    // Normalize tasks: ensure dependsOn is always an array
    const normalizedWorkflow: DAGStructure = {
      ...workflowArgs.workflow,
      tasks: workflowArgs.workflow.tasks.map((task) => ({
        ...task,
        dependsOn: task.dependsOn ?? [],
      })),
    };

    // Server-side validation detection (Story 2.5-4 security fix)
    // Server decides based on DAG content - client cannot bypass
    const serverRequiresValidation = await requiresValidation(
      normalizedWorkflow,
      deps.capabilityStore,
    );
    const useValidation = serverRequiresValidation || perLayerValidation;

    log.info(`Executing explicit workflow`, {
      clientRequested: perLayerValidation,
      serverRequired: serverRequiresValidation,
      usingValidation: useValidation,
    });

    if (useValidation) {
      return await executeWithPerLayerValidation(
        normalizedWorkflow,
        workflowArgs.intent ?? "explicit_workflow",
        deps,
        userId,
      );
    }

    // Standard execution (no validation pauses - safe DAG)
    return await executeStandardWorkflow(normalizedWorkflow, workflowArgs.intent, deps, userId);
  }

  // Case 2: Intent-based (GraphRAG suggestion)
  if (workflowArgs.intent) {
    log.info(`Processing workflow intent: "${workflowArgs.intent}"`);

    const executionMode = await deps.gatewayHandler.processIntent({
      text: workflowArgs.intent,
    });

    if (executionMode.mode === "explicit_required") {
      return formatMCPSuccess({
        mode: "explicit_required",
        message: executionMode.explanation || "Low confidence - please provide explicit workflow",
        confidence: executionMode.confidence,
      });
    }

    if (executionMode.mode === "suggestion" && executionMode.dagStructure) {
      // Server-side validation detection for suggested DAG
      const serverRequiresValidation = await requiresValidation(
        executionMode.dagStructure,
        deps.capabilityStore,
      );
      const useValidation = serverRequiresValidation || perLayerValidation;

      log.info(`Intent suggestion`, {
        clientRequested: perLayerValidation,
        serverRequired: serverRequiresValidation,
        usingValidation: useValidation,
      });

      if (useValidation) {
        return await executeWithPerLayerValidation(
          executionMode.dagStructure,
          workflowArgs.intent,
          deps,
          userId,
        );
      }

      // Return suggestion for client to review (no auto-execute without validation)
      return formatMCPSuccess({
        mode: "suggestion",
        suggested_dag: executionMode.dagStructure,
        confidence: executionMode.confidence,
        explanation: executionMode.explanation,
      });
    }

    if (executionMode.mode === "suggestion") {
      // No DAG structure generated
      return formatMCPSuccess({
        mode: "suggestion",
        suggested_dag: executionMode.dagStructure,
        confidence: executionMode.confidence,
        explanation: executionMode.explanation,
      });
    }

    if (executionMode.mode === "speculative_execution") {
      return formatMCPSuccess({
        mode: "speculative_execution",
        results: executionMode.results,
        confidence: executionMode.confidence,
        executionTimeMs: executionMode.executionTimeMs,
      });
    }
  }

  // Neither intent nor workflow provided
  return formatMCPToolError(
    "Either 'intent' or 'workflow' must be provided",
    { received: Object.keys(workflowArgs) },
  );
}

/**
 * Execute standard workflow without validation pauses
 *
 * Story 10.5 AC10: Uses WorkerBridge for 100% RPC traceability.
 */
async function executeStandardWorkflow(
  dag: DAGStructure,
  intent: string | undefined,
  deps: WorkflowHandlerDependencies,
  userId?: string,
): Promise<MCPToolResponse> {
  // Build tool definitions for WorkerBridge context
  const toolDefs = await buildToolDefinitionsFromDAG(dag, deps);

  // Create WorkerBridge-based executor for tracing
  const { executor, context } = createToolExecutorWithTracing(deps, toolDefs);

  try {
    const controlledExecutor = new ControlledExecutor(executor, {
      taskTimeout: ServerDefaults.taskTimeout,
      userId: userId ?? "local",
    });

    controlledExecutor.setDAGSuggester(deps.dagSuggester);
    controlledExecutor.setLearningDependencies(deps.capabilityStore, deps.graphEngine);
    // Phase 1: Set WorkerBridge for code execution task tracing
    controlledExecutor.setWorkerBridge(context.bridge);

    const result = await controlledExecutor.execute(dag);

    // Update graph with execution data (learning loop)
    await deps.graphEngine.updateFromExecution({
      executionId: crypto.randomUUID(),
      executedAt: new Date(),
      intentText: intent ?? "",
      dagStructure: dag,
      success: result.errors.length === 0,
      executionTimeMs: result.executionTimeMs,
      userId: userId ?? "local",
    });

    // Story 10.7c: Update Thompson Sampling with execution outcomes
    const thompsonResults = result.results.map((r) => {
      const task = dag.tasks.find((t) => t.id === r.taskId);
      return {
        taskId: r.taskId,
        tool: task?.tool ?? "unknown",
        args: {} as Record<string, import("../../capabilities/types.ts").JsonValue>,
        result: (r.output ?? null) as import("../../capabilities/types.ts").JsonValue,
        success: r.status === "success",
        durationMs: r.executionTimeMs ?? 0,
      };
    });
    updateThompsonSampling(deps.adaptiveThresholdManager, thompsonResults);

    log.info(`[Story 10.5] Workflow executed via WorkerBridge`, {
      tracesCount: context.traces.length,
      tasksCount: dag.tasks.length,
    });

    return formatMCPSuccess({
      status: "completed",
      results: result.results,
      executionTimeMs: result.executionTimeMs,
      parallelization_layers: result.parallelizationLayers,
      errors: result.errors,
    });
  } finally {
    // Cleanup WorkerBridge resources
    cleanupWorkerBridgeExecutor(context);
  }
}

/**
 * Execute workflow with per-layer validation (Story 2.5-4)
 *
 * Story 10.5 AC10: Uses WorkerBridge for 100% RPC traceability.
 */
async function executeWithPerLayerValidation(
  dag: DAGStructure,
  intent: string,
  deps: WorkflowHandlerDependencies,
  userId?: string,
): Promise<MCPToolResponse> {
  const workflowId = crypto.randomUUID();

  // Save DAG to database for stateless continuation
  await saveWorkflowDAG(deps.db, workflowId, dag, intent);

  // Build tool definitions for WorkerBridge context
  const toolDefs = await buildToolDefinitionsFromDAG(dag, deps);

  // Create WorkerBridge-based executor for tracing
  const { executor, context } = createToolExecutorWithTracing(deps, toolDefs);

  // Create ControlledExecutor for this workflow
  // Story 10.7c fix: Enable perLayerValidation so generator pauses after checkpoints
  const controlledExecutor = new ControlledExecutor(executor, {
    taskTimeout: ServerDefaults.taskTimeout,
    userId: userId ?? "local",
    perLayerValidation: true,
  });

  // Configure checkpointing
  controlledExecutor.setCheckpointManager(deps.db, true);
  controlledExecutor.setDAGSuggester(deps.dagSuggester);
  controlledExecutor.setLearningDependencies(deps.capabilityStore, deps.graphEngine);

  // Start streaming execution
  const generator = controlledExecutor.executeStream(dag, workflowId);

  log.info(`[Story 10.5] Starting per-layer validation via WorkerBridge`, {
    workflowId,
    tasksCount: dag.tasks.length,
    toolDefsCount: toolDefs.length,
  });

  // Process events until first layer completes
  // Note: ExecutorContext cleanup happens when workflow completes or aborts
  return await processGeneratorUntilPause(
    workflowId,
    controlledExecutor,
    generator,
    dag,
    0,
    deps,
    context,
  );
}

/**
 * Process generator events until next pause point or completion
 *
 * @param executorContext - Optional ExecutorContext for WorkerBridge cleanup (Story 10.5)
 */
export async function processGeneratorUntilPause(
  workflowId: string,
  executor: ControlledExecutor,
  generator: AsyncGenerator<ExecutionEvent, WorkflowState, void>,
  dag: DAGStructure,
  expectedLayer: number,
  deps: WorkflowHandlerDependencies,
  executorContext?: ExecutorContext,
): Promise<MCPToolResponse> {
  const layerResults: TaskResult[] = [];
  let currentLayer = expectedLayer;
  let totalLayers = 0;
  let latestCheckpointId: string | null = null;

  for await (const event of generator) {
    if (event.type === "workflow_start") {
      totalLayers = event.totalLayers ?? 0;
    }

    if (event.type === "task_complete" || event.type === "task_error") {
      layerResults.push({
        taskId: event.taskId ?? "",
        status: event.type === "task_complete" ? "success" : "error",
        output: event.type === "task_complete"
          ? {
            executionTimeMs: event.executionTimeMs,
            resultPreview: event.resultPreview,
            resultSize: event.resultSize,
          }
          : undefined,
        error: event.type === "task_error" ? event.error : undefined,
      });
    }

    // Story 2.5-3 HIL Fix: Handle decision_required events
    if (event.type === "decision_required") {
      const activeWorkflow: ActiveWorkflow = {
        workflowId,
        executor,
        generator,
        dag,
        currentLayer,
        totalLayers,
        layerResults: [...layerResults],
        status: "awaiting_approval",
        createdAt: deps.activeWorkflows.get(workflowId)?.createdAt ?? new Date(),
        lastActivityAt: new Date(),
        latestCheckpointId: event.checkpointId ?? null,
      };
      deps.activeWorkflows.set(workflowId, activeWorkflow);

      return formatApprovalRequired(
        workflowId,
        event.checkpointId,
        event.decisionType,
        event.description,
        event.context,
      );
    }

    if (event.type === "checkpoint") {
      latestCheckpointId = event.checkpointId ?? null;
      currentLayer = event.layerIndex ?? currentLayer;

      // Update active workflow state
      const activeWorkflow: ActiveWorkflow = {
        workflowId,
        executor,
        generator,
        dag,
        currentLayer,
        totalLayers,
        layerResults: [...layerResults],
        status: "paused",
        createdAt: deps.activeWorkflows.get(workflowId)?.createdAt ?? new Date(),
        lastActivityAt: new Date(),
        latestCheckpointId,
      };
      deps.activeWorkflows.set(workflowId, activeWorkflow);

      return formatLayerComplete(
        workflowId,
        latestCheckpointId,
        currentLayer,
        totalLayers,
        layerResults,
        currentLayer + 1 < totalLayers,
      );
    }

    if (event.type === "workflow_complete") {
      // Workflow completed - clean up
      deps.activeWorkflows.delete(workflowId);
      await deleteWorkflowDAG(deps.db, workflowId);

      // Story 10.5: Cleanup WorkerBridge resources
      if (executorContext) {
        cleanupWorkerBridgeExecutor(executorContext);
        log.debug(`[Story 10.5] WorkerBridge cleanup on workflow complete`, {
          workflowId,
          tracesCount: executorContext.traces.length,
        });
      }

      return formatWorkflowComplete(
        workflowId,
        event.totalTimeMs ?? 0,
        event.successfulTasks ?? 0,
        event.failedTasks ?? 0,
        layerResults,
      );
    }
  }

  // Generator exhausted without workflow_complete (unexpected)
  // Story 10.5: Still cleanup WorkerBridge
  if (executorContext) {
    cleanupWorkerBridgeExecutor(executorContext);
  }
  return formatMCPSuccess({ status: "complete", workflow_id: workflowId });
}
