/**
 * Tests for Cluster Boost Calculator Module
 *
 * Tests boost computation, PageRank integration, cache handling,
 * and edge cases for the clustering/boost-calculator module.
 *
 * @module tests/unit/graphrag/clustering/boost-calculator.test
 */

import { assertEquals, assertExists } from "jsr:@std/assert@1";
import {
  type ClusterBoostDeps,
  computeClusterBoosts,
  getCapabilityPageranks,
} from "../../../../src/graphrag/clustering/boost-calculator.ts";
import type { Capability } from "../../../../src/capabilities/types.ts";
import type { DagScoringConfig } from "../../../../src/graphrag/dag-scoring-config.ts";
import { DEFAULT_DAG_SCORING_CONFIG } from "../../../../src/graphrag/dag-scoring-config.ts";
import type { ClusterableCapability } from "../../../../src/graphrag/spectral-clustering.ts";

// =============================================================================
// Mock SpectralClusteringManager
// =============================================================================

interface MockSpectralClusteringManager {
  restoreFromCacheIfValid: (
    tools: string[],
    capabilities: ClusterableCapability[],
  ) => boolean;
  buildBipartiteMatrix: (
    tools: string[],
    capabilities: ClusterableCapability[],
  ) => void;
  computeClusters: () => void;
  computeHypergraphPageRank: (capabilities: ClusterableCapability[]) => void;
  saveToCache: (tools: string[], capabilities: ClusterableCapability[]) => void;
  identifyActiveCluster: (contextTools: string[]) => number;
  getClusterBoost: (capability: ClusterableCapability, activeCluster: number) => number;
  getPageRank: (capabilityId: string) => number;
  getAllPageRanks: () => Map<string, number>;
}

function createMockSpectralClustering(
  options: {
    cacheHit?: boolean;
    activeCluster?: number;
    clusterBoosts?: Map<string, number>;
    pageRanks?: Map<string, number>;
  } = {},
): MockSpectralClusteringManager {
  const {
    cacheHit = false,
    activeCluster = 0,
    clusterBoosts = new Map(),
    pageRanks = new Map(),
  } = options;

  return {
    restoreFromCacheIfValid: () => cacheHit,
    buildBipartiteMatrix: () => {},
    computeClusters: () => {},
    computeHypergraphPageRank: () => {},
    saveToCache: () => {},
    identifyActiveCluster: () => activeCluster,
    getClusterBoost: (capability: ClusterableCapability) => clusterBoosts.get(capability.id) ?? 0,
    getPageRank: (capabilityId: string) => pageRanks.get(capabilityId) ?? 0,
    getAllPageRanks: () => new Map(pageRanks),
  };
}

// =============================================================================
// Mock LocalAlphaCalculator
// =============================================================================

interface MockLocalAlphaCalculator {
  setSpectralClustering: (clustering: unknown) => void;
  setSpectralClusteringCallCount: number;
}

function createMockLocalAlphaCalculator(): MockLocalAlphaCalculator {
  return {
    setSpectralClusteringCallCount: 0,
    setSpectralClustering: function () {
      this.setSpectralClusteringCallCount++;
    },
  };
}

// =============================================================================
// Test Fixtures
// =============================================================================

function createTestCapability(id: string, toolsUsed: string[]): Capability {
  return {
    id,
    name: `Capability ${id}`,
    description: "Test capability",
    codeSnippet: "// test code",
    codeHash: "test-hash",
    intentEmbedding: new Float32Array(1024),
    cacheConfig: { ttl_ms: 3600000, cacheable: true },
    usageCount: 0,
    successCount: 0,
    successRate: 0,
    avgDurationMs: 0,
    createdAt: new Date(),
    lastUsed: new Date(),
    source: "emergent" as const,
    toolsUsed,
  };
}

function createTestDeps(
  spectralClustering: MockSpectralClusteringManager | null,
  localAlphaCalculator: MockLocalAlphaCalculator | null = null,
  config: DagScoringConfig = DEFAULT_DAG_SCORING_CONFIG,
): ClusterBoostDeps {
  return {
    spectralClustering: spectralClustering as any,
    localAlphaCalculator: localAlphaCalculator as any,
    config,
  };
}

// =============================================================================
// Basic Functionality Tests
// =============================================================================

Deno.test("computeClusterBoosts - basic cluster boost computation", () => {
  const capabilities = [
    createTestCapability("cap-1", ["tool-a", "tool-b"]),
    createTestCapability("cap-2", ["tool-b", "tool-c"]),
    createTestCapability("cap-3", ["tool-d"]),
  ];

  const contextTools = ["tool-a", "tool-b"];

  const clusterBoosts = new Map([
    ["cap-1", 0.5], // Same cluster as context tools
    ["cap-2", 0.25], // Partial overlap
  ]);

  const pageRanks = new Map([
    ["cap-1", 0.4],
    ["cap-2", 0.3],
    ["cap-3", 0.3],
  ]);

  const mockClustering = createMockSpectralClustering({
    activeCluster: 0,
    clusterBoosts,
    pageRanks,
  });

  const deps = createTestDeps(mockClustering);
  const result = computeClusterBoosts(capabilities, contextTools, deps);

  assertExists(result.boosts);
  assertExists(result.spectralClustering);

  // cap-1: cluster boost (0.5) + PageRank boost (0.4 * 0.3 = 0.12) = 0.62
  assertEquals(result.boosts.get("cap-1"), 0.62);

  // cap-2: cluster boost (0.25) + PageRank boost (0.3 * 0.3 = 0.09) = 0.34
  const cap2Boost = result.boosts.get("cap-2");
  assertExists(cap2Boost);
  assertEquals(Math.round(cap2Boost * 100) / 100, 0.34);

  // cap-3: only PageRank boost (0.3 * 0.3 = 0.09) = 0.09
  assertEquals(result.boosts.get("cap-3"), 0.09);
});

Deno.test("computeClusterBoosts - returns empty boosts for insufficient capabilities", () => {
  const capabilities = [createTestCapability("cap-1", ["tool-a"])];
  const contextTools = ["tool-a"];

  const deps = createTestDeps(null);
  const result = computeClusterBoosts(capabilities, contextTools, deps);

  assertEquals(result.boosts.size, 0);
  assertEquals(result.spectralClustering, null);
});

Deno.test("computeClusterBoosts - returns empty boosts for insufficient context tools", () => {
  const capabilities = [
    createTestCapability("cap-1", ["tool-a"]),
    createTestCapability("cap-2", ["tool-b"]),
  ];
  const contextTools = ["tool-a"]; // Only 1 tool

  const deps = createTestDeps(null);
  const result = computeClusterBoosts(capabilities, contextTools, deps);

  assertEquals(result.boosts.size, 0);
  assertEquals(result.spectralClustering, null);
});

Deno.test("computeClusterBoosts - handles no active cluster identified", () => {
  const capabilities = [
    createTestCapability("cap-1", ["tool-a", "tool-b"]),
    createTestCapability("cap-2", ["tool-c", "tool-d"]),
  ];

  const contextTools = ["tool-x", "tool-y"]; // Tools not in any cluster

  const mockClustering = createMockSpectralClustering({
    activeCluster: -1, // No active cluster
  });

  const deps = createTestDeps(mockClustering);
  const result = computeClusterBoosts(capabilities, contextTools, deps);

  // Should have empty boosts map when no active cluster
  assertEquals(result.boosts.size, 0);
});

// =============================================================================
// Cache Hit/Miss Tests
// =============================================================================

Deno.test("computeClusterBoosts - cache hit skips expensive computation", () => {
  const capabilities = [
    createTestCapability("cap-1", ["tool-a", "tool-b"]),
    createTestCapability("cap-2", ["tool-b", "tool-c"]),
  ];

  const contextTools = ["tool-a", "tool-b"];

  const clusterBoosts = new Map([["cap-1", 0.5]]);
  const pageRanks = new Map([["cap-1", 0.4]]);

  let buildCalled = false;
  let computeClustersCalled = false;
  let computePageRankCalled = false;
  let saveCacheCalled = false;

  const mockClustering = {
    ...createMockSpectralClustering({
      cacheHit: true, // Cache hit
      activeCluster: 0,
      clusterBoosts,
      pageRanks,
    }),
    buildBipartiteMatrix: () => {
      buildCalled = true;
    },
    computeClusters: () => {
      computeClustersCalled = true;
    },
    computeHypergraphPageRank: () => {
      computePageRankCalled = true;
    },
    saveToCache: () => {
      saveCacheCalled = true;
    },
  };

  const deps = createTestDeps(mockClustering);
  const result = computeClusterBoosts(capabilities, contextTools, deps);

  assertExists(result.boosts);

  // Verify expensive operations were NOT called due to cache hit
  assertEquals(buildCalled, false);
  assertEquals(computeClustersCalled, false);
  assertEquals(computePageRankCalled, false);
  assertEquals(saveCacheCalled, false);
});

Deno.test("computeClusterBoosts - cache miss triggers full computation", () => {
  const capabilities = [
    createTestCapability("cap-1", ["tool-a", "tool-b"]),
    createTestCapability("cap-2", ["tool-b", "tool-c"]),
  ];

  const contextTools = ["tool-a", "tool-b"];

  const clusterBoosts = new Map([["cap-1", 0.5]]);
  const pageRanks = new Map([["cap-1", 0.4]]);

  let buildCalled = false;
  let computeClustersCalled = false;
  let computePageRankCalled = false;
  let saveCacheCalled = false;

  const mockClustering = {
    ...createMockSpectralClustering({
      cacheHit: false, // Cache miss
      activeCluster: 0,
      clusterBoosts,
      pageRanks,
    }),
    buildBipartiteMatrix: () => {
      buildCalled = true;
    },
    computeClusters: () => {
      computeClustersCalled = true;
    },
    computeHypergraphPageRank: () => {
      computePageRankCalled = true;
    },
    saveToCache: () => {
      saveCacheCalled = true;
    },
  };

  const deps = createTestDeps(mockClustering);
  const result = computeClusterBoosts(capabilities, contextTools, deps);

  assertExists(result.boosts);

  // Verify all expensive operations were called due to cache miss
  assertEquals(buildCalled, true);
  assertEquals(computeClustersCalled, true);
  assertEquals(computePageRankCalled, true);
  assertEquals(saveCacheCalled, true);
});

// =============================================================================
// Initialization Tests
// =============================================================================

Deno.test("computeClusterBoosts - initializes spectral clustering if null", () => {
  const capabilities = [
    createTestCapability("cap-1", ["tool-a", "tool-b"]),
    createTestCapability("cap-2", ["tool-b", "tool-c"]),
  ];

  const contextTools = ["tool-a", "tool-b"];

  const deps = createTestDeps(null);
  const result = computeClusterBoosts(capabilities, contextTools, deps);

  // Should have created a new SpectralClusteringManager instance
  assertExists(result.spectralClustering);
});

Deno.test("computeClusterBoosts - syncs to LocalAlphaCalculator on first init", () => {
  const capabilities = [
    createTestCapability("cap-1", ["tool-a", "tool-b"]),
    createTestCapability("cap-2", ["tool-b", "tool-c"]),
  ];

  const contextTools = ["tool-a", "tool-b"];

  const mockLocalAlpha = createMockLocalAlphaCalculator();
  const deps = createTestDeps(null, mockLocalAlpha);

  const result = computeClusterBoosts(capabilities, contextTools, deps);

  assertExists(result.spectralClustering);

  // Verify LocalAlphaCalculator was updated
  assertEquals(mockLocalAlpha.setSpectralClusteringCallCount, 1);
});

Deno.test("computeClusterBoosts - syncs to LocalAlphaCalculator after cache miss", () => {
  const capabilities = [
    createTestCapability("cap-1", ["tool-a", "tool-b"]),
    createTestCapability("cap-2", ["tool-b", "tool-c"]),
  ];

  const contextTools = ["tool-a", "tool-b"];

  const mockClustering = createMockSpectralClustering({
    cacheHit: false, // Cache miss
    activeCluster: 0,
  });

  const mockLocalAlpha = createMockLocalAlphaCalculator();
  const deps = createTestDeps(mockClustering, mockLocalAlpha);

  computeClusterBoosts(capabilities, contextTools, deps);

  // Verify LocalAlphaCalculator was updated after recomputation
  assertEquals(mockLocalAlpha.setSpectralClusteringCallCount, 1);
});

Deno.test("computeClusterBoosts - does not sync to LocalAlphaCalculator on cache hit", () => {
  const capabilities = [
    createTestCapability("cap-1", ["tool-a", "tool-b"]),
    createTestCapability("cap-2", ["tool-b", "tool-c"]),
  ];

  const contextTools = ["tool-a", "tool-b"];

  const mockClustering = createMockSpectralClustering({
    cacheHit: true, // Cache hit
    activeCluster: 0,
  });

  const mockLocalAlpha = createMockLocalAlphaCalculator();
  const deps = createTestDeps(mockClustering, mockLocalAlpha);

  computeClusterBoosts(capabilities, contextTools, deps);

  // Verify LocalAlphaCalculator was NOT updated on cache hit
  assertEquals(mockLocalAlpha.setSpectralClusteringCallCount, 0);
});

// =============================================================================
// PageRank Integration Tests
// =============================================================================

Deno.test("computeClusterBoosts - applies PageRank boost correctly", () => {
  const capabilities = [
    createTestCapability("cap-1", ["tool-a", "tool-b"]),
    createTestCapability("cap-2", ["tool-c"]), // Need >= 2 capabilities
  ];
  const contextTools = ["tool-a", "tool-b"];

  const pageRanks = new Map([["cap-1", 0.5]]);
  const clusterBoosts = new Map([["cap-1", 0.2]]); // Base cluster boost

  const mockClustering = createMockSpectralClustering({
    activeCluster: 0,
    clusterBoosts,
    pageRanks,
  });

  const deps = createTestDeps(mockClustering);
  const result = computeClusterBoosts(capabilities, contextTools, deps);

  // cap-1: 0.2 (cluster) + (0.5 * 0.3 [default pagerankWeight]) = 0.2 + 0.15 = 0.35
  assertEquals(result.boosts.get("cap-1"), 0.35);
});

Deno.test("computeClusterBoosts - skips zero PageRank scores", () => {
  const capabilities = [
    createTestCapability("cap-1", ["tool-a"]),
    createTestCapability("cap-2", ["tool-b"]),
  ];
  const contextTools = ["tool-a", "tool-b"];

  const mockClustering = createMockSpectralClustering({
    activeCluster: 0,
    clusterBoosts: new Map([["cap-1", 0.3]]),
    pageRanks: new Map([["cap-1", 0.0]]), // Zero PageRank
  });

  const deps = createTestDeps(mockClustering);
  const result = computeClusterBoosts(capabilities, contextTools, deps);

  // cap-1: 0.3 (cluster) + 0.0 (zero PageRank) = 0.3
  assertEquals(result.boosts.get("cap-1"), 0.3);

  // cap-2 should not be in boosts (no cluster boost, no PageRank)
  assertEquals(result.boosts.has("cap-2"), false);
});

Deno.test("computeClusterBoosts - combines high cluster and high PageRank boosts", () => {
  const capabilities = [
    createTestCapability("cap-1", ["tool-a", "tool-b"]),
    createTestCapability("cap-2", ["tool-c"]), // Need >= 2 capabilities
  ];
  const contextTools = ["tool-a", "tool-b"];

  const clusterBoosts = new Map([["cap-1", 0.4]]);
  const pageRanks = new Map([["cap-1", 0.6]]);

  const mockClustering = createMockSpectralClustering({
    activeCluster: 0,
    clusterBoosts,
    pageRanks,
  });

  const deps = createTestDeps(mockClustering);
  const result = computeClusterBoosts(capabilities, contextTools, deps);

  // cap-1: 0.4 (cluster) + (0.6 * 0.3) = 0.4 + 0.18 = 0.58
  const cap1Boost = result.boosts.get("cap-1");
  assertExists(cap1Boost);
  assertEquals(Math.round(cap1Boost * 100) / 100, 0.58);
});

// =============================================================================
// Edge Cases and Error Handling
// =============================================================================

Deno.test("computeClusterBoosts - handles empty capabilities list", () => {
  const capabilities: Capability[] = [];
  const contextTools = ["tool-a", "tool-b"];

  const deps = createTestDeps(null);
  const result = computeClusterBoosts(capabilities, contextTools, deps);

  assertEquals(result.boosts.size, 0);
  assertEquals(result.spectralClustering, null);
});

Deno.test("computeClusterBoosts - handles empty context tools", () => {
  const capabilities = [
    createTestCapability("cap-1", ["tool-a"]),
    createTestCapability("cap-2", ["tool-b"]),
  ];
  const contextTools: string[] = [];

  const deps = createTestDeps(null);
  const result = computeClusterBoosts(capabilities, contextTools, deps);

  assertEquals(result.boosts.size, 0);
  assertEquals(result.spectralClustering, null);
});

Deno.test("computeClusterBoosts - handles capabilities without toolsUsed", () => {
  const capabilities = [
    { id: "cap-1", toolsUsed: undefined } as any,
    createTestCapability("cap-2", ["tool-a", "tool-b"]),
  ];
  const contextTools = ["tool-a", "tool-b"];

  const mockClustering = createMockSpectralClustering({
    activeCluster: 0,
    clusterBoosts: new Map([["cap-2", 0.5]]),
  });

  const deps = createTestDeps(mockClustering);
  const result = computeClusterBoosts(capabilities, contextTools, deps);

  // Should handle cap-1 gracefully (empty tools)
  assertExists(result.boosts);
  assertEquals(result.boosts.has("cap-1"), false);
});

Deno.test("computeClusterBoosts - handles errors gracefully", () => {
  const capabilities = [createTestCapability("cap-1", ["tool-a", "tool-b"])];
  const contextTools = ["tool-a", "tool-b"];

  const errorClustering = {
    ...createMockSpectralClustering({ cacheHit: false }),
    buildBipartiteMatrix: () => {
      throw new Error("Matrix build failed");
    },
  };

  const deps = createTestDeps(errorClustering);
  const result = computeClusterBoosts(capabilities, contextTools, deps);

  // Should return empty boosts on error
  assertEquals(result.boosts.size, 0);
  assertExists(result.spectralClustering);
});

Deno.test("computeClusterBoosts - handles null LocalAlphaCalculator gracefully", () => {
  const capabilities = [
    createTestCapability("cap-1", ["tool-a", "tool-b"]),
    createTestCapability("cap-2", ["tool-b", "tool-c"]),
  ];

  const contextTools = ["tool-a", "tool-b"];

  const deps = createTestDeps(null, null); // null LocalAlphaCalculator
  const result = computeClusterBoosts(capabilities, contextTools, deps);

  // Should work fine without LocalAlphaCalculator
  assertExists(result.spectralClustering);
  assertExists(result.boosts);
});

// =============================================================================
// getCapabilityPageranks Tests
// =============================================================================

Deno.test("getCapabilityPageranks - returns all PageRank scores", () => {
  const pageRanks = new Map([
    ["cap-1", 0.4],
    ["cap-2", 0.35],
    ["cap-3", 0.25],
  ]);

  const mockClustering = createMockSpectralClustering({ pageRanks });

  const result = getCapabilityPageranks(mockClustering as any);

  assertEquals(result.size, 3);
  assertEquals(result.get("cap-1"), 0.4);
  assertEquals(result.get("cap-2"), 0.35);
  assertEquals(result.get("cap-3"), 0.25);
});

Deno.test("getCapabilityPageranks - returns empty map for null clustering", () => {
  const result = getCapabilityPageranks(null);

  assertEquals(result.size, 0);
  assertEquals(result instanceof Map, true);
});

Deno.test("getCapabilityPageranks - returns empty map when no PageRanks computed", () => {
  const mockClustering = createMockSpectralClustering({
    pageRanks: new Map(),
  });

  const result = getCapabilityPageranks(mockClustering as any);

  assertEquals(result.size, 0);
});

// =============================================================================
// Integration Scenario Tests
// =============================================================================

Deno.test("computeClusterBoosts - realistic multi-capability scenario", () => {
  const capabilities = [
    createTestCapability("file-reader", ["Read", "Glob"]),
    createTestCapability("file-writer", ["Write", "Edit"]),
    createTestCapability("data-analyzer", ["Read", "Grep"]),
    createTestCapability("git-ops", ["Bash"]),
  ];

  const contextTools = ["Read", "Grep"]; // Working with file reading/searching

  const clusterBoosts = new Map([
    ["file-reader", 0.5], // Same cluster
    ["data-analyzer", 0.5], // Same cluster
    ["file-writer", 0.15], // Different cluster, partial overlap
  ]);

  const pageRanks = new Map([
    ["file-reader", 0.5], // High centrality
    ["file-writer", 0.3],
    ["data-analyzer", 0.15],
    ["git-ops", 0.05],
  ]);

  const mockClustering = createMockSpectralClustering({
    activeCluster: 0,
    clusterBoosts,
    pageRanks,
  });

  const deps = createTestDeps(mockClustering);
  const result = computeClusterBoosts(capabilities, contextTools, deps);

  // file-reader: high cluster + high PageRank = 0.5 + (0.5 * 0.3) = 0.65
  assertEquals(result.boosts.get("file-reader"), 0.65);

  // data-analyzer: high cluster + low PageRank = 0.5 + (0.15 * 0.3) = 0.545
  assertEquals(result.boosts.get("data-analyzer"), 0.545);

  // file-writer: low cluster + medium PageRank = 0.15 + (0.3 * 0.3) = 0.24
  assertEquals(result.boosts.get("file-writer"), 0.24);

  // git-ops: no cluster but has PageRank = 0 + (0.05 * 0.3) = 0.015
  assertEquals(result.boosts.get("git-ops"), 0.015);
});

Deno.test("computeClusterBoosts - handles large capability sets efficiently", () => {
  // Generate 100 capabilities
  const capabilities = Array.from(
    { length: 100 },
    (_, i) => createTestCapability(`cap-${i}`, [`tool-${i % 10}`, `tool-${(i + 1) % 10}`]),
  );

  const contextTools = ["tool-0", "tool-1", "tool-2"];

  const clusterBoosts = new Map(
    capabilities.map((cap) => [cap.id, 0.1]),
  );

  const pageRanks = new Map(
    capabilities.map((cap) => [cap.id, 0.01]),
  );

  const mockClustering = createMockSpectralClustering({
    cacheHit: true, // Simulate cache hit for performance
    activeCluster: 0,
    clusterBoosts,
    pageRanks,
  });

  const deps = createTestDeps(mockClustering);
  const startTime = performance.now();
  const result = computeClusterBoosts(capabilities, contextTools, deps);
  const duration = performance.now() - startTime;

  assertEquals(result.boosts.size, 100);
  // Should complete quickly due to cache hit
  assertEquals(duration < 100, true); // Less than 100ms
});
