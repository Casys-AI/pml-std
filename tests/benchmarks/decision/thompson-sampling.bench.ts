/**
 * Thompson Sampling Benchmarks
 *
 * Benchmarks for Intelligent Adaptive Thresholds (ADR-049).
 * Tests Thompson Sampling decision making for tool execution.
 *
 * Run: deno bench --allow-all tests/benchmarks/decision/thompson-sampling.bench.ts
 *
 * @module tests/benchmarks/decision/thompson-sampling
 */

import { loadScenario } from "../fixtures/scenario-loader.ts";
import {
  classifyToolRisk,
  createThompsonForMode,
  makeDecision,
  type RiskCategory,
  ThompsonSampler,
  type ThresholdMode,
} from "../../../src/graphrag/algorithms/thompson.ts";

// ============================================================================
// Setup
// ============================================================================

const mediumScenario = await loadScenario("medium-graph");

// Create sampler instances
const sampler = new ThompsonSampler();

// Pre-populate with some observations
const toolIds = mediumScenario.nodes.tools.map((t) => t.id);
for (let i = 0; i < 100; i++) {
  const toolId = toolIds[Math.floor(Math.random() * toolIds.length)];
  sampler.recordOutcome(toolId, Math.random() > 0.3); // 70% success rate
}

// Create mode-specific samplers
const activeSampler = createThompsonForMode("active_search");
const passiveSampler = createThompsonForMode("passive_suggestion");
const speculationSampler = createThompsonForMode("speculation");

// Pre-populate mode samplers
for (let i = 0; i < 50; i++) {
  const toolId = toolIds[Math.floor(Math.random() * toolIds.length)];
  activeSampler.recordOutcome(toolId, Math.random() > 0.2);
  passiveSampler.recordOutcome(toolId, Math.random() > 0.3);
  speculationSampler.recordOutcome(toolId, Math.random() > 0.4);
}

// ============================================================================
// Benchmarks: Single Threshold Sampling
// ============================================================================

Deno.bench({
  name: "Thompson: sample single threshold",
  group: "thompson-single",
  baseline: true,
  fn: () => {
    sampler.sampleThreshold(toolIds[0]);
  },
});

Deno.bench({
  name: "Thompson: sample with cold start (new tool)",
  group: "thompson-single",
  fn: () => {
    sampler.sampleThreshold(`new_tool_${Math.random()}`);
  },
});

Deno.bench({
  name: "Thompson: getThreshold with breakdown",
  group: "thompson-single",
  fn: () => {
    sampler.getThreshold(toolIds[0], "moderate", "passive_suggestion", 0.75);
  },
});

// ============================================================================
// Benchmarks: Mode-Specific Thresholds
// ============================================================================

Deno.bench({
  name: "Thompson: active search mode",
  group: "thompson-modes",
  baseline: true,
  fn: () => {
    activeSampler.getThreshold(toolIds[0], "safe", "active_search", 0.6);
  },
});

Deno.bench({
  name: "Thompson: passive suggestion mode",
  group: "thompson-modes",
  fn: () => {
    passiveSampler.getThreshold(toolIds[0], "moderate", "passive_suggestion", 0.75);
  },
});

Deno.bench({
  name: "Thompson: speculation mode",
  group: "thompson-modes",
  fn: () => {
    speculationSampler.getThreshold(toolIds[0], "dangerous", "speculation", 0.9);
  },
});

// ============================================================================
// Benchmarks: Batch Sampling
// ============================================================================

Deno.bench({
  name: "Thompson: batch sample 5 tools",
  group: "thompson-batch",
  baseline: true,
  fn: () => {
    sampler.sampleBatch(toolIds.slice(0, 5));
  },
});

Deno.bench({
  name: "Thompson: batch sample 10 tools",
  group: "thompson-batch",
  fn: () => {
    sampler.sampleBatch(toolIds.slice(0, 10));
  },
});

Deno.bench({
  name: "Thompson: batch sample 20 tools",
  group: "thompson-batch",
  fn: () => {
    sampler.sampleBatch(toolIds.slice(0, 20));
  },
});

// ============================================================================
// Benchmarks: Update Operations
// ============================================================================

Deno.bench({
  name: "Thompson: single update (success)",
  group: "thompson-update",
  baseline: true,
  fn: () => {
    sampler.recordOutcome(toolIds[0], true);
  },
});

Deno.bench({
  name: "Thompson: single update (failure)",
  group: "thompson-update",
  fn: () => {
    sampler.recordOutcome(toolIds[0], false);
  },
});

Deno.bench({
  name: "Thompson: batch update (10 observations)",
  group: "thompson-update",
  fn: () => {
    for (let i = 0; i < 10; i++) {
      sampler.recordOutcome(toolIds[i % toolIds.length], Math.random() > 0.3);
    }
  },
});

// ============================================================================
// Benchmarks: UCB Bonus Calculation
// ============================================================================

Deno.bench({
  name: "Thompson: UCB bonus (established tool)",
  group: "thompson-ucb",
  baseline: true,
  fn: () => {
    sampler.getUCBBonus(toolIds[0]);
  },
});

Deno.bench({
  name: "Thompson: UCB bonus (new tool)",
  group: "thompson-ucb",
  fn: () => {
    sampler.getUCBBonus(`new_tool_${Math.random()}`);
  },
});

Deno.bench({
  name: "Thompson: UCB bonus batch (10 tools)",
  group: "thompson-ucb",
  fn: () => {
    for (const toolId of toolIds.slice(0, 10)) {
      sampler.getUCBBonus(toolId);
    }
  },
});

// ============================================================================
// Benchmarks: Beta Distribution Sampling
// ============================================================================

Deno.bench({
  name: "Beta: sample uniform (1, 1)",
  group: "beta-sampling",
  baseline: true,
  fn: () => {
    sampler.sampleBeta(1, 1);
  },
});

Deno.bench({
  name: "Beta: sample skewed success (10, 2)",
  group: "beta-sampling",
  fn: () => {
    sampler.sampleBeta(10, 2);
  },
});

Deno.bench({
  name: "Beta: sample skewed failure (2, 10)",
  group: "beta-sampling",
  fn: () => {
    sampler.sampleBeta(2, 10);
  },
});

Deno.bench({
  name: "Beta: sample high observations (100, 30)",
  group: "beta-sampling",
  fn: () => {
    sampler.sampleBeta(100, 30);
  },
});

// ============================================================================
// Benchmarks: Risk Classification
// ============================================================================

Deno.bench({
  name: "Risk: classify read_file",
  group: "risk-classify",
  baseline: true,
  fn: () => {
    classifyToolRisk("read_file");
  },
});

Deno.bench({
  name: "Risk: classify write_file",
  group: "risk-classify",
  fn: () => {
    classifyToolRisk("write_file");
  },
});

Deno.bench({
  name: "Risk: classify delete_file",
  group: "risk-classify",
  fn: () => {
    classifyToolRisk("delete_file");
  },
});

Deno.bench({
  name: "Risk: classify unknown tool",
  group: "risk-classify",
  fn: () => {
    classifyToolRisk("some_custom_tool");
  },
});

// ============================================================================
// Benchmarks: Decision Making (Full Pipeline)
// ============================================================================

Deno.bench({
  name: "Thompson: full decision (single tool)",
  group: "thompson-decision",
  baseline: true,
  fn: () => {
    makeDecision(sampler, toolIds[0], 0.75, "moderate", "passive_suggestion", 0.75);
  },
});

Deno.bench({
  name: "Thompson: full decision (5 tools)",
  group: "thompson-decision",
  fn: () => {
    for (const toolId of toolIds.slice(0, 5)) {
      makeDecision(sampler, toolId, 0.75, "moderate", "passive_suggestion", 0.75);
    }
  },
});

Deno.bench({
  name: "Thompson: full decision (10 tools)",
  group: "thompson-decision",
  fn: () => {
    for (const toolId of toolIds.slice(0, 10)) {
      makeDecision(sampler, toolId, 0.75, "moderate", "passive_suggestion", 0.75);
    }
  },
});

// ============================================================================
// Benchmarks: Comparison with Static Threshold
// ============================================================================

function staticDecision(score: number, threshold: number = 0.7): boolean {
  return score >= threshold;
}

Deno.bench({
  name: "Static threshold: single decision",
  group: "thompson-vs-static",
  baseline: true,
  fn: () => {
    staticDecision(0.75);
  },
});

Deno.bench({
  name: "Thompson: single decision",
  group: "thompson-vs-static",
  fn: () => {
    makeDecision(sampler, toolIds[0], 0.75, "moderate", "passive_suggestion", 0.75);
  },
});

// ============================================================================
// Benchmarks: Statistics API
// ============================================================================

Deno.bench({
  name: "Thompson: get mean",
  group: "thompson-stats",
  baseline: true,
  fn: () => {
    sampler.getMean(toolIds[0]);
  },
});

Deno.bench({
  name: "Thompson: get variance",
  group: "thompson-stats",
  fn: () => {
    sampler.getVariance(toolIds[0]);
  },
});

Deno.bench({
  name: "Thompson: get confidence interval",
  group: "thompson-stats",
  fn: () => {
    sampler.getConfidenceInterval(toolIds[0]);
  },
});

// ============================================================================
// Cleanup
// ============================================================================

globalThis.addEventListener("unload", () => {
  console.log("\nThompson Sampling Benchmark Summary:");
  console.log(`- Tools tested: ${toolIds.length}`);
  console.log(`- Total executions: ${sampler.getTotalExecutions()}`);
  console.log(`- Modes tested: active_search, passive_suggestion, speculation`);
  console.log("");
  console.log("Thompson Sampling (ADR-049) provides:");
  console.log("- Per-tool adaptive thresholds");
  console.log("- UCB exploration bonus for new tools");
  console.log("- Bayesian updating with each observation");
  console.log("- Mode-specific behavior (ADR-038 pattern)");
  console.log("- Risk-based base thresholds");
});
