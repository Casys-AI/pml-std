/**
 * Tests for DenoSubprocessRunner
 *
 * @module tests/unit/sandbox/deno_runner_test
 */

import { assertEquals, assertExists } from "@std/assert";
import {
  DenoSubprocessRunner,
  type DenoRunnerConfig,
} from "../../../src/sandbox/execution/deno-runner.ts";

const DEFAULT_CONFIG: DenoRunnerConfig = {
  timeout: 5000,
  memoryLimit: 256,
  allowedReadPaths: [],
};

Deno.test("DenoSubprocessRunner - executes simple expression", async () => {
  const runner = new DenoSubprocessRunner(DEFAULT_CONFIG);
  const result = await runner.execute("1 + 1");

  assertEquals(result.success, true);
  assertEquals(result.result, 2);
  assertExists(result.executionTimeMs);
});

Deno.test("DenoSubprocessRunner - executes with context", async () => {
  const runner = new DenoSubprocessRunner(DEFAULT_CONFIG);
  const result = await runner.execute("x + y", { x: 10, y: 20 });

  assertEquals(result.success, true);
  assertEquals(result.result, 30);
});

Deno.test("DenoSubprocessRunner - handles syntax error", async () => {
  const runner = new DenoSubprocessRunner(DEFAULT_CONFIG);
  const result = await runner.execute("const x = ");

  assertEquals(result.success, false);
  assertExists(result.error);
  // Error type can be SyntaxError or RuntimeError depending on how Deno reports it
  assertEquals(
    ["SyntaxError", "RuntimeError"].includes(result.error?.type ?? ""),
    true,
    `Expected SyntaxError or RuntimeError, got ${result.error?.type}`,
  );
});

Deno.test("DenoSubprocessRunner - handles runtime error", async () => {
  const runner = new DenoSubprocessRunner(DEFAULT_CONFIG);
  const result = await runner.execute("throw new Error('test error')");

  assertEquals(result.success, false);
  assertExists(result.error);
  assertEquals(result.error?.type, "RuntimeError");
});

Deno.test("DenoSubprocessRunner - handles timeout", async () => {
  const config: DenoRunnerConfig = {
    timeout: 500, // Very short timeout
    memoryLimit: 256,
    allowedReadPaths: [],
  };
  const runner = new DenoSubprocessRunner(config);

  // Infinite loop should timeout
  const result = await runner.execute("while(true) {}");

  assertEquals(result.success, false);
  assertExists(result.error);
  // Can be TimeoutError or RuntimeError depending on how process termination is reported
  assertEquals(
    ["TimeoutError", "RuntimeError"].includes(result.error?.type ?? ""),
    true,
    `Expected TimeoutError or RuntimeError, got ${result.error?.type}`,
  );
});

Deno.test("DenoSubprocessRunner - executes with statement code", async () => {
  const runner = new DenoSubprocessRunner(DEFAULT_CONFIG);
  const result = await runner.execute(`
    const a = 5;
    const b = 10;
    return a * b;
  `);

  assertEquals(result.success, true);
  assertEquals(result.result, 50);
});

Deno.test("DenoSubprocessRunner - handles async code", async () => {
  const runner = new DenoSubprocessRunner(DEFAULT_CONFIG);
  const result = await runner.execute(`
    const delay = (ms) => new Promise(r => setTimeout(r, ms));
    await delay(10);
    return "done";
  `);

  assertEquals(result.success, true);
  assertEquals(result.result, "done");
});

Deno.test("DenoSubprocessRunner - returns null for undefined result", async () => {
  const runner = new DenoSubprocessRunner(DEFAULT_CONFIG);
  const result = await runner.execute("undefined");

  assertEquals(result.success, true);
  assertEquals(result.result, null);
});

Deno.test("DenoSubprocessRunner - handles complex data types", async () => {
  const runner = new DenoSubprocessRunner(DEFAULT_CONFIG);
  const result = await runner.execute(`
    return { name: "test", values: [1, 2, 3], nested: { a: true } };
  `);

  assertEquals(result.success, true);
  assertEquals(result.result, {
    name: "test",
    values: [1, 2, 3],
    nested: { a: true },
  });
});

Deno.test("DenoSubprocessRunner - handles array return", async () => {
  const runner = new DenoSubprocessRunner(DEFAULT_CONFIG);
  const result = await runner.execute("[1, 2, 3].map(x => x * 2)");

  assertEquals(result.success, true);
  assertEquals(result.result, [2, 4, 6]);
});

Deno.test("DenoSubprocessRunner - permission denied for net access", async () => {
  const runner = new DenoSubprocessRunner(DEFAULT_CONFIG);
  const result = await runner.execute('await fetch("https://example.com")');

  assertEquals(result.success, false);
  assertExists(result.error);
  assertEquals(result.error?.type, "PermissionError");
});

Deno.test("DenoSubprocessRunner - permission denied for file write", async () => {
  const runner = new DenoSubprocessRunner(DEFAULT_CONFIG);
  const result = await runner.execute('Deno.writeTextFileSync("/tmp/test.txt", "data")');

  assertEquals(result.success, false);
  assertExists(result.error);
  assertEquals(result.error?.type, "PermissionError");
});
