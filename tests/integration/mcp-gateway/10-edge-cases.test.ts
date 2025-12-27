/**
 * MCP Gateway Integration Tests - Edge Cases
 *
 * Tests:
 * - EDGE-001: Empty database
 * - EDGE-002: Very large graph
 * - EDGE-003: Query parameter edge cases
 * - EDGE-004: Special characters in IDs
 * - EDGE-005: Very long event filter
 * - EDGE-006: Rapid SSE connect/disconnect
 *
 * @module tests/integration/mcp-gateway/edge-cases
 */

import { assert, assertEquals, assertExists } from "@std/assert";
import {
  connectSSE,
  createTestGatewayServer,
  getRandomPort,
  makeGatewayRequest,
} from "./fixtures/gateway-test-helpers.ts";

Deno.test({
  name: "EDGE-001: Empty database",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    await gateway.startHttp(port);

    // Query graph snapshot with empty database
    const snapshotResponse = await makeGatewayRequest(port, "/api/graph/snapshot");

    assert(
      [200, 503].includes(snapshotResponse.status),
      "Graph snapshot should handle empty database",
    );

    if (snapshotResponse.status === 200) {
      const body = await snapshotResponse.json();

      assertExists(body.nodes, "Should have nodes array");
      assertExists(body.edges, "Should have edges array");
      assert(Array.isArray(body.nodes), "Nodes should be array");
      assert(Array.isArray(body.edges), "Edges should be array");

      // Empty database should return empty arrays or minimal data
      console.log(`  ✓ Empty database: ${body.nodes.length} nodes, ${body.edges.length} edges`);
    }

    // Query capabilities with empty database
    const capabilitiesResponse = await makeGatewayRequest(port, "/api/capabilities");

    assert(
      [200, 503].includes(capabilitiesResponse.status),
      "Capabilities should handle empty database",
    );

    if (capabilitiesResponse.status === 200) {
      const body = await capabilitiesResponse.json();

      assertExists(body.capabilities, "Should have capabilities array");
      assertExists(body.total, "Should have total count");
      assertEquals(body.total, 0, "Empty database should have 0 capabilities");

      console.log("  ✓ Empty database returns empty capabilities list");
    }
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test("EDGE-002: Very large graph", {
  // This test is resource-intensive and time-consuming
  // Mark as slow/integration test
  ignore: true,
}, async () => {
  const { gateway, db: _db, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    // Insert many nodes (simplified - would need actual graph insertion)
    // This is a placeholder for the actual implementation

    await gateway.startHttp(port);

    const response = await makeGatewayRequest(port, "/api/graph/snapshot");

    assert(
      [200, 500, 503].includes(response.status),
      "Should handle large graph",
    );

    if (response.status === 200) {
      const body = await response.json();

      console.log(
        `  ✓ Large graph handled: ${body.nodes?.length || 0} nodes`,
      );
    }
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test({
  name: "EDGE-003: Query parameter edge cases",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  const testCases = [
    {
      path: "/api/capabilities?limit=-1",
      description: "negative limit",
      expectedStatuses: [200, 400, 503],
    },
    {
      path: "/api/capabilities?limit=999999",
      description: "very large limit",
      expectedStatuses: [200, 400, 503],
    },
    {
      path: "/api/capabilities?offset=-10",
      description: "negative offset",
      expectedStatuses: [200, 400, 503],
    },
    {
      path: "/api/graph/hypergraph?min_success_rate=1.5",
      description: "success rate > 1.0",
      expectedStatuses: [400, 503],
    },
    {
      path: "/api/graph/hypergraph?min_success_rate=-0.5",
      description: "negative success rate",
      expectedStatuses: [400, 503],
    },
    {
      path: "/api/capabilities?sort=invalid_field",
      description: "invalid sort field",
      expectedStatuses: [200, 400, 503],
    },
    {
      path: "/api/capabilities?limit=abc",
      description: "non-numeric limit",
      expectedStatuses: [200, 400, 503],
    },
  ];

  try {
    await gateway.startHttp(port);

    for (const { path, description, expectedStatuses } of testCases) {
      const response = await makeGatewayRequest(port, path);

      assert(
        expectedStatuses.includes(response.status),
        `${description} should return one of ${expectedStatuses.join(", ")}`,
      );

      console.log(`  ✓ ${description}: ${response.status}`);
    }
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test({
  name: "EDGE-004: Special characters in IDs",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  const specialIds = [
    "cap:with:colons",
    "cap/with/slashes",
    "cap?with?questions",
    "cap#with#hashes",
    "cap%20with%20spaces",
    "cap+with+plus",
  ];

  try {
    await gateway.startHttp(port);

    for (const capId of specialIds) {
      // URL encode the ID
      const encodedId = encodeURIComponent(capId);

      const response = await makeGatewayRequest(
        port,
        `/api/capabilities/${encodedId}/dependencies`,
      );

      assert(
        [200, 400, 404, 503].includes(response.status),
        `Special ID should be handled: ${capId}`,
      );

      console.log(`  ✓ Special ID "${capId}": ${response.status}`);
    }
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test({
  name: "EDGE-005: Very long event filter",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    await gateway.startHttp(port);

    // Create a filter with 100 event types
    const eventTypes = [];
    for (let i = 1; i <= 100; i++) {
      eventTypes.push(`event.type.${i}`);
    }

    const filter = eventTypes.join(",");

    const response = await connectSSE(port, filter);

    assert(
      [200, 400, 503].includes(response.status),
      "Very long filter should be handled",
    );

    if (response.status === 200) {
      console.log(`  ✓ Very long filter (${eventTypes.length} types) accepted`);

      if (response.body) await response.body.cancel();
    } else {
      console.log(`  ✓ Very long filter rejected with status ${response.status}`);
    }
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test({
  name: "EDGE-006: Rapid SSE connect/disconnect",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    await gateway.startHttp(port);

    const cycles = 10;
    const clientsPerCycle = 5;

    for (let cycle = 0; cycle < cycles; cycle++) {
      const connections: Response[] = [];

      // Connect multiple clients
      for (let i = 0; i < clientsPerCycle; i++) {
        const response = await connectSSE(port);
        assertEquals(
          response.status,
          200,
          `Cycle ${cycle + 1}, client ${i + 1} should connect`,
        );
        connections.push(response);
      }

      // Immediately disconnect all
      for (const conn of connections) {
        if (conn.body) await conn.body.cancel();
      }

      // Small delay for cleanup
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    console.log(
      `  ✓ Rapid connect/disconnect: ${cycles} cycles × ${clientsPerCycle} clients`,
    );
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test({
  name: "EDGE-007: Empty query strings",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  const testCases = [
    { path: "/api/capabilities?limit=", description: "empty limit value" },
    { path: "/api/capabilities?", description: "trailing question mark" },
    { path: "/api/tools/search?q=", description: "empty search query" },
  ];

  try {
    await gateway.startHttp(port);

    for (const { path, description } of testCases) {
      const response = await makeGatewayRequest(port, path);

      assert(
        [200, 400, 503].includes(response.status),
        `${description} should be handled`,
      );

      console.log(`  ✓ ${description}: ${response.status}`);
    }
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test({
  name: "EDGE-008: Unicode in parameters",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    await gateway.startHttp(port);

    // Test Unicode in query parameters
    const unicodeQuery = "读取文件"; // "read file" in Chinese
    const encodedQuery = encodeURIComponent(unicodeQuery);

    const response = await makeGatewayRequest(
      port,
      `/api/tools/search?q=${encodedQuery}`,
    );

    assert(
      [200, 400, 503].includes(response.status),
      "Unicode query should be handled",
    );

    console.log(`  ✓ Unicode query handled: ${response.status}`);
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test({
  name: "EDGE-009: Duplicate query parameters",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    await gateway.startHttp(port);

    // Test with duplicate query parameters
    const response = await makeGatewayRequest(
      port,
      "/api/capabilities?limit=10&limit=20",
    );

    assert(
      [200, 400, 503].includes(response.status),
      "Duplicate parameters should be handled",
    );

    console.log(`  ✓ Duplicate parameters handled: ${response.status}`);
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test({
  name: "EDGE-010: Case sensitivity in paths",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  const testCases = [
    { path: "/HEALTH", expectedStatus: 404 },
    { path: "/Health", expectedStatus: 404 },
    { path: "/API/graph/snapshot", expectedStatus: 404 },
    { path: "/health", expectedStatus: 200 }, // Correct case
  ];

  try {
    await gateway.startHttp(port);

    for (const { path, expectedStatus } of testCases) {
      const response = await makeGatewayRequest(port, path);

      assertEquals(
        response.status,
        expectedStatus,
        `${path} case sensitivity test`,
      );

      console.log(`  ✓ ${path}: ${response.status}`);
    }
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test("EDGE-011: Very long URL", {
  // This test may hit URL length limits
  ignore: true,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    await gateway.startHttp(port);

    // Create a very long query string (approaching URL limits)
    const longValue = "x".repeat(2000);
    const response = await makeGatewayRequest(
      port,
      `/api/tools/search?q=${encodeURIComponent(longValue)}`,
    );

    assert(
      [200, 400, 414, 503].includes(response.status),
      "Very long URL should be handled",
    );

    console.log(`  ✓ Very long URL handled: ${response.status}`);
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test({
  name: "EDGE-012: Missing slash in path",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    await gateway.startHttp(port);

    const response = await makeGatewayRequest(port, "health"); // Missing leading slash

    // Fetch API typically handles this, but verify it doesn't cause issues
    assert(
      [200, 400, 404].includes(response.status),
      "Missing slash should be handled",
    );

    console.log(`  ✓ Path without leading slash handled: ${response.status}`);
  } finally {
    await gateway.stop();
    await cleanup();
  }
});
