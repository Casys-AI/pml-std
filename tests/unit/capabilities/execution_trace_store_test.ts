/**
 * Unit tests for ExecutionTraceStore
 *
 * Story: 11.2 - Execution Trace Table & Store
 *
 * Tests:
 * - AC7: INSERT trace with FK capability validates
 * - AC8: SELECT traces by capability_id works
 * - saveTrace() inserts with auto-generated id
 * - getTraceById() retrieves single trace
 * - getTraces() filters by capability_id
 * - getHighPriorityTraces() orders by priority DESC
 * - updatePriority() updates priority correctly
 * - sampleByPriority() returns weighted sample
 * - sanitization strips sensitive data (AC11)
 *
 * @module tests/unit/capabilities/execution_trace_store_test
 */

import { assertEquals, assertExists, assertGreater, assertLess } from "@std/assert";
import { PGliteClient } from "../../../src/db/client.ts";
import { getAllMigrations, MigrationRunner } from "../../../src/db/migrations.ts";
import { ExecutionTraceStore, type SaveTraceInput } from "../../../src/capabilities/execution-trace-store.ts";
import type { BranchDecision, TraceTaskResult } from "../../../src/capabilities/types.ts";

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
 *
 * Note: Migration 022 removed 'name' column from workflow_pattern.
 * Names now live in capability_records.display_name (Story 13.2).
 */
async function createTestCapability(db: PGliteClient): Promise<string> {
  // Generate unique hash to avoid conflicts
  const uniqueHash = `test-hash-${Date.now()}-${Math.random().toString(36).substring(7)}`;

  // PGlite requires vector as string format: '[0.5, 0.5, ...]'
  const embeddingStr = `[${new Array(1024).fill(0.5).join(",")}]`;

  const result = await db.query(`
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
  `, [uniqueHash, embeddingStr, `code-hash-${uniqueHash}`]);
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
// Basic CRUD Tests
// =============================================================================

Deno.test("ExecutionTraceStore - saveTrace() inserts with auto-generated id", async () => {
  const db = await setupTestDb();
  const store = new ExecutionTraceStore(db);

  const input = createTestTraceInput();
  const trace = await store.saveTrace(input);

  assertExists(trace);
  assertExists(trace.id);
  assertEquals(trace.success, true);
  assertEquals(trace.durationMs, 100);
  assertEquals(trace.intentText, "Test intent");
  assertEquals(trace.userId, "test-user");
  assertEquals(trace.createdBy, "test-agent");

  await db.close();
});

Deno.test("ExecutionTraceStore - getTraceById() retrieves single trace", async () => {
  const db = await setupTestDb();
  const store = new ExecutionTraceStore(db);

  const input = createTestTraceInput({ intentText: "Unique intent" });
  const saved = await store.saveTrace(input);

  const retrieved = await store.getTraceById(saved.id);

  assertExists(retrieved);
  assertEquals(retrieved.id, saved.id);
  assertEquals(retrieved.intentText, "Unique intent");

  await db.close();
});

Deno.test("ExecutionTraceStore - getTraceById() returns null for non-existent id", async () => {
  const db = await setupTestDb();
  const store = new ExecutionTraceStore(db);

  const retrieved = await store.getTraceById("00000000-0000-0000-0000-000000000000");

  assertEquals(retrieved, null);

  await db.close();
});

// =============================================================================
// AC7: INSERT trace with FK capability validates
// =============================================================================

Deno.test("ExecutionTraceStore - AC7: saveTrace() with FK capability validates", async () => {
  const db = await setupTestDb();
  const store = new ExecutionTraceStore(db);

  // Create a capability to link to
  const capabilityId = await createTestCapability(db);

  // Save trace with FK reference
  const input = createTestTraceInput({ capabilityId });
  const trace = await store.saveTrace(input);

  assertExists(trace);
  assertEquals(trace.capabilityId, capabilityId);

  // Verify FK relationship in database
  // Note: Migration 022 removed 'name' from workflow_pattern, just verify FK works
  const result = await db.query(`
    SELECT et.*, wp.pattern_id
    FROM execution_trace et
    JOIN workflow_pattern wp ON et.capability_id = wp.pattern_id
    WHERE et.id = $1
  `, [trace.id]);

  assertEquals(result.length, 1);
  assertEquals(result[0].pattern_id, capabilityId);

  await db.close();
});

Deno.test("ExecutionTraceStore - AC7: saveTrace() without capability_id works (standalone trace)", async () => {
  const db = await setupTestDb();
  const store = new ExecutionTraceStore(db);

  const input = createTestTraceInput({ capabilityId: undefined });
  const trace = await store.saveTrace(input);

  assertExists(trace);
  assertEquals(trace.capabilityId, undefined);

  await db.close();
});

// =============================================================================
// AC8: SELECT traces by capability_id works
// =============================================================================

Deno.test("ExecutionTraceStore - AC8: getTraces() filters by capability_id", async () => {
  const db = await setupTestDb();
  const store = new ExecutionTraceStore(db);

  // Create two capabilities
  const capA = await createTestCapability(db);
  const capB = await createTestCapability(db);

  // Create traces for each
  await store.saveTrace(createTestTraceInput({ capabilityId: capA, intentText: "Cap A trace 1" }));
  await store.saveTrace(createTestTraceInput({ capabilityId: capA, intentText: "Cap A trace 2" }));
  await store.saveTrace(createTestTraceInput({ capabilityId: capB, intentText: "Cap B trace 1" }));

  // Query by capability_id
  const tracesA = await store.getTraces(capA);
  const tracesB = await store.getTraces(capB);

  assertEquals(tracesA.length, 2);
  assertEquals(tracesB.length, 1);
  assertEquals(tracesA.every((t) => t.capabilityId === capA), true);
  assertEquals(tracesB[0].capabilityId, capB);

  await db.close();
});

Deno.test("ExecutionTraceStore - AC8: getTraces() respects limit", async () => {
  const db = await setupTestDb();
  const store = new ExecutionTraceStore(db);

  const capId = await createTestCapability(db);

  // Create 10 traces
  for (let i = 0; i < 10; i++) {
    await store.saveTrace(createTestTraceInput({ capabilityId: capId }));
  }

  // Query with limit
  const traces = await store.getTraces(capId, 5);

  assertEquals(traces.length, 5);

  await db.close();
});

Deno.test("ExecutionTraceStore - AC8: getTraces() orders by executed_at DESC", async () => {
  const db = await setupTestDb();
  const store = new ExecutionTraceStore(db);

  const capId = await createTestCapability(db);

  // Create traces with small delay
  await store.saveTrace(createTestTraceInput({ capabilityId: capId, intentText: "First" }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  await store.saveTrace(createTestTraceInput({ capabilityId: capId, intentText: "Second" }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  await store.saveTrace(createTestTraceInput({ capabilityId: capId, intentText: "Third" }));

  const traces = await store.getTraces(capId);

  // Most recent first
  assertEquals(traces[0].intentText, "Third");
  assertEquals(traces[1].intentText, "Second");
  assertEquals(traces[2].intentText, "First");

  await db.close();
});

// =============================================================================
// Priority and PER Sampling Tests
// =============================================================================

Deno.test("ExecutionTraceStore - getHighPriorityTraces() orders by priority DESC", async () => {
  const db = await setupTestDb();
  const store = new ExecutionTraceStore(db);

  // Create traces with different priorities
  await store.saveTrace(createTestTraceInput({ priority: 0.2 }));
  await store.saveTrace(createTestTraceInput({ priority: 0.9 }));
  await store.saveTrace(createTestTraceInput({ priority: 0.5 }));
  await store.saveTrace(createTestTraceInput({ priority: 1.0 }));

  const traces = await store.getHighPriorityTraces(10);

  assertEquals(traces.length, 4);
  assertEquals(traces[0].priority, 1.0);
  assertEquals(traces[1].priority, 0.9);
  assertGreater(traces[0].priority, traces[1].priority);
  assertGreater(traces[1].priority, traces[2].priority);

  await db.close();
});

Deno.test("ExecutionTraceStore - updatePriority() updates correctly", async () => {
  const db = await setupTestDb();
  const store = new ExecutionTraceStore(db);

  const trace = await store.saveTrace(createTestTraceInput({ priority: 0.5 }));
  assertEquals(trace.priority, 0.5);

  // Update priority
  await store.updatePriority(trace.id, 0.85);

  const updated = await store.getTraceById(trace.id);
  assertExists(updated);
  assertEquals(updated.priority, 0.85);

  await db.close();
});

Deno.test("ExecutionTraceStore - updatePriority() clamps to 0-1 range", async () => {
  const db = await setupTestDb();
  const store = new ExecutionTraceStore(db);

  const trace = await store.saveTrace(createTestTraceInput({ priority: 0.5 }));

  // Update with out-of-range values
  await store.updatePriority(trace.id, 1.5); // Should clamp to 1.0
  let updated = await store.getTraceById(trace.id);
  assertEquals(updated?.priority, 1.0);

  await store.updatePriority(trace.id, -0.5); // Should clamp to 0.0
  updated = await store.getTraceById(trace.id);
  assertEquals(updated?.priority, 0.0);

  await db.close();
});

Deno.test("ExecutionTraceStore - sampleByPriority() returns traces above minPriority", async () => {
  const db = await setupTestDb();
  const store = new ExecutionTraceStore(db);

  // Create traces with different priorities
  await store.saveTrace(createTestTraceInput({ priority: 0.1 }));
  await store.saveTrace(createTestTraceInput({ priority: 0.3 }));
  await store.saveTrace(createTestTraceInput({ priority: 0.5 }));
  await store.saveTrace(createTestTraceInput({ priority: 0.8 }));

  // Sample with minPriority = 0.4
  const traces = await store.sampleByPriority(10, 0.4);

  assertEquals(traces.length, 2); // Only priority >= 0.4
  assertEquals(traces.every((t) => t.priority >= 0.4), true);

  await db.close();
});

Deno.test("ExecutionTraceStore - sampleByPriority() respects limit", async () => {
  const db = await setupTestDb();
  const store = new ExecutionTraceStore(db);

  // Create 10 traces with high priority
  for (let i = 0; i < 10; i++) {
    await store.saveTrace(createTestTraceInput({ priority: 0.8 }));
  }

  const traces = await store.sampleByPriority(5, 0.1);

  assertEquals(traces.length, 5);

  await db.close();
});

// =============================================================================
// Data Storage Tests (decisions, taskResults, executedPath)
// =============================================================================

Deno.test("ExecutionTraceStore - stores and retrieves decisions JSONB", async () => {
  const db = await setupTestDb();
  const store = new ExecutionTraceStore(db);

  const decisions: BranchDecision[] = [
    { nodeId: "branch1", outcome: "success", condition: "status == 200" },
    { nodeId: "branch2", outcome: "retry", condition: "attempts < 3" },
  ];

  const trace = await store.saveTrace(createTestTraceInput({ decisions }));

  const retrieved = await store.getTraceById(trace.id);
  assertExists(retrieved);
  assertEquals(retrieved.decisions.length, 2);
  assertEquals(retrieved.decisions[0].nodeId, "branch1");
  assertEquals(retrieved.decisions[0].outcome, "success");
  assertEquals(retrieved.decisions[1].nodeId, "branch2");

  await db.close();
});

Deno.test("ExecutionTraceStore - stores and retrieves taskResults JSONB", async () => {
  const db = await setupTestDb();
  const store = new ExecutionTraceStore(db);

  const taskResults: TraceTaskResult[] = [
    {
      taskId: "task1",
      tool: "mcp.filesystem.read",
      args: { path: "/data/file.txt" },
      result: { content: "file contents" },
      success: true,
      durationMs: 50,
    },
    {
      taskId: "task2",
      tool: "mcp.github.createIssue",
      args: { title: "Bug report" },
      result: { issueNumber: 123 },
      success: true,
      durationMs: 200,
    },
  ];

  const trace = await store.saveTrace(createTestTraceInput({ taskResults }));

  const retrieved = await store.getTraceById(trace.id);
  assertExists(retrieved);
  assertEquals(retrieved.taskResults.length, 2);
  assertEquals(retrieved.taskResults[0].tool, "mcp.filesystem.read");
  assertEquals(retrieved.taskResults[1].tool, "mcp.github.createIssue");

  await db.close();
});

Deno.test("ExecutionTraceStore - stores and retrieves executedPath array", async () => {
  const db = await setupTestDb();
  const store = new ExecutionTraceStore(db);

  const executedPath = ["start", "fetch", "transform", "validate", "save", "end"];

  const trace = await store.saveTrace(createTestTraceInput({ executedPath }));

  const retrieved = await store.getTraceById(trace.id);
  assertExists(retrieved);
  assertExists(retrieved.executedPath);
  assertEquals(retrieved.executedPath.length, 6);
  assertEquals(retrieved.executedPath[0], "start");
  assertEquals(retrieved.executedPath[5], "end");

  await db.close();
});

// =============================================================================
// AC11: Sanitization Tests
// =============================================================================

Deno.test("ExecutionTraceStore - AC11: sanitizes sensitive data in taskResults.args", async () => {
  const db = await setupTestDb();
  const store = new ExecutionTraceStore(db);

  const taskResults: TraceTaskResult[] = [
    {
      taskId: "task1",
      tool: "api.call",
      args: {
        url: "https://api.example.com",
        api_key: "sk-super-secret-key-12345",
        token: "bearer-token-xyz",
        password: "my-password-123",
        data: "normal data",
      },
      result: { status: "ok" },
      success: true,
      durationMs: 100,
    },
  ];

  const trace = await store.saveTrace(createTestTraceInput({ taskResults }));

  const retrieved = await store.getTraceById(trace.id);
  assertExists(retrieved);

  const args = retrieved.taskResults[0].args;
  assertEquals(args.url, "https://api.example.com"); // Not sensitive
  assertEquals(args.api_key, "[REDACTED]"); // Sensitive - redacted
  assertEquals(args.token, "[REDACTED]"); // Sensitive - redacted
  assertEquals(args.password, "[REDACTED]"); // Sensitive - redacted
  assertEquals(args.data, "normal data"); // Not sensitive

  await db.close();
});

Deno.test("ExecutionTraceStore - AC11: sanitizes sensitive data in initialContext", async () => {
  const db = await setupTestDb();
  const store = new ExecutionTraceStore(db);

  const initialContext = {
    query: "search term",
    authorization: "Bearer secret-token",
    config: {
      api_key: "key-12345",
      timeout: 5000,
    },
  };

  const trace = await store.saveTrace(createTestTraceInput({ initialContext }));

  const retrieved = await store.getTraceById(trace.id);
  assertExists(retrieved);
  assertExists(retrieved.initialContext);

  assertEquals(retrieved.initialContext.query, "search term");
  assertEquals(retrieved.initialContext.authorization, "[REDACTED]");

  const config = retrieved.initialContext.config as Record<string, unknown>;
  assertEquals(config.api_key, "[REDACTED]");
  assertEquals(config.timeout, 5000);

  await db.close();
});

// =============================================================================
// Statistics and Count Tests
// =============================================================================

Deno.test("ExecutionTraceStore - getTraceCount() returns correct count", async () => {
  const db = await setupTestDb();
  const store = new ExecutionTraceStore(db);

  const capId = await createTestCapability(db);

  // Initial count should be 0
  let count = await store.getTraceCount(capId);
  assertEquals(count, 0);

  // Add traces
  await store.saveTrace(createTestTraceInput({ capabilityId: capId }));
  await store.saveTrace(createTestTraceInput({ capabilityId: capId }));
  await store.saveTrace(createTestTraceInput()); // Different capability (none)

  // Count for specific capability
  count = await store.getTraceCount(capId);
  assertEquals(count, 2);

  // Count for all traces
  count = await store.getTraceCount();
  assertEquals(count, 3);

  await db.close();
});

Deno.test("ExecutionTraceStore - getStats() returns aggregate statistics", async () => {
  const db = await setupTestDb();
  const store = new ExecutionTraceStore(db);

  // Create traces with varying success and duration
  await store.saveTrace(createTestTraceInput({ success: true, durationMs: 100, priority: 0.3 }));
  await store.saveTrace(createTestTraceInput({ success: true, durationMs: 200, priority: 0.5 }));
  await store.saveTrace(createTestTraceInput({ success: false, durationMs: 50, priority: 0.8 }));

  const stats = await store.getStats();

  assertEquals(stats.totalTraces, 3);
  assertEquals(stats.successfulTraces, 2);
  // Average duration: (100 + 200 + 50) / 3 ≈ 116.67
  assertGreater(stats.avgDurationMs, 100);
  assertLess(stats.avgDurationMs, 150);
  // Average priority: (0.3 + 0.5 + 0.8) / 3 ≈ 0.53
  assertGreater(stats.avgPriority, 0.4);
  assertLess(stats.avgPriority, 0.6);

  await db.close();
});

// =============================================================================
// Multi-tenancy Tests
// =============================================================================

Deno.test("ExecutionTraceStore - getTracesByUser() filters by userId", async () => {
  const db = await setupTestDb();
  const store = new ExecutionTraceStore(db);

  // Create traces for different users
  await store.saveTrace(createTestTraceInput({ userId: "user-alice" }));
  await store.saveTrace(createTestTraceInput({ userId: "user-alice" }));
  await store.saveTrace(createTestTraceInput({ userId: "user-bob" }));

  const aliceTraces = await store.getTracesByUser("user-alice");
  const bobTraces = await store.getTracesByUser("user-bob");

  assertEquals(aliceTraces.length, 2);
  assertEquals(bobTraces.length, 1);
  assertEquals(aliceTraces.every((t) => t.userId === "user-alice"), true);

  await db.close();
});

// =============================================================================
// Hierarchical Traces Tests (ADR-041)
// =============================================================================

Deno.test("ExecutionTraceStore - getChildTraces() returns child traces", async () => {
  const db = await setupTestDb();
  const store = new ExecutionTraceStore(db);

  // Create parent trace
  const parent = await store.saveTrace(createTestTraceInput({ intentText: "Parent trace" }));

  // Create child traces
  await store.saveTrace(createTestTraceInput({
    parentTraceId: parent.id,
    intentText: "Child 1",
  }));
  await store.saveTrace(createTestTraceInput({
    parentTraceId: parent.id,
    intentText: "Child 2",
  }));
  await store.saveTrace(createTestTraceInput({ intentText: "Unrelated trace" }));

  const children = await store.getChildTraces(parent.id);

  assertEquals(children.length, 2);
  assertEquals(children.every((t) => t.parentTraceId === parent.id), true);

  await db.close();
});

// =============================================================================
// Anonymization and Pruning Tests
// =============================================================================

Deno.test("ExecutionTraceStore - anonymizeUserTraces() anonymizes user data", async () => {
  const db = await setupTestDb();
  const store = new ExecutionTraceStore(db);

  // Create traces for user
  await store.saveTrace(createTestTraceInput({
    userId: "user-to-delete",
    intentText: "Personal query",
    initialContext: { secret: "data" },
  }));
  await store.saveTrace(createTestTraceInput({ userId: "other-user" }));

  // Anonymize user traces
  const count = await store.anonymizeUserTraces("user-to-delete");
  assertEquals(count, 1);

  // Verify anonymization
  const traces = await store.getTracesByUser("anonymized");
  assertEquals(traces.length, 1);
  assertEquals(traces[0].intentText, undefined);
  assertEquals(Object.keys(traces[0].initialContext ?? {}).length, 0);

  // Other user unaffected
  const otherTraces = await store.getTracesByUser("other-user");
  assertEquals(otherTraces.length, 1);

  await db.close();
});

// =============================================================================
// Error Handling Tests
// =============================================================================

Deno.test("ExecutionTraceStore - handles empty taskResults gracefully", async () => {
  const db = await setupTestDb();
  const store = new ExecutionTraceStore(db);

  const trace = await store.saveTrace(createTestTraceInput({
    taskResults: [],
    decisions: [],
  }));

  const retrieved = await store.getTraceById(trace.id);
  assertExists(retrieved);
  assertEquals(retrieved.taskResults.length, 0);
  assertEquals(retrieved.decisions.length, 0);

  await db.close();
});

Deno.test("ExecutionTraceStore - handles failed trace with error message", async () => {
  const db = await setupTestDb();
  const store = new ExecutionTraceStore(db);

  const trace = await store.saveTrace(createTestTraceInput({
    success: false,
    errorMessage: "Connection timeout after 5000ms",
  }));

  const retrieved = await store.getTraceById(trace.id);
  assertExists(retrieved);
  assertEquals(retrieved.success, false);
  assertEquals(retrieved.errorMessage, "Connection timeout after 5000ms");

  await db.close();
});
