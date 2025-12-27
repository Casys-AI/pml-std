/**
 * Unit tests for WorkflowSyncService (Story 5.2)
 *
 * Tests cover:
 * - AC2: Sync creates DB entries with source='user'
 * - AC4: Checksum comparison triggers/skips sync
 * - AC6: Auto-bootstrap when graph empty
 */

import { assert, assertEquals, assertExists } from "@std/assert";
import { PGliteClient } from "../../../src/db/client.ts";
import { getAllMigrations, MigrationRunner } from "../../../src/db/migrations.ts";
import {
  type EmbeddingModelFactory,
  type IEmbeddingModel,
  WorkflowSyncService,
} from "../../../src/graphrag/workflow-sync.ts";

/**
 * Mock embedding model for tests (no ONNX, no resource leaks)
 */
class MockEmbeddingModel implements IEmbeddingModel {
  async load(): Promise<void> {
    // No-op: no real model to load
  }

  async encode(_text: string): Promise<number[]> {
    // Return fake 1024-dimensional embedding
    return new Array(1024).fill(0.1);
  }

  async dispose(): Promise<void> {
    // No-op: no resources to clean up
  }
}

/**
 * Factory that creates mock embedding models
 */
const mockEmbeddingFactory: EmbeddingModelFactory = () => new MockEmbeddingModel();

/**
 * Create test database with schema
 */
async function createTestDb(): Promise<PGliteClient> {
  const db = new PGliteClient(`memory://${crypto.randomUUID()}`);
  await db.connect();

  // Run all migrations
  const migrationRunner = new MigrationRunner(db);
  await migrationRunner.runUp(getAllMigrations());

  return db;
}

/**
 * Create temporary workflow YAML file
 */
async function createTempYaml(content: string): Promise<string> {
  const tempFile = await Deno.makeTempFile({ suffix: ".yaml" });
  await Deno.writeTextFile(tempFile, content);
  return tempFile;
}

/**
 * Populate tool_schema with test tools (for strict validation)
 */
async function populateToolSchema(db: PGliteClient, toolIds: string[]): Promise<void> {
  for (const toolId of toolIds) {
    const [serverId, toolName] = toolId.includes(":") ? toolId.split(":") : ["test_server", toolId];

    await db.query(
      `INSERT INTO tool_schema (server_id, name, tool_id, description, input_schema)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tool_id) DO NOTHING`,
      [serverId, toolName, toolId, `Test tool ${toolId}`, JSON.stringify({ type: "object" })],
    );
  }
}

// ============================================
// AC2: Sync creates DB entries with source='user'
// ============================================

Deno.test({
  name: "WorkflowSyncService - sync creates edges with source='user'",
  sanitizeResources: false, // HuggingFace Transformers doesn't expose ONNX cleanup
  sanitizeOps: false, // ONNX model async operations
  fn: async () => {
    const db = await createTestDb();
    const syncService = new WorkflowSyncService(db, mockEmbeddingFactory);

    // Populate tool_schema with test tools (strict validation requires this)
    await populateToolSchema(db, ["tool_a", "tool_b", "tool_c"]);

    const yamlPath = await createTempYaml(`
workflows:
  - name: test_workflow
    steps: [tool_a, tool_b, tool_c]
`);

    const result = await syncService.sync(yamlPath, true);

    // Check sync succeeded
    assertEquals(result.success, true);
    assertEquals(result.workflowsProcessed, 1);
    assertEquals(result.edgesCreated, 2); // (a→b), (b→c)

    // Check edges were created with edge_source='user'
    const edges = await db.query(
      `SELECT from_tool_id, to_tool_id, edge_source, confidence_score
     FROM tool_dependency
     ORDER BY from_tool_id`,
    );

    assertEquals(edges.length, 2);
    assertEquals(edges[0].from_tool_id, "tool_a");
    assertEquals(edges[0].to_tool_id, "tool_b");
    assertEquals(edges[0].edge_source, "user");
    assertEquals(edges[0].confidence_score, 0.9);

    assertEquals(edges[1].from_tool_id, "tool_b");
    assertEquals(edges[1].to_tool_id, "tool_c");
    assertEquals(edges[1].edge_source, "user");

    await Deno.remove(yamlPath);
    await db.close();
  },
});

Deno.test({
  name: "WorkflowSyncService - sync preserves observed_count on upsert",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = await createTestDb();
    const syncService = new WorkflowSyncService(db, mockEmbeddingFactory);

    // Populate tool_schema (strict validation)
    await populateToolSchema(db, ["tool_a", "tool_b"]);

    // Pre-create an edge with observed_count = 100
    await db.query(
      `INSERT INTO tool_dependency (from_tool_id, to_tool_id, observed_count, confidence_score, edge_source)
     VALUES ('tool_a', 'tool_b', 100, 0.5, 'learned')`,
    );

    const yamlPath = await createTempYaml(`
workflows:
  - name: test_workflow
    steps: [tool_a, tool_b]
`);

    const result = await syncService.sync(yamlPath, true);

    assertEquals(result.success, true);
    assertEquals(result.edgesUpdated, 1);
    assertEquals(result.edgesCreated, 0);

    // Check observed_count was preserved
    const edge = await db.queryOne(
      `SELECT observed_count, edge_source, confidence_score
     FROM tool_dependency
     WHERE from_tool_id = 'tool_a' AND to_tool_id = 'tool_b'`,
    );

    assertExists(edge);
    assertEquals(edge.observed_count, 100); // Preserved
    assertEquals(edge.edge_source, "user"); // Updated to 'user' on sync
    assertEquals(edge.confidence_score, 0.9); // Updated (GREATEST(0.5, 0.9))

    await Deno.remove(yamlPath);
    await db.close();
  },
});

// ============================================
// AC4: Checksum comparison triggers/skips sync
// ============================================

Deno.test({
  name: "WorkflowSyncService - needsSync returns true for new file",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = await createTestDb();
    const syncService = new WorkflowSyncService(db, mockEmbeddingFactory);

    const yamlPath = await createTempYaml("workflows: []");

    const needsSync = await syncService.needsSync(yamlPath);

    assertEquals(needsSync, true);

    await Deno.remove(yamlPath);
    await db.close();
  },
});

Deno.test({
  name: "WorkflowSyncService - needsSync returns false after sync",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = await createTestDb();
    const syncService = new WorkflowSyncService(db, mockEmbeddingFactory);

    // Populate tool_schema (strict validation)
    await populateToolSchema(db, ["a", "b"]);

    const yamlPath = await createTempYaml(`
workflows:
  - name: test
    steps: [a, b]
`);

    // First sync
    await syncService.sync(yamlPath, false);

    // Check if needs sync again
    const needsSync = await syncService.needsSync(yamlPath);

    assertEquals(needsSync, false);

    await Deno.remove(yamlPath);
    await db.close();
  },
});

Deno.test({
  name: "WorkflowSyncService - needsSync returns true after file change",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = await createTestDb();
    const syncService = new WorkflowSyncService(db, mockEmbeddingFactory);

    // Populate tool_schema with all tools (original + modified)
    await populateToolSchema(db, ["a", "b", "x", "y", "z"]);

    const yamlPath = await createTempYaml(`
workflows:
  - name: original
    steps: [a, b]
`);

    // First sync
    await syncService.sync(yamlPath, false);

    // Modify file
    await Deno.writeTextFile(
      yamlPath,
      `
workflows:
  - name: modified
    steps: [x, y, z]
`,
    );

    // Check if needs sync
    const needsSync = await syncService.needsSync(yamlPath);

    assertEquals(needsSync, true);

    await Deno.remove(yamlPath);
    await db.close();
  },
});

Deno.test({
  name: "WorkflowSyncService - sync skips when unchanged (no --force)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = await createTestDb();
    const syncService = new WorkflowSyncService(db, mockEmbeddingFactory);

    // Populate tool_schema (strict validation)
    await populateToolSchema(db, ["a", "b"]);

    const yamlPath = await createTempYaml(`
workflows:
  - name: test
    steps: [a, b]
`);

    // First sync
    const firstResult = await syncService.sync(yamlPath, false);
    assertEquals(firstResult.edgesCreated, 1);

    // Second sync without force
    const secondResult = await syncService.sync(yamlPath, false);
    assertEquals(secondResult.edgesCreated, 0);
    assertEquals(secondResult.edgesUpdated, 0);

    await Deno.remove(yamlPath);
    await db.close();
  },
});

Deno.test({
  name: "WorkflowSyncService - sync runs with --force even when unchanged",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = await createTestDb();
    const syncService = new WorkflowSyncService(db, mockEmbeddingFactory);

    // Populate tool_schema (strict validation)
    await populateToolSchema(db, ["a", "b"]);

    const yamlPath = await createTempYaml(`
workflows:
  - name: test
    steps: [a, b]
`);

    // First sync
    await syncService.sync(yamlPath, true);

    // Second sync with force
    const result = await syncService.sync(yamlPath, true);

    // Should run and update existing edge
    assertEquals(result.edgesUpdated, 1);
    assertEquals(result.workflowsProcessed, 1);

    await Deno.remove(yamlPath);
    await db.close();
  },
});

// ============================================
// AC6: Auto-bootstrap when graph empty
// ============================================

Deno.test({
  name: "WorkflowSyncService - isGraphEmpty returns true for empty graph",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = await createTestDb();
    const syncService = new WorkflowSyncService(db, mockEmbeddingFactory);

    const isEmpty = await syncService.isGraphEmpty();

    assertEquals(isEmpty, true);

    await db.close();
  },
});

Deno.test({
  name: "WorkflowSyncService - isGraphEmpty returns false when embeddings exist",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = await createTestDb();
    const syncService = new WorkflowSyncService(db, mockEmbeddingFactory);

    // Add an embedding (isGraphEmpty checks tool_embedding, not tool_dependency)
    await db.query(
      `INSERT INTO tool_embedding (tool_id, server_id, tool_name, embedding)
     VALUES ('tool_a', 'test_server', 'tool_a', '[${new Array(1024).fill(0.1).join(",")}]')`,
    );

    const isEmpty = await syncService.isGraphEmpty();

    assertEquals(isEmpty, false);

    await db.close();
  },
});

Deno.test({
  name: "WorkflowSyncService - bootstrapIfEmpty syncs when graph empty",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = await createTestDb();
    const syncService = new WorkflowSyncService(db, mockEmbeddingFactory);

    // Populate tool_schema (strict validation)
    await populateToolSchema(db, ["start", "middle", "end"]);

    const yamlPath = await createTempYaml(`
workflows:
  - name: bootstrap_workflow
    steps: [start, middle, end]
`);

    const bootstrapped = await syncService.bootstrapIfEmpty(yamlPath);

    assertEquals(bootstrapped, true);

    // Check edges were created
    const edges = await db.query(`SELECT * FROM tool_dependency`);
    assertEquals(edges.length, 2);

    await Deno.remove(yamlPath);
    await db.close();
  },
});

Deno.test({
  name: "WorkflowSyncService - bootstrapIfEmpty skips when graph not empty",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = await createTestDb();
    const syncService = new WorkflowSyncService(db, mockEmbeddingFactory);

    // Populate tool_schema (strict validation)
    await populateToolSchema(db, ["a", "b", "c"]);

    // Pre-populate graph with embedding (isGraphEmpty checks tool_embedding)
    await db.query(
      `INSERT INTO tool_embedding (tool_id, server_id, tool_name, embedding)
     VALUES ('existing_tool', 'test_server', 'existing_tool', '[${
        new Array(1024).fill(0.1).join(",")
      }]')`,
    );

    const yamlPath = await createTempYaml(`
workflows:
  - name: new_workflow
    steps: [a, b, c]
`);

    const bootstrapped = await syncService.bootstrapIfEmpty(yamlPath);

    assertEquals(bootstrapped, false);

    await Deno.remove(yamlPath);
    await db.close();
  },
});

Deno.test({
  name: "WorkflowSyncService - bootstrapIfEmpty skips when file missing",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = await createTestDb();
    const syncService = new WorkflowSyncService(db, mockEmbeddingFactory);

    const bootstrapped = await syncService.bootstrapIfEmpty("/nonexistent/file.yaml");

    assertEquals(bootstrapped, false);

    await db.close();
  },
});

// ============================================
// Edge statistics
// ============================================

Deno.test({
  name: "WorkflowSyncService - getEdgeStats returns correct counts",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = await createTestDb();
    const syncService = new WorkflowSyncService(db, mockEmbeddingFactory);

    // Add user edges
    await db.query(
      `INSERT INTO tool_dependency (from_tool_id, to_tool_id, edge_source)
     VALUES ('user_a', 'user_b', 'user'), ('user_b', 'user_c', 'user')`,
    );

    // Add learned edges
    await db.query(
      `INSERT INTO tool_dependency (from_tool_id, to_tool_id, edge_source)
     VALUES ('learned_a', 'learned_b', 'learned')`,
    );

    const stats = await syncService.getEdgeStats();

    assertEquals(stats.user, 2);
    assertEquals(stats.learned, 1);
    assertEquals(stats.total, 3);

    await db.close();
  },
});

// ============================================
// Error handling
// ============================================

Deno.test({
  name: "WorkflowSyncService - sync returns error result on failure",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = await createTestDb();
    const syncService = new WorkflowSyncService(db, mockEmbeddingFactory);

    // Populate tool_schema (required for sync to proceed to YAML validation)
    await populateToolSchema(db, ["some_tool"]);

    // Use invalid YAML (not an object with workflows)
    const yamlPath = await createTempYaml("invalid: not workflows");

    const result = await syncService.sync(yamlPath, true);

    assertEquals(result.success, false);
    assertExists(result.error);
    assert(result.error.includes("Invalid YAML"));

    await Deno.remove(yamlPath);
    await db.close();
  },
});
