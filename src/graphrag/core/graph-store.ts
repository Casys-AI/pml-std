/**
 * Graph Store Module
 *
 * Wrapper around Graphology for graph data storage and manipulation.
 * Provides a clean interface for node/edge operations with type safety.
 *
 * @module graphrag/core/graph-store
 */

// @ts-ignore: NPM module resolution
import graphologyPkg from "graphology";
import { parseToolId } from "../search/autocomplete.ts";

const { DirectedGraph } = graphologyPkg as { DirectedGraph: new (options?: { allowSelfLoops?: boolean }) => GraphologyInstance };

/**
 * Graphology instance interface (partial)
 */
interface GraphologyInstance {
  clear(): void;
  addNode(nodeId: string, attributes?: Record<string, unknown>): void;
  addEdge(source: string, target: string, attributes?: Record<string, unknown>): void;
  hasNode(nodeId: string): boolean;
  hasEdge(source: string, target: string): boolean;
  getNodeAttribute(nodeId: string, attr: string): unknown;
  getNodeAttributes(nodeId: string): Record<string, unknown>;
  setNodeAttribute(nodeId: string, attr: string, value: unknown): void;
  getEdgeAttribute(edge: string, attr: string): unknown;
  getEdgeAttributes(source: string, target: string): Record<string, unknown>;
  setEdgeAttribute(source: string, target: string, attr: string, value: unknown): void;
  order: number;
  size: number;
  nodes(): string[];
  edges(): string[];
  extremities(edge: string): [string, string];
  source(edge: string): string;
  target(edge: string): string;
  neighbors(nodeId: string): string[];
  inNeighbors(nodeId: string): string[];
  outNeighbors(nodeId: string): string[];
  degree(nodeId: string): number;
  forEachNode(callback: (nodeId: string, attrs: Record<string, unknown>) => void): void;
  forEachEdge(callback: (edge: string, attrs: Record<string, unknown>, source: string, target: string) => void): void;
}

/**
 * Node attributes
 */
export interface NodeAttributes {
  type?: "tool" | "capability";
  name?: string;
  serverId?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown; // Index signature for Graphology compatibility
}

/**
 * Edge attributes (ADR-041, ADR-050, Story 10.3)
 *
 * Edge types per ADR-050:
 * - dependency: Explicit DAG dependency from templates (weight: 1.0)
 * - contains: Parent-child hierarchy (weight: 0.8)
 * - provides: Data flow - A's output feeds B's input (weight: 0.7) [Story 10.3]
 * - sequence: Temporal order between siblings (weight: 0.5)
 * - alternative: DEPRECATED - kept for backward compatibility with existing
 *   persisted data. New edges should use "provides" for data flow relationships.
 */
export interface EdgeAttributes {
  weight: number;
  count: number;
  edge_type: "dependency" | "contains" | "alternative" | "sequence" | "provides";
  edge_source: "observed" | "inferred" | "template";
  source?: string;
  relationship?: string;
  [key: string]: unknown; // Index signature for Graphology compatibility
}

/**
 * Graph snapshot for visualization
 */
export interface GraphSnapshot {
  nodes: Array<{
    id: string;
    label: string;
    server: string;
    pagerank: number;
    degree: number;
    communityId?: string;
  }>;
  edges: Array<{
    source: string;
    target: string;
    confidence: number;
    observed_count: number;
    edge_type: string;
    edge_source: string;
  }>;
  metadata: {
    total_nodes: number;
    total_edges: number;
    density: number;
    last_updated: string;
  };
}

/**
 * GraphStore wraps Graphology for type-safe graph operations
 */
export class GraphStore {
  private graph: GraphologyInstance;

  constructor() {
    this.graph = new DirectedGraph({ allowSelfLoops: false });
  }

  /**
   * Get the underlying Graphology instance
   *
   * Used by algorithms that need direct graph access.
   */
  getGraph(): GraphologyInstance {
    return this.graph;
  }

  /**
   * Clear all nodes and edges from the graph
   */
  clear(): void {
    this.graph.clear();
  }

  /**
   * Get node count
   */
  get nodeCount(): number {
    return this.graph.order;
  }

  /**
   * Get edge count
   */
  get edgeCount(): number {
    return this.graph.size;
  }

  // === Node Operations ===

  /**
   * Add a node to the graph
   */
  addNode(nodeId: string, attributes: NodeAttributes = {}): void {
    if (!this.graph.hasNode(nodeId)) {
      this.graph.addNode(nodeId, attributes);
    }
  }

  /**
   * Check if a node exists
   */
  hasNode(nodeId: string): boolean {
    return this.graph.hasNode(nodeId);
  }

  /**
   * Get node attributes
   */
  getNodeAttributes(nodeId: string): NodeAttributes | null {
    if (!this.graph.hasNode(nodeId)) return null;
    return this.graph.getNodeAttributes(nodeId) as NodeAttributes;
  }

  /**
   * Set a node attribute
   */
  setNodeAttribute(nodeId: string, attr: string, value: unknown): void {
    if (this.graph.hasNode(nodeId)) {
      this.graph.setNodeAttribute(nodeId, attr, value);
    }
  }

  /**
   * Get all node IDs
   */
  getNodes(): string[] {
    return this.graph.nodes();
  }

  /**
   * Iterate over all nodes
   */
  forEachNode(callback: (nodeId: string, attrs: NodeAttributes) => void): void {
    this.graph.forEachNode((nodeId, attrs) => {
      callback(nodeId, attrs as NodeAttributes);
    });
  }

  // === Edge Operations ===

  /**
   * Add an edge to the graph
   */
  addEdge(source: string, target: string, attributes: Partial<EdgeAttributes>): void {
    // Ensure nodes exist
    if (!this.graph.hasNode(source)) {
      this.graph.addNode(source, { type: "tool" });
    }
    if (!this.graph.hasNode(target)) {
      this.graph.addNode(target, { type: "tool" });
    }

    if (!this.graph.hasEdge(source, target)) {
      this.graph.addEdge(source, target, {
        weight: attributes.weight ?? 0.5,
        count: attributes.count ?? 1,
        edge_type: attributes.edge_type ?? "sequence",
        edge_source: attributes.edge_source ?? "inferred",
        ...attributes,
      });
    }
  }

  /**
   * Check if an edge exists
   */
  hasEdge(source: string, target: string): boolean {
    return this.graph.hasEdge(source, target);
  }

  /**
   * Get edge attributes
   */
  getEdgeAttributes(source: string, target: string): EdgeAttributes | null {
    if (!this.graph.hasEdge(source, target)) return null;
    return this.graph.getEdgeAttributes(source, target) as EdgeAttributes;
  }

  /**
   * Set an edge attribute
   */
  setEdgeAttribute(source: string, target: string, attr: string, value: unknown): void {
    if (this.graph.hasEdge(source, target)) {
      this.graph.setEdgeAttribute(source, target, attr, value);
    }
  }

  /**
   * Get all edges
   */
  getEdges(): Array<{ source: string; target: string; attributes: EdgeAttributes }> {
    const edges: Array<{ source: string; target: string; attributes: EdgeAttributes }> = [];

    this.graph.forEachEdge((_edge, attrs, source, target) => {
      edges.push({
        source,
        target,
        attributes: attrs as EdgeAttributes,
      });
    });

    return edges;
  }

  /**
   * Get edges filtered by type (Story 10.3)
   *
   * @param edgeType - Edge type to filter by (dependency, contains, provides, sequence, alternative)
   * @returns Array of edges with the specified type
   */
  getEdgesByType(
    edgeType: EdgeAttributes["edge_type"],
  ): Array<{ source: string; target: string; attributes: EdgeAttributes }> {
    return this.getEdges().filter((edge) => edge.attributes.edge_type === edgeType);
  }

  /**
   * Get all edge keys
   */
  getEdgeKeys(): string[] {
    return this.graph.edges();
  }

  /**
   * Get edge extremities (source, target)
   */
  getEdgeExtremities(edge: string): [string, string] {
    return this.graph.extremities(edge);
  }

  /**
   * Iterate over all edges
   */
  forEachEdge(
    callback: (edge: string, attrs: EdgeAttributes, source: string, target: string) => void
  ): void {
    this.graph.forEachEdge((edge, attrs, source, target) => {
      callback(edge, attrs as EdgeAttributes, source, target);
    });
  }

  // === Neighbor Operations ===

  /**
   * Get neighbors of a node
   */
  getNeighbors(nodeId: string, direction: "in" | "out" | "both" = "both"): string[] {
    if (!this.graph.hasNode(nodeId)) return [];

    switch (direction) {
      case "in":
        return this.graph.inNeighbors(nodeId);
      case "out":
        return this.graph.outNeighbors(nodeId);
      case "both":
        return this.graph.neighbors(nodeId);
    }
  }

  /**
   * Get node degree
   */
  getDegree(nodeId: string): number {
    if (!this.graph.hasNode(nodeId)) return 0;
    return this.graph.degree(nodeId);
  }

  // === Snapshot ===

  /**
   * Get complete graph snapshot for visualization
   */
  getSnapshot(
    pageRanks: Record<string, number>,
    communities: Record<string, string>
  ): GraphSnapshot {
    const nodes = this.graph.nodes().map((toolId) => {
      const { server, name: label } = parseToolId(toolId);

      return {
        id: toolId,
        label,
        server,
        pagerank: pageRanks[toolId] || 0,
        degree: this.graph.degree(toolId),
        communityId: communities[toolId],
      };
    });

    const edges = this.graph.edges().map((edgeKey) => {
      const edge = this.graph.getEdgeAttributes(this.graph.source(edgeKey), this.graph.target(edgeKey));
      return {
        source: this.graph.source(edgeKey),
        target: this.graph.target(edgeKey),
        confidence: (edge.weight as number) ?? 0,
        observed_count: (edge.count as number) ?? 0,
        edge_type: (edge.edge_type as string) ?? "sequence",
        edge_source: (edge.edge_source as string) ?? "inferred",
      };
    });

    // Calculate density
    const nodeCount = this.graph.order;
    const maxPossibleEdges = nodeCount * (nodeCount - 1);
    const density = maxPossibleEdges > 0 ? this.graph.size / maxPossibleEdges : 0;

    return {
      nodes,
      edges,
      metadata: {
        total_nodes: nodes.length,
        total_edges: edges.length,
        density,
        last_updated: new Date().toISOString(),
      },
    };
  }
}

/**
 * Create a new GraphStore instance
 */
export function createGraphStore(): GraphStore {
  return new GraphStore();
}
