/**
 * Migration 002: Telemetry and Logging Schema
 *
 * CRITICAL: The metrics table may already exist from initial migration.
 * This migration uses IF NOT EXISTS to ensure idempotency.
 *
 * Created: 2025-11-04
 * Purpose: Ensure metrics table exists for telemetry tracking
 */

import type { DbClient } from "../types.ts";
import type { Migration } from "../migrations.ts";

/**
 * Create telemetry migration
 *
 * This migration ensures the metrics table exists for telemetry data.
 * Uses CREATE TABLE IF NOT EXISTS for safety since the table may already
 * be created by other migrations or code (see src/context/metrics.ts).
 */
export function createTelemetryMigration(): Migration {
  const telemetrySql = `
-- Metrics table for telemetry tracking
-- Uses IF NOT EXISTS to avoid conflicts with existing table
CREATE TABLE IF NOT EXISTS metrics (
  id SERIAL PRIMARY KEY,
  metric_name TEXT NOT NULL,
  value REAL NOT NULL,
  metadata JSONB,
  timestamp TIMESTAMP DEFAULT NOW()
);

-- Index for efficient metric queries by name and time
CREATE INDEX IF NOT EXISTS idx_metrics_name_timestamp
ON metrics (metric_name, timestamp DESC);
`;

  return {
    version: 2,
    name: "telemetry_logging",
    up: async (db: DbClient) => {
      // Split by semicolons and execute each statement
      const statements = telemetrySql
        .split(";")
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && !s.startsWith("--"));

      for (const statement of statements) {
        try {
          await db.exec(statement);
        } catch (error) {
          // If table already exists, that's okay - log and continue
          if (error instanceof Error && error.message.includes("already exists")) {
            console.warn(`Table or index already exists (expected): ${error.message}`);
          } else {
            throw error;
          }
        }
      }
    },
    down: async (db: DbClient) => {
      // Don't drop metrics table in down migration as it may be used by other features
      // Just drop our index if it exists
      await db.exec("DROP INDEX IF EXISTS idx_metrics_name_timestamp;");
    },
  };
}
