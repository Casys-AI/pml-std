#!/usr/bin/env -S deno run --allow-all
/**
 * Database Cleanup Script
 *
 * Cleans capability and trace data while preserving:
 * - Schema (migrations)
 * - MCP tool definitions (tool_schema)
 *
 * Usage:
 *   deno task cleanup-db          # Dry run (shows what will be deleted)
 *   deno task cleanup-db --execute # Actually delete
 *
 * By default uses DATABASE_URL (PostgreSQL) if set, otherwise PGlite.
 * Use --pglite to force PGlite even when DATABASE_URL is set.
 */

import "@std/dotenv/load";
import { getDb } from "../src/db/client.ts";
import { createPostgresClient, isCloudDatabase } from "../src/db/postgres-client.ts";
import type { DbClient } from "../src/db/types.ts";

const EXECUTE = Deno.args.includes("--execute");
const FORCE_PGLITE = Deno.args.includes("--pglite");

async function main() {
  let db: DbClient;
  let dbType: string;

  // Use PostgreSQL if DATABASE_URL is set (unless --pglite is specified)
  if (isCloudDatabase() && !FORCE_PGLITE) {
    const pgClient = createPostgresClient();
    await pgClient.connect();
    db = pgClient;
    dbType = "PostgreSQL";
  } else {
    db = await getDb();
    dbType = "PGlite";
  }

  console.log("╔════════════════════════════════════════╗");
  console.log("║     Database Cleanup Script            ║");
  console.log("╚════════════════════════════════════════╝\n");
  console.log(`📦 Target: ${dbType}\n`);

  // Tables to clean (order matters for FK constraints)
  const tablesToClean = [
    "capability_dependency",
    "execution_trace",
    "workflow_execution",
    "capability_records",
    "workflow_pattern",
    "algorithm_traces",
    "entropy_history",
  ];

  // Get current counts
  console.log("📊 Current state:\n");
  for (const table of tablesToClean) {
    try {
      const result = await db.query(`SELECT COUNT(*) as count FROM ${table}`);
      const count = result[0]?.count ?? 0;
      console.log(`   ${table}: ${count} rows`);
    } catch {
      console.log(`   ${table}: (table doesn't exist)`);
    }
  }

  // Check tool_schema (will be kept)
  try {
    const toolCount = await db.query(`SELECT COUNT(*) as count FROM tool_schema`);
    console.log(`\n   tool_schema: ${toolCount[0]?.count ?? 0} rows (KEPT)`);
  } catch {
    console.log(`\n   tool_schema: (table doesn't exist)`);
  }

  if (!EXECUTE) {
    console.log("\n⚠️  DRY RUN - No changes made");
    console.log("   Run with --execute to actually clean the database\n");
    console.log("   Example: deno task cleanup-db --execute\n");
    await db.close();
    return;
  }

  console.log("\n🧹 Cleaning tables...\n");

  // Use TRUNCATE CASCADE for PostgreSQL (faster, handles FK), DELETE for PGlite
  const usesTruncate = dbType === "PostgreSQL";

  for (const table of tablesToClean) {
    try {
      if (usesTruncate) {
        await db.query(`TRUNCATE TABLE ${table} CASCADE`);
      } else {
        await db.query(`DELETE FROM ${table}`);
      }
      console.log(`   ✓ ${table} cleaned`);
    } catch (e) {
      console.log(`   ⚠ ${table}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Verify cleanup
  console.log("\n📊 After cleanup:\n");
  for (const table of tablesToClean) {
    try {
      const result = await db.query(`SELECT COUNT(*) as count FROM ${table}`);
      const count = result[0]?.count ?? 0;
      console.log(`   ${table}: ${count} rows`);
    } catch {
      // Skip
    }
  }

  console.log("\n✅ Cleanup complete!");
  console.log("   - Schema preserved");
  console.log("   - tool_schema preserved");
  console.log("   - Ready for fresh capability learning\n");

  await db.close();
}

main().catch(console.error);
