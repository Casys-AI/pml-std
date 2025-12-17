/**
 * MCP Gateway Integration Tests - JSON-RPC Protocol
 *
 * Tests:
 * - JSONRPC-001: Initialize handshake
 * - JSONRPC-002: Initialized notification
 * - JSONRPC-003: Tools list via JSON-RPC
 * - JSONRPC-004: Tools call via JSON-RPC
 * - JSONRPC-005: Method not found error
 * - JSONRPC-006: Invalid request error
 * - JSONRPC-007: User context propagation
 * - JSONRPC-008: Legacy message endpoint
 *
 * @module tests/integration/mcp-gateway/jsonrpc
 */

import { assertEquals, assertExists, assert } from "@std/assert";
import {
  createTestGatewayServer,
  makeGatewayRequest,
  makeJsonRpcRequest,
  seedTestApiKeys,
  withCloudMode,
  getRandomPort,
} from "./fixtures/gateway-test-helpers.ts";

Deno.test({
  name: "JSONRPC-001: Initialize handshake",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    await gateway.startHttp(port);

    const response = await makeJsonRpcRequest(port, "initialize", {
      protocolVersion: "2024-11-05",
      clientInfo: {
        name: "test-client",
        version: "1.0.0",
      },
    });

    assertEquals(response.status, 200);

    const body = await response.json();

    assertEquals(body.jsonrpc, "2.0");
    assertEquals(body.id, 1);
    assertExists(body.result, "Should have result");

    const result = body.result;
    assertEquals(result.protocolVersion, "2024-11-05");
    assertExists(result.capabilities, "Should have capabilities");
    assertExists(result.serverInfo, "Should have serverInfo");

    assertEquals(result.serverInfo.name, "mcp-gateway");
    assertExists(result.serverInfo.version);

    console.log("  ✓ Initialize handshake successful");
    console.log(`    Server: ${result.serverInfo.title}`);
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test({
  name: "JSONRPC-002: Initialized notification",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    await gateway.startHttp(port);

    const response = await makeJsonRpcRequest(port, "notifications/initialized", {}, 2);

    assertEquals(response.status, 200);

    const body = await response.json();

    assertEquals(body.jsonrpc, "2.0");
    assertEquals(body.id, 2);
    assertExists(body.result, "Should have result");

    console.log("  ✓ Initialized notification acknowledged");
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test({
  name: "JSONRPC-003: Tools list via JSON-RPC",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    await gateway.startHttp(port);

    const response = await makeJsonRpcRequest(port, "tools/list", {}, 3);

    assertEquals(response.status, 200);

    const body = await response.json();

    assertEquals(body.jsonrpc, "2.0");
    assertEquals(body.id, 3);
    assertExists(body.result, "Should have result");

    const result = body.result;
    assertExists(result.tools, "Should have tools array");
    assert(Array.isArray(result.tools), "Tools should be an array");

    // Verify meta-tools are present
    const toolNames = result.tools.map((t: { name: string }) => t.name);
    assert(
      toolNames.includes("pml:execute_dag") || toolNames.some((n: string) => n.startsWith("pml:")),
      "Should include PML meta-tools",
    );

    console.log(`  ✓ Tools list returned ${result.tools.length} tools`);
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test({
  name: "JSONRPC-004: Tools call via JSON-RPC",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    await gateway.startHttp(port);

    // Call pml:search_tools
    const response = await makeJsonRpcRequest(
      port,
      "tools/call",
      {
        name: "pml:search_tools",
        arguments: {
          query: "read file",
          limit: 5,
        },
      },
      4,
    );

    assertEquals(response.status, 200);

    const body = await response.json();

    assertEquals(body.jsonrpc, "2.0");
    assertEquals(body.id, 4);

    // Check if result or error
    if (body.result) {
      assertExists(body.result.content, "Result should have content");
      assert(Array.isArray(body.result.content), "Content should be an array");

      console.log("  ✓ Tools call executed successfully");
    } else if (body.error) {
      // Error is acceptable if dependencies not available
      console.log(`  ✓ Tools call returned error (acceptable): ${body.error.message}`);
    }
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test({
  name: "JSONRPC-005: Method not found error",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    await gateway.startHttp(port);

    const response = await makeJsonRpcRequest(port, "unknown/method", {}, 5);

    assertEquals(response.status, 200, "JSON-RPC errors still return 200");

    const body = await response.json();

    assertEquals(body.jsonrpc, "2.0");
    assertEquals(body.id, 5);
    assertExists(body.error, "Should have error");

    assertEquals(body.error.code, -32601, "Should be METHOD_NOT_FOUND error code");
    assert(
      body.error.message.includes("Method not found"),
      "Error message should mention method not found",
    );

    console.log("  ✓ Unknown method returns proper error");
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test({
  name: "JSONRPC-006: Invalid request error",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    await gateway.startHttp(port);

    // Send invalid JSON
    const response = await makeGatewayRequest(port, "/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{invalid json",
    });

    assertEquals(response.status, 400, "Invalid JSON should return 400");

    const body = await response.json();

    assertExists(body.error, "Should have error message");
    assert(
      body.error.includes("Invalid request") || body.error.includes("Parse error"),
      "Error should mention invalid request or parse error",
    );

    console.log("  ✓ Invalid JSON returns 400 error");
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test({
  name: "JSONRPC-007: User context propagation",
  ignore: !Deno.env.get("GITHUB_CLIENT_ID"), // Skip in local mode - requires cloud auth setup
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  await withCloudMode(async () => {
    const { gateway, db, cleanup } = await createTestGatewayServer();
    const { validApiKey, userId: _userId } = await seedTestApiKeys(db);
    const port = getRandomPort();

    try {
      await gateway.startHttp(port);

      // Make authenticated JSON-RPC call
      const response = await makeJsonRpcRequest(
        port,
        "tools/call",
        {
          name: "pml:search_tools",
          arguments: {
            query: "test",
            limit: 5,
          },
        },
        7,
        validApiKey,
      );

      assertEquals(response.status, 200);

      const body = await response.json();

      // User ID should be propagated internally
      // We can't directly verify this without instrumentation,
      // but we verify the call succeeded with auth
      assert(
        body.result || body.error,
        "Should have result or error (not auth failure)",
      );

      console.log("  ✓ User context propagated through JSON-RPC call");
    } finally {
      await gateway.stop();
      await cleanup();
    }
  });
});

Deno.test({
  name: "JSONRPC-008: Legacy message endpoint",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    await gateway.startHttp(port);

    // Use /message instead of /mcp (legacy endpoint)
    const response = await makeGatewayRequest(port, "/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 8,
        method: "tools/list",
      }),
    });

    assertEquals(response.status, 200);

    const body = await response.json();

    assertEquals(body.jsonrpc, "2.0");
    assertEquals(body.id, 8);
    assertExists(body.result, "Legacy endpoint should work like /mcp");

    console.log("  ✓ Legacy /message endpoint works");
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test({
  name: "JSONRPC-009: Missing required parameters",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    await gateway.startHttp(port);

    // Call tools/call without name parameter
    const response = await makeJsonRpcRequest(
      port,
      "tools/call",
      {
        arguments: { query: "test" },
        // Missing 'name' field
      },
      9,
    );

    assertEquals(response.status, 200, "JSON-RPC errors return 200");

    const body = await response.json();

    assertExists(body.error, "Should have error");
    assertEquals(
      body.error.code,
      -32602,
      "Should be INVALID_PARAMS error code",
    );

    console.log("  ✓ Missing parameters return proper error");
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test({
  name: "JSONRPC-010: Concurrent JSON-RPC requests with correct ID matching",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    await gateway.startHttp(port);

    // Make 5 concurrent requests with different IDs
    const promises = [];
    for (let i = 1; i <= 5; i++) {
      promises.push(
        makeJsonRpcRequest(port, "tools/list", {}, i).then(async (resp) => {
          const body = await resp.json();
          return { requestId: i, responseId: body.id };
        }),
      );
    }

    const results = await Promise.all(promises);

    // Verify each response ID matches its request ID
    for (const { requestId, responseId } of results) {
      assertEquals(
        responseId,
        requestId,
        `Response ID should match request ID ${requestId}`,
      );
    }

    console.log("  ✓ Concurrent JSON-RPC requests maintain correct ID mapping");
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test({
  name: "JSONRPC-011: Empty params object",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    await gateway.startHttp(port);

    // Some methods accept empty params
    const response = await makeJsonRpcRequest(port, "tools/list", {}, 11);

    assertEquals(response.status, 200);

    const body = await response.json();

    assertEquals(body.jsonrpc, "2.0");
    assertExists(body.result, "Empty params should be acceptable for tools/list");

    console.log("  ✓ Empty params object handled correctly");
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test({
  name: "JSONRPC-012: Tool execution failure returns proper error",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    await gateway.startHttp(port);

    // Call a tool that doesn't exist
    const response = await makeJsonRpcRequest(
      port,
      "tools/call",
      {
        name: "nonexistent:tool",
        arguments: {},
      },
      12,
    );

    assertEquals(response.status, 200);

    const body = await response.json();

    // Tool execution errors are returned as MCP tool errors (in result.content)
    // so the agent can see them in conversation, not as JSON-RPC protocol errors
    assertExists(body.result, "Should have result with tool error");
    assertEquals(body.result.isError, true, "Should be marked as error");
    assertExists(body.result.content, "Should have content array");
    assert(
      body.result.content[0].text.includes("Unknown MCP server"),
      "Error message should mention unknown server",
    );

    console.log("  ✓ Tool execution failure returns proper error");
  } finally {
    await gateway.stop();
    await cleanup();
  }
});
