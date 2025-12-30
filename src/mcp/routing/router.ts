/**
 * Main Router
 *
 * Central router that dispatches HTTP requests to appropriate handlers.
 *
 * @module mcp/routing/router
 */

import * as log from "@std/log";
import type { RouteContext } from "./types.ts";

// Import route handlers from handlers/
import {
  handleCapabilitiesRoutes,
  handleEmergenceRoutes,
  handleGraphRoutes,
  handleHealthRoutes,
  handleMetricsRoutes,
  handleToolsRoutes,
} from "./handlers/mod.ts";

/**
 * Main router that dispatches requests to appropriate handlers
 *
 * Returns null if no matching route found (allows caller to handle 404 or fallback)
 */
export async function routeRequest(
  req: Request,
  url: URL,
  ctx: RouteContext,
  corsHeaders: Record<string, string>,
): Promise<Response | null> {
  // Health routes (public)
  const healthResponse = handleHealthRoutes(req, url, ctx, corsHeaders);
  if (healthResponse) return healthResponse;

  // Graph API routes
  const graphResponse = await handleGraphRoutes(req, url, ctx, corsHeaders);
  if (graphResponse) return graphResponse;

  // Capabilities API routes
  const capabilitiesResponse = await handleCapabilitiesRoutes(req, url, ctx, corsHeaders);
  if (capabilitiesResponse) return capabilitiesResponse;

  // Metrics API route
  const metricsResponse = await handleMetricsRoutes(req, url, ctx, corsHeaders);
  if (metricsResponse) return metricsResponse;

  // Emergence metrics API route (CAS/SYMBIOSIS)
  const emergenceResponse = await handleEmergenceRoutes(req, url, ctx, corsHeaders);
  if (emergenceResponse) return emergenceResponse;

  // Tools API routes
  const toolsResponse = handleToolsRoutes(req, url, ctx, corsHeaders);
  if (toolsResponse) return toolsResponse;

  // No matching route
  return null;
}

/**
 * Log initialized routes for startup message
 */
export function logRoutes(): void {
  log.info("  Routes:");
  log.info("    - GET /health (public)");
  log.info("    - GET /events/stream");
  log.info("    - GET /dashboard (redirect)");
  log.info("    - GET /api/graph/snapshot");
  log.info("    - GET /api/graph/path");
  log.info("    - GET /api/graph/related");
  log.info("    - GET /api/graph/hypergraph");
  log.info("    - GET /api/capabilities");
  log.info("    - GET /api/capabilities/:id/dependencies");
  log.info("    - POST /api/capabilities/:id/dependencies");
  log.info("    - DELETE /api/capabilities/:from/dependencies/:to");
  log.info("    - GET /api/metrics");
  log.info("    - GET /api/metrics/emergence");
  log.info("    - GET /api/tools/search");
  log.info("    - POST /mcp (JSON-RPC)");
  log.info("    - GET /mcp (SSE)");
  log.info("    - POST /message (JSON-RPC)");
}
