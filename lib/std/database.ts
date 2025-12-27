/**
 * Database tools - SQL and NoSQL database access
 *
 * @module lib/std/tools/database
 */

import { type MiniTool, runCommand } from "./common.ts";

export const databaseTools: MiniTool[] = [
  {
    name: "sqlite_query",
    description:
      "Execute SQL queries on SQLite database files. Run SELECT, INSERT, UPDATE, DELETE operations on local .db files. Output as JSON, CSV, or table format. Use for local data storage, testing, embedded databases, or data analysis. Keywords: sqlite query, SQL database, local db, select insert update, sqlite3 command, database query.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        database: { type: "string", description: "Database file path" },
        query: { type: "string", description: "SQL query" },
        mode: {
          type: "string",
          enum: ["json", "csv", "table", "line"],
          description: "Output mode",
        },
      },
      required: ["database", "query"],
    },
    handler: async ({ database, query, mode = "json" }) => {
      const args = [database as string, "-cmd", `.mode ${mode}`, query as string];

      const result = await runCommand("sqlite3", args);
      if (result.code !== 0) {
        throw new Error(`sqlite3 failed: ${result.stderr}`);
      }

      if (mode === "json") {
        try {
          return { results: JSON.parse(result.stdout || "[]") };
        } catch {
          return { output: result.stdout };
        }
      }
      return { output: result.stdout };
    },
  },
  {
    name: "psql_query",
    description:
      "Execute SQL queries on PostgreSQL databases. Connect to remote or local Postgres servers, run queries, manage data. Use for production database operations, data analysis, schema management, or database administration. Keywords: postgresql query, psql, postgres SQL, database query, pg connection, SQL execute.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string", description: "Database host" },
        port: { type: "number", description: "Port (default: 5432)" },
        database: { type: "string", description: "Database name" },
        user: { type: "string", description: "Username" },
        query: { type: "string", description: "SQL query" },
      },
      required: ["database", "query"],
    },
    handler: async ({ host = "localhost", port = 5432, database, user, query }) => {
      const args = ["-h", host as string, "-p", String(port), "-d", database as string];
      if (user) args.push("-U", user as string);
      args.push("-t", "-A", "-c", query as string);

      const result = await runCommand("psql", args);
      if (result.code !== 0) {
        throw new Error(`psql failed: ${result.stderr}`);
      }
      return { output: result.stdout.trim() };
    },
  },
  {
    name: "redis_cli",
    description:
      "Execute Redis commands for key-value operations, caching, and pub/sub. Run GET, SET, HGET, LPUSH, and other Redis operations. Use for cache management, session storage, message queues, or real-time data. Keywords: redis cli, redis command, key value store, cache operations, redis get set, NoSQL database.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string", description: "Redis host (default: localhost)" },
        port: { type: "number", description: "Redis port (default: 6379)" },
        command: { type: "string", description: "Redis command" },
        database: { type: "number", description: "Database number" },
      },
      required: ["command"],
    },
    handler: async ({ host = "localhost", port = 6379, command, database }) => {
      const args = ["-h", host as string, "-p", String(port)];
      if (database !== undefined) args.push("-n", String(database));
      args.push(...(command as string).split(" "));

      const result = await runCommand("redis-cli", args);
      if (result.code !== 0) {
        throw new Error(`redis-cli failed: ${result.stderr}`);
      }
      return { result: result.stdout.trim() };
    },
  },
  {
    name: "mysql_query",
    description:
      "Execute SQL queries on MySQL/MariaDB databases. Connect to local or remote MySQL servers, run queries, and manage data. Use for production databases, data analysis, or administration. Keywords: mysql query, mariadb, SQL execute, mysql database, mysql connect.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string", description: "Database host (default: localhost)" },
        port: { type: "number", description: "Port (default: 3306)" },
        database: { type: "string", description: "Database name" },
        user: { type: "string", description: "Username" },
        password: { type: "string", description: "Password" },
        query: { type: "string", description: "SQL query" },
      },
      required: ["database", "user", "query"],
    },
    handler: async ({ host = "localhost", port = 3306, database, user, password, query }) => {
      const args = ["-h", host as string, "-P", String(port), "-u", user as string];
      if (password) args.push(`-p${password}`);
      args.push("-N", "-B", "-e", query as string, database as string);

      const result = await runCommand("mysql", args);
      if (result.code !== 0) {
        throw new Error(`mysql failed: ${result.stderr}`);
      }
      return { output: result.stdout.trim() };
    },
  },
  {
    name: "sqlite_tables",
    description:
      "List all tables in a SQLite database. Get table names for schema exploration. Use for database discovery, documentation, or migration planning. Keywords: sqlite tables, list tables, database schema, table names, sqlite structure.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        database: { type: "string", description: "Database file path" },
      },
      required: ["database"],
    },
    handler: async ({ database }) => {
      const result = await runCommand("sqlite3", [
        database as string,
        "-cmd",
        ".mode json",
        "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name",
      ]);
      if (result.code !== 0) {
        throw new Error(`sqlite3 failed: ${result.stderr}`);
      }
      try {
        return { tables: JSON.parse(result.stdout || "[]") };
      } catch {
        return { output: result.stdout };
      }
    },
  },
  {
    name: "sqlite_schema",
    description:
      "Get the schema (CREATE statement) for a SQLite table. View column definitions, types, constraints, and indexes. Use for documentation, migration, or understanding table structure. Keywords: sqlite schema, table schema, column types, create statement, table structure.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        database: { type: "string", description: "Database file path" },
        table: { type: "string", description: "Table name" },
      },
      required: ["database", "table"],
    },
    handler: async ({ database, table }) => {
      const result = await runCommand("sqlite3", [
        database as string,
        `.schema ${table}`,
      ]);
      if (result.code !== 0) {
        throw new Error(`sqlite3 failed: ${result.stderr}`);
      }
      return { schema: result.stdout.trim(), table };
    },
  },
  {
    name: "sqlite_info",
    description:
      "Get detailed column information for a SQLite table using PRAGMA. Shows column names, types, nullability, defaults, and primary keys. Use for data validation or ORM mapping. Keywords: sqlite pragma, table info, column info, column types, table columns.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        database: { type: "string", description: "Database file path" },
        table: { type: "string", description: "Table name" },
      },
      required: ["database", "table"],
    },
    handler: async ({ database, table }) => {
      const result = await runCommand("sqlite3", [
        database as string,
        "-cmd",
        ".mode json",
        `PRAGMA table_info(${table})`,
      ]);
      if (result.code !== 0) {
        throw new Error(`sqlite3 failed: ${result.stderr}`);
      }
      try {
        return { columns: JSON.parse(result.stdout || "[]"), table };
      } catch {
        return { output: result.stdout };
      }
    },
  },
  {
    name: "psql_tables",
    description:
      "List all tables in a PostgreSQL database. Get table names, schemas, and types. Use for database exploration, documentation, or migration planning. Keywords: postgres tables, list tables, pg_tables, postgresql schema, table list.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string", description: "Database host" },
        port: { type: "number", description: "Port (default: 5432)" },
        database: { type: "string", description: "Database name" },
        user: { type: "string", description: "Username" },
        schema: { type: "string", description: "Schema filter (default: public)" },
      },
      required: ["database"],
    },
    handler: async ({ host = "localhost", port = 5432, database, user, schema = "public" }) => {
      const query =
        `SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = '${schema}' ORDER BY table_name`;
      const args = ["-h", host as string, "-p", String(port), "-d", database as string];
      if (user) args.push("-U", user as string);
      args.push("-t", "-A", "-F", ",", "-c", query);

      const result = await runCommand("psql", args);
      if (result.code !== 0) {
        throw new Error(`psql failed: ${result.stderr}`);
      }

      const lines = result.stdout.trim().split("\n").filter(Boolean);
      const tables = lines.map((line) => {
        const [name, type] = line.split(",");
        return { name, type };
      });
      return { tables, schema };
    },
  },
  {
    name: "psql_schema",
    description:
      "Get detailed schema information for a PostgreSQL table. View columns, types, constraints, and defaults. Use for documentation, migration, or data modeling. Keywords: postgres schema, table columns, pg describe, column types, table definition.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string", description: "Database host" },
        port: { type: "number", description: "Port (default: 5432)" },
        database: { type: "string", description: "Database name" },
        user: { type: "string", description: "Username" },
        table: { type: "string", description: "Table name" },
      },
      required: ["database", "table"],
    },
    handler: async ({ host = "localhost", port = 5432, database, user, table }) => {
      const query = `
        SELECT column_name, data_type, character_maximum_length, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_name = '${table}'
        ORDER BY ordinal_position`;
      const args = ["-h", host as string, "-p", String(port), "-d", database as string];
      if (user) args.push("-U", user as string);
      args.push("-t", "-A", "-F", "|", "-c", query);

      const result = await runCommand("psql", args);
      if (result.code !== 0) {
        throw new Error(`psql failed: ${result.stderr}`);
      }

      const lines = result.stdout.trim().split("\n").filter(Boolean);
      const columns = lines.map((line) => {
        const [name, type, maxLength, nullable, defaultVal] = line.split("|");
        return {
          name,
          type,
          maxLength: maxLength || null,
          nullable: nullable === "YES",
          default: defaultVal || null,
        };
      });
      return { columns, table };
    },
  },
  {
    name: "redis_keys",
    description:
      "List Redis keys matching a pattern. Search for keys using glob patterns (* ? []). Use for cache inspection, debugging, or key discovery. Keywords: redis keys, key pattern, list keys, redis scan, key search.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string", description: "Redis host (default: localhost)" },
        port: { type: "number", description: "Redis port (default: 6379)" },
        pattern: { type: "string", description: "Key pattern (default: *)" },
        database: { type: "number", description: "Database number" },
        count: { type: "number", description: "Max keys to return (default: 100)" },
      },
    },
    handler: async ({ host = "localhost", port = 6379, pattern = "*", database, count = 100 }) => {
      const args = ["-h", host as string, "-p", String(port)];
      if (database !== undefined) args.push("-n", String(database));
      args.push("--scan", "--pattern", pattern as string, "--count", String(count));

      const result = await runCommand("redis-cli", args);
      if (result.code !== 0) {
        throw new Error(`redis-cli failed: ${result.stderr}`);
      }
      const keys = result.stdout.trim().split("\n").filter(Boolean);
      return { keys, count: keys.length, pattern };
    },
  },
  {
    name: "redis_info",
    description:
      "Get Redis server information and statistics. View memory usage, connected clients, persistence status, replication info, and more. Use for monitoring, debugging, or capacity planning. Keywords: redis info, server stats, redis memory, redis status, server info.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string", description: "Redis host (default: localhost)" },
        port: { type: "number", description: "Redis port (default: 6379)" },
        section: {
          type: "string",
          description:
            "Info section (server, clients, memory, stats, replication, cpu, keyspace, all)",
        },
      },
    },
    handler: async ({ host = "localhost", port = 6379, section }) => {
      const args = ["-h", host as string, "-p", String(port), "INFO"];
      if (section) args.push(section as string);

      const result = await runCommand("redis-cli", args);
      if (result.code !== 0) {
        throw new Error(`redis-cli failed: ${result.stderr}`);
      }

      // Parse INFO output into object
      const info: Record<string, string | Record<string, string>> = {};
      let currentSection = "default";

      for (const line of result.stdout.split("\n")) {
        if (line.startsWith("#")) {
          currentSection = line.slice(2).trim().toLowerCase();
          info[currentSection] = {};
        } else if (line.includes(":")) {
          const [key, value] = line.split(":");
          if (typeof info[currentSection] === "object") {
            (info[currentSection] as Record<string, string>)[key.trim()] = value.trim();
          }
        }
      }

      return { info };
    },
  },
  {
    name: "redis_get",
    description:
      "Get the value of a Redis key with type detection. Automatically handles strings, hashes, lists, sets, and sorted sets. Use for inspecting cached data, debugging, or data retrieval. Keywords: redis get, key value, redis hgetall, redis lrange, fetch key.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string", description: "Redis host (default: localhost)" },
        port: { type: "number", description: "Redis port (default: 6379)" },
        key: { type: "string", description: "Key to retrieve" },
        database: { type: "number", description: "Database number" },
      },
      required: ["key"],
    },
    handler: async ({ host = "localhost", port = 6379, key, database }) => {
      const baseArgs = ["-h", host as string, "-p", String(port)];
      if (database !== undefined) baseArgs.push("-n", String(database));

      // First get the type
      const typeResult = await runCommand("redis-cli", [...baseArgs, "TYPE", key as string]);
      if (typeResult.code !== 0) {
        throw new Error(`redis-cli failed: ${typeResult.stderr}`);
      }
      const keyType = typeResult.stdout.trim();

      if (keyType === "none") {
        return { key, exists: false };
      }

      let value: unknown;
      let cmd: string[];

      switch (keyType) {
        case "string":
          cmd = [...baseArgs, "GET", key as string];
          break;
        case "hash":
          cmd = [...baseArgs, "HGETALL", key as string];
          break;
        case "list":
          cmd = [...baseArgs, "LRANGE", key as string, "0", "-1"];
          break;
        case "set":
          cmd = [...baseArgs, "SMEMBERS", key as string];
          break;
        case "zset":
          cmd = [...baseArgs, "ZRANGE", key as string, "0", "-1", "WITHSCORES"];
          break;
        default:
          cmd = [...baseArgs, "GET", key as string];
      }

      const result = await runCommand("redis-cli", cmd);
      if (result.code !== 0) {
        throw new Error(`redis-cli failed: ${result.stderr}`);
      }

      value = result.stdout.trim();

      // Parse hash results into object
      if (keyType === "hash") {
        const lines = (value as string).split("\n");
        const hash: Record<string, string> = {};
        for (let i = 0; i < lines.length; i += 2) {
          if (lines[i] && lines[i + 1]) {
            hash[lines[i]] = lines[i + 1];
          }
        }
        value = hash;
      }

      // Parse list/set into array
      if (keyType === "list" || keyType === "set") {
        value = (value as string).split("\n").filter(Boolean);
      }

      return { key, type: keyType, value, exists: true };
    },
  },
  {
    name: "redis_set",
    description:
      "Set a Redis key with optional expiration. Store string values with TTL for caching. Use for caching data, session storage, or temporary data. Keywords: redis set, store key, redis setex, cache value, key expiry.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string", description: "Redis host (default: localhost)" },
        port: { type: "number", description: "Redis port (default: 6379)" },
        key: { type: "string", description: "Key name" },
        value: { type: "string", description: "Value to store" },
        ttl: { type: "number", description: "Time to live in seconds" },
        database: { type: "number", description: "Database number" },
        nx: { type: "boolean", description: "Only set if key doesn't exist" },
        xx: { type: "boolean", description: "Only set if key exists" },
      },
      required: ["key", "value"],
    },
    handler: async ({ host = "localhost", port = 6379, key, value, ttl, database, nx, xx }) => {
      const args = ["-h", host as string, "-p", String(port)];
      if (database !== undefined) args.push("-n", String(database));
      args.push("SET", key as string, value as string);
      if (ttl) args.push("EX", String(ttl));
      if (nx) args.push("NX");
      if (xx) args.push("XX");

      const result = await runCommand("redis-cli", args);
      if (result.code !== 0) {
        throw new Error(`redis-cli failed: ${result.stderr}`);
      }
      return { key, success: result.stdout.trim() === "OK", ttl: ttl || null };
    },
  },
  {
    name: "redis_del",
    description:
      "Delete one or more Redis keys. Remove keys from the database. Use for cache invalidation, cleanup, or data removal. Keywords: redis del, delete key, remove key, cache invalidate, key delete.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string", description: "Redis host (default: localhost)" },
        port: { type: "number", description: "Redis port (default: 6379)" },
        keys: { type: "array", items: { type: "string" }, description: "Keys to delete" },
        database: { type: "number", description: "Database number" },
      },
      required: ["keys"],
    },
    handler: async ({ host = "localhost", port = 6379, keys, database }) => {
      const args = ["-h", host as string, "-p", String(port)];
      if (database !== undefined) args.push("-n", String(database));
      args.push("DEL", ...(keys as string[]));

      const result = await runCommand("redis-cli", args);
      if (result.code !== 0) {
        throw new Error(`redis-cli failed: ${result.stderr}`);
      }
      return { deleted: parseInt(result.stdout.trim(), 10), keys };
    },
  },
  {
    name: "mongo_query",
    description:
      "Execute MongoDB queries using mongosh. Run find, aggregate, insert, update, or delete operations. Use for document database operations, data analysis, or administration. Keywords: mongodb query, mongosh, mongo find, document query, nosql query.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string", description: "MongoDB host (default: localhost)" },
        port: { type: "number", description: "Port (default: 27017)" },
        database: { type: "string", description: "Database name" },
        collection: { type: "string", description: "Collection name" },
        operation: {
          type: "string",
          enum: ["find", "findOne", "count", "aggregate", "insertOne", "updateOne", "deleteOne"],
          description: "Operation type",
        },
        query: { description: "Query document or pipeline" },
        options: { description: "Operation options (projection, sort, limit, etc.)" },
      },
      required: ["database", "collection", "operation"],
    },
    handler: async (
      {
        host = "localhost",
        port = 27017,
        database,
        collection,
        operation,
        query = {},
        options = {},
      },
    ) => {
      const uri = `mongodb://${host}:${port}/${database}`;

      let jsCode: string;
      const q = JSON.stringify(query);
      const opts = JSON.stringify(options);

      switch (operation) {
        case "find":
          jsCode = `db.${collection}.find(${q}, ${opts}).toArray()`;
          break;
        case "findOne":
          jsCode = `db.${collection}.findOne(${q}, ${opts})`;
          break;
        case "count":
          jsCode = `db.${collection}.countDocuments(${q})`;
          break;
        case "aggregate":
          jsCode = `db.${collection}.aggregate(${q}).toArray()`;
          break;
        case "insertOne":
          jsCode = `db.${collection}.insertOne(${q})`;
          break;
        case "updateOne":
          jsCode = `db.${collection}.updateOne(${q}, ${opts})`;
          break;
        case "deleteOne":
          jsCode = `db.${collection}.deleteOne(${q})`;
          break;
        default:
          throw new Error(`Unknown operation: ${operation}`);
      }

      const result = await runCommand("mongosh", [
        uri,
        "--quiet",
        "--json=relaxed",
        "--eval",
        `JSON.stringify(${jsCode})`,
      ]);

      if (result.code !== 0) {
        throw new Error(`mongosh failed: ${result.stderr}`);
      }

      try {
        return { result: JSON.parse(result.stdout), operation };
      } catch {
        return { output: result.stdout, operation };
      }
    },
  },
  {
    name: "mongo_collections",
    description:
      "List collections in a MongoDB database. Get collection names and types. Use for database exploration or schema discovery. Keywords: mongo collections, list collections, mongodb schema, collection names.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string", description: "MongoDB host (default: localhost)" },
        port: { type: "number", description: "Port (default: 27017)" },
        database: { type: "string", description: "Database name" },
      },
      required: ["database"],
    },
    handler: async ({ host = "localhost", port = 27017, database }) => {
      const uri = `mongodb://${host}:${port}/${database}`;

      const result = await runCommand("mongosh", [
        uri,
        "--quiet",
        "--json=relaxed",
        "--eval",
        "JSON.stringify(db.getCollectionNames())",
      ]);

      if (result.code !== 0) {
        throw new Error(`mongosh failed: ${result.stderr}`);
      }

      try {
        return { collections: JSON.parse(result.stdout), database };
      } catch {
        return { output: result.stdout };
      }
    },
  },
];
