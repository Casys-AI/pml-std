/**
 * MCP Server Module
 *
 * Exports server types, constants, utilities, lifecycle, and health.
 *
 * @module mcp/server
 */

// Constants
export { type MCPErrorCode, MCPErrorCodes, SERVER_TITLE, ServerDefaults } from "./constants.ts";

// Types
export {
  type AbortArgs,
  type ActiveWorkflow,
  type ApprovalResponseArgs,
  type ContinueArgs,
  type GatewayServerConfig,
  type JsonRpcRequest,
  type MCPErrorResponse,
  type MCPHandlerResponse,
  type MCPToolResponse,
  type ReplanArgs,
  type ResolvedGatewayConfig,
  type SearchCapabilitiesArgs,
  type SearchToolsArgs,
  type WorkflowExecutionArgs,
} from "./types.ts";

// Response formatters
export {
  formatAbortConfirmation,
  formatApprovalRequired,
  formatLayerComplete,
  formatMCPError,
  formatMCPSuccess,
  formatMCPToolError,
  formatRejectionConfirmation,
  formatReplanConfirmation,
  formatWorkflowComplete,
} from "./responses.ts";

// Lifecycle management
export { createMCPServer, startStdioServer, stopServer } from "./lifecycle.ts";

// Health checks
export {
  getHealthStatus,
  handleDashboardRedirect,
  handleEventsStream,
  handleHealth,
  type HealthStatus,
} from "./health.ts";

// HTTP server
export {
  createHttpRequestHandler,
  handleJsonRpcRequest,
  type HttpServerDependencies,
  type HttpServerState,
  startHttpServer,
} from "./http.ts";
