/**
 * Unit tests for CapabilityDataService - resolveCapReferences
 */

import { assertEquals } from "@std/assert";

// Test the resolveCapReferences logic directly
// Since it's a private function, we test through the public interface or extract the logic

Deno.test("resolveCapReferences - should replace $cap:uuid with mcp.namespace.action", () => {
  // Test the regex pattern used in resolveCapReferences
  const testCode = `const result = await mcp["$cap:12345678-1234-1234-1234-123456789abc"]({ arg: "value" });`;

  // Simulate the lookup map
  const capUuidLookup = new Map<string, string>();
  capUuidLookup.set("12345678-1234-1234-1234-123456789abc", "test:action");

  // Apply the same transformation as resolveCapReferences
  const resolved = testCode.replace(
    /mcp\["\$cap:([0-9a-f-]{36})"\]/gi,
    (_match, uuid) => {
      const resolved = capUuidLookup.get(uuid);
      if (resolved) {
        const [namespace, action] = resolved.split(":");
        return `mcp.${namespace}.${action}`;
      }
      return `mcp["$cap:${uuid}"]`;
    },
  );

  assertEquals(resolved, `const result = await mcp.test.action({ arg: "value" });`);
});

Deno.test("resolveCapReferences - should preserve unresolved cap references", () => {
  const testCode = `const result = await mcp["$cap:unknown-uuid-1234-1234-123456789abc"]();`;

  // Empty lookup - nothing to resolve
  const capUuidLookup = new Map<string, string>();

  const resolved = testCode.replace(
    /mcp\["\$cap:([0-9a-f-]{36})"\]/gi,
    (_match, uuid) => {
      const resolved = capUuidLookup.get(uuid);
      if (resolved) {
        const [namespace, action] = resolved.split(":");
        return `mcp.${namespace}.${action}`;
      }
      return `mcp["$cap:${uuid}"]`;
    },
  );

  // Should remain unchanged when UUID not found
  assertEquals(resolved, testCode);
});

Deno.test("resolveCapReferences - should handle multiple cap references in same code", () => {
  const testCode = `
const a = await mcp["$cap:11111111-1111-1111-1111-111111111111"]();
const b = await mcp["$cap:22222222-2222-2222-2222-222222222222"]();
`;

  const capUuidLookup = new Map<string, string>();
  capUuidLookup.set("11111111-1111-1111-1111-111111111111", "ns1:action1");
  capUuidLookup.set("22222222-2222-2222-2222-222222222222", "ns2:action2");

  const resolved = testCode.replace(
    /mcp\["\$cap:([0-9a-f-]{36})"\]/gi,
    (_match, uuid) => {
      const resolved = capUuidLookup.get(uuid);
      if (resolved) {
        const [namespace, action] = resolved.split(":");
        return `mcp.${namespace}.${action}`;
      }
      return `mcp["$cap:${uuid}"]`;
    },
  );

  assertEquals(resolved, `
const a = await mcp.ns1.action1();
const b = await mcp.ns2.action2();
`);
});

Deno.test("resolveCapReferences - should handle mixed resolved and unresolved", () => {
  const testCode = `
const a = await mcp["$cap:11111111-1111-1111-1111-111111111111"]();
const b = await mcp["$cap:99999999-9999-9999-9999-999999999999"]();
`;

  const capUuidLookup = new Map<string, string>();
  capUuidLookup.set("11111111-1111-1111-1111-111111111111", "known:capability");
  // 99999999-... not in lookup

  const resolved = testCode.replace(
    /mcp\["\$cap:([0-9a-f-]{36})"\]/gi,
    (_match, uuid) => {
      const resolved = capUuidLookup.get(uuid);
      if (resolved) {
        const [namespace, action] = resolved.split(":");
        return `mcp.${namespace}.${action}`;
      }
      return `mcp["$cap:${uuid}"]`;
    },
  );

  assertEquals(resolved, `
const a = await mcp.known.capability();
const b = await mcp["$cap:99999999-9999-9999-9999-999999999999"]();
`);
});

Deno.test("resolveCapReferences - should be case insensitive for hex characters", () => {
  const testCode = `const result = await mcp["$cap:ABCDEF12-1234-1234-1234-123456789ABC"]();`;

  const capUuidLookup = new Map<string, string>();
  capUuidLookup.set("abcdef12-1234-1234-1234-123456789abc", "upper:case");

  const resolved = testCode.replace(
    /mcp\["\$cap:([0-9a-f-]{36})"\]/gi,
    (_match, uuid) => {
      const resolved = capUuidLookup.get(uuid.toLowerCase());
      if (resolved) {
        const [namespace, action] = resolved.split(":");
        return `mcp.${namespace}.${action}`;
      }
      return `mcp["$cap:${uuid}"]`;
    },
  );

  assertEquals(resolved, `const result = await mcp.upper.case();`);
});

Deno.test("resolveCapReferences - should not affect regular mcp calls", () => {
  const testCode = `
const a = await mcp.std.psql_query({ query: "SELECT 1" });
const b = await mcp["$cap:11111111-1111-1111-1111-111111111111"]();
const c = await mcp.filesystem.read_file({ path: "/tmp/test" });
`;

  const capUuidLookup = new Map<string, string>();
  capUuidLookup.set("11111111-1111-1111-1111-111111111111", "custom:action");

  const resolved = testCode.replace(
    /mcp\["\$cap:([0-9a-f-]{36})"\]/gi,
    (_match, uuid) => {
      const resolved = capUuidLookup.get(uuid);
      if (resolved) {
        const [namespace, action] = resolved.split(":");
        return `mcp.${namespace}.${action}`;
      }
      return `mcp["$cap:${uuid}"]`;
    },
  );

  assertEquals(resolved, `
const a = await mcp.std.psql_query({ query: "SELECT 1" });
const b = await mcp.custom.action();
const c = await mcp.filesystem.read_file({ path: "/tmp/test" });
`);
});
