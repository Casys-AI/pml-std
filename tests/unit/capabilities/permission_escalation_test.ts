/**
 * Unit Tests for Permission Escalation (Story 7.7c)
 *
 * Tests:
 * 1. suggestEscalation() parses PermissionDenied errors correctly
 * 2. Valid escalation paths are enforced
 * 3. Confidence scoring works correctly
 *
 * Note: 3-axis permission model (ffi, run) removed - permissions via mcp-permissions.yaml
 *
 * @module tests/unit/capabilities/permission_escalation_test
 */

import { assertEquals, assertNotEquals, assertStrictEquals } from "@std/assert";
import {
  getValidEscalationTargets,
  isSandboxEscapePermission,
  isSecurityCritical,
  isValidEscalation,
  suggestEscalation,
} from "../../../src/capabilities/permission-escalation.ts";

// ===================================================================
// PERMISSION DENIED ERROR PARSING
// ===================================================================

Deno.test("suggestEscalation - parses network permission denied error", () => {
  const error =
    "PermissionDenied: Requires net access to api.example.com:443, run again with --allow-net";
  const result = suggestEscalation(error, "cap-123", "minimal");

  assertNotEquals(result, null);
  assertEquals(result?.detectedOperation, "net");
  assertEquals(result?.requestedSet, "network-api");
  assertEquals(result?.capabilityId, "cap-123");
  assertEquals(result?.currentSet, "minimal");
  assertEquals(result?.reason, error);
});

Deno.test("suggestEscalation - parses read permission denied error", () => {
  const error = "PermissionDenied: Requires read access to /etc/config.json";
  const result = suggestEscalation(error, "cap-456", "minimal");

  assertNotEquals(result, null);
  assertEquals(result?.detectedOperation, "read");
  assertEquals(result?.requestedSet, "readonly");
});

Deno.test("suggestEscalation - parses write permission denied error", () => {
  const error = "PermissionDenied: Requires write access to /tmp/output.txt";
  const result = suggestEscalation(error, "cap-789", "minimal");

  assertNotEquals(result, null);
  assertEquals(result?.detectedOperation, "write");
  assertEquals(result?.requestedSet, "filesystem");
});

Deno.test("suggestEscalation - parses env permission denied error", () => {
  const error = 'PermissionDenied: Requires env access to "API_KEY"';
  const result = suggestEscalation(error, "cap-env", "minimal");

  assertNotEquals(result, null);
  assertEquals(result?.detectedOperation, "env");
  assertEquals(result?.requestedSet, "mcp-standard");
});

// ===================================================================
// SANDBOX-ESCAPE PERMISSIONS (FFI, RUN) - REMOVED
// toolConfig.ffi/run no longer used - permissions managed via mcp-permissions.yaml
// ===================================================================

Deno.test("suggestEscalation - returns escalation request for ffi without config", () => {
  const error = "PermissionDenied: Requires ffi access";
  // No toolConfig provided
  const result = suggestEscalation(error, "cap-unknown", "minimal");

  // Should return request (not null) but with lower confidence
  assertNotEquals(result, null);
  assertEquals(result?.detectedOperation, "ffi");
  assertEquals(result?.confidence, 0.5); // Lower confidence - not explicitly declared
});

Deno.test("suggestEscalation - returns escalation request for run without config", () => {
  const error = "PermissionDenied: Requires run access to /bin/sh";
  // No toolConfig provided
  const result = suggestEscalation(error, "cap-unknown", "minimal");

  // Should return request (not null) for HIL to handle
  assertNotEquals(result, null);
  assertEquals(result?.detectedOperation, "run");
  assertEquals(result?.confidence, 0.5);
});

Deno.test("isSandboxEscapePermission - identifies run", () => {
  assertEquals(isSandboxEscapePermission("run"), true);
});

Deno.test("isSandboxEscapePermission - identifies ffi", () => {
  assertEquals(isSandboxEscapePermission("ffi"), true);
});

Deno.test("isSandboxEscapePermission - net is not sandbox-escape", () => {
  assertEquals(isSandboxEscapePermission("net"), false);
});

Deno.test("isSandboxEscapePermission - read is not sandbox-escape", () => {
  assertEquals(isSandboxEscapePermission("read"), false);
});

// Legacy function (deprecated but still works)
Deno.test("isSecurityCritical - identifies run (legacy API)", () => {
  assertEquals(isSecurityCritical("run"), true);
});

Deno.test("isSecurityCritical - identifies ffi (legacy API)", () => {
  assertEquals(isSecurityCritical("ffi"), true);
});

Deno.test("isSecurityCritical - net is not security-critical", () => {
  assertEquals(isSecurityCritical("net"), false);
});

Deno.test("isSecurityCritical - read is not security-critical", () => {
  assertEquals(isSecurityCritical("read"), false);
});

// ===================================================================
// VALID ESCALATION PATHS
// ===================================================================

Deno.test("isValidEscalation - minimal can escalate to readonly", () => {
  assertEquals(isValidEscalation("minimal", "readonly"), true);
});

Deno.test("isValidEscalation - minimal can escalate to filesystem", () => {
  assertEquals(isValidEscalation("minimal", "filesystem"), true);
});

Deno.test("isValidEscalation - minimal can escalate to network-api", () => {
  assertEquals(isValidEscalation("minimal", "network-api"), true);
});

Deno.test("isValidEscalation - minimal can escalate to mcp-standard", () => {
  assertEquals(isValidEscalation("minimal", "mcp-standard"), true);
});

Deno.test("isValidEscalation - minimal cannot escalate to trusted", () => {
  // trusted is manual-only
  assertEquals(isValidEscalation("minimal", "trusted"), false);
});

Deno.test("isValidEscalation - readonly can escalate to filesystem", () => {
  assertEquals(isValidEscalation("readonly", "filesystem"), true);
});

Deno.test("isValidEscalation - readonly can escalate to mcp-standard", () => {
  assertEquals(isValidEscalation("readonly", "mcp-standard"), true);
});

Deno.test("isValidEscalation - readonly cannot escalate to network-api", () => {
  // readonly doesn't include network, so direct jump isn't valid
  assertEquals(isValidEscalation("readonly", "network-api"), false);
});

Deno.test("isValidEscalation - mcp-standard cannot escalate further", () => {
  assertEquals(isValidEscalation("mcp-standard", "trusted"), false);
});

Deno.test("isValidEscalation - trusted cannot escalate", () => {
  assertEquals(getValidEscalationTargets("trusted").length, 0);
});

// ===================================================================
// VALID ESCALATION TARGETS
// ===================================================================

Deno.test("getValidEscalationTargets - minimal has 4 targets", () => {
  const targets = getValidEscalationTargets("minimal");
  assertEquals(targets.length, 4);
  assertEquals(targets.includes("readonly"), true);
  assertEquals(targets.includes("filesystem"), true);
  assertEquals(targets.includes("network-api"), true);
  assertEquals(targets.includes("mcp-standard"), true);
});

Deno.test("getValidEscalationTargets - mcp-standard has 0 targets", () => {
  const targets = getValidEscalationTargets("mcp-standard");
  assertEquals(targets.length, 0);
});

// ===================================================================
// CONFIDENCE SCORING
// ===================================================================

Deno.test("suggestEscalation - confidence score is between 0 and 1", () => {
  const error = "PermissionDenied: Requires net access to api.example.com:443";
  const result = suggestEscalation(error, "cap-123", "minimal");

  assertNotEquals(result, null);
  assertEquals(result!.confidence > 0, true);
  assertEquals(result!.confidence <= 1, true);
});

Deno.test("suggestEscalation - specific resource path increases confidence", () => {
  const errorWithPath = "PermissionDenied: Requires net access to api.example.com:443";

  const resultWithPath = suggestEscalation(errorWithPath, "cap-1", "minimal");

  assertNotEquals(resultWithPath, null);
  // API patterns with :443 should have higher confidence
  assertEquals(resultWithPath!.confidence >= 0.85, true);
});

// ===================================================================
// NON-PERMISSION ERRORS
// ===================================================================

Deno.test("suggestEscalation - returns null for non-permission errors", () => {
  const error = "TypeError: Cannot read property 'foo' of undefined";
  const result = suggestEscalation(error, "cap-123", "minimal");

  assertStrictEquals(result, null);
});

Deno.test("suggestEscalation - returns null for unknown permission format", () => {
  const error = "PermissionDenied: Something unknown happened";
  const result = suggestEscalation(error, "cap-123", "minimal");

  // Should return null if we can't parse the specific permission
  assertStrictEquals(result, null);
});

// ===================================================================
// ESCALATION PATH FINDING
// ===================================================================

Deno.test("suggestEscalation - finds valid path from readonly when needing network", () => {
  // readonly + net = needs mcp-standard (since readonly->network-api isn't valid)
  const error = "PermissionDenied: Requires net access to api.test.com";
  const result = suggestEscalation(error, "cap-combo", "readonly");

  assertNotEquals(result, null);
  // Should suggest mcp-standard since that includes both filesystem (from readonly) and network
  assertEquals(result?.requestedSet, "mcp-standard");
});

Deno.test("suggestEscalation - returns null when no valid escalation exists", () => {
  // From mcp-standard, no further escalation is allowed
  const error = "PermissionDenied: Requires net access to api.test.com";
  const result = suggestEscalation(error, "cap-maxed", "mcp-standard");

  // Already at highest auto-escalatable level
  assertStrictEquals(result, null);
});

// ===================================================================
// 3-AXIS PERMISSION MODEL TESTS - REMOVED
// ffi/run config properties no longer used - permissions via mcp-permissions.yaml
// ===================================================================

Deno.test("suggestEscalation - handles legacy trusted value", () => {
  const error = "PermissionDenied: Requires net access to api.test.com";
  // trusted should map to mcp-standard internally
  const result = suggestEscalation(error, "cap-trusted", "trusted");

  // Should return null because trusted (mcp-standard) has no valid escalation for net
  assertStrictEquals(result, null);
});

Deno.test("getValidEscalationTargets - handles legacy trusted value", () => {
  const targets = getValidEscalationTargets("trusted");
  // trusted maps to mcp-standard which has 0 targets
  assertEquals(targets.length, 0);
});

Deno.test("isValidEscalation - handles legacy trusted value", () => {
  // trusted maps to mcp-standard, which cannot escalate
  assertEquals(isValidEscalation("trusted", "mcp-standard"), false);
});
