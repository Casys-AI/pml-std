/**
 * PGlite tools - Direct access to the AgentCards embedded PostgreSQL database
 *
 * Unlike database.ts which uses CLI tools (psql, sqlite3, etc.), this module
 * connects directly to the PGlite database used by AgentCards.
 *
 * @module lib/std/tools/pglite
 */

import type { MiniTool } from "./common.ts";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { getAgentCardsDatabasePath } from "../../src/cli/utils.ts";

// Singleton database connection
let db: PGlite | null = null;
let dbPath: string | null = null;

/**
 * Get or create database connection
 */
async function getDb(path?: string): Promise<PGlite> {
  const targetPath = path || getAgentCardsDatabasePath();

  // Return existing connection if path matches
  if (db && dbPath === targetPath) {
    return db;
  }

  // Close existing connection if path changed
  if (db) {
    await db.close();
  }

  // Normalize :memory: to memory://
  const normalizedPath = targetPath === ":memory:" ? "memory://" : targetPath;

  db = new PGlite(normalizedPath, {
    extensions: { vector },
  });

  // Ensure pgvector extension is loaded
  await db.exec("CREATE EXTENSION IF NOT EXISTS vector;");

  dbPath = targetPath;
  return db;
}

export const pgliteTools: MiniTool[] = [
  {
    name: "pglite_query",
    description:
      "Execute SQL queries on the AgentCards PGlite database. Run SELECT, INSERT, UPDATE, DELETE operations. Returns JSON results with row limit for safety. Use for querying capabilities, workflows, traces, and all AgentCards data. Keywords: pglite query, agentcards database, embedded postgres, SQL query, capability query.",
    category: "database",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "SQL query to execute",
        },
        params: {
          type: "array",
          items: {},
          description: "Query parameters (optional, uses $1, $2, etc.)",
        },
        limit: {
          type: "number",
          description: "Max rows to return (default: 100, max: 1000)",
        },
        dbPath: {
          type: "string",
          description: "Database path (optional, defaults to AGENTCARDS_DB_PATH)",
        },
      },
      required: ["query"],
    },
    handler: async ({ query, params, limit = 100, dbPath: customPath }) => {
      const pglite = await getDb(customPath as string | undefined);

      // Enforce row limit
      const safeLimit = Math.min(Number(limit) || 100, 1000);
      let safeQuery = String(query).trim();

      // Add LIMIT if not present for SELECT queries
      if (
        safeQuery.toUpperCase().startsWith("SELECT") &&
        !safeQuery.toUpperCase().includes("LIMIT")
      ) {
        safeQuery = `${safeQuery} LIMIT ${safeLimit}`;
      }

      const result = params && (params as unknown[]).length > 0
        ? await (pglite as any).query(safeQuery, params)
        : await (pglite as any).query(safeQuery);

      return {
        rows: result.rows,
        rowCount: result.rows.length,
        fields: result.fields?.map((f: any) => ({
          name: f.name,
          dataTypeID: f.dataTypeID,
        })),
      };
    },
  },
  {
    name: "pglite_tables",
    description:
      "List all tables in the AgentCards PGlite database. Returns table names, types, and row counts. Use for exploring the database schema, discovering available data, or documentation. Keywords: pglite tables, list tables, agentcards schema, database structure.",
    category: "database",
    inputSchema: {
      type: "object",
      properties: {
        dbPath: {
          type: "string",
          description: "Database path (optional, defaults to AGENTCARDS_DB_PATH)",
        },
        includeRowCounts: {
          type: "boolean",
          description: "Include approximate row counts (slower but informative)",
        },
      },
    },
    handler: async ({ dbPath: customPath, includeRowCounts = false }) => {
      const pglite = await getDb(customPath as string | undefined);

      const tablesResult = await (pglite as any).query(`
        SELECT table_name, table_type
        FROM information_schema.tables
        WHERE table_schema = 'public'
        ORDER BY table_name
      `);

      const tables = tablesResult.rows;

      if (includeRowCounts) {
        for (const table of tables) {
          try {
            const countResult = await (pglite as any).query(
              `SELECT COUNT(*) as count FROM "${table.table_name}"`,
            );
            table.row_count = Number(countResult.rows[0]?.count || 0);
          } catch {
            table.row_count = null;
          }
        }
      }

      return { tables, count: tables.length };
    },
  },
  {
    name: "pglite_schema",
    description:
      "Get detailed schema information for a table in the AgentCards database. Shows column names, types, nullability, defaults, and constraints. Use for understanding data structure or generating queries. Keywords: pglite schema, table columns, column types, table structure, describe table.",
    category: "database",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Table name" },
        dbPath: { type: "string", description: "Database path (optional)" },
      },
      required: ["table"],
    },
    handler: async ({ table, dbPath: customPath }) => {
      const pglite = await getDb(customPath as string | undefined);

      const columnsResult = await (pglite as any).query(
        `
        SELECT column_name, data_type, character_maximum_length,
               is_nullable, column_default, ordinal_position
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position
      `,
        [table],
      );

      const pkResult = await (pglite as any).query(
        `
        SELECT a.attname
        FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        JOIN pg_class c ON c.oid = i.indrelid
        WHERE c.relname = $1 AND i.indisprimary
      `,
        [table],
      );

      const primaryKeys = pkResult.rows.map((r: any) => r.attname);

      const fkResult = await (pglite as any).query(
        `
        SELECT kcu.column_name,
               ccu.table_name AS foreign_table_name,
               ccu.column_name AS foreign_column_name
        FROM information_schema.table_constraints AS tc
        JOIN information_schema.key_column_usage AS kcu
          ON tc.constraint_name = kcu.constraint_name
        JOIN information_schema.constraint_column_usage AS ccu
          ON ccu.constraint_name = tc.constraint_name
        WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = $1
      `,
        [table],
      );

      return {
        table,
        columns: columnsResult.rows.map((col: any) => ({
          name: col.column_name,
          type: col.data_type,
          maxLength: col.character_maximum_length,
          nullable: col.is_nullable === "YES",
          default: col.column_default,
          isPrimaryKey: primaryKeys.includes(col.column_name),
        })),
        primaryKeys,
        foreignKeys: fkResult.rows,
      };
    },
  },
  {
    name: "pglite_stats",
    description:
      "Get database statistics and health information. Shows table count, total rows, database size estimates, and extension status. Use for monitoring, debugging, or capacity planning. Keywords: pglite stats, database size, table count, health check.",
    category: "database",
    inputSchema: {
      type: "object",
      properties: {
        dbPath: { type: "string", description: "Database path (optional)" },
      },
    },
    handler: async ({ dbPath: customPath }) => {
      const pglite = await getDb(customPath as string | undefined);

      const tableCountResult = await (pglite as any).query(`
        SELECT COUNT(*) as count
        FROM information_schema.tables
        WHERE table_schema = 'public'
      `);

      const extensionsResult = await (pglite as any).query(`
        SELECT extname, extversion FROM pg_extension
      `);

      const tablesResult = await (pglite as any).query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      `);

      let totalRows = 0;
      const tableSizes: Record<string, number> = {};

      for (const { table_name } of tablesResult.rows) {
        try {
          const countResult = await (pglite as any).query(
            `SELECT COUNT(*) as count FROM "${table_name}"`,
          );
          const count = Number(countResult.rows[0]?.count || 0);
          tableSizes[table_name] = count;
          totalRows += count;
        } catch { /* skip */ }
      }

      const topTables = Object.entries(tableSizes)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 10)
        .map(([name, count]) => ({ name, count }));

      return {
        tableCount: Number(tableCountResult.rows[0]?.count || 0),
        totalRows,
        topTables,
        extensions: extensionsResult.rows,
        dbPath: dbPath || getAgentCardsDatabasePath(),
      };
    },
  },
  {
    name: "pglite_exec",
    description:
      "Execute SQL statements without returning results (DDL, INSERT, UPDATE, DELETE). Use for data modifications or schema changes. Returns affected row count. Keywords: pglite exec, SQL execute, insert update delete, DDL, schema change.",
    category: "database",
    inputSchema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "SQL statement to execute" },
        params: { type: "array", items: {}, description: "Statement parameters (optional)" },
        dbPath: { type: "string", description: "Database path (optional)" },
      },
      required: ["sql"],
    },
    handler: async ({ sql, params, dbPath: customPath }) => {
      const pglite = await getDb(customPath as string | undefined);

      const result = params && (params as unknown[]).length > 0
        ? await (pglite as any).query(String(sql), params)
        : await (pglite as any).query(String(sql));

      return {
        success: true,
        affectedRows: result.affectedRows || 0,
        command: result.command,
      };
    },
  },
  {
    name: "pglite_indexes",
    description:
      "List indexes for a table or all tables in the database. Shows index name, columns, uniqueness, and type. Use for performance analysis or schema documentation. Keywords: pglite indexes, table indexes, database indexes, index info.",
    category: "database",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Table name (optional, shows all if not specified)" },
        dbPath: { type: "string", description: "Database path (optional)" },
      },
    },
    handler: async ({ table, dbPath: customPath }) => {
      const pglite = await getDb(customPath as string | undefined);

      let query = `
        SELECT i.relname as index_name, t.relname as table_name,
               a.attname as column_name, ix.indisunique as is_unique,
               ix.indisprimary as is_primary
        FROM pg_index ix
        JOIN pg_class t ON t.oid = ix.indrelid
        JOIN pg_class i ON i.oid = ix.indexrelid
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'public'
      `;

      const params: string[] = [];
      if (table) {
        query += ` AND t.relname = $1`;
        params.push(String(table));
      }
      query += ` ORDER BY t.relname, i.relname, a.attnum`;

      const result = params.length > 0
        ? await (pglite as any).query(query, params)
        : await (pglite as any).query(query);

      const indexes: Record<string, any> = {};
      for (const row of result.rows) {
        const key = `${row.table_name}.${row.index_name}`;
        if (!indexes[key]) {
          indexes[key] = {
            indexName: row.index_name,
            tableName: row.table_name,
            columns: [],
            isUnique: row.is_unique,
            isPrimary: row.is_primary,
          };
        }
        indexes[key].columns.push(row.column_name);
      }

      return { indexes: Object.values(indexes), count: Object.keys(indexes).length };
    },
  },
  {
    name: "pglite_search",
    description:
      "Search across multiple tables for a text pattern. Searches text columns and returns matching rows with context. Use for finding data across the database. Keywords: pglite search, full text search, find data, text search.",
    category: "database",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Text pattern to search for (case-insensitive)" },
        tables: {
          type: "array",
          items: { type: "string" },
          description: "Tables to search (optional)",
        },
        limit: { type: "number", description: "Max results per table (default: 10)" },
        dbPath: { type: "string", description: "Database path (optional)" },
      },
      required: ["pattern"],
    },
    handler: async ({ pattern, tables, limit = 10, dbPath: customPath }) => {
      const pglite = await getDb(customPath as string | undefined);
      const safeLimit = Math.min(Number(limit) || 10, 100);
      const searchPattern = `%${String(pattern)}%`;

      const defaultTables = ["capabilities", "capability_records", "mcp_tools", "workflow_dags"];
      const targetTables = (tables as string[]) || defaultTables;

      const results: Record<string, any[]> = {};

      for (const tableName of targetTables) {
        try {
          const columnsResult = await (pglite as any).query(
            `
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = $1
              AND data_type IN ('text', 'character varying', 'varchar', 'char')
          `,
            [tableName],
          );

          if (columnsResult.rows.length === 0) continue;

          const conditions = columnsResult.rows
            .map((c: any) => `"${c.column_name}" ILIKE $1`)
            .join(" OR ");

          const searchResult = await (pglite as any).query(
            `SELECT * FROM "${tableName}" WHERE ${conditions} LIMIT ${safeLimit}`,
            [searchPattern],
          );

          if (searchResult.rows.length > 0) {
            results[tableName] = searchResult.rows;
          }
        } catch { /* table might not exist */ }
      }

      return {
        pattern,
        results,
        matchCount: Object.values(results).reduce((sum, arr) => sum + arr.length, 0),
        tablesSearched: Object.keys(results).length,
      };
    },
  },
];

/** Close the database connection (for cleanup) */
export async function closePgliteConnection(): Promise<void> {
  if (db) {
    await db.close();
    db = null;
    dbPath = null;
  }
}
