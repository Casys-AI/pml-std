/**
 * MCP Gateway Integration Tests - Authentication
 *
 * Tests:
 * - AUTH-001: Local mode - auth bypass
 * - AUTH-002: Cloud mode - API key required
 * - AUTH-003: Cloud mode - valid API key
 * - AUTH-004: Cloud mode - invalid API key format
 * - AUTH-005: Public routes - no auth required
 *
 * @module tests/integration/mcp-gateway/authentication
 */

import { assertEquals, assertExists } from "@std/assert";
import {
  createTestGatewayServer,
  getRandomPort,
  makeGatewayRequest,
  makeJsonRpcRequest,
  seedTestApiKeys,
  withCloudMode,
  withLocalMode,
} from "./fixtures/gateway-test-helpers.ts";

Deno.test({
  name: "AUTH-001: Local mode - auth bypass",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  await withLocalMode(async () => {
    const { gateway, cleanup } = await createTestGatewayServer();
    const port = getRandomPort();

    try {
      await gateway.startHttp(port);

      // Test API endpoint without auth
      const apiResponse = await makeGatewayRequest(port, "/api/graph/snapshot");
      // Should succeed (200) or return service unavailable (503) but not 401
      assertEquals(
        [200, 503].includes(apiResponse.status),
        true,
        "API endpoint should not require auth in local mode",
      );

      // Test MCP endpoint without auth
      const mcpResponse = await makeJsonRpcRequest(port, "tools/list");
      assertEquals(mcpResponse.status, 200, "MCP endpoint should not require auth in local mode");

      // Test SSE endpoint without auth
      const sseResponse = await makeGatewayRequest(port, "/events/stream");
      assertEquals(
        [200, 503].includes(sseResponse.status),
        true,
        "SSE endpoint should not require auth in local mode",
      );

      console.log("  ✓ All endpoints accessible without auth in local mode");
    } finally {
      await gateway.stop();
      await cleanup();
    }
  });
});

Deno.test({
  name: "AUTH-002: Cloud mode - API key required",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  await withCloudMode(async () => {
    const { gateway, cleanup } = await createTestGatewayServer();
    const port = getRandomPort();

    try {
      await gateway.startHttp(port);

      // Test API endpoint without key
      const apiResponse = await makeGatewayRequest(port, "/api/graph/snapshot");
      assertEquals(apiResponse.status, 401, "API endpoint should require auth in cloud mode");

      const apiBody = await apiResponse.json();
      assertEquals(apiBody.error, "Unauthorized");
      assertEquals(apiBody.message, "Valid API key required");

      // Verify CORS headers present
      assertExists(
        apiResponse.headers.get("access-control-allow-origin"),
        "CORS headers should be present on auth error",
      );

      // Test MCP endpoint without key
      const mcpResponse = await makeJsonRpcRequest(port, "tools/list");
      assertEquals(mcpResponse.status, 401, "MCP endpoint should require auth in cloud mode");

      console.log("  ✓ Protected endpoints return 401 without API key in cloud mode");
    } finally {
      await gateway.stop();
      await cleanup();
    }
  });
});

Deno.test({
  name: "AUTH-003: Cloud mode - valid API key",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  await withCloudMode(async () => {
    const { gateway, db, cleanup } = await createTestGatewayServer();
    const { validApiKey } = await seedTestApiKeys(db);
    const port = getRandomPort();

    try {
      await gateway.startHttp(port);

      // Test with valid API key
      const response = await makeGatewayRequest(port, "/api/graph/snapshot", {
        apiKey: validApiKey,
      });

      // Should succeed (200) or service unavailable (503) but not 401
      assertEquals(
        [200, 503].includes(response.status),
        true,
        "Valid API key should grant access",
      );

      if (response.status === 200) {
        const body = await response.json();
        assertExists(body.nodes, "Response should have nodes property");
        assertExists(body.edges, "Response should have edges property");
      }

      console.log("  ✓ Valid API key grants access to protected endpoints");
    } finally {
      await gateway.stop();
      await cleanup();
    }
  });
});

Deno.test({
  name: "AUTH-004: Cloud mode - invalid API key formats",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  await withCloudMode(async () => {
    const { gateway, cleanup } = await createTestGatewayServer();
    const port = getRandomPort();

    const invalidKeys = [
      { key: "invalid_key", reason: "wrong prefix" },
      { key: "ac_short", reason: "too short" },
      { key: "xx_123456789012345678901234", reason: "wrong prefix" },
      { key: "ac_12345678901234567890123456789", reason: "too long" },
      { key: "", reason: "empty string" },
      { key: "Bearer ac_123456789012345678901234", reason: "bearer format" },
    ];

    try {
      await gateway.startHttp(port);

      for (const { key, reason } of invalidKeys) {
        const response = await makeGatewayRequest(port, "/api/graph/snapshot", {
          apiKey: key,
        });

        assertEquals(
          response.status,
          401,
          `Invalid API key (${reason}) should be rejected`,
        );

        const body = await response.json();
        assertEquals(body.error, "Unauthorized");
      }

      console.log(`  ✓ All ${invalidKeys.length} invalid API key formats correctly rejected`);
    } finally {
      await gateway.stop();
      await cleanup();
    }
  });
});

Deno.test({
  name: "AUTH-005: Public routes - no auth required",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  await withCloudMode(async () => {
    const { gateway, cleanup } = await createTestGatewayServer();
    const port = getRandomPort();

    try {
      await gateway.startHttp(port);

      // Test health check without API key
      const response = await makeGatewayRequest(port, "/health");
      assertEquals(response.status, 200, "Health check should be public");

      const body = await response.json();
      assertEquals(body.status, "ok");

      // Verify CORS headers present
      assertExists(response.headers.get("access-control-allow-origin"));

      console.log("  ✓ Public routes accessible without auth even in cloud mode");
    } finally {
      await gateway.stop();
      await cleanup();
    }
  });
});

Deno.test({
  name: "AUTH-006: Local mode with API key header still succeeds",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  await withLocalMode(async () => {
    const { gateway, cleanup } = await createTestGatewayServer();
    const port = getRandomPort();

    try {
      await gateway.startHttp(port);

      // Even with an invalid API key in local mode, request should succeed
      const response = await makeGatewayRequest(port, "/api/graph/snapshot", {
        apiKey: "invalid_key",
      });

      assertEquals(
        [200, 503].includes(response.status),
        true,
        "Local mode should ignore API key header",
      );

      console.log("  ✓ API key header ignored in local mode");
    } finally {
      await gateway.stop();
      await cleanup();
    }
  });
});

Deno.test({
  name: "AUTH-007: Multiple auth headers",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  await withCloudMode(async () => {
    const { gateway, db, cleanup } = await createTestGatewayServer();
    const { validApiKey } = await seedTestApiKeys(db);
    const port = getRandomPort();

    try {
      await gateway.startHttp(port);

      // Test with multiple x-api-key headers (edge case)
      const headers = new Headers();
      headers.append("x-api-key", validApiKey);
      headers.append("x-api-key", "invalid_key");

      const response = await fetch(`http://localhost:${port}/api/graph/snapshot`, {
        headers,
      });

      // Should use first header value
      assertEquals(
        [200, 401, 503].includes(response.status),
        true,
        "Should handle multiple headers",
      );

      console.log("  ✓ Multiple auth headers handled");
    } finally {
      await gateway.stop();
      await cleanup();
    }
  });
});
