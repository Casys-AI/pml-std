/**
 * Code Transformer - Replaces capability display_names with FQDNs
 *
 * When saving capabilities, this transformer ensures that any references
 * to other capabilities use FQDNs (immutable) instead of display_names (mutable).
 *
 * Uses shared SWC analyzer for robust AST-based parsing.
 *
 * Patterns handled (capabilities use same syntax as MCP tools):
 * - `mcp.namespace.action(args)` → `mcp["local.default.ns.action.hash"](args)`
 *
 * The action name is resolved against the capability registry. If found,
 * it's replaced with the immutable FQDN. If not found, it's left as-is
 * (assumed to be an MCP tool call, not a capability).
 *
 * @module capabilities/code-transformer
 */

import type { CapabilityRegistry, Scope } from "./capability-registry.ts";
import { analyzeCode } from "./swc-analyzer.ts";
import { getLogger } from "../telemetry/logger.ts";

const logger = getLogger("default");

/**
 * Default scope for capability resolution
 */
const DEFAULT_SCOPE: Scope = { org: "local", project: "default" };

/**
 * Result of code transformation
 */
export interface CodeTransformResult {
  /** Transformed code with FQDNs */
  code: string;
  /** Number of references replaced */
  replacedCount: number;
  /** Map of display_name → FQDN for references found */
  replacements: Record<string, string>;
  /** Names that couldn't be resolved (kept as-is) */
  unresolved: string[];
}

/**
 * Transform capability references in code from display_name to FQDN
 *
 * Uses the shared SWC analyzer to find all capability references, then
 * resolves each display_name to its FQDN via the registry.
 *
 * @param code - The code to transform
 * @param registry - CapabilityRegistry for name resolution
 * @param scope - Scope for resolution (default: local.default)
 * @returns Transformed code and metadata
 */
export async function transformCapabilityRefs(
  code: string,
  registry: CapabilityRegistry,
  scope: Scope = DEFAULT_SCOPE,
): Promise<CodeTransformResult> {
  const replacements: Record<string, string> = {};
  const unresolved: string[] = [];
  let replacedCount = 0;

  // Use shared SWC analyzer - capabilities use mcp.namespace.action() syntax
  const analysis = await analyzeCode(code);

  if (!analysis.success) {
    logger.warn("Failed to parse code for transformation, returning as-is", {
      error: analysis.error,
    });
    return { code, replacedCount: 0, replacements: {}, unresolved: [] };
  }

  // Capabilities use the same syntax as tools: mcp.namespace.action()
  const toolRefs = analysis.tools;

  if (toolRefs.length === 0) {
    return { code, replacedCount: 0, replacements: {}, unresolved: [] };
  }

  logger.debug("Found mcp.*.* references in code", {
    count: toolRefs.length,
    refs: toolRefs.map((r) => r.toolId),
  });

  // Resolve each unique action name to FQDN
  // The "tool" field contains the action name (last part of mcp.namespace.action)
  const uniqueActions = [...new Set(toolRefs.map((r) => r.tool))];
  for (const actionName of uniqueActions) {
    // Skip if already looks like an FQDN (contains dots with structure)
    if (actionName.includes(".") && actionName.split(".").length >= 4) {
      logger.debug("Skipping already-FQDN reference", { actionName });
      continue;
    }

    try {
      // Try to resolve as capability by action name (display_name)
      const record = await registry.resolveByName(actionName, scope);
      if (record) {
        replacements[actionName] = record.id; // record.id is the FQDN
        logger.debug("Resolved capability action to FQDN", {
          actionName,
          fqdn: record.id,
        });
      } else {
        // Not found in registry - probably an MCP tool, not a capability
        logger.debug("Action not found as capability (may be MCP tool)", { actionName });
      }
    } catch (error) {
      unresolved.push(actionName);
      logger.warn("Error resolving capability action", {
        actionName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // If no capability replacements needed, return original
  if (Object.keys(replacements).length === 0) {
    return { code, replacedCount: 0, replacements: {}, unresolved };
  }

  // Transform the code by replacing capability references
  // Process in reverse order to maintain correct positions
  let transformedCode = code;
  const sortedRefs = [...toolRefs].sort((a, b) => b.start - a.start);

  // Use dynamic baseOffset to handle SWC's cumulative position tracking
  const baseOffset = analysis.baseOffset;

  logger.debug("Sorted refs for transformation", {
    count: sortedRefs.length,
    baseOffset,
    refs: sortedRefs.map((r) => r.tool),
  });

  for (const ref of sortedRefs) {
    const fqdn = replacements[ref.tool];
    if (!fqdn) continue; // Not a capability, skip

    // Adjust positions for the original code (not wrapped)
    // Use dynamic baseOffset to handle SWC's cumulative positions
    const start = ref.start - baseOffset;
    const end = ref.end - baseOffset;

    // Skip if positions are invalid (reference is in wrapper, not original code)
    if (start < 0 || end > code.length) continue;

    // Replace mcp.namespace.action with mcp["FQDN"]
    const before = transformedCode.substring(0, start);
    const after = transformedCode.substring(end);
    const replacement = `mcp["${fqdn}"]`;
    transformedCode = before + replacement + after;
    replacedCount++;
  }

  logger.info("Code transformation complete", {
    replacedCount,
    resolvedNames: Object.keys(replacements).length,
    unresolvedNames: unresolved.length,
  });

  return {
    code: transformedCode,
    replacedCount,
    replacements,
    unresolved,
  };
}
