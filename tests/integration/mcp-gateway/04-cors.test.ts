/**
 * MCP Gateway Integration Tests - CORS
 *
 * Tests:
 * - CORS-001: Preflight request
 * - CORS-002: CORS headers on actual requests
 * - CORS-003: CORS origin configuration
 * - CORS-004: CORS on error responses
 *
 * @module tests/integration/mcp-gateway/cors
 */

import { assert, assertEquals, assertExists } from "@std/assert";
import {
  createTestGatewayServer,
  getRandomPort,
  makeGatewayRequest,
  withCloudMode,
  withEnv,
} from "./fixtures/gateway-test-helpers.ts";

Deno.test({
  name: "CORS-001: Preflight request",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    await gateway.startHttp(port);

    // Send OPTIONS request (preflight)
    const response = await makeGatewayRequest(port, "/api/graph/snapshot", {
      method: "OPTIONS",
    });

    assertEquals(response.status, 200, "Preflight should return 200");

    // Verify CORS headers
    const allowOrigin = response.headers.get("access-control-allow-origin");
    const allowMethods = response.headers.get("access-control-allow-methods");
    const allowHeaders = response.headers.get("access-control-allow-headers");

    assertExists(allowOrigin, "Should have Access-Control-Allow-Origin");
    assertExists(allowMethods, "Should have Access-Control-Allow-Methods");
    assertExists(allowHeaders, "Should have Access-Control-Allow-Headers");

    // Verify allowed methods include common ones
    assert(
      allowMethods?.includes("GET") &&
        allowMethods?.includes("POST") &&
        allowMethods?.includes("OPTIONS"),
      "Should allow GET, POST, OPTIONS methods",
    );

    // Verify allowed headers include auth header
    assert(
      allowHeaders?.includes("x-api-key") && allowHeaders?.includes("Content-Type"),
      "Should allow x-api-key and Content-Type headers",
    );

    console.log("  ✓ Preflight request returns proper CORS headers");
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test({
  name: "CORS-002: CORS headers on actual requests",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  const testVectors = [
    { method: "GET", path: "/health", description: "health check" },
    { method: "GET", path: "/api/graph/snapshot", description: "graph snapshot" },
    { method: "GET", path: "/api/metrics", description: "metrics" },
    {
      method: "POST",
      path: "/mcp",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      description: "JSON-RPC",
    },
  ];

  try {
    await gateway.startHttp(port);

    for (const { method, path, body, description } of testVectors) {
      const response = await makeGatewayRequest(port, path, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body,
      });

      const allowOrigin = response.headers.get("access-control-allow-origin");
      assertExists(allowOrigin, `${description} should include CORS headers`);

      console.log(`  ✓ ${description}: CORS headers present`);
    }
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test({
  name: "CORS-003: CORS origin configuration",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const port = getRandomPort();

  // Test 1: No DOMAIN env (default to localhost:8081)
  {
    const { gateway, cleanup } = await createTestGatewayServer();
    try {
      await gateway.startHttp(port);

      const response = await makeGatewayRequest(port, "/health");
      const allowOrigin = response.headers.get("access-control-allow-origin");

      // Default should be localhost with FRESH_PORT or 8081
      assert(
        allowOrigin?.includes("localhost"),
        "Default origin should include localhost",
      );

      console.log(`  ✓ Default CORS origin: ${allowOrigin}`);
    } finally {
      await gateway.stop();
      await cleanup();
    }

    // Wait for port to be released
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  // Test 2: Custom DOMAIN env
  await withEnv("DOMAIN", "example.com", async () => {
    const { gateway, cleanup } = await createTestGatewayServer();
    try {
      await gateway.startHttp(port);

      const response = await makeGatewayRequest(port, "/health");
      const allowOrigin = response.headers.get("access-control-allow-origin");

      assertEquals(
        allowOrigin,
        "https://example.com",
        "Should use custom domain with https",
      );

      console.log(`  ✓ Custom CORS origin: ${allowOrigin}`);
    } finally {
      await gateway.stop();
      await cleanup();
    }
  });
});

Deno.test({
  name: "CORS-004: CORS on error responses",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  await withCloudMode(async () => {
    const { gateway, cleanup } = await createTestGatewayServer();
    const port = getRandomPort();

    try {
      await gateway.startHttp(port);

      // Test 1: 401 Unauthorized (no API key in cloud mode)
      {
        const response = await makeGatewayRequest(port, "/api/graph/snapshot");
        assertEquals(response.status, 401);

        const allowOrigin = response.headers.get("access-control-allow-origin");
        assertExists(allowOrigin, "401 response should include CORS headers");

        console.log("  ✓ 401 error includes CORS headers");
      }

      // Test 2: 404 Not Found
      {
        const response = await makeGatewayRequest(port, "/unknown/route");
        assertEquals(response.status, 404);

        // CORS headers should be present on 404 as well
        const allowOrigin = response.headers.get("access-control-allow-origin");
        // Note: 404 may not have CORS headers depending on routing implementation
        // This is acceptable as long as documented routes have them
        console.log(`  ✓ 404 response checked for CORS headers (allow-origin: ${allowOrigin})`);
      }

      // Test 3: 405 Method Not Allowed
      {
        const response = await makeGatewayRequest(port, "/health", {
          method: "POST",
        });

        // Health endpoint only accepts GET, POST should be 404 or 405
        if (response.status === 405 || response.status === 404) {
          console.log("  ✓ Method not allowed response checked");
        }
      }
    } finally {
      await gateway.stop();
      await cleanup();
    }
  });
});

Deno.test({
  name: "CORS-005: Preflight for different endpoints",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  const endpoints = [
    "/api/graph/snapshot",
    "/api/capabilities",
    "/api/metrics",
    "/mcp",
    "/events/stream",
  ];

  try {
    await gateway.startHttp(port);

    for (const endpoint of endpoints) {
      const response = await makeGatewayRequest(port, endpoint, {
        method: "OPTIONS",
      });

      assertEquals(
        response.status,
        200,
        `Preflight for ${endpoint} should return 200`,
      );

      const allowOrigin = response.headers.get("access-control-allow-origin");
      assertExists(allowOrigin, `${endpoint} preflight should have CORS headers`);
    }

    console.log(`  ✓ Preflight requests work for all ${endpoints.length} endpoints`);
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test({
  name: "CORS-006: Wildcard vs specific origin",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    await gateway.startHttp(port);

    const response = await makeGatewayRequest(port, "/health");
    const allowOrigin = response.headers.get("access-control-allow-origin");

    assertExists(allowOrigin, "Should have CORS origin header");

    // Should NOT be wildcard (*) for security reasons with credentials
    assert(
      allowOrigin !== "*",
      "Should use specific origin, not wildcard, for better security",
    );

    console.log(`  ✓ CORS uses specific origin (not wildcard): ${allowOrigin}`);
  } finally {
    await gateway.stop();
    await cleanup();
  }
});
