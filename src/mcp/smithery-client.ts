/**
 * Smithery MCP Client
 *
 * MCP client for Smithery remote servers using HTTP Streamable transport.
 * Uses @smithery/sdk for URL construction and @modelcontextprotocol/sdk for protocol.
 *
 * @module mcp/smithery-client
 */

import * as log from "@std/log";
import type { MCPClientBase, MCPServer, MCPTool, ServerDiscoveryResult } from "./types.ts";
import { MCPServerError, TimeoutError } from "../errors/error-types.ts";
import { withTimeout } from "../utils/timeout.ts";

// SDK modules (lazy loaded)
// deno-lint-ignore no-explicit-any
let MCPClientClass: any;
let StreamableHTTPClientTransportClass: new (
  url: URL,
  options?: { requestInit?: RequestInit },
) => unknown;
let createSmitheryUrlFn: (
  serverUrl: string,
  options: { config: Record<string, unknown>; apiKey: string },
) => URL;
let sdkInitialized = false;

/**
 * Initialize SDK dependencies
 *
 * Lazily loads @smithery/sdk and @modelcontextprotocol/sdk
 */
async function initSDK(): Promise<void> {
  if (sdkInitialized) return;

  try {
    // Import MCP SDK client
    const mcpClientModule = await import("@modelcontextprotocol/sdk/client/index.js");
    MCPClientClass = mcpClientModule.Client;

    // Import StreamableHTTPClientTransport
    const transportModule = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    StreamableHTTPClientTransportClass = transportModule.StreamableHTTPClientTransport;

    // Import Smithery URL builder
    const smitheryModule = await import("@smithery/sdk/shared/config.js");
    createSmitheryUrlFn = smitheryModule.createSmitheryUrl;

    sdkInitialized = true;
    log.debug("Smithery SDK initialized");
  } catch (error) {
    throw new Error(
      `Failed to load Smithery SDK. Ensure @smithery/sdk and @modelcontextprotocol/sdk are installed: ${error}`,
    );
  }
}

/**
 * Configuration options for SmitheryMCPClient
 */
export interface SmitheryMCPClientConfig {
  /**
   * Request timeout in milliseconds (default: 30000)
   *
   * 30 seconds is used as default because Smithery servers may need time to:
   * - Cold start if not recently used
   * - Authenticate with OAuth
   * - Connect to downstream services (Airtable, Notion, etc.)
   */
  timeoutMs?: number;
  /** Smithery API key for authentication */
  apiKey: string;
}

/**
 * Mask sensitive data in error messages
 *
 * Prevents API keys and tokens from leaking into logs.
 */
function maskSensitiveData(message: string, apiKey: string): string {
  if (!apiKey || apiKey.length < 8) return message;

  // Mask the API key if it appears in the message
  const maskedKey = `${apiKey.substring(0, 4)}...${apiKey.substring(apiKey.length - 4)}`;
  return message.replaceAll(apiKey, maskedKey);
}

/**
 * SmitheryMCPClient - MCP client for Smithery remote servers
 *
 * Provides the same interface as MCPClient but uses HTTP Streamable transport
 * instead of stdio. Connects to servers hosted on server.smithery.ai.
 */
export class SmitheryMCPClient implements MCPClientBase {
  private server: MCPServer;
  private timeout: number;
  private apiKey: string;
  private transport: unknown = null;
  // deno-lint-ignore no-explicit-any
  private client: any = null;
  private serverConfig: Record<string, unknown> = {};

  constructor(server: MCPServer, config: SmitheryMCPClientConfig) {
    this.server = server;
    this.timeout = config.timeoutMs ?? 30000;
    this.apiKey = config.apiKey;

    // Parse server config from env (stored by SmitheryLoader)
    if (server.env?.__smithery_config) {
      try {
        this.serverConfig = JSON.parse(server.env.__smithery_config);
      } catch (parseError) {
        log.warn(`Failed to parse Smithery config for ${server.id}`);
        log.debug(`Config parse error: ${parseError}`);
      }
    }
  }

  /**
   * Get server ID
   */
  get serverId(): string {
    return this.server.id;
  }

  /**
   * Get server name
   */
  get serverName(): string {
    return this.server.name;
  }

  /**
   * Connect to Smithery server via HTTP Streamable transport
   */
  async connect(): Promise<void> {
    try {
      log.debug(`Connecting to Smithery server: ${this.server.id}`);

      // Initialize SDK on first use
      await initSDK();

      // Build Smithery URL with config and API key
      // server.url (new format) or server.command (legacy) contains the base URL
      const baseUrl = this.server.url || this.server.command;
      if (!baseUrl) {
        throw new Error(`No URL or command specified for HTTP server ${this.server.id}`);
      }

      // Build headers from server config if present
      const headers: Record<string, string> = this.server.headers ? { ...this.server.headers } : {};

      // Normalize URL: createSmitheryUrl expects base URL WITHOUT /mcp suffix
      // It adds /mcp + query params (config & api_key) automatically
      // See: https://smithery.ai/docs/use/connect
      let normalizedUrl = baseUrl;
      if (normalizedUrl.endsWith("/mcp")) {
        normalizedUrl = normalizedUrl.slice(0, -4); // Remove /mcp suffix
      }

      // Use SDK to build proper URL with config and auth
      const serverUrl = createSmitheryUrlFn(normalizedUrl, {
        config: this.serverConfig,
        apiKey: this.apiKey,
      });

      log.debug(`Smithery URL for ${this.server.id}: ${serverUrl.toString()}`);

      // Create HTTP Streamable transport with headers
      this.transport = new StreamableHTTPClientTransportClass(serverUrl, {
        requestInit: Object.keys(headers).length > 0 ? { headers } : undefined,
      });

      // Create MCP client
      this.client = new MCPClientClass({
        name: "pml-gateway",
        version: "1.0.0",
      });

      // Connect with timeout
      await withTimeout(
        this.client.connect(this.transport),
        this.timeout,
        `Smithery connect for ${this.server.id}`,
      );

      log.debug(`Connected to Smithery server: ${this.server.id}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const safeMessage = maskSensitiveData(errorMessage, this.apiKey);
      log.error(`Failed to connect to Smithery server ${this.server.id}: ${safeMessage}`);

      if (error instanceof MCPServerError || error instanceof TimeoutError) {
        throw error;
      }

      throw new MCPServerError(
        this.server.id,
        `Smithery connection failed: ${safeMessage}`,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * List available tools from the Smithery server
   */
  async listTools(): Promise<MCPTool[]> {
    if (!this.client) {
      throw new MCPServerError(this.server.id, "Not connected");
    }

    try {
      const response = await withTimeout(
        this.client.listTools(),
        this.timeout,
        `list_tools for ${this.server.id}`,
      ) as { tools?: Array<{ name?: string; description?: string; inputSchema?: unknown }> };

      const tools: MCPTool[] = (response.tools || []).map((
        tool: { name?: string; description?: string; inputSchema?: unknown },
      ) => ({
        name: String(tool.name || ""),
        description: String(tool.description || ""),
        inputSchema: (tool.inputSchema as Record<string, unknown>) || {},
      }));

      log.debug(`Listed ${tools.length} tools from Smithery server ${this.server.id}`);
      return tools;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const safeMessage = maskSensitiveData(errorMessage, this.apiKey);
      log.error(`Failed to list tools from Smithery ${this.server.id}: ${safeMessage}`);

      if (error instanceof MCPServerError || error instanceof TimeoutError) {
        throw error;
      }

      throw new MCPServerError(
        this.server.id,
        `Failed to list tools: ${safeMessage}`,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Call a tool on the Smithery server
   *
   * @param toolName - Name of the tool to call
   * @param args - Tool arguments
   * @returns Tool execution result
   */
  async callTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    if (!this.client) {
      throw new MCPServerError(this.server.id, "Not connected");
    }

    try {
      log.debug(`Calling tool ${toolName} on Smithery server ${this.server.id}`);

      const response = await withTimeout(
        this.client.callTool({
          name: toolName,
          arguments: args,
        }),
        this.timeout,
        `call_tool ${toolName} on ${this.server.id}`,
      ) as { content?: unknown };

      return response.content;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const safeMessage = maskSensitiveData(errorMessage, this.apiKey);
      log.error(`Failed to call tool ${toolName} on Smithery ${this.server.id}: ${safeMessage}`);

      if (error instanceof MCPServerError || error instanceof TimeoutError) {
        throw error;
      }

      throw new MCPServerError(
        this.server.id,
        `Failed to call tool ${toolName}: ${safeMessage}`,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Alias for close() to maintain backward compatibility with MCPClient
   */
  async disconnect(): Promise<void> {
    await this.close();
  }

  /**
   * Close the connection
   */
  async close(): Promise<void> {
    if (this.client) {
      try {
        await this.client.close();
      } catch (closeError) {
        // Close errors are usually benign (connection already closed, etc.)
        log.debug(`Close error for ${this.server.id} (ignored): ${closeError}`);
      }
      this.client = null;
    }

    this.transport = null;
    log.debug(`Closed Smithery connection to ${this.server.id}`);
  }

  /**
   * Test connection and extract schemas
   *
   * Used by discovery workflow
   */
  async extractSchemas(
    _onProgress?: (message: string) => void,
  ): Promise<ServerDiscoveryResult> {
    const startTime = performance.now();

    try {
      await this.connect();
      const tools = await this.listTools();
      const duration = performance.now() - startTime;

      return {
        serverId: this.server.id,
        serverName: this.server.name,
        status: "success",
        toolsExtracted: tools.length,
        tools,
        connectionDuration: Math.round(duration),
      };
    } catch (error) {
      const duration = performance.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isTimeout = errorMessage.includes("timeout") || errorMessage.includes("Timeout");

      return {
        serverId: this.server.id,
        serverName: this.server.name,
        status: isTimeout ? "timeout" : "failed",
        toolsExtracted: 0,
        error: errorMessage,
        connectionDuration: Math.round(duration),
      };
    } finally {
      await this.close();
    }
  }
}
