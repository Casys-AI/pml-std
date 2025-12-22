/**
 * Control Commands Handler
 *
 * Handles workflow control commands: continue, abort, replan, approval_response.
 *
 * @module mcp/handlers/control-commands-handler
 */

import * as log from "@std/log";
import type {
  MCPToolResponse,
  MCPErrorResponse,
  ActiveWorkflow,
  ContinueArgs,
  AbortArgs,
  ReplanArgs,
  ApprovalResponseArgs,
} from "../server/types.ts";
import { ServerDefaults } from "../server/constants.ts";
import {
  formatMCPToolError,
  formatAbortConfirmation,
  formatRejectionConfirmation,
  formatReplanConfirmation,
} from "../server/responses.ts";
import { ControlledExecutor } from "../../dag/controlled-executor.ts";
import {
  deleteWorkflowDAG,
  extendWorkflowDAGExpiration,
  getWorkflowDAG,
  updateWorkflowDAG,
} from "../workflow-dag-store.ts";
import { processGeneratorUntilPause } from "./workflow-execution-handler.ts";
import type { WorkflowHandlerDependencies } from "./workflow-handler-types.ts";
// Story 10.5 AC10: WorkerBridge-based executor for 100% traceability
import {
  createToolExecutorViaWorker,
  type ExecutorContext,
} from "../../dag/execution/workerbridge-executor.ts";
import type { ToolDefinition } from "../../sandbox/types.ts";
import { buildToolDefinitionsFromDAG } from "./shared/tool-definitions.ts";

/**
 * Create tool executor using WorkerBridge for 100% traceability
 *
 * Story 10.5 AC10: All MCP tool calls go through WorkerBridge RPC.
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
 * Handle continue command (Story 2.5-4)
 */
export async function handleContinue(
  args: unknown,
  deps: WorkflowHandlerDependencies,
): Promise<MCPToolResponse | MCPErrorResponse> {
  const params = args as ContinueArgs;

  if (!params.workflow_id) {
    return formatMCPToolError("Missing required parameter: 'workflow_id'");
  }

  log.info(
    `handleContinue: workflow_id=${params.workflow_id}, reason=${params.reason || "none"}`,
  );

  // Check in-memory workflows first
  const activeWorkflow = deps.activeWorkflows.get(params.workflow_id);

  if (activeWorkflow) {
    return await continueFromActiveWorkflow(activeWorkflow, params.reason, deps);
  }

  // Fallback: Load from database
  const dag = await getWorkflowDAG(deps.db, params.workflow_id);
  if (!dag) {
    return formatMCPToolError(
      `Workflow ${params.workflow_id} not found or expired`,
      { workflow_id: params.workflow_id },
    );
  }

  // Load latest checkpoint
  if (!deps.checkpointManager) {
    return formatMCPToolError("CheckpointManager not initialized");
  }

  const latestCheckpoint = await deps.checkpointManager.getLatestCheckpoint(params.workflow_id);
  if (!latestCheckpoint) {
    return formatMCPToolError(`No checkpoints found for workflow ${params.workflow_id}`);
  }

  // Story 10.5 AC10: Build tool definitions and create WorkerBridge executor
  const toolDefs = await buildToolDefinitionsFromDAG(dag, deps);
  const { executor, context } = createToolExecutorWithTracing(deps, toolDefs);

  // Create new executor and resume from checkpoint
  const controlledExecutor = new ControlledExecutor(executor, {
    taskTimeout: ServerDefaults.taskTimeout,
  });

  controlledExecutor.setCheckpointManager(deps.db, true);
  controlledExecutor.setDAGSuggester(deps.dagSuggester);
  controlledExecutor.setLearningDependencies(deps.capabilityStore, deps.graphEngine);

  const generator = controlledExecutor.resumeFromCheckpoint(dag, latestCheckpoint.id);

  log.info(`[Story 10.5] Resuming workflow via WorkerBridge`, {
    workflowId: params.workflow_id,
    layer: latestCheckpoint.layer + 1,
  });

  return await processGeneratorUntilPause(
    params.workflow_id,
    controlledExecutor,
    generator,
    dag,
    latestCheckpoint.layer + 1,
    deps,
    context,
  );
}

/**
 * Continue workflow from active in-memory state
 */
async function continueFromActiveWorkflow(
  workflow: ActiveWorkflow,
  reason: string | undefined,
  deps: WorkflowHandlerDependencies,
): Promise<MCPToolResponse> {
  log.debug(`Continuing workflow ${workflow.workflowId} from layer ${workflow.currentLayer}`);

  // Enqueue continue command to executor
  workflow.executor.enqueueCommand({
    type: "continue",
    reason: reason || "external_agent_continue",
  });

  workflow.status = "running";
  workflow.lastActivityAt = new Date();

  // Extend DAG TTL
  await extendWorkflowDAGExpiration(deps.db, workflow.workflowId);

  return await processGeneratorUntilPause(
    workflow.workflowId,
    workflow.executor,
    workflow.generator,
    workflow.dag,
    workflow.currentLayer + 1,
    deps,
  );
}

/**
 * Handle abort command (Story 2.5-4)
 */
export async function handleAbort(
  args: unknown,
  deps: WorkflowHandlerDependencies,
): Promise<MCPToolResponse | MCPErrorResponse> {
  const params = args as AbortArgs;

  if (!params.workflow_id) {
    return formatMCPToolError("Missing required parameter: 'workflow_id'");
  }

  if (!params.reason) {
    return formatMCPToolError("Missing required parameter: 'reason'");
  }

  log.info(`handleAbort: workflow_id=${params.workflow_id}, reason=${params.reason}`);

  // Check if workflow exists
  const activeWorkflow = deps.activeWorkflows.get(params.workflow_id);
  const dag = await getWorkflowDAG(deps.db, params.workflow_id);

  if (!activeWorkflow && !dag) {
    return formatMCPToolError(
      `Workflow ${params.workflow_id} not found or expired`,
      { workflow_id: params.workflow_id },
    );
  }

  // Send abort command if workflow is active
  if (activeWorkflow) {
    activeWorkflow.executor.enqueueCommand({
      type: "abort",
      reason: params.reason,
    });
    activeWorkflow.status = "aborted";
  }

  // Collect partial results
  const partialResults = activeWorkflow?.layerResults ?? [];
  const completedLayers = activeWorkflow?.currentLayer ?? 0;

  // Clean up resources
  deps.activeWorkflows.delete(params.workflow_id);
  await deleteWorkflowDAG(deps.db, params.workflow_id);

  log.info(`Workflow ${params.workflow_id} aborted: ${params.reason}`);

  return formatAbortConfirmation(
    params.workflow_id,
    params.reason,
    completedLayers,
    partialResults,
  );
}

/**
 * Handle replan command (Story 2.5-4)
 */
export async function handleReplan(
  args: unknown,
  deps: WorkflowHandlerDependencies,
): Promise<MCPToolResponse | MCPErrorResponse> {
  const params = args as ReplanArgs;

  if (!params.workflow_id) {
    return formatMCPToolError("Missing required parameter: 'workflow_id'");
  }

  if (!params.new_requirement) {
    return formatMCPToolError("Missing required parameter: 'new_requirement'");
  }

  log.info(
    `handleReplan: workflow_id=${params.workflow_id}, new_requirement=${params.new_requirement}`,
  );

  // Get current DAG
  const currentDag = await getWorkflowDAG(deps.db, params.workflow_id);
  if (!currentDag) {
    return formatMCPToolError(
      `Workflow ${params.workflow_id} not found or expired`,
      { workflow_id: params.workflow_id },
    );
  }

  // Get active workflow state
  const activeWorkflow = deps.activeWorkflows.get(params.workflow_id);
  const completedTasks = activeWorkflow?.layerResults ?? [];

  // Replan via DAGSuggester/GraphRAG
  try {
    const augmentedDAG = await deps.dagSuggester.replanDAG(currentDag, {
      completedTasks: completedTasks.map((t) => ({
        taskId: t.taskId,
        status: t.status,
        output: t.output,
      })),
      newRequirement: params.new_requirement,
      availableContext: params.available_context ?? {},
    });

    // Calculate new tasks added
    const newTasksCount = augmentedDAG.tasks.length - currentDag.tasks.length;
    const newTaskIds = augmentedDAG.tasks
      .filter((t) => !currentDag.tasks.some((ct) => ct.id === t.id))
      .map((t) => t.id);

    // Update DAG in database
    await updateWorkflowDAG(deps.db, params.workflow_id, augmentedDAG);

    // Update active workflow if exists
    if (activeWorkflow) {
      activeWorkflow.dag = augmentedDAG;
      activeWorkflow.lastActivityAt = new Date();

      // Send replan command to executor
      activeWorkflow.executor.enqueueCommand({
        type: "replan_dag",
        newRequirement: params.new_requirement,
        availableContext: params.available_context ?? {},
      });
    }

    log.info(`Workflow ${params.workflow_id} replanned: ${newTasksCount} new tasks`);

    return formatReplanConfirmation(
      params.workflow_id,
      params.new_requirement,
      newTasksCount,
      newTaskIds,
      augmentedDAG.tasks.length,
    );
  } catch (error) {
    log.error(`Replan failed: ${error}`);
    return formatMCPToolError(
      `Replanning failed: ${error instanceof Error ? error.message : String(error)}`,
      { workflow_id: params.workflow_id },
    );
  }
}

/**
 * Handle approval_response command (Story 2.5-4)
 */
export async function handleApprovalResponse(
  args: unknown,
  deps: WorkflowHandlerDependencies,
): Promise<MCPToolResponse | MCPErrorResponse> {
  const params = args as ApprovalResponseArgs;

  if (!params.workflow_id) {
    return formatMCPToolError("Missing required parameter: 'workflow_id'");
  }

  if (!params.checkpoint_id) {
    return formatMCPToolError("Missing required parameter: 'checkpoint_id'");
  }

  if (params.approved === undefined) {
    return formatMCPToolError("Missing required parameter: 'approved'");
  }

  log.info(
    `handleApprovalResponse: workflow_id=${params.workflow_id}, checkpoint_id=${params.checkpoint_id}, approved=${params.approved}`,
  );

  // Get active workflow
  const activeWorkflow = deps.activeWorkflows.get(params.workflow_id);

  if (!activeWorkflow) {
    const dag = await getWorkflowDAG(deps.db, params.workflow_id);
    if (!dag) {
      return formatMCPToolError(
        `Workflow ${params.workflow_id} not found or expired`,
        { workflow_id: params.workflow_id },
      );
    }

    return formatMCPToolError(
      `Workflow ${params.workflow_id} is not active. Use 'continue' to resume.`,
      { workflow_id: params.workflow_id },
    );
  }

  // Send approval command to executor
  activeWorkflow.executor.enqueueCommand({
    type: "approval_response",
    checkpointId: params.checkpoint_id,
    approved: params.approved,
    feedback: params.feedback,
  });

  if (!params.approved) {
    // Rejected - abort workflow
    activeWorkflow.status = "aborted";

    const partialResults = activeWorkflow.layerResults;
    const completedLayers = activeWorkflow.currentLayer;

    // Clean up
    deps.activeWorkflows.delete(params.workflow_id);
    await deleteWorkflowDAG(deps.db, params.workflow_id);

    log.info(`Workflow ${params.workflow_id} rejected at checkpoint ${params.checkpoint_id}`);

    return formatRejectionConfirmation(
      params.workflow_id,
      params.checkpoint_id,
      params.feedback,
      completedLayers,
      partialResults,
    );
  }

  // Approved - continue execution
  activeWorkflow.status = "running";
  activeWorkflow.lastActivityAt = new Date();

  // Extend TTL
  await extendWorkflowDAGExpiration(deps.db, params.workflow_id);

  log.info(`Workflow ${params.workflow_id} approved at checkpoint ${params.checkpoint_id}`);

  return await processGeneratorUntilPause(
    params.workflow_id,
    activeWorkflow.executor,
    activeWorkflow.generator,
    activeWorkflow.dag,
    activeWorkflow.currentLayer + 1,
    deps,
  );
}
