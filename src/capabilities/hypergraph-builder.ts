/**
 * HypergraphBuilder (Epic 8 - Story 8.2)
 *
 * Converts capabilities to D3.js compound graph with hyperedge support.
 * Handles N-ary relationships where tools can belong to multiple capabilities.
 *
 * Key design decisions:
 * - Tool nodes have `parents[]` array instead of single `parent`
 * - Hierarchical edges derived from parents[] for D3 force layout
 * - Hull zones generated for capability visualization (convex hulls)
 *
 * @module capabilities/hypergraph-builder
 */

import type {
  CapabilityDependencyEdge,
  CapabilityEdge,
  CapabilityNode,
  CapabilityResponseInternal,
  GraphEdge,
  GraphNode,
  HierarchicalEdge,
  ToolNode,
} from "./types.ts";
import type { GraphSnapshot } from "../graphrag/graph-engine.ts";
import { getLogger } from "../telemetry/logger.ts";

const logger = getLogger("default");

/**
 * Hull zone metadata for capability visualization
 * Each capability is rendered as a convex hull around its tools
 */
export interface CapabilityZone {
  /** Capability ID (cap-{uuid}) */
  id: string;
  /** Display label */
  label: string;
  /** Zone color (hex) */
  color: string;
  /** Opacity (0-1) for overlapping zones */
  opacity: number;
  /** Tool IDs contained in this zone */
  toolIds: string[];
  /** Padding around tools in px */
  padding: number;
  /** Minimum hull radius */
  minRadius: number;
}

/**
 * Result of building a compound graph for hypergraph visualization
 */
export interface HypergraphResult {
  /** All nodes (capabilities + tools) */
  nodes: GraphNode[];
  /** All edges (hierarchical + capability_link + dependency) */
  edges: GraphEdge[];
  /** Hull zone metadata for D3.js hull rendering */
  capabilityZones: CapabilityZone[];
  /** Capabilities count */
  capabilitiesCount: number;
  /** Tools count (unique) */
  toolsCount: number;
}

/**
 * Color palette for capability zones
 * Distinct colors for visual differentiation
 */
const ZONE_COLORS = [
  "#8b5cf6", // violet
  "#3b82f6", // blue
  "#10b981", // emerald
  "#f59e0b", // amber
  "#ef4444", // red
  "#ec4899", // pink
  "#06b6d4", // cyan
  "#84cc16", // lime
];

/**
 * HypergraphBuilder - Converts capabilities to D3.js compound graph
 *
 * Handles hyperedge semantics:
 * - A tool can belong to multiple capabilities (multi-parent)
 * - Shared tools create visual zone overlaps via Hull
 * - Capability-to-capability edges from shared tools and explicit dependencies
 *
 * @example
 * ```typescript
 * const builder = new HypergraphBuilder();
 * const result = builder.buildCompoundGraph(capabilities, graphSnapshot);
 * // result.nodes, result.edges, result.capabilityZones ready for D3.js
 * ```
 */
export class HypergraphBuilder {
  /**
   * Build a compound graph from capabilities with hyperedge support
   *
   * @param capabilities List of capabilities to visualize
   * @param toolsSnapshot Optional GraphSnapshot for tool metrics (pagerank, degree)
   * @param capabilityPageranks Optional map of capability ID to PageRank score
   * @returns HypergraphResult with nodes, edges, and zone metadata
   */
  buildCompoundGraph(
    capabilities: CapabilityResponseInternal[],
    toolsSnapshot?: GraphSnapshot,
    capabilityPageranks?: Map<string, number>,
  ): HypergraphResult {
    logger.debug("Building compound graph", {
      capabilitiesCount: capabilities.length,
      hasSnapshot: !!toolsSnapshot,
    });

    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const capabilityZones: CapabilityZone[] = [];

    // Track tools with their parent capabilities (for deduplication)
    const toolNodes = new Map<string, ToolNode>();
    const capabilityToolsMap = new Map<string, Set<string>>();

    // 1. Create capability nodes and collect tool data
    for (let i = 0; i < capabilities.length; i++) {
      const cap = capabilities[i];
      const capId = `cap-${cap.id}`;

      // Create capability node (with pagerank from spectral clustering if available)
      const capNode: CapabilityNode = {
        data: {
          id: capId,
          type: "capability",
          label: cap.name || cap.intentPreview.substring(0, 50),
          codeSnippet: cap.codeSnippet,
          successRate: cap.successRate,
          usageCount: cap.usageCount,
          toolsCount: cap.toolsUsed.length,
          pagerank: capabilityPageranks?.get(cap.id) ?? 0,
          toolsUsed: cap.toolsUsed, // Unique tools (deduplicated)
          toolInvocations: cap.toolInvocations, // Full sequence with timestamps (for invocation mode)
        },
      };
      nodes.push(capNode);

      // Track tools for this capability
      const toolSet = new Set<string>();
      for (const toolId of cap.toolsUsed) {
        toolSet.add(toolId);

        if (!toolNodes.has(toolId)) {
          // First occurrence - create node with parents array
          const toolNode = this.createToolNode(toolId, toolsSnapshot, [capId]);
          toolNodes.set(toolId, toolNode);
        } else {
          // Tool already exists - add this capability to parents[]
          const existingNode = toolNodes.get(toolId)!;
          if (existingNode.data.parents) {
            existingNode.data.parents.push(capId);
          }
        }

        // Create hierarchical edge (capability → tool) for D3 force layout
        const hierEdge: HierarchicalEdge = {
          data: {
            id: `edge-${capId}-${toolId}`,
            source: capId,
            target: toolId,
            edgeType: "hierarchy",
            edgeSource: "observed",
            observedCount: cap.usageCount,
          },
        };
        edges.push(hierEdge);
      }

      capabilityToolsMap.set(capId, toolSet);

      // Create hull zone metadata
      const zone: CapabilityZone = {
        id: capId,
        label: cap.name || cap.intentPreview.substring(0, 30),
        color: ZONE_COLORS[i % ZONE_COLORS.length],
        opacity: 0.3,
        toolIds: [...cap.toolsUsed],
        padding: 20,
        minRadius: 50,
      };
      capabilityZones.push(zone);
    }

    // 2. Add all tool nodes to result
    for (const toolNode of toolNodes.values()) {
      nodes.push(toolNode);
    }

    // 3. Create capability_link edges for shared tools
    const capIds = Array.from(capabilityToolsMap.keys());
    for (let i = 0; i < capIds.length; i++) {
      for (let j = i + 1; j < capIds.length; j++) {
        const capId1 = capIds[i];
        const capId2 = capIds[j];
        const tools1 = capabilityToolsMap.get(capId1)!;
        const tools2 = capabilityToolsMap.get(capId2)!;

        // Count shared tools
        const sharedTools = Array.from(tools1).filter((t) => tools2.has(t)).length;

        if (sharedTools > 0) {
          const linkEdge: CapabilityEdge = {
            data: {
              id: `edge-${capId1}-${capId2}-shared`,
              source: capId1,
              target: capId2,
              sharedTools,
              edgeType: "capability_link",
              edgeSource: "inferred",
            },
          };
          edges.push(linkEdge);
        }
      }
    }

    const result: HypergraphResult = {
      nodes,
      edges,
      capabilityZones,
      capabilitiesCount: capabilities.length,
      toolsCount: toolNodes.size,
    };

    logger.info("Compound graph built", {
      nodesCount: nodes.length,
      edgesCount: edges.length,
      zonesCount: capabilityZones.length,
      capabilitiesCount: result.capabilitiesCount,
      toolsCount: result.toolsCount,
    });

    return result;
  }

  /**
   * Add capability dependency edges from database records
   *
   * @param edges Existing edges array to append to
   * @param dependencies Capability dependencies from DB
   * @param existingCapIds Set of capability IDs that exist in the graph
   */
  addCapabilityDependencyEdges(
    edges: GraphEdge[],
    dependencies: Array<{
      from_capability_id: string;
      to_capability_id: string;
      observed_count: number;
      edge_type: string;
      edge_source: string;
    }>,
    existingCapIds: Set<string>,
  ): void {
    for (const dep of dependencies) {
      const fromCapId = `cap-${dep.from_capability_id}`;
      const toCapId = `cap-${dep.to_capability_id}`;

      // Only add edge if both capabilities are in visualization
      if (!existingCapIds.has(fromCapId) || !existingCapIds.has(toCapId)) {
        continue;
      }

      // Validate edge_type (Story 10.3: added "provides")
      const rawEdgeType = dep.edge_type || "dependency";
      const edgeType = ["contains", "sequence", "dependency", "alternative", "provides"].includes(
          rawEdgeType,
        )
        ? (rawEdgeType as "contains" | "sequence" | "dependency" | "alternative" | "provides")
        : "dependency";

      // Validate edge_source
      const rawEdgeSource = dep.edge_source || "inferred";
      const edgeSource = ["template", "inferred", "observed"].includes(rawEdgeSource)
        ? (rawEdgeSource as "template" | "inferred" | "observed")
        : "inferred";

      const depEdge: CapabilityDependencyEdge = {
        data: {
          id: `dep-${dep.from_capability_id}-${dep.to_capability_id}`,
          source: fromCapId,
          target: toCapId,
          edgeType,
          edgeSource,
          observedCount: dep.observed_count || 1,
        },
      };
      edges.push(depEdge);
    }

    logger.debug("Added capability dependency edges", {
      inputCount: dependencies.length,
      addedCount: edges.filter((e) => e.data.id.startsWith("dep-")).length,
    });
  }

  /**
   * Add standalone tools (not part of any capability) from graph snapshot
   *
   * @param nodes Existing nodes array to append to
   * @param toolsSnapshot GraphSnapshot with all tools
   * @param existingToolIds Set of tool IDs already in graph
   */
  addStandaloneTools(
    nodes: GraphNode[],
    toolsSnapshot: GraphSnapshot,
    existingToolIds: Set<string>,
  ): void {
    for (const snapshotNode of toolsSnapshot.nodes) {
      if (existingToolIds.has(snapshotNode.id)) {
        continue;
      }

      // Create standalone tool node (no parent)
      const toolNode: ToolNode = {
        data: {
          id: snapshotNode.id,
          type: "tool",
          server: snapshotNode.server,
          label: snapshotNode.label,
          pagerank: snapshotNode.pagerank || 0,
          degree: snapshotNode.degree || 0,
          communityId: snapshotNode.communityId,
          parents: [], // Empty array = standalone
        },
      };
      nodes.push(toolNode);
    }
  }

  /**
   * Create a tool node with pagerank/degree from snapshot
   *
   * @param toolId Tool identifier (server:name format)
   * @param snapshot Optional GraphSnapshot for metrics
   * @param parents Initial parent capability IDs
   * @returns ToolNode with all required fields
   */
  private createToolNode(
    toolId: string,
    snapshot?: GraphSnapshot,
    parents: string[] = [],
  ): ToolNode {
    // Extract server and name from tool_id
    const [server = "unknown", ...nameParts] = toolId.split(":");
    const name = nameParts.join(":") || toolId;

    // Get metrics from snapshot if available
    let pagerank = 0;
    let degree = 0;
    let communityId: string | undefined;
    if (snapshot) {
      const snapshotNode = snapshot.nodes.find((n) => n.id === toolId);
      if (snapshotNode) {
        pagerank = snapshotNode.pagerank || 0;
        degree = snapshotNode.degree || 0;
        communityId = snapshotNode.communityId;
      }
    }

    return {
      data: {
        id: toolId,
        type: "tool",
        server,
        label: name,
        pagerank,
        degree,
        communityId,
        parents,
        // Backward compatibility: set legacy `parent` field to first parent
        ...(parents.length > 0 ? { parent: parents[0] } : {}),
      },
    };
  }

  // Note: addToolInvocationNodes removed - invocations now generated client-side from toolsUsed
}
