/**
 * DR-DSP (Directed Relationship Dynamic Shortest Path)
 *
 * POC implementation of shortest hyperpath algorithm for directed hypergraphs.
 * Based on Gallo et al. (1993) B-visit algorithm + dynamic extensions from
 * Ausiello et al. (2012) DR-DSP.
 *
 * Key concepts:
 * - Hyperedge: Connects multiple source nodes to multiple target nodes
 * - Hyperpath: Sequence of hyperedges where consecutive ones share at least one node
 * - B-arc (backward arc): (head, tail_set) where head is the target, tail_set are sources
 *
 * Complexity:
 * - General hypergraph: NP-hard
 * - DAG (acyclic): O(|V| + |E| × max_tail_size) - polynomial!
 *
 * @module graphrag/algorithms/dr-dsp
 */

import { getLogger } from "../../telemetry/logger.ts";

const _log = getLogger("default");
void _log; // Mark as intentionally unused for now

// ============================================================================
// Types
// ============================================================================

/**
 * A hyperedge connecting multiple sources to multiple targets
 * In our case: a capability connecting its tools
 */
export interface Hyperedge {
  id: string;
  /** Source nodes (prerequisites) */
  sources: string[];
  /** Target nodes (what this edge provides) */
  targets: string[];
  /** Weight/cost of traversing this hyperedge */
  weight: number;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Result of a hyperpath search
 */
export interface HyperpathResult {
  /** Sequence of hyperedge IDs forming the path */
  path: string[];
  /** Full hyperedge objects in order */
  hyperedges: Hyperedge[];
  /** Total path weight (sum of hyperedge weights) */
  totalWeight: number;
  /** Sequence of nodes visited */
  nodeSequence: string[];
  /** Whether a valid path was found */
  found: boolean;
}

/**
 * B-tree node for backward traversal
 */
interface BTreeNode {
  nodeId: string;
  distance: number;
  /** Hyperedge that leads to this node */
  viaHyperedge: string | null;
  /** Parent nodes in the B-tree */
  parents: string[];
}

/**
 * Dynamic update for incremental path computation
 */
export interface DynamicUpdate {
  type: "weight_increase" | "weight_decrease" | "edge_add" | "edge_remove";
  hyperedgeId: string;
  newWeight?: number;
  newEdge?: Hyperedge;
}

// ============================================================================
// DR-DSP Implementation
// ============================================================================

/**
 * DR-DSP Algorithm
 *
 * Finds shortest hyperpaths in directed hypergraphs.
 * Optimized for DAGs (our capability structure).
 */
export class DRDSP {
  private hyperedges: Map<string, Hyperedge> = new Map();
  private nodeToIncomingEdges: Map<string, Set<string>> = new Map();
  private nodeToOutgoingEdges: Map<string, Set<string>> = new Map();

  // B-tree for shortest path tracking
  private bTree: Map<string, BTreeNode> = new Map();

  constructor(hyperedges: Hyperedge[] = []) {
    for (const edge of hyperedges) {
      this.addHyperedge(edge);
    }
  }

  /**
   * Add a hyperedge to the graph
   */
  addHyperedge(edge: Hyperedge): void {
    this.hyperedges.set(edge.id, edge);

    // Index by target nodes (incoming)
    for (const target of edge.targets) {
      if (!this.nodeToIncomingEdges.has(target)) {
        this.nodeToIncomingEdges.set(target, new Set());
      }
      this.nodeToIncomingEdges.get(target)!.add(edge.id);
    }

    // Index by source nodes (outgoing)
    for (const source of edge.sources) {
      if (!this.nodeToOutgoingEdges.has(source)) {
        this.nodeToOutgoingEdges.set(source, new Set());
      }
      this.nodeToOutgoingEdges.get(source)!.add(edge.id);
    }
  }

  /**
   * Remove a hyperedge from the graph
   */
  removeHyperedge(edgeId: string): void {
    const edge = this.hyperedges.get(edgeId);
    if (!edge) return;

    // Remove from indices
    for (const target of edge.targets) {
      this.nodeToIncomingEdges.get(target)?.delete(edgeId);
    }
    for (const source of edge.sources) {
      this.nodeToOutgoingEdges.get(source)?.delete(edgeId);
    }

    this.hyperedges.delete(edgeId);
  }

  /**
   * Find shortest hyperpath from source to target
   *
   * Uses B-visit algorithm (backward traversal from target)
   */
  findShortestHyperpath(source: string, target: string): HyperpathResult {
    // Reset B-tree
    this.bTree.clear();

    // Initialize target with distance 0
    this.bTree.set(target, {
      nodeId: target,
      distance: 0,
      viaHyperedge: null,
      parents: [],
    });

    // Priority queue for Dijkstra-like processing (min-heap by distance)
    const queue: Array<{ nodeId: string; distance: number }> = [{ nodeId: target, distance: 0 }];
    const visited = new Set<string>();

    while (queue.length > 0) {
      // Extract min
      queue.sort((a, b) => a.distance - b.distance);
      const current = queue.shift()!;

      if (visited.has(current.nodeId)) continue;
      visited.add(current.nodeId);

      // Check if we reached the source
      if (current.nodeId === source) {
        return this.reconstructPath(source, target);
      }

      // Get incoming hyperedges (edges where this node is a target)
      const incomingEdges = this.nodeToIncomingEdges.get(current.nodeId) || new Set();

      for (const edgeId of incomingEdges) {
        const edge = this.hyperedges.get(edgeId)!;

        // For B-visit: we need ALL sources of this edge to be reachable
        // In DAG case, we can relax this to "at least one source"
        const newDistance = current.distance + edge.weight;

        // Update all source nodes
        for (const sourceNode of edge.sources) {
          const existing = this.bTree.get(sourceNode);

          if (!existing || newDistance < existing.distance) {
            this.bTree.set(sourceNode, {
              nodeId: sourceNode,
              distance: newDistance,
              viaHyperedge: edgeId,
              parents: edge.targets,
            });

            if (!visited.has(sourceNode)) {
              queue.push({ nodeId: sourceNode, distance: newDistance });
            }
          }
        }
      }
    }

    // No path found
    return {
      path: [],
      hyperedges: [],
      totalWeight: Infinity,
      nodeSequence: [],
      found: false,
    };
  }

  /**
   * Reconstruct the path from B-tree
   */
  private reconstructPath(source: string, target: string): HyperpathResult {
    const path: string[] = [];
    const hyperedges: Hyperedge[] = [];
    const nodeSequence: string[] = [source];

    let current = source;
    const visited = new Set<string>();

    while (current !== target && !visited.has(current)) {
      visited.add(current);
      const node = this.bTree.get(current);

      if (!node || !node.viaHyperedge) {
        // Check if we can reach target directly
        if (current === target) break;

        // Try to find path through parents
        const outgoing = this.nodeToOutgoingEdges.get(current);
        if (outgoing) {
          for (const edgeId of outgoing) {
            const edge = this.hyperedges.get(edgeId)!;
            // Check if any target is closer to destination
            for (const t of edge.targets) {
              const tNode = this.bTree.get(t);
              if (tNode && tNode.distance < (this.bTree.get(current)?.distance ?? Infinity)) {
                path.push(edgeId);
                hyperedges.push(edge);
                nodeSequence.push(t);
                current = t;
                break;
              }
            }
            if (current !== node?.nodeId) break;
          }
        }
        if (current === node?.nodeId) break;
      } else {
        path.push(node.viaHyperedge);
        const edge = this.hyperedges.get(node.viaHyperedge)!;
        hyperedges.push(edge);

        // Move to one of the targets (preferring the one closer to destination)
        let nextNode = node.parents[0];
        let minDist = Infinity;
        for (const parent of node.parents) {
          const pNode = this.bTree.get(parent);
          if (pNode && pNode.distance < minDist) {
            minDist = pNode.distance;
            nextNode = parent;
          }
        }
        nodeSequence.push(nextNode);
        current = nextNode;
      }
    }

    const totalWeight = hyperedges.reduce((sum, e) => sum + e.weight, 0);

    return {
      path,
      hyperedges,
      totalWeight,
      nodeSequence,
      found: current === target || nodeSequence.includes(target),
    };
  }

  /**
   * Dynamic update: handle weight change or edge modification
   *
   * DR-DSP is optimized for updates that affect shortest paths.
   * Instead of recomputing from scratch, we update incrementally.
   */
  applyUpdate(update: DynamicUpdate): void {
    switch (update.type) {
      case "weight_increase":
      case "weight_decrease": {
        const edge = this.hyperedges.get(update.hyperedgeId);
        if (edge && update.newWeight !== undefined) {
          edge.weight = update.newWeight;
        }
        break;
      }
      case "edge_add": {
        if (update.newEdge) {
          this.addHyperedge(update.newEdge);
        }
        break;
      }
      case "edge_remove": {
        this.removeHyperedge(update.hyperedgeId);
        break;
      }
    }

    // Note: In a full implementation, we would incrementally update
    // the B-tree rather than requiring a full recomputation.
    // For POC, we clear the cached tree.
    this.bTree.clear();
  }

  /**
   * Find all shortest hyperpaths from source to all reachable nodes
   * (SSSP - Single Source Shortest Path)
   */
  findAllShortestPaths(source: string): Map<string, HyperpathResult> {
    const results = new Map<string, HyperpathResult>();
    const allNodes = new Set<string>();

    // Collect all nodes
    for (const edge of this.hyperedges.values()) {
      for (const node of [...edge.sources, ...edge.targets]) {
        allNodes.add(node);
      }
    }

    // Find path to each node
    for (const target of allNodes) {
      if (target !== source) {
        const result = this.findShortestHyperpath(source, target);
        if (result.found) {
          results.set(target, result);
        }
      }
    }

    return results;
  }

  /**
   * Get graph statistics
   */
  getStats(): {
    hyperedgeCount: number;
    nodeCount: number;
    avgHyperedgeSize: number;
  } {
    const nodes = new Set<string>();
    let totalSize = 0;

    for (const edge of this.hyperedges.values()) {
      for (const node of [...edge.sources, ...edge.targets]) {
        nodes.add(node);
      }
      totalSize += edge.sources.length + edge.targets.length;
    }

    return {
      hyperedgeCount: this.hyperedges.size,
      nodeCount: nodes.size,
      avgHyperedgeSize: this.hyperedges.size > 0 ? totalSize / this.hyperedges.size : 0,
    };
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Convert capability data to hyperedges
 *
 * A capability is a hyperedge where:
 * - sources = prerequisite tools (from provides edges)
 * - targets = tools that this capability enables
 */
export function capabilityToHyperedge(
  capabilityId: string,
  toolsUsed: string[],
  staticEdges?: Array<{ from: string; to: string; type: string }>,
  successRate: number = 1.0,
): Hyperedge {
  // If we have static structure, use provides edges
  if (staticEdges && staticEdges.length > 0) {
    const providesEdges = staticEdges.filter((e) => e.type === "provides");
    const sources = new Set<string>();
    const targets = new Set<string>();

    for (const edge of providesEdges) {
      sources.add(edge.from);
      targets.add(edge.to);
    }

    // If no provides edges, treat all tools as both sources and targets
    if (sources.size === 0) {
      return {
        id: capabilityId,
        sources: toolsUsed.slice(0, Math.ceil(toolsUsed.length / 2)),
        targets: toolsUsed.slice(Math.ceil(toolsUsed.length / 2)),
        weight: 1 / successRate, // Lower weight = better
      };
    }

    return {
      id: capabilityId,
      sources: Array.from(sources),
      targets: Array.from(targets),
      weight: 1 / successRate,
    };
  }

  // Default: first half are sources, second half are targets
  const mid = Math.ceil(toolsUsed.length / 2);
  return {
    id: capabilityId,
    sources: toolsUsed.slice(0, mid),
    targets: toolsUsed.slice(mid),
    weight: 1 / successRate,
  };
}

/**
 * Build DR-DSP from capability store data
 */
export function buildDRDSPFromCapabilities(
  capabilities: Array<{
    id: string;
    toolsUsed: string[];
    staticEdges?: Array<{ from: string; to: string; type: string }>;
    successRate?: number;
  }>,
): DRDSP {
  const drdsp = new DRDSP();

  for (const cap of capabilities) {
    const hyperedge = capabilityToHyperedge(
      cap.id,
      cap.toolsUsed,
      cap.staticEdges,
      cap.successRate ?? 1.0,
    );
    drdsp.addHyperedge(hyperedge);
  }

  return drdsp;
}
