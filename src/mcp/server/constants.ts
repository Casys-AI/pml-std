/**
 * MCP Gateway Server Constants
 *
 * JSON-RPC error codes and server defaults.
 *
 * @module mcp/server/constants
 */

/**
 * MCP JSON-RPC error codes (per JSON-RPC 2.0 spec)
 */
export const MCPErrorCodes = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

export type MCPErrorCode = (typeof MCPErrorCodes)[keyof typeof MCPErrorCodes];

/**
 * Default server configuration values
 */
export const ServerDefaults = {
  name: "mcp-gateway",
  version: "1.0.0",
  enableSpeculative: true,
  defaultToolLimit: 10,
  taskTimeout: 30000,
  maxCodeSizeBytes: 100 * 1024, // 100KB
} as const;

/**
 * Server description shown to MCP clients
 */
export const SERVER_TITLE =
  "PML - Orchestrate any MCP workflow. Use pml_execute with just an 'intent' (natural language) to auto-discover tools and execute. Or provide explicit 'code' for custom TypeScript workflows. Learns from successful executions.";
