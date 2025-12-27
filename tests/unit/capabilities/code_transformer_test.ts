/**
 * Unit tests for code-transformer.ts (Story 13.2)
 *
 * Tests the transformation of capability references from display_name to FQDN.
 * Capabilities use the same syntax as MCP tools: mcp.namespace.action()
 *
 * Patterns:
 * - mcp.fs.readJson() → mcp["local.default.fs.read_json.a7f3"]()
 */

import { assertEquals, assertExists } from "jsr:@std/assert@1.0.11";
import { transformCapabilityRefs } from "../../../src/capabilities/code-transformer.ts";
import type { CapabilityRegistry, Scope } from "../../../src/capabilities/capability-registry.ts";
import type { CapabilityRecord } from "../../../src/capabilities/types.ts";

/**
 * Mock CapabilityRegistry for testing
 */
class MockCapabilityRegistry implements Partial<CapabilityRegistry> {
  private records = new Map<string, CapabilityRecord>();

  addRecord(displayName: string, fqdn: string): void {
    this.records.set(displayName, {
      id: fqdn,
      displayName,
      org: "local",
      project: "default",
      namespace: "test",
      action: displayName,
      hash: fqdn.split(".").pop() || "xxxx",
      usageCount: 1,
      successRate: 1.0,
      visibility: "public",
      createdBy: "test",
      createdAt: new Date(),
      updatedAt: new Date(),
      version: 1,
      verified: false,
      successCount: 1,
      totalLatencyMs: 100,
      avgLatencyMs: 100,
      lastUsedAt: new Date(),
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
  name: "CodeTransformer - transforms mcp.namespace.action reference",
  fn: async () => {
    const registry = new MockCapabilityRegistry();
    registry.addRecord("readJson", "local.default.fs.read_json.a7f3");

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
    assertEquals(result.replacements["readJson"], "local.default.fs.read_json.a7f3");
    assertEquals(result.unresolved.length, 0);

    // Verify the code was transformed
    const hasTransformed = result.code.includes('mcp["local.default.fs.read_json.a7f3"]');
    assertEquals(hasTransformed, true);
  },
});

Deno.test({
  name: "CodeTransformer - handles multiple capability references",
  fn: async () => {
    const registry = new MockCapabilityRegistry();
    registry.addRecord("readFile", "local.default.fs.read.1111");
    registry.addRecord("writeFile", "local.default.fs.write.2222");
    registry.addRecord("deleteFile", "local.default.fs.delete.3333");

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
  },
});

Deno.test({
  name: "CodeTransformer - handles duplicate references (same capability multiple times)",
  fn: async () => {
    const registry = new MockCapabilityRegistry();
    registry.addRecord("logMessage", "local.default.util.log.4444");

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
  },
});

// =============================================================================
// Unit Tests - Edge Cases
// =============================================================================

Deno.test({
  name: "CodeTransformer - returns original code if no mcp references found",
  fn: async () => {
    const registry = new MockCapabilityRegistry();
    registry.addRecord("unused", "local.default.test.unused.5555");

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
    registry.addRecord("processData", "local.default.api.process.aaaa");
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
    assertEquals(result.replacements["processData"], "local.default.api.process.aaaa");

    // processData should be transformed
    assertEquals(result.code.includes('mcp["local.default.api.process.aaaa"]'), true);
    // read_file should NOT be transformed (it's an MCP tool)
    assertEquals(result.code.includes("mcp.filesystem.read_file"), true);
  },
});

Deno.test({
  name: "CodeTransformer - handles nested capability calls",
  fn: async () => {
    const registry = new MockCapabilityRegistry();
    registry.addRecord("fetchData", "local.default.api.fetch.1111");
    registry.addRecord("transformData", "local.default.api.transform.2222");

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
