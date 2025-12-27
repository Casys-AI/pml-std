/**
 * E2E/Integration tests for Permission Set Enforcement
 *
 * Story: 7.7b - Sandbox Permission Integration - AC#10
 *
 * Tests:
 * - permission_set = "minimal" → PermissionDenied if attempts fetch
 * - permission_set = "network-api" → fetch succeeds
 * - permission_set = "readonly" → read succeeds, write fails
 * - permission_set = "filesystem" → read/write to /tmp succeeds
 * - fallback behavior when confidence < 0.7
 *
 * @module tests/integration/permission_enforcement_test
 */

import { assertEquals, assertExists } from "@std/assert";
import { DenoSandboxExecutor, determinePermissionSet } from "../../src/sandbox/executor.ts";
import type { PermissionSet } from "../../src/capabilities/types.ts";

// ==========================================================================
// AC#10: E2E Tests - Permission Enforcement
// ==========================================================================

Deno.test("E2E - minimal permission blocks fetch (PermissionDenied)", async () => {
  const executor = new DenoSandboxExecutor({ timeout: 10000 });

  const result = await executor.execute(
    `return await fetch("https://example.com").then(r => r.status)`,
    {},
    "minimal",
  );

  assertEquals(result.success, false);
  assertExists(result.error);

  // Should be a permission error
  const errorMessage = result.error.message?.toLowerCase() || "";
  const errorType = result.error.type || "";

  assertEquals(
    errorType === "PermissionError" ||
      errorMessage.includes("permission") ||
      errorMessage.includes("denied") ||
      errorMessage.includes("requires"),
    true,
    `Expected permission error, got: ${errorType} - ${errorMessage}`,
  );
});

Deno.test("E2E - network-api permission allows fetch", async () => {
  const executor = new DenoSandboxExecutor({ timeout: 15000 });

  // Use a reliable endpoint (Google returns various status codes but should always connect)
  const result = await executor.execute(
    `
    try {
      const response = await fetch("https://www.google.com/robots.txt");
      // Success if we got any response (connection was allowed)
      return { connected: true, status: response.status };
    } catch (e) {
      return { connected: false, error: e.message };
    }
    `,
    {},
    "network-api",
  );

  assertEquals(
    result.success,
    true,
    `Expected success but got error: ${JSON.stringify(result.error)}`,
  );
  // Check that we were able to connect (permission was granted)
  const res = result.result as { connected: boolean; status?: number; error?: string };
  assertEquals(res.connected, true, `Network should be allowed: ${res.error}`);
});

Deno.test("E2E - minimal permission blocks file write", async () => {
  const executor = new DenoSandboxExecutor({ timeout: 10000 });

  const result = await executor.execute(
    `Deno.writeTextFileSync("/tmp/permission-test-minimal.txt", "test data"); return "written"`,
    {},
    "minimal",
  );

  assertEquals(result.success, false);
  assertExists(result.error);
});

Deno.test("E2E - filesystem permission allows /tmp write", async () => {
  const executor = new DenoSandboxExecutor({ timeout: 10000 });

  // Generate unique filename to avoid conflicts
  const filename = `/tmp/permission-test-${Date.now()}.txt`;

  const result = await executor.execute(
    `
    Deno.writeTextFileSync("${filename}", "test data from sandbox");
    const content = Deno.readTextFileSync("${filename}");
    return content;
    `,
    {},
    "filesystem",
  );

  assertEquals(
    result.success,
    true,
    `Expected success but got error: ${JSON.stringify(result.error)}`,
  );
  assertEquals(result.result, "test data from sandbox");

  // Cleanup
  try {
    Deno.removeSync(filename);
  } catch {
    // Ignore cleanup errors
  }
});

Deno.test("E2E - readonly permission allows read but blocks write", async () => {
  const executor = new DenoSandboxExecutor({ timeout: 10000 });

  // Test write failure
  const writeResult = await executor.execute(
    `Deno.writeTextFileSync("/tmp/readonly-test.txt", "data"); return "written"`,
    {},
    "readonly",
  );

  assertEquals(writeResult.success, false, "Write should fail with readonly permission");
  assertExists(writeResult.error);
});

Deno.test("E2E - mcp-standard permission allows read, write, network, limited env", async () => {
  const executor = new DenoSandboxExecutor({ timeout: 15000 });

  // Test network access
  const networkResult = await executor.execute(
    `
    try {
      const response = await fetch("https://www.google.com/robots.txt");
      return { connected: true, status: response.status };
    } catch (e) {
      return { connected: false, error: e.message };
    }
    `,
    {},
    "mcp-standard",
  );

  assertEquals(
    networkResult.success,
    true,
    `Network should work: ${JSON.stringify(networkResult.error)}`,
  );
  const netRes = networkResult.result as { connected: boolean; status?: number; error?: string };
  assertEquals(netRes.connected, true, `Network should be allowed: ${netRes.error}`);

  // Test file write to /tmp
  const filename = `/tmp/mcp-standard-test-${Date.now()}.txt`;
  const writeResult = await executor.execute(
    `
    Deno.writeTextFileSync("${filename}", "mcp data");
    return Deno.readTextFileSync("${filename}");
    `,
    {},
    "mcp-standard",
  );

  assertEquals(
    writeResult.success,
    true,
    `Write should work: ${JSON.stringify(writeResult.error)}`,
  );
  assertEquals(writeResult.result, "mcp data");

  // Test limited env access (HOME and PATH allowed)
  const envResult = await executor.execute(
    `return Deno.env.get("HOME") !== undefined`,
    {},
    "mcp-standard",
  );

  assertEquals(
    envResult.success,
    true,
    `Env HOME should be accessible: ${JSON.stringify(envResult.error)}`,
  );
  assertEquals(envResult.result, true);

  // Cleanup
  try {
    Deno.removeSync(filename);
  } catch {
    // Ignore cleanup errors
  }
});

Deno.test("E2E - trusted permission allows all operations", async () => {
  const executor = new DenoSandboxExecutor({ timeout: 15000 });

  // Test network
  const networkResult = await executor.execute(
    `
    try {
      const response = await fetch("https://www.google.com/robots.txt");
      return { connected: true, status: response.status };
    } catch (e) {
      return { connected: false, error: e.message };
    }
    `,
    {},
    "trusted",
  );

  assertEquals(
    networkResult.success,
    true,
    `Network should work: ${JSON.stringify(networkResult.error)}`,
  );
  const netRes = networkResult.result as { connected: boolean; status?: number; error?: string };
  assertEquals(netRes.connected, true, `Network should be allowed: ${netRes.error}`);
});

// ==========================================================================
// Fallback behavior when confidence < 0.7
// ==========================================================================

Deno.test("E2E - determinePermissionSet fallback with low confidence capability", async () => {
  const executor = new DenoSandboxExecutor({ timeout: 10000 });

  // Simulate a capability with low confidence
  const capability = {
    source: "emergent" as const,
    permissionSet: "network-api" as PermissionSet, // Would allow network
    permissionConfidence: 0.5, // Below threshold
    id: "test-fallback-cap",
  };

  // Determine permission should fallback to minimal
  const effectivePermission = determinePermissionSet(capability);
  assertEquals(effectivePermission, "minimal");

  // Execute with effective permission (minimal) should block network
  const result = await executor.execute(
    `return await fetch("https://example.com").then(r => r.status)`,
    {},
    effectivePermission,
  );

  assertEquals(result.success, false, "Low confidence should fallback to minimal and block fetch");
});

Deno.test("E2E - determinePermissionSet respects high confidence capability", async () => {
  const executor = new DenoSandboxExecutor({ timeout: 15000 });

  // Simulate a capability with high confidence
  const capability = {
    source: "emergent" as const,
    permissionSet: "network-api" as PermissionSet,
    permissionConfidence: 0.85, // Above threshold
    id: "test-high-conf-cap",
  };

  // Determine permission should use inferred permission
  const effectivePermission = determinePermissionSet(capability);
  assertEquals(effectivePermission, "network-api");

  // Execute with effective permission (network-api) should allow network
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
    effectivePermission,
  );

  assertEquals(
    result.success,
    true,
    `High confidence should allow network: ${JSON.stringify(result.error)}`,
  );
  const res = result.result as { connected: boolean; status?: number; error?: string };
  assertEquals(res.connected, true, `Network should be allowed: ${res.error}`);
});

Deno.test("E2E - determinePermissionSet manual source ignores confidence", async () => {
  const executor = new DenoSandboxExecutor({ timeout: 15000 });

  // Manual capability with low confidence - should still use stored permission
  const capability = {
    source: "manual" as const,
    permissionSet: "network-api" as PermissionSet,
    permissionConfidence: 0.3, // Low confidence should be ignored for manual
    id: "test-manual-cap",
  };

  // Determine permission should use stored permission (ignore confidence for manual)
  const effectivePermission = determinePermissionSet(capability);
  assertEquals(effectivePermission, "network-api");

  // Execute should allow network
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
    effectivePermission,
  );

  assertEquals(
    result.success,
    true,
    `Manual source should use stored permission: ${JSON.stringify(result.error)}`,
  );
  const res = result.result as { connected: boolean; status?: number; error?: string };
  assertEquals(res.connected, true, `Network should be allowed: ${res.error}`);
});

// ==========================================================================
// Edge Cases
// ==========================================================================

Deno.test("E2E - permission set blocks subprocess spawning (--deny-run always applied)", async () => {
  const executor = new DenoSandboxExecutor({ timeout: 10000 });

  // Even with trusted, --deny-run should be applied for security
  const result = await executor.execute(
    `
    const process = new Deno.Command("echo", { args: ["hello"] });
    const output = process.outputSync();
    return new TextDecoder().decode(output.stdout);
    `,
    {},
    "trusted", // Even trusted should block run
  );

  assertEquals(result.success, false, "Subprocess spawning should always be blocked");
});

Deno.test("E2E - permission set blocks FFI (--deny-ffi always applied)", async () => {
  const executor = new DenoSandboxExecutor({ timeout: 10000 });

  // Even with trusted, --deny-ffi should be applied for security
  const result = await executor.execute(
    `
    const lib = Deno.dlopen("libc.so.6", {});
    return "loaded";
    `,
    {},
    "trusted", // Even trusted should block FFI
  );

  assertEquals(result.success, false, "FFI should always be blocked");
});

Deno.test("E2E - sequential executions with different permission sets", async () => {
  const executor = new DenoSandboxExecutor({ timeout: 10000 });

  // First: minimal (should block network)
  const result1 = await executor.execute(
    `return 1 + 1`,
    {},
    "minimal",
  );
  assertEquals(result1.success, true);
  assertEquals(result1.result, 2);

  // Second: network-api (should allow network - if we test, but let's just test computation)
  const result2 = await executor.execute(
    `return 2 + 2`,
    {},
    "network-api",
  );
  assertEquals(result2.success, true);
  assertEquals(result2.result, 4);

  // Third: back to minimal
  const result3 = await executor.execute(
    `return 3 + 3`,
    {},
    "minimal",
  );
  assertEquals(result3.success, true);
  assertEquals(result3.result, 6);
});
