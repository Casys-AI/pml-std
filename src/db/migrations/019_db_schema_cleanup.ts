/**
 * Migration 019: Database Schema Cleanup
 *
 * Story 11.0: Clean up database schema as prerequisite for Epic 11 (Learning).
 *
 * Changes:
 * 1. DROP workflow_dags - Replaced by Deno KV (src/cache/workflow-state-cache.ts)
 * 2. DROP mcp_tool - Merged into tool_schema
 * 3. DROP mcp_server - Dependency of mcp_tool
 * 4. DROP COLUMN source FROM tool_dependency - Redundant with edge_source (migration 012)
 * 5. ADD FK on permission_audit_log.capability_id → workflow_pattern.pattern_id
 *
 * All operations are idempotent (IF EXISTS / IF NOT EXISTS).
 *
 * @module db/migrations/019_db_schema_cleanup
 */

import type { Migration } from "../migrations.ts";
import type { DbClient } from "../types.ts";
import * as log from "@std/log";

export function createDbSchemaCleanupMigration(): Migration {
  return {
    version: 19,
    name: "db_schema_cleanup",
    up: async (db: DbClient) => {
      log.info("Migration 019: Starting database schema cleanup...");

      // 1. Drop workflow_dags table (replaced by Deno KV)
      await db.exec("DROP TABLE IF EXISTS workflow_dags CASCADE");
      log.info("  ✓ Dropped workflow_dags table (replaced by Deno KV)");

      // 2. Drop mcp_tool table (merged into tool_schema)
      await db.exec("DROP TABLE IF EXISTS mcp_tool CASCADE");
      log.info("  ✓ Dropped mcp_tool table (merged into tool_schema)");

      // 3. Drop mcp_server table (dependency of mcp_tool)
      await db.exec("DROP TABLE IF EXISTS mcp_server CASCADE");
      log.info("  ✓ Dropped mcp_server table");

      // 4. Drop redundant 'source' column from tool_dependency
      // (edge_source from migration 012 is the canonical column)
      // Note: PGlite supports DROP COLUMN IF EXISTS
      try {
        await db.exec(`
          ALTER TABLE tool_dependency DROP COLUMN IF EXISTS source
        `);
        log.info("  ✓ Dropped redundant 'source' column from tool_dependency");
      } catch (error) {
        // Column might not exist, which is fine
        log.debug(`  Note: source column drop skipped: ${error}`);
      }

      // 5. Add FK on permission_audit_log.capability_id → workflow_pattern.pattern_id
      // capability_id is TEXT, pattern_id is UUID - need to convert type first
      try {
        // First, delete rows with invalid UUID format (cleanup orphans)
        await db.exec(`
          DELETE FROM permission_audit_log
          WHERE capability_id IS NOT NULL
          AND capability_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        `);
        log.debug("  Cleaned up non-UUID capability_id values");

        // Delete orphaned records (capability_id not in workflow_pattern)
        await db.exec(`
          DELETE FROM permission_audit_log
          WHERE capability_id IS NOT NULL
          AND capability_id::uuid NOT IN (SELECT pattern_id FROM workflow_pattern)
        `);
        log.debug("  Cleaned up orphaned permission_audit_log records");

        // Convert capability_id from TEXT to UUID
        await db.exec(`
          ALTER TABLE permission_audit_log
          ALTER COLUMN capability_id TYPE UUID USING capability_id::uuid
        `);
        log.info("  ✓ Converted capability_id from TEXT to UUID");

        // Add FK constraint
        await db.exec(`
          ALTER TABLE permission_audit_log
          ADD CONSTRAINT fk_permission_audit_capability
          FOREIGN KEY (capability_id)
          REFERENCES workflow_pattern(pattern_id)
          ON DELETE SET NULL
        `);
        log.info("  ✓ Added FK constraint on permission_audit_log.capability_id");
      } catch (error) {
        // If conversion fails (e.g., table doesn't exist yet), log and continue
        log.warn(`  Note: FK constraint setup failed: ${error}`);
      }

      log.info("✓ Migration 019 complete: Database schema cleanup");
    },
    down: async (db: DbClient) => {
      log.info("Migration 019 rollback: Recreating dropped tables...");

      // Drop FK constraint and revert capability_id to TEXT
      try {
        await db.exec(`
          ALTER TABLE permission_audit_log
          DROP CONSTRAINT IF EXISTS fk_permission_audit_capability
        `);
        await db.exec(`
          ALTER TABLE permission_audit_log
          ALTER COLUMN capability_id TYPE TEXT USING capability_id::text
        `);
        log.info("  ✓ Reverted capability_id to TEXT");
      } catch {
        // Constraint/column might not exist
      }

      // Re-add source column to tool_dependency
      try {
        await db.exec(`
          ALTER TABLE tool_dependency ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'learned'
        `);
        log.info("  ✓ Re-added source column to tool_dependency");
      } catch {
        // Column might already exist
      }

      // Recreate mcp_server table
      await db.exec(`
        CREATE TABLE IF NOT EXISTS mcp_server (
          id SERIAL PRIMARY KEY,
          server_id TEXT UNIQUE NOT NULL,
          server_name TEXT,
          connection_info JSONB,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      log.info("  ✓ Recreated mcp_server table");

      // Recreate mcp_tool table
      await db.exec(`
        CREATE TABLE IF NOT EXISTS mcp_tool (
          id SERIAL PRIMARY KEY,
          server_id TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          tool_schema JSONB NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE (server_id, tool_name)
        )
      `);
      await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_mcp_tool_server_id ON mcp_tool(server_id)
      `);
      await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_mcp_tool_tool_name ON mcp_tool(tool_name)
      `);
      log.info("  ✓ Recreated mcp_tool table");

      // Recreate workflow_dags table
      await db.exec(`
        CREATE TABLE IF NOT EXISTS workflow_dags (
          workflow_id TEXT PRIMARY KEY,
          dag JSONB NOT NULL,
          intent TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '1 hour'
        )
      `);
      await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_workflow_dags_expires ON workflow_dags(expires_at)
      `);
      log.info("  ✓ Recreated workflow_dags table");

      log.info("Migration 019 rollback complete");
    },
  };
}
