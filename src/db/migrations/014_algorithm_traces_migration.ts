/**
 * Migration 014: Algorithm Traces (Story 7.6 - ADR-039)
 *
 * Creates algorithm_traces table for observability of scoring algorithms.
 * Enables validation of Spectral Clustering, ReliabilityFactor, and other
 * ADR-038 scoring decisions.
 *
 * Features:
 * - Stores trace records for each scoring decision
 * - JSONB columns for flexible signal storage
 * - 7-day retention policy (cleanup via scheduled job)
 * - Indexes for time-based queries and mode filtering
 *
 * @module db/migrations/014_algorithm_traces_migration
 */

import type { Migration } from "../migrations.ts";
import type { DbClient } from "../types.ts";
import * as log from "@std/log";

export function createAlgorithmTracesMigration(): Migration {
  return {
    version: 14,
    name: "algorithm_traces",
    up: async (db: DbClient) => {
      // ============================================
      // Create algorithm_traces table
      // ============================================

      await db.exec(`
        CREATE TABLE IF NOT EXISTS algorithm_traces (
          -- Primary key: UUID for distributed-safe ID generation
          trace_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

          -- Timestamp for ordering and retention cleanup
          timestamp TIMESTAMPTZ DEFAULT NOW(),

          -- Algorithm mode: 'active_search' (intent-based) or 'passive_suggestion' (context-based)
          algorithm_mode TEXT NOT NULL,

          -- Target type: 'tool' or 'capability'
          target_type TEXT NOT NULL,

          -- Optional intent text (for active_search mode)
          intent TEXT,

          -- Context hash for linking to AdaptiveThresholds (Story 4.1c pattern)
          context_hash TEXT,

          -- Raw input signals as JSONB for flexibility
          -- Contains: semanticScore, toolsOverlap, successRate, pagerank, cooccurrence,
          --           graphDensity, spectralClusterMatch, adamicAdar
          signals JSONB NOT NULL DEFAULT '{}'::jsonb,

          -- Algorithm parameters used for this decision
          -- Contains: alpha (semantic vs graph), reliabilityFactor, structuralBoost
          params JSONB NOT NULL DEFAULT '{}'::jsonb,

          -- Computed final score after all adjustments
          final_score REAL NOT NULL,

          -- Adaptive threshold value used for this decision
          threshold_used REAL NOT NULL,

          -- Decision outcome: 'accepted', 'rejected_by_threshold', 'filtered_by_reliability'
          decision TEXT NOT NULL,

          -- Outcome (updated async after user feedback)
          -- Contains: userAction ('selected', 'ignored', 'explicit_rejection'),
          --           executionSuccess (boolean), durationMs (number)
          outcome JSONB,

          -- Audit column for when the trace was created (redundant with timestamp but follows pattern)
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);

      log.info("Migration 014: algorithm_traces table created");

      // ============================================
      // Create indexes for efficient queries
      // ============================================

      // Index for time-based queries (retention cleanup, recent traces)
      await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_algorithm_traces_timestamp
        ON algorithm_traces(timestamp)
      `);

      log.info("Migration 014: idx_algorithm_traces_timestamp index created");

      // Index for filtering by algorithm mode (active_search vs passive_suggestion)
      await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_algorithm_traces_mode
        ON algorithm_traces(algorithm_mode)
      `);

      log.info("Migration 014: idx_algorithm_traces_mode index created");

      // Index for filtering by target type (tool vs capability)
      await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_algorithm_traces_target_type
        ON algorithm_traces(target_type)
      `);

      log.info("Migration 014: idx_algorithm_traces_target_type index created");

      // Index for filtering by decision (for conversion rate analysis)
      await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_algorithm_traces_decision
        ON algorithm_traces(decision)
      `);

      log.info("Migration 014: idx_algorithm_traces_decision index created");

      // GIN index on signals JSONB for querying specific signal values
      // (e.g., WHERE signals->>'spectralClusterMatch' = 'true')
      await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_algorithm_traces_signals_gin
        ON algorithm_traces USING GIN (signals)
      `);

      log.info("Migration 014: idx_algorithm_traces_signals_gin index created");

      log.info("✓ Migration 014 complete: Algorithm traces table for ADR-039 observability");
    },

    down: async (db: DbClient) => {
      // Drop indexes first
      await db.exec("DROP INDEX IF EXISTS idx_algorithm_traces_signals_gin");
      await db.exec("DROP INDEX IF EXISTS idx_algorithm_traces_decision");
      await db.exec("DROP INDEX IF EXISTS idx_algorithm_traces_target_type");
      await db.exec("DROP INDEX IF EXISTS idx_algorithm_traces_mode");
      await db.exec("DROP INDEX IF EXISTS idx_algorithm_traces_timestamp");

      // Drop table
      await db.exec("DROP TABLE IF EXISTS algorithm_traces");

      log.info("Migration 014 rolled back");
    },
  };
}
