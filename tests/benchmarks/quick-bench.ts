#!/usr/bin/env -S deno run --allow-all --unstable-worker-options
/**
 * Quick Benchmark: Single execution comparison
 */

import { DenoSandboxExecutor } from "../../src/sandbox/executor.ts";
import { WorkerBridge } from "../../src/sandbox/worker-bridge.ts";

const CODE = `return 1 + 1;`;

console.log("=== Quick Benchmark ===");

// Subprocess test (1 execution)
console.log("\n1. Subprocess (no cache):");
const subExec = new DenoSandboxExecutor({
  timeout: 5000,
  memoryLimit: 128,
  cacheConfig: { enabled: false },
});
const subStart = performance.now();
await subExec.execute(CODE);
console.log(`   Time: ${(performance.now() - subStart).toFixed(2)}ms`);

// Worker test (1 execution)
console.log("\n2. Worker:");
const bridge = new WorkerBridge({
  timeout: 5000,
  toolDefinitions: [],
  mcpClients: new Map(),
});
const workerStart = performance.now();
await bridge.execute(CODE, [], {});
console.log(`   Time: ${(performance.now() - workerStart).toFixed(2)}ms`);
bridge.terminate();

console.log("\n=== Done ===");
