/**
 * MCP Server Discovery and Configuration
 *
 * Discovers MCP servers from configuration file and manages connections
 *
 * @module mcp/discovery
 */

import { parse } from "@std/yaml";
import * as log from "@std/log";
import { MCPConfig, MCPServer } from "./types.ts";
import { SmitheryLoader } from "./smithery-loader.ts";

/**
 * MCP Server Discovery Engine
 *
 * Responsible for:
 * - Loading and parsing MCP server configurations
 * - Discovering servers from config files and Smithery API
 * - Establishing connections to stdio and HTTP Streamable servers
 * - Extracting tool schemas via MCP list_tools protocol
 */
export class MCPServerDiscovery {
  private config: MCPConfig | null = null;
  private configPath: string;
  private smitheryServers: MCPServer[] = [];
  private smitheryLoader: SmitheryLoader;

  constructor(configPath: string) {
    this.configPath = configPath;
    this.smitheryLoader = new SmitheryLoader();
  }

  /**
   * Load and parse MCP configuration from YAML file
   *
   * Supports both ~/.pml/config.yaml and Claude Code mcp.json
   */
  async loadConfig(): Promise<MCPConfig> {
    try {
      log.debug(`Loading MCP configuration from ${this.configPath}`);

      // Read config file
      const fileContent = await Deno.readTextFile(this.configPath);

      // Parse YAML or JSON based on file extension
      let parsed: unknown;

      if (this.configPath.endsWith(".json")) {
        parsed = JSON.parse(fileContent);
      } else {
        parsed = parse(fileContent) as Record<string, unknown>;
      }

      // Normalize to MCPConfig format
      const config = this.normalizeConfig(parsed);

      // Validate configuration
      this.validateConfig(config);

      this.config = config;
      log.info(`Configuration loaded: ${config.servers.length} servers found`);

      return config;
    } catch (error) {
      log.error(`Failed to load configuration: ${error}`);
      throw new Error(`Cannot load MCP configuration: ${error}`);
    }
  }

  /**
   * Normalize various config formats to MCPConfig
   *
   * Supports:
   * - Claude Code mcp.json format: { mcpServers: { "name": { command, args } } }
   * - Smithery HTTP format: { mcpServers: { "name": { type: "http", url: "..." } } }
   * - Casys PML format: { servers: [...] }
   */
  private normalizeConfig(raw: unknown): MCPConfig {
    // Handle Claude Code mcp.json format: { mcpServers: { "name": { command, args, ... } } }
    if (
      typeof raw === "object" && raw !== null && "mcpServers" in raw
    ) {
      const mcpServers = (raw as Record<string, unknown>).mcpServers as
        | Record<string, unknown>
        | undefined;

      if (!mcpServers || typeof mcpServers !== "object") {
        return { servers: [] };
      }

      const servers: MCPServer[] = [];
      for (const [id, config] of Object.entries(mcpServers)) {
        if (typeof config === "object" && config !== null) {
          const cfg = config as Record<string, unknown>;

          // Detect protocol from type field or presence of url
          const configType = cfg.type as string | undefined;
          const isHttp = configType === "http" || (cfg.url && !cfg.command);
          const protocol = isHttp ? "http" : "stdio";

          servers.push({
            id,
            name: id,
            command: cfg.command ? String(cfg.command) : undefined,
            args: Array.isArray(cfg.args) ? cfg.args.map(String) : undefined,
            env: typeof cfg.env === "object" ? cfg.env as Record<string, string> : undefined,
            protocol: protocol as "stdio" | "http",
            url: cfg.url ? String(cfg.url) : undefined,
            headers: typeof cfg.headers === "object"
              ? cfg.headers as Record<string, string>
              : undefined,
          });
        }
      }
      return { servers };
    }

    // Handle Casys PML config.yaml format: { servers: [...] }
    if (typeof raw === "object" && raw !== null && "servers" in raw) {
      const servers = (raw as Record<string, unknown>).servers;
      if (Array.isArray(servers)) {
        return {
          servers: servers.map((s) => {
            const srv = s as Record<string, unknown>;
            return {
              id: String(srv.id || srv.name || "unknown"),
              name: String(srv.name || srv.id || "unknown"),
              command: srv.command ? String(srv.command) : undefined,
              args: Array.isArray(srv.args) ? srv.args.map(String) : undefined,
              env: typeof srv.env === "object" ? srv.env as Record<string, string> : undefined,
              protocol: String(srv.protocol || "stdio") as "stdio" | "http",
              url: srv.url ? String(srv.url) : undefined,
              headers: typeof srv.headers === "object"
                ? srv.headers as Record<string, string>
                : undefined,
            };
          }),
        };
      }
    }

    return { servers: [] };
  }

  /**
   * Validate MCP configuration
   */
  private validateConfig(config: MCPConfig): void {
    if (!Array.isArray(config.servers)) {
      throw new Error("Invalid config: servers must be an array");
    }

    for (const server of config.servers) {
      if (!server.id || !server.name) {
        throw new Error(
          `Invalid server config: missing id or name`,
        );
      }

      // Validate based on protocol
      if (server.protocol === "http") {
        if (!server.url) {
          throw new Error(
            `Invalid HTTP server config for ${server.id}: missing url`,
          );
        }
      } else {
        // stdio protocol requires command
        if (!server.command) {
          throw new Error(
            `Invalid stdio server config for ${server.id}: missing command`,
          );
        }
      }

      if (server.protocol && !["stdio", "http"].includes(server.protocol)) {
        throw new Error(
          `Invalid protocol for ${server.id}: must be "stdio" or "http"`,
        );
      }
    }
  }

  /**
   * Load servers from Smithery registry
   *
   * Fetches MCP servers from the user's Smithery profile.
   * Gracefully degrades if Smithery is unreachable.
   *
   * @param apiKey - Smithery API key
   */
  async loadFromSmithery(apiKey: string): Promise<void> {
    try {
      this.smitheryServers = await this.smitheryLoader.loadServers(apiKey);
      log.info(`Loaded ${this.smitheryServers.length} server(s) from Smithery`);
    } catch (error) {
      // Graceful degradation: log warning but don't fail
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.warn(`Failed to load from Smithery (continuing with local servers): ${errorMessage}`);
      this.smitheryServers = [];
    }
  }

  /**
   * Discover all MCP servers from configuration
   *
   * Merges servers from:
   * 1. Local config file (priority - overrides Smithery if same ID)
   * 2. Smithery registry (if loaded via loadFromSmithery)
   *
   * Returns list of servers that can be connected to
   */
  async discoverServers(): Promise<MCPServer[]> {
    if (!this.config) {
      await this.loadConfig();
    }

    if (!this.config) {
      throw new Error("No servers configured");
    }

    // Merge: local servers take priority over Smithery servers
    const localIds = new Set(this.config.servers.map((s) => s.id));
    const smitheryFiltered = this.smitheryServers.filter(
      (s) => !localIds.has(s.id),
    );

    const allServers = [...this.config.servers, ...smitheryFiltered];

    log.info(
      `Discovered ${allServers.length} MCP servers ` +
        `(${this.config.servers.length} local, ${smitheryFiltered.length} Smithery)`,
    );

    return allServers;
  }

  /**
   * Get a specific server by ID
   */
  getServer(serverId: string): MCPServer | undefined {
    return this.config?.servers.find((s) => s.id === serverId);
  }

  /**
   * Get all servers with a specific protocol
   */
  getServersByProtocol(protocol: "stdio" | "http"): MCPServer[] {
    return this.config?.servers.filter((s) => s.protocol === protocol) || [];
  }

  /**
   * Get configuration
   */
  getConfig(): MCPConfig | null {
    return this.config;
  }
}

/**
 * Create a discovery engine for the default config location
 */
export function createDefaultDiscovery(): MCPServerDiscovery {
  const homeDir = Deno.env.get("HOME") || Deno.env.get("USERPROFILE") || ".";
  const configPath = `${homeDir}/.pml/config.yaml`;
  return new MCPServerDiscovery(configPath);
}
