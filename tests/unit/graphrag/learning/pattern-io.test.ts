/**
 * Pattern Import/Export Tests
 *
 * Tests for learned pattern management functions:
 * - Agent hint registration
 * - Pattern export
 * - Pattern import with merge strategies
 *
 * @module tests/unit/graphrag/learning/pattern-io.test
 */

import { assertEquals, assertExists, assertRejects } from "jsr:@std/assert@1";
import {
  exportLearnedPatterns,
  importLearnedPatterns,
  type PatternImport,
  registerAgentHint,
} from "../../../../src/graphrag/learning/pattern-io.ts";
import type { GraphRAGEngine } from "../../../../src/graphrag/graph-engine.ts";
import type { DagScoringConfig } from "../../../../src/graphrag/dag-scoring-config.ts";
import { DEFAULT_DAG_SCORING_CONFIG } from "../../../../src/graphrag/dag-scoring-config.ts";

/**
 * Edge data structure for mock graph
 */
interface MockEdgeData {
  weight: number;
  count: number;
  source?: string;
}

/**
 * Create mock GraphRAGEngine with configurable behavior
 */
function createMockGraphEngine(
  initialEdges: Array<{ from: string; to: string; attrs: MockEdgeData }> = [],
): GraphRAGEngine & {
  edges: Map<string, MockEdgeData>;
  addEdgeCalls: Array<{ from: string; to: string; attrs: MockEdgeData }>;
  shouldThrowOnAddEdge?: boolean;
} {
  const edges = new Map<string, MockEdgeData>();
  const addEdgeCalls: Array<{ from: string; to: string; attrs: MockEdgeData }> = [];

  // Initialize with provided edges
  for (const { from, to, attrs } of initialEdges) {
    edges.set(`${from}->${to}`, attrs);
  }

  const mock = {
    edges,
    addEdgeCalls,
    shouldThrowOnAddEdge: false,

    async addEdge(from: string, to: string, attrs: MockEdgeData) {
      if (mock.shouldThrowOnAddEdge) {
        throw new Error("Graph engine error");
      }
      addEdgeCalls.push({ from, to, attrs });
      edges.set(`${from}->${to}`, attrs);
    },

    getEdges(): Array<{ source: string; target: string; attributes: Record<string, unknown> }> {
      const result: Array<{ source: string; target: string; attributes: Record<string, unknown> }> =
        [];
      for (const [key, attrs] of edges.entries()) {
        const [source, target] = key.split("->");
        result.push({ source, target, attributes: attrs as unknown as Record<string, unknown> });
      }
      return result;
    },

    getEdgeData(from: string, to: string): MockEdgeData | null {
      return edges.get(`${from}->${to}`) || null;
    },
  };

  return mock as unknown as GraphRAGEngine & {
    edges: Map<string, MockEdgeData>;
    addEdgeCalls: Array<{ from: string; to: string; attrs: MockEdgeData }>;
    shouldThrowOnAddEdge?: boolean;
  };
}

/**
 * Create mock config
 */
function createMockConfig(overrides?: Partial<DagScoringConfig>): DagScoringConfig {
  return {
    ...DEFAULT_DAG_SCORING_CONFIG,
    ...overrides,
  };
}

Deno.test("pattern-io - Agent Hint Registration", async (t) => {
  await t.step("registerAgentHint() adds edge to graph with specified confidence", async () => {
    const graphEngine = createMockGraphEngine();
    const config = createMockConfig();
    config.caps.defaultNodeConfidence = 0.60;

    await registerAgentHint("WriteFile", "ReadFile", graphEngine, config, 0.75);

    assertEquals(graphEngine.addEdgeCalls.length, 1);
    const call = graphEngine.addEdgeCalls[0];
    assertEquals(call.from, "ReadFile");
    assertEquals(call.to, "WriteFile");
    assertEquals(call.attrs.weight, 0.75);
    assertEquals(call.attrs.count, 1);
    assertEquals(call.attrs.source, "hint");
  });

  await t.step("registerAgentHint() uses default confidence when not provided", async () => {
    const graphEngine = createMockGraphEngine();
    const config = createMockConfig();
    config.caps.defaultNodeConfidence = 0.65;

    await registerAgentHint("Edit", "Read", graphEngine, config);

    assertEquals(graphEngine.addEdgeCalls.length, 1);
    const call = graphEngine.addEdgeCalls[0];
    assertEquals(call.attrs.weight, 0.65); // Uses config default
  });

  await t.step("registerAgentHint() allows custom confidence override", async () => {
    const graphEngine = createMockGraphEngine();
    const config = createMockConfig();
    config.caps.defaultNodeConfidence = 0.60;

    await registerAgentHint("Bash", "Glob", graphEngine, config, 0.90);

    assertEquals(graphEngine.addEdgeCalls.length, 1);
    assertEquals(graphEngine.addEdgeCalls[0].attrs.weight, 0.90);
  });

  await t.step("registerAgentHint() sets count to 1 for new hints", async () => {
    const graphEngine = createMockGraphEngine();
    const config = createMockConfig();

    await registerAgentHint("ToolB", "ToolA", graphEngine, config);

    assertEquals(graphEngine.addEdgeCalls[0].attrs.count, 1);
  });

  await t.step("registerAgentHint() propagates graph engine errors", async () => {
    const graphEngine = createMockGraphEngine();
    graphEngine.shouldThrowOnAddEdge = true;
    const config = createMockConfig();

    await assertRejects(
      async () => await registerAgentHint("ToolB", "ToolA", graphEngine, config),
      Error,
      "Graph engine error",
    );
  });

  await t.step("registerAgentHint() handles zero confidence", async () => {
    const graphEngine = createMockGraphEngine();
    const config = createMockConfig();

    await registerAgentHint("ToolB", "ToolA", graphEngine, config, 0.0);

    assertEquals(graphEngine.addEdgeCalls[0].attrs.weight, 0.0);
  });

  await t.step("registerAgentHint() handles max confidence", async () => {
    const graphEngine = createMockGraphEngine();
    const config = createMockConfig();

    await registerAgentHint("ToolB", "ToolA", graphEngine, config, 1.0);

    assertEquals(graphEngine.addEdgeCalls[0].attrs.weight, 1.0);
  });
});

Deno.test("pattern-io - Pattern Export", async (t) => {
  await t.step("exportLearnedPatterns() returns all edges from graph", () => {
    const graphEngine = createMockGraphEngine([
      { from: "Read", to: "Write", attrs: { weight: 0.85, count: 5, source: "learned" } },
      { from: "Glob", to: "Read", attrs: { weight: 0.75, count: 3, source: "hint" } },
      { from: "Bash", to: "Grep", attrs: { weight: 0.90, count: 10, source: "learned" } },
    ]);

    const patterns = exportLearnedPatterns(graphEngine);

    assertEquals(patterns.length, 3);

    const readToWrite = patterns.find((p) => p.from === "Read" && p.to === "Write");
    assertExists(readToWrite);
    assertEquals(readToWrite.weight, 0.85);
    assertEquals(readToWrite.count, 5);
    assertEquals(readToWrite.source, "learned");

    const globToRead = patterns.find((p) => p.from === "Glob" && p.to === "Read");
    assertExists(globToRead);
    assertEquals(globToRead.weight, 0.75);
    assertEquals(globToRead.count, 3);
    assertEquals(globToRead.source, "hint");
  });

  await t.step("exportLearnedPatterns() returns empty array for empty graph", () => {
    const graphEngine = createMockGraphEngine();

    const patterns = exportLearnedPatterns(graphEngine);

    assertEquals(patterns, []);
  });

  await t.step("exportLearnedPatterns() uses default values for missing attributes", () => {
    const graphEngine = createMockGraphEngine([
      { from: "ToolA", to: "ToolB", attrs: {} as MockEdgeData },
    ]);

    const patterns = exportLearnedPatterns(graphEngine);

    assertEquals(patterns.length, 1);
    assertEquals(patterns[0].weight, 0.5); // Default weight
    assertEquals(patterns[0].count, 1); // Default count
    assertEquals(patterns[0].source, "learned"); // Default source
  });

  await t.step("exportLearnedPatterns() handles getEdges() errors gracefully", () => {
    const graphEngine = {
      getEdges: () => {
        throw new Error("Graph access error");
      },
    } as unknown as GraphRAGEngine;

    const patterns = exportLearnedPatterns(graphEngine);

    assertEquals(patterns, []); // Returns empty array on error
  });

  await t.step("exportLearnedPatterns() preserves all edge metadata", () => {
    const graphEngine = createMockGraphEngine([
      { from: "A", to: "B", attrs: { weight: 0.42, count: 7, source: "custom" } },
    ]);

    const patterns = exportLearnedPatterns(graphEngine);

    assertEquals(patterns[0].weight, 0.42);
    assertEquals(patterns[0].count, 7);
    assertEquals(patterns[0].source, "custom");
  });
});

Deno.test("pattern-io - Pattern Import with Merge Strategy", async (t) => {
  await t.step("importLearnedPatterns() adds new patterns to graph (replace mode)", async () => {
    const graphEngine = createMockGraphEngine();
    const patterns: PatternImport[] = [
      { from: "Read", to: "Write", weight: 0.80, count: 4, source: "imported" },
      { from: "Glob", to: "Grep", weight: 0.70, count: 2, source: "imported" },
    ];

    const imported = await importLearnedPatterns(patterns, graphEngine, "replace");

    assertEquals(imported, 2);
    assertEquals(graphEngine.addEdgeCalls.length, 2);

    const call1 = graphEngine.addEdgeCalls[0];
    assertEquals(call1.from, "Read");
    assertEquals(call1.to, "Write");
    assertEquals(call1.attrs.weight, 0.80);
    assertEquals(call1.attrs.count, 4);
    assertEquals(call1.attrs.source, "imported");
  });

  await t.step("importLearnedPatterns() replaces existing patterns in replace mode", async () => {
    const graphEngine = createMockGraphEngine([
      { from: "Read", to: "Write", attrs: { weight: 0.50, count: 2, source: "old" } },
    ]);

    const patterns: PatternImport[] = [
      { from: "Read", to: "Write", weight: 0.90, count: 10, source: "new" },
    ];

    const imported = await importLearnedPatterns(patterns, graphEngine, "replace");

    assertEquals(imported, 1);
    // Should have added new edge (graph engine handles replacement)
    const lastCall = graphEngine.addEdgeCalls[graphEngine.addEdgeCalls.length - 1];
    assertEquals(lastCall.attrs.weight, 0.90);
    assertEquals(lastCall.attrs.count, 10);
    assertEquals(lastCall.attrs.source, "new");
  });

  await t.step("importLearnedPatterns() merges patterns in merge mode", async () => {
    const graphEngine = createMockGraphEngine([
      { from: "Read", to: "Write", attrs: { weight: 0.60, count: 5, source: "existing" } },
    ]);

    const patterns: PatternImport[] = [
      { from: "Read", to: "Write", weight: 0.80, count: 3, source: "imported" },
    ];

    const imported = await importLearnedPatterns(patterns, graphEngine, "merge");

    assertEquals(imported, 1);
    const lastCall = graphEngine.addEdgeCalls[graphEngine.addEdgeCalls.length - 1];

    // Merge: Average weights, sum counts
    assertEquals(lastCall.attrs.weight, (0.60 + 0.80) / 2); // 0.70
    assertEquals(lastCall.attrs.count, 5 + 3); // 8
    assertEquals(lastCall.attrs.source, "merged");
  });

  await t.step("importLearnedPatterns() defaults to merge mode", async () => {
    const graphEngine = createMockGraphEngine([
      { from: "A", to: "B", attrs: { weight: 0.40, count: 2, source: "old" } },
    ]);

    const patterns: PatternImport[] = [
      { from: "A", to: "B", weight: 0.60, count: 4, source: "new" },
    ];

    // No merge strategy specified
    const imported = await importLearnedPatterns(patterns, graphEngine);

    assertEquals(imported, 1);
    const lastCall = graphEngine.addEdgeCalls[graphEngine.addEdgeCalls.length - 1];
    assertEquals(lastCall.attrs.weight, 0.50); // Merged: (0.40 + 0.60) / 2
    assertEquals(lastCall.attrs.count, 6); // Merged: 2 + 4
  });

  await t.step("importLearnedPatterns() handles empty pattern list", async () => {
    const graphEngine = createMockGraphEngine();

    const imported = await importLearnedPatterns([], graphEngine, "replace");

    assertEquals(imported, 0);
    assertEquals(graphEngine.addEdgeCalls.length, 0);
  });

  await t.step("importLearnedPatterns() handles partial import failures", async () => {
    const graphEngine = createMockGraphEngine();
    let callCount = 0;
    graphEngine.addEdge = async (from: string, to: string, attrs: MockEdgeData) => {
      callCount++;
      if (callCount === 2) {
        throw new Error("Failed to add edge");
      }
      graphEngine.edges.set(`${from}->${to}`, attrs);
      graphEngine.addEdgeCalls.push({ from, to, attrs });
    };

    const patterns: PatternImport[] = [
      { from: "A", to: "B", weight: 0.80, count: 1 },
      { from: "C", to: "D", weight: 0.70, count: 2 }, // This will fail
      { from: "E", to: "F", weight: 0.60, count: 3 },
    ];

    const imported = await importLearnedPatterns(patterns, graphEngine, "replace");

    assertEquals(imported, 2); // 2 out of 3 succeeded
  });

  await t.step("importLearnedPatterns() uses default source when not provided", async () => {
    const graphEngine = createMockGraphEngine();
    const patterns: PatternImport[] = [
      { from: "A", to: "B", weight: 0.75, count: 3 }, // No source field
    ];

    const imported = await importLearnedPatterns(patterns, graphEngine, "replace");

    assertEquals(imported, 1);
    assertEquals(graphEngine.addEdgeCalls[0].attrs.source, "imported");
  });

  await t.step("importLearnedPatterns() preserves custom source in replace mode", async () => {
    const graphEngine = createMockGraphEngine();
    const patterns: PatternImport[] = [
      { from: "A", to: "B", weight: 0.75, count: 3, source: "custom-source" },
    ];

    const imported = await importLearnedPatterns(patterns, graphEngine, "replace");

    assertEquals(imported, 1);
    assertEquals(graphEngine.addEdgeCalls[0].attrs.source, "custom-source");
  });

  await t.step(
    "importLearnedPatterns() handles mixed new and existing patterns in merge mode",
    async () => {
      const graphEngine = createMockGraphEngine([
        { from: "A", to: "B", attrs: { weight: 0.50, count: 5, source: "old" } },
      ]);

      const patterns: PatternImport[] = [
        { from: "A", to: "B", weight: 0.70, count: 3 }, // Existing - should merge
        { from: "C", to: "D", weight: 0.80, count: 4 }, // New - should add
      ];

      const imported = await importLearnedPatterns(patterns, graphEngine, "merge");

      assertEquals(imported, 2);

      // Check merged pattern
      const mergedCall = graphEngine.addEdgeCalls.find((c) => c.from === "A" && c.to === "B");
      assertExists(mergedCall);
      assertEquals(mergedCall.attrs.weight, 0.60); // (0.50 + 0.70) / 2
      assertEquals(mergedCall.attrs.count, 8); // 5 + 3

      // Check new pattern
      const newCall = graphEngine.addEdgeCalls.find((c) => c.from === "C" && c.to === "D");
      assertExists(newCall);
      assertEquals(newCall.attrs.weight, 0.80);
      assertEquals(newCall.attrs.count, 4);
    },
  );
});

Deno.test("pattern-io - Edge Cases and Error Handling", async (t) => {
  await t.step("exportLearnedPatterns() handles patterns with extreme values", () => {
    const graphEngine = createMockGraphEngine([
      { from: "A", to: "B", attrs: { weight: 0.0, count: 1, source: "test" } },
      { from: "C", to: "D", attrs: { weight: 1.0, count: 999, source: "test" } },
    ]);

    const patterns = exportLearnedPatterns(graphEngine);

    assertEquals(patterns.length, 2);
    assertEquals(patterns[0].weight, 0.0);
    assertEquals(patterns[1].weight, 1.0);
    assertEquals(patterns[1].count, 999);
  });

  await t.step("importLearnedPatterns() handles patterns with zero weight", async () => {
    const graphEngine = createMockGraphEngine();
    const patterns: PatternImport[] = [
      { from: "A", to: "B", weight: 0.0, count: 1 },
    ];

    const imported = await importLearnedPatterns(patterns, graphEngine, "replace");

    assertEquals(imported, 1);
    assertEquals(graphEngine.addEdgeCalls[0].attrs.weight, 0.0);
  });

  await t.step("importLearnedPatterns() handles patterns with zero count", async () => {
    const graphEngine = createMockGraphEngine();
    const patterns: PatternImport[] = [
      { from: "A", to: "B", weight: 0.75, count: 0 },
    ];

    const imported = await importLearnedPatterns(patterns, graphEngine, "replace");

    assertEquals(imported, 1);
    assertEquals(graphEngine.addEdgeCalls[0].attrs.count, 0);
  });

  await t.step("merge calculates correct averages with fractional weights", async () => {
    const graphEngine = createMockGraphEngine([
      { from: "A", to: "B", attrs: { weight: 0.333, count: 7, source: "old" } },
    ]);

    const patterns: PatternImport[] = [
      { from: "A", to: "B", weight: 0.667, count: 3 },
    ];

    const imported = await importLearnedPatterns(patterns, graphEngine, "merge");

    assertEquals(imported, 1);
    const call = graphEngine.addEdgeCalls[graphEngine.addEdgeCalls.length - 1];
    assertEquals(call.attrs.weight, 0.5); // (0.333 + 0.667) / 2
    assertEquals(call.attrs.count, 10); // 7 + 3
  });

  await t.step("handles same tool appearing in multiple patterns", async () => {
    const graphEngine = createMockGraphEngine();
    const patterns: PatternImport[] = [
      { from: "Read", to: "Write", weight: 0.80, count: 3 },
      { from: "Read", to: "Edit", weight: 0.70, count: 2 },
      { from: "Glob", to: "Read", weight: 0.90, count: 5 },
    ];

    const imported = await importLearnedPatterns(patterns, graphEngine, "replace");

    assertEquals(imported, 3);
    assertEquals(graphEngine.addEdgeCalls.length, 3);
  });

  await t.step("importLearnedPatterns() continues after individual failures", async () => {
    const graphEngine = createMockGraphEngine();
    let shouldFail = false;
    graphEngine.addEdge = async (from: string, to: string, attrs: MockEdgeData) => {
      if (shouldFail) {
        shouldFail = false;
        throw new Error("Intermittent failure");
      }
      shouldFail = true;
      graphEngine.edges.set(`${from}->${to}`, attrs);
      graphEngine.addEdgeCalls.push({ from, to, attrs });
    };

    const patterns: PatternImport[] = [
      { from: "A", to: "B", weight: 0.80, count: 1 }, // Success
      { from: "C", to: "D", weight: 0.70, count: 2 }, // Fail
      { from: "E", to: "F", weight: 0.60, count: 3 }, // Success
      { from: "G", to: "H", weight: 0.50, count: 4 }, // Fail
    ];

    const imported = await importLearnedPatterns(patterns, graphEngine, "replace");

    assertEquals(imported, 2); // 2 successes out of 4
  });

  await t.step("merge mode with non-existent edge treats as new pattern", async () => {
    const graphEngine = createMockGraphEngine();
    const patterns: PatternImport[] = [
      { from: "New", to: "Pattern", weight: 0.85, count: 5, source: "test" },
    ];

    const imported = await importLearnedPatterns(patterns, graphEngine, "merge");

    assertEquals(imported, 1);
    const call = graphEngine.addEdgeCalls[0];
    assertEquals(call.attrs.weight, 0.85); // Not averaged since no existing edge
    assertEquals(call.attrs.count, 5);
    assertEquals(call.attrs.source, "test");
  });
});

Deno.test("pattern-io - Integration Scenarios", async (t) => {
  await t.step("export-then-import preserves patterns (replace mode)", async () => {
    const sourceGraph = createMockGraphEngine([
      { from: "Read", to: "Write", attrs: { weight: 0.85, count: 10, source: "learned" } },
      { from: "Glob", to: "Grep", attrs: { weight: 0.75, count: 5, source: "hint" } },
    ]);

    const targetGraph = createMockGraphEngine();

    // Export from source
    const patterns = exportLearnedPatterns(sourceGraph);

    // Import to target
    const imported = await importLearnedPatterns(patterns, targetGraph, "replace");

    assertEquals(imported, 2);
    assertEquals(targetGraph.edges.size, 2);

    const readWrite = targetGraph.getEdgeData("Read", "Write");
    assertExists(readWrite);
    assertEquals(readWrite.weight, 0.85);
    assertEquals(readWrite.count, 10);
  });

  await t.step("export-then-import with merge combines patterns", async () => {
    const sourceGraph = createMockGraphEngine([
      { from: "A", to: "B", attrs: { weight: 0.80, count: 8, source: "source1" } },
    ]);

    const targetGraph = createMockGraphEngine([
      { from: "A", to: "B", attrs: { weight: 0.60, count: 4, source: "source2" } },
    ]);

    const patterns = exportLearnedPatterns(sourceGraph);
    const imported = await importLearnedPatterns(patterns, targetGraph, "merge");

    assertEquals(imported, 1);

    const mergedCall = targetGraph.addEdgeCalls[targetGraph.addEdgeCalls.length - 1];
    assertEquals(mergedCall.attrs.weight, 0.70); // (0.60 + 0.80) / 2
    assertEquals(mergedCall.attrs.count, 12); // 4 + 8
    assertEquals(mergedCall.attrs.source, "merged");
  });

  await t.step("registerAgentHint followed by export includes hint", async () => {
    const graphEngine = createMockGraphEngine();
    const config = createMockConfig();
    config.caps.defaultNodeConfidence = 0.70;

    await registerAgentHint("Write", "Read", graphEngine, config);

    const patterns = exportLearnedPatterns(graphEngine);

    assertEquals(patterns.length, 1);
    assertEquals(patterns[0].from, "Read");
    assertEquals(patterns[0].to, "Write");
    assertEquals(patterns[0].weight, 0.70);
    assertEquals(patterns[0].source, "hint");
  });
});
