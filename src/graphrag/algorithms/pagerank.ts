/**
 * PageRank Algorithm Module
 *
 * Computes PageRank scores for graph nodes using Graphology's native implementation.
 * Provides centrality metrics for tool importance ranking.
 *
 * @module graphrag/algorithms/pagerank
 */

// @ts-ignore: NPM module resolution
import pagerankPkg from "graphology-metrics/centrality/pagerank.js";
import * as log from "@std/log";

const pagerank = pagerankPkg as any;

/**
 * PageRank computation options
 */
export interface PageRankOptions {
  /** Use edge weights in computation */
  weighted?: boolean;
  /** Convergence tolerance (default: 0.0001) */
  tolerance?: number;
}

/**
 * PageRank computation result
 */
export interface PageRankResult {
  /** PageRank scores keyed by node ID */
  scores: Record<string, number>;
  /** Computation time in milliseconds */
  computeTimeMs: number;
}

/**
 * Compute PageRank scores for all nodes in the graph
 *
 * Uses power iteration method with configurable convergence tolerance.
 * Weighted mode considers edge weights in the random walk probability.
 *
 * @param graph - Graphology graph instance
 * @param options - PageRank computation options
 * @returns PageRank scores for all nodes
 */
export function computePageRank(
  graph: unknown,
  options: PageRankOptions = {},
): PageRankResult {
  const startTime = performance.now();

  const scores = pagerank(graph, {
    weighted: options.weighted ?? true,
    tolerance: options.tolerance ?? 0.0001,
  });

  const computeTimeMs = performance.now() - startTime;
  log.debug(
    `[PageRank] Computed scores for ${Object.keys(scores).length} nodes (${
      computeTimeMs.toFixed(1)
    }ms)`,
  );

  return { scores, computeTimeMs };
}

/**
 * Get PageRank score for a specific node
 *
 * @param scores - Pre-computed PageRank scores
 * @param nodeId - Node identifier
 * @returns PageRank score (0-1) or 0 if node not found
 */
export function getPageRankScore(
  scores: Record<string, number>,
  nodeId: string,
): number {
  return scores[nodeId] || 0;
}

/**
 * Get top N nodes by PageRank score
 *
 * @param scores - Pre-computed PageRank scores
 * @param n - Number of top nodes to return
 * @returns Array of nodes sorted by PageRank (descending)
 */
export function getTopPageRankNodes(
  scores: Record<string, number>,
  n: number,
): Array<{ toolId: string; score: number }> {
  return Object.entries(scores)
    .map(([toolId, score]) => ({ toolId, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, n);
}

/**
 * Compute average PageRank score across all nodes
 *
 * @param scores - Pre-computed PageRank scores
 * @returns Average PageRank score
 */
export function getAveragePageRank(scores: Record<string, number>): number {
  const values = Object.values(scores);
  if (values.length === 0) return 0;
  return values.reduce((sum, score) => sum + score, 0) / values.length;
}
