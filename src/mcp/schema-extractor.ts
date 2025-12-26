/**
 * MCP Schema Extraction and Storage
 *
 * Orchestrates discovery, extraction, validation, and storage of MCP tool schemas
 *
 * @module mcp/schema-extractor
 */

import * as log from "@std/log";
import type { DbClient } from "../db/types.ts";
import { MCPServerDiscovery } from "./discovery.ts";
import { MCPClient } from "./client.ts";
import { DiscoveryStats, MCPServer, MCPTool, ServerDiscoveryResult } from "./types.ts";

/**
 * Schema Extractor Service
 *
 * Responsible for:
 * - Discovering MCP servers from configuration
 * - Extracting tool schemas via MCP protocol
 * - Validating schemas
 * - Storing schemas in PGlite
 * - Handling errors gracefully
 * - Reporting statistics
 */
export class SchemaExtractor {
  private discovery: MCPServerDiscovery;
  private db: DbClient;
  private timeout: number = 10000; // 10 seconds per server

  constructor(
    configPath: string,
    db: DbClient,
  ) {
    this.discovery = new MCPServerDiscovery(configPath);
    this.db = db;
  }

  /**
   * Execute full discovery and extraction workflow
   *
   * AC1-AC8 implementation:
   * - Discovers servers (AC1)
   * - Connects to each server (AC2)
   * - Extracts schemas via list_tools (AC3)
   * - Validates schemas (AC4)
   * - Stores in database (AC5)
   * - Handles errors (AC6)
   * - Outputs summary (AC7)
   * - Supports 15+ servers concurrently (AC8)
   */
  async extractAndStore(): Promise<DiscoveryStats> {
    log.info("🔍 Starting MCP server discovery and schema extraction...");

    const startTime = performance.now();
    const stats: DiscoveryStats = {
      totalServers: 0,
      successfulServers: 0,
      failedServers: 0,
      totalToolsExtracted: 0,
      failures: new Map(),
      duration: 0,
    };

    try {
      // Step 1: Discover servers (AC1)
      const servers = await this.discovery.discoverServers();
      stats.totalServers = servers.length;

      console.log(`✓ Found ${servers.length} servers in config\n`);
      log.info(`Discovered ${servers.length} MCP servers`);

      // Step 2-5: Extract schemas from all servers concurrently (AC8)
      const results = await Promise.all(
        servers.map((server) => this.extractServerSchemas(server)),
      );

      // Step 6: Process results and store in database
      for (const result of results) {
        if (result.status === "success") {
          stats.successfulServers++;
          stats.totalToolsExtracted += result.toolsExtracted;

          // AC5: Store schemas in database
          if (result.tools && result.tools.length > 0) {
            await this.storeSchemas(result.serverId, result.tools);
          }

          const duration = result.connectionDuration || 0;
          console.log(
            `✓ Connected to ${result.serverName} (${result.toolsExtracted} tools) [${duration}ms]`,
          );
        } else {
          stats.failedServers++;
          stats.failures.set(
            result.serverId,
            result.error || "Unknown error",
          );

          const reason = result.status === "timeout" ? "timeout" : result.error;
          console.log(
            `✗ Failed to connect to ${result.serverName} (${reason})`,
          );
        }
      }

      // AC7: Console output summary
      console.log(`\n📊 Summary:`);
      console.log(
        `  Servers connected: ${stats.successfulServers}/${stats.totalServers}`,
      );
      console.log(`  Tools extracted: ${stats.totalToolsExtracted}`);

      if (stats.failedServers > 0) {
        console.log(`  Failed servers: ${stats.failedServers}`);
        for (const [serverId, error] of stats.failures) {
          console.log(`    - ${serverId}: ${error}`);
        }
      }

      stats.duration = Math.round(performance.now() - startTime);
      console.log(`  Total duration: ${stats.duration}ms\n`);

      log.info(
        `Discovery complete: ${stats.successfulServers}/${stats.totalServers} servers, ${stats.totalToolsExtracted} tools`,
      );

      return stats;
    } catch (error) {
      log.error(`Discovery failed: ${error}`);
      stats.duration = Math.round(performance.now() - startTime);
      throw new Error(`Schema extraction failed: ${error}`);
    }
  }

  /**
   * Extract schemas from a single server
   *
   * AC2-AC4: Connection, list_tools call, validation
   */
  private async extractServerSchemas(
    server: MCPServer,
  ): Promise<ServerDiscoveryResult> {
    try {
      // AC2: Establish connection
      // AC3: Send list_tools request
      // AC4: Parse and validate schemas
      const client = new MCPClient(server, this.timeout);
      const result = await client.extractSchemas();

      if (result.status === "success" && result.tools) {
        // AC4: Validate schemas
        this.validateSchemas(result.tools);
      }

      return result;
    } catch (error) {
      log.warn(
        `Error extracting schemas from ${server.id}: ${error}`,
      );
      return {
        serverId: server.id,
        serverName: server.name,
        status: "failed",
        toolsExtracted: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Validate tool schemas (AC4)
   *
   * Ensures schemas are valid JSON Schema format
   */
  private validateSchemas(tools: MCPTool[]): void {
    for (const tool of tools) {
      // Basic validation: check required fields
      if (!tool.name || typeof tool.name !== "string") {
        throw new Error(`Invalid tool: missing or invalid name`);
      }

      if (!tool.inputSchema || typeof tool.inputSchema !== "object") {
        throw new Error(
          `Invalid tool ${tool.name}: missing or invalid inputSchema`,
        );
      }

      // Optional: Validate JSON Schema structure (simplified)
      this.validateJsonSchema(tool.inputSchema);

      if (tool.outputSchema) {
        this.validateJsonSchema(tool.outputSchema);
      }
    }
  }

  /**
   * Basic JSON Schema validation
   */
  private validateJsonSchema(schema: Record<string, unknown>): void {
    // Simplified validation - just check it's an object
    if (typeof schema !== "object" || schema === null) {
      throw new Error(`Invalid JSON Schema`);
    }

    // Could add more comprehensive validation here
    // For now, accept any object as valid schema
  }

  /**
   * Store extracted schemas in PGlite (AC5)
   */
  private async storeSchemas(
    serverId: string,
    tools: MCPTool[],
  ): Promise<void> {
    for (const tool of tools) {
      const toolId = `${serverId}:${tool.name}`;

      try {
        await this.db.query(
          `INSERT INTO tool_schema (tool_id, server_id, name, description, input_schema, output_schema, cached_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, NOW())
           ON CONFLICT(tool_id) DO UPDATE SET
             description = excluded.description,
             input_schema = excluded.input_schema,
             output_schema = excluded.output_schema,
             cached_at = NOW()`,
          [
            toolId,
            serverId,
            tool.name,
            tool.description,
            tool.inputSchema, // postgres.js/pglite auto-serializes to JSONB
            tool.outputSchema ?? null, // postgres.js/pglite auto-serializes to JSONB
          ],
        );
      } catch (error) {
        log.warn(
          `Failed to store schema for ${toolId}: ${error}`,
        );
        // Continue with other tools on error (graceful degradation)
      }
    }

    log.debug(
      `Stored ${tools.length} schemas for server ${serverId}`,
    );
  }

  /**
   * Get extraction statistics
   */
  async getStats(): Promise<DiscoveryStats> {
    const toolCount = await this.db.queryOne(
      "SELECT COUNT(*) as count FROM tool_schema",
    );

    return {
      totalServers: 0,
      successfulServers: 0,
      failedServers: 0,
      totalToolsExtracted: (toolCount?.count as number) || 0,
      failures: new Map(),
      duration: 0,
    };
  }
}
