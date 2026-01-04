/**
 * Unit tests for HypergraphBuilder (Story 8.2)
 *
 * Tests compound graph construction with hyperedge support:
 * - Tool deduplication with multi-parent array
 * - Capability link edges for shared tools
 * - Hull zone generation
 * - Edge cases (empty, no tools, standalone tools)
 *
 * @module tests/unit/capabilities/hypergraph_builder_test
 */

import { assertEquals, assertExists } from "@std/assert";
import { HypergraphBuilder } from "../../../src/capabilities/hypergraph-builder.ts";
import type {
  CapabilityDependencyEdge,
  CapabilityResponseInternal,
} from "../../../src/capabilities/types.ts";
import type { GraphSnapshot } from "../../../src/graphrag/graph-engine.ts";

/**
 * Helper to create a mock capability
 */
function createMockCapability(
  id: string,
  toolsUsed: string[],
  overrides: Partial<CapabilityResponseInternal> = {},
): CapabilityResponseInternal {
  const base: CapabilityResponseInternal = {
    id,
    name: `Capability ${id}`,
    fqdn: null,
    description: `Description for ${id}`,
    codeSnippet: `const result = await doSomething();`,
    toolsUsed,
    successRate: 0.9,
    usageCount: 10,
    avgDurationMs: 100,
    communityId: null,
    intentPreview: `Intent preview for ${id}`,
    createdAt: new Date().toISOString(),
    lastUsed: new Date().toISOString(),
    source: "emergent",
    hierarchyLevel: 0,
  };
  return { ...base, ...overrides };
}

/**
 * Helper to create a mock GraphSnapshot
 */
function createMockSnapshot(
  tools: Array<{ id: string; pagerank: number; degree: number }>,
): GraphSnapshot {
  return {
    nodes: tools.map((t) => ({
      id: t.id,
      server: t.id.split(":")[0],
      label: t.id.split(":").slice(1).join(":"),
      pagerank: t.pagerank,
      degree: t.degree,
    })),
    edges: [],
    metadata: {
      total_nodes: tools.length,
      total_edges: 0,
      density: 0,
      last_updated: new Date().toISOString(),
    },
  };
}

Deno.test("HypergraphBuilder - buildCompoundGraph returns empty for no capabilities", () => {
  const builder = new HypergraphBuilder();
  const result = builder.buildCompoundGraph([], undefined);

  assertEquals(result.nodes.length, 0);
  assertEquals(result.edges.length, 0);
  assertEquals(result.capabilityZones.length, 0);
  assertEquals(result.capabilitiesCount, 0);
  assertEquals(result.toolsCount, 0);
});

Deno.test("HypergraphBuilder - creates capability node with correct structure", () => {
  const builder = new HypergraphBuilder();
  const cap = createMockCapability("uuid-1", ["filesystem:read"]);

  const result = builder.buildCompoundGraph([cap], undefined);

  // Find capability node
  const capNode = result.nodes.find(
    (n) => n.data.type === "capability" && n.data.id === "cap-uuid-1",
  );
  assertExists(capNode);
  assertEquals(capNode.data.type, "capability");
  assertEquals(capNode.data.label, "Capability uuid-1");

  if (capNode.data.type === "capability") {
    assertEquals(capNode.data.successRate, 0.9);
    assertEquals(capNode.data.usageCount, 10);
    assertEquals(capNode.data.toolsCount, 1);
    assertExists(capNode.data.codeSnippet);
  }
});

Deno.test("HypergraphBuilder - creates tool node with parents[] array", () => {
  const builder = new HypergraphBuilder();
  const cap = createMockCapability("uuid-1", ["filesystem:read"]);

  const result = builder.buildCompoundGraph([cap], undefined);

  // Find tool node
  const toolNode = result.nodes.find(
    (n) => n.data.type === "tool" && n.data.id === "filesystem:read",
  );
  assertExists(toolNode);
  assertEquals(toolNode.data.type, "tool");

  if (toolNode.data.type === "tool") {
    assertEquals(toolNode.data.server, "filesystem");
    assertEquals(toolNode.data.label, "read");
  }

  if (toolNode.data.type === "tool") {
    // Verify parents[] array (new hyperedge support)
    assertExists(toolNode.data.parents);
    assertEquals(Array.isArray(toolNode.data.parents), true);
    assertEquals(toolNode.data.parents.length, 1);
    assertEquals(toolNode.data.parents[0], "cap-uuid-1");
  }
});

Deno.test("HypergraphBuilder - deduplicates tools with multiple parents", () => {
  const builder = new HypergraphBuilder();
  const cap1 = createMockCapability("uuid-1", ["filesystem:read", "github:create_issue"]);
  const cap2 = createMockCapability("uuid-2", ["filesystem:read", "slack:post_message"]);

  const result = builder.buildCompoundGraph([cap1, cap2], undefined);

  // Should have 2 capability nodes + 3 tool nodes (filesystem:read deduplicated)
  const capNodes = result.nodes.filter((n) => n.data.type === "capability");
  const toolNodes = result.nodes.filter((n) => n.data.type === "tool");

  assertEquals(capNodes.length, 2);
  assertEquals(toolNodes.length, 3); // filesystem:read appears ONCE

  // Verify filesystem:read has both parents
  const sharedTool = toolNodes.find((n) => n.data.id === "filesystem:read");
  assertExists(sharedTool);

  if (sharedTool.data.type === "tool") {
    assertExists(sharedTool.data.parents);
    assertEquals(sharedTool.data.parents.length, 2);
    assertEquals(sharedTool.data.parents.includes("cap-uuid-1"), true);
    assertEquals(sharedTool.data.parents.includes("cap-uuid-2"), true);
  }
});

Deno.test("HypergraphBuilder - creates hierarchical edges from parents[]", () => {
  const builder = new HypergraphBuilder();
  const cap1 = createMockCapability("uuid-1", ["filesystem:read"]);
  const cap2 = createMockCapability("uuid-2", ["filesystem:read", "github:create_issue"]);

  const result = builder.buildCompoundGraph([cap1, cap2], undefined);

  // Should have 3 hierarchical edges:
  // - cap-uuid-1 → filesystem:read
  // - cap-uuid-2 → filesystem:read
  // - cap-uuid-2 → github:create_issue
  const hierEdges = result.edges.filter((e) => e.data.edgeType === "hierarchy");
  assertEquals(hierEdges.length, 3);

  // Verify edge structure
  const edge = hierEdges.find(
    (e) => e.data.source === "cap-uuid-1" && e.data.target === "filesystem:read",
  );
  assertExists(edge);
  if (edge.data.edgeType === "hierarchy") {
    assertEquals(edge.data.edgeSource, "observed");
    assertExists(edge.data.observedCount);
  }
});

Deno.test("HypergraphBuilder - creates capability_link edges for shared tools", () => {
  const builder = new HypergraphBuilder();
  const cap1 = createMockCapability("uuid-1", ["filesystem:read", "github:create_issue"]);
  const cap2 = createMockCapability("uuid-2", ["filesystem:read", "slack:post_message"]);

  const result = builder.buildCompoundGraph([cap1, cap2], undefined);

  // Should have 1 capability_link edge (they share filesystem:read)
  const linkEdges = result.edges.filter((e) => e.data.edgeType === "capability_link");
  assertEquals(linkEdges.length, 1);

  const linkEdge = linkEdges[0];
  // Verify sharedTools count and edgeSource
  if (linkEdge.data.edgeType === "capability_link") {
    assertEquals(linkEdge.data.edgeSource, "inferred");
    assertEquals(linkEdge.data.sharedTools, 1);
  }
});

Deno.test("HypergraphBuilder - creates capability_link with correct sharedTools count", () => {
  const builder = new HypergraphBuilder();
  // Two capabilities sharing 2 tools
  const cap1 = createMockCapability("uuid-1", [
    "filesystem:read",
    "github:create_issue",
    "slack:post_message",
  ]);
  const cap2 = createMockCapability("uuid-2", [
    "filesystem:read",
    "slack:post_message",
    "http:fetch",
  ]);

  const result = builder.buildCompoundGraph([cap1, cap2], undefined);

  const linkEdges = result.edges.filter((e) => e.data.edgeType === "capability_link");
  assertEquals(linkEdges.length, 1);

  if (linkEdges[0].data.edgeType === "capability_link") {
    assertEquals(linkEdges[0].data.sharedTools, 2); // filesystem:read + slack:post_message
  }
});

Deno.test("HypergraphBuilder - generates capabilityZones for hull rendering", () => {
  const builder = new HypergraphBuilder();
  const cap1 = createMockCapability("uuid-1", ["filesystem:read", "github:create_issue"]);
  const cap2 = createMockCapability("uuid-2", ["slack:post_message"]);

  const result = builder.buildCompoundGraph([cap1, cap2], undefined);

  assertEquals(result.capabilityZones.length, 2);

  // Verify zone structure
  const zone1 = result.capabilityZones.find((z) => z.id === "cap-uuid-1");
  assertExists(zone1);
  assertEquals(zone1.label, "Capability uuid-1");
  assertEquals(zone1.toolIds.length, 2);
  assertEquals(zone1.toolIds.includes("filesystem:read"), true);
  assertEquals(zone1.toolIds.includes("github:create_issue"), true);
  assertExists(zone1.color);
  assertEquals(zone1.opacity, 0.3);
  assertEquals(zone1.padding, 20);
  assertEquals(zone1.minRadius, 50);

  const zone2 = result.capabilityZones.find((z) => z.id === "cap-uuid-2");
  assertExists(zone2);
  assertEquals(zone2.toolIds.length, 1);
});

Deno.test("HypergraphBuilder - handles capability with 0 tools", () => {
  const builder = new HypergraphBuilder();
  const cap = createMockCapability("uuid-empty", []);

  const result = builder.buildCompoundGraph([cap], undefined);

  assertEquals(result.capabilitiesCount, 1);
  assertEquals(result.toolsCount, 0);

  // Capability node should exist
  const capNode = result.nodes.find((n) => n.data.id === "cap-uuid-empty");
  assertExists(capNode);

  if (capNode.data.type === "capability") {
    assertEquals(capNode.data.toolsCount, 0);
  }

  // Zone should exist but with empty toolIds
  const zone = result.capabilityZones.find((z) => z.id === "cap-uuid-empty");
  assertExists(zone);
  assertEquals(zone.toolIds.length, 0);
});

Deno.test("HypergraphBuilder - enriches tool nodes from GraphSnapshot", () => {
  const builder = new HypergraphBuilder();
  const cap = createMockCapability("uuid-1", ["filesystem:read"]);

  const snapshot = createMockSnapshot([
    { id: "filesystem:read", pagerank: 0.85, degree: 12 },
  ]);

  const result = builder.buildCompoundGraph([cap], snapshot);

  const toolNode = result.nodes.find((n) => n.data.id === "filesystem:read");
  assertExists(toolNode);

  if (toolNode.data.type === "tool") {
    assertEquals(toolNode.data.pagerank, 0.85);
    assertEquals(toolNode.data.degree, 12);
  }
});

Deno.test("HypergraphBuilder - addStandaloneTools adds tools not in capabilities", () => {
  const builder = new HypergraphBuilder();
  const cap = createMockCapability("uuid-1", ["filesystem:read"]);

  const snapshot = createMockSnapshot([
    { id: "filesystem:read", pagerank: 0.5, degree: 5 },
    { id: "http:fetch", pagerank: 0.3, degree: 3 },
    { id: "database:query", pagerank: 0.2, degree: 2 },
  ]);

  const result = builder.buildCompoundGraph([cap], snapshot);
  const existingToolIds = new Set(
    result.nodes.filter((n) => n.data.type === "tool").map((n) => n.data.id),
  );

  // Add standalone tools
  builder.addStandaloneTools(result.nodes, snapshot, existingToolIds);

  // Should now have 3 tool nodes
  const toolNodes = result.nodes.filter((n) => n.data.type === "tool");
  assertEquals(toolNodes.length, 3);

  // Verify standalone tools have empty parents[]
  const httpNode = toolNodes.find((n) => n.data.id === "http:fetch");
  assertExists(httpNode);

  if (httpNode.data.type === "tool") {
    assertExists(httpNode.data.parents);
    assertEquals(httpNode.data.parents.length, 0); // Standalone = empty parents
  }
});

Deno.test("HypergraphBuilder - addCapabilityDependencyEdges adds dependency edges", () => {
  const builder = new HypergraphBuilder();
  const cap1 = createMockCapability("uuid-1", ["filesystem:read"]);
  const cap2 = createMockCapability("uuid-2", ["github:create_issue"]);

  const result = builder.buildCompoundGraph([cap1, cap2], undefined);
  const existingCapIds = new Set(["cap-uuid-1", "cap-uuid-2"]);

  // Add dependency edges
  const dependencies = [
    {
      from_capability_id: "uuid-1",
      to_capability_id: "uuid-2",
      observed_count: 5,
      edge_type: "sequence",
      edge_source: "observed",
    },
  ];

  builder.addCapabilityDependencyEdges(result.edges, dependencies, existingCapIds);

  // Find dependency edge
  const depEdges = result.edges.filter((e) => e.data.id.startsWith("dep-"));
  assertEquals(depEdges.length, 1);

  const depEdge = depEdges[0] as CapabilityDependencyEdge;
  assertEquals(depEdge.data.source, "cap-uuid-1");
  assertEquals(depEdge.data.target, "cap-uuid-2");

  assertEquals(depEdge.data.edgeType, "sequence");
  assertEquals(depEdge.data.edgeSource, "observed");
  assertEquals(depEdge.data.observedCount, 5);
});

Deno.test("HypergraphBuilder - addCapabilityDependencyEdges skips missing capabilities", () => {
  const builder = new HypergraphBuilder();
  const cap1 = createMockCapability("uuid-1", ["filesystem:read"]);

  const result = builder.buildCompoundGraph([cap1], undefined);
  const existingCapIds = new Set(["cap-uuid-1"]); // uuid-2 NOT in set

  // Add dependency to non-existent capability
  const dependencies = [
    {
      from_capability_id: "uuid-1",
      to_capability_id: "uuid-2", // Does not exist
      observed_count: 5,
      edge_type: "dependency",
      edge_source: "inferred",
    },
  ];

  const initialEdgeCount = result.edges.length;
  builder.addCapabilityDependencyEdges(result.edges, dependencies, existingCapIds);

  // No new edge should be added
  assertEquals(result.edges.length, initialEdgeCount);
});

Deno.test("HypergraphBuilder - validates edge_type and edge_source", () => {
  const builder = new HypergraphBuilder();
  const cap1 = createMockCapability("uuid-1", ["filesystem:read"]);
  const cap2 = createMockCapability("uuid-2", ["github:create_issue"]);

  const result = builder.buildCompoundGraph([cap1, cap2], undefined);
  const existingCapIds = new Set(["cap-uuid-1", "cap-uuid-2"]);

  // Add dependency with invalid edge_type
  const dependencies = [
    {
      from_capability_id: "uuid-1",
      to_capability_id: "uuid-2",
      observed_count: 1,
      edge_type: "invalid_type", // Invalid - should default to "dependency"
      edge_source: "unknown_source", // Invalid - should default to "inferred"
    },
  ];

  builder.addCapabilityDependencyEdges(result.edges, dependencies, existingCapIds);

  const depEdge = result.edges.find((e) => e.data.id.startsWith("dep-")) as
    | CapabilityDependencyEdge
    | undefined;
  assertExists(depEdge);

  // Should default to valid values
  assertEquals(depEdge.data.edgeType, "dependency");
  assertEquals(depEdge.data.edgeSource, "inferred");
});

Deno.test("HypergraphBuilder - no capability_link edges when no shared tools", () => {
  const builder = new HypergraphBuilder();
  const cap1 = createMockCapability("uuid-1", ["filesystem:read"]);
  const cap2 = createMockCapability("uuid-2", ["github:create_issue"]);

  const result = builder.buildCompoundGraph([cap1, cap2], undefined);

  // No shared tools = no capability_link edges
  const linkEdges = result.edges.filter((e) => e.data.edgeType === "capability_link");
  assertEquals(linkEdges.length, 0);
});

Deno.test("HypergraphBuilder - handles complex tool ID with multiple colons", () => {
  const builder = new HypergraphBuilder();
  const cap = createMockCapability("uuid-1", ["mcp:server:complex:tool"]);

  const result = builder.buildCompoundGraph([cap], undefined);

  const toolNode = result.nodes.find((n) => n.data.id === "mcp:server:complex:tool");
  assertExists(toolNode);

  if (toolNode.data.type === "tool") {
    assertEquals(toolNode.data.server, "mcp");
    assertEquals(toolNode.data.label, "server:complex:tool");
  }
});
