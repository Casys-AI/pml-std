/**
 * Metrics API Route Handler
 *
 * Handles /api/metrics endpoint for the MCP Gateway.
 *
 * Story 9.8: Added scope filtering for per-user dashboard metrics.
 *
 * @module mcp/routing/handlers/metrics
 */

import * as log from "@std/log";
import type { RouteContext } from "../types.ts";
import { errorResponse, jsonResponse } from "../types.ts";
import {
  getExecutedToolIds,
  type Scope,
} from "../../../graphrag/user-usage.ts";

// Rate limiting for metrics endpoint
let lastMetricsCall = 0;
let metricsCallCount = 0;
const METRICS_RATE_LIMIT_WINDOW = 1000; // 1 second
const METRICS_MAX_CALLS_PER_WINDOW = 3;

/**
 * GET /api/metrics
 *
 * Returns graph metrics for the specified time range (Story 6.3)
 *
 * Query params:
 * - range: Time range (1h, 24h, 7d) (default: 24h)
 * - scope: Scope filter "user" | "system" (default: user) (Story 9.8)
 */
export async function handleMetrics(
  req: Request,
  url: URL,
  ctx: RouteContext,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  try {
    const now = Date.now();
    const range = url.searchParams.get("range") || "24h";
    const scope = (url.searchParams.get("scope") || "user") as Scope;

    // Rate limiting: reset counter if window expired
    if (now - lastMetricsCall > METRICS_RATE_LIMIT_WINDOW) {
      metricsCallCount = 0;
    }
    metricsCallCount++;
    lastMetricsCall = now;

    // Log if called too frequently (helps diagnose rapid polling issues)
    if (metricsCallCount > METRICS_MAX_CALLS_PER_WINDOW) {
      const origin = req.headers.get("Origin") || "unknown";
      log.warn(
        `[/api/metrics] Rate limit warning: ${metricsCallCount} calls in 1s (origin: ${origin}, range: ${range})`,
      );
    }

    // Validate range parameter
    if (range !== "1h" && range !== "24h" && range !== "7d") {
      return errorResponse(
        `Invalid range parameter: ${range}. Must be one of: 1h, 24h, 7d`,
        400,
        corsHeaders,
      );
    }

    // Validate scope parameter (Story 9.8 AC #7)
    if (!["user", "system"].includes(scope)) {
      return errorResponse(
        `Invalid scope parameter: ${scope}. Must be one of: user, system`,
        400,
        corsHeaders,
      );
    }

    // Get base metrics
    const metrics = await ctx.graphEngine.getMetrics(range as "1h" | "24h" | "7d");

    // Story 9.8: Filter PageRank top 10 by scope
    if (ctx.db && metrics.current?.pagerankTop10) {
      const userId = ctx.userId || "local";
      const executedToolIds = await getExecutedToolIds(ctx.db, scope, userId);

      // Only filter if we have executed tools
      if (executedToolIds.size > 0) {
        // Filter pagerankTop10 to only include executed tools
        metrics.current.pagerankTop10 = metrics.current.pagerankTop10.filter(
          (item) => executedToolIds.has(item.toolId),
        );
        log.debug(
          `[metrics] Scope=${scope}, userId=${userId}: filtered pagerankTop10 to ${metrics.current.pagerankTop10.length} tools`,
        );
      }
    }

    return jsonResponse(metrics, 200, corsHeaders);
  } catch (error) {
    log.error(`Failed to get metrics: ${error}`);
    return errorResponse(`Failed to get metrics: ${error}`, 500, corsHeaders);
  }
}

/**
 * Route /api/metrics requests
 */
export async function handleMetricsRoutes(
  req: Request,
  url: URL,
  ctx: RouteContext,
  corsHeaders: Record<string, string>,
): Promise<Response | null> {
  if (url.pathname === "/api/metrics" && req.method === "GET") {
    return await handleMetrics(req, url, ctx, corsHeaders);
  }
  return null;
}
