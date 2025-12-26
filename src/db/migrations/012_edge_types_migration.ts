/**
 * Migration 012: Add edge_type and edge_source to tool_dependency (ADR-041)
 *
 * Implements hierarchical trace tracking for accurate tool/capability relationships.
 *
 * edge_type: Nature of the relationship
 *   - 'contains': Parent-child relationship (capability → tool, capability → nested capability)
 *   - 'sequence': Temporal order between siblings (same parent)
 *   - 'dependency': Explicit DAG dependency from templates
 *
 * edge_source: Origin and confidence level
 *   - 'template': Bootstrap from workflow templates (lowest confidence)
 *   - 'inferred': Single observation (medium confidence)
 *   - 'observed': Confirmed by 3+ executions (highest confidence)
 *
 * @module db/migrations/012_edge_types_migration
 */

import type { DbClient } from "../types.ts";
import type { Migration } from "../migrations.ts";
import * as log from "@std/log";

export function createEdgeTypesMigration(): Migration {
  return {
    version: 12,
    name: "edge_types",
    up: async (db: DbClient) => {
      // Add edge_type column with default 'sequence' for backward compatibility
      await db.exec(`
        ALTER TABLE tool_dependency
        ADD COLUMN IF NOT EXISTS edge_type TEXT DEFAULT 'sequence';
      `);
      log.info("Migration 012: Added edge_type column to tool_dependency");

      // Add edge_source column with default 'inferred' for existing edges
      await db.exec(`
        ALTER TABLE tool_dependency
        ADD COLUMN IF NOT EXISTS edge_source TEXT DEFAULT 'inferred';
      `);
      log.info("Migration 012: Added edge_source column to tool_dependency");

      // Create index for filtering by edge_type
      await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_tool_dependency_edge_type
        ON tool_dependency(edge_type);
      `);
      log.info("Migration 012: Created index on edge_type");

      // Create index for filtering by edge_source
      await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_tool_dependency_edge_source
        ON tool_dependency(edge_source);
      `);
      log.info("Migration 012: Created index on edge_source");

      // Create composite index for common query patterns (type + source)
      await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_tool_dependency_type_source
        ON tool_dependency(edge_type, edge_source);
      `);
      log.info("Migration 012: Created composite index on edge_type, edge_source");

      log.info("✓ Migration 012 complete: edge_types columns added");
    },
    down: async (db: DbClient) => {
      // Drop indexes first
      await db.exec("DROP INDEX IF EXISTS idx_tool_dependency_type_source;");
      await db.exec("DROP INDEX IF EXISTS idx_tool_dependency_edge_source;");
      await db.exec("DROP INDEX IF EXISTS idx_tool_dependency_edge_type;");

      // Drop columns
      await db.exec("ALTER TABLE tool_dependency DROP COLUMN IF EXISTS edge_source;");
      await db.exec("ALTER TABLE tool_dependency DROP COLUMN IF EXISTS edge_type;");

      log.info("✓ Migration 012 rolled back: edge_types columns removed");
    },
  };
}
