/**
 * Capability Executor Tests (Story 7.3b - AC#12)
 *
 * Tests for CapabilityExecutor orchestrator:
 * - Intent → CapabilityMatcher → CodeGenerator flow
 * - prepareCapabilityContext() method
 * - prepareContextForCapabilities() method
 * - findMatch() delegation
 */

import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { CapabilityExecutor } from "../../../src/capabilities/executor.ts";
import type { CapabilityMatcher } from "../../../src/capabilities/matcher.ts";
import type { Capability, CapabilityMatch } from "../../../src/capabilities/types.ts";

/**
 * Create a mock capability for testing
 */
function createMockCapability(overrides: Partial<Capability> = {}): Capability {
  return {
    id: overrides.id || "test-cap-" + crypto.randomUUID().slice(0, 8),
    name: overrides.name || "Test Capability",
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
// Unit Tests - Instantiation
// =============================================================================

Deno.test({
  name: "CapabilityExecutor - instantiation",
  fn: () => {
    const matcher = createMockMatcher();
    const executor = new CapabilityExecutor(matcher);
    assertExists(executor);
  },
});

// =============================================================================
// Unit Tests - prepareCapabilityContext (AC#12)
// =============================================================================

Deno.test({
  name: "CapabilityExecutor - prepareCapabilityContext returns undefined when no match",
  fn: async () => {
    const matcher = createMockMatcher(null); // No match
    const executor = new CapabilityExecutor(matcher);

    const result = await executor.prepareCapabilityContext("unknown intent");

    assertEquals(result, undefined);
  },
});

Deno.test({
  name: "CapabilityExecutor - prepareCapabilityContext returns context when match found",
  fn: async () => {
    const capability = createMockCapability({
      id: "cap-deploy",
      name: "deployApp",
      codeSnippet: "return await mcp.kubernetes.deploy(args);",
    });

    const match = createMockMatch(capability, 0.92);

    const matcher = createMockMatcher(match);
    const executor = new CapabilityExecutor(matcher);

    const result = await executor.prepareCapabilityContext("deploy my app to production");

    assertExists(result);
    assertExists(result.capabilityContext);
    assertExists(result.match);
    assertExists(result.capabilities);

    // Verify context contains capability code
    assertStringIncludes(result.capabilityContext, "deployApp:");
    assertStringIncludes(result.capabilityContext, "__capabilityDepth");

    // Verify match is returned
    assertEquals(result.match.score, 0.92);
    assertEquals(result.match.capability.id, "cap-deploy");

    // Verify capabilities array
    assertEquals(result.capabilities.length, 1);
    assertEquals(result.capabilities[0].id, "cap-deploy");
  },
});

Deno.test({
  name: "CapabilityExecutor - prepareCapabilityContext includes tracing in generated code",
  fn: async () => {
    const capability = createMockCapability({
      id: "cap-traced",
      name: "tracedOp",
      codeSnippet: "return 'traced';",
    });

    const match = createMockMatch(capability, 0.85);

    const matcher = createMockMatcher(match);
    const executor = new CapabilityExecutor(matcher);

    const result = await executor.prepareCapabilityContext("do traced operation");

    assertExists(result);
    assertStringIncludes(result.capabilityContext, "__trace(");
    assertStringIncludes(result.capabilityContext, "capability_start");
    assertStringIncludes(result.capabilityContext, "capability_end");
  },
});

// =============================================================================
// Unit Tests - prepareContextForCapabilities
// =============================================================================

Deno.test({
  name: "CapabilityExecutor - prepareContextForCapabilities with empty array",
  fn: () => {
    const matcher = createMockMatcher();
    const executor = new CapabilityExecutor(matcher);

    const context = executor.prepareContextForCapabilities([]);

    assertStringIncludes(context, "let __capabilityDepth = 0;");
    assertStringIncludes(context, "const capabilities = {};");
  },
});

Deno.test({
  name: "CapabilityExecutor - prepareContextForCapabilities with single capability",
  fn: () => {
    const matcher = createMockMatcher();
    const executor = new CapabilityExecutor(matcher);

    const capability = createMockCapability({
      name: "singleCap",
      codeSnippet: "return 42;",
    });

    const context = executor.prepareContextForCapabilities([capability]);

    assertStringIncludes(context, "singleCap:");
    assertStringIncludes(context, "return 42;");
  },
});

Deno.test({
  name: "CapabilityExecutor - prepareContextForCapabilities with multiple capabilities",
  fn: () => {
    const matcher = createMockMatcher();
    const executor = new CapabilityExecutor(matcher);

    const cap1 = createMockCapability({
      id: "cap-1",
      name: "capOne",
      codeSnippet: "return 1;",
    });
    const cap2 = createMockCapability({
      id: "cap-2",
      name: "capTwo",
      codeSnippet: "return 2;",
    });

    const context = executor.prepareContextForCapabilities([cap1, cap2]);

    assertStringIncludes(context, "capOne:");
    assertStringIncludes(context, "capTwo:");
  },
});

// =============================================================================
// Unit Tests - findMatch delegation
// =============================================================================

Deno.test({
  name: "CapabilityExecutor - findMatch delegates to matcher",
  fn: async () => {
    const capability = createMockCapability({ name: "delegatedCap" });
    const match = createMockMatch(capability, 0.88);

    const matcher = createMockMatcher(match);
    const executor = new CapabilityExecutor(matcher);

    const result = await executor.findMatch("test intent");

    assertExists(result);
    assertEquals(result.score, 0.88);
    assertEquals(result.semanticScore, 0.88);
  },
});

Deno.test({
  name: "CapabilityExecutor - findMatch returns null when no match",
  fn: async () => {
    const matcher = createMockMatcher(null);
    const executor = new CapabilityExecutor(matcher);

    const result = await executor.findMatch("no match intent");

    assertEquals(result, null);
  },
});

// =============================================================================
// Integration Tests - Full Flow
// =============================================================================

Deno.test({
  name: "CapabilityExecutor - full orchestration flow",
  fn: async () => {
    // Setup: Capability that calls MCP tool
    const capability = createMockCapability({
      id: "cap-full-flow",
      name: "fullFlowCapability",
      codeSnippet: `
        const result = await mcp.filesystem.read_file({ path: args.path });
        return result;
      `,
    });

    const match = createMockMatch(capability, 0.95);

    const matcher = createMockMatcher(match);
    const executor = new CapabilityExecutor(matcher);

    // Execute full flow
    const result = await executor.prepareCapabilityContext("read a file");

    // Verify complete result
    assertExists(result);
    assertEquals(result.capabilities.length, 1);
    assertEquals(result.match.score, 0.95);

    // Verify generated code is complete and valid
    const context = result.capabilityContext;
    assertStringIncludes(context, "let __capabilityDepth = 0;");
    assertStringIncludes(context, "const capabilities = {");
    assertStringIncludes(context, "fullFlowCapability:");
    assertStringIncludes(context, "async (args) =>");
    assertStringIncludes(context, "__trace(");
    assertStringIncludes(context, "mcp.filesystem.read_file");
  },
});

// =============================================================================
// Edge Cases
// =============================================================================

Deno.test({
  name: "CapabilityExecutor - handles capability with special characters in name",
  fn: async () => {
    const capability = createMockCapability({
      name: "deploy-to-prod (v2)",
      codeSnippet: "return 'deployed';",
    });

    const match = createMockMatch(capability, 0.80);

    const matcher = createMockMatcher(match);
    const executor = new CapabilityExecutor(matcher);

    const result = await executor.prepareCapabilityContext("deploy");

    assertExists(result);
    // Name should be normalized to valid JS identifier
    assertStringIncludes(result.capabilityContext, "deploy_to_prod");
  },
});

Deno.test({
  name: "CapabilityExecutor - handles empty intent string",
  fn: async () => {
    const matcher = createMockMatcher(null);
    const executor = new CapabilityExecutor(matcher);

    const result = await executor.prepareCapabilityContext("");

    assertEquals(result, undefined);
  },
});
