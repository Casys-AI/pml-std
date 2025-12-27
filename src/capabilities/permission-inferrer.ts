/**
 * Permission Inferrer (Epic 7 - Story 7.7a)
 *
 * Automatically infers permission requirements from TypeScript code using SWC AST parser.
 * Analyzes code patterns (fetch, mcp.*, Deno.* APIs) to determine minimal permission sets
 * following the principle of least privilege.
 *
 * Permission model (simplified 2025-12-19):
 * - scope: Resource access level (metadata for audit/documentation)
 * - approvalMode: auto (works freely) or hil (requires human approval)
 *
 * Note: Worker sandbox always runs with permissions: "none".
 * These are METADATA used for validation detection, not enforcement.
 *
 * @module capabilities/permission-inferrer
 */

import { parse } from "https://deno.land/x/swc@0.2.1/mod.ts";
import { parse as parseYaml } from "@std/yaml";
import { getLogger } from "../telemetry/logger.ts";
import type { ApprovalMode, PermissionConfig, PermissionScope, PermissionSet } from "./types.ts";

const logger = getLogger("default");

// Re-export types for convenience (canonical definition in types.ts)
export type { ApprovalMode, PermissionConfig, PermissionScope, PermissionSet } from "./types.ts";

/**
 * Pattern types detected in code analysis
 */
export type PatternCategory = "network" | "filesystem" | "env" | "unknown";

/**
 * Detected pattern in code analysis
 */
export interface DetectedPattern {
  /** The pattern identifier (e.g., "fetch", "mcp.filesystem.read") */
  pattern: string;
  /** Category of the pattern */
  category: PatternCategory;
  /** Whether this is a read-only operation */
  isReadOnly: boolean;
}

/**
 * Result of permission inference
 */
export interface InferredPermissions {
  /** The determined permission set profile */
  permissionSet: PermissionSet;
  /** Confidence score (0-1) based on pattern clarity */
  confidence: number;
  /** List of detected patterns for debugging/logging */
  detectedPatterns: string[];
}

/**
 * MCP tool permission config entry (from YAML)
 *
 * Supports two formats:
 * 1. Shorthand (legacy): { permissionSet: "network-api", isReadOnly: true }
 * 2. Explicit (new): { scope: "network-api", approvalMode: "auto" }
 */
interface McpPermissionConfigLegacy {
  permissionSet: PermissionSet;
  isReadOnly: boolean;
}

/**
 * Explicit permission config (simplified model)
 */
interface McpPermissionConfigExplicit {
  scope: PermissionScope;
  approvalMode?: ApprovalMode;
  isReadOnly?: boolean;
}

/**
 * Union type for YAML config - supports both formats
 */
type McpPermissionConfigYaml = McpPermissionConfigLegacy | McpPermissionConfigExplicit;

/**
 * Check if config is in explicit format (new model)
 */
function isExplicitConfig(config: McpPermissionConfigYaml): config is McpPermissionConfigExplicit {
  return "scope" in config;
}

/**
 * Convert YAML config entry to PermissionConfig
 */
function toPermissionConfig(config: McpPermissionConfigYaml): PermissionConfig {
  if (isExplicitConfig(config)) {
    return {
      scope: config.scope,
      approvalMode: config.approvalMode ?? "auto",
    };
  }
  // Legacy format - convert shorthand to explicit
  const scope: PermissionScope = config.permissionSet === "trusted"
    ? "mcp-standard"
    : config.permissionSet;
  return {
    scope,
    approvalMode: "auto",
  };
}

/**
 * Internal cache entry with both legacy and new formats
 */
interface McpPermissionCacheEntry {
  legacy: McpPermissionConfigLegacy;
  config: PermissionConfig;
}

/**
 * MCP tool prefix to permission mapping
 * Loaded from config/mcp-permissions.yaml at runtime
 */
let MCP_TOOL_PERMISSIONS: Record<string, McpPermissionCacheEntry> | null = null;

/**
 * Default fallback permissions (used if config file not found)
 */
const DEFAULT_MCP_PERMISSIONS: Record<string, McpPermissionCacheEntry> = {
  "filesystem": {
    legacy: { permissionSet: "filesystem", isReadOnly: false },
    config: { scope: "filesystem", approvalMode: "auto" },
  },
  "fs": {
    legacy: { permissionSet: "filesystem", isReadOnly: false },
    config: { scope: "filesystem", approvalMode: "auto" },
  },
  "github": {
    legacy: { permissionSet: "network-api", isReadOnly: false },
    config: { scope: "network-api", approvalMode: "auto" },
  },
  "slack": {
    legacy: { permissionSet: "network-api", isReadOnly: false },
    config: { scope: "network-api", approvalMode: "auto" },
  },
  "tavily": {
    legacy: { permissionSet: "network-api", isReadOnly: false },
    config: { scope: "network-api", approvalMode: "auto" },
  },
  "api": {
    legacy: { permissionSet: "network-api", isReadOnly: false },
    config: { scope: "network-api", approvalMode: "auto" },
  },
  "kubernetes": {
    legacy: { permissionSet: "mcp-standard", isReadOnly: false },
    config: { scope: "mcp-standard", approvalMode: "auto" },
  },
  "docker": {
    legacy: { permissionSet: "mcp-standard", isReadOnly: false },
    config: { scope: "mcp-standard", approvalMode: "auto" },
  },
};

/**
 * Load MCP permissions from YAML config file
 * Falls back to defaults if file not found
 *
 * Supports both formats:
 * - Shorthand: { permissionSet: "network-api", isReadOnly: true }
 * - Explicit: { scope: "network-api", approvalMode: "auto" }
 */
async function loadMcpPermissions(): Promise<Record<string, McpPermissionCacheEntry>> {
  if (MCP_TOOL_PERMISSIONS !== null) {
    return MCP_TOOL_PERMISSIONS;
  }

  try {
    // Try multiple possible config paths
    const configPaths = [
      "./config/mcp-permissions.yaml",
      "../config/mcp-permissions.yaml",
      "../../config/mcp-permissions.yaml",
    ];

    for (const configPath of configPaths) {
      try {
        const content = await Deno.readTextFile(configPath);
        const parsed = parseYaml(content) as Record<string, McpPermissionConfigYaml>;

        // Convert to cache entries with both legacy and config formats
        const cacheEntries: Record<string, McpPermissionCacheEntry> = {};
        for (const [key, value] of Object.entries(parsed)) {
          const config = toPermissionConfig(value);
          const isReadOnly = isExplicitConfig(value)
            ? (value.isReadOnly ?? false)
            : value.isReadOnly;

          cacheEntries[key] = {
            legacy: {
              permissionSet: config.scope,
              isReadOnly,
            },
            config,
          };
        }

        MCP_TOOL_PERMISSIONS = cacheEntries;
        logger.debug("MCP permissions loaded from config", {
          path: configPath,
          toolCount: Object.keys(cacheEntries).length,
        });
        return MCP_TOOL_PERMISSIONS;
      } catch {
        // Try next path
      }
    }

    // No config file found, use defaults
    logger.debug("MCP permissions config not found, using defaults");
    MCP_TOOL_PERMISSIONS = DEFAULT_MCP_PERMISSIONS;
    return MCP_TOOL_PERMISSIONS;
  } catch (error) {
    logger.warn("Failed to load MCP permissions config, using defaults", {
      error: error instanceof Error ? error.message : String(error),
    });
    MCP_TOOL_PERMISSIONS = DEFAULT_MCP_PERMISSIONS;
    return MCP_TOOL_PERMISSIONS;
  }
}

/**
 * Get MCP tool permissions (sync version for internal use)
 * Returns cached permissions or defaults
 */
function getMcpPermissions(): Record<string, McpPermissionCacheEntry> {
  return MCP_TOOL_PERMISSIONS ?? DEFAULT_MCP_PERMISSIONS;
}

/**
 * Get PermissionConfig for a specific tool prefix
 *
 * @param toolPrefix - MCP tool prefix (e.g., "fermat", "github")
 * @returns PermissionConfig or null if not found
 */
export function getToolPermissionConfig(toolPrefix: string): PermissionConfig | null {
  const cache = getMcpPermissions();
  return cache[toolPrefix]?.config ?? null;
}

/**
 * Force reload of MCP permissions config
 * Useful for testing or when config file changes
 */
export function reloadMcpPermissions(): void {
  MCP_TOOL_PERMISSIONS = null;
}

/**
 * Filesystem read-only operations
 */
const FILESYSTEM_READ_OPS = new Set([
  "read",
  "readFile",
  "readTextFile",
  "readDir",
  "stat",
  "lstat",
  "realPath",
]);

/**
 * PermissionInferrer - Infers permission requirements from TypeScript code
 *
 * Uses SWC (Rust-based parser) to analyze code and detect I/O patterns.
 * Returns minimal permission sets based on detected patterns.
 *
 * @example
 * ```typescript
 * const inferrer = new PermissionInferrer();
 * const permissions = await inferrer.inferPermissions(`
 *   const data = await fetch("https://api.example.com/data");
 *   return data.json();
 * `);
 * // Returns:
 * // {
 * //   permissionSet: "network-api",
 * //   confidence: 0.95,
 * //   detectedPatterns: ["fetch"]
 * // }
 * ```
 */
export class PermissionInferrer {
  private configLoaded = false;

  constructor() {
    logger.debug("PermissionInferrer initialized");
  }

  /**
   * Ensure MCP permissions config is loaded
   * Called automatically on first inferPermissions() call
   */
  private async ensureConfigLoaded(): Promise<void> {
    if (!this.configLoaded) {
      await loadMcpPermissions();
      this.configLoaded = true;
    }
  }

  /**
   * Infer permission requirements from TypeScript code
   *
   * @param code TypeScript code to analyze
   * @returns Permission inference result with set, confidence, and patterns
   */
  async inferPermissions(code: string): Promise<InferredPermissions> {
    try {
      // Ensure MCP permissions config is loaded
      await this.ensureConfigLoaded();

      // Wrap code in function if not already (for valid parsing)
      const wrappedCode = this.wrapCodeIfNeeded(code);

      // Parse with SWC
      const ast = await parse(wrappedCode, {
        syntax: "typescript",
        comments: false,
        script: true,
      });

      logger.debug("Code parsed for permission inference", {
        codeLength: code.length,
      });

      // Find all I/O patterns
      const patterns = this.findPatterns(ast);

      logger.debug("Patterns detected for permissions", {
        count: patterns.length,
        patterns: patterns.map((p) => p.pattern),
      });

      // Map patterns to permission set
      const result = this.mapPatternsToPermissionSet(patterns);

      logger.debug("Permission inference result", {
        permissionSet: result.permissionSet,
        confidence: result.confidence,
        patternCount: result.detectedPatterns.length,
      });

      return result;
    } catch (error) {
      // Non-critical: return minimal with low confidence on parse errors
      logger.warn("Permission inference failed, returning minimal", {
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        permissionSet: "minimal",
        confidence: 0.0,
        detectedPatterns: [],
      };
    }
  }

  /**
   * Wrap code in function if needed for valid parsing
   * (Same pattern as SchemaInferrer)
   */
  private wrapCodeIfNeeded(code: string): string {
    // Check if code already contains function/class/export declarations
    if (
      code.includes("function ") ||
      code.includes("class ") ||
      code.includes("export ")
    ) {
      return code;
    }

    // Wrap in async function for valid parsing
    return `async function _agentCardsWrapper() {\n${code}\n}`;
  }

  /**
   * Find all I/O patterns in the AST
   */
  private findPatterns(
    node: unknown,
    patterns: Map<string, DetectedPattern> = new Map(),
  ): DetectedPattern[] {
    if (!node || typeof node !== "object") {
      return Array.from(patterns.values());
    }

    const n = node as Record<string, unknown>;

    // CallExpression: fetch(), Deno.readFile(), etc.
    if (n.type === "CallExpression") {
      this.handleCallExpression(n, patterns);
    }

    // MemberExpression: mcp.filesystem, Deno.env, process.env
    if (n.type === "MemberExpression") {
      this.handleMemberExpression(n, patterns);
    }

    // Recurse through AST
    for (const key of Object.keys(n)) {
      const val = n[key];
      if (Array.isArray(val)) {
        for (const item of val) {
          this.findPatterns(item, patterns);
        }
      } else if (typeof val === "object" && val !== null) {
        this.findPatterns(val, patterns);
      }
    }

    return Array.from(patterns.values());
  }

  /**
   * Handle CallExpression nodes: fetch(), Deno.readFile(), mcp.fs.read()
   */
  private handleCallExpression(
    n: Record<string, unknown>,
    patterns: Map<string, DetectedPattern>,
  ): void {
    const callee = n.callee as Record<string, unknown> | undefined;

    if (!callee) return;

    // Direct function call: fetch()
    if (callee.type === "Identifier") {
      const name = callee.value as string;

      if (name === "fetch") {
        patterns.set("fetch", {
          pattern: "fetch",
          category: "network",
          isReadOnly: false,
        });
      }
    }

    // Member expression call: Deno.readFile(), mcp.filesystem.read()
    if (callee.type === "MemberExpression") {
      const chainParts = this.extractMemberChain(callee);

      if (chainParts.length >= 2) {
        const pattern = chainParts.join(".");
        const detected = this.classifyPattern(chainParts);

        if (detected) {
          patterns.set(pattern, detected);
        }
      }
    }
  }

  /**
   * Handle MemberExpression nodes for property access patterns
   */
  private handleMemberExpression(
    n: Record<string, unknown>,
    patterns: Map<string, DetectedPattern>,
  ): void {
    const chainParts = this.extractMemberChain(n);

    // Detect Deno.env or process.env access
    if (chainParts.length >= 2) {
      const root = chainParts[0];
      const prop = chainParts[1];

      if ((root === "Deno" && prop === "env") || (root === "process" && prop === "env")) {
        const pattern = `${root}.${prop}`;
        patterns.set(pattern, {
          pattern,
          category: "env",
          isReadOnly: true, // Reading env vars
        });
      }
    }
  }

  /**
   * Extract member expression chain as array of strings
   * e.g., mcp.filesystem.read → ["mcp", "filesystem", "read"]
   */
  private extractMemberChain(
    node: Record<string, unknown>,
    parts: string[] = [],
  ): string[] {
    if (node.type === "Identifier") {
      return [node.value as string, ...parts];
    }

    if (node.type === "MemberExpression") {
      const obj = node.object as Record<string, unknown>;
      const prop = node.property as Record<string, unknown>;

      if (prop?.type === "Identifier" && typeof prop?.value === "string") {
        parts.unshift(prop.value);
      }

      return this.extractMemberChain(obj, parts);
    }

    return parts;
  }

  /**
   * Classify a member chain into a detected pattern
   */
  private classifyPattern(chainParts: string[]): DetectedPattern | null {
    const root = chainParts[0];

    // Deno.* patterns
    if (root === "Deno") {
      return this.classifyDenoPattern(chainParts);
    }

    // mcp.* patterns
    if (root === "mcp") {
      return this.classifyMCPPattern(chainParts);
    }

    return null;
  }

  /**
   * Classify Deno.* patterns
   */
  private classifyDenoPattern(chainParts: string[]): DetectedPattern | null {
    if (chainParts.length < 2) return null;

    const api = chainParts[1];
    const pattern = chainParts.join(".");

    // Network patterns
    if (api === "connect") {
      return {
        pattern,
        category: "network",
        isReadOnly: false,
      };
    }

    // Filesystem patterns
    if (
      api === "readFile" || api === "readTextFile" || api === "readDir" ||
      api === "stat" || api === "lstat" || api === "realPath"
    ) {
      return {
        pattern,
        category: "filesystem",
        isReadOnly: true,
      };
    }

    if (
      api === "writeFile" || api === "writeTextFile" || api === "mkdir" ||
      api === "remove" || api === "rename" || api === "copyFile"
    ) {
      return {
        pattern,
        category: "filesystem",
        isReadOnly: false,
      };
    }

    // Env pattern
    if (api === "env") {
      return {
        pattern,
        category: "env",
        isReadOnly: true,
      };
    }

    return null;
  }

  /**
   * Classify mcp.* patterns
   */
  private classifyMCPPattern(chainParts: string[]): DetectedPattern | null {
    if (chainParts.length < 2) return null;

    const toolPrefix = chainParts[1];
    const operation = chainParts.length > 2 ? chainParts[2] : undefined;
    const pattern = chainParts.join(".");

    // Check known MCP tool prefixes (loaded from config/mcp-permissions.yaml)
    const toolEntry = getMcpPermissions()[toolPrefix];

    if (toolEntry) {
      let isReadOnly = toolEntry.legacy.isReadOnly;

      // For filesystem tools, check if operation is read-only
      if ((toolPrefix === "filesystem" || toolPrefix === "fs") && operation) {
        isReadOnly = FILESYSTEM_READ_OPS.has(operation);
      }

      // Determine category based on permission scope
      let category: PatternCategory;
      const scope = toolEntry.config.scope;
      if (scope === "network-api") {
        category = "network";
      } else if (scope === "filesystem" || scope === "readonly") {
        category = "filesystem";
      } else {
        // mcp-standard or minimal tools → unknown category
        category = "unknown";
      }

      return {
        pattern,
        category,
        isReadOnly,
      };
    }

    // Unknown MCP tool - default to mcp-standard
    return {
      pattern,
      category: "unknown",
      isReadOnly: false,
    };
  }

  /**
   * Map detected patterns to a permission set with confidence score
   */
  private mapPatternsToPermissionSet(patterns: DetectedPattern[]): InferredPermissions {
    const patternStrings = patterns.map((p) => p.pattern);

    // No patterns detected → minimal with high confidence
    if (patterns.length === 0) {
      return {
        permissionSet: "minimal",
        confidence: 0.95,
        detectedPatterns: [],
      };
    }

    // Categorize patterns
    const hasNetwork = patterns.some((p) => p.category === "network");
    const hasFilesystem = patterns.some((p) => p.category === "filesystem");
    const hasEnv = patterns.some((p) => p.category === "env");
    const hasUnknown = patterns.some((p) => p.category === "unknown");

    // All filesystem read-only
    const allFsReadOnly = patterns
      .filter((p) => p.category === "filesystem")
      .every((p) => p.isReadOnly);

    // Single category patterns → higher confidence
    const categoryCount = [hasNetwork, hasFilesystem, hasEnv, hasUnknown].filter(Boolean).length;

    // Mixed patterns or unknown → mcp-standard with lower confidence
    if (hasUnknown || categoryCount > 1) {
      return {
        permissionSet: "mcp-standard",
        confidence: hasUnknown ? 0.50 : 0.70,
        detectedPatterns: patternStrings,
      };
    }

    // Network only
    if (hasNetwork && !hasFilesystem && !hasEnv) {
      return {
        permissionSet: "network-api",
        confidence: patterns.length > 1 ? 0.95 : 0.90,
        detectedPatterns: patternStrings,
      };
    }

    // Filesystem only
    if (hasFilesystem && !hasNetwork && !hasEnv) {
      const permissionSet = allFsReadOnly ? "readonly" : "filesystem";
      return {
        permissionSet,
        confidence: patterns.length > 1 ? 0.95 : 0.90,
        detectedPatterns: patternStrings,
      };
    }

    // Env only → minimal (env access doesn't escalate to higher permissions)
    if (hasEnv && !hasNetwork && !hasFilesystem) {
      return {
        permissionSet: "mcp-standard", // Env access needs mcp-standard
        confidence: 0.80,
        detectedPatterns: patternStrings,
      };
    }

    // Fallback to mcp-standard
    return {
      permissionSet: "mcp-standard",
      confidence: 0.70,
      detectedPatterns: patternStrings,
    };
  }
}
