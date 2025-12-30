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
