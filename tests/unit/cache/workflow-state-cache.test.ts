/**
 * Workflow State Cache Tests
 *
 * Tests for src/cache/workflow-state-cache.ts
 * Verifies Deno KV-based workflow state storage with TTL.
 *
 * Story 11.0: AC8 (store/retrieve), AC9 (TTL expiration)
 *
 * @module tests/unit/cache/workflow-state-cache.test
 */

import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { closeKv } from "../../../src/cache/kv.ts";
import {
  deleteWorkflowState,
  getWorkflowState,
  getWorkflowStateRecord,
  saveWorkflowState,
  updateWorkflowState,
} from "../../../src/cache/workflow-state-cache.ts";
import type { DAGStructure } from "../../../src/graphrag/types.ts";

// Test DAG structure
function createTestDAG(taskCount: number = 3): DAGStructure {
  return {
    tasks: Array.from({ length: taskCount }, (_, i) => ({
      id: `task-${i}`,
      tool: `test-server:tool-${i}`,
      arguments: { input: `value-${i}` },
      dependsOn: i > 0 ? [`task-${i - 1}`] : [],
    })),
  };
}

// Generate unique workflow ID for each test
function uniqueWorkflowId(): string {
  return `test-workflow-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

Deno.test("AC8: saveWorkflowState - stores DAG in KV", async () => {
  const workflowId = uniqueWorkflowId();
  const dag = createTestDAG(3);
  const intent = "Test intent for save";

  try {
    await saveWorkflowState(workflowId, dag, intent);

    // Verify it was stored
    const retrieved = await getWorkflowState(workflowId);
    assertExists(retrieved, "DAG should be retrievable after save");
    assertEquals(retrieved.tasks.length, 3, "Should have 3 tasks");
    assertEquals(retrieved.tasks[0].id, "task-0");
  } finally {
    await deleteWorkflowState(workflowId);
    await closeKv();
  }
});

Deno.test("AC8: getWorkflowState - retrieves stored DAG", async () => {
  const workflowId = uniqueWorkflowId();
  const dag = createTestDAG(5);

  try {
    await saveWorkflowState(workflowId, dag, "Retrieve test");

    const retrieved = await getWorkflowState(workflowId);
    assertExists(retrieved);
    assertEquals(retrieved.tasks.length, 5);

    // Verify task structure
    assertEquals(retrieved.tasks[2].id, "task-2");
    assertEquals(retrieved.tasks[2].tool, "test-server:tool-2");
    assertEquals(retrieved.tasks[2].dependsOn, ["task-1"]);
  } finally {
    await deleteWorkflowState(workflowId);
    await closeKv();
  }
});

Deno.test("AC8: getWorkflowState - returns null for non-existent workflow", async () => {
  try {
    const result = await getWorkflowState("non-existent-workflow-id");
    assertEquals(result, null, "Should return null for non-existent workflow");
  } finally {
    await closeKv();
  }
});

Deno.test("AC8: getWorkflowStateRecord - returns full record with metadata", async () => {
  const workflowId = uniqueWorkflowId();
  const dag = createTestDAG(2);
  const intent = "Full record test";

  try {
    const beforeSave = Date.now();
    await saveWorkflowState(workflowId, dag, intent);
    const afterSave = Date.now();

    const record = await getWorkflowStateRecord(workflowId);
    assertExists(record);

    // Verify structure
    assertEquals(record.workflow_id, workflowId);
    assertEquals(record.dag.tasks.length, 2);
    assertEquals(record.intent, intent);

    // Verify timestamps
    assertExists(record.created_at);
    assertExists(record.expires_at);

    // created_at should be within our test window
    const createdAtMs = record.created_at.getTime();
    assertEquals(createdAtMs >= beforeSave && createdAtMs <= afterSave, true);

    // expires_at should be ~1 hour after created_at
    const ttlMs = record.expires_at.getTime() - record.created_at.getTime();
    assertEquals(ttlMs, 3600_000, "TTL should be 1 hour (3600000ms)");
  } finally {
    await deleteWorkflowState(workflowId);
    await closeKv();
  }
});

Deno.test("AC8: updateWorkflowState - updates DAG and refreshes TTL", async () => {
  const workflowId = uniqueWorkflowId();
  const originalDAG = createTestDAG(2);
  const updatedDAG = createTestDAG(5);

  try {
    await saveWorkflowState(workflowId, originalDAG, "Update test");

    // Get original record
    const originalRecord = await getWorkflowStateRecord(workflowId);
    assertExists(originalRecord);

    // Small delay to ensure createdAt differs
    await new Promise((r) => setTimeout(r, 10));

    // Update
    await updateWorkflowState(workflowId, updatedDAG);

    // Verify update
    const updatedRecord = await getWorkflowStateRecord(workflowId);
    assertExists(updatedRecord);
    assertEquals(updatedRecord.dag.tasks.length, 5, "DAG should be updated");

    // TTL should be refreshed (createdAt updated)
    assertEquals(
      updatedRecord.created_at.getTime() >= originalRecord.created_at.getTime(),
      true,
      "TTL should be refreshed",
    );
  } finally {
    await deleteWorkflowState(workflowId);
    await closeKv();
  }
});

Deno.test("AC8: updateWorkflowState - throws for non-existent workflow", async () => {
  const dag = createTestDAG(1);

  try {
    await assertRejects(
      () => updateWorkflowState("non-existent-workflow", dag),
      Error,
      "not found",
    );
  } finally {
    await closeKv();
  }
});

Deno.test("AC8: deleteWorkflowState - removes workflow from KV", async () => {
  const workflowId = uniqueWorkflowId();
  const dag = createTestDAG(1);

  try {
    await saveWorkflowState(workflowId, dag, "Delete test");

    // Verify exists
    const before = await getWorkflowState(workflowId);
    assertExists(before);

    // Delete
    await deleteWorkflowState(workflowId);

    // Verify deleted
    const after = await getWorkflowState(workflowId);
    assertEquals(after, null, "Should be null after deletion");
  } finally {
    await closeKv();
  }
});

Deno.test("AC9: TTL configuration - verifies 1 hour expiration is set", async () => {
  const workflowId = uniqueWorkflowId();
  const dag = createTestDAG(1);

  try {
    await saveWorkflowState(workflowId, dag, "TTL test");

    const record = await getWorkflowStateRecord(workflowId);
    assertExists(record);

    // Calculate TTL from record
    const ttlMs = record.expires_at.getTime() - record.created_at.getTime();

    // Should be exactly 1 hour
    assertEquals(ttlMs, 3600_000, "TTL should be 1 hour (3600000ms)");
  } finally {
    await deleteWorkflowState(workflowId);
    await closeKv();
  }
});

Deno.test("AC8: saveWorkflowState - handles empty intent", async () => {
  const workflowId = uniqueWorkflowId();
  const dag = createTestDAG(1);

  try {
    // Save with empty intent
    await saveWorkflowState(workflowId, dag, "");

    const record = await getWorkflowStateRecord(workflowId);
    assertExists(record);
    assertEquals(record.intent, null, "Empty intent should be stored as null");
  } finally {
    await deleteWorkflowState(workflowId);
    await closeKv();
  }
});

Deno.test("AC8: saveWorkflowState - handles large DAG", async () => {
  const workflowId = uniqueWorkflowId();
  const dag = createTestDAG(100); // Large DAG with 100 tasks

  try {
    await saveWorkflowState(workflowId, dag, "Large DAG test");

    const retrieved = await getWorkflowState(workflowId);
    assertExists(retrieved);
    assertEquals(retrieved.tasks.length, 100, "Should store large DAG");
  } finally {
    await deleteWorkflowState(workflowId);
    await closeKv();
  }
});

Deno.test("AC8: multiple workflows - isolated storage", async () => {
  const workflow1 = uniqueWorkflowId();
  const workflow2 = uniqueWorkflowId();
  const dag1 = createTestDAG(2);
  const dag2 = createTestDAG(4);

  try {
    await saveWorkflowState(workflow1, dag1, "Workflow 1");
    await saveWorkflowState(workflow2, dag2, "Workflow 2");

    const retrieved1 = await getWorkflowState(workflow1);
    const retrieved2 = await getWorkflowState(workflow2);

    assertExists(retrieved1);
    assertExists(retrieved2);
    assertEquals(retrieved1.tasks.length, 2);
    assertEquals(retrieved2.tasks.length, 4);
  } finally {
    await deleteWorkflowState(workflow1);
    await deleteWorkflowState(workflow2);
    await closeKv();
  }
});
