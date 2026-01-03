/**
 * Migration 035: PML Registry VIEW (Story 13.8)
 *
 * Creates a unified registry VIEW that combines tool_schema and capability_records.
 * This enables pml:discover to search both MCP tools and capabilities uniformly.
 *
 * Changes:
 * 1. Add `code_url` column to tool_schema (for dynamic import URL)
 * 2. Add `routing` column to tool_schema (local/cloud, defaults to 'local' for security)
 * 3. Create VIEW `pml_registry` that UNIONs both tables
 *
 * Architecture Decision (Story 13.8):
 * - VIEW approach chosen over table rename (less risk, 0 file changes)
 * - Each table keeps its business logic
 * - Unified interface for discovery
 *
 * Security Note:
 * - routing defaults to 'local' because stdio MCPs have system access
 * - Cloud execution would access server filesystem (dangerous)
 *
 * @module db/migrations/035_pml_registry_view
 */

import type { Migration } from "../migrations.ts";
import type { DbClient } from "../types.ts";
import * as log from "@std/log";

export function createPmlRegistryViewMigration(): Migration {
  return {
    version: 35,
    name: "pml_registry_view",
    up: async (db: DbClient) => {
      log.info("Migration 035: Creating pml_registry VIEW...");

      // ============================================
      // 1. Add code_url column to tool_schema (AC1)
      // ============================================
      await db.exec(`
        ALTER TABLE tool_schema
        ADD COLUMN IF NOT EXISTS code_url TEXT
      `);
      log.info("  ✓ Added code_url column to tool_schema");

      // ============================================
      // 2. Add routing column to tool_schema (AC1)
      // DEFAULT 'local' for security: stdio MCPs with system access
      // should NOT execute in cloud (would access server filesystem!)
      // ============================================
      await db.exec(`
        ALTER TABLE tool_schema
        ADD COLUMN IF NOT EXISTS routing TEXT DEFAULT 'local'
      `);
      log.info("  ✓ Added routing column to tool_schema");

      // Add CHECK constraint separately for PGlite compatibility
      try {
        await db.exec(`
          ALTER TABLE tool_schema
          ADD CONSTRAINT tool_schema_routing_check
          CHECK (routing IN ('local', 'cloud'))
        `);
        log.info("  ✓ Added routing CHECK constraint");
      } catch {
        // Constraint may already exist or PGlite doesn't support named constraints
        log.debug("  ○ Could not add named constraint (may already exist)");
      }

      // ============================================
      // 3. Create pml_registry VIEW (AC2)
      // UNION of tool_schema and capability_records
      // ============================================
      await db.exec(`
        CREATE OR REPLACE VIEW pml_registry AS
          -- MCP Tools (from tool_schema)
          SELECT
            'mcp-tool'::text as record_type,
            tool_id as id,
            name,
            description,
            code_url,
            routing,
            server_id,
            NULL::uuid as workflow_pattern_id,
            NULL::text as org,
            NULL::text as project,
            NULL::text as namespace,
            NULL::text as action
          FROM tool_schema

          UNION ALL

          -- Capabilities (from capability_records + workflow_pattern)
          -- Note: capability_records.id is UUID after migration 028
          SELECT
            'capability'::text as record_type,
            cr.id::text as id,
            cr.namespace || ':' || cr.action as name,
            wp.description,
            NULL::text as code_url,
            cr.routing,
            NULL::text as server_id,
            cr.workflow_pattern_id,
            cr.org,
            cr.project,
            cr.namespace,
            cr.action
          FROM capability_records cr
          LEFT JOIN workflow_pattern wp ON cr.workflow_pattern_id = wp.pattern_id
      `);
      log.info("  ✓ Created pml_registry VIEW");

      // ============================================
      // 4. Add comments for documentation
      // ============================================
      try {
        await db.exec(`
          COMMENT ON VIEW pml_registry IS
            'Unified registry VIEW combining tool_schema (MCP tools) and capability_records. Story 13.8.'
        `);
        await db.exec(`
          COMMENT ON COLUMN tool_schema.code_url IS
            'URL for dynamic import (e.g., pml.casys.ai/mcp/{fqdn}). Story 13.8.'
        `);
        await db.exec(`
          COMMENT ON COLUMN tool_schema.routing IS
            'Execution location: local (default, secure) or cloud. Story 13.8.'
        `);
      } catch {
        // Comments are optional, may fail on PGlite
        log.debug("  ○ Could not add comments (PGlite limitation)");
      }

      log.info("✓ Migration 035 complete: pml_registry VIEW created");
    },
    down: async (db: DbClient) => {
      log.info("Migration 035 rollback: Dropping pml_registry VIEW and columns...");

      // 1. Drop the VIEW first
      await db.exec("DROP VIEW IF EXISTS pml_registry");
      log.info("  ✓ Dropped pml_registry VIEW");

      // 2. Drop routing constraint if exists
      try {
        await db.exec(`
          ALTER TABLE tool_schema
          DROP CONSTRAINT IF EXISTS tool_schema_routing_check
        `);
        log.info("  ✓ Dropped routing CHECK constraint");
      } catch {
        // Constraint may not exist
      }

      // 3. Drop routing column
      await db.exec(`
        ALTER TABLE tool_schema
        DROP COLUMN IF EXISTS routing
      `);
      log.info("  ✓ Dropped routing column");

      // 4. Drop code_url column
      await db.exec(`
        ALTER TABLE tool_schema
        DROP COLUMN IF EXISTS code_url
      `);
      log.info("  ✓ Dropped code_url column");

      log.info("Migration 035 rollback complete");
    },
  };
}
