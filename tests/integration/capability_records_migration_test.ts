/**
 * Integration tests for capability_records migration (Story 13.1, Migration 028)
 *
 * Tests:
 * - Migration up/down idempotence (AC10)
 * - workflow_pattern data preservation (AC10)
 * - UUID primary key generation
 * - FQDN computation from components
 * - Scope resolution
 *
 * Note: capability_aliases table was removed in migration 028.
 *
 * @module tests/integration/capability_records_migration_test
 */

import { assert, assertEquals } from "@std/assert";
import { PGliteClient } from "../../src/db/client.ts";
import { getAllMigrations, MigrationRunner } from "../../src/db/migrations.ts";
import { CapabilityRegistry, getCapabilityFqdn } from "../../src/capabilities/capability-registry.ts";
import { createTestWorkflowPattern } from "../fixtures/test-helpers.ts";

// Test setup helper
async function setupTestDb(): Promise<PGliteClient> {
  const db = new PGliteClient(":memory:");
  await db.connect();
  return db;
}

// ============================================
// Migration Up/Down Idempotence Tests (AC10)
// ============================================

Deno.test("Migration 021 - idempotent up operation", async () => {
  const db = await setupTestDb();
  const runner = new MigrationRunner(db);
  const migrations = getAllMigrations();

  // Run all migrations
  await runner.runUp(migrations);

  // Verify capability_records table exists
  const tableCheck = await db.queryOne(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_name = 'capability_records'
    ) AS table_exists
  `);
  assertEquals(tableCheck?.table_exists, true);

  // Run again - should be idempotent
  await runner.runUp(migrations);

  // Table should still exist
  const tableCheck2 = await db.queryOne(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_name = 'capability_records'
    ) AS table_exists
  `);
  assertEquals(tableCheck2?.table_exists, true);

  await db.close();
});

Deno.test("Migration 028 - capability_aliases table dropped", async () => {
  const db = await setupTestDb();
  const runner = new MigrationRunner(db);
  const migrations = getAllMigrations();

  // Run all migrations including 028
  await runner.runUp(migrations);

  // Verify capability_aliases table does NOT exist (dropped in 028)
  const tableCheck = await db.queryOne(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_name = 'capability_aliases'
    ) AS table_exists
  `);
  assertEquals(tableCheck?.table_exists, false);

  await db.close();
});

Deno.test("Migration 028 - capability_records has UUID id column", async () => {
  const db = await setupTestDb();
  const runner = new MigrationRunner(db);
  const migrations = getAllMigrations();

  // Run all migrations
  await runner.runUp(migrations);

  // Verify id column is UUID type
  const columnCheck = await db.queryOne(`
    SELECT data_type
    FROM information_schema.columns
    WHERE table_name = 'capability_records' AND column_name = 'id'
  `);
  assertEquals(columnCheck?.data_type, "uuid");

  await db.close();
});

Deno.test("Migration 028 - display_name column dropped", async () => {
  const db = await setupTestDb();
  const runner = new MigrationRunner(db);
  const migrations = getAllMigrations();

  // Run all migrations
  await runner.runUp(migrations);

  // Verify display_name column does NOT exist
  const columnCheck = await db.queryOne(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'capability_records' AND column_name = 'display_name'
    ) AS column_exists
  `);
  assertEquals(columnCheck?.column_exists, false);

  await db.close();
});

// ============================================
// Workflow Pattern Preservation Tests (AC10)
// ============================================

Deno.test("Migration - preserves existing workflow_pattern data", async () => {
  const db = await setupTestDb();
  const runner = new MigrationRunner(db);
  const migrations = getAllMigrations();

  // Run migrations up to 020 (before capability_records)
  const migrationsUpTo20 = migrations.filter((m) => m.version <= 20);
  await runner.runUp(migrationsUpTo20);

  // Insert test data into workflow_pattern (using correct schema)
  // workflow_pattern requires: pattern_hash, dag_structure, intent_embedding
  // Create a proper 1024-dim zero vector for testing
  const zeroVector = Array(1024).fill(0).map(() => Math.random());

  await db.query(
    `
    INSERT INTO workflow_pattern (
      pattern_id, pattern_hash, dag_structure, intent_embedding,
      usage_count, success_rate, avg_duration_ms,
      name, description, code_snippet, code_hash
    ) VALUES (
      gen_random_uuid(), 'test_hash_001', '{"nodes":[],"edges":[]}'::jsonb, $1::vector,
      5, 0.9, 100,
      'test_pattern', 'A test pattern', 'const x = 1;', 'abcd1234'
    )
  `,
    [`[${zeroVector.join(",")}]`],
  );

  // Verify data exists
  const beforeMigration = await db.queryOne(`
    SELECT COUNT(*) as count FROM workflow_pattern
  `);
  assertEquals(beforeMigration?.count, 1);

  // Run all remaining migrations including 028
  await runner.runUp(migrations);

  // Verify workflow_pattern data is preserved
  const afterMigration = await db.queryOne(`
    SELECT COUNT(*) as count FROM workflow_pattern
  `);
  assertEquals(afterMigration?.count, 1);

  // Verify data content is unchanged
  const patternData = await db.queryOne(`
    SELECT name, description, usage_count FROM workflow_pattern
  `);
  assertEquals(patternData?.name, "test_pattern");
  assertEquals(patternData?.description, "A test pattern");
  assertEquals(patternData?.usage_count, 5);

  await db.close();
});

// ============================================
// UUID Primary Key Tests
// ============================================

Deno.test("Integration - UUID generated as primary key", async () => {
  const db = await setupTestDb();
  const runner = new MigrationRunner(db);
  await runner.runUp(getAllMigrations());

  const registry = new CapabilityRegistry(db);

  // Create workflow_pattern first
  const { patternId, hash } = await createTestWorkflowPattern(db, "test code");

  const record = await registry.create({
    org: "local",
    project: "default",
    namespace: "fs",
    action: "read_json",
    workflowPatternId: patternId,
    hash,
  });

  // ID should be a valid UUID (36 chars with hyphens)
  assertEquals(record.id.length, 36);
  assert(record.id.includes("-"), "ID should be a UUID with hyphens");

  // UUID format validation (8-4-4-4-12)
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  assert(uuidRegex.test(record.id), `ID should match UUID format: ${record.id}`);

  await db.close();
});

// ============================================
// FQDN Computation Tests
// ============================================

Deno.test("Integration - FQDN computed from components", async () => {
  const db = await setupTestDb();
  const runner = new MigrationRunner(db);
  await runner.runUp(getAllMigrations());

  const registry = new CapabilityRegistry(db);

  // Test various FQDN patterns
  const testCases = [
    { org: "local", project: "default", namespace: "fs", action: "read_json" },
    { org: "acme", project: "webapp", namespace: "api", action: "fetch_user" },
    { org: "my_org", project: "my-project", namespace: "data_api", action: "process-data" },
  ];

  for (const tc of testCases) {
    const { patternId, hash } = await createTestWorkflowPattern(db, `// ${tc.org}.${tc.project}`);

    const record = await registry.create({
      org: tc.org,
      project: tc.project,
      namespace: tc.namespace,
      action: tc.action,
      workflowPatternId: patternId,
      hash,
    });

    // Verify UUID is the id
    assertEquals(record.id.length, 36);

    // Verify FQDN is computed correctly
    const fqdn = getCapabilityFqdn(record);
    assert(fqdn.startsWith(`${tc.org}.${tc.project}.${tc.namespace}.${tc.action}.`));
    assertEquals(record.org, tc.org);
    assertEquals(record.project, tc.project);
    assertEquals(record.namespace, tc.namespace);
    assertEquals(record.action, tc.action);
    assertEquals(record.hash.length, 4);
  }

  await db.close();
});

// ============================================
// Scope Resolution Integration Tests
// ============================================

Deno.test("Integration - scope resolution priority", async () => {
  const db = await setupTestDb();
  const runner = new MigrationRunner(db);
  await runner.runUp(getAllMigrations());

  const registry = new CapabilityRegistry(db);

  // Create capabilities with same namespace:action in different scopes
  const localPattern = await createTestWorkflowPattern(db, "local code");
  const localCap = await registry.create({
    org: "acme",
    project: "webapp",
    namespace: "ns",
    action: "shared_action",
    workflowPatternId: localPattern.patternId,
    hash: localPattern.hash,
  });

  const publicPattern = await createTestWorkflowPattern(db, "public code");
  const publicCap = await registry.create({
    org: "marketplace",
    project: "public",
    namespace: "ns",
    action: "shared_action",
    workflowPatternId: publicPattern.patternId,
    hash: publicPattern.hash,
    visibility: "public",
  });

  // Resolution in acme.webapp should find local first
  const resolved1 = await registry.resolveByName(
    "ns:shared_action",
    { org: "acme", project: "webapp" },
  );
  assertEquals(resolved1?.id, localCap.id);

  // Resolution in other scope should find public
  const resolved2 = await registry.resolveByName(
    "ns:shared_action",
    { org: "other", project: "other" },
  );
  assertEquals(resolved2?.id, publicCap.id);

  await db.close();
});

// ============================================
// Unique Index Tests
// ============================================

Deno.test("Integration - unique index on FQDN components prevents duplicates", async () => {
  const db = await setupTestDb();
  const runner = new MigrationRunner(db);
  await runner.runUp(getAllMigrations());

  const registry = new CapabilityRegistry(db);

  // Create first capability
  const { patternId, hash } = await createTestWorkflowPattern(db, "code v1");

  const record1 = await registry.create({
    org: "local",
    project: "default",
    namespace: "ns",
    action: "action",
    workflowPatternId: patternId,
    hash,
  });

  // Create with same FQDN components - should update (ON CONFLICT)
  const record2 = await registry.create({
    org: "local",
    project: "default",
    namespace: "ns",
    action: "action",
    workflowPatternId: patternId,
    hash, // same hash = same FQDN
  });

  // Should be same UUID
  assertEquals(record1.id, record2.id);

  // Only one record should exist
  const count = await db.queryOne(`
    SELECT COUNT(*) as count FROM capability_records
    WHERE org = 'local' AND project = 'default' AND namespace = 'ns' AND action = 'action'
  `);
  assertEquals(count?.count, 1);

  await db.close();
});

// ============================================
// Index Verification Tests (AC2)
// ============================================

Deno.test("Migration 028 - indexes are created correctly", async () => {
  const db = await setupTestDb();
  const runner = new MigrationRunner(db);
  await runner.runUp(getAllMigrations());

  // Check indexes on capability_records
  const indexes = await db.query(`
    SELECT indexname FROM pg_indexes
    WHERE tablename = 'capability_records'
  `);

  const indexNames = indexes.map((r) => r.indexname as string);

  assert(indexNames.includes("idx_capability_records_scope"), "Missing scope index");
  assert(indexNames.includes("idx_capability_records_namespace"), "Missing namespace index");
  assert(indexNames.includes("idx_capability_records_creator"), "Missing creator index");
  assert(indexNames.includes("idx_capability_records_tags"), "Missing tags GIN index");
  assert(indexNames.includes("idx_capability_records_visibility"), "Missing visibility index");

  // Check unique index on FQDN components exists
  assert(
    indexNames.some((n) => n.includes("fqdn") || n.includes("org") || n.includes("capability_records_org")),
    "Missing FQDN unique index"
  );

  await db.close();
});
