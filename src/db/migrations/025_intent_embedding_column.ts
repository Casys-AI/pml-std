/**
 * Migration 025: Intent Embedding Column for execution_trace
 *
 * Story 11.x: Adds intent_embedding for intentSimilarSuccessRate feature in SHGAT v2.
 * Enables semantic similarity search across execution traces.
 *
 * Changes:
 * 1. ADD intent_embedding vector(1024) column to execution_trace
 * 2. CREATE HNSW index for fast similarity search
 *
 * This enables queryIntentSimilarSuccessRate() in trace-feature-extractor.ts
 * to find traces with similar intents and compute success rates.
 *
 * @module db/migrations/025_intent_embedding_column
 */

import type { Migration } from "../migrations.ts";
import type { DbClient } from "../types.ts";
import * as log from "@std/log";

export function createIntentEmbeddingColumnMigration(): Migration {
  return {
    version: 25,
    name: "intent_embedding_column",
    up: async (db: DbClient) => {
      log.info("Migration 025: Adding intent_embedding column to execution_trace...");

      // 1. Add intent_embedding column (nullable, populated on new traces)
      try {
        await db.exec(`
          ALTER TABLE execution_trace
          ADD COLUMN IF NOT EXISTS intent_embedding vector(1024)
        `);
        log.info("  ✓ Added intent_embedding column");
      } catch (error) {
        if (String(error).includes("already exists")) {
          log.info("  ○ intent_embedding column already exists");
        } else {
          throw error;
        }
      }

      // 2. Create HNSW index for fast similarity search
      // Same parameters as tool_embedding index for consistency
      await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_exec_trace_intent_embedding
        ON execution_trace
        USING hnsw (intent_embedding vector_cosine_ops)
        WITH (m = 16, ef_construction = 64)
      `);
      log.info("  ✓ Created idx_exec_trace_intent_embedding (HNSW)");

      // 3. Add comment for documentation
      try {
        await db.exec(`
          COMMENT ON COLUMN execution_trace.intent_embedding IS
            'BGE-M3 1024D embedding of intent_text for similarity search. For SHGAT v2 intentSimilarSuccessRate.'
        `);
      } catch {
        // Comments are optional
      }

      log.info("✓ Migration 025 complete: intent_embedding column added");
    },
    down: async (db: DbClient) => {
      log.info("Migration 025 rollback: Removing intent_embedding column...");

      await db.exec("DROP INDEX IF EXISTS idx_exec_trace_intent_embedding");
      log.info("  ✓ Dropped idx_exec_trace_intent_embedding");

      await db.exec("ALTER TABLE execution_trace DROP COLUMN IF EXISTS intent_embedding");
      log.info("  ✓ Dropped intent_embedding column");

      log.info("Migration 025 rollback complete");
    },
  };
}
