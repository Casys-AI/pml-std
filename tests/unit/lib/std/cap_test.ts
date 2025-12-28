/**
 * Unit tests for lib/std/cap.ts (Migration 028)
 *
 * Story 13.5: Capability Management Tools
 *
 * Tests cap:list, cap:rename, cap:lookup, cap:whois
 *
 * Note: displayName and aliases were removed in migration 028.
 * Display name is now computed as namespace:action.
 * ID is now a UUID, not FQDN.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { CapModule, globToSqlLike, PmlStdServer } from "../../../../lib/std/cap.ts";

// =============================================================================
// globToSqlLike Tests
// =============================================================================

Deno.test("globToSqlLike - converts * to %", () => {
  assertEquals(globToSqlLike("fs:*"), "fs:%");
  assertEquals(globToSqlLike("*reader"), "%reader");
  assertEquals(globToSqlLike("read*json"), "read%json");
});

Deno.test("globToSqlLike - converts ? to _", () => {
  assertEquals(globToSqlLike("read_?"), "read\\__");
  assertEquals(globToSqlLike("file?"), "file_");
});

Deno.test("globToSqlLike - escapes existing % and _", () => {
  assertEquals(globToSqlLike("100%"), "100\\%");
  assertEquals(globToSqlLike("file_name"), "file\\_name");
  assertEquals(globToSqlLike("api:get_*"), "api:get\\_%");
});

Deno.test("globToSqlLike - complex patterns", () => {
  // fs:read_?_* → escape _ → fs:read\_?\_* → * to % → fs:read\_?\_% → ? to _ → fs:read\__\_%
  assertEquals(globToSqlLike("fs:read_?_*"), "fs:read\\__\\_%");
  assertEquals(globToSqlLike("*:*"), "%:%");
});

// Edge case tests (M2 - Code Review Fix)
Deno.test("globToSqlLike - empty pattern", () => {
  assertEquals(globToSqlLike(""), "");
});

Deno.test("globToSqlLike - SQL injection attempts are escaped", () => {
  // SQL special characters should be escaped
  assertEquals(globToSqlLike("'; DROP TABLE--"), "'; DROP TABLE--");
  assertEquals(globToSqlLike("test%injection"), "test\\%injection");
  assertEquals(globToSqlLike("user_input"), "user\\_input");
  // The * and ? are converted, but other SQL chars are harmless in LIKE
  assertEquals(globToSqlLike("*'; DELETE *"), "%'; DELETE %");
});

Deno.test("globToSqlLike - unicode patterns", () => {
  assertEquals(globToSqlLike("读取*"), "读取%");
  assertEquals(globToSqlLike("émoji:🔥*"), "émoji:🔥%");
  assertEquals(globToSqlLike("データ_?"), "データ\\__");
});

// =============================================================================
// Mock Database and Registry (Migration 028: UUID PK, no displayName/aliases)
// =============================================================================

interface MockRow {
  [key: string]: unknown;
}

class MockDb {
  public queries: Array<{ sql: string; params: unknown[] }> = [];
  public mockRows: MockRow[] = [];

  query(sql: string, params: unknown[] = []): Promise<MockRow[]> {
    this.queries.push({ sql, params });
    return Promise.resolve(this.mockRows);
  }

  setMockRows(rows: MockRow[]): void {
    this.mockRows = rows;
  }

  getLastQuery(): { sql: string; params: unknown[] } | undefined {
    return this.queries[this.queries.length - 1];
  }

  clearQueries(): void {
    this.queries = [];
  }
}

/**
 * Mock capability record (Migration 028: UUID id, no displayName)
 */
interface MockCapRecord {
  id: string; // UUID now, not FQDN
  org: string;
  project: string;
  namespace: string;
  action: string;
  hash: string;
  workflowPatternId?: string;
  createdBy: string;
  createdAt: Date;
  updatedBy?: string;
  updatedAt?: Date;
  version: number;
  versionTag?: string;
  verified: boolean;
  signature?: string;
  usageCount: number;
  successCount: number;
  totalLatencyMs: number;
  tags: string[];
  visibility: "private" | "project" | "org" | "public";
  routing: "local" | "cloud";
}

/**
 * Mock registry (Migration 028: no aliases)
 */
class MockRegistry {
  public capabilities: Map<string, MockCapRecord> = new Map();

  resolveByName(
    name: string,
    _scope: { org: string; project: string },
  ): Promise<MockCapRecord | null> {
    // Try to find by namespace:action format
    for (const [_, cap] of this.capabilities) {
      const displayName = `${cap.namespace}:${cap.action}`;
      if (displayName === name) return Promise.resolve(cap);
      // Also match by action only
      if (cap.action === name) return Promise.resolve(cap);
    }
    return Promise.resolve(null);
  }

  getById(uuid: string): Promise<MockCapRecord | null> {
    return Promise.resolve(this.capabilities.get(uuid) ?? null);
  }

  addCapability(cap: MockCapRecord): void {
    this.capabilities.set(cap.id, cap);
  }
}

function createMockCapability(overrides: Partial<MockCapRecord> = {}): MockCapRecord {
  return {
    id: "550e8400-e29b-41d4-a716-446655440001", // UUID
    org: "local",
    project: "default",
    namespace: "fs",
    action: "read_json",
    hash: "a7f3",
    workflowPatternId: "pattern-123",
    createdBy: "test",
    createdAt: new Date("2025-01-01"),
    version: 1,
    verified: false,
    usageCount: 10,
    successCount: 8,
    totalLatencyMs: 1000,
    tags: [],
    visibility: "private",
    routing: "local",
    ...overrides,
  };
}

// =============================================================================
// CapModule.listTools Tests
// =============================================================================

Deno.test("CapModule.listTools - returns 4 tools", () => {
  const mockDb = new MockDb();
  const mockRegistry = new MockRegistry();
  // deno-lint-ignore no-explicit-any
  const capModule = new CapModule(mockRegistry as any, mockDb as any);

  const tools = capModule.listTools();

  assertEquals(tools.length, 4);
  assertEquals(tools.map((t) => t.name).sort(), [
    "cap:list",
    "cap:lookup",
    "cap:rename",
    "cap:whois",
  ]);
});

Deno.test("CapModule.listTools - each tool has inputSchema", () => {
  const mockDb = new MockDb();
  const mockRegistry = new MockRegistry();
  // deno-lint-ignore no-explicit-any
  const capModule = new CapModule(mockRegistry as any, mockDb as any);

  const tools = capModule.listTools();

  for (const tool of tools) {
    assertEquals(tool.inputSchema.type, "object");
    assertEquals(typeof tool.inputSchema.properties, "object");
  }
});

// =============================================================================
// cap:list Tests (AC1-4)
// =============================================================================

Deno.test("cap:list - returns items with correct fields (UUID id, namespace:action display)", async () => {
  const mockDb = new MockDb();
  const mockRegistry = new MockRegistry();
  mockDb.setMockRows([
    {
      id: "550e8400-e29b-41d4-a716-446655440001",
      namespace: "fs",
      action: "read",
      usage_count: 5,
      success_count: 4,
      description: "Reads files",
      total: "1",
    },
  ]);

  // deno-lint-ignore no-explicit-any
  const capModule = new CapModule(mockRegistry as any, mockDb as any);

  const result = await capModule.call("cap:list", {});
  const data = JSON.parse(result.content[0].text);

  assertEquals(data.items.length, 1);
  assertEquals(data.items[0].id, "550e8400-e29b-41d4-a716-446655440001");
  // Display name is namespace:action
  assertEquals(data.items[0].namespace, "fs");
  assertEquals(data.items[0].action, "read");
  assertEquals(data.items[0].usageCount, 5);
  assertEquals(data.items[0].successRate, 0.8);
  assertEquals(data.items[0].description, "Reads files");
});

Deno.test("cap:list - pattern filter uses LIKE on namespace:action", async () => {
  const mockDb = new MockDb();
  const mockRegistry = new MockRegistry();
  mockDb.setMockRows([]);

  // deno-lint-ignore no-explicit-any
  const capModule = new CapModule(mockRegistry as any, mockDb as any);

  await capModule.call("cap:list", { pattern: "fs:*" });
  const query = mockDb.getLastQuery();

  assertStringIncludes(query!.sql, "LIKE");
  assertEquals(query!.params[2], "fs:%");
});

Deno.test("cap:list - pagination with total", async () => {
  const mockDb = new MockDb();
  const mockRegistry = new MockRegistry();
  mockDb.setMockRows([
    {
      id: "550e8400-e29b-41d4-a716-446655440001",
      namespace: "fs",
      action: "read",
      usage_count: 5,
      success_count: 4,
      description: null,
      total: "100",
    },
  ]);

  // deno-lint-ignore no-explicit-any
  const capModule = new CapModule(mockRegistry as any, mockDb as any);

  const result = await capModule.call("cap:list", { limit: 10, offset: 20 });
  const data = JSON.parse(result.content[0].text);

  assertEquals(data.total, 100);
  assertEquals(data.limit, 10);
  assertEquals(data.offset, 20);
});

// =============================================================================
// cap:rename Tests (Migration 028: simpler, no aliases)
// =============================================================================

Deno.test("cap:rename - updates description", async () => {
  const mockDb = new MockDb();
  const mockRegistry = new MockRegistry();

  const cap = createMockCapability();
  mockRegistry.addCapability(cap);
  mockDb.setMockRows([{ count: "0" }]);

  // deno-lint-ignore no-explicit-any
  const capModule = new CapModule(mockRegistry as any, mockDb as any);

  const result = await capModule.call("cap:rename", {
    name: "fs:read_json",
    description: "Reads JSON files from disk",
  });
  const data = JSON.parse(result.content[0].text);

  assertEquals(data.success, true);
  assertEquals(data.id, cap.id);

  // Verify description was updated
  const queries = mockDb.queries.filter((q) => q.sql.includes("UPDATE workflow_pattern"));
  assertEquals(queries.length, 1);
  assertStringIncludes(queries[0].sql, "description");
});

Deno.test("cap:rename - not found error", async () => {
  const mockDb = new MockDb();
  const mockRegistry = new MockRegistry();

  // deno-lint-ignore no-explicit-any
  const capModule = new CapModule(mockRegistry as any, mockDb as any);

  const result = await capModule.call("cap:rename", {
    name: "nonexistent:action",
    description: "New description",
  });
  const data = JSON.parse(result.content[0].text);

  assertStringIncludes(data.error, "not found");
  assertEquals(result.isError, true);
});

// =============================================================================
// cap:lookup Tests
// =============================================================================

Deno.test("cap:lookup - returns capability details", async () => {
  const mockDb = new MockDb();
  const mockRegistry = new MockRegistry();

  const cap = createMockCapability();
  mockRegistry.addCapability(cap);
  mockDb.setMockRows([{ description: "Reads JSON files" }]);

  // deno-lint-ignore no-explicit-any
  const capModule = new CapModule(mockRegistry as any, mockDb as any);

  const result = await capModule.call("cap:lookup", { name: "fs:read_json" });
  const data = JSON.parse(result.content[0].text);

  assertEquals(data.id, cap.id);
  // Display name is now namespace:action
  assertEquals(data.namespace, "fs");
  assertEquals(data.action, "read_json");
  assertEquals(data.usageCount, 10);
  assertEquals(data.successRate, 0.8);
  assertEquals(data.description, "Reads JSON files");
});

Deno.test("cap:lookup - not found error", async () => {
  const mockDb = new MockDb();
  const mockRegistry = new MockRegistry();

  // deno-lint-ignore no-explicit-any
  const capModule = new CapModule(mockRegistry as any, mockDb as any);

  const result = await capModule.call("cap:lookup", { name: "nonexistent" });
  const data = JSON.parse(result.content[0].text);

  assertStringIncludes(data.error, "not found");
  assertEquals(result.isError, true);
});

// =============================================================================
// cap:whois Tests
// =============================================================================

Deno.test("cap:whois - returns full metadata", async () => {
  const mockDb = new MockDb();
  const mockRegistry = new MockRegistry();

  const cap = createMockCapability();
  mockRegistry.addCapability(cap);
  mockDb.setMockRows([{ description: "Full description" }]);

  // deno-lint-ignore no-explicit-any
  const capModule = new CapModule(mockRegistry as any, mockDb as any);

  const result = await capModule.call("cap:whois", { id: cap.id });
  const data = JSON.parse(result.content[0].text);

  assertEquals(data.id, cap.id);
  assertEquals(data.org, "local");
  assertEquals(data.project, "default");
  assertEquals(data.namespace, "fs");
  assertEquals(data.action, "read_json");
  assertEquals(data.hash, "a7f3");
  assertEquals(data.version, 1);
  assertEquals(data.usageCount, 10);
  assertEquals(data.successCount, 8);
  assertEquals(data.visibility, "private");
  assertEquals(data.routing, "local");
  assertEquals(data.description, "Full description");
  // No more aliases field
});

Deno.test("cap:whois - not found error", async () => {
  const mockDb = new MockDb();
  const mockRegistry = new MockRegistry();

  // deno-lint-ignore no-explicit-any
  const capModule = new CapModule(mockRegistry as any, mockDb as any);

  const result = await capModule.call("cap:whois", { id: "00000000-0000-0000-0000-000000000000" });
  const data = JSON.parse(result.content[0].text);

  assertStringIncludes(data.error, "not found");
  assertEquals(result.isError, true);
});

// =============================================================================
// PmlStdServer Tests
// =============================================================================

Deno.test("PmlStdServer - handleListTools returns cap tools", () => {
  const mockDb = new MockDb();
  const mockRegistry = new MockRegistry();

  // deno-lint-ignore no-explicit-any
  const server = new PmlStdServer(mockRegistry as any, mockDb as any);

  const tools = server.handleListTools();
  assertEquals(tools.length, 4);
  assertEquals(tools[0].name, "cap:list");
});

Deno.test("PmlStdServer - isCapManagementTool", () => {
  const mockDb = new MockDb();
  const mockRegistry = new MockRegistry();

  // deno-lint-ignore no-explicit-any
  const server = new PmlStdServer(mockRegistry as any, mockDb as any);

  assertEquals(server.isCapManagementTool("cap:list"), true);
  assertEquals(server.isCapManagementTool("cap:rename"), true);
  assertEquals(server.isCapManagementTool("mcp__fs__read"), false);
  assertEquals(server.isCapManagementTool("pml:execute"), false);
});

Deno.test("PmlStdServer - rejects non-cap tools", async () => {
  const mockDb = new MockDb();
  const mockRegistry = new MockRegistry();

  // deno-lint-ignore no-explicit-any
  const server = new PmlStdServer(mockRegistry as any, mockDb as any);

  const result = await server.handleCallTool("unknown:tool", {});
  const data = JSON.parse(result.content[0].text);

  assertStringIncludes(data.error, "Unknown tool");
  assertEquals(result.isError, true);
});
