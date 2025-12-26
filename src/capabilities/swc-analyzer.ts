/**
 * SWC Code Analyzer - Shared AST parsing for code analysis (Story 13.2)
 *
 * Provides a unified SWC-based parsing layer for:
 * - Extracting MCP tool calls (mcp.server.tool)
 * - Extracting capability references (capabilities.name)
 * - Position tracking for source code transformation
 *
 * Used by:
 * - static-structure-builder.ts: DAG construction
 * - code-transformer.ts: display_name → FQDN transformation
 *
 * @module capabilities/swc-analyzer
 */

import { parse } from "https://deno.land/x/swc@0.2.1/mod.ts";
import { getLogger } from "../telemetry/logger.ts";

const logger = getLogger("default");

/**
 * Reference to a capability in the source code
 *
 * DEPRECATED: Capabilities use the same syntax as tools (mcp.namespace.action)
 * Use MCPToolReference instead. This is kept for backward compatibility.
 *
 * @deprecated Use MCPToolReference - capabilities are invoked as mcp.namespace.action()
 */
export interface CapabilityReference {
  /** The capability name (display_name or already FQDN) */
  name: string;
  /** Start position in source (1-indexed from SWC) */
  start: number;
  /** End position in source (1-indexed from SWC) */
  end: number;
  /** Whether it's dot notation (true) or bracket notation (false) */
  isDotNotation: boolean;
}

/**
 * Reference to an MCP tool call in the source code
 */
export interface MCPToolReference {
  /** Server name (e.g., "filesystem") */
  server: string;
  /** Tool name (e.g., "read_file") */
  tool: string;
  /** Full tool ID (e.g., "filesystem:read_file") */
  toolId: string;
  /** Start position in source */
  start: number;
  /** End position in source */
  end: number;
  /** Extracted arguments (if any) */
  arguments?: Record<string, unknown>;
}

/**
 * Result of analyzing code with SWC
 */
export interface CodeAnalysisResult {
  /** Capability references found (capabilities.name or capabilities["name"]) */
  capabilities: CapabilityReference[];
  /** MCP tool references found (mcp.server.tool) */
  tools: MCPToolReference[];
  /** Whether parsing was successful */
  success: boolean;
  /** Error message if parsing failed */
  error?: string;
  /**
   * Dynamic base offset for position adjustment.
   * SWC maintains cumulative positions across parse() calls, so we need
   * to calculate the actual offset for each parse operation.
   */
  baseOffset: number;
}

/**
 * Analyze TypeScript code using SWC to extract references
 *
 * This is a single-pass analysis that extracts:
 * - All capability references for code transformation
 * - All MCP tool calls for DAG building
 *
 * @param code - TypeScript code to analyze
 * @returns Analysis result with all references found
 */
export async function analyzeCode(code: string): Promise<CodeAnalysisResult> {
  const capabilities: CapabilityReference[] = [];
  const tools: MCPToolReference[] = [];

  if (!code || code.trim().length === 0) {
    return { capabilities, tools, success: true, baseOffset: WRAPPER_OFFSET };
  }

  // Wrap code for parsing (consistent with static-structure-builder.ts)
  const wrappedCode = `(async () => { ${code} })()`;

  try {
    const ast = await parse(wrappedCode, {
      syntax: "typescript",
      target: "es2022",
    });

    // Calculate dynamic base offset
    // SWC accumulates positions across parse() calls, so we need to detect
    // where this AST actually starts and add the wrapper prefix length
    // deno-lint-ignore no-explicit-any
    const astSpanStart = (ast as any).span?.start ?? 0;
    const baseOffset = astSpanStart + WRAPPER_OFFSET;

    // Traverse AST and extract references
    visitNode(ast, capabilities, tools);

    logger.debug("Code analysis complete", {
      capabilityCount: capabilities.length,
      toolCount: tools.length,
      astSpanStart,
      baseOffset,
    });

    return { capabilities, tools, success: true, baseOffset };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.warn("Failed to parse code for analysis", { error: errorMsg });
    return {
      capabilities,
      tools,
      success: false,
      error: errorMsg,
      baseOffset: WRAPPER_OFFSET,
    };
  }
}

/**
 * Offset for the wrapper `(async () => { ` prefix
 * Used to convert AST positions to original code positions
 *
 * Counting: ( a s y n c   ( )   = >   {   = 15 characters
 */
export const WRAPPER_OFFSET = 15;

/**
 * Convert AST position to original code position
 *
 * @param astPosition - Position from SWC AST
 * @returns Position in original (unwrapped) code
 */
export function toOriginalPosition(astPosition: number): number {
  return astPosition - WRAPPER_OFFSET;
}

// =============================================================================
// AST Traversal
// =============================================================================

/**
 * Visit AST node and extract references
 */
// deno-lint-ignore no-explicit-any
function visitNode(
  node: any,
  capabilities: CapabilityReference[],
  tools: MCPToolReference[],
): void {
  if (!node || typeof node !== "object") return;

  // Check for MemberExpression patterns
  if (node.type === "MemberExpression") {
    // Check for capabilities.name or capabilities["name"]
    if (isCapabilitiesReference(node)) {
      const ref = extractCapabilityReference(node);
      if (ref) {
        capabilities.push(ref);
      }
    }

    // Note: mcp.server.tool detection is done at CallExpression level
    // to also capture arguments
  }

  // Check for CallExpression: mcp.server.tool()
  if (node.type === "CallExpression") {
    const toolRef = extractMCPToolReference(node);
    if (toolRef) {
      tools.push(toolRef);
    }
  }

  // Recurse through all properties
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        visitNode(item, capabilities, tools);
      }
    } else if (value && typeof value === "object") {
      visitNode(value, capabilities, tools);
    }
  }
}

/**
 * Check if node is a capabilities.* reference
 */
// deno-lint-ignore no-explicit-any
function isCapabilitiesReference(node: any): boolean {
  if (node.type !== "MemberExpression") return false;

  // Check if object is 'capabilities' identifier
  return (
    node.object?.type === "Identifier" &&
    node.object?.value === "capabilities"
  );
}

/**
 * Extract capability reference from MemberExpression
 *
 * SWC AST structure:
 * - Dot notation (capabilities.name): property.type === "Identifier"
 * - Bracket notation (capabilities["name"]): property.type === "Computed"
 *   with the string value in property.expression.value
 */
// deno-lint-ignore no-explicit-any
function extractCapabilityReference(node: any): CapabilityReference | null {
  let name: string | null = null;
  let isDotNotation = false;

  const prop = node.property;
  if (!prop) return null;

  if (prop.type === "Identifier") {
    // Dot notation: capabilities.name
    name = prop.value;
    isDotNotation = true;
  } else if (prop.type === "Computed") {
    // Bracket notation: capabilities["name"] or capabilities['name']
    // SWC wraps the string in a Computed node with expression property
    const expr = prop.expression;
    if (expr?.type === "StringLiteral") {
      name = expr.value;
      isDotNotation = false;
    }
  } else if (prop.type === "StringLiteral") {
    // Fallback: direct StringLiteral (older SWC versions)
    name = prop.value;
    isDotNotation = false;
  }

  if (name) {
    return {
      name,
      start: node.span?.start ?? 0,
      end: node.span?.end ?? 0,
      isDotNotation,
    };
  }

  return null;
}

/**
 * Check if node is an mcp.server.tool() call and extract reference
 */
// deno-lint-ignore no-explicit-any
function extractMCPToolReference(node: any): MCPToolReference | null {
  const callee = node.callee;
  if (!callee || callee.type !== "MemberExpression") return null;

  const chain = extractMemberChain(callee);

  // Check for mcp.server.tool pattern (at least 3 parts)
  if (chain.length >= 3 && chain[0] === "mcp") {
    const server = chain[1];
    const tool = chain[2];
    const toolId = `${server}:${tool}`;

    // Extract arguments if present
    const args = extractArguments(node.arguments);

    // Use callee span (mcp.server.tool) not node span (which includes args)
    // This allows correct code transformation
    return {
      server,
      tool,
      toolId,
      start: callee.span?.start ?? 0,
      end: callee.span?.end ?? 0,
      ...(Object.keys(args).length > 0 ? { arguments: args } : {}),
    };
  }

  return null;
}

/**
 * Extract member expression chain: mcp.filesystem.read → ["mcp", "filesystem", "read"]
 */
// deno-lint-ignore no-explicit-any
function extractMemberChain(node: any, parts: string[] = []): string[] {
  if (node.type === "Identifier") {
    return [node.value as string, ...parts];
  }

  if (node.type === "MemberExpression") {
    const prop = node.property;

    if (prop?.type === "Identifier" && typeof prop?.value === "string") {
      parts.unshift(prop.value);
    }

    return extractMemberChain(node.object, parts);
  }

  return parts;
}

/**
 * Extract arguments from CallExpression
 *
 * Supports:
 * - Object literals: { path: "file.txt" }
 * - Variable references (tracked by name)
 */
// deno-lint-ignore no-explicit-any
function extractArguments(args: any[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  if (!args || args.length === 0) return result;

  // SWC wraps arguments in { spread, expression } structure
  const firstArg = args[0];
  const argExpr = firstArg?.expression ?? firstArg;

  if (argExpr?.type === "ObjectExpression") {
    const props = argExpr.properties;
    if (Array.isArray(props)) {
      for (const prop of props) {
        if (prop.type === "KeyValueProperty" || prop.type === "Property") {
          const key = extractPropertyKey(prop);
          const value = extractPropertyValue(prop);
          if (key !== null) {
            result[key] = value;
          }
        }
      }
    }
  }

  return result;
}

/**
 * Extract property key from AST node
 */
// deno-lint-ignore no-explicit-any
function extractPropertyKey(prop: any): string | null {
  const key = prop.key;
  if (key?.type === "Identifier") {
    return key.value as string;
  }
  if (key?.type === "StringLiteral") {
    return key.value as string;
  }
  return null;
}

/**
 * Extract property value from AST node
 *
 * Handles:
 * - String/Number/Boolean literals
 * - Variable references (as "$varName" placeholder)
 * - Member expressions (as "$obj.prop" placeholder)
 */
// deno-lint-ignore no-explicit-any
function extractPropertyValue(prop: any): unknown {
  const value = prop.value;
  if (!value) return undefined;

  switch (value.type) {
    case "StringLiteral":
      return value.value;
    case "NumericLiteral":
      return value.value;
    case "BooleanLiteral":
      return value.value;
    case "NullLiteral":
      return null;
    case "Identifier":
      // Variable reference - return placeholder
      return `$${value.value}`;
    case "MemberExpression": {
      // Property access - return as path
      const chain = extractMemberChain(value);
      return `$${chain.join(".")}`;
    }
    case "ObjectExpression":
      // Nested object - extract recursively
      return extractArguments([{ expression: value }]);
    default:
      return undefined;
  }
}
