/**
 * MCP Registry Service (Story 14.7)
 *
 * Provides unified access to MCPs from pml_registry VIEW + mcp_server config.
 * No seed JSON - all metadata derived dynamically.
 *
 * @module mcp/registry/mcp-registry.service
 */

import * as log from "@std/log";
import type { DbClient } from "../../db/types.ts";
import {
  generateFQDN,
  getFQDNPartCount,
  parseFQDN,
  parseFQDNWithoutHash,
  stripHash,
} from "../../capabilities/fqdn.ts";
import type {
  McpCatalogItem,
  McpCatalogResponse,
  McpListOptions,
  McpRegistryEntry,
  McpRouting,
  McpType,
  PmlRegistryRow,
  ServerConnectionInfo,
} from "./types.ts";
import {
  buildHttpHashContent,
  buildStdioHashContent,
  computeIntegrity,
  deriveEnvRequired,
  deriveMcpType,
  extractShortHash,
} from "./hash-utils.ts";

// Cached server config from .mcp-servers.json
let cachedServerConfig: Record<string, ServerConnectionInfo> | null = null;

/**
 * Load MCP server config from config/.mcp-servers.json
 */
async function loadServerConfigFromFile(): Promise<Record<string, ServerConnectionInfo>> {
  if (cachedServerConfig !== null) return cachedServerConfig;

  try {
    const content = await Deno.readTextFile("config/.mcp-servers.json");
    const parsed = JSON.parse(content);
    // Handle { mcpServers: { ... } } format
    cachedServerConfig = parsed.mcpServers || parsed;
    log.debug("[McpRegistry] Loaded server config from config/.mcp-servers.json");
  } catch {
    log.debug("[McpRegistry] No .mcp-servers.json found");
    cachedServerConfig = {};
  }

  return cachedServerConfig!;
}

/**
 * MCP Registry Service
 *
 * Queries pml_registry VIEW and enriches with mcp_server config.
 */
export class McpRegistryService {
  constructor(private readonly db: DbClient) {}

  /**
   * Get MCP by full FQDN (5-part with hash).
   *
   * AC1-AC4: Returns entry with appropriate content type.
   * AC5: Returns null if hash doesn't match.
   *
   * @param fqdn - Full 5-part FQDN with hash
   * @returns Registry entry or null if not found/hash mismatch
   */
  async getByFqdn(fqdn: string): Promise<McpRegistryEntry | null> {
    const partCount = getFQDNPartCount(fqdn);
    if (partCount !== 5) {
      log.debug(`[McpRegistry] Invalid FQDN format: ${fqdn}`);
      return null;
    }

    // Validate FQDN format
    parseFQDN(fqdn);
    const fqdnWithoutHash = stripHash(fqdn);

    // Query pml_registry VIEW
    const entry = await this.findInRegistry(fqdnWithoutHash);
    if (!entry) {
      log.debug(`[McpRegistry] Not found in registry: ${fqdnWithoutHash}`);
      return null;
    }

    // Validate hash
    if (entry.fqdn !== fqdn) {
      log.debug(`[McpRegistry] Hash mismatch: expected ${entry.fqdn}, got ${fqdn}`);
      return null;
    }

    return entry;
  }

  /**
   * Get MCP by FQDN without hash (4-part).
   *
   * AC10: Returns current version for redirect.
   *
   * @param fqdnWithoutHash - 4-part FQDN without hash
   * @returns Registry entry or null if not found
   */
  async getByFqdnWithoutHash(fqdnWithoutHash: string): Promise<McpRegistryEntry | null> {
    const partCount = getFQDNPartCount(fqdnWithoutHash);
    if (partCount !== 4 && partCount !== 0) {
      // Could be 5-part FQDN, strip hash
      try {
        const stripped = stripHash(fqdnWithoutHash);
        return await this.findInRegistry(stripped);
      } catch {
        // Not a valid 5-part either
      }
    }

    return await this.findInRegistry(fqdnWithoutHash);
  }

  /**
   * Get current FQDN with hash for a 4-part FQDN.
   *
   * @param fqdnWithoutHash - 4-part FQDN
   * @returns Full 5-part FQDN or null if not found
   */
  async getCurrentFqdn(fqdnWithoutHash: string): Promise<string | null> {
    const entry = await this.findInRegistry(fqdnWithoutHash);
    return entry?.fqdn ?? null;
  }

  /**
   * List MCPs with filtering and pagination.
   *
   * AC8-AC9: Catalog listing with type filter.
   *
   * @param options - List options
   * @returns Paginated catalog response
   */
  async list(options: McpListOptions = {}): Promise<McpCatalogResponse> {
    const { type, routing, recordType, page = 1, limit = 50, search } = options;

    // Build WHERE clauses
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (search) {
      conditions.push(`(name ILIKE $${paramIndex} OR description ILIKE $${paramIndex})`);
      params.push(`%${search}%`);
      paramIndex++;
    }

    if (recordType) {
      conditions.push(`record_type = $${paramIndex}`);
      params.push(recordType);
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Get total count
    const countResult = await this.db.query(
      `SELECT COUNT(*) as total FROM pml_registry ${whereClause}`,
      params,
    );
    const total = parseInt(countResult[0]?.total as string) || 0;

    // Get paginated results
    const offset = (page - 1) * limit;
    const rows = (await this.db.query(
      `SELECT * FROM pml_registry ${whereClause} ORDER BY name LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, limit, offset],
    )) as unknown as PmlRegistryRow[];

    // Enrich and filter by type/routing (done post-query since derived)
    const enrichedItems: McpCatalogItem[] = [];

    for (const row of rows) {
      const entry = await this.enrichRow(row);
      if (entry) {
        // Apply type/routing filters
        if (type && entry.type !== type) continue;
        if (routing && entry.routing !== routing) continue;

        enrichedItems.push({
          fqdn: entry.fqdn,
          type: entry.type,
          routing: entry.routing,
          description: entry.description,
        });
      }
    }

    return {
      items: enrichedItems,
      total,
      page,
      limit,
    };
  }

  /**
   * Get TypeScript code for a deno-type MCP.
   *
   * AC1-AC2: Returns code for capabilities/MiniTools.
   *
   * @param fqdn - Full 5-part FQDN
   * @returns TypeScript code or null if not deno type
   */
  async getCode(fqdn: string): Promise<string | null> {
    const entry = await this.getByFqdn(fqdn);
    if (!entry || entry.type !== "deno") {
      return null;
    }

    // For capabilities: get code_snippet from workflow_pattern via capability_records
    if (entry.recordType === "capability") {
      try {
        const result = await this.db.query(
          `SELECT wp.code_snippet
           FROM capability_records cr
           JOIN workflow_pattern wp ON cr.workflow_pattern_id = wp.pattern_id
           WHERE cr.namespace = $1 AND cr.action = $2
           LIMIT 1`,
          [fqdn.split(".")[2], fqdn.split(".")[3]?.split(".")[0]], // namespace, action from FQDN
        );

        if (result.length > 0 && result[0].code_snippet) {
          return result[0].code_snippet as string;
        }
      } catch (e) {
        log.warn(`[McpRegistry] Failed to get code for ${fqdn}: ${e}`);
      }
    }

    // MiniTools (pml.std.*) are bundled client-side in lib/std/bundle.js
    // No server-side code serving needed - client uses local bundle
    return null;
  }

  // =========================================================================
  // Private Methods
  // =========================================================================

  /**
   * Find entry in pml_registry VIEW by 4-part FQDN.
   */
  private async findInRegistry(fqdnWithoutHash: string): Promise<McpRegistryEntry | null> {
    try {
      const parts = parseFQDNWithoutHash(fqdnWithoutHash);

      // Try to find by org.project.namespace.action pattern
      // For MiniTools: server_id = "std", name = "std:{tool}"
      // For capabilities: org, project, namespace, action columns

      let row: PmlRegistryRow | null = null;

      // Check if it's a capability (has org/project/namespace/action)
      const capResult = await this.db.query(
        `SELECT * FROM pml_registry
         WHERE org = $1 AND project = $2 AND namespace = $3 AND action = $4
         LIMIT 1`,
        [parts.org, parts.project, parts.namespace, parts.action],
      );

      if (capResult.length > 0) {
        row = capResult[0] as unknown as PmlRegistryRow;
      } else {
        // Try MCP tool lookup by server_id + name
        // DB: server_id = "filesystem", name = "read_file"
        // FQDN pml.mcp.filesystem.read_file → namespace=filesystem, action=read_file
        const toolResult = await this.db.query(
          `SELECT * FROM pml_registry
           WHERE server_id = $1 AND name = $2
           LIMIT 1`,
          [parts.namespace, parts.action],
        );

        if (toolResult.length > 0) {
          row = toolResult[0] as unknown as PmlRegistryRow;
        }
      }

      if (!row) {
        return null;
      }

      return await this.enrichRow(row);
    } catch (e) {
      log.debug(`[McpRegistry] Error finding ${fqdnWithoutHash}: ${e}`);
      return null;
    }
  }

  /**
   * Enrich a pml_registry row with server config.
   */
  private async enrichRow(row: PmlRegistryRow): Promise<McpRegistryEntry | null> {
    try {
      // Get server connection info from config file
      const config = await this.getServerConfig(row.server_id);

      // Derive type from config or row
      let type: McpType;
      if (config) {
        type = deriveMcpType(config);
      } else if (row.record_type === "capability" || row.server_id === "std") {
        type = "deno"; // Capabilities and MiniTools are built-in
      } else {
        type = "stdio"; // Default for unknown external servers
      }

      // Derive routing (from row or default based on type)
      const routing: McpRouting = (row.routing as McpRouting) || (type === "http" ? "server" : "client");

      // Compute integrity hash based on type
      let integrity: string;
      let hashContent: string;

      if (type === "stdio" && config) {
        hashContent = buildStdioHashContent(config);
      } else if (type === "http" && config) {
        hashContent = buildHttpHashContent(config);
      } else {
        // deno - use description + name as proxy for hash
        // NOTE: For capabilities, the actual code hash is computed when code is fetched via codeUrl.
        // This hash is for catalog/listing purposes only. Client lockfile uses ETag from actual fetch.
        hashContent = `${row.name}:${row.description || ""}`;
      }

      integrity = await computeIntegrity(type, hashContent);
      const shortHash = extractShortHash(integrity);

      // Build FQDN
      let fqdn: string;
      if (row.org && row.project && row.namespace && row.action) {
        // Capability
        fqdn = generateFQDN({
          org: row.org,
          project: row.project,
          namespace: row.namespace,
          action: row.action,
          hash: shortHash,
        });
      } else {
        // MCP tool - use server_id if available, otherwise derive from name
        let server: string;
        let tool: string;

        if (row.server_id) {
          // Use server_id from DB (preferred)
          server = row.server_id;
          tool = row.name.includes(":") ? row.name.split(":")[1] : row.name;
        } else if (row.name.includes(":")) {
          // Fallback: derive from name (server:tool format)
          [server, tool] = row.name.split(":");
        } else {
          // Last resort: assume std
          server = "std";
          tool = row.name;
        }

        fqdn = generateFQDN({
          org: "pml",
          project: "mcp", // MCP tools always use "mcp" project
          namespace: server,
          action: tool,
          hash: shortHash,
        });
      }

      // Build entry
      const entry: McpRegistryEntry = {
        fqdn,
        type,
        description: row.description || "",
        routing,
        tools: [row.name], // Simplified - could expand
        integrity,
        recordType: row.record_type,
        codeUrl: row.code_url || undefined,
        envRequired: deriveEnvRequired(config),
      };

      // Add type-specific fields
      if (type === "stdio" && config) {
        entry.install = {
          command: config.command || "",
          args: config.args || [],
          envRequired: deriveEnvRequired(config),
        };
      } else if (type === "http" && config) {
        entry.proxyTo = config.url;
      }

      return entry;
    } catch (e) {
      log.warn(`[McpRegistry] Error enriching row ${row.name}: ${e}`);
      return null;
    }
  }

  /**
   * Get server connection info from config/.mcp-servers.json
   */
  private async getServerConfig(serverId: string | null): Promise<ServerConnectionInfo | null> {
    if (!serverId) return null;

    const configs = await loadServerConfigFromFile();
    return configs[serverId] || null;
  }
}
