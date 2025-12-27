/**
 * Unit tests for Permission Set Integration in Sandbox Executor
 *
 * Story: 7.7b - Sandbox Permission Integration
 *
 * Tests:
 * - permissionSetToFlags() for all 6 permission sets (AC#9)
 * - supportsPermissionSets() version detection (AC#11)
 * - determinePermissionSet() confidence threshold logic (AC#8)
 * - buildCommand() includes correct flags based on permission set
 *
 * @module tests/unit/sandbox/permission_integration_test
 */

import { assertEquals, assertExists } from "@std/assert";
import {
  DenoSandboxExecutor,
  determinePermissionSet,
  PERMISSION_CONFIDENCE_THRESHOLD,
} from "../../../src/sandbox/executor.ts";
import type { PermissionSet } from "../../../src/capabilities/types.ts";

// ==========================================================================
// AC#9: Unit Tests - Permission Set to Flags Mapping
// ==========================================================================

Deno.test("permissionSetToFlags - minimal returns empty array (deny all)", () => {
  const executor = new DenoSandboxExecutor();
  const flags = executor.permissionSetToFlags("minimal");

  assertEquals(flags, []);
});

Deno.test("permissionSetToFlags - readonly returns --allow-read=./data,/tmp", () => {
  const executor = new DenoSandboxExecutor();
  const flags = executor.permissionSetToFlags("readonly");

  assertEquals(flags, ["--allow-read=./data,/tmp"]);
});

Deno.test("permissionSetToFlags - filesystem returns --allow-read and --allow-write=/tmp", () => {
  const executor = new DenoSandboxExecutor();
  const flags = executor.permissionSetToFlags("filesystem");

  assertEquals(flags, ["--allow-read", "--allow-write=/tmp"]);
});

Deno.test("permissionSetToFlags - network-api returns --allow-net", () => {
  const executor = new DenoSandboxExecutor();
  const flags = executor.permissionSetToFlags("network-api");

  assertEquals(flags, ["--allow-net"]);
});

Deno.test("permissionSetToFlags - mcp-standard returns read, write, net, limited env", () => {
  const executor = new DenoSandboxExecutor();
  const flags = executor.permissionSetToFlags("mcp-standard");

  assertEquals(flags, [
    "--allow-read",
    "--allow-write=/tmp,./output",
    "--allow-net",
    "--allow-env=HOME,PATH",
  ]);
});

Deno.test("permissionSetToFlags - trusted returns --allow-all", () => {
  const executor = new DenoSandboxExecutor();
  const flags = executor.permissionSetToFlags("trusted");

  assertEquals(flags, ["--allow-all"]);
});

Deno.test("permissionSetToFlags - unknown permission set returns empty (fallback to minimal)", () => {
  const executor = new DenoSandboxExecutor();
  // @ts-expect-error Testing invalid permission set
  const flags = executor.permissionSetToFlags("invalid-set");

  assertEquals(flags, []);
});

// ==========================================================================
// AC#11: Unit Tests - Deno Version Detection
// ==========================================================================

Deno.test("supportsPermissionSets - returns boolean based on Deno version", () => {
  const executor = new DenoSandboxExecutor();
  const result = executor.supportsPermissionSets();

  // Result should be a boolean
  assertEquals(typeof result, "boolean");

  // Should be consistent (cached)
  assertEquals(executor.supportsPermissionSets(), result);
});

Deno.test("supportsPermissionSets - result is cached for performance", () => {
  const executor = new DenoSandboxExecutor();

  // First call
  const first = executor.supportsPermissionSets();

  // Second call should return same result (from cache)
  const second = executor.supportsPermissionSets();

  assertEquals(first, second);
});

Deno.test("supportsPermissionSets - current Deno version check", () => {
  const executor = new DenoSandboxExecutor();

  // Parse current Deno version
  const [major, minor] = Deno.version.deno.split(".").map(Number);
  const expectedSupport = major > 2 || (major === 2 && minor >= 5);

  assertEquals(executor.supportsPermissionSets(), expectedSupport);
});

// ==========================================================================
// AC#8: Unit Tests - Confidence Threshold Logic
// ==========================================================================

Deno.test("determinePermissionSet - manual source always uses stored permission set", () => {
  const capability = {
    source: "manual" as const,
    permissionSet: "network-api" as PermissionSet,
    permissionConfidence: 0.3, // Low confidence should be ignored for manual
    id: "test-cap-1",
  };

  const result = determinePermissionSet(capability);

  assertEquals(result, "network-api");
});

Deno.test("determinePermissionSet - manual source without permission set defaults to mcp-standard", () => {
  const capability = {
    source: "manual" as const,
    permissionConfidence: 0.9,
    id: "test-cap-2",
  };

  const result = determinePermissionSet(capability);

  assertEquals(result, "mcp-standard");
});

Deno.test("determinePermissionSet - emergent with low confidence uses minimal", () => {
  const capability = {
    source: "emergent" as const,
    permissionSet: "filesystem" as PermissionSet,
    permissionConfidence: 0.5, // Below threshold (0.7)
    id: "test-cap-3",
  };

  const result = determinePermissionSet(capability);

  assertEquals(result, "minimal");
});

Deno.test("determinePermissionSet - emergent with high confidence uses inferred permission", () => {
  const capability = {
    source: "emergent" as const,
    permissionSet: "filesystem" as PermissionSet,
    permissionConfidence: 0.85, // Above threshold (0.7)
    id: "test-cap-4",
  };

  const result = determinePermissionSet(capability);

  assertEquals(result, "filesystem");
});

Deno.test("determinePermissionSet - emergent at exactly threshold uses inferred permission", () => {
  const capability = {
    source: "emergent" as const,
    permissionSet: "network-api" as PermissionSet,
    permissionConfidence: PERMISSION_CONFIDENCE_THRESHOLD, // Exactly 0.7
    id: "test-cap-5",
  };

  const result = determinePermissionSet(capability);

  assertEquals(result, "network-api");
});

Deno.test("determinePermissionSet - emergent just below threshold uses minimal", () => {
  const capability = {
    source: "emergent" as const,
    permissionSet: "trusted" as PermissionSet,
    permissionConfidence: PERMISSION_CONFIDENCE_THRESHOLD - 0.01, // 0.69
    id: "test-cap-6",
  };

  const result = determinePermissionSet(capability);

  assertEquals(result, "minimal");
});

Deno.test("determinePermissionSet - emergent with undefined confidence uses minimal", () => {
  const capability = {
    source: "emergent" as const,
    permissionSet: "filesystem" as PermissionSet,
    // permissionConfidence is undefined
    id: "test-cap-7",
  };

  const result = determinePermissionSet(capability);

  assertEquals(result, "minimal");
});

Deno.test("determinePermissionSet - emergent high confidence but no permission set uses minimal", () => {
  const capability = {
    source: "emergent" as const,
    permissionConfidence: 0.95,
    // permissionSet is undefined
    id: "test-cap-8",
  };

  const result = determinePermissionSet(capability);

  assertEquals(result, "minimal");
});

// ==========================================================================
// Constant Validation
// ==========================================================================

Deno.test("PERMISSION_CONFIDENCE_THRESHOLD is 0.7", () => {
  assertEquals(PERMISSION_CONFIDENCE_THRESHOLD, 0.7);
});

// ==========================================================================
// Execute Method with Permission Set
// ==========================================================================

Deno.test("execute - accepts permissionSet parameter", async () => {
  const executor = new DenoSandboxExecutor({ timeout: 5000 });

  // Simple code that doesn't need network
  const result = await executor.execute("return 1 + 1", {}, "minimal");

  assertEquals(result.success, true);
  assertEquals(result.result, 2);
});

Deno.test("execute - default permission set is minimal", async () => {
  const executor = new DenoSandboxExecutor({ timeout: 5000 });

  // Code should succeed with minimal permissions
  const result = await executor.execute("return 'hello'");

  assertEquals(result.success, true);
  assertEquals(result.result, "hello");
});

Deno.test("execute - minimal permission set blocks network", async () => {
  const executor = new DenoSandboxExecutor({ timeout: 10000 });

  // Code that attempts network access
  const result = await executor.execute(
    `const r = await fetch("https://example.com"); return r.status`,
    {},
    "minimal",
  );

  // Should fail with permission denied
  assertEquals(result.success, false);
  assertExists(result.error);
  // Error should mention permission
  assertEquals(
    result.error.type === "PermissionError" ||
      result.error.message?.toLowerCase().includes("permission"),
    true,
  );
});

Deno.test("execute - network-api permission set allows fetch (subprocess only)", async () => {
  // Permission sets only work with subprocess mode.
  // Worker mode always uses permissions: "none" for 100% traceability (all I/O via MCP RPC).
  const executor = new DenoSandboxExecutor({
    timeout: 15000,
    useWorkerForExecute: false, // Subprocess mode for permission set support
  });

  // Code that performs network access (using reliable endpoint pattern from E2E tests)
  const result = await executor.execute(
    `
    try {
      const response = await fetch("https://www.google.com/robots.txt");
      return { connected: true, status: response.status };
    } catch (e) {
      return { connected: false, error: e.message };
    }
    `,
    {},
    "network-api",
  );

  // Should succeed with network-api permissions
  assertEquals(
    result.success,
    true,
    `Expected success but got error: ${JSON.stringify(result.error)}`,
  );
  const res = result.result as { connected: boolean; status?: number; error?: string };
  assertEquals(res.connected, true, `Network should be allowed: ${res.error}`);
});

Deno.test("execute - minimal permission set blocks env access", async () => {
  const executor = new DenoSandboxExecutor({ timeout: 5000 });

  // Code that attempts env access
  const result = await executor.execute(
    `return Deno.env.get("HOME") || "none"`,
    {},
    "minimal",
  );

  // Should fail with permission denied
  assertEquals(result.success, false);
  assertExists(result.error);
});
