/**
 * Migration 016: Add capability_dependency table
 *
 * Creates dedicated table for capability-to-capability relationships.
 * Separate from tool_dependency for:
 *   - Proper UUID foreign keys to workflow_pattern
 *   - Clear semantics for capability relationships
 *   - Optimized queries by type
 *
 * Edge types (same as tool_dependency for consistency):
 *   - 'contains': Composition (capability A includes capability B)
 *   - 'sequence': Temporal order (A then B)
 *   - 'dependency': Explicit DAG dependency
 *   - 'alternative': Same intent, different implementation
 *
 * Edge sources:
 *   - 'template': Bootstrap, not yet confirmed
 *   - 'inferred': 1-2 observations
 *   - 'observed': 3+ observations (promoted from inferred)
 *
 * @module db/migrations/016_capability_dependency
 */

import type { Migration } from "../migrations.ts";
import type { DbClient } from "../types.ts";
import * as log from "@std/log";

export function createCapabilityDependencyMigration(): Migration {
  return {
    version: 16,
    name: "capability_dependency",
    up: async (db: DbClient) => {
      // Create capability_dependency table with foreign keys to workflow_pattern
      await db.exec(`
        CREATE TABLE IF NOT EXISTS capability_dependency (
          from_capability_id UUID NOT NULL REFERENCES workflow_pattern(pattern_id) ON DELETE CASCADE,
          to_capability_id UUID NOT NULL REFERENCES workflow_pattern(pattern_id) ON DELETE CASCADE,
          observed_count INTEGER DEFAULT 1,
          confidence_score REAL DEFAULT 0.5,
          edge_type TEXT DEFAULT 'sequence',
          edge_source TEXT DEFAULT 'inferred',
          created_at TIMESTAMPTZ DEFAULT NOW(),
          last_observed TIMESTAMPTZ DEFAULT NOW(),
          PRIMARY KEY (from_capability_id, to_capability_id),
          CHECK (from_capability_id != to_capability_id)
        )
      `);
      log.info("Migration 016: capability_dependency table created");

      // Create indexes for efficient queries
      await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_capability_dep_from
        ON capability_dependency(from_capability_id)
      `);
      log.info("Migration 016: idx_capability_dep_from index created");

      await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_capability_dep_to
        ON capability_dependency(to_capability_id)
      `);
      log.info("Migration 016: idx_capability_dep_to index created");

      await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_capability_dep_type
        ON capability_dependency(edge_type)
      `);
      log.info("Migration 016: idx_capability_dep_type index created");

      await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_capability_dep_type_source
        ON capability_dependency(edge_type, edge_source)
      `);
      log.info("Migration 016: idx_capability_dep_type_source composite index created");

      log.info("✓ Migration 016 complete: capability_dependency table");
    },
    down: async (db: DbClient) => {
      // Drop indexes first
      await db.exec("DROP INDEX IF EXISTS idx_capability_dep_type_source");
      await db.exec("DROP INDEX IF EXISTS idx_capability_dep_type");
      await db.exec("DROP INDEX IF EXISTS idx_capability_dep_to");
      await db.exec("DROP INDEX IF EXISTS idx_capability_dep_from");

      // Drop table
      await db.exec("DROP TABLE IF EXISTS capability_dependency");

      log.info("Migration 016 rolled back");
    },
  };
}
