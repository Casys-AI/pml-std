/**
 * Migration 009: Add source column to tool_dependency (Story 5.2)
 *
 * Adds tracking for where dependency edges come from:
 * - 'user': Defined in workflow-templates.yaml
 * - 'learned': Discovered from execution history
 * - 'hint': Registered via agent hints
 */

import type { Migration } from "../migrations.ts";
import type { DbClient } from "../types.ts";
import * as log from "@std/log";

export function createToolDependencySourceMigration(): Migration {
  return {
    version: 9,
    name: "tool_dependency_source",
    up: async (db: DbClient) => {
      // Check if column already exists
      const columnExists = await db.query(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'tool_dependency' AND column_name = 'source'
      `);

      if (columnExists.length === 0) {
        // Add source column with default 'learned'
        await db.exec(`
          ALTER TABLE tool_dependency ADD COLUMN source TEXT DEFAULT 'learned'
        `);
        log.info("Migration 009: Added source column to tool_dependency");
      } else {
        log.info("Migration 009: source column already exists");
      }

      // Create index for filtering by source (ignore if exists)
      try {
        await db.exec(`
          CREATE INDEX IF NOT EXISTS idx_tool_dependency_source ON tool_dependency(source)
        `);
        log.info("Migration 009: Created index on source column");
      } catch (error) {
        // Index might already exist
        log.debug(`Index creation skipped: ${error}`);
      }

      log.info("✓ Migration 009 complete: tool_dependency source tracking");
    },
    down: async (db: DbClient) => {
      // Drop index first
      await db.exec(`
        DROP INDEX IF EXISTS idx_tool_dependency_source
      `);

      // PGlite doesn't support DROP COLUMN, so we'd need to recreate the table
      // For simplicity, we leave the column in place
      log.info("Migration 009 rollback: Index dropped (column retained)");
    },
  };
}
