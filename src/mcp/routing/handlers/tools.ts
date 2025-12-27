/**
 * Tools API Route Handler
 *
 * Handles /api/tools/* endpoints for the MCP Gateway.
 *
 * @module mcp/routing/handlers/tools
 */

import * as log from "@std/log";
import type { RouteContext } from "../types.ts";
import { errorResponse, jsonResponse } from "../types.ts";

/**
 * GET /api/tools/search
 *
 * Search tools for autocomplete (Story 6.4 AC10)
 *
 * Query params:
 * - q: Search query (min 2 chars)
 * - limit: Max results (default: 10)
 */
export function handleToolsSearch(
  _req: Request,
  url: URL,
  ctx: RouteContext,
  corsHeaders: Record<string, string>,
): Response {
  try {
    const q = url.searchParams.get("q") || "";
    const limit = parseInt(url.searchParams.get("limit") || "10", 10);

    if (q.length < 2) {
      return jsonResponse({ results: [], total: 0 }, 200, corsHeaders);
    }

    const results = ctx.graphEngine.searchToolsForAutocomplete(q, limit);
    return jsonResponse({ results, total: results.length }, 200, corsHeaders);
  } catch (error) {
    log.error(`Search failed: ${error}`);
    return errorResponse(`Search failed: ${error}`, 500, corsHeaders);
  }
}

/**
 * Route /api/tools/* requests
 */
export function handleToolsRoutes(
  req: Request,
  url: URL,
  ctx: RouteContext,
  corsHeaders: Record<string, string>,
): Response | null {
  if (url.pathname === "/api/tools/search" && req.method === "GET") {
    return handleToolsSearch(req, url, ctx, corsHeaders);
  }
  return null;
}
