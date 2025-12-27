/**
 * Gateway Server Unit Tests
 *
 * Tests for MCP gateway server functionality:
 * - Server initialization
 * - Handler registration
 * - list_tools handler (with/without query)
 * - call_tool handler (single tool + workflow)
 * - MCP-compliant error responses
 *
 * @module tests/unit/mcp/gateway_server_test
 */

import { assert, assertEquals, assertExists } from "@std/assert";
import { PMLGatewayServer } from "../../../src/mcp/gateway-server.ts";
import type { PGliteClient } from "../../../src/db/client.ts";
import type { SearchResult, VectorSearch } from "../../../src/vector/search.ts";
import type { GraphRAGEngine } from "../../../src/graphrag/graph-engine.ts";
import type { DAGSuggester } from "../../../src/graphrag/dag-suggester.ts";
import type { ParallelExecutor } from "../../../src/dag/executor.ts";
import { MCPClient } from "../../../src/mcp/client.ts";
import type { MCPTool } from "../../../src/mcp/types.ts";

/**
 * Mock database client
 */
function createMockDB(): PGliteClient {
  return {
    query: async (sql: string) => {
      // Mock returning tools from database
      if (sql.includes("SELECT server_id, name, input_schema, description")) {
        return [
          {
            server_id: "filesystem",
            name: "read",
            description: "Read file contents",
            input_schema: { type: "object", properties: { path: { type: "string" } } },
          },
          {
            server_id: "github",
            name: "create_issue",
            description: "Create GitHub issue",
            input_schema: { type: "object", properties: { title: { type: "string" } } },
          },
        ];
      }
      return [];
    },
    connect: async () => {},
    close: async () => {},
  } as unknown as PGliteClient;
}

/**
 * Mock vector search
 */
function createMockVectorSearch(): VectorSearch {
  return {
    searchTools: async (_query: string, topK: number) => {
      const results: SearchResult[] = [
        {
          toolId: "filesystem:read",
          serverId: "filesystem",
          toolName: "read",
          score: 0.85,
          schema: {
            name: "filesystem:read",
            description: "Read file contents",
            inputSchema: { type: "object", properties: { path: { type: "string" } } },
          },
        },
      ];
      return results.slice(0, topK);
    },
  } as unknown as VectorSearch;
}

/**
 * Mock graph engine
 */
function createMockGraphEngine(): GraphRAGEngine {
  return {
    getPageRank: () => 0.5,
    updateFromExecution: async () => {}, // Required for workflow execution
  } as unknown as GraphRAGEngine;
}

/**
 * Mock DAG suggester
 */
function createMockDAGSuggester(): DAGSuggester {
  return {
    suggestDAG: async () => null,
  } as unknown as DAGSuggester;
}

/**
 * Mock parallel executor
 */
function createMockExecutor(): ParallelExecutor {
  return {
    execute: async (_dag: any) => ({
      results: new Map([["t1", { output: "test result", executionTimeMs: 100 }]]),
      errors: [],
      executionTimeMs: 100,
      parallelizationLayers: 1,
    }),
  } as unknown as ParallelExecutor;
}

/**
 * Mock MCP client
 */
function createMockMCPClient(_serverId: string): MCPClient {
  return {
    callTool: async (toolName: string, args: Record<string, unknown>) => {
      return { success: true, output: `Called ${toolName} with ${JSON.stringify(args)}` };
    },
    disconnect: async () => {},
  } as unknown as MCPClient;
}

Deno.test({
  name: "PMLGatewayServer - Initialization",
  sanitizeOps: false, // Async operations may overlap in parallel mode
  fn: () => {
    const db = createMockDB();
    const vectorSearch = createMockVectorSearch();
    const graphEngine = createMockGraphEngine();
    const dagSuggester = createMockDAGSuggester();
    const executor = createMockExecutor();
    const mcpClients = new Map<string, MCPClient>();

    const gateway = new PMLGatewayServer(
      db,
      vectorSearch,
      graphEngine,
      dagSuggester,
      executor,
      mcpClients,
      undefined, // capabilityStore
      undefined, // adaptiveThresholdManager
      {
        name: "pml-test",
        version: "1.0.0-test",
      },
    );

    assertExists(gateway);
  },
});

/**
 * NOTE: Private Method Access Strategy for Refactoring
 *
 * These tests access private methods via `(gateway as any).methodName`.
 * This is intentional for testing internal handlers during the Gateway Server refactoring.
 *
 * Strategy: "Transparent Delegation"
 * - Gateway-server.ts will keep wrapper methods that delegate to extracted handlers
 * - Tests continue to work without modification during refactoring
 * - Clean up wrappers in Phase 6 (final consolidation)
 *
 * Expected behavior during refactoring:
 * - Phase 2: handleSearchTools moves → delegated via gateway
 * - Phase 4: handleExecuteDAG moves → delegated via gateway
 * - Phase 5: handleListTools, handleCallTool move → delegated via gateway
 *
 * If a test breaks, update to call the new handler location or maintain delegation.
 */

Deno.test({
  name: "PMLGatewayServer - list_tools without query",
  sanitizeOps: false, // Async operations may overlap in parallel mode
  fn: async () => {
    const db = createMockDB();
    const vectorSearch = createMockVectorSearch();
    const graphEngine = createMockGraphEngine();
    const dagSuggester = createMockDAGSuggester();
    const executor = createMockExecutor();
    const mcpClients = new Map<string, MCPClient>();

    const gateway = new PMLGatewayServer(
      db,
      vectorSearch,
      graphEngine,
      dagSuggester,
      executor,
      mcpClients,
    );

    // Access private method via type assertion (see strategy comment above)
    const handleListTools = (gateway as any).handleListTools.bind(gateway);
    const result = await handleListTools({});

    assertExists(result.tools);
    assert(Array.isArray(result.tools));

    // ADR-013: Verify presence of critical meta-tools (more robust than exact count)
    // This approach survives refactoring that adds/removes tools
    // Note: pml:search_tools replaced by pml:discover (Story 10.6)
    // Note: pml:execute is the primary API (Story 10.7)
    const criticalTools = [
      "pml:execute",
      "pml:discover",
      "pml:execute_dag",
      "pml:execute_code",
      "pml:continue",
      "pml:abort",
      "pml:replan",
    ];

    criticalTools.forEach((name) => {
      const tool = result.tools.find((t: MCPTool) => t.name === name);
      assertExists(tool, `Missing critical meta-tool: ${name}`);
    });

    // Should have at least the core meta-tools (allows for additions)
    assert(
      result.tools.length >= criticalTools.length,
      `Expected at least ${criticalTools.length} tools, got ${result.tools.length}`,
    );

    // Verify DAG execution tool is included (renamed from execute_workflow)
    const dagTool = result.tools.find((t: MCPTool) => t.name === "pml:execute_dag");
    assertExists(dagTool);
    assertEquals(dagTool.name, "pml:execute_dag");
  },
});

Deno.test({
  name: "PMLGatewayServer - list_tools with query",
  sanitizeOps: false, // Async operations may overlap in parallel mode
  fn: async () => {
    const db = createMockDB();
    const vectorSearch = createMockVectorSearch();
    const graphEngine = createMockGraphEngine();
    const dagSuggester = createMockDAGSuggester();
    const executor = createMockExecutor();
    const mcpClients = new Map<string, MCPClient>();

    const gateway = new PMLGatewayServer(
      db,
      vectorSearch,
      graphEngine,
      dagSuggester,
      executor,
      mcpClients,
    );

    const handleListTools = (gateway as any).handleListTools.bind(gateway);
    const result = await handleListTools({ params: { query: "read files" } });

    assertExists(result.tools);
    assert(Array.isArray(result.tools));

    // Should include DAG execution tool + semantic search results (renamed from execute_workflow)
    const dagTool = result.tools.find((t: MCPTool) => t.name === "pml:execute_dag");
    assertExists(dagTool);
  },
});

Deno.test("PMLGatewayServer - call_tool single tool proxy", async () => {
  const db = createMockDB();
  const vectorSearch = createMockVectorSearch();
  const graphEngine = createMockGraphEngine();
  const dagSuggester = createMockDAGSuggester();
  const executor = createMockExecutor();

  const mcpClients = new Map<string, MCPClient>();
  mcpClients.set("filesystem", createMockMCPClient("filesystem"));

  const gateway = new PMLGatewayServer(
    db,
    vectorSearch,
    graphEngine,
    dagSuggester,
    executor,
    mcpClients,
  );

  const handleCallTool = (gateway as any).handleCallTool.bind(gateway);
  const result = await handleCallTool({
    params: {
      name: "filesystem:read",
      arguments: { path: "/test.txt" },
    },
  });

  assertExists(result.content);
  assert(Array.isArray(result.content));
  assertEquals(result.content[0].type, "text");
});

Deno.test("PMLGatewayServer - call_tool workflow execution", async () => {
  const db = createMockDB();
  const vectorSearch = createMockVectorSearch();
  const graphEngine = createMockGraphEngine();
  const dagSuggester = createMockDAGSuggester();
  const executor = createMockExecutor();
  // Add filesystem client so the tool is known and doesn't require validation
  const mcpClients = new Map<string, MCPClient>();
  mcpClients.set("filesystem", createMockMCPClient("filesystem"));

  const gateway = new PMLGatewayServer(
    db,
    vectorSearch,
    graphEngine,
    dagSuggester,
    executor,
    mcpClients,
  );

  const handleCallTool = (gateway as any).handleCallTool.bind(gateway);
  const result = await handleCallTool({
    params: {
      name: "pml:execute_dag",
      arguments: {
        workflow: {
          tasks: [
            // Use known tool (filesystem:read) to avoid validation requirement
            {
              id: "t1",
              tool: "filesystem:read",
              arguments: { path: "/tmp/test.txt" },
              dependsOn: [],
            },
          ],
        },
      },
    },
  });

  assertExists(result.content);
  assert(Array.isArray(result.content));

  const response = JSON.parse(result.content[0].text);
  assertEquals(response.status, "completed");
  assertExists(response.results);
});

Deno.test({
  name: "PMLGatewayServer - MCP error responses",
  sanitizeOps: false, // Async operations may overlap in parallel mode
  fn: async () => {
    const db = createMockDB();
    const vectorSearch = createMockVectorSearch();
    const graphEngine = createMockGraphEngine();
    const dagSuggester = createMockDAGSuggester();
    const executor = createMockExecutor();
    const mcpClients = new Map<string, MCPClient>();

    const gateway = new PMLGatewayServer(
      db,
      vectorSearch,
      graphEngine,
      dagSuggester,
      executor,
      mcpClients,
    );

    // Test missing tool name
    const handleCallTool = (gateway as any).handleCallTool.bind(gateway);
    const result = await handleCallTool({
      params: {
        arguments: {},
      },
    });

    assertExists(result.error);
    assertEquals(result.error.code, -32602); // INVALID_PARAMS
    assert(result.error.message.includes("Missing required parameter"));
  },
});

Deno.test({
  name: "PMLGatewayServer - Unknown MCP server error",
  sanitizeOps: false, // Async operations may overlap in parallel mode
  fn: async () => {
    const db = createMockDB();
    const vectorSearch = createMockVectorSearch();
    const graphEngine = createMockGraphEngine();
    const dagSuggester = createMockDAGSuggester();
    const executor = createMockExecutor();
    const mcpClients = new Map<string, MCPClient>(); // Empty - no servers

    const gateway = new PMLGatewayServer(
      db,
      vectorSearch,
      graphEngine,
      dagSuggester,
      executor,
      mcpClients,
    );

    const handleCallTool = (gateway as any).handleCallTool.bind(gateway);
    const result = await handleCallTool({
      params: {
        name: "unknown:tool",
        arguments: {},
      },
    });

    // Gateway returns MCP tool error format (visible to LLM)
    assertEquals(result.isError, true);
    assertExists(result.content);
    const errorContent = JSON.parse(result.content[0].text);
    assert(errorContent.error.includes("Unknown MCP server"));
  },
});
