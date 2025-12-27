/**
 * Candidate Ranking Tests
 *
 * Comprehensive unit tests for the ranking module.
 * Tests candidate ranking, dependency path extraction, and alpha calculation.
 *
 * @module tests/unit/graphrag/suggestion/ranking.test
 */

import { assertAlmostEquals, assertEquals, assertExists } from "jsr:@std/assert@1";
import {
  calculateAverageAlpha,
  extractDependencyPaths,
  rankCandidates,
} from "../../../../src/graphrag/suggestion/ranking.ts";
import type { CandidateAlpha } from "../../../../src/graphrag/suggestion/ranking.ts";
import type { HybridSearchResult } from "../../../../src/graphrag/types.ts";
import type { GraphRAGEngine } from "../../../../src/graphrag/graph-engine.ts";
import { DEFAULT_DAG_SCORING_CONFIG } from "../../../../src/graphrag/dag-scoring-config.ts";

const config = DEFAULT_DAG_SCORING_CONFIG;

// Mock GraphRAGEngine with only required methods
function createMockGraphEngine(
  pageRanks: Record<string, number> = {},
  adamicAdar: Record<string, number> = {},
  paths: Record<string, string[] | null> = {},
): GraphRAGEngine {
  return {
    getPageRank: (toolId: string) => pageRanks[toolId] ?? 0,
    adamicAdarBetween: (tool1: string, tool2: string) => {
      const key = `${tool1}-${tool2}`;
      return adamicAdar[key] ?? 0;
    },
    findShortestPath: (from: string, to: string) => {
      const key = `${from}-${to}`;
      return paths[key] ?? null;
    },
  } as unknown as GraphRAGEngine;
}

Deno.test("rankCandidates - Happy Path", async (t) => {
  await t.step("ranks candidates by combined score", () => {
    const candidates: HybridSearchResult[] = [
      {
        toolId: "tool1",
        serverId: "server1",
        toolName: "Tool 1",
        description: "First tool",
        semanticScore: 0.80,
        graphScore: 0.05,
        finalScore: 0.85,
      },
      {
        toolId: "tool2",
        serverId: "server1",
        toolName: "Tool 2",
        description: "Second tool",
        semanticScore: 0.70,
        graphScore: 0.05,
        finalScore: 0.75,
      },
      {
        toolId: "tool3",
        serverId: "server1",
        toolName: "Tool 3",
        description: "Third tool",
        semanticScore: 0.60,
        graphScore: 0.05,
        finalScore: 0.65,
      },
    ];

    const graphEngine = createMockGraphEngine(
      { tool1: 0.15, tool2: 0.12, tool3: 0.08 },
    );

    const ranked = rankCandidates(candidates, [], graphEngine, config);

    assertEquals(ranked.length, 3);
    assertEquals(ranked[0].toolId, "tool1");
    assertEquals(ranked[1].toolId, "tool2");
    assertEquals(ranked[2].toolId, "tool3");

    // Verify combined scores are calculated
    assert(ranked[0].combinedScore > 0);
    assert(ranked[0].combinedScore >= ranked[1].combinedScore);
    assert(ranked[1].combinedScore >= ranked[2].combinedScore);
  });

  await t.step("limits results to rankedCandidates config", () => {
    const candidates: HybridSearchResult[] = Array.from({ length: 10 }, (_, i) => ({
      toolId: `tool${i}`,
      serverId: "server1",
      toolName: `Tool ${i}`,
      description: `Tool ${i}`,
      semanticScore: 0.9 - i * 0.05,
      graphScore: 0.05,
      finalScore: 0.9 - i * 0.05,
    }));

    const graphEngine = createMockGraphEngine();
    const ranked = rankCandidates(candidates, [], graphEngine, config);

    // Should limit to config.limits.rankedCandidates (5)
    assertEquals(ranked.length, config.limits.rankedCandidates);
    assertEquals(ranked.length, 5);
  });

  await t.step("calculates PageRank scores correctly", () => {
    const candidates: HybridSearchResult[] = [{
      toolId: "tool1",
      serverId: "server1",
      toolName: "Tool 1",
      description: "First tool",
      semanticScore: 0.80,
      graphScore: 0.05,
      finalScore: 0.85,
    }];

    const graphEngine = createMockGraphEngine({ tool1: 0.25 });
    const ranked = rankCandidates(candidates, [], graphEngine, config);

    assertEquals(ranked[0].pageRank, 0.25);
  });

  await t.step("calculates Adamic-Adar scores with context tools", () => {
    const candidates: HybridSearchResult[] = [{
      toolId: "tool1",
      serverId: "server1",
      toolName: "Tool 1",
      description: "First tool",
      semanticScore: 0.80,
      graphScore: 0.05,
      finalScore: 0.85,
    }];

    const contextTools = ["ctx1", "ctx2", "ctx3"];
    const adamicAdar = {
      "tool1-ctx1": 2.0,
      "tool1-ctx2": 4.0,
      "tool1-ctx3": 1.0,
    };

    const graphEngine = createMockGraphEngine({}, adamicAdar);
    const ranked = rankCandidates(candidates, contextTools, graphEngine, config);

    // Should use max Adamic-Adar score (4.0) normalized to 0-1 range
    const expectedAA = Math.min(4.0 / 2, 1.0);
    assertEquals(ranked[0].adamicAdar, expectedAA);
    assertEquals(ranked[0].adamicAdar, 1.0);
  });

  await t.step("preserves schema from hybrid search results", () => {
    const schema = {
      type: "object",
      properties: { name: { type: "string" } },
    };

    const candidates: HybridSearchResult[] = [{
      toolId: "tool1",
      serverId: "server1",
      toolName: "Tool 1",
      description: "First tool",
      semanticScore: 0.80,
      graphScore: 0.05,
      finalScore: 0.85,
      schema,
    }];

    const graphEngine = createMockGraphEngine();
    const ranked = rankCandidates(candidates, [], graphEngine, config);

    assertEquals(ranked[0].schema, schema);
  });
});

Deno.test("rankCandidates - Combined Score Calculation", async (t) => {
  await t.step("combines finalScore and PageRank with configured weights", () => {
    const candidates: HybridSearchResult[] = [{
      toolId: "tool1",
      serverId: "server1",
      toolName: "Tool 1",
      description: "First tool",
      semanticScore: 0.80,
      graphScore: 0.05,
      finalScore: 0.85,
    }];

    const graphEngine = createMockGraphEngine({ tool1: 0.20 });
    const ranked = rankCandidates(candidates, [], graphEngine, config);

    const expectedCombined = 0.85 * config.weights.candidateRanking.hybridScore +
      0.20 * config.weights.candidateRanking.pagerank;

    assertAlmostEquals(ranked[0].combinedScore, expectedCombined, 0.001);

    // With default weights: 0.85 * 0.8 + 0.20 * 0.2 = 0.68 + 0.04 = 0.72
    assertAlmostEquals(ranked[0].combinedScore, 0.72, 0.001);
  });

  await t.step("PageRank can boost ranking of lower finalScore", () => {
    const candidates: HybridSearchResult[] = [
      {
        toolId: "tool1",
        serverId: "server1",
        toolName: "Tool 1",
        description: "High semantic, low PageRank",
        semanticScore: 0.85,
        graphScore: 0.05,
        finalScore: 0.90,
      },
      {
        toolId: "tool2",
        serverId: "server1",
        toolName: "Tool 2",
        description: "Lower semantic, high PageRank",
        semanticScore: 0.70,
        graphScore: 0.05,
        finalScore: 0.75,
      },
    ];

    const graphEngine = createMockGraphEngine({
      tool1: 0.05, // Low PageRank
      tool2: 0.80, // Very high PageRank
    });

    const ranked = rankCandidates(candidates, [], graphEngine, config);

    // tool2 might rank higher due to very high PageRank
    // tool1: 0.90 * 0.8 + 0.05 * 0.2 = 0.72 + 0.01 = 0.73
    // tool2: 0.75 * 0.8 + 0.80 * 0.2 = 0.60 + 0.16 = 0.76
    assertEquals(ranked[0].toolId, "tool2");
    assertEquals(ranked[1].toolId, "tool1");
  });
});

Deno.test("rankCandidates - Edge Cases", async (t) => {
  await t.step("handles empty candidates array", () => {
    const graphEngine = createMockGraphEngine();
    const ranked = rankCandidates([], [], graphEngine, config);

    assertEquals(ranked.length, 0);
  });

  await t.step("handles single candidate", () => {
    const candidates: HybridSearchResult[] = [{
      toolId: "tool1",
      serverId: "server1",
      toolName: "Tool 1",
      description: "Only tool",
      semanticScore: 0.80,
      graphScore: 0.05,
      finalScore: 0.85,
    }];

    const graphEngine = createMockGraphEngine();
    const ranked = rankCandidates(candidates, [], graphEngine, config);

    assertEquals(ranked.length, 1);
    assertEquals(ranked[0].toolId, "tool1");
  });

  await t.step("handles candidates with zero PageRank", () => {
    const candidates: HybridSearchResult[] = [{
      toolId: "tool1",
      serverId: "server1",
      toolName: "Tool 1",
      description: "First tool",
      semanticScore: 0.80,
      graphScore: 0.05,
      finalScore: 0.85,
    }];

    const graphEngine = createMockGraphEngine({ tool1: 0 });
    const ranked = rankCandidates(candidates, [], graphEngine, config);

    assertEquals(ranked[0].pageRank, 0);
    assertExists(ranked[0].combinedScore);
  });

  await t.step("handles no context tools", () => {
    const candidates: HybridSearchResult[] = [{
      toolId: "tool1",
      serverId: "server1",
      toolName: "Tool 1",
      description: "First tool",
      semanticScore: 0.80,
      graphScore: 0.05,
      finalScore: 0.85,
    }];

    const graphEngine = createMockGraphEngine();
    const ranked = rankCandidates(candidates, [], graphEngine, config);

    assertEquals(ranked[0].adamicAdar, 0);
  });

  await t.step("handles zero Adamic-Adar scores", () => {
    const candidates: HybridSearchResult[] = [{
      toolId: "tool1",
      serverId: "server1",
      toolName: "Tool 1",
      description: "First tool",
      semanticScore: 0.80,
      graphScore: 0.05,
      finalScore: 0.85,
    }];

    const contextTools = ["ctx1", "ctx2"];
    const graphEngine = createMockGraphEngine({}, {
      "tool1-ctx1": 0,
      "tool1-ctx2": 0,
    });

    const ranked = rankCandidates(candidates, contextTools, graphEngine, config);

    assertEquals(ranked[0].adamicAdar, 0);
  });

  await t.step("normalizes Adamic-Adar to max 1.0", () => {
    const candidates: HybridSearchResult[] = [{
      toolId: "tool1",
      serverId: "server1",
      toolName: "Tool 1",
      description: "First tool",
      semanticScore: 0.80,
      graphScore: 0.05,
      finalScore: 0.85,
    }];

    const contextTools = ["ctx1"];
    const graphEngine = createMockGraphEngine({}, {
      "tool1-ctx1": 10.0, // Very high Adamic-Adar
    });

    const ranked = rankCandidates(candidates, contextTools, graphEngine, config);

    // Should be normalized: min(10.0 / 2, 1.0) = 1.0
    assertEquals(ranked[0].adamicAdar, 1.0);
  });
});

Deno.test("extractDependencyPaths - Happy Path", async (t) => {
  await t.step("extracts direct paths (1 hop)", () => {
    const toolIds = ["tool1", "tool2"];
    const paths = {
      "tool1-tool2": ["tool1", "tool2"],
    };

    const graphEngine = createMockGraphEngine({}, {}, paths);
    const result = extractDependencyPaths(toolIds, graphEngine, config);

    assertEquals(result.length, 1);
    assertEquals(result[0].from, "tool1");
    assertEquals(result[0].to, "tool2");
    assertEquals(result[0].hops, 1);
    assertEquals(result[0].path, ["tool1", "tool2"]);
    assertExists(result[0].explanation);
    assertExists(result[0].confidence);
  });

  await t.step("extracts transitive paths (2+ hops)", () => {
    const toolIds = ["tool1", "tool2"];
    const paths = {
      "tool1-tool2": ["tool1", "intermediate", "tool2"],
    };

    const graphEngine = createMockGraphEngine({}, {}, paths);
    const result = extractDependencyPaths(toolIds, graphEngine, config);

    assertEquals(result.length, 1);
    assertEquals(result[0].hops, 2);
    assertEquals(result[0].path.length, 3);
  });

  await t.step("extracts multiple paths between different tools", () => {
    const toolIds = ["tool1", "tool2", "tool3"];
    const paths = {
      "tool1-tool2": ["tool1", "tool2"],
      "tool1-tool3": ["tool1", "tool3"],
      "tool2-tool3": ["tool2", "tool3"],
    };

    const graphEngine = createMockGraphEngine({}, {}, paths);
    const result = extractDependencyPaths(toolIds, graphEngine, config);

    assertEquals(result.length, 3);
  });

  await t.step("only checks from earlier to later tools", () => {
    const toolIds = ["tool1", "tool2", "tool3"];
    const paths = {
      "tool1-tool2": ["tool1", "tool2"],
      "tool1-tool3": ["tool1", "tool3"],
      "tool2-tool3": ["tool2", "tool3"],
      // Reverse paths should not be checked
      "tool2-tool1": ["tool2", "tool1"],
      "tool3-tool1": ["tool3", "tool1"],
      "tool3-tool2": ["tool3", "tool2"],
    };

    const graphEngine = createMockGraphEngine({}, {}, paths);
    const result = extractDependencyPaths(toolIds, graphEngine, config);

    // Should only find 3 forward paths, not 6 total
    assertEquals(result.length, 3);
    assert(result.every((p) => {
      const fromIdx = toolIds.indexOf(p.from);
      const toIdx = toolIds.indexOf(p.to);
      return fromIdx < toIdx;
    }));
  });

  await t.step("filters paths exceeding maxPathLength", () => {
    const toolIds = ["tool1", "tool2", "tool3"];
    const paths = {
      "tool1-tool2": ["tool1", "tool2"], // 1 hop, within limit
      "tool1-tool3": ["tool1", "a", "b", "c", "d", "e", "tool3"], // 6 hops, exceeds limit
      "tool2-tool3": ["tool2", "x", "tool3"], // 2 hops, within limit
    };

    const graphEngine = createMockGraphEngine({}, {}, paths);
    const result = extractDependencyPaths(toolIds, graphEngine, config);

    // Should only include paths within maxPathLength (4)
    assertEquals(result.length, 2);
    assert(result.every((p) => p.path.length <= config.limits.maxPathLength));
  });
});

Deno.test("extractDependencyPaths - Edge Cases", async (t) => {
  await t.step("handles empty toolIds array", () => {
    const graphEngine = createMockGraphEngine();
    const result = extractDependencyPaths([], graphEngine, config);

    assertEquals(result.length, 0);
  });

  await t.step("handles single tool", () => {
    const graphEngine = createMockGraphEngine();
    const result = extractDependencyPaths(["tool1"], graphEngine, config);

    assertEquals(result.length, 0);
  });

  await t.step("handles no paths found", () => {
    const toolIds = ["tool1", "tool2", "tool3"];
    const graphEngine = createMockGraphEngine({}, {}, {});

    const result = extractDependencyPaths(toolIds, graphEngine, config);

    assertEquals(result.length, 0);
  });

  await t.step("handles null paths from graph engine", () => {
    const toolIds = ["tool1", "tool2"];
    const paths = {
      "tool1-tool2": null,
    };

    const graphEngine = createMockGraphEngine({}, {}, paths);
    const result = extractDependencyPaths(toolIds, graphEngine, config);

    assertEquals(result.length, 0);
  });

  await t.step("calculates correct hop count", () => {
    const toolIds = ["tool1", "tool2"];
    const paths = {
      "tool1-tool2": ["tool1", "a", "b", "c", "tool2"],
    };

    const graphEngine = createMockGraphEngine({}, {}, paths);
    const result = extractDependencyPaths(toolIds, graphEngine, config);

    // 5 nodes = 4 hops, but path length is 5 which exceeds maxPathLength of 4
    // So it should be filtered out
    assertEquals(result.length, 0);
  });

  await t.step("handles path at exact maxPathLength boundary", () => {
    const toolIds = ["tool1", "tool2"];
    const maxPathLength = config.limits.maxPathLength; // 4
    // Create path with exactly maxPathLength nodes
    const path = [
      "tool1",
      ...Array.from({ length: maxPathLength - 2 }, (_, i) => `n${i}`),
      "tool2",
    ];

    const paths = {
      "tool1-tool2": path,
    };

    const graphEngine = createMockGraphEngine({}, {}, paths);
    const result = extractDependencyPaths(toolIds, graphEngine, config);

    // Should include path exactly at limit
    assertEquals(result.length, 1);
    assertEquals(result[0].path.length, maxPathLength);
  });

  await t.step("handles many tools efficiently", () => {
    const toolIds = Array.from({ length: 20 }, (_, i) => `tool${i}`);
    const graphEngine = createMockGraphEngine({}, {}, {});

    const result = extractDependencyPaths(toolIds, graphEngine, config);

    // Should complete without error (no paths found)
    assertEquals(result.length, 0);
  });
});

Deno.test("calculateAverageAlpha - Happy Path", async (t) => {
  await t.step("calculates average for single candidate", () => {
    const candidates: CandidateAlpha[] = [{
      toolId: "tool1",
      alpha: 0.75,
      algorithm: "heat_diffusion",
      coldStart: false,
    }];

    const avg = calculateAverageAlpha(candidates, config.defaults.alpha);

    assertEquals(avg, 0.75);
  });

  await t.step("calculates average for multiple candidates", () => {
    const candidates: CandidateAlpha[] = [
      { toolId: "tool1", alpha: 0.50, algorithm: "heat_diffusion", coldStart: false },
      { toolId: "tool2", alpha: 0.75, algorithm: "bayesian", coldStart: false },
      { toolId: "tool3", alpha: 1.00, algorithm: "none", coldStart: true },
    ];

    const avg = calculateAverageAlpha(candidates, config.defaults.alpha);

    const expected = (0.50 + 0.75 + 1.00) / 3;
    assertAlmostEquals(avg, expected, 0.001);
    assertAlmostEquals(avg, 0.75, 0.001);
  });

  await t.step("calculates average for candidates with varying alphas", () => {
    const candidates: CandidateAlpha[] = [
      { toolId: "tool1", alpha: 0.60, algorithm: "heat_diffusion", coldStart: false },
      { toolId: "tool2", alpha: 0.80, algorithm: "bayesian", coldStart: false },
    ];

    const avg = calculateAverageAlpha(candidates, config.defaults.alpha);

    assertAlmostEquals(avg, 0.70, 0.001);
  });

  await t.step("includes all candidates in average", () => {
    const candidates: CandidateAlpha[] = Array.from({ length: 10 }, (_, i) => ({
      toolId: `tool${i}`,
      alpha: 0.50 + i * 0.05,
      algorithm: "heat_diffusion",
      coldStart: false,
    }));

    const avg = calculateAverageAlpha(candidates, config.defaults.alpha);

    const expected = candidates.reduce((sum, c) => sum + c.alpha, 0) / candidates.length;
    assertAlmostEquals(avg, expected, 0.001);
  });
});

Deno.test("calculateAverageAlpha - Edge Cases", async (t) => {
  await t.step("returns default alpha for empty array", () => {
    const avg = calculateAverageAlpha([], config.defaults.alpha);

    assertEquals(avg, config.defaults.alpha);
    assertEquals(avg, 0.75);
  });

  await t.step("returns default alpha for custom default", () => {
    const avg = calculateAverageAlpha([], 0.85);

    assertEquals(avg, 0.85);
  });

  await t.step("handles alpha at minimum boundary (0.5)", () => {
    const candidates: CandidateAlpha[] = [
      { toolId: "tool1", alpha: 0.5, algorithm: "heat_diffusion", coldStart: false },
      { toolId: "tool2", alpha: 0.5, algorithm: "heat_diffusion", coldStart: false },
    ];

    const avg = calculateAverageAlpha(candidates, config.defaults.alpha);

    assertEquals(avg, 0.5);
  });

  await t.step("handles alpha at maximum boundary (1.0)", () => {
    const candidates: CandidateAlpha[] = [
      { toolId: "tool1", alpha: 1.0, algorithm: "none", coldStart: true },
      { toolId: "tool2", alpha: 1.0, algorithm: "none", coldStart: true },
    ];

    const avg = calculateAverageAlpha(candidates, config.defaults.alpha);

    assertEquals(avg, 1.0);
  });

  await t.step("handles mixed cold start and non-cold start", () => {
    const candidates: CandidateAlpha[] = [
      { toolId: "tool1", alpha: 0.60, algorithm: "heat_diffusion", coldStart: false },
      { toolId: "tool2", alpha: 1.00, algorithm: "none", coldStart: true },
    ];

    const avg = calculateAverageAlpha(candidates, config.defaults.alpha);

    assertAlmostEquals(avg, 0.80, 0.001);
  });

  await t.step("handles candidates with same alpha", () => {
    const candidates: CandidateAlpha[] = [
      { toolId: "tool1", alpha: 0.75, algorithm: "bayesian", coldStart: false },
      { toolId: "tool2", alpha: 0.75, algorithm: "bayesian", coldStart: false },
      { toolId: "tool3", alpha: 0.75, algorithm: "bayesian", coldStart: false },
    ];

    const avg = calculateAverageAlpha(candidates, config.defaults.alpha);

    assertEquals(avg, 0.75);
  });

  await t.step("handles very small differences in alpha", () => {
    const candidates: CandidateAlpha[] = [
      { toolId: "tool1", alpha: 0.7501, algorithm: "heat_diffusion", coldStart: false },
      { toolId: "tool2", alpha: 0.7502, algorithm: "heat_diffusion", coldStart: false },
      { toolId: "tool3", alpha: 0.7503, algorithm: "heat_diffusion", coldStart: false },
    ];

    const avg = calculateAverageAlpha(candidates, config.defaults.alpha);

    assertAlmostEquals(avg, 0.7502, 0.0001);
  });
});

// Helper function for assertions
function assert(condition: boolean, message?: string): asserts condition {
  if (!condition) {
    throw new Error(message || "Assertion failed");
  }
}
