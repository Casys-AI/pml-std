/**
 * SHGAT Level Parameters Tests
 *
 * Tests for multi-level parameter initialization and counting.
 *
 * @module tests/unit/graphrag/shgat/level-params_test
 */

import { assertEquals, assertExists, assertThrows } from "@std/assert";
import {
  countLevelParameters,
  exportLevelParams,
  getAdaptiveHeadsByGraphSize,
  getLevelParams,
  importLevelParams,
  initializeLevelParameters,
} from "../../../../src/graphrag/algorithms/shgat/initialization/index.ts";
import type { SHGATConfig } from "../../../../src/graphrag/algorithms/shgat/types.ts";
import { DEFAULT_SHGAT_CONFIG } from "../../../../src/graphrag/algorithms/shgat/types.ts";

Deno.test("initializeLevelParameters - creates params for all levels", () => {
  const config: SHGATConfig = { ...DEFAULT_SHGAT_CONFIG, numHeads: 4, hiddenDim: 64 };
  const maxLevel = 2;

  const levelParams = initializeLevelParameters(config, maxLevel);

  assertEquals(levelParams.size, 3, "Should have params for levels 0, 1, 2");

  for (let level = 0; level <= maxLevel; level++) {
    const params = levelParams.get(level);
    assertExists(params, `Params should exist for level ${level}`);
    assertEquals(params.W_child.length, config.numHeads, "W_child should have numHeads");
    assertEquals(params.W_parent.length, config.numHeads, "W_parent should have numHeads");
    assertEquals(params.a_upward.length, config.numHeads, "a_upward should have numHeads");
    assertEquals(params.a_downward.length, config.numHeads, "a_downward should have numHeads");
  }
});

Deno.test("initializeLevelParameters - dimensions are correct", () => {
  const config: SHGATConfig = {
    ...DEFAULT_SHGAT_CONFIG,
    numHeads: 4,
    hiddenDim: 64,
    embeddingDim: 1024,
  };
  const maxLevel = 1;
  const headDim = Math.floor(config.hiddenDim / config.numHeads); // 16

  const levelParams = initializeLevelParameters(config, maxLevel);

  // Level 0: input is embeddingDim
  const level0 = levelParams.get(0)!;
  assertEquals(level0.W_child[0].length, headDim, "W_child[0] rows should be headDim");
  assertEquals(
    level0.W_child[0][0].length,
    config.embeddingDim,
    "W_child[0] cols should be embDim",
  );
  assertEquals(level0.a_upward[0].length, 2 * headDim, "a_upward should be 2*headDim");

  // Level 1: input is numHeads * headDim
  const level1 = levelParams.get(1)!;
  assertEquals(
    level1.W_child[0][0].length,
    config.numHeads * headDim,
    "Level 1 W_child cols should be numHeads*headDim",
  );
});

Deno.test("countLevelParameters - matches formula", () => {
  const config: SHGATConfig = {
    ...DEFAULT_SHGAT_CONFIG,
    numHeads: 4,
    hiddenDim: 64,
    embeddingDim: 1024,
  };
  const maxLevel = 2;
  const headDim = Math.floor(config.hiddenDim / config.numHeads); // 16

  const count = countLevelParameters(config, maxLevel);

  // Manual calculation based on formula in 05-parameters.md:
  // Per level k: K × (2·headDim·inputDim + 4·headDim)
  // Level 0: inputDim = embDim = 1024
  // Level k>0: inputDim = numHeads * headDim = 64

  // Level 0: 4 × (2×16×1024 + 4×16) = 4 × (32768 + 64) = 131328
  const level0Params = config.numHeads * (2 * headDim * config.embeddingDim + 4 * headDim);

  // Level 1 & 2: 4 × (2×16×64 + 4×16) = 4 × (2048 + 64) = 8448 each
  const levelKParams = config.numHeads * (2 * headDim * (config.numHeads * headDim) + 4 * headDim);

  const expected = level0Params + 2 * levelKParams;
  assertEquals(count, expected, `Count should match formula: ${expected}`);
});

Deno.test("getLevelParams - returns correct params", () => {
  const config: SHGATConfig = { ...DEFAULT_SHGAT_CONFIG };
  const maxLevel = 1;

  const levelParams = initializeLevelParameters(config, maxLevel);

  const level0 = getLevelParams(levelParams, 0);
  assertExists(level0.W_child);

  const level1 = getLevelParams(levelParams, 1);
  assertExists(level1.W_parent);
});

Deno.test("getLevelParams - throws for invalid level", () => {
  const config: SHGATConfig = { ...DEFAULT_SHGAT_CONFIG };
  const maxLevel = 1;

  const levelParams = initializeLevelParameters(config, maxLevel);

  assertThrows(
    () => getLevelParams(levelParams, 5),
    Error,
    "LevelParams not found for level 5",
  );
});

Deno.test("exportLevelParams/importLevelParams - round trip", () => {
  const config: SHGATConfig = { ...DEFAULT_SHGAT_CONFIG };
  const maxLevel = 2;

  const original = initializeLevelParameters(config, maxLevel);
  const exported = exportLevelParams(original);
  const imported = importLevelParams(exported);

  assertEquals(imported.size, original.size, "Should have same number of levels");

  for (const [level, params] of original) {
    const importedParams = imported.get(level)!;
    assertEquals(
      importedParams.W_child.length,
      params.W_child.length,
      `Level ${level} W_child should match`,
    );
    assertEquals(
      importedParams.a_upward[0][0],
      params.a_upward[0][0],
      `Level ${level} a_upward values should match`,
    );
  }
});

Deno.test("getAdaptiveHeadsByGraphSize - scales with graph size", () => {
  // Small graph
  const small = getAdaptiveHeadsByGraphSize(10, 5, 0);
  assertEquals(small.numHeads, 4, "Small graph should have 4 heads");

  // Medium graph
  const medium = getAdaptiveHeadsByGraphSize(100, 50, 0);
  assertEquals(medium.numHeads, 6, "Medium graph should have 6 heads");

  // Large graph
  const large = getAdaptiveHeadsByGraphSize(300, 100, 0);
  assertEquals(large.numHeads, 8, "Large graph should have 8 heads");

  // Very large graph
  const veryLarge = getAdaptiveHeadsByGraphSize(600, 300, 0);
  assertEquals(veryLarge.numHeads, 12, "Very large graph should have 12 heads");
});

Deno.test("getAdaptiveHeadsByGraphSize - increases for deep hierarchies", () => {
  const shallow = getAdaptiveHeadsByGraphSize(100, 50, 0);
  const deep = getAdaptiveHeadsByGraphSize(100, 50, 2);

  assertEquals(deep.numHeads > shallow.numHeads, true, "Deep hierarchy should have more heads");
});

Deno.test("getAdaptiveHeadsByGraphSize - numHeads is always even", () => {
  // Test various sizes to ensure numHeads is always even
  for (let tools = 10; tools < 1500; tools += 100) {
    for (let levels = 0; levels <= 3; levels++) {
      const result = getAdaptiveHeadsByGraphSize(tools, 10, levels);
      assertEquals(
        result.numHeads % 2,
        0,
        `numHeads should be even for ${tools} tools, level ${levels}`,
      );
    }
  }
});

Deno.test("getAdaptiveHeadsByGraphSize - hiddenDim = numHeads * headDim", () => {
  const result = getAdaptiveHeadsByGraphSize(200, 100, 1);
  assertEquals(
    result.hiddenDim,
    result.numHeads * result.headDim,
    "hiddenDim should equal numHeads * headDim",
  );
});
