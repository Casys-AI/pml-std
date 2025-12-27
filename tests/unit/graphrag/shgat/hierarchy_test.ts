/**
 * SHGAT Hierarchy Computation Tests
 *
 * Tests for Phase 9: Hierarchy level computation and cycle detection.
 *
 * @module tests/unit/graphrag/shgat/hierarchy_test
 * @see 02-hierarchy-computation.md, 09-testing.md
 */

import { assertEquals, assertThrows } from "@std/assert";
import {
  computeHierarchyLevels,
  getCapabilitiesAtLevel,
  getSortedLevels,
  HierarchyCycleError,
  validateAcyclic,
} from "../../../../src/graphrag/algorithms/shgat/graph/hierarchy.ts";
import type { CapabilityNode } from "../../../../src/graphrag/algorithms/shgat/types.ts";

// Helper to create a minimal capability node
function createCap(
  id: string,
  toolIds: string[] = [],
  childCapIds: string[] = [],
): CapabilityNode {
  return {
    id,
    embedding: new Array(1024).fill(0),
    members: [
      ...toolIds.map((t) => ({ type: "tool" as const, id: t })),
      ...childCapIds.map((c) => ({ type: "capability" as const, id: c })),
    ],
    hierarchyLevel: 0,
    successRate: 0.8,
  };
}

Deno.test("computeHierarchyLevels - leaf capabilities (tools only) are level 0", () => {
  const caps = new Map<string, CapabilityNode>();
  caps.set("cap-a", createCap("cap-a", ["tool-1", "tool-2"]));
  caps.set("cap-b", createCap("cap-b", ["tool-3"]));

  const result = computeHierarchyLevels(caps);

  assertEquals(result.maxHierarchyLevel, 0, "Max level should be 0");
  assertEquals(result.capabilities.get("cap-a")!.hierarchyLevel, 0);
  assertEquals(result.capabilities.get("cap-b")!.hierarchyLevel, 0);
  assertEquals(result.hierarchyLevels.get(0)?.size, 2);
});

Deno.test("computeHierarchyLevels - parent is level 1, children are level 0", () => {
  const caps = new Map<string, CapabilityNode>();
  // child contains only tools
  caps.set("child-1", createCap("child-1", ["tool-a"]));
  caps.set("child-2", createCap("child-2", ["tool-b"]));
  // parent contains both tools and child capabilities
  caps.set("parent", createCap("parent", ["tool-c"], ["child-1", "child-2"]));

  const result = computeHierarchyLevels(caps);

  assertEquals(result.maxHierarchyLevel, 1, "Max level should be 1");
  assertEquals(result.capabilities.get("child-1")!.hierarchyLevel, 0);
  assertEquals(result.capabilities.get("child-2")!.hierarchyLevel, 0);
  assertEquals(result.capabilities.get("parent")!.hierarchyLevel, 1);
});

Deno.test("computeHierarchyLevels - 3-level hierarchy", () => {
  const caps = new Map<string, CapabilityNode>();
  // Level 0: leaf capabilities
  caps.set("leaf-1", createCap("leaf-1", ["tool-1"]));
  caps.set("leaf-2", createCap("leaf-2", ["tool-2"]));
  // Level 1: contains leaf capabilities
  caps.set("mid-1", createCap("mid-1", [], ["leaf-1"]));
  caps.set("mid-2", createCap("mid-2", [], ["leaf-2"]));
  // Level 2: contains level 1 capabilities
  caps.set("root", createCap("root", [], ["mid-1", "mid-2"]));

  const result = computeHierarchyLevels(caps);

  assertEquals(result.maxHierarchyLevel, 2, "Max level should be 2");
  assertEquals(result.capabilities.get("leaf-1")!.hierarchyLevel, 0);
  assertEquals(result.capabilities.get("leaf-2")!.hierarchyLevel, 0);
  assertEquals(result.capabilities.get("mid-1")!.hierarchyLevel, 1);
  assertEquals(result.capabilities.get("mid-2")!.hierarchyLevel, 1);
  assertEquals(result.capabilities.get("root")!.hierarchyLevel, 2);
});

Deno.test("computeHierarchyLevels - diamond pattern (shared child)", () => {
  const caps = new Map<string, CapabilityNode>();
  // Leaf shared by two parents
  caps.set("shared", createCap("shared", ["tool-1"]));
  // Two parents at level 1
  caps.set("parent-a", createCap("parent-a", [], ["shared"]));
  caps.set("parent-b", createCap("parent-b", [], ["shared"]));
  // Root at level 2
  caps.set("root", createCap("root", [], ["parent-a", "parent-b"]));

  const result = computeHierarchyLevels(caps);

  assertEquals(result.maxHierarchyLevel, 2);
  assertEquals(result.capabilities.get("shared")!.hierarchyLevel, 0);
  assertEquals(result.capabilities.get("parent-a")!.hierarchyLevel, 1);
  assertEquals(result.capabilities.get("parent-b")!.hierarchyLevel, 1);
  assertEquals(result.capabilities.get("root")!.hierarchyLevel, 2);
});

// ============================================================================
// Cycle Detection Tests
// ============================================================================

Deno.test("computeHierarchyLevels - detects simple cycle A→B→A", () => {
  const caps = new Map<string, CapabilityNode>();
  caps.set("cap-a", createCap("cap-a", [], ["cap-b"]));
  caps.set("cap-b", createCap("cap-b", [], ["cap-a"]));

  assertThrows(
    () => computeHierarchyLevels(caps),
    HierarchyCycleError,
    "Cycle detected",
  );
});

Deno.test("computeHierarchyLevels - detects self-loop A→A", () => {
  const caps = new Map<string, CapabilityNode>();
  caps.set("cap-a", createCap("cap-a", [], ["cap-a"]));

  assertThrows(
    () => computeHierarchyLevels(caps),
    HierarchyCycleError,
    "Cycle detected",
  );
});

Deno.test("computeHierarchyLevels - detects longer cycle A→B→C→A", () => {
  const caps = new Map<string, CapabilityNode>();
  caps.set("cap-a", createCap("cap-a", [], ["cap-b"]));
  caps.set("cap-b", createCap("cap-b", [], ["cap-c"]));
  caps.set("cap-c", createCap("cap-c", [], ["cap-a"]));

  assertThrows(
    () => computeHierarchyLevels(caps),
    HierarchyCycleError,
    "Cycle detected",
  );
});

Deno.test("HierarchyCycleError - includes path information", () => {
  const caps = new Map<string, CapabilityNode>();
  caps.set("cap-a", createCap("cap-a", [], ["cap-b"]));
  caps.set("cap-b", createCap("cap-b", [], ["cap-a"]));

  try {
    computeHierarchyLevels(caps);
  } catch (e) {
    if (e instanceof HierarchyCycleError) {
      assertEquals(e.path.length > 0, true, "Path should not be empty");
    }
  }
});

Deno.test("validateAcyclic - returns true for valid DAG", () => {
  const caps = new Map<string, CapabilityNode>();
  caps.set("leaf", createCap("leaf", ["tool-1"]));
  caps.set("parent", createCap("parent", [], ["leaf"]));

  assertEquals(validateAcyclic(caps), true);
});

Deno.test("validateAcyclic - throws for cycle", () => {
  const caps = new Map<string, CapabilityNode>();
  caps.set("cap-a", createCap("cap-a", [], ["cap-b"]));
  caps.set("cap-b", createCap("cap-b", [], ["cap-a"]));

  assertThrows(() => validateAcyclic(caps), HierarchyCycleError);
});

// ============================================================================
// Helper Function Tests
// ============================================================================

Deno.test("getCapabilitiesAtLevel - returns correct capabilities", () => {
  const caps = new Map<string, CapabilityNode>();
  caps.set("leaf-1", createCap("leaf-1", ["tool-1"]));
  caps.set("leaf-2", createCap("leaf-2", ["tool-2"]));
  caps.set("parent", createCap("parent", [], ["leaf-1"]));

  const result = computeHierarchyLevels(caps);

  const level0 = getCapabilitiesAtLevel(result.hierarchyLevels, 0);
  assertEquals(level0.has("leaf-1"), true);
  assertEquals(level0.has("leaf-2"), true);
  assertEquals(level0.has("parent"), false);

  const level1 = getCapabilitiesAtLevel(result.hierarchyLevels, 1);
  assertEquals(level1.has("parent"), true);
});

Deno.test("getCapabilitiesAtLevel - returns empty set for non-existent level", () => {
  const caps = new Map<string, CapabilityNode>();
  caps.set("leaf", createCap("leaf", ["tool-1"]));

  const result = computeHierarchyLevels(caps);

  const level5 = getCapabilitiesAtLevel(result.hierarchyLevels, 5);
  assertEquals(level5.size, 0);
});

Deno.test("getSortedLevels - returns levels in ascending order", () => {
  const caps = new Map<string, CapabilityNode>();
  caps.set("l0", createCap("l0", ["tool-1"]));
  caps.set("l1", createCap("l1", [], ["l0"]));
  caps.set("l2", createCap("l2", [], ["l1"]));

  const result = computeHierarchyLevels(caps);
  const sortedLevels = getSortedLevels(result.hierarchyLevels);

  assertEquals(sortedLevels, [0, 1, 2]);
});

// ============================================================================
// Edge Cases
// ============================================================================

Deno.test("computeHierarchyLevels - handles empty map", () => {
  const caps = new Map<string, CapabilityNode>();
  const result = computeHierarchyLevels(caps);

  assertEquals(result.maxHierarchyLevel, 0);
  assertEquals(result.hierarchyLevels.size, 0);
});

Deno.test("computeHierarchyLevels - handles single capability with no tools", () => {
  const caps = new Map<string, CapabilityNode>();
  caps.set("empty", createCap("empty", []));

  const result = computeHierarchyLevels(caps);

  assertEquals(result.maxHierarchyLevel, 0);
  assertEquals(result.capabilities.get("empty")!.hierarchyLevel, 0);
});

Deno.test("computeHierarchyLevels - throws for missing child reference", () => {
  const caps = new Map<string, CapabilityNode>();
  caps.set("parent", createCap("parent", [], ["non-existent-child"]));

  assertThrows(
    () => computeHierarchyLevels(caps),
    Error,
    "Unknown capability",
  );
});
