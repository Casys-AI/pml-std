/**
 * Code Transformer - Code transformations for capability storage
 *
 * Provides two transformations:
 *
 * 1. **Capability References** (transformCapabilityRefs):
 *    - `mcp.namespace.action(args)` → `mcp["$cap:<uuid>"](args)`
 *    - Ensures capabilities use immutable UUIDs instead of mutable names
 *
 * 2. **Literal Parameterization** (transformLiteralsToArgs):
 *    - `const token = "sk-xxx"; mcp.api({ auth: token })` → `mcp.api({ auth: args.token })`
 *    - Makes capabilities shareable in cloud mode by removing hardcoded values
 *    - Generates parameter schema from extracted literals
 *
 * Uses shared SWC analyzer for robust AST-based parsing.
 *
 * @module capabilities/code-transformer
 */

import { parse } from "https://deno.land/x/swc@0.2.1/mod.ts";
import type { CapabilityRegistry, Scope } from "./capability-registry.ts";
import { analyzeCode, WRAPPER_OFFSET } from "./swc-analyzer.ts";
import type { JSONSchema } from "./types.ts";
import type { JsonValue } from "./types.ts";
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
  /** Transformed code with $cap:<uuid> references */
  code: string;
  /** Number of references replaced */
  replacedCount: number;
  /** Map of name → UUID for references found */
  replacements: Record<string, string>;
  /** Names that couldn't be resolved (kept as-is) */
  unresolved: string[];
}

/**
 * Transform capability references in code from names to UUID references
 *
 * Uses the shared SWC analyzer to find all capability references, then
 * resolves each name to its UUID via the registry.
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

  // Resolve each unique action name to UUID
  // The "tool" field contains the action name (last part of mcp.namespace.action)
  const uniqueActions = [...new Set(toolRefs.map((r) => r.tool))];
  for (const actionName of uniqueActions) {
    // Skip if already a $cap: reference (already transformed)
    if (actionName.startsWith("$cap:")) {
      logger.debug("Skipping already-transformed $cap: reference", { actionName });
      continue;
    }

    try {
      // Try to resolve as capability by action name (namespace:action format)
      const record = await registry.resolveByName(actionName, scope);
      if (record) {
        replacements[actionName] = record.id; // record.id is the UUID
        logger.debug("Resolved capability action to UUID", {
          actionName,
          uuid: record.id,
        });
      } else {
        // Not found in registry - probably an MCP tool, not a capability
        logger.debug("Action not found as capability (may be MCP tool)", { actionName });
      }
    } catch (error) {
      // Errors during resolution are bugs that need fixing - propagate the error
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error("Error resolving capability action", {
        actionName,
        error: errorMsg,
      });
      throw new Error(`Failed to resolve capability action '${actionName}': ${errorMsg}`);
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
    const uuid = replacements[ref.tool];
    if (!uuid) continue; // Not a capability, skip

    // Adjust positions for the original code (not wrapped)
    // Use dynamic baseOffset to handle SWC's cumulative positions
    const start = ref.start - baseOffset;
    const end = ref.end - baseOffset;

    // Skip if positions are invalid (reference is in wrapper, not original code)
    if (start < 0 || end > code.length) continue;

    // Replace mcp.namespace.action with mcp["$cap:<uuid>"]
    const before = transformedCode.substring(0, start);
    const after = transformedCode.substring(end);
    const replacement = `mcp["$cap:${uuid}"]`;
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

// =============================================================================
// Literal Parameterization (Cloud Mode)
// =============================================================================

/**
 * Result of literal-to-args transformation
 */
export interface LiteralTransformResult {
  /** Transformed code with args.xxx references */
  code: string;
  /** Number of literals replaced */
  replacedCount: number;
  /** Generated parameter schema */
  parametersSchema: JSONSchema;
  /** Map of paramName → original literal value (for defaults/examples) */
  extractedLiterals: Record<string, JsonValue>;
}

/**
 * Position of an identifier in source code
 */
interface IdentifierPosition {
  /** Variable name */
  name: string;
  /** Start position in source */
  start: number;
  /** End position in source */
  end: number;
  /** Whether this is a declaration (const x = ...) vs usage */
  isDeclaration: boolean;
}

/**
 * Transform literal bindings to args.xxx references
 *
 * Makes capabilities shareable in cloud mode by:
 * 1. Removing variable declarations that hold literals (const token = "sk-xxx")
 * 2. Replacing usages of those variables with args.xxx (token → args.token)
 * 3. Generating a parameter schema for the capability
 *
 * @param code - The code to transform
 * @param literalBindings - Map of variable names to their literal values
 * @returns Transformed code, schema, and metadata
 *
 * @example
 * ```typescript
 * const result = await transformLiteralsToArgs(
 *   'const token = "sk-xxx"; await mcp.api({ auth: token });',
 *   { token: "sk-xxx" }
 * );
 * // result.code = 'await mcp.api({ auth: args.token });'
 * // result.parametersSchema = { properties: { token: { type: "string" } } }
 * ```
 */
export async function transformLiteralsToArgs(
  code: string,
  literalBindings: Record<string, JsonValue>,
): Promise<LiteralTransformResult> {
  const extractedLiterals: Record<string, JsonValue> = { ...literalBindings };

  // No literals to transform
  if (Object.keys(literalBindings).length === 0) {
    return {
      code,
      replacedCount: 0,
      parametersSchema: { type: "object", properties: {} },
      extractedLiterals: {},
    };
  }

  // Parse code with SWC
  const wrappedCode = `(async () => { ${code} })()`;
  let ast;
  try {
    ast = await parse(wrappedCode, {
      syntax: "typescript",
      target: "es2022",
    });
  } catch (error) {
    logger.warn("Failed to parse code for literal transformation", {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      code,
      replacedCount: 0,
      parametersSchema: { type: "object", properties: {} },
      extractedLiterals: {},
    };
  }

  // Calculate base offset for position adjustment
  // deno-lint-ignore no-explicit-any
  const astSpanStart = (ast as any).span?.start ?? 0;
  const baseOffset = astSpanStart + WRAPPER_OFFSET;

  // Find all identifier positions (declarations and usages)
  const identifierPositions: IdentifierPosition[] = [];
  const literalNames = new Set(Object.keys(literalBindings));

  findIdentifierPositions(ast, literalNames, identifierPositions);

  if (identifierPositions.length === 0) {
    return {
      code,
      replacedCount: 0,
      parametersSchema: { type: "object", properties: {} },
      extractedLiterals: {},
    };
  }

  logger.debug("Found identifier positions for literals", {
    count: identifierPositions.length,
    literals: Array.from(literalNames),
  });

  // Sort by position descending to replace from end to start
  const sortedPositions = [...identifierPositions].sort((a, b) => b.start - a.start);

  // Track which declarations to remove (we'll remove entire statements)
  const declarationsToRemove: { start: number; end: number }[] = [];

  // Transform code
  let transformedCode = code;
  let replacedCount = 0;

  for (const pos of sortedPositions) {
    const start = pos.start - baseOffset;
    const end = pos.end - baseOffset;

    // Skip if positions are invalid
    if (start < 0 || end > code.length) continue;

    if (pos.isDeclaration) {
      // Find the full declaration statement to remove
      const declBounds = findDeclarationBounds(code, start, end);
      if (declBounds) {
        declarationsToRemove.push(declBounds);
      }
    } else {
      // Replace usage: token → args.token
      const before = transformedCode.substring(0, start);
      const after = transformedCode.substring(end);
      transformedCode = before + `args.${pos.name}` + after;
      replacedCount++;
    }
  }

  // Remove declarations (process in reverse order to maintain positions)
  const sortedDeclarations = [...declarationsToRemove].sort((a, b) => b.start - a.start);
  for (const decl of sortedDeclarations) {
    // Skip if already processed (overlapping declarations)
    if (decl.start < 0 || decl.end > transformedCode.length) continue;

    const before = transformedCode.substring(0, decl.start);
    const after = transformedCode.substring(decl.end);
    transformedCode = before + after;
  }

  // Clean up: remove empty lines and extra whitespace
  transformedCode = transformedCode
    .split("\n")
    .filter((line) => line.trim() !== "")
    .join("\n")
    .trim();

  // Generate parameter schema
  const parametersSchema = generateSchemaFromLiterals(literalBindings);

  logger.info("Literal-to-args transformation complete", {
    replacedCount,
    removedDeclarations: declarationsToRemove.length,
    parameters: Object.keys(literalBindings),
  });

  return {
    code: transformedCode,
    replacedCount,
    parametersSchema,
    extractedLiterals,
  };
}

/**
 * Two-pass approach for finding identifier positions:
 * Pass 1: Find all declarations to remove
 * Pass 2: Find all usages (independently of declarations)
 *
 * This is more robust than a single-pass approach because:
 * - No dependency on AST traversal order
 * - Clear separation of concerns
 * - Handles edge cases like `const b = a + "world"` correctly
 */
function findIdentifierPositions(
  // deno-lint-ignore no-explicit-any
  node: any,
  literalNames: Set<string>,
  positions: IdentifierPosition[],
): void {
  // Pass 1: Find declarations
  const declarations = findLiteralDeclarations(node, literalNames);

  // Pass 2: Find all usages (skip declaration positions)
  const declarationSpans = new Set(
    declarations.map((d) => `${d.start}-${d.end}`)
  );
  const usages = findAllUsages(node, literalNames, declarationSpans);

  // Combine results
  positions.push(...declarations, ...usages);
}

/**
 * Pass 1: Find all variable declarations for literals we want to remove
 */
function findLiteralDeclarations(
  // deno-lint-ignore no-explicit-any
  node: any,
  literalNames: Set<string>,
  results: IdentifierPosition[] = [],
): IdentifierPosition[] {
  if (!node || typeof node !== "object") return results;

  if (node.type === "VariableDeclarator") {
    const id = node.id;
    if (id?.type === "Identifier" && literalNames.has(id.value)) {
      results.push({
        name: id.value,
        start: id.span?.start ?? 0,
        end: id.span?.end ?? 0,
        isDeclaration: true,
      });
    }
  }

  // Recurse through all properties
  for (const key of Object.keys(node)) {
    if (key === "span") continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        findLiteralDeclarations(item, literalNames, results);
      }
    } else if (value && typeof value === "object") {
      findLiteralDeclarations(value, literalNames, results);
    }
  }

  return results;
}

/**
 * Pass 2: Find all usages of literal names (excluding declarations and args.xxx)
 */
function findAllUsages(
  // deno-lint-ignore no-explicit-any
  node: any,
  literalNames: Set<string>,
  declarationSpans: Set<string>,
  results: IdentifierPosition[] = [],
): IdentifierPosition[] {
  if (!node || typeof node !== "object") return results;

  // Skip args.xxx member expressions entirely
  if (node.type === "MemberExpression") {
    const obj = node.object;
    if (obj?.type === "Identifier" && obj?.value === "args") {
      return results;
    }
  }

  // Check for identifier usage
  if (node.type === "Identifier") {
    const name = node.value;
    if (literalNames.has(name)) {
      const start = node.span?.start ?? 0;
      const end = node.span?.end ?? 0;
      const spanKey = `${start}-${end}`;

      // Skip if this is a declaration position
      if (!declarationSpans.has(spanKey)) {
        results.push({
          name,
          start,
          end,
          isDeclaration: false,
        });
      }
    }
  }

  // Recurse through all properties
  for (const key of Object.keys(node)) {
    if (key === "span") continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        findAllUsages(item, literalNames, declarationSpans, results);
      }
    } else if (value && typeof value === "object") {
      findAllUsages(value, literalNames, declarationSpans, results);
    }
  }

  return results;
}

/**
 * Find the bounds of a variable declaration statement
 *
 * Given "const token = 'xxx';" returns the full statement bounds
 * including any trailing semicolon and newline
 */
function findDeclarationBounds(
  code: string,
  identStart: number,
  identEnd: number,
): { start: number; end: number } | null {
  // Search backward for 'const', 'let', or 'var'
  let start = identStart;
  while (start > 0) {
    const slice = code.substring(start - 5, start);
    if (slice.includes("const") || slice.includes("let") || slice.includes("var")) {
      // Find exact keyword start
      const keywordMatch = code.substring(Math.max(0, start - 10), identEnd).match(/\b(const|let|var)\b/);
      if (keywordMatch?.index !== undefined) {
        start = Math.max(0, start - 10) + keywordMatch.index;
        break;
      }
    }
    start--;
  }

  // Search forward for semicolon or newline
  let end = identEnd;
  while (end < code.length) {
    const char = code[end];
    if (char === ";") {
      end++; // Include semicolon
      // Also include trailing newline if present
      if (code[end] === "\n") end++;
      break;
    }
    if (char === "\n") {
      end++; // Include newline
      break;
    }
    end++;
  }

  return { start, end };
}

/**
 * Generate JSON Schema from literal bindings
 */
function generateSchemaFromLiterals(
  literals: Record<string, JsonValue>,
): JSONSchema {
  const properties: Record<string, JSONSchema> = {};

  for (const [name, value] of Object.entries(literals)) {
    const propSchema: JSONSchema = {};

    if (typeof value === "string") {
      propSchema.type = "string";
      // Add example for documentation
      if (value.length > 0 && value.length < 100) {
        propSchema.examples = [value];
      }
    } else if (typeof value === "number") {
      propSchema.type = Number.isInteger(value) ? "integer" : "number";
      propSchema.examples = [value];
    } else if (typeof value === "boolean") {
      propSchema.type = "boolean";
      propSchema.default = value;
    } else if (Array.isArray(value)) {
      propSchema.type = "array";
      // Infer item type from first element
      if (value.length > 0) {
        const firstType = typeof value[0];
        if (firstType === "string" || firstType === "number" || firstType === "boolean") {
          propSchema.items = { type: firstType };
        }
      }
    } else if (value !== null && typeof value === "object") {
      propSchema.type = "object";
    }

    properties[name] = propSchema;
  }

  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties,
    required: Object.keys(literals), // All extracted literals are required
  };
}
