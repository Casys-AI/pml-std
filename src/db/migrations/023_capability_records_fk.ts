/**
 * Migration 023: Capability Records FK (Epic 13 - Story 13.2 fix)
 *
 * Fixes the design by:
 * 1. Adding workflow_pattern_id FK to capability_records
 * 2. Removing duplicated columns (code_snippet, description, parameters_schema, tools_used)
 *
 * Original design (Story 13.1 line 118):
 *   "Future migration (13.2) - Links records via capability_records.workflow_pattern_id FK"
 *
 * After this migration:
 *   - capability_records = registry (FQDN, naming, visibility, versioning, provenance)
 *   - workflow_pattern = source of truth for code, embedding, stats
 *   - Linked via FK, no duplication
 *
 * @module db/migrations/023_capability_records_fk
 */

import type { Migration } from "../migrations.ts";
import type { DbClient } from "../types.ts";
import * as log from "@std/log";

export function createCapabilityRecordsFkMigration(): Migration {
  return {
    version: 23,
    name: "capability_records_fk",
    up: async (db: DbClient) => {
      log.info(
        "Migration 023: Adding FK and removing duplicated columns from capability_records...",
      );

      // ============================================
      // 1. Add workflow_pattern_id FK column
      // ============================================
      await db.exec(`
        ALTER TABLE capability_records
        ADD COLUMN IF NOT EXISTS workflow_pattern_id UUID
        REFERENCES workflow_pattern(pattern_id) ON DELETE SET NULL
      `);
      log.info("  ✓ Added workflow_pattern_id FK column");

      // ============================================
      // 2. Create index for FK joins
      // ============================================
      await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_capability_records_workflow_pattern
        ON capability_records(workflow_pattern_id)
        WHERE workflow_pattern_id IS NOT NULL
      `);
      log.info("  ✓ Created idx_capability_records_workflow_pattern index");

      // ============================================
      // 3. Migrate existing data: link by code_hash
      // ============================================
      // Match capability_records.hash (4 chars) to workflow_pattern.code_hash prefix
      const updateResult = await db.query(`
        UPDATE capability_records cr
        SET workflow_pattern_id = wp.pattern_id
        FROM workflow_pattern wp
        WHERE SUBSTRING(wp.code_hash, 1, 4) = cr.hash
          AND cr.workflow_pattern_id IS NULL
      `);
      log.info(`  ✓ Linked ${updateResult.length || 0} existing records via code_hash`);

      // ============================================
      // 4. Drop duplicated columns
      // ============================================
      const columnsToDrop = ["code_snippet", "description", "parameters_schema", "tools_used"];

      for (const col of columnsToDrop) {
        try {
          await db.exec(`ALTER TABLE capability_records DROP COLUMN IF EXISTS ${col}`);
          log.info(`  ✓ Dropped duplicated column: ${col}`);
        } catch (error) {
          log.warn(`  ○ Column ${col} already dropped or doesn't exist`);
        }
      }

      // ============================================
      // 5. Drop the old hash-based index (no longer needed for JOIN)
      // ============================================
      await db.exec(`
        DROP INDEX IF EXISTS idx_workflow_pattern_code_hash_prefix
      `);
      log.info("  ✓ Dropped idx_workflow_pattern_code_hash_prefix (replaced by FK)");

      // ============================================
      // 6. Update table comment
      // ============================================
      try {
        await db.exec(`
          COMMENT ON TABLE capability_records IS
            'Capability registry with FQDN structure. Links to workflow_pattern via FK for code/stats. Epic 13.'
        `);
        await db.exec(`
          COMMENT ON COLUMN capability_records.workflow_pattern_id IS
            'FK to workflow_pattern for code, embedding, and execution stats'
        `);
      } catch {
        // Comments are optional
      }

      log.info("✓ Migration 023 complete: capability_records now uses FK, duplicates removed");
    },
    down: async (db: DbClient) => {
      log.info("Migration 023 rollback: Restoring duplicated columns...");

      // Re-add duplicated columns
      await db.exec(`
        ALTER TABLE capability_records
        ADD COLUMN IF NOT EXISTS code_snippet TEXT,
        ADD COLUMN IF NOT EXISTS description TEXT,
        ADD COLUMN IF NOT EXISTS parameters_schema JSONB,
        ADD COLUMN IF NOT EXISTS tools_used TEXT[] DEFAULT '{}'
      `);
      log.info("  ✓ Restored duplicated columns");

      // Re-create the hash-based index
      await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_workflow_pattern_code_hash_prefix
        ON workflow_pattern (SUBSTRING(code_hash, 1, 4))
        WHERE code_hash IS NOT NULL
      `);
      log.info("  ✓ Restored idx_workflow_pattern_code_hash_prefix");

      // Drop FK index
      await db.exec(`DROP INDEX IF EXISTS idx_capability_records_workflow_pattern`);

      // Drop FK column
      await db.exec(`ALTER TABLE capability_records DROP COLUMN IF EXISTS workflow_pattern_id`);
      log.info("  ✓ Dropped workflow_pattern_id FK column");

      log.info("Migration 023 rollback complete");
    },
  };
}
