/**
 * Alternative Suggestions Tests
 *
 * Tests for alternative capability suggestion logic including dependency
 * edge traversal and episodic filtering.
 *
 * @module tests/unit/graphrag/prediction/alternatives.test
 */

import { assertAlmostEquals, assertEquals, assertExists } from "jsr:@std/assert@1";
import {
  type AlternativeSuggestionDeps,
  suggestAlternatives,
} from "../../../../src/graphrag/prediction/alternatives.ts";
import type { Capability, CapabilityDependency } from "../../../../src/capabilities/types.ts";
import type { EpisodeStatsMap } from "../../../../src/graphrag/prediction/types.ts";
import { DEFAULT_DAG_SCORING_CONFIG } from "../../../../src/graphrag/dag-scoring-config.ts";

/**
 * Create mock CapabilityStore
 */
function createMockCapabilityStore(
  dependencies: CapabilityDependency[] = [],
  alternativeCapabilities: Capability[] = [],
) {
  return {
    getDependencies: async (_capId: string, _direction: string) => {
      return dependencies;
    },
    findById: async (id: string) => {
      return alternativeCapabilities.find((c) => c.id === id);
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
    toolsUsed: ["filesystem:read"],
    name: "Test Capability",
    ...overrides,
  };
}

/**
 * Create mock capability dependency
 */
function createMockDependency(
  from: string,
  to: string,
  edgeType: "alternative" | "contains" | "sequence" | "dependency",
): CapabilityDependency {
  return {
    fromCapabilityId: from,
    toCapabilityId: to,
    observedCount: 5,
    confidenceScore: 0.8,
    edgeType,
    edgeSource: "observed",
    createdAt: new Date(),
    lastObserved: new Date(),
  };
}

/**
 * Create mock AlternativeSuggestionDeps
 */
function createMockDeps(
  overrides: Partial<AlternativeSuggestionDeps> = {},
): AlternativeSuggestionDeps {
  return {
    capabilityStore: createMockCapabilityStore(),
    graphEngine: createMockGraphEngine() as any,
    algorithmTracer: null,
    config: DEFAULT_DAG_SCORING_CONFIG,
    ...overrides,
  };
}

Deno.test("suggestAlternatives - Alternative Discovery", async (t) => {
  await t.step("returns empty array when no capability store", async () => {
    const deps = createMockDeps({ capabilityStore: null });
    const matchedCapability = createMockCapability("cap-123");

    const alternatives = await suggestAlternatives(
      matchedCapability,
      0.8,
      new Set(),
      new Map(),
      deps,
    );

    assertEquals(alternatives, []);
  });

  await t.step("returns empty array when no alternative edges exist", async () => {
    const capStore = createMockCapabilityStore([], []);
    const deps = createMockDeps({ capabilityStore: capStore as any });
    const matchedCapability = createMockCapability("cap-123");

    const alternatives = await suggestAlternatives(
      matchedCapability,
      0.8,
      new Set(),
      new Map(),
      deps,
    );

    assertEquals(alternatives, []);
  });

  await t.step("suggests alternative capability (outbound edge)", async () => {
    const matchedCap = createMockCapability("cap-123");
    const alternativeCap = createMockCapability("cap-456", {
      name: "Alternative Capability",
      successRate: 0.85,
    });

    const dependency = createMockDependency("cap-123", "cap-456", "alternative");
    const capStore = createMockCapabilityStore([dependency], [alternativeCap]);
    const deps = createMockDeps({ capabilityStore: capStore as any });

    const alternatives = await suggestAlternatives(
      matchedCap,
      0.8,
      new Set(),
      new Map(),
      deps,
    );

    assertEquals(alternatives.length, 1);
    assertEquals(alternatives[0].toolId, "capability:cap-456");
    assertEquals(alternatives[0].source, "capability");
    assertEquals(alternatives[0].capabilityId, "cap-456");
    assertExists(alternatives[0].reasoning);
    assertEquals(alternatives[0].reasoning.includes("Alternative to"), true);
  });

  await t.step("suggests alternative capability (inbound edge)", async () => {
    const matchedCap = createMockCapability("cap-123");
    const alternativeCap = createMockCapability("cap-456", {
      name: "Alternative Capability",
      successRate: 0.85,
    });

    // Edge goes from alternative TO matched (inbound)
    const dependency = createMockDependency("cap-456", "cap-123", "alternative");
    const capStore = createMockCapabilityStore([dependency], [alternativeCap]);
    const deps = createMockDeps({ capabilityStore: capStore as any });

    const alternatives = await suggestAlternatives(
      matchedCap,
      0.8,
      new Set(),
      new Map(),
      deps,
    );

    assertEquals(alternatives.length, 1);
    assertEquals(alternatives[0].toolId, "capability:cap-456");
  });

  await t.step("filters out non-alternative edge types", async () => {
    const matchedCap = createMockCapability("cap-123");
    const otherCap = createMockCapability("cap-456", { successRate: 0.85 });

    const sequenceDep = createMockDependency("cap-123", "cap-456", "sequence");
    const containsDep = createMockDependency("cap-123", "cap-789", "contains");
    const capStore = createMockCapabilityStore([sequenceDep, containsDep], [otherCap]);
    const deps = createMockDeps({ capabilityStore: capStore as any });

    const alternatives = await suggestAlternatives(
      matchedCap,
      0.8,
      new Set(),
      new Map(),
      deps,
    );

    // Non-alternative edges should be filtered out
    assertEquals(alternatives, []);
  });

  await t.step("skips already seen alternatives", async () => {
    const matchedCap = createMockCapability("cap-123");
    const alternativeCap = createMockCapability("cap-456", { successRate: 0.85 });

    const dependency = createMockDependency("cap-123", "cap-456", "alternative");
    const capStore = createMockCapabilityStore([dependency], [alternativeCap]);
    const deps = createMockDeps({ capabilityStore: capStore as any });
    const seenTools = new Set(["capability:cap-456"]);

    const alternatives = await suggestAlternatives(
      matchedCap,
      0.8,
      seenTools,
      new Map(),
      deps,
    );

    assertEquals(alternatives, []);
  });

  await t.step("skips alternative if capability not found in store", async () => {
    const matchedCap = createMockCapability("cap-123");

    const dependency = createMockDependency("cap-123", "cap-456", "alternative");
    const capStore = createMockCapabilityStore([dependency], []); // No capabilities
    const deps = createMockDeps({ capabilityStore: capStore as any });

    const alternatives = await suggestAlternatives(
      matchedCap,
      0.8,
      new Set(),
      new Map(),
      deps,
    );

    assertEquals(alternatives, []);
  });

  await t.step("skips alternatives with low success rate", async () => {
    const matchedCap = createMockCapability("cap-123");
    const alternativeCap = createMockCapability("cap-456", {
      successRate: 0.5, // Below threshold (0.7)
    });

    const dependency = createMockDependency("cap-123", "cap-456", "alternative");
    const capStore = createMockCapabilityStore([dependency], [alternativeCap]);
    const deps = createMockDeps({ capabilityStore: capStore as any });

    const alternatives = await suggestAlternatives(
      matchedCap,
      0.8,
      new Set(),
      new Map(),
      deps,
    );

    // Should be filtered out due to low success rate
    assertEquals(alternatives, []);
  });

  await t.step("applies score multiplier to alternative confidence", async () => {
    const matchedCap = createMockCapability("cap-123");
    const alternativeCap = createMockCapability("cap-456", {
      successRate: 0.85,
    });

    const dependency = createMockDependency("cap-123", "cap-456", "alternative");
    const capStore = createMockCapabilityStore([dependency], [alternativeCap]);
    const deps = createMockDeps({ capabilityStore: capStore as any });

    const alternatives = await suggestAlternatives(
      matchedCap,
      0.8, // Matched score
      new Set(),
      new Map(),
      deps,
    );

    assertEquals(alternatives.length, 1);
    // baseConfidence = 0.8 * 0.90 (scoreMultiplier) = 0.72
    // After episodic adjustment (no stats), should be 0.72
    assertAlmostEquals(alternatives[0].confidence, 0.72, 0.01);
  });

  await t.step("applies episodic adjustments to alternative", async () => {
    const matchedCap = createMockCapability("cap-123");
    const alternativeCap = createMockCapability("cap-456", {
      successRate: 0.85,
    });

    const dependency = createMockDependency("cap-123", "cap-456", "alternative");
    const capStore = createMockCapabilityStore([dependency], [alternativeCap]);
    const deps = createMockDeps({ capabilityStore: capStore as any });

    const episodeStats: EpisodeStatsMap = new Map([
      [
        "capability:cap-456",
        {
          total: 10,
          successes: 9,
          failures: 1,
          successRate: 0.9,
          failureRate: 0.1,
        },
      ],
    ]);

    const alternatives = await suggestAlternatives(
      matchedCap,
      0.8,
      new Set(),
      episodeStats,
      deps,
    );

    assertEquals(alternatives.length, 1);
    // Should have episodic boost applied
    assertExists(alternatives[0].confidence);
    // baseConfidence = 0.8 * 0.90 = 0.72
    // With episodic boost, should be higher
    assertEquals(alternatives[0].confidence > 0.72, true);
  });

  await t.step("excludes alternatives with high failure rate", async () => {
    const matchedCap = createMockCapability("cap-123");
    const alternativeCap = createMockCapability("cap-456", {
      successRate: 0.85, // Store success rate is good
    });

    const dependency = createMockDependency("cap-123", "cap-456", "alternative");
    const capStore = createMockCapabilityStore([dependency], [alternativeCap]);
    const deps = createMockDeps({ capabilityStore: capStore as any });

    const episodeStats: EpisodeStatsMap = new Map([
      [
        "capability:cap-456",
        {
          total: 10,
          successes: 3,
          failures: 7,
          successRate: 0.3,
          failureRate: 0.7, // High failure rate
        },
      ],
    ]);

    const alternatives = await suggestAlternatives(
      matchedCap,
      0.8,
      new Set(),
      episodeStats,
      deps,
    );

    // Should be excluded due to high failure rate in episodes
    assertEquals(alternatives, []);
  });

  await t.step("handles multiple alternative edges", async () => {
    const matchedCap = createMockCapability("cap-123");
    const alt1 = createMockCapability("cap-456", {
      name: "Alt 1",
      successRate: 0.85,
    });
    const alt2 = createMockCapability("cap-789", {
      name: "Alt 2",
      successRate: 0.90,
    });

    const dep1 = createMockDependency("cap-123", "cap-456", "alternative");
    const dep2 = createMockDependency("cap-123", "cap-789", "alternative");
    const capStore = createMockCapabilityStore([dep1, dep2], [alt1, alt2]);
    const deps = createMockDeps({ capabilityStore: capStore as any });

    const alternatives = await suggestAlternatives(
      matchedCap,
      0.8,
      new Set(),
      new Map(),
      deps,
    );

    assertEquals(alternatives.length, 2);
    assertEquals(alternatives[0].toolId, "capability:cap-456");
    assertEquals(alternatives[1].toolId, "capability:cap-789");
  });

  await t.step("marks alternatives as seen after suggestion", async () => {
    const matchedCap = createMockCapability("cap-123");
    const alternativeCap = createMockCapability("cap-456", {
      successRate: 0.85,
    });

    const dependency = createMockDependency("cap-123", "cap-456", "alternative");
    const capStore = createMockCapabilityStore([dependency], [alternativeCap]);
    const deps = createMockDeps({ capabilityStore: capStore as any });
    const seenTools = new Set<string>();

    await suggestAlternatives(
      matchedCap,
      0.8,
      seenTools,
      new Map(),
      deps,
    );

    // Alternative should be marked as seen
    assertEquals(seenTools.has("capability:cap-456"), true);
  });

  await t.step("includes success rate in reasoning", async () => {
    const matchedCap = createMockCapability("cap-123", {
      name: "Original Capability",
    });
    const alternativeCap = createMockCapability("cap-456", {
      name: "Alternative Capability",
      successRate: 0.85,
    });

    const dependency = createMockDependency("cap-123", "cap-456", "alternative");
    const capStore = createMockCapabilityStore([dependency], [alternativeCap]);
    const deps = createMockDeps({ capabilityStore: capStore as any });

    const alternatives = await suggestAlternatives(
      matchedCap,
      0.8,
      new Set(),
      new Map(),
      deps,
    );

    assertEquals(alternatives.length, 1);
    // Reasoning should mention success rate
    assertEquals(alternatives[0].reasoning.includes("85% success rate"), true);
    assertEquals(alternatives[0].reasoning.includes("Alternative to"), true);
  });

  await t.step("handles errors gracefully", async () => {
    const capStore = {
      getDependencies: async () => {
        throw new Error("Database connection failed");
      },
    };
    const deps = createMockDeps({ capabilityStore: capStore as any });
    const matchedCapability = createMockCapability("cap-123");

    const alternatives = await suggestAlternatives(
      matchedCapability,
      0.8,
      new Set(),
      new Map(),
      deps,
    );

    // Should return empty array on error
    assertEquals(alternatives, []);
  });
});

Deno.test("suggestAlternatives - ADR-042 Compliance", async (t) => {
  await t.step("uses alternative edges for symmetric relationships", async () => {
    const matchedCap = createMockCapability("cap-123");
    const alternativeCap = createMockCapability("cap-456", {
      successRate: 0.85,
    });

    // Test both directions of the symmetric relationship
    const dependency = createMockDependency("cap-123", "cap-456", "alternative");
    const capStore = createMockCapabilityStore([dependency], [alternativeCap]);
    const deps = createMockDeps({ capabilityStore: capStore as any });

    const alternatives = await suggestAlternatives(
      matchedCap,
      0.8,
      new Set(),
      new Map(),
      deps,
    );

    assertEquals(alternatives.length, 1);
    assertEquals(alternatives[0].source, "capability");
  });

  await t.step("filters alternatives by success rate threshold", async () => {
    const matchedCap = createMockCapability("cap-123");
    const goodAlt = createMockCapability("cap-456", {
      successRate: 0.75, // Above threshold (0.70)
    });
    const badAlt = createMockCapability("cap-789", {
      successRate: 0.65, // Below threshold (0.70)
    });

    const dep1 = createMockDependency("cap-123", "cap-456", "alternative");
    const dep2 = createMockDependency("cap-123", "cap-789", "alternative");
    const capStore = createMockCapabilityStore([dep1, dep2], [goodAlt, badAlt]);
    const deps = createMockDeps({ capabilityStore: capStore as any });

    const alternatives = await suggestAlternatives(
      matchedCap,
      0.8,
      new Set(),
      new Map(),
      deps,
    );

    // Only the good alternative should be suggested
    assertEquals(alternatives.length, 1);
    assertEquals(alternatives[0].toolId, "capability:cap-456");
  });

  await t.step("reduces score by multiplier (slight reduction)", async () => {
    const matchedCap = createMockCapability("cap-123");
    const alternativeCap = createMockCapability("cap-456", {
      successRate: 0.85,
    });

    const dependency = createMockDependency("cap-123", "cap-456", "alternative");
    const capStore = createMockCapabilityStore([dependency], [alternativeCap]);
    const deps = createMockDeps({ capabilityStore: capStore as any });

    const matchedScore = 0.8;
    const alternatives = await suggestAlternatives(
      matchedCap,
      matchedScore,
      new Set(),
      new Map(),
      deps,
    );

    assertEquals(alternatives.length, 1);
    // Score should be reduced by scoreMultiplier (0.90 from config)
    const expectedBase = matchedScore * DEFAULT_DAG_SCORING_CONFIG.alternatives.scoreMultiplier;
    assertEquals(alternatives[0].confidence, expectedBase);
  });
});

Deno.test("suggestAlternatives - Edge Cases", async (t) => {
  await t.step("handles self-referential alternative edges", async () => {
    const matchedCap = createMockCapability("cap-123", {
      successRate: 0.85,
    });

    // Edge pointing to itself
    const dependency = createMockDependency("cap-123", "cap-123", "alternative");
    const capStore = createMockCapabilityStore([dependency], [matchedCap]);
    const deps = createMockDeps({ capabilityStore: capStore as any });

    const alternatives = await suggestAlternatives(
      matchedCap,
      0.8,
      new Set(),
      new Map(),
      deps,
    );

    // Should suggest itself as alternative (though unusual)
    assertEquals(alternatives.length, 1);
    assertEquals(alternatives[0].toolId, "capability:cap-123");
  });

  await t.step("handles capability with null name", async () => {
    const matchedCap = createMockCapability("cap-123", {
      name: undefined,
    });
    const alternativeCap = createMockCapability("cap-456", {
      name: undefined,
      successRate: 0.85,
    });

    const dependency = createMockDependency("cap-123", "cap-456", "alternative");
    const capStore = createMockCapabilityStore([dependency], [alternativeCap]);
    const deps = createMockDeps({ capabilityStore: capStore as any });

    const alternatives = await suggestAlternatives(
      matchedCap,
      0.8,
      new Set(),
      new Map(),
      deps,
    );

    assertEquals(alternatives.length, 1);
    // Should handle null name gracefully (uses ID substring)
    assertExists(alternatives[0].reasoning);
  });

  await t.step("handles zero matched score", async () => {
    const matchedCap = createMockCapability("cap-123");
    const alternativeCap = createMockCapability("cap-456", {
      successRate: 0.85,
    });

    const dependency = createMockDependency("cap-123", "cap-456", "alternative");
    const capStore = createMockCapabilityStore([dependency], [alternativeCap]);
    const deps = createMockDeps({ capabilityStore: capStore as any });

    const alternatives = await suggestAlternatives(
      matchedCap,
      0.0, // Zero matched score
      new Set(),
      new Map(),
      deps,
    );

    assertEquals(alternatives.length, 1);
    // Should still suggest with reduced confidence
    assertEquals(alternatives[0].confidence, 0.0);
  });

  await t.step("handles very high matched score", async () => {
    const matchedCap = createMockCapability("cap-123");
    const alternativeCap = createMockCapability("cap-456", {
      successRate: 0.85,
    });

    const dependency = createMockDependency("cap-123", "cap-456", "alternative");
    const capStore = createMockCapabilityStore([dependency], [alternativeCap]);
    const deps = createMockDeps({ capabilityStore: capStore as any });

    const alternatives = await suggestAlternatives(
      matchedCap,
      1.0, // Maximum score
      new Set(),
      new Map(),
      deps,
    );

    assertEquals(alternatives.length, 1);
    // Should apply multiplier but not exceed 1.0
    assertEquals(alternatives[0].confidence, 0.9); // 1.0 * 0.90
  });
});
