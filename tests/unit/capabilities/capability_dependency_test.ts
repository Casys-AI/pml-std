/**
 * Unit tests for Capability Dependencies (Tech-spec)
 *
 * Tests:
 * - AC 1: Table exists with FKs to workflow_pattern
 * - AC 2: addDependency() creates relation with edge_type/edge_source
 * - AC 3: updateDependency() increments observed_count and upgrades edge_source
 * - AC 4: getDependencies() returns relations in both directions
 * - AC 13: Cycles A→B + B→A are allowed
 *
 * @module tests/unit/capabilities/capability_dependency_test
 */

import { assertEquals, assertExists } from "@std/assert";
import { PGliteClient } from "../../../src/db/client.ts";
import { getAllMigrations, MigrationRunner } from "../../../src/db/migrations.ts";
import { CapabilityStore } from "../../../src/capabilities/capability-store.ts";

/**
 * Mock EmbeddingModel for tests
 */
class MockEmbeddingModel {
  async load(): Promise<void> {}

  async encode(text: string): Promise<number[]> {
    const embedding = new Array(1024).fill(0);
    for (let i = 0; i < Math.min(text.length, 1024); i++) {
      embedding[i] = (text.charCodeAt(i) % 100) / 100;
    }
    return embedding;
  }

  isLoaded(): boolean {
    return true;
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
 * Create test capabilities and return their IDs
 */
async function createTestCapabilities(
  store: CapabilityStore,
): Promise<{ capA: string; capB: string; capC: string }> {
  const { capability: capA } = await store.saveCapability({
    code: 'const a = await tools.fetch({url: "api/data"});',
    intent: "Fetch data from API",
    durationMs: 100,
  });

  const { capability: capB } = await store.saveCapability({
    code: 'const b = await tools.transform({data});',
    intent: "Transform data",
    durationMs: 50,
  });

  const { capability: capC } = await store.saveCapability({
    code: 'const c = await tools.save({data});',
    intent: "Save data to storage",
    durationMs: 75,
  });

  return { capA: capA.id, capB: capB.id, capC: capC.id };
}

Deno.test("CapabilityDependency - AC 1: capability_dependency table exists", async () => {
  const db = await setupTestDb();

  // Verify table exists by querying information_schema
  const result = await db.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_name = 'capability_dependency'
  `);

  assertEquals(result.length, 1);
  await db.close();
});

Deno.test("CapabilityDependency - AC 2: addDependency creates relation with correct types", async () => {
  const db = await setupTestDb();
  const model = new MockEmbeddingModel();
  const store = new CapabilityStore(db, model as any);

  const { capA, capB } = await createTestCapabilities(store);

  // Add a dependency relation
  const dep = await store.addDependency({
    fromCapabilityId: capA,
    toCapabilityId: capB,
    edgeType: "sequence",
  });

  assertExists(dep);
  assertEquals(dep.fromCapabilityId, capA);
  assertEquals(dep.toCapabilityId, capB);
  assertEquals(dep.edgeType, "sequence");
  assertEquals(dep.edgeSource, "inferred");
  assertEquals(dep.observedCount, 1);
  // sequence (0.5) * inferred (0.7) = 0.35
  assertEquals(dep.confidenceScore, 0.35);

  await db.close();
});

Deno.test("CapabilityDependency - AC 2: addDependency with dependency type has higher confidence", async () => {
  const db = await setupTestDb();
  const model = new MockEmbeddingModel();
  const store = new CapabilityStore(db, model as any);

  const { capA, capB } = await createTestCapabilities(store);

  const dep = await store.addDependency({
    fromCapabilityId: capA,
    toCapabilityId: capB,
    edgeType: "dependency",
    edgeSource: "template",
  });

  // dependency (1.0) * template (0.5) = 0.5
  assertEquals(dep.confidenceScore, 0.5);
  assertEquals(dep.edgeType, "dependency");
  assertEquals(dep.edgeSource, "template");

  await db.close();
});

Deno.test("CapabilityDependency - AC 3: addDependency increments observed_count on conflict", async () => {
  const db = await setupTestDb();
  const model = new MockEmbeddingModel();
  const store = new CapabilityStore(db, model as any);

  const { capA, capB } = await createTestCapabilities(store);

  // First observation
  const dep1 = await store.addDependency({
    fromCapabilityId: capA,
    toCapabilityId: capB,
    edgeType: "sequence",
  });
  assertEquals(dep1.observedCount, 1);
  assertEquals(dep1.edgeSource, "inferred");

  // Second observation
  const dep2 = await store.addDependency({
    fromCapabilityId: capA,
    toCapabilityId: capB,
    edgeType: "sequence",
  });
  assertEquals(dep2.observedCount, 2);
  assertEquals(dep2.edgeSource, "inferred");

  // Third observation - should upgrade to 'observed'
  const dep3 = await store.addDependency({
    fromCapabilityId: capA,
    toCapabilityId: capB,
    edgeType: "sequence",
  });
  assertEquals(dep3.observedCount, 3);
  assertEquals(dep3.edgeSource, "observed");
  // sequence (0.5) * observed (1.0) = 0.5
  assertEquals(dep3.confidenceScore, 0.5);

  await db.close();
});

Deno.test("CapabilityDependency - AC 4: getDependencies returns relations in specified direction", async () => {
  const db = await setupTestDb();
  const model = new MockEmbeddingModel();
  const store = new CapabilityStore(db, model as any);

  const { capA, capB, capC } = await createTestCapabilities(store);

  // A → B (sequence)
  await store.addDependency({
    fromCapabilityId: capA,
    toCapabilityId: capB,
    edgeType: "sequence",
  });

  // B → C (dependency)
  await store.addDependency({
    fromCapabilityId: capB,
    toCapabilityId: capC,
    edgeType: "dependency",
  });

  // Test 'from' direction (outgoing from A)
  const fromA = await store.getDependencies(capA, "from");
  assertEquals(fromA.length, 1);
  assertEquals(fromA[0].toCapabilityId, capB);

  // Test 'to' direction (incoming to B)
  const toB = await store.getDependencies(capB, "to");
  assertEquals(toB.length, 1);
  assertEquals(toB[0].fromCapabilityId, capA);

  // Test 'both' direction (all relations involving B)
  const bothB = await store.getDependencies(capB, "both");
  assertEquals(bothB.length, 2); // A→B and B→C

  await db.close();
});

Deno.test("CapabilityDependency - getDependenciesCount returns correct count", async () => {
  const db = await setupTestDb();
  const model = new MockEmbeddingModel();
  const store = new CapabilityStore(db, model as any);

  const { capA, capB, capC } = await createTestCapabilities(store);

  // A → B, A → C
  await store.addDependency({
    fromCapabilityId: capA,
    toCapabilityId: capB,
    edgeType: "contains",
  });
  await store.addDependency({
    fromCapabilityId: capA,
    toCapabilityId: capC,
    edgeType: "contains",
  });

  const count = await store.getDependenciesCount(capA);
  assertEquals(count, 2);

  await db.close();
});

Deno.test("CapabilityDependency - removeDependency deletes relation", async () => {
  const db = await setupTestDb();
  const model = new MockEmbeddingModel();
  const store = new CapabilityStore(db, model as any);

  const { capA, capB } = await createTestCapabilities(store);

  await store.addDependency({
    fromCapabilityId: capA,
    toCapabilityId: capB,
    edgeType: "sequence",
  });

  let deps = await store.getDependencies(capA, "from");
  assertEquals(deps.length, 1);

  await store.removeDependency(capA, capB);

  deps = await store.getDependencies(capA, "from");
  assertEquals(deps.length, 0);

  await db.close();
});

Deno.test("CapabilityDependency - updateDependency increments count and upgrades source", async () => {
  const db = await setupTestDb();
  const model = new MockEmbeddingModel();
  const store = new CapabilityStore(db, model as any);

  const { capA, capB } = await createTestCapabilities(store);

  // Create initial dependency
  await store.addDependency({
    fromCapabilityId: capA,
    toCapabilityId: capB,
    edgeType: "sequence",
  });

  // Get initial state
  let deps = await store.getDependencies(capA, "from");
  assertEquals(deps[0].observedCount, 1);
  assertEquals(deps[0].edgeSource, "inferred");

  // Update with incrementBy=1 (default)
  await store.updateDependency(capA, capB);
  deps = await store.getDependencies(capA, "from");
  assertEquals(deps[0].observedCount, 2);
  assertEquals(deps[0].edgeSource, "inferred");

  // Update again - should upgrade to 'observed' at count=3
  await store.updateDependency(capA, capB);
  deps = await store.getDependencies(capA, "from");
  assertEquals(deps[0].observedCount, 3);
  assertEquals(deps[0].edgeSource, "observed");
  // sequence (0.5) * observed (1.0) = 0.5
  assertEquals(deps[0].confidenceScore, 0.5);

  // Test incrementBy > 1
  await store.updateDependency(capA, capB, 5);
  deps = await store.getDependencies(capA, "from");
  assertEquals(deps[0].observedCount, 8);

  await db.close();
});

Deno.test("CapabilityDependency - AC 13: Cycles A→B + B→A are allowed", async () => {
  const db = await setupTestDb();
  const model = new MockEmbeddingModel();
  const store = new CapabilityStore(db, model as any);

  const { capA, capB } = await createTestCapabilities(store);

  // Create A → B
  const depAB = await store.addDependency({
    fromCapabilityId: capA,
    toCapabilityId: capB,
    edgeType: "sequence",
  });
  assertExists(depAB);

  // Create B → A (reverse direction - should be allowed)
  const depBA = await store.addDependency({
    fromCapabilityId: capB,
    toCapabilityId: capA,
    edgeType: "sequence",
  });
  assertExists(depBA);

  // Both should exist
  const depsFromA = await store.getDependencies(capA, "from");
  const depsFromB = await store.getDependencies(capB, "from");

  assertEquals(depsFromA.length, 1);
  assertEquals(depsFromB.length, 1);
  assertEquals(depsFromA[0].toCapabilityId, capB);
  assertEquals(depsFromB[0].toCapabilityId, capA);

  await db.close();
});

Deno.test("CapabilityDependency - getAllDependencies filters by confidence", async () => {
  const db = await setupTestDb();
  const model = new MockEmbeddingModel();
  const store = new CapabilityStore(db, model as any);

  const { capA, capB, capC } = await createTestCapabilities(store);

  // sequence + inferred = 0.35 (below threshold 0.4)
  await store.addDependency({
    fromCapabilityId: capA,
    toCapabilityId: capB,
    edgeType: "sequence",
  });

  // dependency + template = 0.5 (above threshold 0.4)
  await store.addDependency({
    fromCapabilityId: capA,
    toCapabilityId: capC,
    edgeType: "dependency",
    edgeSource: "template",
  });

  const allDeps = await store.getAllDependencies(0.4);
  assertEquals(allDeps.length, 1);
  assertEquals(allDeps[0].toCapabilityId, capC);

  await db.close();
});

Deno.test("CapabilityDependency - alternative edge type has correct weight", async () => {
  const db = await setupTestDb();
  const model = new MockEmbeddingModel();
  const store = new CapabilityStore(db, model as any);

  const { capA, capB } = await createTestCapabilities(store);

  const dep = await store.addDependency({
    fromCapabilityId: capA,
    toCapabilityId: capB,
    edgeType: "alternative",
  });

  // alternative (0.6) * inferred (0.7) = 0.42
  assertEquals(dep.edgeType, "alternative");
  assertEquals(dep.confidenceScore, 0.42);

  await db.close();
});

Deno.test("CapabilityDependency - searchByIntentWithDeps includes dependencies", async () => {
  const db = await setupTestDb();
  const model = new MockEmbeddingModel();
  const store = new CapabilityStore(db, model as any);

  const { capA, capB } = await createTestCapabilities(store);

  // Create dependency chain: A depends on B
  await store.addDependency({
    fromCapabilityId: capA,
    toCapabilityId: capB,
    edgeType: "dependency",
  });

  // Search for capability A
  const results = await store.searchByIntentWithDeps("Fetch data", 5, 0.1);

  // Should find capability A with its dependency B
  const fetchResult = results.find((r) => r.capability.id === capA);
  assertExists(fetchResult);
  assertEquals(fetchResult.dependencies.length, 1);
  assertEquals(fetchResult.dependencies[0].id, capB);

  await db.close();
});
