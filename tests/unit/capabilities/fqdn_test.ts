/**
 * Unit tests for FQDN utilities (Story 13.1)
 *
 * Tests FQDN generation, parsing, validation, and hash generation.
 *
 * @module tests/unit/capabilities/fqdn_test
 */

import { assert, assertEquals, assertNotEquals, assertThrows } from "@std/assert";
import {
  extractDefaultDisplayName,
  fqdnBelongsToScope,
  type FQDNComponents,
  generateFQDN,
  generateFQDNFromCode,
  generateHash,
  getShortName,
  isValidFQDN,
  isValidMCPName,
  parseFQDN,
} from "../../../src/capabilities/fqdn.ts";

// ============================================
// generateFQDN Tests (AC4)
// ============================================

Deno.test("generateFQDN - creates valid FQDN from components", () => {
  const components: FQDNComponents = {
    org: "local",
    project: "default",
    namespace: "fs",
    action: "read_json",
    hash: "a7f3",
  };

  const fqdn = generateFQDN(components);
  assertEquals(fqdn, "local.default.fs.read_json.a7f3");
});

Deno.test("generateFQDN - handles organization capability", () => {
  const components: FQDNComponents = {
    org: "acme",
    project: "webapp",
    namespace: "api",
    action: "fetch_user",
    hash: "b8e2",
  };

  const fqdn = generateFQDN(components);
  assertEquals(fqdn, "acme.webapp.api.fetch_user.b8e2");
});

Deno.test("generateFQDN - handles underscores and hyphens", () => {
  const components: FQDNComponents = {
    org: "my_org",
    project: "my-project",
    namespace: "data_api",
    action: "fetch-all_items",
    hash: "c9d1",
  };

  const fqdn = generateFQDN(components);
  assertEquals(fqdn, "my_org.my-project.data_api.fetch-all_items.c9d1");
});

Deno.test("generateFQDN - rejects invalid org (starts with number)", () => {
  const components: FQDNComponents = {
    org: "123invalid",
    project: "default",
    namespace: "fs",
    action: "read",
    hash: "a7f3",
  };

  assertThrows(
    () => generateFQDN(components),
    Error,
    "Invalid org component",
  );
});

Deno.test("generateFQDN - rejects invalid project (has dot)", () => {
  const components: FQDNComponents = {
    org: "local",
    project: "my.project",
    namespace: "fs",
    action: "read",
    hash: "a7f3",
  };

  assertThrows(
    () => generateFQDN(components),
    Error,
    "Invalid project component",
  );
});

Deno.test("generateFQDN - rejects invalid hash (wrong length)", () => {
  const components: FQDNComponents = {
    org: "local",
    project: "default",
    namespace: "fs",
    action: "read",
    hash: "a7f3aa", // 6 chars instead of 4
  };

  assertThrows(
    () => generateFQDN(components),
    Error,
    "Invalid hash",
  );
});

Deno.test("generateFQDN - rejects invalid hash (uppercase)", () => {
  const components: FQDNComponents = {
    org: "local",
    project: "default",
    namespace: "fs",
    action: "read",
    hash: "A7F3", // uppercase not allowed
  };

  assertThrows(
    () => generateFQDN(components),
    Error,
    "Invalid hash",
  );
});

Deno.test("generateFQDN - rejects invalid hash (mixed case)", () => {
  const components: FQDNComponents = {
    org: "local",
    project: "default",
    namespace: "fs",
    action: "read",
    hash: "a7F3", // mixed case not allowed
  };

  assertThrows(
    () => generateFQDN(components),
    Error,
    "Invalid hash",
  );
});

// ============================================
// parseFQDN Tests (AC6)
// ============================================

Deno.test("parseFQDN - parses valid FQDN correctly", () => {
  const result = parseFQDN("acme.webapp.fs.read_json.a7f3");

  assertEquals(result.org, "acme");
  assertEquals(result.project, "webapp");
  assertEquals(result.namespace, "fs");
  assertEquals(result.action, "read_json");
  assertEquals(result.hash, "a7f3");
});

Deno.test("parseFQDN - roundtrip with generateFQDN", () => {
  const original: FQDNComponents = {
    org: "marketplace",
    project: "public",
    namespace: "util",
    action: "format_date",
    hash: "c9d1",
  };

  const fqdn = generateFQDN(original);
  const parsed = parseFQDN(fqdn);

  assertEquals(parsed, original);
});

Deno.test("parseFQDN - rejects too few parts", () => {
  assertThrows(
    () => parseFQDN("org.project.namespace"),
    Error,
    "Expected 5 parts",
  );
});

Deno.test("parseFQDN - rejects too many parts", () => {
  assertThrows(
    () => parseFQDN("org.project.namespace.action.hash.extra"),
    Error,
    "Expected 5 parts",
  );
});

Deno.test("parseFQDN - rejects empty string", () => {
  assertThrows(
    () => parseFQDN(""),
    Error,
    "Expected 5 parts",
  );
});

Deno.test("parseFQDN - rejects invalid component in middle", () => {
  assertThrows(
    () => parseFQDN("local.default.123invalid.action.a7f3"),
    Error,
    "Invalid namespace",
  );
});

// ============================================
// isValidFQDN Tests
// ============================================

Deno.test("isValidFQDN - returns true for valid FQDN", () => {
  assert(isValidFQDN("local.default.fs.read_json.a7f3"));
  assert(isValidFQDN("acme.webapp.api.fetch_user.b8e2"));
  assert(isValidFQDN("_private.project.ns.action.0000"));
});

Deno.test("isValidFQDN - returns false for invalid FQDN", () => {
  assertEquals(isValidFQDN(""), false);
  assertEquals(isValidFQDN("only.three.parts"), false);
  assertEquals(isValidFQDN("org.project.ns.action.HASH"), false); // uppercase hash
  assertEquals(isValidFQDN("123.project.ns.action.a7f3"), false); // invalid org
});

// ============================================
// generateHash Tests (AC4)
// ============================================

Deno.test("generateHash - produces 4-char hex string", async () => {
  const hash = await generateHash("export function foo() { return 42; }");

  assertEquals(hash.length, 4);
  assert(/^[0-9a-f]{4}$/.test(hash));
});

Deno.test("generateHash - same input produces same hash (deterministic)", async () => {
  const code = "const x = 1;";
  const hash1 = await generateHash(code);
  const hash2 = await generateHash(code);

  assertEquals(hash1, hash2);
});

Deno.test("generateHash - different inputs produce different hashes", async () => {
  const hash1 = await generateHash("function a() {}");
  const hash2 = await generateHash("function b() {}");

  assertNotEquals(hash1, hash2);
});

Deno.test("generateHash - handles empty string", async () => {
  const hash = await generateHash("");

  assertEquals(hash.length, 4);
  assert(/^[0-9a-f]{4}$/.test(hash));
});

Deno.test("generateHash - handles unicode content", async () => {
  const hash = await generateHash("const emoji = '🚀';");

  assertEquals(hash.length, 4);
  assert(/^[0-9a-f]{4}$/.test(hash));
});

Deno.test("generateHash - collision resistance (basic check)", async () => {
  // Generate hashes for many different strings and check for uniqueness
  const hashes = new Set<string>();
  const testStrings = [
    "a",
    "b",
    "c",
    "aa",
    "ab",
    "ba",
    "abc",
    "def",
    "function a() {}",
    "function b() {}",
    "function c() {}",
    "const x = 1;",
    "const x = 2;",
    "const y = 1;",
    "export default {};",
    "export const x = 1;",
  ];

  for (const str of testStrings) {
    const hash = await generateHash(str);
    hashes.add(hash);
  }

  // With 4-char hex (65536 possibilities) and 15 inputs, collision chance is low
  // We expect all unique, but allow for one collision in this basic test
  assert(hashes.size >= testStrings.length - 1);
});

// ============================================
// isValidMCPName Tests (AC5 constraint)
// ============================================

Deno.test("isValidMCPName - accepts alphanumeric names", () => {
  assert(isValidMCPName("readConfig"));
  assert(isValidMCPName("ReadConfig"));
  assert(isValidMCPName("read123"));
  assert(isValidMCPName("a1b2c3"));
});

Deno.test("isValidMCPName - accepts underscores", () => {
  assert(isValidMCPName("read_config"));
  assert(isValidMCPName("_private"));
  assert(isValidMCPName("my_app_function"));
});

Deno.test("isValidMCPName - accepts hyphens", () => {
  assert(isValidMCPName("read-config"));
  assert(isValidMCPName("analytics-compute"));
  assert(isValidMCPName("my-app-function"));
});

Deno.test("isValidMCPName - accepts colons (MCP namespace)", () => {
  assert(isValidMCPName("fs:read"));
  assert(isValidMCPName("myapp:fetch_user"));
  assert(isValidMCPName("api:v2:get_user"));
});

Deno.test("isValidMCPName - accepts mixed valid characters", () => {
  assert(isValidMCPName("fs:read_json"));
  assert(isValidMCPName("my-app:fetch_user-v2"));
  assert(isValidMCPName("api_v2:get-user_by_id"));
});

Deno.test("isValidMCPName - rejects spaces", () => {
  assertEquals(isValidMCPName("my function"), false);
  assertEquals(isValidMCPName(" read"), false);
  assertEquals(isValidMCPName("read "), false);
});

Deno.test("isValidMCPName - rejects special characters", () => {
  assertEquals(isValidMCPName("foo@bar"), false);
  assertEquals(isValidMCPName("foo#bar"), false);
  assertEquals(isValidMCPName("foo$bar"), false);
  assertEquals(isValidMCPName("foo%bar"), false);
  assertEquals(isValidMCPName("foo.bar"), false); // dot not allowed
  assertEquals(isValidMCPName("foo/bar"), false);
  assertEquals(isValidMCPName("foo\\bar"), false);
});

Deno.test("isValidMCPName - rejects empty string", () => {
  assertEquals(isValidMCPName(""), false);
});

// ============================================
// extractDefaultDisplayName Tests (AC5)
// ============================================

Deno.test("extractDefaultDisplayName - extracts action from FQDN", () => {
  assertEquals(
    extractDefaultDisplayName("acme.webapp.fs.read_json.a7f3"),
    "read_json",
  );
});

Deno.test("extractDefaultDisplayName - works with complex action names", () => {
  assertEquals(
    extractDefaultDisplayName("local.default.api.fetch_user_by_id.b8e2"),
    "fetch_user_by_id",
  );
});

// ============================================
// generateFQDNFromCode Tests
// ============================================

Deno.test("generateFQDNFromCode - generates FQDN with automatic hash", async () => {
  const code =
    "export function readJson(path: string) { return JSON.parse(Deno.readTextFileSync(path)); }";
  const fqdn = await generateFQDNFromCode("local", "default", "fs", "read_json", code);

  // Should match pattern: local.default.fs.read_json.<4-char-hash>
  assert(fqdn.startsWith("local.default.fs.read_json."));
  assertEquals(fqdn.length, "local.default.fs.read_json.".length + 4);
});

Deno.test("generateFQDNFromCode - same code produces same FQDN", async () => {
  const code = "const x = 1;";
  const fqdn1 = await generateFQDNFromCode("org", "proj", "ns", "action", code);
  const fqdn2 = await generateFQDNFromCode("org", "proj", "ns", "action", code);

  assertEquals(fqdn1, fqdn2);
});

Deno.test("generateFQDNFromCode - different code produces different FQDN", async () => {
  const code1 = "const x = 1;";
  const code2 = "const x = 2;";
  const fqdn1 = await generateFQDNFromCode("org", "proj", "ns", "action", code1);
  const fqdn2 = await generateFQDNFromCode("org", "proj", "ns", "action", code2);

  assertNotEquals(fqdn1, fqdn2);
});

// ============================================
// fqdnBelongsToScope Tests
// ============================================

Deno.test("fqdnBelongsToScope - returns true for matching scope", () => {
  assert(fqdnBelongsToScope("acme.webapp.fs.read.a7f3", "acme", "webapp"));
});

Deno.test("fqdnBelongsToScope - returns false for different org", () => {
  assertEquals(
    fqdnBelongsToScope("acme.webapp.fs.read.a7f3", "other", "webapp"),
    false,
  );
});

Deno.test("fqdnBelongsToScope - returns false for different project", () => {
  assertEquals(
    fqdnBelongsToScope("acme.webapp.fs.read.a7f3", "acme", "other"),
    false,
  );
});

Deno.test("fqdnBelongsToScope - returns false for invalid FQDN", () => {
  assertEquals(
    fqdnBelongsToScope("invalid.fqdn", "acme", "webapp"),
    false,
  );
});

// ============================================
// getShortName Tests
// ============================================

Deno.test("getShortName - extracts namespace.action", () => {
  assertEquals(
    getShortName("acme.webapp.fs.read_json.a7f3"),
    "fs.read_json",
  );
});

Deno.test("getShortName - works with complex names", () => {
  assertEquals(
    getShortName("marketplace.public.data_api.fetch_all_items.c9d1"),
    "data_api.fetch_all_items",
  );
});
