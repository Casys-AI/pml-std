/**
 * V→V Message Passing Phase Tests
 *
 * Tests for co-occurrence based tool-to-tool message passing.
 *
 * @module tests/unit/graphrag/shgat/vertex-to-vertex-phase_test
 */

import { assertEquals } from "@std/assert";
import {
  buildCooccurrenceMatrix,
  DEFAULT_V2V_CONFIG,
  VertexToVertexPhase,
  type CooccurrenceEntry,
} from "../../../../src/graphrag/algorithms/shgat/message-passing/vertex-to-vertex-phase.ts";

// Helper: create normalized random embedding
function randomEmbedding(dim: number): number[] {
  const emb = Array.from({ length: dim }, () => Math.random() - 0.5);
  const norm = Math.sqrt(emb.reduce((s, x) => s + x * x, 0));
  return norm > 0 ? emb.map((x) => x / norm) : emb;
}

// Helper: compute cosine similarity
function cosineSim(a: number[], b: number[]): number {
  const dot = a.reduce((s, x, i) => s + x * b[i], 0);
  const normA = Math.sqrt(a.reduce((s, x) => s + x * x, 0));
  const normB = Math.sqrt(b.reduce((s, x) => s + x * x, 0));
  return normA * normB > 0 ? dot / (normA * normB) : 0;
}

// ============================================================================
// VertexToVertexPhase Tests
// ============================================================================

Deno.test("V2V forward - empty input returns empty output", () => {
  const phase = new VertexToVertexPhase();
  const result = phase.forward([], []);

  assertEquals(result.embeddings.length, 0);
  assertEquals(result.attentionWeights.length, 0);
});

Deno.test("V2V forward - single tool with no co-occurrence keeps original", () => {
  const phase = new VertexToVertexPhase();
  const H = [randomEmbedding(1024)];
  const cooc: CooccurrenceEntry[] = [];

  const result = phase.forward(H, cooc);

  assertEquals(result.embeddings.length, 1);
  // Should be normalized version of original (no aggregation happened)
  const sim = cosineSim(H[0], result.embeddings[0]);
  assertEquals(sim > 0.99, true, "Single tool should keep original direction");
});

Deno.test("V2V forward - two co-occurring tools get enriched", () => {
  const phase = new VertexToVertexPhase({ residualWeight: 0.5 });

  // Two distinct embeddings
  const H = [
    [1, 0, 0, 0, 0, 0, 0, 0], // Tool 0: points in dim 0
    [0, 1, 0, 0, 0, 0, 0, 0], // Tool 1: points in dim 1
  ];

  // They co-occur
  const cooc: CooccurrenceEntry[] = [
    { from: 0, to: 1, weight: 1.0 },
    { from: 1, to: 0, weight: 1.0 },
  ];

  const result = phase.forward(H, cooc);

  // After enrichment, each tool should have some component from the other
  // Tool 0 should now have some weight in dim 1 (from tool 1)
  assertEquals(result.embeddings[0][1] > 0, true, "Tool 0 should gain dim 1 from tool 1");
  // Tool 1 should now have some weight in dim 0 (from tool 0)
  assertEquals(result.embeddings[1][0] > 0, true, "Tool 1 should gain dim 0 from tool 0");
});

Deno.test("V2V forward - residual connection preserves original info", () => {
  const phase = new VertexToVertexPhase({ residualWeight: 0.3 });

  const original = [1, 0, 0, 0, 0, 0, 0, 0];
  const neighbor = [0, 1, 0, 0, 0, 0, 0, 0];
  const H = [original, neighbor];

  const cooc: CooccurrenceEntry[] = [
    { from: 0, to: 1, weight: 1.0 },
  ];

  const result = phase.forward(H, cooc);

  // Original direction should still be dominant (residual = 0.3 means 70% original)
  const enriched = result.embeddings[0];
  // Dim 0 (original) should be larger than dim 1 (from neighbor)
  assertEquals(enriched[0] > enriched[1], true, "Original dimension should dominate");
});

Deno.test("V2V forward - attention weights are computed and stored", () => {
  const phase = new VertexToVertexPhase({ useAttention: true });

  const H = [
    randomEmbedding(64),
    randomEmbedding(64),
    randomEmbedding(64),
  ];

  const cooc: CooccurrenceEntry[] = [
    { from: 0, to: 1, weight: 0.8 },
    { from: 0, to: 2, weight: 0.5 },
  ];

  const result = phase.forward(H, cooc);

  // Should have attention weights for both neighbors
  assertEquals(result.attentionWeights.length, 2);

  // Attention weights should sum to 1 for each source
  const weightsForTool0 = result.attentionWeights.filter((w) => w.from === 0);
  const sum = weightsForTool0.reduce((s, w) => s + w.weight, 0);
  assertEquals(Math.abs(sum - 1.0) < 0.01, true, "Attention weights should sum to 1");
});

Deno.test("V2V forward - higher co-occurrence weight means more influence", () => {
  const phase = new VertexToVertexPhase({ useAttention: true, residualWeight: 1.0 });

  // Source tool and two neighbors - use similar embeddings so cosine similarity is positive
  const H = [
    [1, 0.5, 0.3, 0], // Tool 0 (source)
    [0.8, 0.6, 0.2, 0], // Tool 1 (strong co-occurrence) - similar to tool 0
    [0.7, 0.4, 0.5, 0], // Tool 2 (weak co-occurrence) - also similar to tool 0
  ];

  const cooc: CooccurrenceEntry[] = [
    { from: 0, to: 1, weight: 0.9 }, // Strong
    { from: 0, to: 2, weight: 0.1 }, // Weak
  ];

  const result = phase.forward(H, cooc);

  // Check attention weights: higher cooc weight should give higher attention
  const attFor0 = result.attentionWeights.filter((w) => w.from === 0);
  const attTo1 = attFor0.find((w) => w.to === 1)?.weight ?? 0;
  const attTo2 = attFor0.find((w) => w.to === 2)?.weight ?? 0;

  assertEquals(attTo1 > attTo2, true, "Higher cooc weight should give higher attention");
});

Deno.test("V2V forward - embeddings are L2 normalized", () => {
  const phase = new VertexToVertexPhase();

  const H = [randomEmbedding(128), randomEmbedding(128)];
  const cooc: CooccurrenceEntry[] = [
    { from: 0, to: 1, weight: 0.5 },
    { from: 1, to: 0, weight: 0.5 },
  ];

  const result = phase.forward(H, cooc);

  // Check L2 norm of each output embedding
  for (const emb of result.embeddings) {
    const norm = Math.sqrt(emb.reduce((s, x) => s + x * x, 0));
    assertEquals(Math.abs(norm - 1.0) < 0.01, true, "Output should be L2 normalized");
  }
});

Deno.test("V2V forward - out of bounds indices are ignored", () => {
  const phase = new VertexToVertexPhase();

  const H = [randomEmbedding(32), randomEmbedding(32)];

  // Include invalid index (tool 5 doesn't exist)
  const cooc: CooccurrenceEntry[] = [
    { from: 0, to: 1, weight: 0.5 },
    { from: 0, to: 5, weight: 0.9 }, // Invalid: tool 5 doesn't exist
    { from: 5, to: 0, weight: 0.9 }, // Invalid: tool 5 doesn't exist
  ];

  // Should not throw
  const result = phase.forward(H, cooc);
  assertEquals(result.embeddings.length, 2);
});

Deno.test("V2V forward - self-loops don't cause issues", () => {
  const phase = new VertexToVertexPhase();

  const H = [randomEmbedding(32)];

  // Self-loop (should be handled gracefully)
  const cooc: CooccurrenceEntry[] = [
    { from: 0, to: 0, weight: 1.0 },
  ];

  const result = phase.forward(H, cooc);
  assertEquals(result.embeddings.length, 1);
  // Embedding should still be valid (normalized)
  const norm = Math.sqrt(result.embeddings[0].reduce((s, x) => s + x * x, 0));
  assertEquals(Math.abs(norm - 1.0) < 0.01, true);
});

// ============================================================================
// buildCooccurrenceMatrix Tests
// ============================================================================

Deno.test("buildCooccurrenceMatrix - creates bidirectional edges", () => {
  const patterns = [
    { from: "tool:a", to: "tool:b", weight: 1.0, frequency: 10 },
  ];
  const toolIndex = new Map([
    ["tool:a", 0],
    ["tool:b", 1],
  ]);

  const entries = buildCooccurrenceMatrix(patterns, toolIndex);

  // Should have 2 entries (bidirectional)
  assertEquals(entries.length, 2);
  assertEquals(entries.some((e) => e.from === 0 && e.to === 1), true);
  assertEquals(entries.some((e) => e.from === 1 && e.to === 0), true);
});

Deno.test("buildCooccurrenceMatrix - skips unknown tools", () => {
  const patterns = [
    { from: "tool:a", to: "tool:unknown", weight: 1.0, frequency: 5 },
  ];
  const toolIndex = new Map([
    ["tool:a", 0],
    // tool:unknown not in index
  ]);

  const entries = buildCooccurrenceMatrix(patterns, toolIndex);

  assertEquals(entries.length, 0, "Should skip patterns with unknown tools");
});

Deno.test("buildCooccurrenceMatrix - converts weight to co-occurrence", () => {
  // Lower weight in PriorPattern = higher frequency = higher co-occurrence
  const patterns = [
    { from: "tool:a", to: "tool:b", weight: 0.5, frequency: 100 }, // Low weight = high cooc
    { from: "tool:a", to: "tool:c", weight: 2.0, frequency: 5 }, // High weight = low cooc
  ];
  const toolIndex = new Map([
    ["tool:a", 0],
    ["tool:b", 1],
    ["tool:c", 2],
  ]);

  const entries = buildCooccurrenceMatrix(patterns, toolIndex);

  const abEntry = entries.find((e) => e.from === 0 && e.to === 1);
  const acEntry = entries.find((e) => e.from === 0 && e.to === 2);

  // a→b should have higher co-occurrence weight than a→c
  assertEquals(abEntry!.weight > acEntry!.weight, true, "Lower pattern weight = higher cooc");
});

Deno.test("buildCooccurrenceMatrix - deduplicates same-direction edges", () => {
  const patterns = [
    { from: "tool:a", to: "tool:b", weight: 1.0, frequency: 10 },
    { from: "tool:a", to: "tool:b", weight: 0.8, frequency: 15 }, // Duplicate direction
  ];
  const toolIndex = new Map([
    ["tool:a", 0],
    ["tool:b", 1],
  ]);

  const entries = buildCooccurrenceMatrix(patterns, toolIndex);

  // Should deduplicate: first pattern wins for each direction
  // a→b and b→a = 2 entries (not 4)
  assertEquals(entries.length, 2);

  // Both directions should exist
  assertEquals(entries.some((e) => e.from === 0 && e.to === 1), true, "a→b should exist");
  assertEquals(entries.some((e) => e.from === 1 && e.to === 0), true, "b→a should exist");
});

// ============================================================================
// Configuration Tests
// ============================================================================

Deno.test("V2V config - default values", () => {
  assertEquals(DEFAULT_V2V_CONFIG.residualWeight, 0.3);
  assertEquals(DEFAULT_V2V_CONFIG.useAttention, true);
  assertEquals(DEFAULT_V2V_CONFIG.temperature, 1.0);
});

Deno.test("V2V config - custom values are applied", () => {
  const phase = new VertexToVertexPhase({
    residualWeight: 0.8,
    useAttention: false,
    temperature: 0.5,
  });

  const config = phase.getConfig();
  assertEquals(config.residualWeight, 0.8);
  assertEquals(config.useAttention, false);
  assertEquals(config.temperature, 0.5);
});

Deno.test("V2V getName returns correct identifier", () => {
  const phase = new VertexToVertexPhase();
  assertEquals(phase.getName(), "Vertex→Vertex");
});
