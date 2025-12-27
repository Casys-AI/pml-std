/**
 * Capability Injection Tests (Story 7.3b - AC#7)
 *
 * Tests for capability injection into Worker sandbox:
 * - Capability calls MCP tool → tool traced in bridge, capability traced in worker
 * - Capability A calls capability B → both traced with correct timestamps
 * - Nested capabilities (A → B → C) → all traced with parent/child relationship
 * - Merged traces have correct chronological order
 *
 * NOTE: Requires --unstable-broadcast-channel and --unstable-worker-options flags
 */

import { assertEquals, assertExists, assertLess, assertStringIncludes } from "@std/assert";
import { WorkerBridge } from "../../../src/sandbox/worker-bridge.ts";
import { CapabilityCodeGenerator } from "../../../src/capabilities/code-generator.ts";
import type { MCPClient } from "../../../src/mcp/client.ts";
import type { Capability } from "../../../src/capabilities/types.ts";
import type { ToolDefinition } from "../../../src/sandbox/types.ts";

/**
 * Create a mock capability for testing
 */
function createMockCapability(overrides: Partial<Capability> = {}): Capability {
  return {
    id: overrides.id || "test-cap-" + crypto.randomUUID().slice(0, 8),
    name: overrides.name || "testCapability",
    description: overrides.description || "A test capability",
    codeSnippet: overrides.codeSnippet || "return args.value * 2;",
    codeHash: overrides.codeHash || "test-hash",
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
 * Create a mock MCPClient for testing
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

// =============================================================================
// AC#7 Tests - Capability Tracing
// =============================================================================

Deno.test({
  name: "AC7: capability calls MCP tool - both traced correctly",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const mcpClients = new Map<string, MCPClient>();
    mcpClients.set(
      "test-server",
      createMockMCPClient("test-server", {
        echo: { echoed: "hello" },
      }),
    );

    const bridge = new WorkerBridge(mcpClients, { timeout: 10000 });
    const toolDefs: ToolDefinition[] = [{
      server: "test-server",
      name: "echo",
      description: "Echo test",
      inputSchema: { type: "object" },
    }];

    // Capability that calls an MCP tool
    const capability = createMockCapability({
      id: "cap-tool-caller",
      name: "toolCaller",
      codeSnippet: `
        const result = await mcp["test-server"].echo({ message: "from capability" });
        return result;
      `,
    });

    const capabilityContext = bridge.buildCapabilityContext([capability]);

    const result = await bridge.execute(
      "return await capabilities.toolCaller({})",
      toolDefs,
      {},
      capabilityContext,
    );

    // Wait for BroadcastChannel
    await new Promise((r) => setTimeout(r, 100));

    assertEquals(result.success, true);

    const traces = bridge.getTraces();

    // Should have both capability and tool traces
    const capStart = traces.find((t) => t.type === "capability_start");
    const capEnd = traces.find((t) => t.type === "capability_end");
    const toolStart = traces.find((t) => t.type === "tool_start");
    const toolEnd = traces.find((t) => t.type === "tool_end");

    assertExists(capStart, "Should have capability_start");
    assertExists(capEnd, "Should have capability_end");
    assertExists(toolStart, "Should have tool_start");
    assertExists(toolEnd, "Should have tool_end");

    // Verify capability trace content
    if (capStart && capStart.type === "capability_start") {
      assertEquals(capStart.capabilityId, "cap-tool-caller");
    }

    // Verify tool trace content
    if (toolStart && toolStart.type === "tool_start") {
      assertEquals(toolStart.tool, "test-server:echo");
    }

    bridge.cleanup();
  },
});

Deno.test({
  name: "AC7: capability A calls capability B - both traced with timestamps",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const mcpClients = new Map<string, MCPClient>();
    const bridge = new WorkerBridge(mcpClients, { timeout: 10000 });

    // Capability B (inner)
    const capB = createMockCapability({
      id: "cap-b",
      name: "capB",
      codeSnippet: "return args.value + 10;",
    });

    // Capability A (outer) - calls capability B
    const capA = createMockCapability({
      id: "cap-a",
      name: "capA",
      codeSnippet: `
        const innerResult = await capabilities.capB({ value: args.value });
        return innerResult + 5;
      `,
    });

    const capabilityContext = bridge.buildCapabilityContext([capA, capB]);

    const result = await bridge.execute(
      "return await capabilities.capA({ value: 100 })",
      [],
      {},
      capabilityContext,
    );

    // Wait for BroadcastChannel
    await new Promise((r) => setTimeout(r, 100));

    assertEquals(result.success, true);
    assertEquals(result.result, 115); // 100 + 10 + 5

    const traces = bridge.getTraces();

    // Should have 4 capability traces (2 starts + 2 ends)
    const capStarts = traces.filter((t) => t.type === "capability_start");
    const capEnds = traces.filter((t) => t.type === "capability_end");

    assertEquals(capStarts.length, 2, "Should have 2 capability_start events");
    assertEquals(capEnds.length, 2, "Should have 2 capability_end events");

    // Verify chronological order: A starts, B starts, B ends, A ends
    const sortedTraces = [...traces].sort((a, b) => a.ts - b.ts);

    // Find capability traces in order
    const capTraces = sortedTraces.filter(
      (t) => t.type === "capability_start" || t.type === "capability_end",
    );

    // First should be capA start, last should be capA end
    if (capTraces.length >= 4) {
      const first = capTraces[0];
      const last = capTraces[capTraces.length - 1];

      if (first.type === "capability_start") {
        assertStringIncludes(first.capability, "capA");
      }
      if (last.type === "capability_end") {
        assertStringIncludes(last.capability, "capA");
      }
    }

    bridge.cleanup();
  },
});

Deno.test({
  name: "AC7: nested capabilities (A → B → C) - all 3 traced",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const mcpClients = new Map<string, MCPClient>();
    const bridge = new WorkerBridge(mcpClients, { timeout: 10000 });

    // Capability C (innermost)
    const capC = createMockCapability({
      id: "cap-c",
      name: "capC",
      codeSnippet: "return args.value * 2;",
    });

    // Capability B (middle) - calls C
    const capB = createMockCapability({
      id: "cap-b",
      name: "capB",
      codeSnippet: `
        const cResult = await capabilities.capC({ value: args.value });
        return cResult + 1;
      `,
    });

    // Capability A (outer) - calls B
    const capA = createMockCapability({
      id: "cap-a",
      name: "capA",
      codeSnippet: `
        const bResult = await capabilities.capB({ value: args.value });
        return bResult + 1;
      `,
    });

    const capabilityContext = bridge.buildCapabilityContext([capA, capB, capC]);

    const result = await bridge.execute(
      "return await capabilities.capA({ value: 5 })",
      [],
      {},
      capabilityContext,
    );

    // Wait for BroadcastChannel
    await new Promise((r) => setTimeout(r, 100));

    assertEquals(result.success, true);
    assertEquals(result.result, 12); // (5 * 2) + 1 + 1 = 12

    const traces = bridge.getTraces();

    // Should have 6 capability traces (3 starts + 3 ends)
    const capStarts = traces.filter((t) => t.type === "capability_start");
    const capEnds = traces.filter((t) => t.type === "capability_end");

    assertEquals(capStarts.length, 3, "Should have 3 capability_start events");
    assertEquals(capEnds.length, 3, "Should have 3 capability_end events");

    // Verify all three capabilities are traced
    const capIds: string[] = [];
    for (const t of capStarts) {
      if (t.type === "capability_start") {
        capIds.push(t.capabilityId);
      }
    }

    assertEquals(capIds.includes("cap-a"), true, "capA should be traced");
    assertEquals(capIds.includes("cap-b"), true, "capB should be traced");
    assertEquals(capIds.includes("cap-c"), true, "capC should be traced");

    bridge.cleanup();
  },
});

Deno.test({
  name: "AC7: merged traces have correct chronological order",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const mcpClients = new Map<string, MCPClient>();
    mcpClients.set(
      "test-server",
      createMockMCPClient("test-server", { tool1: "result1" }),
    );

    const bridge = new WorkerBridge(mcpClients, { timeout: 10000 });
    const toolDefs: ToolDefinition[] = [{
      server: "test-server",
      name: "tool1",
      description: "Tool 1",
      inputSchema: { type: "object" },
    }];

    const capability = createMockCapability({
      id: "cap-chronological",
      name: "chronoCap",
      codeSnippet: `
        const r = await mcp["test-server"].tool1({});
        return r;
      `,
    });

    const capabilityContext = bridge.buildCapabilityContext([capability]);

    await bridge.execute(
      "return await capabilities.chronoCap({})",
      toolDefs,
      {},
      capabilityContext,
    );

    // Wait for BroadcastChannel
    await new Promise((r) => setTimeout(r, 100));

    const traces = bridge.getTraces();

    // Verify traces are sorted by timestamp
    for (let i = 1; i < traces.length; i++) {
      assertLess(
        traces[i - 1].ts,
        traces[i].ts + 1, // Allow same ms
        `Trace ${i - 1} should have timestamp <= trace ${i}`,
      );
    }

    bridge.cleanup();
  },
});

// =============================================================================
// Depth Limit Tests (AC#10)
// =============================================================================

Deno.test({
  name: "AC10: depth limit prevents infinite recursion at depth 3",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const mcpClients = new Map<string, MCPClient>();
    const bridge = new WorkerBridge(mcpClients, { timeout: 5000 });

    // Create a self-referencing capability (will hit depth limit)
    // Note: We simulate by checking the depth manually since true recursion
    // would require the capability to call itself
    const generator = new CapabilityCodeGenerator();

    // Create 4 nested capabilities to test depth limit
    const cap4 = createMockCapability({
      id: "cap-4",
      name: "cap4",
      codeSnippet: "return 'reached cap4';",
    });

    const cap3 = createMockCapability({
      id: "cap-3",
      name: "cap3",
      codeSnippet: "return await capabilities.cap4({});",
    });

    const cap2 = createMockCapability({
      id: "cap-2",
      name: "cap2",
      codeSnippet: "return await capabilities.cap3({});",
    });

    const cap1 = createMockCapability({
      id: "cap-1",
      name: "cap1",
      codeSnippet: "return await capabilities.cap2({});",
    });

    // Build context with all 4 capabilities
    const capabilityContext = generator.buildCapabilitiesObject([cap1, cap2, cap3, cap4]);

    // Execute cap1 → cap2 → cap3 → cap4 (depth = 4, should fail at cap4)
    const result = await bridge.execute(
      "return await capabilities.cap1({})",
      [],
      {},
      capabilityContext,
    );

    // Should fail because depth exceeds 3
    assertEquals(result.success, false);
    assertExists(result.error);
    assertStringIncludes(result.error.message, "depth exceeded");

    bridge.cleanup();
  },
});

Deno.test({
  name: "AC10: depth 3 is allowed (A → B → C works)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const mcpClients = new Map<string, MCPClient>();
    const bridge = new WorkerBridge(mcpClients, { timeout: 5000 });

    const generator = new CapabilityCodeGenerator();

    // 3 levels of nesting (should work)
    const capC = createMockCapability({
      id: "cap-c-ok",
      name: "capCOk",
      codeSnippet: "return 'C';",
    });

    const capB = createMockCapability({
      id: "cap-b-ok",
      name: "capBOk",
      codeSnippet: "return await capabilities.capCOk({}) + 'B';",
    });

    const capA = createMockCapability({
      id: "cap-a-ok",
      name: "capAOk",
      codeSnippet: "return await capabilities.capBOk({}) + 'A';",
    });

    const capabilityContext = generator.buildCapabilitiesObject([capA, capB, capC]);

    const result = await bridge.execute(
      "return await capabilities.capAOk({})",
      [],
      {},
      capabilityContext,
    );

    // Should succeed (depth 3 is within limit)
    assertEquals(result.success, true);
    assertEquals(result.result, "CBA");

    bridge.cleanup();
  },
});

// =============================================================================
// Code Sanitization Tests
// =============================================================================

Deno.test({
  name: "Capability injection - blocks eval in capability code",
  fn: () => {
    const generator = new CapabilityCodeGenerator();

    const maliciousCap = createMockCapability({
      codeSnippet: "return eval('1+1');",
    });

    let threw = false;
    try {
      generator.generateInlineCode(maliciousCap);
    } catch (e) {
      threw = true;
      assertStringIncludes((e as Error).message, "eval");
    }

    assertEquals(threw, true, "Should throw on eval");
  },
});

Deno.test({
  name: "Capability injection - blocks Deno namespace access",
  fn: () => {
    const generator = new CapabilityCodeGenerator();

    const maliciousCap = createMockCapability({
      codeSnippet: "return Deno.readFileSync('/etc/passwd');",
    });

    let threw = false;
    try {
      generator.generateInlineCode(maliciousCap);
    } catch (e) {
      threw = true;
      assertStringIncludes((e as Error).message, "Deno");
    }

    assertEquals(threw, true, "Should throw on Deno access");
  },
});

// =============================================================================
// Performance Tests (AC#9)
// =============================================================================

Deno.test({
  name: "AC9: code generation < 10ms for 10 capabilities",
  fn: () => {
    const generator = new CapabilityCodeGenerator();

    // Create 10 capabilities
    const capabilities: Capability[] = [];
    for (let i = 0; i < 10; i++) {
      capabilities.push(
        createMockCapability({
          id: `cap-perf-${i}`,
          name: `perfCap${i}`,
          codeSnippet: `return args.value + ${i};`,
        }),
      );
    }

    const start = performance.now();
    generator.buildCapabilitiesObject(capabilities);
    const elapsed = performance.now() - start;

    assertLess(elapsed, 10, `Code generation took ${elapsed}ms, should be < 10ms`);
  },
});

Deno.test({
  name: "AC9: trace merging is efficient (getTraces returns sorted)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const mcpClients = new Map<string, MCPClient>();
    const bridge = new WorkerBridge(mcpClients, { timeout: 5000 });

    const capability = createMockCapability({
      name: "quickCap",
      codeSnippet: "return 'quick';",
    });

    const capabilityContext = bridge.buildCapabilityContext([capability]);

    await bridge.execute(
      "return await capabilities.quickCap({})",
      [],
      {},
      capabilityContext,
    );

    await new Promise((r) => setTimeout(r, 50));

    // Measure getTraces() performance
    const start = performance.now();
    bridge.getTraces();
    const elapsed = performance.now() - start;

    // Should be very fast (< 5ms even for sorting)
    assertLess(elapsed, 5, `getTraces took ${elapsed}ms, should be < 5ms`);

    bridge.cleanup();
  },
});
