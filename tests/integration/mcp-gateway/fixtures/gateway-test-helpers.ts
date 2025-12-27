/**
 * Test Fixtures and Helpers for MCP Gateway Integration Tests
 *
 * Provides utilities for:
 * - Creating test gateway servers
 * - Making HTTP requests to the gateway
 * - JSON-RPC request helpers
 * - SSE connection helpers
 * - Environment management
 *
 * @module tests/integration/mcp-gateway/fixtures
 */

import { createDefaultClient, type PGliteClient } from "../../../../src/db/client.ts";
import { getAllMigrations, MigrationRunner } from "../../../../src/db/migrations.ts";
import { PMLGatewayServer } from "../../../../src/mcp/gateway-server.ts";
import { EmbeddingModel } from "../../../../src/vector/embeddings.ts";
import { VectorSearch } from "../../../../src/vector/search.ts";
import { GraphRAGEngine } from "../../../../src/graphrag/graph-engine.ts";
import { DAGSuggester } from "../../../../src/graphrag/dag-suggester.ts";
import { ParallelExecutor } from "../../../../src/dag/executor.ts";
import { CapabilityStore } from "../../../../src/capabilities/capability-store.ts";
import { AdaptiveThresholdManager } from "../../../../src/mcp/adaptive-threshold.ts";
import type { GatewayServerConfig } from "../../../../src/mcp/gateway-server.ts";
import type { MCPClientBase } from "../../../../src/mcp/types.ts";

/**
 * Test gateway server configuration
 */
export interface TestGatewayConfig extends Partial<GatewayServerConfig> {
  skipHealthCheck?: boolean;
}

/**
 * Test gateway server wrapper
 */
export interface TestGatewayServer {
  gateway: PMLGatewayServer;
  db: PGliteClient;
  testDir: string;
  cleanup: () => Promise<void>;
}

/**
 * Mock MCP client for testing
 */
export function createMockMCPClient(): MCPClientBase {
  return {
    callTool: async (toolName: string, args: Record<string, unknown>) => {
      return {
        success: true,
        result: `Mock result for ${toolName}`,
        args,
      };
    },
    listTools: async () => {
      return {
        tools: [
          {
            name: "mock_tool",
            description: "Mock tool for testing",
            inputSchema: {
              type: "object",
              properties: {
                input: { type: "string" },
              },
            },
          },
        ],
      };
    },
    disconnect: async () => {},
    close: async () => {},
  } as unknown as MCPClientBase;
}

/**
 * Initialize test database with migrations
 */
async function initializeTestDatabase(db: PGliteClient): Promise<void> {
  const runner = new MigrationRunner(db);
  await runner.runUp(getAllMigrations());
}

/**
 * Seed test database with sample data
 */
export async function seedTestDatabase(db: PGliteClient): Promise<void> {
  // Insert sample tool schemas
  await db.exec(`
    INSERT INTO tool_schema (tool_id, server_id, name, description, input_schema)
    VALUES
      ('test-server:test_tool', 'test-server', 'test_tool', 'A test tool',
       '{"type":"object","properties":{"input":{"type":"string"}}}'::jsonb),
      ('filesystem:read', 'filesystem', 'read', 'Read file',
       '{"type":"object","properties":{"path":{"type":"string"}}}'::jsonb)
    ON CONFLICT (tool_id) DO UPDATE SET
      description = EXCLUDED.description,
      input_schema = EXCLUDED.input_schema
  `);

  // Insert sample tool embeddings
  const embedding = new Array(1024).fill(0);
  embedding[0] = 1.0;

  await db.exec(`
    INSERT INTO tool_embedding (tool_id, server_id, tool_name, embedding, metadata)
    VALUES
      ('test-server:test_tool', 'test-server', 'test_tool', '[${embedding.join(",")}]', '{}'),
      ('filesystem:read', 'filesystem', 'read', '[${embedding.join(",")}]', '{}')
    ON CONFLICT (tool_id) DO UPDATE SET
      embedding = EXCLUDED.embedding,
      metadata = EXCLUDED.metadata
  `);
}

/**
 * Seed test API keys for authentication testing
 */
export async function seedTestApiKeys(
  db: PGliteClient,
): Promise<{ validApiKey: string; userId: string }> {
  const validApiKey = "ac_123456789012345678901234";
  const userId = "test_user_1";

  // Note: This is a simplified version. In production, API keys are hashed.
  // For testing, we'll store a mock hash or use a test-specific approach.

  // Check if users table exists and has necessary columns
  try {
    await db.exec(`
      INSERT INTO users (id, username)
      VALUES ('${userId}', 'test_user')
      ON CONFLICT (id) DO NOTHING
    `);
  } catch (error) {
    console.warn("Could not seed API keys - users table may not have required structure:", error);
  }

  return { validApiKey, userId };
}

/**
 * Create test gateway server with all dependencies
 */
export async function createTestGatewayServer(
  config?: TestGatewayConfig,
): Promise<TestGatewayServer> {
  // Create test database
  const db = createDefaultClient();
  await db.connect();
  await initializeTestDatabase(db);

  // Initialize embedding model
  const embeddingModel = new EmbeddingModel();
  await embeddingModel.load();

  // Initialize core components
  const vectorSearch = new VectorSearch(db, embeddingModel);
  const graphEngine = new GraphRAGEngine(db);
  const dagSuggester = new DAGSuggester(graphEngine, vectorSearch);
  const executor = new ParallelExecutor(async () => ({ success: true, output: "test" }));

  // Create mock MCP clients
  const mcpClients = new Map<string, MCPClientBase>();
  mcpClients.set("test-server", createMockMCPClient());
  mcpClients.set("filesystem", createMockMCPClient());

  // Initialize optional components
  const capabilityStore = new CapabilityStore(db, embeddingModel);
  const adaptiveThresholdManager = new AdaptiveThresholdManager(undefined, db);

  // Create gateway server
  const gateway = new PMLGatewayServer(
    db,
    vectorSearch,
    graphEngine,
    dagSuggester,
    executor,
    mcpClients,
    capabilityStore,
    adaptiveThresholdManager,
    config,
  );

  const cleanup = async () => {
    try {
      await gateway.stop();
    } catch (_error) {
      // Ignore errors during cleanup
    }
    try {
      await db.close();
    } catch (_error) {
      // Ignore errors during cleanup
    }
  };

  return {
    gateway,
    db,
    testDir: "/tmp",
    cleanup,
  };
}

/**
 * Make HTTP request to gateway server
 */
export async function makeGatewayRequest(
  port: number,
  path: string,
  options?: RequestInit & { apiKey?: string },
): Promise<Response> {
  const headers = new Headers(options?.headers);

  if (options?.apiKey) {
    headers.set("x-api-key", options.apiKey);
  }

  return await fetch(`http://localhost:${port}${path}`, {
    ...options,
    headers,
  });
}

/**
 * Make JSON-RPC request to gateway
 */
export async function makeJsonRpcRequest(
  port: number,
  method: string,
  params?: Record<string, unknown>,
  id: number | string = 1,
  apiKey?: string,
): Promise<Response> {
  return await makeGatewayRequest(port, "/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    apiKey,
  });
}

/**
 * SSE Event structure
 */
export interface SSEEvent {
  event: string;
  data: string;
}

/**
 * Parse SSE buffer into events
 */
function parseSSEBuffer(buffer: string): SSEEvent[] {
  const events: SSEEvent[] = [];
  const lines = buffer.split("\n\n");

  for (const chunk of lines) {
    if (!chunk.trim()) continue;

    const eventLines = chunk.split("\n");
    let event = "message";
    let data = "";

    for (const line of eventLines) {
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        data = line.slice(5).trim();
      } else if (line.startsWith(":")) {
        // Comment/heartbeat - skip
        continue;
      }
    }

    if (data) {
      events.push({ event, data });
    }
  }

  return events;
}

/**
 * Connect to SSE stream
 */
export async function connectSSE(
  port: number,
  filter?: string,
  apiKey?: string,
): Promise<Response> {
  const url = new URL(`http://localhost:${port}/events/stream`);
  if (filter) url.searchParams.set("filter", filter);

  return await makeGatewayRequest(port, url.pathname + url.search, {
    method: "GET",
    apiKey,
  });
}

/**
 * Read SSE events from response stream
 */
export async function* readSSEEvents(response: Response): AsyncGenerator<SSEEvent> {
  if (!response.body) {
    throw new Error("Response body is null");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete events
      const events = parseSSEBuffer(buffer);
      for (const event of events) {
        yield event;
        // Remove processed event from buffer
        const eventStr = `event: ${event.event}\ndata: ${event.data}\n\n`;
        buffer = buffer.replace(eventStr, "");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Wait for specific SSE event
 */
export async function waitForSSEEvent(
  response: Response,
  eventType: string,
  timeoutMs = 5000,
): Promise<SSEEvent> {
  const timeout = new Promise<never>((_resolve, reject) => {
    setTimeout(() => reject(new Error(`Timeout waiting for event: ${eventType}`)), timeoutMs);
  });

  const waitForEvent = async (): Promise<SSEEvent> => {
    for await (const event of readSSEEvents(response)) {
      if (event.event === eventType) {
        return event;
      }
    }
    throw new Error(`Stream ended without receiving event: ${eventType}`);
  };

  return await Promise.race([waitForEvent(), timeout]);
}

/**
 * Environment variable management
 */
export async function withEnv<T>(
  key: string,
  value: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const original = Deno.env.get(key);

  if (value === undefined) {
    Deno.env.delete(key);
  } else {
    Deno.env.set(key, value);
  }

  try {
    return await fn();
  } finally {
    if (original !== undefined) {
      Deno.env.set(key, original);
    } else {
      Deno.env.delete(key);
    }
  }
}

/**
 * Run test in cloud mode (GITHUB_CLIENT_ID set)
 */
export async function withCloudMode<T>(fn: () => Promise<T>): Promise<T> {
  return await withEnv("GITHUB_CLIENT_ID", "test_client_id", fn);
}

/**
 * Run test in local mode (GITHUB_CLIENT_ID not set)
 */
export async function withLocalMode<T>(fn: () => Promise<T>): Promise<T> {
  return await withEnv("GITHUB_CLIENT_ID", undefined, fn);
}

/**
 * Wait for condition to be true
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 100,
): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Timeout waiting for condition after ${timeoutMs}ms`);
}

/**
 * Get random available port
 */
export function getRandomPort(): number {
  return 3000 + Math.floor(Math.random() * 1000);
}

/**
 * Check if port is available
 */
export async function isPortAvailable(port: number): Promise<boolean> {
  try {
    const listener = Deno.listen({ port });
    listener.close();
    return true;
  } catch (_error) {
    return false;
  }
}
