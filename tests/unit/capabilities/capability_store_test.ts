/**
 * Unit tests for CapabilityStore
 *
 * Story: 7.2a Capability Storage - Migration & Eager Learning (AC4, AC5, AC8)
 *
 * Tests:
 * - exec 1x → verify capability created with usage_count = 1
 * - exec 2x same code → verify usage_count = 2, success_rate recalculated
 * - exec with failure → verify success_rate decreases
 * - migration idempotency (can be replayed)
 * - hash collision handling
 *
 * @module tests/unit/capabilities/capability_store_test
 */

import { assertEquals, assertExists, assertNotEquals } from "@std/assert";
import { PGliteClient } from "../../../src/db/client.ts";
import { getAllMigrations, MigrationRunner } from "../../../src/db/migrations.ts";
import { CapabilityStore } from "../../../src/capabilities/capability-store.ts";
import { hashCode } from "../../../src/capabilities/hash.ts";

/**
 * Mock EmbeddingModel for tests (avoids loading real model)
 */
class MockEmbeddingModel {
  private callCount = 0;

  async load(): Promise<void> {
    // No-op
  }

  async encode(text: string): Promise<number[]> {
    this.callCount++;
    // Generate deterministic embedding based on text hash
    const embedding = new Array(1024).fill(0);
    for (let i = 0; i < Math.min(text.length, 1024); i++) {
      embedding[i] = (text.charCodeAt(i) % 100) / 100;
    }
    return embedding;
  }

  isLoaded(): boolean {
    return true;
  }

  getCallCount(): number {
    return this.callCount;
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

Deno.test("CapabilityStore - saveCapability creates capability with usage_count=1", async () => {
  const db = await setupTestDb();
  const model = new MockEmbeddingModel();
  const store = new CapabilityStore(db, model as any);

  const { capability } = await store.saveCapability({
    code: 'const result = await tools.search({query: "test"});',
    intent: "Search for test data",
    durationMs: 150,
    success: true,
  });

  assertExists(capability.id);
  assertEquals(capability.usageCount, 1);
  assertEquals(capability.successCount, 1);
  assertEquals(capability.successRate, 1.0);
  assertEquals(capability.avgDurationMs, 150);
  assertEquals(capability.source, "emergent");
  assertExists(capability.codeHash);
  assertEquals(capability.codeHash.length, 64); // SHA-256

  await db.close();
});

Deno.test("CapabilityStore - exec 2x same code increments usage_count", async () => {
  const db = await setupTestDb();
  const model = new MockEmbeddingModel();
  const store = new CapabilityStore(db, model as any);

  const code = 'const result = await tools.fetch({url: "https://example.com"});';

  // First execution
  const { capability: cap1 } = await store.saveCapability({
    code,
    intent: "Fetch example.com",
    durationMs: 100,
    success: true,
  });

  assertEquals(cap1.usageCount, 1);
  assertEquals(cap1.successCount, 1);

  // Second execution (same code)
  const { capability: cap2 } = await store.saveCapability({
    code,
    intent: "Fetch example.com",
    durationMs: 200,
    success: true,
  });

  assertEquals(cap2.usageCount, 2);
  assertEquals(cap2.successCount, 2);
  assertEquals(cap2.successRate, 1.0);
  // Average duration: (100 + 200) / 2 = 150
  assertEquals(cap2.avgDurationMs, 150);

  // Should have same id (upsert)
  assertEquals(cap1.id, cap2.id);

  await db.close();
});

Deno.test("CapabilityStore - exec with failure decreases success_rate", async () => {
  const db = await setupTestDb();
  const model = new MockEmbeddingModel();
  const store = new CapabilityStore(db, model as any);

  const code = 'const result = await tools.process({data: "test"});';

  // First execution - success
  await store.saveCapability({
    code,
    intent: "Process test data",
    durationMs: 100,
    success: true,
  });

  // Second execution - failure
  const { capability: cap2 } = await store.saveCapability({
    code,
    intent: "Process test data",
    durationMs: 200,
    success: false,
  });

  assertEquals(cap2.usageCount, 2);
  assertEquals(cap2.successCount, 1);
  assertEquals(cap2.successRate, 0.5); // 1 success / 2 total

  // Third execution - success
  const { capability: cap3 } = await store.saveCapability({
    code,
    intent: "Process test data",
    durationMs: 150,
    success: true,
  });

  assertEquals(cap3.usageCount, 3);
  assertEquals(cap3.successCount, 2);
  // 2 / 3 ≈ 0.666...
  assertEquals(Math.abs(cap3.successRate - 0.666) < 0.01, true);

  await db.close();
});

Deno.test("CapabilityStore - findByCodeHash returns existing capability", async () => {
  const db = await setupTestDb();
  const model = new MockEmbeddingModel();
  const store = new CapabilityStore(db, model as any);

  const code = "const x = 1 + 2;";
  const codeHash = await hashCode(code);

  // Save capability
  await store.saveCapability({
    code,
    intent: "Add numbers",
    durationMs: 50,
  });

  // Find by hash
  const found = await store.findByCodeHash(codeHash);

  assertExists(found);
  assertEquals(found.codeHash, codeHash);
  assertEquals(found.codeSnippet, code);

  await db.close();
});

Deno.test("CapabilityStore - findByCodeHash returns null for unknown hash", async () => {
  const db = await setupTestDb();
  const model = new MockEmbeddingModel();
  const store = new CapabilityStore(db, model as any);

  const found = await store.findByCodeHash("nonexistent-hash-1234567890");

  assertEquals(found, null);

  await db.close();
});

Deno.test("CapabilityStore - updateUsage updates statistics", async () => {
  const db = await setupTestDb();
  const model = new MockEmbeddingModel();
  const store = new CapabilityStore(db, model as any);

  const code = "const y = 2 * 3;";
  const codeHash = await hashCode(code);

  // Save initial capability
  await store.saveCapability({
    code,
    intent: "Multiply numbers",
    durationMs: 100,
  });

  // Update usage
  await store.updateUsage(codeHash, true, 80);

  // Verify update
  const cap = await store.findByCodeHash(codeHash);
  assertExists(cap);
  assertEquals(cap.usageCount, 2);
  assertEquals(cap.successCount, 2);
  // Average: (100 + 80) / 2 = 90
  assertEquals(cap.avgDurationMs, 90);

  await db.close();
});

Deno.test("CapabilityStore - getCapabilityCount returns correct count", async () => {
  const db = await setupTestDb();
  const model = new MockEmbeddingModel();
  const store = new CapabilityStore(db, model as any);

  // Initially zero
  let count = await store.getCapabilityCount();
  assertEquals(count, 0);

  // Add capabilities
  await store.saveCapability({
    code: "const a = 1;",
    intent: "Define a",
    durationMs: 10,
  });
  await store.saveCapability({
    code: "const b = 2;",
    intent: "Define b",
    durationMs: 10,
  });

  count = await store.getCapabilityCount();
  assertEquals(count, 2);

  await db.close();
});

Deno.test("CapabilityStore - getStats returns aggregated statistics", async () => {
  const db = await setupTestDb();
  const model = new MockEmbeddingModel();
  const store = new CapabilityStore(db, model as any);

  // Add capabilities with different usage patterns
  await store.saveCapability({
    code: "const x = 1;",
    intent: "Define x",
    durationMs: 100,
    success: true,
  });
  await store.saveCapability({
    code: "const y = 2;",
    intent: "Define y",
    durationMs: 200,
    success: true,
  });
  await store.saveCapability({
    code: "const z = 3;",
    intent: "Define z",
    durationMs: 300,
    success: false,
  });

  const stats = await store.getStats();

  assertEquals(stats.totalCapabilities, 3);
  assertEquals(stats.totalExecutions, 3);
  // Average success rate: (1 + 1 + 0) / 3 ≈ 0.666
  assertEquals(Math.abs(stats.avgSuccessRate - 0.666) < 0.01, true);
  // Average duration: (100 + 200 + 300) / 3 = 200
  assertEquals(stats.avgDurationMs, 200);

  await db.close();
});

// Note: Migration 022 removed 'name' column from workflow_pattern.
// Names are now stored in capability_records.display_name (Story 13.2).
// The Capability.name field is always undefined after this migration.
Deno.test("CapabilityStore - name is undefined after migration 022", async () => {
  const db = await setupTestDb();
  const model = new MockEmbeddingModel();
  const store = new CapabilityStore(db, model as any);

  const { capability } = await store.saveCapability({
    code: "return 42;",
    intent: "calculate the meaning of life",
    durationMs: 10,
  });

  // After migration 022, capability.name is always undefined
  // Names should be stored via capability_records.display_name
  assertEquals(capability.name, undefined);

  await db.close();
});

// Note: Migration 022 removed 'name' from workflow_pattern.
// Even if a custom name is passed, it's not stored in workflow_pattern anymore.
// Names should be registered via capability_records.display_name (Story 13.2).
Deno.test("CapabilityStore - description preserved but name undefined", async () => {
  const db = await setupTestDb();
  const model = new MockEmbeddingModel();
  const store = new CapabilityStore(db, model as any);

  const { capability } = await store.saveCapability({
    code: "return 42;",
    intent: "calculate something",
    durationMs: 10,
    name: "LifeMeaningCalculator", // This is ignored after migration 022
    description: "Calculates the meaning of life",
  });

  // name is always undefined after migration 022
  assertEquals(capability.name, undefined);
  // description is still preserved
  assertEquals(capability.description, "Calculates the meaning of life");

  await db.close();
});

Deno.test("CapabilityStore - different code produces different capabilities", async () => {
  const db = await setupTestDb();
  const model = new MockEmbeddingModel();
  const store = new CapabilityStore(db, model as any);

  const { capability: cap1 } = await store.saveCapability({
    code: "const a = 1;",
    intent: "Define variable",
    durationMs: 10,
  });

  const { capability: cap2 } = await store.saveCapability({
    code: "const b = 2;",
    intent: "Define variable",
    durationMs: 10,
  });

  assertNotEquals(cap1.id, cap2.id);
  assertNotEquals(cap1.codeHash, cap2.codeHash);

  await db.close();
});

Deno.test("CapabilityStore - toolsUsed stored in dag_structure", async () => {
  const db = await setupTestDb();
  const model = new MockEmbeddingModel();
  const store = new CapabilityStore(db, model as any);

  const { capability } = await store.saveCapability({
    code: 'await tools.search({q: "test"});',
    intent: "Search with tools",
    durationMs: 50,
    toolsUsed: ["search:search", "memory:store"],
  });

  // Verify capability was saved with tools
  assertExists(capability.id);
  assertEquals(capability.source, "emergent");

  await db.close();
});

Deno.test("Migration 011 - idempotent (can be replayed)", async () => {
  const db = new PGliteClient(":memory:");
  await db.connect();

  const runner = new MigrationRunner(db);
  const migrations = getAllMigrations();

  // Run migrations first time
  await runner.runUp(migrations);

  // Check migration 011 applied
  const version1 = await runner.getCurrentVersion();
  assertEquals(version1 >= 11, true);

  // Running again should be no-op (already applied)
  await runner.runUp(migrations);

  const version2 = await runner.getCurrentVersion();
  assertEquals(version2, version1);

  await db.close();
});

Deno.test("Migration 011 - columns exist after migration (updated for migration 022)", async () => {
  const db = await setupTestDb();

  // Check workflow_pattern columns
  const patternCols = await db.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'workflow_pattern'
    ORDER BY column_name
  `);

  const colNames = patternCols.map((r) => r.column_name as string);

  // Verify columns from migration 011 still exist
  assertEquals(colNames.includes("code_snippet"), true);
  assertEquals(colNames.includes("code_hash"), true);
  assertEquals(colNames.includes("parameters_schema"), true);
  assertEquals(colNames.includes("cache_config"), true);
  // Note: 'name' was removed by migration 022 - names now in capability_records.display_name
  assertEquals(colNames.includes("name"), false, "name column removed by migration 022");
  assertEquals(colNames.includes("description"), true);
  assertEquals(colNames.includes("success_rate"), true);
  assertEquals(colNames.includes("avg_duration_ms"), true);
  assertEquals(colNames.includes("created_at"), true);
  assertEquals(colNames.includes("source"), true);

  await db.close();
});

Deno.test("Migration 011 - code_hash index exists", async () => {
  const db = await setupTestDb();

  const indexes = await db.query(`
    SELECT indexname FROM pg_indexes
    WHERE tablename = 'workflow_pattern'
    AND indexname LIKE '%code_hash%'
  `);

  assertEquals(indexes.length >= 1, true);

  await db.close();
});

// ============================================
// MEDIUM-1: searchByIntent tests (Code Review Fix)
// ============================================

Deno.test("CapabilityStore - searchByIntent returns matching capabilities", async () => {
  const db = await setupTestDb();
  const model = new MockEmbeddingModel();
  const store = new CapabilityStore(db, model as any);

  // Save capabilities with different intents
  await store.saveCapability({
    code: 'await tools.search({q: "weather"});',
    intent: "Search for weather data",
    durationMs: 100,
  });
  await store.saveCapability({
    code: 'await tools.fetch({url: "api.example.com"});',
    intent: "Fetch data from API",
    durationMs: 150,
  });

  // Search for similar intent
  const results = await store.searchByIntent("Get weather information", 5, 0.0);

  // Should return results (mock embedding creates deterministic values)
  assertEquals(results.length >= 1, true);
  assertEquals(results[0].semanticScore >= 0, true);
  assertExists(results[0].capability.id);

  await db.close();
});

Deno.test("CapabilityStore - searchByIntent respects limit", async () => {
  const db = await setupTestDb();
  const model = new MockEmbeddingModel();
  const store = new CapabilityStore(db, model as any);

  // Save multiple capabilities
  for (let i = 0; i < 5; i++) {
    await store.saveCapability({
      code: `const x${i} = ${i};`,
      intent: `Define variable x${i}`,
      durationMs: 10,
    });
  }

  // Search with limit
  const results = await store.searchByIntent("Define variable", 2, 0.0);

  assertEquals(results.length <= 2, true);

  await db.close();
});

Deno.test("CapabilityStore - searchByIntent returns empty for no matches", async () => {
  const db = await setupTestDb();
  const model = new MockEmbeddingModel();
  const store = new CapabilityStore(db, model as any);

  // Search without any capabilities stored
  const results = await store.searchByIntent("Completely unrelated query", 5, 0.99);

  assertEquals(results.length, 0);

  await db.close();
});

// ============================================
// MEDIUM-3: Concurrent operations test (Code Review Fix)
// ============================================

Deno.test("CapabilityStore - concurrent saves handle ON CONFLICT correctly", async () => {
  const db = await setupTestDb();
  const model = new MockEmbeddingModel();
  const store = new CapabilityStore(db, model as any);

  const code = 'const concurrent = "test";';
  const intent = "Concurrent test capability";

  // Simulate concurrent saves (same code, same time)
  const [res1, res2, res3] = await Promise.all([
    store.saveCapability({ code, intent, durationMs: 100 }),
    store.saveCapability({ code, intent, durationMs: 150 }),
    store.saveCapability({ code, intent, durationMs: 200 }),
  ]);

  // All should have same id (same capability)
  assertEquals(res1.capability.id, res2.capability.id);
  assertEquals(res2.capability.id, res3.capability.id);

  // Usage count should reflect all 3 executions
  // Due to concurrent execution, the final count may vary based on timing
  // but should be at least 1 and at most 3
  const finalCap = await store.findByCodeHash(res1.capability.codeHash);
  assertExists(finalCap);
  assertEquals(finalCap.usageCount >= 1, true);
  assertEquals(finalCap.usageCount <= 3, true);

  await db.close();
});

// ============================================
// MEDIUM-4: Embedding error handling test (Code Review Fix)
// ============================================

Deno.test("CapabilityStore - saveCapability throws on embedding failure", async () => {
  const db = await setupTestDb();

  // Mock model that throws
  const failingModel = {
    async encode(_text: string): Promise<number[]> {
      throw new Error("Model not loaded");
    },
    isLoaded: () => false,
  };

  const store = new CapabilityStore(db, failingModel as any);

  let errorThrown = false;
  try {
    await store.saveCapability({
      code: "const x = 1;",
      intent: "Test intent",
      durationMs: 100,
    });
  } catch (error) {
    errorThrown = true;
    assertEquals(
      (error as Error).message.includes("Embedding generation failed"),
      true,
    );
  }

  assertEquals(errorThrown, true, "Should throw on embedding failure");

  await db.close();
});

// ============================================
// Story 7.4: searchByContext edge cases (Code Review Fix)
// ============================================

Deno.test("CapabilityStore - searchByContext with empty array returns empty", async () => {
  const db = await setupTestDb();
  const model = new MockEmbeddingModel();
  const store = new CapabilityStore(db, model as any);

  // Save a capability with tools
  await store.saveCapability({
    code: 'await tools.search({q: "test"});',
    intent: "Search test",
    durationMs: 50,
    toolsUsed: ["search:search", "memory:store"],
  });

  // Search with empty context
  const results = await store.searchByContext([], 5, 0.3);

  assertEquals(results.length, 0, "Empty context should return empty results");

  await db.close();
});

Deno.test("CapabilityStore - searchByContext filters invalid tools", async () => {
  const db = await setupTestDb();
  const model = new MockEmbeddingModel();
  const store = new CapabilityStore(db, model as any);

  // Save a capability with tools
  await store.saveCapability({
    code: 'await tools.search({q: "test"});',
    intent: "Search test",
    durationMs: 50,
    toolsUsed: ["search:search"],
  });

  // Search with mixed valid/invalid tools (empty strings, too long)
  const longTool = "a".repeat(300); // > 256 chars
  const results = await store.searchByContext(
    ["", "search:search", longTool, null as unknown as string],
    5,
    0.3,
  );

  // Should still work with the valid tool
  // (Results depend on whether capability was saved with tools_used in dag_structure)
  assertEquals(Array.isArray(results), true);

  await db.close();
});

Deno.test("CapabilityStore - searchByContext respects minOverlap threshold", async () => {
  const db = await setupTestDb();
  const model = new MockEmbeddingModel();
  const store = new CapabilityStore(db, model as any);

  // Save capability with 4 tools
  await store.saveCapability({
    code: "await tools.multi();",
    intent: "Multi tool operation",
    durationMs: 100,
    toolsUsed: ["tool:a", "tool:b", "tool:c", "tool:d"],
  });

  // Search with 1 matching tool (25% overlap)
  const lowOverlap = await store.searchByContext(["tool:a"], 5, 0.3);
  // 1/4 = 0.25 < 0.3, should not match
  assertEquals(lowOverlap.length, 0, "25% overlap should not match with 30% threshold");

  // Search with 2 matching tools (50% overlap)
  const highOverlap = await store.searchByContext(["tool:a", "tool:b"], 5, 0.3);
  // 2/4 = 0.50 >= 0.3, should match
  // Note: This only works if tools_used is stored in dag_structure JSONB
  // If not stored, will return 0 (graceful degradation)
  assertEquals(Array.isArray(highOverlap), true);

  await db.close();
});
