/**
 * Migration 013: Add user_id to workflow_execution (Epic 9 - Multi-tenancy)
 *
 * Adds user tracking columns to workflow_execution table for data isolation:
 * - user_id: Owner of the workflow execution
 * - created_by: User who created the record
 * - updated_by: User who last updated the record
 *
 * Supports both cloud (multi-user) and local (single-user) modes.
 * Backfills existing data with user_id = 'local' for backward compatibility.
 *
 * @module db/migrations/013_user_id_workflow_execution
 */

import type { Migration } from "../migrations.ts";
import type { DbClient } from "../types.ts";
import * as log from "@std/log";

export function createUserIdWorkflowExecutionMigration(): Migration {
  return {
    version: 13,
    name: "user_id_workflow_execution",
    up: async (db: DbClient) => {
      // Add user_id column (nullable for backward compatibility)
      await db.exec(`
        ALTER TABLE workflow_execution
        ADD COLUMN IF NOT EXISTS user_id TEXT
      `);
      log.info("Migration 013: user_id column added to workflow_execution");

      // Backfill existing data with 'local' (for single-user deployments)
      await db.exec(`
        UPDATE workflow_execution
        SET user_id = 'local'
        WHERE user_id IS NULL
      `);
      log.info("Migration 013: Backfilled user_id = 'local' for existing records");

      // Add ownership tracking columns
      await db.exec(`
        ALTER TABLE workflow_execution
        ADD COLUMN IF NOT EXISTS created_by TEXT,
        ADD COLUMN IF NOT EXISTS updated_by TEXT
      `);
      log.info("Migration 013: Ownership tracking columns (created_by, updated_by) added");

      // Create index for user_id (performance for WHERE user_id = ? queries)
      await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_workflow_execution_user_id
        ON workflow_execution(user_id)
      `);
      log.info("Migration 013: Index on user_id created");

      log.info(
        "✓ Migration 013 complete: user_id, created_by, updated_by added to workflow_execution",
      );
    },
    down: async (db: DbClient) => {
      // Rollback: Remove index and columns
      await db.exec("DROP INDEX IF EXISTS idx_workflow_execution_user_id");
      await db.exec("ALTER TABLE workflow_execution DROP COLUMN IF EXISTS updated_by");
      await db.exec("ALTER TABLE workflow_execution DROP COLUMN IF EXISTS created_by");
      await db.exec("ALTER TABLE workflow_execution DROP COLUMN IF EXISTS user_id");
      log.info("Migration 013 rolled back");
    },
  };
}
