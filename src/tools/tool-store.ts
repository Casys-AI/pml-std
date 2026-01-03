/**
 * Tool Store
 *
 * Repository for MCP tool metadata. Provides access to tool information
 * stored in the database (tool_schema + tool_embedding tables).
 *
 * @module tools/tool-store
 */

import * as log from "@std/log";
import type { DbClient } from "../db/types.ts";
import type { IToolRepository, ToolMetadata } from "../domain/interfaces/tool-repository.ts";

/**
 * Tool Store Implementation
 *
 * Provides CRUD-like access to MCP tool metadata stored in PostgreSQL.
 * Used by discover usecases to enrich SHGAT scoring results.
 *
 * Implements IToolRepository from domain layer (Clean Architecture).
 */
export class ToolStore implements IToolRepository {
  constructor(private readonly db: DbClient) {}

  /**
   * Find a single tool by ID
   *
   * @param toolId - Tool ID (format: "server:toolName")
   * @returns Tool metadata or undefined if not found
   */
  async findById(toolId: string): Promise<ToolMetadata | undefined> {
    const results = await this.findByIds([toolId]);
    return results.get(toolId);
  }

  /**
   * Find multiple tools by IDs (batch)
   *
   * Fetches tool metadata from tool_schema joined with tool_embedding.
   * More efficient than multiple findById calls.
   *
   * @param toolIds - Array of tool IDs to fetch
   * @returns Map of toolId to metadata
   */
  async findByIds(toolIds: string[]): Promise<Map<string, ToolMetadata>> {
    if (toolIds.length === 0) {
      return new Map();
    }

    try {
      // Build parameterized query for IN clause
      const placeholders = toolIds.map((_, i) => `$${i + 1}`).join(", ");

      const results = await this.db.query(
        `SELECT
          te.tool_id,
          te.server_id,
          ts.description,
          ts.input_schema
        FROM tool_embedding te
        JOIN tool_schema ts ON te.tool_id = ts.tool_id
        WHERE te.tool_id IN (${placeholders})`,
        toolIds,
      );

      const toolsMap = new Map<string, ToolMetadata>();

      for (const row of results) {
        toolsMap.set(row.tool_id as string, {
          toolId: row.tool_id as string,
          serverId: row.server_id as string,
          description: row.description as string,
          inputSchema: row.input_schema as Record<string, unknown> | undefined,
        });
      }

      log.debug(`[ToolStore] Found ${toolsMap.size}/${toolIds.length} tools`);
      return toolsMap;
    } catch (error) {
      log.warn(`[ToolStore] Failed to fetch tool metadata: ${error}`);
      return new Map();
    }
  }
}
