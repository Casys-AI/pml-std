/**
 * Parallel Execution Performance Benchmarks
 *
 * Validates performance targets:
 * - AC8: P95 latency <3 seconds for 5-tool workflows
 * - AC9: 3-5x speedup on parallelizable workflows
 */

import { ParallelExecutor } from "../../src/dag/executor.ts";
import type { DAGStructure } from "../../src/graphrag/types.ts";
import type { ToolExecutor } from "../../src/dag/types.ts";

// ============================================
// Benchmark Helpers
// ============================================

/**
 * Mock tool executor with realistic delays
 */
function createBenchmarkExecutor(): ToolExecutor {
  return async (tool: string, args: Record<string, unknown>): Promise<unknown> => {
    const delay = (args.ms as number) || 100;
    await new Promise((resolve) => setTimeout(resolve, delay));
    return { tool, delay, timestamp: Date.now() };
  };
}

/**
 * Run benchmark multiple times and return statistics
 */
async function runBenchmark(
  name: string,
  iterations: number,
  fn: () => Promise<number>,
): Promise<{
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
}> {
  const results: number[] = [];

  console.log(`\n📊 Running benchmark: ${name} (${iterations} iterations)`);

  for (let i = 0; i < iterations; i++) {
    const time = await fn();
    results.push(time);
  }

  results.sort((a, b) => a - b);

  const mean = results.reduce((a, b) => a + b, 0) / results.length;
  const p50 = results[Math.floor(results.length * 0.50)];
  const p95 = results[Math.floor(results.length * 0.95)];
  const p99 = results[Math.floor(results.length * 0.99)];
  const min = results[0];
  const max = results[results.length - 1];

  console.log(`  Mean: ${mean.toFixed(1)}ms`);
  console.log(`  P50:  ${p50.toFixed(1)}ms`);
  console.log(`  P95:  ${p95.toFixed(1)}ms`);
  console.log(`  P99:  ${p99.toFixed(1)}ms`);
  console.log(`  Min:  ${min.toFixed(1)}ms`);
  console.log(`  Max:  ${max.toFixed(1)}ms`);

  return { mean, p50, p95, p99, min, max };
}

// ============================================
// AC8: P95 Latency <3 seconds for 5-tool workflows
// ============================================

Deno.bench("Parallel execution - 5 independent tasks @500ms each", {
  group: "latency",
  baseline: true,
}, async () => {
  const executor = new ParallelExecutor(createBenchmarkExecutor());

  const dag: DAGStructure = {
    tasks: [
      { id: "t1", tool: "mock:delay", arguments: { ms: 500 }, dependsOn: [] },
      { id: "t2", tool: "mock:delay", arguments: { ms: 500 }, dependsOn: [] },
      { id: "t3", tool: "mock:delay", arguments: { ms: 500 }, dependsOn: [] },
      { id: "t4", tool: "mock:delay", arguments: { ms: 500 }, dependsOn: [] },
      { id: "t5", tool: "mock:delay", arguments: { ms: 500 }, dependsOn: [] },
    ],
  };

  await executor.execute(dag);
});

Deno.bench("Parallel execution - 5-task mixed parallel/sequential", {
  group: "latency",
}, async () => {
  const executor = new ParallelExecutor(createBenchmarkExecutor());

  // [t1, t2] → t3 → [t4, t5]
  const dag: DAGStructure = {
    tasks: [
      { id: "t1", tool: "mock:delay", arguments: { ms: 400 }, dependsOn: [] },
      { id: "t2", tool: "mock:delay", arguments: { ms: 400 }, dependsOn: [] },
      { id: "t3", tool: "mock:delay", arguments: { ms: 400 }, dependsOn: ["t1", "t2"] },
      { id: "t4", tool: "mock:delay", arguments: { ms: 400 }, dependsOn: ["t3"] },
      { id: "t5", tool: "mock:delay", arguments: { ms: 400 }, dependsOn: ["t3"] },
    ],
  };

  await executor.execute(dag);
});

// ============================================
// AC9: 3-5x Speedup Validation
// ============================================

Deno.bench("Sequential baseline - 5 tasks @200ms each", {
  group: "speedup",
  baseline: true,
}, async () => {
  const executor = new ParallelExecutor(createBenchmarkExecutor());

  // Fully sequential chain
  const dag: DAGStructure = {
    tasks: [
      { id: "t1", tool: "mock:delay", arguments: { ms: 200 }, dependsOn: [] },
      { id: "t2", tool: "mock:delay", arguments: { ms: 200 }, dependsOn: ["t1"] },
      { id: "t3", tool: "mock:delay", arguments: { ms: 200 }, dependsOn: ["t2"] },
      { id: "t4", tool: "mock:delay", arguments: { ms: 200 }, dependsOn: ["t3"] },
      { id: "t5", tool: "mock:delay", arguments: { ms: 200 }, dependsOn: ["t4"] },
    ],
  };

  await executor.execute(dag);
});

Deno.bench("Parallel execution - 5 independent tasks @200ms each", {
  group: "speedup",
}, async () => {
  const executor = new ParallelExecutor(createBenchmarkExecutor());

  // Fully parallel
  const dag: DAGStructure = {
    tasks: [
      { id: "t1", tool: "mock:delay", arguments: { ms: 200 }, dependsOn: [] },
      { id: "t2", tool: "mock:delay", arguments: { ms: 200 }, dependsOn: [] },
      { id: "t3", tool: "mock:delay", arguments: { ms: 200 }, dependsOn: [] },
      { id: "t4", tool: "mock:delay", arguments: { ms: 200 }, dependsOn: [] },
      { id: "t5", tool: "mock:delay", arguments: { ms: 200 }, dependsOn: [] },
    ],
  };

  await executor.execute(dag);
});

// ============================================
// Detailed Speedup Analysis
// ============================================

if (import.meta.main) {
  console.log("\n" + "=".repeat(60));
  console.log("🚀 Parallel Execution Performance Analysis");
  console.log("=".repeat(60));

  // Test 1: AC8 - P95 latency validation
  console.log("\n📋 AC8: P95 Latency Target (<3 seconds for 5-tool workflows)");
  console.log("-".repeat(60));

  const latencyStats = await runBenchmark(
    "5 independent tasks @500ms each",
    20,
    async () => {
      const executor = new ParallelExecutor(createBenchmarkExecutor());
      const dag: DAGStructure = {
        tasks: [
          { id: "t1", tool: "mock:delay", arguments: { ms: 500 }, dependsOn: [] },
          { id: "t2", tool: "mock:delay", arguments: { ms: 500 }, dependsOn: [] },
          { id: "t3", tool: "mock:delay", arguments: { ms: 500 }, dependsOn: [] },
          { id: "t4", tool: "mock:delay", arguments: { ms: 500 }, dependsOn: [] },
          { id: "t5", tool: "mock:delay", arguments: { ms: 500 }, dependsOn: [] },
        ],
      };

      const result = await executor.execute(dag);
      return result.executionTimeMs;
    },
  );

  const p95Pass = latencyStats.p95 < 3000;
  console.log(
    `\n${p95Pass ? "✅ PASS" : "❌ FAIL"}: P95 latency = ${
      latencyStats.p95.toFixed(1)
    }ms (target: <3000ms)`,
  );

  // Test 2: AC9 - Speedup validation
  console.log("\n\n📋 AC9: Speedup Target (3-5x for parallelizable workflows)");
  console.log("-".repeat(60));

  const speedupResults: number[] = [];

  for (let i = 0; i < 10; i++) {
    const executor = new ParallelExecutor(createBenchmarkExecutor());

    const dag: DAGStructure = {
      tasks: [
        { id: "t1", tool: "mock:delay", arguments: { ms: 200 }, dependsOn: [] },
        { id: "t2", tool: "mock:delay", arguments: { ms: 200 }, dependsOn: [] },
        { id: "t3", tool: "mock:delay", arguments: { ms: 200 }, dependsOn: [] },
        { id: "t4", tool: "mock:delay", arguments: { ms: 200 }, dependsOn: [] },
        { id: "t5", tool: "mock:delay", arguments: { ms: 200 }, dependsOn: [] },
      ],
    };

    const result = await executor.execute(dag);
    const speedup = executor.calculateSpeedup(result);
    speedupResults.push(speedup);
  }

  const avgSpeedup = speedupResults.reduce((a, b) => a + b, 0) / speedupResults.length;
  const minSpeedup = Math.min(...speedupResults);
  const maxSpeedup = Math.max(...speedupResults);

  console.log(`\n📊 Speedup Statistics (10 iterations):`);
  console.log(`  Average: ${avgSpeedup.toFixed(2)}x`);
  console.log(`  Min:     ${minSpeedup.toFixed(2)}x`);
  console.log(`  Max:     ${maxSpeedup.toFixed(2)}x`);

  const speedupPass = avgSpeedup >= 3.0 && avgSpeedup <= 5.5;
  console.log(
    `\n${speedupPass ? "✅ PASS" : "❌ FAIL"}: Average speedup = ${
      avgSpeedup.toFixed(2)
    }x (target: 3-5x)`,
  );

  // Test 3: Mixed parallel/sequential patterns
  console.log("\n\n📊 Mixed Parallel/Sequential Pattern Analysis");
  console.log("-".repeat(60));

  const mixedSpeedups: number[] = [];

  for (let i = 0; i < 10; i++) {
    const executor = new ParallelExecutor(createBenchmarkExecutor());

    // Diamond pattern: t1 → [t2, t3] → t4 → [t5, t6]
    const dag: DAGStructure = {
      tasks: [
        { id: "t1", tool: "mock:delay", arguments: { ms: 150 }, dependsOn: [] },
        { id: "t2", tool: "mock:delay", arguments: { ms: 150 }, dependsOn: ["t1"] },
        { id: "t3", tool: "mock:delay", arguments: { ms: 150 }, dependsOn: ["t1"] },
        { id: "t4", tool: "mock:delay", arguments: { ms: 150 }, dependsOn: ["t2", "t3"] },
        { id: "t5", tool: "mock:delay", arguments: { ms: 150 }, dependsOn: ["t4"] },
        { id: "t6", tool: "mock:delay", arguments: { ms: 150 }, dependsOn: ["t4"] },
      ],
    };

    const result = await executor.execute(dag);
    const speedup = executor.calculateSpeedup(result);
    mixedSpeedups.push(speedup);
  }

  const avgMixedSpeedup = mixedSpeedups.reduce((a, b) => a + b, 0) / mixedSpeedups.length;

  console.log(`\n📊 Diamond Pattern Speedup:`);
  console.log(`  Average: ${avgMixedSpeedup.toFixed(2)}x`);
  console.log(`  Expected layers: 4 ([t1] → [t2,t3] → [t4] → [t5,t6])`);

  // Final Summary
  console.log("\n" + "=".repeat(60));
  console.log("📊 PERFORMANCE VALIDATION SUMMARY");
  console.log("=".repeat(60));
  console.log(
    `AC8 (P95 Latency <3s):     ${p95Pass ? "✅ PASS" : "❌ FAIL"} (${
      latencyStats.p95.toFixed(1)
    }ms)`,
  );
  console.log(
    `AC9 (Speedup 3-5x):        ${speedupPass ? "✅ PASS" : "❌ FAIL"} (${avgSpeedup.toFixed(2)}x)`,
  );
  console.log("=".repeat(60) + "\n");

  Deno.exit(p95Pass && speedupPass ? 0 : 1);
}
