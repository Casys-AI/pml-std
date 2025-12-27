/**
 * Workflow Handler
 *
 * Re-exports workflow execution and control command handlers.
 *
 * @module mcp/handlers/workflow-handler
 */

// Re-export types
export type { WorkflowHandlerDependencies } from "./workflow-handler-types.ts";

// Re-export workflow execution
export {
  handleWorkflowExecution,
  processGeneratorUntilPause,
} from "./workflow-execution-handler.ts";

// Re-export control commands
export {
  handleAbort,
  handleApprovalResponse,
  handleContinue,
  handleReplan,
} from "./control-commands-handler.ts";
