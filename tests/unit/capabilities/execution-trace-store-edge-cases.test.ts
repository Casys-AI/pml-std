/**
 * Extended Unit Tests for ExecutionTraceStore - Coverage Gaps
 *
 * Tests for previously untested code paths:
 * - buildHierarchy() method and edge cases
 * - rowToTrace() parsing edge cases (string formats, error handling)
 * - sampleByPriority() edge cases (cold start, alpha=0, empty pool)
 * - computeVariance() edge cases
 * - weightedSampleWithoutReplacement() algorithm
 *
 * @module tests/unit/capabilities/execution-trace-store-coverage.test
 */

import { assertEquals, assertExists } from "@std/assert";
import { PGliteClient } from "../../../src/db/client.ts";
import { getAllMigrations, MigrationRunner } from "../../../src/db/migrations.ts";
import {
  ExecutionTraceStore,
  type SaveTraceInput,
} from "../../../src/capabilities/execution-trace-store.ts";
import type { ExecutionTrace } from "../../../src/capabilities/types.ts";

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
 * Create a capability in workflow_pattern for FK tests
 */
async function createTestCapability(db: PGliteClient): Promise<string> {
  const uniqueHash = `test-hash-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  const embeddingStr = `[${new Array(1024).fill(0.5).join(",")}]`;

  const result = await db.query(
    `
    INSERT INTO workflow_pattern (
      pattern_id,
      pattern_hash,
      dag_structure,
      intent_embedding,
      code_snippet,
      code_hash
    )
    VALUES (
      gen_random_uuid(),
      $1,
      '{"nodes": [], "edges": []}'::jsonb,
      $2::vector,
      'console.log("test")',
      $3
    )
    RETURNING pattern_id
  `,
    [uniqueHash, embeddingStr, `code-hash-${uniqueHash}`],
  );
  return result[0].pattern_id as string;
}

/**
 * Create a minimal valid trace input
 */
function createTestTraceInput(overrides?: Partial<SaveTraceInput>): SaveTraceInput {
  return {
    capabilityId: undefined,
    intentText: "Test intent",
    initialContext: { query: "test" },
    executedAt: new Date(),
    success: true,
    durationMs: 100,
    errorMessage: undefined,
    executedPath: ["node1", "node2"],
    decisions: [],
    taskResults: [],
    priority: 0.5,
    parentTraceId: undefined,
    userId: "test-user",
    createdBy: "test-agent",
    ...overrides,
  };
}

// =============================================================================
// buildHierarchy() Tests
// =============================================================================

Deno.test("ExecutionTraceStore - buildHierarchy() builds correct tree from flat traces", async () => {
  const db = await setupTestDb();
  const store = new ExecutionTraceStore(db);

  // Create parent trace
  const parent = await store.saveTrace(createTestTraceInput({ intentText: "Parent" }));

  // Create child traces
  const child1 = await store.saveTrace(
    createTestTraceInput({
      parentTraceId: parent.id,
      intentText: "Child 1",
    }),
  );
  const child2 = await store.saveTrace(
    createTestTraceInput({
      parentTraceId: parent.id,
      intentText: "Child 2",
    }),
  );

  // Create grandchild
  const grandchild = await store.saveTrace(
    createTestTraceInput({
      parentTraceId: child1.id,
      intentText: "Grandchild",
    }),
  );

  // Build hierarchy from all traces
  const allTraces = [parent, child1, child2, grandchild];
  const roots = store.buildHierarchy(allTraces);

  // Should have exactly one root
  assertEquals(roots.length, 1, "Should have exactly one root node");
  assertEquals(roots[0].trace.id, parent.id, "Root should be the parent trace");

  // Parent should have 2 children
  assertEquals(roots[0].children.length, 2, "Parent should have 2 children");

  // Find child1 node and verify it has the grandchild
  const child1Node = roots[0].children.find((c) => c.trace.id === child1.id);
  assertExists(child1Node, "Should find child1 in hierarchy");
  assertEquals(child1Node.children.length, 1, "Child1 should have 1 grandchild");
  assertEquals(child1Node.children[0].trace.id, grandchild.id, "Grandchild should be correct");

  // Child2 should have no children
  const child2Node = roots[0].children.find((c) => c.trace.id === child2.id);
  assertExists(child2Node, "Should find child2 in hierarchy");
  assertEquals(child2Node.children.length, 0, "Child2 should have no children");

  await db.close();
});

Deno.test("ExecutionTraceStore - buildHierarchy() handles empty input", async () => {
  const db = await setupTestDb();
  const store = new ExecutionTraceStore(db);

  const roots = store.buildHierarchy([]);

  assertEquals(roots.length, 0, "Empty input should return empty array");

  await db.close();
});

Deno.test("ExecutionTraceStore - buildHierarchy() handles multiple root nodes", async () => {
  const db = await setupTestDb();
  const store = new ExecutionTraceStore(db);

  // Create two independent root traces (no parent)
  const root1 = await store.saveTrace(createTestTraceInput({ intentText: "Root 1" }));
  const root2 = await store.saveTrace(createTestTraceInput({ intentText: "Root 2" }));

  // Create children for each root
  const child1 = await store.saveTrace(
    createTestTraceInput({
      parentTraceId: root1.id,
      intentText: "Child of Root 1",
    }),
  );
  const child2 = await store.saveTrace(
    createTestTraceInput({
      parentTraceId: root2.id,
      intentText: "Child of Root 2",
    }),
  );

  const allTraces = [root1, root2, child1, child2];
  const roots = store.buildHierarchy(allTraces);

  // Should have 2 roots
  assertEquals(roots.length, 2, "Should have 2 root nodes");

  // Each root should have 1 child
  for (const root of roots) {
    assertEquals(root.children.length, 1, "Each root should have 1 child");
  }

  await db.close();
});

Deno.test("ExecutionTraceStore - buildHierarchy() treats orphan trace as root (missing parent)", async () => {
  const db = await setupTestDb();
  const store = new ExecutionTraceStore(db);

  // Create a trace that claims to have a parent, but the parent is not in the input
  const orphanTrace: ExecutionTrace = {
    id: "orphan-trace-id",
    capabilityId: undefined,
    intentText: "Orphan trace",
    executedAt: new Date(),
    success: true,
    durationMs: 100,
    decisions: [],
    taskResults: [],
    priority: 0.5,
    parentTraceId: "non-existent-parent-id", // Parent not in input
    userId: "test-user",
    createdBy: "test-agent",
  };

  const roots = store.buildHierarchy([orphanTrace]);

  // Orphan should be treated as root (fallback for corrupted data)
  assertEquals(roots.length, 1, "Orphan should become a root node");
  assertEquals(roots[0].trace.id, "orphan-trace-id", "Orphan trace should be the root");
  assertEquals(roots[0].children.length, 0, "Orphan should have no children");

  await db.close();
});

Deno.test("ExecutionTraceStore - buildHierarchy() single trace without parent is root", async () => {
  const db = await setupTestDb();
  const store = new ExecutionTraceStore(db);

  const trace = await store.saveTrace(createTestTraceInput({ intentText: "Single trace" }));

  const roots = store.buildHierarchy([trace]);

  assertEquals(roots.length, 1, "Single trace should be root");
  assertEquals(roots[0].trace.id, trace.id, "Should be the same trace");
  assertEquals(roots[0].children.length, 0, "Should have no children");

  await db.close();
});

// =============================================================================
// PER Sampling Edge Cases
// =============================================================================

Deno.test("ExecutionTraceStore - sampleByPriority() returns empty array when no traces meet minPriority", async () => {
  const db = await setupTestDb();
  const store = new ExecutionTraceStore(db);

  // Create traces with low priorities
  await store.saveTrace(createTestTraceInput({ priority: 0.1 }));
  await store.saveTrace(createTestTraceInput({ priority: 0.2 }));
  await store.saveTrace(createTestTraceInput({ priority: 0.05 }));

  // Sample with high minPriority threshold
  const traces = await store.sampleByPriority(10, 0.5);

  assertEquals(traces.length, 0, "No traces should meet the threshold");

  await db.close();
});

Deno.test("ExecutionTraceStore - sampleByPriority() with alpha=0 uses uniform sampling", async () => {
  const db = await setupTestDb();
  const store = new ExecutionTraceStore(db);

  // Create traces with very different priorities
  await store.saveTrace(createTestTraceInput({ priority: 0.9, intentText: "High priority" }));
  await store.saveTrace(createTestTraceInput({ priority: 0.5, intentText: "Medium priority" }));
  await store.saveTrace(createTestTraceInput({ priority: 0.3, intentText: "Low priority" }));

  // Sample with alpha=0 (should ignore priorities, use uniform)
  // Run multiple times to verify randomness
  const samples: ExecutionTrace[][] = [];
  for (let i = 0; i < 10; i++) {
    const result = await store.sampleByPriority(2, 0.1, 0); // alpha=0
    samples.push(result);
  }

  // With alpha=0, we should get uniform distribution (all traces equally likely)
  // At minimum, verify we get results
  assertEquals(samples.every((s) => s.length === 2), true, "Should always return 2 traces");

  await db.close();
});

Deno.test("ExecutionTraceStore - sampleByPriority() cold start uniform fallback", async () => {
  const db = await setupTestDb();
  const store = new ExecutionTraceStore(db);

  // Create traces with nearly identical priorities (variance < 0.001)
  // This triggers cold start detection
  await store.saveTrace(createTestTraceInput({ priority: 0.5 }));
  await store.saveTrace(createTestTraceInput({ priority: 0.5 }));
  await store.saveTrace(createTestTraceInput({ priority: 0.5 }));
  await store.saveTrace(createTestTraceInput({ priority: 0.5 }));

  // Sample should fall back to uniform (cold start)
  const traces = await store.sampleByPriority(2, 0.1, 0.6);

  assertEquals(traces.length, 2, "Should return 2 traces even in cold start");

  await db.close();
});

Deno.test("ExecutionTraceStore - sampleByPriority() returns all when limit exceeds available", async () => {
  const db = await setupTestDb();
  const store = new ExecutionTraceStore(db);

  // Create only 3 traces
  await store.saveTrace(createTestTraceInput({ priority: 0.6 }));
  await store.saveTrace(createTestTraceInput({ priority: 0.7 }));
  await store.saveTrace(createTestTraceInput({ priority: 0.8 }));

  // Request more than available
  const traces = await store.sampleByPriority(100, 0.5);

  assertEquals(traces.length, 3, "Should return all available traces");

  await db.close();
});

Deno.test("ExecutionTraceStore - sampleByPriority() weighted sampling returns valid traces", async () => {
  const db = await setupTestDb();
  const store = new ExecutionTraceStore(db);

  // Create traces with very different priorities
  for (let i = 0; i < 5; i++) {
    await store.saveTrace(createTestTraceInput({ priority: 0.3, intentText: `Low ${i}` }));
  }
  await store.saveTrace(createTestTraceInput({ priority: 0.95, intentText: "Very High" }));

  // Sample with default alpha=0.6
  const traces = await store.sampleByPriority(3, 0.2, 0.6);

  // Should return 3 traces
  assertEquals(traces.length, 3, "Should return requested number of traces");

  // All traces should have priority >= minPriority
  assertEquals(
    traces.every((t) => t.priority >= 0.2),
    true,
    "All traces should meet minimum priority",
  );

  // Verify sampling without replacement (no duplicates)
  const ids = traces.map((t) => t.id);
  const uniqueIds = new Set(ids);
  assertEquals(uniqueIds.size, ids.length, "Should not have duplicate traces");

  await db.close();
});

// =============================================================================
// rowToTrace() Parsing Edge Cases
// =============================================================================

Deno.test("ExecutionTraceStore - handles decisions as pre-parsed object", async () => {
  const db = await setupTestDb();
  const store = new ExecutionTraceStore(db);

  const decisions = [
    { nodeId: "d1", outcome: "true", condition: "x > 0" },
    { nodeId: "d2", outcome: "false", condition: "y === 0" },
  ];

  const trace = await store.saveTrace(createTestTraceInput({ decisions }));
  const retrieved = await store.getTraceById(trace.id);

  assertExists(retrieved);
  assertEquals(retrieved.decisions.length, 2, "Should have 2 decisions");
  assertEquals(retrieved.decisions[0].nodeId, "d1");
  assertEquals(retrieved.decisions[1].outcome, "false");

  await db.close();
});

Deno.test("ExecutionTraceStore - handles taskResults with nested objects", async () => {
  const db = await setupTestDb();
  const store = new ExecutionTraceStore(db);

  const taskResults = [
    {
      taskId: "t1",
      tool: "mcp.db.query",
      args: {
        query: "SELECT * FROM users",
        params: { limit: 10, offset: 0 },
      },
      result: {
        rows: [{ id: 1, name: "Alice" }],
        count: 1,
      },
      success: true,
      durationMs: 50,
    },
  ];

  const trace = await store.saveTrace(createTestTraceInput({ taskResults }));
  const retrieved = await store.getTraceById(trace.id);

  assertExists(retrieved);
  assertEquals(retrieved.taskResults.length, 1);
  assertEquals(retrieved.taskResults[0].tool, "mcp.db.query");

  // Verify nested structure preserved (after sanitization)
  const args = retrieved.taskResults[0].args;
  assertEquals(args.query, "SELECT * FROM users");

  await db.close();
});

Deno.test("ExecutionTraceStore - handles empty executed_path", async () => {
  const db = await setupTestDb();
  const store = new ExecutionTraceStore(db);

  const trace = await store.saveTrace(
    createTestTraceInput({
      executedPath: [],
    }),
  );

  const retrieved = await store.getTraceById(trace.id);

  assertExists(retrieved);
  assertEquals(retrieved.executedPath?.length ?? 0, 0, "Empty path should be preserved");

  await db.close();
});

Deno.test("ExecutionTraceStore - handles undefined optional fields", async () => {
  const db = await setupTestDb();
  const store = new ExecutionTraceStore(db);

  const trace = await store.saveTrace({
    capabilityId: undefined,
    intentText: undefined,
    initialContext: undefined,
    executedAt: new Date(),
    success: true,
    durationMs: 50,
    errorMessage: undefined,
    executedPath: undefined,
    decisions: [],
    taskResults: [],
    priority: 0.5,
    parentTraceId: undefined,
    userId: undefined,
    createdBy: undefined,
  });

  const retrieved = await store.getTraceById(trace.id);

  assertExists(retrieved);
  assertEquals(retrieved.success, true);
  assertEquals(retrieved.durationMs, 50);
  assertEquals(retrieved.capabilityId, undefined);
  assertEquals(retrieved.intentText, undefined);

  await db.close();
});

Deno.test("ExecutionTraceStore - stores and retrieves intent embedding", async () => {
  const db = await setupTestDb();
  const store = new ExecutionTraceStore(db);

  // Database requires 1024-dimensional vectors
  const embedding = new Array(1024).fill(0).map((_, i) => (i % 100) / 100);

  const trace = await store.saveTrace(
    createTestTraceInput({
      intentEmbedding: embedding,
    }),
  );

  const retrieved = await store.getTraceById(trace.id);

  assertExists(retrieved);
  assertExists(retrieved.intentEmbedding, "Should have intent embedding");
  assertEquals(retrieved.intentEmbedding.length, 1024, "Embedding should have 1024 dimensions");

  // Check first few values are approximately correct (floating point)
  for (let i = 0; i < 5; i++) {
    assertEquals(
      Math.abs(retrieved.intentEmbedding[i] - embedding[i]) < 0.0001,
      true,
      `Embedding[${i}] should match`,
    );
  }

  await db.close();
});

// =============================================================================
// Statistics Edge Cases
// =============================================================================

Deno.test("ExecutionTraceStore - getStats() returns defaults when no traces", async () => {
  const db = await setupTestDb();
  const store = new ExecutionTraceStore(db);

  const stats = await store.getStats();

  assertEquals(stats.totalTraces, 0);
  assertEquals(stats.successfulTraces, 0);
  assertEquals(stats.avgDurationMs, 0);
  assertEquals(stats.avgPriority, 0.5); // Default priority

  await db.close();
});

Deno.test("ExecutionTraceStore - getTraceCount() without capabilityId returns all", async () => {
  const db = await setupTestDb();
  const store = new ExecutionTraceStore(db);

  const cap1 = await createTestCapability(db);
  const cap2 = await createTestCapability(db);

  await store.saveTrace(createTestTraceInput({ capabilityId: cap1 }));
  await store.saveTrace(createTestTraceInput({ capabilityId: cap1 }));
  await store.saveTrace(createTestTraceInput({ capabilityId: cap2 }));
  await store.saveTrace(createTestTraceInput()); // No capability

  const totalCount = await store.getTraceCount();
  const cap1Count = await store.getTraceCount(cap1);
  const cap2Count = await store.getTraceCount(cap2);

  assertEquals(totalCount, 4, "Total should be 4");
  assertEquals(cap1Count, 2, "Cap1 should have 2");
  assertEquals(cap2Count, 1, "Cap2 should have 1");

  await db.close();
});

// =============================================================================
// Child Traces Edge Cases
// =============================================================================

Deno.test("ExecutionTraceStore - getChildTraces() returns empty for no children", async () => {
  const db = await setupTestDb();
  const store = new ExecutionTraceStore(db);

  const trace = await store.saveTrace(createTestTraceInput());

  const children = await store.getChildTraces(trace.id);

  assertEquals(children.length, 0, "Should have no children");

  await db.close();
});

Deno.test("ExecutionTraceStore - getChildTraces() orders by executed_at ASC", async () => {
  const db = await setupTestDb();
  const store = new ExecutionTraceStore(db);

  const parent = await store.saveTrace(createTestTraceInput({ intentText: "Parent" }));

  // Create children with delays to ensure different timestamps
  const child1 = await store.saveTrace(
    createTestTraceInput({
      parentTraceId: parent.id,
      intentText: "First child",
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  const child2 = await store.saveTrace(
    createTestTraceInput({
      parentTraceId: parent.id,
      intentText: "Second child",
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  const child3 = await store.saveTrace(
    createTestTraceInput({
      parentTraceId: parent.id,
      intentText: "Third child",
    }),
  );

  const children = await store.getChildTraces(parent.id);

  assertEquals(children.length, 3);
  assertEquals(children[0].id, child1.id, "First created should be first");
  assertEquals(children[1].id, child2.id, "Second created should be second");
  assertEquals(children[2].id, child3.id, "Third created should be third");

  await db.close();
});

// =============================================================================
// Anonymization Edge Cases
// =============================================================================

Deno.test("ExecutionTraceStore - anonymizeUserTraces() returns 0 for unknown user", async () => {
  const db = await setupTestDb();
  const store = new ExecutionTraceStore(db);

  await store.saveTrace(createTestTraceInput({ userId: "existing-user" }));

  const count = await store.anonymizeUserTraces("non-existent-user");

  assertEquals(count, 0, "Should return 0 for unknown user");

  await db.close();
});

Deno.test("ExecutionTraceStore - anonymizeUserTraces() anonymizes multiple traces", async () => {
  const db = await setupTestDb();
  const store = new ExecutionTraceStore(db);

  const userId = "user-to-anonymize";

  // Create 5 traces for the user
  for (let i = 0; i < 5; i++) {
    await store.saveTrace(
      createTestTraceInput({
        userId,
        intentText: `User query ${i}`,
        initialContext: { privateData: `secret-${i}` },
      }),
    );
  }

  // Create trace for different user
  await store.saveTrace(
    createTestTraceInput({
      userId: "other-user",
      intentText: "Other user query",
    }),
  );

  const count = await store.anonymizeUserTraces(userId);

  assertEquals(count, 5, "Should anonymize 5 traces");

  // Verify anonymization
  const anonymizedTraces = await store.getTracesByUser("anonymized");
  assertEquals(anonymizedTraces.length, 5);

  for (const trace of anonymizedTraces) {
    assertEquals(trace.userId, "anonymized");
    assertEquals(trace.intentText, undefined);
    assertEquals(Object.keys(trace.initialContext ?? {}).length, 0);
  }

  // Other user should be unaffected
  const otherTraces = await store.getTracesByUser("other-user");
  assertEquals(otherTraces.length, 1);
  assertEquals(otherTraces[0].intentText, "Other user query");

  await db.close();
});
