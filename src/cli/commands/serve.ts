/**
 * Serve Command
 *
 * CLI command to start Casys PML as an MCP gateway server
 *
 * @module cli/commands/serve
 */

import { Command } from "@cliffy/command";
import * as log from "@std/log";
import { createDefaultClient } from "../../db/client.ts";
import { getAllMigrations, MigrationRunner } from "../../db/migrations.ts";
import { MCPServerDiscovery } from "../../mcp/discovery.ts";
import { MCPClient } from "../../mcp/client.ts";
import { SmitheryMCPClient } from "../../mcp/smithery-client.ts";
import { EmbeddingModel } from "../../vector/embeddings.ts";
import { VectorSearch } from "../../vector/search.ts";
import { GraphRAGEngine } from "../../graphrag/graph-engine.ts";
import { DAGSuggester } from "../../graphrag/dag-suggester.ts";
import { ParallelExecutor } from "../../dag/executor.ts";
import { PMLGatewayServer } from "../../mcp/gateway-server.ts";
import { WorkflowSyncService } from "../../graphrag/workflow-sync.ts";
import { getWorkflowTemplatesPath } from "../utils.ts";
import { autoInitIfConfigChanged } from "../auto-init.ts";
import type { MCPClientBase, MCPServer } from "../../mcp/types.ts";
import type { ToolExecutor } from "../../dag/types.ts";
import { CapabilityMatcher } from "../../capabilities/matcher.ts";
import { CapabilityStore } from "../../capabilities/capability-store.ts";
import { SchemaInferrer } from "../../capabilities/schema-inferrer.ts";
import { AdaptiveThresholdManager } from "../../mcp/adaptive-threshold.ts";
import { AlgorithmTracer } from "../../telemetry/algorithm-tracer.ts";
import { ensureStdBundle } from "../../lib/std-loader.ts";

/**
 * Find and validate config file
 *
 * Requires explicit --config flag to avoid assumptions about config location.
 * This makes the tool more predictable and easier to use in different environments.
 */
async function findConfigFile(configPath?: string): Promise<string> {
  if (!configPath) {
    throw new Error(
      `❌ No MCP server configuration provided.

Please specify your MCP servers config file using --config:

  ${Deno.build.os === "windows" ? ">" : "$"} cai serve --port 3001 --config <path-to-config>

Examples:
  • ./config/mcp-servers.json
  • ./playground/config/mcp-servers.json
  • ~/.config/cai/mcp-servers.json

Need help creating a config? See: https://github.com/casys-ai/casys-pml#configuration`,
    );
  }

  try {
    await Deno.stat(configPath);
    log.info(`✓ Found MCP config: ${configPath}`);
    return configPath;
  } catch {
    throw new Error(
      `❌ Config file not found: ${configPath}

Please check that the file exists and the path is correct.`,
    );
  }
}

/**
 * Discover and connect to MCP servers
 *
 * Handles both stdio (MCPClient) and HTTP Streamable (SmitheryMCPClient) protocols.
 *
 * @param servers - List of server configurations
 * @param smitheryApiKey - Optional Smithery API key for HTTP servers
 */
async function connectToMCPServers(
  servers: MCPServer[],
  smitheryApiKey?: string,
): Promise<Map<string, MCPClientBase>> {
  const clients = new Map<string, MCPClientBase>();

  const stdioServers = servers.filter((s) => s.protocol === "stdio");
  const httpServers = servers.filter((s) => s.protocol === "http");

  log.info(
    `Connecting to ${servers.length} MCP server(s) ` +
      `(${stdioServers.length} stdio, ${httpServers.length} HTTP)...`,
  );

  // Connect to stdio servers
  for (const server of stdioServers) {
    try {
      const client = new MCPClient(server, 10000);
      await client.connect();
      clients.set(server.id, client);
      log.info(`  ✓ Connected (stdio): ${server.id}`);
    } catch (error) {
      log.error(`  ✗ Failed to connect to ${server.id}: ${error}`);
      // Continue with other servers (gateway is resilient to individual failures)
    }
  }

  // Connect to HTTP Streamable (Smithery) servers
  if (httpServers.length > 0) {
    if (!smitheryApiKey) {
      log.warn(
        `  ⚠ ${httpServers.length} HTTP server(s) skipped: SMITHERY_API_KEY not set`,
      );
    } else {
      for (const server of httpServers) {
        try {
          const client = new SmitheryMCPClient(server, {
            apiKey: smitheryApiKey,
            timeoutMs: 30000,
          });
          await client.connect();
          clients.set(server.id, client);
          log.info(`  ✓ Connected (HTTP): ${server.id}`);
        } catch (error) {
          log.error(`  ✗ Failed to connect to Smithery ${server.id}: ${error}`);
          // Continue with other servers
        }
      }
    }
  }

  if (clients.size === 0) {
    throw new Error("Failed to connect to any MCP servers");
  }

  return clients;
}

/**
 * Callback type for tool execution tracking (Story 3.7 cache invalidation)
 */
type OnToolCallCallback = (toolKey: string) => void;

/**
 * Create tool executor function for ParallelExecutor
 *
 * This function is called by the executor to execute individual tools.
 * It routes tool calls to the appropriate MCP client (stdio or HTTP).
 *
 * @param clients - Map of MCP clients by server ID
 * @param onToolCall - Optional callback for tracking tool usage (Story 3.7)
 */
function createToolExecutor(
  clients: Map<string, MCPClientBase>,
  onToolCall?: OnToolCallCallback,
): ToolExecutor {
  return async (toolName: string, args: Record<string, unknown>) => {
    // Parse tool name: "serverId:toolName"
    const [serverId, ...toolNameParts] = toolName.split(":");
    const actualToolName = toolNameParts.join(":");

    const client = clients.get(serverId);
    if (!client) {
      throw new Error(`Unknown MCP server: ${serverId}`);
    }

    // Track tool call for cache invalidation (Story 3.7)
    if (onToolCall) {
      onToolCall(toolName);
    }

    // Execute tool via MCP client
    return await client.callTool(actualToolName, args);
  };
}

/**
 * Create serve command
 *
 * Usage:
 *   cai serve --config ./config/mcp-servers.json --port 3001
 *   cai serve --config ~/.config/cai/mcp-servers.json
 */
export function createServeCommand() {
  return new Command()
    .name("serve")
    .description("Start Casys PML MCP gateway server")
    .option(
      "--config <path:string>",
      "Path to MCP servers config file (required)",
    )
    .option(
      "--port <port:number>",
      "HTTP port for HTTP/SSE transport (optional, stdio is default)",
    )
    .option(
      "--no-speculative",
      "Disable speculative execution mode",
      { default: true },
    )
    .option(
      "--no-pii-protection",
      "Disable PII detection and tokenization (use in trusted environments only)",
      { default: true },
    )
    .option(
      "--no-cache",
      "Disable code execution caching (forces re-execution every time)",
      { default: true },
    )
    .action(async (options) => {
      try {
        log.info("🚀 Starting Casys PML MCP Gateway...\n");

        // 0. Ensure std bundle is up-to-date (for sandbox)
        await ensureStdBundle();

        // 1. Find and load config
        log.info("Step 1/7: Loading configuration...");
        const configPath = await findConfigFile(options.config);
        const discovery = new MCPServerDiscovery(configPath);
        await discovery.loadConfig();

        // Load from Smithery if API key is set
        const smitheryApiKey = Deno.env.get("SMITHERY_API_KEY");
        if (smitheryApiKey) {
          log.info("  → Loading servers from Smithery...");
          await discovery.loadFromSmithery(smitheryApiKey);
        }

        // Get all servers (local + Smithery merged)
        const allServers = await discovery.discoverServers();

        if (allServers.length === 0) {
          throw new Error("No MCP servers configured");
        }

        // 2. Initialize database
        log.info("Step 2/6: Initializing database...");
        const db = createDefaultClient();
        await db.connect();

        // Run migrations
        const runner = new MigrationRunner(db);
        await runner.runUp(getAllMigrations());

        // 2.5 Auto-init if config changed (discovers tools & generates embeddings)
        const autoInitResult = await autoInitIfConfigChanged(configPath, db);
        if (autoInitResult.performed) {
          log.info(
            `✓ Auto-init: ${autoInitResult.toolsCount} tools discovered (${autoInitResult.reason})`,
          );
        }

        // 3. Connect to MCP servers
        log.info("Step 3/6: Connecting to MCP servers...");
        const mcpClients = await connectToMCPServers(allServers, smitheryApiKey);

        // 4. Initialize AI components
        log.info("Step 4/6: Loading AI models...");
        const embeddingModel = new EmbeddingModel();
        await embeddingModel.load();

        const vectorSearch = new VectorSearch(db, embeddingModel);

        // Story 5.2: Auto-bootstrap graph from workflow templates if empty
        // Must be after MCP connection (tool_schema populated) and embedding model loaded
        const workflowSyncService = new WorkflowSyncService(db);
        const bootstrapped = await workflowSyncService.bootstrapIfEmpty(
          getWorkflowTemplatesPath(),
        );
        if (bootstrapped) {
          log.info("✓ Graph bootstrapped from workflow-templates.yaml");
        }

        const graphEngine = new GraphRAGEngine(db);
        await graphEngine.syncFromDatabase();

        // 4.1 Initialize Capabilities System (Story 7.3a)
        const schemaInferrer = new SchemaInferrer(db);
        const capabilityStore = new CapabilityStore(db, embeddingModel, schemaInferrer);
        const adaptiveThresholdManager = new AdaptiveThresholdManager({}, db);
        const capabilityMatcher = new CapabilityMatcher(capabilityStore, adaptiveThresholdManager);

        const dagSuggester = new DAGSuggester(graphEngine, vectorSearch, capabilityMatcher, capabilityStore);

        // Story 7.6: Wire AlgorithmTracer for observability (ADR-039)
        const algorithmTracer = new AlgorithmTracer(db);
        capabilityMatcher.setAlgorithmTracer(algorithmTracer);
        dagSuggester.setAlgorithmTracer(algorithmTracer);
        log.info("✓ Algorithm tracing enabled");

        // Create tool executor with tracking callback (Story 3.7)
        // Gateway reference will be set after gateway is created
        let gatewayRef: { trackToolUsage: (toolKey: string) => Promise<void> } | null = null;
        const toolExecutor = createToolExecutor(mcpClients, (toolKey) => {
          // Fire-and-forget tracking - don't block tool execution
          gatewayRef?.trackToolUsage(toolKey).catch(() => {});
        });
        const executor = new ParallelExecutor(toolExecutor, {
          verbose: false,
          taskTimeout: 30000,
        });

        // Check PII protection settings
        // --no-pii-protection sets options.piiProtection to false
        // Support both CAI_NO_PII_PROTECTION and legacy AGENTCARDS_NO_PII_PROTECTION
        const piiProtectionEnabled = options.piiProtection !== false &&
          Deno.env.get("CAI_NO_PII_PROTECTION") !== "1" &&
          Deno.env.get("AGENTCARDS_NO_PII_PROTECTION") !== "1";

        if (!piiProtectionEnabled) {
          log.warn(
            "⚠️  PII protection is DISABLED. Sensitive data may be exposed to LLM context.",
          );
        }

        // Check cache settings
        // --no-cache sets options.cache to false
        // Support both CAI_NO_CACHE and legacy AGENTCARDS_NO_CACHE
        const cacheEnabled = options.cache !== false &&
          Deno.env.get("CAI_NO_CACHE") !== "1" &&
          Deno.env.get("AGENTCARDS_NO_CACHE") !== "1";

        if (!cacheEnabled) {
          log.warn(
            "⚠️  Code execution cache is DISABLED. Performance may be degraded for repetitive queries.",
          );
        }

        // 5. Create gateway server
        log.info("Step 5/6: Starting MCP gateway...");
        const gateway = new PMLGatewayServer(
          db,
          vectorSearch,
          graphEngine,
          dagSuggester,
          executor,
          mcpClients,
          capabilityStore,
          adaptiveThresholdManager,
          {
            name: "pml",
            version: "1.0.0",
            enableSpeculative: options.speculative,
            defaultToolLimit: 10,
            piiProtection: {
              enabled: piiProtectionEnabled,
            },
            cacheConfig: {
              enabled: cacheEnabled,
              maxEntries: 100,
              ttlSeconds: 300,
              persistence: false,
            },
          },
          embeddingModel, // Story 10.7: Pass for SHGAT scoring
        );

        // Connect gateway to tool tracking callback (Story 3.7)
        gatewayRef = gateway;

        // 6. Start gateway (stdio or HTTP mode based on --port option)
        log.info("Step 6/6: Listening for MCP requests...\n");
        if (options.port) {
          await gateway.startHttp(options.port);
        } else {
          await gateway.start();
        }

        // Setup graceful shutdown (ADR-020: Fix hanging shutdown)
        let isShuttingDown = false;
        const shutdown = () => {
          if (isShuttingDown) return;
          isShuttingDown = true;

          log.info("\n\nShutting down...");
          log.info("Shutting down Casys PML gateway...");

          // Force exit after 10 seconds if graceful shutdown hangs
          // PGlite needs time to flush WAL and close cleanly
          const forceExitTimer = setTimeout(() => {
            log.warn("Graceful shutdown timeout - forcing exit");
            Deno.exit(1);
          }, 10000);

          // Attempt graceful shutdown
          Promise.all([
            gateway.stop(),
            db.close(),
          ])
            .then(() => {
              clearTimeout(forceExitTimer);
              log.info("✓ Shutdown complete");
              Deno.exit(0);
            })
            .catch((err) => {
              clearTimeout(forceExitTimer);
              log.error(`Shutdown error: ${err}`);
              Deno.exit(1);
            });
        };

        Deno.addSignalListener("SIGINT", shutdown);
        Deno.addSignalListener("SIGTERM", shutdown);

        // Keep process alive
        await new Promise(() => {}); // Run forever
      } catch (error) {
        log.error(`❌ Failed to start gateway: ${error}`);
        console.error(error);
        Deno.exit(1);
      }
    });
}
