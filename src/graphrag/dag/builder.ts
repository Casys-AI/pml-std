/**
 * DAG Builder Module
 *
 * Constructs DAG structures from candidate tools using graph-based
 * path analysis and cycle breaking.
 *
 * @module graphrag/dag/builder
 */

import type { DAGStructure } from "../types.ts";
import { calculateAveragePathWeight, findShortestPath } from "../algorithms/pathfinding.ts";

/**
 * Graph interface for DAG building operations
 */
export interface DAGBuilderGraph {
  hasNode(nodeId: string): boolean;
  hasEdge(source: string, target: string): boolean;
  getEdgeAttributes(source: string, target: string): Record<string, unknown>;
  neighbors(nodeId: string): string[];
  inNeighbors(nodeId: string): string[];
  outNeighbors(nodeId: string): string[];
}

/**
 * Build a DAG structure from candidate tools
 *
 * Process:
 * 1. For each pair of tools, find shortest path in the knowledge graph
 * 2. Create adjacency matrix based on path existence (max 4 hops)
 * 3. Weight edges by inverse path length * average edge weight
 * 4. Break cycles by keeping the higher-weighted edge
 * 5. Generate task list with dependencies
 *
 * @param graph - Graphology graph instance
 * @param candidateTools - Array of tool IDs to build DAG from
 * @returns DAG structure with tasks and dependencies
 */
export function buildDAG(graph: DAGBuilderGraph, candidateTools: string[]): DAGStructure {
  const n = candidateTools.length;
  const adjacency: boolean[][] = Array.from({ length: n }, () => Array(n).fill(false));
  const edgeWeights: number[][] = Array.from({ length: n }, () => Array(n).fill(0));

  // Build adjacency matrix from shortest paths
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const path = findShortestPath(graph, candidateTools[j], candidateTools[i]);
      if (path && path.length > 0 && path.length <= 4) {
        adjacency[i][j] = true;
        const avgWeight = calculateAveragePathWeight(graph, path);
        edgeWeights[i][j] = (1.0 / path.length) * avgWeight;
      }
    }
  }

  // Break cycles by removing lower-weighted edge
  breakCycles(adjacency, edgeWeights, n);

  // Generate tasks with dependencies
  const tasks = candidateTools.map((toolId, i) => {
    const dependsOn: string[] = [];
    for (let j = 0; j < n; j++) {
      if (adjacency[i][j]) dependsOn.push(`task_${j}`);
    }
    return { id: `task_${i}`, tool: toolId, arguments: {}, dependsOn };
  });

  return { tasks };
}

/**
 * Break cycles in adjacency matrix by removing lower-weighted edges
 *
 * For each bidirectional edge pair (i→j and j→i), keeps only
 * the edge with higher weight.
 *
 * @param adjacency - Mutable adjacency matrix
 * @param edgeWeights - Edge weight matrix
 * @param n - Number of nodes
 */
function breakCycles(
  adjacency: boolean[][],
  edgeWeights: number[][],
  n: number,
): void {
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (adjacency[i][j] && adjacency[j][i]) {
        if (edgeWeights[i][j] >= edgeWeights[j][i]) {
          adjacency[j][i] = false;
        } else {
          adjacency[i][j] = false;
        }
      }
    }
  }
}

/**
 * Validate DAG structure has no cycles
 *
 * Uses topological sort attempt to detect cycles.
 *
 * @param dag - DAG structure to validate
 * @returns True if valid DAG (no cycles), false otherwise
 */
export function validateDAG(dag: DAGStructure): boolean {
  const taskMap = new Map(dag.tasks.map((t) => [t.id, t]));
  const visited = new Set<string>();
  const recStack = new Set<string>();

  function hasCycle(taskId: string): boolean {
    if (recStack.has(taskId)) return true;
    if (visited.has(taskId)) return false;

    visited.add(taskId);
    recStack.add(taskId);

    const task = taskMap.get(taskId);
    if (task) {
      for (const depId of task.dependsOn) {
        if (hasCycle(depId)) return true;
      }
    }

    recStack.delete(taskId);
    return false;
  }

  for (const task of dag.tasks) {
    if (hasCycle(task.id)) return false;
  }

  return true;
}
