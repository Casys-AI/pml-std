/**
 * Adamic-Adar Similarity Algorithm Module
 *
 * Computes similarity between nodes based on shared neighbors,
 * weighted by neighbor rarity (inverse log of degree).
 *
 * ADR-041: Now weighted by edge type and source for more accurate similarity.
 *
 * @module graphrag/algorithms/adamic-adar
 */

import { type EdgeSource, type EdgeType, getEdgeWeight } from "./edge-weights.ts";

/**
 * Graph interface for Adamic-Adar operations
 */
export interface AdamicAdarGraph {
  hasNode(nodeId: string): boolean;
  hasEdge(source: string, target: string): boolean;
  neighbors(nodeId: string): string[];
  degree(nodeId: string): number;
  getEdgeAttributes(source: string, target: string): Record<string, unknown>;
}

/**
 * Adamic-Adar similarity result
 */
export interface AdamicAdarResult {
  toolId: string;
  score: number;
}

/**
 * Compute Adamic-Adar similarity for a node
 *
 * Finds nodes that share common neighbors, weighted by:
 * 1. Neighbor rarity (1/log(degree)) - rare neighbors are more informative
 * 2. Edge quality (ADR-041: type × source modifier)
 *
 * Formula: AA(u,v) = Σ (edge_weight × 1/log(|N(w)|)) for all w in N(u) ∩ N(v)
 *
 * @param graph - Graphology graph instance
 * @param nodeId - Node to find similar nodes for
 * @param limit - Maximum number of results (default: 10)
 * @returns Array of similar nodes sorted by Adamic-Adar score
 */
export function computeAdamicAdar(
  graph: unknown,
  nodeId: string,
  limit: number = 10,
): AdamicAdarResult[] {
  const g = graph as AdamicAdarGraph;

  if (!g.hasNode(nodeId)) return [];

  const neighbors = new Set(g.neighbors(nodeId));
  const scores = new Map<string, number>();

  for (const neighbor of neighbors) {
    const degree = g.degree(neighbor);
    if (degree <= 1) continue;

    // ADR-041: Get edge weight from nodeId → neighbor
    let edgeWeight = 0.5; // default
    if (g.hasEdge(nodeId, neighbor)) {
      const attrs = g.getEdgeAttributes(nodeId, neighbor);
      edgeWeight = getEdgeWeight(
        (attrs.edge_type as EdgeType) || "sequence",
        (attrs.edge_source as EdgeSource) || "inferred",
      );
    } else if (g.hasEdge(neighbor, nodeId)) {
      const attrs = g.getEdgeAttributes(neighbor, nodeId);
      edgeWeight = getEdgeWeight(
        (attrs.edge_type as EdgeType) || "sequence",
        (attrs.edge_source as EdgeSource) || "inferred",
      );
    }

    // Find two-hop neighbors and accumulate scores
    for (const twoHop of g.neighbors(neighbor)) {
      if (twoHop === nodeId) continue;
      // ADR-041: Weight the AA contribution by edge quality
      const aaContribution = edgeWeight / Math.log(degree);
      scores.set(twoHop, (scores.get(twoHop) || 0) + aaContribution);
    }
  }

  return [...scores.entries()]
    .map(([id, score]) => ({ toolId: id, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Compute Adamic-Adar score between two specific nodes
 *
 * @param graph - Graphology graph instance
 * @param nodeId1 - First node
 * @param nodeId2 - Second node
 * @returns Adamic-Adar score (0 if no common neighbors)
 */
export function adamicAdarBetween(
  graph: unknown,
  nodeId1: string,
  nodeId2: string,
): number {
  const g = graph as AdamicAdarGraph;

  if (!g.hasNode(nodeId1) || !g.hasNode(nodeId2)) return 0;

  const neighbors1 = new Set(g.neighbors(nodeId1));
  const neighbors2 = new Set(g.neighbors(nodeId2));

  let score = 0;
  for (const neighbor of neighbors1) {
    if (neighbors2.has(neighbor)) {
      const degree = g.degree(neighbor);
      if (degree > 1) {
        score += 1 / Math.log(degree);
      }
    }
  }

  return score;
}

/**
 * Compute graph relatedness of a node to context nodes
 *
 * Returns highest relatedness score:
 * - Direct edge = 1.0 (maximum)
 * - Otherwise uses Adamic-Adar, normalized to 0-1
 *
 * @param graph - Graphology graph instance
 * @param nodeId - Node to evaluate
 * @param contextNodes - Nodes already in context
 * @returns Normalized relatedness score (0-1)
 */
export function computeGraphRelatedness(
  graph: unknown,
  nodeId: string,
  contextNodes: string[],
): number {
  const g = graph as AdamicAdarGraph;

  if (contextNodes.length === 0 || !g.hasNode(nodeId)) return 0;

  let maxScore = 0;
  for (const contextNode of contextNodes) {
    if (!g.hasNode(contextNode)) continue;

    // Direct neighbor = max score
    if (g.hasEdge(contextNode, nodeId) || g.hasEdge(nodeId, contextNode)) {
      return 1.0;
    }

    // Adamic-Adar score
    const aaScore = adamicAdarBetween(graph, nodeId, contextNode);
    maxScore = Math.max(maxScore, aaScore);
  }

  // Normalize (typical AA scores are 0-5, cap at 1.0)
  return Math.min(maxScore / 2, 1.0);
}

/**
 * Get all neighbors of a node by direction
 *
 * @param graph - Graphology graph instance
 * @param nodeId - Node identifier
 * @param direction - 'in' (predecessors), 'out' (successors), 'both'
 * @returns Array of neighbor node IDs
 */
export function getNeighbors(
  graph: unknown,
  nodeId: string,
  direction: "in" | "out" | "both" = "both",
): string[] {
  const g = graph as AdamicAdarGraph & {
    inNeighbors(nodeId: string): string[];
    outNeighbors(nodeId: string): string[];
  };

  if (!g.hasNode(nodeId)) return [];

  switch (direction) {
    case "in":
      return g.inNeighbors(nodeId);
    case "out":
      return g.outNeighbors(nodeId);
    case "both":
      return g.neighbors(nodeId);
  }
}

/**
 * Find nodes with highest similarity to a set of nodes
 *
 * Useful for finding tools related to a workflow context.
 *
 * @param graph - Graphology graph instance
 * @param contextNodes - Nodes to find similar nodes for
 * @param limit - Maximum number of results
 * @param excludeContext - Exclude context nodes from results (default: true)
 * @returns Array of similar nodes with aggregated scores
 */
export function findSimilarNodes(
  graph: unknown,
  contextNodes: string[],
  limit: number = 10,
  excludeContext: boolean = true,
): AdamicAdarResult[] {
  const aggregatedScores = new Map<string, number>();
  const contextSet = new Set(contextNodes);

  for (const contextNode of contextNodes) {
    const similar = computeAdamicAdar(graph, contextNode, limit * 2);
    for (const { toolId, score } of similar) {
      if (excludeContext && contextSet.has(toolId)) continue;
      aggregatedScores.set(toolId, (aggregatedScores.get(toolId) || 0) + score);
    }
  }

  return [...aggregatedScores.entries()]
    .map(([toolId, score]) => ({ toolId, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
