/**
 * E2E Tests: Code Execution Caching
 *
 * Validates caching behavior:
 * - Cache hit on identical code + context
 * - Cache miss on different code
 * - Cache miss on different context
 * - TTL expiration
 * - Cache invalidation on tool changes
 * - Performance improvement with caching
 *
 * Story 3.8 - AC: #2.1 (cache hit on second run)
 */

import { assertEquals, assertExists } from "@std/assert";
import { CodeExecutionCache, generateCacheKey } from "../../../src/sandbox/cache.ts";
import type { ExecutionResult } from "../../../src/sandbox/types.ts";
import type { JsonValue } from "../../../src/capabilities/types.ts";

/**
 * Create a mock execution result
 */
function createMockResult(value: JsonValue): ExecutionResult {
  return {
    success: true,
    result: value,
    executionTimeMs: 100,
  };
}

/**
 * Create a cache entry
 */
function createCacheEntry(
  code: string,
  context: Record<string, unknown>,
  result: ExecutionResult,
  toolVersions: Record<string, string> = {},
) {
  const now = Date.now();
  return {
    code,
    context,
    result,
    toolVersions,
    timestamp: now,
    createdAt: now,
    expiresAt: now + 60000, // 60s TTL
    hitCount: 0,
  };
}

Deno.test({
  name: "E2E Cache: Hit on identical code and context",
  fn() {
    const cache = new CodeExecutionCache({
      enabled: true,
      maxEntries: 100,
      ttlSeconds: 60,
      persistence: false,
    });

    const code = "return 1 + 1;";
    const context = { data: [1, 2, 3] };
    const toolVersions = { "filesystem": "1.0.0" };
    const result = createMockResult(2);
    const key = generateCacheKey(code, context, toolVersions);

    // Set cache entry
    cache.set(key, createCacheEntry(code, context, result, toolVersions));

    // Get should return cached result
    const cached = cache.get(key);
    assertExists(cached, "Cache hit expected");
    assertEquals(cached!.result.result, 2);

    // Stats should show hit
    const stats = cache.getStats();
    assertEquals(stats.hits, 1);
  },
});

Deno.test({
  name: "E2E Cache: Miss on different code",
  fn() {
    const cache = new CodeExecutionCache({
      enabled: true,
      maxEntries: 100,
      ttlSeconds: 60,
      persistence: false,
    });

    const context = { data: [1, 2, 3] };
    const toolVersions = {};

    // Cache first code
    const key1 = generateCacheKey("return 1;", context, toolVersions);
    cache.set(key1, createCacheEntry("return 1;", context, createMockResult(1), toolVersions));

    // Different code should miss
    const key2 = generateCacheKey("return 2;", context, toolVersions);
    const cached = cache.get(key2);
    assertEquals(cached, null, "Different code should miss");

    const stats = cache.getStats();
    assertEquals(stats.misses, 1);
  },
});

Deno.test({
  name: "E2E Cache: Miss on different context",
  fn() {
    const cache = new CodeExecutionCache({
      enabled: true,
      maxEntries: 100,
      ttlSeconds: 60,
      persistence: false,
    });

    const code = "return context.value;";
    const toolVersions = {};

    // Cache with context A
    const key1 = generateCacheKey(code, { value: 1 }, toolVersions);
    cache.set(key1, createCacheEntry(code, { value: 1 }, createMockResult(1), toolVersions));

    // Different context should miss
    const key2 = generateCacheKey(code, { value: 2 }, toolVersions);
    const cached = cache.get(key2);
    assertEquals(cached, null, "Different context should miss");
  },
});

Deno.test({
  name: "E2E Cache: Miss on different tool versions",
  fn() {
    const cache = new CodeExecutionCache({
      enabled: true,
      maxEntries: 100,
      ttlSeconds: 60,
      persistence: false,
    });

    const code = "return 1;";
    const context = {};

    // Cache with tool version 1.0
    const key1 = generateCacheKey(code, context, { tool: "1.0.0" });
    cache.set(key1, createCacheEntry(code, context, createMockResult(1), { tool: "1.0.0" }));

    // Different tool version generates different key (invalidation)
    const key2 = generateCacheKey(code, context, { tool: "2.0.0" });
    const cached = cache.get(key2);
    assertEquals(cached, null, "Different tool version should generate different key");
  },
});

Deno.test({
  name: "E2E Cache: LRU eviction when full",
  fn() {
    const cache = new CodeExecutionCache({
      enabled: true,
      maxEntries: 3, // Small cache for testing
      ttlSeconds: 60,
      persistence: false,
    });

    const context = {};
    const toolVersions = {};

    // Fill cache with 3 entries
    for (let i = 1; i <= 3; i++) {
      const key = generateCacheKey(`return ${i};`, context, toolVersions);
      cache.set(key, createCacheEntry(`return ${i};`, context, createMockResult(i), toolVersions));
    }

    // Add 4th entry - should evict oldest (1)
    const key4 = generateCacheKey("return 4;", context, toolVersions);
    cache.set(key4, createCacheEntry("return 4;", context, createMockResult(4), toolVersions));

    // First entry should be evicted
    const key1 = generateCacheKey("return 1;", context, toolVersions);
    const evicted = cache.get(key1);
    assertEquals(evicted, null, "Oldest entry should be evicted");

    // Newer entries should still exist
    const key3 = generateCacheKey("return 3;", context, toolVersions);
    const entry3 = cache.get(key3);
    assertExists(entry3, "Newer entries should remain");
  },
});

Deno.test({
  name: "E2E Cache: Disabled cache always misses",
  fn() {
    const cache = new CodeExecutionCache({
      enabled: false, // Disabled
      maxEntries: 100,
      ttlSeconds: 60,
      persistence: false,
    });

    const code = "return 1;";
    const context = {};
    const toolVersions = {};
    const key = generateCacheKey(code, context, toolVersions);

    cache.set(key, createCacheEntry(code, context, createMockResult(1), toolVersions));
    const cached = cache.get(key);

    assertEquals(cached, null, "Disabled cache should always miss");
  },
});

Deno.test({
  name: "E2E Cache: Clear removes all entries",
  fn() {
    const cache = new CodeExecutionCache({
      enabled: true,
      maxEntries: 100,
      ttlSeconds: 60,
      persistence: false,
    });

    const context = {};
    const toolVersions = {};

    const key1 = generateCacheKey("return 1;", context, toolVersions);
    const key2 = generateCacheKey("return 2;", context, toolVersions);
    cache.set(key1, createCacheEntry("return 1;", context, createMockResult(1), toolVersions));
    cache.set(key2, createCacheEntry("return 2;", context, createMockResult(2), toolVersions));

    cache.clear();

    const stats = cache.getStats();
    assertEquals(stats.currentEntries, 0, "Cache should be empty after clear");
  },
});

Deno.test({
  name: "E2E Cache: Performance metrics tracked",
  fn() {
    const cache = new CodeExecutionCache({
      enabled: true,
      maxEntries: 100,
      ttlSeconds: 60,
      persistence: false,
    });

    const code = "return 1;";
    const context = {};
    const toolVersions = {};
    const key = generateCacheKey(code, context, toolVersions);
    const result = createMockResult(1);
    result.executionTimeMs = 500; // 500ms execution

    cache.set(key, createCacheEntry(code, context, result, toolVersions));

    // Hit the cache twice
    cache.get(key);
    cache.get(key);

    const stats = cache.getStats();
    assertEquals(stats.hits, 2, "Should have 2 hits");
    assertEquals(stats.totalSavedMs, 1000, "Should track 2x500ms saved");
  },
});
