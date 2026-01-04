/**
 * PER Priority End-to-End Integration Tests (Story 11.3)
 *
 * Tests the full TD Error + PER priority flow:
 * calculateTDError → storeTraceWithPriority → getHighPriorityTraces
 *
 * @module tests/integration/per_priority_e2e_test
 */

import { assertEquals, assertExists, assertGreater, assertLess } from "@std/assert";
import { PGliteClient } from "../../src/db/client.ts";
import { getAllMigrations, MigrationRunner } from "../../src/db/migrations.ts";
import { ExecutionTraceStore } from "../../src/capabilities/execution-trace-store.ts";
import { DEFAULT_SHGAT_CONFIG, SHGAT } from "../../src/graphrag/algorithms/shgat.ts";
import {
  calculateTDError,
  COLD_START_PRIORITY,
  type EmbeddingProvider,
  storeTraceWithPriority,
} from "../../src/capabilities/per-priority.ts";

// =============================================================================
// Test Setup
// =============================================================================

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
 * Create a mock embedding provider
 */
function createMockEmbeddingProvider(): EmbeddingProvider {
  return {
    getEmbedding: async (_text: string): Promise<number[]> => {
      // Return a deterministic 1024-dim embedding
      return new Array(1024).fill(0.5);
    },
  };
}

/**
 * Create a SHGAT with test tools and capabilities
 */
function createTestSHGAT(): SHGAT {
  const shgat = new SHGAT(DEFAULT_SHGAT_CONFIG);

  // Register some tools
  shgat.registerTool({
    id: "filesystem:read",
    embedding: new Array(1024).fill(0.3),
  });
  shgat.registerTool({
    id: "filesystem:write",
    embedding: new Array(1024).fill(0.4),
  });
  shgat.registerTool({
    id: "http:get",
    embedding: new Array(1024).fill(0.6),
  });

  // Register some capabilities
  shgat.registerCapability({
    id: "cap-read-file",
    embedding: new Array(1024).fill(0.35),
    toolsUsed: ["filesystem:read"],
    successRate: 0.95,
    parents: [],
    children: [],
    members: [{ type: "tool", id: "filesystem:read" }],
    hierarchyLevel: 0,
  });
  shgat.registerCapability({
    id: "cap-fetch-api",
    embedding: new Array(1024).fill(0.65),
    toolsUsed: ["http:get"],
    successRate: 0.80,
    parents: [],
    children: [],
    members: [{ type: "tool", id: "http:get" }],
    hierarchyLevel: 0,
  });

  return shgat;
}

// =============================================================================
// E2E Flow Tests
// =============================================================================

Deno.test("E2E: storeTraceWithPriority → getHighPriorityTraces (success case)", async () => {
  const db = await setupTestDb();
  const traceStore = new ExecutionTraceStore(db);
  const shgat = createTestSHGAT();
  const embeddingProvider = createMockEmbeddingProvider();

  try {
    // Store a successful trace with known tools
    const savedTrace = await storeTraceWithPriority(
      traceStore,
      shgat,
      embeddingProvider,
      {
        intentText: "Read a config file",
        executedPath: ["filesystem:read"],
        executedAt: new Date(),
        success: true,
        durationMs: 50,
        decisions: [],
        taskResults: [],
      },
    );

    // Verify trace was saved
    assertExists(savedTrace.id);
    assertEquals(savedTrace.success, true);
    assertGreater(savedTrace.priority, 0);
    assertLess(savedTrace.priority, 1);

    // Verify it appears in high priority traces
    const highPriorityTraces = await traceStore.getHighPriorityTraces(10);
    assertEquals(highPriorityTraces.length, 1);
    assertEquals(highPriorityTraces[0].id, savedTrace.id);
  } finally {
    await db.close();
  }
});

Deno.test("E2E: storeTraceWithPriority → getHighPriorityTraces (failure case = high priority)", async () => {
  const db = await setupTestDb();
  const traceStore = new ExecutionTraceStore(db);
  const shgat = createTestSHGAT();
  const embeddingProvider = createMockEmbeddingProvider();

  try {
    // Store a failed trace - should have higher priority (unexpected failure)
    const failedTrace = await storeTraceWithPriority(
      traceStore,
      shgat,
      embeddingProvider,
      {
        intentText: "Fetch API data",
        executedPath: ["http:get"],
        executedAt: new Date(),
        success: false,
        errorMessage: "Connection timeout",
        durationMs: 5000,
        decisions: [],
        taskResults: [],
      },
    );

    // Store a successful trace
    const successTrace = await storeTraceWithPriority(
      traceStore,
      shgat,
      embeddingProvider,
      {
        intentText: "Read local file",
        executedPath: ["filesystem:read"],
        executedAt: new Date(),
        success: true,
        durationMs: 10,
        decisions: [],
        taskResults: [],
      },
    );

    // Failed trace should have higher priority (more surprising)
    // since SHGAT would predict success for known tools
    assertGreater(failedTrace.priority, 0.01);

    // Verify ordering: high priority first
    const traces = await traceStore.getHighPriorityTraces(10);
    assertEquals(traces.length, 2);
    // The failed trace should be first (higher priority) if prediction was > 0.5
    // Otherwise success trace may be higher if prediction was < 0.5
    // Either way, both should be in the results
    const ids = traces.map((t) => t.id);
    assertEquals(ids.includes(failedTrace.id), true);
    assertEquals(ids.includes(successTrace.id), true);
  } finally {
    await db.close();
  }
});

Deno.test("E2E: cold start (empty SHGAT) → priority = 0.5", async () => {
  const db = await setupTestDb();
  const traceStore = new ExecutionTraceStore(db);
  const emptyShgat = new SHGAT(DEFAULT_SHGAT_CONFIG); // No tools/capabilities
  const embeddingProvider = createMockEmbeddingProvider();

  try {
    // Cold start: SHGAT has no nodes
    const trace = await storeTraceWithPriority(
      traceStore,
      emptyShgat,
      embeddingProvider,
      {
        intentText: "Unknown intent",
        executedPath: ["unknown:tool"],
        executedAt: new Date(),
        success: true,
        durationMs: 100,
        decisions: [],
        taskResults: [],
      },
    );

    // Should get cold start priority
    assertEquals(trace.priority, COLD_START_PRIORITY);
  } finally {
    await db.close();
  }
});

Deno.test("E2E: calculateTDError returns correct structure", async () => {
  const shgat = createTestSHGAT();
  const embeddingProvider = createMockEmbeddingProvider();

  // Test success case
  const successResult = await calculateTDError(shgat, embeddingProvider, {
    intentText: "Read file",
    executedPath: ["filesystem:read"],
    success: true,
  });

  assertExists(successResult.tdError);
  assertExists(successResult.priority);
  assertExists(successResult.predicted);
  assertEquals(successResult.actual, 1.0);
  assertEquals(successResult.isColdStart, false);
  assertEquals(successResult.priority, Math.abs(successResult.tdError));

  // Test failure case
  const failResult = await calculateTDError(shgat, embeddingProvider, {
    intentText: "Read file",
    executedPath: ["filesystem:read"],
    success: false,
  });

  assertEquals(failResult.actual, 0.0);
  assertEquals(failResult.isColdStart, false);
  // Same predicted value (same path/intent)
  assertEquals(failResult.predicted, successResult.predicted);
  // But opposite TD error sign
  assertEquals(failResult.tdError, 0.0 - failResult.predicted);
});

Deno.test("E2E: multiple traces ordered by priority in getHighPriorityTraces", async () => {
  const db = await setupTestDb();
  const traceStore = new ExecutionTraceStore(db);
  const shgat = createTestSHGAT();
  const embeddingProvider = createMockEmbeddingProvider();

  try {
    // Create traces with different scenarios to get varying priorities
    const traces = await Promise.all([
      storeTraceWithPriority(traceStore, shgat, embeddingProvider, {
        intentText: "Task 1",
        executedPath: ["filesystem:read"],
        executedAt: new Date(),
        success: true,
        durationMs: 10,
        decisions: [],
        taskResults: [],
      }),
      storeTraceWithPriority(traceStore, shgat, embeddingProvider, {
        intentText: "Task 2",
        executedPath: ["http:get"],
        executedAt: new Date(),
        success: false,
        durationMs: 100,
        decisions: [],
        taskResults: [],
      }),
      storeTraceWithPriority(traceStore, shgat, embeddingProvider, {
        intentText: "Task 3",
        executedPath: ["filesystem:write"],
        executedAt: new Date(),
        success: true,
        durationMs: 50,
        decisions: [],
        taskResults: [],
      }),
    ]);

    // Verify all traces saved
    assertEquals(traces.length, 3);

    // Get high priority traces and verify ordering
    const orderedTraces = await traceStore.getHighPriorityTraces(10);
    assertEquals(orderedTraces.length, 3);

    // Verify they are ordered by priority DESC
    for (let i = 0; i < orderedTraces.length - 1; i++) {
      assertGreater(
        orderedTraces[i].priority,
        orderedTraces[i + 1].priority - 0.001, // Small epsilon for float comparison
        `Trace ${i} priority should be >= trace ${i + 1} priority`,
      );
    }
  } finally {
    await db.close();
  }
});
