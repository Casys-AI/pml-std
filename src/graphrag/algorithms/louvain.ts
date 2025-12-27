/**
 * Louvain Community Detection Module
 *
 * Detects communities in the graph using the Louvain algorithm.
 * Communities represent groups of tools that are frequently used together.
 *
 * @module graphrag/algorithms/louvain
 */

// @ts-ignore: NPM module resolution
import louvainPkg from "graphology-communities-louvain";
import * as log from "@std/log";

const louvain = louvainPkg as any;

/**
 * Louvain community detection options
 */
export interface LouvainOptions {
  /** Resolution parameter (default: 1.0). Higher = more communities */
  resolution?: number;
}

/**
 * Community detection result
 */
export interface LouvainResult {
  /** Community assignments keyed by node ID */
  communities: Record<string, string>;
  /** Number of communities detected */
  communityCount: number;
  /** Computation time in milliseconds */
  computeTimeMs: number;
}

/**
 * Detect communities using Louvain algorithm
 *
 * The Louvain algorithm optimizes modularity to find natural groupings.
 * Tools in the same community are often used together in workflows.
 *
 * @param graph - Graphology graph instance
 * @param options - Louvain detection options
 * @returns Community assignments for all nodes
 */
export function detectCommunities(
  graph: unknown,
  options: LouvainOptions = {},
): LouvainResult {
  const startTime = performance.now();

  const communities = louvain(graph, {
    resolution: options.resolution ?? 1.0,
  });

  const communityCount = new Set(Object.values(communities)).size;
  const computeTimeMs = performance.now() - startTime;

  log.debug(
    `[Louvain] Detected ${communityCount} communities for ${
      Object.keys(communities).length
    } nodes (${computeTimeMs.toFixed(1)}ms)`,
  );

  return { communities, communityCount, computeTimeMs };
}

/**
 * Get community ID for a specific node
 *
 * @param communities - Pre-computed community assignments
 * @param nodeId - Node identifier
 * @returns Community ID or undefined if node not found
 */
export function getNodeCommunity(
  communities: Record<string, string>,
  nodeId: string,
): string | undefined {
  return communities[nodeId];
}

/**
 * Find all nodes in the same community as a given node
 *
 * @param communities - Pre-computed community assignments
 * @param nodeId - Node identifier
 * @param excludeSelf - Exclude the input node from results (default: true)
 * @returns Array of node IDs in the same community
 */
export function findCommunityMembers(
  communities: Record<string, string>,
  nodeId: string,
  excludeSelf: boolean = true,
): string[] {
  const community = communities[nodeId];
  if (!community) return [];

  return Object.entries(communities)
    .filter(([id, comm]) => comm === community && (!excludeSelf || id !== nodeId))
    .map(([id]) => id);
}

/**
 * Get total number of unique communities
 *
 * @param communities - Pre-computed community assignments
 * @returns Number of distinct communities
 */
export function getCommunityCount(communities: Record<string, string>): number {
  return new Set(Object.values(communities)).size;
}

/**
 * Get community size distribution
 *
 * @param communities - Pre-computed community assignments
 * @returns Map of community ID to member count
 */
export function getCommunityDistribution(
  communities: Record<string, string>,
): Map<string, number> {
  const distribution = new Map<string, number>();

  for (const communityId of Object.values(communities)) {
    distribution.set(communityId, (distribution.get(communityId) || 0) + 1);
  }

  return distribution;
}

/**
 * Check if two nodes are in the same community
 *
 * @param communities - Pre-computed community assignments
 * @param nodeId1 - First node identifier
 * @param nodeId2 - Second node identifier
 * @returns true if both nodes are in the same community
 */
export function areInSameCommunity(
  communities: Record<string, string>,
  nodeId1: string,
  nodeId2: string,
): boolean {
  const comm1 = communities[nodeId1];
  const comm2 = communities[nodeId2];
  return comm1 !== undefined && comm1 === comm2;
}
