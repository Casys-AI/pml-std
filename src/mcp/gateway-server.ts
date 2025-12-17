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
import type { PGliteClient } from "../db/client.ts";
import type { VectorSearch } from "../vector/search.ts";
import type { GraphRAGEngine } from "../graphrag/graph-engine.ts";
import type { DAGSuggester } from "../graphrag/dag-suggester.ts";
import type { ParallelExecutor } from "../dag/executor.ts";
import { GatewayHandler } from "./gateway-handler.ts";
import type { MCPClientBase } from "./types.ts";
import { HealthChecker } from "../health/health-checker.ts";
import { ContextBuilder } from "../sandbox/context-builder.ts";
import { addBreadcrumb, captureError, startTransaction } from "../telemetry/sentry.ts";
import type { CapabilityStore } from "../capabilities/capability-store.ts";
import type { AdaptiveThresholdManager } from "./adaptive-threshold.ts";
import { CapabilityDataService } from "../capabilities/mod.ts";
import { CheckpointManager } from "../dag/checkpoint-manager.ts";
import { EventsStreamManager } from "../server/events-stream.ts";

// Server types, constants, lifecycle, and HTTP server
import {
  MCPErrorCodes,
  ServerDefaults,
  type GatewayServerConfig,
  type ResolvedGatewayConfig,
  type ActiveWorkflow,
  formatMCPError,
  formatMCPToolError,
  // Lifecycle functions
  createMCPServer,
  startStdioServer,
  stopServer,
  // HTTP server functions
  startHttpServer,
  type HttpServerDependencies,
  type HttpServerState,
} from "./server/mod.ts";

// Tool definitions
import { getMetaTools } from "./tools/mod.ts";

// Handlers
import {
  handleSearchTools,
  handleSearchCapabilities,
  handleExecuteCode,
  handleWorkflowExecution,
  handleContinue,
  handleAbort,
  handleReplan,
  handleApprovalResponse,
  type CodeExecutionDependencies,
  type WorkflowHandlerDependencies,
} from "./handlers/mod.ts";

// Re-export for backward compatibility
export type { GatewayServerConfig };

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

  constructor(
    // @ts-ignore: db kept for future use (direct queries)
    private db: PGliteClient,
    private vectorSearch: VectorSearch,
    private graphEngine: GraphRAGEngine,
    private dagSuggester: DAGSuggester,
    // @ts-ignore: executor kept for API backward compatibility
    private _executor: ParallelExecutor,
    private mcpClients: Map<string, MCPClientBase>,
    private capabilityStore?: CapabilityStore,
    private adaptiveThresholdManager?: AdaptiveThresholdManager,
    config?: GatewayServerConfig,
  ) {
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

    this.setupHandlers();
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
      log.info(`list_tools: returning meta-tools only (ADR-013)`);

      const result = { tools: getMetaTools() };
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
      mcpClients: this.mcpClients,
      gatewayHandler: this.gatewayHandler,
      checkpointManager: this.checkpointManager,
      activeWorkflows: this.activeWorkflows,
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
      adaptiveThresholdManager: this.adaptiveThresholdManager,
      config: this.config,
      contextBuilder: this.contextBuilder,
      toolSchemaCache: this.toolSchemaCache,
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
  async start(): Promise<void> {
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
    // Class-specific cleanup
    this.healthChecker.stopPeriodicChecks();

    if (this.eventsStream) {
      this.eventsStream.close();
      this.eventsStream = null;
    }

    // Delegate core shutdown to lifecycle module
    await stopServer(this.server, this.mcpClients, this.httpServer);
    this.httpServer = null;
  }
}
