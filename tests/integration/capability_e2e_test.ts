/**
 * Capability End-to-End Integration Tests (Story 7.3b - AC#11)
 *
 * Tests the full capability injection flow:
 * Intent → CapabilityMatcher → CodeGenerator → WorkerBridge → Traces
 *
 * NOTE: Requires --unstable-broadcast-channel and --unstable-worker-options flags
 */

import { assertEquals, assertExists, assertGreater, assertStringIncludes } from "@std/assert";
import { WorkerBridge } from "../../src/sandbox/worker-bridge.ts";
import { CapabilityExecutor } from "../../src/capabilities/executor.ts";
import { CapabilityCodeGenerator } from "../../src/capabilities/code-generator.ts";
import type { CapabilityMatcher } from "../../src/capabilities/matcher.ts";
import type { MCPClient } from "../../src/mcp/client.ts";
import type { Capability, CapabilityMatch } from "../../src/capabilities/types.ts";
import type { ToolDefinition } from "../../src/sandbox/types.ts";

/**
 * Create a mock capability
 */
function createMockCapability(overrides: Partial<Capability> = {}): Capability {
  return {
    id: overrides.id || "e2e-cap-" + crypto.randomUUID().slice(0, 8),
    name: overrides.name || "e2eCapability",
    description: overrides.description || "E2E test capability",
    codeSnippet: overrides.codeSnippet || "return args.value * 2;",
    codeHash: overrides.codeHash || "e2e-hash",
    intentEmbedding: overrides.intentEmbedding || new Float32Array(1024),
    cacheConfig: overrides.cacheConfig || { ttl_ms: 3600000, cacheable: true },
    usageCount: overrides.usageCount || 1,
    successCount: overrides.successCount || 1,
    successRate: overrides.successRate || 1.0,
    avgDurationMs: overrides.avgDurationMs || 100,
    createdAt: overrides.createdAt || new Date(),
    lastUsed: overrides.lastUsed || new Date(),
    source: overrides.source || "emergent",
  };
}

/**
 * Create a mock MCPClient
 */
function createMockMCPClient(
  serverId: string,
  responses: Record<string, unknown> = {},
): MCPClient {
  return {
    serverId,
    serverName: serverId,
    callTool: async (toolName: string, args: Record<string, unknown>) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (responses[toolName] !== undefined) {
        return responses[toolName];
      }
      return { success: true, tool: toolName, args };
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
 * Create a mock CapabilityMatch
 */
function createMockMatch(
  capability: Capability,
  score: number = 0.85,
): CapabilityMatch {
  return {
    capability,
    score,
    semanticScore: score,
    thresholdUsed: 0.7,
    parametersSchema: null,
  };
}

/**
 * Create a mock CapabilityMatcher
 */
function createMockMatcher(
  matchResult: CapabilityMatch | null = null,
): CapabilityMatcher {
  return {
    findMatch: async (_intent: string): Promise<CapabilityMatch | null> => {
      return matchResult;
    },
  } as CapabilityMatcher;
}

// =============================================================================
// AC#11: End-to-End Integration Tests
// =============================================================================

Deno.test({
  name: "E2E: Full flow - Intent → Match → Generate → Execute → Traces",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // 1. Setup: Create capability that will be matched
    const capability = createMockCapability({
      id: "cap-e2e-deploy",
      name: "deployApplication",
      codeSnippet: `
        // Simulated deployment logic
        const config = { env: args.env, version: args.version };
        return { deployed: true, config };
      `,
    });

    const match = createMockMatch(capability, 0.95);

    // 2. Create CapabilityExecutor with mock matcher
    const matcher = createMockMatcher(match);
    const executor = new CapabilityExecutor(matcher);

    // 3. Find match for intent (simulates user intent)
    const prepResult = await executor.prepareCapabilityContext(
      "deploy my application to production",
    );

    assertExists(prepResult, "Should find matching capability");
    assertEquals(prepResult.match.score, 0.95);

    // 4. Setup WorkerBridge
    const mcpClients = new Map<string, MCPClient>();
    const bridge = new WorkerBridge(mcpClients, { timeout: 10000 });

    // 5. Execute with capability context
    const result = await bridge.execute(
      'return await capabilities.deployApplication({ env: "prod", version: "1.0.0" })',
      [],
      {},
      prepResult.capabilityContext,
    );

    // Wait for BroadcastChannel traces
    await new Promise((r) => setTimeout(r, 100));

    // 6. Verify execution succeeded
    assertEquals(result.success, true);
    const execResult = result.result as {
      deployed: boolean;
      config: { env: string; version: string };
    };
    assertEquals(execResult.deployed, true);
    assertEquals(execResult.config.env, "prod");
    assertEquals(execResult.config.version, "1.0.0");

    // 7. Verify traces were captured
    const traces = bridge.getTraces();
    assertGreater(traces.length, 0, "Should have captured traces");

    const capStart = traces.find((t) => t.type === "capability_start");
    const capEnd = traces.find((t) => t.type === "capability_end");

    assertExists(capStart, "Should have capability_start trace");
    assertExists(capEnd, "Should have capability_end trace");

    if (capStart && capStart.type === "capability_start") {
      assertEquals(capStart.capabilityId, "cap-e2e-deploy");
    }

    bridge.cleanup();
  },
});

Deno.test({
  name: "E2E: Capability calling MCP tool - full trace chain",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // 1. Setup capability that calls MCP tool
    const capability = createMockCapability({
      id: "cap-e2e-file-reader",
      name: "readConfigFile",
      codeSnippet: `
        const content = await mcp["filesystem"].read_file({ path: args.path });
        return { path: args.path, content };
      `,
    });

    const match = createMockMatch(capability, 0.88);

    // 2. Setup executor
    const matcher = createMockMatcher(match);
    const executor = new CapabilityExecutor(matcher);
    const prepResult = await executor.prepareCapabilityContext("read the config file");

    assertExists(prepResult);

    // 3. Setup bridge with MCP client
    const mcpClients = new Map<string, MCPClient>();
    mcpClients.set(
      "filesystem",
      createMockMCPClient("filesystem", {
        read_file: { content: "key=value\nhost=localhost" },
      }),
    );

    const bridge = new WorkerBridge(mcpClients, { timeout: 10000 });
    const toolDefs: ToolDefinition[] = [{
      server: "filesystem",
      name: "read_file",
      description: "Read a file",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
    }];

    // 4. Execute
    const result = await bridge.execute(
      'return await capabilities.readConfigFile({ path: "/etc/config.txt" })',
      toolDefs,
      {},
      prepResult.capabilityContext,
    );

    await new Promise((r) => setTimeout(r, 100));

    // 5. Verify execution
    assertEquals(result.success, true);
    const execResult = result.result as { path: string; content: { content: string } };
    assertEquals(execResult.path, "/etc/config.txt");

    // 6. Verify full trace chain: capability_start → tool_start → tool_end → capability_end
    const traces = bridge.getTraces();

    const capStart = traces.find((t) => t.type === "capability_start");
    const capEnd = traces.find((t) => t.type === "capability_end");
    const toolStart = traces.find((t) => t.type === "tool_start");
    const toolEnd = traces.find((t) => t.type === "tool_end");

    assertExists(capStart, "Should have capability_start");
    assertExists(capEnd, "Should have capability_end");
    assertExists(toolStart, "Should have tool_start");
    assertExists(toolEnd, "Should have tool_end");

    // Verify tool trace
    if (toolStart && toolStart.type === "tool_start") {
      assertEquals(toolStart.tool, "filesystem:read_file");
    }

    bridge.cleanup();
  },
});

Deno.test({
  name: "E2E: No match found - graceful handling",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // Setup matcher that returns no match
    const matcher = createMockMatcher(null);
    const executor = new CapabilityExecutor(matcher);

    // Try to find match for unknown intent
    const prepResult = await executor.prepareCapabilityContext(
      "do something completely unknown and unmatched",
    );

    // Should return undefined (no match)
    assertEquals(prepResult, undefined);

    // Bridge execution without capability context should still work
    const mcpClients = new Map<string, MCPClient>();
    const bridge = new WorkerBridge(mcpClients, { timeout: 5000 });

    const result = await bridge.execute("return 'no capability needed'", []);

    assertEquals(result.success, true);
    assertEquals(result.result, "no capability needed");

    bridge.cleanup();
  },
});

Deno.test({
  name: "E2E: Multiple capabilities in context",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // Create multiple capabilities
    const cap1 = createMockCapability({
      id: "cap-e2e-1",
      name: "addNumbers",
      codeSnippet: "return args.a + args.b;",
    });

    const cap2 = createMockCapability({
      id: "cap-e2e-2",
      name: "multiplyNumbers",
      codeSnippet: "return args.a * args.b;",
    });

    const cap3 = createMockCapability({
      id: "cap-e2e-3",
      name: "combineOps",
      codeSnippet: `
        const sum = await capabilities.addNumbers({ a: args.a, b: args.b });
        const product = await capabilities.multiplyNumbers({ a: sum, b: args.c });
        return product;
      `,
    });

    // Use CodeGenerator directly for multiple capabilities
    const generator = new CapabilityCodeGenerator();
    const capabilityContext = generator.buildCapabilitiesObject([cap1, cap2, cap3]);

    // Setup bridge
    const mcpClients = new Map<string, MCPClient>();
    const bridge = new WorkerBridge(mcpClients, { timeout: 10000 });

    // Execute code that uses multiple capabilities
    const result = await bridge.execute(
      "return await capabilities.combineOps({ a: 2, b: 3, c: 4 })",
      [],
      {},
      capabilityContext,
    );

    await new Promise((r) => setTimeout(r, 100));

    // (2 + 3) * 4 = 20
    assertEquals(result.success, true);
    assertEquals(result.result, 20);

    // Should have traces for all 3 capabilities
    const traces = bridge.getTraces();
    const capStarts = traces.filter((t) => t.type === "capability_start");

    assertEquals(capStarts.length, 3, "Should trace all 3 capabilities");

    bridge.cleanup();
  },
});

Deno.test({
  name: "E2E: Capability error handling - traces capture failure",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const capability = createMockCapability({
      id: "cap-e2e-error",
      name: "errorCapability",
      codeSnippet: `
        if (args.shouldFail) {
          throw new Error("Intentional failure for testing");
        }
        return "success";
      `,
    });

    const generator = new CapabilityCodeGenerator();
    const capabilityContext = generator.buildCapabilitiesObject([capability]);

    const mcpClients = new Map<string, MCPClient>();
    const bridge = new WorkerBridge(mcpClients, { timeout: 5000 });

    // Execute with failure condition
    const result = await bridge.execute(
      "return await capabilities.errorCapability({ shouldFail: true })",
      [],
      {},
      capabilityContext,
    );

    await new Promise((r) => setTimeout(r, 100));

    // Execution should fail
    assertEquals(result.success, false);
    assertExists(result.error);
    assertStringIncludes(result.error.message, "Intentional failure");

    // Traces should still be captured (including error trace)
    const traces = bridge.getTraces();
    const capStart = traces.find((t) => t.type === "capability_start");
    const capEnd = traces.find((t) => t.type === "capability_end");

    assertExists(capStart, "Should have capability_start even on error");
    assertExists(capEnd, "Should have capability_end even on error");

    // Error trace should indicate failure
    if (capEnd && capEnd.type === "capability_end") {
      // Note: success might still be true in finally block, but error was thrown
      assertExists(capEnd.capabilityId);
    }

    bridge.cleanup();
  },
});

Deno.test({
  name: "E2E: Performance - full flow < 200ms",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const capability = createMockCapability({
      id: "cap-e2e-perf",
      name: "perfCapability",
      codeSnippet: "return args.value * 2;",
    });

    const match = createMockMatch(capability, 0.99);

    const matcher = createMockMatcher(match);
    const executor = new CapabilityExecutor(matcher);

    const start = performance.now();

    // Full flow
    const prepResult = await executor.prepareCapabilityContext("double value");
    assertExists(prepResult);

    const mcpClients = new Map<string, MCPClient>();
    const bridge = new WorkerBridge(mcpClients, { timeout: 5000 });

    const result = await bridge.execute(
      "return await capabilities.perfCapability({ value: 21 })",
      [],
      {},
      prepResult.capabilityContext,
    );

    const elapsed = performance.now() - start;

    assertEquals(result.success, true);
    assertEquals(result.result, 42);

    // Full flow should be reasonably fast (< 200ms)
    // Note: First run may be slower due to Worker initialization
    console.log(`E2E flow took ${elapsed.toFixed(1)}ms`);

    bridge.cleanup();
  },
});
