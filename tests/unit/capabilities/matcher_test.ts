import { assertEquals, assertExists } from "@std/assert";
import { CapabilityMatcher } from "../../../src/capabilities/matcher.ts";
import type { CapabilityStore } from "../../../src/capabilities/capability-store.ts";
import type { AdaptiveThresholdManager } from "../../../src/mcp/adaptive-threshold.ts";
import type { Capability, CapabilitySearchResult } from "../../../src/capabilities/types.ts";

// Simple mocks
class MockCapabilityStore {
  private capabilities: CapabilitySearchResult[] = [];

  setSearchResults(results: CapabilitySearchResult[]) {
    this.capabilities = results;
  }

  async searchByIntent(_intent: string, _limit?: number): Promise<CapabilitySearchResult[]> {
    return this.capabilities;
  }
}

class MockAdaptiveThresholdManager {
  private thresholds = { suggestionThreshold: 0.70, explicitThreshold: 0.50 };

  setThresholds(t: { suggestionThreshold: number; explicitThreshold: number }) {
    this.thresholds = t;
  }

  getThresholds() {
    return this.thresholds;
  }
}

// Helper to create dummy capabilities
function createCap(id: string, successRate: number): Capability {
  return {
    id,
    codeSnippet: "console.log('test')",
    codeHash: "hash",
    intentEmbedding: new Float32Array([]),
    parametersSchema: {},
    cacheConfig: { ttl_ms: 1000, cacheable: true },
    usageCount: 10,
    successCount: Math.floor(10 * successRate),
    successRate,
    avgDurationMs: 100,
    createdAt: new Date(),
    lastUsed: new Date(),
    source: "emergent",
  };
}

Deno.test("CapabilityMatcher - finds match above threshold", async () => {
  const store = new MockCapabilityStore() as unknown as CapabilityStore;
  const thresholds = new MockAdaptiveThresholdManager() as unknown as AdaptiveThresholdManager;
  const matcher = new CapabilityMatcher(store, thresholds);

  // Setup: Cap with 0.9 semantic, 1.0 reliability
  // Score = 0.9 * 1.2 (boost) = 1.08 (capped at 0.95)
  const cap = createCap("cap-1", 1.0);
  (store as any).setSearchResults([{ capability: cap, semanticScore: 0.9 }]);

  const match = await matcher.findMatch("test intent");

  assertExists(match);
  assertEquals(match?.capability.id, "cap-1");
  assertEquals(match?.score, 0.95, "Score should be capped at 0.95");
  assertEquals(match?.thresholdUsed, 0.70);
});

Deno.test("CapabilityMatcher - rejects match below threshold", async () => {
  const store = new MockCapabilityStore() as unknown as CapabilityStore;
  const thresholds = new MockAdaptiveThresholdManager() as unknown as AdaptiveThresholdManager;
  const matcher = new CapabilityMatcher(store, thresholds);

  // Setup: Cap with 0.6 semantic, 1.0 reliability
  // Score = 0.6 * 1.2 = 0.72
  // Threshold = 0.80
  (thresholds as any).setThresholds({ suggestionThreshold: 0.80, explicitThreshold: 0.50 });

  const cap = createCap("cap-1", 1.0);
  (store as any).setSearchResults([{ capability: cap, semanticScore: 0.6 }]);

  const match = await matcher.findMatch("test intent");

  assertEquals(match, null);
});

Deno.test("CapabilityMatcher - penalizes low reliability", async () => {
  const store = new MockCapabilityStore() as unknown as CapabilityStore;
  const thresholds = new MockAdaptiveThresholdManager() as unknown as AdaptiveThresholdManager;
  const matcher = new CapabilityMatcher(store, thresholds);

  // Setup: Cap with 0.9 semantic, but 0.4 reliability
  // Score = 0.9 * 0.1 (penalty) = 0.09
  // Threshold = 0.70
  const cap = createCap("cap-bad", 0.4);
  (store as any).setSearchResults([{ capability: cap, semanticScore: 0.9 }]);

  const match = await matcher.findMatch("test intent");

  assertEquals(match, null, "Should reject high semantic match if reliability is low");
});
