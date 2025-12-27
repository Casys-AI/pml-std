/**
 * Unit tests for lib/std/pglite.ts
 *
 * Tests PGlite MCP tools for database access
 */

import { assertEquals, assertExists } from "@std/assert";
import { closePgliteConnection, pgliteTools } from "../../../../lib/std/pglite.ts";

// Helper to find tool by name
function getTool(name: string) {
  const tool = pgliteTools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool;
}

// Result type for casting
interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
  fields?: { name: string; dataTypeID: number }[];
}

interface TablesResult {
  tables: { table_name: string; table_type: string; row_count?: number }[];
  count: number;
}

interface SchemaResult {
  table: string;
  columns: { name: string; type: string; isPrimaryKey: boolean }[];
  primaryKeys: string[];
  foreignKeys: unknown[];
}

interface StatsResult {
  tableCount: number;
  totalRows: number;
  extensions: unknown[];
  topTables: { name: string; count: number }[];
}

interface ExecResult {
  success: boolean;
  affectedRows: number;
  command?: string;
}

interface IndexesResult {
  indexes: { indexName: string; tableName: string; columns: string[]; isPrimary: boolean }[];
  count: number;
}

interface SearchResult {
  pattern: string;
  results: Record<string, unknown[]>;
  matchCount: number;
  tablesSearched: number;
}

// Setup: create test table
async function setup() {
  const execTool = getTool("pglite_exec");
  await execTool.handler({
    dbPath: ":memory:",
    sql: `
      CREATE TABLE IF NOT EXISTS test_items (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `,
  });

  await execTool.handler({
    dbPath: ":memory:",
    sql: `INSERT INTO test_items (name, description) VALUES ($1, $2)`,
    params: ["Item One", "First test item"],
  });
  await execTool.handler({
    dbPath: ":memory:",
    sql: `INSERT INTO test_items (name, description) VALUES ($1, $2)`,
    params: ["Item Two", "Second test item"],
  });
  await execTool.handler({
    dbPath: ":memory:",
    sql: `INSERT INTO test_items (name, description) VALUES ($1, $2)`,
    params: ["Another Thing", "Something different"],
  });
}

// Cleanup
async function cleanup() {
  await closePgliteConnection();
}

Deno.test("pgliteTools - exports 7 tools", () => {
  assertEquals(pgliteTools.length, 7);
});

Deno.test("pgliteTools - correct tool names", () => {
  const names = pgliteTools.map((t) => t.name);
  assertEquals(names, [
    "pglite_query",
    "pglite_tables",
    "pglite_schema",
    "pglite_stats",
    "pglite_exec",
    "pglite_indexes",
    "pglite_search",
  ]);
});

Deno.test("pgliteTools - all have category 'database'", () => {
  for (const tool of pgliteTools) {
    assertEquals(tool.category, "database");
  }
});

Deno.test("pglite_query - execute SELECT queries", async () => {
  await setup();
  try {
    const tool = getTool("pglite_query");
    const result = await tool.handler({
      dbPath: ":memory:",
      query: "SELECT * FROM test_items ORDER BY id",
    }) as QueryResult;

    assertEquals(result.rowCount, 3);
    assertEquals(result.rows[0].name, "Item One");
    assertEquals(result.rows[1].name, "Item Two");
  } finally {
    await cleanup();
  }
});

Deno.test("pglite_query - parameterized queries", async () => {
  await setup();
  try {
    const tool = getTool("pglite_query");
    const result = await tool.handler({
      dbPath: ":memory:",
      query: "SELECT * FROM test_items WHERE name ILIKE $1",
      params: ["%Item%"],
    }) as QueryResult;

    assertEquals(result.rowCount, 2);
  } finally {
    await cleanup();
  }
});

Deno.test("pglite_query - respects limit parameter", async () => {
  await setup();
  try {
    const tool = getTool("pglite_query");
    const result = await tool.handler({
      dbPath: ":memory:",
      query: "SELECT * FROM test_items",
      limit: 1,
    }) as QueryResult;

    assertEquals(result.rowCount, 1);
  } finally {
    await cleanup();
  }
});

Deno.test("pglite_tables - lists tables", async () => {
  await setup();
  try {
    const tool = getTool("pglite_tables");
    const result = await tool.handler({ dbPath: ":memory:" }) as TablesResult;

    assertExists(result.tables);
    const tableNames = result.tables.map((t) => t.table_name);
    assertEquals(tableNames.includes("test_items"), true);
  } finally {
    await cleanup();
  }
});

Deno.test("pglite_tables - includes row counts when requested", async () => {
  await setup();
  try {
    const tool = getTool("pglite_tables");
    const result = await tool.handler({
      dbPath: ":memory:",
      includeRowCounts: true,
    }) as TablesResult;

    const testTable = result.tables.find((t) => t.table_name === "test_items");
    assertExists(testTable);
    assertEquals(testTable.row_count, 3);
  } finally {
    await cleanup();
  }
});

Deno.test("pglite_schema - returns column information", async () => {
  await setup();
  try {
    const tool = getTool("pglite_schema");
    const result = await tool.handler({
      dbPath: ":memory:",
      table: "test_items",
    }) as SchemaResult;

    assertEquals(result.table, "test_items");
    assertExists(result.columns);
    assertEquals(result.columns.length, 4);

    const idColumn = result.columns.find((c) => c.name === "id");
    assertExists(idColumn);
    assertEquals(idColumn.isPrimaryKey, true);
  } finally {
    await cleanup();
  }
});

Deno.test("pglite_schema - identifies primary keys", async () => {
  await setup();
  try {
    const tool = getTool("pglite_schema");
    const result = await tool.handler({
      dbPath: ":memory:",
      table: "test_items",
    }) as SchemaResult;

    assertEquals(result.primaryKeys, ["id"]);
  } finally {
    await cleanup();
  }
});

Deno.test("pglite_stats - returns database statistics", async () => {
  await setup();
  try {
    const tool = getTool("pglite_stats");
    const result = await tool.handler({ dbPath: ":memory:" }) as StatsResult;

    assertExists(result.tableCount);
    assertExists(result.totalRows);
    assertExists(result.extensions);
    assertExists(result.topTables);
  } finally {
    await cleanup();
  }
});

Deno.test("pglite_exec - executes INSERT statements", async () => {
  await setup();
  try {
    const tool = getTool("pglite_exec");
    const result = await tool.handler({
      dbPath: ":memory:",
      sql: "INSERT INTO test_items (name) VALUES ($1)",
      params: ["New Item"],
    }) as ExecResult;

    assertEquals(result.success, true);
  } finally {
    await cleanup();
  }
});

Deno.test("pglite_exec - executes UPDATE statements", async () => {
  await setup();
  try {
    const tool = getTool("pglite_exec");

    // First insert
    await tool.handler({
      dbPath: ":memory:",
      sql: "INSERT INTO test_items (name) VALUES ($1)",
      params: ["New Item"],
    });

    // Then update
    const result = await tool.handler({
      dbPath: ":memory:",
      sql: "UPDATE test_items SET description = $1 WHERE name = $2",
      params: ["Updated description", "New Item"],
    }) as ExecResult;

    assertEquals(result.success, true);
  } finally {
    await cleanup();
  }
});

Deno.test("pglite_indexes - lists indexes for a table", async () => {
  await setup();
  try {
    const tool = getTool("pglite_indexes");
    const result = await tool.handler({
      dbPath: ":memory:",
      table: "test_items",
    }) as IndexesResult;

    assertExists(result.indexes);
    // Should have at least the primary key index
    const pkIndex = result.indexes.find((i) => i.isPrimary);
    assertExists(pkIndex);
  } finally {
    await cleanup();
  }
});

Deno.test("pglite_search - searches across text columns", async () => {
  await setup();
  try {
    const tool = getTool("pglite_search");
    const result = await tool.handler({
      dbPath: ":memory:",
      pattern: "Item",
      tables: ["test_items"],
    }) as SearchResult;

    assertExists(result.results);
    assertEquals(result.matchCount >= 2, true);
  } finally {
    await cleanup();
  }
});

Deno.test("pglite_search - case-insensitive", async () => {
  await setup();
  try {
    const tool = getTool("pglite_search");
    const result = await tool.handler({
      dbPath: ":memory:",
      pattern: "item",
      tables: ["test_items"],
    }) as SearchResult;

    assertEquals(result.matchCount >= 2, true);
  } finally {
    await cleanup();
  }
});
