/**
 * Capability Prediction Tests
 *
 * Tests for capability prediction functions including local alpha application,
 * episodic adjustment, capability prediction, and DAG injection.
 *
 * @module tests/unit/graphrag/prediction/capabilities.test
 */

import { assertAlmostEquals, assertEquals, assertExists } from "jsr:@std/assert@1";
import {
  adjustConfidenceFromEpisodes,
  applyLocalAlpha,
  type CapabilityPredictionDeps,
  createCapabilityTask,
  getCapabilityToolsUsed,
  injectMatchingCapabilities,
  predictCapabilities,
} from "../../../../src/graphrag/prediction/capabilities.ts";
import type { EpisodeStatsMap } from "../../../../src/graphrag/prediction/types.ts";
import type { Capability } from "../../../../src/capabilities/types.ts";
import type { DAGStructure, PredictedNode } from "../../../../src/graphrag/types.ts";
import { DEFAULT_DAG_SCORING_CONFIG } from "../../../../src/graphrag/dag-scoring-config.ts";
import type { LocalAlphaCalculator, NodeType } from "../../../../src/graphrag/local-alpha.ts";

/**
 * Create mock LocalAlphaCalculator
 */
function createMockAlphaCalculator(alpha = 0.75, algorithm = "heat_diffusion") {
  return {
    getLocalAlphaWithBreakdown: (
      _mode: string,
      _targetId: string,
      _nodeType: NodeType,
      _contextNodes: string[],
    ) => ({
      alpha,
      algorithm,
      breakdown: {},
    }),
  } as any as LocalAlphaCalculator;
}

/**
 * Create mock CapabilityStore
 */
function createMockCapabilityStore(capabilities: Capability[] = []) {
  return {
    searchByContext: async (_contextTools: string[], _limit: number, _threshold: number) => {
      return capabilities.map((cap) => ({
        capability: cap,
        overlapScore: 0.8,
      }));
    },
    findById: async (id: string) => {
      return capabilities.find((c) => c.id === id);
    },
    getDependencies: async (_capId: string, _direction: string) => {
      return [];
    },
  } as any;
}

/**
 * Create mock GraphRAGEngine
 */
function createMockGraphEngine() {
  return {
    getGraphDensity: () => 0.5,
  };
}

/**
 * Create mock capability
 */
function createMockCapability(id: string, overrides: Partial<Capability> = {}): Capability {
  return {
    id,
    codeSnippet: "console.log('test');",
    codeHash: "hash123",
    intentEmbedding: new Float32Array(1024),
    cacheConfig: { ttl_ms: 3600000, cacheable: true },
    usageCount: 10,
    successCount: 8,
    successRate: 0.8,
    avgDurationMs: 100,
    createdAt: new Date(),
    lastUsed: new Date(),
    source: "emergent",
    toolsUsed: ["filesystem:read", "github:create_issue"],
    name: "Test Capability",
    ...overrides,
  };
}

/**
 * Create mock CapabilityPredictionDeps
 */
function createMockDeps(
  overrides: Partial<CapabilityPredictionDeps> = {},
): CapabilityPredictionDeps {
  return {
    capabilityStore: createMockCapabilityStore(),
    graphEngine: createMockGraphEngine() as any,
    algorithmTracer: null,
    localAlphaCalculator: null,
    config: DEFAULT_DAG_SCORING_CONFIG,
    ...overrides,
  };
}

Deno.test("applyLocalAlpha - Alpha Adjustment", async (t) => {
  await t.step("returns unchanged confidence when no calculator provided", () => {
    const result = applyLocalAlpha(
      0.8,
      "test:tool",
      "tool",
      ["context:tool1"],
      null,
      DEFAULT_DAG_SCORING_CONFIG,
    );

    assertEquals(result.confidence, 0.8);
    assertEquals(result.alpha, DEFAULT_DAG_SCORING_CONFIG.defaults.alpha);
    assertEquals(result.algorithm, "none");
  });

  await t.step("applies local alpha adjustment with calculator", () => {
    const calculator = createMockAlphaCalculator(0.75, "heat_diffusion");

    const result = applyLocalAlpha(
      0.8,
      "test:tool",
      "tool",
      ["context:tool1"],
      calculator,
      DEFAULT_DAG_SCORING_CONFIG,
    );

    // Formula: adjustedConfidence = baseConfidence * (1.5 - alpha)
    // 0.8 * (1.5 - 0.75) = 0.8 * 0.75 = 0.6
    assertAlmostEquals(result.confidence, 0.6, 0.01);
    assertEquals(result.alpha, 0.75);
    assertEquals(result.algorithm, "heat_diffusion");
  });

  await t.step("applies alpha=0.5 (full trust in graph, no adjustment)", () => {
    const calculator = createMockAlphaCalculator(0.5, "heat_diffusion");

    const result = applyLocalAlpha(
      0.8,
      "test:tool",
      "tool",
      ["context:tool1"],
      calculator,
      DEFAULT_DAG_SCORING_CONFIG,
    );

    // graphTrustFactor = 1.5 - 0.5 = 1.0 (no adjustment)
    assertEquals(result.confidence, 0.8);
    assertEquals(result.alpha, 0.5);
  });

  await t.step("applies alpha=1.0 (low trust in graph, 50% reduction)", () => {
    const calculator = createMockAlphaCalculator(1.0, "bayesian");

    const result = applyLocalAlpha(
      0.8,
      "test:tool",
      "tool",
      ["context:tool1"],
      calculator,
      DEFAULT_DAG_SCORING_CONFIG,
    );

    // graphTrustFactor = 1.5 - 1.0 = 0.5 (50% reduction)
    assertEquals(result.confidence, 0.4);
    assertEquals(result.alpha, 1.0);
    assertEquals(result.algorithm, "bayesian");
  });

  await t.step("respects maxConfidence cap", () => {
    const calculator = createMockAlphaCalculator(0.5, "heat_diffusion");

    const result = applyLocalAlpha(
      1.2, // Above max
      "test:tool",
      "tool",
      ["context:tool1"],
      calculator,
      DEFAULT_DAG_SCORING_CONFIG,
    );

    // Should be capped at maxConfidence
    assertEquals(result.confidence, DEFAULT_DAG_SCORING_CONFIG.caps.maxConfidence);
  });

  await t.step("handles zero base confidence", () => {
    const calculator = createMockAlphaCalculator(0.75, "heat_diffusion");

    const result = applyLocalAlpha(
      0.0,
      "test:tool",
      "tool",
      ["context:tool1"],
      calculator,
      DEFAULT_DAG_SCORING_CONFIG,
    );

    assertEquals(result.confidence, 0.0);
  });

  await t.step("handles empty context nodes", () => {
    const calculator = createMockAlphaCalculator(0.75, "heat_diffusion");

    const result = applyLocalAlpha(
      0.8,
      "test:tool",
      "tool",
      [],
      calculator,
      DEFAULT_DAG_SCORING_CONFIG,
    );

    assertEquals(result.alpha, 0.75);
    assertExists(result.confidence);
  });
});

Deno.test("adjustConfidenceFromEpisodes - Episodic Learning", async (t) => {
  await t.step("returns unchanged confidence when no episode stats", () => {
    const episodeStats: EpisodeStatsMap = new Map();

    const result = adjustConfidenceFromEpisodes(
      0.7,
      "test:tool",
      episodeStats,
      DEFAULT_DAG_SCORING_CONFIG,
    );

    assertExists(result);
    assertEquals(result.confidence, 0.7);
    assertEquals(result.adjustment, 0);
  });

  await t.step("returns unchanged confidence when stats total is zero", () => {
    const episodeStats: EpisodeStatsMap = new Map([
      [
        "test:tool",
        {
          total: 0,
          successes: 0,
          failures: 0,
          successRate: 0,
          failureRate: 0,
        },
      ],
    ]);

    const result = adjustConfidenceFromEpisodes(
      0.7,
      "test:tool",
      episodeStats,
      DEFAULT_DAG_SCORING_CONFIG,
    );

    assertExists(result);
    assertEquals(result.confidence, 0.7);
    assertEquals(result.adjustment, 0);
  });

  await t.step("excludes tool with high failure rate", () => {
    const episodeStats: EpisodeStatsMap = new Map([
      [
        "test:tool",
        {
          total: 10,
          successes: 3,
          failures: 7,
          successRate: 0.3,
          failureRate: 0.7,
        },
      ],
    ]);

    const result = adjustConfidenceFromEpisodes(
      0.7,
      "test:tool",
      episodeStats,
      DEFAULT_DAG_SCORING_CONFIG,
    );

    // failureRate 0.7 > failureExclusionRate 0.5 (from config)
    assertEquals(result, null);
  });

  await t.step("boosts confidence for successful patterns", () => {
    const episodeStats: EpisodeStatsMap = new Map([
      [
        "test:tool",
        {
          total: 10,
          successes: 9,
          failures: 1,
          successRate: 0.9,
          failureRate: 0.1,
        },
      ],
    ]);

    const result = adjustConfidenceFromEpisodes(
      0.7,
      "test:tool",
      episodeStats,
      DEFAULT_DAG_SCORING_CONFIG,
    );

    assertExists(result);
    // boost = min(0.15, 0.9 * 0.20) = min(0.15, 0.18) = 0.15
    // penalty = min(0.15, 0.1 * 0.25) = min(0.15, 0.025) = 0.025
    // adjustment = 0.15 - 0.025 = 0.125
    // confidence = 0.7 + 0.125 = 0.825
    assertEquals(result.confidence, 0.825);
    assertEquals(result.adjustment, 0.125);
  });

  await t.step("penalizes confidence for failed patterns", () => {
    const episodeStats: EpisodeStatsMap = new Map([
      [
        "test:tool",
        {
          total: 10,
          successes: 6,
          failures: 4,
          successRate: 0.6,
          failureRate: 0.4,
        },
      ],
    ]);

    const result = adjustConfidenceFromEpisodes(
      0.7,
      "test:tool",
      episodeStats,
      DEFAULT_DAG_SCORING_CONFIG,
    );

    assertExists(result);
    // boost = min(0.15, 0.6 * 0.20) = 0.12
    // penalty = min(0.15, 0.4 * 0.25) = 0.10
    // adjustment = 0.12 - 0.10 = 0.02
    // confidence = 0.7 + 0.02 = 0.72
    assertAlmostEquals(result.confidence, 0.72, 0.01);
    assertAlmostEquals(result.adjustment, 0.02, 0.01);
  });

  await t.step("clamps adjusted confidence to [0, 1]", () => {
    const episodeStats: EpisodeStatsMap = new Map([
      [
        "test:tool",
        {
          total: 10,
          successes: 10,
          failures: 0,
          successRate: 1.0,
          failureRate: 0.0,
        },
      ],
    ]);

    // Start with high confidence
    const result = adjustConfidenceFromEpisodes(
      0.95,
      "test:tool",
      episodeStats,
      DEFAULT_DAG_SCORING_CONFIG,
    );

    assertExists(result);
    // Should be clamped to 1.0
    assertEquals(result.confidence <= 1.0, true);
  });

  await t.step("respects boost and penalty caps", () => {
    const episodeStats: EpisodeStatsMap = new Map([
      [
        "test:tool",
        {
          total: 100,
          successes: 100,
          failures: 0,
          successRate: 1.0,
          failureRate: 0.0,
        },
      ],
    ]);

    const result = adjustConfidenceFromEpisodes(
      0.5,
      "test:tool",
      episodeStats,
      DEFAULT_DAG_SCORING_CONFIG,
    );

    assertExists(result);
    // boost = min(successBoostCap=0.15, 1.0 * 0.20) = 0.15
    // adjustment should be capped at 0.15
    assertEquals(result.adjustment, 0.15);
    assertEquals(result.confidence, 0.65);
  });
});

Deno.test("predictCapabilities - Capability Prediction", async (t) => {
  await t.step("returns empty array when no capability store", async () => {
    const deps = createMockDeps({ capabilityStore: null });

    const predictions = await predictCapabilities(
      ["filesystem:read"],
      new Set(),
      new Map(),
      new Map(),
      deps,
      async () => [],
    );

    assertEquals(predictions, []);
  });

  await t.step("returns empty array when no context tools", async () => {
    const deps = createMockDeps();

    const predictions = await predictCapabilities(
      [],
      new Set(),
      new Map(),
      new Map(),
      deps,
      async () => [],
    );

    assertEquals(predictions, []);
  });

  await t.step("predicts capability from context tools", async () => {
    const capability = createMockCapability("cap-123");
    const capStore = createMockCapabilityStore([capability]);
    const deps = createMockDeps({ capabilityStore: capStore as any });

    const predictions = await predictCapabilities(
      ["filesystem:read", "github:create_issue"],
      new Set(),
      new Map(),
      new Map(),
      deps,
      async () => [],
    );

    assertEquals(predictions.length, 1);
    assertEquals(predictions[0].toolId, "capability:cap-123");
    assertEquals(predictions[0].source, "capability");
    assertEquals(predictions[0].capabilityId, "cap-123");
    assertExists(predictions[0].confidence);
    assertExists(predictions[0].reasoning);
  });

  await t.step("skips already seen capabilities", async () => {
    const capability = createMockCapability("cap-123");
    const capStore = createMockCapabilityStore([capability]);
    const deps = createMockDeps({ capabilityStore: capStore as any });
    const seenTools = new Set(["capability:cap-123"]);

    const predictions = await predictCapabilities(
      ["filesystem:read"],
      seenTools,
      new Map(),
      new Map(),
      deps,
      async () => [],
    );

    assertEquals(predictions, []);
  });

  await t.step("applies cluster boost to discovery score", async () => {
    const capability = createMockCapability("cap-123");
    const capStore = createMockCapabilityStore([capability]);
    const deps = createMockDeps({ capabilityStore: capStore as any });
    const clusterBoosts = new Map([["cap-123", 0.5]]);

    const predictions = await predictCapabilities(
      ["filesystem:read"],
      new Set(),
      new Map(),
      clusterBoosts,
      deps,
      async () => [],
    );

    assertEquals(predictions.length, 1);
    // Reasoning should mention cluster boost
    assertEquals(predictions[0].reasoning.includes("cluster boost"), true);
  });

  await t.step("applies episodic adjustments", async () => {
    const capability = createMockCapability("cap-123");
    const capStore = createMockCapabilityStore([capability]);
    const deps = createMockDeps({ capabilityStore: capStore as any });
    const episodeStats: EpisodeStatsMap = new Map([
      [
        "capability:cap-123",
        {
          total: 10,
          successes: 9,
          failures: 1,
          successRate: 0.9,
          failureRate: 0.1,
        },
      ],
    ]);

    const predictions = await predictCapabilities(
      ["filesystem:read"],
      new Set(),
      episodeStats,
      new Map(),
      deps,
      async () => [],
    );

    assertEquals(predictions.length, 1);
    // Confidence should be adjusted based on high success rate
    assertExists(predictions[0].confidence);
  });

  await t.step("excludes capabilities with high failure rates", async () => {
    const capability = createMockCapability("cap-123");
    const capStore = createMockCapabilityStore([capability]);
    const deps = createMockDeps({ capabilityStore: capStore as any });
    const episodeStats: EpisodeStatsMap = new Map([
      [
        "capability:cap-123",
        {
          total: 10,
          successes: 3,
          failures: 7,
          successRate: 0.3,
          failureRate: 0.7,
        },
      ],
    ]);

    const predictions = await predictCapabilities(
      ["filesystem:read"],
      new Set(),
      episodeStats,
      new Map(),
      deps,
      async () => [],
    );

    // Should be excluded due to high failure rate
    assertEquals(predictions, []);
  });

  await t.step("applies local alpha adjustment when calculator provided", async () => {
    const capability = createMockCapability("cap-123");
    const capStore = createMockCapabilityStore([capability]);
    const calculator = createMockAlphaCalculator(0.8, "heat_hierarchical");
    const deps = createMockDeps({
      capabilityStore: capStore as any,
      localAlphaCalculator: calculator,
    });

    const predictions = await predictCapabilities(
      ["filesystem:read"],
      new Set(),
      new Map(),
      new Map(),
      deps,
      async () => [],
    );

    assertEquals(predictions.length, 1);
    // Reasoning should mention alpha
    assertEquals(predictions[0].reasoning.includes("α="), true);
  });

  await t.step("calls suggestAlternatives for each capability", async () => {
    const capability = createMockCapability("cap-123");
    const capStore = createMockCapabilityStore([capability]);
    const deps = createMockDeps({ capabilityStore: capStore as any });
    let suggestAlternativesCalled = false;

    const predictions = await predictCapabilities(
      ["filesystem:read"],
      new Set(),
      new Map(),
      new Map(),
      deps,
      async () => {
        suggestAlternativesCalled = true;
        return [];
      },
    );

    assertEquals(predictions.length, 1);
    assertEquals(suggestAlternativesCalled, true);
  });

  await t.step("includes alternative predictions in results", async () => {
    const capability = createMockCapability("cap-123");
    const capStore = createMockCapabilityStore([capability]);
    const deps = createMockDeps({ capabilityStore: capStore as any });
    const alternativePrediction: PredictedNode = {
      toolId: "capability:cap-456",
      confidence: 0.6,
      reasoning: "Alternative capability",
      source: "capability",
      capabilityId: "cap-456",
    };

    const predictions = await predictCapabilities(
      ["filesystem:read"],
      new Set(),
      new Map(),
      new Map(),
      deps,
      async () => [alternativePrediction],
    );

    assertEquals(predictions.length, 2);
    assertEquals(predictions[1].toolId, "capability:cap-456");
  });

  await t.step("handles capability store errors gracefully", async () => {
    const capStore = {
      searchByContext: async () => {
        throw new Error("Database connection failed");
      },
    };
    const deps = createMockDeps({ capabilityStore: capStore as any });

    const predictions = await predictCapabilities(
      ["filesystem:read"],
      new Set(),
      new Map(),
      new Map(),
      deps,
      async () => [],
    );

    // Should return empty array on error
    assertEquals(predictions, []);
  });
});

Deno.test("getCapabilityToolsUsed - Tool Extraction", async (t) => {
  await t.step("extracts toolsUsed from capability", () => {
    const capability = createMockCapability("cap-123", {
      toolsUsed: ["filesystem:read", "github:create_issue"],
    });

    const tools = getCapabilityToolsUsed(capability);

    assertEquals(tools, ["filesystem:read", "github:create_issue"]);
  });

  await t.step("returns empty array when toolsUsed is undefined", () => {
    const capability = createMockCapability("cap-123", {
      toolsUsed: undefined,
    });

    const tools = getCapabilityToolsUsed(capability);

    assertEquals(tools, []);
  });

  await t.step("returns empty array when toolsUsed is empty", () => {
    const capability = createMockCapability("cap-123", {
      toolsUsed: [],
    });

    const tools = getCapabilityToolsUsed(capability);

    assertEquals(tools, []);
  });
});

Deno.test("createCapabilityTask - Task Creation", async (t) => {
  await t.step("creates capability task with correct structure", () => {
    const capability = createMockCapability("cap-123", {
      name: "Test Capability",
      codeSnippet: "console.log('hello');",
      toolsUsed: ["filesystem:read"],
    });
    const dag: DAGStructure = {
      tasks: [
        {
          id: "task-1",
          tool: "filesystem:read",
          arguments: {},
          dependsOn: [],
        },
      ],
    };

    const task = createCapabilityTask(capability, dag);

    assertEquals(task.type, "capability");
    assertEquals(task.tool, "Test Capability");
    assertEquals(task.capabilityId, "cap-123");
    assertEquals(task.code, "console.log('hello');");
    assertExists(task.id);
    assertEquals(task.id.startsWith("cap_"), true);
  });

  await t.step("creates dependencies based on tools_used", () => {
    const capability = createMockCapability("cap-123", {
      toolsUsed: ["filesystem:read", "github:create_issue"],
    });
    const dag: DAGStructure = {
      tasks: [
        {
          id: "task-1",
          tool: "filesystem:read",
          arguments: {},
          dependsOn: [],
        },
        {
          id: "task-2",
          tool: "github:create_issue",
          arguments: {},
          dependsOn: ["task-1"],
        },
        {
          id: "task-3",
          tool: "other:tool",
          arguments: {},
          dependsOn: [],
        },
      ],
    };

    const task = createCapabilityTask(capability, dag);

    assertEquals(task.dependsOn.length, 2);
    assertEquals(task.dependsOn.includes("task-1"), true);
    assertEquals(task.dependsOn.includes("task-2"), true);
    assertEquals(task.dependsOn.includes("task-3"), false);
  });

  await t.step("depends on last task when no matching tools", () => {
    const capability = createMockCapability("cap-123", {
      toolsUsed: ["unrelated:tool"],
    });
    const dag: DAGStructure = {
      tasks: [
        {
          id: "task-1",
          tool: "filesystem:read",
          arguments: {},
          dependsOn: [],
        },
        {
          id: "task-2",
          tool: "github:create_issue",
          arguments: {},
          dependsOn: ["task-1"],
        },
      ],
    };

    const task = createCapabilityTask(capability, dag);

    // Should depend on the last task (sequential insertion)
    assertEquals(task.dependsOn, ["task-2"]);
  });

  await t.step("has no dependencies for empty DAG", () => {
    const capability = createMockCapability("cap-123");
    const dag: DAGStructure = { tasks: [] };

    const task = createCapabilityTask(capability, dag);

    assertEquals(task.dependsOn, []);
  });

  await t.step("uses capability ID prefix in tool name when name is null", () => {
    const capability = createMockCapability("cap-abcd1234", {
      name: undefined,
    });
    const dag: DAGStructure = { tasks: [] };

    const task = createCapabilityTask(capability, dag);

    assertEquals(task.tool, "capability_cap-abcd");
  });
});

Deno.test("injectMatchingCapabilities - DAG Injection", async (t) => {
  await t.step("does nothing when no capability store", async () => {
    const deps = createMockDeps({ capabilityStore: null });
    const dag: DAGStructure = { tasks: [] };

    await injectMatchingCapabilities(dag, ["filesystem:read"], new Map(), deps);

    assertEquals(dag.tasks.length, 0);
  });

  await t.step("does nothing when no context tools", async () => {
    const deps = createMockDeps();
    const dag: DAGStructure = { tasks: [] };

    await injectMatchingCapabilities(dag, [], new Map(), deps);

    assertEquals(dag.tasks.length, 0);
  });

  await t.step("injects matching capability into DAG", async () => {
    const capability = createMockCapability("cap-123", {
      name: "Test Capability",
    });
    const capStore = createMockCapabilityStore([capability]);
    const deps = createMockDeps({ capabilityStore: capStore as any });
    const dag: DAGStructure = {
      tasks: [
        {
          id: "task-1",
          tool: "filesystem:read",
          arguments: {},
          dependsOn: [],
        },
      ],
    };

    await injectMatchingCapabilities(
      dag,
      ["filesystem:read"],
      new Map(),
      deps,
    );

    assertEquals(dag.tasks.length, 2);
    assertEquals(dag.tasks[1].type, "capability");
    assertEquals(dag.tasks[1].tool, "Test Capability");
  });

  await t.step("skips low-scoring capabilities", async () => {
    const capability = createMockCapability("cap-123");
    const capStore = {
      searchByContext: async () => [
        {
          capability,
          overlapScore: 0.1, // Low score
        },
      ],
    };
    const deps = createMockDeps({ capabilityStore: capStore as any });
    const dag: DAGStructure = { tasks: [] };

    await injectMatchingCapabilities(
      dag,
      ["filesystem:read"],
      new Map(),
      deps,
    );

    // Low-scoring capability should be skipped
    assertEquals(dag.tasks.length, 0);
  });

  await t.step("applies cluster boosts to score", async () => {
    const capability = createMockCapability("cap-123");
    const capStore = {
      searchByContext: async () => [
        {
          capability,
          overlapScore: 0.35, // Below threshold alone
        },
      ],
    };
    const deps = createMockDeps({ capabilityStore: capStore as any });
    const dag: DAGStructure = { tasks: [] };
    const clusterBoosts = new Map([["cap-123", 0.2]]);

    await injectMatchingCapabilities(
      dag,
      ["filesystem:read"],
      clusterBoosts,
      deps,
    );

    // With boost: 0.35 * (1 + 0.2) = 0.42 > finalScoreMinimum (0.4)
    assertEquals(dag.tasks.length, 1);
  });

  await t.step("handles capability store errors gracefully", async () => {
    const capStore = {
      searchByContext: async () => {
        throw new Error("Database error");
      },
    };
    const deps = createMockDeps({ capabilityStore: capStore as any });
    const dag: DAGStructure = { tasks: [] };

    // Should not throw
    await injectMatchingCapabilities(
      dag,
      ["filesystem:read"],
      new Map(),
      deps,
    );

    assertEquals(dag.tasks.length, 0);
  });

  await t.step("injects multiple capabilities", async () => {
    const cap1 = createMockCapability("cap-123", { name: "Cap 1" });
    const cap2 = createMockCapability("cap-456", { name: "Cap 2" });
    const capStore = createMockCapabilityStore([cap1, cap2]);
    const deps = createMockDeps({ capabilityStore: capStore as any });
    const dag: DAGStructure = { tasks: [] };

    await injectMatchingCapabilities(
      dag,
      ["filesystem:read"],
      new Map(),
      deps,
    );

    assertEquals(dag.tasks.length, 2);
    assertEquals(dag.tasks[0].tool, "Cap 1");
    assertEquals(dag.tasks[1].tool, "Cap 2");
  });
});
