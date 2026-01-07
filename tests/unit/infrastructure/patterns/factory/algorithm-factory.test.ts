/**
 * AlgorithmFactory Unit Tests
 *
 * Tests for SHGAT and DR-DSP algorithm factory.
 *
 * @module tests/unit/infrastructure/patterns/factory/algorithm-factory
 */

import { assertEquals, assertExists, assertGreater } from "jsr:@std/assert@1";
import {
  AlgorithmFactory,
  type AlgorithmCapabilityInput,
  type DRDSPCapabilityInput,
} from "../../../../../src/infrastructure/patterns/factory/algorithm-factory.ts";

// Helper to create test capabilities
function createTestCapabilities(count: number): AlgorithmCapabilityInput[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `cap-${i}`,
    embedding: Array.from({ length: 1024 }, () => Math.random() - 0.5),
    toolsUsed: [`tool:${i}-a`, `tool:${i}-b`],
    successRate: 0.8 + Math.random() * 0.2,
    children: i > 0 ? [`cap-${i - 1}`] : undefined,
    parents: i < count - 1 ? [`cap-${i + 1}`] : undefined,
  }));
}

function createDRDSPCapabilities(count: number): DRDSPCapabilityInput[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `cap-${i}`,
    toolsUsed: [`tool:${i}-a`, `tool:${i}-b`],
    successRate: 0.8 + Math.random() * 0.2,
  }));
}

Deno.test("AlgorithmFactory - createSHGAT", async (t) => {
  await t.step("creates SHGAT instance with capabilities", async () => {
    const capabilities = createTestCapabilities(5);

    const result = await AlgorithmFactory.createSHGAT(capabilities);

    assertExists(result.shgat);
    assertEquals(result.capabilitiesLoaded, 5);
  });

  await t.step("handles empty capabilities array", async () => {
    const result = await AlgorithmFactory.createSHGAT([]);

    assertExists(result.shgat);
    assertEquals(result.capabilitiesLoaded, 0);
  });

  await t.step("creates SHGAT with co-occurrence option", async () => {
    const capabilities = createTestCapabilities(3);

    const result = await AlgorithmFactory.createSHGAT(capabilities, {
      withCooccurrence: true,
    });

    assertExists(result.shgat);
    // Co-occurrence may or may not load depending on data availability
  });

  await t.step("creates SHGAT with hyperedge cache option", async () => {
    const capabilities = createTestCapabilities(3);

    const result = await AlgorithmFactory.createSHGAT(capabilities, {
      withHyperedgeCache: true,
    });

    assertExists(result.shgat);
    // Hyperedges should be cached if capabilities have tools
    if (capabilities.some((c) => c.toolsUsed.length > 0)) {
      assertExists(result.hyperedgesCached);
    }
  });

  await t.step("preserves capability hierarchy", async () => {
    const capabilities: AlgorithmCapabilityInput[] = [
      {
        id: "parent",
        embedding: Array(1024).fill(0.1),
        toolsUsed: ["tool:a"],
        successRate: 0.9,
        children: ["child"],
      },
      {
        id: "child",
        embedding: Array(1024).fill(0.2),
        toolsUsed: ["tool:b"],
        successRate: 0.85,
        parents: ["parent"],
      },
    ];

    const result = await AlgorithmFactory.createSHGAT(capabilities);

    assertExists(result.shgat);
    assertEquals(result.capabilitiesLoaded, 2);
  });
});

Deno.test("AlgorithmFactory - createEmptySHGAT", async (t) => {
  await t.step("creates empty SHGAT instance", () => {
    const shgat = AlgorithmFactory.createEmptySHGAT();

    assertExists(shgat);
  });

  await t.step("allows dynamic capability registration", () => {
    const shgat = AlgorithmFactory.createEmptySHGAT();

    // Should be able to register capabilities dynamically
    shgat.registerCapability({
      id: "dynamic-cap",
      embedding: Array(1024).fill(0.1),
      members: [{ type: "tool", id: "tool:dynamic" }],
      hierarchyLevel: 0,
      successRate: 1.0,
      toolsUsed: ["tool:dynamic"],
    });

    // Verify registration worked
    const toolIds = shgat.getRegisteredToolIds();
    assertEquals(toolIds.includes("tool:dynamic"), true);
  });
});

Deno.test("AlgorithmFactory - createDRDSP", async (t) => {
  await t.step("creates DR-DSP instance with capabilities", () => {
    const capabilities = createDRDSPCapabilities(5);

    const drdsp = AlgorithmFactory.createDRDSP(capabilities);

    assertExists(drdsp);
  });

  await t.step("handles empty capabilities array", () => {
    const drdsp = AlgorithmFactory.createDRDSP([]);

    assertExists(drdsp);
  });

  await t.step("works without embeddings", () => {
    const capabilities: DRDSPCapabilityInput[] = [
      { id: "cap-1", toolsUsed: ["tool:a", "tool:b"], successRate: 0.9 },
      { id: "cap-2", toolsUsed: ["tool:c"], successRate: 0.8 },
    ];

    const drdsp = AlgorithmFactory.createDRDSP(capabilities);

    assertExists(drdsp);
  });
});

Deno.test("AlgorithmFactory - createBoth", async (t) => {
  await t.step("creates both SHGAT and DR-DSP instances", async () => {
    const capabilities = createTestCapabilities(5);

    const result = await AlgorithmFactory.createBoth(capabilities);

    assertExists(result.shgat);
    assertExists(result.shgat.shgat);
    assertExists(result.drdsp);
    assertEquals(result.shgat.capabilitiesLoaded, 5);
  });

  await t.step("passes options to SHGAT creation", async () => {
    const capabilities = createTestCapabilities(3);

    const result = await AlgorithmFactory.createBoth(capabilities, {
      withCooccurrence: true,
      withHyperedgeCache: true,
    });

    assertExists(result.shgat);
    assertExists(result.drdsp);
  });

  await t.step("handles empty capabilities for both algorithms", async () => {
    const result = await AlgorithmFactory.createBoth([]);

    assertExists(result.shgat);
    assertExists(result.drdsp);
    assertEquals(result.shgat.capabilitiesLoaded, 0);
  });

  await t.step("creates algorithms concurrently", async () => {
    const capabilities = createTestCapabilities(10);

    const startTime = performance.now();
    const result = await AlgorithmFactory.createBoth(capabilities);
    const duration = performance.now() - startTime;

    assertExists(result.shgat);
    assertExists(result.drdsp);

    // Both should complete reasonably fast (concurrent execution)
    assertGreater(5000, duration); // Should complete in under 5 seconds
  });
});

Deno.test("AlgorithmFactory - edge cases", async (t) => {
  await t.step("handles capabilities with special characters in IDs", async () => {
    const capabilities: AlgorithmCapabilityInput[] = [
      {
        id: "cap:special/chars-in_id",
        embedding: Array(1024).fill(0.1),
        toolsUsed: ["tool:with:colons", "tool/with/slashes"],
        successRate: 0.9,
      },
    ];

    const result = await AlgorithmFactory.createSHGAT(capabilities);
    assertExists(result.shgat);
  });

  await t.step("handles capabilities with zero success rate", async () => {
    const capabilities: AlgorithmCapabilityInput[] = [
      {
        id: "failed-cap",
        embedding: Array(1024).fill(0.1),
        toolsUsed: ["tool:a"],
        successRate: 0.0,
      },
    ];

    const result = await AlgorithmFactory.createSHGAT(capabilities);
    assertExists(result.shgat);
  });

  await t.step("handles capabilities with many tools", async () => {
    const manyTools = Array.from({ length: 50 }, (_, i) => `tool:${i}`);
    const capabilities: AlgorithmCapabilityInput[] = [
      {
        id: "many-tools-cap",
        embedding: Array(1024).fill(0.1),
        toolsUsed: manyTools,
        successRate: 0.9,
      },
    ];

    const result = await AlgorithmFactory.createSHGAT(capabilities);
    assertExists(result.shgat);
  });

  await t.step("handles large number of capabilities", async () => {
    const capabilities = createTestCapabilities(100);

    const result = await AlgorithmFactory.createSHGAT(capabilities);

    assertExists(result.shgat);
    assertEquals(result.capabilitiesLoaded, 100);
  });
});
