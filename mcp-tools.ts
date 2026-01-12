/**
 * MCP Mini-Tools Library
 *
 * A collection of lightweight utility tools implementing MCPClientBase.
 * Designed for playground demos and educational use.
 *
 * This module re-exports from lib/std/ which contains the actual implementations.
 * For direct access to specific categories, import from lib/std/mod.ts or
 * individual category modules.
 *
 * Categories:
 * - text:        String manipulation with change-case
 * - json:        JSON operations with jmespath
 * - math:        Calculations with mathjs, simple-statistics
 * - datetime:    Date/time operations with date-fns
 * - crypto:      Hashing and encoding with Web Crypto API
 * - collections: Array operations with lodash-es
 * - vfs:         Virtual filesystem (in-memory)
 * - data:        Fake data generation with @faker-js/faker
 * - http:        URL building, parsing, fetch
 * - validation:  Validation with zod, validator
 * - format:      Number/text formatting with Intl
 * - transform:   CSV/XML transforms with papaparse
 * - state:       Key-value store with TTL
 * - compare:     Diff with diff, jsondiffpatch
 * - algo:        Algorithms with mnemonist
 *
 * @module lib/mcp-tools
 */

// Re-export everything from primitives
export {
  algoTools,
  // Combined arrays
  allTools,
  collectionsTools,
  compareTools,
  cryptoTools,
  dataTools,
  datetimeTools,
  defaultClient,
  formatTools,
  getCategories,
  getToolByName,
  // Helper functions
  getToolsByCategory,
  httpTools,
  jsonTools,
  mathTools,
  // Client class
  MiniToolsClient,
  stateTools,
  // Tool arrays by category
  textTools,
  toolsByCategory,
  transformTools,
  validationTools,
  vfsTools,
} from "./std/mod.ts";

// Re-export types
export type { MiniTool, MiniToolHandler, MiniToolResult } from "./std/types.ts";

// Import for local use
import { allTools, MiniToolsClient } from "./std/mod.ts";
import type { MiniTool } from "./std/types.ts";

// ============================================================================
// Legacy Types (for backward compatibility)
// ============================================================================

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
  | "algo";

// ============================================================================
// Legacy exports (for backward compatibility)
// ============================================================================

/**
 * All available mini tools
 * @deprecated Use allTools from lib/std/mod.ts instead
 */
export const MINI_TOOLS: MiniTool[] = allTools;

/**
 * MiniTools MCP Client - Implements MCPClientBase interface
 *
 * @example
 * ```typescript
 * const client = new MiniToolsMCP();
 * await client.connect();
 *
 * const tools = await client.listTools();
 * const result = await client.callTool("text_upper", { text: "hello" });
 * ```
 */
export class MiniToolsMCP implements MCPClientBase {
  readonly serverId = "mini-tools";
  readonly serverName = "MiniTools";

  private client: MiniToolsClient;
  private connected = false;

  constructor() {
    this.client = new MiniToolsClient();
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async listTools(): Promise<MCPTool[]> {
    return this.client.toMCPFormat();
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.connected) {
      throw new Error("Client not connected");
    }
    return this.client.execute(name, args);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  /**
   * Get underlying MiniToolsClient for direct access
   */
  getClient(): MiniToolsClient {
    return this.client;
  }
}

/**
 * Default MiniToolsMCP instance
 */
export const miniToolsMCP: MiniToolsMCP = new MiniToolsMCP();
