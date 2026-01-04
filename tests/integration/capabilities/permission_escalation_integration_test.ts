/**
 * Integration Tests for Permission Escalation (Story 7.7c)
 *
 * Tests:
 * 1. PermissionAuditStore persists audit logs
 * 2. CapabilityStore.updatePermissionSet updates permissions
 * 3. PermissionEscalationHandler coordinates the full flow
 * 4. Migration 018 creates the permission_audit_log table
 *
 * @module tests/integration/capabilities/permission_escalation_integration_test
 */

import { assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { initializeTestDatabase } from "../../fixtures/test-helpers.ts";
import { PGliteClient } from "../../../src/db/client.ts";
import { PermissionAuditStore } from "../../../src/capabilities/permission-audit-store.ts";
import { CapabilityStore } from "../../../src/capabilities/capability-store.ts";
import {
  formatEscalationRequest,
  PermissionEscalationHandler,
} from "../../../src/capabilities/permission-escalation-handler.ts";
import { suggestEscalation } from "../../../src/capabilities/permission-escalation.ts";
import { MockEmbeddingModel } from "../../fixtures/mock-embedding-model.ts";
import type { EmbeddingModel } from "../../../src/vector/embeddings.ts";

// Helper to create and cleanup test DB
async function createTestDb(): Promise<PGliteClient> {
  return await initializeTestDatabase();
}

async function cleanupTestDb(db: PGliteClient): Promise<void> {
  // Extract temp dir from db path if needed, or just close
  try {
    await db.close();
  } catch {
    // Ignore close errors
  }
}

// Cast MockEmbeddingModel to EmbeddingModel for tests
function getMockEmbedding(): EmbeddingModel {
  return new MockEmbeddingModel() as unknown as EmbeddingModel;
}

// ===================================================================
// AUDIT STORE INTEGRATION TESTS
// ===================================================================

Deno.test({
  name: "PermissionAuditStore - logs escalation and retrieves it",
  async fn() {
    const db = await createTestDb();
    const store = new PermissionAuditStore(db);

    try {
      // Log an approved escalation
      const entry = await store.logEscalation({
        capabilityId: "cap-test-123",
        fromSet: "minimal",
        toSet: "network-api",
        approved: true,
        approvedBy: "test-user",
        reason: "PermissionDenied: Requires net access to api.test.com",
        detectedOperation: "net",
      });

      assertNotEquals(entry.id, undefined);
      assertEquals(entry.capabilityId, "cap-test-123");
      assertEquals(entry.fromSet, "minimal");
      assertEquals(entry.toSet, "network-api");
      assertEquals(entry.approved, true);
      assertEquals(entry.approvedBy, "test-user");

      // Retrieve the log
      const logs = await store.getAuditLogForCapability("cap-test-123");
      assertEquals(logs.length, 1);
      assertEquals(logs[0].id, entry.id);
    } finally {
      await cleanupTestDb(db);
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "PermissionAuditStore - filters by approval status",
  async fn() {
    const db = await createTestDb();
    const store = new PermissionAuditStore(db);

    try {
      // Log approved escalation
      await store.logEscalation({
        capabilityId: "cap-1",
        fromSet: "minimal",
        toSet: "network-api",
        approved: true,
      });

      // Log rejected escalation
      await store.logEscalation({
        capabilityId: "cap-2",
        fromSet: "minimal",
        toSet: "filesystem",
        approved: false,
      });

      // Filter by approved
      const approvedLogs = await store.getAuditLog({ approved: true });
      assertEquals(approvedLogs.length, 1);
      assertEquals(approvedLogs[0].capabilityId, "cap-1");

      // Filter by rejected
      const rejectedLogs = await store.getAuditLog({ approved: false });
      assertEquals(rejectedLogs.length, 1);
      assertEquals(rejectedLogs[0].capabilityId, "cap-2");
    } finally {
      await cleanupTestDb(db);
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "PermissionAuditStore - getEscalationCount returns correct stats",
  async fn() {
    const db = await createTestDb();
    const store = new PermissionAuditStore(db);

    try {
      // Log multiple escalations for same capability
      await store.logEscalation({
        capabilityId: "cap-stats",
        fromSet: "minimal",
        toSet: "readonly",
        approved: true,
      });

      await store.logEscalation({
        capabilityId: "cap-stats",
        fromSet: "readonly",
        toSet: "filesystem",
        approved: true,
      });

      await store.logEscalation({
        capabilityId: "cap-stats",
        fromSet: "filesystem",
        toSet: "mcp-standard",
        approved: false,
      });

      const counts = await store.getEscalationCount("cap-stats");
      assertEquals(counts.total, 3);
      assertEquals(counts.approved, 2);
      assertEquals(counts.rejected, 1);
    } finally {
      await cleanupTestDb(db);
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "PermissionAuditStore - getRecentStats returns aggregated data",
  async fn() {
    const db = await createTestDb();
    const store = new PermissionAuditStore(db);

    try {
      // Log several escalations
      await store.logEscalation({
        capabilityId: "cap-a",
        fromSet: "minimal",
        toSet: "network-api",
        approved: true,
      });

      await store.logEscalation({
        capabilityId: "cap-b",
        fromSet: "minimal",
        toSet: "filesystem",
        approved: true,
      });

      await store.logEscalation({
        capabilityId: "cap-c",
        fromSet: "minimal",
        toSet: "readonly",
        approved: false,
      });

      const stats = await store.getRecentStats(24);
      assertEquals(stats.totalRequests, 3);
      assertEquals(stats.approvedCount, 2);
      assertEquals(stats.rejectedCount, 1);
      assertEquals(stats.uniqueCapabilities, 3);
      // Approval rate should be ~0.666
      assertEquals(stats.approvalRate > 0.6, true);
      assertEquals(stats.approvalRate < 0.7, true);
    } finally {
      await cleanupTestDb(db);
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

// ===================================================================
// CAPABILITY STORE PERMISSION UPDATE TESTS
// ===================================================================

Deno.test({
  name: "CapabilityStore - updatePermissionSet updates capability in DB",
  async fn() {
    const db = await createTestDb();
    const embeddingModel = getMockEmbedding();
    const store = new CapabilityStore(db, embeddingModel);

    try {
      // First, create a capability
      const { capability: cap } = await store.saveCapability({
        code: "const result = await tools.fetch({url: 'https://api.test.com'});",
        intent: "Fetch data from test API",
        durationMs: 100,
        success: true,
      });

      // Verify initial permission set (should be 'minimal' by default)
      const initial = await store.findById(cap.id);
      assertEquals(initial?.permissionSet, "minimal");

      // Update permission set
      await store.updatePermissionSet(cap.id, "network-api");

      // Verify update
      const updated = await store.findById(cap.id);
      assertEquals(updated?.permissionSet, "network-api");
      // Confidence should be 1.0 after manual update
      assertEquals(updated?.permissionConfidence, 1.0);
    } finally {
      await cleanupTestDb(db);
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "CapabilityStore - updatePermissionSet rejects invalid escalation",
  async fn() {
    const db = await createTestDb();
    const embeddingModel = getMockEmbedding();
    const store = new CapabilityStore(db, embeddingModel);

    try {
      // Create a capability at mcp-standard level
      const { capability: cap } = await store.saveCapability({
        code: "const x = 1;",
        intent: "Simple test",
        durationMs: 50,
        success: true,
      });

      // Update to mcp-standard first (valid)
      await store.updatePermissionSet(cap.id, "mcp-standard");

      // Try to escalate to trusted (invalid - not allowed via escalation)
      await assertRejects(
        async () => {
          await store.updatePermissionSet(cap.id, "trusted");
        },
        Error,
        "Invalid permission escalation",
      );
    } finally {
      await cleanupTestDb(db);
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "CapabilityStore - isValidEscalation works correctly",
  async fn() {
    const db = await createTestDb();
    const embeddingModel = getMockEmbedding();
    const store = new CapabilityStore(db, embeddingModel);

    try {
      // Valid escalations
      assertEquals(store.isValidEscalation("minimal", "readonly"), true);
      assertEquals(store.isValidEscalation("minimal", "network-api"), true);

      // Invalid escalations
      assertEquals(store.isValidEscalation("minimal", "trusted"), false);
      assertEquals(store.isValidEscalation("mcp-standard", "trusted"), false);
    } finally {
      await cleanupTestDb(db);
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

// ===================================================================
// PERMISSION ESCALATION HANDLER TESTS
// ===================================================================

Deno.test({
  name: "PermissionEscalationHandler - handles approved escalation",
  async fn() {
    const db = await createTestDb();
    const embeddingModel = getMockEmbedding();
    const capStore = new CapabilityStore(db, embeddingModel);
    const auditStore = new PermissionAuditStore(db);

    // Mock HIL callback that always approves
    const mockHilCallback = async () => ({ approved: true, feedback: "Approved for testing" });

    const handler = new PermissionEscalationHandler(capStore, auditStore, mockHilCallback);

    try {
      // Create a capability
      const { capability: cap } = await capStore.saveCapability({
        code: "await tools.fetch({url: 'https://api.test.com'});",
        intent: "Fetch API data",
        durationMs: 100,
        success: true,
      });

      // Handle permission error
      const result = await handler.handlePermissionError(
        cap.id,
        "minimal",
        "PermissionDenied: Requires net access to api.test.com",
        "exec-123",
      );

      assertEquals(result.handled, true);
      assertEquals(result.approved, true);
      assertEquals(result.newPermissionSet, "network-api");
      assertEquals(result.feedback, "Approved for testing");

      // Verify capability was updated
      const updated = await capStore.findById(cap.id);
      assertEquals(updated?.permissionSet, "network-api");

      // Verify audit log
      const logs = await auditStore.getAuditLogForCapability(cap.id);
      assertEquals(logs.length, 1);
      assertEquals(logs[0].approved, true);
    } finally {
      await cleanupTestDb(db);
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "PermissionEscalationHandler - handles rejected escalation",
  async fn() {
    const db = await createTestDb();
    const embeddingModel = getMockEmbedding();
    const capStore = new CapabilityStore(db, embeddingModel);
    const auditStore = new PermissionAuditStore(db);

    // Mock HIL callback that rejects
    const mockHilCallback = async () => ({ approved: false, feedback: "Too risky" });

    const handler = new PermissionEscalationHandler(capStore, auditStore, mockHilCallback);

    try {
      // Create a capability
      const { capability: cap } = await capStore.saveCapability({
        code: "await tools.writeFile({path: '/etc/config'});",
        intent: "Write config file",
        durationMs: 100,
        success: true,
      });

      // Handle permission error
      const result = await handler.handlePermissionError(
        cap.id,
        "minimal",
        "PermissionDenied: Requires write access to /etc/config",
        "exec-456",
      );

      assertEquals(result.handled, true);
      assertEquals(result.approved, false);
      assertEquals(result.feedback, "Too risky");

      // Verify capability was NOT updated
      const unchanged = await capStore.findById(cap.id);
      assertEquals(unchanged?.permissionSet, "minimal");

      // Verify audit log
      const logs = await auditStore.getAuditLogForCapability(cap.id);
      assertEquals(logs.length, 1);
      assertEquals(logs[0].approved, false);
    } finally {
      await cleanupTestDb(db);
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "PermissionEscalationHandler - enforces retry limit (AC5)",
  async fn() {
    const db = await createTestDb();
    const embeddingModel = getMockEmbedding();
    const capStore = new CapabilityStore(db, embeddingModel);
    const auditStore = new PermissionAuditStore(db);

    // Mock HIL callback that always approves
    const mockHilCallback = async () => ({ approved: true });

    const handler = new PermissionEscalationHandler(capStore, auditStore, mockHilCallback);

    try {
      // Create a capability
      const { capability: cap } = await capStore.saveCapability({
        code: "await tools.fetch({url: 'https://api.test.com'});",
        intent: "Fetch API data",
        durationMs: 100,
        success: true,
      });

      const execId = "exec-retry-test";

      // First attempt should succeed
      const result1 = await handler.handlePermissionError(
        cap.id,
        "minimal",
        "PermissionDenied: Requires net access to api.test.com",
        execId,
      );
      assertEquals(result1.handled, true);
      assertEquals(result1.approved, true);

      // Second attempt for same execution should be blocked
      const result2 = await handler.handlePermissionError(
        cap.id,
        "network-api",
        "PermissionDenied: Requires env access to API_KEY",
        execId,
      );
      assertEquals(result2.handled, false);
      assertEquals(result2.approved, false);
      assertEquals(result2.error?.includes("Maximum escalation retries"), true);

      // Reset attempts
      handler.resetAttempts(execId);

      // After reset, should work again
      const result3 = await handler.handlePermissionError(
        cap.id,
        "network-api",
        "PermissionDenied: Requires env access to API_KEY",
        execId,
      );
      assertEquals(result3.handled, true);
    } finally {
      await cleanupTestDb(db);
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "PermissionEscalationHandler - sandbox-escape permissions go through HIL (3-axis model)",
  async fn() {
    const db = await createTestDb();
    const embeddingModel = getMockEmbedding();
    const capStore = new CapabilityStore(db, embeddingModel);
    const auditStore = new PermissionAuditStore(db);

    // Mock HIL callback that rejects sandbox-escape permissions
    const mockHilCallback = async () => ({ approved: false, feedback: "Sandbox-escape rejected" });
    const handler = new PermissionEscalationHandler(capStore, auditStore, mockHilCallback);

    try {
      const { capability: cap } = await capStore.saveCapability({
        code: "Deno.run({cmd: ['ls']})",
        intent: "Run shell command",
        durationMs: 100,
        success: true,
      });

      // Try to escalate for 'run' permission (sandbox-escape)
      // In 3-axis model, this goes through HIL instead of being hard-blocked
      const result = await handler.handlePermissionError(
        cap.id,
        "minimal",
        "PermissionDenied: Requires run access to /bin/sh",
        "exec-security",
      );

      // New behavior: handled=true (went through HIL), approved=false (HIL rejected)
      assertEquals(result.handled, true, "Sandbox-escape should go through HIL");
      assertEquals(result.approved, false, "HIL should reject sandbox-escape without toolConfig");
      assertEquals(result.feedback, "Sandbox-escape rejected");

      // Verify audit log recorded the rejection
      const logs = await auditStore.getAuditLogForCapability(cap.id);
      assertEquals(logs.length, 1);
      assertEquals(logs[0].approved, false);
    } finally {
      await cleanupTestDb(db);
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

// ===================================================================
// FORMATTING TESTS
// ===================================================================

Deno.test("formatEscalationRequest - produces human-readable output", () => {
  const request = suggestEscalation(
    "PermissionDenied: Requires net access to api.example.com:443",
    "cap-format-test",
    "minimal",
  );

  assertNotEquals(request, null);
  const formatted = formatEscalationRequest(request!);

  // Check that key information is present
  assertEquals(formatted.includes("cap-format-test"), true);
  assertEquals(formatted.includes("minimal"), true);
  assertEquals(formatted.includes("network-api"), true);
  assertEquals(formatted.includes("Requires net access"), true);
  assertEquals(formatted.includes("[A]pprove"), true);
  assertEquals(formatted.includes("[R]eject"), true);
});
