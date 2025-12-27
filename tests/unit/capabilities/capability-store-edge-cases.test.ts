/**
 * Extended Unit Tests for CapabilityStore - Coverage Gaps
 *
 * Tests for previously untested code paths:
 * - addDependency() with cycle detection
 * - updateDependency() method
 * - getDependencies() with different directions
 * - removeDependency() method
 * - getAllDependencies() method
 * - updatePermissionSet() with validation
 * - isValidEscalation() method
 * - getStaticStructure() method
 * - listWithSchemas() method
 * - Code transformation error handling (throws on failure)
 *
 * @module tests/unit/capabilities/capability-store-coverage.test
 */

import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { PGliteClient } from "../../../src/db/client.ts";
import { getAllMigrations, MigrationRunner } from "../../../src/db/migrations.ts";
import { CapabilityStore } from "../../../src/capabilities/capability-store.ts";

/**
 * Mock EmbeddingModel for tests
 */
class MockEmbeddingModel {
  async encode(_text: string): Promise<number[]> {
    return new Array(1024).fill(0.5);
  }

  isLoaded(): boolean {
    return true;
  }
}

/**
 * Mock CapabilityRegistry that fails transformation
 */
class FailingMockRegistry {
  async resolveByName(_actionName: string, _scope?: unknown): Promise<unknown> {
    throw new Error("Registry lookup failed");
  }
}

/**
 * Setup test database with migrations
 */
async function setupTestDb(): Promise<PGliteClient> {
  const db = new PGliteClient(":memory:");
  await db.connect();

  const runner = new MigrationRunner(db);
  await runner.runUp(getAllMigrations());

  return db;
}

/**
 * Create a test capability and return its ID
 */
async function createTestCapability(
  store: CapabilityStore,
  code: string,
  intent: string,
): Promise<string> {
  const { capability } = await store.saveCapability({
    code,
    intent,
    durationMs: 100,
    success: true,
  });
  return capability.id;
}

// =============================================================================
// Dependency Management Tests
// =============================================================================

Deno.test("CapabilityStore - addDependency() creates new dependency", async () => {
  const db = await setupTestDb();
  const model = new MockEmbeddingModel();
  const store = new CapabilityStore(db, model as any);

  const capA = await createTestCapability(store, "const a = 1;", "Define A");
  const capB = await createTestCapability(store, "const b = 2;", "Define B");

  const dep = await store.addDependency({
    fromCapabilityId: capA,
    toCapabilityId: capB,
    edgeType: "dependency",
    edgeSource: "inferred",
  });

  assertExists(dep);
  assertEquals(dep.fromCapabilityId, capA);
  assertEquals(dep.toCapabilityId, capB);
  assertEquals(dep.edgeType, "dependency");
  assertEquals(dep.edgeSource, "inferred");
  assertEquals(dep.observedCount, 1);
  // Confidence = 1.0 (dependency weight) * 0.7 (inferred modifier) = 0.7
  assertEquals(dep.confidenceScore, 0.7);

  await db.close();
});

Deno.test("CapabilityStore - addDependency() increments on re-add", async () => {
  const db = await setupTestDb();
  const model = new MockEmbeddingModel();
  const store = new CapabilityStore(db, model as any);

  const capA = await createTestCapability(store, "const x = 1;", "Define X");
  const capB = await createTestCapability(store, "const y = 2;", "Define Y");

  // Add dependency first time
  await store.addDependency({
    fromCapabilityId: capA,
    toCapabilityId: capB,
    edgeType: "sequence",
    edgeSource: "inferred",
  });

  // Add same dependency again
  const dep = await store.addDependency({
    fromCapabilityId: capA,
    toCapabilityId: capB,
    edgeType: "sequence",
    edgeSource: "inferred",
  });

  assertEquals(dep.observedCount, 2, "Should increment observed count");

  await db.close();
});

Deno.test("CapabilityStore - addDependency() upgrades to observed after threshold", async () => {
  const db = await setupTestDb();
  const model = new MockEmbeddingModel();
  const store = new CapabilityStore(db, model as any);

  const capA = await createTestCapability(store, "const p = 1;", "Define P");
  const capB = await createTestCapability(store, "const q = 2;", "Define Q");

  // Add dependency 3 times (threshold is 3)
  await store.addDependency({
    fromCapabilityId: capA,
    toCapabilityId: capB,
    edgeType: "dependency",
    edgeSource: "inferred",
  });
  await store.addDependency({
    fromCapabilityId: capA,
    toCapabilityId: capB,
    edgeType: "dependency",
    edgeSource: "inferred",
  });
  const dep = await store.addDependency({
    fromCapabilityId: capA,
    toCapabilityId: capB,
    edgeType: "dependency",
    edgeSource: "inferred",
  });

  assertEquals(dep.observedCount, 3);
  assertEquals(dep.edgeSource, "observed", "Should upgrade to observed after threshold");
  // Confidence should now be 1.0 (dependency) * 1.0 (observed) = 1.0
  assertEquals(dep.confidenceScore, 1.0);

  await db.close();
});

Deno.test("CapabilityStore - getDependencies() with direction=from", async () => {
  const db = await setupTestDb();
  const model = new MockEmbeddingModel();
  const store = new CapabilityStore(db, model as any);

  const capA = await createTestCapability(store, "const a = 1;", "A");
  const capB = await createTestCapability(store, "const b = 2;", "B");
  const capC = await createTestCapability(store, "const c = 3;", "C");

  // A -> B, A -> C
  await store.addDependency({
    fromCapabilityId: capA,
    toCapabilityId: capB,
    edgeType: "dependency",
  });
  await store.addDependency({
    fromCapabilityId: capA,
    toCapabilityId: capC,
    edgeType: "contains",
  });

  const deps = await store.getDependencies(capA, "from");

  assertEquals(deps.length, 2, "Should have 2 outgoing dependencies");
  assertEquals(deps.every((d) => d.fromCapabilityId === capA), true);

  await db.close();
});

Deno.test("CapabilityStore - getDependencies() with direction=to", async () => {
  const db = await setupTestDb();
  const model = new MockEmbeddingModel();
  const store = new CapabilityStore(db, model as any);

  const capA = await createTestCapability(store, "const a = 1;", "A");
  const capB = await createTestCapability(store, "const b = 2;", "B");
  const capC = await createTestCapability(store, "const c = 3;", "C");

  // A -> C, B -> C
  await store.addDependency({
    fromCapabilityId: capA,
    toCapabilityId: capC,
    edgeType: "dependency",
  });
  await store.addDependency({
    fromCapabilityId: capB,
    toCapabilityId: capC,
    edgeType: "dependency",
  });

  const deps = await store.getDependencies(capC, "to");

  assertEquals(deps.length, 2, "Should have 2 incoming dependencies");
  assertEquals(deps.every((d) => d.toCapabilityId === capC), true);

  await db.close();
});

Deno.test("CapabilityStore - getDependencies() with direction=both", async () => {
  const db = await setupTestDb();
  const model = new MockEmbeddingModel();
  const store = new CapabilityStore(db, model as any);

  const capA = await createTestCapability(store, "const a = 1;", "A");
  const capB = await createTestCapability(store, "const b = 2;", "B");
  const capC = await createTestCapability(store, "const c = 3;", "C");

  // A -> B, C -> A
  await store.addDependency({
    fromCapabilityId: capA,
    toCapabilityId: capB,
    edgeType: "dependency",
  });
  await store.addDependency({
    fromCapabilityId: capC,
    toCapabilityId: capA,
    edgeType: "dependency",
  });

  const deps = await store.getDependencies(capA, "both");

  assertEquals(deps.length, 2, "Should have 2 total dependencies (1 in, 1 out)");

  await db.close();
});

Deno.test("CapabilityStore - getDependenciesCount() returns correct count", async () => {
  const db = await setupTestDb();
  const model = new MockEmbeddingModel();
  const store = new CapabilityStore(db, model as any);

  const capA = await createTestCapability(store, "const a = 1;", "A");
  const capB = await createTestCapability(store, "const b = 2;", "B");
  const capC = await createTestCapability(store, "const c = 3;", "C");

  // Create dependencies: A -> B, A -> C, B -> A
  await store.addDependency({
    fromCapabilityId: capA,
    toCapabilityId: capB,
    edgeType: "dependency",
  });
  await store.addDependency({
    fromCapabilityId: capA,
    toCapabilityId: capC,
    edgeType: "dependency",
  });
  await store.addDependency({
    fromCapabilityId: capB,
    toCapabilityId: capA,
    edgeType: "dependency",
  });

  const countA = await store.getDependenciesCount(capA);
  const countB = await store.getDependenciesCount(capB);
  const countC = await store.getDependenciesCount(capC);

  assertEquals(countA, 3, "A has 3 dependencies (2 out, 1 in)");
  assertEquals(countB, 2, "B has 2 dependencies (1 out, 1 in)");
  assertEquals(countC, 1, "C has 1 dependency (1 in)");

  await db.close();
});

Deno.test("CapabilityStore - updateDependency() increments observed count", async () => {
  const db = await setupTestDb();
  const model = new MockEmbeddingModel();
  const store = new CapabilityStore(db, model as any);

  const capA = await createTestCapability(store, "const a = 1;", "A");
  const capB = await createTestCapability(store, "const b = 2;", "B");

  await store.addDependency({
    fromCapabilityId: capA,
    toCapabilityId: capB,
    edgeType: "dependency",
    edgeSource: "inferred",
  });

  // Update with increment of 5
  await store.updateDependency(capA, capB, 5);

  const deps = await store.getDependencies(capA, "from");
  assertEquals(deps.length, 1);
  assertEquals(deps[0].observedCount, 6, "Should be 1 + 5 = 6");
  assertEquals(deps[0].edgeSource, "observed", "Should upgrade to observed (6 >= 3)");

  await db.close();
});

Deno.test("CapabilityStore - removeDependency() deletes dependency", async () => {
  const db = await setupTestDb();
  const model = new MockEmbeddingModel();
  const store = new CapabilityStore(db, model as any);

  const capA = await createTestCapability(store, "const a = 1;", "A");
  const capB = await createTestCapability(store, "const b = 2;", "B");

  await store.addDependency({
    fromCapabilityId: capA,
    toCapabilityId: capB,
    edgeType: "dependency",
  });

  // Verify it exists
  let deps = await store.getDependencies(capA, "from");
  assertEquals(deps.length, 1);

  // Remove it
  await store.removeDependency(capA, capB);

  // Verify it's gone
  deps = await store.getDependencies(capA, "from");
  assertEquals(deps.length, 0);

  await db.close();
});

Deno.test("CapabilityStore - getAllDependencies() with minConfidence filter", async () => {
  const db = await setupTestDb();
  const model = new MockEmbeddingModel();
  const store = new CapabilityStore(db, model as any);

  const capA = await createTestCapability(store, "const a = 1;", "A");
  const capB = await createTestCapability(store, "const b = 2;", "B");
  const capC = await createTestCapability(store, "const c = 3;", "C");

  // dependency (1.0) * inferred (0.7) = 0.7
  await store.addDependency({
    fromCapabilityId: capA,
    toCapabilityId: capB,
    edgeType: "dependency",
    edgeSource: "inferred",
  });

  // sequence (0.5) * inferred (0.7) = 0.35
  await store.addDependency({
    fromCapabilityId: capA,
    toCapabilityId: capC,
    edgeType: "sequence",
    edgeSource: "inferred",
  });

  // Get all with minConfidence 0.5
  const deps = await store.getAllDependencies(0.5);

  assertEquals(deps.length, 1, "Only dependency with confidence > 0.5");
  assertEquals(deps[0].toCapabilityId, capB);

  // Get all with low minConfidence
  const allDeps = await store.getAllDependencies(0.1);
  assertEquals(allDeps.length, 2, "Both dependencies above 0.1");

  await db.close();
});

// =============================================================================
// Permission Escalation Tests
// =============================================================================

Deno.test("CapabilityStore - isValidEscalation() validates allowed transitions", async () => {
  const db = await setupTestDb();
  const model = new MockEmbeddingModel();
  const store = new CapabilityStore(db, model as any);

  // Valid escalations from minimal
  assertEquals(store.isValidEscalation("minimal", "readonly"), true);
  assertEquals(store.isValidEscalation("minimal", "filesystem"), true);
  assertEquals(store.isValidEscalation("minimal", "network-api"), true);
  assertEquals(store.isValidEscalation("minimal", "mcp-standard"), true);

  // Valid escalations from readonly
  assertEquals(store.isValidEscalation("readonly", "filesystem"), true);
  assertEquals(store.isValidEscalation("readonly", "mcp-standard"), true);

  // Valid escalations from filesystem
  assertEquals(store.isValidEscalation("filesystem", "mcp-standard"), true);

  // Invalid escalations
  assertEquals(
    store.isValidEscalation("minimal", "trusted"),
    false,
    "trusted unreachable via escalation",
  );
  assertEquals(store.isValidEscalation("mcp-standard", "minimal"), false, "cannot de-escalate");
  assertEquals(
    store.isValidEscalation("trusted", "mcp-standard"),
    false,
    "trusted has no valid targets",
  );

  await db.close();
});

Deno.test("CapabilityStore - updatePermissionSet() updates valid escalation", async () => {
  const db = await setupTestDb();
  const model = new MockEmbeddingModel();
  const store = new CapabilityStore(db, model as any);

  const capId = await createTestCapability(store, "const x = 1;", "Test capability");

  // Verify initial permission set is minimal
  let cap = await store.findById(capId);
  assertEquals(cap?.permissionSet, "minimal");

  // Escalate to readonly
  await store.updatePermissionSet(capId, "readonly");

  cap = await store.findById(capId);
  assertEquals(cap?.permissionSet, "readonly");
  assertEquals(cap?.permissionConfidence, 1.0, "Confidence should be 1.0 after HIL approval");

  await db.close();
});

Deno.test("CapabilityStore - updatePermissionSet() throws on invalid escalation", async () => {
  const db = await setupTestDb();
  const model = new MockEmbeddingModel();
  const store = new CapabilityStore(db, model as any);

  const capId = await createTestCapability(store, "const x = 1;", "Test capability");

  // Try to escalate directly to trusted (not allowed)
  await assertRejects(
    async () => {
      await store.updatePermissionSet(capId, "trusted");
    },
    Error,
    "Invalid permission escalation",
  );

  await db.close();
});

Deno.test("CapabilityStore - updatePermissionSet() throws on non-existent capability", async () => {
  const db = await setupTestDb();
  const model = new MockEmbeddingModel();
  const store = new CapabilityStore(db, model as any);

  // Use a valid UUID format that doesn't exist
  await assertRejects(
    async () => {
      await store.updatePermissionSet("00000000-0000-0000-0000-000000000000", "readonly");
    },
    Error,
    "not found",
  );

  await db.close();
});

Deno.test("CapabilityStore - updatePermissionSet() multi-step escalation", async () => {
  const db = await setupTestDb();
  const model = new MockEmbeddingModel();
  const store = new CapabilityStore(db, model as any);

  const capId = await createTestCapability(store, "const x = 1;", "Test capability");

  // Escalate step by step: minimal -> readonly -> filesystem -> mcp-standard
  await store.updatePermissionSet(capId, "readonly");
  let cap = await store.findById(capId);
  assertEquals(cap?.permissionSet, "readonly");

  await store.updatePermissionSet(capId, "filesystem");
  cap = await store.findById(capId);
  assertEquals(cap?.permissionSet, "filesystem");

  await store.updatePermissionSet(capId, "mcp-standard");
  cap = await store.findById(capId);
  assertEquals(cap?.permissionSet, "mcp-standard");

  await db.close();
});

// =============================================================================
// Static Structure Tests
// =============================================================================

Deno.test("CapabilityStore - getStaticStructure() returns null for missing capability", async () => {
  const db = await setupTestDb();
  const model = new MockEmbeddingModel();
  const store = new CapabilityStore(db, model as any);

  const structure = await store.getStaticStructure("non-existent-id");

  assertEquals(structure, null);

  await db.close();
});

Deno.test("CapabilityStore - getStaticStructure() returns null when no static_structure", async () => {
  const db = await setupTestDb();
  const model = new MockEmbeddingModel();
  const store = new CapabilityStore(db, model as any);

  // Create capability without static structure builder
  const capId = await createTestCapability(store, "const x = 1;", "Simple capability");

  const structure = await store.getStaticStructure(capId);

  // No static structure was built, so should be null
  assertEquals(structure, null);

  await db.close();
});

// =============================================================================
// listWithSchemas Tests
// =============================================================================

Deno.test("CapabilityStore - listWithSchemas() returns empty when no capability_records", async () => {
  const db = await setupTestDb();
  const model = new MockEmbeddingModel();
  const store = new CapabilityStore(db, model as any);

  // Create a capability (but no capability_records entry)
  await createTestCapability(store, "const x = 1;", "Test");

  const results = await store.listWithSchemas();

  // No capability_records, so empty
  assertEquals(results.length, 0);

  await db.close();
});

Deno.test("CapabilityStore - listWithSchemas() joins with capability_records", async () => {
  const db = await setupTestDb();
  const model = new MockEmbeddingModel();
  const store = new CapabilityStore(db, model as any);

  // Create a capability
  const capId = await createTestCapability(store, "const x = 1;", "Test capability");

  // Manually insert a capability_record entry with all required fields
  await db.query(
    `
    INSERT INTO capability_records (
      id, org, project, namespace, action, hash, display_name, workflow_pattern_id, visibility, created_by
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
  `,
    [
      "test.proj.test.myAction.abcd",
      "test",
      "proj",
      "test",
      "myAction",
      "abcd",
      "My Test Action",
      capId,
      "public",
      "test-user",
    ],
  );

  const results = await store.listWithSchemas();

  assertEquals(results.length, 1);
  assertEquals(results[0].namespace, "test");
  assertEquals(results[0].action, "myAction");
  assertEquals(results[0].displayName, "My Test Action");
  assertEquals(results[0].id, capId);

  await db.close();
});

Deno.test("CapabilityStore - listWithSchemas() respects visibility filter", async () => {
  const db = await setupTestDb();
  const model = new MockEmbeddingModel();
  const store = new CapabilityStore(db, model as any);

  const cap1 = await createTestCapability(store, "const a = 1;", "Public cap");
  const cap2 = await createTestCapability(store, "const b = 2;", "Private cap");

  // Create capability_records with different visibility (include all required fields)
  await db.query(
    `INSERT INTO capability_records (id, org, project, namespace, action, hash, display_name, workflow_pattern_id, visibility, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      "org.proj.public.action.ab12",
      "org",
      "proj",
      "public",
      "action",
      "ab12",
      "Public Action",
      cap1,
      "public",
      "user",
    ],
  );
  await db.query(
    `INSERT INTO capability_records (id, org, project, namespace, action, hash, display_name, workflow_pattern_id, visibility, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      "org.proj.private.action.cd34",
      "org",
      "proj",
      "private",
      "action",
      "cd34",
      "Private Action",
      cap2,
      "private",
      "user",
    ],
  );

  // Query only public
  const publicOnly = await store.listWithSchemas({ visibility: ["public"] });
  assertEquals(publicOnly.length, 1);
  assertEquals(publicOnly[0].namespace, "public");

  // Query only private
  const privateOnly = await store.listWithSchemas({ visibility: ["private"] });
  assertEquals(privateOnly.length, 1);
  assertEquals(privateOnly[0].namespace, "private");

  // Query both
  const both = await store.listWithSchemas({ visibility: ["public", "private"] });
  assertEquals(both.length, 2);

  await db.close();
});

Deno.test("CapabilityStore - listWithSchemas() respects limit", async () => {
  const db = await setupTestDb();
  const model = new MockEmbeddingModel();
  const store = new CapabilityStore(db, model as any);

  // Create 5 capabilities with records
  for (let i = 0; i < 5; i++) {
    const capId = await createTestCapability(store, `const x${i} = ${i};`, `Cap ${i}`);
    const hash = `a${i}${i}${i}`;
    await db.query(
      `INSERT INTO capability_records (id, org, project, namespace, action, hash, display_name, workflow_pattern_id, visibility, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        `org.proj.ns.action${i}.${hash}`,
        "org",
        "proj",
        "ns",
        `action${i}`,
        hash,
        `Action ${i}`,
        capId,
        "public",
        "user",
      ],
    );
  }

  const results = await store.listWithSchemas({ limit: 3 });

  assertEquals(results.length, 3);

  await db.close();
});

Deno.test("CapabilityStore - listWithSchemas() orders by usageCount", async () => {
  const db = await setupTestDb();
  const model = new MockEmbeddingModel();
  const store = new CapabilityStore(db, model as any);

  // Create capabilities with different usage counts
  const { capability: cap1 } = await store.saveCapability({
    code: "const a = 1;",
    intent: "Low usage",
    durationMs: 100,
  });
  // Use cap1 code again to increment usage
  await store.saveCapability({ code: "const a = 1;", intent: "Low usage", durationMs: 100 });

  const { capability: cap2 } = await store.saveCapability({
    code: "const b = 2;",
    intent: "High usage",
    durationMs: 100,
  });
  // Use cap2 code multiple times
  await store.saveCapability({ code: "const b = 2;", intent: "High usage", durationMs: 100 });
  await store.saveCapability({ code: "const b = 2;", intent: "High usage", durationMs: 100 });
  await store.saveCapability({ code: "const b = 2;", intent: "High usage", durationMs: 100 });

  // Create records with all required fields
  await db.query(
    `INSERT INTO capability_records (id, org, project, namespace, action, hash, display_name, workflow_pattern_id, visibility, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      "org.proj.ns.low.1111",
      "org",
      "proj",
      "ns",
      "low",
      "1111",
      "Low Usage",
      cap1.id,
      "public",
      "user",
    ],
  );
  await db.query(
    `INSERT INTO capability_records (id, org, project, namespace, action, hash, display_name, workflow_pattern_id, visibility, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      "org.proj.ns.high.2222",
      "org",
      "proj",
      "ns",
      "high",
      "2222",
      "High Usage",
      cap2.id,
      "public",
      "user",
    ],
  );

  const results = await store.listWithSchemas({ orderBy: "usageCount" });

  assertEquals(results.length, 2);
  assertEquals(results[0].action, "high", "Higher usage should come first");
  assertEquals(results[1].action, "low");

  await db.close();
});

// =============================================================================
// Code Transformation Error Handling Tests
// =============================================================================

Deno.test("CapabilityStore - saveCapability throws on code transformation failure", async () => {
  const db = await setupTestDb();
  const model = new MockEmbeddingModel();
  const store = new CapabilityStore(db, model as any);

  // Set a failing registry
  store.setCapabilityRegistry(new FailingMockRegistry() as any);

  // Attempt to save - should throw because transformation fails
  // Use mcp.namespace.action() pattern which triggers registry lookup
  await assertRejects(
    async () => {
      await store.saveCapability({
        code: "await mcp.myNamespace.myCapability();", // This triggers transformation via swc-analyzer
        intent: "Test with capability reference",
        durationMs: 100,
      });
    },
    Error,
    "Code transformation failed",
  );

  await db.close();
});

// =============================================================================
// findById Edge Cases
// =============================================================================

Deno.test("CapabilityStore - findById() returns null for non-existent id", async () => {
  const db = await setupTestDb();
  const model = new MockEmbeddingModel();
  const store = new CapabilityStore(db, model as any);

  // Use valid UUID format that doesn't exist
  const cap = await store.findById("00000000-0000-0000-0000-000000000000");

  assertEquals(cap, null);

  await db.close();
});

Deno.test("CapabilityStore - findById() returns correct capability", async () => {
  const db = await setupTestDb();
  const model = new MockEmbeddingModel();
  const store = new CapabilityStore(db, model as any);

  const { capability: created } = await store.saveCapability({
    code: "const unique = 42;",
    intent: "Unique capability",
    durationMs: 50,
    description: "A unique test capability",
  });

  const found = await store.findById(created.id);

  assertExists(found);
  assertEquals(found.id, created.id);
  assertEquals(found.codeSnippet, "const unique = 42;");
  assertEquals(found.description, "A unique test capability");

  await db.close();
});
