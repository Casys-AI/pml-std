/**
 * Migration 010: GraphRAG Tables (Epic 2)
 *
 * Creates tables for workflow execution history, patterns, and adaptive config.
 * These tables were originally in 003_graphrag_tables.sql but never integrated.
 *
 * Discovered during Story 6.3 code review - the SQL file existed but was
 * never registered in the TypeScript migration system.
 *
 * @module db/migrations/010_graphrag_tables_migration
 */

import type { Migration } from "../migrations.ts";
import type { DbClient } from "../types.ts";
import * as log from "@std/log";

export function createGraphRagTablesMigration(): Migration {
  return {
    version: 10,
    name: "graphrag_tables",
    up: async (db: DbClient) => {
      // ============================================
      // Workflow execution history (Story 6.3 time-series)
      // ============================================
      await db.exec(`
        CREATE TABLE IF NOT EXISTS workflow_execution (
          execution_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          executed_at TIMESTAMP DEFAULT NOW(),
          intent_text TEXT,
          dag_structure JSONB NOT NULL,
          success BOOLEAN NOT NULL,
          execution_time_ms INTEGER NOT NULL,
          error_message TEXT
        )
      `);
      await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_execution_timestamp
        ON workflow_execution(executed_at DESC)
      `);
      log.info("Migration 010: workflow_execution table created");

      // ============================================
      // Workflow patterns (for semantic search)
      // ============================================
      await db.exec(`
        CREATE TABLE IF NOT EXISTS workflow_pattern (
          pattern_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          pattern_hash TEXT UNIQUE NOT NULL,
          dag_structure JSONB NOT NULL,
          intent_embedding vector(1024) NOT NULL,
          usage_count INTEGER DEFAULT 1,
          success_count INTEGER DEFAULT 0,
          last_used TIMESTAMP DEFAULT NOW()
        )
      `);
      await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_pattern_intent_embedding
        ON workflow_pattern USING hnsw (intent_embedding vector_cosine_ops)
        WITH (m = 16, ef_construction = 64)
      `);
      log.info("Migration 010: workflow_pattern table created");

      // ============================================
      // Adaptive threshold configuration
      // ============================================
      await db.exec(`
        CREATE TABLE IF NOT EXISTS adaptive_config (
          config_key TEXT PRIMARY KEY,
          config_value REAL NOT NULL,
          last_updated TIMESTAMP DEFAULT NOW(),
          total_samples INTEGER DEFAULT 0
        )
      `);

      // Insert default thresholds
      await db.exec(`
        INSERT INTO adaptive_config (config_key, config_value, total_samples)
        VALUES
          ('threshold_speculative', 0.85, 0),
          ('threshold_suggestion', 0.70, 0),
          ('threshold_explicit', 0.70, 0)
        ON CONFLICT (config_key) DO NOTHING
      `);
      log.info("Migration 010: adaptive_config table created with defaults");

      log.info("✓ Migration 010 complete: GraphRAG tables");
    },
    down: async (db: DbClient) => {
      await db.exec("DROP INDEX IF EXISTS idx_pattern_intent_embedding");
      await db.exec("DROP INDEX IF EXISTS idx_execution_timestamp");
      await db.exec("DROP TABLE IF EXISTS adaptive_config CASCADE");
      await db.exec("DROP TABLE IF EXISTS workflow_pattern CASCADE");
      await db.exec("DROP TABLE IF EXISTS workflow_execution CASCADE");
      log.info("Migration 010 rolled back");
    },
  };
}
