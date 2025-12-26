/**
 * Migration 003: Error Logging Table
 *
 * Adds error_log table for persisting errors to enable post-mortem analysis.
 * Includes indexes for efficient querying by timestamp and error type.
 *
 * @module db/migrations/003_error_logging
 */

import type { Migration } from "../migrations.ts";
import type { DbClient } from "../types.ts";

export function createErrorLoggingMigration(): Migration {
  const errorLoggingSql = `
-- Error logging table for post-mortem analysis
CREATE TABLE IF NOT EXISTS error_log (
  id SERIAL PRIMARY KEY,
  error_type TEXT NOT NULL,
  message TEXT NOT NULL,
  stack TEXT,
  context JSONB,
  timestamp TIMESTAMP DEFAULT NOW()
);

-- Index for efficient queries by timestamp (most recent errors first)
CREATE INDEX IF NOT EXISTS idx_error_log_timestamp
ON error_log (timestamp DESC);

-- Index for filtering by error type
CREATE INDEX IF NOT EXISTS idx_error_log_type
ON error_log (error_type);
`;

  return {
    version: 3,
    name: "error_logging",
    up: async (db: DbClient) => {
      // Remove SQL comments
      const sqlWithoutComments = errorLoggingSql
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .replace(/\/\*[\s\S]*?\*\//g, ""); // Remove /* */ comments

      // Split by semicolons and execute each statement
      const statements = sqlWithoutComments
        .split(";")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      for (const statement of statements) {
        try {
          await db.exec(statement);
        } catch (error) {
          // If table/index already exists, that's okay - log and continue
          if (error instanceof Error && error.message.includes("already exists")) {
            console.warn(`Table or index already exists (expected): ${error.message}`);
          } else {
            throw error;
          }
        }
      }
    },
    down: async (db: DbClient) => {
      // Drop indexes first, then table
      await db.exec("DROP INDEX IF EXISTS idx_error_log_type;");
      await db.exec("DROP INDEX IF EXISTS idx_error_log_timestamp;");
      await db.exec("DROP TABLE IF EXISTS error_log CASCADE;");
    },
  };
}
