/**
 * Migration 018: Create permission_audit_log table
 *
 * Stores audit trail for all permission escalation decisions (Story 7.7c).
 * Every escalation request (approved or rejected) is logged for security audit.
 *
 * Table: permission_audit_log
 *   - id: TEXT PRIMARY KEY - UUID
 *   - timestamp: INTEGER - Unix timestamp when escalation was requested
 *   - capability_id: TEXT - FK to workflow_pattern.pattern_id
 *   - from_set: TEXT - Permission set before escalation (e.g., "minimal")
 *   - to_set: TEXT - Permission set requested (e.g., "network-api")
 *   - approved: INTEGER - Boolean (0/1) whether escalation was approved
 *   - approved_by: TEXT - User ID or "system"
 *   - reason: TEXT - Original error message that triggered escalation
 *   - detected_operation: TEXT - Operation type (e.g., "fetch", "read", "write")
 *
 * Indexes:
 *   - idx_permission_audit_capability: On capability_id for filtering
 *   - idx_permission_audit_timestamp: On timestamp for audit queries
 *
 * @module db/migrations/018_permission_audit_log
 */

import type { Migration } from "../migrations.ts";
import type { DbClient } from "../types.ts";
import * as log from "@std/log";

export function createPermissionAuditLogMigration(): Migration {
  return {
    version: 18,
    name: "permission_audit_log",
    up: async (db: DbClient) => {
      // Create permission_audit_log table
      await db.exec(`
        CREATE TABLE IF NOT EXISTS permission_audit_log (
          id TEXT PRIMARY KEY,
          timestamp BIGINT NOT NULL,
          capability_id TEXT NOT NULL,
          from_set TEXT NOT NULL,
          to_set TEXT NOT NULL,
          approved INTEGER NOT NULL,
          approved_by TEXT,
          reason TEXT,
          detected_operation TEXT
        )
      `);
      log.info("Migration 018: permission_audit_log table created");

      // Create index on capability_id for efficient filtering
      await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_permission_audit_capability
        ON permission_audit_log(capability_id)
      `);
      log.info("Migration 018: idx_permission_audit_capability index created");

      // Create index on timestamp for audit queries
      await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_permission_audit_timestamp
        ON permission_audit_log(timestamp DESC)
      `);
      log.info("Migration 018: idx_permission_audit_timestamp index created");

      log.info("✓ Migration 018 complete: permission_audit_log table created");
    },
    down: async (db: DbClient) => {
      // Drop indexes first
      await db.exec("DROP INDEX IF EXISTS idx_permission_audit_timestamp");
      await db.exec("DROP INDEX IF EXISTS idx_permission_audit_capability");

      // Drop table
      await db.exec("DROP TABLE IF EXISTS permission_audit_log");

      log.info("Migration 018 rolled back");
    },
  };
}
