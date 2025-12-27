/**
 * MCP Protocol Client
 *
 * Handles MCP communication via stdio transport
 *
 * @module mcp/client
 */

import * as log from "@std/log";
import type {
  MCPClientBase,
  MCPServer,
  MCPTool,
  SamplingRequestHandler,
  ServerDiscoveryResult,
} from "./types.ts";
import { MCPServerError, TimeoutError } from "../errors/error-types.ts";
import { withTimeout } from "../utils/timeout.ts";
import type { JsonRpcRequest, JsonRpcResponse } from "./server/types.ts";

interface JSONRPCResponse {
  jsonrpc: string;
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/**
 * Configuration options for MCPClient
 */
export interface MCPClientConfig {
  /** Request timeout in milliseconds (default: 10000) */
  timeoutMs?: number;
  /** Use mutex for request serialization instead of multiplexer (default: false) */
  useMutex?: boolean;
  /** Handler for sampling requests from child server (for relay to parent) */
  samplingHandler?: SamplingRequestHandler;
}

/**
 * MCP Client for stdio communication
 *
 * Implements basic MCP protocol:
 * - Initialize connection
 * - Send list_tools request
 * - Parse tool schemas
 * - Handle errors and timeouts
 */
export class MCPClient implements MCPClientBase {
  private server: MCPServer;
  private process: Deno.ChildProcess | null = null;
  private requestId: number = 1;
  private timeout: number;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private stderrReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private stderrRunning: boolean = false;

  // JSON-RPC multiplexer state (fixes race condition - pattern from WorkerBridge)
  private pendingRequests: Map<number, {
    resolve: (response: JSONRPCResponse) => void;
    reject: (error: Error) => void;
    timeoutId: ReturnType<typeof setTimeout>;
  }> = new Map();
  private readerLoopRunning: boolean = false;
  private readBuffer: string = "";

  // Mutex fallback for request serialization (optional safety mode)
  private useMutex: boolean = false;
  private mutexLock: Promise<void> = Promise.resolve();
  private mutexRelease: (() => void) | null = null;

  // Sampling request handler for relay to parent (Story 11.x)
  private samplingHandler: SamplingRequestHandler | null = null;

  constructor(server: MCPServer, config?: MCPClientConfig | number) {
    this.server = server;
    // Support both old signature (number) and new config object
    if (typeof config === "number") {
      this.timeout = config;
    } else {
      this.timeout = config?.timeoutMs ?? 10000;
      this.useMutex = config?.useMutex ?? false;
      this.samplingHandler = config?.samplingHandler ?? null;
    }
  }

  /**
   * Set the sampling request handler (for relay to parent)
   */
  setSamplingHandler(handler: SamplingRequestHandler): void {
    this.samplingHandler = handler;
    log.debug(`[${this.server.id}] Sampling handler configured`);
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
   * Connect to MCP server via stdio
   */
  async connect(): Promise<void> {
    try {
      log.debug(`Connecting to MCP server: ${this.server.id}`);

      // Validate command exists (required for stdio protocol)
      if (!this.server.command) {
        throw new MCPServerError(
          this.server.id,
          "No command specified for stdio server",
        );
      }

      // Start subprocess
      this.process = new Deno.Command(this.server.command, {
        args: this.server.args || [],
        env: this.server.env,
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      }).spawn();

      // Initialize persistent streams
      if (!this.process.stdin || !this.process.stdout) {
        throw new MCPServerError(
          this.server.id,
          "Failed to initialize stdio streams",
        );
      }
      this.writer = this.process.stdin.getWriter();
      this.reader = this.process.stdout.getReader();

      // Start reading stderr in background (ADR-012)
      if (this.process.stderr) {
        this.stderrReader = this.process.stderr.getReader();
        this.readStderr();
      }

      // Send initialize request with timeout
      await withTimeout(
        this.sendInitializeRequest(),
        this.timeout,
        `MCP initialize for ${this.server.id}`,
      );

      log.debug(`Connected to ${this.server.id}`);
    } catch (error) {
      log.error(`Failed to connect to ${this.server.id}: ${error}`);

      if (error instanceof MCPServerError || error instanceof TimeoutError) {
        throw error; // Re-throw our custom errors
      }

      throw new MCPServerError(
        this.server.id,
        `Connection failed: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Send MCP initialize request
   *
   * Initializes the MCP protocol session
   */
  private async sendInitializeRequest(): Promise<void> {
    const initRequest = {
      jsonrpc: "2.0",
      id: this.requestId++,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: {
          name: "pml",
          version: "0.1.0",
        },
      },
    };

    const response = await this.sendRequest(initRequest);

    if (response.error) {
      throw new Error(
        `Initialize failed: ${response.error.message}`,
      );
    }

    log.debug(`Initialize response received for ${this.server.id}`);
  }

  /**
   * Read stderr from MCP server process in background (ADR-012)
   *
   * Logs stderr output from child MCP servers to our logger,
   * making them visible in Grafana/Loki.
   */
  private async readStderr(): Promise<void> {
    if (!this.stderrReader || this.stderrRunning) return;

    this.stderrRunning = true;
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (this.stderrRunning) {
        const { done, value } = await this.stderrReader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete lines
        const lines = buffer.split("\n");
        buffer = lines.pop() || ""; // Keep incomplete line in buffer

        for (const line of lines) {
          if (line.trim()) {
            log.info(`[${this.server.id}:stderr] ${line}`);
          }
        }
      }

      // Flush remaining buffer
      if (buffer.trim()) {
        log.info(`[${this.server.id}:stderr] ${buffer}`);
      }
    } catch (error) {
      // Ignore errors when process is closing
      if (this.stderrRunning) {
        log.debug(`stderr reader error for ${this.server.id}: ${error}`);
      }
    } finally {
      this.stderrRunning = false;
    }
  }

  /**
   * List available tools from the MCP server
   */
  async listTools(): Promise<MCPTool[]> {
    try {
      const listRequest = {
        jsonrpc: "2.0",
        id: this.requestId++,
        method: "tools/list",
        params: {},
      };

      const response = await this.sendRequest(listRequest);

      if (response.error) {
        throw new MCPServerError(
          this.server.id,
          `list_tools failed: ${response.error.message}`,
        );
      }

      const tools = this.parseToolsResponse(
        response.result as Record<string, unknown> || {},
      );
      log.debug(
        `Extracted ${tools.length} tools from ${this.server.id}`,
      );

      return tools;
    } catch (error) {
      log.error(
        `Failed to list tools from ${this.server.id}: ${error}`,
      );

      if (error instanceof MCPServerError || error instanceof TimeoutError) {
        throw error;
      }

      throw new MCPServerError(
        this.server.id,
        `Failed to list tools: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Send a JSON-RPC response to the child server (for sampling relay)
   */
  private async sendResponseToChild(response: JsonRpcResponse): Promise<void> {
    if (!this.writer) {
      log.error(`[${this.server.id}] Cannot send response - writer not initialized`);
      return;
    }

    const encoder = new TextEncoder();
    const message = JSON.stringify(response) + "\n";
    log.debug(`[${this.server.id}:stdin] → ${JSON.stringify(response)}`);
    await this.writer.write(encoder.encode(message));
  }

  /**
   * Start the reader loop for multiplexed JSON-RPC responses
   *
   * Runs continuously once started, dispatching responses to pending requests by ID.
   * Also handles sampling requests from child server (Story 11.x).
   * Pattern from WorkerBridge (src/sandbox/worker-bridge.ts:337-342)
   */
  private startReaderLoop(): void {
    if (this.readerLoopRunning || !this.reader) return;
    this.readerLoopRunning = true;

    (async () => {
      const decoder = new TextDecoder();

      try {
        while (this.readerLoopRunning && this.reader) {
          const { done, value } = await this.reader.read();

          if (done) {
            // Stream closed - reject all pending requests
            this.rejectAllPending(new Error("Stream closed unexpectedly"));
            break;
          }

          this.readBuffer += decoder.decode(value, { stream: true });

          // Process complete JSON lines
          const lines = this.readBuffer.split("\n");
          this.readBuffer = lines.pop() || ""; // Keep incomplete line in buffer

          for (const line of lines) {
            if (!line.trim()) continue;

            try {
              const parsed = JSON.parse(line);
              log.debug(
                `[${this.server.id}:stdout] ← ${line.substring(0, 500)}${
                  line.length > 500 ? "..." : ""
                }`,
              );

              // Check if it's a request (has method) vs response (has result/error)
              if (parsed.method) {
                // This is a request from the child server (e.g., sampling/createMessage)
                const request = parsed as JsonRpcRequest;

                if (this.samplingHandler) {
                  const handled = this.samplingHandler(
                    this.server.id,
                    request,
                    (response) => this.sendResponseToChild(response),
                  );

                  if (handled) {
                    log.debug(`[${this.server.id}] Sampling request forwarded to relay`);
                    continue;
                  }
                }

                // Not handled - send error response
                log.warn(`[${this.server.id}] Unhandled request from child: ${request.method}`);
                await this.sendResponseToChild({
                  jsonrpc: "2.0",
                  id: request.id,
                  error: {
                    code: -32601,
                    message: `Method not supported: ${request.method}`,
                  },
                });
                continue;
              }

              // It's a response - dispatch to pending request
              const response = parsed as JSONRPCResponse;
              const pending = this.pendingRequests.get(response.id);
              if (pending) {
                clearTimeout(pending.timeoutId);
                pending.resolve(response);
                this.pendingRequests.delete(response.id);
              } else {
                log.debug(
                  `[${this.server.id}] Received response for unknown request ID: ${response.id}`,
                );
              }
            } catch {
              // Not valid JSON, skip this line
              log.debug(`[${this.server.id}] Invalid JSON line: ${line.substring(0, 100)}`);
            }
          }
        }
      } catch (error) {
        // Connection error - reject all pending requests
        if (this.readerLoopRunning) {
          this.rejectAllPending(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      } finally {
        this.readerLoopRunning = false;
      }
    })();
  }

  /**
   * Reject all pending requests (pattern from WorkerBridge:527-531)
   *
   * Called when connection is lost or closed
   */
  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeoutId);
      pending.reject(error);
      this.pendingRequests.delete(id);
    }
  }

  /**
   * Acquire mutex lock for serialized request mode
   */
  private async acquireMutex(): Promise<void> {
    const currentLock = this.mutexLock;
    let release: () => void;
    this.mutexLock = new Promise((resolve) => {
      release = resolve;
    });
    this.mutexRelease = release!;
    await currentLock;
  }

  /**
   * Release mutex lock
   */
  private releaseMutex(): void {
    if (this.mutexRelease) {
      this.mutexRelease();
      this.mutexRelease = null;
    }
  }

  /**
   * Send a JSON-RPC request and wait for response (mutex mode)
   *
   * Serializes all requests - only one request at a time.
   * Used as fallback when multiplexer has issues.
   */
  private async sendRequestWithMutex(
    request: Record<string, unknown>,
  ): Promise<JSONRPCResponse> {
    if (!this.writer || !this.reader) {
      throw new Error("Streams not initialized");
    }

    await this.acquireMutex();

    try {
      // Send request
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const message = JSON.stringify(request) + "\n";
      log.debug(`[${this.server.id}:stdout] → ${JSON.stringify(request)}`);
      await this.writer.write(encoder.encode(message));

      // Read response with timeout
      let buffer = "";
      const startTime = Date.now();

      while (true) {
        if (Date.now() - startTime > this.timeout) {
          throw new TimeoutError(this.server.id, this.timeout);
        }

        const { done, value } = await this.reader.read();

        if (done) {
          throw new Error("Stream closed unexpectedly");
        }

        buffer += decoder.decode(value, { stream: true });

        // Check if we have a complete JSON object
        const lines = buffer.split("\n");
        for (const line of lines.slice(0, -1)) {
          if (line.trim()) {
            try {
              const response = JSON.parse(line) as JSONRPCResponse;
              log.debug(
                `[${this.server.id}:stdout] ← ${line.substring(0, 500)}${
                  line.length > 500 ? "..." : ""
                }`,
              );
              return response;
            } catch {
              // Not valid JSON yet, continue reading
            }
          }
        }
        buffer = lines[lines.length - 1];
      }
    } finally {
      this.releaseMutex();
    }
  }

  /**
   * Send a JSON-RPC request and wait for response
   *
   * Uses multiplexed reader loop by default - multiple concurrent requests supported.
   * Falls back to mutex mode if configured (useMutex: true).
   */
  private async sendRequest(
    request: Record<string, unknown>,
  ): Promise<JSONRPCResponse> {
    // Use mutex mode if configured
    if (this.useMutex) {
      return this.sendRequestWithMutex(request);
    }

    if (!this.writer || !this.reader) {
      throw new Error("Streams not initialized");
    }

    const requestId = request.id as number;

    // Ensure reader loop is running (fire and forget)
    this.startReaderLoop();

    // Send request
    const encoder = new TextEncoder();
    const message = JSON.stringify(request) + "\n";
    log.debug(`[${this.server.id}:stdout] → ${JSON.stringify(request)}`);
    await this.writer.write(encoder.encode(message));

    // Register pending request and return promise
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new TimeoutError(this.server.id, this.timeout));
      }, this.timeout);

      this.pendingRequests.set(requestId, { resolve, reject, timeoutId });
    });
  }

  /**
   * Parse tools/list response
   */
  private parseToolsResponse(
    result: Record<string, unknown>,
  ): MCPTool[] {
    if (!result || !Array.isArray(result.tools)) {
      return [];
    }

    return (result.tools as Array<Record<string, unknown>>).map((tool) => ({
      name: String(tool.name || ""),
      description: String(tool.description || ""),
      inputSchema: tool.inputSchema as Record<string, unknown> || {},
      outputSchema: tool.outputSchema as Record<string, unknown> | undefined,
    }));
  }

  /**
   * Call a tool on the MCP server
   *
   * @param toolName - Name of the tool to call
   * @param args - Tool arguments
   * @returns Tool execution result
   */
  async callTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    try {
      const callRequest = {
        jsonrpc: "2.0",
        id: this.requestId++,
        method: "tools/call",
        params: {
          name: toolName,
          arguments: args,
        },
      };

      const response = await this.sendRequest(callRequest);

      if (response.error) {
        throw new MCPServerError(
          this.server.id,
          `tools/call failed for ${toolName}: ${response.error.message}`,
        );
      }

      return response.result;
    } catch (error) {
      log.error(
        `Failed to call tool ${toolName} on ${this.server.id}: ${error}`,
      );

      if (error instanceof MCPServerError || error instanceof TimeoutError) {
        throw error;
      }

      throw new MCPServerError(
        this.server.id,
        `Failed to call tool ${toolName}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Alias for close() to maintain backward compatibility
   */
  async disconnect(): Promise<void> {
    await this.close();
  }

  /**
   * Close the connection
   */
  async close(): Promise<void> {
    // Stop reader loop and reject pending requests
    this.readerLoopRunning = false;
    this.rejectAllPending(new Error("Connection closed"));

    // Release streams
    if (this.reader) {
      try {
        this.reader.releaseLock();
      } catch {
        // Stream already released
      }
      this.reader = null;
    }

    if (this.writer) {
      try {
        this.writer.releaseLock();
      } catch {
        // Stream already released
      }
      this.writer = null;
    }

    // Stop stderr reader (ADR-012)
    this.stderrRunning = false;
    if (this.stderrReader) {
      try {
        this.stderrReader.releaseLock();
      } catch {
        // Stream already released
      }
      this.stderrReader = null;
    }

    // Kill process
    if (this.process) {
      try {
        this.process.kill();
        await this.process.status;
      } catch {
        // Process already terminated
      }
      this.process = null;
    }

    // Clear buffer
    this.readBuffer = "";

    log.debug(`Closed connection to ${this.server.id}`);
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

      const result: ServerDiscoveryResult = {
        serverId: this.server.id,
        serverName: this.server.name,
        status: "success",
        toolsExtracted: tools.length,
        tools,
        connectionDuration: Math.round(duration),
      };

      return result;
    } catch (error) {
      const duration = performance.now() - startTime;

      const errorMessage = error instanceof Error ? error.message : String(error);
      const isTimeout = errorMessage.includes("timeout") ||
        errorMessage.includes("Timeout");

      const result: ServerDiscoveryResult = {
        serverId: this.server.id,
        serverName: this.server.name,
        status: isTimeout ? "timeout" : "failed",
        toolsExtracted: 0,
        error: errorMessage,
        connectionDuration: Math.round(duration),
      };

      return result;
    } finally {
      await this.close();
    }
  }
}
