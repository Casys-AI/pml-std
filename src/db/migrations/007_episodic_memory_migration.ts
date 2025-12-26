/**
 * Migration 007: Episodic Memory & Adaptive Thresholds Persistence
 *
 * Story: 4.1a Schema PGlite (Epic 4 Phase 1)
 * ADR: ADR-008 Episodic Memory & Adaptive Thresholds
 *
 * Creates:
 * - episodic_events: Stores workflow execution events for learning retrieval
 * - adaptive_thresholds: Persists learned thresholds (extends Story 4.2)
 *
 * @module db/migrations/007_episodic_memory_migration
 */

import type { DbClient } from "../types.ts";
import type { Migration } from "../migrations.ts";
import * as log from "@std/log";

/**
 * Create episodic memory migration
 *
 * Up: Creates episodic_events and adaptive_thresholds tables with indexes
 * Down: Drops tables and indexes
 */
export function createEpisodicMemoryMigration(): Migration {
  const episodicMemorySql = `
-- Table 1: episodic_events
CREATE TABLE IF NOT EXISTS episodic_events (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  task_id TEXT,
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  context_hash TEXT,
  data JSONB NOT NULL,
  CONSTRAINT chk_event_type CHECK (
    event_type IN ('speculation_start', 'task_complete', 'ail_decision', 'hil_decision', 'workflow_start', 'workflow_complete')
  )
);

CREATE INDEX IF NOT EXISTS idx_episodic_workflow
  ON episodic_events(workflow_id);

CREATE INDEX IF NOT EXISTS idx_episodic_type
  ON episodic_events(event_type);

CREATE INDEX IF NOT EXISTS idx_episodic_timestamp
  ON episodic_events(timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_episodic_context_hash
  ON episodic_events(context_hash);

CREATE INDEX IF NOT EXISTS idx_episodic_data
  ON episodic_events USING GIN (data);

-- Table 2: adaptive_thresholds
CREATE TABLE IF NOT EXISTS adaptive_thresholds (
  context_hash TEXT PRIMARY KEY,
  context_keys JSONB NOT NULL,
  suggestion_threshold REAL NOT NULL DEFAULT 0.70,
  explicit_threshold REAL NOT NULL DEFAULT 0.50,
  success_rate REAL,
  sample_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT chk_suggestion_threshold CHECK (suggestion_threshold >= 0.40 AND suggestion_threshold <= 0.90),
  CONSTRAINT chk_explicit_threshold CHECK (explicit_threshold >= 0.30 AND explicit_threshold <= 0.80),
  CONSTRAINT chk_success_rate CHECK (success_rate IS NULL OR (success_rate >= 0.0 AND success_rate <= 1.0))
);

CREATE INDEX IF NOT EXISTS idx_adaptive_updated
  ON adaptive_thresholds(updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_adaptive_context_keys
  ON adaptive_thresholds USING GIN (context_keys);
`;

  return {
    version: 7,
    name: "episodic_memory",
    up: async (db: DbClient) => {
      // Remove SQL comments
      const sqlWithoutComments = episodicMemorySql
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .replace(/\/\*[\s\S]*?\*\//g, "");

      // Split and execute each statement
      const statements = sqlWithoutComments
        .split(";")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      for (const statement of statements) {
        try {
          await db.exec(statement);
        } catch (error) {
          log.error(`Failed to execute statement: ${statement.substring(0, 100)}...`);
          throw error;
        }
      }

      log.info("Migration 007: episodic_events and adaptive_thresholds tables created");
    },
    down: async (db: DbClient) => {
      // Drop indexes first, then tables
      // episodic_events indexes
      await db.exec("DROP INDEX IF EXISTS idx_episodic_data;");
      await db.exec("DROP INDEX IF EXISTS idx_episodic_context_hash;");
      await db.exec("DROP INDEX IF EXISTS idx_episodic_timestamp;");
      await db.exec("DROP INDEX IF EXISTS idx_episodic_type;");
      await db.exec("DROP INDEX IF EXISTS idx_episodic_workflow;");
      await db.exec("DROP TABLE IF EXISTS episodic_events CASCADE;");

      // adaptive_thresholds indexes
      await db.exec("DROP INDEX IF EXISTS idx_adaptive_context_keys;");
      await db.exec("DROP INDEX IF EXISTS idx_adaptive_updated;");
      await db.exec("DROP TABLE IF EXISTS adaptive_thresholds CASCADE;");

      log.info("Migration 007: episodic_events and adaptive_thresholds tables dropped");
    },
  };
}
