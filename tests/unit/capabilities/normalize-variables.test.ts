/**
 * Unit Tests: Variable Name Normalization
 *
 * Tests for normalizeVariableNames() which normalizes variable names
 * in code using variableBindings from static structure analysis.
 *
 * Coverage:
 * - Single variable normalization
 * - Multiple variable normalization
 * - Word boundary matching (no partial replacements)
 * - Empty bindings handling
 * - Full integration with StaticStructureBuilder
 *
 * @module tests/unit/capabilities/normalize-variables.test
 */

import { assertEquals } from "@std/assert";
import { normalizeVariableNames } from "../../../src/capabilities/code-transformer.ts";
import { StaticStructureBuilder } from "../../../src/capabilities/static-structure-builder.ts";
import type { DbClient, Transaction } from "../../../src/db/types.ts";

// Mock DbClient for tests
const mockDb: DbClient = {
  connect: async () => {},
  exec: async () => {},
  query: async () => [],
  queryOne: async () => null,
  transaction: async <T>(fn: (tx: Transaction) => Promise<T>) => fn({} as Transaction),
  close: async () => {},
};

// =============================================================================
// normalizeVariableNames - Basic Tests
// =============================================================================

Deno.test("normalizeVariableNames - single variable", () => {
  const code = `const result = await mcp.foo(); return result;`;
  const bindings = { result: "n1" };

  const { code: normalized, renames } = normalizeVariableNames(code, bindings);

  assertEquals(normalized, `const _n1 = await mcp.foo(); return _n1;`);
  assertEquals(renames, { result: "_n1" });
});

Deno.test("normalizeVariableNames - multiple variables", () => {
  const code = `const file = await mcp.read(); const data = await mcp.parse(file); return data;`;
  const bindings = { file: "n1", data: "n2" };

  const { code: normalized, renames } = normalizeVariableNames(code, bindings);

  assertEquals(
    normalized,
    `const _n1 = await mcp.read(); const _n2 = await mcp.parse(_n1); return _n2;`,
  );
  assertEquals(renames, { file: "_n1", data: "_n2" });
});

Deno.test("normalizeVariableNames - empty bindings returns unchanged code", () => {
  const code = `const result = 1; return result;`;

  const { code: normalized, renames } = normalizeVariableNames(code, {});

  assertEquals(normalized, code);
  assertEquals(renames, {});
});

Deno.test("normalizeVariableNames - null bindings returns unchanged code", () => {
  const code = `const result = 1; return result;`;

  const { code: normalized, renames } = normalizeVariableNames(
    code,
    null as unknown as Record<string, string>,
  );

  assertEquals(normalized, code);
  assertEquals(renames, {});
});

// =============================================================================
// normalizeVariableNames - Word Boundary Tests
// =============================================================================

Deno.test("normalizeVariableNames - respects word boundaries", () => {
  const code = `const result = 1; const results = 2; return result;`;
  const bindings = { result: "n1" };

  const { code: normalized } = normalizeVariableNames(code, bindings);

  // Should replace "result" but NOT "results"
  assertEquals(normalized, `const _n1 = 1; const results = 2; return _n1;`);
});

Deno.test("normalizeVariableNames - handles variable in property access", () => {
  const code = `const file = await mcp.read(); return file.content;`;
  const bindings = { file: "n1" };

  const { code: normalized } = normalizeVariableNames(code, bindings);

  assertEquals(normalized, `const _n1 = await mcp.read(); return _n1.content;`);
});

Deno.test("normalizeVariableNames - handles variable in method call", () => {
  const code = `const arr = [1, 2, 3]; return arr.map(x => x * 2);`;
  const bindings = { arr: "n1" };

  const { code: normalized } = normalizeVariableNames(code, bindings);

  assertEquals(normalized, `const _n1 = [1, 2, 3]; return _n1.map(x => x * 2);`);
});

// =============================================================================
// normalizeVariableNames - Integration with StaticStructureBuilder
// =============================================================================

Deno.test("normalizeVariableNames - integration: same semantics produce same code", async () => {
  const builder = new StaticStructureBuilder(mockDb);

  const code1 = `const result = await mcp.std.psql_query({ query: args.query });
return result;`;

  const code2 = `const data = await mcp.std.psql_query({ query: args.query });
return data;`;

  const code3 = `const foo = await mcp.std.psql_query({ query: args.query });
return foo;`;

  const struct1 = await builder.buildStaticStructure(code1);
  const struct2 = await builder.buildStaticStructure(code2);
  const struct3 = await builder.buildStaticStructure(code3);

  const norm1 = normalizeVariableNames(code1, struct1.variableBindings || {});
  const norm2 = normalizeVariableNames(code2, struct2.variableBindings || {});
  const norm3 = normalizeVariableNames(code3, struct3.variableBindings || {});

  assertEquals(norm1.code, norm2.code, "code1 and code2 should normalize to same code");
  assertEquals(norm2.code, norm3.code, "code2 and code3 should normalize to same code");
});

Deno.test("normalizeVariableNames - integration: multiple MCP calls", async () => {
  const builder = new StaticStructureBuilder(mockDb);

  const code1 = `const file = await mcp.filesystem.read_file({ path: args.path });
const parsed = await mcp.std.json_parse({ text: file.content });
return parsed;`;

  const code2 = `const content = await mcp.filesystem.read_file({ path: args.path });
const data = await mcp.std.json_parse({ text: content.content });
return data;`;

  const struct1 = await builder.buildStaticStructure(code1);
  const struct2 = await builder.buildStaticStructure(code2);

  const norm1 = normalizeVariableNames(code1, struct1.variableBindings || {});
  const norm2 = normalizeVariableNames(code2, struct2.variableBindings || {});

  assertEquals(norm1.code, norm2.code, "Multi-call code should normalize identically");
});

Deno.test("normalizeVariableNames - integration: preserves non-tracked variables", async () => {
  const builder = new StaticStructureBuilder(mockDb);

  // 'i' is a loop variable, not tracked in variableBindings
  const code = `const result = await mcp.foo();
for (let i = 0; i < 10; i++) { console.log(i); }
return result;`;

  const struct = await builder.buildStaticStructure(code);
  const { code: normalized } = normalizeVariableNames(code, struct.variableBindings || {});

  // 'i' should NOT be replaced
  assertEquals(normalized.includes("let i = 0"), true);
  assertEquals(normalized.includes("i < 10"), true);
  assertEquals(normalized.includes("i++"), true);
});
