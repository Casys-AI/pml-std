/**
 * Migration 037: Update routing constraint to client/server terminology
 *
 * The routing column was created with CHECK (routing IN ('local', 'cloud'))
 * but the codebase now uses 'client'/'server' terminology (Story 13.9).
 *
 * This migration:
 * 1. Converts existing 'local' → 'client' and 'cloud' → 'server'
 * 2. Updates the check constraint to accept new values
 *
 * @module db/migrations/037_routing_client_server
 */

import type { Migration } from "../migrations.ts";
import type { DbClient } from "../types.ts";
import * as log from "@std/log";

export function createRoutingClientServerMigration(): Migration {
  return {
    version: 37,
    name: "routing_client_server",
    up: async (db: DbClient) => {
      log.info("Migration 037: Updating routing constraint to client/server...");

      // 1. Drop old constraint FIRST (before UPDATE to avoid violation)
      await db.exec(`
        ALTER TABLE capability_records
        DROP CONSTRAINT IF EXISTS capability_records_routing_check
      `);
      log.info("  ✓ Dropped old routing constraint");

      // 2. Convert existing values (now safe without constraint)
      await db.exec(`
        UPDATE capability_records
        SET routing = CASE
          WHEN routing = 'local' THEN 'client'
          WHEN routing = 'cloud' THEN 'server'
          ELSE routing
        END
        WHERE routing IN ('local', 'cloud')
      `);
      log.info("  ✓ Converted local→client, cloud→server");

      // 3. Add new constraint
      await db.exec(`
        ALTER TABLE capability_records
        ADD CONSTRAINT capability_records_routing_check
        CHECK (routing IN ('client', 'server'))
      `);
      log.info("  ✓ Added new routing constraint (client/server)");

      // 4. Update DEFAULT value to match new terminology
      await db.exec(`
        ALTER TABLE capability_records
        ALTER COLUMN routing SET DEFAULT 'client'
      `);
      log.info("  ✓ Updated routing default to 'client'");

      // 5. Update tool_schema routing (same treatment)
      // Drop old constraint first
      try {
        await db.exec(`
          ALTER TABLE tool_schema
          DROP CONSTRAINT IF EXISTS tool_schema_routing_check
        `);
      } catch {
        // Constraint may not exist
      }

      // Convert values
      await db.exec(`
        UPDATE tool_schema
        SET routing = CASE
          WHEN routing = 'local' THEN 'client'
          WHEN routing = 'cloud' THEN 'server'
          ELSE routing
        END
        WHERE routing IN ('local', 'cloud')
      `);

      // Add new constraint
      try {
        await db.exec(`
          ALTER TABLE tool_schema
          ADD CONSTRAINT tool_schema_routing_check
          CHECK (routing IN ('client', 'server'))
        `);
      } catch {
        // Constraint may already exist
      }

      // Update default
      await db.exec(`
        ALTER TABLE tool_schema
        ALTER COLUMN routing SET DEFAULT 'client'
      `);
      log.info("  ✓ Updated tool_schema routing to client/server");

      // 6. Update column comment
      try {
        await db.exec(`
          COMMENT ON COLUMN capability_records.routing IS
            'Execution location: client (local sandbox) or server (pml.casys.ai HTTP RPC)'
        `);
        log.debug("  ✓ Updated column comment");
      } catch {
        // Comments are optional
      }

      log.info("✓ Migration 037 complete: routing constraint updated to client/server");
    },
    down: async (db: DbClient) => {
      log.info("Migration 037 rollback: Reverting to local/cloud terminology...");

      // Convert back
      await db.exec(`
        UPDATE capability_records
        SET routing = CASE
          WHEN routing = 'client' THEN 'local'
          WHEN routing = 'server' THEN 'cloud'
          ELSE routing
        END
        WHERE routing IN ('client', 'server')
      `);

      // Drop new constraint and restore old one
      await db.exec(`
        ALTER TABLE capability_records
        DROP CONSTRAINT IF EXISTS capability_records_routing_check
      `);

      await db.exec(`
        ALTER TABLE capability_records
        ADD CONSTRAINT capability_records_routing_check
        CHECK (routing IN ('local', 'cloud'))
      `);

      // Restore old default
      await db.exec(`
        ALTER TABLE capability_records
        ALTER COLUMN routing SET DEFAULT 'local'
      `);

      // Rollback tool_schema too
      await db.exec(`
        UPDATE tool_schema
        SET routing = CASE
          WHEN routing = 'client' THEN 'local'
          WHEN routing = 'server' THEN 'cloud'
          ELSE routing
        END
        WHERE routing IN ('client', 'server')
      `);

      try {
        await db.exec(`
          ALTER TABLE tool_schema
          DROP CONSTRAINT IF EXISTS tool_schema_routing_check
        `);
        await db.exec(`
          ALTER TABLE tool_schema
          ADD CONSTRAINT tool_schema_routing_check
          CHECK (routing IN ('local', 'cloud'))
        `);
      } catch {
        // Best effort
      }

      await db.exec(`
        ALTER TABLE tool_schema
        ALTER COLUMN routing SET DEFAULT 'local'
      `);

      log.info("Migration 037 rollback complete");
    },
  };
}
