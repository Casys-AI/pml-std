/**
 * HTTP Server Module
 *
 * HTTP transport implementation for the MCP Gateway.
 * Uses Hono for routing (QW-4 migration).
 *
 * @module mcp/server/http
 */

import * as log from "@std/log";
import { EventsStreamManager } from "../../server/events-stream.ts";
import { logAuthMode, validateAuthConfig } from "../../lib/auth.ts";
import { getAllowedOrigin } from "../routing/mod.ts";
import { MCPErrorCodes, SERVER_TITLE } from "./constants.ts";
import type { JsonRpcRequest, ResolvedGatewayConfig } from "./types.ts";
import { createApp, type HonoAppDependencies } from "./app.ts";
import type { RouteContext } from "../routing/types.ts";

/**
 * Validate JSON-RPC request structure
 */
function isValidJsonRpcRequest(body: unknown): body is JsonRpcRequest {
  if (!body || typeof body !== "object") return false;
  const req = body as Record<string, unknown>;
  return (
    typeof req.jsonrpc === "string" &&
    typeof req.method === "string" &&
    (req.id === undefined || typeof req.id === "number" || typeof req.id === "string")
  );
}

/**
 * Dependencies required for HTTP server
 */
export interface HttpServerDependencies {
  config: ResolvedGatewayConfig;
  routeContext: Omit<RouteContext, "userId" | "eventsStream">;
  handleListTools: (request: unknown) => Promise<unknown>;
  handleCallTool: (request: unknown, userId?: string, isPackageClient?: boolean) => Promise<unknown>;
}

/**
 * HTTP Server state
 */
export interface HttpServerState {
  httpServer: Deno.HttpServer | null;
  eventsStream: EventsStreamManager | null;
}

/**
 * Handle JSON-RPC request
 */
export async function handleJsonRpcRequest(
  request: JsonRpcRequest,
  deps: HttpServerDependencies,
  userId?: string,
  isPackageClient?: boolean,
): Promise<Record<string, unknown>> {
  const { id, method, params } = request;

  try {
    // MCP initialize handshake
    if (method === "initialize") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: {
            tools: { listChanged: true },
          },
          serverInfo: {
            name: deps.config.name,
            title: SERVER_TITLE,
            version: deps.config.version,
          },
        },
      };
    }

    // MCP initialized notification
    if (method === "notifications/initialized") {
      return { jsonrpc: "2.0", id, result: {} };
    }

    if (method === "tools/list") {
      const result = await deps.handleListTools({ params });
      if (result && typeof result === "object" && "error" in result) {
        return { jsonrpc: "2.0", id, error: (result as { error: unknown }).error };
      }
      return { jsonrpc: "2.0", id, result };
    }

    if (method === "tools/call") {
      const result = await deps.handleCallTool({ params }, userId, isPackageClient);
      if (result && typeof result === "object" && "error" in result) {
        return { jsonrpc: "2.0", id, error: (result as { error: unknown }).error };
      }
      return { jsonrpc: "2.0", id, result };
    }

    return {
      jsonrpc: "2.0",
      id,
      error: { code: MCPErrorCodes.METHOD_NOT_FOUND, message: `Method not found: ${method}` },
    };
  } catch (error) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: MCPErrorCodes.INTERNAL_ERROR, message: `${error}` },
    };
  }
}

/**
 * Start HTTP server using Hono
 */
export async function startHttpServer(
  port: number,
  deps: HttpServerDependencies,
  state: HttpServerState,
  healthChecker: { initialHealthCheck: () => Promise<void>; startPeriodicChecks: () => void },
): Promise<Deno.HttpServer> {
  await healthChecker.initialHealthCheck();
  healthChecker.startPeriodicChecks();

  state.eventsStream = new EventsStreamManager();
  log.info(`✓ EventsStreamManager initialized with EventBus`);

  logAuthMode("API Server");
  validateAuthConfig("API Server");

  const allowedOrigin = getAllowedOrigin();
  log.info(`✓ CORS configured for origin: ${allowedOrigin}`);

  // Create Hono app with all dependencies
  const appDeps: HonoAppDependencies = {
    routeContext: deps.routeContext,
    eventsStream: state.eventsStream,
    handleJsonRpc: async (body: unknown, userId?: string, isPackageClient?: boolean) => {
      // Validate JsonRpcRequest structure before processing
      if (!isValidJsonRpcRequest(body)) {
        return {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: "Invalid JSON-RPC request structure" },
        };
      }
      return handleJsonRpcRequest(body, deps, userId, isPackageClient);
    },
  };

  const app = createApp(appDeps, [allowedOrigin]);

  // Start server with Hono's fetch handler
  const httpServer = Deno.serve({ port }, app.fetch);

  log.info(`✓ Casys PML MCP gateway started (HTTP mode on port ${port})`);
  log.info(`  Server: ${deps.config.name} v${deps.config.version}`);
  log.info(`  Connected MCP servers: ${deps.routeContext.mcpClients.size}`);
  log.info(`  Routing: Hono framework`);
  log.info(
    `  Endpoints: GET /health, GET /events/stream, GET /dashboard, GET /api/graph/*, GET /api/capabilities/*, GET /api/metrics, POST /mcp`,
  );

  return httpServer;
}
