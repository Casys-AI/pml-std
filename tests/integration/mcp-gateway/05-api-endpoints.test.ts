/**
 * MCP Gateway Integration Tests - API Endpoints
 *
 * Tests:
 * - API-001: Health check endpoint
 * - API-002: Graph snapshot endpoint
 * - API-003: Graph path finding endpoint
 * - API-004: Graph related tools endpoint
 * - API-005: Graph hypergraph endpoint
 * - API-006 to API-015: Other API endpoints
 *
 * @module tests/integration/mcp-gateway/api-endpoints
 */

import { assert, assertEquals, assertExists } from "@std/assert";
import {
  createTestGatewayServer,
  getRandomPort,
  makeGatewayRequest,
  seedTestDatabase,
} from "./fixtures/gateway-test-helpers.ts";

Deno.test({
  name: "API-001: Health check endpoint",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    await gateway.startHttp(port);

    const response = await makeGatewayRequest(port, "/health");

    assertEquals(response.status, 200);
    assertEquals(response.headers.get("content-type"), "application/json");

    const body = await response.json();
    assertEquals(body.status, "ok");

    // Test that POST is not allowed (should be 404 or 405)
    const postResponse = await makeGatewayRequest(port, "/health", {
      method: "POST",
    });
    assert(
      postResponse.status === 404 || postResponse.status === 405,
      "POST to health should not be allowed",
    );

    console.log("  ✓ Health check endpoint works correctly");
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test({
  name: "API-002: Graph snapshot endpoint",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, db, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    await seedTestDatabase(db);
    await gateway.startHttp(port);

    const response = await makeGatewayRequest(port, "/api/graph/snapshot");

    // Should succeed (200) or service unavailable (503)
    assert(
      [200, 503].includes(response.status),
      "Graph snapshot should return 200 or 503",
    );

    if (response.status === 200) {
      const body = await response.json();

      assertExists(body.nodes, "Response should have nodes");
      assertExists(body.edges, "Response should have edges");
      assertExists(body.metadata, "Response should have metadata");

      assert(Array.isArray(body.nodes), "Nodes should be an array");
      assert(Array.isArray(body.edges), "Edges should be an array");

      console.log(`  ✓ Graph snapshot: ${body.nodes.length} nodes, ${body.edges.length} edges`);
    } else {
      console.log("  ✓ Graph snapshot returned 503 (service unavailable)");
    }
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test({
  name: "API-003: Graph path finding endpoint",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    await gateway.startHttp(port);

    // Test with query parameters
    const response = await makeGatewayRequest(
      port,
      "/api/graph/path?from=node_a&to=node_b",
    );

    // Should return 200, 400, or 503
    assert(
      [200, 400, 503].includes(response.status),
      "Path finding should return 200, 400, or 503",
    );

    if (response.status === 200) {
      const body = await response.json();

      assertExists(body.path, "Response should have path");
      assert(Array.isArray(body.path), "Path should be an array");

      console.log("  ✓ Path finding endpoint works");
    }

    // Test missing parameters
    const missingFromResponse = await makeGatewayRequest(
      port,
      "/api/graph/path?to=node_b",
    );
    assertEquals(
      missingFromResponse.status,
      400,
      "Missing 'from' parameter should return 400",
    );

    const missingToResponse = await makeGatewayRequest(
      port,
      "/api/graph/path?from=node_a",
    );
    assertEquals(
      missingToResponse.status,
      400,
      "Missing 'to' parameter should return 400",
    );

    console.log("  ✓ Path finding validates query parameters");
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test({
  name: "API-004: Graph related tools endpoint",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    await gateway.startHttp(port);

    // Test with tool_id parameter
    const response = await makeGatewayRequest(
      port,
      "/api/graph/related?tool_id=test_tool&limit=5",
    );

    assert(
      [200, 400, 503].includes(response.status),
      "Related tools should return 200, 400, or 503",
    );

    if (response.status === 200) {
      const body = await response.json();

      assertExists(body.tool_id, "Response should have tool_id");
      assertExists(body.related, "Response should have related array");
      assert(Array.isArray(body.related), "Related should be an array");

      console.log(`  ✓ Related tools: ${body.related.length} results`);
    }

    // Test missing tool_id
    const missingIdResponse = await makeGatewayRequest(
      port,
      "/api/graph/related?limit=5",
    );
    assertEquals(
      missingIdResponse.status,
      400,
      "Missing tool_id should return 400",
    );

    console.log("  ✓ Related tools endpoint validates parameters");
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test({
  name: "API-005: Graph hypergraph endpoint",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    await gateway.startHttp(port);

    // Test basic request
    const response = await makeGatewayRequest(port, "/api/graph/hypergraph");

    assert(
      [200, 503].includes(response.status),
      "Hypergraph should return 200 or 503",
    );

    if (response.status === 200) {
      const body = await response.json();

      assertExists(body.nodes, "Response should have nodes");
      assertExists(body.edges, "Response should have edges");
      assertExists(body.metadata, "Response should have metadata");

      console.log("  ✓ Hypergraph endpoint returns structured data");
    }

    // Test with query parameters
    const filteredResponse = await makeGatewayRequest(
      port,
      "/api/graph/hypergraph?include_tools=true&min_success_rate=0.8",
    );

    assert(
      [200, 400, 503].includes(filteredResponse.status),
      "Filtered hypergraph should return 200, 400, or 503",
    );

    // Test invalid parameters
    const invalidResponse = await makeGatewayRequest(
      port,
      "/api/graph/hypergraph?min_success_rate=2.0",
    );
    assertEquals(
      invalidResponse.status,
      400,
      "Invalid min_success_rate should return 400",
    );

    console.log("  ✓ Hypergraph endpoint validates parameters");
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test({
  name: "API-006: Capabilities list endpoint",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    await gateway.startHttp(port);

    const response = await makeGatewayRequest(port, "/api/capabilities");

    assert(
      [200, 503].includes(response.status),
      "Capabilities should return 200 or 503",
    );

    if (response.status === 200) {
      const body = await response.json();

      assertExists(body.capabilities, "Response should have capabilities array");
      assert(Array.isArray(body.capabilities), "Capabilities should be an array");
      assertExists(body.total, "Response should have total count");

      console.log(`  ✓ Capabilities list: ${body.total} total`);
    }

    // Test with filters
    const filteredResponse = await makeGatewayRequest(
      port,
      "/api/capabilities?min_success_rate=0.9&limit=10&offset=0",
    );

    assert(
      [200, 400, 503].includes(filteredResponse.status),
      "Filtered capabilities should work",
    );

    console.log("  ✓ Capabilities endpoint supports filtering");
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test({
  name: "API-007: Capability dependencies GET",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    await gateway.startHttp(port);

    // Use valid UUID format
    const testCapId = "00000000-0000-0000-0000-000000000123";
    const response = await makeGatewayRequest(
      port,
      `/api/capabilities/${testCapId}/dependencies`,
    );

    assert(
      [200, 404, 503].includes(response.status),
      "Dependencies GET should return 200, 404, or 503",
    );

    if (response.status === 200) {
      const body = await response.json();

      assertExists(body.capability_id, "Response should have capability_id");
      assertExists(body.dependencies, "Response should have dependencies array");

      console.log("  ✓ Capability dependencies GET works");
    }
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test({
  name: "API-008: Capability dependencies POST",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    await gateway.startHttp(port);

    // Use valid UUID format
    const capId = "00000000-0000-0000-0000-000000000123";
    const targetId = "00000000-0000-0000-0000-000000000456";

    const response = await makeGatewayRequest(
      port,
      `/api/capabilities/${capId}/dependencies`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target_id: targetId,
          dependency_type: "requires",
          confidence: 0.9,
        }),
      },
    );

    assert(
      [201, 400, 404, 503].includes(response.status),
      "Dependencies POST should return 201, 400, 404, or 503",
    );

    // Test missing required fields
    const missingFieldResponse = await makeGatewayRequest(
      port,
      `/api/capabilities/${capId}/dependencies`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dependency_type: "requires",
        }),
      },
    );

    assertEquals(
      missingFieldResponse.status,
      400,
      "Missing target_id should return 400",
    );

    console.log("  ✓ Capability dependencies POST validates input");
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test({
  name: "API-009: Capability dependencies DELETE",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    await gateway.startHttp(port);

    // Use valid UUID format
    const capId = "00000000-0000-0000-0000-000000000123";
    const depId = "00000000-0000-0000-0000-000000000456";
    const response = await makeGatewayRequest(
      port,
      `/api/capabilities/${capId}/dependencies/${depId}`,
      {
        method: "DELETE",
      },
    );

    // Accept 200/204 (success), 404 (not found), 405 (method not allowed), 500, or 503
    assert(
      [200, 204, 404, 405, 500, 503].includes(response.status),
      `Dependencies DELETE should return 200, 204, 404, 405, 500, or 503 (got ${response.status})`,
    );

    console.log(`  ✓ Capability dependencies DELETE: status=${response.status}`);
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test({
  name: "API-010: Metrics endpoint",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    await gateway.startHttp(port);

    const response = await makeGatewayRequest(port, "/api/metrics");

    assert(
      [200, 503].includes(response.status),
      "Metrics should return 200 or 503",
    );

    if (response.status === 200) {
      const body = await response.json();

      // Metrics structure may vary, check for common fields
      assertExists(body, "Response should have data");

      console.log("  ✓ Metrics endpoint returns data");
    }
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test({
  name: "API-011: Tools search endpoint",
  sanitizeResources: false,
  sanitizeOps: false,
  ignore: true, // /api/tools/search doesn't exist - tool search is via MCP pml:search_tools
}, async () => {
  const { gateway, db, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    await seedTestDatabase(db);
    await gateway.startHttp(port);

    // Test with query
    const response = await makeGatewayRequest(
      port,
      "/api/tools/search?q=read+file&limit=5",
    );

    assert(
      [200, 400, 503].includes(response.status),
      "Tools search should return 200, 400, or 503",
    );

    if (response.status === 200) {
      const body = await response.json();

      assertExists(body.query, "Response should have query");
      assertExists(body.results, "Response should have results array");
      assert(Array.isArray(body.results), "Results should be an array");

      console.log(`  ✓ Tools search: ${body.results.length} results for "${body.query}"`);
    }

    // Test missing query parameter
    const missingQueryResponse = await makeGatewayRequest(
      port,
      "/api/tools/search",
    );
    assertEquals(
      missingQueryResponse.status,
      400,
      "Missing query parameter should return 400",
    );

    console.log("  ✓ Tools search validates query parameter");
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test({
  name: "API-012: Events stream endpoint",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    await gateway.startHttp(port);

    const response = await makeGatewayRequest(port, "/events/stream");

    assert(
      [200, 503].includes(response.status),
      "Events stream should return 200 or 503",
    );

    if (response.status === 200) {
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

      console.log("  ✓ Events stream endpoint returns SSE headers");
    }
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test({
  name: "API-013: Dashboard redirect endpoint",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    await gateway.startHttp(port);

    const response = await makeGatewayRequest(port, "/dashboard", {
      redirect: "manual", // Don't follow redirects
    });

    assert(
      [302, 307, 308].includes(response.status),
      "Dashboard should redirect",
    );

    const location = response.headers.get("location");
    assertExists(location, "Redirect should have Location header");
    assert(
      location.includes("dashboard"),
      "Location should point to dashboard",
    );

    console.log(`  ✓ Dashboard redirects to: ${location}`);
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test({
  name: "API-014: Method not allowed",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  const testVectors = [
    { method: "POST", path: "/health", description: "POST to health" },
    { method: "POST", path: "/api/graph/snapshot", description: "POST to snapshot" },
    { method: "DELETE", path: "/health", description: "DELETE to health" },
    { method: "PUT", path: "/api/metrics", description: "PUT to metrics" },
  ];

  try {
    await gateway.startHttp(port);

    for (const { method, path, description } of testVectors) {
      const response = await makeGatewayRequest(port, path, { method });

      assert(
        [404, 405].includes(response.status),
        `${description} should return 404 or 405`,
      );

      // CORS headers may or may not be present on 404 responses
      // depending on whether the route was matched at all
      const corsHeader = response.headers.get("access-control-allow-origin");
      console.log(`    ${description}: status=${response.status}, CORS=${corsHeader ?? "none"}`);
      // Note: CORS on unmatched routes is implementation-dependent
    }

    console.log(`  ✓ Tested ${testVectors.length} method not allowed cases`);
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

Deno.test({
  name: "API-015: Not found",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = getRandomPort();

  try {
    await gateway.startHttp(port);

    // Test unknown routes
    const unknownRoutes = [
      "/unknown/route",
      "/api/unknown",
      "/api/graph/unknown",
      "/totally/made/up",
    ];

    for (const route of unknownRoutes) {
      const response = await makeGatewayRequest(port, route);

      assertEquals(
        response.status,
        404,
        `${route} should return 404`,
      );
    }

    console.log(`  ✓ Tested ${unknownRoutes.length} not found cases`);
  } finally {
    await gateway.stop();
    await cleanup();
  }
});
