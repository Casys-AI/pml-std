/**
 * Discover Tools Use Case
 *
 * Searches for MCP tools using SHGAT K-head scoring with HybridSearch fallback.
 * Extracts business logic from discover-handler for Clean Architecture.
 *
 * @module application/use-cases/discover/discover-tools
 */

import * as log from "@std/log";
import type { UseCaseResult } from "../shared/types.ts";
import type { DiscoverRequest, DiscoveredTool, DiscoverToolsResult } from "./types.ts";
import type { IToolStore } from "../../../tools/types.ts";
import type { SHGAT } from "../../../graphrag/algorithms/shgat.ts";
import type { EmbeddingModelInterface } from "../../../vector/embeddings.ts";
import type { IDecisionLogger } from "../../../telemetry/decision-logger.ts";
import type { GraphRAGEngine } from "../../../graphrag/graph-engine.ts";
import type { VectorSearch } from "../../../vector/search.ts";
import type { HybridSearchResult } from "../../../graphrag/types.ts";
import {
  calculateReliabilityFactor,
  DEFAULT_RELIABILITY_CONFIG,
  GLOBAL_SCORE_CAP,
} from "../../../graphrag/algorithms/unified-search.ts";

/**
 * Dependencies for DiscoverToolsUseCase
 */
export interface DiscoverToolsDeps {
  toolStore: IToolStore;
  shgat?: SHGAT;
  embeddingModel?: EmbeddingModelInterface;
  graphEngine?: GraphRAGEngine;
  vectorSearch?: VectorSearch;
  decisionLogger?: IDecisionLogger;
}

/**
 * Discover Tools Use Case
 *
 * Uses SHGAT K-head for tool scoring when available, falls back to HybridSearch.
 */
export class DiscoverToolsUseCase {
  constructor(private readonly deps: DiscoverToolsDeps) {}

  /**
   * Execute tool discovery
   */
  async execute(request: DiscoverRequest): Promise<UseCaseResult<DiscoverToolsResult>> {
    const { intent, limit = 5, minScore = 0, correlationId } = request;

    if (!intent || intent.trim().length === 0) {
      return {
        success: false,
        error: { code: "MISSING_INTENT", message: "Intent is required for tool discovery" },
      };
    }

    try {
      // Try SHGAT first (unified scoring)
      if (this.deps.shgat && this.deps.embeddingModel) {
        const result = await this.discoverWithSHGAT(intent, limit, minScore, correlationId);
        if (result) return { success: true, data: result };
      }

      // Fallback to HybridSearch
      if (this.deps.graphEngine && this.deps.vectorSearch) {
        const result = await this.discoverWithHybridSearch(intent, limit, minScore, correlationId);
        return { success: true, data: result };
      }

      return {
        success: false,
        error: { code: "NO_SEARCH_ENGINE", message: "No search engine available" },
      };
    } catch (error) {
      log.error(`[DiscoverTools] Failed: ${error}`);
      return {
        success: false,
        error: { code: "DISCOVERY_FAILED", message: (error as Error).message },
      };
    }
  }

  /**
   * Discover tools using SHGAT K-head scoring
   */
  private async discoverWithSHGAT(
    intent: string,
    limit: number,
    minScore: number,
    correlationId?: string,
  ): Promise<DiscoverToolsResult | null> {
    const { shgat, embeddingModel, toolStore, decisionLogger } = this.deps;
    if (!shgat || !embeddingModel) return null;

    const intentEmbedding = await embeddingModel.encode(intent);
    if (!intentEmbedding || intentEmbedding.length === 0) {
      log.warn("[DiscoverTools] Failed to generate intent embedding");
      return null;
    }

    // Score tools with SHGAT K-head
    const shgatResults = shgat.scoreAllTools(intentEmbedding);

    log.debug("[DiscoverTools] SHGAT scored", {
      count: shgatResults.length,
      top3: shgatResults.slice(0, 3).map((r) => ({ id: r.toolId, score: r.score.toFixed(3) })),
    });

    // Fetch metadata for top results
    const topToolIds = shgatResults.slice(0, limit).map((r) => r.toolId);
    const toolsMetadata = await toolStore.findByIds(topToolIds);

    // Build results
    const tools: DiscoveredTool[] = [];
    for (const shgatResult of shgatResults.slice(0, limit)) {
      const metadata = toolsMetadata.get(shgatResult.toolId);
      const toolName = extractToolName(shgatResult.toolId);

      // Log decision with name for TracingPanel display
      decisionLogger?.logDecision({
        algorithm: "SHGAT",
        mode: "active_search",
        targetType: "tool",
        intent,
        finalScore: shgatResult.score,
        threshold: minScore,
        decision: shgatResult.score >= minScore ? "accepted" : "rejected",
        targetId: shgatResult.toolId,
        targetName: toolName,
        correlationId,
        signals: {
          numHeads: shgatResult.headScores?.length ?? 0,
          avgHeadScore: shgatResult.headScores
            ? shgatResult.headScores.reduce((a, b) => a + b, 0) / shgatResult.headScores.length
            : 0,
        },
      });
      tools.push({
        type: "tool",
        record_type: "mcp-tool",
        id: shgatResult.toolId,
        name: extractToolName(shgatResult.toolId),
        description: metadata?.description ?? shgatResult.toolId,
        score: shgatResult.score,
        server_id: metadata?.serverId,
        input_schema: metadata?.inputSchema,
      });
    }

    return { tools, totalFound: shgatResults.length };
  }

  /**
   * Discover tools using HybridSearch (fallback)
   */
  private async discoverWithHybridSearch(
    intent: string,
    limit: number,
    minScore: number,
    correlationId?: string,
  ): Promise<DiscoverToolsResult> {
    const { graphEngine, vectorSearch, decisionLogger } = this.deps;
    if (!graphEngine || !vectorSearch) {
      return { tools: [], totalFound: 0 };
    }

    log.debug("[DiscoverTools] Using HybridSearch fallback");

    const hybridResults: HybridSearchResult[] = await graphEngine.searchToolsHybrid(
      vectorSearch,
      intent,
      limit,
      [], // contextTools - empty for discover
      false, // includeRelated
      undefined,
      correlationId,
    );

    const tools: DiscoveredTool[] = [];
    for (const result of hybridResults) {
      // Apply unified formula: score = semantic × reliability
      const toolSuccessRate = 1.0; // Cold start favorable
      const reliabilityFactor = calculateReliabilityFactor(toolSuccessRate, DEFAULT_RELIABILITY_CONFIG);
      const unifiedScore = Math.min(result.semanticScore * reliabilityFactor, GLOBAL_SCORE_CAP);
      const toolName = extractToolName(result.toolId);

      decisionLogger?.logDecision({
        algorithm: "HybridSearch",
        mode: "active_search",
        targetType: "tool",
        intent,
        finalScore: unifiedScore,
        threshold: minScore,
        decision: unifiedScore >= minScore ? "accepted" : "rejected",
        targetId: result.toolId,
        targetName: toolName,
        correlationId,
        signals: { semanticScore: result.semanticScore, targetSuccessRate: toolSuccessRate },
        params: { reliabilityFactor },
      });

      tools.push({
        type: "tool",
        record_type: "mcp-tool",
        id: result.toolId,
        name: extractToolName(result.toolId),
        description: result.description,
        score: unifiedScore,
        server_id: result.serverId,
        input_schema: result.schema?.inputSchema as Record<string, unknown> | undefined,
        related_tools: result.relatedTools?.map((rt) => ({
          tool_id: rt.toolId,
          relation: rt.relation,
          score: rt.score,
        })),
      });
    }

    return { tools, totalFound: hybridResults.length };
  }
}

/**
 * Extract tool name from tool ID
 * @example "filesystem:read_file" → "read_file"
 */
function extractToolName(toolId: string): string {
  const parts = toolId.split(":");
  return parts.length > 1 ? parts.slice(1).join(":") : toolId;
}
