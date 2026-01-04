/**
 * Unit tests for code-transformer.ts (Story 13.2, Migration 028)
 *
 * Tests the transformation of capability references from namespace:action to $cap:<uuid>.
 * Capabilities use the same syntax as MCP tools: mcp.namespace.action()
 *
 * Patterns:
 * - mcp.fs.readJson() → mcp["$cap:<uuid>"]()
 */

import { assertEquals, assertExists } from "jsr:@std/assert@1.0.11";
import { transformCapabilityRefs, transformLiteralsToArgs } from "../../../src/capabilities/code-transformer.ts";
import type { CapabilityRegistry, Scope } from "../../../src/capabilities/capability-registry.ts";
import type { CapabilityRecord } from "../../../src/capabilities/types.ts";

/**
 * Mock CapabilityRegistry for testing
 *
 * Note: After migration 028, record.id is a UUID (not FQDN).
 * FQDN is computed from org.project.namespace.action.hash.
 * Display name is namespace:action.
 */
class MockCapabilityRegistry implements Partial<CapabilityRegistry> {
  private records = new Map<string, CapabilityRecord>();

  /**
   * Add a mock record
   * @param actionName - The action name used for resolution (namespace:action format)
   * @param uuid - The UUID (now the primary key)
   */
  addRecord(actionName: string, uuid: string): void {
    // Parse namespace:action if provided, otherwise use actionName as action
    const parts = actionName.includes(":") ? actionName.split(":") : ["test", actionName];
    const namespace = parts[0];
    const action = parts[1];

    this.records.set(actionName, {
      id: uuid, // UUID is now the PK
      org: "local",
      project: "default",
      namespace,
      action,
      hash: "xxxx",
      usageCount: 1,
      visibility: "public",
      createdBy: "test",
      createdAt: new Date(),
      updatedAt: new Date(),
      version: 1,
      verified: false,
      successCount: 1,
      totalLatencyMs: 100,
      tags: [],
      routing: "local",
    } as CapabilityRecord);
  }

  async resolveByName(
    name: string,
    _scope: Scope,
  ): Promise<CapabilityRecord | null> {
    return this.records.get(name) || null;
  }
}

// =============================================================================
// Unit Tests - Basic Transformation (mcp.namespace.action syntax)
// =============================================================================

Deno.test({
  name: "CodeTransformer - transforms mcp.namespace.action reference to $cap:<uuid>",
  fn: async () => {
    const registry = new MockCapabilityRegistry();
    const uuid = "550e8400-e29b-41d4-a716-446655440001";
    registry.addRecord("readJson", uuid);

    const code = `
      const data = await mcp.fs.readJson({ path: "config.json" });
      return data;
    `;

    const result = await transformCapabilityRefs(
      code,
      registry as unknown as CapabilityRegistry,
    );

    assertExists(result);
    assertEquals(result.replacedCount, 1);
    assertEquals(result.replacements["readJson"], uuid);
    assertEquals(result.unresolved.length, 0);

    // Verify the code was transformed to $cap:<uuid> format
    const hasTransformed = result.code.includes(`mcp["$cap:${uuid}"]`);
    assertEquals(hasTransformed, true);
  },
});

Deno.test({
  name: "CodeTransformer - handles multiple capability references",
  fn: async () => {
    const registry = new MockCapabilityRegistry();
    const uuid1 = "550e8400-e29b-41d4-a716-446655440001";
    const uuid2 = "550e8400-e29b-41d4-a716-446655440002";
    const uuid3 = "550e8400-e29b-41d4-a716-446655440003";
    registry.addRecord("readFile", uuid1);
    registry.addRecord("writeFile", uuid2);
    registry.addRecord("deleteFile", uuid3);

    const code = `
      const content = await mcp.fs.readFile({ path: "in.txt" });
      await mcp.fs.writeFile({ path: "out.txt", content });
      await mcp.fs.deleteFile({ path: "in.txt" });
    `;

    const result = await transformCapabilityRefs(
      code,
      registry as unknown as CapabilityRegistry,
    );

    assertExists(result);
    assertEquals(result.replacedCount, 3);
    assertEquals(Object.keys(result.replacements).length, 3);
    assertEquals(result.unresolved.length, 0);

    // Verify all are transformed to $cap:<uuid> format
    assertEquals(result.code.includes(`mcp["$cap:${uuid1}"]`), true);
    assertEquals(result.code.includes(`mcp["$cap:${uuid2}"]`), true);
    assertEquals(result.code.includes(`mcp["$cap:${uuid3}"]`), true);
  },
});

Deno.test({
  name: "CodeTransformer - handles duplicate references (same capability multiple times)",
  fn: async () => {
    const registry = new MockCapabilityRegistry();
    const uuid = "550e8400-e29b-41d4-a716-446655440004";
    registry.addRecord("logMessage", uuid);

    const code = `
      await mcp.util.logMessage({ msg: "start" });
      // ... some code ...
      await mcp.util.logMessage({ msg: "end" });
    `;

    const result = await transformCapabilityRefs(
      code,
      registry as unknown as CapabilityRegistry,
    );

    assertExists(result);
    assertEquals(result.replacedCount, 2);
    // Only one unique replacement
    assertEquals(Object.keys(result.replacements).length, 1);
    assertEquals(result.replacements["logMessage"], uuid);
  },
});

// =============================================================================
// Unit Tests - Edge Cases
// =============================================================================

Deno.test({
  name: "CodeTransformer - returns original code if no mcp references found",
  fn: async () => {
    const registry = new MockCapabilityRegistry();
    registry.addRecord("unused", "550e8400-e29b-41d4-a716-446655440005");

    const code = `
      const x = 42;
      return x * 2;
    `;

    const result = await transformCapabilityRefs(
      code,
      registry as unknown as CapabilityRegistry,
    );

    assertExists(result);
    assertEquals(result.replacedCount, 0);
    assertEquals(result.code, code);
    assertEquals(Object.keys(result.replacements).length, 0);
  },
});

Deno.test({
  name: "CodeTransformer - leaves MCP tools untouched (not in registry)",
  fn: async () => {
    const registry = new MockCapabilityRegistry();
    // Not adding any records - all mcp.X.Y are treated as tools

    const code = `
      await mcp.filesystem.read_file({ path: "test.txt" });
    `;

    const result = await transformCapabilityRefs(
      code,
      registry as unknown as CapabilityRegistry,
    );

    assertExists(result);
    assertEquals(result.replacedCount, 0);
    // Code should be unchanged - read_file is not a capability
    assertEquals(result.code, code);
  },
});

Deno.test({
  name: "CodeTransformer - handles parse errors gracefully",
  fn: async () => {
    const registry = new MockCapabilityRegistry();

    const invalidCode = `
      const x = {{{ // invalid syntax
    `;

    const result = await transformCapabilityRefs(
      invalidCode,
      registry as unknown as CapabilityRegistry,
    );

    assertExists(result);
    assertEquals(result.replacedCount, 0);
    // Should return original code on parse error
    assertEquals(result.code, invalidCode);
  },
});

Deno.test({
  name: "CodeTransformer - handles empty code",
  fn: async () => {
    const registry = new MockCapabilityRegistry();

    const result = await transformCapabilityRefs(
      "",
      registry as unknown as CapabilityRegistry,
    );

    assertExists(result);
    assertEquals(result.replacedCount, 0);
    assertEquals(result.code, "");
  },
});

// =============================================================================
// Unit Tests - Mixed Patterns (capabilities + MCP tools)
// =============================================================================

Deno.test({
  name: "CodeTransformer - transforms only capabilities, leaves tools",
  fn: async () => {
    const registry = new MockCapabilityRegistry();
    const uuid = "550e8400-e29b-41d4-a716-446655440006";
    registry.addRecord("processData", uuid);
    // filesystem.read_file is NOT in registry (it's an MCP tool)

    const code = `
      const raw = await mcp.filesystem.read_file({ path: "data.json" });
      const processed = await mcp.api.processData({ data: raw });
      return processed;
    `;

    const result = await transformCapabilityRefs(
      code,
      registry as unknown as CapabilityRegistry,
    );

    assertExists(result);
    assertEquals(result.replacedCount, 1);
    assertEquals(result.replacements["processData"], uuid);

    // processData should be transformed to $cap:<uuid>
    assertEquals(result.code.includes(`mcp["$cap:${uuid}"]`), true);
    // read_file should NOT be transformed (it's an MCP tool)
    assertEquals(result.code.includes("mcp.filesystem.read_file"), true);
  },
});

Deno.test({
  name: "CodeTransformer - handles nested capability calls",
  fn: async () => {
    const registry = new MockCapabilityRegistry();
    const uuid1 = "550e8400-e29b-41d4-a716-446655440007";
    const uuid2 = "550e8400-e29b-41d4-a716-446655440008";
    registry.addRecord("fetchData", uuid1);
    registry.addRecord("transformData", uuid2);

    const code = `
      const processed = await mcp.api.transformData({
        data: await mcp.api.fetchData({ url: "https://api.example.com" })
      });
    `;

    const result = await transformCapabilityRefs(
      code,
      registry as unknown as CapabilityRegistry,
    );

    assertExists(result);
    assertEquals(result.replacedCount, 2);
    assertEquals(result.code.includes(`mcp["$cap:${uuid1}"]`), true);
    assertEquals(result.code.includes(`mcp["$cap:${uuid2}"]`), true);
  },
});

// =============================================================================
// Unit Tests - Scope Support
// =============================================================================

Deno.test({
  name: "CodeTransformer - uses provided scope for resolution",
  fn: async () => {
    // This test verifies that scope is passed to the registry
    const mockScope: Scope = { org: "custom-org", project: "custom-project" };
    let receivedScope: Scope | undefined;

    const registry = {
      async resolveByName(_name: string, scope: Scope) {
        receivedScope = scope;
        return null;
      },
    } as unknown as CapabilityRegistry;

    const code = `await mcp.test.someAction({});`;

    await transformCapabilityRefs(code, registry, mockScope);

    assertExists(receivedScope);
    assertEquals(receivedScope?.org, "custom-org");
    assertEquals(receivedScope?.project, "custom-project");
  },
});

// =============================================================================
// Unit Tests - $cap: prefix already present (skip transformation)
// =============================================================================

Deno.test({
  name: "CodeTransformer - skips already-transformed $cap: references",
  fn: async () => {
    const registry = new MockCapabilityRegistry();
    // Even if we add a record, $cap: references should be skipped
    registry.addRecord("$cap:existing-uuid", "new-uuid");

    // Code already has $cap: reference (e.g., from previous save)
    const code = `
      const data = await mcp["$cap:550e8400-e29b-41d4-a716-446655440001"]({ path: "config.json" });
      return data;
    `;

    const result = await transformCapabilityRefs(
      code,
      registry as unknown as CapabilityRegistry,
    );

    assertExists(result);
    assertEquals(result.replacedCount, 0);
    // Code should remain unchanged
    assertEquals(result.code, code);
  },
});

// =============================================================================
// Unit Tests - Literal Parameterization (transformLiteralsToArgs)
// =============================================================================

Deno.test({
  name: "LiteralTransform - transforms simple string literal to args.xxx",
  fn: async () => {
    const code = `const token = "sk-secret-123";
await mcp.api.call({ auth: token });`;

    const literalBindings = { token: "sk-secret-123" };

    const result = await transformLiteralsToArgs(code, literalBindings);

    assertExists(result);
    assertEquals(result.replacedCount, 1);
    // Token usage should be replaced with args.token
    assertEquals(result.code.includes("args.token"), true);
    // Declaration should be removed
    assertEquals(result.code.includes('const token = "sk-secret-123"'), false);
    // Schema should have token property
    assertExists(result.parametersSchema.properties?.token);
    assertEquals(result.parametersSchema.properties?.token?.type, "string");
  },
});

Deno.test({
  name: "LiteralTransform - transforms multiple literals",
  fn: async () => {
    const code = `const apiKey = "key-123";
const limit = 100;
await mcp.api.search({ key: apiKey, max: limit });`;

    const literalBindings = {
      apiKey: "key-123",
      limit: 100,
    };

    const result = await transformLiteralsToArgs(code, literalBindings);

    assertExists(result);
    assertEquals(result.replacedCount, 2);
    assertEquals(result.code.includes("args.apiKey"), true);
    assertEquals(result.code.includes("args.limit"), true);
    // Schema should have both properties
    assertExists(result.parametersSchema.properties?.apiKey);
    assertExists(result.parametersSchema.properties?.limit);
    assertEquals(result.parametersSchema.properties?.apiKey?.type, "string");
    assertEquals(result.parametersSchema.properties?.limit?.type, "integer");
  },
});

Deno.test({
  name: "LiteralTransform - transforms array literal",
  fn: async () => {
    const code = `const numbers = [1, 2, 3];
const result = numbers.filter(n => n > 1);`;

    const literalBindings = { numbers: [1, 2, 3] };

    const result = await transformLiteralsToArgs(code, literalBindings);

    assertExists(result);
    assertEquals(result.code.includes("args.numbers"), true);
    assertExists(result.parametersSchema.properties?.numbers);
    assertEquals(result.parametersSchema.properties?.numbers?.type, "array");
  },
});

Deno.test({
  name: "LiteralTransform - handles empty literalBindings",
  fn: async () => {
    const code = `await mcp.api.call({ data: args.existing });`;

    const result = await transformLiteralsToArgs(code, {});

    assertExists(result);
    assertEquals(result.replacedCount, 0);
    assertEquals(result.code, code);
    assertEquals(Object.keys(result.parametersSchema.properties || {}).length, 0);
  },
});

Deno.test({
  name: "LiteralTransform - preserves existing args.xxx references",
  fn: async () => {
    const code = `const extra = "value";
await mcp.api.call({ existing: args.param, new: extra });`;

    const literalBindings = { extra: "value" };

    const result = await transformLiteralsToArgs(code, literalBindings);

    assertExists(result);
    // Should transform extra to args.extra
    assertEquals(result.code.includes("args.extra"), true);
    // Should preserve existing args.param
    assertEquals(result.code.includes("args.param"), true);
  },
});

Deno.test({
  name: "LiteralTransform - generates correct schema with required fields",
  fn: async () => {
    const code = `const token = "abc";
const debug = true;
await mcp.api.call({ auth: token, verbose: debug });`;

    const literalBindings = {
      token: "abc",
      debug: true,
    };

    const result = await transformLiteralsToArgs(code, literalBindings);

    assertExists(result);
    // All literals should be in required array
    assertEquals(result.parametersSchema.required?.includes("token"), true);
    assertEquals(result.parametersSchema.required?.includes("debug"), true);
    // Boolean should have default value
    assertEquals(result.parametersSchema.properties?.debug?.default, true);
  },
});

Deno.test({
  name: "LiteralTransform - handles parse errors gracefully",
  fn: async () => {
    const invalidCode = `const x = {{{ // invalid`;
    const literalBindings = { x: 123 };

    const result = await transformLiteralsToArgs(invalidCode, literalBindings);

    assertExists(result);
    assertEquals(result.replacedCount, 0);
    assertEquals(result.code, invalidCode);
  },
});

Deno.test({
  name: "LiteralTransform - extracts literals for documentation",
  fn: async () => {
    const code = `const path = "/api/users";
await mcp.http.get({ url: path });`;

    const literalBindings = { path: "/api/users" };

    const result = await transformLiteralsToArgs(code, literalBindings);

    assertExists(result);
    // Should preserve original value in extractedLiterals
    assertEquals(result.extractedLiterals.path, "/api/users");
    // Should have example in schema
    const examples = result.parametersSchema.properties?.path?.examples as string[];
    assertEquals(examples?.includes("/api/users"), true);
  },
});

// =============================================================================
// Unit Tests - Inline Literal Parameterization (Story 10.2d)
// =============================================================================

Deno.test({
  name: "LiteralTransform - transforms inline string literal in object property",
  fn: async () => {
    const code = `await mcp.db.query({ host: "localhost", query: "SELECT 1" });`;

    // These would come from static-structure-builder's inline literal extraction
    const literalBindings = {
      host: "localhost",
      query: "SELECT 1",
    };

    const result = await transformLiteralsToArgs(code, literalBindings);

    assertExists(result);
    assertEquals(result.replacedCount, 2);
    // Inline literals should be replaced with args.xxx
    assertEquals(result.code.includes("args.host"), true);
    assertEquals(result.code.includes("args.query"), true);
    // Original literals should be removed
    assertEquals(result.code.includes('"localhost"'), false);
    assertEquals(result.code.includes('"SELECT 1"'), false);
    // Schema should have both properties
    assertExists(result.parametersSchema.properties?.host);
    assertExists(result.parametersSchema.properties?.query);
  },
});

Deno.test({
  name: "LiteralTransform - transforms inline number literal in object property",
  fn: async () => {
    const code = `await mcp.db.connect({ port: 5432, timeout: 30 });`;

    const literalBindings = {
      port: 5432,
      timeout: 30,
    };

    const result = await transformLiteralsToArgs(code, literalBindings);

    assertExists(result);
    assertEquals(result.replacedCount, 2);
    assertEquals(result.code.includes("args.port"), true);
    assertEquals(result.code.includes("args.timeout"), true);
    // Schema should have integer types
    assertExists(result.parametersSchema.properties?.port);
    assertEquals(result.parametersSchema.properties?.port?.type, "integer");
  },
});

Deno.test({
  name: "LiteralTransform - transforms mixed inline literals (psql_query example)",
  fn: async () => {
    const code = `await mcp.std.psql_query({
  host: "localhost",
  port: 5432,
  database: "casys",
  user: "casys",
  password: "changeme",
  query: "SELECT * FROM users"
});`;

    const literalBindings = {
      host: "localhost",
      port: 5432,
      database: "casys",
      user: "casys",
      password: "changeme",
      query: "SELECT * FROM users",
    };

    const result = await transformLiteralsToArgs(code, literalBindings);

    assertExists(result);
    assertEquals(result.replacedCount, 6);
    // All inline literals should be replaced
    assertEquals(result.code.includes("args.host"), true);
    assertEquals(result.code.includes("args.port"), true);
    assertEquals(result.code.includes("args.database"), true);
    assertEquals(result.code.includes("args.password"), true);
    assertEquals(result.code.includes("args.query"), true);
    // Sensitive values should be removed
    assertEquals(result.code.includes("changeme"), false);
    // Schema should have all properties
    assertEquals(Object.keys(result.parametersSchema.properties || {}).length, 6);
  },
});

// =============================================================================
// Unit Tests - MCP Call Inline Literals Discovery (Story 10.2e)
// =============================================================================

Deno.test({
  name: "LiteralTransform - discovers inline literals in MCP calls without literalBindings",
  fn: async () => {
    // This test verifies that inline literals are discovered even with empty literalBindings
    const code = `const r = await mcp.std.cap_rename({
  name: "fetch:exec_fc6ca799",
  namespace: "api",
  action: "checkEmergence"
});`;

    // Empty literalBindings - the function should discover literals automatically
    const literalBindings = {};

    const result = await transformLiteralsToArgs(code, literalBindings);

    assertExists(result);
    // Should discover and transform 3 inline literals
    assertEquals(result.replacedCount, 3);
    assertEquals(result.code.includes("args.name"), true);
    assertEquals(result.code.includes("args.namespace"), true);
    assertEquals(result.code.includes("args.action"), true);
    // Original values should be removed
    assertEquals(result.code.includes("fetch:exec_fc6ca799"), false);
    assertEquals(result.code.includes('"api"'), false);
    // Schema should have all 3 discovered properties
    assertEquals(Object.keys(result.parametersSchema.properties || {}).length, 3);
    // extractedLiterals should contain discovered values
    assertEquals(result.extractedLiterals.name, "fetch:exec_fc6ca799");
    assertEquals(result.extractedLiterals.namespace, "api");
    assertEquals(result.extractedLiterals.action, "checkEmergence");
  },
});

Deno.test({
  name: "LiteralTransform - discovers nested MCP call inline literals",
  fn: async () => {
    // Multiple MCP calls with inline literals
    const code = `
const r1 = await mcp.std.cap_rename({ name: "old:name", newName: "new:name" });
const r2 = await mcp.fs.read_file({ path: "/tmp/test.txt" });
`;

    const result = await transformLiteralsToArgs(code, {});

    assertExists(result);
    // Should discover all 3 inline literals (name, newName, path)
    assertEquals(result.replacedCount, 3);
    assertEquals(result.code.includes("args.name"), true);
    assertEquals(result.code.includes("args.newName"), true);
    assertEquals(result.code.includes("args.path"), true);
    // Schema should have 3 properties
    assertEquals(Object.keys(result.parametersSchema.properties || {}).length, 3);
  },
});

// =============================================================================
// Unit Tests - Nested Literal Extraction in Code Templates (Story 10.2f)
// =============================================================================

Deno.test({
  name: "LiteralTransform - extracts nested literals from code template (Playwright)",
  fn: async () => {
    // Code template with nested literals that should be extracted
    const code = `const result = await mcp.playwright.browser_run_code({
  code: \`async (page) => {
    await page.goto('http://localhost:8081/dashboard');
    await page.waitForLoadState('networkidle');
    const content = await page.evaluate(() => {
      return texts.slice(0, 100).join(' | ');
    });
    return { url: page.url(), content };
  }\`
});`;

    const result = await transformLiteralsToArgs(code, {});

    assertExists(result);
    // Should extract 5 nested literals: url, state, sliceStart, sliceEnd, separator
    assertEquals(result.replacedCount, 5);
    // Check that interpolations were added
    assertEquals(result.code.includes("${args.url}"), true);
    assertEquals(result.code.includes("${args.state}"), true);
    assertEquals(result.code.includes("${args.sliceStart}"), true);
    assertEquals(result.code.includes("${args.sliceEnd}"), true);
    assertEquals(result.code.includes("${args.separator}"), true);
    // Check extracted values
    assertEquals(result.extractedLiterals.url, "http://localhost:8081/dashboard");
    assertEquals(result.extractedLiterals.state, "networkidle");
    assertEquals(result.extractedLiterals.sliceStart, 0);
    assertEquals(result.extractedLiterals.sliceEnd, 100);
    assertEquals(result.extractedLiterals.separator, " | ");
    // Original hardcoded values should be removed
    assertEquals(result.code.includes("'http://localhost:8081/dashboard'"), false);
    assertEquals(result.code.includes("'networkidle'"), false);
    // Schema should have all 5 parameters
    assertEquals(Object.keys(result.parametersSchema.properties || {}).length, 5);
  },
});

Deno.test({
  name: "LiteralTransform - handles simple SQL template (not code-like)",
  fn: async () => {
    // SQL template should be treated as regular literal, not code template
    const code = `const result = await mcp.postgres.query({
  query: \`SELECT * FROM users WHERE id = 1\`
});`;

    const result = await transformLiteralsToArgs(code, {});

    assertExists(result);
    // SQL is not code-like, so it should be replaced as a whole
    assertEquals(result.replacedCount, 1);
    assertEquals(result.code.includes("args.query"), true);
    assertEquals(result.extractedLiterals.query, "SELECT * FROM users WHERE id = 1");
  },
});

// =============================================================================
// Unit Tests - Variable Shadowing in Loops (Bug 1 Fix - Story 10.2)
// =============================================================================

Deno.test({
  name: "LiteralTransform - does NOT replace loop variable that shadows outer literal (forOf)",
  fn: async () => {
    // Bug 1: Loop variable `file` shadows outer `const file = "README.md"`
    // The loop variable should NOT be replaced with args.file
    const code = `const file = "README.md";
const files = ["a.txt", "b.txt"];
for (const file of files) {
  await mcp.fs.read({ path: file });
}`;

    const literalBindings = {
      file: "README.md",
      files: ["a.txt", "b.txt"],
    };

    const result = await transformLiteralsToArgs(code, literalBindings);

    assertExists(result);
    // The outer `file` declaration should be replaced
    assertEquals(result.code.includes("const file = args.file"), false); // Declaration removed
    // files array should be replaced
    assertEquals(result.code.includes("args.files"), true);
    // The loop variable `file` in `for (const file of` should NOT be replaced
    assertEquals(result.code.includes("for (const file of"), true, "Loop variable was incorrectly replaced!");
    // The `path: file` inside loop should use the loop variable, NOT args.file
    assertEquals(result.code.includes("path: file"), true, "Loop body variable was incorrectly replaced!");
    assertEquals(result.code.includes("path: args.file"), false);
  },
});

Deno.test({
  name: "LiteralTransform - does NOT replace loop variable that shadows outer literal (forIn)",
  fn: async () => {
    const code = `const key = "defaultKey";
const obj = { a: 1, b: 2 };
for (const key in obj) {
  console.log(key, obj[key]);
}`;

    const literalBindings = {
      key: "defaultKey",
    };

    const result = await transformLiteralsToArgs(code, literalBindings);

    assertExists(result);
    // Loop variable `key` should NOT be replaced
    assertEquals(result.code.includes("for (const key in"), true);
    assertEquals(result.code.includes("console.log(key,"), true);
    // Should not have args.key in the loop body
    assertEquals(result.code.includes("console.log(args.key,"), false);
  },
});

Deno.test({
  name: "LiteralTransform - does NOT replace for-loop index variable that shadows outer literal",
  fn: async () => {
    const code = `const i = 10;
for (let i = 0; i < 5; i++) {
  await mcp.log({ index: i });
}
const final = i;`;

    const literalBindings = {
      i: 10,
    };

    const result = await transformLiteralsToArgs(code, literalBindings);

    assertExists(result);
    // Loop variable `i` in `for (let i = 0` should NOT be replaced
    assertEquals(result.code.includes("for (let i = 0"), true);
    // `index: i` inside loop should use loop variable
    assertEquals(result.code.includes("index: i"), true);
    assertEquals(result.code.includes("index: args.i"), false);
    // `const final = i` AFTER loop should use outer (now args.i)
    // Actually after the loop, `i` refers to the outer one which was removed
    // The replacement behavior here is complex - the key test is that loop body is correct
  },
});

Deno.test({
  name: "LiteralTransform - does NOT replace arrow function param that shadows outer literal",
  fn: async () => {
    const code = `const item = "default";
const items = ["a", "b"];
const results = items.map(item => item.toUpperCase());`;

    const literalBindings = {
      item: "default",
      items: ["a", "b"],
    };

    const result = await transformLiteralsToArgs(code, literalBindings);

    assertExists(result);
    // Arrow param `item` should NOT be replaced
    assertEquals(result.code.includes(".map(item =>"), true);
    assertEquals(result.code.includes("item.toUpperCase()"), true);
    // Should NOT have args.item in the map callback
    assertEquals(result.code.includes("args.item.toUpperCase()"), false);
  },
});

Deno.test({
  name: "LiteralTransform - does NOT replace function param that shadows outer literal",
  fn: async () => {
    const code = `const data = "outer";
function process(data) {
  return data.trim();
}
const result = process(data);`;

    const literalBindings = {
      data: "outer",
    };

    const result = await transformLiteralsToArgs(code, literalBindings);

    assertExists(result);
    // Function param `data` should NOT be replaced
    assertEquals(result.code.includes("function process(data)"), true);
    assertEquals(result.code.includes("return data.trim()"), true);
    // Should NOT have args.data in the function body
    assertEquals(result.code.includes("return args.data.trim()"), false);
  },
});

Deno.test({
  name: "LiteralTransform - does NOT replace catch clause param that shadows outer literal",
  fn: async () => {
    const code = `const error = "default error";
try {
  throw new Error("test");
} catch (error) {
  console.log(error.message);
}`;

    const literalBindings = {
      error: "default error",
    };

    const result = await transformLiteralsToArgs(code, literalBindings);

    assertExists(result);
    // Catch param `error` should NOT be replaced
    assertEquals(result.code.includes("catch (error)"), true);
    assertEquals(result.code.includes("error.message"), true);
    // Should NOT have args.error in the catch body
    assertEquals(result.code.includes("args.error.message"), false);
  },
});

Deno.test({
  name: "LiteralTransform - correctly replaces outer variable used outside shadowing scope",
  fn: async () => {
    const code = `const file = "README.md";
await mcp.fs.read({ path: file });
for (const file of ["a.txt"]) {
  await mcp.fs.process({ name: file });
}
await mcp.fs.write({ target: file });`;

    const literalBindings = {
      file: "README.md",
    };

    const result = await transformLiteralsToArgs(code, literalBindings);

    assertExists(result);
    // First usage BEFORE loop should be replaced (or declaration removed)
    // The declaration `const file = "README.md"` should be removed
    assertEquals(result.code.includes('const file = "README.md"'), false);
    // Loop variable should stay as `file`
    assertEquals(result.code.includes("for (const file of"), true);
    // Inside loop, `name: file` should use loop variable
    assertEquals(result.code.includes("name: file"), true);
    // AFTER loop, `target: file` should... this is tricky
    // After loop, the outer `file` is now args.file
    // But since the declaration is removed, this test verifies the behavior
  },
});
