/**
 * Test Helpers for E2E Tests
 *
 * Shared utilities for setting up test databases, embedding models,
 * and common test fixtures.
 */

import { PGliteClient } from "../../src/db/client.ts";
import { getAllMigrations, MigrationRunner } from "../../src/db/migrations.ts";
import { EmbeddingModel } from "../../src/vector/embeddings.ts";
import { generateHash } from "../../src/capabilities/fqdn.ts";

/**
 * Initialize a test database with migrations
 *
 * Creates a temporary PGlite database with pgvector extension
 * and runs all migrations.
 *
 * @param testDir - Optional test directory (creates temp dir if not provided)
 * @returns Initialized database instance
 */
export async function initializeTestDatabase(
  testDir?: string,
): Promise<PGliteClient> {
  const dir = testDir || await Deno.makeTempDir({ prefix: "pml_test_" });
  const dbPath = `${dir}/test.db`;

  const db = new PGliteClient(dbPath);
  await db.connect();

  // Run migrations
  const migrationRunner = new MigrationRunner(db);
  await migrationRunner.runUp(getAllMigrations());

  return db;
}

/**
 * Clean up test database and directory
 *
 * @param db - Database instance to close
 * @param testDir - Test directory to remove
 */
export async function cleanupTestDatabase(
  db: PGliteClient,
  testDir: string,
): Promise<void> {
  try {
    await db.close();
  } catch (error) {
    console.error("Error closing database:", error);
  }

  try {
    await Deno.remove(testDir, { recursive: true });
  } catch {
    // Ignore errors if directory doesn't exist
  }
}

/**
 * Load embedding model for tests
 *
 * Uses BGE-M3 model with caching for faster test execution.
 *
 * @returns EmbeddingModel instance
 */
export async function loadEmbeddingModel(): Promise<EmbeddingModel> {
  const model = new EmbeddingModel();
  await model.load();
  return model;
}

/**
 * Load mock embedding model for E2E testing
 *
 * Returns a lightweight mock that doesn't require cleanup/dispose.
 * Use this in E2E tests to avoid resource leaks.
 *
 * @returns Mock embedding model with encode() method
 */
export async function loadMockEmbeddingModel(): Promise<
  { encode: (text: string) => Promise<number[]> }
> {
  const { SemanticMockEmbedding } = await import("../mocks/semantic-embedding-mock.ts");
  return new SemanticMockEmbedding();
}

/**
 * Generate test embeddings for given texts
 *
 * @param model - Embedding model
 * @param texts - Array of texts to embed
 * @returns Array of embedding vectors
 */
export async function generateTestEmbeddings(
  model: EmbeddingModel,
  texts: string[],
): Promise<number[][]> {
  const embeddings: number[][] = [];

  for (const text of texts) {
    const embedding = await model.encode(text);
    embeddings.push(embedding);
  }

  return embeddings;
}

interface ToolSchema {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/**
 * Store mock tool schemas in database
 *
 * Story 11.0: Now uses tool_schema only (mcp_tool removed)
 *
 * @param db - Database instance
 * @param serverId - MCP server ID
 * @param schemas - Tool schemas to store
 */
export async function storeSchemas(
  db: PGliteClient,
  serverId: string,
  schemas: ToolSchema[],
): Promise<void> {
  for (const schema of schemas) {
    const toolId = `${serverId}:${schema.name}`;

    // Insert into tool_schema table (unified table for all tool storage)
    await db.query(
      `
      INSERT INTO tool_schema (tool_id, server_id, name, description, input_schema)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (tool_id)
      DO UPDATE SET description = EXCLUDED.description,
                    input_schema = EXCLUDED.input_schema,
                    updated_at = NOW()
    `,
      [
        toolId,
        serverId,
        schema.name,
        schema.description || "",
        JSON.stringify(schema.inputSchema || {}),
      ],
    );
  }
}

interface ToolRecord {
  tool_id: string;
  server_id: string;
  name: string;
  description: string | null;
}

/**
 * Generate embeddings for all tools in database
 *
 * @param db - Database instance
 * @param embeddingModel - Embedding model
 */
export async function generateEmbeddings(
  db: PGliteClient,
  embeddingModel: EmbeddingModel,
): Promise<void> {
  // Get all tools from tool_schema
  const tools = await db.query(
    `SELECT tool_id, server_id, name, description FROM tool_schema`,
  );

  for (const tool of tools) {
    const toolRecord = tool as unknown as ToolRecord;
    const text = `${toolRecord.name}: ${toolRecord.description || ""}`;

    // Generate embedding using EmbeddingModel.encode()
    const embedding = await embeddingModel.encode(text);

    // Store embedding
    await db.query(
      `
      INSERT INTO tool_embedding (tool_id, server_id, tool_name, embedding)
      VALUES ($1, $2, $3, $4::vector)
      ON CONFLICT (tool_id)
      DO UPDATE SET embedding = EXCLUDED.embedding,
                    server_id = EXCLUDED.server_id,
                    tool_name = EXCLUDED.tool_name
    `,
      [toolRecord.tool_id, toolRecord.server_id, toolRecord.name, `[${embedding.join(",")}]`],
    );
  }
}

interface DAGTask {
  id: string;
  tool: string;
  arguments: Record<string, unknown>;
  dependsOn: string[];
}

interface DAGStructure {
  tasks: DAGTask[];
}

/**
 * Create a test DAG structure for testing
 *
 * @param taskCount - Number of tasks in the DAG
 * @returns DAG structure
 */
export function createTestDAG(taskCount: number): DAGStructure {
  const tasks: DAGTask[] = [];

  for (let i = 0; i < taskCount; i++) {
    tasks.push({
      id: `task-${i}`,
      tool: `server:tool-${i}`,
      arguments: { input: `value-${i}` },
      dependsOn: i > 0 ? [`task-${i - 1}`] : [],
    });
  }

  return { tasks };
}

/**
 * Wait for a condition to be true with timeout
 *
 * @param condition - Async function that returns true when condition is met
 * @param timeout - Maximum time to wait in milliseconds
 * @param interval - Check interval in milliseconds
 */
export async function waitFor(
  condition: () => Promise<boolean>,
  timeout: number = 5000,
  interval: number = 100,
): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  throw new Error(`Timeout waiting for condition after ${timeout}ms`);
}

/**
 * Measure execution time of an async function
 *
 * @param fn - Async function to measure
 * @returns Object with result and duration
 */
export async function measureTime<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; duration: number }> {
  const start = performance.now();
  const result = await fn();
  const duration = performance.now() - start;

  return { result, duration };
}

/**
 * Assert that a value is within a range
 *
 * @param value - Value to check
 * @param min - Minimum value (inclusive)
 * @param max - Maximum value (inclusive)
 * @param message - Error message
 */
export function assertInRange(
  value: number,
  min: number,
  max: number,
  message?: string,
): void {
  if (value < min || value > max) {
    throw new Error(
      message ||
        `Expected ${value} to be between ${min} and ${max}`,
    );
  }
}

/**
 * Calculate percentile from sorted array
 *
 * @param sortedArray - Sorted array of numbers
 * @param percentile - Percentile to calculate (0-1)
 * @returns Value at percentile
 */
export function calculatePercentile(
  sortedArray: number[],
  percentile: number,
): number {
  if (sortedArray.length === 0) return 0;
  const index = Math.floor(sortedArray.length * percentile);
  return sortedArray[Math.min(index, sortedArray.length - 1)];
}

/**
 * Create a workflow_pattern for testing
 *
 * Architecture (migration 023): capability_records points to workflow_pattern via FK.
 * This helper creates a workflow_pattern with required fields so tests can create
 * capability_records with valid workflowPatternId.
 *
 * @param db - Database instance
 * @param code - Code snippet (used to generate hash)
 * @returns Pattern ID and 4-char hash for FQDN generation
 */
export async function createTestWorkflowPattern(
  db: PGliteClient,
  code: string,
): Promise<{ patternId: string; hash: string }> {
  const hash = await generateHash(code);
  const patternHash = `test_${hash}_${Date.now()}`;

  // Create fake 1024-dim embedding (required by schema)
  const fakeEmbedding = new Array(1024).fill(0);
  const embeddingStr = `[${fakeEmbedding.join(",")}]`;

  const result = await db.query(
    `
    INSERT INTO workflow_pattern (
      pattern_hash, dag_structure, intent_embedding, code_snippet, code_hash
    ) VALUES (
      $1, $2::jsonb, $3, $4, $5
    )
    RETURNING pattern_id
  `,
    [
      patternHash,
      JSON.stringify({ nodes: [], edges: [] }),
      embeddingStr,
      code,
      hash,
    ],
  );

  const patternId = (result[0] as { pattern_id: string }).pattern_id;
  return { patternId, hash };
}
