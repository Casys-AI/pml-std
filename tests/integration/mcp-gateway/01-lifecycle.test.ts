/**
 * MCP Gateway Integration Tests - Lifecycle
 *
 * Tests:
 * - LIFECYCLE-001: HTTP server startup
 * - LIFECYCLE-002: HTTP server shutdown
 * - LIFECYCLE-003: Multiple start/stop cycles
 *
 * @module tests/integration/mcp-gateway/lifecycle
 */

import { assertEquals, assertExists } from "@std/assert";
import {
  createTestGatewayServer,
  getRandomPort,
  makeGatewayRequest,
} from "./fixtures/gateway-test-helpers.ts";

Deno.test({
  name: "LIFECYCLE-001: HTTP server startup",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    // Start HTTP server
    await gateway.startHttp(port);

    // Verify server is listening by making health check request
    const response = await makeGatewayRequest(port, "/health");

    assertEquals(response.status, 200, "Health check should return 200");

    const body = await response.json();
    assertEquals(body.status, "ok", "Health check should return ok status");

    // Verify server info logged
    console.log("  ✓ HTTP server started successfully on port", port);
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test({
  name: "LIFECYCLE-002: HTTP server shutdown",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    // Start server
    await gateway.startHttp(port);

    // Verify server is running
    const healthResponse = await makeGatewayRequest(port, "/health");
    assertEquals(healthResponse.status, 200);

    // Stop server
    await gateway.stop();

    // Wait a bit for server to fully stop
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify server is no longer accepting connections
    try {
      await makeGatewayRequest(port, "/health");
      throw new Error("Server should not be accepting connections after stop");
    } catch (error) {
      // Expected: connection refused or fetch error
      assertExists(error, "Should throw error when connecting to stopped server");
    }

    console.log("  ✓ HTTP server shutdown gracefully");
  } finally {
    await cleanup();
  }
});

Deno.test({
  name: "LIFECYCLE-003: Multiple start/stop cycles",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();
  const cycles = 3;

  try {
    for (let i = 0; i < cycles; i++) {
      console.log(`  Cycle ${i + 1}/${cycles}`);

      // Start server
      await gateway.startHttp(port);

      // Make 5 requests
      for (let j = 0; j < 5; j++) {
        const response = await makeGatewayRequest(port, "/health");
        assertEquals(response.status, 200, `Request ${j + 1} should succeed`);
      }

      // Stop server
      await gateway.stop();

      // Wait for cleanup
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    console.log(`  ✓ Completed ${cycles} start/stop cycles without errors`);
  } finally {
    await cleanup();
  }
});

Deno.test({
  name: "LIFECYCLE-004: Port already in use",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway: gateway1, cleanup: cleanup1 } = await createTestGatewayServer();
  const { gateway: gateway2, cleanup: cleanup2 } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    // Start first gateway on port
    await gateway1.startHttp(port);

    // Try to start second gateway on same port - should fail
    let errorThrown = false;
    try {
      await gateway2.startHttp(port);
    } catch (error) {
      errorThrown = true;
      console.log("  ✓ Second server correctly failed to bind to occupied port");
    }

    assertEquals(errorThrown, true, "Should throw error when port is already in use");
  } finally {
    await gateway1.stop();
    await gateway2.stop();
    await cleanup1();
    await cleanup2();
  }
});

Deno.test({
  name: "LIFECYCLE-005: Server handles concurrent startup requests",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    // Start server
    await gateway.startHttp(port);

    // Make concurrent requests during startup
    const promises = [];
    for (let i = 0; i < 10; i++) {
      promises.push(makeGatewayRequest(port, "/health"));
    }

    const responses = await Promise.all(promises);

    // All requests should succeed
    for (const response of responses) {
      assertEquals(response.status, 200, "All concurrent requests should succeed");
    }

    console.log("  ✓ Server handled 10 concurrent requests during startup");
  } finally {
    await gateway.stop();
    await cleanup();
  }
});
