/**
 * Migration 027: SHGAT Parameters Persistence
 * Story 10.7b: Save/load SHGAT weights between server restarts
 *
 * Creates table for persisting SHGAT attention weights per user.
 */

import type { Migration } from "../migrations.ts";

export function createSHGATParamsMigration(): Migration {
  return {
    version: 27,
    name: "shgat_params",
    up: async (db) => {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS shgat_params (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id TEXT NOT NULL DEFAULT 'local' UNIQUE,
          params JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_shgat_params_user_id ON shgat_params(user_id);

        COMMENT ON TABLE shgat_params IS 'Persisted SHGAT attention weights for capability matching (Story 10.7b)';
      `);
    },
    down: async (db) => {
      await db.exec(`DROP TABLE IF EXISTS shgat_params;`);
    },
  };
}
