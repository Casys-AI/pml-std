/**
 * Unit Tests: Code Hashing and Semantic Hashing
 *
 * Tests for capability deduplication via hashing.
 *
 * Coverage:
 * - normalizeCode() removes comments and normalizes whitespace
 * - hashCode() produces consistent hashes
 * - hashSemanticStructure() produces same hash for semantically identical code
 *
 * @module tests/unit/capabilities/hash.test
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import {
  hashCode,
  hashSemanticStructure,
  normalizeCode,
} from "../../../src/capabilities/hash.ts";
import { StaticStructureBuilder } from "../../../src/capabilities/static-structure-builder.ts";
import type { DbClient, Transaction } from "../../../src/db/types.ts";

// Mock DbClient for tests (StaticStructureBuilder requires it but doesn't use it for basic parsing)
const mockDb: DbClient = {
  connect: async () => {},
  exec: async () => {},
  query: async () => [],
  queryOne: async () => null,
  transaction: async <T>(fn: (tx: Transaction) => Promise<T>) => fn({} as Transaction),
  close: async () => {},
};

// =============================================================================
// normalizeCode Tests
// =============================================================================

Deno.test("normalizeCode - removes single-line comments", () => {
  const code = `const x = 1; // this is a comment
const y = 2;`;
  const normalized = normalizeCode(code);
  assertEquals(normalized, "const x = 1; const y = 2;");
});

Deno.test("normalizeCode - removes multi-line comments", () => {
  const code = `/* block comment */
const x = 1;
/* another
   multi-line
   comment */
const y = 2;`;
  const normalized = normalizeCode(code);
  assertEquals(normalized, "const x = 1; const y = 2;");
});

Deno.test("normalizeCode - collapses whitespace", () => {
  const code = `const   x   =   1;

const y = 2;`;
  const normalized = normalizeCode(code);
  assertEquals(normalized, "const x = 1; const y = 2;");
});

Deno.test("normalizeCode - trims leading and trailing whitespace", () => {
  const code = `   const x = 1;   `;
  const normalized = normalizeCode(code);
  assertEquals(normalized, "const x = 1;");
});

// =============================================================================
// hashCode Tests
// =============================================================================

Deno.test("hashCode - produces 64-character hex string", async () => {
  const hash = await hashCode("const x = 1;");
  assertEquals(hash.length, 64);
  assertEquals(/^[0-9a-f]+$/.test(hash), true);
});

Deno.test("hashCode - same code produces same hash", async () => {
  const hash1 = await hashCode("const x = 1;");
  const hash2 = await hashCode("const x = 1;");
  assertEquals(hash1, hash2);
});

Deno.test("hashCode - different code produces different hash", async () => {
  const hash1 = await hashCode("const x = 1;");
  const hash2 = await hashCode("const x = 2;");
  assertNotEquals(hash1, hash2);
});

Deno.test("hashCode - whitespace variations produce same hash", async () => {
  const hash1 = await hashCode("const x = 1;");
  const hash2 = await hashCode("const   x   =   1;  ");
  assertEquals(hash1, hash2);
});

Deno.test("hashCode - comments don't affect hash", async () => {
  const hash1 = await hashCode("const x = 1;");
  const hash2 = await hashCode("// comment\nconst x = 1;");
  const hash3 = await hashCode("/* block */ const x = 1;");
  assertEquals(hash1, hash2);
  assertEquals(hash2, hash3);
});

// =============================================================================
// hashSemanticStructure Tests
// =============================================================================

Deno.test("hashSemanticStructure - same structure produces same hash", async () => {
  const builder = new StaticStructureBuilder(mockDb);

  const code1 = `const result = await mcp.std.psql_query({ query: args.query });
return result;`;

  const code2 = `const data = await mcp.std.psql_query({ query: args.query });
return data;`;

  const struct1 = await builder.buildStaticStructure(code1);
  const struct2 = await builder.buildStaticStructure(code2);

  const hash1 = await hashSemanticStructure(struct1);
  const hash2 = await hashSemanticStructure(struct2);

  assertEquals(hash1, hash2, "Semantically identical code should have same hash");
});

Deno.test("hashSemanticStructure - different tools produce different hash", async () => {
  const builder = new StaticStructureBuilder(mockDb);

  const code1 = `const result = await mcp.std.psql_query({ query: args.query });
return result;`;

  const code2 = `const result = await mcp.filesystem.read_file({ path: args.path });
return result;`;

  const struct1 = await builder.buildStaticStructure(code1);
  const struct2 = await builder.buildStaticStructure(code2);

  const hash1 = await hashSemanticStructure(struct1);
  const hash2 = await hashSemanticStructure(struct2);

  assertNotEquals(hash1, hash2, "Different tools should have different hashes");
});

Deno.test("hashSemanticStructure - different arguments produce different hash", async () => {
  const builder = new StaticStructureBuilder(mockDb);

  const code1 = `const result = await mcp.std.psql_query({ query: args.query });
return result;`;

  const code2 = `const result = await mcp.std.psql_query({ query: args.sql });
return result;`;

  const struct1 = await builder.buildStaticStructure(code1);
  const struct2 = await builder.buildStaticStructure(code2);

  const hash1 = await hashSemanticStructure(struct1);
  const hash2 = await hashSemanticStructure(struct2);

  assertNotEquals(hash1, hash2, "Different arguments should have different hashes");
});

Deno.test("hashSemanticStructure - multiple variables normalize correctly", async () => {
  const builder = new StaticStructureBuilder(mockDb);

  const code1 = `const file = await mcp.filesystem.read_file({ path: args.path });
const parsed = await mcp.std.json_parse({ text: file.content });
return parsed;`;

  const code2 = `const content = await mcp.filesystem.read_file({ path: args.path });
const data = await mcp.std.json_parse({ text: content.content });
return data;`;

  const struct1 = await builder.buildStaticStructure(code1);
  const struct2 = await builder.buildStaticStructure(code2);

  const hash1 = await hashSemanticStructure(struct1);
  const hash2 = await hashSemanticStructure(struct2);

  assertEquals(hash1, hash2, "Multiple variables should normalize to same hash");
});

Deno.test("hashSemanticStructure - produces 64-character hex string", async () => {
  const builder = new StaticStructureBuilder(mockDb);
  const code = `const result = await mcp.std.psql_query({ query: args.query });`;
  const struct = await builder.buildStaticStructure(code);
  const hash = await hashSemanticStructure(struct);

  assertEquals(hash.length, 64);
  assertEquals(/^[0-9a-f]+$/.test(hash), true);
});
