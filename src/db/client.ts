/**
 * PGlite Database Client
 *
 * Provides a wrapper around PGlite for managing embeddings, schemas, and configurations.
 * Includes support for migrations and transaction management.
 *
 * @module db/client
 */

import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import * as log from "@std/log";
import { ensureDir } from "@std/fs";
import { getAgentCardsDatabasePath } from "../cli/utils.ts";
import type { DbClient, Row, Transaction } from "./types.ts";

// Re-export types for backward compatibility
export type { DbClient, Row, Transaction } from "./types.ts";

/**
 * PGlite client wrapper with transaction support and logging
 *
 * Implements DbClient interface for compatibility with PostgresClient.
 */
export class PGliteClient implements DbClient {
  private db: PGlite | null = null;
  private dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  /**
   * Initialize and connect to the database
   * Creates ~/.pml/ directory if it doesn't exist
   * Initializes PGlite with pgvector extension
   */
  async connect(): Promise<void> {
    try {
      // Normalize :memory: (SQLite convention) to memory:// (PGlite convention)
      let normalizedPath = this.dbPath;
      if (this.dbPath === ":memory:") {
        normalizedPath = "memory://";
      }

      // Ensure directory exists (skip for memory databases)
      if (!normalizedPath.startsWith("memory://")) {
        const dir = normalizedPath.substring(0, normalizedPath.lastIndexOf("/"));
        if (dir && dir.length > 0) {
          await ensureDir(dir);
        }
      }

      // Initialize PGlite with pgvector extension
      this.db = new PGlite(normalizedPath, {
        extensions: { vector },
      });

      // Load pgvector extension
      await this.db.exec("CREATE EXTENSION IF NOT EXISTS vector;");

      log.info(`Database connected: ${this.dbPath}`);
    } catch (error) {
      log.error(`Failed to connect to database: ${error}`);
      throw error;
    }
  }

  /**
   * Execute SQL statement without returning results
   */
  async exec(sql: string, params?: unknown[]): Promise<void> {
    if (!this.db) {
      throw new Error("Database not connected");
    }
    try {
      if (params && params.length > 0) {
        // PGlite exec doesn't support params directly, use query instead for parameterized execution
        await (this.db as any).exec(sql, params as any);
      } else {
        await this.db.exec(sql);
      }
    } catch (error) {
      log.error(`SQL execution failed: ${error}`);
      throw error;
    }
  }

  /**
   * Execute query and return results
   */
  async query(sql: string, params?: unknown[]): Promise<Row[]> {
    if (!this.db) {
      throw new Error("Database not connected");
    }
    try {
      const result = params && params.length > 0
        ? await (this.db as any).query(sql, params)
        : await (this.db as any).query(sql);
      return result.rows as Row[];
    } catch (error) {
      log.error(`SQL query failed: ${error}`);
      throw error;
    }
  }

  /**
   * Execute single row query, returns first row or null
   */
  async queryOne(sql: string, params?: unknown[]): Promise<Row | null> {
    const rows = await this.query(sql, params);
    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * Run a transaction
   */
  async transaction<T>(
    fn: (tx: Transaction) => Promise<T>,
  ): Promise<T> {
    if (!this.db) {
      throw new Error("Database not connected");
    }

    try {
      await this.exec("BEGIN TRANSACTION;");

      const tx: Transaction = {
        exec: (sql: string, params?: unknown[]) => this.exec(sql, params),
        query: (sql: string, params?: unknown[]) => this.query(sql, params),
      };

      const result = await fn(tx);
      await this.exec("COMMIT;");
      return result;
    } catch (error) {
      await this.exec("ROLLBACK;");
      log.error(`Transaction failed: ${error}`);
      throw error;
    }
  }

  /**
   * Close database connection
   */
  async close(): Promise<void> {
    if (this.db) {
      try {
        await this.db.close();
      } catch (error) {
        log.error(`Error closing database: ${error}`);
      }
      this.db = null;
      log.info("Database connection closed");
    }
  }

  /**
   * Get database statistics
   */
  async stats(): Promise<{ tables: number; size: string }> {
    const tables = await this.query(
      "SELECT COUNT(*) as count FROM information_schema.tables WHERE table_schema = 'public'",
    );

    return {
      tables: tables[0]?.count as number || 0,
      size: "unknown", // PGlite doesn't expose file size via SQL
    };
  }
}

/**
 * Create a database client with explicit path
 *
 * @param path - Database path. Use ":memory:" for in-memory database.
 * @returns PGliteClient instance (call .connect() before use)
 *
 * @example
 * // In-memory database (for tests/playground)
 * const db = createClient(":memory:");
 *
 * @example
 * // Custom path
 * const db = createClient("/data/my-app.db");
 */
export function createClient(path: string): PGliteClient {
  return new PGliteClient(path);
}

/**
 * Create a database client with default path
 *
 * Uses AGENTCARDS_DB_PATH env variable or falls back to ~/.pml/.pml.db
 *
 * @returns PGliteClient instance (call .connect() before use)
 *
 * @example
 * const db = createDefaultClient();
 * await db.connect();
 */
export function createDefaultClient(): PGliteClient {
  return createClient(getAgentCardsDatabasePath());
}

/**
 * Get a connected database client
 *
 * Creates and connects to the default database.
 * Used by route handlers that need immediate database access.
 */
export async function getDb(): Promise<PGliteClient> {
  const client = createDefaultClient();
  await client.connect();
  return client;
}
