/**
 * Drizzle ORM Client for PGlite and PostgreSQL
 *
 * Wraps database instances with Drizzle ORM.
 * Used for Epic 9+ tables (users, sessions, etc.)
 * Coexists with manual migrations for legacy tables.
 *
 * Supports dual-mode:
 * - Local: PGlite (drizzle-orm/pglite)
 * - Cloud: PostgreSQL (drizzle-orm/postgres-js)
 *
 * @module db/drizzle
 */

import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { migrate as migratePostgres } from "drizzle-orm/postgres-js/migrator";
import type { PGlite } from "@electric-sql/pglite";
import type { Sql } from "postgres";
import * as schema from "./schema/mod.ts";
import { resolvePath } from "../lib/paths.ts";
import * as log from "@std/log";

export type DrizzleDB = ReturnType<typeof drizzlePglite<typeof schema>>;
export type DrizzlePostgresDB = ReturnType<typeof drizzlePostgres<typeof schema>>;

/**
 * Create a Drizzle client instance from a PGlite connection
 * @param client PGlite client instance
 * @returns Drizzle database instance
 */
export function createDrizzleClient(client: PGlite): DrizzleDB {
  // Type cast needed due to private member mismatch between PGlite versions
  // deno-lint-ignore no-explicit-any
  return drizzlePglite(client as any, { schema });
}

/**
 * Create a Drizzle client instance from a PostgreSQL connection
 * @param client postgres.js client instance
 * @returns Drizzle database instance
 */
export function createDrizzlePostgresClient(client: Sql): DrizzlePostgresDB {
  return drizzlePostgres(client, { schema });
}

/**
 * Run Drizzle migrations for PGlite
 * Safe to run multiple times (idempotent)
 * @param db Drizzle database instance
 */
export async function runDrizzleMigrations(db: DrizzleDB): Promise<void> {
  await migratePglite(db, { migrationsFolder: resolvePath("./drizzle") });
}

/**
 * Run Drizzle migrations for PostgreSQL
 * Safe to run multiple times (idempotent)
 * @param db Drizzle PostgreSQL database instance
 */
export async function runDrizzlePostgresMigrations(db: DrizzlePostgresDB): Promise<void> {
  log.info("[Drizzle] Running PostgreSQL migrations...");
  await migratePostgres(db, { migrationsFolder: resolvePath("./drizzle") });
  log.info("[Drizzle] PostgreSQL migrations complete");
}

/**
 * Run Drizzle migrations based on environment (auto-detect mode)
 * Creates a temporary Drizzle client, runs migrations, then closes.
 * Safe to run multiple times (idempotent)
 */
export async function runDrizzleMigrationsAuto(): Promise<void> {
  const { isCloudDatabase } = await import("./postgres-client.ts");

  if (isCloudDatabase()) {
    // Cloud mode: PostgreSQL
    const databaseUrl = Deno.env.get("DATABASE_URL");
    if (!databaseUrl) {
      throw new Error("DATABASE_URL required for cloud mode");
    }

    const { default: postgres } = await import("postgres");
    const sql = postgres(databaseUrl, { max: 1 });

    try {
      const db = createDrizzlePostgresClient(sql);
      await runDrizzlePostgresMigrations(db);
    } finally {
      await sql.end();
    }
  } else {
    // Local mode: PGlite - migrations run via getDb() in auth/db.ts
    log.debug("[Drizzle] Local mode - PGlite migrations handled by auth/db.ts");
  }
}
