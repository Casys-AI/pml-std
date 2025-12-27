/**
 * Migration 026: Add algorithm_name and correlation_id columns to algorithm_traces
 *
 * Adds algorithm_name field to track which specific algorithm produced the trace:
 * - CapabilityMatcher
 * - DAGSuggester
 * - HybridSearch
 * - SHGAT
 * - DRDSP
 * - AlternativesPrediction
 * - CapabilitiesPrediction
 *
 * Adds correlation_id to group traces from the same operation (e.g., pml:execute call)
 *
 * @module db/migrations/026_algorithm_name_column
 */

import type { Migration } from "../migrations.ts";
import type { DbClient } from "../types.ts";
import * as log from "@std/log";

export function createAlgorithmNameColumnMigration(): Migration {
  return {
    version: 26,
    name: "algorithm_name_column",
    up: async (db: DbClient) => {
      // Add algorithm_name column
      await db.exec(`
        ALTER TABLE algorithm_traces
        ADD COLUMN IF NOT EXISTS algorithm_name TEXT
      `);

      log.info("Migration 026: algorithm_name column added");

      // Add correlation_id column for grouping traces from same operation
      await db.exec(`
        ALTER TABLE algorithm_traces
        ADD COLUMN IF NOT EXISTS correlation_id UUID
      `);

      log.info("Migration 026: correlation_id column added");

      // Create index for filtering by algorithm
      await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_algorithm_traces_algorithm_name
        ON algorithm_traces(algorithm_name)
      `);

      log.info("Migration 026: idx_algorithm_traces_algorithm_name index created");

      // Create index for grouping by correlation
      await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_algorithm_traces_correlation_id
        ON algorithm_traces(correlation_id)
      `);

      log.info("Migration 026: idx_algorithm_traces_correlation_id index created");

      log.info("✓ Migration 026 complete: algorithm_name and correlation_id columns");
    },

    down: async (db: DbClient) => {
      await db.exec("DROP INDEX IF EXISTS idx_algorithm_traces_correlation_id");
      await db.exec("DROP INDEX IF EXISTS idx_algorithm_traces_algorithm_name");
      await db.exec("ALTER TABLE algorithm_traces DROP COLUMN IF EXISTS correlation_id");
      await db.exec("ALTER TABLE algorithm_traces DROP COLUMN IF EXISTS algorithm_name");
      log.info("Migration 026 rolled back");
    },
  };
}
