/**
 * Migration 036: Enhance pml_registry VIEW
 *
 * Adds useful columns to pml_registry VIEW for catalog and discovery:
 * - visibility: Filter by public/private
 * - fqdn: Full qualified domain name (org.project.namespace.action)
 * - created_at: Sort by creation date
 * - created_by: Filter by author (multi-tenant)
 * - tags: Category filtering
 *
 * MCP tools are always considered 'public' (they're system tools).
 *
 * @module db/migrations/036_pml_registry_visibility
 */

import type { Migration } from "../migrations.ts";
import type { DbClient } from "../types.ts";
import * as log from "@std/log";

export function createPmlRegistryVisibilityMigration(): Migration {
  return {
    version: 36,
    name: "pml_registry_enhanced",
    up: async (db: DbClient) => {
      log.info("Migration 036: Enhancing pml_registry VIEW...");

      // Recreate the VIEW with additional columns
      await db.exec(`
        CREATE OR REPLACE VIEW pml_registry AS
          -- MCP Tools (from tool_schema) - always 'public'
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
            NULL::text as action,
            'public'::text as visibility,
            server_id || '.' || name as fqdn,
            cached_at as created_at,
            NULL::text as created_by,
            NULL::text[] as tags
          FROM tool_schema

          UNION ALL

          -- Capabilities (from capability_records + workflow_pattern)
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
            cr.action,
            cr.visibility,
            CASE
              WHEN cr.org IS NOT NULL AND cr.project IS NOT NULL
              THEN cr.org || '.' || cr.project || '.' || cr.namespace || '.' || cr.action
              ELSE cr.namespace || '.' || cr.action
            END as fqdn,
            cr.created_at,
            wp.created_by,
            cr.tags
          FROM capability_records cr
          LEFT JOIN workflow_pattern wp ON cr.workflow_pattern_id = wp.pattern_id
      `);
      log.info("  ✓ Enhanced pml_registry VIEW with visibility, fqdn, created_at, created_by, tags");

      log.info("✓ Migration 036 complete");
    },
    down: async (db: DbClient) => {
      log.info("Migration 036 rollback: Restoring original pml_registry VIEW...");

      // Restore the original VIEW (from migration 035)
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
      log.info("  ✓ Restored original pml_registry VIEW");

      log.info("Migration 036 rollback complete");
    },
  };
}
