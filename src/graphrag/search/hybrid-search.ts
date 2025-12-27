/**
 * Hybrid Search Module
 *
 * Combines semantic search (vector similarity) with graph-based recommendations
 * for intelligent tool discovery.
 *
 * ADR-022: Hybrid approach balances semantic relevance with structural relationships.
 * ADR-048: Local adaptive alpha for per-tool weight calculation.
 *
 * @module graphrag/search/hybrid-search
 */

import * as log from "@std/log";
import type { VectorSearch } from "../../vector/search.ts";
import type { HybridSearchResult } from "../types.ts";
import { computeGraphRelatedness, getNeighbors } from "../algorithms/adamic-adar.ts";
import type { LocalAlphaCalculator } from "../local-alpha.ts";
import type { AlgorithmTracer } from "../../telemetry/algorithm-tracer.ts";

/**
 * Graph interface for hybrid search operations
 */
export interface HybridSearchGraph {
  order: number;
  size: number;
  hasNode(nodeId: string): boolean;
  hasEdge(source: string, target: string): boolean;
  neighbors(nodeId: string): string[];
  inNeighbors(nodeId: string): string[];
  outNeighbors(nodeId: string): string[];
  degree(nodeId: string): number;
  getEdgeAttributes(source: string, target: string): Record<string, unknown>;
}

/**
 * Hybrid search options
 */
export interface HybridSearchOptions {
  /** Maximum number of results (default: 10) */
  limit?: number;
  /** Minimum semantic score threshold (default: 0.5) */
  minScore?: number;
  /** Tools already in context (boosts related tools) */
  contextTools?: string[];
  /** Include related tools via graph neighbors (default: false) */
  includeRelated?: boolean;
  /** LocalAlphaCalculator for per-tool alpha (ADR-048) */
  localAlphaCalculator?: LocalAlphaCalculator | null;
  /** AlgorithmTracer for observability (Story 7.6) */
  algorithmTracer?: AlgorithmTracer | null;
  /** Correlation ID for grouping related traces (Story 7.6+) */
  correlationId?: string;
}

/**
 * Alpha breakdown for tracing
 */
interface AlphaBreakdown {
  alpha: number;
  algorithm: string;
  coldStart: boolean;
}

/**
 * Perform hybrid search combining semantic and graph scores
 *
 * Process:
 * 1. Semantic search for query-matching tools (base candidates)
 * 2. Calculate adaptive alpha based on graph density
 * 3. Compute graph relatedness for each candidate (Adamic-Adar / direct edges)
 * 4. Combine scores: finalScore = α × semantic + (1-α) × graph
 * 5. Optionally add related tools (in/out neighbors)
 *
 * Graceful degradation: Falls back to semantic-only if graph is empty (alpha=1.0)
 *
 * Performance target: <20ms overhead (ADR-022)
 *
 * @param vectorSearch - VectorSearch instance for semantic search
 * @param graph - Graphology graph instance
 * @param pageRanks - Pre-computed PageRank scores
 * @param query - Natural language search query
 * @param options - Search options
 * @returns Sorted array of hybrid search results (highest finalScore first)
 */
export async function searchToolsHybrid(
  vectorSearch: VectorSearch,
  graph: HybridSearchGraph,
  _pageRanks: Record<string, number>, // Reserved for future PageRank boosting (ADR-022)
  query: string,
  options: HybridSearchOptions = {},
): Promise<HybridSearchResult[]> {
  const startTime = performance.now();
  const {
    limit = 10,
    minScore = 0.5,
    contextTools = [],
    includeRelated = false,
    localAlphaCalculator = null,
    algorithmTracer = null,
  } = options;

  try {
    // 1. Calculate graph density for adaptive parameters
    const edgeCount = graph.size;
    const nodeCount = graph.order;
    const maxPossibleEdges = nodeCount * (nodeCount - 1); // directed graph
    const density = maxPossibleEdges > 0 ? edgeCount / maxPossibleEdges : 0;

    // ADR-023: Dynamic Candidate Expansion based on graph maturity
    // Cold start: 1.5x (trust semantic), Growing: 2.0x, Mature: 3.0x (find hidden gems)
    const expansionMultiplier = density < 0.01 ? 1.5 : density < 0.1 ? 2.0 : 3.0;
    const searchLimit = Math.ceil(limit * expansionMultiplier);

    // 2. Semantic search for base candidates with dynamic expansion
    const semanticResults = await vectorSearch.searchTools(query, searchLimit, minScore);

    if (semanticResults.length === 0) {
      log.debug(`[searchToolsHybrid] No semantic candidates for: "${query}"`);
      return [];
    }

    // 3. Calculate adaptive alpha (ADR-048: local per tool, fallback to global)
    // Global alpha for logging and fallback
    const globalAlpha = Math.max(0.5, 1.0 - density * 2);

    log.debug(
      `[searchToolsHybrid] globalAlpha=${
        globalAlpha.toFixed(2)
      }, expansion=${expansionMultiplier}x (density=${density.toFixed(4)}, edges=${edgeCount})`,
    );

    // 4. Compute hybrid scores for each candidate with local alpha (ADR-048)
    // Store alpha breakdown for tracing (keyed by toolId for post-sort lookup)
    const alphaBreakdowns = new Map<string, AlphaBreakdown>();

    const results: HybridSearchResult[] = semanticResults.map((result) => {
      const graphScore = computeGraphRelatedness(graph, result.toolId, contextTools);

      // ADR-048: Use local alpha per tool (Active Search mode) with breakdown for tracing
      let localAlpha = globalAlpha;
      let alphaAlgorithm = "none";
      let coldStart = false;

      if (localAlphaCalculator) {
        const breakdown = localAlphaCalculator.getLocalAlphaWithBreakdown(
          "active",
          result.toolId,
          "tool",
          contextTools,
        );
        localAlpha = breakdown.alpha;
        alphaAlgorithm = breakdown.algorithm;
        coldStart = breakdown.coldStart;
      }

      alphaBreakdowns.set(result.toolId, {
        alpha: localAlpha,
        algorithm: alphaAlgorithm,
        coldStart,
      });

      const finalScore = localAlpha * result.score + (1 - localAlpha) * graphScore;

      return {
        toolId: result.toolId,
        serverId: result.serverId,
        toolName: result.toolName,
        description: result.schema?.description || "",
        semanticScore: Math.round(result.score * 100) / 100,
        graphScore: Math.round(graphScore * 100) / 100,
        finalScore: Math.round(finalScore * 100) / 100,
        schema: result.schema as unknown as Record<string, unknown>,
      };
    });

    // 5. Sort by final score (descending) and limit
    results.sort((a, b) => b.finalScore - a.finalScore);
    const topResults = results.slice(0, limit);

    // 6. Add related tools if requested
    if (includeRelated) {
      for (const result of topResults) {
        result.relatedTools = [];

        // Get in-neighbors (tools often used BEFORE this one)
        const inNeighbors = getNeighbors(graph, result.toolId, "in");
        for (const neighbor of inNeighbors.slice(0, 2)) {
          result.relatedTools.push({
            toolId: neighbor,
            relation: "often_before",
            score: 0.8,
          });
        }

        // Get out-neighbors (tools often used AFTER this one)
        const outNeighbors = getNeighbors(graph, result.toolId, "out");
        for (const neighbor of outNeighbors.slice(0, 2)) {
          result.relatedTools.push({
            toolId: neighbor,
            relation: "often_after",
            score: 0.8,
          });
        }
      }
    }

    // Story 7.6: Log algorithm traces for observability (fire-and-forget)
    if (algorithmTracer) {
      for (const result of topResults) {
        const breakdown = alphaBreakdowns.get(result.toolId) || {
          alpha: globalAlpha,
          algorithm: "none",
          coldStart: false,
        };

        algorithmTracer.logTrace({
          correlationId: options.correlationId,
          algorithmName: "HybridSearch",
          algorithmMode: "active_search",
          targetType: "tool",
          intent: query.substring(0, 200),
          signals: {
            semanticScore: result.semanticScore,
            graphScore: result.graphScore,
            graphDensity: density,
            spectralClusterMatch: false, // N/A for hybrid search
            localAlpha: breakdown.alpha,
            alphaAlgorithm: breakdown.algorithm as
              | "embeddings_hybrides"
              | "heat_diffusion"
              | "heat_hierarchical"
              | "bayesian"
              | "none",
            coldStart: breakdown.coldStart,
            targetId: result.toolId, // Auto-detects pure in AlgorithmTracer
          },
          params: {
            alpha: breakdown.alpha,
            reliabilityFactor: 1.0,
            structuralBoost: 0,
          },
          finalScore: result.finalScore,
          thresholdUsed: minScore,
          decision: "accepted",
        });
      }
    }

    const elapsedMs = performance.now() - startTime;
    log.info(
      `[searchToolsHybrid] "${query}" → ${topResults.length} results (alpha=${
        globalAlpha.toFixed(2)
      }, ${elapsedMs.toFixed(1)}ms)`,
    );

    return topResults;
  } catch (error) {
    log.error(`[searchToolsHybrid] Failed: ${error}`);
    // Graceful degradation: fall back to semantic-only
    try {
      const fallbackResults = await vectorSearch.searchTools(query, limit, minScore);
      return fallbackResults.map((r) => ({
        toolId: r.toolId,
        serverId: r.serverId,
        toolName: r.toolName,
        description: r.schema?.description || "",
        semanticScore: r.score,
        graphScore: 0,
        finalScore: r.score,
        schema: r.schema as unknown as Record<string, unknown>,
      }));
    } catch (fallbackError) {
      log.error(`[searchToolsHybrid] Fallback also failed: ${fallbackError}`);
      return [];
    }
  }
}

/**
 * Calculate adaptive alpha based on graph density
 *
 * Alpha controls the balance between semantic and graph scores:
 * - alpha=1.0: Pure semantic search (cold start, no graph data)
 * - alpha=0.5: Equal weight (dense graph)
 *
 * Formula: alpha = max(0.5, 1.0 - density * 2)
 *
 * @param graph - Graphology graph instance
 * @returns Alpha value between 0.5 and 1.0
 */
export function calculateAdaptiveAlpha(graph: HybridSearchGraph): number {
  const nodeCount = graph.order;
  if (nodeCount <= 1) return 1.0;

  const maxPossibleEdges = nodeCount * (nodeCount - 1);
  const density = maxPossibleEdges > 0 ? graph.size / maxPossibleEdges : 0;
  return Math.max(0.5, 1.0 - density * 2);
}

/**
 * Calculate graph density
 *
 * Density = actual_edges / max_possible_edges
 *
 * @param graph - Graphology graph instance
 * @returns Density value between 0 and 1
 */
export function calculateGraphDensity(graph: HybridSearchGraph): number {
  const nodeCount = graph.order;
  if (nodeCount <= 1) return 0;

  const maxPossibleEdges = nodeCount * (nodeCount - 1); // directed graph
  return graph.size / maxPossibleEdges;
}
