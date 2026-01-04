/**
 * V→V Co-occurrence Enrichment Benchmark
 *
 * Validates that V→V message passing from n8n workflow patterns
 * actually improves tool embedding quality.
 *
 * Metrics:
 * - Co-occurring tools become more similar after enrichment
 * - Non-co-occurring tools maintain distinctiveness
 * - MRR improvement for tool recommendation
 *
 * @module tests/benchmarks/shgat-v2v-cooccurrence.bench
 */

import { assertEquals } from "@std/assert";
import {
  buildCooccurrenceMatrix,
  VertexToVertexPhase,
  type CooccurrenceEntry,
} from "../../src/graphrag/algorithms/shgat/message-passing/mod.ts";
import { PatternStore } from "../../src/graphrag/workflow-patterns/mod.ts";

// ============================================================================
// Helpers
// ============================================================================

/** Generate normalized random embedding */
function randomEmbedding(dim: number, seed: number): number[] {
  // Simple seeded PRNG (mulberry32)
  let state = seed;
  const rand = () => {
    state |= 0;
    state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const emb = Array.from({ length: dim }, () => rand() - 0.5);
  const norm = Math.sqrt(emb.reduce((s, x) => s + x * x, 0));
  return norm > 0 ? emb.map((x) => x / norm) : emb;
}

/** Cosine similarity */
function cosineSim(a: number[], b: number[]): number {
  const dot = a.reduce((s, x, i) => s + x * b[i], 0);
  const normA = Math.sqrt(a.reduce((s, x) => s + x * x, 0));
  const normB = Math.sqrt(b.reduce((s, x) => s + x * x, 0));
  return normA * normB > 0 ? dot / (normA * normB) : 0;
}

/** Compute average similarity for co-occurring pairs */
function avgCooccurringSimilarity(
  embeddings: number[][],
  cooccurrence: CooccurrenceEntry[],
): number {
  if (cooccurrence.length === 0) return 0;

  let sum = 0;
  let count = 0;
  const seen = new Set<string>();

  for (const entry of cooccurrence) {
    const key = `${Math.min(entry.from, entry.to)}:${Math.max(entry.from, entry.to)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (entry.from < embeddings.length && entry.to < embeddings.length) {
      sum += cosineSim(embeddings[entry.from], embeddings[entry.to]);
      count++;
    }
  }

  return count > 0 ? sum / count : 0;
}

/** Compute average similarity for random non-co-occurring pairs */
function avgNonCooccurringSimilarity(
  embeddings: number[][],
  cooccurrence: CooccurrenceEntry[],
  sampleSize: number = 100,
): number {
  const coocSet = new Set<string>();
  for (const entry of cooccurrence) {
    coocSet.add(`${entry.from}:${entry.to}`);
    coocSet.add(`${entry.to}:${entry.from}`);
  }

  let sum = 0;
  let count = 0;
  const n = embeddings.length;

  // Sample random pairs
  for (let k = 0; k < sampleSize && count < sampleSize; k++) {
    const i = Math.floor(Math.random() * n);
    const j = Math.floor(Math.random() * n);
    if (i === j) continue;
    if (coocSet.has(`${i}:${j}`)) continue;

    sum += cosineSim(embeddings[i], embeddings[j]);
    count++;
  }

  return count > 0 ? sum / count : 0;
}

// ============================================================================
// Benchmarks
// ============================================================================

Deno.test("V2V Bench - load real patterns and build matrix", async () => {
  const store = new PatternStore("config/workflow-patterns.json");
  const patterns = await store.load();

  if (!patterns) {
    console.log("⚠️  No patterns file found, skipping");
    return;
  }

  console.log(`\n📊 Loaded ${patterns.priorPatterns.length} prior patterns`);
  console.log(`   From ${patterns.workflowsProcessed} n8n workflows`);

  // Build tool index
  const toolIndex = new Map<string, number>();
  for (const p of patterns.priorPatterns) {
    if (!toolIndex.has(p.from)) toolIndex.set(p.from, toolIndex.size);
    if (!toolIndex.has(p.to)) toolIndex.set(p.to, toolIndex.size);
  }

  console.log(`   ${toolIndex.size} unique tools`);

  // Build co-occurrence matrix
  const cooc = buildCooccurrenceMatrix(
    patterns.priorPatterns.map((p) => ({
      from: p.from,
      to: p.to,
      weight: p.weight,
      frequency: p.frequency,
    })),
    toolIndex,
  );

  console.log(`   ${cooc.length} co-occurrence edges`);

  assertEquals(cooc.length > 0, true, "Should have co-occurrence edges");
});

Deno.test("V2V Bench - enrichment increases co-occurring similarity", async () => {
  const store = new PatternStore("config/workflow-patterns.json");
  const patterns = await store.load();

  if (!patterns || patterns.priorPatterns.length < 10) {
    console.log("⚠️  Not enough patterns, skipping");
    return;
  }

  // Build tool index
  const toolIndex = new Map<string, number>();
  for (const p of patterns.priorPatterns) {
    if (!toolIndex.has(p.from)) toolIndex.set(p.from, toolIndex.size);
    if (!toolIndex.has(p.to)) toolIndex.set(p.to, toolIndex.size);
  }

  const numTools = toolIndex.size;
  const dim = 1024;

  // Generate initial random embeddings (seeded for reproducibility)
  const H_init: number[][] = [];
  for (let i = 0; i < numTools; i++) {
    H_init.push(randomEmbedding(dim, 42 + i));
  }

  // Build co-occurrence matrix
  const cooc = buildCooccurrenceMatrix(
    patterns.priorPatterns.map((p) => ({
      from: p.from,
      to: p.to,
      weight: p.weight,
      frequency: p.frequency,
    })),
    toolIndex,
  );

  // Measure BEFORE enrichment
  const simCoocBefore = avgCooccurringSimilarity(H_init, cooc);
  const simNonCoocBefore = avgNonCooccurringSimilarity(H_init, cooc);

  // Apply V→V enrichment
  const phase = new VertexToVertexPhase({ residualWeight: 0.5 });
  const { embeddings: H_enriched } = phase.forward(H_init, cooc);

  // Measure AFTER enrichment
  const simCoocAfter = avgCooccurringSimilarity(H_enriched, cooc);
  const simNonCoocAfter = avgNonCooccurringSimilarity(H_enriched, cooc);

  console.log("\n📈 V→V Enrichment Impact:");
  console.log(`   Co-occurring pairs:`);
  console.log(`     Before: ${simCoocBefore.toFixed(4)}`);
  console.log(`     After:  ${simCoocAfter.toFixed(4)}`);
  console.log(`     Delta:  ${(simCoocAfter - simCoocBefore).toFixed(4)} (${simCoocAfter > simCoocBefore ? "✓ improved" : "✗ decreased"})`);
  console.log(`   Non-co-occurring pairs:`);
  console.log(`     Before: ${simNonCoocBefore.toFixed(4)}`);
  console.log(`     After:  ${simNonCoocAfter.toFixed(4)}`);
  console.log(`   Discrimination ratio (cooc/non-cooc):`);
  console.log(`     Before: ${(simCoocBefore / (simNonCoocBefore || 0.001)).toFixed(2)}x`);
  console.log(`     After:  ${(simCoocAfter / (simNonCoocAfter || 0.001)).toFixed(2)}x`);

  // Validate: co-occurring similarity should increase
  assertEquals(
    simCoocAfter > simCoocBefore,
    true,
    "Co-occurring tools should become more similar after V→V",
  );
});

Deno.test("V2V Bench - residual weight impact", async () => {
  const store = new PatternStore("config/workflow-patterns.json");
  const patterns = await store.load();

  if (!patterns || patterns.priorPatterns.length < 10) {
    console.log("⚠️  Not enough patterns, skipping");
    return;
  }

  // Build tool index
  const toolIndex = new Map<string, number>();
  for (const p of patterns.priorPatterns) {
    if (!toolIndex.has(p.from)) toolIndex.set(p.from, toolIndex.size);
    if (!toolIndex.has(p.to)) toolIndex.set(p.to, toolIndex.size);
  }

  const numTools = toolIndex.size;
  const dim = 1024;

  // Generate initial embeddings
  const H_init: number[][] = [];
  for (let i = 0; i < numTools; i++) {
    H_init.push(randomEmbedding(dim, 42 + i));
  }

  const cooc = buildCooccurrenceMatrix(
    patterns.priorPatterns.map((p) => ({
      from: p.from,
      to: p.to,
      weight: p.weight,
      frequency: p.frequency,
    })),
    toolIndex,
  );

  console.log("\n📊 Residual Weight Comparison:");
  console.log("   β     | CoocSim | NonCoocSim | Ratio");
  console.log("   ------|---------|------------|------");

  for (const beta of [0.1, 0.3, 0.5, 0.7, 1.0]) {
    const phase = new VertexToVertexPhase({ residualWeight: beta });
    const { embeddings } = phase.forward(H_init, cooc);

    const simCooc = avgCooccurringSimilarity(embeddings, cooc);
    const simNonCooc = avgNonCooccurringSimilarity(embeddings, cooc);
    const ratio = simCooc / (simNonCooc || 0.001);

    console.log(
      `   ${beta.toFixed(1)}   | ${simCooc.toFixed(4)}  | ${simNonCooc.toFixed(4)}     | ${ratio.toFixed(2)}x`,
    );
  }
});

Deno.test("V2V Bench - performance at scale", async () => {
  const numTools = 500;
  const dim = 1024;
  const numEdges = 2000;

  // Generate random embeddings
  const H: number[][] = [];
  for (let i = 0; i < numTools; i++) {
    H.push(randomEmbedding(dim, i));
  }

  // Generate random co-occurrence edges
  const cooc: CooccurrenceEntry[] = [];
  for (let k = 0; k < numEdges; k++) {
    const from = Math.floor(Math.random() * numTools);
    const to = Math.floor(Math.random() * numTools);
    if (from !== to) {
      cooc.push({ from, to, weight: Math.random() });
    }
  }

  const phase = new VertexToVertexPhase();

  // Warmup
  phase.forward(H.slice(0, 10), cooc.slice(0, 10));

  // Benchmark
  const iterations = 5;
  const times: number[] = [];

  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    phase.forward(H, cooc);
    times.push(performance.now() - start);
  }

  const avgTime = times.reduce((a, b) => a + b, 0) / times.length;
  const minTime = Math.min(...times);

  console.log("\n⚡ V→V Performance:");
  console.log(`   ${numTools} tools × ${dim}d embeddings`);
  console.log(`   ${numEdges} co-occurrence edges`);
  console.log(`   Avg: ${avgTime.toFixed(2)}ms`);
  console.log(`   Min: ${minTime.toFixed(2)}ms`);

  // Should complete in reasonable time
  assertEquals(avgTime < 1000, true, "V→V should complete in < 1s for 500 tools");
});

Deno.test("V2V Bench - top co-occurring pairs", async () => {
  const store = new PatternStore("config/workflow-patterns.json");
  const patterns = await store.load();

  if (!patterns) {
    console.log("⚠️  No patterns file found, skipping");
    return;
  }

  // Sort by frequency
  const sorted = [...patterns.priorPatterns].sort((a, b) => b.frequency - a.frequency);

  console.log("\n🔝 Top 10 Co-occurring Tool Pairs:");
  console.log("   Freq | From → To");
  console.log("   -----|----------");

  for (const p of sorted.slice(0, 10)) {
    console.log(`   ${String(p.frequency).padStart(4)} | ${p.from} → ${p.to}`);
  }
});
