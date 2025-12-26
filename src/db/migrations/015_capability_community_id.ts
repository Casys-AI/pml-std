/**
 * Migration 015: Add community_id to workflow_pattern (Story 8.1)
 *
 * Adds Louvain community ID column to workflow_pattern for capability clustering.
 * Community IDs are calculated from the tool graph and can be used to filter
 * related capabilities.
 *
 * @module db/migrations/015_capability_community_id
 */

import type { Migration } from "../migrations.ts";
import type { DbClient } from "../types.ts";
import * as log from "@std/log";

export function createCapabilityCommunityIdMigration(): Migration {
  return {
    version: 15,
    name: "capability_community_id",
    up: async (db: DbClient) => {
      // Add community_id column to workflow_pattern
      await db.exec(`
        ALTER TABLE workflow_pattern
        ADD COLUMN IF NOT EXISTS community_id INTEGER
      `);

      log.info("Migration 015: community_id column added to workflow_pattern");

      // Create index on community_id for filtering
      await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_workflow_pattern_community_id
        ON workflow_pattern(community_id)
        WHERE community_id IS NOT NULL
      `);

      log.info("Migration 015: idx_workflow_pattern_community_id index created");

      log.info("✓ Migration 015 complete: Capability community_id column");
    },
    down: async (db: DbClient) => {
      await db.exec("DROP INDEX IF EXISTS idx_workflow_pattern_community_id");
      await db.exec(`
        ALTER TABLE workflow_pattern
        DROP COLUMN IF EXISTS community_id
      `);
      log.info("Migration 015 rolled back");
    },
  };
}
