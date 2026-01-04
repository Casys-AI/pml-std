/**
 * E2E Tests for Permission Escalation (Story 7.7c)
 *
 * Tests the full escalation flow including:
 * 1. Capability fails with PermissionDenied
 * 2. suggestEscalation() creates request
 * 3. Human approves via mock callback
 * 4. Capability's permission_set is updated
 * 5. Retry execution succeeds with new permissions
 *
 * @module tests/e2e/permission_escalation_e2e_test
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import { initializeTestDatabase } from "../fixtures/test-helpers.ts";
// PGliteClient type is used internally by initializeTestDatabase
import { CapabilityStore } from "../../src/capabilities/capability-store.ts";
import { PermissionAuditStore } from "../../src/capabilities/permission-audit-store.ts";
import {
  formatEscalationRequest,
  PermissionEscalationHandler,
} from "../../src/capabilities/permission-escalation-handler.ts";
import {
  isSecurityCritical,
  suggestEscalation,
} from "../../src/capabilities/permission-escalation.ts";
import { MockEmbeddingModel } from "../fixtures/mock-embedding-model.ts";
import type { EmbeddingModel } from "../../src/vector/embeddings.ts";
import type { PermissionEscalationRequest } from "../../src/capabilities/types.ts";

// Helper to get mock embedding as EmbeddingModel type
function getMockEmbedding(): EmbeddingModel {
  return new MockEmbeddingModel() as unknown as EmbeddingModel;
}

// Simulates the full permission escalation flow
Deno.test({
  name: "E2E: Full permission escalation flow - network access",
  async fn() {
    // Setup
    const db = await initializeTestDatabase();
    const embeddingModel = getMockEmbedding();
    const capStore = new CapabilityStore(db, embeddingModel);
    const auditStore = new PermissionAuditStore(db);

    // Track HIL requests for verification
    const hilRequests: PermissionEscalationRequest[] = [];

    // Mock HIL callback that captures requests and auto-approves
    const mockHilCallback = async (request: PermissionEscalationRequest) => {
      hilRequests.push(request);
      return { approved: true, feedback: "Approved for API access" };
    };

    const handler = new PermissionEscalationHandler(capStore, auditStore, mockHilCallback);

    try {
      // Step 1: Create a capability that will need network access
      const { capability: cap } = await capStore.saveCapability({
        code: `
          const response = await fetch("https://api.example.com/data");
          return await response.json();
        `,
        intent: "Fetch data from external API",
        durationMs: 150,
        success: true,
        toolsUsed: ["fetch"],
      });

      // Verify initial state
      const initialCap = await capStore.findById(cap.id);
      assertEquals(initialCap?.permissionSet, "minimal");

      // Step 2: Simulate execution failure with PermissionDenied
      const error =
        "PermissionDenied: Requires net access to api.example.com:443, run again with --allow-net";

      // Step 3: Handle the permission error
      const result = await handler.handlePermissionError(
        cap.id,
        initialCap!.permissionSet!,
        error,
        "exec-e2e-1",
      );

      // Step 4: Verify escalation was handled
      assertEquals(result.handled, true);
      assertEquals(result.approved, true);
      assertEquals(result.newPermissionSet, "network-api");
      assertEquals(result.feedback, "Approved for API access");

      // Verify HIL callback was called with correct request
      assertEquals(hilRequests.length, 1);
      assertEquals(hilRequests[0].capabilityId, cap.id);
      assertEquals(hilRequests[0].currentSet, "minimal");
      assertEquals(hilRequests[0].requestedSet, "network-api");
      assertEquals(hilRequests[0].detectedOperation, "net");

      // Step 5: Verify capability was updated in DB
      const updatedCap = await capStore.findById(cap.id);
      assertEquals(updatedCap?.permissionSet, "network-api");
      assertEquals(updatedCap?.permissionConfidence, 1.0);

      // Step 6: Verify audit log
      const auditLogs = await auditStore.getAuditLogForCapability(cap.id);
      assertEquals(auditLogs.length, 1);
      assertEquals(auditLogs[0].approved, true);
      assertEquals(auditLogs[0].fromSet, "minimal");
      assertEquals(auditLogs[0].toSet, "network-api");
      assertEquals(auditLogs[0].detectedOperation, "net");
    } finally {
      await db.close();
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "E2E: Permission escalation rejection flow",
  async fn() {
    const db = await initializeTestDatabase();
    const embeddingModel = getMockEmbedding();
    const capStore = new CapabilityStore(db, embeddingModel);
    const auditStore = new PermissionAuditStore(db);

    // Mock HIL callback that rejects
    const mockHilCallback = async (_request: PermissionEscalationRequest) => {
      return { approved: false, feedback: "Filesystem access not needed for this task" };
    };

    const handler = new PermissionEscalationHandler(capStore, auditStore, mockHilCallback);

    try {
      // Create capability
      const { capability: cap } = await capStore.saveCapability({
        code: `await Deno.writeTextFile("/etc/config.json", "{}");`,
        intent: "Write system configuration",
        durationMs: 50,
        success: true,
      });

      // Handle permission error
      const result = await handler.handlePermissionError(
        cap.id,
        "minimal",
        "PermissionDenied: Requires write access to /etc/config.json",
        "exec-reject-1",
      );

      // Verify rejection
      assertEquals(result.handled, true);
      assertEquals(result.approved, false);
      assertEquals(result.feedback, "Filesystem access not needed for this task");

      // Verify capability NOT updated
      const unchangedCap = await capStore.findById(cap.id);
      assertEquals(unchangedCap?.permissionSet, "minimal");

      // Verify audit log shows rejection
      const auditLogs = await auditStore.getAuditLogForCapability(cap.id);
      assertEquals(auditLogs.length, 1);
      assertEquals(auditLogs[0].approved, false);
    } finally {
      await db.close();
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "E2E: Security-critical permission blocked (run)",
  async fn() {
    const db = await initializeTestDatabase();
    const embeddingModel = getMockEmbedding();
    const capStore = new CapabilityStore(db, embeddingModel);
    const auditStore = new PermissionAuditStore(db);

    // HIL callback should NEVER be called for security-critical
    let hilCalled = false;
    const mockHilCallback = async (_request: PermissionEscalationRequest) => {
      hilCalled = true;
      return { approved: true };
    };

    const handler = new PermissionEscalationHandler(capStore, auditStore, mockHilCallback);

    try {
      // Create capability that tries to run shell commands
      const { capability: cap } = await capStore.saveCapability({
        code: `const proc = Deno.run({ cmd: ["ls", "-la"] });`,
        intent: "List directory contents via shell",
        durationMs: 100,
        success: true,
      });

      // Try to handle run permission error
      const result = await handler.handlePermissionError(
        cap.id,
        "minimal",
        "PermissionDenied: Requires run access to /usr/bin/ls",
        "exec-security-1",
      );

      // Verify blocked at escalation suggestion level (never reaches HIL)
      assertEquals(result.handled, false);
      assertEquals(result.approved, false);
      assertEquals(
        result.error?.includes("security-critical") || result.error?.includes("unsupported"),
        true,
      );

      // HIL callback should NOT have been called
      assertEquals(hilCalled, false);

      // No audit log since request was blocked before HIL
      const auditLogs = await auditStore.getAuditLogForCapability(cap.id);
      assertEquals(auditLogs.length, 0);
    } finally {
      await db.close();
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "E2E: Progressive escalation (minimal -> readonly -> filesystem)",
  async fn() {
    const db = await initializeTestDatabase();
    const embeddingModel = getMockEmbedding();
    const capStore = new CapabilityStore(db, embeddingModel);
    const auditStore = new PermissionAuditStore(db);

    const mockHilCallback = async (_request: PermissionEscalationRequest) => {
      return { approved: true };
    };

    const handler = new PermissionEscalationHandler(capStore, auditStore, mockHilCallback);

    try {
      // Create capability
      const { capability: cap } = await capStore.saveCapability({
        code:
          `const data = await Deno.readTextFile("/config.json"); await Deno.writeTextFile("/config.json", data);`,
        intent: "Read and update configuration",
        durationMs: 100,
        success: true,
      });

      // First escalation: read access (minimal -> readonly)
      const exec1 = "exec-prog-1";
      const result1 = await handler.handlePermissionError(
        cap.id,
        "minimal",
        "PermissionDenied: Requires read access to /config.json",
        exec1,
      );
      assertEquals(result1.approved, true);
      assertEquals(result1.newPermissionSet, "readonly");

      // Reset for next execution
      handler.resetAttempts(exec1);

      // Second escalation: write access (readonly -> filesystem)
      const exec2 = "exec-prog-2";
      const result2 = await handler.handlePermissionError(
        cap.id,
        "readonly", // Now at readonly after first escalation
        "PermissionDenied: Requires write access to /config.json",
        exec2,
      );
      assertEquals(result2.approved, true);
      assertEquals(result2.newPermissionSet, "filesystem");

      // Verify final state
      const finalCap = await capStore.findById(cap.id);
      assertEquals(finalCap?.permissionSet, "filesystem");

      // Verify audit trail shows both escalations
      const auditLogs = await auditStore.getAuditLogForCapability(cap.id);
      assertEquals(auditLogs.length, 2);
    } finally {
      await db.close();
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "E2E: formatEscalationRequest produces correct output",
  fn() {
    // Create a mock escalation request
    const request = suggestEscalation(
      "PermissionDenied: Requires net access to api.github.com:443",
      "cap-format-test",
      "minimal",
    );

    assertNotEquals(request, null);
    const formatted = formatEscalationRequest(request!);

    // Verify all required information is present
    assertEquals(formatted.includes("Permission Escalation Request"), true);
    assertEquals(formatted.includes("cap-format-test"), true);
    assertEquals(formatted.includes("minimal"), true);
    assertEquals(formatted.includes("network-api"), true);
    assertEquals(formatted.includes("net"), true);
    assertEquals(formatted.includes("[A]pprove"), true);
    assertEquals(formatted.includes("[R]eject"), true);
  },
});

Deno.test({
  name: "E2E: isSecurityCritical correctly identifies dangerous permissions",
  fn() {
    // Security-critical permissions
    assertEquals(isSecurityCritical("run"), true);
    assertEquals(isSecurityCritical("ffi"), true);

    // Safe permissions
    assertEquals(isSecurityCritical("read"), false);
    assertEquals(isSecurityCritical("write"), false);
    assertEquals(isSecurityCritical("net"), false);
    assertEquals(isSecurityCritical("env"), false);
  },
});

// ===================================================================
// CONTROLLED EXECUTOR INTEGRATION TESTS (Story 7.7c - AC3, AC5)
// ===================================================================

import { ControlledExecutor } from "../../src/dag/controlled-executor.ts";
import type { ExecutionEvent } from "../../src/dag/types.ts";
import type { DAGStructure } from "../../src/graphrag/types.ts";

Deno.test({
  name: "E2E: ControlledExecutor permission escalation integration - setter and getter",
  async fn() {
    const db = await initializeTestDatabase();
    const embeddingModel = getMockEmbedding();
    const capStore = new CapabilityStore(db, embeddingModel);
    const auditStore = new PermissionAuditStore(db);

    // Mock tool executor
    const mockToolExecutor = async (_tool: string, _args: Record<string, unknown>) => ({});

    // Create executor with permission escalation dependencies
    const executor = new ControlledExecutor(mockToolExecutor, { userId: "test-user" });

    // Set learning dependencies first (required for permission escalation)
    executor.setLearningDependencies(capStore);

    // Set permission escalation dependencies
    executor.setPermissionEscalationDependencies(auditStore);

    // Verify audit store is accessible
    const retrievedAuditStore = executor.getPermissionAuditStore();
    assertNotEquals(retrievedAuditStore, null);

    await db.close();
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "E2E: ControlledExecutor capability task with permission escalation available",
  async fn() {
    const db = await initializeTestDatabase();
    const embeddingModel = getMockEmbedding();
    const capStore = new CapabilityStore(db, embeddingModel);
    const auditStore = new PermissionAuditStore(db);

    // Create a simple capability
    const { capability: cap } = await capStore.saveCapability({
      code: "return 42;", // Simple code that doesn't need permissions
      intent: "Return the answer to everything",
      durationMs: 10,
      success: true,
    });

    // Mock tool executor
    const mockToolExecutor = async (_tool: string, _args: Record<string, unknown>) => ({});

    // Create executor with full setup
    const executor = new ControlledExecutor(mockToolExecutor, { userId: "test-user" });
    executor.setLearningDependencies(capStore);
    executor.setPermissionEscalationDependencies(auditStore);

    // Create a simple DAG with capability task
    const dag: DAGStructure = {
      tasks: [
        {
          id: "simple_cap",
          tool: "capability",
          type: "capability",
          capabilityId: cap.id,
          code: "return 42;",
          arguments: {},
          dependsOn: [],
        },
      ],
    };

    // Execute and collect events
    const events: ExecutionEvent[] = [];
    for await (const event of executor.executeStream(dag)) {
      events.push(event);
    }

    // Verify workflow completed successfully
    const workflowComplete = events.find((e) => e.type === "workflow_complete");
    assertNotEquals(workflowComplete, undefined);

    if (workflowComplete && workflowComplete.type === "workflow_complete") {
      assertEquals(workflowComplete.successfulTasks, 1);
      assertEquals(workflowComplete.failedTasks, 0);
    }

    await db.close();
  },
  sanitizeOps: false,
  sanitizeResources: false,
});
