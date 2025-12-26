/**
 * Auto-Init Service
 *
 * Automatically runs init when MCP config file changes.
 * Compares file hash with stored hash to detect changes.
 *
 * @module cli/auto-init
 */

import * as log from "@std/log";
import type { DbClient } from "../db/mod.ts";
import { MCPServerDiscovery } from "../mcp/discovery.ts";
import { SchemaExtractor } from "../mcp/schema-extractor.ts";
import { EmbeddingModel, generateEmbeddings } from "../vector/embeddings.ts";
import { hashFile, MCP_CONFIG_HASH_KEY } from "./utils.ts";

/**
 * Auto-init options
 */
export interface AutoInitOptions {
  /** Force re-indexing even if config hasn't changed */
  forceReindex?: boolean;
}

/**
 * Auto-init result
 */
export interface AutoInitResult {
  /** Whether init was performed */
  performed: boolean;
  /** Reason for the result */
  reason: "config_changed" | "first_run" | "tool_count_changed" | "force_reindex" | "no_change" | "error";
  /** Number of tools discovered (if init was performed) */
  toolsCount?: number;
  /** Error message (if error occurred) */
  error?: string;
}

/**
 * Check if MCP config has changed and run init if needed
 *
 * Triggers re-indexing when:
 * - Config file hash changed
 * - First run (no stored hash)
 * - Tool count mismatch (code changed but not config)
 * - Force reindex flag is set
 *
 * @param configPath - Path to MCP servers config file
 * @param db - Database client
 * @param options - Optional settings (forceReindex)
 * @returns Auto-init result
 */
export async function autoInitIfConfigChanged(
  configPath: string,
  db: DbClient,
  options?: AutoInitOptions,
): Promise<AutoInitResult> {
  try {
    // 0. Check force reindex flag
    if (options?.forceReindex) {
      log.info("[auto-init] Force reindex requested, running init...");
      const toolsCount = await runInit(configPath, db);
      const currentHash = await hashFile(configPath);
      await storeConfigHash(db, currentHash);
      log.info(`[auto-init] Complete: ${toolsCount} tools discovered`);
      return { performed: true, reason: "force_reindex", toolsCount };
    }

    // 1. Calculate current config hash
    const currentHash = await hashFile(configPath);

    // 2. Get stored hash from database
    const storedHash = await getStoredConfigHash(db);

    // 3. Check if config hash changed
    if (storedHash !== currentHash) {
      const reason = storedHash === null ? "first_run" : "config_changed";
      log.info(
        `[auto-init] ${reason === "first_run" ? "First run" : "Config changed"}, running init...`,
      );

      const toolsCount = await runInit(configPath, db);
      await storeConfigHash(db, currentHash);

      log.info(`[auto-init] Complete: ${toolsCount} tools discovered`);
      return { performed: true, reason, toolsCount };
    }

    // 4. Check if tool count changed (code changed but not config)
    const toolCountChanged = await checkToolCountMismatch(configPath, db);
    if (toolCountChanged) {
      log.info("[auto-init] Tool count mismatch detected, running init...");
      const toolsCount = await runInit(configPath, db);
      log.info(`[auto-init] Complete: ${toolsCount} tools discovered`);
      return { performed: true, reason: "tool_count_changed", toolsCount };
    }

    log.debug("[auto-init] Config unchanged and tool count matches, skipping init");
    return { performed: false, reason: "no_change" };
  } catch (error) {
    log.error(`[auto-init] Error: ${error}`);
    return {
      performed: false,
      reason: "error",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Check if the expected tool count differs from what's in the database
 * This detects when code changes add/remove tools but config stays the same
 */
async function checkToolCountMismatch(
  configPath: string,
  db: DbClient,
): Promise<boolean> {
  try {
    // Load config to validate it exists
    const discovery = new MCPServerDiscovery(configPath);
    await discovery.loadConfig();

    // Get current tool count in DB per server
    const dbCounts = await db.query(
      `SELECT server_id, COUNT(*) as count FROM tool_schema GROUP BY server_id`,
    ) as Array<{ server_id: string; count: string }>;

    const dbCountMap = new Map<string, number>();
    for (const row of dbCounts) {
      dbCountMap.set(row.server_id, parseInt(row.count, 10));
    }

    // For 'std' server specifically, check against allTools count
    // This catches when lib/std tools are added/removed
    if (dbCountMap.has("std")) {
      const { allTools } = await import("../../lib/std/mod.ts");
      const expectedStdCount = allTools.length;
      const actualStdCount = dbCountMap.get("std") || 0;

      if (expectedStdCount !== actualStdCount) {
        log.info(
          `[auto-init] std tool count mismatch: DB has ${actualStdCount}, code has ${expectedStdCount}`,
        );
        return true;
      }
    }

    return false;
  } catch (error) {
    log.debug(`[auto-init] Tool count check failed: ${error}`);
    return false; // Don't trigger reindex on check failure
  }
}

/**
 * Run the init logic (schema extraction + embeddings)
 */
async function runInit(configPath: string, db: DbClient): Promise<number> {
  // 1. Load config and discover servers
  const discovery = new MCPServerDiscovery(configPath);
  const config = await discovery.loadConfig();

  if (config.servers.length === 0) {
    log.warn("[auto-init] No servers in config");
    return 0;
  }

  // 2. Extract schemas from all servers
  const extractor = new SchemaExtractor(configPath, db);
  const result = await extractor.extractAndStore();
  const toolsCount = result.totalToolsExtracted;

  log.info(
    `[auto-init] Extracted ${toolsCount} tools from ${result.successfulServers}/${result.totalServers} servers`,
  );

  // 3. Generate embeddings for new tools
  if (toolsCount > 0) {
    log.info("[auto-init] Generating embeddings...");
    const embeddingModel = new EmbeddingModel();
    await embeddingModel.load();
    const embeddingResult = await generateEmbeddings(db, embeddingModel);
    log.info(
      `[auto-init] Generated ${embeddingResult.newlyGenerated} embeddings (${embeddingResult.cachedCount} cached)`,
    );
  }

  return toolsCount;
}

/**
 * Get stored config hash from database
 */
async function getStoredConfigHash(db: DbClient): Promise<string | null> {
  try {
    const result = await db.queryOne(
      `SELECT value FROM config WHERE key = $1`,
      [MCP_CONFIG_HASH_KEY],
    );
    if (result && typeof result === "object" && "value" in result) {
      return (result as { value: string }).value;
    }
    return null;
  } catch {
    // Table might not exist yet or other error
    return null;
  }
}

/**
 * Store config hash in database
 */
async function storeConfigHash(db: DbClient, hash: string): Promise<void> {
  await db.query(
    `INSERT INTO config (key, value)
     VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = $2`,
    [MCP_CONFIG_HASH_KEY, hash],
  );
}
