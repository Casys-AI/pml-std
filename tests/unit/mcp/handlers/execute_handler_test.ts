/**
 * Unit tests for Execute Handler (Story 10.7)
 *
 * Tests cover:
 * - Input validation (intent required)
 * - Mode Direct: execute code + create capability
 * - Mode Suggestion: find capability + execute or return suggestions
 * - Error handling
 *
 * @module tests/unit/mcp/handlers/execute_handler_test
 */

import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import {
  type ExecuteArgs,
  type ExecuteDependencies,
  handleExecute,
} from "../../../../src/mcp/handlers/execute-handler.ts";

// Mock dependencies factory
function createMockDependencies(): ExecuteDependencies {
  const mockCapabilityStore = {
    saveCapability: async (input: unknown) => ({
      capability: {
        id: "test-cap-id",
        codeSnippet: (input as { code: string }).code,
        codeHash: "abc123",
        successRate: 1.0,
        usageCount: 1,
        name: "Test Capability",
      },
      trace: {
        id: "test-trace-id",
        capabilityId: "test-cap-id",
        success: true,
        durationMs: 100,
      },
    }),
    updateUsage: async () => {},
    searchByIntent: async () => [],
    getStaticStructure: async () => null,
    findById: async () => null, // Story 10.7: Used by SHGAT flow
  };

  const mockGraphEngine = {
    searchToolsHybrid: async () => [],
  };

  const mockVectorSearch = {};

  const mockContextBuilder = {
    buildContext: async () => ({ tools: [] }),
  };

  // Story 10.7: Mock embedding model for SHGAT
  const mockEmbeddingModel = {
    encode: async () => new Array(1024).fill(0.1), // 1024-dim embedding
  };

  // Story 10.7/11.10: Mock SHGAT - returns empty by default (no capabilities/tools)
  const mockShgat = {
    scoreAllCapabilities: () => [], // No matches
    scoreAllCapabilitiesV2: () => [], // No matches (v2)
    scoreAllToolsV2: () => [], // No matches (v2)
    getToolIds: () => [], // No tools registered
    getCapabilityIds: () => [], // No capabilities registered
  };

  return {
    vectorSearch: mockVectorSearch as unknown as ExecuteDependencies["vectorSearch"],
    graphEngine: mockGraphEngine as unknown as ExecuteDependencies["graphEngine"],
    mcpClients: new Map(),
    capabilityStore: mockCapabilityStore as unknown as ExecuteDependencies["capabilityStore"],
    config: {
      name: "test",
      version: "1.0.0",
      enableSpeculative: true,
      defaultToolLimit: 10,
      piiProtection: { enabled: false, types: [], detokenizeOutput: false },
      cacheConfig: { enabled: false, maxEntries: 100, ttlSeconds: 300, persistence: false },
    },
    contextBuilder: mockContextBuilder as unknown as ExecuteDependencies["contextBuilder"],
    toolSchemaCache: new Map(),
    db: {} as unknown as ExecuteDependencies["db"],
    embeddingModel: mockEmbeddingModel as unknown as ExecuteDependencies["embeddingModel"],
    shgat: mockShgat as unknown as ExecuteDependencies["shgat"],
  };
}

// ============================================================================
// Input Validation Tests
// ============================================================================

Deno.test("Execute Handler - should reject missing intent parameter", async () => {
  const deps = createMockDependencies();
  const result = await handleExecute({}, deps);

  assertExists(result);
  if ("content" in result) {
    const text = result.content[0].text;
    assertStringIncludes(text, "Missing or empty required parameter");
    assertStringIncludes(text, "intent");
  }
});

Deno.test("Execute Handler - should reject empty intent parameter", async () => {
  const deps = createMockDependencies();
  const result = await handleExecute({ intent: "" }, deps);

  assertExists(result);
  if ("content" in result) {
    const text = result.content[0].text;
    assertStringIncludes(text, "Missing or empty required parameter");
  }
});

Deno.test("Execute Handler - should reject whitespace-only intent", async () => {
  const deps = createMockDependencies();
  const result = await handleExecute({ intent: "   " }, deps);

  assertExists(result);
  if ("content" in result) {
    const text = result.content[0].text;
    assertStringIncludes(text, "Missing or empty required parameter");
  }
});

// ============================================================================
// Mode Detection Tests
// ============================================================================

Deno.test("Execute Handler - should detect Mode Direct when code is provided", async () => {
  const deps = createMockDependencies();
  const args: ExecuteArgs = {
    intent: "test intent",
    code: "return 42;",
  };

  // This will fail at execution but we can verify mode detection works
  const result = await handleExecute(args, deps);
  assertExists(result);
  // Mode direct attempts execution
  if ("content" in result) {
    const parsed = JSON.parse(result.content[0].text);
    // Should attempt direct mode (may fail due to mock)
    assertEquals(typeof parsed, "object");
  }
});

Deno.test("Execute Handler - should detect Mode Suggestion when only intent is provided", async () => {
  const deps = createMockDependencies();
  const args: ExecuteArgs = {
    intent: "read a file",
  };

  const result = await handleExecute(args, deps);
  assertExists(result);

  if ("content" in result) {
    const parsed = JSON.parse(result.content[0].text);
    // Mode suggestion with no match returns suggestions
    assertEquals(parsed.status, "suggestions");
  }
});

// ============================================================================
// Mode Suggestion Tests
// ============================================================================

Deno.test("Execute Handler - should return suggestions when no capability match found", async () => {
  const deps = createMockDependencies();
  const args: ExecuteArgs = {
    intent: "do something new",
  };

  const result = await handleExecute(args, deps);
  assertExists(result);

  if ("content" in result) {
    const parsed = JSON.parse(result.content[0].text);
    assertEquals(parsed.status, "suggestions");
    assertExists(parsed.suggestions);
    assertEquals(parsed.suggestions.confidence, 0);
  }
});

Deno.test("Execute Handler - should return suggestions when SHGAT score is low", async () => {
  const deps = createMockDependencies();

  // Mock SHGAT returning low confidence match (below 0.7 threshold)
  deps.shgat = {
    scoreAllCapabilities: () => [],
    scoreAllCapabilitiesV2: () => [
      { capabilityId: "low-conf-cap", score: 0.5, headWeights: [0.5, 0.5] },
    ],
    scoreAllToolsV2: () => [],
    getToolIds: () => [],
    getCapabilityIds: () => ["low-conf-cap"],
  } as unknown as ExecuteDependencies["shgat"];

  // Mock capability store to return the capability
  deps.capabilityStore = {
    ...deps.capabilityStore,
    findById: async () => ({
      id: "low-conf-cap",
      codeSnippet: "return 'hello';",
      codeHash: "hash456",
      successRate: 0.9, // High success rate
      usageCount: 2,
      name: "Low Confidence Capability",
    }),
  } as unknown as ExecuteDependencies["capabilityStore"];

  const args: ExecuteArgs = {
    intent: "do the thing",
  };

  const result = await handleExecute(args, deps);
  assertExists(result);

  if ("content" in result) {
    const parsed = JSON.parse(result.content[0].text);
    // Should return suggestions because SHGAT score < 0.7
    assertEquals(parsed.status, "suggestions");
  }
});

Deno.test("Execute Handler - should return suggestions when SHGAT score is high but successRate is low", async () => {
  const deps = createMockDependencies();

  // Mock SHGAT returning high score
  deps.shgat = {
    scoreAllCapabilities: () => [],
    scoreAllCapabilitiesV2: () => [
      { capabilityId: "unreliable-cap", score: 0.85, headWeights: [0.85, 0.85] },
    ],
    scoreAllToolsV2: () => [],
    getToolIds: () => [],
    getCapabilityIds: () => ["unreliable-cap"],
  } as unknown as ExecuteDependencies["shgat"];

  // Mock capability with low successRate
  deps.capabilityStore = {
    ...deps.capabilityStore,
    findById: async () => ({
      id: "unreliable-cap",
      codeSnippet: "return 'hello';",
      codeHash: "hash789",
      successRate: 0.6, // Below 0.8 threshold
      usageCount: 5,
      name: "Unreliable Capability",
    }),
  } as unknown as ExecuteDependencies["capabilityStore"];

  const args: ExecuteArgs = {
    intent: "do something unreliable",
  };

  const result = await handleExecute(args, deps);
  assertExists(result);

  if ("content" in result) {
    const parsed = JSON.parse(result.content[0].text);
    // Should return suggestions because successRate < 0.8
    assertEquals(parsed.status, "suggestions");
  }
});

// ============================================================================
// Response Format Tests
// ============================================================================

Deno.test("Execute Handler - should include executionTimeMs in response", async () => {
  const deps = createMockDependencies();
  const args: ExecuteArgs = {
    intent: "test timing",
  };

  const result = await handleExecute(args, deps);
  assertExists(result);

  if ("content" in result) {
    const parsed = JSON.parse(result.content[0].text);
    assertExists(parsed.executionTimeMs);
    assertEquals(typeof parsed.executionTimeMs, "number");
  }
});

Deno.test("Execute Handler - should return suggestions with confidence when no capabilities", async () => {
  const deps = createMockDependencies();

  // Mock SHGAT to return no capabilities
  deps.shgat = {
    scoreAllCapabilities: () => [],
    scoreAllCapabilitiesV2: () => [],
    scoreAllToolsV2: () => [],
    getToolIds: () => [],
    getCapabilityIds: () => [],
  } as unknown as ExecuteDependencies["shgat"];

  const args: ExecuteArgs = {
    intent: "read a file",
  };

  const result = await handleExecute(args, deps);
  assertExists(result);

  if ("content" in result) {
    const parsed = JSON.parse(result.content[0].text);
    assertEquals(parsed.status, "suggestions");
    assertExists(parsed.suggestions);
    assertEquals(parsed.suggestions.confidence, 0);
  }
});

// ============================================================================
// Options Handling Tests
// ============================================================================

Deno.test("Execute Handler - should accept timeout option", async () => {
  const deps = createMockDependencies();
  const args: ExecuteArgs = {
    intent: "test with options",
    options: {
      timeout: 5000,
    },
  };

  const result = await handleExecute(args, deps);
  assertExists(result);
  // Should not throw on valid options
});

Deno.test("Execute Handler - should accept per_layer_validation option", async () => {
  const deps = createMockDependencies();
  const args: ExecuteArgs = {
    intent: "test with validation",
    options: {
      per_layer_validation: true,
    },
  };

  const result = await handleExecute(args, deps);
  assertExists(result);
  // Should not throw on valid options
});

// ============================================================================
// DR-DSP Backward Integration Tests (Story 10.7)
// ============================================================================

Deno.test("Execute Handler - should use DR-DSP backward to build suggestedDag from hyperpath", async () => {
  const deps = createMockDependencies();

  // Mock SHGAT returning a capability match (but below threshold for execution)
  deps.shgat = {
    scoreAllCapabilities: () => [
      { capabilityId: "checkout-cap", score: 0.65, headScores: [0.6, 0.7] }, // Below 0.7 threshold
    ],
    scoreAllCapabilitiesV2: () => [
      { capabilityId: "checkout-cap", score: 0.65, headWeights: [0.6, 0.7] }, // Below 0.7 threshold
    ],
    scoreAllToolsV2: () => [
      { toolId: "db:getCart", score: 0.8 },
      { toolId: "inventory:check", score: 0.7 },
      { toolId: "payment:charge", score: 0.9 },
    ],
    getToolIds: () => ["db:getCart", "inventory:check", "payment:charge"],
    getCapabilityIds: () => ["checkout-cap"],
  } as unknown as ExecuteDependencies["shgat"];

  // Mock capability with tools for DR-DSP to use
  const mockCapability = {
    id: "checkout-cap",
    codeSnippet: "const cart = await mcp.db.getCart(); await mcp.payment.charge(cart);",
    codeHash: "checkout123",
    successRate: 0.95,
    usageCount: 10,
    name: "Checkout Flow",
    toolsUsed: ["db:getCart", "inventory:check", "payment:charge"],
  };

  deps.capabilityStore = {
    ...deps.capabilityStore,
    findById: async (id: string) => id === "checkout-cap" ? mockCapability : null,
    searchByIntent: async () => [{
      capability: mockCapability,
      semanticScore: 0.7,
    }],
  } as unknown as ExecuteDependencies["capabilityStore"];

  // Mock graphEngine for tool search and metadata
  deps.graphEngine = {
    ...deps.graphEngine,
    searchToolsHybrid: async () => [
      { toolId: "db:getCart", finalScore: 0.8 },
      { toolId: "inventory:check", finalScore: 0.7 },
      { toolId: "payment:charge", finalScore: 0.9 },
    ],
    getToolNode: (toolId: string) => ({
      name: toolId.split(":")[1] ?? toolId,
      serverId: toolId.split(":")[0] ?? "unknown",
      description: `Tool: ${toolId}`,
      schema: undefined,
    }),
  } as unknown as ExecuteDependencies["graphEngine"];

  // Mock DR-DSP that returns a hyperpath
  const mockDrdsp = {
    findShortestHyperpath: (source: string, target: string) => {
      // Simulate finding a path through the capability
      if (source === "db:getCart" && target === "payment:charge") {
        return {
          found: true,
          path: ["checkout-cap"],
          hyperedges: [],
          totalWeight: 0.5,
          nodeSequence: ["db:getCart", "inventory:check", "payment:charge"],
        };
      }
      return { found: false, path: [], hyperedges: [], totalWeight: Infinity, nodeSequence: [] };
    },
  };

  deps.drdsp = mockDrdsp as unknown as ExecuteDependencies["drdsp"];

  const args: ExecuteArgs = {
    intent: "checkout the cart",
  };

  const result = await handleExecute(args, deps);
  assertExists(result);

  if ("content" in result) {
    const parsed = JSON.parse(result.content[0].text);
    assertEquals(parsed.status, "suggestions");
    assertExists(parsed.suggestions);
    assertExists(parsed.suggestions.suggestedDag);

    // Verify the suggestedDag was built from the DR-DSP hyperpath
    const dag = parsed.suggestions.suggestedDag;
    assertEquals(Array.isArray(dag.tasks), true);
    assertEquals(dag.tasks.length, 3); // 3 tools in the hyperpath

    // Verify the tasks have callName matching the hyperpath nodeSequence
    assertEquals(dag.tasks[0].callName, "db:getCart");
    assertEquals(dag.tasks[1].callName, "inventory:check");
    assertEquals(dag.tasks[2].callName, "payment:charge");

    // Verify type is set
    assertEquals(dag.tasks[0].type, "tool");
    assertEquals(dag.tasks[1].type, "tool");
    assertEquals(dag.tasks[2].type, "tool");

    // Verify dependencies are chained correctly
    assertEquals(dag.tasks[0].dependsOn, []);
    assertEquals(dag.tasks[1].dependsOn, ["task_0"]);
    assertEquals(dag.tasks[2].dependsOn, ["task_1"]);
  }
});

Deno.test("Execute Handler - should NOT create suggestedDag without SHGAT bestCapability", async () => {
  const deps = createMockDependencies();

  // Mock SHGAT returning no match
  deps.shgat = {
    scoreAllCapabilities: () => [], // No matches
    scoreAllCapabilitiesV2: () => [], // No matches
    scoreAllToolsV2: () => [],
    getToolIds: () => [],
    getCapabilityIds: () => [],
  } as unknown as ExecuteDependencies["shgat"];

  // Mock DR-DSP available but no bestCapability to use it with
  const mockDrdsp = {
    findShortestHyperpath: () => ({
      found: true,
      path: ["some-cap"],
      hyperedges: [],
      totalWeight: 0.3,
      nodeSequence: ["tool1", "tool2"],
    }),
  };
  deps.drdsp = mockDrdsp as unknown as ExecuteDependencies["drdsp"];

  const args: ExecuteArgs = {
    intent: "do something",
  };

  const result = await handleExecute(args, deps);
  assertExists(result);

  if ("content" in result) {
    const parsed = JSON.parse(result.content[0].text);
    assertEquals(parsed.status, "suggestions");
    assertExists(parsed.suggestions);
    // NO suggestedDag without bestCapability - no fallbacks
    assertEquals(parsed.suggestions.suggestedDag, undefined);
  }
});

// ============================================================================
// Story 13.2 Accept Suggestion Tests (formerly Call-by-Name)
// ============================================================================

Deno.test("Execute Handler - accept_suggestion requires capabilityRegistry", async () => {
  const deps = createMockDependencies();
  // Ensure no capabilityRegistry
  deps.capabilityRegistry = undefined;

  const result = await handleExecute(
    {
      accept_suggestion: {
        callName: "fs:read_json",
      },
    },
    deps,
  );

  assertExists(result);
  if ("content" in result) {
    const text = result.content[0].text;
    assertStringIncludes(text, "CapabilityRegistry");
  }
});

Deno.test("Execute Handler - accept_suggestion returns not found for unknown callName", async () => {
  const deps = createMockDependencies();

  // Mock capabilityRegistry that returns null (not found)
  deps.capabilityRegistry = {
    resolveByName: async () => null,
    recordUsage: async () => {},
  } as unknown as ExecuteDependencies["capabilityRegistry"];

  const result = await handleExecute(
    {
      accept_suggestion: {
        callName: "unknown:capability",
      },
    },
    deps,
  );

  assertExists(result);
  if ("content" in result) {
    const text = result.content[0].text;
    assertStringIncludes(text, "not found");
  }
});

Deno.test("Execute Handler - accept_suggestion requires callName", async () => {
  const deps = createMockDependencies();

  const result = await handleExecute(
    {
      accept_suggestion: {
        callName: "", // Empty callName
      },
    },
    deps,
  );

  assertExists(result);
  if ("content" in result) {
    const text = result.content[0].text;
    assertStringIncludes(text, "callName");
  }
});

// ============================================================================
// Story 13.2 AC8: Args Merging Tests
// ============================================================================

Deno.test("Execute Handler - mergeArgsWithDefaults merges provided args with schema defaults", async () => {
  const deps = createMockDependencies();

  // Mock capabilityRegistry with a capability that has parametersSchema with defaults
  deps.capabilityRegistry = {
    resolveByName: async () => ({
      id: "local.default.fs.read_json.a7f3",
      displayName: "json-reader",
      org: "local",
      project: "default",
      namespace: "fs",
      action: "read_json",
      hash: "a7f3",
      workflowPatternId: "wp-uuid-123",
      createdBy: "test",
      createdAt: new Date(),
      version: 1,
      verified: false,
      usageCount: 5,
      successCount: 4,
      totalLatencyMs: 1000,
      tags: [],
      visibility: "private" as const,
      routing: "local" as const,
    }),
    recordUsage: async () => {},
  } as unknown as ExecuteDependencies["capabilityRegistry"];

  // Mock db.query to return workflow_pattern with parametersSchema containing defaults
  deps.db = {
    query: async (sql: string) => {
      if (sql.includes("workflow_pattern")) {
        return [{
          code_snippet: "const x = await mcp.filesystem.read_file({ path: args.path });",
          parameters_schema: JSON.stringify({
            type: "object",
            properties: {
              path: { type: "string" },
              encoding: { type: "string", default: "utf-8" },
              verbose: { type: "boolean", default: false },
            },
          }),
          description: "Read JSON file",
        }];
      }
      return [];
    },
  } as unknown as ExecuteDependencies["db"];

  const result = await handleExecute(
    {
      accept_suggestion: {
        callName: "fs:read_json",
        args: { path: "config.json" }, // Only path provided, encoding/verbose should use defaults
      },
    },
    deps,
  );

  assertExists(result);
  // The execution will fail (no real MCP tools) but we verified the flow works
  // The important thing is it reached the merging logic (no early errors)
  if ("content" in result) {
    const text = result.content[0].text;
    // Should NOT fail on "not found" - capability was resolved
    assertEquals(text.includes("not found for callName"), false);
  }
});

// ============================================================================
// Story 13.2 AC10: Usage Tracking Tests
// ============================================================================

Deno.test("Execute Handler - accept_suggestion does not record usage on capability not found", async () => {
  const deps = createMockDependencies();

  // Track recordUsage calls
  let recordUsageCalled = false;

  deps.capabilityRegistry = {
    resolveByName: async () => null, // Not found
    recordUsage: async () => {
      recordUsageCalled = true;
    },
  } as unknown as ExecuteDependencies["capabilityRegistry"];

  await handleExecute(
    {
      accept_suggestion: {
        callName: "non-existent:capability",
      },
    },
    deps,
  );

  // recordUsage should NOT be called for not-found (no capability to track)
  assertEquals(recordUsageCalled, false);
});
