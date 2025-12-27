/**
 * Discover Handler (Story 10.6)
 *
 * Unified discovery API for tools and capabilities.
 * Implements Active Search mode from ADR-038.
 *
 * Algorithm (AC12-13 Unified Scoring Formula):
 * score = semanticScore × reliabilityFactor
 *
 * This simplifies the formula for pml_discover (search without context)
 * where graph relatedness (Adamic-Adar) returns 0 anyway.
 *
 * For tools: successRate defaults to 1.0 (cold start favorable)
 * For capabilities: successRate from capability.successRate
 *
 * @module mcp/handlers/discover-handler
 */

import * as log from "@std/log";
import type { GraphRAGEngine } from "../../graphrag/graph-engine.ts";
import type { VectorSearch } from "../../vector/search.ts";
import type { DAGSuggester } from "../../graphrag/dag-suggester.ts";
import type { MCPErrorResponse, MCPToolResponse } from "../server/types.ts";
import { formatMCPSuccess } from "../server/responses.ts";
import { addBreadcrumb, captureError, startTransaction } from "../../telemetry/sentry.ts";
import type { HybridSearchResult } from "../../graphrag/types.ts";
import type { CapabilityMatch } from "../../capabilities/types.ts";
import {
  calculateReliabilityFactor,
  DEFAULT_RELIABILITY_CONFIG,
  GLOBAL_SCORE_CAP,
  type ReliabilityConfig,
} from "../../graphrag/algorithms/unified-search.ts";

/**
 * Discover request arguments
 */
export interface DiscoverArgs {
  intent?: string;
  filter?: {
    type?: "tool" | "capability" | "all";
    minScore?: number;
  };
  limit?: number;
  include_related?: boolean;
}

/**
 * Related tool in discover response
 */
interface RelatedToolResponse {
  tool_id: string;
  relation: string;
  score: number;
}

/**
 * Unified discover result item
 */
interface DiscoverResultItem {
  type: "tool" | "capability";
  id: string;
  name: string;
  description: string;
  score: number;
  // Tool-specific fields
  server_id?: string;
  input_schema?: Record<string, unknown>;
  related_tools?: RelatedToolResponse[];
  // Capability-specific fields
  code_snippet?: string;
  success_rate?: number;
  usage_count?: number;
  semantic_score?: number;
}

/**
 * Discover response format
 */
interface DiscoverResponse {
  results: DiscoverResultItem[];
  meta: {
    query: string;
    filter_type: string;
    total_found: number; // Total matches before limit
    returned_count: number; // Actual results returned after limit
    tools_count: number;
    capabilities_count: number;
  };
}

/**
 * Compute unified discover score (AC12-13)
 *
 * Formula: score = semanticScore × reliabilityFactor
 *
 * This is the simplified formula for pml_discover (Active Search without context).
 * Graph relatedness (Adamic-Adar) is not used because contextNodes is empty.
 *
 * @param semanticScore - Vector similarity score (0-1)
 * @param successRate - Success rate (0-1), defaults to 1.0 for tools
 * @param config - Reliability thresholds configuration
 * @returns Final score capped at 0.95
 */
export function computeDiscoverScore(
  semanticScore: number,
  successRate: number = 1.0,
  config: ReliabilityConfig = DEFAULT_RELIABILITY_CONFIG,
): number {
  const reliabilityFactor = calculateReliabilityFactor(successRate, config);
  const rawScore = semanticScore * reliabilityFactor;
  return Math.min(rawScore, GLOBAL_SCORE_CAP);
}

/**
 * Handle pml:discover request (Story 10.6)
 *
 * Unified search across tools and capabilities with merged, sorted results.
 *
 * @param args - Discover arguments (intent, filter, limit, include_related)
 * @param vectorSearch - Vector search for semantic matching
 * @param graphEngine - GraphRAG engine for hybrid tool search
 * @param dagSuggester - DAG suggester for capability search
 * @returns Unified discover results
 */
export async function handleDiscover(
  args: unknown,
  vectorSearch: VectorSearch,
  graphEngine: GraphRAGEngine,
  dagSuggester: DAGSuggester,
): Promise<MCPToolResponse | MCPErrorResponse> {
  const transaction = startTransaction("mcp.discover", "mcp");
  const startTime = performance.now();

  try {
    const params = args as DiscoverArgs;

    // Validate required intent parameter (must be non-empty string)
    if (!params.intent || typeof params.intent !== "string" || !params.intent.trim()) {
      transaction.finish();
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: "Missing or empty required parameter: 'intent'",
          }),
        }],
      };
    }

    const intent = params.intent;
    const filterType = params.filter?.type ?? "all";
    const minScore = params.filter?.minScore ?? 0.0;
    const limit = Math.min(params.limit ?? 1, 50); // Default 1, Max 50
    const includeRelated = params.include_related ?? false;

    transaction.setData("intent", intent);
    transaction.setData("filter_type", filterType);
    transaction.setData("limit", limit);
    addBreadcrumb("mcp", "Processing discover request", { intent, filterType });

    log.info(`discover: intent="${intent}", filter=${filterType}, limit=${limit}`);

    const results: DiscoverResultItem[] = [];
    let toolsCount = 0;
    let capabilitiesCount = 0;

    // Search tools if filter allows
    if (filterType === "all" || filterType === "tool") {
      const toolResults = await searchTools(
        intent,
        vectorSearch,
        graphEngine,
        limit,
        includeRelated,
      );
      for (const tool of toolResults) {
        if (tool.score >= minScore) {
          results.push(tool);
          toolsCount++;
        }
      }
    }

    // Search capabilities if filter allows
    if (filterType === "all" || filterType === "capability") {
      const capabilityResult = await searchCapability(intent, dagSuggester);
      if (capabilityResult && capabilityResult.score >= minScore) {
        results.push(capabilityResult);
        capabilitiesCount++;
      }
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);

    // Apply limit after merge and sort
    const limitedResults = results.slice(0, limit);

    const response: DiscoverResponse = {
      results: limitedResults,
      meta: {
        query: intent,
        filter_type: filterType,
        total_found: results.length, // Before limit
        returned_count: limitedResults.length, // After limit
        tools_count: toolsCount,
        capabilities_count: capabilitiesCount,
      },
    };

    const elapsedMs = performance.now() - startTime;
    log.info(
      `discover: found ${limitedResults.length} results (${toolsCount} tools, ${capabilitiesCount} capabilities) in ${
        elapsedMs.toFixed(1)
      }ms`,
    );

    transaction.finish();
    return formatMCPSuccess(response);
  } catch (error) {
    log.error(`discover error: ${error}`);
    captureError(error as Error, {
      operation: "discover",
      handler: "handleDiscover",
    });
    transaction.finish();
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          error: `Discover failed: ${(error as Error).message}`,
        }),
      }],
    };
  }
}

/**
 * Search tools using unified scoring (AC12-13)
 *
 * For pml_discover (Active Search without context), we use simplified formula:
 * score = semanticScore × reliabilityFactor
 *
 * Tools default to successRate=1.0 (cold start favorable).
 * Graph relatedness is not used since contextNodes is empty.
 */
async function searchTools(
  intent: string,
  vectorSearch: VectorSearch,
  graphEngine: GraphRAGEngine,
  limit: number,
  includeRelated: boolean,
): Promise<DiscoverResultItem[]> {
  const hybridResults: HybridSearchResult[] = await graphEngine.searchToolsHybrid(
    vectorSearch,
    intent,
    limit,
    [], // contextTools - empty for pml_discover
    includeRelated,
  );

  return hybridResults.map((result) => {
    // AC12: Apply unified formula: score = semantic × reliability
    // Tools don't have successRate yet, default to 1.0 (cold start favorable)
    const toolSuccessRate = 1.0;
    const unifiedScore = computeDiscoverScore(result.semanticScore, toolSuccessRate);

    const item: DiscoverResultItem = {
      type: "tool",
      id: result.toolId,
      name: extractToolName(result.toolId),
      description: result.description,
      score: unifiedScore, // Use unified score instead of finalScore
      server_id: result.serverId,
      input_schema: result.schema?.inputSchema as Record<string, unknown> | undefined,
    };

    // Add related tools if present
    if (result.relatedTools && result.relatedTools.length > 0) {
      item.related_tools = result.relatedTools.map((rt) => ({
        tool_id: rt.toolId,
        relation: rt.relation,
        score: rt.score,
      }));
    }

    return item;
  });
}

/**
 * Search capabilities using CapabilityMatcher (AC12-13)
 *
 * The CapabilityMatcher already applies the unified formula:
 * score = semanticScore × reliabilityFactor × transitiveReliability
 *
 * Transitive reliability (ADR-042 §3) propagates through dependencies:
 * if A depends on B, A's reliability = min(A.successRate, B.successRate)
 *
 * We use match.score directly which includes all reliability factors.
 */
async function searchCapability(
  intent: string,
  dagSuggester: DAGSuggester,
): Promise<DiscoverResultItem | null> {
  const match: CapabilityMatch | null = await dagSuggester.searchCapabilities(intent);

  if (!match) {
    return null;
  }

  // AC12-13: CapabilityMatcher.findMatch() already computes:
  // score = semanticScore × reliabilityFactor × transitiveReliability
  // See matcher.ts:187-188 and computeTransitiveReliability() for implementation
  return {
    type: "capability",
    id: match.capability.id,
    name: match.capability.name ?? match.capability.id.substring(0, 8),
    description: match.capability.description ?? "Learned capability",
    score: match.score, // Already includes reliability + transitive
    code_snippet: match.capability.codeSnippet,
    success_rate: match.capability.successRate,
    usage_count: match.capability.usageCount,
    semantic_score: match.semanticScore,
  };
}

/**
 * Extract tool name from tool ID
 *
 * @example "filesystem:read_file" → "read_file"
 */
function extractToolName(toolId: string): string {
  const parts = toolId.split(":");
  return parts.length > 1 ? parts.slice(1).join(":") : toolId;
}
