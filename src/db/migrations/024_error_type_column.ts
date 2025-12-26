/**
 * Migration 024: Error Type Column for execution_trace
 *
 * Story 11.x: Adds error_type for errorTypeAffinity feature in SHGAT v2.
 * Enables learning per-error-type recovery patterns.
 *
 * Changes:
 * 1. ADD error_type TEXT column to execution_trace
 * 2. CREATE index for error_type queries
 * 3. BACKFILL existing records by parsing error_message
 *
 * Error types: TIMEOUT, PERMISSION, NOT_FOUND, VALIDATION, NETWORK, UNKNOWN
 *
 * @module db/migrations/024_error_type_column
 */

import type { Migration } from "../migrations.ts";
import type { DbClient } from "../types.ts";
import * as log from "@std/log";

/**
 * Classify an error message into a type category
 *
 * Used during backfill and at trace insertion time.
 */
export function classifyErrorType(errorMessage: string | null): string {
  if (!errorMessage) return "UNKNOWN";

  const msg = errorMessage.toLowerCase();

  // Timeout errors
  if (msg.includes("timeout") || msg.includes("timed out") || msg.includes("deadline")) {
    return "TIMEOUT";
  }

  // Permission/auth errors
  if (
    msg.includes("permission") ||
    msg.includes("denied") ||
    msg.includes("unauthorized") ||
    msg.includes("forbidden") ||
    msg.includes("403") ||
    msg.includes("401")
  ) {
    return "PERMISSION";
  }

  // Not found errors
  if (
    msg.includes("not found") ||
    msg.includes("404") ||
    msg.includes("does not exist") ||
    msg.includes("no such") ||
    msg.includes("missing")
  ) {
    return "NOT_FOUND";
  }

  // Validation errors
  if (
    msg.includes("validation") ||
    msg.includes("invalid") ||
    msg.includes("malformed") ||
    msg.includes("parse") ||
    msg.includes("schema") ||
    msg.includes("type error")
  ) {
    return "VALIDATION";
  }

  // Network errors
  if (
    msg.includes("network") ||
    msg.includes("econnrefused") ||
    msg.includes("econnreset") ||
    msg.includes("enotfound") ||
    msg.includes("socket") ||
    msg.includes("connection")
  ) {
    return "NETWORK";
  }

  return "UNKNOWN";
}

/**
 * All known error types for SHGAT v2 errorTypeAffinity
 */
export const ERROR_TYPES = [
  "TIMEOUT",
  "PERMISSION",
  "NOT_FOUND",
  "VALIDATION",
  "NETWORK",
  "UNKNOWN",
] as const;

export type ErrorType = typeof ERROR_TYPES[number];

export function createErrorTypeColumnMigration(): Migration {
  return {
    version: 24,
    name: "error_type_column",
    up: async (db: DbClient) => {
      log.info("Migration 024: Adding error_type column to execution_trace...");

      // 1. Add error_type column (nullable, backfilled below)
      try {
        await db.exec(`
          ALTER TABLE execution_trace
          ADD COLUMN IF NOT EXISTS error_type TEXT
        `);
        log.info("  ✓ Added error_type column");
      } catch (error) {
        if (String(error).includes("already exists")) {
          log.info("  ○ error_type column already exists");
        } else {
          throw error;
        }
      }

      // 2. Create index for error_type queries
      await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_exec_trace_error_type
        ON execution_trace(error_type)
        WHERE error_type IS NOT NULL
      `);
      log.info("  ✓ Created idx_exec_trace_error_type");

      // 3. Backfill existing failed traces by parsing error_message
      const result = await db.query(`
        SELECT id, error_message
        FROM execution_trace
        WHERE success = false
          AND error_message IS NOT NULL
          AND error_type IS NULL
      `);

      const rows = result as Array<{ id: string; error_message: string }>;

      if (rows.length > 0) {
        log.info(`  → Backfilling ${rows.length} failed traces...`);

        for (const row of rows) {
          const errorType = classifyErrorType(row.error_message);
          await db.exec(
            `UPDATE execution_trace SET error_type = $1 WHERE id = $2`,
            [errorType, row.id],
          );
        }

        log.info(`  ✓ Backfilled ${rows.length} traces with error_type`);
      } else {
        log.info("  ○ No traces to backfill");
      }

      // 4. Add comment for documentation
      try {
        await db.exec(`
          COMMENT ON COLUMN execution_trace.error_type IS
            'Error category: TIMEOUT, PERMISSION, NOT_FOUND, VALIDATION, NETWORK, UNKNOWN. For SHGAT v2 errorTypeAffinity.'
        `);
      } catch {
        // Comments are optional
      }

      log.info("✓ Migration 024 complete: error_type column added");
    },
    down: async (db: DbClient) => {
      log.info("Migration 024 rollback: Removing error_type column...");

      await db.exec("DROP INDEX IF EXISTS idx_exec_trace_error_type");
      log.info("  ✓ Dropped idx_exec_trace_error_type");

      await db.exec("ALTER TABLE execution_trace DROP COLUMN IF EXISTS error_type");
      log.info("  ✓ Dropped error_type column");

      log.info("Migration 024 rollback complete");
    },
  };
}
