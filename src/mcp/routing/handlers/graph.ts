/**
 * Graph API Route Handlers
 *
 * Handles all /api/graph/* endpoints for the MCP Gateway.
 *
 * @module mcp/routing/handlers/graph
 */

import * as log from "@std/log";
import type { RouteContext } from "../types.ts";
import { errorResponse, jsonResponse } from "../types.ts";
import type {
  CapabilityNode,
  GraphEdge,
  GraphNode,
  HypergraphOptions,
  SequenceEdge,
  ToolInvocationNode,
} from "../../../capabilities/types.ts";

/**
 * GET /api/graph/snapshot
 *
 * Returns the current graph snapshot for visualization (Story 6.2)
 */
export function handleGraphSnapshot(
  _req: Request,
  _url: URL,
  ctx: RouteContext,
  corsHeaders: Record<string, string>,
): Response {
  try {
    const snapshot = ctx.graphEngine.getGraphSnapshot();
    return jsonResponse(snapshot, 200, corsHeaders);
  } catch (error) {
    log.error(`Failed to get graph snapshot: ${error}`);
    return errorResponse(`Failed to get graph snapshot: ${error}`, 500, corsHeaders);
  }
}

/**
 * GET /api/graph/path
 *
 * Find shortest path between two nodes (Story 6.4 AC4)
 *
 * Query params:
 * - from: Source node ID (required)
 * - to: Target node ID (required)
 */
export function handleGraphPath(
  _req: Request,
  url: URL,
  ctx: RouteContext,
  corsHeaders: Record<string, string>,
): Response {
  try {
    const from = url.searchParams.get("from") || "";
    const to = url.searchParams.get("to") || "";

    if (!from || !to) {
      return errorResponse(
        "Missing required parameters: 'from' and 'to'",
        400,
        corsHeaders,
      );
    }

    const path = ctx.graphEngine.findShortestPath(from, to);
    return jsonResponse(
      {
        path: path || [],
        total_hops: path ? path.length - 1 : -1,
        from,
        to,
      },
      200,
      corsHeaders,
    );
  } catch (error) {
    log.error(`Path finding failed: ${error}`);
    return errorResponse(`Path finding failed: ${error}`, 500, corsHeaders);
  }
}

/**
 * GET /api/graph/related
 *
 * Find related tools using Adamic-Adar similarity (Story 6.4 AC6)
 *
 * Query params:
 * - tool_id: Tool ID to find related tools for (required)
 * - limit: Max results (default: 5)
 */
export function handleGraphRelated(
  _req: Request,
  url: URL,
  ctx: RouteContext,
  corsHeaders: Record<string, string>,
): Response {
  try {
    const toolId = url.searchParams.get("tool_id") || "";
    const limit = parseInt(url.searchParams.get("limit") || "5", 10);

    if (!toolId) {
      return errorResponse(
        "Missing required parameter: 'tool_id'",
        400,
        corsHeaders,
      );
    }

    const related = ctx.graphEngine.computeAdamicAdar(toolId, limit);

    // Enrich with server info and edge data
    const enrichedRelated = related.map((r) => {
      const edgeData = ctx.graphEngine.getEdgeData(toolId, r.toolId) ||
        ctx.graphEngine.getEdgeData(r.toolId, toolId);

      // Extract server and name from tool_id
      let server = "unknown";
      let name = r.toolId;
      if (r.toolId.includes(":")) {
        const colonIndex = r.toolId.indexOf(":");
        server = r.toolId.substring(0, colonIndex);
        name = r.toolId.substring(colonIndex + 1);
      }

      return {
        tool_id: r.toolId,
        name,
        server,
        adamic_adar_score: Math.round(r.score * 1000) / 1000,
        edge_confidence: edgeData?.weight ?? null,
      };
    });

    return jsonResponse(
      {
        tool_id: toolId,
        related: enrichedRelated,
      },
      200,
      corsHeaders,
    );
  } catch (error) {
    log.error(`Related tools lookup failed: ${error}`);
    return errorResponse(`Related tools lookup failed: ${error}`, 500, corsHeaders);
  }
}

/**
 * Map node data to snake_case for external API
 */
function mapNodeData(node: GraphNode): Record<string, unknown> {
  if (node.data.type === "capability") {
    const capNode = node as CapabilityNode;
    return {
      data: {
        id: node.data.id,
        type: node.data.type,
        label: node.data.label,
        code_snippet: node.data.codeSnippet,
        success_rate: node.data.successRate,
        usage_count: node.data.usageCount,
        tools_count: node.data.toolsCount,
        tools_used: capNode.data.toolsUsed,
        tool_invocations: capNode.data.toolInvocations?.map((inv) => ({
          id: inv.id,
          tool: inv.tool,
          ts: inv.ts,
          duration_ms: inv.durationMs,
          sequence_index: inv.sequenceIndex,
        })),
        // Story 11.4: Execution traces (when include_traces=true)
        traces: capNode.data.traces?.map((trace) => ({
          id: trace.id,
          capability_id: trace.capabilityId,
          executed_at: trace.executedAt instanceof Date
            ? trace.executedAt.toISOString()
            : trace.executedAt,
          success: trace.success,
          duration_ms: trace.durationMs,
          error_message: trace.errorMessage,
          priority: trace.priority,
          task_results: trace.taskResults.map((r) => ({
            task_id: r.taskId,
            tool: r.tool,
            args: r.args,
            result: r.result,
            success: r.success,
            duration_ms: r.durationMs,
            layer_index: r.layerIndex,
          })),
        })),
      },
    };
  } else if (node.data.type === "tool_invocation") {
    const invNode = node as ToolInvocationNode;
    return {
      data: {
        id: invNode.data.id,
        parent: invNode.data.parent,
        type: invNode.data.type,
        tool: invNode.data.tool,
        server: invNode.data.server,
        label: invNode.data.label,
        ts: invNode.data.ts,
        duration_ms: invNode.data.durationMs,
        sequence_index: invNode.data.sequenceIndex,
      },
    };
  } else {
    return {
      data: {
        id: node.data.id,
        parent: node.data.parent,
        parents: node.data.parents,
        type: node.data.type,
        server: node.data.server,
        label: node.data.label,
        pagerank: node.data.pagerank,
        degree: node.data.degree,
        community_id: node.data.communityId,
      },
    };
  }
}

/**
 * Map edge data to snake_case for external API
 */
function mapEdgeData(edge: GraphEdge): Record<string, unknown> {
  if (edge.data.edgeType === "capability_link") {
    return {
      data: {
        id: edge.data.id,
        source: edge.data.source,
        target: edge.data.target,
        shared_tools: edge.data.sharedTools,
        edge_type: edge.data.edgeType,
        edge_source: edge.data.edgeSource,
      },
    };
  } else if (edge.data.edgeType === "sequence") {
    const seqEdge = edge as SequenceEdge;
    return {
      data: {
        id: seqEdge.data.id,
        source: seqEdge.data.source,
        target: seqEdge.data.target,
        edge_type: seqEdge.data.edgeType,
        time_delta_ms: seqEdge.data.timeDeltaMs,
        is_parallel: seqEdge.data.isParallel,
      },
    };
  } else {
    return {
      data: {
        id: edge.data.id,
        source: edge.data.source,
        target: edge.data.target,
        edge_type: edge.data.edgeType,
        edge_source: edge.data.edgeSource,
        observed_count: edge.data.observedCount,
      },
    };
  }
}

/**
 * GET /api/graph/hypergraph
 *
 * Returns hypergraph data for capability visualization (Story 8.1, 8.2, 8.3)
 *
 * Query params:
 * - include_tools: Include tool nodes (default: true)
 * - include_orphans: Include orphan tools with no parent capabilities (default: false for perf)
 * - min_success_rate: Filter by minimum success rate (0-1)
 * - min_usage: Filter by minimum usage count
 */
export async function handleGraphHypergraph(
  req: Request,
  url: URL,
  ctx: RouteContext,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  try {
    if (!ctx.capabilityDataService) {
      return errorResponse("CapabilityDataService not configured", 503, corsHeaders);
    }

    // Parse query parameters
    const options: HypergraphOptions = {};

    const includeToolsParam = url.searchParams.get("include_tools");
    if (includeToolsParam !== null) {
      options.includeTools = includeToolsParam === "true";
    }

    // Performance: Default to false to avoid sending 450+ orphan tool nodes
    const includeOrphansParam = url.searchParams.get("include_orphans");
    options.includeOrphans = includeOrphansParam === "true"; // Default false for perf

    const minSuccessRateParam = url.searchParams.get("min_success_rate");
    if (minSuccessRateParam) {
      const minSuccessRate = parseFloat(minSuccessRateParam);
      if (!isNaN(minSuccessRate)) {
        if (minSuccessRate < 0 || minSuccessRate > 1) {
          return errorResponse(
            "min_success_rate must be between 0 and 1",
            400,
            corsHeaders,
          );
        }
        options.minSuccessRate = minSuccessRate;
      }
    }

    const minUsageParam = url.searchParams.get("min_usage");
    if (minUsageParam) {
      const minUsage = parseInt(minUsageParam, 10);
      if (!isNaN(minUsage)) {
        if (minUsage < 0) {
          return errorResponse("min_usage must be >= 0", 400, corsHeaders);
        }
        options.minUsage = minUsage;
      }
    }

    // Story 11.4: Include execution traces for each capability
    const includeTracesParam = url.searchParams.get("include_traces");
    if (includeTracesParam !== null) {
      options.includeTraces = includeTracesParam === "true";
    }

    // Build hypergraph data
    const result = await ctx.capabilityDataService.buildHypergraphData(options);

    const response = {
      nodes: result.nodes.map(mapNodeData),
      edges: result.edges.map(mapEdgeData),
      capability_zones: result.capabilityZones || [],
      capabilities_count: result.capabilitiesCount,
      tools_count: result.toolsCount,
      metadata: {
        generated_at: result.metadata.generatedAt,
        version: result.metadata.version,
      },
    };

    // Generate ETag from response content hash for caching
    const responseBody = JSON.stringify(response);
    const etag = `"${await generateETag(responseBody)}"`;

    // Check If-None-Match header for conditional GET
    const ifNoneMatch = req.headers.get("If-None-Match");
    if (ifNoneMatch === etag) {
      return new Response(null, {
        status: 304,
        headers: { ...corsHeaders, "ETag": etag },
      });
    }

    return new Response(responseBody, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "ETag": etag,
        "Cache-Control": "private, max-age=5", // 5s cache, revalidate with ETag
      },
    });
  } catch (error) {
    log.error(`Hypergraph generation failed: ${error}`);
    return errorResponse(`Failed to build hypergraph: ${error}`, 500, corsHeaders);
  }
}

/**
 * Generate a short ETag hash from response body
 */
async function generateETag(body: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(body);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  // Use first 16 bytes for shorter ETag
  return hashArray.slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Route all /api/graph/* requests
 */
export async function handleGraphRoutes(
  req: Request,
  url: URL,
  ctx: RouteContext,
  corsHeaders: Record<string, string>,
): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/graph/")) {
    return null;
  }

  if (req.method !== "GET") {
    return new Response(null, { status: 405, headers: corsHeaders });
  }

  switch (url.pathname) {
    case "/api/graph/snapshot":
      return handleGraphSnapshot(req, url, ctx, corsHeaders);
    case "/api/graph/path":
      return handleGraphPath(req, url, ctx, corsHeaders);
    case "/api/graph/related":
      return handleGraphRelated(req, url, ctx, corsHeaders);
    case "/api/graph/hypergraph":
      return await handleGraphHypergraph(req, url, ctx, corsHeaders);
    default:
      return null;
  }
}
