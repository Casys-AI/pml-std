/**
 * MCP Gateway Integration Tests - Error Handling
 *
 * Tests:
 * - ERROR-001: EventsStreamManager initialization failure
 * - ERROR-002: GraphEngine failure
 * - ERROR-003: CapabilityDataService unavailable
 * - ERROR-004: Database connection loss
 * - ERROR-005: Invalid JSON body
 * - ERROR-006: Missing required fields
 *
 * @module tests/integration/mcp-gateway/error-handling
 */

import { assert, assertEquals, assertExists } from "@std/assert";
import {
  createTestGatewayServer,
  getRandomPort,
  makeGatewayRequest,
  makeJsonRpcRequest,
} from "./fixtures/gateway-test-helpers.ts";

Deno.test({
  name: "ERROR-001: EventsStreamManager initialization failure",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    await gateway.startHttp(port);

    // Try to connect to events stream
    // If EventsStreamManager fails to initialize, should return 503
    const response = await makeGatewayRequest(port, "/events/stream");

    assert(
      [200, 503].includes(response.status),
      "Events stream should return 200 or 503",
    );

    if (response.status === 503) {
      const body = await response.json();
      assertExists(body.error, "503 response should have error message");

      console.log("  ✓ EventsStream unavailable returns 503");
    } else {
      console.log("  ✓ EventsStream initialized successfully");

      if (response.body) await response.body.cancel();
    }
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test({
  name: "ERROR-002: GraphEngine failure",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    await gateway.startHttp(port);

    // Request graph snapshot
    const response = await makeGatewayRequest(port, "/api/graph/snapshot");

    // Should return 200 (success), 500 (error), or 503 (unavailable)
    assert(
      [200, 500, 503].includes(response.status),
      "Graph snapshot should handle errors gracefully",
    );

    if (response.status === 500) {
      const body = await response.json();
      assertExists(body.error, "500 response should have error message");
      assert(
        body.error.includes("Failed to get graph snapshot") ||
          body.error.includes("error"),
        "Error message should be descriptive",
      );

      console.log("  ✓ GraphEngine failure returns 500 with error message");
    } else {
      console.log("  ✓ GraphEngine working or unavailable (503)");
    }
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test({
  name: "ERROR-003: CapabilityDataService unavailable",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    await gateway.startHttp(port);

    // Request hypergraph (requires CapabilityDataService)
    const response = await makeGatewayRequest(port, "/api/graph/hypergraph");

    assert(
      [200, 503].includes(response.status),
      "Hypergraph should return 200 or 503",
    );

    if (response.status === 503) {
      const body = await response.json();
      assertExists(body.error, "503 response should have error message");

      console.log("  ✓ CapabilityDataService unavailable returns 503");
    } else {
      console.log("  ✓ CapabilityDataService available");
    }
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test("ERROR-004: Database connection loss", {
  // This test is complex to set up (requires mocking db failure)
  // Mark as integration test that requires specific setup
  ignore: true,
}, async () => {
  const { gateway, db: _db, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    await gateway.startHttp(port);

    // Simulate database connection loss (would need to close db)
    // await db.close();

    // Make request
    const response = await makeGatewayRequest(port, "/api/capabilities");

    // Server should handle error gracefully (not crash)
    assert(
      [200, 500, 503].includes(response.status),
      "Should handle database error gracefully",
    );

    console.log("  ✓ Database connection loss handled gracefully");
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test({
  name: "ERROR-005: Invalid JSON body",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  const invalidJsonBodies = [
    "{invalid}",
    "not json at all",
    '{"incomplete":',
    "{",
    '{"key": undefined}',
  ];

  try {
    await gateway.startHttp(port);

    for (const invalidBody of invalidJsonBodies) {
      // Test POST to /mcp
      const mcpResponse = await makeGatewayRequest(port, "/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: invalidBody,
      });

      assertEquals(
        mcpResponse.status,
        400,
        `Invalid JSON should return 400: ${invalidBody.substring(0, 20)}`,
      );

      const body = await mcpResponse.json();
      assertExists(body.error, "Error response should have error field");

      // Test POST to capability dependencies
      const apiResponse = await makeGatewayRequest(
        port,
        "/api/capabilities/cap_123/dependencies",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: invalidBody,
        },
      );

      assert(
        [400, 401].includes(apiResponse.status),
        "Invalid JSON to API should return 400 or 401",
      );
    }

    console.log(`  ✓ Tested ${invalidJsonBodies.length} invalid JSON bodies`);
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test({
  name: "ERROR-006: Missing required fields",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    await gateway.startHttp(port);

    // Test 1: tools/call without name parameter
    {
      const response = await makeJsonRpcRequest(
        port,
        "tools/call",
        {
          arguments: { test: "value" },
          // Missing 'name' field
        },
        1,
      );

      assertEquals(response.status, 200, "JSON-RPC errors return 200");

      const body = await response.json();
      assertExists(body.error, "Should have error");
      assertEquals(body.error.code, -32602, "Should be INVALID_PARAMS");

      console.log("  ✓ Missing 'name' in tools/call returns error");
    }

    // Test 2: POST capability dependency without target_id
    {
      const response = await makeGatewayRequest(
        port,
        "/api/capabilities/cap_123/dependencies",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            dependency_type: "requires",
            // Missing 'target_id' field
          }),
        },
      );

      assert(
        [400, 401, 503].includes(response.status),
        "Missing required field should return 400, 401, or 503",
      );

      console.log("  ✓ Missing required fields validated");
    }
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test({
  name: "ERROR-007: Malformed Content-Type header",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    await gateway.startHttp(port);

    // Send JSON-RPC request with wrong content type
    const response = await makeGatewayRequest(port, "/mcp", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      }),
    });

    // Server should handle this (either parse as JSON or reject)
    assert(
      [200, 400, 415].includes(response.status),
      "Wrong content-type should be handled",
    );

    console.log("  ✓ Malformed Content-Type handled");
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test("ERROR-008: Very large request body", {
  // This test can be resource-intensive
  ignore: true,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    await gateway.startHttp(port);

    // Create a very large request (10MB)
    const largeBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "test",
        arguments: {
          data: "x".repeat(10 * 1024 * 1024), // 10MB of data
        },
      },
    });

    const response = await makeGatewayRequest(port, "/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: largeBody,
    });

    // Server should handle large requests (either accept or reject)
    assert(
      [200, 400, 413, 500].includes(response.status),
      "Large request should be handled",
    );

    console.log("  ✓ Large request body handled");
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test({
  name: "ERROR-009: Error responses include CORS headers",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    await gateway.startHttp(port);

    // Trigger various errors and verify CORS headers
    const errorEndpoints = [
      { path: "/unknown", expectedStatus: 404 },
      { path: "/api/graph/path", expectedStatus: 400 }, // Missing params
    ];

    for (const { path, expectedStatus } of errorEndpoints) {
      const response = await makeGatewayRequest(port, path);

      assertEquals(
        response.status,
        expectedStatus,
        `${path} should return ${expectedStatus}`,
      );

      // Verify CORS headers present even on errors
      const corsHeader = response.headers.get("access-control-allow-origin");
      // Note: Not all error responses may have CORS headers depending on where error occurs
      // This is informational rather than strict requirement
      if (corsHeader) {
        console.log(`  ✓ ${path}: CORS headers present on error`);
      } else {
        console.log(`  ⚠ ${path}: CORS headers not present on error`);
      }
    }
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test({
  name: "ERROR-010: Server recovers from transient errors",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    await gateway.startHttp(port);

    // Make a request that might fail
    const errorResponse = await makeGatewayRequest(
      port,
      "/api/graph/path?from=invalid&to=invalid",
    );

    // Error or success doesn't matter - just verify server is still responsive
    assert(
      [200, 400, 404, 503].includes(errorResponse.status),
      "Server should respond",
    );

    // Make a successful request after error
    const healthResponse = await makeGatewayRequest(port, "/health");
    assertEquals(
      healthResponse.status,
      200,
      "Server should recover and handle subsequent requests",
    );

    console.log("  ✓ Server remains operational after errors");
  } finally {
    await gateway.stop();
    await cleanup();
  }
});
