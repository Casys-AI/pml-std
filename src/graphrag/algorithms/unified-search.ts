/**
 * Unified Search Algorithm (POC)
 *
 * Unified search for both tools and capabilities on the hypergraph.
 * Replaces the asymmetric approach where tools had elaborate search
 * and capabilities had simple semantic × reliability.
 *
 * Formula: score = (semantic × α + graph × (1-α)) × reliability
 *
 * This unifies:
 * - Tool Hybrid Search (ADR-022): semantic + graph with adaptive alpha
 * - Capability Active Match (ADR-038): semantic × reliability
 *
 * Into a single algorithm that treats everything as a capability
 * (tools are atomic capabilities).
 *
 * @module graphrag/algorithms/unified-search
 */

import { computeGraphRelatedness } from "./adamic-adar.ts";
import type { LocalAlphaCalculator, NodeType } from "../local-alpha.ts";

/**
 * Node type in the unified hypergraph
 */
export type UnifiedNodeType = "tool" | "capability";

/**
 * A searchable node (tool or capability)
 */
export interface SearchableNode {
  id: string;
  type: UnifiedNodeType;
  name: string;
  description: string;
  /** Embedding vector for semantic search */
  embedding?: number[];
  /** Success rate (0-1), defaults to 1.0 for new nodes */
  successRate: number;
  /** Server ID for tools */
  serverId?: string;
}

/**
 * Graph interface for unified search
 */
export interface UnifiedSearchGraph {
  order: number;
  size: number;
  hasNode(nodeId: string): boolean;
  hasEdge(source: string, target: string): boolean;
  neighbors(nodeId: string): string[];
  inNeighbors(nodeId: string): string[];
  outNeighbors(nodeId: string): string[];
  degree(nodeId: string): number;
  getEdgeAttributes(source: string, target: string): Record<string, unknown>;
  // ADR-048: Additional methods for LocalAlphaCalculator compatibility
  getEdgeAttribute?(source: string, target: string, name: string): number | undefined;
  forEachNode?(callback: (node: string) => void): void;
}

/**
 * Vector search interface
 */
export interface UnifiedVectorSearch {
  /**
   * Search for nodes by semantic similarity
   * @param query - Natural language query
   * @param limit - Max results
   * @param minScore - Minimum similarity threshold
   * @returns Array of { nodeId, score }
   */
  search(query: string, limit: number, minScore: number): Promise<Array<{
    nodeId: string;
    score: number;
  }>>;
}

/**
 * Unified search options
 */
export interface UnifiedSearchOptions {
  /** Maximum results (default: 10) */
  limit?: number;
  /** Minimum semantic score (default: 0.5) */
  minScore?: number;
  /** Context nodes for graph relatedness */
  contextNodes?: string[];
  /** Override alpha (0-1), otherwise calculated adaptively. Takes precedence over localAlphaCalculator. */
  alpha?: number;
  /** LocalAlphaCalculator for per-node alpha (ADR-048). Used when alpha is not set. */
  localAlphaCalculator?: LocalAlphaCalculator | null;
  /** Alpha mode for LocalAlphaCalculator: 'active' uses EmbeddingsHybrides, 'passive' uses HeatDiffusion */
  alphaMode?: "active" | "passive";
  /** Reliability thresholds */
  reliability?: ReliabilityConfig;
  /** Transitive reliability lookup (for capabilities with dependencies) */
  getTransitiveReliability?: (nodeId: string) => Promise<number>;
}

/**
 * Reliability configuration (ADR-038 §3.1)
 */
export interface ReliabilityConfig {
  /** Below this, apply penalty (default: 0.5) */
  penaltyThreshold: number;
  /** Penalty multiplier (default: 0.1) */
  penaltyFactor: number;
  /** Above this, apply boost (default: 0.9) */
  boostThreshold: number;
  /** Boost multiplier (default: 1.2) */
  boostFactor: number;
}

/**
 * Default reliability config
 */
export const DEFAULT_RELIABILITY_CONFIG: ReliabilityConfig = {
  penaltyThreshold: 0.5,
  penaltyFactor: 0.1,
  boostThreshold: 0.9,
  boostFactor: 1.2,
};

/**
 * Global score cap (ADR-038)
 *
 * Prevents any single result from dominating by capping final scores.
 * This ensures diverse results and prevents over-confidence.
 */
export const GLOBAL_SCORE_CAP = 0.95;

/**
 * Unified search result
 */
export interface UnifiedSearchResult {
  nodeId: string;
  nodeType: UnifiedNodeType;
  name: string;
  description: string;
  /** Raw semantic similarity (0-1) */
  semanticScore: number;
  /** Graph relatedness score (0-1) */
  graphScore: number;
  /** Reliability factor applied */
  reliabilityFactor: number;
  /** Alpha used for this node */
  alpha: number;
  /** Final combined score */
  finalScore: number;
  /** Server ID (for tools) */
  serverId?: string;
}

/**
 * Score breakdown for debugging/tracing
 */
export interface ScoreBreakdown {
  semantic: number;
  graph: number;
  alpha: number;
  hybridBeforeReliability: number;
  reliabilityFactor: number;
  transitiveReliability: number;
  final: number;
}

/**
 * Calculate adaptive alpha based on graph density
 *
 * - alpha=1.0: Pure semantic (cold start, sparse graph)
 * - alpha=0.5: Equal weight (dense graph)
 *
 * Formula: alpha = max(0.5, 1.0 - density * 2)
 */
export function calculateAdaptiveAlpha(graph: UnifiedSearchGraph): number {
  const nodeCount = graph.order;
  if (nodeCount <= 1) return 1.0;

  const maxPossibleEdges = nodeCount * (nodeCount - 1);
  const density = maxPossibleEdges > 0 ? graph.size / maxPossibleEdges : 0;
  return Math.max(0.5, 1.0 - density * 2);
}

/**
 * Calculate reliability factor from success rate
 */
export function calculateReliabilityFactor(
  successRate: number,
  config: ReliabilityConfig = DEFAULT_RELIABILITY_CONFIG
): number {
  if (successRate < config.penaltyThreshold) {
    return config.penaltyFactor;
  } else if (successRate > config.boostThreshold) {
    return config.boostFactor;
  }
  return 1.0;
}

/**
 * Compute unified score with full breakdown
 *
 * Formula: score = (semantic × α + graph × (1-α)) × reliability
 */
export function computeUnifiedScore(
  semanticScore: number,
  graphScore: number,
  alpha: number,
  reliabilityFactor: number,
  transitiveReliability: number = 1.0
): ScoreBreakdown {
  const hybridBeforeReliability = alpha * semanticScore + (1 - alpha) * graphScore;
  const combinedReliability = reliabilityFactor * transitiveReliability;
  const final = Math.min(hybridBeforeReliability * combinedReliability, GLOBAL_SCORE_CAP);

  return {
    semantic: semanticScore,
    graph: graphScore,
    alpha,
    hybridBeforeReliability,
    reliabilityFactor,
    transitiveReliability,
    final,
  };
}

/**
 * Unified search across tools and capabilities
 *
 * Process:
 * 1. Semantic search for candidates
 * 2. Calculate adaptive alpha from graph density
 * 3. For each candidate:
 *    a. Compute graph relatedness (Adamic-Adar)
 *    b. Get reliability factor from success rate
 *    c. Apply transitive reliability if available
 *    d. Combine: (semantic × α + graph × (1-α)) × reliability
 * 4. Sort by final score, return top N
 *
 * @param vectorSearch - Vector search interface
 * @param graph - Graph for relatedness computation
 * @param nodes - Map of node ID to SearchableNode
 * @param query - Natural language query
 * @param options - Search options
 * @returns Sorted array of unified search results
 */
export async function unifiedSearch(
  vectorSearch: UnifiedVectorSearch,
  graph: UnifiedSearchGraph,
  nodes: Map<string, SearchableNode>,
  query: string,
  options: UnifiedSearchOptions = {}
): Promise<UnifiedSearchResult[]> {
  const {
    limit = 10,
    minScore = 0.5,
    contextNodes = [],
    alpha: overrideAlpha,
    localAlphaCalculator,
    reliability = DEFAULT_RELIABILITY_CONFIG,
    getTransitiveReliability,
  } = options;

  // 1. Semantic search with expansion for graph re-ranking
  const expansionMultiplier = 2.0;
  const searchLimit = Math.ceil(limit * expansionMultiplier);
  const semanticResults = await vectorSearch.search(query, searchLimit, minScore);

  if (semanticResults.length === 0) {
    return [];
  }

  // 2. Calculate global alpha as fallback (used if no localAlphaCalculator and no override)
  const globalAlpha = overrideAlpha ?? calculateAdaptiveAlpha(graph);

  // 3. Score each candidate
  const results: UnifiedSearchResult[] = [];

  for (const { nodeId, score: semanticScore } of semanticResults) {
    const node = nodes.get(nodeId);
    if (!node) continue;

    // Graph relatedness (Adamic-Adar based)
    const graphScore = computeGraphRelatedness(graph, nodeId, contextNodes);

    // Reliability factor from success rate
    const reliabilityFactor = calculateReliabilityFactor(node.successRate, reliability);

    // Transitive reliability (for capabilities with dependencies)
    let transitiveReliability = 1.0;
    if (getTransitiveReliability) {
      transitiveReliability = await getTransitiveReliability(nodeId);
    }

    // ADR-048: Use local alpha per node if LocalAlphaCalculator is available
    let nodeAlpha = globalAlpha;
    if (overrideAlpha === undefined && localAlphaCalculator) {
      // Map UnifiedNodeType to NodeType for LocalAlphaCalculator
      const nodeType: NodeType = node.type === "tool" ? "tool" : "capability";
      nodeAlpha = localAlphaCalculator.getLocalAlpha("active", nodeId, nodeType, contextNodes);
    }

    // Compute unified score
    const breakdown = computeUnifiedScore(
      semanticScore,
      graphScore,
      nodeAlpha,
      reliabilityFactor,
      transitiveReliability
    );

    results.push({
      nodeId,
      nodeType: node.type,
      name: node.name,
      description: node.description,
      semanticScore: Math.round(semanticScore * 100) / 100,
      graphScore: Math.round(graphScore * 100) / 100,
      reliabilityFactor: Math.round(breakdown.reliabilityFactor * breakdown.transitiveReliability * 100) / 100,
      alpha: Math.round(nodeAlpha * 100) / 100,
      finalScore: Math.round(breakdown.final * 100) / 100,
      serverId: node.serverId,
    });
  }

  // 4. Sort by final score and limit
  results.sort((a, b) => b.finalScore - a.finalScore);
  return results.slice(0, limit);
}

/**
 * Create a simple in-memory vector search for testing
 */
export function createMockVectorSearch(
  nodes: Map<string, SearchableNode>
): UnifiedVectorSearch {
  return {
    async search(query: string, limit: number, minScore: number) {
      // Simple keyword matching for POC
      const queryLower = query.toLowerCase();
      const results: Array<{ nodeId: string; score: number }> = [];

      for (const [nodeId, node] of nodes) {
        const text = `${node.name} ${node.description}`.toLowerCase();

        // Calculate simple overlap score
        const queryWords = queryLower.split(/\s+/);
        const matchingWords = queryWords.filter(w => text.includes(w));
        const score = matchingWords.length / queryWords.length;

        if (score >= minScore) {
          results.push({ nodeId, score });
        }
      }

      results.sort((a, b) => b.score - a.score);
      return results.slice(0, limit);
    },
  };
}

/**
 * Create a mock graph for testing
 */
export function createMockGraph(
  edges: Array<{ from: string; to: string; weight?: number }>
): UnifiedSearchGraph {
  const adjacency = new Map<string, Set<string>>();
  const reverseAdjacency = new Map<string, Set<string>>();
  const edgeWeights = new Map<string, number>();
  const allNodes = new Set<string>();

  for (const { from, to, weight = 1.0 } of edges) {
    allNodes.add(from);
    allNodes.add(to);

    if (!adjacency.has(from)) adjacency.set(from, new Set());
    adjacency.get(from)!.add(to);

    if (!reverseAdjacency.has(to)) reverseAdjacency.set(to, new Set());
    reverseAdjacency.get(to)!.add(from);

    edgeWeights.set(`${from}:${to}`, weight);
  }

  return {
    order: allNodes.size,
    size: edges.length,
    hasNode: (nodeId: string) => allNodes.has(nodeId),
    hasEdge: (source: string, target: string) =>
      adjacency.get(source)?.has(target) || false,
    neighbors: (nodeId: string) => [
      ...(adjacency.get(nodeId) || []),
      ...(reverseAdjacency.get(nodeId) || []),
    ],
    inNeighbors: (nodeId: string) => [...(reverseAdjacency.get(nodeId) || [])],
    outNeighbors: (nodeId: string) => [...(adjacency.get(nodeId) || [])],
    degree: (nodeId: string) =>
      (adjacency.get(nodeId)?.size || 0) + (reverseAdjacency.get(nodeId)?.size || 0),
    getEdgeAttributes: (source: string, target: string) => ({
      weight: edgeWeights.get(`${source}:${target}`) || 0,
    }),
    // ADR-048: Additional methods for LocalAlphaCalculator compatibility
    getEdgeAttribute: (source: string, target: string, name: string) => {
      if (name === "weight") return edgeWeights.get(`${source}:${target}`);
      return undefined;
    },
    forEachNode: (callback: (node: string) => void) => {
      for (const node of allNodes) callback(node);
    },
  };
}
