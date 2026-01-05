/**
 * Graph API Route Handlers
 *
 * Handles all /api/graph/* endpoints for the MCP Gateway.
 *
 * @module mcp/routing/handlers/graph
 */

import * as log from "@std/log";
import type { RouteContext } from "../mcp/routing/types.ts";
import { errorResponse, jsonResponse } from "../mcp/routing/types.ts";
import type {
  CapabilityNode,
  GraphEdge,
  GraphNode,
  HypergraphOptions,
  SequenceEdge,
  ToolInvocationNode,
} from "../capabilities/types.ts";
import { toolsByCategory } from "../../lib/std/mod.ts";

// Build lookup: tool name -> category (module) for std tools
const stdToolCategoryMap = new Map<string, string>();
for (const [category, tools] of Object.entries(toolsByCategory)) {
  for (const tool of tools) {
    stdToolCategoryMap.set(tool.name, category);
  }
}

// =============================================================================
// Types for /api/graph/insights unified endpoint
// =============================================================================

/** Algorithm contribution to a node's discovery */
interface AlgorithmScore {
  score: number;
  rank?: number;
  metadata?: Record<string, unknown>;
}

/** Unified insight item - a node discovered by one or more algorithms */
interface InsightItem {
  id: string;
  name: string;
  type: "tool" | "capability";
  server?: string;
  algorithms: Record<string, AlgorithmScore>;
  combinedScore: number;
}

/** Response for /api/graph/insights */
interface InsightsResponse {
  nodeId: string;
  nodeType: "tool" | "capability";
  items: InsightItem[];
  algorithmStats: Record<string, { count: number; avgScore: number }>;
}

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
 * GET /api/graph/community
 *
 * Find nodes in the same Louvain community as the given node
 *
 * Query params:
 * - node_id: Node ID to find community for (required)
 * - limit: Max results (default: 20)
 */
export function handleGraphCommunity(
  _req: Request,
  url: URL,
  ctx: RouteContext,
  corsHeaders: Record<string, string>,
): Response {
  try {
    const nodeId = url.searchParams.get("node_id") || "";
    const limit = parseInt(url.searchParams.get("limit") || "20", 10);

    if (!nodeId) {
      return errorResponse(
        "Missing required parameter: 'node_id'",
        400,
        corsHeaders,
      );
    }

    // Get community ID for the node
    const communityId = ctx.graphEngine.getCommunity(nodeId);
    if (communityId === undefined) {
      return jsonResponse(
        {
          node_id: nodeId,
          community_id: null,
          members: [],
          member_count: 0,
        },
        200,
        corsHeaders,
      );
    }

    // Get all members in this community
    const memberIds = ctx.graphEngine.findCommunityMembers(nodeId);

    // Enrich with PageRank and metadata, sorted by PageRank
    const enrichedMembers = memberIds
      .filter((id) => id !== nodeId) // Exclude the source node
      .map((memberId) => {
        const pagerank = ctx.graphEngine.getPageRank(memberId);
        let server = "unknown";
        let name = memberId;
        if (memberId.includes(":")) {
          const colonIndex = memberId.indexOf(":");
          server = memberId.substring(0, colonIndex);
          name = memberId.substring(colonIndex + 1);
        }
        return {
          id: memberId,
          name,
          server,
          pagerank: Math.round(pagerank * 1000) / 1000,
        };
      })
      .sort((a, b) => b.pagerank - a.pagerank)
      .slice(0, limit);

    return jsonResponse(
      {
        node_id: nodeId,
        community_id: parseInt(communityId, 10),
        members: enrichedMembers,
        member_count: memberIds.length - 1, // Exclude source node
      },
      200,
      corsHeaders,
    );
  } catch (error) {
    log.error(`Community lookup failed: ${error}`);
    return errorResponse(`Community lookup failed: ${error}`, 500, corsHeaders);
  }
}

/**
 * GET /api/graph/neighbors
 *
 * Get direct neighbors of a node, sorted by PageRank
 *
 * Query params:
 * - node_id: Node ID to find neighbors for (required)
 * - limit: Max results (default: 10)
 */
export function handleGraphNeighbors(
  _req: Request,
  url: URL,
  ctx: RouteContext,
  corsHeaders: Record<string, string>,
): Response {
  try {
    const nodeId = url.searchParams.get("node_id") || "";
    const limit = parseInt(url.searchParams.get("limit") || "10", 10);

    if (!nodeId) {
      return errorResponse(
        "Missing required parameter: 'node_id'",
        400,
        corsHeaders,
      );
    }

    // Get neighbors using the graph engine
    const neighbors = ctx.graphEngine.getNeighbors(nodeId);

    // Enrich with PageRank, edge data, sorted by PageRank
    const enrichedNeighbors = neighbors
      .map((neighborId) => {
        const pagerank = ctx.graphEngine.getPageRank(neighborId);
        const edgeData = ctx.graphEngine.getEdgeData(nodeId, neighborId) ||
          ctx.graphEngine.getEdgeData(neighborId, nodeId);

        let server = "unknown";
        let name = neighborId;
        if (neighborId.includes(":")) {
          const colonIndex = neighborId.indexOf(":");
          server = neighborId.substring(0, colonIndex);
          name = neighborId.substring(colonIndex + 1);
        }

        return {
          id: neighborId,
          name,
          server,
          pagerank: Math.round(pagerank * 1000) / 1000,
          edge_weight: edgeData?.weight ?? null,
          edge_type: edgeData?.edge_type ?? null,
          edge_source: edgeData?.edge_source ?? null,
        };
      })
      .sort((a, b) => b.pagerank - a.pagerank)
      .slice(0, limit);

    return jsonResponse(
      {
        node_id: nodeId,
        neighbors: enrichedNeighbors,
        neighbor_count: neighbors.length,
      },
      200,
      corsHeaders,
    );
  } catch (error) {
    log.error(`Neighbors lookup failed: ${error}`);
    return errorResponse(`Neighbors lookup failed: ${error}`, 500, corsHeaders);
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
        description: capNode.data.description,
        // Story 10.1: Parent capability ID for nested compound nodes
        parent: node.data.parent,
        code_snippet: node.data.codeSnippet,
        success_rate: node.data.successRate,
        usage_count: node.data.usageCount,
        tools_count: node.data.toolsCount,
        // Story 8.2: Graph position data
        pagerank: capNode.data.pagerank,
        community_id: capNode.data.communityId,
        fqdn: capNode.data.fqdn,
        tools_used: capNode.data.toolsUsed,
        // Story 10.1: Meta-capability hierarchy (0=leaf, 1+=meta)
        hierarchy_level: capNode.data.hierarchyLevel ?? 0,
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
            // Story 10.1: Resolved capability name for $cap:uuid references
            resolved_tool: r.resolvedTool,
            args: r.args,
            result: r.result,
            success: r.success,
            duration_ms: r.durationMs,
            layer_index: r.layerIndex,
            // Loop Abstraction metadata (camelCase → snake_case)
            loop_id: r.loopId,
            loop_type: r.loopType,
            loop_condition: r.loopCondition,
            body_tools: r.bodyTools,
            // Story 10.1: Flag for capability calls (render CapabilityTaskCard)
            is_capability_call: r.isCapabilityCall,
            // Story 10.1: Nested tools inside called capability
            nested_tools: r.nestedTools,
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
    // Tool node - add module for std tools
    const toolName = node.data.label;
    const module = node.data.server === "std" ? stdToolCategoryMap.get(toolName) : undefined;

    return {
      data: {
        id: node.data.id,
        parent: node.data.parent,
        parents: node.data.parents,
        type: node.data.type,
        server: node.data.server,
        module, // Category/module for std tools (e.g., "crypto", "json", "http")
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
 * GET /api/graph/insights
 *
 * Unified endpoint that returns related nodes from ALL algorithms,
 * deduplicated by node_id with algorithm badges.
 *
 * Query params:
 * - node_id: Node ID to find insights for (required)
 * - limit: Max results per algorithm (default: 10)
 *
 * Algorithms included:
 * - louvain: Community members (same Louvain cluster)
 * - neighbors: Direct neighbors sorted by PageRank
 * - adamic_adar: Adamic-Adar similarity (for tools)
 * - hyperedge: Capabilities sharing tools (hyperedge overlap)
 * - spectral: Same spectral cluster
 */
export async function handleGraphInsights(
  _req: Request,
  url: URL,
  ctx: RouteContext,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  try {
    const nodeId = url.searchParams.get("node_id") || "";
    const limit = parseInt(url.searchParams.get("limit") || "10", 10);

    if (!nodeId) {
      return errorResponse("Missing required parameter: 'node_id'", 400, corsHeaders);
    }

    // Detect node type from ID pattern
    const isCapability = nodeId.startsWith("cap:") || !nodeId.includes(":");
    const nodeType: "tool" | "capability" = isCapability ? "capability" : "tool";

    // Accumulator: nodeId -> InsightItem
    const itemsMap = new Map<string, InsightItem>();

    // Helper to add/merge algorithm result
    const addResult = (
      id: string,
      name: string,
      type: "tool" | "capability",
      server: string | undefined,
      algorithm: string,
      score: number,
      rank: number,
      metadata?: Record<string, unknown>,
    ) => {
      const existing = itemsMap.get(id);
      if (existing) {
        existing.algorithms[algorithm] = { score, rank, metadata };
      } else {
        itemsMap.set(id, {
          id,
          name,
          type,
          server,
          algorithms: { [algorithm]: { score, rank, metadata } },
          combinedScore: 0, // Calculated later
        });
      }
    };

    // Helper to extract server and name from node ID (for tools)
    const parseNodeId = (id: string): { server: string; name: string } => {
      if (id.includes(":")) {
        const colonIndex = id.indexOf(":");
        return {
          server: id.substring(0, colonIndex),
          name: id.substring(colonIndex + 1),
        };
      }
      return { server: "unknown", name: id };
    };

    // Build capability displayName lookup map (id -> displayName)
    // This ensures we show proper names instead of raw IDs
    const capabilityNames = new Map<string, string>();
    if (ctx.capabilityDataService) {
      try {
        const capList = await ctx.capabilityDataService.listCapabilities({ limit: 200 });
        for (const cap of capList.capabilities) {
          // Use name (displayName) if available, fallback to id
          const displayName = cap.name || cap.id;
          capabilityNames.set(cap.id, displayName);
        }
      } catch (e) {
        log.warn(`Failed to build capability names lookup: ${e}`);
      }
    }

    // Helper to get display name for a node (uses lookup for capabilities)
    const getNodeDisplayName = (id: string, type: "tool" | "capability"): string => {
      if (type === "capability") {
        return capabilityNames.get(id) || id.replace(/^cap:/, "");
      }
      // For tools, parse server:name format
      const { name } = parseNodeId(id);
      return name;
    };

    // =========================================================================
    // 1. Louvain Community Members
    // =========================================================================
    try {
      const communityId = ctx.graphEngine.getCommunity(nodeId);
      if (communityId !== undefined) {
        const memberIds = ctx.graphEngine.findCommunityMembers(nodeId);
        const members = memberIds
          .filter((id) => id !== nodeId)
          .map((id) => ({
            id,
            pagerank: ctx.graphEngine.getPageRank(id),
          }))
          .sort((a, b) => b.pagerank - a.pagerank)
          .slice(0, limit);

        members.forEach((member, idx) => {
          const { server } = parseNodeId(member.id);
          const memberType: "tool" | "capability" = member.id.startsWith("cap:")
            ? "capability"
            : "tool";
          const displayName = getNodeDisplayName(member.id, memberType);
          addResult(
            member.id,
            displayName,
            memberType,
            memberType === "capability" ? undefined : server,
            "louvain",
            member.pagerank,
            idx + 1,
            { communityId: parseInt(communityId, 10) },
          );
        });
      }
    } catch (e) {
      log.warn(`Louvain failed for ${nodeId}: ${e}`);
    }

    // =========================================================================
    // 2. PageRank Neighbors (direct connections)
    // =========================================================================
    try {
      const neighborIds = ctx.graphEngine.getNeighbors(nodeId);
      const neighbors = neighborIds
        .map((id) => ({
          id,
          pagerank: ctx.graphEngine.getPageRank(id),
          edgeData: ctx.graphEngine.getEdgeData(nodeId, id) ||
            ctx.graphEngine.getEdgeData(id, nodeId),
        }))
        .sort((a, b) => b.pagerank - a.pagerank)
        .slice(0, limit);

      neighbors.forEach((neighbor, idx) => {
        const { server } = parseNodeId(neighbor.id);
        const neighborType: "tool" | "capability" = neighbor.id.startsWith("cap:")
          ? "capability"
          : "tool";
        const displayName = getNodeDisplayName(neighbor.id, neighborType);
        addResult(
          neighbor.id,
          displayName,
          neighborType,
          neighborType === "capability" ? undefined : server,
          "neighbors",
          neighbor.pagerank,
          idx + 1,
          {
            edgeWeight: neighbor.edgeData?.weight ?? null,
            edgeType: neighbor.edgeData?.edge_type ?? null,
          },
        );
      });
    } catch (e) {
      log.warn(`Neighbors failed for ${nodeId}: ${e}`);
    }

    // =========================================================================
    // 3. Adamic-Adar (for tools - measures structural similarity)
    // =========================================================================
    if (nodeType === "tool") {
      try {
        const related = ctx.graphEngine.computeAdamicAdar(nodeId, limit);
        related.forEach((r, idx) => {
          const { server, name } = parseNodeId(r.toolId);
          addResult(
            r.toolId,
            name,
            "tool",
            server,
            "adamic_adar",
            r.score,
            idx + 1,
          );
        });
      } catch (e) {
        log.warn(`Adamic-Adar failed for ${nodeId}: ${e}`);
      }
    }

    // =========================================================================
    // 4. Hyperedge Overlap (capabilities sharing tools)
    // =========================================================================
    if (nodeType === "capability" && ctx.capabilityDataService) {
      try {
        // Get capabilities list to find shared tools
        const capList = await ctx.capabilityDataService.listCapabilities({ limit: 100 });
        const sourceCapability = capList.capabilities.find((c) => c.id === nodeId);

        if (sourceCapability && sourceCapability.toolsUsed.length > 0) {
          const sourceTools = new Set(sourceCapability.toolsUsed);

          const overlaps = capList.capabilities
            .filter((c) => c.id !== nodeId)
            .map((c) => {
              const sharedCount = c.toolsUsed.filter((t) => sourceTools.has(t)).length;
              const unionCount = new Set([...sourceCapability.toolsUsed, ...c.toolsUsed]).size;
              const jaccardScore = unionCount > 0 ? sharedCount / unionCount : 0;
              return { capability: c, sharedCount, jaccardScore };
            })
            .filter((o) => o.sharedCount > 0)
            .sort((a, b) => b.jaccardScore - a.jaccardScore)
            .slice(0, limit);

          overlaps.forEach((overlap, idx) => {
            addResult(
              overlap.capability.id,
              overlap.capability.name || overlap.capability.id,
              "capability",
              undefined,
              "hyperedge",
              overlap.jaccardScore,
              idx + 1,
              { sharedTools: overlap.sharedCount },
            );
          });
        }
      } catch (e) {
        log.warn(`Hyperedge overlap failed for ${nodeId}: ${e}`);
      }
    }

    // =========================================================================
    // 5. Co-occurrence from execution traces
    // =========================================================================
    if (nodeType === "capability" && ctx.capabilityDataService) {
      try {
        const cooccurring = await ctx.capabilityDataService.findCoOccurringCapabilities(
          nodeId,
          limit,
        );

        cooccurring.forEach((co, idx) => {
          // Normalize score: log scale for count, capped at 1.0
          const normalizedScore = Math.min(1.0, Math.log10(co.cooccurrenceCount + 1) / 2);
          addResult(
            co.capabilityId,
            co.name || co.capabilityId,
            "capability",
            undefined,
            "co_occurrence",
            normalizedScore,
            idx + 1,
            {
              count: co.cooccurrenceCount,
              lastSeen: co.lastSeen,
            },
          );
        });
      } catch (e) {
        log.warn(`Co-occurrence failed for ${nodeId}: ${e}`);
      }
    }

    // =========================================================================
    // 6. Spectral Clustering (same cluster members)
    // =========================================================================
    if (ctx.dagSuggester) {
      try {
        const pageranks = ctx.dagSuggester.getCapabilityPageranks();
        if (pageranks.size > 0) {
          // Get cluster ID for source node
          // Note: Spectral clustering works on capabilities
          const capList = await ctx.capabilityDataService?.listCapabilities({ limit: 100 });
          if (capList) {
            // Ensure pageranks are computed
            ctx.dagSuggester.ensurePageranksComputed(
              capList.capabilities.map((c) => ({ id: c.id, toolsUsed: c.toolsUsed })),
            );

            // Find capabilities in same spectral cluster
            // We use pagerank as proxy since spectral clusters share similar pagerank distribution
            const sourcePagerank = pageranks.get(nodeId) || 0;
            if (sourcePagerank > 0) {
              const spectralPeers = capList.capabilities
                .filter((c) => c.id !== nodeId && pageranks.has(c.id))
                .map((c) => ({
                  capability: c,
                  pagerank: pageranks.get(c.id) || 0,
                  distance: Math.abs((pageranks.get(c.id) || 0) - sourcePagerank),
                }))
                .sort((a, b) => a.distance - b.distance)
                .slice(0, limit);

              spectralPeers.forEach((peer, idx) => {
                addResult(
                  peer.capability.id,
                  peer.capability.name || peer.capability.id,
                  "capability",
                  undefined,
                  "spectral",
                  1 - peer.distance, // Convert distance to similarity
                  idx + 1,
                  { pagerank: peer.pagerank },
                );
              });
            }
          }
        }
      } catch (e) {
        log.warn(`Spectral clustering failed for ${nodeId}: ${e}`);
      }
    }

    // =========================================================================
    // Calculate combined scores and prepare response
    // =========================================================================
    const items = Array.from(itemsMap.values());

    // Combined score = weighted average across algorithms
    // More algorithms = higher boost (max 1.5x for 5+ algos)
    const ALGO_WEIGHTS: Record<string, number> = {
      neighbors: 1.0, // Direct connections are strongest signal
      co_occurrence: 0.9, // Execution history - very strong signal
      louvain: 0.8, // Community membership
      adamic_adar: 0.7, // Structural similarity
      hyperedge: 0.6, // Shared tools
      spectral: 0.5, // Cluster proximity
    };

    for (const item of items) {
      const algoEntries = Object.entries(item.algorithms);
      let weightedSum = 0;
      let totalWeight = 0;

      for (const [algo, data] of algoEntries) {
        const weight = ALGO_WEIGHTS[algo] || 0.5;
        weightedSum += data.score * weight;
        totalWeight += weight;
      }

      // Base score from weighted average
      const baseScore = totalWeight > 0 ? weightedSum / totalWeight : 0;

      // Boost for multi-algorithm discovery (max 1.5x for 5+ algos)
      const algoBoost = Math.min(1.5, 1 + (algoEntries.length - 1) * 0.1);

      item.combinedScore = Math.round(baseScore * algoBoost * 1000) / 1000;
    }

    // Sort by combined score
    items.sort((a, b) => b.combinedScore - a.combinedScore);

    // Calculate algorithm stats
    const algorithmStats: Record<string, { count: number; avgScore: number }> = {};
    for (const item of items) {
      for (const [algo, data] of Object.entries(item.algorithms)) {
        if (!algorithmStats[algo]) {
          algorithmStats[algo] = { count: 0, avgScore: 0 };
        }
        algorithmStats[algo].count++;
        algorithmStats[algo].avgScore += data.score;
      }
    }
    for (const algo of Object.keys(algorithmStats)) {
      algorithmStats[algo].avgScore =
        Math.round((algorithmStats[algo].avgScore / algorithmStats[algo].count) * 1000) / 1000;
    }

    const response: InsightsResponse = {
      nodeId,
      nodeType,
      items,
      algorithmStats,
    };

    return jsonResponse(response, 200, corsHeaders);
  } catch (error) {
    log.error(`Graph insights failed: ${error}`);
    return errorResponse(`Failed to compute insights: ${error}`, 500, corsHeaders);
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
    case "/api/graph/community":
      return handleGraphCommunity(req, url, ctx, corsHeaders);
    case "/api/graph/neighbors":
      return handleGraphNeighbors(req, url, ctx, corsHeaders);
    case "/api/graph/hypergraph":
      return await handleGraphHypergraph(req, url, ctx, corsHeaders);
    case "/api/graph/insights":
      return await handleGraphInsights(req, url, ctx, corsHeaders);
    default:
      return null;
  }
}
