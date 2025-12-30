/**
 * Capabilities API Route Handlers
 *
 * Handles all /api/capabilities/* endpoints for the MCP Gateway.
 *
 * @module mcp/routing/handlers/capabilities
 */

import * as log from "@std/log";
import type { RouteContext } from "../types.ts";
import { errorResponse, jsonResponse } from "../types.ts";
import type { CapabilityFilters } from "../../../capabilities/types.ts";

/**
 * Parse and validate capability list filters from URL params
 */
function parseCapabilityFilters(
  url: URL,
  corsHeaders: Record<string, string>,
): { filters: CapabilityFilters; error?: Response } {
  const filters: CapabilityFilters = {};

  // community_id
  const communityIdParam = url.searchParams.get("community_id");
  if (communityIdParam) {
    const communityId = parseInt(communityIdParam, 10);
    if (!isNaN(communityId)) {
      filters.communityId = communityId;
    }
  }

  // min_success_rate
  const minSuccessRateParam = url.searchParams.get("min_success_rate");
  if (minSuccessRateParam) {
    const minSuccessRate = parseFloat(minSuccessRateParam);
    if (!isNaN(minSuccessRate)) {
      if (minSuccessRate < 0 || minSuccessRate > 1) {
        return {
          filters,
          error: errorResponse(
            "min_success_rate must be between 0 and 1",
            400,
            corsHeaders,
          ),
        };
      }
      filters.minSuccessRate = minSuccessRate;
    }
  }

  // min_usage
  const minUsageParam = url.searchParams.get("min_usage");
  if (minUsageParam) {
    const minUsage = parseInt(minUsageParam, 10);
    if (!isNaN(minUsage)) {
      if (minUsage < 0) {
        return {
          filters,
          error: errorResponse("min_usage must be >= 0", 400, corsHeaders),
        };
      }
      filters.minUsage = minUsage;
    }
  }

  // limit
  const limitParam = url.searchParams.get("limit");
  if (limitParam) {
    let limit = parseInt(limitParam, 10);
    if (!isNaN(limit)) {
      limit = Math.min(limit, 100); // Cap at 100
      filters.limit = limit;
    }
  }

  // offset
  const offsetParam = url.searchParams.get("offset");
  if (offsetParam) {
    const offset = parseInt(offsetParam, 10);
    if (!isNaN(offset)) {
      if (offset < 0) {
        return {
          filters,
          error: errorResponse("offset must be >= 0", 400, corsHeaders),
        };
      }
      filters.offset = offset;
    }
  }

  // sort
  const sortParam = url.searchParams.get("sort");
  if (sortParam) {
    if (
      sortParam === "usage_count" ||
      sortParam === "success_rate" ||
      sortParam === "last_used" ||
      sortParam === "created_at"
    ) {
      const sortMap: Record<string, "usageCount" | "successRate" | "lastUsed" | "createdAt"> = {
        usage_count: "usageCount",
        success_rate: "successRate",
        last_used: "lastUsed",
        created_at: "createdAt",
      };
      filters.sort = sortMap[sortParam];
    }
  }

  // order
  const orderParam = url.searchParams.get("order");
  if (orderParam === "asc" || orderParam === "desc") {
    filters.order = orderParam;
  }

  return { filters };
}

/**
 * GET /api/capabilities
 *
 * List capabilities with optional filtering (Story 8.1)
 * Story 9.8: Always filters by current user (AC #5)
 */
export async function handleListCapabilities(
  _req: Request,
  url: URL,
  ctx: RouteContext,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  try {
    if (!ctx.capabilityDataService) {
      return errorResponse("CapabilityDataService not initialized", 503, corsHeaders);
    }

    const { filters, error } = parseCapabilityFilters(url, corsHeaders);
    if (error) return error;

    // Story 9.8 AC #5: Capabilities always filtered by current user
    // No scope toggle - always show only user's capabilities
    if (ctx.userId) {
      filters.userId = ctx.userId;
    }

    const result = await ctx.capabilityDataService.listCapabilities(filters);

    // Get capability pageranks from DAGSuggester (Story 8.2)
    const pageranks = ctx.dagSuggester?.getCapabilityPageranks() ?? new Map<string, number>();

    // Map to snake_case and include dependencies_count + pagerank
    const capabilitiesWithDeps = await Promise.all(
      result.capabilities.map(async (cap) => {
        const depsCount = ctx.capabilityStore
          ? await ctx.capabilityStore.getDependenciesCount(cap.id)
          : 0;
        return {
          id: cap.id,
          name: cap.name,
          fqdn: cap.fqdn,
          description: cap.description,
          code_snippet: cap.codeSnippet,
          tools_used: cap.toolsUsed,
          success_rate: cap.successRate,
          usage_count: cap.usageCount,
          avg_duration_ms: cap.avgDurationMs,
          community_id: cap.communityId,
          pagerank: pageranks.get(cap.id) ?? 0,
          intent_preview: cap.intentPreview,
          created_at: cap.createdAt,
          last_used: cap.lastUsed,
          source: cap.source,
          dependencies_count: depsCount,
        };
      }),
    );

    return jsonResponse(
      {
        capabilities: capabilitiesWithDeps,
        total: result.total,
        limit: result.limit,
        offset: result.offset,
      },
      200,
      corsHeaders,
    );
  } catch (error) {
    log.error(`Failed to list capabilities: ${error}`);
    return errorResponse(`Failed to list capabilities: ${error}`, 500, corsHeaders);
  }
}

/**
 * GET /api/capabilities/:id/dependencies
 *
 * Get dependencies for a capability
 */
export async function handleGetDependencies(
  _req: Request,
  url: URL,
  ctx: RouteContext,
  corsHeaders: Record<string, string>,
  capabilityId: string,
): Promise<Response> {
  try {
    if (!ctx.capabilityStore) {
      return errorResponse("Capability store not initialized", 503, corsHeaders);
    }

    const directionParam = url.searchParams.get("direction") || "both";

    if (!["from", "to", "both"].includes(directionParam)) {
      return errorResponse(
        "direction must be 'from', 'to', or 'both'",
        400,
        corsHeaders,
      );
    }

    const deps = await ctx.capabilityStore.getDependencies(
      capabilityId,
      directionParam as "from" | "to" | "both",
    );

    return jsonResponse(
      {
        capability_id: capabilityId,
        dependencies: deps.map((d) => ({
          from_capability_id: d.fromCapabilityId,
          to_capability_id: d.toCapabilityId,
          observed_count: d.observedCount,
          confidence_score: d.confidenceScore,
          edge_type: d.edgeType,
          edge_source: d.edgeSource,
          created_at: d.createdAt.toISOString(),
          last_observed: d.lastObserved.toISOString(),
        })),
        total: deps.length,
      },
      200,
      corsHeaders,
    );
  } catch (error) {
    log.error(`Failed to get dependencies: ${error}`);
    return errorResponse(`Failed to get dependencies: ${error}`, 500, corsHeaders);
  }
}

/**
 * POST /api/capabilities/:id/dependencies
 *
 * Create a new dependency
 */
export async function handleCreateDependency(
  req: Request,
  _url: URL,
  ctx: RouteContext,
  corsHeaders: Record<string, string>,
  fromCapabilityId: string,
): Promise<Response> {
  try {
    if (!ctx.capabilityStore) {
      return errorResponse("Capability store not initialized", 503, corsHeaders);
    }

    const body = await req.json();

    // Validate required fields
    if (!body.to_capability_id || !body.edge_type) {
      return errorResponse(
        "Missing required fields: to_capability_id, edge_type",
        400,
        corsHeaders,
      );
    }

    // Validate edge_type (Story 10.3: added "provides")
    const validEdgeTypes = ["contains", "sequence", "dependency", "alternative", "provides"];
    if (!validEdgeTypes.includes(body.edge_type)) {
      return errorResponse(
        `Invalid edge_type. Must be one of: ${validEdgeTypes.join(", ")}`,
        400,
        corsHeaders,
      );
    }

    const dep = await ctx.capabilityStore.addDependency({
      fromCapabilityId,
      toCapabilityId: body.to_capability_id,
      edgeType: body.edge_type,
      edgeSource: body.edge_source || "template",
    });

    return jsonResponse(
      {
        created: true,
        dependency: {
          from_capability_id: dep.fromCapabilityId,
          to_capability_id: dep.toCapabilityId,
          observed_count: dep.observedCount,
          confidence_score: dep.confidenceScore,
          edge_type: dep.edgeType,
          edge_source: dep.edgeSource,
          created_at: dep.createdAt.toISOString(),
          last_observed: dep.lastObserved.toISOString(),
        },
      },
      201,
      corsHeaders,
    );
  } catch (error) {
    log.error(`Failed to create dependency: ${error}`);
    return errorResponse(`Failed to create dependency: ${error}`, 500, corsHeaders);
  }
}

/**
 * DELETE /api/capabilities/:from/dependencies/:to
 *
 * Remove a dependency
 */
export async function handleDeleteDependency(
  _req: Request,
  _url: URL,
  ctx: RouteContext,
  corsHeaders: Record<string, string>,
  fromCapabilityId: string,
  toCapabilityId: string,
): Promise<Response> {
  try {
    if (!ctx.capabilityStore) {
      return errorResponse("Capability store not initialized", 503, corsHeaders);
    }

    await ctx.capabilityStore.removeDependency(fromCapabilityId, toCapabilityId);
    return jsonResponse({ deleted: true }, 200, corsHeaders);
  } catch (error) {
    log.error(`Failed to delete dependency: ${error}`);
    return errorResponse(`Failed to delete dependency: ${error}`, 500, corsHeaders);
  }
}

/**
 * GET /api/capabilities/by-tool
 *
 * Find capability containing a specific tool (for search highlighting in Capabilities view)
 */
export async function handleGetCapabilityByTool(
  _req: Request,
  url: URL,
  ctx: RouteContext,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  try {
    if (!ctx.capabilityDataService) {
      return errorResponse("CapabilityDataService not initialized", 503, corsHeaders);
    }

    const toolId = url.searchParams.get("tool_id");
    if (!toolId) {
      return errorResponse("Missing required parameter: tool_id", 400, corsHeaders);
    }

    // Get all capabilities and find one containing this tool
    const result = await ctx.capabilityDataService.listCapabilities({ limit: 100 });

    for (const cap of result.capabilities) {
      if (cap.toolsUsed?.includes(toolId)) {
        return jsonResponse(
          {
            capability_id: cap.id,
            capability_name: cap.name,
            tool_id: toolId,
          },
          200,
          corsHeaders,
        );
      }
    }

    // Not found - return 404
    return jsonResponse(
      {
        capability_id: null,
        tool_id: toolId,
        message: "No capability found containing this tool",
      },
      200,
      corsHeaders,
    );
  } catch (error) {
    log.error(`Failed to find capability by tool: ${error}`);
    return errorResponse(`Failed to find capability by tool: ${error}`, 500, corsHeaders);
  }
}

/**
 * Route all /api/capabilities/* requests
 */
export async function handleCapabilitiesRoutes(
  req: Request,
  url: URL,
  ctx: RouteContext,
  corsHeaders: Record<string, string>,
): Promise<Response | null> {
  // GET /api/capabilities/by-tool
  if (url.pathname === "/api/capabilities/by-tool" && req.method === "GET") {
    return await handleGetCapabilityByTool(req, url, ctx, corsHeaders);
  }

  // GET /api/capabilities
  if (url.pathname === "/api/capabilities" && req.method === "GET") {
    return await handleListCapabilities(req, url, ctx, corsHeaders);
  }

  // GET/POST /api/capabilities/:id/dependencies
  const capDepMatch = url.pathname.match(/^\/api\/capabilities\/([\w-]+)\/dependencies$/);
  if (capDepMatch) {
    const capabilityId = capDepMatch[1];
    if (req.method === "GET") {
      return await handleGetDependencies(req, url, ctx, corsHeaders, capabilityId);
    }
    if (req.method === "POST") {
      return await handleCreateDependency(req, url, ctx, corsHeaders, capabilityId);
    }
    return new Response(null, { status: 405, headers: corsHeaders });
  }

  // DELETE /api/capabilities/:from/dependencies/:to
  const capDepDeleteMatch = url.pathname.match(
    /^\/api\/capabilities\/([\w-]+)\/dependencies\/([\w-]+)$/,
  );
  if (capDepDeleteMatch && req.method === "DELETE") {
    const [, fromId, toId] = capDepDeleteMatch;
    return await handleDeleteDependency(req, url, ctx, corsHeaders, fromId, toId);
  }

  return null;
}
