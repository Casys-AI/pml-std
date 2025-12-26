/**
 * Migration 004: MCP Tool Tables
 *
 * Creates mcp_tool and mcp_server tables for compatibility with E2E tests.
 * These tables provide a simpler schema for tool management alongside
 * the existing tool_schema and tool_embedding tables.
 */

import type { DbClient } from "../types.ts";
import type { Migration } from "../migrations.ts";
import * as log from "@std/log";

export function createMcpToolTablesMigration(): Migration {
  return {
    version: 4,
    name: "mcp_tool_tables",
    up: async (db: DbClient) => {
      log.info("Creating mcp_server and mcp_tool tables...");

      // Create mcp_server table
      await db.exec(`
        CREATE TABLE IF NOT EXISTS mcp_server (
          id SERIAL PRIMARY KEY,
          server_id TEXT UNIQUE NOT NULL,
          server_name TEXT,
          connection_info JSONB,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);

      // Create mcp_tool table
      await db.exec(`
        CREATE TABLE IF NOT EXISTS mcp_tool (
          id SERIAL PRIMARY KEY,
          server_id TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          tool_schema JSONB NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE (server_id, tool_name)
        );
      `);

      // Create indexes for better query performance
      await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_mcp_tool_server_id ON mcp_tool(server_id);
      `);

      await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_mcp_tool_tool_name ON mcp_tool(tool_name);
      `);

      log.info("✓ mcp_server and mcp_tool tables created");
    },
    down: async (db: DbClient) => {
      log.info("Dropping mcp_server and mcp_tool tables...");
      await db.exec("DROP TABLE IF EXISTS mcp_tool CASCADE;");
      await db.exec("DROP TABLE IF EXISTS mcp_server CASCADE;");
      log.info("✓ mcp_server and mcp_tool tables dropped");
    },
  };
}
