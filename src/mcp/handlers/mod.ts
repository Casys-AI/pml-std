/**
 * MCP Handlers Module
 *
 * Exports all MCP tool handlers for use by the gateway server.
 *
 * @module mcp/handlers
 */

export { handleSearchCapabilities, handleSearchTools } from "./search-handler.ts";
export { type DiscoverArgs, handleDiscover } from "./discover-handler.ts";
export { type CodeExecutionDependencies, handleExecuteCode } from "./code-execution-handler.ts";
export { type ExecuteArgs, type ExecuteDependencies, handleExecute, trainingLock } from "./execute-handler.ts";
export {
  handleAbort,
  handleApprovalResponse,
  handleContinue,
  handleReplan,
  handleWorkflowExecution,
  processGeneratorUntilPause,
  type WorkflowHandlerDependencies,
} from "./workflow-handler.ts";
