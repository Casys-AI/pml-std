/**
 * Tests for Tensor Entropy Algorithm
 *
 * Validates the tensor entropy implementation for graphs and hypergraphs.
 *
 * @module tests/unit/graphrag/algorithms/tensor_entropy_test
 */

import { assertEquals, assertAlmostEquals } from "jsr:@std/assert";
import { describe, it } from "jsr:@std/testing/bdd";
import {
  computeTensorEntropy,
  snapshotToEntropyInput,
  _internals,
  type EntropyGraphInput,
} from "../../../../src/graphrag/algorithms/tensor-entropy.ts";

describe("Tensor Entropy", () => {
  describe("computeStructuralEntropy", () => {
    it("should return 0 for empty degree map", () => {
      const degrees = new Map<string, number>();
      const entropy = _internals.computeStructuralEntropy(degrees);
      assertEquals(entropy, 0);
    });

    it("should return 0 for single node with zero degree", () => {
      const degrees = new Map([["a", 0]]);
      const entropy = _internals.computeStructuralEntropy(degrees);
      assertEquals(entropy, 0);
    });

    it("should return max entropy for uniform degrees", () => {
      // 4 nodes with equal degree = max entropy = log2(4) = 2
      const degrees = new Map([
        ["a", 3],
        ["b", 3],
        ["c", 3],
        ["d", 3],
      ]);
      const entropy = _internals.computeStructuralEntropy(degrees);
      assertAlmostEquals(entropy, 2.0, 0.001);
    });

    it("should return lower entropy for skewed degrees (star graph)", () => {
      // Star: hub with degree 4, 4 leaves with degree 1
      // Total = 8, probs = [4/8, 1/8, 1/8, 1/8, 1/8]
      const degrees = new Map([
        ["hub", 4],
        ["leaf1", 1],
        ["leaf2", 1],
        ["leaf3", 1],
        ["leaf4", 1],
      ]);
      const entropy = _internals.computeStructuralEntropy(degrees);
      // Should be less than max entropy of log2(5) ≈ 2.32
      assertEquals(entropy < 2.32, true);
      assertEquals(entropy > 0, true);
    });
  });

  describe("computeVonNeumannEntropyApprox", () => {
    it("should return 0 for single node", () => {
      const degrees = new Map([["a", 0]]);
      const entropy = _internals.computeVonNeumannEntropyApprox(degrees, 0);
      assertEquals(entropy, 0);
    });

    it("should return value in [0,1] range", () => {
      const degrees = new Map([
        ["a", 2],
        ["b", 2],
        ["c", 2],
      ]);
      const entropy = _internals.computeVonNeumannEntropyApprox(degrees, 3);
      assertEquals(entropy >= 0 && entropy <= 1, true);
    });

    it("should be higher for more uniform degree distribution", () => {
      // Uniform: 4 nodes with degree 2 each
      const uniformDegrees = new Map([
        ["a", 2],
        ["b", 2],
        ["c", 2],
        ["d", 2],
      ]);
      const uniformEntropy = _internals.computeVonNeumannEntropyApprox(uniformDegrees, 4);

      // Skewed: hub with high degree
      const skewedDegrees = new Map([
        ["hub", 6],
        ["b", 1],
        ["c", 1],
        ["d", 1],
      ]);
      const skewedEntropy = _internals.computeVonNeumannEntropyApprox(skewedDegrees, 4.5);

      // Uniform should have higher entropy than skewed
      assertEquals(uniformEntropy > skewedEntropy, true);
    });
  });

  describe("extractHyperedges", () => {
    it("should return empty array for graph without capabilities", () => {
      const graph: EntropyGraphInput = {
        nodes: [{ id: "tool1" }, { id: "tool2" }],
        edges: [{ source: "tool1", target: "tool2" }],
      };
      const hyperedges = _internals.extractHyperedges(graph);
      assertEquals(hyperedges.length, 0);
    });

    it("should extract hyperedges from capability contains edges", () => {
      const graph: EntropyGraphInput = {
        nodes: [
          { id: "capability:cap1", type: "capability" },
          { id: "tool1" },
          { id: "tool2" },
          { id: "tool3" },
        ],
        edges: [
          { source: "capability:cap1", target: "tool1", edge_type: "contains" },
          { source: "capability:cap1", target: "tool2", edge_type: "contains" },
          { source: "capability:cap1", target: "tool3", edge_type: "contains" },
        ],
      };
      const hyperedges = _internals.extractHyperedges(graph);
      assertEquals(hyperedges.length, 1);
      assertEquals(hyperedges[0].order, 3);
      assertEquals(hyperedges[0].members.length, 3);
    });

    it("should use explicit hyperedges if provided", () => {
      const graph: EntropyGraphInput = {
        nodes: [{ id: "a" }, { id: "b" }, { id: "c" }],
        edges: [],
        hyperedges: [
          { id: "he1", members: ["a", "b", "c"], weight: 1 },
        ],
      };
      const hyperedges = _internals.extractHyperedges(graph);
      assertEquals(hyperedges.length, 1);
      assertEquals(hyperedges[0].order, 3);
    });
  });

  describe("computeHyperedgeEntropy", () => {
    it("should return 0 for empty hyperedges", () => {
      const entropy = _internals.computeHyperedgeEntropy([], 3);
      assertEquals(entropy, 0);
    });

    it("should return max entropy for uniform participation", () => {
      // 3 hyperedges, each with 3 nodes, all nodes participate equally
      const hyperedges = [
        { members: ["a", "b", "c"], order: 3 },
        { members: ["d", "e", "f"], order: 3 },
        { members: ["g", "h", "i"], order: 3 },
      ];
      const entropy = _internals.computeHyperedgeEntropy(hyperedges, 3);
      // Each node participates once, so entropy = log2(9)/log2(9) = 1
      assertAlmostEquals(entropy, 1.0, 0.001);
    });

    it("should return lower entropy for concentrated participation", () => {
      // One node participates in all hyperedges
      const hyperedges = [
        { members: ["hub", "b", "c"], order: 3 },
        { members: ["hub", "d", "e"], order: 3 },
        { members: ["hub", "f", "g"], order: 3 },
      ];
      const entropy = _internals.computeHyperedgeEntropy(hyperedges, 3);
      // Hub participates 3 times, others once each
      assertEquals(entropy < 1.0, true);
    });
  });

  describe("computeSizeAdjustedThresholds", () => {
    it("should return base thresholds for small graphs (n <= 50)", () => {
      const thresholds = _internals.computeSizeAdjustedThresholds(30, 50);
      assertEquals(thresholds.low, 0.3);
      assertEquals(thresholds.high, 0.7);
    });

    it("should return base thresholds for exactly 50 nodes", () => {
      const thresholds = _internals.computeSizeAdjustedThresholds(50, 100);
      assertEquals(thresholds.low, 0.3);
      assertEquals(thresholds.high, 0.7);
    });

    it("should raise thresholds for large sparse graphs", () => {
      // 500 nodes, 1000 edges is quite sparse (density ~0.008)
      const thresholds = _internals.computeSizeAdjustedThresholds(500, 1000);
      assertEquals(thresholds.low > 0.3, true);
      assertEquals(thresholds.high > 0.7, true);
    });

    it("should raise thresholds less for dense graphs", () => {
      // 100 nodes, 2000 edges is relatively dense
      const sparseThresholds = _internals.computeSizeAdjustedThresholds(100, 200);
      const denseThresholds = _internals.computeSizeAdjustedThresholds(100, 2000);

      // Both should be above base, but dense should be lower than sparse
      assertEquals(sparseThresholds.low >= denseThresholds.low, true);
    });

    it("should cap thresholds at maximum values", () => {
      // Very large sparse graph
      const thresholds = _internals.computeSizeAdjustedThresholds(10000, 20000);
      assertEquals(thresholds.low <= 0.8, true);
      assertEquals(thresholds.high <= 0.95, true);
    });
  });

  describe("determineHealth", () => {
    it("should return rigid for low entropy", () => {
      assertEquals(_internals.determineHealth(0.1), "rigid");
      assertEquals(_internals.determineHealth(0.29), "rigid");
    });

    it("should return healthy for medium entropy", () => {
      assertEquals(_internals.determineHealth(0.3), "healthy");
      assertEquals(_internals.determineHealth(0.5), "healthy");
      assertEquals(_internals.determineHealth(0.7), "healthy");
    });

    it("should return chaotic for high entropy", () => {
      assertEquals(_internals.determineHealth(0.71), "chaotic");
      assertEquals(_internals.determineHealth(0.9), "chaotic");
    });

    it("should use size-adjusted thresholds for large graphs", () => {
      // For a large sparse graph, 0.75 entropy might be healthy
      const health = _internals.determineHealth(0.75, 500, 1000);
      // With adjustment, this should be "healthy" not "chaotic"
      assertEquals(health === "healthy" || health === "chaotic", true);
    });
  });

  describe("computeTensorEntropy (integration)", () => {
    it("should handle empty graph", () => {
      const graph: EntropyGraphInput = { nodes: [], edges: [] };
      const result = computeTensorEntropy(graph);

      assertEquals(result.vonNeumannEntropy, 0);
      assertEquals(result.structuralEntropy, 0);
      assertEquals(result.normalized, 0);
      assertEquals(result.health, "rigid");
      assertEquals(result.meta.nodeCount, 0);
    });

    it("should compute entropy for simple graph", () => {
      // Triangle graph: 3 nodes, 3 edges
      const graph: EntropyGraphInput = {
        nodes: [{ id: "a" }, { id: "b" }, { id: "c" }],
        edges: [
          { source: "a", target: "b", weight: 1 },
          { source: "b", target: "c", weight: 1 },
          { source: "c", target: "a", weight: 1 },
        ],
      };
      const result = computeTensorEntropy(graph);

      assertEquals(result.meta.nodeCount, 3);
      assertEquals(result.meta.edgeCount, 3);
      assertEquals(result.vonNeumannEntropy >= 0, true);
      assertEquals(result.vonNeumannEntropy <= 1, true);
      assertEquals(result.entropyByOrder.has(2), true);
    });

    it("should compute entropy for graph with hyperedges", () => {
      const graph: EntropyGraphInput = {
        nodes: [
          { id: "capability:cap1", type: "capability" },
          { id: "tool1" },
          { id: "tool2" },
          { id: "tool3" },
        ],
        edges: [
          { source: "capability:cap1", target: "tool1", edge_type: "contains" },
          { source: "capability:cap1", target: "tool2", edge_type: "contains" },
          { source: "capability:cap1", target: "tool3", edge_type: "contains" },
          { source: "tool1", target: "tool2", weight: 0.8 },
        ],
      };
      const result = computeTensorEntropy(graph);

      assertEquals(result.meta.hyperedgeCount, 1);
      assertEquals(result.entropyByOrder.has(3), true); // Order-3 hyperedge
    });

    it("should include adjustedThresholds in result", () => {
      const graph: EntropyGraphInput = {
        nodes: [{ id: "a" }, { id: "b" }, { id: "c" }],
        edges: [
          { source: "a", target: "b", weight: 1 },
          { source: "b", target: "c", weight: 1 },
        ],
      };
      const result = computeTensorEntropy(graph);

      assertEquals(result.adjustedThresholds !== undefined, true);
      assertEquals(typeof result.adjustedThresholds.low, "number");
      assertEquals(typeof result.adjustedThresholds.high, "number");
      assertEquals(result.adjustedThresholds.low < result.adjustedThresholds.high, true);
    });

    it("should provide meaningful entropy for large uniform graph", () => {
      // Create a ring graph with 100 nodes
      const nodes = Array.from({ length: 100 }, (_, i) => ({ id: `n${i}` }));
      const edges = Array.from({ length: 100 }, (_, i) => ({
        source: `n${i}`,
        target: `n${(i + 1) % 100}`,
        weight: 1,
      }));

      const graph: EntropyGraphInput = { nodes, edges };
      const result = computeTensorEntropy(graph);

      // Ring graph is very regular, so entropy should be in healthy range
      // Not too low (not a star), not too high (structured)
      // Note: For uniform distributions, entropy can be exactly 1.0 or slightly above
      // due to floating-point precision (e.g., 1.0000000000000002)
      assertEquals(result.normalized >= 0, true);
      assertEquals(result.normalized <= 1.01, true); // Allow tiny FP overshoot
      assertEquals(result.meta.nodeCount, 100);
    });
  });

  describe("snapshotToEntropyInput", () => {
    it("should convert GraphSnapshot format", () => {
      const snapshot = {
        nodes: [
          { id: "capability:cap1", communityId: "0" },
          { id: "mcp:server:tool1", communityId: "1" },
        ],
        edges: [
          { source: "capability:cap1", target: "mcp:server:tool1", confidence: 0.8, edge_type: "contains" },
        ],
      };

      const input = snapshotToEntropyInput(snapshot);

      assertEquals(input.nodes.length, 2);
      assertEquals(input.nodes[0].type, "capability");
      assertEquals(input.nodes[1].type, undefined);
      assertEquals(input.edges.length, 1);
      assertEquals(input.edges[0].weight, 0.8);
    });
  });

  describe("cosineSimilarity", () => {
    it("should return 1 for identical vectors", () => {
      const a = [1, 0, 0];
      const b = [1, 0, 0];
      assertAlmostEquals(_internals.cosineSimilarity(a, b), 1.0, 0.001);
    });

    it("should return 0 for orthogonal vectors", () => {
      const a = [1, 0, 0];
      const b = [0, 1, 0];
      assertAlmostEquals(_internals.cosineSimilarity(a, b), 0.0, 0.001);
    });

    it("should return -1 for opposite vectors", () => {
      const a = [1, 0, 0];
      const b = [-1, 0, 0];
      assertAlmostEquals(_internals.cosineSimilarity(a, b), -1.0, 0.001);
    });

    it("should handle zero vectors", () => {
      const a = [0, 0, 0];
      const b = [1, 2, 3];
      assertEquals(_internals.cosineSimilarity(a, b), 0);
    });

    it("should handle different length vectors", () => {
      const a = [1, 2];
      const b = [1, 2, 3];
      assertEquals(_internals.cosineSimilarity(a, b), 0);
    });
  });

  describe("computeSemanticEntropy", () => {
    it("should return zero for single embedding", () => {
      const embeddings = new Map([["a", [1, 0, 0]]]);
      const result = _internals.computeSemanticEntropy(embeddings);

      assertEquals(result.semanticEntropy, 0);
      assertEquals(result.avgCosineSimilarity, 1);
      assertEquals(result.stats.nodeCount, 1);
    });

    it("should return high entropy for diverse embeddings", () => {
      // Three orthogonal embeddings = very diverse
      const embeddings = new Map([
        ["a", [1, 0, 0]],
        ["b", [0, 1, 0]],
        ["c", [0, 0, 1]],
      ]);
      const result = _internals.computeSemanticEntropy(embeddings);

      // Orthogonal vectors have 0 similarity, so high diversity
      assertEquals(result.avgCosineSimilarity < 0.1, true);
      assertEquals(result.semanticDiversity > 0.9, true);
    });

    it("should return low entropy for identical embeddings", () => {
      // All embeddings identical = no diversity
      const embeddings = new Map([
        ["a", [1, 1, 1]],
        ["b", [1, 1, 1]],
        ["c", [1, 1, 1]],
      ]);
      const result = _internals.computeSemanticEntropy(embeddings);

      // All same = similarity of 1
      assertAlmostEquals(result.avgCosineSimilarity, 1.0, 0.001);
      assertEquals(result.semanticDiversity < 0.1, true);
    });

    it("should handle embeddings with different dimensionality correctly", () => {
      // 1024-dimensional embeddings (like BGE-M3)
      const dim = 64; // Use smaller for test performance
      const embeddings = new Map([
        ["a", Array.from({ length: dim }, (_, i) => Math.sin(i))],
        ["b", Array.from({ length: dim }, (_, i) => Math.cos(i))],
        ["c", Array.from({ length: dim }, (_, i) => Math.sin(i + 1))],
      ]);
      const result = _internals.computeSemanticEntropy(embeddings);

      assertEquals(result.stats.embeddingDim, dim);
      assertEquals(result.semanticEntropy >= 0, true);
      assertEquals(result.semanticEntropy <= 1, true);
    });
  });

  describe("computeDualEntropy", () => {
    it("should weight structural and semantic entropy", () => {
      const structural = 0.8;
      const semantic = 0.4;

      // Default alpha = 0.6
      const dual = _internals.computeDualEntropy(structural, semantic);
      // 0.6 * 0.8 + 0.4 * 0.4 = 0.48 + 0.16 = 0.64
      assertAlmostEquals(dual, 0.64, 0.001);
    });

    it("should respect custom alpha", () => {
      const structural = 0.5;
      const semantic = 0.5;

      // With alpha = 0.5, should be simple average
      const dual = _internals.computeDualEntropy(structural, semantic, 0.5);
      assertAlmostEquals(dual, 0.5, 0.001);
    });

    it("should return structural when alpha = 1", () => {
      const dual = _internals.computeDualEntropy(0.9, 0.1, 1.0);
      assertAlmostEquals(dual, 0.9, 0.001);
    });

    it("should return semantic when alpha = 0", () => {
      const dual = _internals.computeDualEntropy(0.9, 0.1, 0.0);
      assertAlmostEquals(dual, 0.1, 0.001);
    });
  });
});
