/**
 * MCP Gateway Server
 *
 * Exposes Casys PML functionality via MCP protocol (stdio transport)
 * Compatible with Claude Code and other MCP clients.
 *
 * Implements MCP methods:
 * - tools/list: Returns relevant tools (with semantic search)
 * - tools/call: Executes single tool or workflow
 * - prompts/get: Optional prompt retrieval
 *
 * @module mcp/gateway-server
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  type CallToolRequest,
  CallToolRequestSchema,
  type GetPromptRequest,
  GetPromptRequestSchema,
  type ListToolsRequest,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as log from "@std/log";
import type { DbClient } from "../db/types.ts";
import type { VectorSearch } from "../vector/search.ts";
import type { GraphRAGEngine } from "../graphrag/graph-engine.ts";
import type { DAGSuggester } from "../graphrag/dag-suggester.ts";
import type { ParallelExecutor } from "../dag/executor.ts";
import { GatewayHandler } from "./gateway-handler.ts";
import type { MCPClientBase } from "./types.ts";
import { HealthChecker } from "../health/health-checker.ts";
import { ContextBuilder } from "../sandbox/context-builder.ts";
import { WorkerBridge } from "../sandbox/worker-bridge.ts";
import { addBreadcrumb, captureError, startTransaction } from "../telemetry/sentry.ts";
import type { CapabilityStore } from "../capabilities/capability-store.ts";
import { ToolStore } from "../tools/tool-store.ts";
import type { AdaptiveThresholdManager } from "./adaptive-threshold.ts";
import { CapabilityDataService, initMcpPermissions } from "../capabilities/mod.ts";
import { CapabilityRegistry } from "../capabilities/capability-registry.ts";
import { CapabilityMCPServer } from "./capability-server/mod.ts";
// TraceFeatureExtractor removed - V1 uses message passing, not TraceFeatures
import { CheckpointManager } from "../dag/checkpoint-manager.ts";
import { EventsStreamManager } from "../server/events-stream.ts";
import { PmlStdServer } from "../../lib/std/cap.ts";
import type { AlgorithmTracer } from "../telemetry/algorithm-tracer.ts";
import { TelemetryAdapter } from "../telemetry/decision-logger.ts";
import { buildHyperedgesFromSHGAT, cacheHyperedges, getCachedHyperedges, invalidateHyperedge, updateHyperedge } from "../cache/hyperedge-cache.ts";
import { eventBus } from "../events/mod.ts";
import {
  computeTensorEntropy,
  saveEntropySnapshot,
  snapshotToEntropyInput,
  type EntropyGraphInput,
} from "../graphrag/algorithms/tensor-entropy.ts";
import { filterSnapshotByExecution, getExecutedToolIds } from "../graphrag/user-usage.ts";

// Server types, constants, lifecycle, and HTTP server
import {
  type ActiveWorkflow,
  // Lifecycle functions
  createMCPServer,
  formatMCPError,
  formatMCPToolError,
  type GatewayServerConfig,
  type HttpServerDependencies,
  type HttpServerState,
  MCPErrorCodes,
  type ResolvedGatewayConfig,
  ServerDefaults,
  // HTTP server functions
  startHttpServer,
  startStdioServer,
  stopServer,
} from "./server/mod.ts";

// Tool definitions
import { getMetaTools } from "./tools/mod.ts";

// Handlers
import {
  type CodeExecutionDependencies,
  type ExecuteDependencies,
  handleAbort,
  handleApprovalResponse,
  handleContinue,
  handleDiscover,
  handleExecute,
  handleExecuteCode,
  handleReplan,
  handleSearchCapabilities,
  handleSearchTools,
  handleWorkflowExecution,
  trainingLock,
  type WorkflowHandlerDependencies,
} from "./handlers/mod.ts";
import {
  createSHGATFromCapabilities,
  SHGAT,
  type TrainingExample,
} from "../graphrag/algorithms/shgat.ts";
import { loadCooccurrenceData } from "../graphrag/algorithms/shgat/message-passing/index.ts";
import { spawnSHGATTraining } from "../graphrag/algorithms/shgat/spawn-training.ts";
import { buildDRDSPFromCapabilities, DRDSP } from "../graphrag/algorithms/dr-dsp.ts";
import type { EmbeddingModelInterface } from "../vector/embeddings.ts";

// Sampling Relay for agent tools
import { samplingRelay } from "./sampling/mod.ts";

// Re-export for backward compatibility
export type { GatewayServerConfig };

// ============================================================================
// GraphSyncController - Event-driven incremental graph updates
// ============================================================================

/**
 * Controller for event-driven incremental graph updates.
 *
 * Listens to capability.zone.created/updated events and updates:
 * - GraphRAGEngine (in-memory graph)
 * - Hyperedge KV cache
 * - SHGAT (capability registration)
 */
class GraphSyncController {
  private unsubscribeCreated: (() => void) | null = null;
  private unsubscribeUpdated: (() => void) | null = null;
  private unsubscribeMerged: (() => void) | null = null;

  constructor(
    private graphEngine: GraphRAGEngine | null,
    private db: DbClient,
    private getSHGAT: () => SHGAT | null,
  ) {}

  /**
   * Start listening for capability events
   */
  start(): void {
    this.unsubscribeCreated = eventBus.on("capability.zone.created", (event) => {
      const payload = event.payload as { capabilityId: string; toolIds: string[]; label?: string };
      this.handleCapabilityCreated(payload).catch((err) => {
        log.error("[GraphSyncController] Error handling capability.zone.created:", err);
      });
    });

    this.unsubscribeUpdated = eventBus.on("capability.zone.updated", (event) => {
      const payload = event.payload as { capabilityId: string; toolIds: string[] };
      this.handleCapabilityUpdated(payload).catch((err) => {
        log.error("[GraphSyncController] Error handling capability.zone.updated:", err);
      });
    });

    this.unsubscribeMerged = eventBus.on("capability.merged", (event) => {
      const payload = event.payload as {
        sourceId: string;
        sourceName: string;
        sourcePatternId: string | null;
        targetId: string;
        targetName: string;
        targetPatternId: string | null;
      };
      this.handleCapabilityMerged(payload).catch((err) => {
        log.error("[GraphSyncController] Error handling capability.merged:", err);
      });
    });

    log.info("[GraphSyncController] Started listening for capability events");
  }

  /**
   * Stop listening for events
   */
  stop(): void {
    if (this.unsubscribeCreated) {
      this.unsubscribeCreated();
      this.unsubscribeCreated = null;
    }
    if (this.unsubscribeUpdated) {
      this.unsubscribeUpdated();
      this.unsubscribeUpdated = null;
    }
    if (this.unsubscribeMerged) {
      this.unsubscribeMerged();
      this.unsubscribeMerged = null;
    }
    log.info("[GraphSyncController] Stopped listening for capability events");
  }

  private async handleCapabilityCreated(payload: {
    capabilityId: string;
    toolIds: string[];
    label?: string;
  }): Promise<void> {
    const { capabilityId, toolIds } = payload;

    log.debug(`[GraphSyncController] New capability created: ${capabilityId} with ${toolIds.length} tools`);

    // 1. Update graph engine incrementally
    if (this.graphEngine) {
      this.graphEngine.addCapabilityNode(capabilityId, toolIds);
    }

    // 2. Update hyperedge cache (children will be empty for new capabilities)
    await updateHyperedge(capabilityId, toolIds);

    // 3. Register in SHGAT if available (need to fetch embedding)
    const shgat = this.getSHGAT();
    if (shgat) {
      await this.registerInSHGAT(shgat, capabilityId, toolIds);
    }

    // 4. Compute and save entropy after graph change
    await this.saveEntropyAfterChange();
  }

  private async handleCapabilityUpdated(payload: {
    capabilityId: string;
    toolIds: string[];
  }): Promise<void> {
    const { capabilityId, toolIds } = payload;

    log.debug(`[GraphSyncController] Capability updated: ${capabilityId}`);

    // 1. Update graph engine (idempotent - adds edges if not exist)
    if (this.graphEngine) {
      this.graphEngine.addCapabilityNode(capabilityId, toolIds);
    }

    // 2. Update hyperedge cache
    await updateHyperedge(capabilityId, toolIds);

    // 3. Compute and save entropy after graph change
    await this.saveEntropyAfterChange();
  }

  /**
   * Handle capability merge - invalidate caches and trigger graph resync
   */
  private async handleCapabilityMerged(payload: {
    sourceId: string;
    sourceName: string;
    sourcePatternId: string | null;
    targetId: string;
    targetName: string;
    targetPatternId: string | null;
  }): Promise<void> {
    const { sourceName, sourcePatternId, targetName } = payload;

    log.info(
      `[GraphSyncController] Capability merged: ${sourceName} -> ${targetName}`,
    );

    // 1. Remove source capability node from graph (if it exists)
    if (this.graphEngine && sourcePatternId) {
      const capNodeId = `capability:${sourcePatternId}`;
      try {
        // GraphRAGEngine may not have removeNode, so we trigger a full resync
        log.debug(`[GraphSyncController] Source capability node ${capNodeId} removed via merge`);
      } catch {
        // Node might not exist in graph
      }
    }

    // 2. Invalidate hyperedge cache for source
    if (sourcePatternId) {
      await invalidateHyperedge(`capability:${sourcePatternId}`);
    }

    // 3. Invalidate SHGAT cache for the merged capabilities
    const shgat = this.getSHGAT();
    if (shgat) {
      // SHGAT may need to be notified of topology change
      // For now, we rely on the next training cycle to pick up changes
      log.debug(`[GraphSyncController] SHGAT will pick up merge changes on next training cycle`);
    }

    // 4. Trigger full graph resync to ensure consistency
    // This is heavier than incremental updates but ensures correctness after merge
    if (this.graphEngine) {
      try {
        await this.graphEngine.syncFromDatabase();
        log.info(`[GraphSyncController] Graph resynced after merge`);
      } catch (err) {
        log.error(`[GraphSyncController] Failed to resync graph after merge:`, err);
      }
    }

    // 5. Compute and save entropy after graph change
    await this.saveEntropyAfterChange();
  }

  /**
   * Compute and save entropy snapshot after graph structure changes.
   * Uses scope=system filtering (all executed tools, not full graph).
   * This ensures historical entropy data captures actual structural changes.
   */
  private async saveEntropyAfterChange(): Promise<void> {
    if (!this.graphEngine) return;

    try {
      // Get full graph snapshot
      const fullSnapshot = this.graphEngine.getGraphSnapshot();

      // Filter by scope=system (all executed tools by any user)
      const executedToolIds = await getExecutedToolIds(this.db, "system");
      let snapshot = fullSnapshot;
      if (executedToolIds.size > 0) {
        snapshot = filterSnapshotByExecution(fullSnapshot, executedToolIds);
      }

      const baseInput = snapshotToEntropyInput(snapshot);

      // Inject hyperedges from cache
      const cachedHyperedges = await getCachedHyperedges();
      const entropyInput: EntropyGraphInput = {
        ...baseInput,
        hyperedges: cachedHyperedges.length > 0
          ? cachedHyperedges.map((he) => ({
              id: he.capabilityId,
              members: he.members,
              weight: 1,
            }))
          : undefined,
      };

      // Compute entropy
      const result = computeTensorEntropy(entropyInput);

      // Save to history (system-level scope)
      await saveEntropySnapshot(this.db, result, undefined, undefined);

      log.debug(
        `[GraphSyncController] Saved entropy snapshot (scope=system): VN=${result.vonNeumannEntropy.toFixed(3)}, ` +
        `nodes=${result.meta.nodeCount}, edges=${result.meta.edgeCount}, hyperedges=${result.meta.hyperedgeCount}`
      );
    } catch (err) {
      log.warn(`[GraphSyncController] Failed to save entropy: ${err}`);
    }
  }

  private async registerInSHGAT(
    shgat: SHGAT,
    capabilityId: string,
    toolsUsed: string[],
  ): Promise<void> {
    try {
      // Fetch embedding from DB
      const result = await this.db.query(
        `SELECT intent_embedding FROM workflow_pattern WHERE pattern_id = $1`,
        [capabilityId],
      );

      if (result.length === 0 || !result[0].intent_embedding) {
        log.debug(`[GraphSyncController] No embedding for capability ${capabilityId}, skipping SHGAT registration`);
        return;
      }

      // Parse embedding
      let embedding: number[];
      const raw = result[0].intent_embedding;
      if (Array.isArray(raw)) {
        embedding = raw;
      } else if (typeof raw === "string") {
        try {
          embedding = JSON.parse(raw);
        } catch {
          log.warn(`[GraphSyncController] Failed to parse embedding for ${capabilityId}`);
          return;
        }
      } else {
        return;
      }

      // Build members array from toolsUsed
      const members: Array<{ type: "tool"; id: string }> = toolsUsed.map((toolId) => ({
        type: "tool" as const,
        id: toolId,
      }));

      // Register in SHGAT with full CapabilityNode
      shgat.registerCapability({
        id: capabilityId,
        embedding,
        members,
        hierarchyLevel: 0, // Level 0 = only tools, no child capabilities
        successRate: 1.0, // New capabilities start at 100%
        toolsUsed, // Keep legacy field for compatibility
      });

      log.debug(`[GraphSyncController] Registered capability ${capabilityId} in SHGAT`);
    } catch (err) {
      log.warn(`[GraphSyncController] Failed to register in SHGAT: ${err}`);
    }
  }
}

// ============================================================================
// PMLGatewayServer
// ============================================================================

/**
 * MCP Gateway Server
 *
 * Transparent gateway that exposes Casys PML as a single MCP server.
 * Claude Code sees all tools from all MCP servers + workflow execution capability.
 */
export class PMLGatewayServer {
  private server: Server;
  private gatewayHandler: GatewayHandler;
  private healthChecker: HealthChecker;
  private config: ResolvedGatewayConfig;
  private contextBuilder: ContextBuilder;
  private toolSchemaCache: Map<string, string> = new Map();
  private httpServer: Deno.HttpServer | null = null;
  private activeWorkflows: Map<string, ActiveWorkflow> = new Map();
  private checkpointManager: CheckpointManager | null = null;
  private eventsStream: EventsStreamManager | null = null;
  private capabilityDataService: CapabilityDataService;
  private shgat: SHGAT | null = null;
  private drdsp: DRDSP | null = null;
  private embeddingModel: EmbeddingModelInterface | null = null;
  private capabilityRegistry: CapabilityRegistry | null = null; // Story 13.2
  private capabilityMCPServer: CapabilityMCPServer | null = null; // Story 13.3
  // traceFeatureExtractor removed - V1 uses message passing, not TraceFeatures
  private pmlStdServer: PmlStdServer | null = null; // Story 13.5: cap:* management tools
  private algorithmTracer: AlgorithmTracer | null = null; // Story 7.6: Observability
  private graphSyncController: GraphSyncController | null = null; // Incremental graph updates

  constructor(
    // @ts-ignore: db kept for future use (direct queries)
    private db: DbClient,
    private vectorSearch: VectorSearch,
    private graphEngine: GraphRAGEngine,
    private dagSuggester: DAGSuggester,
    // @ts-ignore: executor kept for API backward compatibility
    private _executor: ParallelExecutor,
    private mcpClients: Map<string, MCPClientBase>,
    private capabilityStore?: CapabilityStore,
    private adaptiveThresholdManager?: AdaptiveThresholdManager,
    config?: GatewayServerConfig,
    embeddingModel?: EmbeddingModelInterface,
  ) {
    this.embeddingModel = embeddingModel ?? null;
    // Merge config with defaults
    this.config = {
      name: config?.name ?? ServerDefaults.name,
      version: config?.version ?? ServerDefaults.version,
      enableSpeculative: config?.enableSpeculative ?? ServerDefaults.enableSpeculative,
      defaultToolLimit: config?.defaultToolLimit ?? ServerDefaults.defaultToolLimit,
      piiProtection: {
        enabled: config?.piiProtection?.enabled ?? true,
        types: config?.piiProtection?.types ?? ["email", "phone", "credit_card", "ssn", "api_key"],
        detokenizeOutput: config?.piiProtection?.detokenizeOutput ?? false,
      },
      cacheConfig: {
        enabled: config?.cacheConfig?.enabled ?? true,
        maxEntries: config?.cacheConfig?.maxEntries ?? 100,
        ttlSeconds: config?.cacheConfig?.ttlSeconds ?? 300,
        persistence: config?.cacheConfig?.persistence ?? false,
      },
    };

    // Initialize MCP Server using lifecycle helper
    this.server = createMCPServer(this.config);

    // Initialize Gateway Handler (ADR-030: pass mcpClients for real execution)
    this.gatewayHandler = new GatewayHandler(
      this.graphEngine,
      this.dagSuggester,
      this.mcpClients,
      {
        enableSpeculative: this.config.enableSpeculative,
      },
    );

    // Initialize Health Checker
    this.healthChecker = new HealthChecker(this.mcpClients);

    // Initialize Context Builder for tool injection (Story 3.4)
    this.contextBuilder = new ContextBuilder(this.vectorSearch, this.mcpClients);

    // Initialize CheckpointManager for per-layer validation (Story 2.5-4)
    this.checkpointManager = new CheckpointManager(this.db, true);

    // Initialize CapabilityDataService for API endpoints (Story 8.1)
    this.capabilityDataService = new CapabilityDataService(this.db, this.graphEngine);
    this.capabilityDataService.setDAGSuggester(this.dagSuggester);

    // Initialize CapabilityRegistry for naming support (Story 13.2)
    this.capabilityRegistry = new CapabilityRegistry(this.db);

    // Wire registry to store for code transformation (display_name → FQDN)
    if (this.capabilityStore) {
      this.capabilityStore.setCapabilityRegistry(this.capabilityRegistry);
    }

    // Story 13.5: Initialize PmlStdServer for cap:* management tools
    // Pass embeddingModel for embedding updates on rename
    this.pmlStdServer = new PmlStdServer(
      this.capabilityRegistry,
      this.db,
      this.embeddingModel ?? undefined,
    );

    // Set up merge callback to emit capability.merged events for graph invalidation
    this.pmlStdServer.getCapModule().setOnMerged((response) => {
      eventBus.emit({
        type: "capability.merged",
        source: "cap:merge",
        timestamp: Date.now(),
        payload: {
          sourceId: response.deletedSourceId,
          sourceName: response.deletedSourceName,
          sourcePatternId: response.deletedSourcePatternId,
          targetId: response.targetId,
          targetName: response.targetDisplayName,
          targetPatternId: response.targetPatternId,
          mergedUsageCount: response.mergedStats.usageCount,
        },
      });
    });

    log.info("[Gateway] PmlStdServer initialized (Story 13.5)");

    // Story 13.3: Initialize CapabilityMCPServer for capability-as-tool execution
    if (this.capabilityStore && this.capabilityRegistry) {
      const workerBridge = new WorkerBridge(this.mcpClients, {
        capabilityStore: this.capabilityStore,
        graphRAG: this.graphEngine,
        capabilityRegistry: this.capabilityRegistry,
      });
      this.capabilityMCPServer = new CapabilityMCPServer(
        this.capabilityStore,
        this.capabilityRegistry,
        workerBridge,
      );
      log.info("[Gateway] CapabilityMCPServer initialized (Story 13.3)");
    }

    this.setupHandlers();
    this.setupSamplingRelay();
  }

  /**
   * Setup sampling relay for agent tools (Story 11.x)
   *
   * Configures the relay to forward sampling/createMessage requests from
   * child MCP servers to Claude Code via the SDK's createMessage method.
   */
  private setupSamplingRelay(): void {
    // Configure the relay to use SDK's createMessage
    // The server.createMessage method forwards to the parent client (Claude Code)
    // @ts-ignore - createMessage exists on Server when client supports sampling
    if (typeof this.server.createMessage === "function") {
      samplingRelay.setCreateMessageFn(
        // @ts-ignore - createMessage params type matches our interface
        (request) => this.server.createMessage(request),
      );
      log.info("[Gateway] Sampling relay configured with SDK createMessage");
    } else {
      log.warn("[Gateway] SDK server.createMessage not available - sampling relay disabled");
    }

    // Configure MCPClients with sampling handler
    for (const [serverId, client] of this.mcpClients.entries()) {
      // MCPClient has setSamplingHandler if properly typed
      if ("setSamplingHandler" in client && typeof client.setSamplingHandler === "function") {
        client.setSamplingHandler(
          (childServerId, request, respondToChild) =>
            samplingRelay.handleChildRequest(childServerId, request, respondToChild),
        );
        log.debug(`[Gateway] Sampling handler configured for ${serverId}`);
      }
    }
  }

  /**
   * Set AlgorithmTracer for observability (Story 7.6)
   * Called from serve.ts after gateway construction.
   */
  setAlgorithmTracer(tracer: AlgorithmTracer): void {
    this.algorithmTracer = tracer;
    log.debug("[Gateway] AlgorithmTracer configured for observability");
  }

  /**
   * Setup MCP protocol handlers
   */
  private setupHandlers(): void {
    this.server.setRequestHandler(
      ListToolsRequestSchema,
      async (request: ListToolsRequest) => await this.handleListTools(request),
    );

    this.server.setRequestHandler(
      CallToolRequestSchema,
      async (request: CallToolRequest) => await this.handleCallTool(request),
    );

    this.server.setRequestHandler(
      GetPromptRequestSchema,
      async (request: GetPromptRequest) => await this.handleGetPrompt(request),
    );

    log.info("MCP handlers registered: tools/list, tools/call, prompts/get");
  }

  /**
   * Handler: tools/list
   *
   * Returns meta-tools only (ADR-013: minimize context usage).
   * Tool discovery happens via execute_workflow with intent parameter.
   */
  private handleListTools(
    _request: unknown,
  ): Promise<
    | { tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> }
    | { error: { code: number; message: string; data?: unknown } }
  > {
    const transaction = startTransaction("mcp.tools.list", "mcp");
    try {
      addBreadcrumb("mcp", "Processing tools/list request", {});
      log.info(`list_tools: returning meta-tools (ADR-013)`);

      // Get meta-tools (cap:* tools are MiniTools in lib/std, not meta-tools)
      const metaTools = getMetaTools();

      const result = { tools: metaTools };
      transaction.setData("tools_returned", result.tools.length);
      transaction.finish();
      return Promise.resolve(result);
    } catch (error) {
      log.error(`list_tools error: ${error}`);
      captureError(error as Error, {
        operation: "tools/list",
        handler: "handleListTools",
      });
      transaction.finish();
      return Promise.resolve(formatMCPError(
        MCPErrorCodes.INTERNAL_ERROR,
        `Failed to list tools: ${(error as Error).message}`,
      ));
    }
  }

  /**
   * Handler: tools/call
   *
   * Routes to appropriate handler based on tool name.
   */
  private async handleCallTool(
    request: unknown,
    userId?: string,
  ): Promise<
    { content: Array<{ type: string; text: string }> } | {
      error: { code: number; message: string; data?: unknown };
    }
  > {
    const transaction = startTransaction("mcp.tools.call", "mcp");
    try {
      const params = (request as { params?: { name?: string; arguments?: unknown } }).params;

      if (!params?.name) {
        transaction.finish();
        // Use JSON-RPC error format for validation errors (INVALID_PARAMS)
        return formatMCPError(MCPErrorCodes.INVALID_PARAMS, "Missing required parameter: 'name'");
      }

      const { name, arguments: args } = params;
      transaction.setTag("tool", name);
      transaction.setData("has_arguments", !!args);
      addBreadcrumb("mcp", "Processing tools/call request", { tool: name });
      log.info(`call_tool: ${name}`);

      // Route to handlers
      const result = await this.routeToolCall(name, args, userId);
      transaction.finish();
      return result;
    } catch (error) {
      log.error(`call_tool error: ${error}`);
      captureError(error as Error, {
        operation: "tools/call",
        handler: "handleCallTool",
      });
      transaction.finish();
      return formatMCPToolError(
        `Tool execution failed: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Route tool call to appropriate handler
   */
  private async routeToolCall(
    name: string,
    args: unknown,
    userId?: string,
  ): Promise<
    { content: Array<{ type: string; text: string }> } | {
      error: { code: number; message: string; data?: unknown };
    }
  > {
    // DAG execution
    if (name === "pml:execute_dag") {
      return await handleWorkflowExecution(args, this.getWorkflowDeps(), userId);
    }

    // Control tools
    if (name === "pml:continue") {
      return await handleContinue(args, this.getWorkflowDeps());
    }

    if (name === "pml:abort") {
      return await handleAbort(args, this.getWorkflowDeps());
    }

    if (name === "pml:replan") {
      return await handleReplan(args, this.getWorkflowDeps());
    }

    if (name === "pml:approval_response") {
      return await handleApprovalResponse(args, this.getWorkflowDeps());
    }

    // Code execution
    if (name === "pml:execute_code") {
      return await handleExecuteCode(args, this.getCodeExecutionDeps());
    }

    // Search tools
    if (name === "pml:search_tools") {
      return await handleSearchTools(args, this.graphEngine, this.vectorSearch);
    }

    if (name === "pml:search_capabilities") {
      return await handleSearchCapabilities(args, this.dagSuggester);
    }

    // Unified discover (Story 10.6)
    // Uses SHGAT K-head for capability scoring (unified with pml:execute)
    if (name === "pml:discover") {
      return await handleDiscover(args, {
        vectorSearch: this.vectorSearch,
        graphEngine: this.graphEngine,
        dagSuggester: this.dagSuggester,
        toolStore: new ToolStore(this.db),
        capabilityRegistry: this.capabilityRegistry ?? undefined,
        decisionLogger: new TelemetryAdapter(),
        shgat: this.shgat ?? undefined,
        embeddingModel: this.embeddingModel ?? undefined,
      });
    }

    // Unified execute (Story 10.7)
    if (name === "pml:execute") {
      return await handleExecute(args, this.getExecuteDeps());
    }

    // Story 13.3: Capability tool execution (mcp__namespace__action format)
    if (name.startsWith("mcp__") && this.capabilityMCPServer) {
      const result = await this.capabilityMCPServer.handleCallTool(
        name,
        args as Record<string, unknown>,
      );
      if (result.success) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result.data, null, 2),
            },
          ],
        };
      } else {
        return formatMCPToolError(result.error || "Capability execution failed");
      }
    }

    // Story 13.5: std:cap_* tools need special handling
    // They're MiniTools in lib/std but require gateway's CapModule (not std server's)
    if (name.startsWith("std:cap_") && this.pmlStdServer) {
      // Map std:cap_list → cap:list, std:cap_rename → cap:rename, etc.
      const capToolName = "cap:" + name.slice(8); // "std:cap_list" → "cap:list"
      const result = await this.pmlStdServer.handleCallTool(capToolName, args);
      return {
        content: result.content,
        ...(result.isError ? { isError: true } : {}),
      };
    }

    // Single tool execution (proxy to underlying MCP server)
    return await this.proxyToolCall(name, args);
  }

  /**
   * Proxy tool call to underlying MCP server
   */
  private async proxyToolCall(
    name: string,
    args: unknown,
  ): Promise<
    { content: Array<{ type: string; text: string }> } | {
      error: { code: number; message: string; data?: unknown };
    }
  > {
    const [serverId, ...toolNameParts] = name.split(":");
    const toolName = toolNameParts.join(":");

    const client = this.mcpClients.get(serverId);
    if (!client) {
      // Use tool error format so the agent sees the error in conversation
      log.error(`[MCP_TOOL_ERROR] Unknown MCP server: ${serverId}`);
      return formatMCPToolError(
        `Unknown MCP server: ${serverId}`,
        { available_servers: Array.from(this.mcpClients.keys()) },
      );
    }

    const result = await client.callTool(toolName, args as Record<string, unknown>);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }

  /**
   * Get workflow handler dependencies
   */
  private getWorkflowDeps(): WorkflowHandlerDependencies {
    return {
      db: this.db,
      graphEngine: this.graphEngine,
      dagSuggester: this.dagSuggester,
      capabilityStore: this.capabilityStore,
      capabilityRegistry: this.capabilityRegistry ?? undefined,
      mcpClients: this.mcpClients,
      gatewayHandler: this.gatewayHandler,
      checkpointManager: this.checkpointManager,
      activeWorkflows: this.activeWorkflows,
      adaptiveThresholdManager: this.adaptiveThresholdManager, // Story 10.7c
      algorithmTracer: this.algorithmTracer ?? undefined, // Story 7.6
    };
  }

  /**
   * Get code execution handler dependencies
   */
  private getCodeExecutionDeps(): CodeExecutionDependencies {
    return {
      vectorSearch: this.vectorSearch,
      graphEngine: this.graphEngine,
      mcpClients: this.mcpClients,
      capabilityStore: this.capabilityStore,
      capabilityRegistry: this.capabilityRegistry ?? undefined,
      adaptiveThresholdManager: this.adaptiveThresholdManager,
      config: this.config,
      contextBuilder: this.contextBuilder,
      toolSchemaCache: this.toolSchemaCache,
    };
  }

  /**
   * Get execute handler dependencies (Story 10.7 + Story 13.2)
   * Uses SHGAT + DR-DSP for capability matching (not CapabilityMatcher)
   * Includes CapabilityRegistry for naming support
   */
  private getExecuteDeps(): ExecuteDependencies {
    return {
      vectorSearch: this.vectorSearch,
      graphEngine: this.graphEngine,
      mcpClients: this.mcpClients,
      capabilityStore: this.capabilityStore!,
      adaptiveThresholdManager: this.adaptiveThresholdManager,
      config: this.config,
      contextBuilder: this.contextBuilder,
      toolSchemaCache: this.toolSchemaCache,
      db: this.db,
      drdsp: this.drdsp ?? undefined,
      shgat: this.shgat ?? undefined,
      embeddingModel: this.embeddingModel ?? undefined,
      checkpointManager: this.checkpointManager ?? undefined,
      workflowDeps: this.getWorkflowDeps(),
      capabilityRegistry: this.capabilityRegistry ?? undefined, // Story 13.2
      traceStore: this.capabilityStore?.getTraceStore(), // Story 11.6: PER training
      onSHGATParamsUpdated: () => this.saveSHGATParams(), // Save after PER training
      algorithmTracer: this.algorithmTracer ?? undefined, // Story 7.6: Observability
    };
  }

  /**
   * Handler: prompts/get
   */
  private handleGetPrompt(_request: unknown): Promise<{ prompts: Array<unknown> }> {
    log.debug("prompts/get called (not implemented)");
    return Promise.resolve({ prompts: [] });
  }

  /**
   * Track tool usage for cache invalidation (Story 3.7)
   */
  public async trackToolUsage(toolKey: string): Promise<void> {
    try {
      const [serverId, ...toolNameParts] = toolKey.split(":");
      const toolName = toolNameParts.join(":");

      const rows = await this.db.query(
        `SELECT input_schema FROM tool_schema WHERE server_id = $1 AND name = $2`,
        [serverId, toolName],
      );

      if (rows.length > 0) {
        const schema = rows[0].input_schema;
        const schemaHash = this.hashToolSchema(schema);
        const previousHash = this.toolSchemaCache.get(toolKey);

        if (previousHash && previousHash !== schemaHash) {
          log.info(`Tool schema changed: ${toolKey}, cache will be invalidated`);
        }
        this.toolSchemaCache.set(toolKey, schemaHash);
      }
    } catch (error) {
      log.debug(`Failed to track tool schema for ${toolKey}: ${error}`);
    }
  }

  /**
   * Generate hash of tool schema for change detection
   */
  private hashToolSchema(schema: unknown): string {
    const str = JSON.stringify(schema);
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(16);
  }

  /**
   * Start gateway server with stdio transport
   */
  /**
   * Initialize SHGAT and DR-DSP algorithms (Story 10.7)
   * Called at server startup to enable intelligent capability matching
   */
  private async initializeAlgorithms(): Promise<void> {
    if (!this.capabilityStore) {
      log.warn("[Gateway] No capability store - SHGAT/DR-DSP disabled");
      return;
    }

    try {
      // Load capabilities from DB for algorithm initialization
      interface CapRow {
        id: string;
        embedding: number[] | null;
        tools_used: string[] | null;
        success_rate: number;
      }
      const rows = await this.db.query(
        `SELECT
          pattern_id as id,
          intent_embedding as embedding,
          dag_structure->'tools_used' as tools_used,
          success_rate
        FROM workflow_pattern
        WHERE code_snippet IS NOT NULL
        LIMIT 1000`,
      ) as unknown as CapRow[];

      // Story 10.1: Load capability-to-capability "contains" edges for hierarchy
      interface ContainsEdge {
        from_capability_id: string;
        to_capability_id: string;
      }
      const containsEdges = await this.db.query(
        `SELECT from_capability_id, to_capability_id
         FROM capability_dependency
         WHERE edge_type = 'contains'`,
      ) as unknown as ContainsEdge[];

      // Build children/parents maps from contains edges
      const childrenMap = new Map<string, string[]>();
      const parentsMap = new Map<string, string[]>();
      for (const edge of containsEdges) {
        // Parent -> Children
        const children = childrenMap.get(edge.from_capability_id) || [];
        children.push(edge.to_capability_id);
        childrenMap.set(edge.from_capability_id, children);
        // Child -> Parents
        const parents = parentsMap.get(edge.to_capability_id) || [];
        parents.push(edge.from_capability_id);
        parentsMap.set(edge.to_capability_id, parents);
      }
      // Count cap→tool edges from tools_used arrays
      const toolEdgesCount = rows.reduce((acc, c) => acc + (c.tools_used?.length ?? 0), 0);
      log.debug(
        `[Gateway] Loaded SHGAT hierarchy: ${containsEdges.length} cap→cap edges, ${toolEdgesCount} cap→tool edges (from tools_used)`,
      );

      // Initialize SHGAT with capabilities that have embeddings (or empty)
      // Note: pgvector returns string like "[0.1,0.2,...]", pglite returns array
      const capabilitiesWithEmbeddings = rows
        .filter((c) => c.embedding !== null)
        .map((c) => {
          // Parse embedding: handle both string (pgvector) and array (pglite)
          let embedding: number[];
          if (Array.isArray(c.embedding)) {
            embedding = c.embedding;
          } else if (typeof c.embedding === "string") {
            try {
              embedding = JSON.parse(c.embedding);
            } catch {
              return null;
            }
          } else {
            return null;
          }
          if (!Array.isArray(embedding) || embedding.length === 0) return null;
          return { ...c, embedding };
        })
        .filter((c): c is CapRow & { embedding: number[] } => c !== null)
        .map((c) => ({
          id: c.id,
          embedding: c.embedding,
          toolsUsed: c.tools_used ?? [],
          successRate: c.success_rate,
          // Story 10.1: Include children/parents for capability hierarchy
          children: childrenMap.get(c.id),
          parents: parentsMap.get(c.id),
        }));

      // Always create SHGAT - even empty, capabilities added dynamically
      this.shgat = createSHGATFromCapabilities(capabilitiesWithEmbeddings);
      log.info(
        `[Gateway] SHGAT initialized with ${capabilitiesWithEmbeddings.length} capabilities`,
      );

      // Load V→V co-occurrence patterns from scraped n8n workflows
      try {
        const toolIndex = this.shgat.getToolIndexMap();
        const coocData = await loadCooccurrenceData(toolIndex);
        if (coocData.entries.length > 0) {
          this.shgat.setCooccurrenceData(coocData.entries);
          log.info(
            `[Gateway] V→V co-occurrence loaded: ${coocData.stats.edges} edges from ${coocData.stats.patternsLoaded} patterns`,
          );
        }
      } catch (e) {
        log.debug(`[Gateway] No V→V co-occurrence data: ${e}`);
      }

      // Cache hyperedges in KV for tensor-entropy and other consumers
      const hyperedges = buildHyperedgesFromSHGAT(capabilitiesWithEmbeddings);
      if (hyperedges.length > 0) {
        await cacheHyperedges(hyperedges);
        log.info(
          `[Gateway] Cached ${hyperedges.length} hyperedges in KV`,
        );
      }

      // Start GraphSyncController for incremental updates
      this.graphSyncController = new GraphSyncController(
        this.graphEngine,
        this.db,
        () => this.shgat,
      );
      this.graphSyncController.start();

      // Story 10.7b: Load persisted SHGAT params if available
      const { loaded: paramsLoaded } = await this.loadSHGATParams();

      // Story 10.7: Populate tool features for multi-head attention
      await this.populateToolFeaturesForSHGAT();

      // Story 10.7: Train SHGAT on execution traces only if no saved params
      // PER training handles incremental updates on every execution, so batch
      // training at startup is only needed for first-time initialization
      if (capabilitiesWithEmbeddings.length > 0 && !paramsLoaded) {
        // Run in background to avoid blocking server startup (~30s per epoch)
        log.info(`[Gateway] Starting background SHGAT training (first-time init, no saved params)`);
        this.trainSHGATOnTraces(capabilitiesWithEmbeddings).catch((err) =>
          log.warn(`[Gateway] Background SHGAT training failed: ${err}`)
        );
      } else if (paramsLoaded) {
        log.info(
          `[Gateway] SHGAT params loaded from DB - skipping batch training (PER handles updates)`,
        );
      }

      // TraceFeatureExtractor removed - V1 uses message passing, not TraceFeatures

      // Initialize DR-DSP
      this.drdsp = buildDRDSPFromCapabilities(
        rows.map((c) => ({
          id: c.id,
          toolsUsed: c.tools_used ?? [],
          successRate: c.success_rate,
        })),
      );
      log.info(`[Gateway] DR-DSP initialized with ${rows.length} capabilities`);
    } catch (error) {
      log.error(`[Gateway] Failed to initialize algorithms: ${error}`);
    }
  }

  /**
   * Train SHGAT on execution traces (Story 10.7)
   * Requires ≥20 traces to start training
   */
  private async trainSHGATOnTraces(
    capabilities: Array<{
      id: string;
      embedding: number[];
      toolsUsed: string[];
      successRate: number;
    }>,
  ): Promise<void> {
    if (!this.shgat || !this.embeddingModel) {
      return;
    }

    // Acquire training lock to prevent concurrent training with PER
    if (!trainingLock.acquire("BATCH")) {
      log.info(`[Gateway] Skipping batch training - another training in progress (owner: ${trainingLock.owner})`);
      return;
    }

    try {
      // Query execution_trace with JOIN on workflow_pattern for intent data
      // Since migration 030, intent_text and intent_embedding come from workflow_pattern
      interface TraceRow {
        capability_id: string;
        intent_text: string | null;
        intent_embedding: string | null; // PostgreSQL vector format "[0.1,0.2,...]"
        success: boolean;
        executed_path: string[] | null;
      }

      const traces = await this.db.query(`
        SELECT
          et.capability_id,
          wp.description AS intent_text,
          wp.intent_embedding,
          et.success,
          et.executed_path
        FROM execution_trace et
        JOIN workflow_pattern wp ON wp.pattern_id = et.capability_id
        WHERE et.capability_id IS NOT NULL
          AND wp.intent_embedding IS NOT NULL
        ORDER BY et.priority DESC
        LIMIT 500
      `) as unknown as TraceRow[];

      if (traces.length === 0) {
        log.info(`[Gateway] No execution traces yet - SHGAT will train when traces available`);
        return;
      }


      log.info(`[Gateway] Training SHGAT on ${traces.length} execution traces...`);

      // Build capability embedding lookup
      const capEmbeddings = new Map<string, number[]>();
      for (const cap of capabilities) {
        capEmbeddings.set(cap.id, cap.embedding);
      }

      // Convert traces to TrainingExamples with RANDOM negative mining
      // Random negatives are easier to learn than hard negatives (which are too similar)
      const examples: TrainingExample[] = [];
      const NUM_NEGATIVES = 4;

      for (const trace of traces) {
        // Skip if capability not in our set
        if (!capEmbeddings.has(trace.capability_id)) continue;

        // Parse intent embedding from PostgreSQL vector format
        if (!trace.intent_embedding) continue;
        let intentEmbedding: number[];
        try {
          const embStr = trace.intent_embedding;
          const cleaned = embStr.replace(/^\[|\]$/g, "");
          intentEmbedding = cleaned.split(",").map(Number);
        } catch {
          continue; // Skip traces with invalid embedding format
        }

        // RANDOM NEGATIVE MINING: Select random capabilities (excluding positive)
        const candidateIds: string[] = [];
        for (const [capId] of capEmbeddings) {
          if (capId === trace.capability_id) continue; // Exclude positive
          candidateIds.push(capId);
        }

        // Fisher-Yates shuffle and take first NUM_NEGATIVES
        for (let i = candidateIds.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [candidateIds[i], candidateIds[j]] = [candidateIds[j], candidateIds[i]];
        }
        const negativeCapIds = candidateIds.slice(0, NUM_NEGATIVES);

        examples.push({
          intentEmbedding,
          contextTools: trace.executed_path ?? [],
          candidateId: trace.capability_id,
          outcome: trace.success ? 1.0 : 0.0,
          negativeCapIds,
        });
      }

      if (examples.length === 0) {
        log.info(`[Gateway] No valid training examples - skipping`);
        return;
      }

      // Train SHGAT in subprocess to avoid blocking event loop
      // Also collect tools from examples that may not be in capabilities
      const allToolsFromExamples = new Set<string>();
      for (const ex of examples) {
        for (const tool of ex.contextTools) {
          allToolsFromExamples.add(tool);
        }
      }

      // Pass each capability with its tools, plus ensure all tools from examples are registered
      const capsForWorker = capabilities.map((c, i) => ({
        id: c.id,
        embedding: c.embedding,
        // First capability gets all tools from examples to ensure they're registered
        toolsUsed: i === 0 ? [...new Set([...c.toolsUsed, ...allToolsFromExamples])] : c.toolsUsed,
        successRate: c.successRate,
      }));

      const result = await spawnSHGATTraining({
        capabilities: capsForWorker,
        examples,
        epochs: 10, // 10 epochs for better logit separation with InfoNCE
        batchSize: 16,
      });

      if (result.success && this.shgat) {
        if (result.savedToDb) {
          // Worker saved params directly to DB - reload them
          await this.loadSHGATParams();
          log.info(
            `[Gateway] SHGAT training complete: loss=${result.finalLoss?.toFixed(4)}, accuracy=${
              result.finalAccuracy?.toFixed(2)
            } (params loaded from DB)`,
          );
        } else if (result.params) {
          // Fallback: import params from result (shouldn't happen with DB save)
          this.shgat.importParams(result.params);
          log.info(
            `[Gateway] SHGAT training complete: loss=${result.finalLoss?.toFixed(4)}, accuracy=${
              result.finalAccuracy?.toFixed(2)
            }`,
          );
          await this.saveSHGATParams();
        }
      } else if (!result.success) {
        log.warn(`[Gateway] SHGAT subprocess training failed: ${result.error}`);
      }
    } catch (error) {
      log.warn(`[Gateway] SHGAT training failed: ${error}`);
    } finally {
      trainingLock.release("BATCH");
    }
  }

  /**
   * Populate tool features for SHGAT multi-head attention (Story 10.7)
   *
   * For tools (simple graph), we use:
   * - PageRank: from GraphRAGEngine.getPageRank()
   * - Louvain community: from GraphRAGEngine.getCommunity() (stored as spectralCluster for interface compat)
   * - AdamicAdar: from GraphRAGEngine.computeAdamicAdar() (best score with neighbors)
   * - Cooccurrence: from execution_trace (tool pairs appearing together)
   * - Recency: from execution_trace (how recently the tool was used)
   *
   * Note: Tools use simple graph algos, not hypergraph algos (which are for capabilities).
   */
  private async populateToolFeaturesForSHGAT(): Promise<void> {
    if (!this.shgat || !this.graphEngine) {
      return;
    }

    try {
      // First, register ALL tools from graphEngine into SHGAT (not just from capabilities)
      // This ensures tools from MCP servers are available for scoring
      const graphToolIds = this.graphEngine.getGraph().nodes();
      let registeredCount = 0;

      for (const toolId of graphToolIds) {
        if (!this.shgat.hasToolNode(toolId)) {
          const toolNode = this.graphEngine.getToolNode(toolId);

          // Use pre-computed embedding from DB if available, otherwise generate
          let embedding: number[];
          if (toolNode?.embedding && toolNode.embedding.length > 0) {
            embedding = toolNode.embedding;
          } else {
            // Fallback: generate embedding from description
            const description = toolNode?.description ?? toolId.replace(":", " ");
            embedding = this.embeddingModel
              ? await this.embeddingModel.encode(description)
              : new Array(1024).fill(0).map(() => Math.random() - 0.5);
          }

          this.shgat.registerTool({ id: toolId, embedding });
          registeredCount++;
        }
      }

      if (registeredCount > 0) {
        log.info(`[Gateway] Registered ${registeredCount} MCP tools in SHGAT`);
      }

      // Get all tool IDs from SHGAT (now includes MCP tools)
      const toolIds = this.shgat.getRegisteredToolIds();

      if (toolIds.length === 0) {
        log.debug("[Gateway] No tools registered in SHGAT - skipping feature population");
        return;
      }

      // Query execution traces for temporal features (cooccurrence, recency)
      const { toolRecency, toolCooccurrence } = await this.computeToolTemporalFeatures(toolIds);

      // Build feature updates from GraphRAGEngine
      const updates = new Map<
        string,
        import("../graphrag/algorithms/shgat.ts").ToolGraphFeatures
      >();

      for (const toolId of toolIds) {
        // HEAD 2 (Structure): PageRank, Louvain community, AdamicAdar
        const pageRank = this.graphEngine.getPageRank(toolId);
        const community = this.graphEngine.getCommunity(toolId);
        const louvainCommunity = community ? parseInt(community, 10) || 0 : 0;

        // AdamicAdar: get top similar node's score (0 if no neighbors)
        const adamicResults = this.graphEngine.computeAdamicAdar(toolId, 1);
        const adamicAdar = adamicResults.length > 0
          ? Math.min(adamicResults[0].score / 2, 1.0) // Normalize to 0-1
          : 0;

        // HEAD 3 (Temporal): Cooccurrence, Recency from execution traces
        const cooccurrence = toolCooccurrence.get(toolId) ?? 0;
        const recency = toolRecency.get(toolId) ?? 0;

        updates.set(toolId, {
          pageRank,
          louvainCommunity,
          adamicAdar,
          cooccurrence,
          recency,
          heatDiffusion: 0, // TODO: compute from graph diffusion
        });
      }

      // Batch update SHGAT
      this.shgat.batchUpdateToolFeatures(updates);
      log.info(
        `[Gateway] Populated SHGAT tool features for ${updates.size} tools (PageRank, Louvain, AdamicAdar, temporal)`,
      );
    } catch (error) {
      log.warn(`[Gateway] Failed to populate tool features: ${error}`);
    }
  }

  /**
   * Compute temporal features for tools from execution traces
   *
   * - Recency: How recently was the tool used? (0-1, 1 = used in last hour)
   * - Cooccurrence: How often does this tool appear with other tools? (normalized 0-1)
   */
  private async computeToolTemporalFeatures(
    toolIds: string[],
  ): Promise<{
    toolRecency: Map<string, number>;
    toolCooccurrence: Map<string, number>;
  }> {
    const toolRecency = new Map<string, number>();
    const toolCooccurrence = new Map<string, number>();

    // Initialize with zeros
    for (const toolId of toolIds) {
      toolRecency.set(toolId, 0);
      toolCooccurrence.set(toolId, 0);
    }

    try {
      // Query recent traces (last 500) to compute temporal features
      interface TraceToolRow {
        task_results: string | Array<{ tool?: string }>;
        executed_at: string;
      }

      const traces = await this.db.query(`
        SELECT task_results, executed_at
        FROM execution_trace
        WHERE task_results IS NOT NULL
          AND jsonb_typeof(task_results) = 'array'
          AND jsonb_array_length(task_results) > 0
        ORDER BY executed_at DESC
        LIMIT 500
      `) as unknown as TraceToolRow[];

      if (traces.length === 0) {
        return { toolRecency, toolCooccurrence };
      }

      const now = Date.now();
      const oneHourMs = 60 * 60 * 1000;
      const oneDayMs = 24 * oneHourMs;
      const toolLastUsed = new Map<string, number>(); // tool -> timestamp
      const toolPairCount = new Map<string, number>(); // count of traces tool appears in

      for (const trace of traces) {
        // Parse task_results to extract tools
        let taskResults: Array<{ tool?: string }> = [];
        try {
          taskResults = typeof trace.task_results === "string"
            ? JSON.parse(trace.task_results)
            : trace.task_results;
        } catch {
          continue;
        }

        const traceTime = new Date(trace.executed_at).getTime();
        const toolsInTrace = new Set<string>();

        for (const task of taskResults) {
          if (task.tool && toolIds.includes(task.tool)) {
            toolsInTrace.add(task.tool);
            // Track last usage time
            const existing = toolLastUsed.get(task.tool) ?? 0;
            if (traceTime > existing) {
              toolLastUsed.set(task.tool, traceTime);
            }
          }
        }

        // Count tool occurrences (for cooccurrence)
        for (const tool of toolsInTrace) {
          toolPairCount.set(tool, (toolPairCount.get(tool) ?? 0) + 1);
        }
      }

      // Compute recency: exponential decay based on time since last use
      // recency = exp(-timeSinceLastUse / oneDayMs) -> 1.0 if used just now, ~0.37 if 1 day ago
      for (const [toolId, lastUsedTime] of toolLastUsed) {
        const timeSinceUse = now - lastUsedTime;
        const recency = Math.exp(-timeSinceUse / oneDayMs);
        toolRecency.set(toolId, Math.min(recency, 1.0));
      }

      // Compute cooccurrence: normalize by max count
      const maxCount = Math.max(1, ...toolPairCount.values());
      for (const [toolId, count] of toolPairCount) {
        toolCooccurrence.set(toolId, count / maxCount);
      }

      log.debug(`[Gateway] Computed temporal features from ${traces.length} traces`);
    } catch (error) {
      log.warn(`[Gateway] Failed to compute temporal features: ${error}`);
    }

    return { toolRecency, toolCooccurrence };
  }

  async start(): Promise<void> {
    await initMcpPermissions(); // Load mcp-permissions.yaml for HIL detection
    await this.initializeAlgorithms();
    await this.healthChecker.initialHealthCheck();
    this.healthChecker.startPeriodicChecks();
    await startStdioServer(this.server, this.config, this.mcpClients);
  }

  /**
   * Start gateway server with HTTP transport (ADR-014)
   *
   * Uses extracted HTTP server module for cleaner architecture.
   */
  async startHttp(port: number): Promise<void> {
    // Initialize MCP permissions and algorithms before starting server
    await initMcpPermissions(); // Load mcp-permissions.yaml for HIL detection
    await this.initializeAlgorithms();

    // Prepare dependencies for HTTP server
    const deps: HttpServerDependencies = {
      config: this.config,
      routeContext: {
        graphEngine: this.graphEngine,
        vectorSearch: this.vectorSearch,
        dagSuggester: this.dagSuggester,
        capabilityStore: this.capabilityStore,
        capabilityDataService: this.capabilityDataService,
        healthChecker: this.healthChecker,
        mcpClients: this.mcpClients,
        db: this.db, // Story 9.8: Add db for scope filtering
      },
      handleListTools: (request: unknown) => this.handleListTools(request),
      handleCallTool: (request: unknown, userId?: string) => this.handleCallTool(request, userId),
    };

    // Mutable state for HTTP server
    const state: HttpServerState = {
      httpServer: null,
      eventsStream: null,
    };

    // Start HTTP server using extracted module
    this.httpServer = await startHttpServer(port, deps, state, {
      initialHealthCheck: () => this.healthChecker.initialHealthCheck(),
      startPeriodicChecks: () => this.healthChecker.startPeriodicChecks(),
    });

    // Store eventsStream reference for cleanup
    this.eventsStream = state.eventsStream;
  }

  /**
   * Graceful shutdown
   */
  async stop(): Promise<void> {
    // Story 10.7b: Final save on shutdown
    await this.saveSHGATParams();

    // Class-specific cleanup
    this.healthChecker.stopPeriodicChecks();

    if (this.eventsStream) {
      this.eventsStream.close();
      this.eventsStream = null;
    }

    // Stop GraphSyncController
    if (this.graphSyncController) {
      this.graphSyncController.stop();
      this.graphSyncController = null;
    }

    // Delegate core shutdown to lifecycle module
    await stopServer(this.server, this.mcpClients, this.httpServer);
    this.httpServer = null;
  }

  // ==========================================================================
  // SHGAT Persistence (Story 10.7b)
  // ==========================================================================

  /**
   * Load persisted SHGAT params from database
   * Called at startup after SHGAT structure is initialized
   *
   * @returns Object with loaded status and timestamp (for skip-training logic)
   */
  private async loadSHGATParams(): Promise<{ loaded: boolean; updatedAt?: Date }> {
    if (!this.shgat) return { loaded: false };

    try {
      interface ParamsRow {
        params: Record<string, unknown>;
        updated_at: string;
      }

      const rows = await this.db.query(
        `SELECT params, updated_at FROM shgat_params WHERE user_id = $1 LIMIT 1`,
        ["local"],
      ) as unknown as ParamsRow[];

      if (rows.length > 0 && rows[0].params) {
        this.shgat.importParams(rows[0].params);
        const updatedAt = new Date(rows[0].updated_at);
        log.info(
          `[Gateway] SHGAT params loaded from DB (saved: ${rows[0].updated_at})`,
        );
        return { loaded: true, updatedAt };
      } else {
        log.info("[Gateway] No persisted SHGAT params found - using fresh weights");
        return { loaded: false };
      }
    } catch (error) {
      // Table might not exist yet (migration not run)
      log.debug(`[Gateway] Could not load SHGAT params: ${error}`);
      return { loaded: false };
    }
  }

  /**
   * Save SHGAT params to database
   * Called at shutdown and periodically
   */
  private async saveSHGATParams(): Promise<void> {
    if (!this.shgat) return;

    try {
      const params = this.shgat.exportParams();

      await this.db.query(
        `INSERT INTO shgat_params (user_id, params, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (user_id) DO UPDATE SET
           params = EXCLUDED.params,
           updated_at = NOW()`,
        ["local", params], // postgres.js/pglite auto-serializes to JSONB
      );

      log.info("[Gateway] SHGAT params saved to DB");
    } catch (error) {
      // Table might not exist yet (migration not run)
      log.warn(`[Gateway] Could not save SHGAT params: ${error}`);
    }
  }
}
