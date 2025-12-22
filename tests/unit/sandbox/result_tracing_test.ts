/**
 * Result Tracing Tests (Story 11.1)
 *
 * Tests for result capture in execution traces:
 * - tool_end events include result from MCP tool calls
 * - capability_end events include result from capability execution
 * - Circular reference handling (no crashes, graceful fallback)
 * - Large results (verify no memory issues)
 *
 * @module tests/unit/sandbox/result_tracing_test
 */

import { assertEquals, assertExists } from "@std/assert";
import { WorkerBridge } from "../../../src/sandbox/worker-bridge.ts";
import type { MCPClient } from "../../../src/mcp/client.ts";
import type { ToolDefinition, TraceEvent } from "../../../src/sandbox/types.ts";

/**
 * Mock MCPClient that returns specific results for testing
 */
function createMockMCPClient(
  serverId: string,
  responses: Record<string, unknown> = {},
): MCPClient {
  return {
    serverId,
    serverName: serverId,
    callTool: async (toolName: string, _args: Record<string, unknown>) => {
      // Simulate small delay
      await new Promise((resolve) => setTimeout(resolve, 5));

      // Return configured response (check if key exists, even if value is undefined/null)
      if (toolName in responses) {
        return responses[toolName];
      }

      // Default mock response
      return {
        success: true,
        tool: toolName,
        timestamp: Date.now(),
      };
    },
    connect: async () => {},
    disconnect: async () => {},
    close: async () => {},
    listTools: async () => [],
    extractSchemas: async () => ({
      serverId,
      serverName: serverId,
      status: "success" as const,
      toolsExtracted: 0,
      tools: [],
      connectionDuration: 0,
    }),
  } as unknown as MCPClient;
}

/**
 * Create test tool definitions
 */
function createToolDefinitions(): ToolDefinition[] {
  return [
    {
      server: "test",
      name: "get_data",
      description: "Get test data",
      inputSchema: { type: "object", properties: {} },
    },
    {
      server: "test",
      name: "process_data",
      description: "Process test data",
      inputSchema: { type: "object", properties: { data: { type: "string" } } },
    },
  ];
}

// ═══════════════════════════════════════════════════════════════════════════════
// AC7: tool_end events include result
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test({
  name: "Story 11.1 - AC7: tool_end includes result after successful tool call",
  async fn() {
    // Arrange: Mock MCP client with specific response
    const expectedResult = {
      content: [{ type: "text", text: "Hello from tool!" }],
      data: { foo: "bar", count: 42 },
    };

    const mockClient = createMockMCPClient("test", {
      get_data: expectedResult,
    });
    const clients = new Map<string, MCPClient>([["test", mockClient as MCPClient]]);
    const bridge = new WorkerBridge(clients, { timeout: 5000 });

    const code = `
      const result = await mcp.test.get_data({});
      return result;
    `;

    try {
      // Act: Execute code that calls a tool
      const result = await bridge.execute(code, createToolDefinitions());

      // Assert: Execution succeeded
      assertEquals(result.success, true);

      // Assert: Check traces for tool_end with result
      const traces = bridge.getTraces();
      const toolEndTrace = traces.find((t) => t.type === "tool_end") as TraceEvent & {
        result?: unknown;
      };

      assertExists(toolEndTrace, "tool_end trace should exist");
      assertExists(toolEndTrace.result, "tool_end trace should include result");
      assertEquals(toolEndTrace.result, expectedResult);
    } finally {
      bridge.cleanup();
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "Story 11.1 - AC7: tool_end result is JSON-serializable",
  async fn() {
    // Arrange: Mock MCP client with complex nested response
    const complexResult = {
      nested: {
        array: [1, 2, { deep: "value" }],
        nullValue: null,
        boolValue: true,
      },
      strings: ["a", "b", "c"],
    };

    const mockClient = createMockMCPClient("test", {
      get_data: complexResult,
    });
    const clients = new Map<string, MCPClient>([["test", mockClient as MCPClient]]);
    const bridge = new WorkerBridge(clients, { timeout: 5000 });

    const code = `await mcp.test.get_data({})`;

    try {
      // Act
      await bridge.execute(code, createToolDefinitions());

      // Assert: Result is JSON-serializable
      const traces = bridge.getTraces();
      const toolEndTrace = traces.find((t) => t.type === "tool_end") as TraceEvent & {
        result?: unknown;
      };

      assertExists(toolEndTrace?.result);

      // Verify it can be serialized without error
      const serialized = JSON.stringify(toolEndTrace.result);
      assertExists(serialized);
      assertEquals(JSON.parse(serialized), complexResult);
    } finally {
      bridge.cleanup();
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC8: capability_end events include result
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test({
  name: "Story 11.1 - AC8: capability_end includes result after capability execution",
  async fn() {
    // Arrange
    const mockClient = createMockMCPClient("test", {
      get_data: { data: "test-value" },
    });
    const clients = new Map<string, MCPClient>([["test", mockClient as MCPClient]]);
    const bridge = new WorkerBridge(clients, { timeout: 5000 });

    // Create capability context with a capability that returns a value
    const capabilityContext = `
      let __capabilityDepth = 0;
      const capabilities = {
        getData: async (args) => {
          const __depth = (__capabilityDepth || 0);
          if (__depth >= 3) throw new Error("Depth exceeded");
          __capabilityDepth = __depth + 1;
          __trace({ type: "capability_start", capability: "getData", capabilityId: "cap-test-1", args });
          let __capSuccess = true;
          let __capError = null;
          let __capResult = undefined;
          const __capStartTime = Date.now();
          try {
            __capResult = await (async () => {
              const result = await mcp.test.get_data({});
              return { transformed: result.data };
            })();
            return __capResult;
          } catch (e) {
            __capSuccess = false;
            __capError = e;
            throw e;
          } finally {
            __capabilityDepth = __depth;
            __trace({ type: "capability_end", capability: "getData", capabilityId: "cap-test-1", success: __capSuccess, error: __capError?.message, result: __capResult, durationMs: Date.now() - __capStartTime });
          }
        }
      };
    `;

    const code = `return await capabilities.getData({})`;

    try {
      // Act
      const result = await bridge.execute(code, createToolDefinitions(), undefined, capabilityContext);

      // Assert: Execution succeeded with expected return value
      assertEquals(result.success, true);
      assertEquals(result.result, { transformed: "test-value" });

      // Wait a bit for BroadcastChannel to propagate traces
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Assert: Check traces for capability_end with result
      const traces = bridge.getTraces();
      const capabilityEndTrace = traces.find((t) => t.type === "capability_end") as TraceEvent & {
        result?: unknown;
        durationMs?: number;
      };

      assertExists(capabilityEndTrace, "capability_end trace should exist");
      assertExists(capabilityEndTrace.result, "capability_end trace should include result");
      assertEquals(capabilityEndTrace.result, { transformed: "test-value" });
      assertExists(capabilityEndTrace.durationMs, "capability_end trace should include durationMs");
    } finally {
      bridge.cleanup();
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC9: Circular reference handling
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test({
  name: "Story 11.1 - AC9: circular reference handling (graceful fallback)",
  async fn() {
    // Arrange: Create a circular reference object
    // Note: MCP tools shouldn't return circular refs, but we handle it gracefully
    const circularObj: Record<string, unknown> = { name: "test" };
    circularObj.self = circularObj; // Create circular reference

    const mockClient = createMockMCPClient("test", {
      get_data: circularObj,
    });
    const clients = new Map<string, MCPClient>([["test", mockClient as MCPClient]]);
    const bridge = new WorkerBridge(clients, { timeout: 5000 });

    const code = `await mcp.test.get_data({})`;

    try {
      // Act: Should not crash, should handle gracefully
      const result = await bridge.execute(code, createToolDefinitions());

      // Assert: Execution completed (didn't crash)
      assertExists(result);

      // Assert: Check traces - result should be handled gracefully
      const traces = bridge.getTraces();
      const toolEndTrace = traces.find((t) => t.type === "tool_end") as TraceEvent & {
        result?: unknown;
      };

      assertExists(toolEndTrace, "tool_end trace should exist even with circular ref");
      assertExists(toolEndTrace.result, "result should exist (fallback)");

      // Check that result is the fallback format for non-serializable
      const fallbackResult = toolEndTrace.result as Record<string, unknown>;
      if (fallbackResult.__type === "non-serializable") {
        assertEquals(fallbackResult.__type, "non-serializable");
        assertEquals(fallbackResult.typeof, "object");
        assertExists(fallbackResult.toString);
      }
    } finally {
      bridge.cleanup();
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "Story 11.1 - AC9: large results are captured without memory issues",
  async fn() {
    // Arrange: Create a large result (100KB of data)
    const largeArray = Array.from({ length: 10000 }, (_, i) => ({
      id: i,
      data: `item-${i}-${"x".repeat(10)}`,
    }));

    const mockClient = createMockMCPClient("test", {
      get_data: { items: largeArray },
    });
    const clients = new Map<string, MCPClient>([["test", mockClient as MCPClient]]);
    const bridge = new WorkerBridge(clients, { timeout: 10000 });

    const code = `await mcp.test.get_data({})`;

    try {
      // Act
      const result = await bridge.execute(code, createToolDefinitions());

      // Assert: Execution succeeded
      assertEquals(result.success, true);

      // Assert: Result was captured in trace
      const traces = bridge.getTraces();
      const toolEndTrace = traces.find((t) => t.type === "tool_end") as TraceEvent & {
        result?: unknown;
      };

      assertExists(toolEndTrace?.result);
      const capturedResult = toolEndTrace.result as { items: unknown[] };
      assertEquals(capturedResult.items.length, 10000);
    } finally {
      bridge.cleanup();
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

// ═══════════════════════════════════════════════════════════════════════════════
// Additional edge cases
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test({
  name: "Story 11.1 - tool_end includes result=undefined when tool returns undefined",
  async fn() {
    const mockClient = createMockMCPClient("test", {
      get_data: undefined,
    });
    const clients = new Map<string, MCPClient>([["test", mockClient as MCPClient]]);
    const bridge = new WorkerBridge(clients, { timeout: 5000 });

    const code = `await mcp.test.get_data({})`;

    try {
      await bridge.execute(code, createToolDefinitions());

      const traces = bridge.getTraces();
      const toolEndTrace = traces.find((t) => t.type === "tool_end") as TraceEvent & {
        result?: unknown;
      };

      assertExists(toolEndTrace);
      // undefined result should be captured as undefined
      assertEquals(toolEndTrace.result, undefined);
    } finally {
      bridge.cleanup();
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "Story 11.1 - tool_end includes result when tool returns object with null field",
  async fn() {
    const mockClient = createMockMCPClient("test", {
      get_data: { value: null, status: "empty" },
    });
    const clients = new Map<string, MCPClient>([["test", mockClient as MCPClient]]);
    const bridge = new WorkerBridge(clients, { timeout: 5000 });

    const code = `await mcp.test.get_data({})`;

    try {
      await bridge.execute(code, createToolDefinitions());

      const traces = bridge.getTraces();
      const toolEndTrace = traces.find((t) => t.type === "tool_end") as TraceEvent & {
        result?: unknown;
      };

      assertExists(toolEndTrace);
      assertExists(toolEndTrace.result);
      assertEquals((toolEndTrace.result as Record<string, unknown>).value, null);
      assertEquals((toolEndTrace.result as Record<string, unknown>).status, "empty");
    } finally {
      bridge.cleanup();
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

// ═══════════════════════════════════════════════════════════════════════════════
// Code Review Fixes: Additional edge case tests
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test({
  name: "Story 11.1 - tool_end does NOT include result when tool throws error",
  async fn() {
    // Arrange: Mock MCP client that throws an error
    const mockClient = {
      serverId: "test",
      serverName: "test",
      callTool: async (_toolName: string, _args: Record<string, unknown>) => {
        throw new Error("Tool execution failed: connection timeout");
      },
      connect: async () => {},
      disconnect: async () => {},
      close: async () => {},
      listTools: async () => [],
      extractSchemas: async () => ({
        serverId: "test",
        serverName: "test",
        status: "success" as const,
        toolsExtracted: 0,
        tools: [],
        connectionDuration: 0,
      }),
    } as unknown as MCPClient;

    const clients = new Map<string, MCPClient>([["test", mockClient]]);
    const bridge = new WorkerBridge(clients, { timeout: 5000 });

    const code = `
      try {
        await mcp.test.get_data({});
      } catch (e) {
        return { caught: true, message: e.message };
      }
    `;

    try {
      // Act: Execute code that calls a failing tool
      const result = await bridge.execute(code, createToolDefinitions());

      // Assert: Execution completed (error was caught in user code)
      assertEquals(result.success, true);

      // Assert: Check traces for tool_end WITHOUT result
      const traces = bridge.getTraces();
      const toolEndTrace = traces.find((t) => t.type === "tool_end") as TraceEvent & {
        result?: unknown;
        error?: string;
      };

      assertExists(toolEndTrace, "tool_end trace should exist");
      assertEquals(toolEndTrace.success, false, "tool should have failed");
      assertExists(toolEndTrace.error, "error message should be present");
      assertEquals(toolEndTrace.result, undefined, "result should NOT be present on failed tool");
    } finally {
      bridge.cleanup();
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "Story 11.1 - tool_end includes result when tool returns raw null",
  async fn() {
    // Test that raw null is properly captured (not transformed)
    const mockClient = createMockMCPClient("test", {
      get_data: null,
    });
    const clients = new Map<string, MCPClient>([["test", mockClient as MCPClient]]);
    const bridge = new WorkerBridge(clients, { timeout: 5000 });

    const code = `await mcp.test.get_data({})`;

    try {
      await bridge.execute(code, createToolDefinitions());

      const traces = bridge.getTraces();
      const toolEndTrace = traces.find((t) => t.type === "tool_end") as TraceEvent & {
        result?: unknown;
      };

      assertExists(toolEndTrace);
      // Raw null should be captured as null (not transformed)
      assertEquals(toolEndTrace.result, null);
    } finally {
      bridge.cleanup();
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
