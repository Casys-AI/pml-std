/**
 * Static analysis types for capability code structure
 *
 * Types for representing the static structure of capability code
 * extracted via SWC AST parsing.
 *
 * Story 10.1, 10.2: Static Argument Extraction for Speculative Execution
 *
 * @module capabilities/types/static-analysis
 */

import type { JsonValue } from "./schema.ts";

// ============================================
// Argument Types (Story 10.2)
// ============================================

/**
 * Describes how to resolve a single argument value in a tool call
 *
 * Story 10.2: Static Argument Extraction for Speculative Execution
 *
 * ArgumentValue stores HOW to resolve each argument, not the resolved value:
 * - literal: Direct value, use immediately
 * - reference: Resolve via ProvidesEdge + previous task result
 * - parameter: Extract from capability input parameters
 *
 * @example
 * ```typescript
 * // Literal: { path: "config.json" }
 * { type: "literal", value: "config.json" }
 *
 * // Reference: { input: file.content }
 * { type: "reference", expression: "file.content" }
 *
 * // Parameter: { path: args.filePath }
 * { type: "parameter", parameterName: "filePath" }
 * ```
 */
export interface ArgumentValue {
  /**
   * How this argument value should be resolved:
   * - "literal": The value is known at static analysis time
   * - "reference": The value comes from a previous task result (MemberExpression)
   * - "parameter": The value comes from capability input parameters (args.X, params.X)
   */
  type: "literal" | "reference" | "parameter";
  /**
   * For literal type: the actual value (string, number, boolean, object, array, null)
   * Must be JSON-serializable for storage in JSONB columns.
   */
  value?: JsonValue;
  /**
   * For reference type: the expression string representing the data source
   * @example "file.content", "result.items[0].value"
   */
  expression?: string;
  /**
   * For parameter type: the parameter name from capability input
   * @example "filePath", "inputData"
   */
  parameterName?: string;
}

/**
 * Map of argument names to their resolution strategies
 *
 * Story 10.2: Static Argument Extraction
 *
 * @example
 * ```typescript
 * // For: mcp.fs.read({ path: "config.json", verbose: args.debug })
 * {
 *   path: { type: "literal", value: "config.json" },
 *   verbose: { type: "parameter", parameterName: "debug" }
 * }
 * ```
 */
export type ArgumentsStructure = Record<string, ArgumentValue>;

/**
 * Loop type enumeration for SHGAT semantic understanding
 */
export type LoopType = "for" | "while" | "forOf" | "forIn" | "doWhile";

/**
 * Static structure node types for capability analysis
 *
 * Nodes represent elements discovered during static code analysis:
 * - task: MCP tool call (e.g., mcp.filesystem.read_file)
 * - decision: Control flow (if/else, switch, ternary)
 * - capability: Nested capability call
 * - fork: Parallel execution start (Promise.all/allSettled)
 * - join: Parallel execution end
 * - loop: Iteration pattern (for, while, for-of, for-in, do-while)
 *
 * Story 10.2: Added optional `arguments` field to task nodes for
 * speculative execution argument resolution.
 *
 * Loop Abstraction: Loops are represented as a single node with their
 * body analyzed once. SHGAT learns the iteration pattern rather than
 * seeing repeated operations (which don't generalize well).
 *
 * Bug 2 Fix: Added `parentScope` to all node types for loop membership tracking.
 * Nodes inside a loop have `parentScope` set to the loop's ID.
 */
export type StaticStructureNode =
  | {
    id: string;
    type: "task";
    tool: string;
    /**
     * Extracted arguments for this tool call (Story 10.2)
     *
     * Contains resolution strategies for each argument:
     * - Literals are stored with their actual values
     * - References point to previous task results
     * - Parameters reference capability input
     */
    arguments?: ArgumentsStructure;
    /**
     * Original source code extracted via SWC span (Phase 1)
     *
     * For code operations (tool: "code:*"), this contains the actual
     * JavaScript code to execute, preserving callbacks and variable references.
     */
    code?: string;
    /** Parent scope ID for containment tracking (loop membership, conditional branches) */
    parentScope?: string;
  }
  | { id: string; type: "decision"; condition: string; parentScope?: string }
  | { id: string; type: "capability"; capabilityId: string; parentScope?: string }
  | { id: string; type: "fork"; parentScope?: string }
  | { id: string; type: "join"; parentScope?: string }
  | {
    id: string;
    type: "loop";
    /** Loop condition (e.g., "for(item of items)", "while(hasMore)") */
    condition: string;
    /** Type of loop for semantic understanding */
    loopType: LoopType;
    /**
     * Full loop code including body, extracted from source span.
     * Used for native execution via WorkerBridge.
     */
    code?: string;
    /** Parent scope ID for nested loops */
    parentScope?: string;
  };

/**
 * Coverage level for "provides" edges (data flow)
 *
 * Based on intersection of provider outputs and consumer inputs:
 * - strict: Provider outputs cover ALL required inputs of consumer
 * - partial: Provider outputs cover SOME required inputs
 * - optional: Provider outputs only cover optional inputs
 */
export type ProvidesCoverage = "strict" | "partial" | "optional";

/**
 * Static structure edge types
 *
 * Edges represent relationships between nodes:
 * - sequence: Temporal order (A awaited before B)
 * - provides: Data flow (A's output feeds B's input)
 * - conditional: Branch from decision node
 * - contains: Hierarchy (capability contains tools)
 * - loop_body: Connection from loop node to its body content
 */
export interface StaticStructureEdge {
  from: string;
  to: string;
  type: "sequence" | "provides" | "conditional" | "contains" | "loop_body";
  /** For conditional edges: branch outcome ("true", "false", "case:value") */
  outcome?: string;
  /** For provides edges: coverage level */
  coverage?: ProvidesCoverage;
}

/**
 * Complete static structure of a capability
 *
 * Represents the control flow and data flow graph extracted
 * from static code analysis (before execution).
 */
export interface StaticStructure {
  nodes: StaticStructureNode[];
  edges: StaticStructureEdge[];
  /**
   * Variable to node ID bindings for code task context injection.
   *
   * Maps variable names to the node IDs that produce their values.
   * Used to inject variables into code task execution context.
   *
   * @example
   * ```typescript
   * // Code: const users = await mcp.db.query(...);
   * //       const active = users.filter(u => u.active);
   * // Produces: { "users": "n1" }
   * // At runtime: inject `const users = deps.task_n1.output;`
   * ```
   */
  variableBindings?: Record<string, string>;
  /**
   * Variable to literal value bindings for argument resolution (Story 10.2b).
   *
   * Maps local variable names to their literal values when the variable
   * is assigned a static literal (number, string, boolean, array, object).
   * Used to resolve shorthand arguments like `{ numbers }` where `numbers`
   * is a local variable with a literal value.
   *
   * @example
   * ```typescript
   * // Code: const numbers = [10, 20, 30];
   * //       mcp.math.sum({ numbers })
   * // Produces: { "numbers": [10, 20, 30] }
   * // At resolution: { numbers } → { numbers: [10, 20, 30] }
   * ```
   */
  literalBindings?: Record<string, JsonValue>;
}
