/**
 * Unit tests for CapabilityRegistry (Story 13.1, Migration 028)
 *
 * Tests name resolution with UUID primary key.
 * Note: displayName and aliases were removed in migration 028.
 *
 * @module tests/unit/capabilities/capability_registry_test
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { CapabilityRegistry, getCapabilityFqdn, getCapabilityDisplayName } from "../../../src/capabilities/capability-registry.ts";
import { PGliteClient } from "../../../src/db/client.ts";
import { getAllMigrations, MigrationRunner } from "../../../src/db/migrations.ts";
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

Deno.test("CapabilityRegistry.create - creates record with UUID and computes FQDN", async () => {
  const db = await setupTestDb();
  const registry = new CapabilityRegistry(db);

  // First create workflow_pattern (architecture: code lives there)
  const code = "export function readJson(path) { return JSON.parse(Deno.readTextFileSync(path)); }";
  const { patternId, hash } = await createTestWorkflowPattern(db, code);

  const record = await registry.create({
    org: "local",
    project: "default",
    namespace: "fs",
    action: "read_json",
    workflowPatternId: patternId,
    hash,
  });

  // ID should be a UUID (36 chars with hyphens)
  assertEquals(record.id.length, 36);
  assert(record.id.includes("-"), "ID should be a UUID with hyphens");

  // FQDN is computed from components
  const fqdn = getCapabilityFqdn(record);
  assert(fqdn.startsWith("local.default.fs.read_json."));
  assertEquals(fqdn.length, "local.default.fs.read_json.".length + 4);

  // Display name is namespace:action
  const displayName = getCapabilityDisplayName(record);
  assertEquals(displayName, "fs:read_json");

  // Fields should be set correctly
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

Deno.test("CapabilityRegistry.create - rejects invalid namespace:action (MCP name validation)", async () => {
  const db = await setupTestDb();
  const registry = new CapabilityRegistry(db);

  // Validation happens before DB access, so dummy values are fine
  await assertRejects(
    () =>
      registry.create({
        org: "local",
        project: "default",
        namespace: "my namespace", // has space - invalid for MCP
        action: "read",
        workflowPatternId: "dummy-pattern-id",
        hash: "abcd",
      }),
    Error,
    "Invalid namespace:action",
  );

  await db.close();
});

Deno.test("CapabilityRegistry.create - updates existing on conflict (same FQDN components)", async () => {
  const db = await setupTestDb();
  const registry = new CapabilityRegistry(db);

  // Create workflow_pattern first (architecture: code lives there)
  const { patternId, hash } = await createTestWorkflowPattern(db, "v1");

  // Create first record
  const record1 = await registry.create({
    org: "local",
    project: "default",
    namespace: "fs",
    action: "read",
    workflowPatternId: patternId,
    hash,
  });

  // Create with same FQDN components - should update (ON CONFLICT)
  const record2 = await registry.create({
    org: "local",
    project: "default",
    namespace: "fs",
    action: "read",
    workflowPatternId: patternId,
    hash, // same hash = same FQDN components
  });

  // Should be same UUID (same FQDN components trigger ON CONFLICT DO UPDATE)
  assertEquals(record1.id, record2.id);

  // Fetch and verify version incremented
  const fetched = await registry.getById(record2.id);
  assertEquals(fetched?.version, 2);

  await db.close();
});

// ============================================
// Get By ID Tests (UUID)
// ============================================

Deno.test("CapabilityRegistry.getById - finds record by UUID", async () => {
  const db = await setupTestDb();
  const registry = new CapabilityRegistry(db);

  // Create workflow_pattern first
  const { patternId, hash } = await createTestWorkflowPattern(db, "code");

  // Create a capability
  const created = await registry.create({
    org: "acme",
    project: "webapp",
    namespace: "fs",
    action: "read",
    workflowPatternId: patternId,
    hash,
  });

  // Get by UUID
  const found = await registry.getById(created.id);

  assertEquals(found?.id, created.id);
  assertEquals(found?.org, "acme");
  assertEquals(found?.project, "webapp");

  await db.close();
});

Deno.test("CapabilityRegistry.getById - returns null for non-existent UUID", async () => {
  const db = await setupTestDb();
  const registry = new CapabilityRegistry(db);

  const found = await registry.getById("00000000-0000-0000-0000-000000000000");

  assertEquals(found, null);

  await db.close();
});

// ============================================
// Get By FQDN Components Tests
// ============================================

Deno.test("CapabilityRegistry.getByFqdnComponents - finds record by FQDN parts", async () => {
  const db = await setupTestDb();
  const registry = new CapabilityRegistry(db);

  // Create workflow_pattern first
  const { patternId, hash } = await createTestWorkflowPattern(db, "code");

  // Create a capability
  const created = await registry.create({
    org: "acme",
    project: "webapp",
    namespace: "api",
    action: "fetch",
    workflowPatternId: patternId,
    hash,
  });

  // Get by FQDN components
  const found = await registry.getByFqdnComponents("acme", "webapp", "api", "fetch", hash);

  assertEquals(found?.id, created.id);

  await db.close();
});

// ============================================
// Scope Resolution Tests (AC7)
// ============================================

Deno.test("CapabilityRegistry.resolveByName - finds by namespace:action in scope", async () => {
  const db = await setupTestDb();
  const registry = new CapabilityRegistry(db);

  // Create workflow_pattern first
  const { patternId, hash } = await createTestWorkflowPattern(db, "code");

  // Create a capability
  const created = await registry.create({
    org: "acme",
    project: "webapp",
    namespace: "fs",
    action: "read",
    workflowPatternId: patternId,
    hash,
  });

  // Resolve in same scope using namespace:action format
  const resolved = await registry.resolveByName(
    "fs:read",
    { org: "acme", project: "webapp" },
  );

  assertEquals(resolved?.id, created.id);

  await db.close();
});

Deno.test("CapabilityRegistry.resolveByName - finds by action only in scope", async () => {
  const db = await setupTestDb();
  const registry = new CapabilityRegistry(db);

  // Create workflow_pattern first
  const { patternId, hash } = await createTestWorkflowPattern(db, "code");

  // Create a capability
  const created = await registry.create({
    org: "acme",
    project: "webapp",
    namespace: "fs",
    action: "read",
    workflowPatternId: patternId,
    hash,
  });

  // Resolve by action only (no namespace prefix)
  const resolved = await registry.resolveByName(
    "read",
    { org: "acme", project: "webapp" },
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
    org: "acme",
    project: "webapp",
    namespace: "fs",
    action: "read",
    workflowPatternId: patternId,
    hash,
  });

  // Try to resolve in different scope
  const resolved = await registry.resolveByName(
    "fs:read",
    { org: "other", project: "project" },
  );

  assertEquals(resolved, null);

  await db.close();
});

Deno.test("CapabilityRegistry.resolveByName - finds public capability from any scope", async () => {
  const db = await setupTestDb();
  const registry = new CapabilityRegistry(db);

  // Create workflow_pattern first
  const { patternId, hash } = await createTestWorkflowPattern(db, "code");

  // Create a public capability
  const created = await registry.create({
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
    "util:format",
    { org: "acme", project: "webapp" },
  );

  assertEquals(resolved?.id, created.id);

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

  const updated = await registry.getById(created.id);

  assertEquals(updated?.usageCount, 3);
  assertEquals(updated?.successCount, 2);
  assertEquals(updated?.totalLatencyMs, 350);

  await db.close();
});

// ============================================
// List Tests
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
    org: "acme",
    project: "webapp",
    namespace: "ns",
    action: "a",
    workflowPatternId: patternA.patternId,
    hash: patternA.hash,
  });

  await registry.create({
    org: "acme",
    project: "webapp",
    namespace: "ns",
    action: "b",
    workflowPatternId: patternB.patternId,
    hash: patternB.hash,
  });

  await registry.create({
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
  assert(list.some((c) => c.action === "a"));
  assert(list.some((c) => c.action === "b"));

  await db.close();
});

// ============================================
// Delete Tests
// ============================================

Deno.test("CapabilityRegistry.delete - removes capability by UUID", async () => {
  const db = await setupTestDb();
  const registry = new CapabilityRegistry(db);

  // Create workflow_pattern first
  const { patternId, hash } = await createTestWorkflowPattern(db, "code");

  const created = await registry.create({
    org: "local",
    project: "default",
    namespace: "ns",
    action: "to_delete",
    workflowPatternId: patternId,
    hash,
  });

  // Delete
  const deleted = await registry.delete(created.id);
  assertEquals(deleted, true);

  // Verify it's gone
  const found = await registry.getById(created.id);
  assertEquals(found, null);

  await db.close();
});

Deno.test("CapabilityRegistry.delete - returns false for non-existent UUID", async () => {
  const db = await setupTestDb();
  const registry = new CapabilityRegistry(db);

  const deleted = await registry.delete("00000000-0000-0000-0000-000000000000");
  assertEquals(deleted, false);

  await db.close();
});

// ============================================
// Helper Functions Tests
// ============================================

Deno.test("getCapabilityFqdn - computes correct FQDN", () => {
  const record = {
    org: "acme",
    project: "webapp",
    namespace: "fs",
    action: "read",
    hash: "a1b2",
  };

  const fqdn = getCapabilityFqdn(record);
  assertEquals(fqdn, "acme.webapp.fs.read.a1b2");
});

Deno.test("getCapabilityDisplayName - computes correct display name", () => {
  const record = {
    namespace: "fs",
    action: "read_json",
  };

  const displayName = getCapabilityDisplayName(record);
  assertEquals(displayName, "fs:read_json");
});
