/**
 * MCP Handlers Module
 *
 * Exports all MCP tool handlers for use by the gateway server.
 *
 * @module mcp/handlers
 */

export { handleSearchTools, handleSearchCapabilities } from "./search-handler.ts";
export { handleDiscover, type DiscoverArgs } from "./discover-handler.ts";
export { handleExecuteCode, type CodeExecutionDependencies } from "./code-execution-handler.ts";
export { handleExecute, type ExecuteDependencies, type ExecuteArgs } from "./execute-handler.ts";
export {
  handleWorkflowExecution,
  handleContinue,
  handleAbort,
  handleReplan,
  handleApprovalResponse,
  processGeneratorUntilPause,
  type WorkflowHandlerDependencies,
} from "./workflow-handler.ts";
