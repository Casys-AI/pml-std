/**
 * Sampling Relay - Relays MCP sampling requests between child servers and parent client
 *
 * When a child MCP server (e.g., std) sends a sampling/createMessage request,
 * this relay forwards it to the parent client (e.g., Claude Code) via the SDK
 * and returns the response to the child.
 *
 * Flow:
 * 1. Child server sends: { method: "sampling/createMessage", id: X, params: {...} }
 * 2. Relay receives it and calls SDK's server.createMessage()
 * 3. SDK handles the request/response with Claude Code
 * 4. Response arrives and is forwarded to child: { id: X, result: {...} }
 *
 * @module mcp/sampling/sampling-relay
 */

import * as log from "@std/log";
import type { JsonRpcRequest, JsonRpcResponse } from "../server/types.ts";

/**
 * MCP SDK CreateMessageRequest (matching SDK interface)
 */
export interface CreateMessageRequest {
  messages: Array<{
    role: "user" | "assistant";
    content: { type: string; text?: string; data?: string; mimeType?: string } | string;
  }>;
  maxTokens?: number;
  temperature?: number;
  stopSequences?: string[];
  systemPrompt?: string;
  modelPreferences?: {
    costPriority?: number;
    speedPriority?: number;
    intelligencePriority?: number;
  };
  includeContext?: "thisServer" | "allServers" | "none";
}

/**
 * MCP SDK CreateMessageResult
 */
export interface CreateMessageResult {
  content: { type: string; text?: string }[];
  model?: string;
  stopReason: "endTurn" | "stopSequence" | "maxTokens";
}

/**
 * Function type for MCP SDK's server.createMessage()
 */
export type CreateMessageFn = (request: CreateMessageRequest) => Promise<CreateMessageResult>;

/**
 * Sampling Relay for MCP Gateway
 *
 * Manages the relay of sampling requests between child MCP servers
 * and the parent MCP client (Claude Code) via the SDK.
 */
export class SamplingRelay {
  /** Count of active requests (for monitoring) */
  private activeRequests = 0;

  /** Timeout for sampling requests (5 minutes) */
  private readonly timeoutMs = 300000;

  /** Function to call SDK's createMessage (set by Gateway) */
  private createMessageFn: CreateMessageFn | null = null;

  /**
   * Set the createMessage function from the SDK
   *
   * Called by Gateway during initialization
   */
  setCreateMessageFn(fn: CreateMessageFn): void {
    this.createMessageFn = fn;
    log.info("[SamplingRelay] createMessage function configured");
  }

  /**
   * Handle a sampling request from a child server
   *
   * @param serverId - ID of the child server sending the request
   * @param request - The JSON-RPC sampling request
   * @param respondToChild - Callback to send response back to child
   * @returns true if handled, false if not a sampling request
   */
  handleChildRequest(
    serverId: string,
    request: JsonRpcRequest,
    respondToChild: (response: JsonRpcResponse) => void,
  ): boolean {
    // Only handle sampling/createMessage
    if (request.method !== "sampling/createMessage") {
      return false;
    }

    log.info(`[SamplingRelay] Received sampling request from ${serverId}`);

    if (!this.createMessageFn) {
      log.error("[SamplingRelay] No createMessage function configured - rejecting request");
      respondToChild({
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32603,
          message: "Sampling relay not configured - no parent client",
        },
      });
      return true;
    }

    // Process request asynchronously
    this.processRequest(serverId, request, respondToChild);

    return true;
  }

  /**
   * Process a sampling request via the SDK
   */
  private async processRequest(
    serverId: string,
    request: JsonRpcRequest,
    respondToChild: (response: JsonRpcResponse) => void,
  ): Promise<void> {
    this.activeRequests++;
    const startTime = Date.now();

    try {
      const params = request.params as Record<string, unknown> || {};

      // Convert child request params to SDK format
      const sdkRequest: CreateMessageRequest = {
        messages: (params.messages as CreateMessageRequest["messages"]) || [],
        maxTokens: params.maxTokens as number | undefined,
        temperature: params.temperature as number | undefined,
        stopSequences: params.stopSequences as string[] | undefined,
        systemPrompt: params.systemPrompt as string | undefined,
        includeContext: "none", // Child servers provide their own context
      };

      log.debug(`[SamplingRelay] Calling createMessage for ${serverId}`);

      // Create timeout promise
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Sampling request timed out after ${this.timeoutMs}ms`));
        }, this.timeoutMs);
      });

      // Race between SDK call and timeout
      const result = await Promise.race([
        this.createMessageFn!(sdkRequest),
        timeoutPromise,
      ]);

      const duration = Date.now() - startTime;
      log.info(`[SamplingRelay] Got response for ${serverId} in ${duration}ms`);

      // Send success response to child
      respondToChild({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          content: result.content,
          model: result.model,
          stopReason: this.convertStopReason(result.stopReason),
        },
      });
    } catch (error) {
      const duration = Date.now() - startTime;
      log.error(`[SamplingRelay] Error for ${serverId} after ${duration}ms: ${error}`);

      // Send error response to child
      respondToChild({
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    } finally {
      this.activeRequests--;
    }
  }

  /**
   * Convert SDK stop reason to MCP spec format
   */
  private convertStopReason(sdkReason: string): "end_turn" | "max_tokens" | "stop_sequence" {
    switch (sdkReason) {
      case "endTurn":
        return "end_turn";
      case "maxTokens":
        return "max_tokens";
      case "stopSequence":
        return "stop_sequence";
      default:
        return "end_turn";
    }
  }

  /**
   * Check if there are active sampling requests
   */
  hasActiveRequests(): boolean {
    return this.activeRequests > 0;
  }

  /**
   * Get count of active requests
   */
  getActiveCount(): number {
    return this.activeRequests;
  }
}

/**
 * Singleton instance for the Gateway
 */
export const samplingRelay = new SamplingRelay();
