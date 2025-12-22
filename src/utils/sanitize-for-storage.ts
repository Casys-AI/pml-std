/**
 * Sanitization Utility for Execution Trace Storage
 *
 * Story 11.2: AC #11 - Data sanitization before storage.
 *
 * Provides:
 * - Redaction of sensitive fields (API keys, tokens, passwords)
 * - Truncation of large payloads (>10KB → summary)
 * - Safe JSON-serializable output
 *
 * @module utils/sanitize-for-storage
 */

import type { JsonValue } from "../capabilities/types.ts";

/**
 * Patterns for sensitive field detection
 * Case-insensitive matching on object keys
 */
const SENSITIVE_PATTERNS = [
  /api[_-]?key/i,
  /token/i,
  /password/i,
  /secret/i,
  /authorization/i,
  /bearer/i,
  /credential/i,
  /private[_-]?key/i,
  /access[_-]?key/i,
  /session[_-]?id/i,
  /cookie/i,
  /auth/i,
];

/**
 * Maximum size for string values before truncation (10KB)
 */
const MAX_VALUE_SIZE = 10 * 1024;

/**
 * Maximum depth for recursive sanitization (prevent stack overflow)
 */
const MAX_DEPTH = 20;

/**
 * Redaction marker for sensitive values
 */
const REDACTED_MARKER = "[REDACTED]";

/**
 * Check if a key matches sensitive patterns
 *
 * @param key - The object key to check
 * @returns true if key matches a sensitive pattern
 */
function isSensitiveKey(key: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(key));
}

/**
 * Truncate a string if it exceeds MAX_VALUE_SIZE
 *
 * @param value - The string to potentially truncate
 * @returns Original string or truncation marker
 */
function truncateIfNeeded(value: string): string {
  if (value.length > MAX_VALUE_SIZE) {
    return `[TRUNCATED: ${value.length} chars, preview: ${value.slice(0, 100)}...]`;
  }
  return value;
}

/**
 * Sanitize data for safe storage in the database
 *
 * Performs:
 * 1. Redaction of sensitive keys (api_key, token, password, etc.)
 * 2. Truncation of large string values (>10KB)
 * 3. Safe handling of all JSON-serializable types
 *
 * @param data - Any data to sanitize (unknown type)
 * @param depth - Current recursion depth (internal)
 * @returns JSON-serializable sanitized value
 *
 * @example
 * ```typescript
 * const input = {
 *   path: "/home/user/file.txt",
 *   api_key: "sk-secret-123",
 *   content: "...(large string)..."
 * };
 *
 * const sanitized = sanitizeForStorage(input);
 * // Result:
 * // {
 * //   path: "/home/user/file.txt",
 * //   api_key: "[REDACTED]",
 * //   content: "[TRUNCATED: 50000 chars, preview: ...]"
 * // }
 * ```
 */
export function sanitizeForStorage(data: unknown, depth = 0): JsonValue {
  // Prevent stack overflow from deeply nested structures
  if (depth > MAX_DEPTH) {
    return "[MAX_DEPTH_EXCEEDED]";
  }

  // Handle null/undefined
  if (data === null || data === undefined) {
    return null;
  }

  // Handle primitives
  if (typeof data === "string") {
    return truncateIfNeeded(data);
  }

  if (typeof data === "number") {
    // Handle special number values
    if (Number.isNaN(data)) return null;
    if (!Number.isFinite(data)) return null;
    return data;
  }

  if (typeof data === "boolean") {
    return data;
  }

  // Handle arrays
  if (Array.isArray(data)) {
    return data.map((item) => sanitizeForStorage(item, depth + 1));
  }

  // Handle Date objects (convert to ISO string)
  if (data instanceof Date) {
    return data.toISOString();
  }

  // Handle objects
  if (typeof data === "object") {
    const result: Record<string, JsonValue> = {};

    for (const [key, value] of Object.entries(data)) {
      // Redact sensitive keys
      if (isSensitiveKey(key)) {
        result[key] = REDACTED_MARKER;
      } else {
        result[key] = sanitizeForStorage(value, depth + 1);
      }
    }

    return result;
  }

  // Handle functions, symbols, and other non-serializable types
  if (typeof data === "function") {
    return "[FUNCTION]";
  }

  if (typeof data === "symbol") {
    return "[SYMBOL]";
  }

  if (typeof data === "bigint") {
    return data.toString();
  }

  // Fallback: convert to string
  return String(data);
}

/**
 * Check if a value contains sensitive data
 *
 * Useful for pre-checking before storage decisions.
 *
 * @param data - Any data to check
 * @returns true if any sensitive patterns are detected
 */
export function containsSensitiveData(data: unknown): boolean {
  if (data === null || data === undefined) {
    return false;
  }

  if (typeof data === "object" && !Array.isArray(data)) {
    for (const key of Object.keys(data)) {
      if (isSensitiveKey(key)) {
        return true;
      }
    }

    // Recursively check nested objects
    for (const value of Object.values(data)) {
      if (containsSensitiveData(value)) {
        return true;
      }
    }
  }

  if (Array.isArray(data)) {
    return data.some(containsSensitiveData);
  }

  return false;
}

/**
 * Get the size of a value when serialized to JSON
 *
 * @param data - Any data to measure
 * @returns Size in bytes
 */
export function getSerializedSize(data: unknown): number {
  try {
    return JSON.stringify(data).length;
  } catch {
    return 0;
  }
}
