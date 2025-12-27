/**
 * Unit Tests: Pure Operations Registry
 *
 * Tests for Phase 1 modular DAG execution - pure operations classification.
 *
 * Coverage:
 * - isPureOperation() correctly identifies pure operations
 * - isCodeOperation() detects code: prefix
 * - getOperationName() extracts operation name
 * - validatePureTask() rejects forbidden patterns
 *
 * @module tests/unit/capabilities/pure-operations.test
 */

import { assertEquals, assertThrows } from "@std/assert";
import {
  getOperationName,
  isCodeOperation,
  isPureOperation,
  PURE_OPERATIONS,
  validatePureTask,
} from "../../../src/capabilities/pure-operations.ts";

// =============================================================================
// isPureOperation Tests
// =============================================================================

Deno.test("isPureOperation - returns true for array operations", () => {
  assertEquals(isPureOperation("code:filter"), true);
  assertEquals(isPureOperation("code:map"), true);
  assertEquals(isPureOperation("code:reduce"), true);
  assertEquals(isPureOperation("code:flatMap"), true);
  assertEquals(isPureOperation("code:find"), true);
  assertEquals(isPureOperation("code:some"), true);
  assertEquals(isPureOperation("code:every"), true);
  assertEquals(isPureOperation("code:sort"), true);
  assertEquals(isPureOperation("code:slice"), true);
});

Deno.test("isPureOperation - returns true for string operations", () => {
  assertEquals(isPureOperation("code:split"), true);
  assertEquals(isPureOperation("code:replace"), true);
  assertEquals(isPureOperation("code:trim"), true);
  assertEquals(isPureOperation("code:toLowerCase"), true);
  assertEquals(isPureOperation("code:toUpperCase"), true);
  assertEquals(isPureOperation("code:substring"), true);
});

Deno.test("isPureOperation - returns true for Object operations", () => {
  assertEquals(isPureOperation("code:Object.keys"), true);
  assertEquals(isPureOperation("code:Object.values"), true);
  assertEquals(isPureOperation("code:Object.entries"), true);
  assertEquals(isPureOperation("code:Object.fromEntries"), true);
  assertEquals(isPureOperation("code:Object.assign"), true);
});

Deno.test("isPureOperation - returns true for Math operations", () => {
  assertEquals(isPureOperation("code:Math.max"), true);
  assertEquals(isPureOperation("code:Math.min"), true);
  assertEquals(isPureOperation("code:Math.abs"), true);
  assertEquals(isPureOperation("code:Math.floor"), true);
  assertEquals(isPureOperation("code:Math.ceil"), true);
  assertEquals(isPureOperation("code:Math.round"), true);
});

Deno.test("isPureOperation - returns true for JSON operations", () => {
  assertEquals(isPureOperation("code:JSON.parse"), true);
  assertEquals(isPureOperation("code:JSON.stringify"), true);
});

Deno.test("isPureOperation - returns true for binary operators", () => {
  // Arithmetic
  assertEquals(isPureOperation("code:add"), true);
  assertEquals(isPureOperation("code:subtract"), true);
  assertEquals(isPureOperation("code:multiply"), true);
  assertEquals(isPureOperation("code:divide"), true);
  assertEquals(isPureOperation("code:modulo"), true);
  assertEquals(isPureOperation("code:power"), true);

  // Comparison
  assertEquals(isPureOperation("code:equal"), true);
  assertEquals(isPureOperation("code:strictEqual"), true);
  assertEquals(isPureOperation("code:lessThan"), true);
  assertEquals(isPureOperation("code:greaterThan"), true);

  // Logical
  assertEquals(isPureOperation("code:and"), true);
  assertEquals(isPureOperation("code:or"), true);
});

Deno.test("isPureOperation - returns false for MCP tools", () => {
  assertEquals(isPureOperation("filesystem:read_file"), false);
  assertEquals(isPureOperation("db:query"), false);
  assertEquals(isPureOperation("api:fetch"), false);
  assertEquals(isPureOperation("memory:create_entities"), false);
});

Deno.test("isPureOperation - returns false for unknown code operations", () => {
  assertEquals(isPureOperation("code:unknown"), false);
  assertEquals(isPureOperation("code:dangerousEval"), false);
  assertEquals(isPureOperation("code:fetch"), false);
});

Deno.test("isPureOperation - PURE_OPERATIONS has expected count", () => {
  // Should have ~55 operations (adjust if registry grows)
  assertEquals(PURE_OPERATIONS.length >= 50, true);
  assertEquals(PURE_OPERATIONS.length <= 100, true);
});

// =============================================================================
// isCodeOperation Tests
// =============================================================================

Deno.test("isCodeOperation - returns true for code: prefix", () => {
  assertEquals(isCodeOperation("code:filter"), true);
  assertEquals(isCodeOperation("code:map"), true);
  assertEquals(isCodeOperation("code:Object.keys"), true);
  assertEquals(isCodeOperation("code:Math.abs"), true);
  assertEquals(isCodeOperation("code:add"), true);
});

Deno.test("isCodeOperation - returns false for MCP tools", () => {
  assertEquals(isCodeOperation("filesystem:read_file"), false);
  assertEquals(isCodeOperation("db:query"), false);
  assertEquals(isCodeOperation("memory:create_entities"), false);
});

Deno.test("isCodeOperation - returns false for capability calls", () => {
  assertEquals(isCodeOperation("capability:analyze"), false);
  assertEquals(isCodeOperation("sandbox:execute"), false);
});

// =============================================================================
// getOperationName Tests
// =============================================================================

Deno.test("getOperationName - extracts operation name from code: prefix", () => {
  assertEquals(getOperationName("code:filter"), "filter");
  assertEquals(getOperationName("code:map"), "map");
  assertEquals(getOperationName("code:Object.keys"), "Object.keys");
  assertEquals(getOperationName("code:Math.abs"), "Math.abs");
  assertEquals(getOperationName("code:add"), "add");
});

Deno.test("getOperationName - returns undefined for non-code operations", () => {
  assertEquals(getOperationName("filesystem:read_file"), undefined);
  assertEquals(getOperationName("db:query"), undefined);
  assertEquals(getOperationName("memory:create"), undefined);
});

// =============================================================================
// validatePureTask Tests
// =============================================================================

Deno.test("validatePureTask - passes for valid pure code", () => {
  const task = {
    tool: "code:filter",
    code: "return users.filter(u => u.active);",
    metadata: { pure: true },
  };

  // Should not throw
  validatePureTask(task, "task-1");
});

Deno.test("validatePureTask - passes when not marked pure", () => {
  const task = {
    tool: "code:filter",
    code: "fetch('https://api.com'); return data;", // Would be forbidden if pure
    metadata: { pure: false },
  };

  // Should not throw - not marked pure
  validatePureTask(task, "task-1");
});

Deno.test("validatePureTask - passes when metadata is undefined", () => {
  const task = {
    tool: "code:filter",
    code: "fetch('https://api.com'); return data;",
  };

  // Should not throw - no metadata
  validatePureTask(task, "task-1");
});

Deno.test("validatePureTask - throws for fetch in pure task", () => {
  const task = {
    tool: "code:filter",
    code: "const data = await fetch('https://api.com'); return data;",
    metadata: { pure: true },
  };

  assertThrows(
    () => validatePureTask(task, "task-1"),
    Error,
    "fetch",
  );
});

Deno.test("validatePureTask - throws for Deno API in pure task", () => {
  const task = {
    tool: "code:map",
    code: "const file = await Deno.readTextFile('/etc/passwd'); return file;",
    metadata: { pure: true },
  };

  assertThrows(
    () => validatePureTask(task, "task-1"),
    Error,
    "Deno APIs",
  );
});

Deno.test("validatePureTask - throws for eval in pure task", () => {
  const task = {
    tool: "code:reduce",
    code: "return eval('malicious code');",
    metadata: { pure: true },
  };

  assertThrows(
    () => validatePureTask(task, "task-1"),
    Error,
    "eval",
  );
});

Deno.test("validatePureTask - throws for Function constructor in pure task", () => {
  const task = {
    tool: "code:map",
    code: "const fn = new Function('return 1'); return fn();",
    metadata: { pure: true },
  };

  assertThrows(
    () => validatePureTask(task, "task-1"),
    Error,
    "Function constructor",
  );
});

Deno.test("validatePureTask - throws for setTimeout in pure task", () => {
  const task = {
    tool: "code:filter",
    code: "setTimeout(() => {}, 1000); return [];",
    metadata: { pure: true },
  };

  assertThrows(
    () => validatePureTask(task, "task-1"),
    Error,
    "setTimeout",
  );
});

Deno.test("validatePureTask - throws for dynamic import in pure task", () => {
  const task = {
    tool: "code:map",
    code: "const mod = await import('./module.ts'); return mod.data;",
    metadata: { pure: true },
  };

  assertThrows(
    () => validatePureTask(task, "task-1"),
    Error,
    "dynamic import",
  );
});

Deno.test("validatePureTask - throws for missing code in pure task", () => {
  const task = {
    tool: "code:filter",
    code: undefined as unknown as string,
    metadata: { pure: true },
  };

  assertThrows(
    () => validatePureTask(task, "task-1"),
    Error,
    "missing code",
  );
});
