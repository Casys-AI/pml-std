/**
 * Tool Discovery
 *
 * Discovery mechanisms for MCP tools.
 * Re-exports MCPServerDiscovery from the root discovery module.
 *
 * @module mcp/registry/discovery
 */

// Re-export the main discovery functionality
export { createDefaultDiscovery, MCPServerDiscovery } from "../discovery.ts";

/**
 * Tool discovery result
 */
export interface DiscoveredTool {
  name: string;
  serverId: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Discovery options
 */
export interface DiscoveryOptions {
  /** Include Smithery servers */
  includeSmithery?: boolean;
  /** Smithery API key */
  smitheryApiKey?: string;
  /** Filter by server IDs */
  serverIds?: string[];
}
