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
import { extractNestedLiterals } from "./nested-literal-extractor.ts";
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
 * Position of an inline literal in object property
 * e.g., { host: "localhost" } → "localhost" at position
 */
interface InlineLiteralPosition {
  /** Property name (will become args.propertyName) */
  propertyName: string;
  /** The literal value */
  value: JsonValue;
  /** Start position of the value in source */
  start: number;
  /** End position of the value in source */
  end: number;
}

/**
 * Position of a template literal containing code with nested literals
 * e.g., { code: `page.goto('http://localhost')` }
 * The nested literals inside will be extracted and parameterized
 */
interface CodeTemplateLiteralPosition {
  /** Property name (e.g., "code") */
  propertyName: string;
  /** The full template content */
  templateContent: string;
  /** Start position of the template content (after opening backtick) */
  contentStart: number;
  /** End position of the template content (before closing backtick) */
  contentEnd: number;
  /** Start position of the full template (including backtick) */
  start: number;
  /** End position of the full template (including backtick) */
  end: number;
}

/**
 * Check if a string looks like it contains code (heuristic)
 */
function looksLikeCode(content: string): boolean {
  // Must be substantial (more than simple value)
  if (content.length < 20) return false;

  // Look for code patterns
  const codePatterns = [
    /\bawait\b/, // async/await
    /\bfunction\b/, // function keyword
    /\b=>\b/, // arrow functions
    /\bpage\.\w+/, // Playwright page methods
    /\bdocument\.\w+/, // DOM access
    /\bwindow\.\w+/, // window access
    /\bconsole\.\w+/, // console methods
    /\breturn\b/, // return statement
    /\bconst\b|\blet\b|\bvar\b/, // variable declarations
    /\bif\s*\(/, // if statements
    /\bfor\s*\(/, // for loops
    /\bwhile\s*\(/, // while loops
    /\.\w+\s*\(/, // method calls
  ];

  return codePatterns.some((pattern) => pattern.test(content));
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

  // Parse code with SWC first - we need AST to discover MCP call literals
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

  // Story 10.2d: Also find inline literals in object properties
  // e.g., mcp.tool({ host: "localhost" }) → mcp.tool({ host: args.host })
  const inlineLiteralPositions: InlineLiteralPosition[] = [];
  findInlineLiteralPositions(ast, literalBindings, inlineLiteralPositions);

  // Story 10.2e: Discover ALL inline literals in MCP call arguments
  // e.g., mcp.std.cap_rename({ name: "xxx", namespace: "api" })
  // These are discovered even if not in literalBindings
  const mcpCallLiterals = findMcpCallInlineLiterals(ast);

  // Merge discovered MCP call literals into our collections
  // Filter out positions already covered by findInlineLiteralPositions
  const existingSpans = new Set(inlineLiteralPositions.map((p) => `${p.start}-${p.end}`));
  for (const pos of mcpCallLiterals.positions) {
    const spanKey = `${pos.start}-${pos.end}`;
    if (!existingSpans.has(spanKey)) {
      inlineLiteralPositions.push(pos);
      existingSpans.add(spanKey);
    }
  }

  // Merge discovered literals into extractedLiterals
  for (const [key, value] of Object.entries(mcpCallLiterals.discoveredLiterals)) {
    if (!(key in extractedLiterals)) {
      extractedLiterals[key] = value;
    }
  }

  if (identifierPositions.length === 0 && inlineLiteralPositions.length === 0 && mcpCallLiterals.codeTemplates.length === 0) {
    return {
      code,
      replacedCount: 0,
      parametersSchema: { type: "object", properties: {} },
      extractedLiterals: {},
    };
  }

  logger.debug("Found positions for literal transformation", {
    identifierCount: identifierPositions.length,
    inlineLiteralCount: inlineLiteralPositions.length,
    mcpCallLiteralCount: mcpCallLiterals.positions.length,
    literals: Array.from(literalNames),
    discoveredLiterals: Object.keys(mcpCallLiterals.discoveredLiterals),
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

  // Story 10.2d: Replace inline literals with args.xxx
  // Sort by position descending to replace from end to start
  const sortedInlineLiterals = [...inlineLiteralPositions].sort((a, b) => b.start - a.start);
  for (const pos of sortedInlineLiterals) {
    const start = pos.start - baseOffset;
    const end = pos.end - baseOffset;

    // Skip if positions are invalid
    if (start < 0 || end > transformedCode.length) continue;

    // Replace inline literal value with args.propertyName
    const before = transformedCode.substring(0, start);
    const after = transformedCode.substring(end);
    transformedCode = before + `args.${pos.propertyName}` + after;
    replacedCount++;
  }

  // Story 10.2f: Process code template literals (extract nested literals)
  // Sort by position descending to replace from end to start
  const sortedCodeTemplates = [...mcpCallLiterals.codeTemplates].sort((a, b) => b.start - a.start);
  for (const template of sortedCodeTemplates) {
    const contentStart = template.contentStart - baseOffset;
    const contentEnd = template.contentEnd - baseOffset;

    // Skip if positions are invalid
    if (contentStart < 0 || contentEnd > transformedCode.length) continue;

    // Extract nested literals from the template content
    const nestedResult = await extractNestedLiterals(template.templateContent);

    if (nestedResult.count > 0) {
      // Replace the template content with the transformed version (with interpolations)
      const before = transformedCode.substring(0, contentStart);
      const after = transformedCode.substring(contentEnd);
      transformedCode = before + nestedResult.transformedCode + after;
      replacedCount += nestedResult.count;

      // Add extracted literals to our collection (with prefix to avoid conflicts)
      for (const [name, value] of Object.entries(nestedResult.extractedLiterals)) {
        // Use property-prefixed name if there might be conflicts
        const paramName = `${template.propertyName}_${name}`;
        if (!(paramName in extractedLiterals) && !(name in extractedLiterals)) {
          // Prefer short name if no conflict
          extractedLiterals[name] = value;
        } else {
          extractedLiterals[paramName] = value;
        }
      }

      logger.debug("Extracted nested literals from code template", {
        propertyName: template.propertyName,
        nestedCount: nestedResult.count,
        params: Object.keys(nestedResult.extractedLiterals),
      });
    }
  }

  // Clean up: remove empty lines and extra whitespace
  transformedCode = transformedCode
    .split("\n")
    .filter((line) => line.trim() !== "")
    .join("\n")
    .trim();

  // Generate parameter schema from all extracted literals (including discovered ones)
  const parametersSchema = generateSchemaFromLiterals(extractedLiterals);

  logger.info("Literal-to-args transformation complete", {
    replacedCount,
    removedDeclarations: declarationsToRemove.length,
    parameters: Object.keys(extractedLiterals),
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
 *
 * IMPORTANT: This function must NOT mark loop/function variable declarations as removable.
 * Loop variables (for...of, for...in, for) and function parameters are shadowing variables,
 * not literals to be replaced. Only top-level literal declarations should be removed.
 *
 * @param inLoopInit - True if we're inside a loop's variable declaration (left/init property)
 */
function findLiteralDeclarations(
  // deno-lint-ignore no-explicit-any
  node: any,
  literalNames: Set<string>,
  results: IdentifierPosition[] = [],
  inLoopInit: boolean = false,
): IdentifierPosition[] {
  if (!node || typeof node !== "object") return results;

  // Check if this is a loop construct - we need to skip its variable declarations
  const isForOfOrForIn = node.type === "ForOfStatement" || node.type === "ForInStatement";
  const isForLoop = node.type === "ForStatement";

  if (node.type === "VariableDeclarator") {
    const id = node.id;
    // Only mark for removal if:
    // 1. It matches a literal name
    // 2. It's NOT a loop variable (inLoopInit = false)
    if (id?.type === "Identifier" && literalNames.has(id.value) && !inLoopInit) {
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

    // Determine if we're entering a loop's variable declaration
    let enteringLoopInit = inLoopInit;
    if (isForOfOrForIn && key === "left") {
      enteringLoopInit = true; // ForOfStatement.left / ForInStatement.left
    }
    if (isForLoop && key === "init") {
      enteringLoopInit = true; // ForStatement.init
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        findLiteralDeclarations(item, literalNames, results, enteringLoopInit);
      }
    } else if (value && typeof value === "object") {
      findLiteralDeclarations(value, literalNames, results, enteringLoopInit);
    }
  }

  return results;
}

/**
 * Pass 2: Find all usages of literal names (excluding declarations, args.xxx, and shadowed variables)
 *
 * Handles variable shadowing correctly:
 * - If a loop variable (for...of, for...in) shadows a literal name, usages inside the loop are excluded
 * - If a function parameter shadows a literal name, usages inside the function are excluded
 */
function findAllUsages(
  // deno-lint-ignore no-explicit-any
  node: any,
  literalNames: Set<string>,
  declarationSpans: Set<string>,
  results: IdentifierPosition[] = [],
  shadowedNames: Set<string> = new Set(),
): IdentifierPosition[] {
  if (!node || typeof node !== "object") return results;

  // Skip args.xxx member expressions entirely
  if (node.type === "MemberExpression") {
    const obj = node.object;
    if (obj?.type === "Identifier" && obj?.value === "args") {
      return results;
    }
  }

  // Check for scope-creating nodes that might shadow variables
  // ForOfStatement: for (const x of items) - x shadows any outer x
  // ForInStatement: for (const x in obj) - x shadows any outer x
  // ForStatement: for (let i = 0; ...) - i shadows any outer i
  // ArrowFunctionExpression: (x) => ... - x shadows any outer x
  // FunctionExpression/FunctionDeclaration: function(x) {...} - x shadows any outer x
  const newShadowedNames = detectShadowedVariables(node, literalNames);
  const effectiveShadowed = newShadowedNames.size > 0
    ? new Set([...shadowedNames, ...newShadowedNames])
    : shadowedNames;

  // Check for identifier usage
  if (node.type === "Identifier") {
    const name = node.value;
    // Only process if:
    // 1. Name is in literalNames (we want to parameterize it)
    // 2. Name is NOT shadowed in current scope (it's a different variable)
    if (literalNames.has(name) && !effectiveShadowed.has(name)) {
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
    // Skip property keys in KeyValueProperty - they are not variable usages
    // e.g., in { host: "localhost" }, "host" is a property key, not a variable
    if (node.type === "KeyValueProperty" && key === "key") continue;
    // Skip property names in MemberExpression - they are method/property access
    // e.g., in mcp.db.query(), "query" is a method name, not a variable
    if (node.type === "MemberExpression" && key === "property") continue;

    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        findAllUsages(item, literalNames, declarationSpans, results, effectiveShadowed);
      }
    } else if (value && typeof value === "object") {
      findAllUsages(value, literalNames, declarationSpans, results, effectiveShadowed);
    }
  }

  return results;
}

/**
 * Detect variables that are shadowed by this node's declarations
 *
 * Returns the set of variable names that are declared in this scope and
 * shadow names from literalNames.
 */
function detectShadowedVariables(
  // deno-lint-ignore no-explicit-any
  node: any,
  literalNames: Set<string>,
): Set<string> {
  const shadowed = new Set<string>();

  // ForOfStatement: for (const x of items)
  if (node.type === "ForOfStatement" || node.type === "ForInStatement") {
    const left = node.left;
    if (left?.type === "VariableDeclaration") {
      const declarations = left.declarations as Array<Record<string, unknown>> | undefined;
      if (declarations) {
        for (const decl of declarations) {
          const id = decl.id as Record<string, unknown> | undefined;
          if (id?.type === "Identifier") {
            const name = id.value as string;
            if (literalNames.has(name)) {
              shadowed.add(name);
            }
          }
        }
      }
    }
  }

  // ForStatement: for (let i = 0; ...)
  if (node.type === "ForStatement") {
    const init = node.init;
    if (init?.type === "VariableDeclaration") {
      const declarations = init.declarations as Array<Record<string, unknown>> | undefined;
      if (declarations) {
        for (const decl of declarations) {
          const id = decl.id as Record<string, unknown> | undefined;
          if (id?.type === "Identifier") {
            const name = id.value as string;
            if (literalNames.has(name)) {
              shadowed.add(name);
            }
          }
        }
      }
    }
  }

  // ArrowFunctionExpression: (x) => ...
  // FunctionExpression/FunctionDeclaration: function(x) {...}
  if (
    node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionExpression" ||
    node.type === "FunctionDeclaration"
  ) {
    const params = node.params as Array<Record<string, unknown>> | undefined;
    if (params) {
      for (const param of params) {
        // Handle both simple identifiers and patterns
        const paramNode = param as Record<string, unknown>;
        if (paramNode.type === "Identifier") {
          const name = paramNode.value as string;
          if (literalNames.has(name)) {
            shadowed.add(name);
          }
        } else if (paramNode.pat) {
          const pat = paramNode.pat as Record<string, unknown>;
          if (pat.type === "Identifier") {
            const name = pat.value as string;
            if (literalNames.has(name)) {
              shadowed.add(name);
            }
          }
        }
      }
    }
  }

  // CatchClause: catch (e) {...}
  if (node.type === "CatchClause") {
    const param = node.param;
    if (param?.type === "Identifier") {
      const name = param.value as string;
      if (literalNames.has(name)) {
        shadowed.add(name);
      }
    }
  }

  return shadowed;
}

/**
 * Story 10.2d: Find inline literal positions in object properties
 *
 * Searches for ObjectExpression KeyValueProperty where:
 * - The key matches a property name in literalBindings
 * - The value is a literal matching the expected value
 *
 * @param node AST node to search
 * @param literalBindings Map of property names to their literal values
 * @param results Array to collect found positions
 */
function findInlineLiteralPositions(
  // deno-lint-ignore no-explicit-any
  node: any,
  literalBindings: Record<string, JsonValue>,
  results: InlineLiteralPosition[],
  processedSpans: Set<string> = new Set(),
): void {
  if (!node || typeof node !== "object") return;

  // Check for KeyValueProperty in ObjectExpression
  if (node.type === "KeyValueProperty") {
    const keyNode = node.key;
    const valueNode = node.value;

    // Extract key name
    let keyName: string | undefined;
    if (keyNode?.type === "Identifier") {
      keyName = keyNode.value as string;
    } else if (keyNode?.type === "StringLiteral") {
      keyName = keyNode.value as string;
    }

    // Check if this property is in literalBindings and value is a literal
    if (keyName && keyName in literalBindings && valueNode) {
      const expectedValue = literalBindings[keyName];

      // Check if value node is a matching literal
      let literalValue: JsonValue | undefined;
      if (valueNode.type === "StringLiteral") {
        literalValue = valueNode.value as string;
      } else if (valueNode.type === "NumericLiteral") {
        literalValue = valueNode.value as number;
      } else if (valueNode.type === "BooleanLiteral") {
        literalValue = valueNode.value as boolean;
      }

      // Only add if the literal matches the expected value
      if (literalValue !== undefined && literalValue === expectedValue) {
        const start = valueNode.span?.start ?? 0;
        const end = valueNode.span?.end ?? 0;
        const spanKey = `${start}-${end}`;

        // Skip if already processed (avoid duplicates from AST traversal)
        if (!processedSpans.has(spanKey)) {
          processedSpans.add(spanKey);
          results.push({
            propertyName: keyName,
            value: literalValue,
            start,
            end,
          });
        }
      }
    }
  }

  // Recurse through all properties
  for (const key of Object.keys(node)) {
    if (key === "span") continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        findInlineLiteralPositions(item, literalBindings, results, processedSpans);
      }
    } else if (value && typeof value === "object") {
      findInlineLiteralPositions(value, literalBindings, results, processedSpans);
    }
  }
}

/**
 * Result of finding MCP call inline literals
 */
interface McpCallLiteralsResult {
  positions: InlineLiteralPosition[];
  discoveredLiterals: Record<string, JsonValue>;
  /** Template literals containing code - need special handling for nested literals */
  codeTemplates: CodeTemplateLiteralPosition[];
}

/**
 * Find ALL inline literals in MCP call arguments
 *
 * Unlike findInlineLiteralPositions which only matches known literalBindings,
 * this function discovers ALL inline literals in mcp.*.* call arguments.
 *
 * @example
 * ```typescript
 * // This code:
 * await mcp.std.cap_rename({
 *   name: "fetch:exec_fc6ca799",
 *   namespace: "api",
 *   action: "checkEmergence"
 * });
 *
 * // Will discover: { name: "fetch:exec_fc6ca799", namespace: "api", action: "checkEmergence" }
 * ```
 */
function findMcpCallInlineLiterals(
  // deno-lint-ignore no-explicit-any
  node: any,
  results: McpCallLiteralsResult = { positions: [], discoveredLiterals: {}, codeTemplates: [] },
  processedSpans: Set<string> = new Set(),
  inMcpCallArg: boolean = false,
): McpCallLiteralsResult {
  if (!node || typeof node !== "object") return results;

  // Check if this is an MCP call expression: mcp.namespace.action(args)
  let isEnteringMcpCall = false;
  if (node.type === "CallExpression") {
    const callee = node.callee;
    // Check for mcp.*.* pattern
    if (
      callee?.type === "MemberExpression" &&
      callee.object?.type === "MemberExpression" &&
      callee.object.object?.type === "Identifier" &&
      callee.object.object.value === "mcp"
    ) {
      isEnteringMcpCall = true;
    }
  }

  // If we're inside an MCP call argument and this is a KeyValueProperty with a literal value
  if (inMcpCallArg && node.type === "KeyValueProperty") {
    const keyNode = node.key;
    const valueNode = node.value;

    // Extract key name
    let keyName: string | undefined;
    if (keyNode?.type === "Identifier") {
      keyName = keyNode.value as string;
    } else if (keyNode?.type === "StringLiteral") {
      keyName = keyNode.value as string;
    }

    if (keyName && valueNode) {
      // Extract literal value
      let literalValue: JsonValue | undefined;
      if (valueNode.type === "StringLiteral") {
        literalValue = valueNode.value as string;
      } else if (valueNode.type === "NumericLiteral") {
        literalValue = valueNode.value as number;
      } else if (valueNode.type === "BooleanLiteral") {
        literalValue = valueNode.value as boolean;
      } else if (valueNode.type === "TemplateLiteral") {
        // Handle template literals like `SELECT * FROM users` or `async (page) => {...}`
        const quasis = valueNode.quasis as Array<Record<string, unknown>> | undefined;
        const expressions = valueNode.expressions as Array<unknown> | undefined;

        // Only handle simple templates (no interpolation)
        if (quasis && quasis.length > 0 && (!expressions || expressions.length === 0)) {
          const templateContent = quasis
            .map((q) => (q.cooked as string) ?? "")
            .join("");

          if (templateContent.length > 0) {
            const start = valueNode.span?.start ?? 0;
            const end = valueNode.span?.end ?? 0;
            const spanKey = `${start}-${end}`;

            // Check if this looks like code (needs nested literal extraction)
            if (looksLikeCode(templateContent)) {
              // Add to codeTemplates for special handling
              if (!processedSpans.has(spanKey)) {
                processedSpans.add(spanKey);
                results.codeTemplates.push({
                  propertyName: keyName,
                  templateContent,
                  contentStart: start + 1, // After opening backtick
                  contentEnd: end - 1, // Before closing backtick
                  start,
                  end,
                });
                logger.debug("Found code template literal", {
                  propertyName: keyName,
                  contentLength: templateContent.length,
                });
              }
              // Don't add to literalValue - will be handled separately
            } else {
              // Simple template (SQL, etc.) - treat as regular literal
              literalValue = templateContent;
            }
          }
        }
      } else if (valueNode.type === "ArrayExpression") {
        // Handle array literals like [1, 2, 3]
        const elements = valueNode.elements;
        if (elements && Array.isArray(elements)) {
          const arrayValue: JsonValue[] = [];
          let allLiterals = true;
          for (const elem of elements) {
            if (elem?.expression?.type === "StringLiteral") {
              arrayValue.push(elem.expression.value as string);
            } else if (elem?.expression?.type === "NumericLiteral") {
              arrayValue.push(elem.expression.value as number);
            } else if (elem?.expression?.type === "BooleanLiteral") {
              arrayValue.push(elem.expression.value as boolean);
            } else {
              allLiterals = false;
              break;
            }
          }
          if (allLiterals && arrayValue.length > 0) {
            literalValue = arrayValue;
          }
        }
      }

      if (literalValue !== undefined) {
        const start = valueNode.span?.start ?? 0;
        const end = valueNode.span?.end ?? 0;
        const spanKey = `${start}-${end}`;

        // Skip if already processed
        if (!processedSpans.has(spanKey)) {
          processedSpans.add(spanKey);
          results.positions.push({
            propertyName: keyName,
            value: literalValue,
            start,
            end,
          });
          results.discoveredLiterals[keyName] = literalValue;
        }
      }
    }
  }

  // Recurse through all properties
  for (const key of Object.keys(node)) {
    if (key === "span") continue;
    const value = node[key];

    // Determine if we should mark children as inside MCP call args
    const childInMcpCallArg = inMcpCallArg ||
      (isEnteringMcpCall && key === "arguments");

    if (Array.isArray(value)) {
      for (const item of value) {
        findMcpCallInlineLiterals(item, results, processedSpans, childInMcpCallArg);
      }
    } else if (value && typeof value === "object") {
      findMcpCallInlineLiterals(value, results, processedSpans, childInMcpCallArg);
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

/**
 * Result of variable name normalization
 */
export interface NormalizeVariablesResult {
  /** Code with normalized variable names */
  code: string;
  /** Map of original name → normalized name */
  renames: Record<string, string>;
}

/**
 * Normalize variable names in code using variableBindings from static structure
 *
 * Replaces all variable declarations and usages with normalized names
 * based on the node IDs from static analysis. This ensures that code
 * with different variable names but identical semantics produces
 * identical normalized code.
 *
 * @example
 * ```typescript
 * // Input:
 * const result = await mcp.foo(); return result;
 * // variableBindings: { "result": "n1" }
 *
 * // Output:
 * const _n1 = await mcp.foo(); return _n1;
 * ```
 *
 * @param code - Original code
 * @param variableBindings - Map of variable names to node IDs from static structure
 * @returns Normalized code and rename mapping
 */
export function normalizeVariableNames(
  code: string,
  variableBindings: Record<string, string>,
): NormalizeVariablesResult {
  if (!variableBindings || Object.keys(variableBindings).length === 0) {
    return { code, renames: {} };
  }

  // Build rename map: original name → normalized name (using node ID)
  const renames: Record<string, string> = {};
  for (const [varName, nodeId] of Object.entries(variableBindings)) {
    renames[varName] = `_${nodeId}`;
  }

  // Replace all occurrences using word boundaries
  // Sort by length descending to avoid partial replacements
  const sortedNames = Object.keys(renames).sort((a, b) => b.length - a.length);

  let normalizedCode = code;
  for (const originalName of sortedNames) {
    const normalizedName = renames[originalName];
    // Use negative lookbehind to avoid replacing property accesses
    // e.g., "content" in "const content = ..." should be replaced
    // but "content" in "file.content" should NOT be replaced (it's a property)
    // (?<!\.) = not preceded by a dot
    const pattern = new RegExp(`(?<!\\.)\\b${escapeRegExp(originalName)}\\b`, "g");
    normalizedCode = normalizedCode.replace(pattern, normalizedName);
  }

  return { code: normalizedCode, renames };
}

/**
 * Escape special regex characters in a string
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
