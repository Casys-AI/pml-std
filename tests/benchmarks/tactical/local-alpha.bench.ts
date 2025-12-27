/**
 * Local Alpha Calculator Benchmarks
 *
 * @deprecated OBSOLETE - ADR-050 supersedes ADR-048
 *
 * These benchmarks test Local Adaptive Alpha (ADR-048) which has been replaced
 * by SHGAT learned attention. The alpha formulas (Embeddings Hybrides, Heat
 * Diffusion, Bayesian) are no longer used in production.
 *
 * See:
 * - ADR-050: Unified Search Simplification (supersedes ADR-048)
 * - shgat-drdsp-prediction.bench.ts for current prediction benchmarks
 *
 * Status: OBSOLETE - kept for historical reference only
 *
 * Run: deno bench --allow-all tests/benchmarks/tactical/local-alpha.bench.ts
 *
 * @module tests/benchmarks/tactical/local-alpha
 */

import { LocalAlphaCalculator } from "../../../src/graphrag/local-alpha.ts";
import {
  buildGraphFromScenario,
  generateStressGraph,
  loadScenario,
} from "../fixtures/scenario-loader.ts";

// Helper to create mock AlphaCalculatorDeps from a graph
function createMockDeps(graph: ReturnType<typeof buildGraphFromScenario>) {
  return {
    graph: graph as any,
    spectralClustering: null,
    getSemanticEmbedding: (_nodeId: string) => null,
    getObservationCount: (_nodeId: string) => 10,
    getParent: (_nodeId: string, _parentType: string) => null,
    getChildren: (_nodeId: string, _childType: string) => [] as string[],
  };
}

// ============================================================================
// Setup
// ============================================================================

const smallScenario = await loadScenario("small-graph");
const mediumScenario = await loadScenario("medium-graph");

const smallGraph = buildGraphFromScenario(smallScenario);
const mediumGraph = buildGraphFromScenario(mediumScenario);

// Generate stress graph
const stressScenario = generateStressGraph({
  toolCount: 200,
  capabilityCount: 30,
  metaCapabilityCount: 5,
  edgeDensity: 0.1,
  toolsPerCapability: { min: 4, max: 10 },
  capabilitiesPerMeta: { min: 4, max: 8 },
});
const stressGraph = buildGraphFromScenario(stressScenario);

// Get some node IDs for tests (cast to string[] for type safety)
const smallNodes = Array.from(smallGraph.nodes()).slice(0, 5) as string[];
const mediumNodes = Array.from(mediumGraph.nodes()).slice(0, 10) as string[];
const stressNodes = Array.from(stressGraph.nodes()).slice(0, 20) as string[];

// Create calculators with proper deps
const smallCalc = new LocalAlphaCalculator(createMockDeps(smallGraph));
const mediumCalc = new LocalAlphaCalculator(createMockDeps(mediumGraph));
const stressCalc = new LocalAlphaCalculator(createMockDeps(stressGraph));

// ============================================================================
// Benchmarks: Active Search Mode (Embeddings Hybrides)
// ============================================================================

Deno.bench({
  name: "LocalAlpha: active search (small graph)",
  group: "alpha-active",
  baseline: true,
  fn: () => {
    if (smallNodes.length >= 1) {
      smallCalc.getLocalAlpha("active", smallNodes[0], "tool", smallNodes.slice(1, 3));
    }
  },
});

Deno.bench({
  name: "LocalAlpha: active search (medium graph)",
  group: "alpha-active",
  fn: () => {
    if (mediumNodes.length >= 1) {
      mediumCalc.getLocalAlpha("active", mediumNodes[0], "tool", mediumNodes.slice(1, 5));
    }
  },
});

Deno.bench({
  name: "LocalAlpha: active search (stress graph)",
  group: "alpha-active",
  fn: () => {
    if (stressNodes.length >= 1) {
      stressCalc.getLocalAlpha("active", stressNodes[0], "tool", stressNodes.slice(1, 10));
    }
  },
});

// ============================================================================
// Benchmarks: Passive Mode Tools (Heat Diffusion)
// ============================================================================

Deno.bench({
  name: "LocalAlpha: passive tool (small graph)",
  group: "alpha-passive-tool",
  baseline: true,
  fn: () => {
    if (smallNodes.length >= 1) {
      smallCalc.getLocalAlpha("passive", smallNodes[0], "tool", smallNodes.slice(1, 3));
    }
  },
});

Deno.bench({
  name: "LocalAlpha: passive tool (medium graph)",
  group: "alpha-passive-tool",
  fn: () => {
    if (mediumNodes.length >= 1) {
      mediumCalc.getLocalAlpha("passive", mediumNodes[0], "tool", mediumNodes.slice(1, 5));
    }
  },
});

Deno.bench({
  name: "LocalAlpha: passive tool (stress graph)",
  group: "alpha-passive-tool",
  fn: () => {
    if (stressNodes.length >= 1) {
      stressCalc.getLocalAlpha("passive", stressNodes[0], "tool", stressNodes.slice(1, 10));
    }
  },
});

// ============================================================================
// Benchmarks: Passive Mode Capabilities (Heat Diffusion Hierarchical)
// ============================================================================

// Filter for capability nodes (cast to string[] for type safety)
const smallCaps = Array.from(smallGraph.nodes()).filter((n) =>
  smallGraph.getNodeAttribute(n, "type") === "capability"
) as string[];
const mediumCaps = Array.from(mediumGraph.nodes()).filter((n) =>
  mediumGraph.getNodeAttribute(n, "type") === "capability"
) as string[];

Deno.bench({
  name: "LocalAlpha: passive capability (small graph)",
  group: "alpha-passive-cap",
  baseline: true,
  fn: () => {
    if (smallCaps.length >= 1) {
      smallCalc.getLocalAlpha("passive", smallCaps[0], "capability", smallNodes.slice(0, 3));
    }
  },
});

Deno.bench({
  name: "LocalAlpha: passive capability (medium graph)",
  group: "alpha-passive-cap",
  fn: () => {
    if (mediumCaps.length >= 1) {
      mediumCalc.getLocalAlpha("passive", mediumCaps[0], "capability", mediumNodes.slice(0, 5));
    }
  },
});

// ============================================================================
// Benchmarks: Cold Start (Bayesian Fallback)
// ============================================================================

// Use nodes with low degree (cold start candidates)
const isolatedSmall = Array.from(smallGraph.nodes()).filter((n) =>
  smallGraph.degree(n) <= 1
) as string[];
const isolatedMedium = Array.from(mediumGraph.nodes()).filter((n) =>
  mediumGraph.degree(n) <= 1
) as string[];

Deno.bench({
  name: "LocalAlpha: cold start (small graph)",
  group: "alpha-cold",
  baseline: true,
  fn: () => {
    const target = isolatedSmall[0] || smallNodes[0];
    smallCalc.getLocalAlpha("active", target, "tool", []);
  },
});

Deno.bench({
  name: "LocalAlpha: cold start (medium graph)",
  group: "alpha-cold",
  fn: () => {
    const target = isolatedMedium[0] || mediumNodes[0];
    mediumCalc.getLocalAlpha("active", target, "tool", []);
  },
});

// ============================================================================
// Benchmarks: With Breakdown (Full Details)
// ============================================================================

Deno.bench({
  name: "LocalAlpha: with breakdown (small)",
  group: "alpha-breakdown",
  baseline: true,
  fn: () => {
    if (smallNodes.length >= 1) {
      smallCalc.getLocalAlphaWithBreakdown("active", smallNodes[0], "tool", smallNodes.slice(1, 3));
    }
  },
});

Deno.bench({
  name: "LocalAlpha: with breakdown (medium)",
  group: "alpha-breakdown",
  fn: () => {
    if (mediumNodes.length >= 1) {
      mediumCalc.getLocalAlphaWithBreakdown(
        "active",
        mediumNodes[0],
        "tool",
        mediumNodes.slice(1, 5),
      );
    }
  },
});

Deno.bench({
  name: "LocalAlpha: with breakdown (stress)",
  group: "alpha-breakdown",
  fn: () => {
    if (stressNodes.length >= 1) {
      stressCalc.getLocalAlphaWithBreakdown(
        "active",
        stressNodes[0],
        "tool",
        stressNodes.slice(1, 10),
      );
    }
  },
});

// ============================================================================
// Benchmarks: Context Size Scaling
// ============================================================================

Deno.bench({
  name: "LocalAlpha: context size 0",
  group: "alpha-context",
  baseline: true,
  fn: () => {
    if (mediumNodes.length >= 1) {
      mediumCalc.getLocalAlpha("active", mediumNodes[0], "tool", []);
    }
  },
});

Deno.bench({
  name: "LocalAlpha: context size 3",
  group: "alpha-context",
  fn: () => {
    if (mediumNodes.length >= 4) {
      mediumCalc.getLocalAlpha("active", mediumNodes[0], "tool", mediumNodes.slice(1, 4));
    }
  },
});

Deno.bench({
  name: "LocalAlpha: context size 10",
  group: "alpha-context",
  fn: () => {
    if (mediumNodes.length >= 11) {
      mediumCalc.getLocalAlpha("active", mediumNodes[0], "tool", mediumNodes.slice(1, 11));
    }
  },
});

// ============================================================================
// Cleanup
// ============================================================================

globalThis.addEventListener("unload", () => {
  console.log("\nLocal Alpha Benchmark Summary:");
  console.log(`- Small graph: ${smallGraph.order} nodes, ${smallGraph.size} edges`);
  console.log(`- Medium graph: ${mediumGraph.order} nodes, ${mediumGraph.size} edges`);
  console.log(`- Stress graph: ${stressGraph.order} nodes, ${stressGraph.size} edges`);
  console.log(`- Isolated nodes (small): ${isolatedSmall.length}`);
  console.log(`- Isolated nodes (medium): ${isolatedMedium.length}`);
});
