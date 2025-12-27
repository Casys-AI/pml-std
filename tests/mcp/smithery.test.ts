/**
 * Smithery MCP Integration Tests
 *
 * Tests for SmitheryLoader and SmitheryMCPClient.
 * Covers:
 * - AC1: Load from Smithery registry API
 * - AC2: Merge with local config (local priority)
 * - AC3: Graceful degradation on Smithery failure
 * - AC4: HTTP Streamable transport connection
 */

import { assert, assertEquals, assertExists, assertRejects } from "jsr:@std/assert@1";
import { SmitheryLoader } from "../../src/mcp/smithery-loader.ts";
import { SmitheryMCPClient } from "../../src/mcp/smithery-client.ts";
import { MCPServerDiscovery } from "../../src/mcp/discovery.ts";
import type { MCPServer, SmitheryServerConfig } from "../../src/mcp/types.ts";

/**
 * Mock Smithery registry API response
 */
interface MockRegistryResponse {
  servers: SmitheryServerConfig[];
}

// ============================================================================
// SmitheryLoader Tests
// ============================================================================

Deno.test({
  name: "SmitheryLoader - converts API response to MCPServer array",
  async fn() {
    // Mock fetch to simulate Smithery API response
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request, _init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

      if (url.includes("registry.smithery.ai/servers")) {
        const mockResponse: MockRegistryResponse = {
          servers: [
            {
              qualifiedName: "@smithery/slack",
              displayName: "Slack MCP",
              remote: true,
              config: { token: "abc123" },
            },
            {
              qualifiedName: "@smithery/github",
              displayName: "GitHub MCP",
              remote: true,
            },
          ],
        };

        return new Response(JSON.stringify(mockResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response("Not found", { status: 404 });
    };

    try {
      const loader = new SmitheryLoader();
      const servers = await loader.loadServers("test-api-key");

      assertEquals(servers.length, 2);

      // Check first server
      assertEquals(servers[0].id, "smithery:@smithery/slack");
      assertEquals(servers[0].name, "Slack MCP");
      assertEquals(servers[0].protocol, "http");
      assertEquals(servers[0].command, "https://server.smithery.ai/@smithery/slack");
      assertExists(servers[0].env?.__smithery_config);

      // Check second server
      assertEquals(servers[1].id, "smithery:@smithery/github");
      assertEquals(servers[1].name, "GitHub MCP");
      assertEquals(servers[1].protocol, "http");
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "SmitheryLoader - filters out non-remote servers",
  async fn() {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      const mockResponse: MockRegistryResponse = {
        servers: [
          {
            qualifiedName: "@local/server",
            displayName: "Local Server",
            remote: false, // Not remote - should be filtered
          },
          {
            qualifiedName: "@remote/server",
            displayName: "Remote Server",
            remote: true, // Remote - should be included
          },
        ],
      };

      return new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    try {
      const loader = new SmitheryLoader();
      const servers = await loader.loadServers("test-api-key");

      // Only remote server should be included
      assertEquals(servers.length, 1);
      assertEquals(servers[0].id, "smithery:@remote/server");
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "SmitheryLoader - throws on API error",
  async fn() {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      return new Response("Internal Server Error", { status: 500 });
    };

    try {
      const loader = new SmitheryLoader();
      await assertRejects(
        async () => await loader.loadServers("test-api-key"),
        Error,
        "Smithery API error",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "SmitheryLoader - throws on network error",
  async fn() {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("Network error");
    };

    try {
      const loader = new SmitheryLoader();
      await assertRejects(
        async () => await loader.loadServers("test-api-key"),
        Error,
        "Network error",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "SmitheryLoader - returns empty array for empty server list",
  async fn() {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      return new Response(JSON.stringify({ servers: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    try {
      const loader = new SmitheryLoader();
      const servers = await loader.loadServers("test-api-key");

      assertEquals(servers, []);
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "SmitheryLoader - returns empty array for missing servers field",
  async fn() {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    try {
      const loader = new SmitheryLoader();
      const servers = await loader.loadServers("test-api-key");

      assertEquals(servers, []);
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "SmitheryLoader - uses custom registry URL",
  async fn() {
    const originalFetch = globalThis.fetch;
    let capturedUrl = "";

    globalThis.fetch = async (input: string | URL | Request) => {
      capturedUrl = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.href
        : input.url;
      return new Response(JSON.stringify({ servers: [] }), { status: 200 });
    };

    try {
      const loader = new SmitheryLoader("https://custom.registry.com/api/servers");
      await loader.loadServers("test-api-key");

      assertEquals(capturedUrl, "https://custom.registry.com/api/servers");
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

// ============================================================================
// SmitheryMCPClient Tests
// ============================================================================

Deno.test({
  name: "SmitheryMCPClient - constructor initializes correctly",
  fn() {
    const server: MCPServer = {
      id: "test-server",
      name: "Test Server",
      protocol: "http",
      command: "https://server.smithery.ai/@test/server",
      args: [],
      env: {
        __smithery_config: JSON.stringify({ token: "abc" }),
      },
    };

    const client = new SmitheryMCPClient(server, {
      apiKey: "test-key",
      timeoutMs: 5000,
    });

    assertEquals(client.serverId, "test-server");
    assertEquals(client.serverName, "Test Server");
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "SmitheryMCPClient - throws when calling methods without connection",
  async fn() {
    const server: MCPServer = {
      id: "test-server",
      name: "Test Server",
      protocol: "http",
      command: "https://server.smithery.ai/@test/server",
      args: [],
    };

    const client = new SmitheryMCPClient(server, { apiKey: "test-key" });

    // Should throw "Not connected" error
    await assertRejects(
      async () => await client.listTools(),
      Error,
      "Not connected",
    );

    await assertRejects(
      async () => await client.callTool("test", {}),
      Error,
      "Not connected",
    );
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "SmitheryMCPClient - disconnect is idempotent",
  async fn() {
    const server: MCPServer = {
      id: "test-server",
      name: "Test Server",
      protocol: "http",
      command: "https://server.smithery.ai/@test/server",
      args: [],
    };

    const client = new SmitheryMCPClient(server, { apiKey: "test-key" });

    // Multiple disconnects should not throw
    await client.disconnect();
    await client.disconnect();
    await client.close();
    await client.close();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

// ============================================================================
// MCPServerDiscovery Merge Tests
// ============================================================================

Deno.test({
  name: "MCPServerDiscovery - local servers take priority over Smithery servers with same ID",
  async fn() {
    // Create a temp config file
    const tempDir = await Deno.makeTempDir();
    const configPath = `${tempDir}/config.json`;

    // Note: Smithery IDs are prefixed with "smithery:", so to test priority
    // we need local server with ID matching "smithery:<qualifiedName>"
    const localConfig = {
      servers: [
        {
          id: "smithery:@shared/server", // Same ID as Smithery will generate
          name: "Local Override Server",
          command: "local-command",
          protocol: "stdio",
        },
        {
          id: "local-only",
          name: "Local Only Server",
          command: "local-only-command",
          protocol: "stdio",
        },
      ],
    };

    await Deno.writeTextFile(configPath, JSON.stringify(localConfig));

    // Mock fetch for Smithery
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      const mockResponse: MockRegistryResponse = {
        servers: [
          {
            qualifiedName: "@shared/server", // Becomes "smithery:@shared/server"
            displayName: "Smithery Server (should be overridden)",
            remote: true,
          },
          {
            qualifiedName: "@smithery/unique",
            displayName: "Smithery Only Server",
            remote: true,
          },
        ],
      };

      return new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    try {
      const discovery = new MCPServerDiscovery(configPath);
      await discovery.loadConfig();
      await discovery.loadFromSmithery("test-api-key");

      const servers = await discovery.discoverServers();

      // Should have 3 servers: 2 local + 1 unique Smithery (shared ID is overridden)
      assertEquals(servers.length, 3);

      // Local server should take priority for shared ID
      const sharedServer = servers.find((s) => s.id === "smithery:@shared/server");
      assertExists(sharedServer);
      assertEquals(sharedServer.name, "Local Override Server");
      assertEquals(sharedServer.protocol, "stdio"); // Local config, not HTTP

      // Local-only server should be present
      const localOnlyServer = servers.find((s) => s.id === "local-only");
      assertExists(localOnlyServer);
      assertEquals(localOnlyServer.name, "Local Only Server");

      // Smithery-only server should be present
      const smitheryServer = servers.find((s) => s.id === "smithery:@smithery/unique");
      assertExists(smitheryServer);
      assertEquals(smitheryServer.name, "Smithery Only Server");
      assertEquals(smitheryServer.protocol, "http");
    } finally {
      globalThis.fetch = originalFetch;
      await Deno.remove(tempDir, { recursive: true });
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "MCPServerDiscovery - gracefully handles Smithery API failure",
  async fn() {
    // Create a temp config file
    const tempDir = await Deno.makeTempDir();
    const configPath = `${tempDir}/config.json`;

    const localConfig = {
      servers: [
        {
          id: "local-server",
          name: "Local Server",
          command: "local-command",
          protocol: "stdio",
        },
      ],
    };

    await Deno.writeTextFile(configPath, JSON.stringify(localConfig));

    // Mock fetch to simulate Smithery failure
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      return new Response("Service Unavailable", { status: 503 });
    };

    try {
      const discovery = new MCPServerDiscovery(configPath);
      await discovery.loadConfig();

      // Should not throw - graceful degradation
      await discovery.loadFromSmithery("test-api-key");

      const servers = await discovery.discoverServers();

      // Should have only local server
      assertEquals(servers.length, 1);
      assertEquals(servers[0].id, "local-server");
      assertEquals(servers[0].name, "Local Server");
    } finally {
      globalThis.fetch = originalFetch;
      await Deno.remove(tempDir, { recursive: true });
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

// ============================================================================
// Integration Test (requires SDK - skip if not available)
// ============================================================================

Deno.test({
  name: "SmitheryMCPClient - extractSchemas returns failure on connect error",
  async fn() {
    // Skip in CI to avoid network dependency
    if (Deno.env.get("CI") === "true") {
      console.log("Skipping network-dependent test in CI");
      return;
    }

    const server: MCPServer = {
      id: "test-server",
      name: "Test Server",
      protocol: "http",
      command: "https://server.smithery.ai/@nonexistent/server",
      args: [],
    };

    const client = new SmitheryMCPClient(server, {
      apiKey: "invalid-key",
      timeoutMs: 1000,
    });

    const result = await client.extractSchemas();

    assertEquals(result.serverId, "test-server");
    assertEquals(result.serverName, "Test Server");
    assert(
      result.status === "failed" || result.status === "timeout",
      `Expected failed or timeout, got ${result.status}`,
    );
    assertEquals(result.toolsExtracted, 0);
    assertExists(result.error);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

// ============================================================================
// Validation Tests
// ============================================================================

Deno.test({
  name: "SmitheryLoader - rejects malformed server objects",
  async fn() {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      // Return servers with various malformed structures
      const mockResponse = {
        servers: [
          { qualifiedName: "", displayName: "Empty name", remote: true }, // Empty qualifiedName
          { qualifiedName: "@valid/name", remote: true }, // Missing displayName
          { qualifiedName: "@valid/name", displayName: "Valid", remote: "yes" }, // Wrong type for remote
          { qualifiedName: "@valid/server", displayName: "Valid Server", remote: true }, // Valid
          "not-an-object", // Not an object
          null, // Null value
        ],
      };

      return new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    try {
      const loader = new SmitheryLoader();
      const servers = await loader.loadServers("test-api-key");

      // Only the valid server should be returned
      assertEquals(servers.length, 1);
      assertEquals(servers[0].id, "smithery:@valid/server");
      assertEquals(servers[0].name, "Valid Server");
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
