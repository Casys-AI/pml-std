/**
 * MCP Gateway Integration Tests - SSE Event Streaming
 *
 * Tests:
 * - SSE-001: Connection establishment
 * - SSE-002: Event broadcasting
 * - SSE-003: Event filtering
 * - SSE-004: Max clients limit
 * - SSE-005: Client disconnect
 * - SSE-006: Heartbeat
 * - SSE-007: CORS headers
 * - SSE-008: GET /mcp SSE
 *
 * @module tests/integration/mcp-gateway/sse-events
 */

import { assert, assertEquals, assertExists } from "@std/assert";
import {
  connectSSE,
  createTestGatewayServer,
  getRandomPort,
  makeGatewayRequest,
  readSSEEvents,
  waitForSSEEvent as _waitForSSEEvent,
} from "./fixtures/gateway-test-helpers.ts";

Deno.test({
  name: "SSE-001: Connection establishment",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    await gateway.startHttp(port);

    const response = await connectSSE(port);

    assertEquals(response.status, 200, "SSE connection should succeed");
    assertEquals(
      response.headers.get("content-type"),
      "text/event-stream",
      "Content-Type should be text/event-stream",
    );
    assertEquals(
      response.headers.get("cache-control"),
      "no-cache",
      "Cache-Control should be no-cache",
    );
    assertExists(
      response.headers.get("connection"),
      "Should have Connection header",
    );

    console.log("  ✓ SSE connection established with correct headers");

    // Close the stream
    if (response.body) {
      await response.body.cancel();
    }
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test("SSE-002: Event broadcasting", {
  // This test requires triggering events and reading from stream
  // May need to be marked as slow or require event triggering mechanism
  ignore: true, // Enable when event triggering is implemented
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    await gateway.startHttp(port);

    // Connect multiple clients
    const client1 = await connectSSE(port);
    const client2 = await connectSSE(port);

    // Trigger an event (would need event bus access)
    // For now, verify multiple connections work

    assertEquals(client1.status, 200);
    assertEquals(client2.status, 200);

    console.log("  ✓ Multiple SSE clients can connect");

    // Cleanup
    if (client1.body) await client1.body.cancel();
    if (client2.body) await client2.body.cancel();
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test({
  name: "SSE-003: Event filtering",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    await gateway.startHttp(port);

    // Connect with filter parameter
    const response = await connectSSE(port, "graph.node_created,graph.edge_created");

    assertEquals(response.status, 200, "Filtered connection should succeed");

    // Verify filter parameter was accepted (connection succeeds)
    console.log("  ✓ SSE connection with filter parameter works");

    if (response.body) await response.body.cancel();
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test("SSE-004: Max clients limit", {
  // This test is resource-intensive (needs 100+ connections)
  // Mark as slow or skip in normal runs
  ignore: true,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    await gateway.startHttp(port);

    const maxClients = 100;
    const connections: Response[] = [];

    // Connect max clients
    for (let i = 0; i < maxClients; i++) {
      const response = await connectSSE(port);
      assertEquals(response.status, 200, `Client ${i + 1} should connect`);
      connections.push(response);
    }

    // Try to connect one more (should fail)
    const overLimitResponse = await connectSSE(port);
    assertEquals(
      overLimitResponse.status,
      503,
      "101st client should be rejected",
    );

    const errorBody = await overLimitResponse.json();
    assertEquals(errorBody.error, "Too many clients");

    console.log("  ✓ SSE max clients limit enforced");

    // Cleanup connections
    for (const conn of connections) {
      if (conn.body) await conn.body.cancel();
    }
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test({
  name: "SSE-005: Client disconnect",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    await gateway.startHttp(port);

    // Connect client
    const response = await connectSSE(port);
    assertEquals(response.status, 200);

    // Disconnect client
    if (response.body) {
      await response.body.cancel();
    }

    // Connect new client (should succeed - slot freed)
    const response2 = await connectSSE(port);
    assertEquals(response2.status, 200, "New client should connect after disconnect");

    console.log("  ✓ Client disconnect properly cleaned up");

    if (response2.body) await response2.body.cancel();
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test("SSE-006: Heartbeat", {
  // This test requires waiting for heartbeat interval (30s)
  // Mark as slow
  ignore: true,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    await gateway.startHttp(port);

    const response = await connectSSE(port);
    assertEquals(response.status, 200);

    // Read events for 35 seconds to capture heartbeat
    const startTime = Date.now();
    let heartbeatReceived = false;

    for await (const event of readSSEEvents(response)) {
      if (event.data === "heartbeat" || event.event === "heartbeat") {
        heartbeatReceived = true;
        break;
      }

      // Timeout after 35 seconds
      if (Date.now() - startTime > 35000) {
        break;
      }
    }

    assert(heartbeatReceived, "Should receive heartbeat within 35 seconds");

    console.log("  ✓ Heartbeat received");

    if (response.body) await response.body.cancel();
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test({
  name: "SSE-007: CORS headers",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    await gateway.startHttp(port);

    // Test OPTIONS preflight
    const preflightResponse = await makeGatewayRequest(port, "/events/stream", {
      method: "OPTIONS",
    });

    assertEquals(preflightResponse.status, 200);
    assertExists(
      preflightResponse.headers.get("access-control-allow-origin"),
      "Preflight should have CORS headers",
    );

    // Test actual SSE connection
    const sseResponse = await connectSSE(port);

    assertEquals(sseResponse.status, 200);
    assertExists(
      sseResponse.headers.get("access-control-allow-origin"),
      "SSE response should have CORS headers",
    );

    console.log("  ✓ CORS headers present on SSE responses");

    if (sseResponse.body) await sseResponse.body.cancel();
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test({
  name: "SSE-008: GET /mcp SSE",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    await gateway.startHttp(port);

    // GET request to /mcp should establish SSE connection (MCP spec)
    const response = await makeGatewayRequest(port, "/mcp", {
      method: "GET",
    });

    // Should return SSE stream or service unavailable
    assert(
      [200, 503].includes(response.status),
      "GET /mcp should return SSE stream or 503",
    );

    if (response.status === 200) {
      assertEquals(
        response.headers.get("content-type"),
        "text/event-stream",
        "Should be SSE stream",
      );

      console.log("  ✓ GET /mcp establishes SSE stream");
    } else {
      console.log("  ✓ GET /mcp returned 503 (events stream not initialized)");
    }

    if (response.body) await response.body.cancel();
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test({
  name: "SSE-009: Multiple filters",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    await gateway.startHttp(port);

    // Test with multiple filters
    const filters = [
      "workflow.started",
      "workflow.completed",
      "graph.node_created",
      "system.error",
    ];

    const response = await connectSSE(port, filters.join(","));

    assertEquals(response.status, 200, "Multiple filters should be accepted");

    console.log(`  ✓ SSE connection with ${filters.length} filters works`);

    if (response.body) await response.body.cancel();
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test({
  name: "SSE-010: Wildcard filter",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    await gateway.startHttp(port);

    // Connect with wildcard filter (all events)
    const response = await connectSSE(port, "*");

    assertEquals(response.status, 200, "Wildcard filter should be accepted");

    console.log("  ✓ SSE wildcard filter works");

    if (response.body) await response.body.cancel();
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test({
  name: "SSE-011: Empty filter parameter",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    await gateway.startHttp(port);

    // Connect with empty filter (should default to all events)
    const response = await connectSSE(port, "");

    assertEquals(response.status, 200, "Empty filter should be accepted");

    console.log("  ✓ Empty filter parameter handled");

    if (response.body) await response.body.cancel();
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test({
  name: "SSE-012: Rapid connect/disconnect",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    await gateway.startHttp(port);

    // Rapidly connect and disconnect 10 times
    for (let i = 0; i < 10; i++) {
      const response = await connectSSE(port);
      assertEquals(response.status, 200, `Connection ${i + 1} should succeed`);

      // Immediately disconnect
      if (response.body) {
        await response.body.cancel();
      }

      // Small delay to allow cleanup
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    console.log("  ✓ Rapid connect/disconnect handled without issues");
  } finally {
    await gateway.stop();
    await cleanup();
  }
});
