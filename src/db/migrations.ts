/**
 * Database Migration System
 *
 * Manages schema versioning and migration execution with up/down support.
 * Tracks applied migrations in a migrations_history table.
 *
 * @module db/migrations
 */

import type { DbClient } from "./types.ts";
import * as log from "@std/log";
import { DatabaseError } from "../errors/error-types.ts";
import { createErrorLoggingMigration } from "./migrations/003_error_logging.ts";
import { createMcpToolTablesMigration } from "./migrations/004_mcp_tool_tables.ts";
import { createWorkflowCheckpointsMigration } from "./migrations/006_workflow_checkpoints_migration.ts";
import { createEpisodicMemoryMigration } from "./migrations/007_episodic_memory_migration.ts";
import { createWorkflowDagsMigration } from "./migrations/008_workflow_dags_migration.ts";
import { createToolDependencySourceMigration } from "./migrations/009_tool_dependency_source_migration.ts";
import { createGraphRagTablesMigration } from "./migrations/010_graphrag_tables_migration.ts";
import { createCapabilityStorageMigration } from "./migrations/011_capability_storage_migration.ts";
import { createEdgeTypesMigration } from "./migrations/012_edge_types_migration.ts";
import { createUserIdWorkflowExecutionMigration } from "./migrations/013_user_id_workflow_execution.ts";
import { createAlgorithmTracesMigration } from "./migrations/014_algorithm_traces_migration.ts";
import { createCapabilityCommunityIdMigration } from "./migrations/015_capability_community_id.ts";
import { createCapabilityDependencyMigration } from "./migrations/016_capability_dependency.ts";
import { createPermissionInferenceMigration } from "./migrations/017_permission_inference.ts";
import { createPermissionAuditLogMigration } from "./migrations/018_permission_audit_log.ts";
import { createDbSchemaCleanupMigration } from "./migrations/019_db_schema_cleanup.ts";
import { createExecutionTraceMigration } from "./migrations/020_execution_trace.ts";
import { createCapabilityRecordsMigration } from "./migrations/021_capability_records.ts";
import { createUnifyCapabilityNamingMigration } from "./migrations/022_unify_capability_naming.ts";
import { createCapabilityRecordsFkMigration } from "./migrations/023_capability_records_fk.ts";
import { createErrorTypeColumnMigration } from "./migrations/024_error_type_column.ts";
import { createIntentEmbeddingColumnMigration } from "./migrations/025_intent_embedding_column.ts";
import { createAlgorithmNameColumnMigration } from "./migrations/026_algorithm_name_column.ts";
import { createSHGATParamsMigration } from "./migrations/027_shgat_params.ts";
import { createCapabilityUuidPkMigration } from "./migrations/028_capability_uuid_pk.ts";
import { createCapabilityHierarchyLevelMigration } from "./migrations/029_capability_hierarchy_level.ts";
import { createRemoveTraceIntentDuplicationMigration } from "./migrations/030_remove_trace_intent_duplication.ts";
import { createPmlRegistryViewMigration } from "./migrations/031_pml_registry_view.ts";
import { createWorkflowPatternCreatedByMigration } from "./migrations/033_workflow_pattern_created_by.ts";

/**
 * Migration definition
 */
export interface Migration {
  version: number;
  name: string;
  up: (db: DbClient) => Promise<void>;
  down: (db: DbClient) => Promise<void>;
}

/**
 * Applied migration record
 */
interface AppliedMigration {
  version: number;
  name: string;
  applied_at: string;
}

/**
 * Migration runner for managing schema versions
 */
export class MigrationRunner {
  private db: DbClient;

  constructor(db: DbClient) {
    this.db = db;
  }

  /**
   * Initialize migrations table
   */
  async init(): Promise<void> {
    try {
      await this.db.exec(
        `CREATE TABLE IF NOT EXISTS migrations_history (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TIMESTAMP DEFAULT NOW()
        );`,
      );
      log.debug("Migrations table initialized");
    } catch (error) {
      log.error(`Failed to initialize migrations table: ${error}`);
      throw error;
    }
  }

  /**
   * Get list of applied migrations
   */
  async getApplied(): Promise<AppliedMigration[]> {
    try {
      const rows = await this.db.query(
        "SELECT version, name, applied_at FROM migrations_history ORDER BY version ASC",
      );
      return rows.map((row) => ({
        version: row.version as number,
        name: row.name as string,
        applied_at: row.applied_at as string,
      }));
    } catch {
      // Table might not exist yet
      return [];
    }
  }

  /**
   * Run all pending migrations
   */
  async runUp(migrations: Migration[]): Promise<void> {
    await this.init();

    const applied = await this.getApplied();
    const appliedVersions = new Set(applied.map((m) => m.version));

    const pending = migrations.filter((m) => !appliedVersions.has(m.version));

    if (pending.length === 0) {
      log.info("No pending migrations");
      return;
    }

    const totalStart = performance.now();

    for (const migration of pending) {
      try {
        log.info(`Running migration ${migration.version}: ${migration.name}`);
        const migrationStart = performance.now();

        await this.db.transaction(async (tx) => {
          // Run the migration up script
          await migration.up(this.db);

          // Record the migration
          const query =
            `INSERT INTO migrations_history (version, name) VALUES (${migration.version}, '${migration.name}')`;
          await tx.exec(query);
        });

        const migrationTime = performance.now() - migrationStart;
        log.info(`✓ Migration ${migration.version} applied (${migrationTime.toFixed(1)}ms)`);
      } catch (error) {
        log.error(
          `✗ Migration ${migration.version} failed: ${error}`,
        );

        throw new DatabaseError(
          `Migration ${migration.version} (${migration.name}) failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          "migration",
        );
      }
    }

    const totalTime = performance.now() - totalStart;
    log.info(
      `All ${pending.length} migrations applied successfully (total: ${totalTime.toFixed(1)}ms)`,
    );
  }

  /**
   * Rollback migrations to a specific version
   */
  async rollbackTo(
    targetVersion: number,
    migrations: Migration[],
  ): Promise<void> {
    await this.init();

    const applied = await this.getApplied();
    const toRollback = applied
      .filter((m) => m.version > targetVersion)
      .reverse();

    if (toRollback.length === 0) {
      log.info("No migrations to rollback");
      return;
    }

    // Build version -> migration map
    const migrationMap = new Map(migrations.map((m) => [m.version, m]));

    for (const migration of toRollback) {
      const mig = migrationMap.get(migration.version);
      if (!mig) {
        throw new DatabaseError(
          `Migration ${migration.version} not found in migration list`,
          "rollback",
        );
      }

      try {
        log.info(`Rolling back migration ${mig.version}: ${mig.name}`);

        await this.db.transaction(async (tx) => {
          // Run the migration down script
          await mig.down(this.db);

          // Remove the migration record
          await tx.exec(
            `DELETE FROM migrations_history WHERE version = ${mig.version}`,
          );
        });

        log.info(`✓ Migration ${mig.version} rolled back`);
      } catch (error) {
        log.error(`✗ Migration ${mig.version} rollback failed: ${error}`);

        throw new DatabaseError(
          `Rollback of migration ${mig.version} (${mig.name}) failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          "rollback",
        );
      }
    }

    log.info(`Rolled back to version ${targetVersion}`);
  }

  /**
   * Get current schema version
   */
  async getCurrentVersion(): Promise<number> {
    try {
      const result = await this.db.queryOne(
        "SELECT MAX(version) as version FROM migrations_history",
      );
      return result?.version as number || 0;
    } catch {
      return 0;
    }
  }
}

/**
 * Load initial migration (001_initial.sql)
 */
export function createInitialMigration(): Migration {
  const initialSql = `
-- Migration 001: Initial Schema for Casys PML
-- Created: 2025-11-03
-- Purpose: Create tables for embeddings, schemas, and configuration

-- Tool schemas table: Cache of MCP tool definitions
CREATE TABLE IF NOT EXISTS tool_schema (
  tool_id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  input_schema JSONB NOT NULL,
  output_schema JSONB,
  cached_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tool embeddings table: BGE-Large-EN-v1.5 embeddings (1024 dimensions)
CREATE TABLE IF NOT EXISTS tool_embedding (
  tool_id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  embedding vector(1024) NOT NULL,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

-- HNSW index for fast vector similarity search
-- Parameters: m=16 (number of connections), ef_construction=64 (construction parameter)
-- Operator: vector_cosine_ops (cosine distance metric)
CREATE INDEX IF NOT EXISTS idx_tool_embedding_hnsw
ON tool_embedding
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- Configuration key-value store
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Tool dependencies table: Track relationships between tools for GraphRAG
CREATE TABLE IF NOT EXISTS tool_dependency (
  from_tool_id TEXT NOT NULL,
  to_tool_id TEXT NOT NULL,
  observed_count INTEGER DEFAULT 1,
  confidence_score REAL DEFAULT 0.5,
  last_observed TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (from_tool_id, to_tool_id)
);

-- Indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_tool_schema_server_id ON tool_schema(server_id);
CREATE INDEX IF NOT EXISTS idx_tool_embedding_server_id ON tool_embedding(server_id);
CREATE INDEX IF NOT EXISTS idx_tool_dependency_from ON tool_dependency(from_tool_id);
CREATE INDEX IF NOT EXISTS idx_tool_dependency_to ON tool_dependency(to_tool_id);
CREATE INDEX IF NOT EXISTS idx_tool_dependency_confidence ON tool_dependency(confidence_score);
`;

  return {
    version: 1,
    name: "initial_schema",
    up: async (db: DbClient) => {
      // Remove SQL comments first (both -- and /* */ style)
      const sqlWithoutComments = initialSql
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .replace(/\/\*[\s\S]*?\*\//g, ""); // Remove /* */ comments

      // Split by semicolons and execute each statement
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
    },
    down: async (db: DbClient) => {
      // Drop tables in reverse order (respecting foreign keys)
      await db.exec("DROP TABLE IF EXISTS tool_dependency CASCADE;");
      await db.exec("DROP TABLE IF EXISTS config CASCADE;");
      await db.exec("DROP TABLE IF EXISTS tool_embedding CASCADE;");
      await db.exec("DROP TABLE IF EXISTS tool_schema CASCADE;");
    },
  };
}

/**
 * Load telemetry migration (002_telemetry_logging)
 */
export function createTelemetryMigration(): Migration {
  const telemetrySql = `
-- Metrics table for telemetry tracking
-- Uses IF NOT EXISTS to avoid conflicts with existing table
CREATE TABLE IF NOT EXISTS metrics (
  id SERIAL PRIMARY KEY,
  metric_name TEXT NOT NULL,
  value REAL NOT NULL,
  metadata JSONB,
  timestamp TIMESTAMP DEFAULT NOW()
);

-- Index for efficient metric queries by name and time
CREATE INDEX IF NOT EXISTS idx_metrics_name_timestamp
ON metrics (metric_name, timestamp DESC);
`;

  return {
    version: 2,
    name: "telemetry_logging",
    up: async (db: DbClient) => {
      // Remove SQL comments first (both -- and /* */ style)
      const sqlWithoutComments = telemetrySql
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .replace(/\/\*[\s\S]*?\*\//g, ""); // Remove /* */ comments

      // Split by semicolons and execute each statement
      const statements = sqlWithoutComments
        .split(";")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      for (const statement of statements) {
        try {
          await db.exec(statement);
        } catch (error) {
          // If table already exists, that's okay - log and continue
          if (error instanceof Error && error.message.includes("already exists")) {
            log.warn(`Table or index already exists (expected): ${error.message}`);
          } else {
            throw error;
          }
        }
      }
    },
    down: async (db: DbClient) => {
      // Don't drop metrics table in down migration as it may be used by other features
      // Just drop our index if it exists
      await db.exec("DROP INDEX IF EXISTS idx_metrics_name_timestamp;");
    },
  };
}

/**
 * Get all migrations in order
 */
export function getAllMigrations(): Migration[] {
  return [
    createInitialMigration(),
    createTelemetryMigration(),
    createErrorLoggingMigration(),
    createMcpToolTablesMigration(),
    createWorkflowCheckpointsMigration(),
    createEpisodicMemoryMigration(),
    createWorkflowDagsMigration(),
    createToolDependencySourceMigration(),
    createGraphRagTablesMigration(),
    createCapabilityStorageMigration(),
    createEdgeTypesMigration(), // ADR-041: Hierarchical trace tracking
    createUserIdWorkflowExecutionMigration(), // Story 9.5: Multi-tenant data isolation
    createAlgorithmTracesMigration(), // Story 7.6 - ADR-039: Algorithm observability
    createCapabilityCommunityIdMigration(), // Story 8.1: Capability community clustering
    createCapabilityDependencyMigration(), // Tech-spec: Capability-to-capability dependencies
    createPermissionInferenceMigration(), // Story 7.7a: Permission inference (ADR-035)
    createPermissionAuditLogMigration(), // Story 7.7c: HIL permission escalation audit log
    createDbSchemaCleanupMigration(), // Story 11.0: DB cleanup - drop workflow_dags, mcp_tool, mcp_server
    createExecutionTraceMigration(), // Story 11.2: Execution trace table (TD Error + PER)
    createCapabilityRecordsMigration(), // Story 13.1: Capability records & aliases (Epic 13)
    createUnifyCapabilityNamingMigration(), // Story 13.2: Unify naming (remove workflow_pattern.name)
    createCapabilityRecordsFkMigration(), // Story 13.2 fix: Add FK, remove duplicated columns
    createErrorTypeColumnMigration(), // SHGAT v2: errorTypeAffinity feature
    createIntentEmbeddingColumnMigration(), // SHGAT v2: intentSimilarSuccessRate feature
    createAlgorithmNameColumnMigration(), // Story 7.6+: Algorithm name for tracing
    createSHGATParamsMigration(), // Story 10.7b: SHGAT weights persistence
    createCapabilityUuidPkMigration(), // Epic 13 refactor: UUID PK, drop display_name & aliases
    createCapabilityHierarchyLevelMigration(), // Story 10.1: Capability hierarchy level for compound nodes
    createRemoveTraceIntentDuplicationMigration(), // Story 11.x: Remove intent duplication, use JOIN
    createPmlRegistryViewMigration(), // Story 13.8: Unified pml_registry VIEW (tool_schema + capability_records)
    createWorkflowPatternCreatedByMigration(), // Story 9.8: Add created_by for user filtering
  ];
}
