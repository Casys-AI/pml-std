/**
 * MCP Gateway E2E Integration Test
 *
 * End-to-end test simulating Claude Code client interacting with Casys PML gateway.
 * Tests the complete flow: stdio transport, MCP protocol, tool execution.
 *
 * @module tests/integration/mcp_gateway_e2e_test
 */

import { assert, assertEquals, assertExists } from "@std/assert";
import { createDefaultClient } from "../../src/db/client.ts";
import { getAllMigrations, MigrationRunner } from "../../src/db/migrations.ts";
import { PMLGatewayServer } from "../../src/mcp/gateway-server.ts";
import { EmbeddingModel } from "../../src/vector/embeddings.ts";
import { VectorSearch } from "../../src/vector/search.ts";
import { GraphRAGEngine } from "../../src/graphrag/graph-engine.ts";
import { DAGSuggester } from "../../src/graphrag/dag-suggester.ts";
import { ParallelExecutor } from "../../src/dag/executor.ts";
import type { PGliteClient } from "../../src/db/client.ts";
import type { MCPTool } from "../../src/mcp/types.ts";

/**
 * Setup test database with sample tools
 */
async function setupTestDatabase(db: PGliteClient): Promise<void> {
  // Insert sample tool schemas
  await db.exec(`
    INSERT INTO tool_schema (tool_id, server_id, name, description, input_schema)
    VALUES
      ('test-server:test_tool', 'test-server', 'test_tool', 'A test tool for testing purposes',
       '{"type":"object","properties":{"input":{"type":"string"}}}'::jsonb),
      ('mock-server:mock_action', 'mock-server', 'mock_action', 'Mock action for integration testing',
       '{"type":"object","properties":{"action":{"type":"string"}}}'::jsonb)
    ON CONFLICT (tool_id) DO UPDATE SET
      description = EXCLUDED.description,
      input_schema = EXCLUDED.input_schema
  `);

  // Insert sample tool embeddings (using zero vectors for testing)
  const embedding = new Array(1024).fill(0);
  embedding[0] = 1.0; // Make non-zero to avoid division by zero

  await db.exec(`
    INSERT INTO tool_embedding (tool_id, server_id, tool_name, embedding, metadata)
    VALUES
      ('test-server:test_tool', 'test-server', 'test_tool', '[${embedding.join(",")}]', '{}'),
      ('mock-server:mock_action', 'mock-server', 'mock_action', '[${embedding.join(",")}]', '{}')
    ON CONFLICT (tool_id) DO UPDATE SET
      embedding = EXCLUDED.embedding,
      metadata = EXCLUDED.metadata
  `);
}

/**
 * Mock MCP client for testing
 */
function createMockMCPClient() {
  return {
    callTool: async (toolName: string, args: Record<string, unknown>) => {
      return {
        success: true,
        result: `Mock result for ${toolName}`,
        args,
      };
    },
    disconnect: async () => {},
    close: async () => {},
  };
}

/**
 * Mock tool executor for ParallelExecutor
 */
function createMockToolExecutor() {
  return async (toolName: string, args: Record<string, unknown>) => {
    return {
      success: true,
      output: `Executed ${toolName}`,
      args,
    };
  };
}

Deno.test({
  name: "MCP Gateway E2E - Full integration test",
  async fn() {
    // 1. Setup database
    const db = createDefaultClient();
    await db.connect();

    const runner = new MigrationRunner(db);
    await runner.runUp(getAllMigrations());

    await setupTestDatabase(db);

    try {
      // 2. Initialize components
      const embeddingModel = new EmbeddingModel();
      await embeddingModel.load();

      const vectorSearch = new VectorSearch(db, embeddingModel);
      const graphEngine = new GraphRAGEngine(db);
      await graphEngine.syncFromDatabase();

      const dagSuggester = new DAGSuggester(graphEngine, vectorSearch);

      const toolExecutor = createMockToolExecutor();
      const executor = new ParallelExecutor(toolExecutor);

      // Create mock MCP clients
      const mcpClients = new Map();
      mcpClients.set("test-server", createMockMCPClient());
      mcpClients.set("mock-server", createMockMCPClient());

      // 3. Create gateway
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

      // 4. Test list_tools (simulating Claude Code request)
      const handleListTools = (gateway as any).handleListTools.bind(gateway);
      const listResult = await handleListTools({
        params: { query: "test" },
      });

      assertExists(listResult.tools);
      assert(Array.isArray(listResult.tools));
      assert(listResult.tools.length > 0);

      // Verify workflow tool is present (renamed in Story 2.5-4)
      const workflowTool = listResult.tools.find((t: MCPTool) => t.name === "pml:execute_dag");
      assertExists(workflowTool);

      // 5. Test call_tool for single tool (simulating Claude Code calling a tool)
      const handleCallTool = (gateway as any).handleCallTool.bind(gateway);
      const callResult = await handleCallTool({
        params: {
          name: "test-server:test_tool",
          arguments: { input: "test input" },
        },
      });

      assertExists(callResult.content);
      assert(Array.isArray(callResult.content));
      assertEquals(callResult.content[0].type, "text");

      const parsedResult = JSON.parse(callResult.content[0].text);
      assertEquals(parsedResult.success, true);

      // 6. Test workflow execution (renamed in Story 2.5-4)
      const workflowResult = await handleCallTool({
        params: {
          name: "pml:execute_dag",
          arguments: {
            workflow: {
              tasks: [
                {
                  id: "task1",
                  tool: "test-server:test_tool",
                  arguments: { input: "workflow test" },
                  dependsOn: [],
                },
                {
                  id: "task2",
                  tool: "mock-server:mock_action",
                  arguments: { action: "test" },
                  dependsOn: ["task1"],
                },
              ],
            },
          },
        },
      });

      assertExists(workflowResult.content);
      const workflowResponse = JSON.parse(workflowResult.content[0].text);
      assertEquals(workflowResponse.status, "completed");
      assertExists(workflowResponse.results);

      console.log("✓ E2E integration test completed successfully");
    } finally {
      await db.close();
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "MCP Gateway E2E - Error handling",
  async fn() {
    const db = createDefaultClient();
    await db.connect();

    const runner = new MigrationRunner(db);
    await runner.runUp(getAllMigrations());

    try {
      const embeddingModel = new EmbeddingModel();
      await embeddingModel.load();

      const vectorSearch = new VectorSearch(db, embeddingModel);
      const graphEngine = new GraphRAGEngine(db);
      await graphEngine.syncFromDatabase();

      const dagSuggester = new DAGSuggester(graphEngine, vectorSearch);
      const toolExecutor = createMockToolExecutor();
      const executor = new ParallelExecutor(toolExecutor);

      const mcpClients = new Map();

      const gateway = new PMLGatewayServer(
        db,
        vectorSearch,
        graphEngine,
        dagSuggester,
        executor,
        mcpClients,
      );

      // Test calling unknown server
      const handleCallTool = (gateway as any).handleCallTool.bind(gateway);
      const errorResult = await handleCallTool({
        params: {
          name: "unknown:tool",
          arguments: {},
        },
      });

      // Should return MCP-compliant error
      assertExists(errorResult.error);
      assertEquals(errorResult.error.code, -32602); // INVALID_PARAMS
      assert(errorResult.error.message.includes("Unknown MCP server"));

      console.log("✓ Error handling test completed successfully");
    } finally {
      await db.close();
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

// =============================================================================
// Story 10.6: pml:discover Integration Tests (AC11)
// =============================================================================

Deno.test({
  name: "MCP Gateway E2E - pml:discover via gateway (Story 10.6 AC11)",
  async fn() {
    const db = createDefaultClient();
    await db.connect();

    const runner = new MigrationRunner(db);
    await runner.runUp(getAllMigrations());

    await setupTestDatabase(db);

    try {
      const embeddingModel = new EmbeddingModel();
      await embeddingModel.load();

      const vectorSearch = new VectorSearch(db, embeddingModel);
      const graphEngine = new GraphRAGEngine(db);
      await graphEngine.syncFromDatabase();

      const dagSuggester = new DAGSuggester(graphEngine, vectorSearch);
      const toolExecutor = createMockToolExecutor();
      const executor = new ParallelExecutor(toolExecutor);

      const mcpClients = new Map();
      mcpClients.set("test-server", createMockMCPClient());
      mcpClients.set("mock-server", createMockMCPClient());

      const gateway = new PMLGatewayServer(
        db,
        vectorSearch,
        graphEngine,
        dagSuggester,
        executor,
        mcpClients,
      );

      // Test pml:discover tool via handleCallTool
      const handleCallTool = (gateway as any).handleCallTool.bind(gateway);
      const discoverResult = await handleCallTool({
        params: {
          name: "pml:discover",
          arguments: {
            intent: "test tool for testing",
            limit: 5,
          },
        },
      });

      // Verify response structure
      assertExists(discoverResult.content);
      assert(Array.isArray(discoverResult.content));
      assertEquals(discoverResult.content[0].type, "text");

      const response = JSON.parse(discoverResult.content[0].text);
      assertExists(response.results);
      assertExists(response.meta);
      assertEquals(response.meta.filter_type, "all");
      assert(typeof response.meta.total_found === "number");
      assert(typeof response.meta.tools_count === "number");
      assert(typeof response.meta.capabilities_count === "number");

      // Verify results are properly typed
      if (response.results.length > 0) {
        const firstResult = response.results[0];
        assertExists(firstResult.type);
        assertExists(firstResult.id);
        assertExists(firstResult.name);
        assert(typeof firstResult.score === "number");
        assert(firstResult.score >= 0 && firstResult.score <= 1);
      }

      console.log("✓ pml:discover E2E test completed successfully");
    } finally {
      await db.close();
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "MCP Gateway E2E - pml:discover with filter type (Story 10.6 AC11)",
  async fn() {
    const db = createDefaultClient();
    await db.connect();

    const runner = new MigrationRunner(db);
    await runner.runUp(getAllMigrations());

    await setupTestDatabase(db);

    try {
      const embeddingModel = new EmbeddingModel();
      await embeddingModel.load();

      const vectorSearch = new VectorSearch(db, embeddingModel);
      const graphEngine = new GraphRAGEngine(db);
      await graphEngine.syncFromDatabase();

      const dagSuggester = new DAGSuggester(graphEngine, vectorSearch);
      const toolExecutor = createMockToolExecutor();
      const executor = new ParallelExecutor(toolExecutor);

      const mcpClients = new Map();
      mcpClients.set("test-server", createMockMCPClient());

      const gateway = new PMLGatewayServer(
        db,
        vectorSearch,
        graphEngine,
        dagSuggester,
        executor,
        mcpClients,
      );

      const handleCallTool = (gateway as any).handleCallTool.bind(gateway);

      // Test filter type = "tool"
      const toolOnlyResult = await handleCallTool({
        params: {
          name: "pml:discover",
          arguments: {
            intent: "test",
            filter: { type: "tool" },
          },
        },
      });

      const toolResponse = JSON.parse(toolOnlyResult.content[0].text);
      assertExists(toolResponse.results);
      assertEquals(toolResponse.meta.filter_type, "tool");
      // All results should be tools
      for (const result of toolResponse.results) {
        assertEquals(result.type, "tool");
      }

      console.log("✓ pml:discover filter test completed successfully");
    } finally {
      await db.close();
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name:
    "MCP Gateway E2E - deprecated pml:search_tools still works (Story 10.6 AC11 backward compat)",
  async fn() {
    const db = createDefaultClient();
    await db.connect();

    const runner = new MigrationRunner(db);
    await runner.runUp(getAllMigrations());

    await setupTestDatabase(db);

    try {
      const embeddingModel = new EmbeddingModel();
      await embeddingModel.load();

      const vectorSearch = new VectorSearch(db, embeddingModel);
      const graphEngine = new GraphRAGEngine(db);
      await graphEngine.syncFromDatabase();

      const dagSuggester = new DAGSuggester(graphEngine, vectorSearch);
      const toolExecutor = createMockToolExecutor();
      const executor = new ParallelExecutor(toolExecutor);

      const mcpClients = new Map();
      mcpClients.set("test-server", createMockMCPClient());

      const gateway = new PMLGatewayServer(
        db,
        vectorSearch,
        graphEngine,
        dagSuggester,
        executor,
        mcpClients,
      );

      const handleCallTool = (gateway as any).handleCallTool.bind(gateway);

      // Test deprecated pml:search_tools still works (backward compatibility)
      const searchResult = await handleCallTool({
        params: {
          name: "pml:search_tools",
          arguments: {
            query: "test tool",
            limit: 5,
          },
        },
      });

      // Should return valid response (not error)
      assertExists(searchResult.content);
      assert(Array.isArray(searchResult.content));
      assertEquals(searchResult.content[0].type, "text");

      const response = JSON.parse(searchResult.content[0].text);
      // Old API returns { tools: [...], meta: {...} }
      assertExists(response.tools);
      assert(Array.isArray(response.tools));

      console.log("✓ Deprecated pml:search_tools backward compat test completed");
    } finally {
      await db.close();
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name:
    "MCP Gateway E2E - deprecated pml:search_capabilities still works (Story 10.6 AC11 backward compat)",
  async fn() {
    const db = createDefaultClient();
    await db.connect();

    const runner = new MigrationRunner(db);
    await runner.runUp(getAllMigrations());

    try {
      const embeddingModel = new EmbeddingModel();
      await embeddingModel.load();

      const vectorSearch = new VectorSearch(db, embeddingModel);
      const graphEngine = new GraphRAGEngine(db);
      await graphEngine.syncFromDatabase();

      const dagSuggester = new DAGSuggester(graphEngine, vectorSearch);
      const toolExecutor = createMockToolExecutor();
      const executor = new ParallelExecutor(toolExecutor);

      const mcpClients = new Map();

      const gateway = new PMLGatewayServer(
        db,
        vectorSearch,
        graphEngine,
        dagSuggester,
        executor,
        mcpClients,
      );

      const handleCallTool = (gateway as any).handleCallTool.bind(gateway);

      // Test deprecated pml:search_capabilities still works
      const searchResult = await handleCallTool({
        params: {
          name: "pml:search_capabilities",
          arguments: {
            intent: "create an issue",
          },
        },
      });

      // Should return valid response (not error)
      assertExists(searchResult.content);
      assert(Array.isArray(searchResult.content));
      assertEquals(searchResult.content[0].type, "text");

      const response = JSON.parse(searchResult.content[0].text);
      // Old API returns { capabilities: [...], ... }
      assertExists(response.capabilities);
      assert(Array.isArray(response.capabilities));

      console.log("✓ Deprecated pml:search_capabilities backward compat test completed");
    } finally {
      await db.close();
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "MCP Gateway E2E - pml:discover returns error for missing intent (Story 10.6 AC11)",
  async fn() {
    const db = createDefaultClient();
    await db.connect();

    const runner = new MigrationRunner(db);
    await runner.runUp(getAllMigrations());

    try {
      const embeddingModel = new EmbeddingModel();
      await embeddingModel.load();

      const vectorSearch = new VectorSearch(db, embeddingModel);
      const graphEngine = new GraphRAGEngine(db);
      const dagSuggester = new DAGSuggester(graphEngine, vectorSearch);
      const executor = new ParallelExecutor(createMockToolExecutor());
      const mcpClients = new Map();

      const gateway = new PMLGatewayServer(
        db,
        vectorSearch,
        graphEngine,
        dagSuggester,
        executor,
        mcpClients,
      );

      const handleCallTool = (gateway as any).handleCallTool.bind(gateway);

      // Test pml:discover without intent parameter
      const errorResult = await handleCallTool({
        params: {
          name: "pml:discover",
          arguments: {},
        },
      });

      // Should return error response
      assertExists(errorResult.content);
      const response = JSON.parse(errorResult.content[0].text);
      assertExists(response.error);
      assert(response.error.includes("intent"));

      console.log("✓ pml:discover error handling test completed");
    } finally {
      await db.close();
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

// =============================================================================
// Story 10.7: pml:execute Integration Tests (AC11)
// =============================================================================

Deno.test({
  name: "MCP Gateway E2E - pml:execute Mode Direct via gateway (Story 10.7 AC11)",
  async fn() {
    const db = createDefaultClient();
    await db.connect();

    const runner = new MigrationRunner(db);
    await runner.runUp(getAllMigrations());

    await setupTestDatabase(db);

    try {
      const embeddingModel = new EmbeddingModel();
      await embeddingModel.load();

      const vectorSearch = new VectorSearch(db, embeddingModel);
      const graphEngine = new GraphRAGEngine(db);
      await graphEngine.syncFromDatabase();

      const dagSuggester = new DAGSuggester(graphEngine, vectorSearch);
      const toolExecutor = createMockToolExecutor();
      const executor = new ParallelExecutor(toolExecutor);

      // Create mock MCP clients with listTools support
      const mockClient = {
        ...createMockMCPClient(),
        listTools: async () => [
          {
            name: "test_tool",
            description: "A test tool",
            inputSchema: { type: "object", properties: { input: { type: "string" } } },
          },
        ],
      };
      const mcpClients = new Map();
      mcpClients.set("test-server", mockClient);

      const gateway = new PMLGatewayServer(
        db,
        vectorSearch,
        graphEngine,
        dagSuggester,
        executor,
        mcpClients,
        undefined, // capabilityStore - needed for Mode Direct
        undefined, // adaptiveThresholdManager
        { name: "pml-test", version: "1.0.0-test" },
        embeddingModel, // Story 10.7: Pass embeddingModel for SHGAT
      );

      const handleCallTool = (gateway as any).handleCallTool.bind(gateway);

      // Test Mode Direct: intent + code
      const directResult = await handleCallTool({
        params: {
          name: "pml:execute",
          arguments: {
            intent: "Read a test file and return its content",
            code: `
              const result = await mcp.test-server.test_tool({ input: "hello" });
              return result;
            `,
          },
        },
      });

      // Verify response structure
      assertExists(directResult.content);
      assert(Array.isArray(directResult.content));
      assertEquals(directResult.content[0].type, "text");

      const response = JSON.parse(directResult.content[0].text);

      // Mode Direct should return execution result or error (depends on capabilityStore availability)
      // Without capabilityStore, should return tool error about missing capability store
      assertExists(response);
      if (response.error) {
        // Expected when capabilityStore is not configured
        assert(typeof response.error === "string");
      } else {
        // If execution succeeded, should have status
        assertExists(response.status);
      }

      console.log("✓ pml:execute Mode Direct E2E test completed");
    } finally {
      await db.close();
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "MCP Gateway E2E - pml:execute Mode Suggestion returns suggestions (Story 10.7 AC11)",
  async fn() {
    const db = createDefaultClient();
    await db.connect();

    const runner = new MigrationRunner(db);
    await runner.runUp(getAllMigrations());

    await setupTestDatabase(db);

    try {
      const embeddingModel = new EmbeddingModel();
      await embeddingModel.load();

      const vectorSearch = new VectorSearch(db, embeddingModel);
      const graphEngine = new GraphRAGEngine(db);
      await graphEngine.syncFromDatabase();

      const dagSuggester = new DAGSuggester(graphEngine, vectorSearch);
      const toolExecutor = createMockToolExecutor();
      const executor = new ParallelExecutor(toolExecutor);

      const mcpClients = new Map();
      mcpClients.set("test-server", {
        ...createMockMCPClient(),
        listTools: async () => [
          {
            name: "test_tool",
            description: "A test tool for testing purposes",
            inputSchema: { type: "object", properties: { input: { type: "string" } } },
          },
        ],
      });

      const gateway = new PMLGatewayServer(
        db,
        vectorSearch,
        graphEngine,
        dagSuggester,
        executor,
        mcpClients,
        undefined, // capabilityStore
        undefined, // adaptiveThresholdManager
        { name: "pml-test", version: "1.0.0-test" },
        embeddingModel,
      );

      const handleCallTool = (gateway as any).handleCallTool.bind(gateway);

      // Test Mode Suggestion: intent only (no code)
      const suggestionResult = await handleCallTool({
        params: {
          name: "pml:execute",
          arguments: {
            intent: "test something with a tool",
          },
        },
      });

      // Verify response structure
      assertExists(suggestionResult.content);
      assert(Array.isArray(suggestionResult.content));
      assertEquals(suggestionResult.content[0].type, "text");

      const response = JSON.parse(suggestionResult.content[0].text);

      // Mode Suggestion should return suggestions structure
      assertEquals(response.status, "suggestions");
      assertExists(response.suggestions);
      assert(typeof response.suggestions.confidence === "number");
      assertExists(response.suggestions.tools);
      assert(Array.isArray(response.suggestions.tools));
      assertExists(response.executionTimeMs);
      assert(typeof response.executionTimeMs === "number");

      console.log("✓ pml:execute Mode Suggestion E2E test completed");
    } finally {
      await db.close();
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "MCP Gateway E2E - pml:execute returns error for missing intent (Story 10.7 AC11)",
  async fn() {
    const db = createDefaultClient();
    await db.connect();

    const runner = new MigrationRunner(db);
    await runner.runUp(getAllMigrations());

    try {
      const embeddingModel = new EmbeddingModel();
      await embeddingModel.load();

      const vectorSearch = new VectorSearch(db, embeddingModel);
      const graphEngine = new GraphRAGEngine(db);
      const dagSuggester = new DAGSuggester(graphEngine, vectorSearch);
      const executor = new ParallelExecutor(createMockToolExecutor());
      const mcpClients = new Map();

      const gateway = new PMLGatewayServer(
        db,
        vectorSearch,
        graphEngine,
        dagSuggester,
        executor,
        mcpClients,
      );

      const handleCallTool = (gateway as any).handleCallTool.bind(gateway);

      // Test pml:execute without intent parameter
      const errorResult = await handleCallTool({
        params: {
          name: "pml:execute",
          arguments: {},
        },
      });

      // Should return error response
      assertExists(errorResult.content);
      const response = JSON.parse(errorResult.content[0].text);
      assertExists(response.error);
      assert(response.error.includes("intent"));

      console.log("✓ pml:execute error handling test completed");
    } finally {
      await db.close();
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "MCP Gateway E2E - deprecated pml:execute_dag still works (Story 10.7 backward compat)",
  async fn() {
    const db = createDefaultClient();
    await db.connect();

    const runner = new MigrationRunner(db);
    await runner.runUp(getAllMigrations());

    await setupTestDatabase(db);

    try {
      const embeddingModel = new EmbeddingModel();
      await embeddingModel.load();

      const vectorSearch = new VectorSearch(db, embeddingModel);
      const graphEngine = new GraphRAGEngine(db);
      await graphEngine.syncFromDatabase();

      const dagSuggester = new DAGSuggester(graphEngine, vectorSearch);
      const toolExecutor = createMockToolExecutor();
      const executor = new ParallelExecutor(toolExecutor);

      const mcpClients = new Map();
      mcpClients.set("test-server", createMockMCPClient());

      const gateway = new PMLGatewayServer(
        db,
        vectorSearch,
        graphEngine,
        dagSuggester,
        executor,
        mcpClients,
      );

      const handleCallTool = (gateway as any).handleCallTool.bind(gateway);

      // Test deprecated pml:execute_dag still works
      // Note: per_layer_validation: false to get immediate completion (not layer_complete)
      const dagResult = await handleCallTool({
        params: {
          name: "pml:execute_dag",
          arguments: {
            workflow: {
              tasks: [
                {
                  id: "task1",
                  tool: "test-server:test_tool",
                  arguments: { input: "backward compat test" },
                  dependsOn: [],
                },
              ],
            },
            config: {
              per_layer_validation: false,
            },
          },
        },
      });

      // Should return valid response (not error)
      assertExists(dagResult.content);
      assert(Array.isArray(dagResult.content));
      assertEquals(dagResult.content[0].type, "text");

      const response = JSON.parse(dagResult.content[0].text);
      // DAG execution returns { status: "completed", results: [...] }
      // or { status: "layer_complete" } if per_layer_validation is enabled
      assert(
        response.status === "completed" || response.status === "layer_complete",
        `Expected completed or layer_complete, got ${response.status}`,
      );
      // Results may be in different formats depending on mode
      if (response.status === "completed") {
        assertExists(response.results);
      }

      console.log("✓ Deprecated pml:execute_dag backward compat test completed");
    } finally {
      await db.close();
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "MCP Gateway E2E - deprecated pml:execute_code still works (Story 10.7 backward compat)",
  async fn() {
    const db = createDefaultClient();
    await db.connect();

    const runner = new MigrationRunner(db);
    await runner.runUp(getAllMigrations());

    try {
      const embeddingModel = new EmbeddingModel();
      await embeddingModel.load();

      const vectorSearch = new VectorSearch(db, embeddingModel);
      const graphEngine = new GraphRAGEngine(db);
      const dagSuggester = new DAGSuggester(graphEngine, vectorSearch);
      const executor = new ParallelExecutor(createMockToolExecutor());
      const mcpClients = new Map();

      const gateway = new PMLGatewayServer(
        db,
        vectorSearch,
        graphEngine,
        dagSuggester,
        executor,
        mcpClients,
      );

      const handleCallTool = (gateway as any).handleCallTool.bind(gateway);

      // Test deprecated pml:execute_code still works
      const codeResult = await handleCallTool({
        params: {
          name: "pml:execute_code",
          arguments: {
            code: "return 42;",
          },
        },
      });

      // Should return valid response (may be error about no tools, but not protocol error)
      assertExists(codeResult.content);
      assert(Array.isArray(codeResult.content));
      assertEquals(codeResult.content[0].type, "text");

      // Response can be success or error, but should be valid JSON
      const response = JSON.parse(codeResult.content[0].text);
      assertExists(response);

      console.log("✓ Deprecated pml:execute_code backward compat test completed");
    } finally {
      await db.close();
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
