/**
 * Migration 033: Add created_by to workflow_pattern
 *
 * Story 9.8 requires filtering capabilities by user (created_by).
 * This column was referenced in data-service.ts but never added.
 */

import type { DbClient } from "../types.ts";
import type { Migration } from "../migrations.ts";
import * as log from "@std/log";

const MIGRATION_NAME = "033_workflow_pattern_created_by";

async function up(db: DbClient): Promise<void> {
  log.info(`[${MIGRATION_NAME}] Adding created_by column to workflow_pattern...`);

  await db.exec(`
    ALTER TABLE workflow_pattern
    ADD COLUMN IF NOT EXISTS created_by TEXT DEFAULT 'local';

    -- Index for user-based filtering
    CREATE INDEX IF NOT EXISTS idx_workflow_pattern_created_by
    ON workflow_pattern(created_by);
  `);

  log.info(`[${MIGRATION_NAME}] Added created_by column with index`);
}

async function down(db: DbClient): Promise<void> {
  log.info(`[${MIGRATION_NAME}] Removing created_by column from workflow_pattern...`);

  await db.exec(`
    DROP INDEX IF EXISTS idx_workflow_pattern_created_by;
    ALTER TABLE workflow_pattern DROP COLUMN IF EXISTS created_by;
  `);

  log.info(`[${MIGRATION_NAME}] Removed created_by column`);
}

export function createWorkflowPatternCreatedByMigration(): Migration {
  return {
    version: 33,
    name: MIGRATION_NAME,
    up,
    down,
  };
}
