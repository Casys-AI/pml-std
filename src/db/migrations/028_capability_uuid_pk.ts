/**
 * Migration 028: Capability UUID Primary Key (Epic 13 - Refactoring)
 *
 * Refactors capability_records to use UUID as primary key instead of FQDN.
 *
 * Changes:
 * 1. Add `uuid` column as new PK (immutable identifier)
 * 2. Rename `id` (FQDN) to computed - we keep org/project/namespace/action/hash columns
 * 3. Remove `display_name` column (redundant - use namespace:action instead)
 * 4. Drop `capability_aliases` table (no longer needed without display_name)
 * 5. Update FK in any referencing tables
 *
 * Rationale:
 * - FQDN contains org/project which are mutable (can be renamed)
 * - UUID provides stable identity for code references: mcp["$cap:<uuid>"]
 * - FQDN can be computed from: org.project.namespace.action.hash
 * - display_name was redundant with namespace:action
 *
 * @module db/migrations/028_capability_uuid_pk
 */

import type { Migration } from "../migrations.ts";
import type { DbClient } from "../types.ts";
import * as log from "@std/log";

export function createCapabilityUuidPkMigration(): Migration {
  return {
    version: 28,
    name: "capability_uuid_pk",
    up: async (db: DbClient) => {
      log.info("Migration 028: Refactoring capability_records to use UUID PK...");

      // ============================================
      // 1. Drop capability_aliases table (no longer needed)
      // ============================================
      await db.exec(`DROP TABLE IF EXISTS capability_aliases CASCADE`);
      log.info("  ✓ Dropped capability_aliases table");

      // ============================================
      // 2. Add new UUID column
      // ============================================
      await db.exec(`
        ALTER TABLE capability_records
        ADD COLUMN IF NOT EXISTS uuid UUID DEFAULT gen_random_uuid()
      `);
      log.info("  ✓ Added uuid column");

      // ============================================
      // 3. Populate UUID for existing rows
      // ============================================
      await db.exec(`
        UPDATE capability_records
        SET uuid = gen_random_uuid()
        WHERE uuid IS NULL
      `);
      log.info("  ✓ Generated UUIDs for existing records");

      // ============================================
      // 4. Drop old PK constraint and id column
      // ============================================
      // First drop the PK constraint (id was the PK)
      try {
        await db.exec(`
          ALTER TABLE capability_records
          DROP CONSTRAINT IF EXISTS capability_records_pkey
        `);
        log.info("  ✓ Dropped old PK constraint");
      } catch (e) {
        log.warn(`  ○ Could not drop PK constraint: ${e}`);
      }

      // Drop the old 'id' column (was FQDN, now computed from components)
      try {
        await db.exec(`
          ALTER TABLE capability_records
          DROP COLUMN IF EXISTS id
        `);
        log.info("  ✓ Dropped old id (FQDN) column");
      } catch (e) {
        log.warn(`  ○ Could not drop id column: ${e}`);
      }

      // ============================================
      // 5. Rename uuid to id and set as PK
      // ============================================
      await db.exec(`
        ALTER TABLE capability_records
        RENAME COLUMN uuid TO id
      `);
      log.info("  ✓ Renamed uuid column to id");

      await db.exec(`
        ALTER TABLE capability_records
        ADD PRIMARY KEY (id)
      `);
      log.info("  ✓ Set id (UUID) as new PK");

      // ============================================
      // 6. Drop display_name column (redundant)
      // ============================================
      try {
        await db.exec(`
          ALTER TABLE capability_records
          DROP COLUMN IF EXISTS display_name
        `);
        log.info("  ✓ Dropped display_name column");
      } catch (e) {
        log.warn(`  ○ Could not drop display_name: ${e}`);
      }

      // ============================================
      // 7. Add unique constraint on FQDN components
      // ============================================
      await db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_capability_records_fqdn
        ON capability_records(org, project, namespace, action, hash)
      `);
      log.info("  ✓ Created unique index on FQDN components");

      // ============================================
      // 8. Update table comment
      // ============================================
      try {
        await db.exec(
          `COMMENT ON TABLE capability_records IS 'Capability registry with UUID PK. FQDN computed from org.project.namespace.action.hash. Epic 13 refactor.'`,
        );
        await db.exec(
          `COMMENT ON COLUMN capability_records.id IS 'Immutable UUID primary key for stable code references'`,
        );
      } catch {
        // Comments are optional, may fail on PGlite
      }

      log.info("✓ Migration 028 complete: capability_records now uses UUID PK");
    },
    down: async (db: DbClient) => {
      log.info("Migration 028 rollback: Restoring FQDN-based PK...");

      // 1. Add back display_name
      await db.exec(`
        ALTER TABLE capability_records
        ADD COLUMN IF NOT EXISTS display_name TEXT
      `);

      // 2. Populate display_name from namespace:action
      await db.exec(`
        UPDATE capability_records
        SET display_name = namespace || ':' || action
        WHERE display_name IS NULL
      `);

      // 3. Add back fqdn column as 'id'
      await db.exec(`
        ALTER TABLE capability_records
        ADD COLUMN IF NOT EXISTS fqdn_temp TEXT
      `);

      await db.exec(`
        UPDATE capability_records
        SET fqdn_temp = org || '.' || project || '.' || namespace || '.' || action || '.' || hash
      `);

      // 4. Drop current PK
      await db.exec(`
        ALTER TABLE capability_records
        DROP CONSTRAINT IF EXISTS capability_records_pkey
      `);

      // 5. Rename id to uuid_temp, fqdn_temp to id
      await db.exec(`ALTER TABLE capability_records RENAME COLUMN id TO uuid_temp`);
      await db.exec(`ALTER TABLE capability_records RENAME COLUMN fqdn_temp TO id`);

      // 6. Set id (FQDN) as PK
      await db.exec(`
        ALTER TABLE capability_records
        ADD PRIMARY KEY (id)
      `);

      // 7. Drop uuid_temp
      await db.exec(`ALTER TABLE capability_records DROP COLUMN uuid_temp`);

      // 8. Recreate capability_aliases table
      await db.exec(`
        CREATE TABLE IF NOT EXISTS capability_aliases (
          alias TEXT NOT NULL,
          org TEXT NOT NULL,
          project TEXT NOT NULL,
          target_fqdn TEXT NOT NULL REFERENCES capability_records(id) ON DELETE CASCADE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (org, project, alias)
        )
      `);

      // 9. Drop FQDN unique index
      await db.exec(`DROP INDEX IF EXISTS idx_capability_records_fqdn`);

      log.info("Migration 028 rollback complete");
    },
  };
}
