/**
 * Migration 022: Unify Capability Naming (Epic 13 - Story 13.2)
 *
 * Removes redundant `name` column from workflow_pattern table.
 * Naming is now handled exclusively by capability_records.display_name.
 *
 * The API will JOIN workflow_pattern with capability_records via code_hash
 * to get display_name (or fallback to FQDN).
 *
 * Link strategy:
 *   workflow_pattern.code_hash (first 4 chars) = capability_records.hash
 *
 * @module db/migrations/022_unify_capability_naming
 */

import type { Migration } from "../migrations.ts";
import type { DbClient } from "../types.ts";
import * as log from "@std/log";

export function createUnifyCapabilityNamingMigration(): Migration {
  return {
    version: 22,
    name: "unify_capability_naming",
    up: async (db: DbClient) => {
      log.info("Migration 022: Unifying capability naming...");

      // ============================================
      // 1. Drop the redundant name column
      // ============================================
      // Note: Hash-based index removed - migration 023 uses FK instead
      // First check if column exists (migration idempotency)
      const columnCheck = await db.query(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'workflow_pattern' AND column_name = 'name'
      `);

      if (columnCheck.length > 0) {
        await db.exec(`
          ALTER TABLE workflow_pattern DROP COLUMN name
        `);
        log.info(
          "  ✓ Dropped workflow_pattern.name column (now using capability_records.display_name)",
        );
      } else {
        log.info("  ✓ workflow_pattern.name column already removed (idempotent)");
      }

      // ============================================
      // 2. Add table comment for documentation
      // ============================================
      try {
        await db.exec(`
          COMMENT ON TABLE workflow_pattern IS
            'Execution statistics for capabilities. Naming handled by capability_records.display_name via code_hash JOIN. Epic 13.'
        `);
        log.debug("  ✓ Updated table comment");
      } catch {
        // Comments are optional
      }

      log.info("✓ Migration 022 complete: capability naming unified");
    },
    down: async (db: DbClient) => {
      log.info("Migration 022 rollback: Restoring workflow_pattern.name column...");

      // Re-add name column
      await db.exec(`
        ALTER TABLE workflow_pattern ADD COLUMN IF NOT EXISTS name TEXT
      `);
      log.info("  ✓ Restored workflow_pattern.name column");

      log.info("Migration 022 rollback complete");
    },
  };
}
