/**
 * Tests for WorkerRunner
 *
 * @module tests/unit/sandbox/worker_runner_test
 */

import { assertEquals, assertExists } from "@std/assert";
import {
  WorkerRunner,
  type WorkerRunnerConfig,
} from "../../../src/sandbox/execution/worker-runner.ts";
import type { MCPClientBase } from "../../../src/mcp/types.ts";

const DEFAULT_CONFIG: WorkerRunnerConfig = {
  timeout: 5000,
};

// Mock MCP client
function createMockMCPClient(responses: Record<string, unknown> = {}): MCPClientBase {
  return {
    serverId: "mock-server",
    serverName: "Mock Server",
    listTools: () => Promise.resolve([]),
    callTool: (name: string, _args: Record<string, unknown>) => {
      if (responses[name]) {
        return Promise.resolve(responses[name]);
      }
      return Promise.resolve({ content: [{ text: `Mocked ${name}` }] });
    },
    connect: () => Promise.resolve(),
    disconnect: () => Promise.resolve(),
    close: () => Promise.resolve(),
  } as MCPClientBase;
}

Deno.test("WorkerRunner - executeSimple runs basic code", async () => {
  const runner = new WorkerRunner(DEFAULT_CONFIG);
  const result = await runner.executeSimple("1 + 1");

  assertEquals(result.success, true);
  assertEquals(result.result, 2);
  assertExists(result.executionTimeMs);

  runner.cleanup();
});

Deno.test("WorkerRunner - executeSimple with context", async () => {
  const runner = new WorkerRunner(DEFAULT_CONFIG);
  const result = await runner.executeSimple("x * y", { x: 5, y: 3 });

  assertEquals(result.success, true);
  assertEquals(result.result, 15);

  runner.cleanup();
});

Deno.test("WorkerRunner - executeSimple handles errors", async () => {
  const runner = new WorkerRunner(DEFAULT_CONFIG);
  const result = await runner.executeSimple("throw new Error('test')");

  assertEquals(result.success, false);
  assertExists(result.error);

  runner.cleanup();
});

Deno.test("WorkerRunner - execute with MCP clients", async () => {
  const mockClient = createMockMCPClient({
    test_tool: { content: [{ text: "42" }] },
  });
  const mcpClients = new Map<string, MCPClientBase>([["test", mockClient]]);

  const runner = new WorkerRunner(DEFAULT_CONFIG);
  const result = await runner.execute(
    `
      const res = await mcp.test.test_tool({});
      return res.content[0].text;
    `,
    mcpClients,
    [{ server: "test", name: "test_tool", description: "Test tool", inputSchema: {} }],
  );

  assertEquals(result.success, true);
  assertEquals(result.result, "42");
  assertExists(result.traces);
  assertExists(result.toolsCalled);

  runner.cleanup();
});

Deno.test("WorkerRunner - getLastTraces returns traces", async () => {
  const mockClient = createMockMCPClient({
    echo: { content: [{ text: "hello" }] },
  });
  const mcpClients = new Map<string, MCPClientBase>([["test", mockClient]]);

  const runner = new WorkerRunner(DEFAULT_CONFIG);
  await runner.execute(
    "await mcp.test.echo({})",
    mcpClients,
    [{ server: "test", name: "echo", description: "Echo", inputSchema: {} }],
  );

  const traces = runner.getLastTraces();
  assertEquals(traces.length >= 2, true, "Should have at least start and end traces");

  runner.cleanup();
});

Deno.test("WorkerRunner - getLastToolsCalled returns called tools", async () => {
  const mockClient = createMockMCPClient({
    tool_a: { content: [{ text: "a" }] },
    tool_b: { content: [{ text: "b" }] },
  });
  const mcpClients = new Map<string, MCPClientBase>([["srv", mockClient]]);

  const runner = new WorkerRunner(DEFAULT_CONFIG);
  await runner.execute(
    `
      await mcp.srv.tool_a({});
      await mcp.srv.tool_b({});
      return "done";
    `,
    mcpClients,
    [
      { server: "srv", name: "tool_a", description: "Tool A", inputSchema: {} },
      { server: "srv", name: "tool_b", description: "Tool B", inputSchema: {} },
    ],
  );

  const toolsCalled = runner.getLastToolsCalled();
  assertEquals(toolsCalled.includes("srv:tool_a"), true);
  assertEquals(toolsCalled.includes("srv:tool_b"), true);

  runner.cleanup();
});

Deno.test("WorkerRunner - handles timeout", async () => {
  const config: WorkerRunnerConfig = {
    timeout: 500, // Short timeout
  };
  const runner = new WorkerRunner(config);

  const result = await runner.executeSimple("while(true) {}");

  assertEquals(result.success, false);
  assertExists(result.error);
  // Can be TimeoutError or RuntimeError depending on Worker termination
  assertEquals(
    ["TimeoutError", "RuntimeError"].includes(result.error?.type ?? ""),
    true,
    `Expected TimeoutError or RuntimeError, got ${result.error?.type}`,
  );

  runner.cleanup();
});

Deno.test("WorkerRunner - cleanup releases resources", async () => {
  const runner = new WorkerRunner(DEFAULT_CONFIG);
  await runner.executeSimple("1");

  // Should not throw
  runner.cleanup();

  // Second cleanup should be safe
  runner.cleanup();
});

Deno.test("WorkerRunner - handles async code", async () => {
  const runner = new WorkerRunner(DEFAULT_CONFIG);
  const result = await runner.executeSimple(`
    const delay = (ms) => new Promise(r => setTimeout(r, ms));
    await delay(10);
    return "async done";
  `);

  assertEquals(result.success, true);
  assertEquals(result.result, "async done");

  runner.cleanup();
});

Deno.test("WorkerRunner - handles complex return types", async () => {
  const runner = new WorkerRunner(DEFAULT_CONFIG);
  const result = await runner.executeSimple(`
    return {
      arr: [1, 2, 3],
      obj: { nested: true },
      str: "hello"
    };
  `);

  assertEquals(result.success, true);
  assertEquals(result.result, {
    arr: [1, 2, 3],
    obj: { nested: true },
    str: "hello",
  });

  runner.cleanup();
});

Deno.test("WorkerRunner - result contains traces when tools are called", async () => {
  const mockClient = createMockMCPClient({
    get_data: { content: [{ text: '{"value": 100}' }] },
  });
  const mcpClients = new Map<string, MCPClientBase>([["api", mockClient]]);

  const runner = new WorkerRunner(DEFAULT_CONFIG);
  const result = await runner.execute(
    `
      const data = await mcp.api.get_data({ id: 1 });
      return JSON.parse(data.content[0].text);
    `,
    mcpClients,
    [{ server: "api", name: "get_data", description: "Get data", inputSchema: { type: "object" } }],
  );

  assertEquals(result.success, true);
  assertEquals(result.result, { value: 100 });
  assertExists(result.traces);
  assertEquals(result.traces!.length >= 2, true);
  assertExists(result.toolsCalled);
  assertEquals(result.toolsCalled!.includes("api:get_data"), true);

  runner.cleanup();
});
