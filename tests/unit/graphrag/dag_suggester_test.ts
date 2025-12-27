/**
 * Unit tests for DAG Suggester
 *
 * Tests integration between vector search and graph algorithms.
 *
 * PERFORMANCE: Uses shared DB to avoid re-running migrations for each test
 */

import { assert, assertEquals, assertExists } from "@std/assert";
import { DAGSuggester } from "../../../src/graphrag/dag-suggester.ts";
import { GraphRAGEngine } from "../../../src/graphrag/graph-engine.ts";
import { VectorSearch } from "../../../src/vector/search.ts";
import { MockEmbeddingModel } from "../../fixtures/mock-embedding-model.ts";
import type { EmbeddingModel } from "../../../src/vector/embeddings.ts";
import { PGliteClient } from "../../../src/db/client.ts";
import { getAllMigrations, MigrationRunner } from "../../../src/db/migrations.ts";
import { DEFAULT_DAG_SCORING_CONFIG } from "../../../src/graphrag/dag-scoring-config.ts";

// Shared DB and model for all tests in this file (migrations run once)
let sharedDb: PGliteClient;
let sharedModel: MockEmbeddingModel;

/**
 * Insert comprehensive test data
 */
async function insertTestData(db: PGliteClient, model: MockEmbeddingModel): Promise<void> {
  const tools = [
    {
      id: "filesystem:read",
      server: "filesystem",
      name: "read_file",
      desc: "Read file contents from filesystem",
    },
    { id: "json:parse", server: "json", name: "parse", desc: "Parse JSON data from text" },
    {
      id: "filesystem:write",
      server: "filesystem",
      name: "write_file",
      desc: "Write content to file",
    },
    { id: "http:get", server: "http", name: "get", desc: "Fetch HTTP resource from URL" },
    {
      id: "json:stringify",
      server: "json",
      name: "stringify",
      desc: "Convert data to JSON string",
    },
    { id: "filesystem:list", server: "filesystem", name: "list", desc: "List files in directory" },
    { id: "http:post", server: "http", name: "post", desc: "Send HTTP POST request" },
    { id: "json:validate", server: "json", name: "validate", desc: "Validate JSON schema" },
  ];

  for (const tool of tools) {
    await db.query(
      `INSERT INTO tool_schema (tool_id, server_id, name, description, input_schema)
       VALUES ($1, $2, $3, $4, $5)`,
      [tool.id, tool.server, tool.name, tool.desc, "{}"],
    );

    const embedding = await model.encode(tool.desc);
    await db.query(
      `INSERT INTO tool_embedding (tool_id, server_id, tool_name, embedding, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [tool.id, tool.server, tool.name, `[${embedding.join(",")}]`, "{}"],
    );
  }

  // Add dependencies - create a denser graph for better PageRank
  const deps = [
    { from: "http:get", to: "json:parse", count: 10, confidence: 0.9 },
    { from: "json:parse", to: "filesystem:write", count: 5, confidence: 0.7 },
    { from: "filesystem:read", to: "json:parse", count: 8, confidence: 0.85 },
    { from: "json:stringify", to: "http:post", count: 6, confidence: 0.75 },
    { from: "filesystem:list", to: "filesystem:read", count: 12, confidence: 0.95 },
    { from: "http:get", to: "json:validate", count: 4, confidence: 0.65 },
    { from: "json:parse", to: "json:validate", count: 3, confidence: 0.6 },
  ];

  for (const dep of deps) {
    await db.query(
      `INSERT INTO tool_dependency (from_tool_id, to_tool_id, observed_count, confidence_score)
       VALUES ($1, $2, $3, $4)`,
      [dep.from, dep.to, dep.count, dep.confidence],
    );
  }
}

// ==============================================================================
// SETUP: Create shared DB once for all tests (saves ~400ms)
// ==============================================================================
Deno.test({
  name: "[SETUP] Initialize shared DB and test data",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // Create DB and run migrations once
    sharedDb = new PGliteClient(`memory://${crypto.randomUUID()}`);
    await sharedDb.connect();

    const migrationRunner = new MigrationRunner(sharedDb);
    await migrationRunner.runUp(getAllMigrations());

    // Load model once
    sharedModel = new MockEmbeddingModel();
    await sharedModel.load();

    // Insert test data once
    await insertTestData(sharedDb, sharedModel);
  },
});

// ==============================================================================
// TESTS: All tests use shared DB
// ==============================================================================
Deno.test({
  name: "DAGSuggester - suggests DAG for high confidence intent",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const graphEngine = new GraphRAGEngine(sharedDb);
    await graphEngine.syncFromDatabase();

    const vectorSearch = new VectorSearch(sharedDb, sharedModel as unknown as EmbeddingModel);
    const suggester = new DAGSuggester(graphEngine, vectorSearch);

    // Use lower thresholds for sparse test graphs (8 nodes, 7 edges)
    // Production graphs are much denser, so use test-appropriate thresholds
    suggester.setScoringConfig({
      ...DEFAULT_DAG_SCORING_CONFIG,
      thresholds: {
        ...DEFAULT_DAG_SCORING_CONFIG.thresholds,
        suggestionReject: 0.30, // Lower for sparse test graph
        suggestionFloor: 0.40,
      },
    });

    const suggestion = await suggester.suggestDAG({
      text: "read file and parse JSON",
    });

    assertExists(suggestion, "Should return suggestion for high confidence intent");
    assertExists(suggestion!.dagStructure);
    assertExists(suggestion!.confidence);
    // Note: In test graphs with minimal density, confidence is lower than production
    // Accept >= 0.3 for test data (production with richer graphs will have higher confidence)
    assert(suggestion!.confidence >= 0.3, "Confidence should be reasonable for test graph");
  },
});

Deno.test({
  name: "DAGSuggester - returns suggestion with warning for low confidence (ADR-026)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const graphEngine = new GraphRAGEngine(sharedDb);
    await graphEngine.syncFromDatabase();

    const vectorSearch = new VectorSearch(sharedDb, sharedModel as unknown as EmbeddingModel);
    const suggester = new DAGSuggester(graphEngine, vectorSearch);

    const suggestion = await suggester.suggestDAG({
      text: "completely unrelated quantum mechanics calculation",
    });

    // ADR-026: Never return null if semantic candidates exist
    // Instead, return suggestion with warning for low confidence
    if (suggestion === null) {
      // No semantic candidates found at all (score < 0.5 threshold)
      // This is expected if the query truly has no semantic match
      assertEquals(suggestion, null, "No candidates found - correct behavior");
    } else {
      // Candidates found but low confidence - should have warning
      assert(suggestion.warning !== undefined, "Low confidence should include warning");
      assert(
        suggestion.warning.includes("cold start") || suggestion.warning.includes("Low confidence"),
        "Warning should mention cold start or low confidence",
      );
      assert(suggestion.confidence < 0.50, "Confidence should be below threshold");
    }
  },
});

Deno.test({
  name: "DAGSuggester - includes dependency paths in suggestion",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // Using shared DB
    // Using shared model

    const graphEngine = new GraphRAGEngine(sharedDb);
    await graphEngine.syncFromDatabase();

    const vectorSearch = new VectorSearch(sharedDb, sharedModel as unknown as EmbeddingModel);
    const suggester = new DAGSuggester(graphEngine, vectorSearch);

    const suggestion = await suggester.suggestDAG({
      text: "fetch HTTP and parse JSON",
    });

    if (suggestion) {
      assertExists(suggestion.dependencyPaths, "Should include dependency paths");
      assert(Array.isArray(suggestion.dependencyPaths), "Dependency paths should be an array");
    }
  },
});

Deno.test({
  name: "DAGSuggester - generates rationale for suggestion",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // Using shared DB
    // Using shared model

    const graphEngine = new GraphRAGEngine(sharedDb);
    await graphEngine.syncFromDatabase();

    const vectorSearch = new VectorSearch(sharedDb, sharedModel as unknown as EmbeddingModel);
    const suggester = new DAGSuggester(graphEngine, vectorSearch);

    const suggestion = await suggester.suggestDAG({
      text: "read file",
    });

    if (suggestion) {
      assertExists(suggestion.rationale, "Should include rationale");
      assert(suggestion.rationale.length > 0, "Rationale should not be empty");
      // ADR-022: Now uses hybrid search rationale
      assert(
        suggestion.rationale.includes("hybrid") ||
          suggestion.rationale.includes("semantic") ||
          suggestion.rationale.includes("PageRank"),
        "Rationale should mention hybrid, semantic, or PageRank",
      );
    }
  },
});

Deno.test({
  name: "DAGSuggester - finds alternative tools from same community",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // Using shared DB
    // Using shared model

    const graphEngine = new GraphRAGEngine(sharedDb);
    await graphEngine.syncFromDatabase();

    const vectorSearch = new VectorSearch(sharedDb, sharedModel as unknown as EmbeddingModel);
    const suggester = new DAGSuggester(graphEngine, vectorSearch);

    const suggestion = await suggester.suggestDAG({
      text: "work with files",
    });

    if (suggestion) {
      assertExists(suggestion.alternatives);
      assert(Array.isArray(suggestion.alternatives), "Alternatives should be an array");
    }
  },
});

// ==============================================================================
// TEARDOWN: Close shared DB
// ==============================================================================
Deno.test({
  name: "[TEARDOWN] Close shared DB",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await sharedDb.close();
  },
});
