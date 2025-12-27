/**
 * Migration 021: Capability Records & Aliases (Epic 13 - Story 13.1)
 *
 * Creates the capability registry with FQDN structure, rich metadata, and alias support.
 * Introduces dual-table strategy alongside existing workflow_pattern table.
 *
 * Tables:
 * - capability_records: Registry with FQDN, versioning, visibility, provenance
 * - capability_aliases: Alias resolution with chain prevention
 *
 * This is an ADDITIVE migration - does not modify existing tables.
 *
 * @module db/migrations/021_capability_records
 */

import type { Migration } from "../migrations.ts";
import type { DbClient } from "../types.ts";
import * as log from "@std/log";

export function createCapabilityRecordsMigration(): Migration {
  return {
    version: 21,
    name: "capability_records",
    up: async (db: DbClient) => {
      log.info("Migration 021: Creating capability_records and capability_aliases tables...");

      // ============================================
      // 1. Create capability_records table (AC1)
      // ============================================
      await db.exec(`
        CREATE TABLE IF NOT EXISTS capability_records (
          -- Identity (AC1)
          id TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          org TEXT NOT NULL,
          project TEXT NOT NULL,
          namespace TEXT NOT NULL,
          action TEXT NOT NULL,
          hash TEXT NOT NULL,

          -- Provenance (AC1)
          created_by TEXT NOT NULL DEFAULT 'local',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_by TEXT,
          updated_at TIMESTAMPTZ,

          -- Versioning (AC1)
          version INTEGER NOT NULL DEFAULT 1,
          version_tag TEXT,

          -- Trust (AC1)
          verified BOOLEAN NOT NULL DEFAULT FALSE,
          signature TEXT,

          -- Metrics (AC1)
          usage_count INTEGER NOT NULL DEFAULT 0,
          success_count INTEGER NOT NULL DEFAULT 0,
          total_latency_ms BIGINT NOT NULL DEFAULT 0,

          -- Metadata (AC1)
          tags TEXT[] DEFAULT '{}',
          visibility TEXT NOT NULL DEFAULT 'private'
            CHECK (visibility IN ('private', 'project', 'org', 'public')),
          code_snippet TEXT,
          parameters_schema JSONB,
          description TEXT,
          tools_used TEXT[] DEFAULT '{}',
          routing TEXT NOT NULL DEFAULT 'local'
            CHECK (routing IN ('local', 'cloud'))
        )
      `);
      log.info("  ✓ Created capability_records table");

      // ============================================
      // 2. Create indexes (AC2)
      // ============================================

      // Scope-based queries
      await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_capability_records_scope
        ON capability_records(org, project)
      `);
      log.debug("  ✓ Created idx_capability_records_scope");

      // Name resolution within scope
      await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_capability_records_name
        ON capability_records(org, project, display_name)
      `);
      log.debug("  ✓ Created idx_capability_records_name");

      // Namespace filtering
      await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_capability_records_namespace
        ON capability_records(namespace)
      `);
      log.debug("  ✓ Created idx_capability_records_namespace");

      // Creator queries
      await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_capability_records_creator
        ON capability_records(created_by)
      `);
      log.debug("  ✓ Created idx_capability_records_creator");

      // Tag-based search (GIN for array)
      await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_capability_records_tags
        ON capability_records USING GIN(tags)
      `);
      log.debug("  ✓ Created idx_capability_records_tags (GIN)");

      // Access control filtering
      await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_capability_records_visibility
        ON capability_records(visibility)
      `);
      log.debug("  ✓ Created idx_capability_records_visibility");

      log.info("  ✓ Created all capability_records indexes");

      // ============================================
      // 3. Create capability_aliases table (AC3)
      // ============================================
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
      log.info("  ✓ Created capability_aliases table");

      // Index for reverse lookup (find all aliases for a target)
      await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_capability_aliases_target
        ON capability_aliases(target_fqdn)
      `);
      log.debug("  ✓ Created idx_capability_aliases_target");

      log.info("  ✓ Created capability_aliases indexes");

      // ============================================
      // 4. Add table comments for documentation
      // ============================================
      try {
        await db.exec(`
          COMMENT ON TABLE capability_records IS
            'Capability registry with FQDN structure (<org>.<project>.<namespace>.<action>.<hash>), versioning, and visibility control. Epic 13.'
        `);
        await db.exec(`
          COMMENT ON COLUMN capability_records.id IS
            'FQDN primary key: <org>.<project>.<namespace>.<action>.<hash>'
        `);
        await db.exec(`
          COMMENT ON COLUMN capability_records.display_name IS
            'Free-format human-readable name (user-chosen)'
        `);
        await db.exec(`
          COMMENT ON COLUMN capability_records.hash IS
            '4-char hex of SHA-256 of code_snippet for uniqueness within namespace'
        `);
        await db.exec(`
          COMMENT ON COLUMN capability_records.visibility IS
            'Access control: private (owner only), project, org, public'
        `);
        await db.exec(`
          COMMENT ON COLUMN capability_records.routing IS
            'Execution location: local (sandbox) or cloud (HTTP RPC)'
        `);
        await db.exec(`
          COMMENT ON TABLE capability_aliases IS
            'Alias table for capability renames with chain prevention. Old names resolve to current FQDN.'
        `);
        await db.exec(`
          COMMENT ON COLUMN capability_aliases.target_fqdn IS
            'Points directly to current FQDN (no alias chains allowed)'
        `);
        log.debug("  ✓ Added table comments");
      } catch {
        // Comments are optional - continue if they fail
      }

      log.info(
        "✓ Migration 021 complete: capability_records and capability_aliases tables created",
      );
    },
    down: async (db: DbClient) => {
      log.info(
        "Migration 021 rollback: Dropping capability_records and capability_aliases tables...",
      );

      // Drop aliases first (has FK to records)
      await db.exec("DROP INDEX IF EXISTS idx_capability_aliases_target");
      await db.exec("DROP TABLE IF EXISTS capability_aliases CASCADE");
      log.info("  ✓ Dropped capability_aliases table");

      // Drop records indexes
      await db.exec("DROP INDEX IF EXISTS idx_capability_records_visibility");
      await db.exec("DROP INDEX IF EXISTS idx_capability_records_tags");
      await db.exec("DROP INDEX IF EXISTS idx_capability_records_creator");
      await db.exec("DROP INDEX IF EXISTS idx_capability_records_namespace");
      await db.exec("DROP INDEX IF EXISTS idx_capability_records_name");
      await db.exec("DROP INDEX IF EXISTS idx_capability_records_scope");
      log.info("  ✓ Dropped capability_records indexes");

      // Drop records table
      await db.exec("DROP TABLE IF EXISTS capability_records CASCADE");
      log.info("  ✓ Dropped capability_records table");

      log.info("Migration 021 rollback complete");
    },
  };
}
