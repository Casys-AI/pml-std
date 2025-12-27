import { assertEquals, assertMatch, assertNotEquals } from "@std/assert";
import {
  generateApiKey,
  getApiKeyPrefix,
  hashApiKey,
  verifyApiKey,
} from "../../../src/lib/api-key.ts";

Deno.test("generateApiKey - format correct", () => {
  const { key, prefix } = generateApiKey();

  // Key format: ac_ + 24 alphanumeric chars
  assertMatch(key, /^ac_[a-zA-Z0-9]{24}$/);

  // Prefix is first 11 chars
  assertEquals(prefix.length, 11);
  assertEquals(prefix, key.substring(0, 11));
  assertMatch(prefix, /^ac_[a-zA-Z0-9]{8}$/);
});

Deno.test("generateApiKey - unique each time", () => {
  const key1 = generateApiKey();
  const key2 = generateApiKey();

  assertNotEquals(key1.key, key2.key);
  assertNotEquals(key1.prefix, key2.prefix);
});

Deno.test("hashApiKey/verifyApiKey - roundtrip success", async () => {
  const { key } = generateApiKey();
  const hashedKey = await hashApiKey(key);

  // Hash is different from original
  assertNotEquals(hashedKey, key);

  // Verify succeeds with correct key
  assertEquals(await verifyApiKey(key, hashedKey), true);
});

Deno.test("hashApiKey/verifyApiKey - wrong key fails", async () => {
  const { key } = generateApiKey();
  const hashedKey = await hashApiKey(key);

  // Verify fails with wrong key
  assertEquals(await verifyApiKey("ac_wrongkey12345678901234", hashedKey), false);
});

Deno.test("getApiKeyPrefix - extraction", () => {
  const prefix = getApiKeyPrefix("ac_a1b2c3d4e5f6g7h8i9j0k1l2");
  assertEquals(prefix, "ac_a1b2c3d4");
  assertEquals(prefix.length, 11);
});
