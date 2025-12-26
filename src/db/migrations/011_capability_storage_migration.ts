/**
 * Migration 011: Capability Storage (Epic 7 - Story 7.2a)
 *
 * Extends workflow_pattern and workflow_execution tables for capability storage.
 * Supports eager learning: store capability on 1st successful execution.
 *
 * Philosophy: Storage is cheap (~2KB/capability), filter at suggestion time.
 *
 * @module db/migrations/011_capability_storage_migration
 */

import type { Migration } from "../migrations.ts";
import type { DbClient } from "../types.ts";
import * as log from "@std/log";

export function createCapabilityStorageMigration(): Migration {
  return {
    version: 11,
    name: "capability_storage",
    up: async (db: DbClient) => {
      // ============================================
      // Extend workflow_pattern for capabilities
      // ============================================

      // Code snippet - the TypeScript code being stored
      await db.exec(`
        ALTER TABLE workflow_pattern
        ADD COLUMN IF NOT EXISTS code_snippet TEXT
      `);

      // Code hash for deduplication (SHA-256 of normalized code)
      await db.exec(`
        ALTER TABLE workflow_pattern
        ADD COLUMN IF NOT EXISTS code_hash TEXT
      `);

      // Parameters schema (populated by Story 7.2b)
      await db.exec(`
        ALTER TABLE workflow_pattern
        ADD COLUMN IF NOT EXISTS parameters_schema JSONB
      `);

      // Cache configuration
      await db.exec(`
        ALTER TABLE workflow_pattern
        ADD COLUMN IF NOT EXISTS cache_config JSONB DEFAULT '{"ttl_ms": 3600000, "cacheable": true}'::jsonb
      `);

      // Human-readable name
      await db.exec(`
        ALTER TABLE workflow_pattern
        ADD COLUMN IF NOT EXISTS name TEXT
      `);

      // Description of what this capability does
      await db.exec(`
        ALTER TABLE workflow_pattern
        ADD COLUMN IF NOT EXISTS description TEXT
      `);

      // Success rate (0.0 - 1.0)
      await db.exec(`
        ALTER TABLE workflow_pattern
        ADD COLUMN IF NOT EXISTS success_rate REAL DEFAULT 1.0
      `);

      // Average execution duration in milliseconds
      await db.exec(`
        ALTER TABLE workflow_pattern
        ADD COLUMN IF NOT EXISTS avg_duration_ms INTEGER DEFAULT 0
      `);

      // When capability was first learned
      await db.exec(`
        ALTER TABLE workflow_pattern
        ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()
      `);

      // Source: 'emergent' (auto-learned) or 'manual' (user-defined)
      await db.exec(`
        ALTER TABLE workflow_pattern
        ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'emergent'
      `);

      log.info("Migration 011: workflow_pattern extended with capability columns");

      // ============================================
      // Extend workflow_execution for code tracking
      // ============================================

      // Code snippet executed
      await db.exec(`
        ALTER TABLE workflow_execution
        ADD COLUMN IF NOT EXISTS code_snippet TEXT
      `);

      // Code hash for linking to workflow_pattern
      await db.exec(`
        ALTER TABLE workflow_execution
        ADD COLUMN IF NOT EXISTS code_hash TEXT
      `);

      log.info("Migration 011: workflow_execution extended with code columns");

      // ============================================
      // Create unique index on code_hash
      // ============================================

      // Partial unique index - only for non-null code_hash
      // This allows old patterns (from migration 010) to have NULL code_hash
      await db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_pattern_code_hash
        ON workflow_pattern(code_hash)
        WHERE code_hash IS NOT NULL
      `);

      log.info("Migration 011: idx_workflow_pattern_code_hash index created");

      // Index for linking executions to patterns
      await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_workflow_execution_code_hash
        ON workflow_execution(code_hash)
        WHERE code_hash IS NOT NULL
      `);

      log.info("Migration 011: idx_workflow_execution_code_hash index created");

      // ============================================
      // Verify existing HNSW index on intent_embedding
      // ============================================

      // The HNSW index was created in migration 010
      // Verify it exists for semantic search
      const hnswCheck = await db.query(`
        SELECT indexname FROM pg_indexes
        WHERE tablename = 'workflow_pattern'
        AND indexname = 'idx_pattern_intent_embedding'
      `);

      if (hnswCheck.length > 0) {
        log.info("Migration 011: HNSW index verified on intent_embedding");
      } else {
        log.warn("Migration 011: HNSW index not found - may need to run migration 010 first");
      }

      log.info("✓ Migration 011 complete: Capability storage");
    },
    down: async (db: DbClient) => {
      // Drop indexes
      await db.exec("DROP INDEX IF EXISTS idx_workflow_execution_code_hash");
      await db.exec("DROP INDEX IF EXISTS idx_workflow_pattern_code_hash");

      // Drop columns from workflow_execution
      await db.exec("ALTER TABLE workflow_execution DROP COLUMN IF EXISTS code_hash");
      await db.exec("ALTER TABLE workflow_execution DROP COLUMN IF EXISTS code_snippet");

      // Drop columns from workflow_pattern
      await db.exec("ALTER TABLE workflow_pattern DROP COLUMN IF EXISTS source");
      await db.exec("ALTER TABLE workflow_pattern DROP COLUMN IF EXISTS created_at");
      await db.exec("ALTER TABLE workflow_pattern DROP COLUMN IF EXISTS avg_duration_ms");
      await db.exec("ALTER TABLE workflow_pattern DROP COLUMN IF EXISTS success_rate");
      await db.exec("ALTER TABLE workflow_pattern DROP COLUMN IF EXISTS description");
      await db.exec("ALTER TABLE workflow_pattern DROP COLUMN IF EXISTS name");
      await db.exec("ALTER TABLE workflow_pattern DROP COLUMN IF EXISTS cache_config");
      await db.exec("ALTER TABLE workflow_pattern DROP COLUMN IF EXISTS parameters_schema");
      await db.exec("ALTER TABLE workflow_pattern DROP COLUMN IF EXISTS code_hash");
      await db.exec("ALTER TABLE workflow_pattern DROP COLUMN IF EXISTS code_snippet");

      log.info("Migration 011 rolled back");
    },
  };
}
