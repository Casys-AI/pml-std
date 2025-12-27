/**
 * Integration tests for capability_records migration (Story 13.1)
 *
 * Tests:
 * - Migration up/down idempotence (AC10)
 * - workflow_pattern data preservation (AC10)
 * - FQDN generation with various inputs
 * - Scope resolution
 * - Alias chain prevention
 * - Concurrent alias creation
 *
 * @module tests/integration/capability_records_migration_test
 */

import { assert, assertEquals } from "@std/assert";
import { PGliteClient } from "../../src/db/client.ts";
import { getAllMigrations, MigrationRunner } from "../../src/db/migrations.ts";
import { CapabilityRegistry } from "../../src/capabilities/capability-registry.ts";

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

Deno.test("Migration 021 - up and down cycle", async () => {
  const db = await setupTestDb();
  const runner = new MigrationRunner(db);
  const migrations = getAllMigrations();

  // Run all migrations up
  await runner.runUp(migrations);

  // Verify tables exist
  let tableCheck = await db.queryOne(`
    SELECT
      (SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'capability_records')) AS records_exists,
      (SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'capability_aliases')) AS aliases_exists
  `);
  assertEquals(tableCheck?.records_exists, true);
  assertEquals(tableCheck?.aliases_exists, true);

  // Rollback to before migration 21
  await runner.rollbackTo(20, migrations);

  // Verify tables no longer exist
  tableCheck = await db.queryOne(`
    SELECT
      (SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'capability_records')) AS records_exists,
      (SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'capability_aliases')) AS aliases_exists
  `);
  assertEquals(tableCheck?.records_exists, false);
  assertEquals(tableCheck?.aliases_exists, false);

  // Run up again - should work
  await runner.runUp(migrations);

  // Tables should exist again
  tableCheck = await db.queryOne(`
    SELECT
      (SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'capability_records')) AS records_exists,
      (SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'capability_aliases')) AS aliases_exists
  `);
  assertEquals(tableCheck?.records_exists, true);
  assertEquals(tableCheck?.aliases_exists, true);

  await db.close();
});

// ============================================
// Workflow Pattern Preservation Tests (AC10)
// ============================================

Deno.test("Migration 021 - preserves existing workflow_pattern data", async () => {
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

  // Run migration 021
  const migration21 = migrations.filter((m) => m.version === 21);
  await runner.runUp(migration21);

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
// FQDN Generation Integration Tests
// ============================================

Deno.test("Integration - FQDN generation with various inputs", async () => {
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
    const record = await registry.create({
      displayName: `${tc.namespace}_${tc.action}`,
      org: tc.org,
      project: tc.project,
      namespace: tc.namespace,
      action: tc.action,
      codeSnippet: `// ${tc.org}.${tc.project}.${tc.namespace}.${tc.action}`,
    });

    // Verify FQDN format
    assert(record.id.startsWith(`${tc.org}.${tc.project}.${tc.namespace}.${tc.action}.`));
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

  // Create capabilities with same display name in different scopes
  const localCap = await registry.create({
    displayName: "shared_name",
    org: "acme",
    project: "webapp",
    namespace: "ns",
    action: "local_action",
    codeSnippet: "local code",
  });

  const publicCap = await registry.create({
    displayName: "shared_name",
    org: "marketplace",
    project: "public",
    namespace: "ns",
    action: "public_action",
    codeSnippet: "public code",
    visibility: "public",
  });

  // Resolution in acme.webapp should find local first
  const resolved1 = await registry.resolveByName(
    "shared_name",
    { org: "acme", project: "webapp" },
  );
  assertEquals(resolved1?.id, localCap.id);

  // Resolution in other scope should find public
  const resolved2 = await registry.resolveByName(
    "shared_name",
    { org: "other", project: "other" },
  );
  assertEquals(resolved2?.id, publicCap.id);

  await db.close();
});

// ============================================
// Alias Chain Prevention Integration Tests (AC9)
// ============================================

Deno.test("Integration - alias chain prevention scenario A->B->C", async () => {
  const db = await setupTestDb();
  const runner = new MigrationRunner(db);
  await runner.runUp(getAllMigrations());

  const registry = new CapabilityRegistry(db);

  // Create capability A (will be renamed to B, then to C)
  const capA = await registry.create({
    displayName: "capability_a",
    org: "local",
    project: "default",
    namespace: "ns",
    action: "original",
    codeSnippet: "original code",
  });

  // Create alias "old_name" pointing to A
  await registry.createAlias("local", "default", "old_name", capA.id);

  // Rename A to B (simulated by creating B and updating aliases)
  const capB = await registry.create({
    displayName: "capability_b",
    org: "local",
    project: "default",
    namespace: "ns",
    action: "renamed",
    codeSnippet: "renamed code",
  });

  // Update all aliases from A to point to B
  await registry.updateAliasChains(capA.id, capB.id);

  // Verify old_name now points to B
  let result = await registry.resolveByAlias("old_name", { org: "local", project: "default" });
  assertEquals(result?.record.id, capB.id);

  // Now rename B to C
  const capC = await registry.create({
    displayName: "capability_c",
    org: "local",
    project: "default",
    namespace: "ns",
    action: "final",
    codeSnippet: "final code",
  });

  // Update all aliases from B to point to C
  await registry.updateAliasChains(capB.id, capC.id);

  // Verify old_name now points DIRECTLY to C (no chain A->B->C)
  result = await registry.resolveByAlias("old_name", { org: "local", project: "default" });
  assertEquals(result?.record.id, capC.id);

  // Verify no alias chains exist (all aliases point directly to C)
  const aliases = await db.query(`
    SELECT alias, target_fqdn FROM capability_aliases
    WHERE org = 'local' AND project = 'default'
  `);

  for (const alias of aliases) {
    assertEquals(alias.target_fqdn, capC.id, `Alias ${alias.alias} should point to C`);
  }

  await db.close();
});

// ============================================
// Concurrent Alias Creation Tests
// ============================================

Deno.test("Integration - concurrent alias creation (upsert)", async () => {
  const db = await setupTestDb();
  const runner = new MigrationRunner(db);
  await runner.runUp(getAllMigrations());

  const registry = new CapabilityRegistry(db);

  // Create target capability
  const target = await registry.create({
    displayName: "target",
    org: "local",
    project: "default",
    namespace: "ns",
    action: "target",
    codeSnippet: "target code",
  });

  // Create another target for update test
  const target2 = await registry.create({
    displayName: "target2",
    org: "local",
    project: "default",
    namespace: "ns",
    action: "target2",
    codeSnippet: "target2 code",
  });

  // Create alias
  await registry.createAlias("local", "default", "my_alias", target.id);

  // Create same alias again (should update via upsert)
  await registry.createAlias("local", "default", "my_alias", target2.id);

  // Verify alias now points to target2
  const result = await registry.resolveByAlias("my_alias", { org: "local", project: "default" });
  assertEquals(result?.record.id, target2.id);

  // Verify only one alias exists
  const aliasCount = await db.queryOne(`
    SELECT COUNT(*) as count FROM capability_aliases
    WHERE org = 'local' AND project = 'default' AND alias = 'my_alias'
  `);
  assertEquals(aliasCount?.count, 1);

  await db.close();
});

Deno.test("Integration - multiple aliases same capability", async () => {
  const db = await setupTestDb();
  const runner = new MigrationRunner(db);
  await runner.runUp(getAllMigrations());

  const registry = new CapabilityRegistry(db);

  // Create capability
  const cap = await registry.create({
    displayName: "my_capability",
    org: "local",
    project: "default",
    namespace: "ns",
    action: "action",
    codeSnippet: "code",
  });

  // Create multiple aliases
  await registry.createAlias("local", "default", "alias1", cap.id);
  await registry.createAlias("local", "default", "alias2", cap.id);
  await registry.createAlias("local", "default", "alias3", cap.id);

  // Verify all aliases resolve to the same capability
  const result1 = await registry.resolveByAlias("alias1", { org: "local", project: "default" });
  const result2 = await registry.resolveByAlias("alias2", { org: "local", project: "default" });
  const result3 = await registry.resolveByAlias("alias3", { org: "local", project: "default" });

  assertEquals(result1?.record.id, cap.id);
  assertEquals(result2?.record.id, cap.id);
  assertEquals(result3?.record.id, cap.id);

  // Verify getAliases returns all
  const aliases = await registry.getAliases(cap.id);
  assertEquals(aliases.length, 3);

  await db.close();
});

// ============================================
// Index Verification Tests (AC2)
// ============================================

Deno.test("Migration 021 - indexes are created correctly", async () => {
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
  assert(indexNames.includes("idx_capability_records_name"), "Missing name index");
  assert(indexNames.includes("idx_capability_records_namespace"), "Missing namespace index");
  assert(indexNames.includes("idx_capability_records_creator"), "Missing creator index");
  assert(indexNames.includes("idx_capability_records_tags"), "Missing tags GIN index");
  assert(indexNames.includes("idx_capability_records_visibility"), "Missing visibility index");

  // Check indexes on capability_aliases
  const aliasIndexes = await db.query(`
    SELECT indexname FROM pg_indexes
    WHERE tablename = 'capability_aliases'
  `);

  const aliasIndexNames = aliasIndexes.map((r) => r.indexname as string);
  assert(aliasIndexNames.includes("idx_capability_aliases_target"), "Missing target index");

  await db.close();
});
