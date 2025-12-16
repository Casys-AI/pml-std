/**
 * GraphRAG Engine with Graphology
 *
 * Implements true graph algorithms (PageRank, Louvain, path finding) for
 * intelligent DAG construction and tool dependency analysis.
 *
 * @module graphrag/graph-engine
 */

// @ts-ignore: NPM module resolution
import graphologyPkg from "graphology";
// @ts-ignore: NPM module resolution
import pagerankPkg from "graphology-metrics/centrality/pagerank.js";
// @ts-ignore: NPM module resolution
import louvainPkg from "graphology-communities-louvain";
// @ts-ignore: NPM module resolution
import { dijkstra } from "graphology-shortest-path";
import * as log from "@std/log";
import type { PGliteClient } from "../db/client.ts";
import type { VectorSearch } from "../vector/search.ts";
import type {
  DAGStructure,
  GraphMetricsResponse,
  GraphStats,
  HybridSearchResult,
  MetricsTimeRange,
  Task,
  TimeSeriesPoint,
  WorkflowExecution,
} from "./types.ts";
import type { GraphEvent } from "./events.ts";
import type { TraceEvent } from "../sandbox/types.ts";
// Story 6.5: EventBus integration (ADR-036)
import { eventBus } from "../events/mod.ts";
// ADR-048: Local adaptive alpha
import { LocalAlphaCalculator, type AlphaMode, type NodeType } from "./local-alpha.ts";

// Extract exports from Graphology packages
const { DirectedGraph } = graphologyPkg as any;
const pagerank = pagerankPkg as any;
const louvain = louvainPkg as any;

/**
 * GraphRAG Engine
 *
 * Hybrid approach: PGlite for persistence, Graphology for graph computations.
 * Syncs graph from database, computes PageRank and communities, provides
 * path finding and DAG building capabilities.
 */
export class GraphRAGEngine {
  private graph: any;
  private pageRanks: Record<string, number> = {};
  private communities: Record<string, string> = {};
  private eventTarget: EventTarget;
  private listenerMap: Map<(event: GraphEvent) => void, EventListener> = new Map();
  private localAlphaCalculator: LocalAlphaCalculator | null = null; // ADR-048

  constructor(private db: PGliteClient) {
    this.graph = new DirectedGraph({ allowSelfLoops: false });
    this.eventTarget = new EventTarget();
    this.initLocalAlphaCalculator(); // ADR-048
  }

  /**
   * Initialize LocalAlphaCalculator with dependencies (ADR-048)
   */
  private initLocalAlphaCalculator(): void {
    this.localAlphaCalculator = new LocalAlphaCalculator({
      graph: this.graph,
      spectralClustering: null, // Will be set by DAGSuggester if available
      getSemanticEmbedding: (_nodeId: string) => null, // Requires VectorSearch, set externally
      getObservationCount: (nodeId: string) => this.getNodeObservationCount(nodeId),
      getParent: (_nodeId: string, _parentType: NodeType) => null, // Set by DAGSuggester
      getChildren: (_nodeId: string, _childType: NodeType) => [], // Set by DAGSuggester
    });
  }

  /**
   * Get observation count for a node (ADR-048)
   * Uses edge weight sum as proxy for observations
   */
  private getNodeObservationCount(nodeId: string): number {
    if (!this.graph.hasNode(nodeId)) return 0;
    let totalWeight = 0;
    this.graph.forEachEdge(nodeId, (_edge: string, attrs: any) => {
      totalWeight += attrs.weight || 1;
    });
    return Math.floor(totalWeight);
  }

  /**
   * Subscribe to graph events
   *
   * @param event - Event name (always "graph_event")
   * @param listener - Event listener function
   */
  on(event: "graph_event", listener: (event: GraphEvent) => void): void {
    const wrappedListener = ((e: CustomEvent<GraphEvent>) => {
      listener(e.detail);
    }) as EventListener;

    this.listenerMap.set(listener, wrappedListener);
    this.eventTarget.addEventListener(event, wrappedListener);
  }

  /**
   * Unsubscribe from graph events
   *
   * @param event - Event name (always "graph_event")
   * @param listener - Event listener function to remove
   */
  off(event: "graph_event", listener: (event: GraphEvent) => void): void {
    const wrappedListener = this.listenerMap.get(listener);
    if (wrappedListener) {
      this.eventTarget.removeEventListener(event, wrappedListener);
      this.listenerMap.delete(listener);
    }
  }

  /**
   * Emit a graph event
   * Story 6.5: Also emits to unified EventBus (ADR-036)
   *
   * @param event - Graph event to emit
   */
  private emit(event: GraphEvent): void {
    // Legacy: dispatch to local EventTarget for backward compat (EventsStreamManager)
    const customEvent = new CustomEvent("graph_event", { detail: event });
    this.eventTarget.dispatchEvent(customEvent);

    // Story 6.5: Also emit to unified EventBus with mapped event types
    this.emitToEventBus(event);
  }

  /**
   * Map legacy GraphEvent to new EventBus event types
   * Story 6.5: Bridge between old and new event systems
   */
  private emitToEventBus(event: GraphEvent): void {
    switch (event.type) {
      case "graph_synced":
        eventBus.emit({
          type: "graph.synced",
          source: "graphrag",
          payload: {
            nodeCount: event.data.nodeCount,
            edgeCount: event.data.edgeCount,
            syncDurationMs: event.data.syncDurationMs,
          },
        });
        break;

      case "edge_created":
        eventBus.emit({
          type: "graph.edge.created",
          source: "graphrag",
          payload: {
            fromToolId: event.data.fromToolId,
            toToolId: event.data.toToolId,
            confidenceScore: event.data.confidenceScore,
          },
        });
        break;

      case "edge_updated":
        eventBus.emit({
          type: "graph.edge.updated",
          source: "graphrag",
          payload: {
            fromToolId: event.data.fromToolId,
            toToolId: event.data.toToolId,
            oldConfidence: event.data.oldConfidence,
            newConfidence: event.data.newConfidence,
            observedCount: event.data.observedCount,
          },
        });
        break;

      case "metrics_updated":
        eventBus.emit({
          type: "graph.metrics.computed",
          source: "graphrag",
          payload: {
            nodeCount: event.data.nodeCount,
            edgeCount: event.data.edgeCount,
            density: event.data.density,
            communitiesCount: event.data.communitiesCount,
          },
        });
        break;

      // heartbeat and workflow_executed are handled elsewhere
      default:
        // Unknown event type, skip EventBus emission
        break;
    }
  }

  /**
   * Sync graph from PGlite to Graphology in-memory
   *
   * Performance target: <50ms P95 for 200 tools, 100 dependencies
   */
  async syncFromDatabase(): Promise<void> {
    const startTime = performance.now();

    // Clear existing graph
    this.graph.clear();

    try {
      // 1. Load nodes (tools) from PGlite
      const tools = await this.db.query(`
        SELECT tool_id, tool_name, server_id, metadata
        FROM tool_embedding
      `);

      for (const tool of tools) {
        this.graph.addNode(tool.tool_id as string, {
          name: tool.tool_name as string,
          serverId: tool.server_id as string,
          metadata: tool.metadata,
        });
      }

      // 2. Load edges (dependencies) from PGlite
      // ADR-041: Include edge_type and edge_source
      const deps = await this.db.query(`
        SELECT from_tool_id, to_tool_id, observed_count, confidence_score, edge_type, edge_source
        FROM tool_dependency
        WHERE confidence_score > 0.3
      `);

      for (const dep of deps) {
        const from = dep.from_tool_id as string;
        const to = dep.to_tool_id as string;

        if (this.graph.hasNode(from) && this.graph.hasNode(to)) {
          this.graph.addEdge(from, to, {
            weight: dep.confidence_score as number,
            count: dep.observed_count as number,
            // ADR-041: Load edge_type and edge_source with defaults for legacy data
            edge_type: (dep.edge_type as string) || "sequence",
            edge_source: (dep.edge_source as string) || "inferred",
          });
        }
      }

      // 3. Load capability-to-capability edges from capability_dependency table
      const capDeps = await this.db.query(`
        SELECT from_capability_id, to_capability_id, observed_count, confidence_score, edge_type, edge_source
        FROM capability_dependency
        WHERE confidence_score > 0.3
      `);

      for (const dep of capDeps) {
        const fromNode = `capability:${dep.from_capability_id}`;
        const toNode = `capability:${dep.to_capability_id}`;

        // Ensure capability nodes exist
        if (!this.graph.hasNode(fromNode)) {
          this.graph.addNode(fromNode, { type: "capability" });
        }
        if (!this.graph.hasNode(toNode)) {
          this.graph.addNode(toNode, { type: "capability" });
        }

        // Add edge if not already present
        if (!this.graph.hasEdge(fromNode, toNode)) {
          this.graph.addEdge(fromNode, toNode, {
            weight: dep.confidence_score as number,
            count: dep.observed_count as number,
            edge_type: (dep.edge_type as string) || "sequence",
            edge_source: (dep.edge_source as string) || "inferred",
            relationship: "capability_dependency",
          });
        }
      }

      log.debug(`Loaded ${capDeps.length} capability-to-capability edges`);

      const syncTime = performance.now() - startTime;
      log.info(
        `✓ Graph synced: ${this.graph.order} nodes, ${this.graph.size} edges (${
          syncTime.toFixed(1)
        }ms)`,
      );

      // 3. Precompute metrics if graph is not empty
      if (this.graph.order > 0) {
        await this.precomputeMetrics();
      }

      // 4. Emit graph_synced event
      this.emit({
        type: "graph_synced",
        data: {
          nodeCount: this.graph.order,
          edgeCount: this.graph.size,
          syncDurationMs: syncTime,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      log.error(`Graph sync failed: ${error}`);
      throw error;
    }
  }

  /**
   * Precompute expensive graph metrics (PageRank, Communities)
   *
   * Performance target: <100ms for PageRank, <150ms for community detection
   */
  private async precomputeMetrics(): Promise<void> {
    const startTime = performance.now();

    try {
      // PageRank (native Graphology)
      this.pageRanks = pagerank(this.graph, {
        weighted: true,
        tolerance: 0.0001,
      });

      // Community detection (Louvain algorithm)
      this.communities = louvain(this.graph, {
        resolution: 1.0,
      });

      const computeTime = performance.now() - startTime;
      log.info(`✓ Graph metrics computed (${computeTime.toFixed(1)}ms)`);
    } catch (error) {
      log.error(`Graph metrics computation failed: ${error}`);
      // Don't throw - allow system to continue with empty metrics
      this.pageRanks = {};
      this.communities = {};
    }
  }

  /**
   * Get PageRank score for a tool
   *
   * @param toolId - Tool identifier
   * @returns PageRank score between 0 and 1, or 0 if tool not found
   */
  getPageRank(toolId: string): number {
    return this.pageRanks[toolId] || 0;
  }

  /**
   * Get community ID for a tool
   *
   * @param toolId - Tool identifier
   * @returns Community ID or undefined if tool not found
   */
  getCommunity(toolId: string): string | undefined {
    return this.communities[toolId];
  }

  /**
   * Find tools in the same community
   *
   * @param toolId - Tool identifier
   * @returns Array of tool IDs in the same community (excluding the tool itself)
   */
  findCommunityMembers(toolId: string): string[] {
    const community = this.communities[toolId];
    if (!community) return [];

    return Object.entries(this.communities)
      .filter(([_, comm]) => comm === community)
      .map(([id]) => id)
      .filter((id) => id !== toolId);
  }

  /**
   * ADR-041: Get combined edge weight (type × source modifier)
   *
   * @param edgeType - Edge type: 'contains', 'sequence', or 'dependency'
   * @param edgeSource - Edge source: 'observed', 'inferred', or 'template'
   * @returns Combined weight for algorithms
   */
  getEdgeWeight(edgeType: string, edgeSource: string): number {
    const typeWeight = GraphRAGEngine.EDGE_TYPE_WEIGHTS[edgeType] || 0.5;
    const sourceModifier = GraphRAGEngine.EDGE_SOURCE_MODIFIERS[edgeSource] || 0.7;
    return typeWeight * sourceModifier;
  }

  /**
   * Find shortest path between two tools
   * ADR-041: Uses Dijkstra with weighted edges for optimal path finding
   *
   * Dijkstra minimizes total cost, so we convert weight to cost:
   * cost = 1 / weight (higher weight = lower cost = preferred path)
   *
   * @param fromToolId - Source tool
   * @param toToolId - Target tool
   * @returns Array of tool IDs representing the path, or null if no path exists
   */
  findShortestPath(fromToolId: string, toToolId: string): string[] | null {
    try {
      // ADR-041: Use Dijkstra with custom weight function
      // Convert weight to cost: higher weight = lower cost = preferred
      return dijkstra.bidirectional(
        this.graph,
        fromToolId,
        toToolId,
        (edge: string) => {
          const weight = this.graph.getEdgeAttribute(edge, "weight") as number || 0.5;
          // Invert weight to cost (min 0.1 to avoid division issues)
          return 1 / Math.max(weight, 0.1);
        },
      );
    } catch {
      return null; // No path exists
    }
  }

  /**
   * Build DAG from tool candidates using graph topology
   * ADR-041: Prioritizes edges by source (observed > inferred > template)
   *
   * Uses shortest path finding to infer dependencies based on historical patterns.
   * Tools with paths ≤3 hops are considered dependent.
   *
   * @param candidateTools - Array of tool IDs to include in DAG
   * @returns DAG structure with tasks and dependencies
   */
  buildDAG(candidateTools: string[]): DAGStructure {
    const n = candidateTools.length;

    // ADR-024: Build full adjacency matrix (N×N) to avoid ordering bias
    // Check dependencies in BOTH directions regardless of list order
    const adjacency: boolean[][] = Array.from({ length: n }, () => Array(n).fill(false));
    const edgeWeights: number[][] = Array.from({ length: n }, () => Array(n).fill(0));

    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j) continue;

        const fromTool = candidateTools[j];
        const toTool = candidateTools[i];
        const path = this.findShortestPath(fromTool, toTool);

        // If path exists and is short (≤3 hops), mark as dependency
        if (path && path.length > 0 && path.length <= 4) {
          adjacency[i][j] = true;

          // ADR-041: Weight based on path length AND edge quality
          // Get average edge weight along the path
          let totalEdgeWeight = 0;
          let edgeCount = 0;
          for (let k = 0; k < path.length - 1; k++) {
            if (this.graph.hasEdge(path[k], path[k + 1])) {
              const attrs = this.graph.getEdgeAttributes(path[k], path[k + 1]);
              const edgeType = attrs.edge_type as string || "sequence";
              const edgeSource = attrs.edge_source as string || "inferred";
              totalEdgeWeight += this.getEdgeWeight(edgeType, edgeSource);
              edgeCount++;
            }
          }
          const avgEdgeWeight = edgeCount > 0 ? totalEdgeWeight / edgeCount : 0.5;

          // Combined weight: path length factor × edge quality
          edgeWeights[i][j] = (1.0 / path.length) * avgEdgeWeight;
        }
      }
    }

    // ADR-024: Detect and break cycles using edge weights
    // ADR-041: Higher edge weight = more reliable = keep
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (adjacency[i][j] && adjacency[j][i]) {
          // Cycle detected: keep edge with higher weight (more reliable)
          if (edgeWeights[i][j] >= edgeWeights[j][i]) {
            adjacency[j][i] = false; // Remove j→i edge
            log.debug(
              `[buildDAG] Cycle broken: keeping ${candidateTools[j]} → ${
                candidateTools[i]
              } (weight: ${edgeWeights[i][j].toFixed(2)})`,
            );
          } else {
            adjacency[i][j] = false; // Remove i→j edge
            log.debug(
              `[buildDAG] Cycle broken: keeping ${candidateTools[i]} → ${
                candidateTools[j]
              } (weight: ${edgeWeights[j][i].toFixed(2)})`,
            );
          }
        }
      }
    }

    // Build tasks with resolved dependencies
    const tasks = candidateTools.map((toolId, i) => {
      const dependsOn: string[] = [];
      for (let j = 0; j < n; j++) {
        if (adjacency[i][j]) {
          dependsOn.push(`task_${j}`);
        }
      }

      return {
        id: `task_${i}`,
        tool: toolId,
        arguments: {},
        dependsOn: dependsOn,
      };
    });

    return { tasks };
  }

  /**
   * Update graph with new execution data
   *
   * Learns from workflow executions to strengthen dependency edges.
   *
   * @param execution - Workflow execution record
   */
  async updateFromExecution(execution: WorkflowExecution): Promise<void> {
    const startTime = performance.now();
    const toolIds = execution.dagStructure.tasks.map((t: Task) => t.tool);

    try {
      // Extract dependencies from executed DAG
      for (const task of execution.dagStructure.tasks) {
        for (const depTaskId of task.dependsOn) {
          const depTask = execution.dagStructure.tasks.find((t: Task) => t.id === depTaskId);
          if (!depTask) continue;

          const fromTool = depTask.tool;
          const toTool = task.tool;

          // Skip self-loops (same tool used multiple times in DAG)
          if (fromTool === toTool) continue;

          // Update or add edge in Graphology
          if (this.graph.hasEdge(fromTool, toTool)) {
            const edge = this.graph.getEdgeAttributes(fromTool, toTool);
            const oldConfidence = edge.weight as number;
            const newCount = (edge.count as number) + 1;
            const newConfidence = Math.min(oldConfidence * 1.1, 1.0);

            this.graph.setEdgeAttribute(fromTool, toTool, "count", newCount);
            this.graph.setEdgeAttribute(fromTool, toTool, "weight", newConfidence);

            // Emit edge_updated event
            this.emit({
              type: "edge_updated",
              data: {
                fromToolId: fromTool,
                toToolId: toTool,
                oldConfidence: oldConfidence,
                newConfidence: newConfidence,
                observedCount: newCount,
                edgeType: "dependency", // ADR-041: DAG dependencies are explicit
                edgeSource: "template", // ADR-041: from DAG template
                timestamp: new Date().toISOString(),
              },
            });
          } else if (this.graph.hasNode(fromTool) && this.graph.hasNode(toTool)) {
            this.graph.addEdge(fromTool, toTool, {
              count: 1,
              weight: 0.5,
              edge_type: "dependency", // ADR-041: DAG dependencies are explicit
              edge_source: "template", // ADR-041: from DAG template
            });

            // Emit edge_created event
            this.emit({
              type: "edge_created",
              data: {
                fromToolId: fromTool,
                toToolId: toTool,
                confidenceScore: 0.5,
                observedCount: 1, // ADR-041
                edgeType: "dependency", // ADR-041: DAG dependencies are explicit
                edgeSource: "template", // ADR-041: from DAG template
                timestamp: new Date().toISOString(),
              },
            });
          }
        }
      }

      // Recompute metrics (fast with Graphology)
      if (this.graph.order > 0) {
        await this.precomputeMetrics();
      }

      // Persist updated edges to PGlite
      await this.persistEdgesToDB();

      // Persist workflow execution for time-series analytics (Story 6.3)
      // Story 9.5: Include user_id and created_by for multi-tenant isolation
      const userId = execution.userId || "local";
      await this.db.query(
        `INSERT INTO workflow_execution
         (intent_text, dag_structure, success, execution_time_ms, error_message, user_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          execution.intentText || null,
          JSON.stringify(execution.dagStructure),
          execution.success,
          Math.round(execution.executionTimeMs), // INTEGER column
          execution.errorMessage || null,
          userId,
          userId, // created_by = user_id
        ],
      );

      const executionTime = performance.now() - startTime;

      // Emit workflow_executed event
      this.emit({
        type: "workflow_executed",
        data: {
          workflowId: execution.executionId,
          toolIds: toolIds,
          success: execution.success,
          executionTimeMs: executionTime,
          timestamp: new Date().toISOString(),
        },
      });

      // Emit metrics_updated event
      this.emit({
        type: "metrics_updated",
        data: {
          edgeCount: this.graph.size,
          nodeCount: this.graph.order,
          density: this.getDensity(),
          pagerankTop10: this.getTopPageRank(10),
          communitiesCount: this.getCommunitiesCount(),
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      log.error(`Failed to update graph from execution: ${error}`);
      throw error;
    }
  }

  // ============================================
  // Story 7.3b: Code Execution Trace Learning
  // ADR-041: Hierarchical edge creation using parent_trace_id
  // ============================================

  /**
   * ADR-041: Edge type weights for algorithms
   *
   * Combined weight formula: final_weight = type_weight × source_modifier
   *
   * Examples of combined weights:
   * - dependency + observed = 1.0 × 1.0 = 1.0 (strongest)
   * - contains + observed   = 0.8 × 1.0 = 0.8
   * - contains + inferred   = 0.8 × 0.7 = 0.56
   * - sequence + inferred   = 0.5 × 0.7 = 0.35
   * - sequence + template   = 0.5 × 0.5 = 0.25 (weakest)
   *
   * For Dijkstra shortest path: cost = 1/weight
   * Higher weight = lower cost = preferred path
   */
  private static readonly EDGE_TYPE_WEIGHTS: Record<string, number> = {
    dependency: 1.0, // Explicit DAG from templates
    contains: 0.8, // Parent-child hierarchy (capability → tool)
    alternative: 0.6, // Same intent, different implementation (capability ↔ capability)
    sequence: 0.5, // Temporal order between siblings
  };

  /**
   * ADR-041: Edge source weight modifiers (multiplied with type weight)
   */
  private static readonly EDGE_SOURCE_MODIFIERS: Record<string, number> = {
    observed: 1.0, // Confirmed by 3+ executions
    inferred: 0.7, // 1-2 observations
    template: 0.5, // Bootstrap, not yet confirmed
  };

  /**
   * ADR-041: Observation threshold for edge_source upgrade
   * Edge transitions from 'inferred' to 'observed' after this many observations
   */
  private static readonly OBSERVED_THRESHOLD = 3;

  /**
   * Update graph from code execution traces (tool + capability)
   * Story 7.3b: Called by WorkerBridge after execution completes
   * ADR-041: Uses parent_trace_id for hierarchical edge creation
   *
   * Creates edges for:
   * - `contains`: Parent → Child (capability → tool, capability → nested capability)
   * - `sequence`: Sibling → Sibling (same parent, ordered by timestamp)
   *
   * @param traces - Chronologically sorted trace events
   */
  async updateFromCodeExecution(traces: TraceEvent[]): Promise<void> {
    if (traces.length < 1) {
      log.debug("[updateFromCodeExecution] No traces for edge creation");
      return;
    }

    const startTime = performance.now();
    let edgesCreated = 0;
    let edgesUpdated = 0;

    // ADR-041: Build maps for hierarchy analysis
    // Map traceId → node_id for all events
    const traceToNode = new Map<string, string>();
    // Map parentTraceId → list of children node_ids (in timestamp order)
    const parentToChildren = new Map<string, string[]>();
    // Track all node IDs for creation
    const nodeIds = new Set<string>();

    // First pass: collect all nodes and build hierarchy
    for (const trace of traces) {
      // Only process *_end events (completed calls)
      if (trace.type !== "tool_end" && trace.type !== "capability_end") continue;

      // Extract node ID based on event type
      const nodeId = trace.type === "tool_end"
        ? (trace as { tool: string }).tool
        : `capability:${(trace as { capabilityId: string }).capabilityId}`;

      nodeIds.add(nodeId);
      traceToNode.set(trace.traceId, nodeId);

      // ADR-041: Track parent-child relationships
      const parentTraceId = trace.parentTraceId;
      if (parentTraceId) {
        if (!parentToChildren.has(parentTraceId)) {
          parentToChildren.set(parentTraceId, []);
        }
        parentToChildren.get(parentTraceId)!.push(nodeId);
      }
    }

    // Ensure all nodes exist in graph
    for (const trace of traces) {
      if (trace.type !== "tool_end" && trace.type !== "capability_end") continue;

      const nodeId = trace.type === "tool_end"
        ? (trace as { tool: string }).tool
        : `capability:${(trace as { capabilityId: string }).capabilityId}`;

      if (!this.graph.hasNode(nodeId)) {
        this.graph.addNode(nodeId, {
          type: trace.type === "tool_end" ? "tool" : "capability",
          name: trace.type === "tool_end"
            ? (trace as { tool: string }).tool
            : (trace as { capability: string }).capability,
        });
      }
    }

    // ADR-041: Create 'contains' edges (parent → child)
    // Tech-spec: Also persist capability→capability edges to capability_dependency table
    for (const [parentTraceId, children] of parentToChildren) {
      const parentNodeId = traceToNode.get(parentTraceId);
      if (!parentNodeId) continue; // Parent not in this execution (e.g., top-level)

      for (const childNodeId of children) {
        if (parentNodeId === childNodeId) continue; // Skip self-loops

        const result = await this.createOrUpdateEdge(
          parentNodeId,
          childNodeId,
          "contains",
        );
        if (result === "created") edgesCreated++;
        else if (result === "updated") edgesUpdated++;

        // Tech-spec Task 5: Persist capability→capability edges to capability_dependency
        if (parentNodeId.startsWith("capability:") && childNodeId.startsWith("capability:")) {
          const fromCapabilityId = parentNodeId.replace("capability:", "");
          const toCapabilityId = childNodeId.replace("capability:", "");

          try {
            await this.persistCapabilityDependency(fromCapabilityId, toCapabilityId, "contains");
          } catch (error) {
            // Log but don't fail - edge already tracked in graph
            log.warn(`Failed to persist capability dependency: ${error}`);
          }
        }
      }
    }

    // ADR-041: Create 'sequence' edges between siblings (same parent)
    for (const [_parentTraceId, children] of parentToChildren) {
      // Children are already in timestamp order (from trace array order)
      for (let i = 0; i < children.length - 1; i++) {
        const fromId = children[i];
        const toId = children[i + 1];
        if (fromId === toId) continue;

        const result = await this.createOrUpdateEdge(fromId, toId, "sequence");
        if (result === "created") edgesCreated++;
        else if (result === "updated") edgesUpdated++;
      }
    }

    // ADR-041: Backward compatibility - create sequence edges for top-level traces without parent
    const topLevelTraces = traces.filter((t) =>
      (t.type === "tool_end" || t.type === "capability_end") && !t.parentTraceId
    );
    for (let i = 0; i < topLevelTraces.length - 1; i++) {
      const from = topLevelTraces[i];
      const to = topLevelTraces[i + 1];

      const fromId = from.type === "tool_end"
        ? (from as { tool: string }).tool
        : `capability:${(from as { capabilityId: string }).capabilityId}`;
      const toId = to.type === "tool_end"
        ? (to as { tool: string }).tool
        : `capability:${(to as { capabilityId: string }).capabilityId}`;

      if (fromId === toId) continue;

      const result = await this.createOrUpdateEdge(fromId, toId, "sequence");
      if (result === "created") edgesCreated++;
      else if (result === "updated") edgesUpdated++;
    }

    // Recompute metrics if changes were made
    if (edgesCreated > 0 || edgesUpdated > 0) {
      if (this.graph.order > 0) {
        await this.precomputeMetrics();
      }
    }

    const elapsed = performance.now() - startTime;
    log.info(
      `[updateFromCodeExecution] Processed ${traces.length} traces: ${edgesCreated} edges created, ${edgesUpdated} updated (${
        elapsed.toFixed(1)
      }ms)`,
    );
  }

  /**
   * ADR-041: Create or update an edge with type and source tracking
   *
   * @param fromId - Source node ID
   * @param toId - Target node ID
   * @param edgeType - Edge type: 'contains', 'sequence', or 'dependency'
   * @returns "created" | "updated" | "none"
   */
  private async createOrUpdateEdge(
    fromId: string,
    toId: string,
    edgeType: "contains" | "sequence" | "dependency",
  ): Promise<"created" | "updated" | "none"> {
    const baseWeight = GraphRAGEngine.EDGE_TYPE_WEIGHTS[edgeType];

    if (this.graph.hasEdge(fromId, toId)) {
      const edge = this.graph.getEdgeAttributes(fromId, toId);
      const newCount = (edge.count as number) + 1;

      // ADR-041: Update edge_source based on observation count
      let newSource = edge.edge_source as string || "inferred";
      if (newCount >= GraphRAGEngine.OBSERVED_THRESHOLD && newSource === "inferred") {
        newSource = "observed";
      }

      // ADR-041: Compute combined weight (type × source modifier)
      const sourceModifier = GraphRAGEngine.EDGE_SOURCE_MODIFIERS[newSource] || 0.7;
      const newWeight = baseWeight * sourceModifier;

      this.graph.setEdgeAttribute(fromId, toId, "count", newCount);
      this.graph.setEdgeAttribute(fromId, toId, "weight", newWeight);
      this.graph.setEdgeAttribute(fromId, toId, "edge_type", edgeType);
      this.graph.setEdgeAttribute(fromId, toId, "edge_source", newSource);

      this.emit({
        type: "edge_updated",
        data: {
          fromToolId: fromId,
          toToolId: toId,
          oldConfidence: edge.weight as number,
          newConfidence: newWeight,
          observedCount: newCount,
          edgeType: edgeType, // ADR-041
          edgeSource: newSource, // ADR-041
          timestamp: new Date().toISOString(),
        },
      });

      return "updated";
    } else {
      // ADR-041: New edge starts as 'inferred'
      const sourceModifier = GraphRAGEngine.EDGE_SOURCE_MODIFIERS["inferred"];
      const weight = baseWeight * sourceModifier;

      this.graph.addEdge(fromId, toId, {
        count: 1,
        weight: weight,
        source: "code_execution",
        edge_type: edgeType,
        edge_source: "inferred",
      });

      this.emit({
        type: "edge_created",
        data: {
          fromToolId: fromId,
          toToolId: toId,
          confidenceScore: weight,
          observedCount: 1, // ADR-041: new edges start at count=1
          edgeType: edgeType, // ADR-041
          edgeSource: "inferred", // ADR-041: new edges start as inferred
          timestamp: new Date().toISOString(),
        },
      });

      return "created";
    }
  }

  /**
   * Tech-spec Task 5: Persist capability→capability edge to capability_dependency table
   *
   * Uses UPSERT to handle repeated observations:
   * - First observation: creates with edge_source='inferred'
   * - 3+ observations: upgrades to edge_source='observed'
   *
   * @param fromCapabilityId - Source capability UUID
   * @param toCapabilityId - Target capability UUID
   * @param edgeType - Edge type: 'contains', 'sequence', 'dependency', 'alternative'
   */
  private async persistCapabilityDependency(
    fromCapabilityId: string,
    toCapabilityId: string,
    edgeType: "contains" | "sequence" | "dependency" | "alternative",
  ): Promise<void> {
    const baseWeight = GraphRAGEngine.EDGE_TYPE_WEIGHTS[edgeType];
    const inferredModifier = GraphRAGEngine.EDGE_SOURCE_MODIFIERS["inferred"];
    const observedModifier = GraphRAGEngine.EDGE_SOURCE_MODIFIERS["observed"];
    const threshold = GraphRAGEngine.OBSERVED_THRESHOLD;

    await this.db.query(
      `INSERT INTO capability_dependency (
        from_capability_id, to_capability_id, observed_count, confidence_score,
        edge_type, edge_source, created_at, last_observed
      ) VALUES ($1, $2, 1, $3, $4, 'inferred', NOW(), NOW())
      ON CONFLICT (from_capability_id, to_capability_id) DO UPDATE SET
        observed_count = capability_dependency.observed_count + 1,
        last_observed = NOW(),
        edge_source = CASE
          WHEN capability_dependency.observed_count + 1 >= $5
            AND capability_dependency.edge_source = 'inferred'
          THEN 'observed'
          ELSE capability_dependency.edge_source
        END,
        confidence_score = $6 * CASE
          WHEN capability_dependency.observed_count + 1 >= $5
            AND capability_dependency.edge_source = 'inferred'
          THEN $7
          ELSE $8
        END`,
      [
        fromCapabilityId,
        toCapabilityId,
        baseWeight * inferredModifier, // initial confidence
        edgeType,
        threshold,
        baseWeight,
        observedModifier,
        inferredModifier,
      ],
    );

    // Warn if contains cycle detected (potential paradox)
    if (edgeType === "contains") {
      const reverseExists = await this.db.queryOne(
        `SELECT 1 FROM capability_dependency
         WHERE from_capability_id = $1 AND to_capability_id = $2 AND edge_type = 'contains'`,
        [toCapabilityId, fromCapabilityId],
      );
      if (reverseExists) {
        log.warn(`Potential paradox: contains cycle detected between capabilities ${fromCapabilityId} ↔ ${toCapabilityId}`);
      }
    }
  }

  /**
   * Persist graph edges to database
   * ADR-041: Now persists edge_type and edge_source
   *
   * Saves all edges from Graphology back to PGlite for persistence.
   */
  private async persistEdgesToDB(): Promise<void> {
    for (const edge of this.graph.edges()) {
      const [from, to] = this.graph.extremities(edge);
      const attrs = this.graph.getEdgeAttributes(edge);

      // ADR-041: Include edge_type and edge_source in persistence
      await this.db.query(
        `
        INSERT INTO tool_dependency (from_tool_id, to_tool_id, observed_count, confidence_score, edge_type, edge_source)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (from_tool_id, to_tool_id) DO UPDATE SET
          observed_count = $3,
          confidence_score = $4,
          edge_type = $5,
          edge_source = $6,
          last_observed = NOW()
      `,
        [
          from,
          to,
          attrs.count,
          attrs.weight,
          attrs.edge_type || "sequence", // ADR-041: default for existing edges
          attrs.edge_source || "inferred", // ADR-041: default for existing edges
        ],
      );
    }
  }

  // ============================================
  // New methods for search_tools (Spike: search-tools-graph-traversal)
  // ============================================

  /**
   * Get edge count for adaptive alpha calculation
   */
  getEdgeCount(): number {
    return this.graph.size;
  }

  /**
   * Get edge data between two tools (Story 3.5-1)
   * ADR-041: Now includes edge_type and edge_source
   *
   * Returns the edge attributes if edge exists, null otherwise.
   *
   * @param fromToolId - Source tool
   * @param toToolId - Target tool
   * @returns Edge attributes or null
   */
  getEdgeData(fromToolId: string, toToolId: string): {
    weight: number;
    count: number;
    edge_type: string;
    edge_source: string;
  } | null {
    if (!this.graph.hasEdge(fromToolId, toToolId)) return null;

    const attrs = this.graph.getEdgeAttributes(fromToolId, toToolId);
    return {
      weight: attrs.weight as number,
      count: attrs.count as number,
      edge_type: (attrs.edge_type as string) || "sequence",
      edge_source: (attrs.edge_source as string) || "inferred",
    };
  }

  /**
   * Add or update edge between two tools (Story 3.5-1 AC #12)
   *
   * Used for agent hints and pattern import/export.
   *
   * @param fromToolId - Source tool
   * @param toToolId - Target tool
   * @param attributes - Edge attributes (weight, count, source)
   */
  async addEdge(
    fromToolId: string,
    toToolId: string,
    attributes: { weight: number; count: number; source?: string },
  ): Promise<void> {
    // Ensure nodes exist
    if (!this.graph.hasNode(fromToolId)) {
      this.graph.addNode(fromToolId, { type: "tool" });
    }
    if (!this.graph.hasNode(toToolId)) {
      this.graph.addNode(toToolId, { type: "tool" });
    }

    // Update or add edge
    if (this.graph.hasEdge(fromToolId, toToolId)) {
      this.graph.setEdgeAttribute(fromToolId, toToolId, "weight", attributes.weight);
      this.graph.setEdgeAttribute(fromToolId, toToolId, "count", attributes.count);
      if (attributes.source) {
        this.graph.setEdgeAttribute(fromToolId, toToolId, "source", attributes.source);
      }
    } else {
      this.graph.addEdge(fromToolId, toToolId, {
        weight: attributes.weight,
        count: attributes.count,
        source: attributes.source ?? "manual",
      });
    }
  }

  /**
   * Get all edges from the graph (Story 3.5-1 AC #13)
   *
   * Returns all edges with their attributes for export.
   *
   * @returns Array of edges with source, target, and attributes
   */
  getEdges(): Array<{
    source: string;
    target: string;
    attributes: Record<string, unknown>;
  }> {
    const edges: Array<{
      source: string;
      target: string;
      attributes: Record<string, unknown>;
    }> = [];

    this.graph.forEachEdge(
      (_edge: string, attrs: Record<string, unknown>, source: string, target: string) => {
        edges.push({
          source,
          target,
          attributes: { ...attrs },
        });
      },
    );

    return edges;
  }

  /**
   * Get neighbors of a tool
   *
   * @param toolId - Tool identifier
   * @param direction - 'in' (tools before), 'out' (tools after), 'both'
   * @returns Array of neighbor tool IDs
   */
  getNeighbors(toolId: string, direction: "in" | "out" | "both" = "both"): string[] {
    if (!this.graph.hasNode(toolId)) return [];

    switch (direction) {
      case "in":
        return this.graph.inNeighbors(toolId);
      case "out":
        return this.graph.outNeighbors(toolId);
      case "both":
        return this.graph.neighbors(toolId);
    }
  }

  /**
   * Compute Adamic-Adar similarity for a tool
   * ADR-041: Now weighted by edge type and source
   *
   * Finds tools that share common neighbors, weighted by neighbor rarity
   * AND by the edge quality (type × source modifier).
   *
   * Formula: AA(u,v) = Σ (edge_weight × 1/log(|N(w)|)) for all w in N(u) ∩ N(v)
   *
   * @param toolId - Tool identifier
   * @param limit - Max number of results
   * @returns Array of related tools with Adamic-Adar scores
   */
  computeAdamicAdar(toolId: string, limit = 10): Array<{ toolId: string; score: number }> {
    if (!this.graph.hasNode(toolId)) return [];

    const neighbors = new Set(this.graph.neighbors(toolId));
    const scores = new Map<string, number>();

    for (const neighbor of neighbors) {
      const degree = this.graph.degree(neighbor);
      if (degree <= 1) continue;

      // ADR-041: Get edge weight from toolId → neighbor
      let edgeWeight = 0.5; // default
      if (this.graph.hasEdge(toolId, neighbor)) {
        const attrs = this.graph.getEdgeAttributes(toolId, neighbor);
        edgeWeight = this.getEdgeWeight(
          attrs.edge_type as string || "sequence",
          attrs.edge_source as string || "inferred",
        );
      } else if (this.graph.hasEdge(neighbor, toolId)) {
        const attrs = this.graph.getEdgeAttributes(neighbor, toolId);
        edgeWeight = this.getEdgeWeight(
          attrs.edge_type as string || "sequence",
          attrs.edge_source as string || "inferred",
        );
      }

      for (const twoHop of this.graph.neighbors(neighbor)) {
        if (twoHop === toolId) continue;
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
   * Compute Adamic-Adar score between two specific tools
   *
   * @param toolId1 - First tool
   * @param toolId2 - Second tool
   * @returns Adamic-Adar score (0 if no common neighbors)
   */
  adamicAdarBetween(toolId1: string, toolId2: string): number {
    if (!this.graph.hasNode(toolId1) || !this.graph.hasNode(toolId2)) return 0;

    const neighbors1 = new Set(this.graph.neighbors(toolId1));
    const neighbors2 = new Set(this.graph.neighbors(toolId2));

    let score = 0;
    for (const neighbor of neighbors1) {
      if (neighbors2.has(neighbor)) {
        const degree = this.graph.degree(neighbor);
        if (degree > 1) {
          score += 1 / Math.log(degree);
        }
      }
    }

    return score;
  }

  /**
   * Compute graph relatedness of a tool to context tools
   *
   * Returns highest relatedness score (direct edge = 1.0, else Adamic-Adar)
   *
   * @param toolId - Tool to evaluate
   * @param contextTools - Tools already in context
   * @returns Normalized relatedness score (0-1)
   */
  computeGraphRelatedness(toolId: string, contextTools: string[]): number {
    if (contextTools.length === 0 || !this.graph.hasNode(toolId)) return 0;

    let maxScore = 0;
    for (const contextTool of contextTools) {
      if (!this.graph.hasNode(contextTool)) continue;

      // Direct neighbor = max score
      if (this.graph.hasEdge(contextTool, toolId) || this.graph.hasEdge(toolId, contextTool)) {
        return 1.0;
      }

      // Adamic-Adar score
      const aaScore = this.adamicAdarBetween(toolId, contextTool);
      maxScore = Math.max(maxScore, aaScore);
    }

    // Normalize (typical AA scores are 0-5, cap at 1.0)
    return Math.min(maxScore / 2, 1.0);
  }

  /**
   * Bootstrap graph with workflow templates
   * ADR-041: Template edges are marked with edge_source: 'template'
   *
   * Creates initial edges based on predefined workflow patterns.
   * Used to solve cold-start problem when no usage data exists.
   *
   * @param templates - Workflow templates with edges
   */
  async bootstrapFromTemplates(
    templates: Record<string, { edges: [string, string][] }>,
  ): Promise<void> {
    let edgesAdded = 0;

    for (const [_templateName, template] of Object.entries(templates)) {
      for (const [from, to] of template.edges) {
        if (this.graph.hasNode(from) && this.graph.hasNode(to)) {
          if (!this.graph.hasEdge(from, to)) {
            // ADR-041: Template edges get lowest confidence (type × template modifier)
            const baseWeight = GraphRAGEngine.EDGE_TYPE_WEIGHTS["dependency"];
            const sourceModifier = GraphRAGEngine.EDGE_SOURCE_MODIFIERS["template"];
            const weight = baseWeight * sourceModifier; // 1.0 × 0.5 = 0.5

            this.graph.addEdge(from, to, {
              count: 1,
              weight: weight,
              source: "template",
              edge_type: "dependency", // ADR-041: Templates create explicit dependencies
              edge_source: "template", // ADR-041: Mark as template-originated
            });
            edgesAdded++;
          }
        }
      }
    }

    if (edgesAdded > 0) {
      log.info(`✓ Bootstrapped graph with ${edgesAdded} template edges`);
      await this.precomputeMetrics();
    }
  }

  /**
   * Get graph statistics
   *
   * @returns Current graph stats including node/edge counts and metrics
   */
  getStats(): GraphStats {
    const nodeCount = this.graph.order;
    const avgPageRank = nodeCount > 0
      ? Object.values(this.pageRanks).reduce((a, b) => a + b, 0) / nodeCount
      : 0;

    return {
      nodeCount,
      edgeCount: this.graph.size,
      communities: new Set(Object.values(this.communities)).size,
      avgPageRank,
    };
  }

  /**
   * Get graph density (0-1)
   * Density = actual_edges / max_possible_edges
   */
  private getDensity(): number {
    const nodeCount = this.graph.order;
    if (nodeCount <= 1) return 0;

    const maxPossibleEdges = nodeCount * (nodeCount - 1); // directed graph
    return this.graph.size / maxPossibleEdges;
  }

  /**
   * Get top N tools by PageRank score
   */
  private getTopPageRank(n: number): Array<{ toolId: string; score: number }> {
    const entries = Object.entries(this.pageRanks)
      .sort(([, a], [, b]) => b - a)
      .slice(0, n);

    return entries.map(([toolId, score]) => ({ toolId, score }));
  }

  /**
   * Get total number of communities detected
   */
  private getCommunitiesCount(): number {
    return new Set(Object.values(this.communities)).size;
  }

  // ============================================
  // Story 6.2: Graph Visualization Dashboard
  // ============================================

  /**
   * Get complete graph snapshot for visualization
   *
   * Returns all nodes and edges with their attributes for rendering
   * in the dashboard interface.
   *
   * @returns GraphSnapshot containing nodes, edges, and metadata
   */
  getGraphSnapshot(): GraphSnapshot {
    const nodes = this.graph.nodes().map((toolId: string) => {
      // Tool IDs can be in format "server:tool_name" or "mcp__server__tool_name"
      // Support both formats for backward compatibility
      let server = "unknown";
      let label = toolId;

      if (toolId.includes(":")) {
        // Format: "server:tool_name" (e.g., "filesystem:read_file")
        const colonIndex = toolId.indexOf(":");
        server = toolId.substring(0, colonIndex);
        label = toolId.substring(colonIndex + 1);
      } else if (toolId.includes("__")) {
        // Format: "mcp__server__tool_name"
        const parts = toolId.split("__");
        if (parts.length >= 3) {
          server = parts[1];
          label = parts.slice(2).join("__");
        }
      }

      return {
        id: toolId,
        label,
        server,
        pagerank: this.pageRanks[toolId] || 0,
        degree: this.graph.degree(toolId),
        communityId: this.communities[toolId],
      };
    });

    const edges = this.graph.edges().map((edgeKey: string) => {
      const edge = this.graph.getEdgeAttributes(edgeKey);
      return {
        source: this.graph.source(edgeKey),
        target: this.graph.target(edgeKey),
        confidence: edge.weight ?? 0,
        observed_count: edge.count ?? 0,
        // ADR-041: Include edge_type and edge_source for visualization
        edge_type: (edge.edge_type as string) ?? "sequence",
        edge_source: (edge.edge_source as string) ?? "inferred",
      };
    });

    return {
      nodes,
      edges,
      metadata: {
        total_nodes: nodes.length,
        total_edges: edges.length,
        density: this.getDensity(),
        last_updated: new Date().toISOString(),
      },
    };
  }

  // ============================================
  // Story 6.4: Search Tools for Autocomplete
  // ============================================

  /**
   * Search tools for autocomplete suggestions (Story 6.4 AC10)
   *
   * Fast prefix-based search on tool name/server for autocomplete.
   * Returns results with pagerank for ranking display.
   *
   * @param query - Search query (min 2 chars)
   * @param limit - Maximum results (default: 10)
   * @returns Array of matching tools with metadata
   */
  searchToolsForAutocomplete(
    query: string,
    limit: number = 10,
  ): Array<{
    tool_id: string;
    name: string;
    server: string;
    description: string;
    score: number;
    pagerank: number;
  }> {
    if (query.length < 2) return [];

    const lowerQuery = query.toLowerCase();
    const results: Array<{
      tool_id: string;
      name: string;
      server: string;
      description: string;
      score: number;
      pagerank: number;
    }> = [];

    // Search through all nodes in graph
    this.graph.forEachNode(
      (
        toolId: string,
        attrs: { name?: string; serverId?: string; metadata?: { description?: string } },
      ) => {
        // Extract server and name from tool_id
        let server = "unknown";
        let name = toolId;

        if (toolId.includes(":")) {
          const colonIndex = toolId.indexOf(":");
          server = toolId.substring(0, colonIndex);
          name = toolId.substring(colonIndex + 1);
        } else if (toolId.includes("__")) {
          const parts = toolId.split("__");
          if (parts.length >= 3) {
            server = parts[1];
            name = parts.slice(2).join("__");
          }
        }

        const description = attrs.metadata?.description || attrs.name || "";
        const lowerName = name.toLowerCase();
        const lowerServer = server.toLowerCase();
        const lowerDescription = description.toLowerCase();

        // Score based on match quality
        let score = 0;

        // Exact name match = highest score
        if (lowerName === lowerQuery) {
          score = 1.0;
        } // Name starts with query = high score
        else if (lowerName.startsWith(lowerQuery)) {
          score = 0.9;
        } // Name contains query = medium score
        else if (lowerName.includes(lowerQuery)) {
          score = 0.7;
        } // Server matches = lower score
        else if (lowerServer.includes(lowerQuery)) {
          score = 0.5;
        } // Description contains query = lowest score
        else if (lowerDescription.includes(lowerQuery)) {
          score = 0.3;
        }

        if (score > 0) {
          results.push({
            tool_id: toolId,
            name,
            server,
            description: description.substring(0, 200), // Truncate for autocomplete
            score,
            pagerank: this.pageRanks[toolId] || 0,
          });
        }
      },
    );

    // Sort by score (desc), then by pagerank (desc)
    results.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.pagerank - a.pagerank;
    });

    return results.slice(0, limit);
  }

  // ============================================
  // Story 5.2 / ADR-022: Hybrid Search Integration
  // ============================================

  /**
   * Hybrid Search: Combines semantic search with graph-based recommendations (ADR-022)
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
   * @param query - Natural language search query
   * @param limit - Maximum number of results (default: 10)
   * @param contextTools - Tools already in context (boosts related tools)
   * @param includeRelated - Include related tools via graph neighbors (default: false)
   * @returns Sorted array of hybrid search results (highest finalScore first)
   */
  async searchToolsHybrid(
    vectorSearch: VectorSearch,
    query: string,
    limit: number = 10,
    contextTools: string[] = [],
    includeRelated: boolean = false,
  ): Promise<HybridSearchResult[]> {
    const startTime = performance.now();

    try {
      // 1. Calculate graph density for adaptive parameters
      const edgeCount = this.getEdgeCount();
      const nodeCount = this.getStats().nodeCount;
      const maxPossibleEdges = nodeCount * (nodeCount - 1); // directed graph
      const density = maxPossibleEdges > 0 ? edgeCount / maxPossibleEdges : 0;

      // ADR-023: Dynamic Candidate Expansion based on graph maturity
      // Cold start: 1.5x (trust semantic), Growing: 2.0x, Mature: 3.0x (find hidden gems)
      const expansionMultiplier = density < 0.01 ? 1.5 : density < 0.10 ? 2.0 : 3.0;
      const searchLimit = Math.ceil(limit * expansionMultiplier);

      // 2. Semantic search for base candidates with dynamic expansion
      const semanticResults = await vectorSearch.searchTools(query, searchLimit, 0.5);

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
      const results: HybridSearchResult[] = semanticResults.map((result) => {
        const graphScore = this.computeGraphRelatedness(result.toolId, contextTools);

        // ADR-048: Use local alpha per tool (Active Search mode)
        const localAlpha = this.localAlphaCalculator
          ? this.localAlphaCalculator.getLocalAlpha("active", result.toolId, "tool", contextTools)
          : globalAlpha;

        const finalScore = localAlpha * result.score + (1 - localAlpha) * graphScore;

        const hybridResult: HybridSearchResult = {
          toolId: result.toolId,
          serverId: result.serverId,
          toolName: result.toolName,
          description: result.schema?.description || "",
          semanticScore: Math.round(result.score * 100) / 100,
          graphScore: Math.round(graphScore * 100) / 100,
          finalScore: Math.round(finalScore * 100) / 100,
          schema: result.schema as unknown as Record<string, unknown>,
        };

        return hybridResult;
      });

      // 5. Sort by final score (descending) and limit
      results.sort((a, b) => b.finalScore - a.finalScore);
      const topResults = results.slice(0, limit);

      // 6. Add related tools if requested
      if (includeRelated) {
        for (const result of topResults) {
          result.relatedTools = [];

          // Get in-neighbors (tools often used BEFORE this one)
          const inNeighbors = this.getNeighbors(result.toolId, "in");
          for (const neighbor of inNeighbors.slice(0, 2)) {
            result.relatedTools.push({
              toolId: neighbor,
              relation: "often_before",
              score: 0.8,
            });
          }

          // Get out-neighbors (tools often used AFTER this one)
          const outNeighbors = this.getNeighbors(result.toolId, "out");
          for (const neighbor of outNeighbors.slice(0, 2)) {
            result.relatedTools.push({
              toolId: neighbor,
              relation: "often_after",
              score: 0.8,
            });
          }
        }
      }

      const elapsedMs = performance.now() - startTime;
      log.info(
        `[searchToolsHybrid] "${query}" → ${topResults.length} results (alpha=${
          alpha.toFixed(2)
        }, ${elapsedMs.toFixed(1)}ms)`,
      );

      return topResults;
    } catch (error) {
      log.error(`[searchToolsHybrid] Failed: ${error}`);
      // Graceful degradation: fall back to semantic-only
      try {
        const fallbackResults = await vectorSearch.searchTools(query, limit, 0.5);
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

  // ============================================
  // Story 6.3: Live Metrics & Analytics Panel
  // ============================================

  /**
   * Get adaptive alpha value for hybrid search (Story 6.3 AC2)
   *
   * Alpha controls the balance between semantic and graph scores:
   * - alpha=1.0: Pure semantic search (cold start, no graph data)
   * - alpha=0.5: Equal weight (dense graph)
   *
   * Formula: alpha = max(0.5, 1.0 - density * 2)
   *
   * @returns Alpha value between 0.5 and 1.0
   */
  getAdaptiveAlpha(): number {
    const nodeCount = this.graph.order;
    if (nodeCount <= 1) return 1.0;

    const maxPossibleEdges = nodeCount * (nodeCount - 1);
    const density = maxPossibleEdges > 0 ? this.graph.size / maxPossibleEdges : 0;
    return Math.max(0.5, 1.0 - density * 2);
  }

  /**
   * Get graph density (0-1) - public version for metrics (Story 6.3)
   *
   * Density = actual_edges / max_possible_edges
   */
  getGraphDensity(): number {
    return this.getDensity();
  }

  /**
   * Get the underlying Graphology graph instance (ADR-048)
   *
   * Used by LocalAlphaCalculator and other components that need
   * direct access to graph structure.
   */
  getGraph(): any {
    return this.graph;
  }

  /**
   * Get the LocalAlphaCalculator instance (ADR-048)
   *
   * Returns the calculator for components that need to compute local alpha
   * (e.g., DAGSuggester for passive suggestions).
   */
  getLocalAlphaCalculator(): LocalAlphaCalculator | null {
    return this.localAlphaCalculator;
  }

  /**
   * Get top N tools by PageRank - public version for metrics (Story 6.3)
   */
  getPageRankTop(n: number): Array<{ toolId: string; score: number }> {
    return this.getTopPageRank(n);
  }

  /**
   * Get total communities count - public version for metrics (Story 6.3)
   */
  getTotalCommunities(): number {
    return this.getCommunitiesCount();
  }

  /**
   * Get comprehensive metrics for dashboard (Story 6.3 AC4)
   *
   * Aggregates current snapshot, time series data, and period statistics.
   *
   * @param range - Time range for historical data ("1h", "24h", "7d")
   * @returns Complete metrics response for dashboard
   */
  async getMetrics(range: MetricsTimeRange): Promise<GraphMetricsResponse> {
    const startTime = performance.now();

    // Calculate interval for time range
    const intervalHours = range === "1h" ? 1 : range === "24h" ? 24 : 168; // 7d = 168h
    const intervalMs = intervalHours * 60 * 60 * 1000;
    const startDate = new Date(Date.now() - intervalMs);

    // Current snapshot metrics + extended counts
    const [capCount, embCount, depCount] = await Promise.all([
      this.db.query("SELECT COUNT(*) as cnt FROM workflow_pattern").then(r => Number(r[0]?.cnt) || 0).catch(() => 0),
      this.db.query("SELECT COUNT(*) as cnt FROM tool_embedding").then(r => Number(r[0]?.cnt) || 0).catch(() => 0),
      this.db.query("SELECT COUNT(*) as cnt FROM tool_dependency").then(r => Number(r[0]?.cnt) || 0).catch(() => 0),
    ]);

    // ADR-048: Fetch local alpha stats from recent traces
    const localAlphaStats = await this.getLocalAlphaStats(startDate);

    const current = {
      nodeCount: this.graph.order,
      edgeCount: this.graph.size,
      density: this.getDensity(),
      adaptiveAlpha: this.getAdaptiveAlpha(), // @deprecated - kept for backward compatibility
      communitiesCount: this.getCommunitiesCount(),
      pagerankTop10: this.getTopPageRank(10),
      capabilitiesCount: capCount,
      embeddingsCount: embCount,
      dependenciesCount: depCount,
      localAlpha: localAlphaStats, // ADR-048
    };

    // Fetch time series data
    const timeseries = await this.getMetricsTimeSeries(range, startDate);

    // Fetch period statistics
    const period = await this.getPeriodStats(range, startDate);

    // Fetch algorithm tracing statistics
    const algorithm = await this.getAlgorithmStats(startDate);

    const elapsed = performance.now() - startTime;
    log.debug(`[getMetrics] Collected metrics in ${elapsed.toFixed(1)}ms (range=${range})`);

    return {
      current,
      timeseries,
      period,
      algorithm,
    };
  }

  /**
   * Get local alpha statistics from recent traces (ADR-048)
   *
   * Queries algorithm_traces to compute:
   * - Average alpha across all traces
   * - Average alpha by mode (active_search vs passive_suggestion)
   * - Algorithm distribution (which alpha algorithm was used)
   * - Cold start percentage
   *
   * @param startDate - Start date for the query window
   * @returns Local alpha statistics or undefined if no data
   */
  private async getLocalAlphaStats(startDate: Date): Promise<GraphMetricsResponse["current"]["localAlpha"]> {
    const isoDate = startDate.toISOString();

    try {
      // Query alpha stats from algorithm_traces
      const result = await this.db.query(`
        SELECT
          AVG((params->>'alpha')::float) as avg_alpha,
          AVG((params->>'alpha')::float) FILTER (WHERE algorithm_mode = 'active_search') as avg_alpha_active,
          AVG((params->>'alpha')::float) FILTER (WHERE algorithm_mode = 'passive_suggestion') as avg_alpha_passive,
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE (signals->>'coldStart')::boolean = true) as cold_start_count,
          COUNT(*) FILTER (WHERE signals->>'alphaAlgorithm' = 'embeddings_hybrides') as emb_hybrides,
          COUNT(*) FILTER (WHERE signals->>'alphaAlgorithm' = 'heat_diffusion') as heat_diff,
          COUNT(*) FILTER (WHERE signals->>'alphaAlgorithm' = 'heat_hierarchical') as heat_hier,
          COUNT(*) FILTER (WHERE signals->>'alphaAlgorithm' = 'bayesian') as bayesian,
          COUNT(*) FILTER (WHERE signals->>'alphaAlgorithm' = 'none' OR signals->>'alphaAlgorithm' IS NULL) as none_algo
        FROM algorithm_traces
        WHERE timestamp >= $1
        AND params->>'alpha' IS NOT NULL
      `, [isoDate]);

      const row = result[0];
      if (!row || Number(row.total) === 0) {
        return undefined; // No data
      }

      const total = Number(row.total) || 1;

      return {
        avgAlpha: Number(row.avg_alpha) || 0.75,
        byMode: {
          activeSearch: Number(row.avg_alpha_active) || 0,
          passiveSuggestion: Number(row.avg_alpha_passive) || 0,
        },
        algorithmDistribution: {
          embeddingsHybrides: Number(row.emb_hybrides) || 0,
          heatDiffusion: Number(row.heat_diff) || 0,
          heatHierarchical: Number(row.heat_hier) || 0,
          bayesian: Number(row.bayesian) || 0,
          none: Number(row.none_algo) || 0,
        },
        coldStartPercentage: (Number(row.cold_start_count) / total) * 100,
      };
    } catch (error) {
      log.error(`[getLocalAlphaStats] Failed: ${error}`);
      return undefined;
    }
  }

  /**
   * Get algorithm tracing statistics (Story 7.6, ADR-039)
   *
   * ADR-039 adds:
   * - byGraphType: Separation of graph vs hypergraph algorithm stats
   * - thresholdEfficiency: Rejection rate metrics
   * - scoreDistribution: Score histograms by graph type
   * - byMode: Stats by algorithm mode (active_search vs passive_suggestion)
   */
  private async getAlgorithmStats(startDate: Date): Promise<GraphMetricsResponse["algorithm"]> {
    const isoDate = startDate.toISOString();

    try {
      // Base stats query (existing)
      const statsResult = await this.db.query(`
        SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE decision = 'accepted') as accepted,
          COUNT(*) FILTER (WHERE decision LIKE 'filtered%') as filtered,
          COUNT(*) FILTER (WHERE decision LIKE 'rejected%') as rejected,
          COUNT(*) FILTER (WHERE target_type = 'tool') as tools,
          COUNT(*) FILTER (WHERE target_type = 'capability') as capabilities,
          AVG(final_score) as avg_final,
          AVG((signals->>'semanticScore')::float) as avg_semantic,
          AVG((signals->>'graphScore')::float) as avg_graph
        FROM algorithm_traces
        WHERE timestamp >= $1
      `, [isoDate]);

      const stats = statsResult[0] || {};
      const total = Number(stats.total) || 0;

      // ADR-039: Graph vs Hypergraph stats
      // hypergraph if target_type = 'capability' OR signals.spectralClusterMatch IS NOT NULL
      const graphTypeResult = await this.db.query(`
        SELECT
          CASE
            WHEN target_type = 'capability' OR signals->>'spectralClusterMatch' IS NOT NULL
            THEN 'hypergraph'
            ELSE 'graph'
          END as graph_type,
          COUNT(*) as count,
          AVG(final_score) as avg_score,
          COUNT(*) FILTER (WHERE decision = 'accepted')::float / NULLIF(COUNT(*), 0) as acceptance_rate,
          AVG((signals->>'pagerank')::float) as avg_pagerank,
          AVG((signals->>'adamicAdar')::float) as avg_adamic_adar,
          AVG((signals->>'cooccurrence')::float) as avg_cooccurrence
        FROM algorithm_traces
        WHERE timestamp >= $1
        GROUP BY graph_type
      `, [isoDate]);

      // Parse graph type results
      const graphStats = { count: 0, avgScore: 0, acceptanceRate: 0, topSignals: { pagerank: 0, adamicAdar: 0, cooccurrence: 0 } };
      const hypergraphStats = { count: 0, avgScore: 0, acceptanceRate: 0 };

      for (const row of graphTypeResult) {
        if (row.graph_type === "graph") {
          graphStats.count = Number(row.count) || 0;
          graphStats.avgScore = Number(row.avg_score) || 0;
          graphStats.acceptanceRate = Number(row.acceptance_rate) || 0;
          graphStats.topSignals = {
            pagerank: Number(row.avg_pagerank) || 0,
            adamicAdar: Number(row.avg_adamic_adar) || 0,
            cooccurrence: Number(row.avg_cooccurrence) || 0,
          };
        } else if (row.graph_type === "hypergraph") {
          hypergraphStats.count = Number(row.count) || 0;
          hypergraphStats.avgScore = Number(row.avg_score) || 0;
          hypergraphStats.acceptanceRate = Number(row.acceptance_rate) || 0;
        }
      }

      // ADR-039: Spectral relevance (hypergraph only)
      const spectralResult = await this.db.query(`
        SELECT
          COALESCE((signals->>'spectralClusterMatch')::boolean, false) as cluster_match,
          COUNT(*) as count,
          AVG(final_score) as avg_score,
          COUNT(*) FILTER (WHERE outcome->>'userAction' = 'selected')::float / NULLIF(COUNT(*), 0) as selected_rate
        FROM algorithm_traces
        WHERE timestamp >= $1
          AND (target_type = 'capability' OR signals->>'spectralClusterMatch' IS NOT NULL)
        GROUP BY cluster_match
      `, [isoDate]);

      const spectralRelevance = {
        withClusterMatch: { count: 0, avgScore: 0, selectedRate: 0 },
        withoutClusterMatch: { count: 0, avgScore: 0, selectedRate: 0 },
      };

      for (const row of spectralResult) {
        const target = row.cluster_match ? spectralRelevance.withClusterMatch : spectralRelevance.withoutClusterMatch;
        target.count = Number(row.count) || 0;
        target.avgScore = Number(row.avg_score) || 0;
        target.selectedRate = Number(row.selected_rate) || 0;
      }

      // ADR-039: Score distribution by graph type
      const distributionResult = await this.db.query(`
        SELECT
          CASE
            WHEN target_type = 'capability' OR signals->>'spectralClusterMatch' IS NOT NULL
            THEN 'hypergraph'
            ELSE 'graph'
          END as graph_type,
          CONCAT(FLOOR(final_score * 10)::int / 10.0, '-', (FLOOR(final_score * 10)::int + 1) / 10.0) as bucket,
          COUNT(*) as count
        FROM algorithm_traces
        WHERE timestamp >= $1
        GROUP BY graph_type, FLOOR(final_score * 10)
        ORDER BY graph_type, FLOOR(final_score * 10)
      `, [isoDate]);

      const scoreDistribution: { graph: Array<{ bucket: string; count: number }>; hypergraph: Array<{ bucket: string; count: number }> } = {
        graph: [],
        hypergraph: [],
      };

      for (const row of distributionResult) {
        const entry = { bucket: String(row.bucket), count: Number(row.count) || 0 };
        if (row.graph_type === "graph") {
          scoreDistribution.graph.push(entry);
        } else {
          scoreDistribution.hypergraph.push(entry);
        }
      }

      // ADR-039: Stats by mode
      const modeResult = await this.db.query(`
        SELECT
          algorithm_mode,
          COUNT(*) as count,
          AVG(final_score) as avg_score,
          COUNT(*) FILTER (WHERE decision = 'accepted')::float / NULLIF(COUNT(*), 0) as acceptance_rate
        FROM algorithm_traces
        WHERE timestamp >= $1
        GROUP BY algorithm_mode
      `, [isoDate]);

      const byMode = {
        activeSearch: { count: 0, avgScore: 0, acceptanceRate: 0 },
        passiveSuggestion: { count: 0, avgScore: 0, acceptanceRate: 0 },
      };

      for (const row of modeResult) {
        const mode = String(row.algorithm_mode || "").toLowerCase();
        if (mode === "active_search" || mode === "activesearch") {
          byMode.activeSearch = {
            count: Number(row.count) || 0,
            avgScore: Number(row.avg_score) || 0,
            acceptanceRate: Number(row.acceptance_rate) || 0,
          };
        } else if (mode === "passive_suggestion" || mode === "passivesuggestion") {
          byMode.passiveSuggestion = {
            count: Number(row.count) || 0,
            avgScore: Number(row.avg_score) || 0,
            acceptanceRate: Number(row.acceptance_rate) || 0,
          };
        }
      }

      // ADR-039: Threshold efficiency
      const thresholdResult = await this.db.query(`
        SELECT
          COUNT(*) as total_evaluated,
          COUNT(*) FILTER (WHERE decision LIKE 'rejected%' OR decision LIKE 'filtered%') as rejected_by_threshold
        FROM algorithm_traces
        WHERE timestamp >= $1
      `, [isoDate]);

      const thresholdStats = thresholdResult[0] || {};
      const totalEvaluated = Number(thresholdStats.total_evaluated) || 0;
      const rejectedByThreshold = Number(thresholdStats.rejected_by_threshold) || 0;

      return {
        tracesCount: total,
        acceptanceRate: total > 0 ? (Number(stats.accepted) || 0) / total : 0,
        avgFinalScore: Number(stats.avg_final) || 0,
        avgSemanticScore: Number(stats.avg_semantic) || 0,
        avgGraphScore: Number(stats.avg_graph) || 0,
        byDecision: {
          accepted: Number(stats.accepted) || 0,
          filtered: Number(stats.filtered) || 0,
          rejected: Number(stats.rejected) || 0,
        },
        byTargetType: {
          tool: Number(stats.tools) || 0,
          capability: Number(stats.capabilities) || 0,
        },
        // ADR-039 extensions
        byGraphType: {
          graph: graphStats,
          hypergraph: {
            ...hypergraphStats,
            spectralRelevance,
          },
        },
        thresholdEfficiency: {
          rejectedByThreshold,
          totalEvaluated,
          rejectionRate: totalEvaluated > 0 ? rejectedByThreshold / totalEvaluated : 0,
        },
        scoreDistribution,
        byMode,
      };
    } catch (error) {
      log.warn(`[getAlgorithmStats] Query failed: ${error}`);
      return {
        tracesCount: 0,
        acceptanceRate: 0,
        avgFinalScore: 0,
        avgSemanticScore: 0,
        avgGraphScore: 0,
        byDecision: { accepted: 0, filtered: 0, rejected: 0 },
        byTargetType: { tool: 0, capability: 0 },
        byGraphType: {
          graph: { count: 0, avgScore: 0, acceptanceRate: 0, topSignals: { pagerank: 0, adamicAdar: 0, cooccurrence: 0 } },
          hypergraph: {
            count: 0,
            avgScore: 0,
            acceptanceRate: 0,
            spectralRelevance: {
              withClusterMatch: { count: 0, avgScore: 0, selectedRate: 0 },
              withoutClusterMatch: { count: 0, avgScore: 0, selectedRate: 0 },
            },
          },
        },
        thresholdEfficiency: { rejectedByThreshold: 0, totalEvaluated: 0, rejectionRate: 0 },
        scoreDistribution: { graph: [], hypergraph: [] },
        byMode: {
          activeSearch: { count: 0, avgScore: 0, acceptanceRate: 0 },
          passiveSuggestion: { count: 0, avgScore: 0, acceptanceRate: 0 },
        },
      };
    }
  }

  /**
   * Get time series data for metrics charts (Story 6.3 AC3)
   *
   * Queries metrics table for historical data points.
   *
   * @param range - Time range
   * @param startDate - Start date for query
   * @returns Time series data for charts
   */
  private async getMetricsTimeSeries(
    range: MetricsTimeRange,
    startDate: Date,
  ): Promise<{
    edgeCount: TimeSeriesPoint[];
    avgConfidence: TimeSeriesPoint[];
    workflowRate: TimeSeriesPoint[];
  }> {
    // Determine bucket size based on range
    const bucketMinutes = range === "1h" ? 5 : range === "24h" ? 60 : 360; // 6h buckets for 7d

    try {
      // Query edge count over time from metrics table
      const edgeCountResult = await this.db.query(
        `
        SELECT
          date_trunc('hour', timestamp) +
          (EXTRACT(minute FROM timestamp)::int / $1) * interval '1 minute' * $1 as bucket,
          AVG(value) as avg_value
        FROM metrics
        WHERE metric_name = 'graph_edge_count'
          AND timestamp >= $2
        GROUP BY bucket
        ORDER BY bucket
        `,
        [bucketMinutes, startDate.toISOString()],
      );

      // Query average confidence score over time
      const avgConfidenceResult = await this.db.query(
        `
        SELECT
          date_trunc('hour', timestamp) +
          (EXTRACT(minute FROM timestamp)::int / $1) * interval '1 minute' * $1 as bucket,
          AVG(value) as avg_value
        FROM metrics
        WHERE metric_name = 'avg_confidence_score'
          AND timestamp >= $2
        GROUP BY bucket
        ORDER BY bucket
        `,
        [bucketMinutes, startDate.toISOString()],
      );

      // Query workflow execution rate (workflows per hour)
      const workflowRateResult = await this.db.query(
        `
        SELECT
          date_trunc('hour', executed_at) as bucket,
          COUNT(*) as count
        FROM workflow_execution
        WHERE executed_at >= $1
        GROUP BY bucket
        ORDER BY bucket
        `,
        [startDate.toISOString()],
      );

      return {
        edgeCount: edgeCountResult.map((row: Record<string, unknown>) => ({
          timestamp: String(row.bucket),
          value: Number(row.avg_value) || 0,
        })),
        avgConfidence: avgConfidenceResult.map((row: Record<string, unknown>) => ({
          timestamp: String(row.bucket),
          value: Number(row.avg_value) || 0,
        })),
        workflowRate: workflowRateResult.map((row: Record<string, unknown>) => ({
          timestamp: String(row.bucket),
          value: Number(row.count) || 0,
        })),
      };
    } catch (error) {
      log.warn(`[getMetricsTimeSeries] Query failed, returning empty data: ${error}`);
      return {
        edgeCount: [],
        avgConfidence: [],
        workflowRate: [],
      };
    }
  }

  /**
   * Get period statistics (Story 6.3 AC2)
   *
   * @param range - Time range
   * @param startDate - Start date for query
   * @returns Period statistics
   */
  private async getPeriodStats(
    range: MetricsTimeRange,
    startDate: Date,
  ): Promise<{
    range: MetricsTimeRange;
    workflowsExecuted: number;
    workflowsSuccessRate: number;
    newEdgesCreated: number;
    newNodesAdded: number;
  }> {
    try {
      // Workflow statistics
      const workflowStats = await this.db.query(
        `
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN success THEN 1 ELSE 0 END) as successful
        FROM workflow_execution
        WHERE executed_at >= $1
        `,
        [startDate.toISOString()],
      );

      const total = Number(workflowStats[0]?.total) || 0;
      const successful = Number(workflowStats[0]?.successful) || 0;
      const successRate = total > 0 ? (successful / total) * 100 : 0;

      // New edges created in period
      const newEdges = await this.db.query(
        `
        SELECT COUNT(*) as count
        FROM tool_dependency
        WHERE last_observed >= $1
        `,
        [startDate.toISOString()],
      );

      // New nodes added (tools embedded in period) - approximate via metrics
      const newNodes = await this.db.query(
        `
        SELECT COUNT(DISTINCT metadata->>'tool_id') as count
        FROM metrics
        WHERE metric_name = 'tool_embedded'
          AND timestamp >= $1
        `,
        [startDate.toISOString()],
      );

      return {
        range,
        workflowsExecuted: total,
        workflowsSuccessRate: Math.round(successRate * 10) / 10,
        newEdgesCreated: Number(newEdges[0]?.count) || 0,
        newNodesAdded: Number(newNodes[0]?.count) || 0,
      };
    } catch (error) {
      log.warn(`[getPeriodStats] Query failed, returning zeros: ${error}`);
      return {
        range,
        workflowsExecuted: 0,
        workflowsSuccessRate: 0,
        newEdgesCreated: 0,
        newNodesAdded: 0,
      };
    }
  }
}

// ============================================
// Story 6.2: Graph Snapshot Types
// ============================================

/**
 * Graph snapshot for visualization dashboard
 * ADR-041: Added edge_type and edge_source for visual differentiation
 */
export interface GraphSnapshot {
  nodes: Array<{
    id: string;
    label: string;
    server: string;
    pagerank: number;
    degree: number;
    /** Louvain community ID for clustering visualization */
    communityId?: string;
  }>;
  edges: Array<{
    source: string;
    target: string;
    confidence: number;
    observed_count: number;
    /** ADR-041: Edge type - 'contains', 'sequence', or 'dependency' */
    edge_type: string;
    /** ADR-041: Edge source - 'observed', 'inferred', or 'template' */
    edge_source: string;
  }>;
  metadata: {
    total_nodes: number;
    total_edges: number;
    density: number;
    last_updated: string;
  };
}
