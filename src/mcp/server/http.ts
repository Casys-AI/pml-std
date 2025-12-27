/**
 * HTTP Server Module
 *
 * HTTP transport implementation for the MCP Gateway.
 * Handles routing, authentication, rate limiting, and CORS.
 *
 * @module mcp/server/http
 */

import * as log from "@std/log";
import { EventsStreamManager } from "../../server/events-stream.ts";
import { logAuthMode, validateAuthConfig, validateRequest } from "../../lib/auth.ts";
import { RateLimiter } from "../../utils/rate-limiter.ts";
import { getRateLimitKey } from "../../lib/rate-limiter-helpers.ts";
import {
  buildCorsHeaders,
  getAllowedOrigin,
  isPublicRoute,
  rateLimitResponse,
  type RouteContext,
  routeRequest,
  unauthorizedResponse,
} from "../routing/mod.ts";
import { MCPErrorCodes, SERVER_TITLE } from "./constants.ts";
import type { JsonRpcRequest, ResolvedGatewayConfig } from "./types.ts";

/**
 * Dependencies required for HTTP server
 */
export interface HttpServerDependencies {
  config: ResolvedGatewayConfig;
  routeContext: Omit<RouteContext, "userId" | "eventsStream">;
  handleListTools: (request: unknown) => Promise<unknown>;
  handleCallTool: (request: unknown, userId?: string) => Promise<unknown>;
}

/**
 * HTTP Server state
 */
export interface HttpServerState {
  httpServer: Deno.HttpServer | null;
  eventsStream: EventsStreamManager | null;
}

/**
 * Create rate limiters for different endpoint types
 */
function createRateLimiters() {
  return {
    mcp: new RateLimiter(100, 60000),
    api: new RateLimiter(200, 60000),
  };
}

/**
 * Handle JSON-RPC request
 */
export async function handleJsonRpcRequest(
  request: JsonRpcRequest,
  deps: HttpServerDependencies,
  userId?: string,
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
      // Check if handler returned an error (e.g., { error: { code, message } })
      if (result && typeof result === "object" && "error" in result) {
        return { jsonrpc: "2.0", id, error: (result as { error: unknown }).error };
      }
      return { jsonrpc: "2.0", id, result };
    }

    if (method === "tools/call") {
      const result = await deps.handleCallTool({ params }, userId);
      // Check if handler returned an error (e.g., { error: { code, message } })
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
 * Create HTTP request handler
 */
export function createHttpRequestHandler(
  deps: HttpServerDependencies,
  state: HttpServerState,
  corsHeaders: Record<string, string>,
): (req: Request) => Promise<Response> {
  const rateLimiters = createRateLimiters();

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);

    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Auth validation for protected routes
    let authResult = null;
    if (!isPublicRoute(url.pathname)) {
      authResult = await validateRequest(req);
      if (!authResult) {
        return unauthorizedResponse(corsHeaders);
      }

      // Rate limiting
      const clientIp = req.headers.get("x-forwarded-for") ||
        req.headers.get("cf-connecting-ip") ||
        "unknown";
      const rateLimitKey = getRateLimitKey(authResult, clientIp);

      let limiter: RateLimiter | null = null;
      if (url.pathname === "/mcp") {
        limiter = rateLimiters.mcp;
      } else if (url.pathname.startsWith("/api/")) {
        limiter = rateLimiters.api;
      }

      if (limiter && !(await limiter.checkLimit(rateLimitKey))) {
        log.warn(`Rate limit exceeded for ${rateLimitKey} on ${url.pathname}`);
        return rateLimitResponse(corsHeaders);
      }
    }

    // MCP Streamable HTTP endpoint
    if (url.pathname === "/mcp") {
      if (req.method === "POST") {
        try {
          const body = await req.json();
          const response = await handleJsonRpcRequest(body, deps, authResult?.user_id);
          return new Response(JSON.stringify(response), {
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        } catch (error) {
          return new Response(
            JSON.stringify({ error: `Invalid request: ${error}` }),
            { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } },
          );
        }
      }
      if (req.method === "GET") {
        if (!state.eventsStream) {
          return new Response(
            JSON.stringify({ error: "Events stream not initialized" }),
            { status: 503, headers: { "Content-Type": "application/json", ...corsHeaders } },
          );
        }
        return state.eventsStream.handleRequest(req);
      }
      return new Response(null, { status: 405, headers: corsHeaders });
    }

    // Route to modular handlers
    const routeCtx: RouteContext = {
      ...deps.routeContext,
      eventsStream: state.eventsStream,
      userId: authResult?.user_id,
    };

    const routeResponse = await routeRequest(req, url, routeCtx, corsHeaders);
    if (routeResponse) {
      return routeResponse;
    }

    // JSON-RPC message endpoint (legacy)
    if (url.pathname === "/message" && req.method === "POST") {
      try {
        const body = await req.json();
        const response = await handleJsonRpcRequest(body, deps, authResult?.user_id);
        return new Response(JSON.stringify(response), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32700, message: `Parse error: ${error}` },
            id: null,
          }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
    }

    return new Response("Not Found", { status: 404 });
  };
}

/**
 * Start HTTP server
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
  const corsHeaders = buildCorsHeaders(allowedOrigin);
  log.info(`✓ CORS configured for origin: ${allowedOrigin}`);

  const handler = createHttpRequestHandler(deps, state, corsHeaders);
  const httpServer = Deno.serve({ port }, handler);

  log.info(`✓ Casys PML MCP gateway started (HTTP mode on port ${port})`);
  log.info(`  Server: ${deps.config.name} v${deps.config.version}`);
  log.info(`  Connected MCP servers: ${deps.routeContext.mcpClients.size}`);
  log.info(
    `  Endpoints: GET /health, GET /events/stream, GET /dashboard, GET /api/graph/*, GET /api/capabilities/*, GET /api/metrics, POST /mcp`,
  );

  return httpServer;
}
