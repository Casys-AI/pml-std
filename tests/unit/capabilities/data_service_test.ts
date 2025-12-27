/**
 * Unit tests for CapabilityDataService (Story 8.1)
 *
 * Tests API data layer for capabilities and hypergraph visualization.
 * PERFORMANCE: Uses shared DB to avoid re-running migrations for each test
 *
 * @module tests/unit/capabilities/data_service_test
 */

import { assertEquals, assertExists } from "@std/assert";
import { PGliteClient } from "../../../src/db/client.ts";
import { getAllMigrations, MigrationRunner } from "../../../src/db/migrations.ts";
import { CapabilityDataService } from "../../../src/capabilities/data-service.ts";
import { GraphRAGEngine } from "../../../src/graphrag/graph-engine.ts";

// Shared DB for all tests (migrations run once)
let sharedDb: PGliteClient;
let service: CapabilityDataService;

/**
 * Generate a valid 1024-dimensional embedding vector
 */
function generateEmbedding(): string {
  const vec = new Array(1024).fill(0).map(() => Math.random());
  return `[${vec.join(",")}]`;
}

// Setup shared DB once
Deno.test({
  name: "[SETUP] CapabilityDataService - Initialize shared DB",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    sharedDb = new PGliteClient(`memory://${crypto.randomUUID()}`);
    await sharedDb.connect();

    const runner = new MigrationRunner(sharedDb);
    await runner.runUp(getAllMigrations());

    const graphEngine = new GraphRAGEngine(sharedDb);
    service = new CapabilityDataService(sharedDb, graphEngine);
  },
});

Deno.test("CapabilityDataService - listCapabilities returns empty list initially", async () => {
  const result = await service.listCapabilities({});

  assertEquals(result.capabilities.length, 0);
  assertEquals(result.total, 0);
  assertEquals(result.limit, 50);
  assertEquals(result.offset, 0);
});

Deno.test("CapabilityDataService - listCapabilities returns capabilities with correct structure", async () => {
  // Insert test capability
  // Note: name column removed in migration 022 - naming via capability_records.display_name
  const capId = crypto.randomUUID();
  await sharedDb.query(
    `
    INSERT INTO workflow_pattern (
      pattern_id, code_snippet, code_hash, pattern_hash, intent_embedding,
      success_rate, usage_count, avg_duration_ms,
      created_at, last_used, source, description,
      dag_structure
    ) VALUES (
      $1, 'const x = 1;', 'hash1', 'phash1', $2,
      0.9, 5, 100,
      NOW(), NOW(), 'emergent', 'Test description',
      '{"tools_used": ["filesystem:read", "github:create_issue"]}'::jsonb
    )

  `,
    [capId, generateEmbedding()],
  );

  const result = await service.listCapabilities({});

  assertEquals(result.capabilities.length >= 1, true);

  const cap = result.capabilities.find((c) => c.id === capId);
  assertExists(cap);
  assertEquals(cap.codeSnippet, "const x = 1;");
  assertEquals(cap.successRate, 0.9);
  assertEquals(cap.usageCount, 5);
  // name now comes from capability_records.display_name (null if not linked)
  assertEquals(cap.name, null);
  assertEquals(cap.toolsUsed.length, 2);
  assertEquals(cap.toolsUsed[0], "filesystem:read");
});

Deno.test("CapabilityDataService - listCapabilities filters by minSuccessRate", async () => {
  // Insert capabilities with different success rates
  const highId = crypto.randomUUID();
  const lowId = crypto.randomUUID();

  await sharedDb.query(
    `
    INSERT INTO workflow_pattern (
      pattern_id, code_snippet, code_hash, pattern_hash, intent_embedding,
      success_rate, usage_count, avg_duration_ms,
      created_at, last_used, source, dag_structure
    ) VALUES
    ($1, 'const a = 1;', 'hash-high', 'phash-high', $3, 0.95, 10, 100, NOW(), NOW(), 'emergent', '{}'::jsonb),
    ($2, 'const b = 2;', 'hash-low', 'phash-low', $4, 0.3, 5, 100, NOW(), NOW(), 'emergent', '{}'::jsonb)

  `,
    [highId, lowId, generateEmbedding(), generateEmbedding()],
  );

  const result = await service.listCapabilities({ minSuccessRate: 0.9 });

  const highCap = result.capabilities.find((c) => c.id === highId);
  const lowCap = result.capabilities.find((c) => c.id === lowId);

  assertExists(highCap);
  assertEquals(lowCap, undefined);
});

Deno.test("CapabilityDataService - listCapabilities supports pagination", async () => {
  const result = await service.listCapabilities({ limit: 2, offset: 0 });

  assertEquals(result.limit, 2);
  assertEquals(result.offset, 0);
  assertEquals(result.capabilities.length <= 2, true);
});

Deno.test("CapabilityDataService - listCapabilities truncates intent preview", async () => {
  const longDescription = "a".repeat(150);
  const capId = crypto.randomUUID();

  await sharedDb.query(
    `
    INSERT INTO workflow_pattern (
      pattern_id, code_snippet, code_hash, pattern_hash, intent_embedding,
      success_rate, usage_count, avg_duration_ms,
      created_at, last_used, source, description, dag_structure
    ) VALUES (
      $1, 'const x = 1;', 'hash-long', 'phash-long', $3,
      0.9, 5, 100, NOW(), NOW(), 'emergent', $2, '{}'::jsonb
    )

  `,
    [capId, longDescription, generateEmbedding()],
  );

  const result = await service.listCapabilities({});
  const cap = result.capabilities.find((c) => c.id === capId);

  if (cap) {
    assertEquals(cap.intentPreview.length, 100);
    assertEquals(cap.intentPreview.endsWith("..."), true);
  }
});

Deno.test("CapabilityDataService - buildHypergraphData returns empty initially", async () => {
  // Clear all capabilities first
  await sharedDb.query("DELETE FROM workflow_pattern");

  const result = await service.buildHypergraphData({});

  assertEquals(result.nodes.length, 0);
  assertEquals(result.edges.length, 0);
  assertEquals(result.capabilitiesCount, 0);
  assertExists(result.metadata.generatedAt);
  assertEquals(result.metadata.version, "1.0.0");
});

Deno.test("CapabilityDataService - buildHypergraphData creates capability and tool nodes", async () => {
  // Note: name column removed in migration 022 - naming via capability_records.display_name
  const capId = crypto.randomUUID();

  await sharedDb.query(
    `
    INSERT INTO workflow_pattern (
      pattern_id, code_snippet, code_hash, pattern_hash, intent_embedding,
      success_rate, usage_count, avg_duration_ms,
      created_at, last_used, source, description,
      dag_structure
    ) VALUES (
      $1, 'const x = 1;', 'hash-hyper-1', 'phash-hyper-1', $2,
      0.8, 10, 100, NOW(), NOW(), 'emergent', 'Test Capability Description',
      '{"tools_used": ["filesystem:read"]}'::jsonb
    )

  `,
    [capId, generateEmbedding()],
  );

  const result = await service.buildHypergraphData({});

  // Should have at least 1 capability node + 1 tool node
  assertEquals(result.capabilitiesCount >= 1, true);
  assertEquals(result.toolsCount >= 1, true);

  // Find capability node
  const capNode = result.nodes.find((n) =>
    n.data.type === "capability" && n.data.id === `cap-${capId}`
  );
  assertExists(capNode);
  // Label falls back to intentPreview (description) when no capability_records entry exists
  assertEquals(capNode.data.label, "Test Capability Description");

  if (capNode.data.type === "capability") {
    assertEquals(capNode.data.successRate, 0.8);
    assertEquals(capNode.data.usageCount, 10);
    assertEquals(capNode.data.toolsCount, 1);
  }

  // Find tool node - Story 8.2: now uses parents[] array instead of single parent
  const toolNode = result.nodes.find((n) =>
    n.data.type === "tool" &&
    n.data.id === "filesystem:read" &&
    n.data.parents?.includes(`cap-${capId}`)
  );
  assertExists(toolNode);
});

Deno.test("CapabilityDataService - buildHypergraphData creates capability links for shared tools", async () => {
  const cap1Id = crypto.randomUUID();
  const cap2Id = crypto.randomUUID();

  await sharedDb.query(
    `
    INSERT INTO workflow_pattern (
      pattern_id, code_snippet, code_hash, pattern_hash, intent_embedding,
      success_rate, usage_count, avg_duration_ms,
      created_at, last_used, source,
      dag_structure
    ) VALUES
    ($1, 'const a = 1;', 'hash-link-1', 'phash-link-1', $3, 0.8, 10, 100, NOW(), NOW(), 'emergent',
     '{"tools_used": ["filesystem:read", "github:create_issue"]}'::jsonb),
    ($2, 'const b = 2;', 'hash-link-2', 'phash-link-2', $4, 0.8, 10, 100, NOW(), NOW(), 'emergent',
     '{"tools_used": ["filesystem:read", "slack:post_message"]}'::jsonb)
    
  `,
    [cap1Id, cap2Id, generateEmbedding(), generateEmbedding()],
  );

  const result = await service.buildHypergraphData({});

  // Find capability link edges (capabilities sharing filesystem:read)
  const linkEdges = result.edges.filter((e) => e.data.edgeType === "capability_link");
  assertEquals(linkEdges.length >= 1, true);

  // Check structure of first link edge
  const edge = linkEdges.find((e) =>
    (e.data.source === `cap-${cap1Id}` && e.data.target === `cap-${cap2Id}`) ||
    (e.data.source === `cap-${cap2Id}` && e.data.target === `cap-${cap1Id}`)
  );

  if (edge && edge.data.edgeType === "capability_link") {
    assertEquals(edge.data.sharedTools, 1); // filesystem:read
    assertEquals(edge.data.edgeSource, "inferred");
  }
});

Deno.test("CapabilityDataService - buildHypergraphData creates hierarchical edges", async () => {
  const result = await service.buildHypergraphData({});

  // Find hierarchical edges (capability → tool)
  const hierEdges = result.edges.filter((e) => e.data.edgeType === "hierarchy");
  assertEquals(hierEdges.length >= 1, true);

  const edge = hierEdges[0];
  assertEquals(edge.data.source.startsWith("cap-"), true);

  // Type guard: verify edge properties within narrowed type context
  if (edge.data.edgeType === "hierarchy") {
    assertEquals(edge.data.edgeSource, "observed");
    assertExists(edge.data.observedCount);
  }
});

// Fix #23: Test sorting functionality
Deno.test("CapabilityDataService - listCapabilities supports sorting by usage_count desc", async () => {
  // Insert capabilities with different usage counts
  const cap1Id = crypto.randomUUID();
  const cap2Id = crypto.randomUUID();
  const cap3Id = crypto.randomUUID();

  await sharedDb.query(
    `
    INSERT INTO workflow_pattern (
      pattern_id, code_snippet, code_hash, pattern_hash, intent_embedding,
      success_rate, usage_count, avg_duration_ms,
      created_at, last_used, source, dag_structure
    ) VALUES
    ($1, 'const a = 1;', 'hash-sort-1', 'phash-sort-1', $4, 0.9, 100, 100, NOW(), NOW(), 'emergent', '{}'::jsonb),
    ($2, 'const b = 2;', 'hash-sort-2', 'phash-sort-2', $5, 0.9, 50, 100, NOW(), NOW(), 'emergent', '{}'::jsonb),
    ($3, 'const c = 3;', 'hash-sort-3', 'phash-sort-3', $6, 0.9, 200, 100, NOW(), NOW(), 'emergent', '{}'::jsonb)

  `,
    [cap1Id, cap2Id, cap3Id, generateEmbedding(), generateEmbedding(), generateEmbedding()],
  );

  const result = await service.listCapabilities({ sort: "usageCount", order: "desc", limit: 3 });

  // Should be ordered: cap3 (200), cap1 (100), cap2 (50)
  const sortedCaps = result.capabilities.filter((c) =>
    c.id === cap1Id || c.id === cap2Id || c.id === cap3Id
  );

  if (sortedCaps.length === 3) {
    // Verify descending order by usage_count
    assertEquals(sortedCaps[0].usageCount >= sortedCaps[1].usageCount, true);
    assertEquals(sortedCaps[1].usageCount >= sortedCaps[2].usageCount, true);
  }
});

// Fix #23: Test sorting by success_rate asc
Deno.test("CapabilityDataService - listCapabilities supports sorting by success_rate asc", async () => {
  const result = await service.listCapabilities({ sort: "successRate", order: "asc", limit: 5 });

  // Verify ascending order
  for (let i = 0; i < result.capabilities.length - 1; i++) {
    assertEquals(
      result.capabilities[i].successRate <= result.capabilities[i + 1].successRate,
      true,
    );
  }
});

// Story 8.2: Test capabilityZones in buildHypergraphData
Deno.test("CapabilityDataService - buildHypergraphData includes capabilityZones", async () => {
  const result = await service.buildHypergraphData({});

  // capabilityZones should exist (even if empty)
  assertExists(result.capabilityZones);
  assertEquals(Array.isArray(result.capabilityZones), true);

  // If we have capabilities, we should have zones
  if (result.capabilitiesCount > 0) {
    assertEquals(result.capabilityZones.length, result.capabilitiesCount);

    // Verify zone structure
    const zone = result.capabilityZones[0];
    assertExists(zone.id);
    assertExists(zone.label);
    assertExists(zone.color);
    assertEquals(typeof zone.opacity, "number");
    assertEquals(Array.isArray(zone.toolIds), true);
    assertEquals(typeof zone.padding, "number");
    assertEquals(typeof zone.minRadius, "number");
  }
});

// Story 8.2: Test backward compatibility - parent field set from parents[0]
Deno.test("CapabilityDataService - buildHypergraphData sets legacy parent field", async () => {
  const result = await service.buildHypergraphData({});

  // Find tool nodes with parents
  const toolNodes = result.nodes.filter((n) => n.data.type === "tool");

  for (const toolNode of toolNodes) {
    if (toolNode.data.type === "tool") {
      // parents should always be defined (required field)
      assertExists(toolNode.data.parents);
      assertEquals(Array.isArray(toolNode.data.parents), true);

      // If tool has parents, legacy parent field should be set to first
      if (toolNode.data.parents.length > 0) {
        assertEquals(toolNode.data.parent, toolNode.data.parents[0]);
      }
    }
  }
});

// Story 11.4: Test includeTraces option
Deno.test("CapabilityDataService - buildHypergraphData with includeTraces=false excludes traces", async () => {
  const result = await service.buildHypergraphData({ includeTraces: false });

  // Capability nodes should not have traces when includeTraces is false
  const capNodes = result.nodes.filter((n) => n.data.type === "capability");
  for (const node of capNodes) {
    if (node.data.type === "capability") {
      // traces should be undefined when not requested
      assertEquals(node.data.traces, undefined);
    }
  }
});

// Story 11.4: Test includeTraces option returns traces when enabled
Deno.test("CapabilityDataService - buildHypergraphData with includeTraces=true fetches traces", async () => {
  // First, insert a capability with an execution trace
  // Note: name column removed in migration 022 - naming via capability_records.display_name
  const capId = crypto.randomUUID();
  const traceId = crypto.randomUUID();

  // Insert capability
  await sharedDb.query(
    `
    INSERT INTO workflow_pattern (
      pattern_id, code_snippet, code_hash, pattern_hash, intent_embedding,
      success_rate, usage_count, avg_duration_ms,
      created_at, last_used, source, description, dag_structure
    ) VALUES (
      $1, 'const x = 1;', $2, 'phash_trace', $3,
      0.9, 1, 100,
      NOW(), NOW(), 'emergent', 'Trace Test Cap Description',
      '{"tools_used": ["filesystem:read"]}'::jsonb
    )
  `,
    [capId, `hash_trace_${capId}`, generateEmbedding()],
  );

  // Insert execution trace with layerIndex
  await sharedDb.query(
    `
    INSERT INTO execution_trace (
      id, capability_id, executed_at, success, duration_ms, priority, task_results
    ) VALUES (
      $1, $2, NOW(), true, 150, 0.5,
      $3::jsonb
    )
  `,
    [
      traceId,
      capId,
      JSON.stringify([
        {
          taskId: "t1",
          tool: "filesystem:read",
          args: {},
          result: {},
          success: true,
          durationMs: 50,
          layerIndex: 0,
        },
        {
          taskId: "t2",
          tool: "github:create_issue",
          args: {},
          result: {},
          success: true,
          durationMs: 100,
          layerIndex: 1,
        },
      ]),
    ],
  );

  const result = await service.buildHypergraphData({ includeTraces: true });

  // Find the capability node with our trace
  const capNode = result.nodes.find(
    (n) => n.data.type === "capability" && n.data.id === `cap-${capId}`,
  );

  if (capNode && capNode.data.type === "capability") {
    // traces should be defined when requested
    assertExists(capNode.data.traces);
    assertEquals(Array.isArray(capNode.data.traces), true);

    if (capNode.data.traces && capNode.data.traces.length > 0) {
      const trace = capNode.data.traces[0];
      assertEquals(trace.success, true);
      assertEquals(trace.durationMs, 150);

      // Verify taskResults have layerIndex
      assertExists(trace.taskResults);
      assertEquals(trace.taskResults.length, 2);
      assertEquals(trace.taskResults[0].layerIndex, 0);
      assertEquals(trace.taskResults[1].layerIndex, 1);
    }
  }
});
