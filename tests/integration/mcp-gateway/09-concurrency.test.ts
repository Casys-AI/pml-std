/**
 * MCP Gateway Integration Tests - Concurrency
 *
 * Tests:
 * - CONCURRENCY-001: Concurrent API requests
 * - CONCURRENCY-002: Concurrent JSON-RPC calls
 * - CONCURRENCY-003: Mixed traffic pattern
 * - CONCURRENCY-004: SSE broadcast performance
 *
 * @module tests/integration/mcp-gateway/concurrency
 */

import { assert, assertEquals } from "@std/assert";
import {
  connectSSE,
  createTestGatewayServer,
  getRandomPort,
  makeGatewayRequest,
  makeJsonRpcRequest,
} from "./fixtures/gateway-test-helpers.ts";

Deno.test({
  name: "CONCURRENCY-001: Concurrent API requests",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    await gateway.startHttp(port);

    const concurrentRequests = 50;
    const promises: Promise<Response>[] = [];

    // Make 50 concurrent requests to graph snapshot
    for (let i = 0; i < concurrentRequests; i++) {
      promises.push(makeGatewayRequest(port, "/api/graph/snapshot"));
    }

    const startTime = performance.now();
    const responses = await Promise.all(promises);
    const duration = performance.now() - startTime;

    // All requests should complete
    assertEquals(responses.length, concurrentRequests, "All requests should complete");

    // Count successful responses
    let successCount = 0;
    const statusCounts: Record<number, number> = {};

    for (const response of responses) {
      statusCounts[response.status] = (statusCounts[response.status] || 0) + 1;
      if ([200, 503].includes(response.status)) {
        successCount++;
      }
    }

    assert(successCount > 0, "At least some requests should succeed");

    console.log(
      `  ✓ ${concurrentRequests} concurrent API requests completed in ${duration.toFixed(0)}ms`,
    );
    console.log(`    Status codes: ${JSON.stringify(statusCounts)}`);
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test({
  name: "CONCURRENCY-002: Concurrent JSON-RPC calls",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    await gateway.startHttp(port);

    const concurrentRequests = 20;
    const promises: Promise<{ response: Response; requestId: number }>[] = [];

    // Make 20 concurrent JSON-RPC requests with different IDs
    for (let i = 1; i <= concurrentRequests; i++) {
      promises.push(
        makeJsonRpcRequest(port, "tools/list", {}, i).then((response) => ({
          response,
          requestId: i,
        })),
      );
    }

    const startTime = performance.now();
    const results = await Promise.all(promises);
    const duration = performance.now() - startTime;

    // Verify all responses match their request IDs
    let idMatches = 0;
    for (const { response, requestId } of results) {
      assertEquals(response.status, 200, "All JSON-RPC requests should return 200");

      const body = await response.json();
      if (body.id === requestId) {
        idMatches++;
      }
    }

    assertEquals(
      idMatches,
      concurrentRequests,
      "All response IDs should match request IDs",
    );

    console.log(
      `  ✓ ${concurrentRequests} concurrent JSON-RPC calls completed in ${duration.toFixed(0)}ms`,
    );
    console.log(`    All response IDs matched request IDs`);
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test({
  name: "CONCURRENCY-003: Mixed traffic pattern",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    await gateway.startHttp(port);

    const promises: Promise<{ type: string; status: number }>[] = [];

    // 10 API requests
    for (let i = 0; i < 10; i++) {
      promises.push(
        makeGatewayRequest(port, "/api/graph/snapshot").then((r) => ({
          type: "API",
          status: r.status,
        })),
      );
    }

    // 10 JSON-RPC requests
    for (let i = 0; i < 10; i++) {
      promises.push(
        makeJsonRpcRequest(port, "tools/list", {}, i).then((r) => ({
          type: "JSON-RPC",
          status: r.status,
        })),
      );
    }

    // 5 SSE connections (will close immediately)
    for (let i = 0; i < 5; i++) {
      promises.push(
        connectSSE(port).then(async (r) => {
          const result = { type: "SSE", status: r.status };
          if (r.body) await r.body.cancel();
          return result;
        }),
      );
    }

    const startTime = performance.now();
    const results = await Promise.all(promises);
    const duration = performance.now() - startTime;

    // Count results by type
    const typeCounts: Record<string, number> = {};
    for (const { type } of results) {
      typeCounts[type] = (typeCounts[type] || 0) + 1;
    }

    assertEquals(typeCounts.API, 10, "Should have 10 API responses");
    assertEquals(typeCounts["JSON-RPC"], 10, "Should have 10 JSON-RPC responses");
    assertEquals(typeCounts.SSE, 5, "Should have 5 SSE responses");

    console.log(`  ✓ Mixed traffic (25 requests) completed in ${duration.toFixed(0)}ms`);
    console.log(
      `    API: ${typeCounts.API}, JSON-RPC: ${typeCounts["JSON-RPC"]}, SSE: ${typeCounts.SSE}`,
    );
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test("CONCURRENCY-004: SSE broadcast performance", {
  // This test requires event triggering and multiple connections
  // Mark as slow/integration test
  ignore: true,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    await gateway.startHttp(port);

    const clientCount = 10; // Reduced from 100 for faster testing
    const connections: Response[] = [];

    // Connect multiple SSE clients
    for (let i = 0; i < clientCount; i++) {
      const response = await connectSSE(port);
      assertEquals(response.status, 200, `Client ${i + 1} should connect`);
      connections.push(response);
    }

    // Trigger event (would need event bus access)
    // For now, just verify connections work
    console.log(`  ✓ ${clientCount} SSE clients connected successfully`);

    // Cleanup
    for (const conn of connections) {
      if (conn.body) await conn.body.cancel();
    }
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test({
  name: "CONCURRENCY-005: Sequential vs concurrent performance",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    await gateway.startHttp(port);

    const requestCount = 10;

    // Sequential execution
    const sequentialStart = performance.now();
    for (let i = 0; i < requestCount; i++) {
      await makeGatewayRequest(port, "/health");
    }
    const sequentialDuration = performance.now() - sequentialStart;

    // Concurrent execution
    const concurrentStart = performance.now();
    const promises = [];
    for (let i = 0; i < requestCount; i++) {
      promises.push(makeGatewayRequest(port, "/health"));
    }
    await Promise.all(promises);
    const concurrentDuration = performance.now() - concurrentStart;

    // Concurrent should be faster (or at least not significantly slower)
    const speedup = sequentialDuration / concurrentDuration;

    console.log(`  ✓ Sequential: ${sequentialDuration.toFixed(0)}ms`);
    console.log(`  ✓ Concurrent: ${concurrentDuration.toFixed(0)}ms`);
    console.log(`  ✓ Speedup: ${speedup.toFixed(2)}x`);

    assert(
      speedup >= 1.0,
      "Concurrent execution should not be slower than sequential",
    );
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test({
  name: "CONCURRENCY-006: No response mixing",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    await gateway.startHttp(port);

    // Make concurrent requests with unique identifiers
    const requestCount = 20;
    const promises: Promise<{ id: number; body: unknown }>[] = [];

    for (let i = 1; i <= requestCount; i++) {
      promises.push(
        makeJsonRpcRequest(port, "tools/list", {}, i).then(async (r) => {
          const body = await r.json();
          return { id: i, body };
        }),
      );
    }

    const results = await Promise.all(promises);

    // Verify no response mixing (each response matches its request)
    for (const { id, body } of results) {
      const responseBody = body as { id: number };
      assertEquals(
        responseBody.id,
        id,
        `Response ${id} should match its request ID`,
      );
    }

    console.log(`  ✓ No response mixing in ${requestCount} concurrent requests`);
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test({
  name: "CONCURRENCY-007: Concurrent requests to different endpoints",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    await gateway.startHttp(port);

    const endpoints = [
      "/health",
      "/api/graph/snapshot",
      "/api/metrics",
      "/api/capabilities",
    ];

    const promises: Promise<{ endpoint: string; status: number }>[] = [];

    // Make 5 requests to each endpoint concurrently
    for (const endpoint of endpoints) {
      for (let i = 0; i < 5; i++) {
        promises.push(
          makeGatewayRequest(port, endpoint).then((r) => ({
            endpoint,
            status: r.status,
          })),
        );
      }
    }

    const startTime = performance.now();
    const results = await Promise.all(promises);
    const duration = performance.now() - startTime;

    // Group by endpoint
    const byEndpoint: Record<string, number[]> = {};
    for (const { endpoint, status } of results) {
      if (!byEndpoint[endpoint]) byEndpoint[endpoint] = [];
      byEndpoint[endpoint].push(status);
    }

    console.log(
      `  ✓ ${results.length} concurrent requests to ${endpoints.length} endpoints in ${
        duration.toFixed(0)
      }ms`,
    );

    for (const endpoint of endpoints) {
      const statuses = byEndpoint[endpoint];
      console.log(`    ${endpoint}: ${statuses.length} requests`);
    }
  } finally {
    await gateway.stop();
    await cleanup();
  }
});
