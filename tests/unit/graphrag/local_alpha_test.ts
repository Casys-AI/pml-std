/**
 * Tests for LocalAlphaCalculator (ADR-048)
 *
 * Validates local adaptive alpha calculation across different modes:
 * - Active Search: Embeddings Hybrides
 * - Passive Suggestion Tools: Heat Diffusion
 * - Passive Suggestion Capabilities: Heat Diffusion Hierarchical
 * - Cold Start: Bayesian fallback
 */

import { assertEquals, assertAlmostEquals, assert } from "@std/assert";
import { LocalAlphaCalculator, type AlphaMode, type NodeType } from "../../../src/graphrag/local-alpha.ts";

// Mock Graphology-like graph
function createMockGraph() {
  const nodes = new Map<string, { degree: number }>();
  const edges = new Map<string, { source: string; target: string; weight: number }>();

  return {
    hasNode: (id: string) => nodes.has(id),
    degree: (id: string) => nodes.get(id)?.degree ?? 0,
    neighbors: (id: string) => {
      const result: string[] = [];
      edges.forEach((edge) => {
        if (edge.source === id) result.push(edge.target);
        if (edge.target === id) result.push(edge.source);
      });
      return result;
    },
    hasEdge: (source: string, target: string) => {
      let found = false;
      edges.forEach((edge) => {
        if ((edge.source === source && edge.target === target) ||
            (edge.source === target && edge.target === source)) {
          found = true;
        }
      });
      return found;
    },
    getEdgeAttribute: (_source: string, _target: string, attr: string) => {
      if (attr === "weight") return 1.0;
      return undefined;
    },
    forEachNode: (fn: (node: string) => void) => {
      nodes.forEach((_, id) => fn(id));
    },
    forEachEdge: (nodeId: string, fn: (edge: string, attrs: any) => void) => {
      edges.forEach((edge, edgeId) => {
        if (edge.source === nodeId || edge.target === nodeId) {
          fn(edgeId, { weight: edge.weight });
        }
      });
    },
    // Helper methods for test setup
    _addNode: (id: string, degree: number) => nodes.set(id, { degree }),
    _addEdge: (id: string, source: string, target: string, weight = 1.0) => {
      edges.set(id, { source, target, weight });
    },
  };
}

// =============================================================================
// Cold Start / Bayesian Tests
// =============================================================================

Deno.test("LocalAlphaCalculator - cold start returns high alpha (Bayesian)", () => {
  const graph = createMockGraph();
  graph._addNode("tool:a", 0); // No connections

  const calculator = new LocalAlphaCalculator({
    graph: graph as any,
    spectralClustering: null,
    getSemanticEmbedding: () => null,
    getObservationCount: () => 0, // Cold start: 0 observations
    getParent: () => null,
    getChildren: () => [],
  });

  const result = calculator.getLocalAlphaWithBreakdown("active", "tool:a", "tool");

  assertEquals(result.algorithm, "bayesian");
  assertEquals(result.coldStart, true);
  assertEquals(result.alpha, 1.0); // Prior: pure semantic
});

Deno.test("LocalAlphaCalculator - partial observations lower alpha progressively", () => {
  const graph = createMockGraph();
  graph._addNode("tool:a", 2);

  // Test with 2 observations (below threshold of 5)
  const calculator = new LocalAlphaCalculator({
    graph: graph as any,
    spectralClustering: null,
    getSemanticEmbedding: () => null,
    getObservationCount: () => 2,
    getParent: () => null,
    getChildren: () => [],
  });

  const result = calculator.getLocalAlphaWithBreakdown("active", "tool:a", "tool");

  assertEquals(result.algorithm, "bayesian");
  assertEquals(result.coldStart, true);
  // With 2/5 observations, alpha should be between 1.0 and 0.7
  assert(result.alpha < 1.0, "Alpha should be lower than prior");
  assert(result.alpha > 0.7, "Alpha should be higher than target");
});

Deno.test("LocalAlphaCalculator - sufficient observations exits cold start", () => {
  const graph = createMockGraph();
  graph._addNode("tool:a", 5);

  const calculator = new LocalAlphaCalculator({
    graph: graph as any,
    spectralClustering: null,
    getSemanticEmbedding: () => null,
    getObservationCount: () => 10, // Above threshold
    getParent: () => null,
    getChildren: () => [],
  });

  const result = calculator.getLocalAlphaWithBreakdown("active", "tool:a", "tool");

  assertEquals(result.coldStart, false);
  // Should use embeddings_hybrides for active mode, but fallback to high alpha without embeddings
  assert(result.algorithm !== "bayesian", "Should not use Bayesian");
});

// =============================================================================
// Embeddings Hybrides Tests (Active Search)
// =============================================================================

Deno.test("LocalAlphaCalculator - active mode without embeddings returns 1.0", () => {
  const graph = createMockGraph();
  graph._addNode("tool:a", 5);

  const calculator = new LocalAlphaCalculator({
    graph: graph as any,
    spectralClustering: null,
    getSemanticEmbedding: () => null, // No semantic embedding
    getObservationCount: () => 10,
    getParent: () => null,
    getChildren: () => [],
  });

  const result = calculator.getLocalAlphaWithBreakdown("active", "tool:a", "tool");

  assertEquals(result.algorithm, "embeddings_hybrides");
  assertEquals(result.alpha, 1.0); // Fallback: pure semantic
});

Deno.test("LocalAlphaCalculator - active mode with coherent embeddings returns low alpha", () => {
  const graph = createMockGraph();
  graph._addNode("tool:a", 5);

  // Mock spectral clustering with matching embedding
  const mockSpectral = {
    getEmbeddingRow: (_nodeId: string) => [0.5, 0.5, 0.5], // Structural embedding
    hasEmbedding: () => true,
  };

  const calculator = new LocalAlphaCalculator({
    graph: graph as any,
    spectralClustering: mockSpectral as any,
    getSemanticEmbedding: () => [0.5, 0.5, 0.5], // Same as structural = coherent
    getObservationCount: () => 10,
    getParent: () => null,
    getChildren: () => [],
  });

  const result = calculator.getLocalAlphaWithBreakdown("active", "tool:a", "tool");

  assertEquals(result.algorithm, "embeddings_hybrides");
  // High coherence (1.0) should give alpha close to 0.5
  assertAlmostEquals(result.alpha, 0.5, 0.01);
});

Deno.test("LocalAlphaCalculator - active mode with divergent embeddings returns high alpha", () => {
  const graph = createMockGraph();
  graph._addNode("tool:a", 5);

  const mockSpectral = {
    getEmbeddingRow: (_nodeId: string) => [1, 0, 0], // Structural embedding
    hasEmbedding: () => true,
  };

  const calculator = new LocalAlphaCalculator({
    graph: graph as any,
    spectralClustering: mockSpectral as any,
    getSemanticEmbedding: () => [0, 1, 0], // Orthogonal to structural = divergent
    getObservationCount: () => 10,
    getParent: () => null,
    getChildren: () => [],
  });

  const result = calculator.getLocalAlphaWithBreakdown("active", "tool:a", "tool");

  assertEquals(result.algorithm, "embeddings_hybrides");
  // Low coherence (0) should give alpha close to 1.0
  assertAlmostEquals(result.alpha, 1.0, 0.01);
});

// =============================================================================
// Heat Diffusion Tests (Passive Suggestion - Tools)
// =============================================================================

Deno.test("LocalAlphaCalculator - passive tool mode with isolated node returns high alpha", () => {
  const graph = createMockGraph();
  graph._addNode("tool:isolated", 0); // No connections

  const calculator = new LocalAlphaCalculator({
    graph: graph as any,
    spectralClustering: null,
    getSemanticEmbedding: () => null,
    getObservationCount: () => 10,
    getParent: () => null,
    getChildren: () => [],
  });

  const result = calculator.getLocalAlphaWithBreakdown("passive", "tool:isolated", "tool", []);

  assertEquals(result.algorithm, "heat_diffusion");
  // Isolated node has zero heat -> high alpha
  assertEquals(result.alpha, 1.0);
});

Deno.test("LocalAlphaCalculator - passive tool mode with well-connected node returns lower alpha", () => {
  const graph = createMockGraph();
  graph._addNode("tool:a", 5);
  graph._addNode("tool:b", 3);
  graph._addNode("tool:c", 4);
  graph._addEdge("e1", "tool:a", "tool:b");
  graph._addEdge("e2", "tool:a", "tool:c");

  const calculator = new LocalAlphaCalculator({
    graph: graph as any,
    spectralClustering: null,
    getSemanticEmbedding: () => null,
    getObservationCount: () => 10,
    getParent: () => null,
    getChildren: () => [],
  });

  const result = calculator.getLocalAlphaWithBreakdown("passive", "tool:a", "tool", ["tool:b"]);

  assertEquals(result.algorithm, "heat_diffusion");
  // Connected node with context should have lower alpha
  assert(result.alpha < 1.0, "Alpha should be lower for connected node");
  assert(result.alpha >= 0.5, "Alpha should be at least 0.5");
});

Deno.test("LocalAlphaCalculator - passive tool mode considers path heat from context", () => {
  const graph = createMockGraph();
  graph._addNode("tool:ctx", 3);
  graph._addNode("tool:target", 2);
  graph._addEdge("e1", "tool:ctx", "tool:target"); // Direct connection

  const calculator = new LocalAlphaCalculator({
    graph: graph as any,
    spectralClustering: null,
    getSemanticEmbedding: () => null,
    getObservationCount: () => 10,
    getParent: () => null,
    getChildren: () => [],
  });

  const result = calculator.getLocalAlphaWithBreakdown("passive", "tool:target", "tool", ["tool:ctx"]);

  assertEquals(result.algorithm, "heat_diffusion");
  assert(result.inputs.pathHeat > 0, "Path heat should be positive with direct edge");
});

// =============================================================================
// Heat Diffusion Hierarchical Tests (Passive Suggestion - Capabilities)
// =============================================================================

Deno.test("LocalAlphaCalculator - passive capability mode uses hierarchical heat", () => {
  const graph = createMockGraph();
  graph._addNode("cap:read_file", 3);

  const calculator = new LocalAlphaCalculator({
    graph: graph as any,
    spectralClustering: null,
    getSemanticEmbedding: () => null,
    getObservationCount: () => 10,
    getParent: () => null,
    getChildren: () => [],
  });

  const result = calculator.getLocalAlphaWithBreakdown("passive", "cap:read_file", "capability", []);

  assertEquals(result.algorithm, "heat_hierarchical");
});

Deno.test("LocalAlphaCalculator - capability inherits heat from meta parent", () => {
  const graph = createMockGraph();
  graph._addNode("meta:file_ops", 5);
  graph._addNode("cap:read_file", 2);

  const calculator = new LocalAlphaCalculator({
    graph: graph as any,
    spectralClustering: null,
    getSemanticEmbedding: () => null,
    getObservationCount: () => 10,
    getParent: (nodeId, parentType) => {
      if (nodeId === "cap:read_file" && parentType === "meta") return "meta:file_ops";
      return null;
    },
    getChildren: () => [],
  });

  const resultWithParent = calculator.getLocalAlphaWithBreakdown("passive", "cap:read_file", "capability", []);

  // With a parent, the capability should inherit some heat
  assert(resultWithParent.inputs.heat !== undefined, "Should have heat input");
});

Deno.test("LocalAlphaCalculator - meta aggregates heat from capability children", () => {
  const graph = createMockGraph();
  graph._addNode("meta:file_ops", 1);
  graph._addNode("cap:read_file", 4);
  graph._addNode("cap:write_file", 3);

  const calculator = new LocalAlphaCalculator({
    graph: graph as any,
    spectralClustering: null,
    getSemanticEmbedding: () => null,
    getObservationCount: () => 10,
    getParent: () => null,
    getChildren: (nodeId, childType) => {
      if (nodeId === "meta:file_ops" && childType === "capability") {
        return ["cap:read_file", "cap:write_file"];
      }
      return [];
    },
  });

  const result = calculator.getLocalAlphaWithBreakdown("passive", "meta:file_ops", "meta", []);

  assertEquals(result.algorithm, "heat_hierarchical");
  // Meta should aggregate heat from children
  assert(result.inputs.heat !== undefined, "Should have aggregated heat");
});

// =============================================================================
// Alpha Range Tests
// =============================================================================

Deno.test("LocalAlphaCalculator - alpha always in [0.5, 1.0] range", () => {
  const graph = createMockGraph();

  // Create a densely connected graph
  for (let i = 0; i < 10; i++) {
    graph._addNode(`tool:${i}`, 9);
  }
  for (let i = 0; i < 10; i++) {
    for (let j = i + 1; j < 10; j++) {
      graph._addEdge(`e${i}-${j}`, `tool:${i}`, `tool:${j}`);
    }
  }

  const mockSpectral = {
    getEmbeddingRow: () => [1, 1, 1],
    hasEmbedding: () => true,
  };

  const calculator = new LocalAlphaCalculator({
    graph: graph as any,
    spectralClustering: mockSpectral as any,
    getSemanticEmbedding: () => [1, 1, 1], // Perfect coherence
    getObservationCount: () => 100, // Many observations
    getParent: () => null,
    getChildren: () => [],
  });

  // Test various modes and types
  const testCases: Array<{ mode: AlphaMode; nodeId: string; nodeType: NodeType }> = [
    { mode: "active", nodeId: "tool:0", nodeType: "tool" },
    { mode: "passive", nodeId: "tool:0", nodeType: "tool" },
    { mode: "passive", nodeId: "tool:0", nodeType: "capability" },
    { mode: "passive", nodeId: "tool:0", nodeType: "meta" },
  ];

  for (const tc of testCases) {
    const result = calculator.getLocalAlpha(tc.mode, tc.nodeId, tc.nodeType, ["tool:1", "tool:2"]);
    assert(result >= 0.5, `Alpha should be >= 0.5 for ${tc.mode}/${tc.nodeType}, got ${result}`);
    assert(result <= 1.0, `Alpha should be <= 1.0 for ${tc.mode}/${tc.nodeType}, got ${result}`);
  }
});

// =============================================================================
// Cache Tests
// =============================================================================

Deno.test("LocalAlphaCalculator - cache invalidation clears heat cache", () => {
  const graph = createMockGraph();
  graph._addNode("tool:a", 3);

  const calculator = new LocalAlphaCalculator({
    graph: graph as any,
    spectralClustering: null,
    getSemanticEmbedding: () => null,
    getObservationCount: () => 10,
    getParent: () => null,
    getChildren: () => [],
  });

  // First call caches heat
  calculator.getLocalAlpha("passive", "tool:a", "tool");

  // Invalidate cache
  calculator.invalidateCache();

  // Should still work after invalidation
  const result = calculator.getLocalAlpha("passive", "tool:a", "tool");
  assert(result >= 0.5 && result <= 1.0, "Should return valid alpha after cache invalidation");
});
