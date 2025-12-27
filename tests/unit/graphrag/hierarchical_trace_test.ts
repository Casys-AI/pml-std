/**
 * ADR-041: Hierarchical Trace Tracking Tests
 *
 * Tests for parent_trace_id propagation and hierarchical edge creation.
 */

import { assertEquals, assertExists } from "@std/assert";
import type { TraceEvent } from "../../../src/sandbox/types.ts";

// Mock GraphRAGEngine for testing updateFromCodeExecution
// This is a simplified version that focuses on edge creation logic

Deno.test("ADR-041: updateFromCodeExecution creates 'contains' edges for parent-child", () => {
  // Simulated traces: capability cap1 contains tool read_file
  const traces: TraceEvent[] = [
    {
      type: "capability_start",
      capability: "analyze_file",
      capabilityId: "cap-uuid-1",
      traceId: "trace-cap1",
      ts: 1000,
    },
    {
      type: "tool_start",
      tool: "filesystem:read_file",
      traceId: "trace-tool1",
      ts: 1100,
      parentTraceId: "trace-cap1", // ADR-041: Parent is capability
    },
    {
      type: "tool_end",
      tool: "filesystem:read_file",
      traceId: "trace-tool1",
      ts: 1200,
      success: true,
      durationMs: 100,
      parentTraceId: "trace-cap1",
    },
    {
      type: "capability_end",
      capability: "analyze_file",
      capabilityId: "cap-uuid-1",
      traceId: "trace-cap1",
      ts: 1300,
      success: true,
      durationMs: 300,
    },
  ];

  // Build hierarchy map (simulating updateFromCodeExecution logic)
  const traceToNode = new Map<string, string>();
  const parentToChildren = new Map<string, string[]>();

  for (const trace of traces) {
    if (trace.type !== "tool_end" && trace.type !== "capability_end") continue;

    const nodeId = trace.type === "tool_end"
      ? (trace as { tool: string }).tool
      : `capability:${(trace as { capabilityId: string }).capabilityId}`;

    traceToNode.set(trace.traceId, nodeId);

    const parent_trace_id = trace.parentTraceId;
    if (parent_trace_id) {
      if (!parentToChildren.has(parent_trace_id)) {
        parentToChildren.set(parent_trace_id, []);
      }
      parentToChildren.get(parent_trace_id)!.push(nodeId);
    }
  }

  // Verify hierarchy was built correctly
  assertEquals(traceToNode.get("trace-cap1"), "capability:cap-uuid-1");
  assertEquals(traceToNode.get("trace-tool1"), "filesystem:read_file");

  // Verify parent-child relationship
  const children = parentToChildren.get("trace-cap1");
  assertExists(children);
  assertEquals(children.includes("filesystem:read_file"), true);
});

Deno.test("ADR-041: nested capabilities have correct parent_trace_id", () => {
  // Simulated traces: outerCap → innerCap → tool
  const traces: TraceEvent[] = [
    {
      type: "capability_start",
      capability: "outer_cap",
      capabilityId: "outer-uuid",
      traceId: "trace-outer",
      ts: 1000,
    },
    {
      type: "capability_start",
      capability: "inner_cap",
      capabilityId: "inner-uuid",
      traceId: "trace-inner",
      ts: 1100,
      parentTraceId: "trace-outer", // Nested capability
    },
    {
      type: "tool_start",
      tool: "memory:store",
      traceId: "trace-tool",
      ts: 1200,
      parentTraceId: "trace-inner", // Tool inside inner capability
    },
    {
      type: "tool_end",
      tool: "memory:store",
      traceId: "trace-tool",
      ts: 1300,
      success: true,
      durationMs: 100,
      parentTraceId: "trace-inner",
    },
    {
      type: "capability_end",
      capability: "inner_cap",
      capabilityId: "inner-uuid",
      traceId: "trace-inner",
      ts: 1400,
      success: true,
      durationMs: 300,
      parentTraceId: "trace-outer",
    },
    {
      type: "capability_end",
      capability: "outer_cap",
      capabilityId: "outer-uuid",
      traceId: "trace-outer",
      ts: 1500,
      success: true,
      durationMs: 500,
    },
  ];

  // Build hierarchy
  const parentToChildren = new Map<string, string[]>();

  for (const trace of traces) {
    if (trace.type !== "tool_end" && trace.type !== "capability_end") continue;

    const nodeId = trace.type === "tool_end"
      ? (trace as { tool: string }).tool
      : `capability:${(trace as { capabilityId: string }).capabilityId}`;

    const parent_trace_id = trace.parentTraceId;
    if (parent_trace_id) {
      if (!parentToChildren.has(parent_trace_id)) {
        parentToChildren.set(parent_trace_id, []);
      }
      parentToChildren.get(parent_trace_id)!.push(nodeId);
    }
  }

  // Verify: outer contains inner
  const outerChildren = parentToChildren.get("trace-outer");
  assertExists(outerChildren);
  assertEquals(outerChildren.includes("capability:inner-uuid"), true);

  // Verify: inner contains tool
  const innerChildren = parentToChildren.get("trace-inner");
  assertExists(innerChildren);
  assertEquals(innerChildren.includes("memory:store"), true);

  // Verify: outer does NOT directly contain tool
  assertEquals(outerChildren.includes("memory:store"), false);
});

Deno.test("ADR-041: sequence edges only between siblings", () => {
  // Simulated traces: cap1 contains (tool1, tool2, tool3) - siblings
  const traces: TraceEvent[] = [
    {
      type: "capability_start",
      capability: "multi_tool_cap",
      capabilityId: "cap-uuid",
      traceId: "trace-cap",
      ts: 1000,
    },
    // Tool 1
    {
      type: "tool_start",
      tool: "fs:read",
      traceId: "trace-t1",
      ts: 1100,
      parentTraceId: "trace-cap",
    },
    {
      type: "tool_end",
      tool: "fs:read",
      traceId: "trace-t1",
      ts: 1150,
      success: true,
      durationMs: 50,
      parentTraceId: "trace-cap",
    },
    // Tool 2
    {
      type: "tool_start",
      tool: "fs:write",
      traceId: "trace-t2",
      ts: 1200,
      parentTraceId: "trace-cap",
    },
    {
      type: "tool_end",
      tool: "fs:write",
      traceId: "trace-t2",
      ts: 1250,
      success: true,
      durationMs: 50,
      parentTraceId: "trace-cap",
    },
    // Tool 3
    {
      type: "tool_start",
      tool: "fs:delete",
      traceId: "trace-t3",
      ts: 1300,
      parentTraceId: "trace-cap",
    },
    {
      type: "tool_end",
      tool: "fs:delete",
      traceId: "trace-t3",
      ts: 1350,
      success: true,
      durationMs: 50,
      parentTraceId: "trace-cap",
    },
    {
      type: "capability_end",
      capability: "multi_tool_cap",
      capabilityId: "cap-uuid",
      traceId: "trace-cap",
      ts: 1400,
      success: true,
      durationMs: 400,
    },
  ];

  // Build sibling list per parent
  const parentToChildren = new Map<string, string[]>();

  for (const trace of traces) {
    if (trace.type !== "tool_end" && trace.type !== "capability_end") continue;

    const nodeId = trace.type === "tool_end"
      ? (trace as { tool: string }).tool
      : `capability:${(trace as { capabilityId: string }).capabilityId}`;

    const parent_trace_id = trace.parentTraceId;
    if (parent_trace_id) {
      if (!parentToChildren.has(parent_trace_id)) {
        parentToChildren.set(parent_trace_id, []);
      }
      parentToChildren.get(parent_trace_id)!.push(nodeId);
    }
  }

  // Get siblings (tools with same parent)
  const siblings = parentToChildren.get("trace-cap");
  assertExists(siblings);
  assertEquals(siblings.length, 3);
  assertEquals(siblings, ["fs:read", "fs:write", "fs:delete"]);

  // Sequence edges would be: read→write, write→delete
  // (NOT read→delete, because they're not consecutive)
  const sequenceEdges: Array<[string, string]> = [];
  for (let i = 0; i < siblings.length - 1; i++) {
    sequenceEdges.push([siblings[i], siblings[i + 1]]);
  }

  assertEquals(sequenceEdges.length, 2);
  assertEquals(sequenceEdges[0], ["fs:read", "fs:write"]);
  assertEquals(sequenceEdges[1], ["fs:write", "fs:delete"]);
});

Deno.test("ADR-041: backward compat - traces without parent_trace_id create sequence edges", () => {
  // Simulated traces: legacy tools without parent_trace_id
  const traces: TraceEvent[] = [
    {
      type: "tool_start",
      tool: "fs:read",
      traceId: "t1",
      ts: 1000,
      // No parent_trace_id (legacy)
    },
    {
      type: "tool_end",
      tool: "fs:read",
      traceId: "t1",
      ts: 1100,
      success: true,
      durationMs: 100,
    },
    {
      type: "tool_start",
      tool: "fs:write",
      traceId: "t2",
      ts: 1200,
    },
    {
      type: "tool_end",
      tool: "fs:write",
      traceId: "t2",
      ts: 1300,
      success: true,
      durationMs: 100,
    },
  ];

  // Filter top-level traces (no parent)
  const topLevelEndEvents = traces.filter((t) =>
    (t.type === "tool_end" || t.type === "capability_end") && !t.parentTraceId
  );

  assertEquals(topLevelEndEvents.length, 2);

  // Sequence edges between consecutive top-level events
  const sequenceEdges: Array<[string, string]> = [];
  for (let i = 0; i < topLevelEndEvents.length - 1; i++) {
    const from = topLevelEndEvents[i];
    const to = topLevelEndEvents[i + 1];
    const fromId = (from as { tool: string }).tool;
    const toId = (to as { tool: string }).tool;
    sequenceEdges.push([fromId, toId]);
  }

  assertEquals(sequenceEdges.length, 1);
  assertEquals(sequenceEdges[0], ["fs:read", "fs:write"]);
});

Deno.test("ADR-041: edge weights are correctly computed", () => {
  // Edge type weights
  const EDGE_TYPE_WEIGHTS: Record<string, number> = {
    dependency: 1.0,
    contains: 0.8,
    sequence: 0.5,
  };

  // Edge source modifiers
  const EDGE_SOURCE_MODIFIERS: Record<string, number> = {
    observed: 1.0,
    inferred: 0.7,
    template: 0.5,
  };

  // Test combined weights
  const getEdgeWeight = (edgeType: string, edgeSource: string): number => {
    const typeWeight = EDGE_TYPE_WEIGHTS[edgeType] || 0.5;
    const sourceModifier = EDGE_SOURCE_MODIFIERS[edgeSource] || 0.7;
    return typeWeight * sourceModifier;
  };

  // dependency + observed = 1.0 × 1.0 = 1.0 (highest)
  assertEquals(getEdgeWeight("dependency", "observed"), 1.0);

  // contains + observed = 0.8 × 1.0 = 0.8
  assertEquals(getEdgeWeight("contains", "observed"), 0.8);

  // sequence + inferred = 0.5 × 0.7 = 0.35
  assertEquals(getEdgeWeight("sequence", "inferred"), 0.35);

  // sequence + template = 0.5 × 0.5 = 0.25 (lowest)
  assertEquals(getEdgeWeight("sequence", "template"), 0.25);
});

Deno.test("ADR-041: edge_source upgrades from 'inferred' to 'observed' at threshold", () => {
  const OBSERVED_THRESHOLD = 3;

  // Simulate edge observation counts
  let observedCount = 1;
  let edgeSource = "inferred";

  // First observation - stays inferred
  assertEquals(edgeSource, "inferred");

  // Second observation
  observedCount++;
  if (observedCount >= OBSERVED_THRESHOLD && edgeSource === "inferred") {
    edgeSource = "observed";
  }
  assertEquals(edgeSource, "inferred"); // Still 2 < 3

  // Third observation - upgrades to observed
  observedCount++;
  if (observedCount >= OBSERVED_THRESHOLD && edgeSource === "inferred") {
    edgeSource = "observed";
  }
  assertEquals(edgeSource, "observed"); // Now 3 >= 3
  assertEquals(observedCount, 3);
});

// ============================================
// Integration-style tests (simulating GraphRAGEngine behavior)
// ============================================

Deno.test("ADR-041: integration - createOrUpdateEdge logic with weight calculation", () => {
  // Simulate the createOrUpdateEdge behavior from GraphRAGEngine
  const EDGE_TYPE_WEIGHTS: Record<string, number> = {
    dependency: 1.0,
    contains: 0.8,
    sequence: 0.5,
  };

  const EDGE_SOURCE_MODIFIERS: Record<string, number> = {
    observed: 1.0,
    inferred: 0.7,
    template: 0.5,
  };

  const OBSERVED_THRESHOLD = 3;

  // Simulated in-memory graph edge store
  const edges = new Map<
    string,
    { count: number; weight: number; edge_type: string; edge_source: string }
  >();

  function createOrUpdateEdge(
    fromId: string,
    toId: string,
    edgeType: "contains" | "sequence" | "dependency",
  ): "created" | "updated" {
    const key = `${fromId}->${toId}`;
    const baseWeight = EDGE_TYPE_WEIGHTS[edgeType];

    if (edges.has(key)) {
      const edge = edges.get(key)!;
      const newCount = edge.count + 1;

      // Upgrade source if threshold reached
      let newSource = edge.edge_source;
      if (newCount >= OBSERVED_THRESHOLD && newSource === "inferred") {
        newSource = "observed";
      }

      const sourceModifier = EDGE_SOURCE_MODIFIERS[newSource];
      const newWeight = baseWeight * sourceModifier;

      edges.set(key, {
        count: newCount,
        weight: newWeight,
        edge_type: edgeType,
        edge_source: newSource,
      });

      return "updated";
    } else {
      // New edge starts as 'inferred'
      const sourceModifier = EDGE_SOURCE_MODIFIERS["inferred"];
      const weight = baseWeight * sourceModifier;

      edges.set(key, {
        count: 1,
        weight: weight,
        edge_type: edgeType,
        edge_source: "inferred",
      });

      return "created";
    }
  }

  // Test: Create new contains edge
  const result1 = createOrUpdateEdge("cap:analyze", "fs:read_file", "contains");
  assertEquals(result1, "created");
  const edge1 = edges.get("cap:analyze->fs:read_file")!;
  assertEquals(edge1.edge_type, "contains");
  assertEquals(edge1.edge_source, "inferred");
  assertEquals(edge1.weight, 0.8 * 0.7); // contains * inferred = 0.56
  assertEquals(edge1.count, 1);

  // Test: Update same edge twice more (total 3) - should upgrade to observed
  createOrUpdateEdge("cap:analyze", "fs:read_file", "contains");
  const result3 = createOrUpdateEdge("cap:analyze", "fs:read_file", "contains");
  assertEquals(result3, "updated");
  const edge3 = edges.get("cap:analyze->fs:read_file")!;
  assertEquals(edge3.edge_source, "observed"); // Upgraded!
  assertEquals(edge3.weight, 0.8 * 1.0); // contains * observed = 0.8
  assertEquals(edge3.count, 3);

  // Test: Sequence edge has lower weight
  createOrUpdateEdge("fs:read_file", "fs:write_file", "sequence");
  const seqEdge = edges.get("fs:read_file->fs:write_file")!;
  assertEquals(seqEdge.weight, 0.5 * 0.7); // sequence * inferred = 0.35
});

Deno.test("ADR-041: integration - Dijkstra cost inversion for path finding", () => {
  // Simulate the cost function used in findShortestPath
  // cost = 1 / weight means higher weight = lower cost = preferred path
  //
  // Graph structure:
  // A --0.8--> B --0.8--> D (contains + observed path)
  // A --0.35-> C --0.25-> D (sequence + inferred/template path)

  function getCost(weight: number): number {
    return 1 / Math.max(weight, 0.1);
  }

  // Path A→B→D has total cost: 1/0.8 + 1/0.8 = 1.25 + 1.25 = 2.5
  const pathABD = getCost(0.8) + getCost(0.8);
  assertEquals(pathABD, 2.5);

  // Path A→C→D has total cost: 1/0.35 + 1/0.25 = 2.86 + 4.0 = 6.86
  const pathACD = getCost(0.35) + getCost(0.25);
  assertEquals(Math.round(pathACD * 100) / 100, 6.86);

  // A→B→D should be preferred (lower cost)
  assertEquals(pathABD < pathACD, true);
});
