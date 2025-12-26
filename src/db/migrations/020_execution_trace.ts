/**
 * Migration 020: Execution Trace Table
 *
 * Story 11.2: Creates persistence layer for execution traces.
 * Epic 11: Learning from Execution Traces (TD Error + PER + SHGAT).
 *
 * Changes:
 * 1. CREATE execution_trace table with learning-specific fields
 * 2. CREATE indexes for efficient queries (capability, timestamp, user, path, priority)
 * 3. MIGRATE data from workflow_execution (if exists and non-empty)
 *
 * Schema separates:
 * - Capability (workflow_pattern): static structure, immutable after creation
 * - Trace (execution_trace): execution data, created per run
 *
 * All operations are idempotent (IF NOT EXISTS / IF EXISTS).
 *
 * @module db/migrations/020_execution_trace
 */

import type { Migration } from "../migrations.ts";
import type { DbClient } from "../types.ts";
import * as log from "@std/log";

export function createExecutionTraceMigration(): Migration {
  return {
    version: 20,
    name: "execution_trace",
    up: async (db: DbClient) => {
      log.info("Migration 020: Creating execution_trace table...");

      // 1. Create execution_trace table (idempotent)
      await db.exec(`
        CREATE TABLE IF NOT EXISTS execution_trace (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          capability_id UUID REFERENCES workflow_pattern(pattern_id) ON DELETE SET NULL,
          intent_text TEXT,
          initial_context JSONB DEFAULT '{}',
          executed_at TIMESTAMPTZ DEFAULT NOW(),
          success BOOLEAN NOT NULL,
          duration_ms INTEGER NOT NULL,
          error_message TEXT,
          user_id TEXT DEFAULT 'local',
          created_by TEXT DEFAULT 'local',
          updated_by TEXT,
          executed_path TEXT[],
          decisions JSONB DEFAULT '[]',
          task_results JSONB DEFAULT '[]',
          priority FLOAT DEFAULT 0.5,
          parent_trace_id UUID REFERENCES execution_trace(id) ON DELETE SET NULL
        )
      `);
      log.info("  ✓ Created execution_trace table");

      // 2. Create indexes for efficient queries (idempotent)
      // Index for capability lookup
      await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_exec_trace_capability
        ON execution_trace(capability_id)
      `);
      log.debug("  ✓ Created idx_exec_trace_capability");

      // Index for time-based queries
      await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_exec_trace_timestamp
        ON execution_trace(executed_at DESC)
      `);
      log.debug("  ✓ Created idx_exec_trace_timestamp");

      // Index for user filtering (multi-tenancy)
      await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_exec_trace_user
        ON execution_trace(user_id)
      `);
      log.debug("  ✓ Created idx_exec_trace_user");

      // GIN index for path array queries
      await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_exec_trace_path
        ON execution_trace USING GIN(executed_path)
      `);
      log.debug("  ✓ Created idx_exec_trace_path (GIN)");

      // Composite index for priority-based sampling (PER)
      await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_exec_trace_priority
        ON execution_trace(capability_id, priority DESC)
      `);
      log.debug("  ✓ Created idx_exec_trace_priority");

      // Index for parent trace lookup (hierarchical traces)
      await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_exec_trace_parent
        ON execution_trace(parent_trace_id)
        WHERE parent_trace_id IS NOT NULL
      `);
      log.debug("  ✓ Created idx_exec_trace_parent");

      log.info("  ✓ Created all indexes");

      // 3. Migrate data from workflow_execution (conditional)
      try {
        // Check if workflow_execution exists and has data
        const hasData = await db.queryOne(`
          SELECT EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_name = 'workflow_execution'
          ) AS table_exists
        `);

        if (hasData?.table_exists) {
          // Check if execution_trace is empty and workflow_execution has data
          const counts = await db.queryOne(`
            SELECT
              (SELECT COUNT(*) FROM execution_trace) AS trace_count,
              (SELECT COUNT(*) FROM workflow_execution) AS exec_count
          `);

          const traceCount = counts?.trace_count as number || 0;
          const execCount = counts?.exec_count as number || 0;

          if (traceCount === 0 && execCount > 0) {
            // Migrate data from workflow_execution to execution_trace
            await db.exec(`
              INSERT INTO execution_trace (
                intent_text,
                executed_at,
                success,
                duration_ms,
                error_message,
                user_id,
                created_by,
                decisions,
                task_results,
                priority
              )
              SELECT
                intent_text,
                executed_at,
                success,
                execution_time_ms,
                error_message,
                COALESCE(user_id, 'local'),
                'migration',
                '[]'::jsonb,
                '[]'::jsonb,
                0.5
              FROM workflow_execution
            `);
            log.info(`  ✓ Migrated ${execCount} records from workflow_execution`);
          } else if (traceCount > 0) {
            log.info("  ○ Skipped migration: execution_trace already has data");
          } else {
            log.info("  ○ Skipped migration: workflow_execution is empty");
          }
        } else {
          log.info("  ○ Skipped migration: workflow_execution table not found");
        }
      } catch (error) {
        // Migration is optional - log warning and continue
        log.warn(`  ⚠ Data migration skipped: ${error}`);
      }

      // 4. Add comments for schema documentation
      try {
        await db.exec(`
          COMMENT ON TABLE execution_trace IS
            'Stores execution traces for learning (TD Error + PER). FK to workflow_pattern for capability.'
        `);
        await db.exec(`
          COMMENT ON COLUMN execution_trace.priority IS
            'PER priority: 0.0 = expected, 0.5 = cold start, 1.0 = surprising (high learning value).'
        `);
        await db.exec(`
          COMMENT ON COLUMN execution_trace.executed_path IS
            'Array of node IDs in execution order for path analysis.'
        `);
        await db.exec(`
          COMMENT ON COLUMN execution_trace.decisions IS
            'JSONB array of BranchDecision: nodeId, outcome, condition.'
        `);
        await db.exec(`
          COMMENT ON COLUMN execution_trace.task_results IS
            'JSONB array of TraceTaskResult: taskId, tool, args, result, success, durationMs.'
        `);
        await db.exec(`
          COMMENT ON COLUMN execution_trace.initial_context IS
            'JSONB of workflow input arguments (Epic 12 dependency).'
        `);
        log.debug("  ✓ Added table comments");
      } catch {
        // Comments are optional
      }

      log.info("✓ Migration 020 complete: execution_trace table created");
    },
    down: async (db: DbClient) => {
      log.info("Migration 020 rollback: Dropping execution_trace table...");

      // Drop indexes first (they'll be dropped with table, but explicit is cleaner)
      await db.exec("DROP INDEX IF EXISTS idx_exec_trace_parent");
      await db.exec("DROP INDEX IF EXISTS idx_exec_trace_priority");
      await db.exec("DROP INDEX IF EXISTS idx_exec_trace_path");
      await db.exec("DROP INDEX IF EXISTS idx_exec_trace_user");
      await db.exec("DROP INDEX IF EXISTS idx_exec_trace_timestamp");
      await db.exec("DROP INDEX IF EXISTS idx_exec_trace_capability");
      log.info("  ✓ Dropped indexes");

      // Drop table
      await db.exec("DROP TABLE IF EXISTS execution_trace CASCADE");
      log.info("  ✓ Dropped execution_trace table");

      log.info("Migration 020 rollback complete");
    },
  };
}
