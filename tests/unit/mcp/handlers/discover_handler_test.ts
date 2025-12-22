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

import { assertEquals, assertExists, assertAlmostEquals } from "@std/assert";
import { handleDiscover, computeDiscoverScore } from "../../../../src/mcp/handlers/discover-handler.ts";
import { GLOBAL_SCORE_CAP } from "../../../../src/graphrag/algorithms/unified-search.ts";
import type { GraphRAGEngine } from "../../../../src/graphrag/graph-engine.ts";
import type { VectorSearch } from "../../../../src/vector/search.ts";
import type { DAGSuggester } from "../../../../src/graphrag/dag-suggester.ts";
import type { HybridSearchResult } from "../../../../src/graphrag/types.ts";
import type { CapabilityMatch, Capability } from "../../../../src/capabilities/types.ts";
import type { MCPToolResponse } from "../../../../src/mcp/server/types.ts";

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

// Mock DAGSuggester
class MockDAGSuggester {
  private match: CapabilityMatch | null = null;

  setCapabilityMatch(match: CapabilityMatch | null) {
    this.match = match;
  }

  async searchCapabilities(_intent: string): Promise<CapabilityMatch | null> {
    return this.match;
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

Deno.test("handleDiscover - returns error when intent is missing", async () => {
  const graphEngine = new MockGraphEngine();
  const vectorSearch = new MockVectorSearch();
  const dagSuggester = new MockDAGSuggester();

  const result = await handleDiscover(
    {},
    vectorSearch as unknown as VectorSearch,
    graphEngine as unknown as GraphRAGEngine,
    dagSuggester as unknown as DAGSuggester,
  ) as MCPToolResponse;

  assertExists(result.content);
  assertEquals(result.content.length, 1);
  const response = parseResponse(result);
  assertExists(response.error);
  assertEquals(response.error, "Missing or empty required parameter: 'intent'");
});

Deno.test("handleDiscover - returns error when intent is empty string", async () => {
  const graphEngine = new MockGraphEngine();
  const vectorSearch = new MockVectorSearch();
  const dagSuggester = new MockDAGSuggester();

  // Test empty string
  const result1 = await handleDiscover(
    { intent: "" },
    vectorSearch as unknown as VectorSearch,
    graphEngine as unknown as GraphRAGEngine,
    dagSuggester as unknown as DAGSuggester,
  ) as MCPToolResponse;

  assertExists(result1.content);
  const response1 = parseResponse(result1);
  assertExists(response1.error);
  assertEquals(response1.error, "Missing or empty required parameter: 'intent'");

  // Test whitespace-only string
  const result2 = await handleDiscover(
    { intent: "   " },
    vectorSearch as unknown as VectorSearch,
    graphEngine as unknown as GraphRAGEngine,
    dagSuggester as unknown as DAGSuggester,
  ) as MCPToolResponse;

  assertExists(result2.content);
  const response2 = parseResponse(result2);
  assertExists(response2.error);
  assertEquals(response2.error, "Missing or empty required parameter: 'intent'");
});

Deno.test("handleDiscover - returns tools from hybrid search", async () => {
  const graphEngine = new MockGraphEngine();
  const vectorSearch = new MockVectorSearch();
  const dagSuggester = new MockDAGSuggester();

  // Setup mock tool results
  // AC12: Unified formula applies: score = semantic × reliability (default 1.2 for successRate=1.0)
  // Score 0.9 × 1.2 = 1.08 → capped at 0.95
  graphEngine.setHybridResults([
    createToolResult("filesystem:read_file", 0.9),
    createToolResult("filesystem:write_file", 0.8),
  ]);

  const result = await handleDiscover(
    { intent: "read a file" },
    vectorSearch as unknown as VectorSearch,
    graphEngine as unknown as GraphRAGEngine,
    dagSuggester as unknown as DAGSuggester,
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
  // AC12: Unified formula: 0.9 × 1.2 = 1.08 → capped at GLOBAL_SCORE_CAP
  assertEquals(response.results[0].score, computeDiscoverScore(0.9, 1.0));
  assertEquals(response.meta.tools_count, 2);
});

Deno.test("handleDiscover - returns capabilities from matcher", async () => {
  const graphEngine = new MockGraphEngine();
  const vectorSearch = new MockVectorSearch();
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

  const result = await handleDiscover(
    { intent: "create an issue", filter: { type: "capability" } },
    vectorSearch as unknown as VectorSearch,
    graphEngine as unknown as GraphRAGEngine,
    dagSuggester as unknown as DAGSuggester,
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
  const vectorSearch = new MockVectorSearch();
  const dagSuggester = new MockDAGSuggester();

  // Setup tools with various semantic scores
  // AC12: Unified formula applies: score = semantic × 1.2 (boost for successRate=1.0)
  // 0.85 × 1.2 = 1.02 → capped at 0.95
  // 0.75 × 1.2 = 0.90
  graphEngine.setHybridResults([
    createToolResult("filesystem:read_file", 0.85),
    createToolResult("github:create_issue", 0.75),
  ]);

  // Setup capability with score 0.80 (from CapabilityMatcher)
  const capability = createCapability("cap-create-issue", 0.92);
  dagSuggester.setCapabilityMatch({
    capability,
    score: 0.80,
    semanticScore: 0.85,
    thresholdUsed: 0.7,
    parametersSchema: null,
  });

  const result = await handleDiscover(
    { intent: "create an issue" },
    vectorSearch as unknown as VectorSearch,
    graphEngine as unknown as GraphRAGEngine,
    dagSuggester as unknown as DAGSuggester,
  ) as MCPToolResponse;

  const response = parseResponse(result) as {
    results: Array<{ type: string; id: string; score: number }>;
    meta: { tools_count: number; capabilities_count: number };
  };

  // AC12: Tools now get boost → capped, 0.90; Capability stays at 0.80
  // Sorted by score descending
  assertEquals(response.results.length, 3);
  assertAlmostEquals(response.results[0].score, GLOBAL_SCORE_CAP, 0.01); // filesystem:read_file (0.85 × 1.2 → capped)
  assertEquals(response.results[0].id, "filesystem:read_file");
  assertAlmostEquals(response.results[1].score, 0.90, 0.01); // github:create_issue (0.75 × 1.2 = 0.90)
  assertEquals(response.results[1].id, "github:create_issue");
  assertAlmostEquals(response.results[2].score, 0.80, 0.01); // capability
  assertEquals(response.results[2].type, "capability");

  assertEquals(response.meta.tools_count, 2);
  assertEquals(response.meta.capabilities_count, 1);
});

Deno.test("handleDiscover - filters by type 'tool' only", async () => {
  const graphEngine = new MockGraphEngine();
  const vectorSearch = new MockVectorSearch();
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

  const result = await handleDiscover(
    { intent: "read file", filter: { type: "tool" } },
    vectorSearch as unknown as VectorSearch,
    graphEngine as unknown as GraphRAGEngine,
    dagSuggester as unknown as DAGSuggester,
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
  const vectorSearch = new MockVectorSearch();
  const dagSuggester = new MockDAGSuggester();

  // AC12: Unified formula applies: score = semantic × 1.2 (boost)
  // 0.9 × 1.2 = 1.08 → capped at 0.95
  // 0.5 × 1.2 = 0.60
  graphEngine.setHybridResults([
    createToolResult("filesystem:read_file", 0.9),
    createToolResult("filesystem:list", 0.5),
  ]);

  const result = await handleDiscover(
    { intent: "read file", filter: { minScore: 0.7 } },
    vectorSearch as unknown as VectorSearch,
    graphEngine as unknown as GraphRAGEngine,
    dagSuggester as unknown as DAGSuggester,
  ) as MCPToolResponse;

  const response = parseResponse(result) as {
    results: Array<{ score: number }>;
  };

  // Only the first tool passes minScore=0.7 (capped score > 0.7, 0.60 < 0.7)
  assertEquals(response.results.length, 1);
  assertEquals(response.results[0].score, computeDiscoverScore(0.9, 1.0)); // AC12: 0.9 × 1.2 → capped
});

Deno.test("handleDiscover - respects limit parameter", async () => {
  const graphEngine = new MockGraphEngine();
  const vectorSearch = new MockVectorSearch();
  const dagSuggester = new MockDAGSuggester();

  graphEngine.setHybridResults([
    createToolResult("filesystem:read_file", 0.9),
    createToolResult("filesystem:write_file", 0.85),
    createToolResult("filesystem:list", 0.8),
    createToolResult("filesystem:delete", 0.75),
  ]);

  const result = await handleDiscover(
    { intent: "file operations", limit: 2 },
    vectorSearch as unknown as VectorSearch,
    graphEngine as unknown as GraphRAGEngine,
    dagSuggester as unknown as DAGSuggester,
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
  const vectorSearch = new MockVectorSearch();
  const dagSuggester = new MockDAGSuggester();

  // Tool with related tools
  const toolWithRelated: HybridSearchResult = {
    ...createToolResult("filesystem:read_file", 0.9),
    relatedTools: [
      { toolId: "filesystem:write_file", relation: "often_after", score: 0.8 },
    ],
  };

  graphEngine.setHybridResults([toolWithRelated]);

  const result = await handleDiscover(
    { intent: "read file", include_related: true },
    vectorSearch as unknown as VectorSearch,
    graphEngine as unknown as GraphRAGEngine,
    dagSuggester as unknown as DAGSuggester,
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
  const vectorSearch = new MockVectorSearch();
  const dagSuggester = new MockDAGSuggester();

  // No results from either source
  graphEngine.setHybridResults([]);
  dagSuggester.setCapabilityMatch(null);

  const result = await handleDiscover(
    { intent: "nonexistent operation" },
    vectorSearch as unknown as VectorSearch,
    graphEngine as unknown as GraphRAGEngine,
    dagSuggester as unknown as DAGSuggester,
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
  const vectorSearch = new MockVectorSearch();
  const dagSuggester = new MockDAGSuggester();

  graphEngine.setHybridResults([
    createToolResult("filesystem:read_file", 0.9),
  ]);

  const result = await handleDiscover(
    { intent: "read a file", filter: { type: "all" } },
    vectorSearch as unknown as VectorSearch,
    graphEngine as unknown as GraphRAGEngine,
    dagSuggester as unknown as DAGSuggester,
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

Deno.test("handleDiscover - AC12: tools use unified scoring formula (semantic × reliability)", async () => {
  const graphEngine = new MockGraphEngine();
  const vectorSearch = new MockVectorSearch();
  const dagSuggester = new MockDAGSuggester();

  // Setup tool with high semantic score
  // The unified formula applies: score = semantic × reliability
  // For tools with no successRate, we default to 1.0 (cold start favorable)
  // So score = 0.9 × 1.0 = 0.9 (but capped at 0.95)
  graphEngine.setHybridResults([
    createToolResult("filesystem:read_file", 0.9),
  ]);

  const result = await handleDiscover(
    { intent: "read a file" },
    vectorSearch as unknown as VectorSearch,
    graphEngine as unknown as GraphRAGEngine,
    dagSuggester as unknown as DAGSuggester,
  ) as MCPToolResponse;

  const response = parseResponse(result) as {
    results: Array<{ type: string; score: number }>;
  };

  assertEquals(response.results.length, 1);
  assertEquals(response.results[0].type, "tool");
  // Unified formula: semantic × reliabilityFactor (with boost for high successRate)
  // successRate=1.0 → boostThreshold=0.9, so boostFactor=1.2 applied
  // score = min(0.9 × 1.2, GLOBAL_SCORE_CAP) - calculated dynamically
  assertEquals(response.results[0].score, computeDiscoverScore(0.9, 1.0));
});

Deno.test("handleDiscover - AC12: scores are normalized between 0 and 1", async () => {
  const graphEngine = new MockGraphEngine();
  const vectorSearch = new MockVectorSearch();
  const dagSuggester = new MockDAGSuggester();

  // Even with very high semantic scores, final score is capped at GLOBAL_SCORE_CAP
  graphEngine.setHybridResults([
    createToolResult("filesystem:read_file", 1.0), // Max semantic score
  ]);

  const result = await handleDiscover(
    { intent: "read file" },
    vectorSearch as unknown as VectorSearch,
    graphEngine as unknown as GraphRAGEngine,
    dagSuggester as unknown as DAGSuggester,
  ) as MCPToolResponse;

  const response = parseResponse(result) as {
    results: Array<{ score: number }>;
  };

  assertEquals(response.results.length, 1);
  // score = 1.0 × 1.2 (boost) = 1.2 → capped at GLOBAL_SCORE_CAP
  assertEquals(response.results[0].score, computeDiscoverScore(1.0, 1.0));
});

Deno.test("handleDiscover - AC13: capabilities use same formula with successRate", async () => {
  const graphEngine = new MockGraphEngine();
  const vectorSearch = new MockVectorSearch();
  const dagSuggester = new MockDAGSuggester();

  // Capability with high success rate gets boost
  // semanticScore=0.85, successRate=0.95 → boost factor 1.2
  // score = 0.85 × 1.2 = 1.02 → capped at 0.95
  const capability = createCapability("cap-high-success", 0.95);
  dagSuggester.setCapabilityMatch({
    capability,
    score: 0.95, // CapabilityMatcher already computes this
    semanticScore: 0.85,
    thresholdUsed: 0.7,
    parametersSchema: null,
  });

  const result = await handleDiscover(
    { intent: "create issue", filter: { type: "capability" } },
    vectorSearch as unknown as VectorSearch,
    graphEngine as unknown as GraphRAGEngine,
    dagSuggester as unknown as DAGSuggester,
  ) as MCPToolResponse;

  const response = parseResponse(result) as {
    results: Array<{ type: string; score: number; success_rate: number }>;
  };

  assertEquals(response.results.length, 1);
  assertEquals(response.results[0].type, "capability");
  assertEquals(response.results[0].success_rate, 0.95);
  // Score comes from CapabilityMatcher which includes transitive reliability
  assertEquals(response.results[0].score, 0.95);
});

Deno.test("handleDiscover - AC13: low successRate capability gets penalty", async () => {
  const graphEngine = new MockGraphEngine();
  const vectorSearch = new MockVectorSearch();
  const dagSuggester = new MockDAGSuggester();

  // Capability with low success rate (0.4 < 0.5 threshold) gets penalty factor 0.1
  // semanticScore=0.8, successRate=0.4 → penalty factor 0.1
  // score = 0.8 × 0.1 = 0.08
  const capability = createCapability("cap-low-success", 0.4);
  dagSuggester.setCapabilityMatch({
    capability,
    score: 0.08, // CapabilityMatcher computes: 0.8 × 0.1 = 0.08
    semanticScore: 0.8,
    thresholdUsed: 0.7,
    parametersSchema: null,
  });

  const result = await handleDiscover(
    { intent: "risky operation", filter: { type: "capability" } },
    vectorSearch as unknown as VectorSearch,
    graphEngine as unknown as GraphRAGEngine,
    dagSuggester as unknown as DAGSuggester,
  ) as MCPToolResponse;

  const response = parseResponse(result) as {
    results: Array<{ type: string; score: number; success_rate: number }>;
  };

  assertEquals(response.results.length, 1);
  assertEquals(response.results[0].success_rate, 0.4);
  // Low success rate results in penalized score
  assertEquals(response.results[0].score, 0.08);
});
