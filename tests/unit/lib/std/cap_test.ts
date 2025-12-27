/**
 * Unit tests for lib/std/cap.ts
 *
 * Story 13.5: Capability Management Tools
 *
 * Tests cap:list, cap:rename, cap:lookup, cap:whois
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
// Mock Database and Registry
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

interface MockCapRecord {
  id: string;
  displayName: string;
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

class MockRegistry {
  public capabilities: Map<string, MockCapRecord> = new Map();
  public aliases: Map<string, string> = new Map();

  resolveByName(
    name: string,
    _scope: { org: string; project: string },
  ): Promise<MockCapRecord | null> {
    for (const [_, cap] of this.capabilities) {
      if (cap.displayName === name) return Promise.resolve(cap);
    }
    const fqdn = this.aliases.get(name);
    if (fqdn) return Promise.resolve(this.capabilities.get(fqdn) ?? null);
    return Promise.resolve(null);
  }

  resolveByAlias(
    alias: string,
    _scope: { org: string; project: string },
  ): Promise<{ record: MockCapRecord; isAlias: boolean; usedAlias: string } | null> {
    const fqdn = this.aliases.get(alias);
    if (fqdn) {
      const record = this.capabilities.get(fqdn);
      if (record) {
        return Promise.resolve({ record, isAlias: true, usedAlias: alias });
      }
    }
    return Promise.resolve(null);
  }

  getByFqdn(fqdn: string): Promise<MockCapRecord | null> {
    return Promise.resolve(this.capabilities.get(fqdn) ?? null);
  }

  createAlias(
    _org: string,
    _project: string,
    alias: string,
    targetFqdn: string,
  ): Promise<void> {
    this.aliases.set(alias, targetFqdn);
    return Promise.resolve();
  }

  getAliases(fqdn: string): Promise<Array<{ alias: string }>> {
    const result: Array<{ alias: string }> = [];
    for (const [alias, target] of this.aliases) {
      if (target === fqdn) {
        result.push({ alias });
      }
    }
    return Promise.resolve(result);
  }

  addCapability(cap: MockCapRecord): void {
    this.capabilities.set(cap.id, cap);
  }
}

function createMockCapability(overrides: Partial<MockCapRecord> = {}): MockCapRecord {
  return {
    id: "local.default.fs.read_json.a7f3",
    displayName: "json-reader",
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

Deno.test("cap:list - AC1: returns items with correct fields", async () => {
  const mockDb = new MockDb();
  const mockRegistry = new MockRegistry();
  mockDb.setMockRows([
    {
      id: "local.default.fs.read.a1b2",
      display_name: "file-reader",
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
  assertEquals(data.items[0].id, "local.default.fs.read.a1b2");
  assertEquals(data.items[0].name, "file-reader");
  assertEquals(data.items[0].namespace, "fs");
  assertEquals(data.items[0].action, "read");
  assertEquals(data.items[0].usageCount, 5);
  assertEquals(data.items[0].successRate, 0.8);
  assertEquals(data.items[0].description, "Reads files");
});

Deno.test("cap:list - AC2: pattern filter uses LIKE", async () => {
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

Deno.test("cap:list - AC3: unnamedOnly filter", async () => {
  const mockDb = new MockDb();
  const mockRegistry = new MockRegistry();
  mockDb.setMockRows([]);

  // deno-lint-ignore no-explicit-any
  const capModule = new CapModule(mockRegistry as any, mockDb as any);

  await capModule.call("cap:list", { unnamedOnly: true });
  const query = mockDb.getLastQuery();

  assertStringIncludes(query!.sql, "unnamed\\_%");
});

Deno.test("cap:list - AC4: pagination with total", async () => {
  const mockDb = new MockDb();
  const mockRegistry = new MockRegistry();
  mockDb.setMockRows([
    {
      id: "local.default.fs.read.a1b2",
      display_name: "reader",
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
// cap:rename Tests (AC5-7)
// =============================================================================

Deno.test("cap:rename - AC5: basic rename with alias", async () => {
  const mockDb = new MockDb();
  const mockRegistry = new MockRegistry();

  const cap = createMockCapability({ displayName: "old-reader" });
  mockRegistry.addCapability(cap);
  mockDb.setMockRows([{ count: "0" }]);

  // deno-lint-ignore no-explicit-any
  const capModule = new CapModule(mockRegistry as any, mockDb as any);

  const result = await capModule.call("cap:rename", {
    name: "old-reader",
    newName: "json-reader",
  });
  const data = JSON.parse(result.content[0].text);

  assertEquals(data.success, true);
  assertEquals(data.fqdn, cap.id);
  assertEquals(data.aliasCreated, true);
  assertEquals(mockRegistry.aliases.get("old-reader"), cap.id);
});

Deno.test("cap:rename - AC6: rename with description", async () => {
  const mockDb = new MockDb();
  const mockRegistry = new MockRegistry();

  const cap = createMockCapability({ displayName: "old-reader" });
  mockRegistry.addCapability(cap);
  mockDb.setMockRows([{ count: "0" }]);

  // deno-lint-ignore no-explicit-any
  const capModule = new CapModule(mockRegistry as any, mockDb as any);

  await capModule.call("cap:rename", {
    name: "old-reader",
    newName: "json-reader",
    description: "Reads JSON files",
  });

  const queries = mockDb.queries.filter((q) => q.sql.includes("UPDATE workflow_pattern"));
  assertEquals(queries.length, 1);
  assertStringIncludes(queries[0].sql, "description");
});

Deno.test("cap:rename - AC7: collision error", async () => {
  const mockDb = new MockDb();
  const mockRegistry = new MockRegistry();

  const cap = createMockCapability({ displayName: "old-reader" });
  mockRegistry.addCapability(cap);
  mockDb.setMockRows([{ count: "1" }]);

  // deno-lint-ignore no-explicit-any
  const capModule = new CapModule(mockRegistry as any, mockDb as any);

  const result = await capModule.call("cap:rename", {
    name: "old-reader",
    newName: "json-reader",
  });
  const data = JSON.parse(result.content[0].text);

  assertStringIncludes(data.error, "already exists");
  assertEquals(result.isError, true);
});

// M4 Fix: Test invalid newName validation
Deno.test("cap:rename - M4: rejects invalid newName", async () => {
  const mockDb = new MockDb();
  const mockRegistry = new MockRegistry();

  const cap = createMockCapability({ displayName: "old-reader" });
  mockRegistry.addCapability(cap);

  // deno-lint-ignore no-explicit-any
  const capModule = new CapModule(mockRegistry as any, mockDb as any);

  // Test with invalid name containing space
  const result = await capModule.call("cap:rename", {
    name: "old-reader",
    newName: "invalid name with spaces",
  });
  const data = JSON.parse(result.content[0].text);

  assertStringIncludes(data.error, "Invalid name");
  assertEquals(result.isError, true);
});

// =============================================================================
// cap:lookup Tests (AC8-9)
// =============================================================================

Deno.test("cap:lookup - AC8: returns capability details", async () => {
  const mockDb = new MockDb();
  const mockRegistry = new MockRegistry();

  const cap = createMockCapability();
  mockRegistry.addCapability(cap);
  mockDb.setMockRows([{ description: "Reads JSON files" }]);

  // deno-lint-ignore no-explicit-any
  const capModule = new CapModule(mockRegistry as any, mockDb as any);

  const result = await capModule.call("cap:lookup", { name: "json-reader" });
  const data = JSON.parse(result.content[0].text);

  assertEquals(data.fqdn, cap.id);
  assertEquals(data.displayName, "json-reader");
  assertEquals(data.usageCount, 10);
  assertEquals(data.successRate, 0.8);
  assertEquals(data.description, "Reads JSON files");
});

Deno.test("cap:lookup - AC9: alias warning", async () => {
  const mockDb = new MockDb();
  const mockRegistry = new MockRegistry();

  const cap = createMockCapability({ displayName: "new-reader" });
  mockRegistry.addCapability(cap);
  mockRegistry.aliases.set("old-reader", cap.id);
  mockDb.setMockRows([{ description: null }]);

  // deno-lint-ignore no-explicit-any
  const capModule = new CapModule(mockRegistry as any, mockDb as any);

  const result = await capModule.call("cap:lookup", { name: "old-reader" });
  const data = JSON.parse(result.content[0].text);

  assertEquals(data.isAlias, true);
  assertStringIncludes(data.warning, "deprecated alias");
  assertStringIncludes(data.warning, "old-reader");
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
// cap:whois Tests (AC10)
// =============================================================================

Deno.test("cap:whois - AC10: returns full metadata", async () => {
  const mockDb = new MockDb();
  const mockRegistry = new MockRegistry();

  const cap = createMockCapability();
  mockRegistry.addCapability(cap);
  mockRegistry.aliases.set("old-name", cap.id);
  mockDb.setMockRows([{ description: "Full description" }]);

  // deno-lint-ignore no-explicit-any
  const capModule = new CapModule(mockRegistry as any, mockDb as any);

  const result = await capModule.call("cap:whois", { fqdn: cap.id });
  const data = JSON.parse(result.content[0].text);

  assertEquals(data.id, cap.id);
  assertEquals(data.displayName, cap.displayName);
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
  assertEquals(data.aliases, ["old-name"]);
  assertEquals(data.description, "Full description");
});

Deno.test("cap:whois - not found error", async () => {
  const mockDb = new MockDb();
  const mockRegistry = new MockRegistry();

  // deno-lint-ignore no-explicit-any
  const capModule = new CapModule(mockRegistry as any, mockDb as any);

  const result = await capModule.call("cap:whois", { fqdn: "nonexistent.fqdn" });
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
