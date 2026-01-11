/**
 * Shared types for MCP Mini-Tools Library
 *
 * @module lib/std/types
 */

/** MCP Tool definition */
export interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** MCP Client interface */
export interface MCPClientBase {
  readonly serverId: string;
  readonly serverName: string;
  connect(): Promise<void>;
  listTools(): Promise<MCPTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  disconnect(): Promise<void>;
}

/** Tool category identifier */
export type ToolCategory =
  | "text"
  | "json"
  | "math"
  | "datetime"
  | "crypto"
  | "collections"
  | "vfs"
  | "data"
  | "http"
  | "validation"
  | "format"
  | "transform"
  | "state"
  | "compare"
  | "algo"
  | "color"
  | "network"
  | "util"
  | "system"
  // New categories from expanded std lib
  | "string"
  | "path"
  | "faker"
  | "geo"
  | "qrcode"
  | "resilience"
  | "schema"
  | "diff"
  // System tool categories
  | "docker"
  | "git"
  | "process"
  | "archive"
  | "ssh"
  | "kubernetes"
  | "database"
  | "media"
  | "cloud"
  | "sysinfo"
  | "packages"
  // Agent tools (MCP Sampling)
  | "agent"
  // Python execution
  | "python"
  // PML tools (capability management)
  | "pml";

/** Mini tool handler function type */
export type MiniToolHandler = (args: Record<string, unknown>) => Promise<unknown> | unknown;

/** Mini tool result type */
export type MiniToolResult = unknown;

/** Mini tool definition with handler */
export interface MiniTool {
  name: string;
  description: string;
  category: ToolCategory;
  inputSchema: Record<string, unknown>;
  handler: MiniToolHandler;
}

/** Helper to create a tool with type safety */
export function defineTool(
  name: string,
  description: string,
  category: ToolCategory,
  inputSchema: Record<string, unknown>,
  handler: (args: Record<string, unknown>) => Promise<unknown> | unknown,
): MiniTool {
  return { name, description, category, inputSchema, handler };
}
