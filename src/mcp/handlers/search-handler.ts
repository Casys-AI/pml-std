/**
 * Search Handlers
 *
 * Handles search_tools and search_capabilities MCP tool requests.
 *
 * @module mcp/handlers/search-handler
 */

import * as log from "@std/log";
import type { GraphRAGEngine } from "../../graphrag/graph-engine.ts";
import type { VectorSearch } from "../../vector/search.ts";
import type { DAGSuggester } from "../../graphrag/dag-suggester.ts";
import type { MCPToolResponse, MCPErrorResponse, SearchToolsArgs, SearchCapabilitiesArgs } from "../server/types.ts";
import { formatMCPToolError, formatMCPSuccess } from "../server/responses.ts";
import { addBreadcrumb, captureError, startTransaction } from "../../telemetry/sentry.ts";

/**
 * Handle search_tools request (Story 5.2 / ADR-022)
 *
 * Delegates to GraphRAGEngine.searchToolsHybrid() for centralized hybrid search logic.
 * Combines semantic search with graph-based recommendations.
 *
 * @param args - Search arguments (query, limit, include_related, context_tools)
 * @param graphEngine - GraphRAG engine for hybrid search
 * @param vectorSearch - Vector search for semantic matching
 * @returns Search results with scores
 */
export async function handleSearchTools(
  args: unknown,
  graphEngine: GraphRAGEngine,
  vectorSearch: VectorSearch,
): Promise<MCPToolResponse> {
  const params = args as SearchToolsArgs;

  // Validate query
  if (!params.query || typeof params.query !== "string") {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          error: "Missing required parameter: 'query'",
        }),
      }],
    };
  }

  const query = params.query;
  const limit = params.limit || 10;
  const includeRelated = params.include_related || false;
  const contextTools = params.context_tools || [];

  log.info(`search_tools: query="${query}", limit=${limit}, include_related=${includeRelated}`);

  // ADR-022: Delegate to centralized hybrid search in GraphRAGEngine
  const hybridResults = await graphEngine.searchToolsHybrid(
    vectorSearch,
    query,
    limit,
    contextTools,
    includeRelated,
  );

  if (hybridResults.length === 0) {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          tools: [],
          message: "No tools found matching your query",
        }),
      }],
    };
  }

  // Map to MCP response format (snake_case for external API)
  const results = hybridResults.map((result) => ({
    tool_id: result.toolId,
    server_id: result.serverId,
    description: result.description,
    input_schema: result.schema?.inputSchema,
    semantic_score: result.semanticScore,
    graph_score: result.graphScore,
    final_score: result.finalScore,
    related_tools: result.relatedTools?.map((rt) => ({
      tool_id: rt.toolId,
      relation: rt.relation,
      score: rt.score,
    })) || [],
  }));

  // Get meta info from graph engine
  const edgeCount = graphEngine.getEdgeCount();
  const nodeCount = graphEngine.getStats().nodeCount;
  const maxPossibleEdges = nodeCount * (nodeCount - 1);
  const density = maxPossibleEdges > 0 ? edgeCount / maxPossibleEdges : 0;
  const alpha = Math.max(0.5, 1.0 - density * 2);

  log.info(
    `search_tools: found ${results.length} results (alpha=${alpha.toFixed(2)}, edges=${edgeCount})`,
  );

  return {
    content: [{
      type: "text",
      text: JSON.stringify(
        {
          tools: results,
          meta: {
            query,
            alpha: Math.round(alpha * 100) / 100,
            edge_count: edgeCount,
          },
        },
        null,
        2,
      ),
    }],
  };
}

/**
 * Handle search_capabilities request (Story 7.3a)
 *
 * Delegates to DAGSuggester.searchCapabilities() for capability matching.
 * Matches capabilities using semantic similarity * reliability score.
 *
 * @param args - Search arguments (intent, include_suggestions)
 * @param dagSuggester - DAG suggester for capability search
 * @returns Capability matches formatted for Claude
 */
export async function handleSearchCapabilities(
  args: unknown,
  dagSuggester: DAGSuggester,
): Promise<MCPToolResponse | MCPErrorResponse> {
  const transaction = startTransaction("mcp.capabilities.search", "mcp");
  try {
    const params = args as SearchCapabilitiesArgs;

    if (!params.intent || typeof params.intent !== "string") {
      transaction.finish();
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: "Missing required parameter: 'intent'",
          }),
        }],
      };
    }

    const intent = params.intent;
    transaction.setData("intent", intent);
    addBreadcrumb("mcp", "Processing search_capabilities request", { intent });

    log.info(`search_capabilities: "${intent}"`);

    // Search for capability match via DAGSuggester
    const match = await dagSuggester.searchCapabilities(intent);

    // Format response (AC5)
    const response = {
      capabilities: match
        ? [{
          id: match.capability.id,
          name: match.capability.name,
          description: match.capability.description,
          code_snippet: match.capability.codeSnippet,
          parameters_schema: match.parametersSchema,
          success_rate: match.capability.successRate,
          usage_count: match.capability.usageCount,
          score: match.score, // Final score (Semantic * Reliability)
          semantic_score: match.semanticScore,
        }]
        : [],
      suggestions: [], // To be implemented in Story 7.4 (Strategic Discovery)
      threshold_used: match?.thresholdUsed ?? 0,
      total_found: match ? 1 : 0,
    };

    transaction.finish();
    return formatMCPSuccess(response);
  } catch (error) {
    log.error(`search_capabilities error: ${error}`);
    captureError(error as Error, {
      operation: "capabilities/search",
      handler: "handleSearchCapabilities",
    });
    transaction.finish();
    return formatMCPToolError(
      `Capability search failed: ${(error as Error).message}`,
    );
  }
}
