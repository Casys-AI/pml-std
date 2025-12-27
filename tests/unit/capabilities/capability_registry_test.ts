/**
 * Unit tests for CapabilityRegistry (Story 13.1)
 *
 * Tests name resolution, alias handling, and chain prevention.
 *
 * @module tests/unit/capabilities/capability_registry_test
 */

import { assertEquals, assert, assertRejects } from "@std/assert";
import { CapabilityRegistry } from "../../../src/capabilities/capability-registry.ts";
import { PGliteClient } from "../../../src/db/client.ts";
import { MigrationRunner, getAllMigrations } from "../../../src/db/migrations.ts";
import { createTestWorkflowPattern } from "../../fixtures/test-helpers.ts";

// Test setup helper
async function setupTestDb(): Promise<PGliteClient> {
  const db = new PGliteClient(":memory:");
  await db.connect();

  // Run migrations
  const runner = new MigrationRunner(db);
  await runner.runUp(getAllMigrations());

  return db;
}

// ============================================
// Create Tests (AC4)
// ============================================

Deno.test("CapabilityRegistry.create - creates record with FQDN", async () => {
  const db = await setupTestDb();
  const registry = new CapabilityRegistry(db);

  // First create workflow_pattern (architecture: code lives there)
  const code = "export function readJson(path) { return JSON.parse(Deno.readTextFileSync(path)); }";
  const { patternId, hash } = await createTestWorkflowPattern(db, code);

  const record = await registry.create({
    displayName: "read_json",
    org: "local",
    project: "default",
    namespace: "fs",
    action: "read_json",
    workflowPatternId: patternId,
    hash,
  });

  // FQDN should be generated
  assert(record.id.startsWith("local.default.fs.read_json."));
  assertEquals(record.id.length, "local.default.fs.read_json.".length + 4);

  // Fields should be set correctly
  assertEquals(record.displayName, "read_json");
  assertEquals(record.org, "local");
  assertEquals(record.project, "default");
  assertEquals(record.namespace, "fs");
  assertEquals(record.action, "read_json");
  assertEquals(record.hash.length, 4);
  assertEquals(record.hash, hash);
  assertEquals(record.visibility, "private");
  assertEquals(record.routing, "local");
  assertEquals(record.version, 1);
  assertEquals(record.verified, false);
  assertEquals(record.usageCount, 0);
  assertEquals(record.successCount, 0);

  await db.close();
});

Deno.test("CapabilityRegistry.create - rejects invalid display name", async () => {
  const db = await setupTestDb();
  const registry = new CapabilityRegistry(db);

  // Validation happens before DB access, so dummy values are fine
  await assertRejects(
    () => registry.create({
      displayName: "my function", // has space - invalid
      org: "local",
      project: "default",
      namespace: "fs",
      action: "read",
      workflowPatternId: "dummy-pattern-id",
      hash: "abcd",
    }),
    Error,
    "Invalid display name"
  );

  await db.close();
});

Deno.test("CapabilityRegistry.create - rejects invalid org (starts with number)", async () => {
  const db = await setupTestDb();
  const registry = new CapabilityRegistry(db);

  // Validation happens before DB access, so dummy values are fine
  await assertRejects(
    () => registry.create({
      displayName: "valid_name",
      org: "123invalid", // starts with number - invalid
      project: "default",
      namespace: "fs",
      action: "read",
      workflowPatternId: "dummy-pattern-id",
      hash: "abcd",
    }),
    Error,
    "Invalid org component"
  );

  await db.close();
});

Deno.test("CapabilityRegistry.create - rejects invalid namespace (has dot)", async () => {
  const db = await setupTestDb();
  const registry = new CapabilityRegistry(db);

  // Validation happens before DB access, so dummy values are fine
  await assertRejects(
    () => registry.create({
      displayName: "valid_name",
      org: "local",
      project: "default",
      namespace: "fs.sub", // has dot - invalid
      action: "read",
      workflowPatternId: "dummy-pattern-id",
      hash: "abcd",
    }),
    Error,
    "Invalid namespace component"
  );

  await db.close();
});

Deno.test("CapabilityRegistry.create - updates existing on conflict", async () => {
  const db = await setupTestDb();
  const registry = new CapabilityRegistry(db);

  // Create workflow_pattern first (architecture: code lives there)
  const { patternId, hash } = await createTestWorkflowPattern(db, "v1");

  // Create first record
  const record1 = await registry.create({
    displayName: "read_json",
    org: "local",
    project: "default",
    namespace: "fs",
    action: "read",
    workflowPatternId: patternId,
    hash,
  });

  // Create with same hash - should update (same FQDN)
  const record2 = await registry.create({
    displayName: "read_json_v2",
    org: "local",
    project: "default",
    namespace: "fs",
    action: "read",
    workflowPatternId: patternId,
    hash, // same hash = same FQDN
  });

  // Should be same FQDN (same hash)
  assertEquals(record1.id, record2.id);

  // Fetch and verify update
  const fetched = await registry.getByFqdn(record2.id);
  assertEquals(fetched?.displayName, "read_json_v2");
  assertEquals(fetched?.version, 2); // version incremented

  await db.close();
});

// ============================================
// Scope Resolution Tests (AC7)
// ============================================

Deno.test("CapabilityRegistry.resolveByName - finds by display name in scope", async () => {
  const db = await setupTestDb();
  const registry = new CapabilityRegistry(db);

  // Create workflow_pattern first
  const { patternId, hash } = await createTestWorkflowPattern(db, "code");

  // Create a capability
  const created = await registry.create({
    displayName: "my_reader",
    org: "acme",
    project: "webapp",
    namespace: "fs",
    action: "read",
    workflowPatternId: patternId,
    hash,
  });

  // Resolve in same scope
  const resolved = await registry.resolveByName(
    "my_reader",
    { org: "acme", project: "webapp" }
  );

  assertEquals(resolved?.id, created.id);

  await db.close();
});

Deno.test("CapabilityRegistry.resolveByName - returns null for wrong scope", async () => {
  const db = await setupTestDb();
  const registry = new CapabilityRegistry(db);

  // Create workflow_pattern first
  const { patternId, hash } = await createTestWorkflowPattern(db, "code");

  // Create a capability
  await registry.create({
    displayName: "my_reader",
    org: "acme",
    project: "webapp",
    namespace: "fs",
    action: "read",
    workflowPatternId: patternId,
    hash,
  });

  // Try to resolve in different scope
  const resolved = await registry.resolveByName(
    "my_reader",
    { org: "other", project: "project" }
  );

  assertEquals(resolved, null);

  await db.close();
});

Deno.test("CapabilityRegistry.resolveByName - finds public capability", async () => {
  const db = await setupTestDb();
  const registry = new CapabilityRegistry(db);

  // Create workflow_pattern first
  const { patternId, hash } = await createTestWorkflowPattern(db, "code");

  // Create a public capability
  const created = await registry.create({
    displayName: "public_util",
    org: "marketplace",
    project: "public",
    namespace: "util",
    action: "format",
    workflowPatternId: patternId,
    hash,
    visibility: "public",
  });

  // Resolve from different scope
  const resolved = await registry.resolveByName(
    "public_util",
    { org: "acme", project: "webapp" }
  );

  assertEquals(resolved?.id, created.id);

  await db.close();
});

// ============================================
// Alias Resolution Tests (AC8)
// ============================================

Deno.test("CapabilityRegistry.resolveByAlias - resolves via alias", async () => {
  const db = await setupTestDb();
  const registry = new CapabilityRegistry(db);

  // Create workflow_pattern first
  const { patternId, hash } = await createTestWorkflowPattern(db, "code");

  // Create capability
  const created = await registry.create({
    displayName: "new_reader",
    org: "acme",
    project: "webapp",
    namespace: "fs",
    action: "read",
    workflowPatternId: patternId,
    hash,
  });

  // Create alias for old name
  await registry.createAlias("acme", "webapp", "old_reader", created.id);

  // Resolve via alias
  const result = await registry.resolveByAlias(
    "old_reader",
    { org: "acme", project: "webapp" }
  );

  assert(result !== null);
  assertEquals(result.record.id, created.id);
  assertEquals(result.isAlias, true);
  assertEquals(result.usedAlias, "old_reader");

  await db.close();
});

Deno.test("CapabilityRegistry.resolveByAlias - returns null for non-existent alias", async () => {
  const db = await setupTestDb();
  const registry = new CapabilityRegistry(db);

  const result = await registry.resolveByAlias(
    "non_existent",
    { org: "acme", project: "webapp" }
  );

  assertEquals(result, null);

  await db.close();
});

Deno.test("CapabilityRegistry.resolveByName - falls back to alias", async () => {
  const db = await setupTestDb();
  const registry = new CapabilityRegistry(db);

  // Create workflow_pattern first
  const { patternId, hash } = await createTestWorkflowPattern(db, "code");

  // Create capability
  const created = await registry.create({
    displayName: "current_name",
    org: "acme",
    project: "webapp",
    namespace: "fs",
    action: "read",
    workflowPatternId: patternId,
    hash,
  });

  // Create alias
  await registry.createAlias("acme", "webapp", "legacy_name", created.id);

  // resolveByName should find via alias when display name doesn't match
  const resolved = await registry.resolveByName(
    "legacy_name",
    { org: "acme", project: "webapp" }
  );

  assertEquals(resolved?.id, created.id);

  await db.close();
});

// ============================================
// Alias Chain Prevention Tests (AC9)
// ============================================

Deno.test("CapabilityRegistry.updateAliasChains - updates all aliases to new target", async () => {
  const db = await setupTestDb();
  const registry = new CapabilityRegistry(db);

  // Create workflow_patterns for both capabilities
  const patternA = await createTestWorkflowPattern(db, "a");
  const patternB = await createTestWorkflowPattern(db, "b");

  // Create capability A
  const capA = await registry.create({
    displayName: "cap_a",
    org: "acme",
    project: "webapp",
    namespace: "ns",
    action: "a",
    workflowPatternId: patternA.patternId,
    hash: patternA.hash,
  });

  // Create capability B
  const capB = await registry.create({
    displayName: "cap_b",
    org: "acme",
    project: "webapp",
    namespace: "ns",
    action: "b",
    workflowPatternId: patternB.patternId,
    hash: patternB.hash,
  });

  // Create aliases pointing to A
  await registry.createAlias("acme", "webapp", "alias1", capA.id);
  await registry.createAlias("acme", "webapp", "alias2", capA.id);

  // Update aliases to point to B (simulating A renamed to B)
  const updated = await registry.updateAliasChains(capA.id, capB.id);

  assertEquals(updated, 2);

  // Verify aliases now point to B
  const result1 = await registry.resolveByAlias(
    "alias1",
    { org: "acme", project: "webapp" }
  );
  const result2 = await registry.resolveByAlias(
    "alias2",
    { org: "acme", project: "webapp" }
  );

  assertEquals(result1?.record.id, capB.id);
  assertEquals(result2?.record.id, capB.id);

  await db.close();
});

Deno.test("CapabilityRegistry.updateAliasChains - scenario: A->B->C no chains", async () => {
  const db = await setupTestDb();
  const registry = new CapabilityRegistry(db);

  // Create workflow_patterns for all capabilities
  const patternA = await createTestWorkflowPattern(db, "a");
  const patternB = await createTestWorkflowPattern(db, "b");
  const patternC = await createTestWorkflowPattern(db, "c");

  // Create capabilities A, B, C
  // capA is intentionally not used directly - we just need it to exist
  await registry.create({
    displayName: "cap_a",
    org: "local",
    project: "default",
    namespace: "ns",
    action: "a",
    workflowPatternId: patternA.patternId,
    hash: patternA.hash,
  });

  const capB = await registry.create({
    displayName: "cap_b",
    org: "local",
    project: "default",
    namespace: "ns",
    action: "b",
    workflowPatternId: patternB.patternId,
    hash: patternB.hash,
  });

  const capC = await registry.create({
    displayName: "cap_c",
    org: "local",
    project: "default",
    namespace: "ns",
    action: "c",
    workflowPatternId: patternC.patternId,
    hash: patternC.hash,
  });

  // Alias A -> B
  await registry.createAlias("local", "default", "alias_a", capB.id);

  // Now B renamed to C, update chains
  await registry.updateAliasChains(capB.id, capC.id);

  // alias_a should now point directly to C (not via B)
  const result = await registry.resolveByAlias(
    "alias_a",
    { org: "local", project: "default" }
  );

  assertEquals(result?.record.id, capC.id);

  await db.close();
});

// ============================================
// Usage Metrics Tests
// ============================================

Deno.test("CapabilityRegistry.recordUsage - increments counters", async () => {
  const db = await setupTestDb();
  const registry = new CapabilityRegistry(db);

  // Create workflow_pattern first
  const { patternId, hash } = await createTestWorkflowPattern(db, "code");

  const created = await registry.create({
    displayName: "test_cap",
    org: "local",
    project: "default",
    namespace: "ns",
    action: "test",
    workflowPatternId: patternId,
    hash,
  });

  // Record successful usage
  await registry.recordUsage(created.id, true, 100);
  await registry.recordUsage(created.id, true, 200);
  await registry.recordUsage(created.id, false, 50);

  const updated = await registry.getByFqdn(created.id);

  assertEquals(updated?.usageCount, 3);
  assertEquals(updated?.successCount, 2);
  assertEquals(updated?.totalLatencyMs, 350);

  await db.close();
});

// ============================================
// List and Alias Retrieval Tests
// ============================================

Deno.test("CapabilityRegistry.listByScope - returns capabilities in scope", async () => {
  const db = await setupTestDb();
  const registry = new CapabilityRegistry(db);

  // Create workflow_patterns for all capabilities
  const patternA = await createTestWorkflowPattern(db, "a");
  const patternB = await createTestWorkflowPattern(db, "b");
  const patternC = await createTestWorkflowPattern(db, "c");

  // Create capabilities in different scopes
  await registry.create({
    displayName: "cap1",
    org: "acme",
    project: "webapp",
    namespace: "ns",
    action: "a",
    workflowPatternId: patternA.patternId,
    hash: patternA.hash,
  });

  await registry.create({
    displayName: "cap2",
    org: "acme",
    project: "webapp",
    namespace: "ns",
    action: "b",
    workflowPatternId: patternB.patternId,
    hash: patternB.hash,
  });

  await registry.create({
    displayName: "other",
    org: "other",
    project: "other",
    namespace: "ns",
    action: "c",
    workflowPatternId: patternC.patternId,
    hash: patternC.hash,
  });

  // List for acme.webapp scope
  const list = await registry.listByScope({ org: "acme", project: "webapp" });

  assertEquals(list.length, 2);
  assert(list.some((c) => c.displayName === "cap1"));
  assert(list.some((c) => c.displayName === "cap2"));

  await db.close();
});

Deno.test("CapabilityRegistry.getAliases - returns all aliases for FQDN", async () => {
  const db = await setupTestDb();
  const registry = new CapabilityRegistry(db);

  // Create workflow_pattern first
  const { patternId, hash } = await createTestWorkflowPattern(db, "code");

  const created = await registry.create({
    displayName: "target_cap",
    org: "local",
    project: "default",
    namespace: "ns",
    action: "target",
    workflowPatternId: patternId,
    hash,
  });

  // Create multiple aliases
  await registry.createAlias("local", "default", "alias_one", created.id);
  await registry.createAlias("local", "default", "alias_two", created.id);

  const aliases = await registry.getAliases(created.id);

  assertEquals(aliases.length, 2);
  assert(aliases.some((a) => a.alias === "alias_one"));
  assert(aliases.some((a) => a.alias === "alias_two"));

  await db.close();
});
