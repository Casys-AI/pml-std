/**
 * MCP Server Bootstrap for Mini-Tools Library
 *
 * This file bootstraps the mcp-tools.ts primitives as a proper MCP server
 * that can be loaded via mcp-servers.json.
 *
 * Usage in mcp-servers.json:
 * {
 *   "mcpServers": {
 *     "primitives": {
 *       "command": "deno",
 *       "args": ["run", "--allow-all", "lib/mcp-tools-server.ts"]
 *     }
 *   }
 * }
 *
 * @module lib/mcp-tools-server
 */

import { MiniToolsClient } from "./mcp-tools.ts";

// ============================================================================
// MCP Protocol Types
// ============================================================================

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ============================================================================
// MCP Server Implementation
// ============================================================================

class MCPServer {
  private client: MiniToolsClient;
  private initialized = false;

  constructor(categories?: string[]) {
    this.client = new MiniToolsClient(categories);
  }

  async handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    try {
      const result = await this.dispatch(request.method, request.params || {});
      return { jsonrpc: "2.0", id: request.id, result };
    } catch (error) {
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : "Unknown error",
        },
      };
    }
  }

  private async dispatch(
    method: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    switch (method) {
      case "initialize":
        return this.handleInitialize();

      case "initialized":
        return {}; // Notification, no response needed

      case "tools/list":
        return this.handleToolsList();

      case "tools/call":
        return this.handleToolsCall(params);

      case "ping":
        return { pong: true };

      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  private handleInitialize() {
    this.initialized = true;
    return {
      protocolVersion: "2024-11-05",
      serverInfo: {
        name: "mcp-primitives",
        version: "1.0.0",
      },
      capabilities: {
        tools: {},
      },
    };
  }

  private async handleToolsList() {
    const tools = await this.client.listTools();
    return { tools };
  }

  private async handleToolsCall(params: Record<string, unknown>) {
    const name = params.name as string;
    const args = (params.arguments || {}) as Record<string, unknown>;

    const result = await this.client.callTool(name, args);

    return {
      content: [
        {
          type: "text",
          text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
        },
      ],
    };
  }
}

// ============================================================================
// Stdio Transport
// ============================================================================

async function readMessage(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<JsonRpcRequest | null> {
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) return null;

    buffer += decoder.decode(value, { stream: true });

    // Look for complete JSON-RPC messages (newline-delimited)
    const newlineIndex = buffer.indexOf("\n");
    if (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);

      if (line) {
        try {
          return JSON.parse(line) as JsonRpcRequest;
        } catch {
          console.error("Failed to parse JSON-RPC message:", line);
        }
      }
    }
  }
}

async function writeMessage(response: JsonRpcResponse): Promise<void> {
  const encoder = new TextEncoder();
  const message = JSON.stringify(response) + "\n";
  await Deno.stdout.write(encoder.encode(message));
}

// ============================================================================
// Main Entry Point
// ============================================================================

async function main() {
  // Parse command line arguments for category filtering
  const args = Deno.args;
  let categories: string[] | undefined;

  const categoriesArg = args.find((arg) => arg.startsWith("--categories="));
  if (categoriesArg) {
    categories = categoriesArg.split("=")[1].split(",");
  }

  const server = new MCPServer(categories);
  const reader = Deno.stdin.readable.getReader();

  // Log to stderr (stdout is for MCP protocol)
  console.error(`[mcp-primitives] Server started${categories ? ` with categories: ${categories.join(", ")}` : " with all categories"}`);

  while (true) {
    const request = await readMessage(reader);
    if (!request) break;

    const response = await server.handleRequest(request);
    await writeMessage(response);
  }

  console.error("[mcp-primitives] Server stopped");
}

// Run if main module
if (import.meta.main) {
  main().catch((error) => {
    console.error("[mcp-primitives] Fatal error:", error);
    Deno.exit(1);
  });
}
