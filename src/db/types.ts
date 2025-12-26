/**
 * Database Client Types
 *
 * Common interface for database clients (PGlite and PostgreSQL).
 * Both clients implement this interface for seamless switching.
 *
 * @module db/types
 */

/**
 * Row returned from database query
 */
export interface Row {
  [key: string]: unknown;
}

/**
 * Transaction context for batch operations
 */
export interface Transaction {
  exec(sql: string, params?: unknown[]): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<Row[]>;
}

/**
 * Common database client interface
 *
 * Both PGliteClient and PostgresClient implement this interface.
 * Use this type instead of concrete client types for portability.
 */
export interface DbClient {
  /**
   * Connect to the database
   */
  connect(): Promise<void>;

  /**
   * Execute SQL statement without returning results
   */
  exec(sql: string, params?: unknown[]): Promise<void>;

  /**
   * Execute query and return results
   */
  query(sql: string, params?: unknown[]): Promise<Row[]>;

  /**
   * Execute single row query, returns first row or null
   */
  queryOne(sql: string, params?: unknown[]): Promise<Row | null>;

  /**
   * Run a transaction
   */
  transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;

  /**
   * Close database connection
   */
  close(): Promise<void>;
}
