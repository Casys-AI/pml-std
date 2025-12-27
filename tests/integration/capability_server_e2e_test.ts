/**
 * Capability MCP Server E2E Integration Test
 *
 * Story 13.3: End-to-end test for capability tools through the Gateway.
 * Tests the complete flow: CapabilityMCPServer → Services → Result
 *
 * Note: Uses mock WorkerBridge to avoid requiring --unstable-worker-options flag.
 * The WorkerBridge itself is tested separately in sandbox tests.
 *
 * @module tests/integration/capability_server_e2e_test
 */

import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { createDefaultClient } from "../../src/db/client.ts";
import { getAllMigrations, MigrationRunner } from "../../src/db/migrations.ts";
import { EmbeddingModel } from "../../src/vector/embeddings.ts";
import { CapabilityStore } from "../../src/capabilities/capability-store.ts";
import { CapabilityRegistry } from "../../src/capabilities/capability-registry.ts";
import { CapabilityMCPServer } from "../../src/mcp/capability-server/mod.ts";
import type { PGliteClient } from "../../src/db/client.ts";
import type { WorkerBridge } from "../../src/sandbox/worker-bridge.ts";

/**
 * Setup test capability in database
 *
 * Creates:
 * 1. workflow_pattern with code_snippet
 * 2. capability_records with FQDN and FK to workflow_pattern
 */
async function setupTestCapability(
  db: PGliteClient,
  embeddingModel: EmbeddingModel,
): Promise<string> {
  // Use unique ID for each test run
  const uniqueId = crypto.randomUUID().slice(0, 8);

  // Generate embedding for intent
  const embedding = await embeddingModel.encode("analyze code structure");
  const embeddingStr = `[${embedding.join(",")}]`;

  // Insert workflow_pattern with unique hash
  const patternHash = `test-hash-${uniqueId}`;
  const codeHash = `code-hash-${uniqueId}`;

  const patternResult = await db.query(
    `
    INSERT INTO workflow_pattern (
      pattern_hash,
      dag_structure,
      intent_embedding,
      usage_count,
      success_count,
      last_used,
      code_snippet,
      code_hash,
      cache_config,
      description,
      success_rate,
      avg_duration_ms,
      parameters_schema,
      permission_set,
      permission_confidence,
      created_at,
      source
    ) VALUES (
      $2,
      '{"type": "code_execution", "tools_used": []}',
      $1::vector,
      5,
      5,
      NOW(),
      'return { analyzed: true, file: context.file };',
      $3,
      '{"ttl_ms": 3600000, "cacheable": true}',
      'Analyze code structure and return analysis result',
      1.0,
      100,
      '{"type": "object", "properties": {"file": {"type": "string", "description": "File to analyze"}}, "required": ["file"]}',
      'minimal',
      0.9,
      NOW(),
      'emergent'
    )
    RETURNING pattern_id
  `,
    [embeddingStr, patternHash, codeHash],
  );

  const patternId = patternResult[0].pattern_id as string;

  // Insert capability_records with FK to workflow_pattern
  const capabilityId = `local.default.code.analyze.${uniqueId}`;

  await db.query(
    `
    INSERT INTO capability_records (
      id,
      display_name,
      org,
      project,
      namespace,
      action,
      hash,
      workflow_pattern_id,
      created_by,
      created_at,
      visibility,
      routing,
      tags
    ) VALUES (
      $2,
      'code:analyze',
      'local',
      'default',
      'code',
      'analyze',
      $3,
      $1,
      'test',
      NOW(),
      'private',
      'local',
      ARRAY[]::text[]
    )
  `,
    [patternId, capabilityId, uniqueId],
  );

  return patternId;
}

/**
 * Create mock WorkerBridge that simulates successful execution
 *
 * This allows testing the CapabilityMCPServer without requiring
 * actual Deno worker permissions.
 */
function createMockWorkerBridge(): WorkerBridge {
  return {
    execute: async (
      code: string,
      _toolDefinitions: unknown[],
      context?: Record<string, unknown>,
      _capabilityContext?: string,
      _parentTraceId?: string,
    ) => {
      // Simulate execution - return result based on code
      if (code.includes("analyzed")) {
        return {
          success: true,
          result: { analyzed: true, file: context?.file ?? "unknown" },
        };
      }
      return {
        success: true,
        result: { executed: true, code_length: code.length },
      };
    },
    close: () => {},
  } as unknown as WorkerBridge;
}

Deno.test({
  name: "Capability Server E2E - Full integration with CapabilityMCPServer",
  async fn() {
    // 1. Setup database
    const db = createDefaultClient();
    await db.connect();

    const runner = new MigrationRunner(db);
    await runner.runUp(getAllMigrations());

    // 2. Initialize embedding model
    const embeddingModel = new EmbeddingModel();
    await embeddingModel.load();

    // 3. Setup test capability
    await setupTestCapability(db, embeddingModel);

    try {
      // 4. Initialize capability components
      const capabilityStore = new CapabilityStore(db, embeddingModel);
      const capabilityRegistry = new CapabilityRegistry(db);

      // 5. Create CapabilityMCPServer with mock WorkerBridge
      const mockWorkerBridge = createMockWorkerBridge();
      const capabilityServer = new CapabilityMCPServer(
        capabilityStore,
        capabilityRegistry,
        mockWorkerBridge,
      );

      // 6. Test listing tools - should include our test capability
      const tools = await capabilityServer.handleListTools();
      console.log("Listed tools:", tools.map((t) => t.name));

      // Find our test capability
      const analyzeTools = tools.filter((t) => t.name.includes("code__analyze"));
      console.log("Analyze tools found:", analyzeTools.length);

      // 7. Test calling the capability
      const callResult = await capabilityServer.handleCallTool(
        "mcp__code__analyze",
        { file: "src/main.ts" },
      );

      console.log("Capability call result:", JSON.stringify(callResult, null, 2));

      // 8. Verify result structure
      assertExists(callResult);
      assertEquals(callResult.success, true);
      assertExists(callResult.data);

      const data = callResult.data as { analyzed?: boolean; file?: string };
      assertEquals(data.analyzed, true);
      assertEquals(data.file, "src/main.ts");

      // 9. Verify latency was tracked
      assertEquals(callResult.latencyMs >= 0, true);
    } finally {
      // Cleanup
      await db.close();
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "Capability Server E2E - Unknown capability returns error",
  async fn() {
    // 1. Setup database
    const db = createDefaultClient();
    await db.connect();

    const runner = new MigrationRunner(db);
    await runner.runUp(getAllMigrations());

    // 2. Initialize embedding model
    const embeddingModel = new EmbeddingModel();
    await embeddingModel.load();

    try {
      // 3. Initialize components (NO test capability created!)
      const capabilityStore = new CapabilityStore(db, embeddingModel);
      const capabilityRegistry = new CapabilityRegistry(db);

      // 4. Create CapabilityMCPServer with mock WorkerBridge
      const mockWorkerBridge = createMockWorkerBridge();
      const capabilityServer = new CapabilityMCPServer(
        capabilityStore,
        capabilityRegistry,
        mockWorkerBridge,
      );

      // 5. Try calling non-existent capability
      const callResult = await capabilityServer.handleCallTool(
        "mcp__nonexistent__capability",
        {},
      );

      console.log("Error result:", JSON.stringify(callResult, null, 2));

      // 6. Verify error response
      assertEquals(callResult.success, false);
      assertExists(callResult.error);
      assertStringIncludes(callResult.error.toLowerCase(), "not found");
    } finally {
      await db.close();
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "Capability Server E2E - AC7: Immediate visibility of new capabilities",
  async fn() {
    // 1. Setup database
    const db = createDefaultClient();
    await db.connect();

    const runner = new MigrationRunner(db);
    await runner.runUp(getAllMigrations());

    // 2. Initialize embedding model
    const embeddingModel = new EmbeddingModel();
    await embeddingModel.load();

    try {
      // 3. Initialize components
      const capabilityStore = new CapabilityStore(db, embeddingModel);
      const capabilityRegistry = new CapabilityRegistry(db);

      // 4. Create CapabilityMCPServer with mock WorkerBridge
      const mockWorkerBridge = createMockWorkerBridge();
      const capabilityServer = new CapabilityMCPServer(
        capabilityStore,
        capabilityRegistry,
        mockWorkerBridge,
      );

      // 5. Get initial tool count
      const toolsBefore = await capabilityServer.handleListTools();
      const countBefore = toolsBefore.length;
      console.log("Tools before:", countBefore);

      // 6. Create a new capability in the database
      await setupTestCapability(db, embeddingModel);

      // 7. List tools again - should see the new capability IMMEDIATELY (no cache)
      const toolsAfter = await capabilityServer.handleListTools();
      const countAfter = toolsAfter.length;
      console.log("Tools after:", countAfter);

      // 8. Verify immediate visibility (AC7)
      assertEquals(countAfter, countBefore + 1, "New capability should be immediately visible");

      // 9. Verify the new capability is in the list
      const newCapability = toolsAfter.find((t) => t.name.includes("code__analyze"));
      assertExists(newCapability, "New capability should be findable");
      assertEquals(newCapability.name, "mcp__code__analyze");
    } finally {
      await db.close();
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
