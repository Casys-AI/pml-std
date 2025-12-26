/**
 * Migration 008: Workflow DAG Persistence
 *
 * Creates workflow_dags table for MCP stateless continuation.
 * Story 2.5-4: MCP Control Tools & Per-Layer Validation
 *
 * @module db/migrations/008_workflow_dags_migration
 */

import type { Migration } from "../migrations.ts";
import type { DbClient } from "../types.ts";
import * as log from "@std/log";

const workflowDagsSql = `
-- Workflow DAGs table: Stores DAG structure separately from checkpoints
CREATE TABLE IF NOT EXISTS workflow_dags (
  workflow_id TEXT PRIMARY KEY,
  dag JSONB NOT NULL,
  intent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '1 hour'
);

CREATE INDEX IF NOT EXISTS idx_workflow_dags_expires
  ON workflow_dags(expires_at);
`;

/**
 * Create the workflow DAGs migration
 */
export function createWorkflowDagsMigration(): Migration {
  return {
    version: 8,
    name: "workflow_dags",
    up: async (db: DbClient) => {
      // Remove SQL comments first
      const sqlWithoutComments = workflowDagsSql
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .replace(/\/\*[\s\S]*?\*\//g, "");

      // Split by semicolons and execute each statement
      const statements = sqlWithoutComments
        .split(";")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      for (const statement of statements) {
        try {
          await db.exec(statement);
        } catch (error) {
          if (error instanceof Error && error.message.includes("already exists")) {
            log.warn(`Table or index already exists (expected): ${error.message}`);
          } else {
            log.error(`Failed to execute statement: ${statement.substring(0, 100)}...`);
            throw error;
          }
        }
      }

      log.info("Migration 008: workflow_dags table created");
    },
    down: async (db: DbClient) => {
      await db.exec("DROP INDEX IF EXISTS idx_workflow_dags_expires;");
      await db.exec("DROP TABLE IF EXISTS workflow_dags CASCADE;");
      log.info("Migration 008: workflow_dags table dropped");
    },
  };
}
