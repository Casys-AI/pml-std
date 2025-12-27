/**
 * GraphRAG Engine - Facade
 *
 * Implements true graph algorithms (PageRank, Louvain, path finding) for
 * intelligent DAG construction and tool dependency analysis.
 *
 * This facade delegates to specialized modules:
 * - algorithms/: PageRank, Louvain, pathfinding, Adamic-Adar
 * - sync/: Database sync, event emission
 * - search/: Hybrid search, autocomplete
 * - metrics/: Dashboard metrics collection
 *
 * @module graphrag/graph-engine
 */

// @ts-ignore: NPM module resolution
import graphologyPkg from "graphology";
import * as log from "@std/log";
import type { DbClient } from "../db/types.ts";
import type { VectorSearch } from "../vector/search.ts";
import type {
  DAGStructure,
  GraphMetricsResponse,
  GraphStats,
  HybridSearchResult,
  MetricsTimeRange,
  Task,
  WorkflowExecution,
} from "./types.ts";
import type { GraphEvent } from "./events.ts";
import type { TraceEvent } from "../sandbox/types.ts";
import type { AlgorithmTracer } from "../telemetry/algorithm-tracer.ts";

// Core types from graph-store (single source of truth)
import type { GraphSnapshot } from "./core/graph-store.ts";
export type { GraphSnapshot };

// Extracted modules
import { computePageRank, getAveragePageRank, getTopPageRankNodes } from "./algorithms/pagerank.ts";
import {
  detectCommunities,
  findCommunityMembers as findCommunityMembersAlgo,
  getCommunityCount,
} from "./algorithms/louvain.ts";
import { findShortestPath } from "./algorithms/pathfinding.ts";
import { buildDAG as buildDAGFromGraph } from "./dag/builder.ts";
import {
  createOrUpdateEdge,
  learnSequenceEdgesFromTasks,
  type TaskResultWithLayer,
  updateFromCodeExecution as updateFromCodeExecutionImpl,
} from "./dag/execution-learning.ts";
import {
  adamicAdarBetween,
  computeAdamicAdar,
  computeGraphRelatedness,
  getNeighbors,
} from "./algorithms/adamic-adar.ts";
import {
  EDGE_SOURCE_MODIFIERS,
  EDGE_TYPE_WEIGHTS,
  getEdgeWeight,
} from "./algorithms/edge-weights.ts";
import {
  persistEdgesToDatabase,
  persistWorkflowExecution,
  syncGraphFromDatabase,
} from "./sync/db-sync.ts";
import { GraphEventEmitter } from "./sync/event-emitter.ts";
import {
  calculateAdaptiveAlpha,
  calculateGraphDensity,
  searchToolsHybrid as hybridSearch,
} from "./search/hybrid-search.ts";
import { parseToolId, searchToolsForAutocomplete } from "./search/autocomplete.ts";
import { collectMetrics } from "./metrics/collector.ts";
import { LocalAlphaCalculator, type NodeType } from "./local-alpha.ts";

const { DirectedGraph } = graphologyPkg as any;

/**
 * GraphRAG Engine - Facade
 *
 * Hybrid approach: PGlite for persistence, Graphology for graph computations.
 */
export class GraphRAGEngine {
  private graph: any;
  private pageRanks: Record<string, number> = {};
  private communities: Record<string, string> = {};
  private eventEmitter: GraphEventEmitter;
  private localAlphaCalculator: LocalAlphaCalculator | null = null;
  private algorithmTracer: AlgorithmTracer | null = null;

  constructor(private db: DbClient) {
    this.graph = new DirectedGraph({ allowSelfLoops: false });
    this.eventEmitter = new GraphEventEmitter();
    this.initLocalAlphaCalculator();
  }

  private initLocalAlphaCalculator(): void {
    this.localAlphaCalculator = new LocalAlphaCalculator({
      graph: this.graph,
      spectralClustering: null,
      getSemanticEmbedding: (_nodeId: string) => null,
      getObservationCount: (nodeId: string) => this.getNodeObservationCount(nodeId),
      getParent: (_nodeId: string, _parentType: NodeType) => null,
      getChildren: (_nodeId: string, _childType: NodeType) => [],
    });
  }

  private getNodeObservationCount(nodeId: string): number {
    if (!this.graph.hasNode(nodeId)) return 0;
    let totalWeight = 0;
    this.graph.forEachEdge(nodeId, (_edge: string, attrs: any) => {
      totalWeight += attrs.weight || 1;
    });
    return Math.floor(totalWeight);
  }

  // === Event API ===

  on(event: "graph_event", listener: (event: GraphEvent) => void): void {
    this.eventEmitter.on(event, listener);
  }

  off(event: "graph_event", listener: (event: GraphEvent) => void): void {
    this.eventEmitter.off(event, listener);
  }

  // === Database Sync ===

  async syncFromDatabase(): Promise<void> {
    const result = await syncGraphFromDatabase(this.db, this.graph);

    if (this.graph.order > 0) {
      await this.precomputeMetrics();
    }

    this.eventEmitter.emitGraphSynced({
      nodeCount: result.nodeCount,
      edgeCount: result.edgeCount,
      syncDurationMs: result.syncDurationMs,
    });
  }

  private async precomputeMetrics(): Promise<void> {
    const startTime = performance.now();
    try {
      const prResult = computePageRank(this.graph, { weighted: true, tolerance: 0.0001 });
      this.pageRanks = prResult.scores;

      const louvainResult = detectCommunities(this.graph, { resolution: 1.0 });
      this.communities = louvainResult.communities;

      log.info(`✓ Graph metrics computed (${(performance.now() - startTime).toFixed(1)}ms)`);
    } catch (error) {
      log.error(`Graph metrics computation failed: ${error}`);
      this.pageRanks = {};
      this.communities = {};
    }
  }

  // === PageRank & Community ===

  getPageRank(toolId: string): number {
    return this.pageRanks[toolId] || 0;
  }

  getCommunity(toolId: string): string | undefined {
    return this.communities[toolId];
  }

  findCommunityMembers(toolId: string): string[] {
    return findCommunityMembersAlgo(this.communities, toolId);
  }

  // === Tool Metadata ===

  /**
   * Get tool node metadata (name, serverId, metadata including schema)
   */
  getToolNode(
    toolId: string,
  ):
    | { name: string; serverId: string; description: string; schema?: { inputSchema?: unknown } }
    | null {
    if (!this.graph.hasNode(toolId)) return null;
    const attrs = this.graph.getNodeAttributes(toolId);
    // Extract description from metadata or generate from tool name
    const metadata = attrs.metadata as Record<string, unknown> | undefined;
    return {
      name: attrs.name as string ?? toolId.split(":")[1] ?? toolId,
      serverId: attrs.serverId as string ?? toolId.split(":")[0] ?? "unknown",
      description: (metadata?.description as string) ?? `Tool: ${attrs.name ?? toolId}`,
      schema: metadata?.schema as { inputSchema?: unknown } | undefined,
    };
  }

  // === Edge Weights (ADR-041) ===

  getEdgeWeight(edgeType: string, edgeSource: string): number {
    return getEdgeWeight(edgeType, edgeSource);
  }

  // === Path Finding ===

  findShortestPath(fromToolId: string, toToolId: string): string[] | null {
    return findShortestPath(this.graph, fromToolId, toToolId);
  }

  // === DAG Building ===

  buildDAG(candidateTools: string[]): DAGStructure {
    return buildDAGFromGraph(this.graph, candidateTools);
  }

  // === Execution Learning ===

  async updateFromExecution(execution: WorkflowExecution): Promise<void> {
    const startTime = performance.now();
    const toolIds = execution.dagStructure.tasks.map((t: Task) => t.tool);

    for (const task of execution.dagStructure.tasks) {
      for (const depTaskId of task.dependsOn) {
        const depTask = execution.dagStructure.tasks.find((t: Task) => t.id === depTaskId);
        if (!depTask || depTask.tool === task.tool) continue;

        await createOrUpdateEdge(
          this.graph,
          depTask.tool,
          task.tool,
          "dependency",
          this.eventEmitter,
        );
      }
    }

    if (this.graph.order > 0) await this.precomputeMetrics();
    await persistEdgesToDatabase(this.db, this.graph);
    await persistWorkflowExecution(this.db, {
      intentText: execution.intentText,
      dagStructure: execution.dagStructure,
      success: execution.success,
      executionTimeMs: execution.executionTimeMs,
      errorMessage: execution.errorMessage,
      userId: execution.userId,
    });

    this.eventEmitter.emitWorkflowExecuted({
      workflowId: execution.executionId,
      toolIds,
      success: execution.success,
      executionTimeMs: performance.now() - startTime,
    });
  }

  async updateFromCodeExecution(traces: TraceEvent[]): Promise<void> {
    await updateFromCodeExecutionImpl(this.graph, this.db, traces, this.eventEmitter);
    if (this.graph.order > 0) await this.precomputeMetrics();
  }

  /**
   * Learn sequence edges from task results with layerIndex (Story 11.4)
   *
   * Creates fan-in/fan-out edges based on DAG layer execution:
   * - All tasks in layer N connect to all tasks in layer N+1
   *
   * @param tasks - Task results with tool and layerIndex
   */
  async learnFromTaskResults(tasks: TaskResultWithLayer[]): Promise<void> {
    const result = await learnSequenceEdgesFromTasks(this.graph, tasks, this.eventEmitter);
    if (result.edgesCreated > 0 || result.edgesUpdated > 0) {
      await persistEdgesToDatabase(this.db, this.graph);
      if (this.graph.order > 0) await this.precomputeMetrics();
    }
  }

  // === Graph Accessors ===

  getEdgeCount(): number {
    return this.graph.size;
  }
  getEdgeData(from: string, to: string) {
    if (!this.graph.hasEdge(from, to)) return null;
    const attrs = this.graph.getEdgeAttributes(from, to);
    return {
      weight: attrs.weight as number,
      count: attrs.count as number,
      edge_type: (attrs.edge_type as string) || "sequence",
      edge_source: (attrs.edge_source as string) || "inferred",
    };
  }

  async addEdge(
    from: string,
    to: string,
    attrs: { weight: number; count: number; source?: string },
  ) {
    if (!this.graph.hasNode(from)) this.graph.addNode(from, { type: "tool" });
    if (!this.graph.hasNode(to)) this.graph.addNode(to, { type: "tool" });
    if (this.graph.hasEdge(from, to)) {
      this.graph.setEdgeAttribute(from, to, "weight", attrs.weight);
      this.graph.setEdgeAttribute(from, to, "count", attrs.count);
    } else {
      this.graph.addEdge(from, to, {
        weight: attrs.weight,
        count: attrs.count,
        source: attrs.source ?? "manual",
      });
    }
  }

  getEdges() {
    const edges: Array<{ source: string; target: string; attributes: Record<string, unknown> }> =
      [];
    this.graph.forEachEdge(
      (_edge: string, attrs: Record<string, unknown>, source: string, target: string) => {
        edges.push({ source, target, attributes: { ...attrs } });
      },
    );
    return edges;
  }

  getNeighbors(toolId: string, direction: "in" | "out" | "both" = "both"): string[] {
    return getNeighbors(this.graph, toolId, direction);
  }

  computeAdamicAdar(toolId: string, limit = 10) {
    return computeAdamicAdar(this.graph, toolId, limit);
  }

  adamicAdarBetween(toolId1: string, toolId2: string): number {
    return adamicAdarBetween(this.graph, toolId1, toolId2);
  }

  computeGraphRelatedness(toolId: string, contextTools: string[]): number {
    return computeGraphRelatedness(this.graph, toolId, contextTools);
  }

  async bootstrapFromTemplates(templates: Record<string, { edges: [string, string][] }>) {
    let edgesAdded = 0;
    for (const [_, template] of Object.entries(templates)) {
      for (const [from, to] of template.edges) {
        if (this.graph.hasNode(from) && this.graph.hasNode(to) && !this.graph.hasEdge(from, to)) {
          const weight = EDGE_TYPE_WEIGHTS["dependency"] * EDGE_SOURCE_MODIFIERS["template"];
          this.graph.addEdge(from, to, {
            count: 1,
            weight,
            source: "template",
            edge_type: "dependency",
            edge_source: "template",
          });
          edgesAdded++;
        }
      }
    }
    if (edgesAdded > 0) {
      log.info(`✓ Bootstrapped graph with ${edgesAdded} template edges`);
      await this.precomputeMetrics();
    }
  }

  getStats(): GraphStats {
    return {
      nodeCount: this.graph.order,
      edgeCount: this.graph.size,
      communities: getCommunityCount(this.communities),
      avgPageRank: getAveragePageRank(this.pageRanks),
    };
  }

  // === Visualization ===

  getGraphSnapshot(): GraphSnapshot {
    const nodes = this.graph.nodes().map((toolId: string) => {
      const { server, name: label } = parseToolId(toolId);
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
        edge_type: edge.edge_type ?? "sequence",
        edge_source: edge.edge_source ?? "inferred",
      };
    });

    const density = this.graph.order > 1
      ? this.graph.size / (this.graph.order * (this.graph.order - 1))
      : 0;
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

  searchToolsForAutocomplete(query: string, limit = 10) {
    return searchToolsForAutocomplete(this.graph, this.pageRanks, query, limit);
  }

  // === Hybrid Search ===

  async searchToolsHybrid(
    vectorSearch: VectorSearch,
    query: string,
    limit = 10,
    contextTools: string[] = [],
    includeRelated = false,
    minScore?: number,
    correlationId?: string,
  ): Promise<HybridSearchResult[]> {
    return hybridSearch(vectorSearch, this.graph, this.pageRanks, query, {
      limit,
      minScore,
      contextTools,
      includeRelated,
      localAlphaCalculator: this.localAlphaCalculator,
      algorithmTracer: this.algorithmTracer,
      correlationId,
    });
  }

  // === Metrics ===

  getAdaptiveAlpha(): number {
    return calculateAdaptiveAlpha(this.graph);
  }
  getGraphDensity(): number {
    return calculateGraphDensity(this.graph);
  }
  getGraph(): any {
    return this.graph;
  }
  getLocalAlphaCalculator(): LocalAlphaCalculator | null {
    return this.localAlphaCalculator;
  }
  setAlgorithmTracer(tracer: AlgorithmTracer): void {
    this.algorithmTracer = tracer;
  }
  getPageRankTop(n: number) {
    return getTopPageRankNodes(this.pageRanks, n);
  }
  getTotalCommunities(): number {
    return getCommunityCount(this.communities);
  }

  async getMetrics(range: MetricsTimeRange): Promise<GraphMetricsResponse> {
    return collectMetrics(this.db, {
      nodeCount: this.graph.order,
      edgeCount: this.graph.size,
      density: this.getGraphDensity(),
      adaptiveAlpha: this.getAdaptiveAlpha(),
      communitiesCount: this.getTotalCommunities(),
      pagerankTop10: this.getPageRankTop(10),
    }, range);
  }
}
