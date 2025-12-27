/**
 * FQDN Utilities for Capability Registry (Story 13.1)
 *
 * Provides functions for generating, parsing, and validating Fully Qualified
 * Domain Names for capabilities.
 *
 * FQDN format: `<org>.<project>.<namespace>.<action>.<hash>`
 *
 * @example
 * - `local.default.fs.read_json.a7f3` - Local dev capability
 * - `acme.webapp.api.fetch_user.b8e2` - Organization capability
 *
 * @module capabilities/fqdn
 */

import type { FQDNComponents } from "./types.ts";

// Re-export types for convenience
export type { FQDNComponents } from "./types.ts";

/**
 * Regular expression for valid FQDN components
 *
 * Each component (org, project, namespace, action) must be:
 * - Alphanumeric with underscores, hyphens allowed
 * - Must start with a letter or underscore
 * - Cannot contain dots (reserved for separator)
 */
const COMPONENT_REGEX = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;

/**
 * Regular expression for valid 4-char hex hash
 */
const HASH_REGEX = /^[0-9a-f]{4}$/;

/**
 * Regular expression for valid MCP tool names (AC #4 constraint)
 *
 * MCP format constraints:
 * - Alphanumeric + underscores + hyphens + colons
 * - No spaces, no special characters
 * - Examples: read_config, myapp:fetch_user, analytics-compute, fs:read_json
 */
const MCP_NAME_REGEX = /^[a-zA-Z0-9_:-]+$/;

/**
 * Generate a 4-character hex hash from code content (AC4)
 *
 * Uses first 4 chars of SHA-256 hex for uniqueness within namespace.
 * This provides 65,536 possible hashes per namespace - sufficient for
 * typical projects while keeping FQDNs short.
 *
 * @param code - The code snippet to hash
 * @returns 4-character lowercase hex string
 *
 * @example
 * ```typescript
 * const hash = await generateHash("export function foo() { return 42; }");
 * // Returns something like "a7f3"
 * ```
 */
export async function generateHash(code: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(code);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = new Uint8Array(hashBuffer);
  const hex = Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex.substring(0, 4);
}

/**
 * Generate a FQDN from components (AC4)
 *
 * FQDN format: `<org>.<project>.<namespace>.<action>.<hash>`
 *
 * @param components - The FQDN components
 * @returns The fully qualified domain name
 * @throws Error if any component is invalid
 *
 * @example
 * ```typescript
 * const fqdn = generateFQDN({
 *   org: "local",
 *   project: "default",
 *   namespace: "fs",
 *   action: "read_json",
 *   hash: "a7f3"
 * });
 * // Returns: "local.default.fs.read_json.a7f3"
 * ```
 */
export function generateFQDN(components: FQDNComponents): string {
  const { org, project, namespace, action, hash } = components;

  // Validate each component
  if (!COMPONENT_REGEX.test(org)) {
    throw new Error(
      `Invalid org component: "${org}". Must be alphanumeric with underscores/hyphens, starting with letter or underscore.`,
    );
  }
  if (!COMPONENT_REGEX.test(project)) {
    throw new Error(
      `Invalid project component: "${project}". Must be alphanumeric with underscores/hyphens, starting with letter or underscore.`,
    );
  }
  if (!COMPONENT_REGEX.test(namespace)) {
    throw new Error(
      `Invalid namespace component: "${namespace}". Must be alphanumeric with underscores/hyphens, starting with letter or underscore.`,
    );
  }
  if (!COMPONENT_REGEX.test(action)) {
    throw new Error(
      `Invalid action component: "${action}". Must be alphanumeric with underscores/hyphens, starting with letter or underscore.`,
    );
  }
  if (!HASH_REGEX.test(hash)) {
    throw new Error(`Invalid hash: "${hash}". Must be exactly 4 lowercase hex characters.`);
  }

  return `${org}.${project}.${namespace}.${action}.${hash}`;
}

/**
 * Parse a FQDN into its components (AC6)
 *
 * @param fqdn - The fully qualified domain name to parse
 * @returns The parsed components
 * @throws Error if FQDN is malformed
 *
 * @example
 * ```typescript
 * const parts = parseFQDN("acme.webapp.fs.read_json.a7f3");
 * // Returns: { org: "acme", project: "webapp", namespace: "fs", action: "read_json", hash: "a7f3" }
 * ```
 */
export function parseFQDN(fqdn: string): FQDNComponents {
  const parts = fqdn.split(".");

  if (parts.length !== 5) {
    throw new Error(
      `Invalid FQDN format: "${fqdn}". Expected 5 parts (org.project.namespace.action.hash), got ${parts.length}.`,
    );
  }

  const [org, project, namespace, action, hash] = parts;

  // Validate each component
  if (!COMPONENT_REGEX.test(org)) {
    throw new Error(`Invalid org in FQDN: "${org}".`);
  }
  if (!COMPONENT_REGEX.test(project)) {
    throw new Error(`Invalid project in FQDN: "${project}".`);
  }
  if (!COMPONENT_REGEX.test(namespace)) {
    throw new Error(`Invalid namespace in FQDN: "${namespace}".`);
  }
  if (!COMPONENT_REGEX.test(action)) {
    throw new Error(`Invalid action in FQDN: "${action}".`);
  }
  if (!HASH_REGEX.test(hash)) {
    throw new Error(`Invalid hash in FQDN: "${hash}". Must be 4 lowercase hex characters.`);
  }

  return { org, project, namespace, action, hash };
}

/**
 * Check if a string is a valid FQDN
 *
 * @param fqdn - The string to check
 * @returns true if valid FQDN, false otherwise
 */
export function isValidFQDN(fqdn: string): boolean {
  try {
    parseFQDN(fqdn);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate that a name is valid for MCP tool names (AC #5 constraint)
 *
 * MCP format constraints:
 * - Alphanumeric + underscores + hyphens + colons only
 * - No spaces, no special characters that break MCP protocol
 *
 * @param name - The name to validate
 * @returns true if name is valid for MCP, false otherwise
 *
 * @example
 * ```typescript
 * isValidMCPName("read_config"); // true
 * isValidMCPName("myapp:fetch_user"); // true
 * isValidMCPName("analytics-compute"); // true
 * isValidMCPName("my function"); // false (has space)
 * isValidMCPName("foo@bar"); // false (has @)
 * ```
 */
export function isValidMCPName(name: string): boolean {
  if (!name || name.length === 0) {
    return false;
  }
  return MCP_NAME_REGEX.test(name);
}

/**
 * Extract display name from FQDN (AC5)
 *
 * Returns the action part of the FQDN as a fallback display name.
 * Note: The actual display_name is stored in the database and may differ.
 *
 * @param fqdn - The fully qualified domain name
 * @returns The action part as default display name
 *
 * @example
 * ```typescript
 * extractDefaultDisplayName("acme.webapp.fs.read_json.a7f3");
 * // Returns: "read_json"
 * ```
 */
export function extractDefaultDisplayName(fqdn: string): string {
  const components = parseFQDN(fqdn);
  return components.action;
}

/**
 * Generate a FQDN from components with automatic hash generation
 *
 * Convenience function that generates the hash from code content.
 *
 * @param org - Organization identifier
 * @param project - Project identifier
 * @param namespace - Namespace grouping
 * @param action - Action name
 * @param code - Code snippet to hash
 * @returns The fully qualified domain name
 *
 * @example
 * ```typescript
 * const fqdn = await generateFQDNFromCode(
 *   "local", "default", "fs", "read_json",
 *   "export function readJson(path: string) { ... }"
 * );
 * // Returns: "local.default.fs.read_json.a7f3"
 * ```
 */
export async function generateFQDNFromCode(
  org: string,
  project: string,
  namespace: string,
  action: string,
  code: string,
): Promise<string> {
  const hash = await generateHash(code);
  return generateFQDN({ org, project, namespace, action, hash });
}

/**
 * Check if an FQDN belongs to a given scope (org + project)
 *
 * @param fqdn - The FQDN to check
 * @param org - Expected organization
 * @param project - Expected project
 * @returns true if FQDN belongs to the scope
 */
export function fqdnBelongsToScope(
  fqdn: string,
  org: string,
  project: string,
): boolean {
  try {
    const components = parseFQDN(fqdn);
    return components.org === org && components.project === project;
  } catch {
    return false;
  }
}

/**
 * Create a short display representation of an FQDN
 *
 * Returns `namespace.action` for compact display.
 *
 * @param fqdn - The full FQDN
 * @returns Short representation (namespace.action)
 *
 * @example
 * ```typescript
 * getShortName("acme.webapp.fs.read_json.a7f3");
 * // Returns: "fs.read_json"
 * ```
 */
export function getShortName(fqdn: string): string {
  const { namespace, action } = parseFQDN(fqdn);
  return `${namespace}.${action}`;
}
