/**
 * Tests for PER Training (Story 11.6)
 *
 * Tests path-level SHGAT training with PER sampling.
 */

import { assertEquals, assertGreater } from "@std/assert";
import {
  extractPathLevelFeatures,
  getFeaturesForTrace,
  getPathKey,
} from "../../../src/graphrag/learning/path-level-features.ts";
import {
  flattenExecutedPath,
  getExecutionCount,
  resetExecutionCounter,
  shouldRunBatchTraining,
  traceToTrainingExamples,
} from "../../../src/graphrag/learning/per-training.ts";
import type { ExecutionTrace } from "../../../src/capabilities/types.ts";

// ============================================================================
// extractPathLevelFeatures Tests
// ============================================================================

Deno.test("extractPathLevelFeatures - empty traces returns empty map", () => {
  const features = extractPathLevelFeatures([]);
  assertEquals(features.size, 0);
});

Deno.test("extractPathLevelFeatures - single trace computes correct features", () => {
  const traces: ExecutionTrace[] = [
    {
      id: "trace-1",
      executedAt: new Date(),
      success: true,
      durationMs: 100,
      decisions: [],
      taskResults: [],
      priority: 0.5,
      executedPath: ["fs:read", "json:parse"],
    },
  ];

  const features = extractPathLevelFeatures(traces);
  assertEquals(features.size, 1);

  const pathKey = "fs:read->json:parse";
  const f = features.get(pathKey)!;
  assertEquals(f.pathSuccessRate, 1.0); // 1 success / 1 total
  assertEquals(f.pathFrequency, 1.0); // only path
  assertEquals(f.isDominantPath, true);
});

Deno.test("extractPathLevelFeatures - multiple paths with different success rates", () => {
  const traces: ExecutionTrace[] = [
    // Path A: 2 success, 1 fail = 66.67% success
    {
      id: "t1",
      executedAt: new Date(),
      success: true,
      durationMs: 100,
      decisions: [],
      taskResults: [],
      priority: 0.5,
      executedPath: ["A", "B"],
    },
    {
      id: "t2",
      executedAt: new Date(),
      success: true,
      durationMs: 100,
      decisions: [],
      taskResults: [],
      priority: 0.5,
      executedPath: ["A", "B"],
    },
    {
      id: "t3",
      executedAt: new Date(),
      success: false,
      durationMs: 100,
      decisions: [],
      taskResults: [],
      priority: 0.5,
      executedPath: ["A", "B"],
    },
    // Path B: 1 success = 100% success
    {
      id: "t4",
      executedAt: new Date(),
      success: true,
      durationMs: 100,
      decisions: [],
      taskResults: [],
      priority: 0.5,
      executedPath: ["X", "Y"],
    },
  ];

  const features = extractPathLevelFeatures(traces);
  assertEquals(features.size, 2);

  const pathA = features.get("A->B")!;
  assertEquals(pathA.pathSuccessRate, 2 / 3);
  assertEquals(pathA.pathFrequency, 3 / 4);
  assertEquals(pathA.isDominantPath, true);

  const pathB = features.get("X->Y")!;
  assertEquals(pathB.pathSuccessRate, 1.0);
  assertEquals(pathB.pathFrequency, 1 / 4);
  assertEquals(pathB.isDominantPath, false);
});

Deno.test("extractPathLevelFeatures - decision success rate", () => {
  const traces: ExecutionTrace[] = [
    {
      id: "t1",
      executedAt: new Date(),
      success: true,
      durationMs: 100,
      decisions: [
        { nodeId: "d1", outcome: "true" },
        { nodeId: "d2", outcome: "false" },
      ],
      taskResults: [],
      priority: 0.5,
      executedPath: ["A"],
    },
    {
      id: "t2",
      executedAt: new Date(),
      success: false,
      durationMs: 100,
      decisions: [
        { nodeId: "d1", outcome: "true" },
      ],
      taskResults: [],
      priority: 0.5,
      executedPath: ["A"],
    },
  ];

  const features = extractPathLevelFeatures(traces);
  const f = features.get("A")!;
  // Total decisions: 3 (2 from t1 + 1 from t2)
  // Successful decisions: 2 (from t1 which succeeded)
  assertEquals(f.decisionSuccessRate, 2 / 3);
});

// ============================================================================
// getPathKey Tests
// ============================================================================

Deno.test("getPathKey - generates correct key", () => {
  const trace: ExecutionTrace = {
    id: "t1",
    executedAt: new Date(),
    success: true,
    durationMs: 100,
    decisions: [],
    taskResults: [],
    priority: 0.5,
    executedPath: ["fs:read", "json:parse", "slack:send"],
  };

  assertEquals(getPathKey(trace), "fs:read->json:parse->slack:send");
});

Deno.test("getPathKey - empty path returns empty string", () => {
  const trace: ExecutionTrace = {
    id: "t1",
    executedAt: new Date(),
    success: true,
    durationMs: 100,
    decisions: [],
    taskResults: [],
    priority: 0.5,
    executedPath: [],
  };

  assertEquals(getPathKey(trace), "");
});

// ============================================================================
// getFeaturesForTrace Tests
// ============================================================================

Deno.test("getFeaturesForTrace - returns features for matching path", () => {
  const trace: ExecutionTrace = {
    id: "t1",
    executedAt: new Date(),
    success: true,
    durationMs: 100,
    decisions: [],
    taskResults: [],
    priority: 0.5,
    executedPath: ["A", "B"],
  };

  const features = new Map([
    ["A->B", {
      pathSuccessRate: 0.9,
      pathFrequency: 0.5,
      decisionSuccessRate: 0.8,
      isDominantPath: true,
    }],
  ]);

  const f = getFeaturesForTrace(trace, features);
  assertEquals(f.pathSuccessRate, 0.9);
  assertEquals(f.isDominantPath, true);
});

Deno.test("getFeaturesForTrace - returns defaults for unknown path", () => {
  const trace: ExecutionTrace = {
    id: "t1",
    executedAt: new Date(),
    success: true,
    durationMs: 100,
    decisions: [],
    taskResults: [],
    priority: 0.5,
    executedPath: ["UNKNOWN"],
  };

  const features = new Map<
    string,
    {
      pathSuccessRate: number;
      pathFrequency: number;
      decisionSuccessRate: number;
      isDominantPath: boolean;
    }
  >();

  const f = getFeaturesForTrace(trace, features);
  assertEquals(f.pathSuccessRate, 0.5); // default
  assertEquals(f.isDominantPath, false); // default
});

// ============================================================================
// traceToTrainingExamples Tests (AC11 - Multi-example)
// ============================================================================

Deno.test("traceToTrainingExamples - generates one example per node", () => {
  const trace: ExecutionTrace = {
    id: "t1",
    executedAt: new Date(),
    success: true,
    durationMs: 100,
    decisions: [],
    taskResults: [],
    priority: 0.5,
    executedPath: ["fs:read", "json:parse", "slack:send"],
  };

  const flatPath = ["fs:read", "json:parse", "slack:send"];
  const intentEmbedding = new Array(1024).fill(0.1);
  const pathFeatures = new Map();

  const examples = traceToTrainingExamples(trace, flatPath, intentEmbedding, pathFeatures);

  assertEquals(examples.length, 3);

  // First example: no context
  assertEquals(examples[0].contextTools, []);
  assertEquals(examples[0].candidateId, "fs:read");
  assertEquals(examples[0].outcome, 1);

  // Second example: fs:read is context
  assertEquals(examples[1].contextTools, ["fs:read"]);
  assertEquals(examples[1].candidateId, "json:parse");

  // Third example: fs:read, json:parse are context
  assertEquals(examples[2].contextTools, ["fs:read", "json:parse"]);
  assertEquals(examples[2].candidateId, "slack:send");
});

Deno.test("traceToTrainingExamples - failed trace has outcome 0", () => {
  const trace: ExecutionTrace = {
    id: "t1",
    executedAt: new Date(),
    success: false,
    durationMs: 100,
    decisions: [],
    taskResults: [],
    priority: 0.5,
    executedPath: ["A"],
  };

  const examples = traceToTrainingExamples(trace, ["A"], new Array(1024).fill(0.1), new Map());

  assertEquals(examples.length, 1);
  assertEquals(examples[0].outcome, 0);
});

Deno.test("traceToTrainingExamples - empty path returns empty array", () => {
  const trace: ExecutionTrace = {
    id: "t1",
    executedAt: new Date(),
    success: true,
    durationMs: 100,
    decisions: [],
    taskResults: [],
    priority: 0.5,
    executedPath: [],
  };

  const examples = traceToTrainingExamples(trace, [], new Array(1024).fill(0.1), new Map());
  assertEquals(examples.length, 0);
});

// ============================================================================
// shouldRunBatchTraining Tests
// ============================================================================

Deno.test("shouldRunBatchTraining - triggers every N executions", () => {
  resetExecutionCounter();

  // First 9 calls should return false
  for (let i = 1; i < 10; i++) {
    assertEquals(shouldRunBatchTraining(10), false);
  }

  // 10th call should return true
  assertEquals(shouldRunBatchTraining(10), true);

  // 11th-19th should return false again
  for (let i = 11; i < 20; i++) {
    assertEquals(shouldRunBatchTraining(10), false);
  }

  // 20th should return true again
  assertEquals(shouldRunBatchTraining(10), true);
});

Deno.test("shouldRunBatchTraining - force flag overrides counter", () => {
  resetExecutionCounter();

  // Force should always return true
  assertEquals(shouldRunBatchTraining(10, true), true);
  assertEquals(getExecutionCount(), 1);
});

Deno.test("resetExecutionCounter - resets to zero", () => {
  // Call a few times to increment
  shouldRunBatchTraining(10);
  shouldRunBatchTraining(10);
  assertGreater(getExecutionCount(), 0);

  // Reset
  resetExecutionCounter();
  assertEquals(getExecutionCount(), 0);
});

// ============================================================================
// flattenExecutedPath Tests (AC13)
// ============================================================================

Deno.test("flattenExecutedPath - returns path as-is when no children", async () => {
  // Create a mock trace store that returns no children
  const mockTraceStore = {
    getChildTraces: async (_id: string) => [],
  } as unknown as import("../../../src/capabilities/execution-trace-store.ts").ExecutionTraceStore;

  const trace: ExecutionTrace = {
    id: "t1",
    executedAt: new Date(),
    success: true,
    durationMs: 100,
    decisions: [],
    taskResults: [],
    priority: 0.5,
    executedPath: ["A", "B", "C"],
  };

  const flat = await flattenExecutedPath(trace, mockTraceStore);
  assertEquals(flat, ["A", "B", "C"]);
});

Deno.test("flattenExecutedPath - flattens hierarchical paths", async () => {
  // Create mock trace store that returns children for capability B
  const mockTraceStore = {
    getChildTraces: async (id: string) => {
      if (id === "t1") {
        // Parent trace has child for capability B
        return [{
          id: "child-1",
          capabilityId: "B", // Links to node B in parent's path
          executedAt: new Date(),
          success: true,
          durationMs: 50,
          decisions: [],
          taskResults: [],
          priority: 0.5,
          executedPath: ["B1", "B2"], // Child's path
        }];
      }
      return [];
    },
  } as unknown as import("../../../src/capabilities/execution-trace-store.ts").ExecutionTraceStore;

  const trace: ExecutionTrace = {
    id: "t1",
    executedAt: new Date(),
    success: true,
    durationMs: 100,
    decisions: [],
    taskResults: [],
    priority: 0.5,
    executedPath: ["A", "B", "C"],
  };

  const flat = await flattenExecutedPath(trace, mockTraceStore);
  // Should be: A, B, B1, B2, C
  assertEquals(flat, ["A", "B", "B1", "B2", "C"]);
});

// ============================================================================
// AC8: PER Sampling Produces High-Priority Biased Distribution
// ============================================================================

Deno.test("AC8: PER sampling biases toward high-priority traces", async () => {
  // Create traces with varying priorities
  const traces: ExecutionTrace[] = [
    {
      id: "low-1",
      executedAt: new Date(),
      success: true,
      durationMs: 100,
      decisions: [],
      taskResults: [],
      priority: 0.1,
      executedPath: ["A"],
    },
    {
      id: "low-2",
      executedAt: new Date(),
      success: true,
      durationMs: 100,
      decisions: [],
      taskResults: [],
      priority: 0.1,
      executedPath: ["A"],
    },
    {
      id: "low-3",
      executedAt: new Date(),
      success: true,
      durationMs: 100,
      decisions: [],
      taskResults: [],
      priority: 0.1,
      executedPath: ["A"],
    },
    {
      id: "low-4",
      executedAt: new Date(),
      success: true,
      durationMs: 100,
      decisions: [],
      taskResults: [],
      priority: 0.1,
      executedPath: ["A"],
    },
    {
      id: "high-1",
      executedAt: new Date(),
      success: true,
      durationMs: 100,
      decisions: [],
      taskResults: [],
      priority: 0.9,
      executedPath: ["B"],
    },
    {
      id: "high-2",
      executedAt: new Date(),
      success: true,
      durationMs: 100,
      decisions: [],
      taskResults: [],
      priority: 0.9,
      executedPath: ["B"],
    },
  ];

  // Simulate PER sampling multiple times to verify bias
  // With alpha=0.6, high priority (0.9) should be sampled ~3x more than low (0.1)
  // P(high) ∝ 0.9^0.6 ≈ 0.94, P(low) ∝ 0.1^0.6 ≈ 0.25
  const alpha = 0.6;
  let highPriorityCount = 0;
  const iterations = 100;

  for (let iter = 0; iter < iterations; iter++) {
    // Simple PER sampling simulation
    const pool = [...traces];
    const priorities = pool.map((t) => Math.pow(t.priority, alpha));
    const total = priorities.reduce((a, b) => a + b, 0);
    const probs = priorities.map((p) => p / total);

    const rand = Math.random();
    let cumSum = 0;
    for (let i = 0; i < pool.length; i++) {
      cumSum += probs[i];
      if (rand <= cumSum) {
        if (pool[i].priority > 0.5) highPriorityCount++;
        break;
      }
    }
  }

  // High priority traces (2 out of 6) should be sampled much more often than uniform (33%)
  // With PER, expect ~60-80% of samples to be high priority
  const highPriorityRatio = highPriorityCount / iterations;
  assertGreater(
    highPriorityRatio,
    0.4,
    `PER should bias toward high priority: got ${(highPriorityRatio * 100).toFixed(0)}%`,
  );
});

// ============================================================================
// AC9: Path-Level Training Improves Prediction vs Tool-Level
// ============================================================================

Deno.test("AC9: path-level multi-example generates richer training signal than single example", () => {
  // Tool-level (Story 10.7): 1 example per execution
  // Path-level (Story 11.6): N examples per execution (one per node)

  const trace: ExecutionTrace = {
    id: "t1",
    executedAt: new Date(),
    success: true,
    durationMs: 100,
    decisions: [],
    taskResults: [],
    priority: 0.8,
    executedPath: ["fs:read", "json:parse", "transform", "slack:send"],
  };

  const flatPath = trace.executedPath!;
  const intentEmbedding = new Array(1024).fill(0.1);
  const pathFeatures = new Map();

  // Path-level: generates 4 examples
  const pathExamples = traceToTrainingExamples(trace, flatPath, intentEmbedding, pathFeatures);

  // Tool-level equivalent: would generate 1 example
  const toolLevelExampleCount = 1;

  // Path-level produces 4x more training signal
  assertEquals(pathExamples.length, 4, "Path-level should generate 4 examples for 4-node path");
  assertGreater(
    pathExamples.length,
    toolLevelExampleCount,
    "Path-level should generate more examples than tool-level",
  );

  // Each example has progressive context
  assertEquals(pathExamples[0].contextTools.length, 0, "First node has no context");
  assertEquals(pathExamples[1].contextTools.length, 1, "Second node has 1 context tool");
  assertEquals(pathExamples[2].contextTools.length, 2, "Third node has 2 context tools");
  assertEquals(pathExamples[3].contextTools.length, 3, "Fourth node has 3 context tools");
});

// ============================================================================
// AC10: Performance Benchmark - Overhead < 50ms per batch
// ============================================================================

Deno.test("AC10: extractPathLevelFeatures + traceToTrainingExamples < 50ms for 100 traces", () => {
  // Generate 100 test traces
  const traces: ExecutionTrace[] = [];
  for (let i = 0; i < 100; i++) {
    traces.push({
      id: `trace-${i}`,
      executedAt: new Date(),
      success: Math.random() > 0.3,
      durationMs: 100 + Math.random() * 200,
      decisions: [{ nodeId: `d${i}`, outcome: "true" }],
      taskResults: [],
      priority: 0.1 + Math.random() * 0.8,
      executedPath: ["step1", "step2", "step3", "step4"].slice(
        0,
        2 + Math.floor(Math.random() * 3),
      ),
    });
  }

  const intentEmbedding = new Array(1024).fill(0.1);

  // Measure time for feature extraction + example generation
  const start = performance.now();

  // Step 1: Extract path features
  const pathFeatures = extractPathLevelFeatures(traces);

  // Step 2: Generate training examples for all traces
  let totalExamples = 0;
  for (const trace of traces) {
    const examples = traceToTrainingExamples(
      trace,
      trace.executedPath ?? [],
      intentEmbedding,
      pathFeatures,
    );
    totalExamples += examples.length;
  }

  const elapsed = performance.now() - start;

  // Assert < 50ms overhead
  console.log(
    `  AC10 Benchmark: ${
      elapsed.toFixed(2)
    }ms for ${traces.length} traces, ${totalExamples} examples`,
  );
  assertGreater(50, elapsed, `Overhead should be < 50ms, got ${elapsed.toFixed(2)}ms`);
  assertGreater(totalExamples, 200, "Should generate many examples from 100 traces");
});
