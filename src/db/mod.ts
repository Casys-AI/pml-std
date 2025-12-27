/**
 * Database Module
 *
 * Provides dual-mode database support:
 * - Local mode: PGlite (embedded, zero config)
 * - Cloud mode: PostgreSQL (via DATABASE_URL)
 *
 * The mode is automatically detected based on DATABASE_URL env var.
 *
 * @module db
 */

import * as log from "@std/log";
import { createDefaultClient as createDefaultPGlite } from "./client.ts";
import { createPostgresClient, isCloudDatabase } from "./postgres-client.ts";

// Re-export types from types.ts (canonical source)
export type { DbClient, Row, Transaction } from "./types.ts";
import type { DbClient } from "./types.ts";

/**
 * Check if running in cloud mode (DATABASE_URL is set)
 */
export function isCloudMode(): boolean {
  return isCloudDatabase();
}

/**
 * Create a database client based on environment
 *
 * - DATABASE_URL set → PostgresClient (cloud mode)
 * - DATABASE_URL not set → PGliteClient (local mode)
 *
 * @returns Database client (call .connect() before use)
 */
export function createClient(): DbClient {
  if (isCloudDatabase()) {
    log.info("Database mode: Cloud (PostgreSQL)");
    return createPostgresClient();
  } else {
    log.info("Database mode: Local (PGlite)");
    return createDefaultPGlite();
  }
}

/**
 * Get a connected database client
 *
 * Creates and connects to the appropriate database based on environment.
 * Used by route handlers that need immediate database access.
 */
export async function getDb(): Promise<DbClient> {
  const client = createClient();
  await client.connect();
  return client;
}

// Legacy exports for backward compatibility
export { createDefaultClient } from "./client.ts";
export { PGliteClient } from "./client.ts";
export { PostgresClient } from "./postgres-client.ts";

// Migrations
export { getAllMigrations, MigrationRunner } from "./migrations.ts";

// Drizzle ORM integration
export { createDrizzleClient, runDrizzleMigrations } from "./drizzle.ts";
export type { DrizzleDB } from "./drizzle.ts";
