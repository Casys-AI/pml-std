/**
 * Migration 006: Workflow Checkpoints
 *
 * Story: 2.5-2 Checkpoint & Resume (Epic 2.5)
 *
 * @module db/migrations/006_workflow_checkpoints_migration
 */

import type { DbClient } from "../types.ts";
import type { Migration } from "../migrations.ts";
import * as log from "@std/log";

/**
 * Create workflow checkpoints migration
 *
 * Up: Creates workflow_checkpoint table with indexes
 * Down: Drops table and indexes
 */
export function createWorkflowCheckpointsMigration(): Migration {
  const checkpointSql = `
-- Migration 006: Workflow Checkpoints
-- Created: 2025-11-14
-- Purpose: Enable checkpoint/resume functionality for adaptive DAG workflows
-- Story: 2.5-2 Checkpoint & Resume (Epic 2.5)

-- Workflow checkpoint table: Stores WorkflowState snapshots for fault tolerance
CREATE TABLE IF NOT EXISTS workflow_checkpoint (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  layer INTEGER NOT NULL,
  state JSONB NOT NULL,
  CONSTRAINT chk_layer_non_negative CHECK (layer >= 0)
);

-- Index for fast pruning and latest checkpoint queries
CREATE INDEX IF NOT EXISTS idx_checkpoint_workflow_ts
  ON workflow_checkpoint(workflow_id, timestamp DESC);

-- Index for workflow_id lookups
CREATE INDEX IF NOT EXISTS idx_checkpoint_workflow_id
  ON workflow_checkpoint(workflow_id);
`;

  return {
    version: 6,
    name: "workflow_checkpoints",
    up: async (db: DbClient) => {
      // Remove SQL comments
      const sqlWithoutComments = checkpointSql
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .replace(/\/\*[\s\S]*?\*\//g, "");

      // Split and execute each statement
      const statements = sqlWithoutComments
        .split(";")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      for (const statement of statements) {
        try {
          await db.exec(statement);
        } catch (error) {
          log.error(`Failed to execute statement: ${statement.substring(0, 100)}...`);
          throw error;
        }
      }

      log.info("Migration 006: workflow_checkpoint table created");
    },
    down: async (db: DbClient) => {
      // Drop indexes first, then table
      await db.exec("DROP INDEX IF EXISTS idx_checkpoint_workflow_id;");
      await db.exec("DROP INDEX IF EXISTS idx_checkpoint_workflow_ts;");
      await db.exec("DROP TABLE IF EXISTS workflow_checkpoint CASCADE;");

      log.info("Migration 006: workflow_checkpoint table dropped");
    },
  };
}
