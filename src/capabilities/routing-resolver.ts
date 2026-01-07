/**
 * Routing Resolver (Story 13.9)
 *
 * Infers capability routing (client/server) from tools_used.
 * Config loaded from config/mcp-routing.json.
 *
 * DEFAULT IS CLIENT - only servers explicitly listed in 'server' array
 * can execute remotely. This is for security: client servers have
 * filesystem/process access that must NOT run on server.
 *
 * Terminology:
 * - client: Runs on user's machine (Claude Code, local MCP)
 * - server: Runs on pml.casys.ai (stateless computation, external APIs)
 *
 * @module capabilities/routing-resolver
 */

import { getLogger } from "../telemetry/logger.ts";
import type { CapabilityRouting } from "./types/fqdn.ts";

const logger = getLogger("default");

/**
 * Routing config structure (loaded from config/mcp-routing.json)
 * Only server-routed tools are listed - everything else defaults to client.
 */
interface McpRoutingJson {
  routing: {
    server: string[];
    client?: string[]; // Optional, for documentation only
  };
}

/**
 * Default empty config (all servers default to client)
 */
const EMPTY_CONFIG: McpRoutingJson = { routing: { server: [] } };

/**
 * Cached routing config
 */
let ROUTING_CACHE: McpRoutingJson | null = null;

/**
 * Config file paths to try (in order)
 */
const CONFIG_PATHS = [
  "./config/mcp-routing.json",
  "../config/mcp-routing.json",
  "../../config/mcp-routing.json",
];

/**
 * Validate that parsed JSON has correct structure
 */
function isValidConfig(parsed: unknown): parsed is McpRoutingJson {
  if (typeof parsed !== "object" || parsed === null) return false;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.routing !== "object" || obj.routing === null) return false;
  const routing = obj.routing as Record<string, unknown>;
  return Array.isArray(routing.server);
}

/**
 * Parse and validate JSON config content
 */
function parseConfig(content: string, path: string): McpRoutingJson | null {
  try {
    const parsed = JSON.parse(content);
    if (!isValidConfig(parsed)) {
      logger.warn("Invalid mcp-routing.json structure, missing routing.server array", { path });
      return null;
    }
    return parsed;
  } catch (err) {
    logger.warn("Failed to parse mcp-routing.json", { path, error: String(err) });
    return null;
  }
}

/**
 * Load routing config synchronously (used on first access)
 */
function loadRoutingJsonSync(): McpRoutingJson {
  for (const configPath of CONFIG_PATHS) {
    try {
      const content = Deno.readTextFileSync(configPath);
      const config = parseConfig(content, configPath);
      if (config) {
        logger.debug("MCP routing config loaded (sync)", {
          path: configPath,
          serverCount: config.routing.server.length,
        });
        return config;
      }
    } catch {
      // Try next path
    }
  }

  logger.debug("MCP routing config not found, defaulting all to client");
  return EMPTY_CONFIG;
}

/**
 * Load routing config from JSON file (async version)
 */
async function loadRoutingJson(): Promise<McpRoutingJson> {
  if (ROUTING_CACHE !== null) {
    return ROUTING_CACHE;
  }

  for (const configPath of CONFIG_PATHS) {
    try {
      const content = await Deno.readTextFile(configPath);
      const config = parseConfig(content, configPath);
      if (config) {
        ROUTING_CACHE = config;
        logger.debug("MCP routing config loaded", {
          path: configPath,
          serverCount: config.routing.server.length,
        });
        return config;
      }
    } catch {
      // Try next path
    }
  }

  logger.debug("MCP routing config not found, defaulting all to client");
  ROUTING_CACHE = EMPTY_CONFIG;
  return ROUTING_CACHE;
}

/**
 * Get routing config, loading synchronously if needed
 * Ensures config is always available (no race condition)
 */
function getRoutingConfig(): McpRoutingJson {
  if (ROUTING_CACHE === null) {
    ROUTING_CACHE = loadRoutingJsonSync();
  }
  return ROUTING_CACHE;
}

/**
 * Check if a tool matches a pattern (supports wildcards)
 * e.g., "filesystem:read" matches "filesystem:*"
 */
function matchesPattern(toolId: string, pattern: string): boolean {
  if (!toolId || !pattern) return false;

  if (pattern.endsWith(":*")) {
    const prefix = pattern.slice(0, -2);
    return toolId.startsWith(prefix + ":") || toolId === prefix;
  }
  return toolId === pattern;
}

/**
 * Check if tool/server is in the server list (can run on pml.casys.ai)
 */
function isInServerList(toolId: string): boolean {
  if (!toolId || typeof toolId !== "string") return false;

  const config = getRoutingConfig();
  const serverName = extractServerName(toolId);

  return config.routing.server.some((pattern) =>
    matchesPattern(toolId, pattern) || matchesPattern(serverName, pattern)
  );
}

/**
 * Extract server name from tool ID
 *
 * @example
 * extractServerName("filesystem:read_file") // "filesystem"
 * extractServerName("mcp__code__analyze") // "code"
 * extractServerName("memory") // "memory"
 * extractServerName("") // ""
 */
export function extractServerName(toolId: string): string {
  if (!toolId || typeof toolId !== "string") return "";

  // Handle mcp__namespace__action format (capability tools)
  if (toolId.startsWith("mcp__")) {
    const parts = toolId.split("__");
    return parts[1] || "";
  }

  // Handle standard format: server:action
  const colonIndex = toolId.indexOf(":");
  if (colonIndex > 0) {
    return toolId.slice(0, colonIndex);
  }

  return toolId;
}

/**
 * Check if a server requires client execution
 * Default is CLIENT - only returns false if explicitly in server list
 */
export function isClientServer(serverName: string): boolean {
  return !isInServerList(serverName);
}

/**
 * Check if a server can run on server (pml.casys.ai)
 */
export function isServerRouted(serverName: string): boolean {
  return isInServerList(serverName);
}

// Legacy aliases for backwards compatibility
export const isLocalServer = isClientServer;
export const isCloudServer = isServerRouted;

/**
 * Resolve routing for a capability based on tools used
 *
 * Algorithm:
 * 1. If explicit override provided, use it
 * 2. If no tools used (pure compute), return 'server' (safe)
 * 3. If ANY tool requires client, return 'client'
 * 4. If ALL tools are in server list, return 'server'
 *
 * Client servers (filesystem, shell, etc.) access USER resources.
 * Server-routed tools (tavily, github, etc.) use HTTP APIs with keys.
 *
 * @param toolsUsed - Array of tool IDs used by the capability
 * @param explicitOverride - Optional explicit routing override
 * @returns 'client' or 'server'
 */
export function resolveRouting(
  toolsUsed: string[],
  explicitOverride?: CapabilityRouting,
): CapabilityRouting {
  // 1. Explicit override takes precedence
  if (explicitOverride) {
    return explicitOverride;
  }

  // 2. No tools = pure compute = server safe (AC6)
  if (!toolsUsed || toolsUsed.length === 0) {
    return "server";
  }

  // 3. Check each tool - any client-only = capability is client
  // Filter out invalid entries (null, undefined, empty strings)
  const validTools = toolsUsed.filter((t) => t && typeof t === "string");

  for (const tool of validTools) {
    if (!isInServerList(tool)) {
      logger.debug("Capability requires client routing", {
        tool,
        serverName: extractServerName(tool),
      });
      return "client";
    }
  }

  // 4. All tools are explicitly in server list (or all were invalid)
  return validTools.length > 0 ? "server" : "server";
}

/**
 * Force reload of routing config
 */
export function reloadRoutingConfig(): void {
  ROUTING_CACHE = null;
}

/**
 * Initialize routing config by loading from file (async)
 * Call this at server startup for optimal performance
 */
export async function initRoutingConfig(): Promise<void> {
  await loadRoutingJson();
}

/**
 * Sync all capability routing based on current config.
 * Call this after config changes to update existing capabilities.
 *
 * @param db - Database client
 * @param dryRun - If true, only log changes without applying
 * @returns Number of capabilities updated
 */
export async function syncCapabilityRouting(
  db: { query: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]> },
  dryRun = false,
): Promise<{ updated: number; unchanged: number; noTools: number }> {
  // Ensure config is loaded
  if (ROUTING_CACHE === null) {
    await loadRoutingJson();
  }

  // Get all capabilities with tools_used
  const rows = await db.query(`
    SELECT
      cr.id,
      cr.namespace,
      cr.action,
      cr.routing,
      wp.dag_structure->'tools_used' as tools_used
    FROM capability_records cr
    LEFT JOIN workflow_pattern wp ON cr.workflow_pattern_id = wp.pattern_id
  `);

  let updated = 0;
  let unchanged = 0;
  let noTools = 0;

  for (const row of rows) {
    const toolsUsed = parseToolsUsedFromDb(row.tools_used);

    if (!toolsUsed || toolsUsed.length === 0) {
      noTools++;
      continue;
    }

    const newRouting = resolveRouting(toolsUsed);
    const currentRouting = row.routing as string;

    if (newRouting === currentRouting) {
      unchanged++;
      continue;
    }

    updated++;
    logger.info("Routing changed for capability", {
      id: row.id,
      name: `${row.namespace}:${row.action}`,
      from: currentRouting,
      to: newRouting,
      dryRun,
    });

    if (!dryRun) {
      await db.query(
        `UPDATE capability_records SET routing = $1, updated_at = NOW() WHERE id = $2`,
        [newRouting, row.id],
      );
    }
  }

  return { updated, unchanged, noTools };
}

/**
 * Parse tools_used from DB (can be JSONB or string)
 */
function parseToolsUsedFromDb(raw: unknown): string[] | null {
  if (!raw) return null;
  if (Array.isArray(raw)) return raw.filter((t) => typeof t === "string");
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((t: unknown) => typeof t === "string") : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Get routing for a single tool
 */
export function getToolRouting(toolId: string): CapabilityRouting {
  return isInServerList(toolId) ? "server" : "client";
}

/**
 * Get hash of current routing config for change detection
 */
export function getRoutingConfigHash(): string {
  const config = getRoutingConfig();
  const content = JSON.stringify(config.routing.server.sort());
  // Simple hash
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(16);
}

/**
 * Check if routing config changed and sync if needed.
 * Uses Deno KV to store last known config hash.
 *
 * @param db - Database client for capability updates
 * @returns Object with sync status and counts
 */
export async function checkAndSyncRouting(
  db: { query: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]> },
): Promise<{ synced: boolean; updated: number; unchanged: number; noTools: number }> {
  // Ensure config is loaded
  await initRoutingConfig();

  const currentHash = getRoutingConfigHash();
  const kv = await Deno.openKv();

  try {
    const storedHash = await kv.get<string>(["routing-config-hash"]);

    if (storedHash.value === currentHash) {
      logger.debug("Routing config unchanged, skipping sync");
      return { synced: false, updated: 0, unchanged: 0, noTools: 0 };
    }

    logger.info("Routing config changed, syncing capabilities", {
      oldHash: storedHash.value,
      newHash: currentHash,
    });

    const result = await syncCapabilityRouting(db, false);

    // Store new hash
    await kv.set(["routing-config-hash"], currentHash);

    logger.info("Routing sync complete", result);

    return { synced: true, ...result };
  } finally {
    kv.close();
  }
}
