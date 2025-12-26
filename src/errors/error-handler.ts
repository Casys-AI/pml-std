/**
 * Error Handler Utility
 *
 * Provides centralized error handling with logging, user-friendly messages,
 * and database persistence for post-mortem analysis.
 *
 * @module errors/error-handler
 */

import { getLogger } from "../telemetry/logger.ts";
import type { DbClient } from "../db/types.ts";
import { PMLError } from "./error-types.ts";

const log = getLogger("default");

/**
 * Centralized error handler
 *
 * Features:
 * - Structured logging with context
 * - User-friendly console messages
 * - Suggestions for error resolution
 * - Database persistence for post-mortem analysis
 */
export class ErrorHandler {
  /**
   * Handle error with logging and user-friendly message
   *
   * @param error - The error to handle
   * @param context - Optional context string for debugging
   */
  static handle(error: Error, context?: string): void {
    if (error instanceof PMLError) {
      // Custom error - log with structured context
      log.error(`[${error.code}] ${error.message}`, {
        code: error.code,
        recoverable: error.recoverable,
        context,
        stack: error.stack,
      });

      // Show user-friendly message
      if (error.recoverable) {
        console.warn(`⚠️  ${error.message}`);
      } else {
        console.error(`❌ ${error.message}`);
      }

      // Show suggestion if available
      if (error.suggestion) {
        console.log(`💡 Suggestion: ${error.suggestion}`);
      }
    } else {
      // Unknown error - log full stack
      log.error(`Unexpected error: ${error.message}`, {
        stack: error.stack,
        context,
      });

      console.error(`❌ Unexpected error: ${error.message}`);
      console.log(
        `💡 Please report this issue with logs from ~/.pml/logs/`,
      );
    }
  }

  /**
   * Wrap async operation with error handling
   *
   * Catches errors, logs them, and optionally returns a fallback value.
   * If no fallback is provided, re-throws the error after logging.
   *
   * @param operation - The async operation to execute
   * @param context - Context string for debugging
   * @param fallback - Optional fallback value to return on error
   * @returns Result of operation or fallback value
   * @throws Re-throws error if no fallback provided
   *
   * @example
   * ```typescript
   * const result = await ErrorHandler.wrapAsync(
   *   () => fetchData(),
   *   "fetchData operation",
   *   [] // fallback to empty array on error
   * );
   * ```
   */
  static async wrapAsync<T>(
    operation: () => Promise<T>,
    context: string,
    fallback?: T,
  ): Promise<T | undefined> {
    try {
      return await operation();
    } catch (error) {
      this.handle(error as Error, context);

      if (fallback !== undefined) {
        return fallback;
      }

      throw error; // Re-throw if no fallback
    }
  }

  /**
   * Persist error to database for post-mortem analysis
   *
   * Stores error information including type, message, stack trace,
   * and additional context in the error_log table.
   *
   * If database logging fails, falls back to console logging only
   * to prevent cascading failures.
   *
   * @param db - PGlite database client
   * @param error - The error to log
   * @param context - Optional context object with additional information
   */
  static async logToDatabase(
    db: DbClient,
    error: Error,
    context?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await db.exec(
        `INSERT INTO error_log (error_type, message, stack, context, timestamp)
         VALUES ($1, $2, $3, $4, NOW())`,
        [
          error.name,
          error.message,
          error.stack || null,
          JSON.stringify(context || {}),
        ],
      );
    } catch (dbError) {
      // If database logging fails, just log to console
      // Don't throw to prevent cascading failures
      console.error("Failed to log error to database:", dbError);
    }
  }
}
