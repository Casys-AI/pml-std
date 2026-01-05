/**
 * Unit tests for Story 10.6: pml_discover unified discovery API
 *
 * Tests cover:
 * - AC1: pml:discover tool exposed
 * - AC2: Calls Hybrid Search for tools (ADR-038)
 * - AC3: Calls Capability Match for capabilities (ADR-038)
 * - AC4: Unified response format with merged results
 * - AC5: Filter by type (tool/capability/all)
 * - AC6: Filter by minScore
 * - AC7: include_related support for tools
 */

import { assert, assertAlmostEquals, assertEquals, assertExists } from "@std/assert";
import {
  handleDiscover,
  type DiscoverHandlerDeps,
} from "../../../../src/mcp/handlers/discover-handler.ts";
import { GLOBAL_SCORE_CAP, calculateReliabilityFactor, DEFAULT_RELIABILITY_CONFIG } from "../../../../src/graphrag/algorithms/unified-search.ts";
import type { GraphRAGEngine } from "../../../../src/graphrag/graph-engine.ts";
import type { VectorSearch } from "../../../../src/vector/search.ts";
import type { DAGSuggester } from "../../../../src/graphrag/dag-suggester.ts";
import type { HybridSearchResult } from "../../../../src/graphrag/types.ts";
import type { Capability, CapabilityMatch } from "../../../../src/capabilities/types.ts";
import type { MCPToolResponse } from "../../../../src/mcp/server/types.ts";
import type { IToolStore, ToolMetadata } from "../../../../src/tools/types.ts";

// Compute discover score helper (unified formula)
function computeDiscoverScore(semanticScore: number, successRate: number = 1.0): number {
  const reliabilityFactor = calculateReliabilityFactor(successRate, DEFAULT_RELIABILITY_CONFIG);
  return Math.min(semanticScore * reliabilityFactor, GLOBAL_SCORE_CAP);
}

// Mock GraphRAGEngine
class MockGraphEngine {
  private results: HybridSearchResult[] = [];

  setHybridResults(results: HybridSearchResult[]) {
    this.results = results;
  }

  async searchToolsHybrid(
    _vectorSearch: unknown,
    _query: string,
    _limit: number,
    _contextTools: string[],
    _includeRelated: boolean,
  ): Promise<HybridSearchResult[]> {
    return this.results;
  }
}

// Mock VectorSearch (minimal)
class MockVectorSearch {
  async searchTools(): Promise<unknown[]> {
    return [];
  }
}

// Mock ToolStore
class MockToolStore implements IToolStore {
  private tools = new Map<string, ToolMetadata>();

  setTools(tools: ToolMetadata[]) {
    this.tools.clear();
    for (const tool of tools) {
      this.tools.set(tool.toolId, tool);
    }
  }

  async findById(toolId: string): Promise<ToolMetadata | undefined> {
    return this.tools.get(toolId);
  }

  async findByIds(toolIds: string[]): Promise<Map<string, ToolMetadata>> {
    const result = new Map<string, ToolMetadata>();
    for (const id of toolIds) {
      const tool = this.tools.get(id);
      if (tool) result.set(id, tool);
    }
    return result;
  }
}

// Mock DAGSuggester
class MockDAGSuggester {
  private match: CapabilityMatch | null = null;

  setCapabilityMatch(match: CapabilityMatch | null) {
    this.match = match;
  }

  async searchCapabilities(_intent: string): Promise<CapabilityMatch | null> {
    return this.match;
  }

  getCapabilityStore() {
    return undefined;
  }
}

// Helper to create a capability
function createCapability(id: string, successRate: number): Capability {
  return {
    id,
    codeSnippet: "console.log('test')",
    codeHash: "hash",
    intentEmbedding: new Float32Array([]),
    parametersSchema: {},
    cacheConfig: { ttl_ms: 1000, cacheable: true },
    usageCount: 10,
    successCount: Math.floor(10 * successRate),
    successRate,
    avgDurationMs: 100,
    createdAt: new Date(),
    lastUsed: new Date(),
    source: "emergent",
    name: `Capability ${id}`,
    description: `Description for ${id}`,
  };
}

// Helper to create a tool result
function createToolResult(toolId: string, score: number): HybridSearchResult {
  const [serverId, toolName] = toolId.split(":");
  return {
    toolId,
    serverId,
    toolName,
    description: `Description for ${toolId}`,
    semanticScore: score,
    graphScore: score * 0.8,
    finalScore: score,
    schema: { inputSchema: {} },
  };
}

// Helper to parse response
function parseResponse(result: MCPToolResponse): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

// Helper to create deps
function createDeps(overrides: Partial<DiscoverHandlerDeps> = {}): DiscoverHandlerDeps {
  return {
    vectorSearch: new MockVectorSearch() as unknown as VectorSearch,
    graphEngine: new MockGraphEngine() as unknown as GraphRAGEngine,
    dagSuggester: new MockDAGSuggester() as unknown as DAGSuggester,
    toolStore: new MockToolStore(),
    ...overrides,
  };
}

Deno.test("handleDiscover - returns error when intent is missing", async () => {
  const deps = createDeps();

  const result = await handleDiscover({}, deps) as MCPToolResponse;

  assertExists(result.content);
  assertEquals(result.content.length, 1);
  const response = parseResponse(result);
  assertExists(response.error);
  assertEquals(response.error, "Missing or empty required parameter: 'intent'");
});

Deno.test("handleDiscover - returns error when intent is empty string", async () => {
  const deps = createDeps();

  // Test empty string
  const result1 = await handleDiscover({ intent: "" }, deps) as MCPToolResponse;

  assertExists(result1.content);
  const response1 = parseResponse(result1);
  assertExists(response1.error);
  assertEquals(response1.error, "Missing or empty required parameter: 'intent'");

  // Test whitespace-only string
  const result2 = await handleDiscover({ intent: "   " }, deps) as MCPToolResponse;

  assertExists(result2.content);
  const response2 = parseResponse(result2);
  assertExists(response2.error);
  assertEquals(response2.error, "Missing or empty required parameter: 'intent'");
});

Deno.test("handleDiscover - returns tools from hybrid search", async () => {
  const graphEngine = new MockGraphEngine();
  const toolStore = new MockToolStore();

  // Setup mock tool results - use lower scores to avoid GLOBAL_SCORE_CAP capping
  graphEngine.setHybridResults([
    createToolResult("filesystem:read_file", 0.7),
    createToolResult("filesystem:write_file", 0.5),
  ]);

  const deps = createDeps({
    graphEngine: graphEngine as unknown as GraphRAGEngine,
    toolStore,
  });

  const result = await handleDiscover(
    { intent: "read a file", limit: 2 },
    deps,
  ) as MCPToolResponse;

  assertExists(result.content);
  const response = parseResponse(result) as {
    results: Array<{ type: string; id: string; score: number }>;
    meta: { tools_count: number };
  };

  assertExists(response.results);
  assertEquals(response.results.length, 2);
  assertEquals(response.results[0].type, "tool");
  assertEquals(response.results[0].id, "filesystem:read_file");
  // Softmax is applied to scores - check ranking preserved and scores sum to ~1
  assert(response.results[0].score > response.results[1].score, "First result should have higher score");
  const scoreSum = response.results.reduce((sum, r) => sum + r.score, 0);
  assertAlmostEquals(scoreSum, 1.0, 0.01); // Softmax scores sum to 1
  assertEquals(response.meta.tools_count, 2);
});

Deno.test("handleDiscover - returns capabilities from matcher", async () => {
  const dagSuggester = new MockDAGSuggester();

  // Setup mock capability result
  const capability = createCapability("cap-123", 0.95);
  dagSuggester.setCapabilityMatch({
    capability,
    score: 0.85,
    semanticScore: 0.9,
    thresholdUsed: 0.7,
    parametersSchema: null,
  });

  const deps = createDeps({
    dagSuggester: dagSuggester as unknown as DAGSuggester,
  });

  const result = await handleDiscover(
    { intent: "create an issue", filter: { type: "capability" } },
    deps,
  ) as MCPToolResponse;

  assertExists(result.content);
  const response = parseResponse(result) as {
    results: Array<{ type: string; id: string; score: number }>;
    meta: { capabilities_count: number };
  };

  assertExists(response.results);
  assertEquals(response.results.length, 1);
  assertEquals(response.results[0].type, "capability");
  assertEquals(response.results[0].id, "cap-123");
  assertEquals(response.results[0].score, 0.85);
  assertEquals(response.meta.capabilities_count, 1);
});

Deno.test("handleDiscover - merges and sorts tools and capabilities by score", async () => {
  const graphEngine = new MockGraphEngine();
  const dagSuggester = new MockDAGSuggester();

  // Setup tools with various semantic scores
  graphEngine.setHybridResults([
    createToolResult("filesystem:read_file", 0.85),
    createToolResult("github:create_issue", 0.75),
  ]);

  // Setup capability with score 0.80
  const capability = createCapability("cap-create-issue", 0.92);
  dagSuggester.setCapabilityMatch({
    capability,
    score: 0.80,
    semanticScore: 0.85,
    thresholdUsed: 0.7,
    parametersSchema: null,
  });

  const deps = createDeps({
    graphEngine: graphEngine as unknown as GraphRAGEngine,
    dagSuggester: dagSuggester as unknown as DAGSuggester,
  });

  const result = await handleDiscover(
    { intent: "create an issue", limit: 3 },
    deps,
  ) as MCPToolResponse;

  const response = parseResponse(result) as {
    results: Array<{ type: string; id: string; score: number }>;
    meta: { tools_count: number; capabilities_count: number };
  };

  // Sorted by score descending - softmax applied so scores are relative probabilities
  assertEquals(response.results.length, 3);
  assertEquals(response.results[0].id, "filesystem:read_file");
  assertEquals(response.results[1].id, "github:create_issue");
  assertEquals(response.results[2].type, "capability");

  // Verify ranking is preserved (descending order)
  assert(response.results[0].score > response.results[1].score, "First > Second");
  assert(response.results[1].score > response.results[2].score, "Second > Third");

  // Softmax scores sum to ~1
  const scoreSum = response.results.reduce((sum, r) => sum + r.score, 0);
  assertAlmostEquals(scoreSum, 1.0, 0.01);

  assertEquals(response.meta.tools_count, 2);
  assertEquals(response.meta.capabilities_count, 1);
});

Deno.test("handleDiscover - filters by type 'tool' only", async () => {
  const graphEngine = new MockGraphEngine();
  const dagSuggester = new MockDAGSuggester();

  graphEngine.setHybridResults([
    createToolResult("filesystem:read_file", 0.9),
  ]);

  const capability = createCapability("cap-1", 0.95);
  dagSuggester.setCapabilityMatch({
    capability,
    score: 0.85,
    semanticScore: 0.9,
    thresholdUsed: 0.7,
    parametersSchema: null,
  });

  const deps = createDeps({
    graphEngine: graphEngine as unknown as GraphRAGEngine,
    dagSuggester: dagSuggester as unknown as DAGSuggester,
  });

  const result = await handleDiscover(
    { intent: "read file", filter: { type: "tool" } },
    deps,
  ) as MCPToolResponse;

  const response = parseResponse(result) as {
    results: Array<{ type: string }>;
    meta: { tools_count: number; capabilities_count: number };
  };

  assertEquals(response.results.length, 1);
  assertEquals(response.results[0].type, "tool");
  assertEquals(response.meta.tools_count, 1);
  assertEquals(response.meta.capabilities_count, 0);
});

Deno.test("handleDiscover - filters by minScore", async () => {
  const graphEngine = new MockGraphEngine();

  graphEngine.setHybridResults([
    createToolResult("filesystem:read_file", 0.9),
    createToolResult("filesystem:list", 0.5),
  ]);

  const deps = createDeps({
    graphEngine: graphEngine as unknown as GraphRAGEngine,
  });

  const result = await handleDiscover(
    { intent: "read file", filter: { minScore: 0.7 } },
    deps,
  ) as MCPToolResponse;

  const response = parseResponse(result) as {
    results: Array<{ score: number }>;
  };

  // Only the first tool passes minScore=0.7 (capped score > 0.7, 0.60 < 0.7)
  assertEquals(response.results.length, 1);
  assertEquals(response.results[0].score, computeDiscoverScore(0.9, 1.0));
});

Deno.test("handleDiscover - respects limit parameter", async () => {
  const graphEngine = new MockGraphEngine();

  graphEngine.setHybridResults([
    createToolResult("filesystem:read_file", 0.9),
    createToolResult("filesystem:write_file", 0.85),
    createToolResult("filesystem:list", 0.8),
    createToolResult("filesystem:delete", 0.75),
  ]);

  const deps = createDeps({
    graphEngine: graphEngine as unknown as GraphRAGEngine,
  });

  const result = await handleDiscover(
    { intent: "file operations", limit: 2 },
    deps,
  ) as MCPToolResponse;

  const response = parseResponse(result) as {
    results: Array<{ id: string }>;
  };

  assertEquals(response.results.length, 2);
  assertEquals(response.results[0].id, "filesystem:read_file");
  assertEquals(response.results[1].id, "filesystem:write_file");
});

Deno.test("handleDiscover - includes related tools when requested", async () => {
  const graphEngine = new MockGraphEngine();

  // Tool with related tools
  const toolWithRelated: HybridSearchResult = {
    ...createToolResult("filesystem:read_file", 0.9),
    relatedTools: [
      { toolId: "filesystem:write_file", relation: "often_after", score: 0.8 },
    ],
  };

  graphEngine.setHybridResults([toolWithRelated]);

  const deps = createDeps({
    graphEngine: graphEngine as unknown as GraphRAGEngine,
  });

  const result = await handleDiscover(
    { intent: "read file", include_related: true },
    deps,
  ) as MCPToolResponse;

  const response = parseResponse(result) as {
    results: Array<{ related_tools?: Array<{ tool_id: string }> }>;
  };

  assertEquals(response.results.length, 1);
  assertExists(response.results[0].related_tools);
  assertEquals(response.results[0].related_tools!.length, 1);
  assertEquals(response.results[0].related_tools![0].tool_id, "filesystem:write_file");
});

Deno.test("handleDiscover - handles empty results gracefully", async () => {
  const graphEngine = new MockGraphEngine();
  const dagSuggester = new MockDAGSuggester();

  // No results from either source
  graphEngine.setHybridResults([]);
  dagSuggester.setCapabilityMatch(null);

  const deps = createDeps({
    graphEngine: graphEngine as unknown as GraphRAGEngine,
    dagSuggester: dagSuggester as unknown as DAGSuggester,
  });

  const result = await handleDiscover(
    { intent: "nonexistent operation" },
    deps,
  ) as MCPToolResponse;

  const response = parseResponse(result) as {
    results: Array<unknown>;
    meta: { total_found: number };
  };

  assertExists(response.results);
  assertEquals(response.results.length, 0);
  assertEquals(response.meta.total_found, 0);
});

Deno.test("handleDiscover - response includes correct metadata", async () => {
  const graphEngine = new MockGraphEngine();

  graphEngine.setHybridResults([
    createToolResult("filesystem:read_file", 0.9),
  ]);

  const deps = createDeps({
    graphEngine: graphEngine as unknown as GraphRAGEngine,
  });

  const result = await handleDiscover(
    { intent: "read a file", filter: { type: "all" } },
    deps,
  ) as MCPToolResponse;

  const response = parseResponse(result) as {
    meta: {
      query: string;
      filter_type: string;
      total_found: number;
      tools_count: number;
      capabilities_count: number;
    };
  };

  assertExists(response.meta);
  assertEquals(response.meta.query, "read a file");
  assertEquals(response.meta.filter_type, "all");
  assertExists(response.meta.total_found);
  assertExists(response.meta.tools_count);
  assertExists(response.meta.capabilities_count);
});

// =============================================================================
// AC12-13: Unified Scoring Formula Tests
// =============================================================================

Deno.test("handleDiscover - AC12: tools use unified scoring formula", async () => {
  const graphEngine = new MockGraphEngine();

  graphEngine.setHybridResults([
    createToolResult("filesystem:read_file", 0.9),
  ]);

  const deps = createDeps({
    graphEngine: graphEngine as unknown as GraphRAGEngine,
  });

  const result = await handleDiscover(
    { intent: "read a file" },
    deps,
  ) as MCPToolResponse;

  const response = parseResponse(result) as {
    results: Array<{ type: string; score: number }>;
  };

  assertEquals(response.results.length, 1);
  assertEquals(response.results[0].type, "tool");
  assertEquals(response.results[0].score, computeDiscoverScore(0.9, 1.0));
});

Deno.test("handleDiscover - AC12: scores are normalized between 0 and 1", async () => {
  const graphEngine = new MockGraphEngine();

  graphEngine.setHybridResults([
    createToolResult("filesystem:read_file", 1.0),
  ]);

  const deps = createDeps({
    graphEngine: graphEngine as unknown as GraphRAGEngine,
  });

  const result = await handleDiscover(
    { intent: "read file" },
    deps,
  ) as MCPToolResponse;

  const response = parseResponse(result) as {
    results: Array<{ score: number }>;
  };

  assertEquals(response.results.length, 1);
  assertEquals(response.results[0].score, computeDiscoverScore(1.0, 1.0));
});

Deno.test("handleDiscover - AC13: capabilities use same formula with successRate", async () => {
  const dagSuggester = new MockDAGSuggester();

  const capability = createCapability("cap-high-success", 0.95);
  dagSuggester.setCapabilityMatch({
    capability,
    score: 0.95,
    semanticScore: 0.85,
    thresholdUsed: 0.7,
    parametersSchema: null,
  });

  const deps = createDeps({
    dagSuggester: dagSuggester as unknown as DAGSuggester,
  });

  const result = await handleDiscover(
    { intent: "create issue", filter: { type: "capability" } },
    deps,
  ) as MCPToolResponse;

  const response = parseResponse(result) as {
    results: Array<{ type: string; score: number; success_rate: number }>;
  };

  assertEquals(response.results.length, 1);
  assertEquals(response.results[0].type, "capability");
  assertEquals(response.results[0].success_rate, 0.95);
  assertEquals(response.results[0].score, 0.95);
});

Deno.test("handleDiscover - AC13: low successRate capability gets penalty", async () => {
  const dagSuggester = new MockDAGSuggester();

  const capability = createCapability("cap-low-success", 0.4);
  dagSuggester.setCapabilityMatch({
    capability,
    score: 0.08,
    semanticScore: 0.8,
    thresholdUsed: 0.7,
    parametersSchema: null,
  });

  const deps = createDeps({
    dagSuggester: dagSuggester as unknown as DAGSuggester,
  });

  const result = await handleDiscover(
    { intent: "risky operation", filter: { type: "capability" } },
    deps,
  ) as MCPToolResponse;

  const response = parseResponse(result) as {
    results: Array<{ type: string; score: number; success_rate: number }>;
  };

  assertEquals(response.results.length, 1);
  assertEquals(response.results[0].success_rate, 0.4);
  assertEquals(response.results[0].score, 0.08);
});

// =============================================================================
// Story 13.8: pml_registry VIEW compatibility
// =============================================================================

Deno.test("handleDiscover - Story 13.8: record_type 'mcp-tool' for tools", async () => {
  const graphEngine = new MockGraphEngine();

  graphEngine.setHybridResults([
    createToolResult("filesystem:read_file", 0.9),
  ]);

  const deps = createDeps({
    graphEngine: graphEngine as unknown as GraphRAGEngine,
  });

  const result = await handleDiscover(
    { intent: "read a file" },
    deps,
  ) as MCPToolResponse;

  const response = parseResponse(result) as {
    results: Array<{ type: string; record_type: string; id: string }>;
  };

  assertEquals(response.results.length, 1);
  assertEquals(response.results[0].type, "tool");
  assertEquals(response.results[0].record_type, "mcp-tool");
  assertEquals(response.results[0].id, "filesystem:read_file");
});

Deno.test("handleDiscover - Story 13.8: record_type 'capability' for capabilities", async () => {
  const dagSuggester = new MockDAGSuggester();

  const capability = createCapability("cap-123", 0.95);
  dagSuggester.setCapabilityMatch({
    capability,
    score: 0.85,
    semanticScore: 0.9,
    thresholdUsed: 0.7,
    parametersSchema: null,
  });

  const deps = createDeps({
    dagSuggester: dagSuggester as unknown as DAGSuggester,
  });

  const result = await handleDiscover(
    { intent: "create an issue", filter: { type: "capability" } },
    deps,
  ) as MCPToolResponse;

  const response = parseResponse(result) as {
    results: Array<{ type: string; record_type: string; id: string }>;
  };

  assertEquals(response.results.length, 1);
  assertEquals(response.results[0].type, "capability");
  assertEquals(response.results[0].record_type, "capability");
  assertEquals(response.results[0].id, "cap-123");
});

Deno.test("handleDiscover - Story 13.8: mixed results have correct record_type", async () => {
  const graphEngine = new MockGraphEngine();
  const dagSuggester = new MockDAGSuggester();

  graphEngine.setHybridResults([
    createToolResult("github:create_issue", 0.85),
  ]);

  const capability = createCapability("cap-create-issue", 0.92);
  dagSuggester.setCapabilityMatch({
    capability,
    score: 0.80,
    semanticScore: 0.85,
    thresholdUsed: 0.7,
    parametersSchema: null,
  });

  const deps = createDeps({
    graphEngine: graphEngine as unknown as GraphRAGEngine,
    dagSuggester: dagSuggester as unknown as DAGSuggester,
  });

  const result = await handleDiscover(
    { intent: "create an issue", limit: 5 },
    deps,
  ) as MCPToolResponse;

  const response = parseResponse(result) as {
    results: Array<{ type: string; record_type: string }>;
  };

  assertEquals(response.results.length, 2);

  const toolResult = response.results.find((r) => r.type === "tool");
  assertExists(toolResult);
  assertEquals(toolResult.record_type, "mcp-tool");

  const capResult = response.results.find((r) => r.type === "capability");
  assertExists(capResult);
  assertEquals(capResult.record_type, "capability");
});
