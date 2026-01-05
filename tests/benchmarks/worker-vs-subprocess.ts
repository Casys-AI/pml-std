#!/usr/bin/env -S deno run --allow-all --unstable-worker-options
/**
 * Benchmark: Worker vs Subprocess Execution
 *
 * Story 10.5 AC13: Measure latency difference between execution paths.
 *
 * This benchmark compares:
 * - Subprocess: DenoSandboxExecutor.execute() - spawns deno subprocess
 * - Worker: WorkerBridge.execute() - uses Deno Worker thread
 *
 * Expected: Worker (~5ms) vs Subprocess (~50-100ms spawn overhead)
 */

import { DenoSandboxExecutor } from "../../src/sandbox/executor.ts";
import { WorkerBridge } from "../../src/sandbox/worker-bridge.ts";

const ITERATIONS = 5;
const WARMUP = 1;

// Simple code that just returns a value (no I/O)
const SIMPLE_CODE = `return 1 + 1;`;

// Code with some computation
const COMPUTE_CODE = `
  let sum = 0;
  for (let i = 0; i < 1000; i++) {
    sum += i;
  }
  return sum;
`;

async function benchmarkSubprocess(code: string, iterations: number): Promise<number[]> {
  const executor = new DenoSandboxExecutor({
    timeout: 5000,
    memoryLimit: 128,
    allowedReadPaths: [],
    // Disable cache for fair comparison
    cacheConfig: { enabled: false },
    // AC13: Force subprocess mode for this benchmark
    useWorkerForExecute: false,
  });

  const times: number[] = [];

  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await executor.execute(code);
    times.push(performance.now() - start);
  }

  return times;
}

async function benchmarkWorker(code: string, iterations: number): Promise<number[]> {
  const bridge = new WorkerBridge(new Map(), {
    timeout: 5000,
  });

  const times: number[] = [];

  try {
    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      await bridge.execute(code, [], {});
      times.push(performance.now() - start);
    }
  } finally {
    bridge.terminate();
  }

  return times;
}

function stats(
  times: number[],
): { avg: number; min: number; max: number; p50: number; p95: number } {
  const sorted = [...times].sort((a, b) => a - b);
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];

  return { avg, min, max, p50, p95 };
}

function formatStats(
  name: string,
  s: { avg: number; min: number; max: number; p50: number; p95: number },
): void {
  console.log(`  ${name}:`);
  console.log(`    avg: ${s.avg.toFixed(2)}ms`);
  console.log(`    min: ${s.min.toFixed(2)}ms`);
  console.log(`    max: ${s.max.toFixed(2)}ms`);
  console.log(`    p50: ${s.p50.toFixed(2)}ms`);
  console.log(`    p95: ${s.p95.toFixed(2)}ms`);
}

async function main() {
  console.log("=== Worker vs Subprocess Benchmark ===");
  console.log(`Iterations: ${ITERATIONS} (warmup: ${WARMUP})`);
  console.log("");

  // Warmup
  console.log("Warming up...");
  await benchmarkSubprocess(SIMPLE_CODE, WARMUP);
  await benchmarkWorker(SIMPLE_CODE, WARMUP);
  console.log("");

  // Simple code benchmark
  console.log("--- Simple Code: `return 1 + 1;` ---");

  console.log("Running subprocess benchmark...");
  const subSimple = await benchmarkSubprocess(SIMPLE_CODE, ITERATIONS);
  const subSimpleStats = stats(subSimple);

  console.log("Running worker benchmark...");
  const workerSimple = await benchmarkWorker(SIMPLE_CODE, ITERATIONS);
  const workerSimpleStats = stats(workerSimple);

  console.log("");
  formatStats("Subprocess", subSimpleStats);
  formatStats("Worker", workerSimpleStats);
  console.log(`  Speedup: ${(subSimpleStats.avg / workerSimpleStats.avg).toFixed(1)}x`);
  console.log("");

  // Compute code benchmark
  console.log("--- Compute Code: loop sum ---");

  console.log("Running subprocess benchmark...");
  const subCompute = await benchmarkSubprocess(COMPUTE_CODE, ITERATIONS);
  const subComputeStats = stats(subCompute);

  console.log("Running worker benchmark...");
  const workerCompute = await benchmarkWorker(COMPUTE_CODE, ITERATIONS);
  const workerComputeStats = stats(workerCompute);

  console.log("");
  formatStats("Subprocess", subComputeStats);
  formatStats("Worker", workerComputeStats);
  console.log(`  Speedup: ${(subComputeStats.avg / workerComputeStats.avg).toFixed(1)}x`);
  console.log("");

  // Summary
  console.log("=== Summary ===");
  console.log(
    `Simple code - Subprocess: ${subSimpleStats.avg.toFixed(2)}ms, Worker: ${
      workerSimpleStats.avg.toFixed(2)
    }ms`,
  );
  console.log(
    `Compute code - Subprocess: ${subComputeStats.avg.toFixed(2)}ms, Worker: ${
      workerComputeStats.avg.toFixed(2)
    }ms`,
  );
  console.log("");
  console.log(
    `Recommendation: ${
      workerSimpleStats.avg < subSimpleStats.avg
        ? "Worker is faster - proceed with AC13 unification"
        : "Subprocess is faster - investigate before AC13"
    }`,
  );
}

await main();
