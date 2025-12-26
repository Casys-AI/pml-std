/**
 * Capability Code Generator (Story 7.3b)
 *
 * Generates inline JavaScript code for capabilities with:
 * - __trace() wrappers for capability tracing (via BroadcastChannel - ADR-036)
 * - Cycle detection via depth tracking
 * - Code sanitization for security
 *
 * @module capabilities/code-generator
 */

import type { Capability } from "./types.ts";
import { getLogger } from "../telemetry/logger.ts";

const logger = getLogger("default");

/**
 * Maximum call depth for capabilities (prevents infinite recursion)
 */
const MAX_DEPTH = 3;

/**
 * Blocked patterns for security (prevents dangerous code execution)
 * These patterns are checked BEFORE code is injected into Worker
 */
const BLOCKED_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  { pattern: /\beval\s*\(/, description: "eval() calls" },
  { pattern: /\bFunction\s*\(/, description: "Function constructor" },
  { pattern: /\bimport\s*\(/, description: "dynamic import()" },
  { pattern: /\bimport\s+/, description: "static import" },
  { pattern: /\bexport\s+/, description: "export statement" },
  { pattern: /\brequire\s*\(/, description: "require() calls" },
  { pattern: /\b__proto__\b/, description: "prototype pollution" },
  { pattern: /\bconstructor\s*\[/, description: "constructor access" },
  { pattern: /\bDeno\b/, description: "Deno namespace access" },
  { pattern: /\bself\b/, description: "Worker self reference" },
  // Allow globalThis.__capabilityDepth for depth tracking
  {
    pattern: /\bglobalThis\b(?!\.__capabilityDepth)/,
    description: "globalThis access (except depth)",
  },
];

/**
 * CapabilityCodeGenerator - Generates inline JavaScript code for capabilities
 *
 * Capabilities are converted to async functions with:
 * - __trace() calls for capability_start/capability_end events
 * - Depth tracking to prevent infinite recursion (max 3 levels)
 * - Code sanitization to block dangerous patterns
 *
 * @example
 * ```typescript
 * const generator = new CapabilityCodeGenerator();
 * const inlineCode = generator.generateInlineCode(capability);
 * const contextCode = generator.buildCapabilitiesObject([capability1, capability2]);
 * ```
 */
export class CapabilityCodeGenerator {
  private usedNames: Set<string> = new Set();

  /**
   * Generate inline function code for a single capability
   *
   * Wraps capability code with:
   * - Depth check (throws if > MAX_DEPTH)
   * - __trace() calls for start/end events
   * - try/catch for error tracing
   *
   * @param capability - The capability to generate code for
   * @param normalizedName - Optional pre-computed normalized name (used by buildCapabilitiesObject)
   * @returns JavaScript async function code string
   */
  generateInlineCode(capability: Capability, normalizedName?: string): string {
    // 1. Sanitize capability code (throws if dangerous patterns detected)
    const sanitizedCode = this.sanitizeCapabilityCode(capability.codeSnippet);

    // 2. Use provided name or normalize (for standalone calls)
    const name = normalizedName ?? this.normalizeCapabilityName(
      capability.name || "",
      capability.id,
    );

    // 3. Generate inline function with tracing + depth guard
    // Note: __trace and __capabilityDepth are provided by sandbox-worker.ts
    // ADR-041: Robust stack management with single capability_end emission in finally
    // Story 11.1: Capture result and durationMs for learning
    // Convention: camelCase for event payload fields (per implementation-patterns.md)
    return `async (args) => {
  const __depth = (__capabilityDepth || 0);
  if (__depth >= ${MAX_DEPTH}) {
    throw new Error("Capability depth exceeded (max: ${MAX_DEPTH}). Possible cycle detected.");
  }
  __capabilityDepth = __depth + 1;
  __trace({ type: "capability_start", capability: "${name}", capabilityId: "${capability.id}", args });
  let __capSuccess = true;
  let __capError = null;
  let __capResult = undefined;
  const __capStartTime = Date.now();
  try {
    __capResult = await (async () => { ${sanitizedCode} })();
    return __capResult;
  } catch (e) {
    __capSuccess = false;
    __capError = e;
    throw e;
  } finally {
    __capabilityDepth = __depth;
    __trace({ type: "capability_end", capability: "${name}", capabilityId: "${capability.id}", success: __capSuccess, error: __capError?.message, result: __capResult, durationMs: Date.now() - __capStartTime });
  }
}`;
  }

  /**
   * Build full capabilities object code from multiple capabilities
   *
   * Creates a JavaScript object with all capabilities as methods:
   * ```javascript
   * // Depth tracking for cycle detection (closure-scoped)
   * let __capabilityDepth = 0;
   * const capabilities = {
   *   runTests: async (args) => { ... },
   *   "local.default.fs.read.a7f3": async (args) => { ... }, // FQDN key (Story 13.2)
   * };
   * ```
   *
   * Story 13.2: Capabilities are exposed by FQDN (immutable) for cross-capability
   * references in transformed code. The normalized name is also kept for backward
   * compatibility with non-transformed code.
   *
   * @param capabilities - Array of capabilities to include
   * @returns JavaScript code string defining capabilities object
   */
  buildCapabilitiesObject(capabilities: Capability[]): string {
    this.usedNames.clear();

    if (capabilities.length === 0) {
      // Include depth tracking even for empty capabilities (consistency)
      return "let __capabilityDepth = 0;\nconst capabilities = {};";
    }

    const entries: string[] = [];

    for (const cap of capabilities) {
      // Compute normalized name FIRST (adds to usedNames for collision tracking)
      const name = this.normalizeCapabilityName(cap.name || "", cap.id);

      // Generate code with the pre-computed name (avoids double collision detection)
      const code = this.generateInlineCode(cap, name);

      // Story 13.2: Expose by FQDN (primary key for transformed code)
      if (cap.fqdn) {
        // FQDN requires bracket notation since it contains dots
        entries.push(`  "${cap.fqdn}": ${code}`);
      }

      // Also expose by normalized name for backward compatibility
      entries.push(`  ${name}: ${code}`);
    }

    // Include __capabilityDepth as closure-scoped variable
    // This is accessible by all capability functions but not directly manipulable by user code
    return `let __capabilityDepth = 0;\nconst capabilities = {\n${entries.join(",\n")}\n};`;
  }

  /**
   * Sanitize capability code for security
   *
   * Checks for dangerous patterns that could:
   * - Execute arbitrary code (eval, Function)
   * - Escape sandbox (import, require, Deno, self)
   * - Pollute prototypes (__proto__, constructor)
   *
   * @param code - Raw capability code snippet
   * @returns Sanitized code (same as input if valid)
   * @throws Error if dangerous patterns detected
   */
  private sanitizeCapabilityCode(code: string): string {
    for (const { pattern, description } of BLOCKED_PATTERNS) {
      if (pattern.test(code)) {
        const error = new Error(`Blocked pattern detected in capability code: ${description}`);
        logger.error("Capability code sanitization failed", {
          pattern: pattern.toString(),
          description,
          codeSnippet: code.substring(0, 100),
        });
        throw error;
      }
    }

    // Validate syntactic correctness (basic check)
    // Note: Full syntax validation happens when Worker executes the code
    if (code.includes("${") && !code.includes("`")) {
      // Template literal syntax outside template string - potential injection
      throw new Error("Invalid template literal syntax in capability code");
    }

    logger.debug("Capability code sanitized", {
      codeLength: code.length,
    });

    return code;
  }

  /**
   * Normalize capability name to valid JavaScript identifier
   *
   * Rules:
   * - Replace non-alphanumeric with underscores
   * - Can't start with number (prefix with _)
   * - Handle collisions by appending last 4 chars of UUID
   *
   * @param name - Human-readable capability name
   * @param id - Capability UUID (used for collision handling)
   * @returns Valid JavaScript identifier
   */
  private normalizeCapabilityName(name: string, id: string): string {
    // Start with name or id
    let normalized = (name || id)
      .replace(/[^a-zA-Z0-9_]/g, "_")
      .replace(/^[0-9]/, "_$&"); // Can't start with number

    // Ensure not empty
    if (!normalized) {
      normalized = `cap_${id.slice(-8)}`;
    }

    // Handle collisions: append last 4 chars of UUID
    if (this.usedNames.has(normalized)) {
      normalized = `${normalized}_${id.slice(-4)}`;
    }

    this.usedNames.add(normalized);
    return normalized;
  }

  /**
   * Reset used names (call before building new capabilities object)
   */
  reset(): void {
    this.usedNames.clear();
  }
}
