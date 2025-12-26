/**
 * Migration 017: Add permission inference columns to workflow_pattern
 *
 * Adds permission_set and permission_confidence columns to support
 * automatic permission inference (Story 7.7a, ADR-035).
 *
 * Columns:
 *   - permission_set: VARCHAR(50) - The inferred permission profile
 *     Values: 'minimal' | 'readonly' | 'filesystem' | 'network-api' | 'mcp-standard' | 'trusted'
 *   - permission_confidence: FLOAT - Confidence score (0-1) of the inference
 *
 * @module db/migrations/017_permission_inference
 */

import type { Migration } from "../migrations.ts";
import type { DbClient } from "../types.ts";
import * as log from "@std/log";

export function createPermissionInferenceMigration(): Migration {
  return {
    version: 17,
    name: "permission_inference",
    up: async (db: DbClient) => {
      // Add permission_set column with default 'minimal'
      await db.exec(`
        ALTER TABLE workflow_pattern
        ADD COLUMN IF NOT EXISTS permission_set VARCHAR(50) DEFAULT 'minimal'
      `);
      log.info("Migration 017: permission_set column added");

      // Add permission_confidence column with default 0.0
      await db.exec(`
        ALTER TABLE workflow_pattern
        ADD COLUMN IF NOT EXISTS permission_confidence REAL DEFAULT 0.0
      `);
      log.info("Migration 017: permission_confidence column added");

      // Create index on permission_set for efficient filtering
      await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_workflow_pattern_permission
        ON workflow_pattern(permission_set)
      `);
      log.info("Migration 017: idx_workflow_pattern_permission index created");

      log.info("✓ Migration 017 complete: permission inference columns added");
    },
    down: async (db: DbClient) => {
      // Drop index first
      await db.exec("DROP INDEX IF EXISTS idx_workflow_pattern_permission");

      // Drop columns
      await db.exec("ALTER TABLE workflow_pattern DROP COLUMN IF EXISTS permission_confidence");
      await db.exec("ALTER TABLE workflow_pattern DROP COLUMN IF EXISTS permission_set");

      log.info("Migration 017 rolled back");
    },
  };
}
