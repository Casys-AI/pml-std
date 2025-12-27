/**
 * Tests for Argument Resolver (Story 10.5)
 *
 * @module tests/dag/argument-resolver_test
 */

import { assertEquals } from "@std/assert";
import {
  buildResolutionSummary,
  mergeArguments,
  resolveArguments,
  validateRequiredArguments,
} from "../../src/dag/argument-resolver.ts";
import type { ArgumentsStructure } from "../../src/capabilities/types.ts";
import type { TaskResult } from "../../src/dag/types.ts";

// =============================================================================
// AC3: Argument Resolution Tests
// =============================================================================

Deno.test("resolveArguments - resolves literal values", () => {
  const args: ArgumentsStructure = {
    path: { type: "literal", value: "/tmp/file.txt" },
    mode: { type: "literal", value: "read" },
    lines: { type: "literal", value: 100 },
  };

  const resolved = resolveArguments(args, {}, new Map());

  assertEquals(resolved.path, "/tmp/file.txt");
  assertEquals(resolved.mode, "read");
  assertEquals(resolved.lines, 100);
});

Deno.test("resolveArguments - resolves parameter references", () => {
  const args: ArgumentsStructure = {
    filename: { type: "parameter", parameterName: "inputFile" },
    format: { type: "parameter", parameterName: "outputFormat" },
  };

  const context = {
    parameters: {
      inputFile: "data.json",
      outputFormat: "csv",
    },
  };

  const resolved = resolveArguments(args, context, new Map());

  assertEquals(resolved.filename, "data.json");
  assertEquals(resolved.format, "csv");
});

Deno.test("resolveArguments - resolves task result references", () => {
  const args: ArgumentsStructure = {
    content: { type: "reference", expression: "n1.content" },
    status: { type: "reference", expression: "n1.metadata.status" },
  };

  const previousResults = new Map<string, TaskResult>([
    [
      "task_n1",
      {
        taskId: "task_n1",
        status: "success",
        output: {
          content: "Hello World",
          metadata: { status: "ok" },
        },
      },
    ],
  ]);

  const resolved = resolveArguments(args, {}, previousResults);

  assertEquals(resolved.content, "Hello World");
  assertEquals(resolved.status, "ok");
});

Deno.test("resolveArguments - handles array indexing in references", () => {
  const args: ArgumentsStructure = {
    firstItem: { type: "reference", expression: "n1.items[0]" },
    secondItem: { type: "reference", expression: "n1.items[1].name" },
  };

  const previousResults = new Map<string, TaskResult>([
    [
      "task_n1",
      {
        taskId: "task_n1",
        status: "success",
        output: {
          items: [
            "first",
            { name: "second" },
          ],
        },
      },
    ],
  ]);

  const resolved = resolveArguments(args, {}, previousResults);

  assertEquals(resolved.firstItem, "first");
  assertEquals(resolved.secondItem, "second");
});

Deno.test("resolveArguments - returns empty object for undefined args", () => {
  const resolved = resolveArguments(undefined, {}, new Map());
  assertEquals(resolved, {});
});

Deno.test("resolveArguments - continues on resolution failure", () => {
  const args: ArgumentsStructure = {
    valid: { type: "literal", value: "works" },
    invalid: { type: "reference", expression: "nonexistent.field" },
  };

  const resolved = resolveArguments(args, {}, new Map());

  assertEquals(resolved.valid, "works");
  assertEquals("invalid" in resolved, false); // Failed reference not included
});

// =============================================================================
// mergeArguments Tests
// =============================================================================

Deno.test("mergeArguments - explicit takes precedence", () => {
  const resolved = { a: 1, b: 2, c: 3 };
  const explicit = { b: 20, d: 4 };

  const merged = mergeArguments(resolved, explicit);

  assertEquals(merged.a, 1);
  assertEquals(merged.b, 20); // Explicit wins
  assertEquals(merged.c, 3);
  assertEquals(merged.d, 4);
});

// =============================================================================
// validateRequiredArguments Tests
// =============================================================================

Deno.test("validateRequiredArguments - returns empty for all present", () => {
  const resolved = { path: "/tmp", mode: "read" };
  const required = ["path", "mode"];

  const missing = validateRequiredArguments(resolved, required);

  assertEquals(missing, []);
});

Deno.test("validateRequiredArguments - returns missing arguments", () => {
  const resolved = { path: "/tmp" };
  const required = ["path", "mode", "encoding"];

  const missing = validateRequiredArguments(resolved, required);

  assertEquals(missing, ["mode", "encoding"]);
});

// =============================================================================
// buildResolutionSummary Tests
// =============================================================================

Deno.test("buildResolutionSummary - counts types correctly", () => {
  const args: ArgumentsStructure = {
    a: { type: "literal", value: 1 },
    b: { type: "literal", value: 2 },
    c: { type: "parameter", parameterName: "x" },
    d: { type: "reference", expression: "n1.out" },
    e: { type: "reference", expression: "n2.out" },
  };

  const resolved = { a: 1, b: 2, c: "x_value" }; // d and e failed

  const summary = buildResolutionSummary(args, resolved);

  assertEquals(summary.total, 5);
  assertEquals(summary.literals, 2);
  assertEquals(summary.parameters, 1);
  assertEquals(summary.references, 2);
  assertEquals(summary.resolved, 3);
  assertEquals(summary.failed, 2);
});

Deno.test("buildResolutionSummary - handles empty args", () => {
  const summary = buildResolutionSummary(undefined, {});

  assertEquals(summary.total, 0);
  assertEquals(summary.resolved, 0);
  assertEquals(summary.failed, 0);
});
