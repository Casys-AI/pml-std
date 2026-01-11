/**
 * MCP Server Bootstrap for Std (Standard Library) Tools
 *
 * This file bootstraps the std tools as a proper MCP server
 * that can be loaded via mcp-servers.json.
 *
 * Usage in mcp-servers.json:
 * {
 *   "mcpServers": {
 *     "std": {
 *       "command": "deno",
 *       "args": ["run", "--allow-all", "lib/mcp-tools-server.ts"]
 *     }
 *   }
 * }
 *
 * @module lib/mcp-tools-server
 */

import { MiniToolsClient } from "./mcp-tools.ts";
import { setSamplingClient } from "./std/mod.ts";

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
// Sampling Client for Agent Tools
// ============================================================================

// Pending sampling requests (waiting for response from client)
const pendingSamplingRequests = new Map<
  number,
  { resolve: (result: unknown) => void; reject: (error: Error) => void }
>();
let samplingRequestId = 1;

/**
 * Send a sampling request to the MCP client (Claude Code)
 * Per MCP spec, the client handles the agentic loop and tool execution
 */
async function sendSamplingRequest(params: {
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  tools?: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  toolChoice?: "auto" | "required" | "none";
  maxTokens?: number;
  maxIterations?: number;
  allowedToolPatterns?: string[];
}): Promise<{
  content: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }>;
  stopReason: "end_turn" | "tool_use" | "max_tokens";
}> {
  const id = samplingRequestId++;

  // Create promise that will be resolved when we get the response
  const promise = new Promise<unknown>((resolve, reject) => {
    pendingSamplingRequests.set(id, { resolve, reject });

    // Timeout after 5 minutes
    setTimeout(() => {
      if (pendingSamplingRequests.has(id)) {
        pendingSamplingRequests.delete(id);
        reject(new Error("Sampling request timed out"));
      }
    }, 300000);
  });

  // Send the request to the client
  const request: JsonRpcRequest = {
    jsonrpc: "2.0",
    id,
    method: "sampling/createMessage",
    params: {
      messages: params.messages.map((m) => ({
        role: m.role,
        content: { type: "text", text: m.content },
      })),
      maxTokens: params.maxTokens || 4096,
      // Pass hints for agentic loop control
      ...(params.maxIterations && { _maxIterations: params.maxIterations }),
      ...(params.allowedToolPatterns && { _allowedToolPatterns: params.allowedToolPatterns }),
    },
  };

  const encoder = new TextEncoder();
  await Deno.stdout.write(encoder.encode(JSON.stringify(request) + "\n"));

  // Wait for response
  const result = await promise;
  return result as {
    content: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }>;
    stopReason: "end_turn" | "tool_use" | "max_tokens";
  };
}

/**
 * Initialize the sampling client for agent tools
 */
function initSamplingClient(): void {
  setSamplingClient({
    createMessage: sendSamplingRequest,
  });
  console.error("[mcp-std] Sampling client initialized for agent tools");
}

// ============================================================================
// MCP Server Implementation
// ============================================================================

class MCPServer {
  private client: MiniToolsClient;

  constructor(categories?: string[]) {
    this.client = new MiniToolsClient(categories ? { categories } : undefined);
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
    params: Record<string, unknown>,
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
    return {
      protocolVersion: "2024-11-05",
      serverInfo: {
        name: "mcp-std",
        version: "1.0.0",
      },
      capabilities: {
        tools: {},
      },
    };
  }

  private handleToolsList() {
    // Convert to MCP tools format
    const tools = this.client.toMCPFormat();
    return { tools };
  }

  private async handleToolsCall(params: Record<string, unknown>) {
    const name = params.name as string;
    const args = (params.arguments || {}) as Record<string, unknown>;

    const result = await this.client.execute(name, args);

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

// Persistent buffer for stdin parsing (fixes message loss when multiple requests arrive together)
const decoder = new TextDecoder();
let stdinBuffer = "";

/**
 * Read a message from stdin
 * Returns the message type: "request" for incoming requests, "response" for sampling responses
 */
async function readMessage(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<
  { type: "request"; data: JsonRpcRequest } | { type: "response"; data: JsonRpcResponse } | null
> {
  while (true) {
    // First check if we already have a complete message in the buffer
    const newlineIndex = stdinBuffer.indexOf("\n");
    if (newlineIndex !== -1) {
      const line = stdinBuffer.slice(0, newlineIndex).trim();
      stdinBuffer = stdinBuffer.slice(newlineIndex + 1);

      if (line) {
        try {
          const parsed = JSON.parse(line);

          // Check if it's a response (has result or error, no method)
          if (!parsed.method && (parsed.result !== undefined || parsed.error !== undefined)) {
            return { type: "response", data: parsed as JsonRpcResponse };
          }

          // Otherwise it's a request
          return { type: "request", data: parsed as JsonRpcRequest };
        } catch {
          console.error("Failed to parse JSON-RPC message:", line);
        }
      }
      continue; // Check for more messages in buffer
    }

    // No complete message in buffer, read more data
    const { value, done } = await reader.read();
    if (done) return null;

    stdinBuffer += decoder.decode(value, { stream: true });
  }
}

/**
 * Handle a sampling response from the client
 */
function handleSamplingResponse(response: JsonRpcResponse): void {
  const id = response.id as number;
  const pending = pendingSamplingRequests.get(id);

  if (!pending) {
    console.error(`[mcp-std] Received response for unknown sampling request: ${id}`);
    return;
  }

  pendingSamplingRequests.delete(id);

  if (response.error) {
    pending.reject(new Error(response.error.message));
  } else {
    pending.resolve(response.result);
  }
}

async function writeMessage(response: JsonRpcResponse): Promise<void> {
  const encoder = new TextEncoder();
  const message = JSON.stringify(response) + "\n";
  await Deno.stdout.write(encoder.encode(message));
}

// ============================================================================
// Concurrent Request Processing
// ============================================================================

const MAX_CONCURRENT = 10;
let inFlight = 0;
const writeQueue: JsonRpcResponse[] = [];
let writing = false;

/**
 * Flush pending responses to stdout
 * Uses a flag to ensure atomic writes (no interleaving)
 */
async function flushWriteQueue(): Promise<void> {
  if (writing) return;
  writing = true;
  try {
    while (writeQueue.length > 0) {
      const response = writeQueue.shift()!;
      await writeMessage(response);
    }
  } finally {
    writing = false;
  }
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

  // Initialize sampling client for agent tools
  initSamplingClient();

  // Log to stderr (stdout is for MCP protocol)
  console.error(
    `[mcp-std] Server started (concurrent, max=${MAX_CONCURRENT})${
      categories ? ` with categories: ${categories.join(", ")}` : " with all categories"
    }`,
  );

  while (true) {
    const message = await readMessage(reader);
    if (!message) break;

    // Handle sampling responses (from client back to us)
    if (message.type === "response") {
      handleSamplingResponse(message.data);
      continue;
    }

    // Handle incoming requests
    const request = message.data;

    // Fire and forget - concurrent processing
    (async () => {
      // Backpressure: wait for a slot if at max concurrency
      while (inFlight >= MAX_CONCURRENT) {
        await new Promise((r) => setTimeout(r, 10));
      }
      inFlight++;
      try {
        const response = await server.handleRequest(request);
        writeQueue.push(response);
        await flushWriteQueue();
      } finally {
        inFlight--;
      }
    })();
  }

  // Wait for in-flight requests to complete before stopping
  while (inFlight > 0) {
    await new Promise((r) => setTimeout(r, 10));
  }
  await flushWriteQueue();

  console.error("[mcp-std] Server stopped");
}

// Run if main module
if (import.meta.main) {
  main().catch((error) => {
    console.error("[mcp-std] Fatal error:", error);
    Deno.exit(1);
  });
}
