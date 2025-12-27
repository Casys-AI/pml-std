/**
 * Path Finding Algorithm Module
 *
 * Implements shortest path algorithms for dependency analysis.
 * Uses Dijkstra's algorithm with edge weight inversion for optimal paths.
 *
 * ADR-041: Uses weighted edges where higher weight = lower cost = preferred path
 *
 * @module graphrag/algorithms/pathfinding
 */

// @ts-ignore: NPM module resolution
import { dijkstra } from "graphology-shortest-path";
import { type EdgeSource, type EdgeType, getEdgeWeight } from "./edge-weights.ts";

/**
 * Graph interface for pathfinding operations
 */
export interface PathfindingGraph {
  hasNode(nodeId: string): boolean;
  hasEdge(source: string, target: string): boolean;
  getEdgeAttribute(edge: string, attr: string): unknown;
  getEdgeAttributes(source: string, target: string): Record<string, unknown>;
}

/**
 * Find shortest path between two nodes
 *
 * Uses Dijkstra's bidirectional search with weight-to-cost conversion.
 * Higher edge weight = lower cost = preferred path.
 *
 * ADR-041: Edge weight considers both type and source:
 * cost = 1 / (type_weight × source_modifier)
 *
 * @param graph - Graphology graph instance
 * @param fromNodeId - Source node
 * @param toNodeId - Target node
 * @returns Array of node IDs representing the path, or null if no path exists
 */
export function findShortestPath(
  graph: unknown,
  fromNodeId: string,
  toNodeId: string,
): string[] | null {
  try {
    const g = graph as PathfindingGraph;

    if (!g.hasNode(fromNodeId) || !g.hasNode(toNodeId)) {
      return null;
    }

    return dijkstra.bidirectional(
      graph as any,
      fromNodeId,
      toNodeId,
      (edge: string) => {
        const weight = g.getEdgeAttribute(edge, "weight") as number || 0.5;
        // Invert weight to cost (min 0.1 to avoid division issues)
        return 1 / Math.max(weight, 0.1);
      },
    );
  } catch {
    return null; // No path exists
  }
}

/**
 * Find all paths between two nodes up to a maximum length
 *
 * @param graph - Graphology graph instance
 * @param fromNodeId - Source node
 * @param toNodeId - Target node
 * @param maxLength - Maximum path length (default: 4)
 * @returns Array of paths (each path is an array of node IDs)
 */
export function findAllPaths(
  graph: unknown,
  fromNodeId: string,
  toNodeId: string,
  maxLength: number = 4,
): string[][] {
  const g = graph as PathfindingGraph & {
    outNeighbors(nodeId: string): string[];
  };

  if (!g.hasNode(fromNodeId) || !g.hasNode(toNodeId)) {
    return [];
  }

  const paths: string[][] = [];
  const visited = new Set<string>();

  function dfs(current: string, path: string[]): void {
    if (path.length > maxLength) return;

    if (current === toNodeId) {
      paths.push([...path]);
      return;
    }

    visited.add(current);

    for (const neighbor of g.outNeighbors(current)) {
      if (!visited.has(neighbor)) {
        path.push(neighbor);
        dfs(neighbor, path);
        path.pop();
      }
    }

    visited.delete(current);
  }

  dfs(fromNodeId, [fromNodeId]);
  return paths;
}

/**
 * Calculate path weight (total cost along path)
 *
 * ADR-041: Uses combined edge weights (type × source modifier)
 *
 * @param graph - Graphology graph instance
 * @param path - Array of node IDs
 * @returns Total path weight (sum of edge weights)
 */
export function calculatePathWeight(
  graph: unknown,
  path: string[],
): number {
  if (path.length < 2) return 0;

  const g = graph as PathfindingGraph;
  let totalWeight = 0;

  for (let i = 0; i < path.length - 1; i++) {
    const from = path[i];
    const to = path[i + 1];

    if (g.hasEdge(from, to)) {
      const attrs = g.getEdgeAttributes(from, to);
      const edgeType = (attrs.edge_type as EdgeType) || "sequence";
      const edgeSource = (attrs.edge_source as EdgeSource) || "inferred";
      totalWeight += getEdgeWeight(edgeType, edgeSource);
    }
  }

  return totalWeight;
}

/**
 * Calculate average edge weight along a path
 *
 * @param graph - Graphology graph instance
 * @param path - Array of node IDs
 * @returns Average edge weight (0 if no edges)
 */
export function calculateAveragePathWeight(
  graph: unknown,
  path: string[],
): number {
  if (path.length < 2) return 0;

  const totalWeight = calculatePathWeight(graph, path);
  const edgeCount = path.length - 1;

  return edgeCount > 0 ? totalWeight / edgeCount : 0;
}

/**
 * Check if a path exists between two nodes within a maximum hop count
 *
 * @param graph - Graphology graph instance
 * @param fromNodeId - Source node
 * @param toNodeId - Target node
 * @param maxHops - Maximum number of hops allowed
 * @returns true if a path exists within the hop limit
 */
export function hasPathWithinHops(
  graph: unknown,
  fromNodeId: string,
  toNodeId: string,
  maxHops: number,
): boolean {
  const path = findShortestPath(graph, fromNodeId, toNodeId);
  return path !== null && path.length <= maxHops + 1;
}

/**
 * Get path length (number of hops)
 *
 * @param path - Array of node IDs
 * @returns Number of hops (edges) in the path
 */
export function getPathLength(path: string[] | null): number {
  if (!path || path.length < 2) return 0;
  return path.length - 1;
}
