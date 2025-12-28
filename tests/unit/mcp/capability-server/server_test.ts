/**
 * Tests for CapabilityMCPServer (Migration 028)
 *
 * Story 13.3: CapabilityMCPServer + Gateway
 * AC5: Usage Tracking - records usage metrics after execution
 *
 * Note: displayName was removed in migration 028.
 * Display name is now computed as namespace:action.
 * ID is now a UUID, not FQDN.
 */

import { assertEquals, assertExists } from "@std/assert";
import { CapabilityMCPServer } from "../../../../src/mcp/capability-server/server.ts";
import type {
  Capability,
  CapabilityRecord,
  CapabilityWithSchema,
  ListWithSchemasOptions,
  Scope,
} from "../../../../src/capabilities/types.ts";

// Mock CapabilityStore
class MockCapabilityStore {
  private capabilities: CapabilityWithSchema[] = [];
  private patterns: Map<string, Capability> = new Map();

  setCapabilities(caps: CapabilityWithSchema[]): void {
    this.capabilities = caps;
  }

  setPattern(id: string, pattern: Partial<Capability>): void {
    this.patterns.set(id, pattern as Capability);
  }

  async listWithSchemas(_options: ListWithSchemasOptions): Promise<CapabilityWithSchema[]> {
    return this.capabilities;
  }

  async findById(id: string): Promise<Capability | null> {
    return this.patterns.get(id) || null;
  }
}

// Mock CapabilityRegistry with usage tracking (Migration 028: UUID id, no displayName)
class MockCapabilityRegistry {
  private records: Map<string, CapabilityRecord> = new Map();
  public recordedUsages: Array<{ id: string; success: boolean; latencyMs: number }> = [];

  setRecord(nameKey: string, record: Partial<CapabilityRecord>): void {
    this.records.set(nameKey, record as CapabilityRecord);
  }

  async resolveByName(name: string, _scope: Scope): Promise<CapabilityRecord | null> {
    return this.records.get(name) || null;
  }

  async recordUsage(id: string, success: boolean, latencyMs: number): Promise<void> {
    this.recordedUsages.push({ id, success, latencyMs });
  }
}

// Mock WorkerBridge
class MockWorkerBridge {
  private mockResult: unknown = { output: "success" };
  private shouldSucceed = true;
  private mockError = "Execution failed";

  setSuccess(result: unknown): void {
    this.shouldSucceed = true;
    this.mockResult = result;
  }

  setFailure(error: string): void {
    this.shouldSucceed = false;
    this.mockError = error;
  }

  async execute(
    _code: string,
    _toolDefinitions: unknown[],
    _context?: Record<string, unknown>,
    _capabilityContext?: string,
    _parentTraceId?: string,
  ): Promise<{ success: boolean; result?: unknown; error?: { type: string; message: string } }> {
    if (this.shouldSucceed) {
      return { success: true, result: this.mockResult };
    } else {
      return { success: false, error: { type: "execution", message: this.mockError } };
    }
  }
}

// Helper to create full test setup
function createTestSetup() {
  const mockStore = new MockCapabilityStore();
  const mockRegistry = new MockCapabilityRegistry();
  const mockBridge = new MockWorkerBridge();

  const capabilityUuid = "550e8400-e29b-41d4-a716-446655440001";

  // Setup capability in store listing (no displayName)
  mockStore.setCapabilities([
    {
      id: "pattern-123",
      namespace: "code",
      action: "analyze",
      description: "Analyze code structure",
      parametersSchema: { type: "object", properties: { file: { type: "string" } } },
      usageCount: 10,
    },
  ]);

  // Setup registry record (UUID id, no displayName)
  mockRegistry.setRecord("code:analyze", {
    id: capabilityUuid, // UUID now
    org: "local",
    project: "default",
    namespace: "code",
    action: "analyze",
    hash: "a1b2",
    workflowPatternId: "pattern-123",
    createdBy: "local",
    createdAt: new Date(),
    version: 1,
    verified: false,
    usageCount: 10,
    successCount: 10,
    totalLatencyMs: 1000,
    tags: [],
    visibility: "private",
    routing: "local",
  });

  // Setup pattern in store
  mockStore.setPattern("pattern-123", {
    id: "pattern-123",
    codeSnippet: "return analyzeCode(file);",
    codeHash: "abc123",
    intentEmbedding: new Float32Array(0),
    usageCount: 10,
    successCount: 10,
    successRate: 1.0,
    avgDurationMs: 100,
    createdAt: new Date(),
    lastUsed: new Date(),
    source: "emergent",
    cacheConfig: { ttl_ms: 3600000, cacheable: true },
    permissionSet: "minimal",
    permissionConfidence: 0.9,
  });

  return { mockStore, mockRegistry, mockBridge, capabilityUuid };
}

Deno.test("CapabilityMCPServer - handleListTools returns capability tools", async () => {
  const { mockStore, mockRegistry, mockBridge } = createTestSetup();

  // @ts-ignore - mocks
  const server = new CapabilityMCPServer(mockStore, mockRegistry, mockBridge);

  const tools = await server.handleListTools();

  assertEquals(tools.length, 1);
  assertEquals(tools[0].name, "mcp__code__analyze");
  assertEquals(tools[0].description, "Analyze code structure");
  assertExists(tools[0].inputSchema);
});

Deno.test("CapabilityMCPServer - handleCallTool executes and returns result", async () => {
  const { mockStore, mockRegistry, mockBridge } = createTestSetup();
  mockBridge.setSuccess({ analysis: "Code looks good" });

  // @ts-ignore - mocks
  const server = new CapabilityMCPServer(mockStore, mockRegistry, mockBridge);

  const result = await server.handleCallTool("mcp__code__analyze", { file: "test.ts" });

  assertEquals(result.success, true);
  assertExists(result.data);
  assertEquals((result.data as { analysis: string }).analysis, "Code looks good");
});

Deno.test("CapabilityMCPServer - AC5: records usage after successful execution", async () => {
  const { mockStore, mockRegistry, mockBridge, capabilityUuid } = createTestSetup();
  mockBridge.setSuccess({ result: "ok" });

  // @ts-ignore - mocks
  const server = new CapabilityMCPServer(mockStore, mockRegistry, mockBridge);

  await server.handleCallTool("mcp__code__analyze", { file: "test.ts" });

  // Verify usage was recorded with UUID
  assertEquals(mockRegistry.recordedUsages.length, 1);
  assertEquals(mockRegistry.recordedUsages[0].id, capabilityUuid);
  assertEquals(mockRegistry.recordedUsages[0].success, true);
  assertEquals(mockRegistry.recordedUsages[0].latencyMs >= 0, true);
});

Deno.test("CapabilityMCPServer - AC5: records usage after failed execution", async () => {
  const { mockStore, mockRegistry, mockBridge } = createTestSetup();
  mockBridge.setFailure("Analysis failed");

  // @ts-ignore - mocks
  const server = new CapabilityMCPServer(mockStore, mockRegistry, mockBridge);

  await server.handleCallTool("mcp__code__analyze", { file: "test.ts" });

  // Verify usage was recorded even for failure
  assertEquals(mockRegistry.recordedUsages.length, 1);
  assertEquals(mockRegistry.recordedUsages[0].success, false);
});

Deno.test("CapabilityMCPServer - usage tracking can be disabled", async () => {
  const { mockStore, mockRegistry, mockBridge } = createTestSetup();
  mockBridge.setSuccess({ result: "ok" });

  // @ts-ignore - mocks
  const server = new CapabilityMCPServer(mockStore, mockRegistry, mockBridge, {
    trackUsage: false,
  });

  await server.handleCallTool("mcp__code__analyze", { file: "test.ts" });

  // Verify no usage was recorded
  assertEquals(mockRegistry.recordedUsages.length, 0);
});

Deno.test("CapabilityMCPServer - isCapabilityTool identifies capability tools", () => {
  const { mockStore, mockRegistry, mockBridge } = createTestSetup();

  // @ts-ignore - mocks
  const server = new CapabilityMCPServer(mockStore, mockRegistry, mockBridge);

  // Capability tools
  assertEquals(server.isCapabilityTool("mcp__code__analyze"), true);
  assertEquals(server.isCapabilityTool("mcp__data__transform"), true);
  assertEquals(server.isCapabilityTool("mcp__api__fetch"), true);

  // Native MCP tools
  assertEquals(server.isCapabilityTool("filesystem:read_file"), false);
  assertEquals(server.isCapabilityTool("github:create_issue"), false);
  assertEquals(server.isCapabilityTool("pml_execute"), false);
});

Deno.test("CapabilityMCPServer - handleCallTool returns error for unknown tool", async () => {
  const mockStore = new MockCapabilityStore();
  const mockRegistry = new MockCapabilityRegistry();
  const mockBridge = new MockWorkerBridge();

  // No capabilities set up

  // @ts-ignore - mocks
  const server = new CapabilityMCPServer(mockStore, mockRegistry, mockBridge);

  const result = await server.handleCallTool("mcp__unknown__tool", {});

  assertEquals(result.success, false);
  assertExists(result.error);
  assertEquals(result.error.includes("not found"), true);
});

Deno.test("CapabilityMCPServer - handleListTools returns empty for no capabilities", async () => {
  const mockStore = new MockCapabilityStore();
  const mockRegistry = new MockCapabilityRegistry();
  const mockBridge = new MockWorkerBridge();

  // No capabilities

  // @ts-ignore - mocks
  const server = new CapabilityMCPServer(mockStore, mockRegistry, mockBridge);

  const tools = await server.handleListTools();

  assertEquals(tools.length, 0);
});
