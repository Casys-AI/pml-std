/**
 * Tests for CapabilityExecutorService
 *
 * Story 13.3: CapabilityMCPServer + Gateway
 * AC2: Tool Execution - executes capability code via sandbox
 * AC3: Error Handling - returns error for non-existent capability
 */

import { assertEquals, assertExists } from "@std/assert";
import { CapabilityExecutorService } from "../../../../src/mcp/capability-server/services/capability-executor.ts";
import type { Capability } from "../../../../src/capabilities/types.ts";
import type { CapabilityRecord, Scope } from "../../../../src/capabilities/types.ts";

// Mock CapabilityStore
class MockCapabilityStore {
  private patterns: Map<string, Capability> = new Map();

  setPattern(id: string, pattern: Partial<Capability>): void {
    this.patterns.set(id, pattern as Capability);
  }

  async findById(id: string): Promise<Capability | null> {
    return this.patterns.get(id) || null;
  }
}

// Mock CapabilityRegistry
class MockCapabilityRegistry {
  private records: Map<string, CapabilityRecord> = new Map();

  setRecord(displayName: string, record: Partial<CapabilityRecord>): void {
    this.records.set(displayName, record as CapabilityRecord);
  }

  async resolveByName(name: string, _scope: Scope): Promise<CapabilityRecord | null> {
    return this.records.get(name) || null;
  }
}

// Mock WorkerBridge
class MockWorkerBridge {
  private shouldSucceed = true;
  private mockResult: unknown = { output: "success" };
  private mockError = "Execution failed";
  public lastExecutedCode: string | null = null;
  public lastContext: Record<string, unknown> | null = null;

  setSuccess(result: unknown): void {
    this.shouldSucceed = true;
    this.mockResult = result;
  }

  setFailure(error: string): void {
    this.shouldSucceed = false;
    this.mockError = error;
  }

  async execute(
    code: string,
    _toolDefinitions: unknown[],
    context?: Record<string, unknown>,
    _capabilityContext?: string,
    _parentTraceId?: string,
  ): Promise<{ success: boolean; result?: unknown; error?: { type: string; message: string } }> {
    this.lastExecutedCode = code;
    this.lastContext = context || null;

    if (this.shouldSucceed) {
      return { success: true, result: this.mockResult };
    } else {
      // Return StructuredError-like object
      return { success: false, error: { type: "execution", message: this.mockError } };
    }
  }
}

Deno.test("CapabilityExecutorService - invalid tool name format", async () => {
  const mockStore = new MockCapabilityStore();
  const mockRegistry = new MockCapabilityRegistry();
  const mockBridge = new MockWorkerBridge();

  // @ts-ignore - mocks
  const executor = new CapabilityExecutorService(mockStore, mockRegistry, mockBridge);

  const result = await executor.execute("invalid_format", {});

  assertEquals(result.success, false);
  assertExists(result.error);
  assertEquals(result.error.includes("Invalid tool name format"), true);
  assertEquals(result.latencyMs >= 0, true);
});

Deno.test("CapabilityExecutorService - AC3: capability not found", async () => {
  const mockStore = new MockCapabilityStore();
  const mockRegistry = new MockCapabilityRegistry();
  const mockBridge = new MockWorkerBridge();

  // Registry returns null for unknown capability
  // @ts-ignore - mocks
  const executor = new CapabilityExecutorService(mockStore, mockRegistry, mockBridge);

  const result = await executor.execute("mcp__code__analyze", { file: "test.ts" });

  assertEquals(result.success, false);
  assertExists(result.error);
  assertEquals(result.error.includes("Capability not found"), true);
});

Deno.test("CapabilityExecutorService - capability has no workflow pattern", async () => {
  const mockStore = new MockCapabilityStore();
  const mockRegistry = new MockCapabilityRegistry();
  const mockBridge = new MockWorkerBridge();

  // Registry returns record without workflowPatternId
  mockRegistry.setRecord("code:analyze", {
    id: "local.default.code.analyze.a1b2",
    org: "local",
    project: "default",
    namespace: "code",
    action: "analyze",
    hash: "a1b2",
    workflowPatternId: undefined, // No FK!
    createdBy: "local",
    createdAt: new Date(),
    version: 1,
    verified: false,
    usageCount: 0,
    successCount: 0,
    totalLatencyMs: 0,
    tags: [],
    visibility: "private",
    routing: "local",
  });

  // @ts-ignore - mocks
  const executor = new CapabilityExecutorService(mockStore, mockRegistry, mockBridge);

  const result = await executor.execute("mcp__code__analyze", { file: "test.ts" });

  assertEquals(result.success, false);
  assertExists(result.error);
  assertEquals(result.error.includes("has no code"), true);
});

Deno.test("CapabilityExecutorService - workflow pattern has no code", async () => {
  const mockStore = new MockCapabilityStore();
  const mockRegistry = new MockCapabilityRegistry();
  const mockBridge = new MockWorkerBridge();

  // Registry returns record with FK
  mockRegistry.setRecord("code:analyze", {
    id: "local.default.code.analyze.a1b2",
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
    usageCount: 0,
    successCount: 0,
    totalLatencyMs: 0,
    tags: [],
    visibility: "private",
    routing: "local",
  });

  // Store returns pattern without code
  mockStore.setPattern("pattern-123", {
    id: "pattern-123",
    codeSnippet: "", // Empty code
    codeHash: "abc",
    intentEmbedding: new Float32Array(0),
    usageCount: 0,
    successCount: 0,
    successRate: 0,
    avgDurationMs: 0,
    createdAt: new Date(),
    lastUsed: new Date(),
    source: "emergent",
    cacheConfig: { ttl_ms: 3600000, cacheable: true },
    permissionSet: "minimal",
    permissionConfidence: 0,
  });

  // @ts-ignore - mocks
  const executor = new CapabilityExecutorService(mockStore, mockRegistry, mockBridge);

  const result = await executor.execute("mcp__code__analyze", { file: "test.ts" });

  assertEquals(result.success, false);
  assertExists(result.error);
  assertEquals(result.error.includes("has no code"), true);
});

Deno.test("CapabilityExecutorService - AC2: successful execution", async () => {
  const mockStore = new MockCapabilityStore();
  const mockRegistry = new MockCapabilityRegistry();
  const mockBridge = new MockWorkerBridge();

  // Setup successful execution
  mockRegistry.setRecord("code:analyze", {
    id: "local.default.code.analyze.a1b2",
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
    usageCount: 5,
    successCount: 5,
    totalLatencyMs: 500,
    tags: [],
    visibility: "private",
    routing: "local",
  });

  mockStore.setPattern("pattern-123", {
    id: "pattern-123",
    codeSnippet: "const result = analyzeCode(file); return result;",
    codeHash: "abc123",
    intentEmbedding: new Float32Array(0),
    usageCount: 5,
    successCount: 5,
    successRate: 1.0,
    avgDurationMs: 100,
    createdAt: new Date(),
    lastUsed: new Date(),
    source: "emergent",
    cacheConfig: { ttl_ms: 3600000, cacheable: true },
    permissionSet: "minimal",
    permissionConfidence: 0.9,
  });

  mockBridge.setSuccess({ analysis: "Code looks good", issues: 0 });

  // @ts-ignore - mocks
  const executor = new CapabilityExecutorService(mockStore, mockRegistry, mockBridge);

  const result = await executor.execute("mcp__code__analyze", { file: "src/main.ts" });

  assertEquals(result.success, true);
  assertExists(result.data);
  assertEquals((result.data as { analysis: string }).analysis, "Code looks good");
  assertEquals(result.latencyMs >= 0, true);
  assertEquals(result.error, undefined);

  // Verify bridge received correct code
  assertEquals(mockBridge.lastExecutedCode, "const result = analyzeCode(file); return result;");
  assertExists(mockBridge.lastContext);
  assertEquals(mockBridge.lastContext.file, "src/main.ts");
});

Deno.test("CapabilityExecutorService - execution failure from bridge", async () => {
  const mockStore = new MockCapabilityStore();
  const mockRegistry = new MockCapabilityRegistry();
  const mockBridge = new MockWorkerBridge();

  // Setup execution that fails
  mockRegistry.setRecord("data:transform", {
    id: "local.default.data.transform.b2c3",
    org: "local",
    project: "default",
    namespace: "data",
    action: "transform",
    hash: "b2c3",
    workflowPatternId: "pattern-456",
    createdBy: "local",
    createdAt: new Date(),
    version: 1,
    verified: false,
    usageCount: 0,
    successCount: 0,
    totalLatencyMs: 0,
    tags: [],
    visibility: "private",
    routing: "local",
  });

  mockStore.setPattern("pattern-456", {
    id: "pattern-456",
    codeSnippet: "throw new Error('Transform failed');",
    codeHash: "def456",
    intentEmbedding: new Float32Array(0),
    usageCount: 0,
    successCount: 0,
    successRate: 0,
    avgDurationMs: 0,
    createdAt: new Date(),
    lastUsed: new Date(),
    source: "emergent",
    cacheConfig: { ttl_ms: 3600000, cacheable: true },
    permissionSet: "minimal",
    permissionConfidence: 0,
  });

  mockBridge.setFailure("Transform operation failed: invalid input");

  // @ts-ignore - mocks
  const executor = new CapabilityExecutorService(mockStore, mockRegistry, mockBridge);

  const result = await executor.execute("mcp__data__transform", { input: "bad data" });

  assertEquals(result.success, false);
  assertEquals(result.data, null);
  assertExists(result.error);
  assertEquals(result.error, "Transform operation failed: invalid input");
  assertEquals(result.latencyMs >= 0, true);
});

Deno.test("CapabilityExecutorService - context includes capability metadata", async () => {
  const mockStore = new MockCapabilityStore();
  const mockRegistry = new MockCapabilityRegistry();
  const mockBridge = new MockWorkerBridge();

  mockRegistry.setRecord("api:fetch", {
    id: "local.default.api.fetch.c3d4",
    org: "local",
    project: "default",
    namespace: "api",
    action: "fetch",
    hash: "c3d4",
    workflowPatternId: "pattern-789",
    createdBy: "local",
    createdAt: new Date(),
    version: 1,
    verified: false,
    usageCount: 0,
    successCount: 0,
    totalLatencyMs: 0,
    tags: [],
    visibility: "private",
    routing: "local",
  });

  mockStore.setPattern("pattern-789", {
    id: "pattern-789",
    codeSnippet: "return await fetch(url);",
    codeHash: "ghi789",
    intentEmbedding: new Float32Array(0),
    usageCount: 0,
    successCount: 0,
    successRate: 0,
    avgDurationMs: 0,
    createdAt: new Date(),
    lastUsed: new Date(),
    source: "emergent",
    cacheConfig: { ttl_ms: 3600000, cacheable: true },
    permissionSet: "minimal",
    permissionConfidence: 0,
  });

  mockBridge.setSuccess({ response: "OK" });

  // @ts-ignore - mocks
  const executor = new CapabilityExecutorService(mockStore, mockRegistry, mockBridge);

  await executor.execute("mcp__api__fetch", { url: "https://example.com" });

  // Verify context includes metadata
  assertExists(mockBridge.lastContext);
  assertEquals(mockBridge.lastContext.__capability_fqdn, "local.default.api.fetch.c3d4");
  assertEquals(mockBridge.lastContext.__capability_name, "api:fetch");
  assertEquals(mockBridge.lastContext.url, "https://example.com");
});
