/**
 * AST Handlers for Static Structure Builder
 *
 * Node-specific handlers extracted from StaticStructureBuilder using
 * the Visitor pattern. Each handler processes a specific AST node type.
 *
 * @module capabilities/static-structure/ast-handlers
 */

import type { ASTVisitor, DefaultHandler } from "../../infrastructure/patterns/visitor/mod.ts";
import type { InternalNode, NodeMetadata } from "./types.ts";
import { ARRAY_METHOD_NAMES } from "../pure-operations.ts";

// ============================================================================
// Visitor Result Type
// ============================================================================

/**
 * Unified result type for all AST handlers
 *
 * Allows handlers to indicate whether they fully handled the node
 * and optionally return a node ID (for CallExpression chaining).
 */
export interface VisitorResult {
  /** Did the handler fully process this node (don't recurse further)? */
  handled: boolean;
  /** For CallExpression: the created node ID for chaining */
  nodeId?: string;
}

/**
 * Context passed to all handlers
 *
 * Contains builder state and utility methods needed by handlers.
 */
export interface HandlerContext {
  /** Collected nodes during traversal */
  nodes: InternalNode[];
  /** Current traversal position */
  position: number;
  /** Parent scope for containment */
  parentScope?: string;
  /** Nesting level for callbacks */
  nestingLevel: number;
  /** Parent operation name */
  currentParentOp?: string;

  // Builder methods exposed to handlers
  generateNodeId: (type: "task" | "decision" | "capability" | "fork" | "join" | "loop") => string;
  extractConditionText: (node: Record<string, unknown> | undefined) => string;
  extractMemberChain: (node: Record<string, unknown>, parts?: string[]) => string[];
  extractCodeFromSpan: (span: { start: number; end: number } | undefined) => string | undefined;
  extractFullChainSpan: (node: Record<string, unknown>) => { start: number; end: number } | undefined;
  extractLiteralValue: (node: Record<string, unknown>) => unknown;
  findNodes: (
    node: unknown,
    nodes: InternalNode[],
    position: number,
    parentScope?: string,
    nestingLevel?: number,
    currentParentOp?: string,
  ) => void;

  // State access
  processedSpans: Map<string, string>;
  variableToNodeId: Map<string, string>;
  literalBindings: Map<string, unknown>;

  // Builder reference for complex operations (CallExpression, VariableDeclarator)
  handleCallExpression?: (
    n: Record<string, unknown>,
    nodes: InternalNode[],
    position: number,
    parentScope?: string,
    nestingLevel?: number,
    currentParentOp?: string,
  ) => { nodeId?: string; handled: boolean };

  handleVariableDeclarator?: (
    n: Record<string, unknown>,
    nodes: InternalNode[],
    position: number,
    parentScope?: string,
    nestingLevel?: number,
    currentParentOp?: string,
  ) => void;
}

/**
 * Handler result for CallExpression
 */
export interface CallExpressionResult {
  nodeId?: string;
  handled: boolean;
}

/**
 * Operator to operation name mapping for binary expressions
 */
export const OPERATOR_MAP: Record<string, string> = {
  // Arithmetic
  "+": "add",
  "-": "subtract",
  "*": "multiply",
  "/": "divide",
  "%": "modulo",
  "**": "power",
  // Comparison
  "==": "equal",
  "===": "strictEqual",
  "!=": "notEqual",
  "!==": "strictNotEqual",
  "<": "lessThan",
  "<=": "lessThanOrEqual",
  ">": "greaterThan",
  ">=": "greaterThanOrEqual",
  // Logical
  "&&": "and",
  "||": "or",
  // Bitwise
  "&": "bitwiseAnd",
  "|": "bitwiseOr",
  "^": "bitwiseXor",
  "<<": "leftShift",
  ">>": "rightShift",
  ">>>": "unsignedRightShift",
};

/**
 * Array method names that should be tracked as operations
 *
 * Re-exported from pure-operations.ts (single source of truth)
 */
export const ARRAY_OPERATIONS = ARRAY_METHOD_NAMES;

// ============================================================================
// Handler Functions
// ============================================================================

/**
 * Handle if/else statements
 *
 * Creates a decision node and recursively processes branches.
 */
export function handleIfStatement(
  n: Record<string, unknown>,
  ctx: HandlerContext,
  _visitor: ASTVisitor<HandlerContext, VisitorResult>,
): VisitorResult {
  // Extract condition
  const test = n.test as Record<string, unknown> | undefined;
  const condition = ctx.extractConditionText(test);

  // Create decision node
  const decisionId = ctx.generateNodeId("decision");
  ctx.nodes.push({
    id: decisionId,
    type: "decision",
    condition,
    position: ctx.position,
    parentScope: ctx.parentScope,
  });

  // Process consequent (if true)
  const consequent = n.consequent as Record<string, unknown> | undefined;
  if (consequent) {
    ctx.findNodes(
      consequent,
      ctx.nodes,
      ctx.position + 1,
      `${decisionId}:true`,
      ctx.nestingLevel,
      ctx.currentParentOp,
    );
  }

  // Process alternate (else)
  const alternate = n.alternate as Record<string, unknown> | undefined;
  if (alternate) {
    ctx.findNodes(
      alternate,
      ctx.nodes,
      ctx.position + 100,
      `${decisionId}:false`,
      ctx.nestingLevel,
      ctx.currentParentOp,
    );
  }

  return { handled: true };
}

/**
 * Handle switch statements
 *
 * Creates a decision node for switch and processes each case.
 */
export function handleSwitchStatement(
  n: Record<string, unknown>,
  ctx: HandlerContext,
  _visitor: ASTVisitor<HandlerContext, VisitorResult>,
): VisitorResult {
  // Extract discriminant
  const discriminant = n.discriminant as Record<string, unknown> | undefined;
  const condition = ctx.extractConditionText(discriminant);

  // Create decision node
  const decisionId = ctx.generateNodeId("decision");
  ctx.nodes.push({
    id: decisionId,
    type: "decision",
    condition: `switch(${condition})`,
    position: ctx.position,
    parentScope: ctx.parentScope,
  });

  // Process cases
  const cases = n.cases as Array<Record<string, unknown>> | undefined;
  if (cases) {
    let casePosition = ctx.position + 1;
    for (const caseClause of cases) {
      const testNode = caseClause.test as Record<string, unknown> | undefined;
      const caseValue = testNode ? ctx.extractConditionText(testNode) : "default";
      const caseScope = `${decisionId}:case:${caseValue}`;

      const consequent = caseClause.consequent as Array<Record<string, unknown>> | undefined;
      if (consequent) {
        for (const stmt of consequent) {
          ctx.findNodes(
            stmt,
            ctx.nodes,
            casePosition++,
            caseScope,
            ctx.nestingLevel,
            ctx.currentParentOp,
          );
        }
      }
    }
  }

  return { handled: true };
}

/**
 * Handle ternary conditional expressions
 *
 * Creates a decision node for condition ? a : b expressions.
 */
export function handleConditionalExpression(
  n: Record<string, unknown>,
  ctx: HandlerContext,
  _visitor: ASTVisitor<HandlerContext, VisitorResult>,
): VisitorResult {
  const test = n.test as Record<string, unknown> | undefined;
  const condition = ctx.extractConditionText(test);

  // Create decision node
  const decisionId = ctx.generateNodeId("decision");
  ctx.nodes.push({
    id: decisionId,
    type: "decision",
    condition,
    position: ctx.position,
    parentScope: ctx.parentScope,
  });

  // Process consequent (true branch)
  const consequent = n.consequent as Record<string, unknown> | undefined;
  if (consequent) {
    ctx.findNodes(
      consequent,
      ctx.nodes,
      ctx.position + 1,
      `${decisionId}:true`,
      ctx.nestingLevel,
      ctx.currentParentOp,
    );
  }

  // Process alternate (false branch)
  const alternate = n.alternate as Record<string, unknown> | undefined;
  if (alternate) {
    ctx.findNodes(
      alternate,
      ctx.nodes,
      ctx.position + 100,
      `${decisionId}:false`,
      ctx.nestingLevel,
      ctx.currentParentOp,
    );
  }

  return { handled: true };
}

// ============================================================================
// Loop Handlers
// ============================================================================

/**
 * Handle for statements (classic for loop)
 *
 * Creates a loop node and processes the body ONCE for SHGAT pattern learning.
 * Example: for (let i = 0; i < 10; i++) { ... }
 */
export function handleForStatement(
  n: Record<string, unknown>,
  ctx: HandlerContext,
  _visitor: ASTVisitor<HandlerContext, VisitorResult>,
): VisitorResult {
  const init = n.init as Record<string, unknown> | undefined;
  const test = n.test as Record<string, unknown> | undefined;
  const update = n.update as Record<string, unknown> | undefined;

  // Build condition string
  const initText = init ? ctx.extractConditionText(init) : "";
  const testText = test ? ctx.extractConditionText(test) : "";
  const updateText = update ? ctx.extractConditionText(update) : "";
  const condition = `for(${initText}; ${testText}; ${updateText})`;

  // Extract full loop code from span for native execution
  const span = n.span as { start: number; end: number } | undefined;
  const code = ctx.extractCodeFromSpan(span);

  // Create loop node
  const loopId = ctx.generateNodeId("loop");
  ctx.nodes.push({
    id: loopId,
    type: "loop",
    condition,
    loopType: "for",
    code, // Full loop code for WorkerBridge execution
    position: ctx.position,
    parentScope: ctx.parentScope,
  });

  // Process body ONCE (SHGAT learns the pattern, not repetitions)
  const body = n.body as Record<string, unknown> | undefined;
  if (body) {
    ctx.findNodes(
      body,
      ctx.nodes,
      ctx.position + 1,
      loopId, // Body is scoped to this loop
      ctx.nestingLevel,
      ctx.currentParentOp,
    );
  }

  return { handled: true };
}

/**
 * Handle while statements
 *
 * Creates a loop node for while (condition) { ... }
 */
export function handleWhileStatement(
  n: Record<string, unknown>,
  ctx: HandlerContext,
  _visitor: ASTVisitor<HandlerContext, VisitorResult>,
): VisitorResult {
  const test = n.test as Record<string, unknown> | undefined;
  const condition = `while(${ctx.extractConditionText(test)})`;

  // Extract full loop code from span for native execution
  const span = n.span as { start: number; end: number } | undefined;
  const code = ctx.extractCodeFromSpan(span);

  const loopId = ctx.generateNodeId("loop");
  ctx.nodes.push({
    id: loopId,
    type: "loop",
    condition,
    loopType: "while",
    code, // Full loop code for WorkerBridge execution
    position: ctx.position,
    parentScope: ctx.parentScope,
  });

  const body = n.body as Record<string, unknown> | undefined;
  if (body) {
    ctx.findNodes(
      body,
      ctx.nodes,
      ctx.position + 1,
      loopId,
      ctx.nestingLevel,
      ctx.currentParentOp,
    );
  }

  return { handled: true };
}

/**
 * Handle do-while statements
 *
 * Creates a loop node for do { ... } while (condition)
 */
export function handleDoWhileStatement(
  n: Record<string, unknown>,
  ctx: HandlerContext,
  _visitor: ASTVisitor<HandlerContext, VisitorResult>,
): VisitorResult {
  const test = n.test as Record<string, unknown> | undefined;
  const condition = `do...while(${ctx.extractConditionText(test)})`;

  // Extract full loop code from span for native execution
  const span = n.span as { start: number; end: number } | undefined;
  const code = ctx.extractCodeFromSpan(span);

  const loopId = ctx.generateNodeId("loop");
  ctx.nodes.push({
    id: loopId,
    type: "loop",
    condition,
    loopType: "doWhile",
    code, // Full loop code for WorkerBridge execution
    position: ctx.position,
    parentScope: ctx.parentScope,
  });

  const body = n.body as Record<string, unknown> | undefined;
  if (body) {
    ctx.findNodes(
      body,
      ctx.nodes,
      ctx.position + 1,
      loopId,
      ctx.nestingLevel,
      ctx.currentParentOp,
    );
  }

  return { handled: true };
}

/**
 * Handle for-of statements
 *
 * Creates a loop node for: for (const x of items) { ... }
 */
export function handleForOfStatement(
  n: Record<string, unknown>,
  ctx: HandlerContext,
  _visitor: ASTVisitor<HandlerContext, VisitorResult>,
): VisitorResult {
  const left = n.left as Record<string, unknown> | undefined;
  const right = n.right as Record<string, unknown> | undefined;

  const leftText = left ? ctx.extractConditionText(left) : "item";
  const rightText = right ? ctx.extractConditionText(right) : "items";
  const condition = `for(${leftText} of ${rightText})`;

  // Extract full loop code from span for native execution
  const span = n.span as { start: number; end: number } | undefined;
  const code = ctx.extractCodeFromSpan(span);

  const loopId = ctx.generateNodeId("loop");
  ctx.nodes.push({
    id: loopId,
    type: "loop",
    condition,
    loopType: "forOf",
    code, // Full loop code for WorkerBridge execution
    position: ctx.position,
    parentScope: ctx.parentScope,
  });

  const body = n.body as Record<string, unknown> | undefined;
  if (body) {
    ctx.findNodes(
      body,
      ctx.nodes,
      ctx.position + 1,
      loopId,
      ctx.nestingLevel,
      ctx.currentParentOp,
    );
  }

  return { handled: true };
}

/**
 * Handle for-in statements
 *
 * Creates a loop node for: for (const key in obj) { ... }
 */
export function handleForInStatement(
  n: Record<string, unknown>,
  ctx: HandlerContext,
  _visitor: ASTVisitor<HandlerContext, VisitorResult>,
): VisitorResult {
  const left = n.left as Record<string, unknown> | undefined;
  const right = n.right as Record<string, unknown> | undefined;

  const leftText = left ? ctx.extractConditionText(left) : "key";
  const rightText = right ? ctx.extractConditionText(right) : "obj";
  const condition = `for(${leftText} in ${rightText})`;

  // Extract full loop code from span for native execution
  const span = n.span as { start: number; end: number } | undefined;
  const code = ctx.extractCodeFromSpan(span);

  const loopId = ctx.generateNodeId("loop");
  ctx.nodes.push({
    id: loopId,
    type: "loop",
    condition,
    loopType: "forIn",
    code, // Full loop code for WorkerBridge execution
    position: ctx.position,
    parentScope: ctx.parentScope,
  });

  const body = n.body as Record<string, unknown> | undefined;
  if (body) {
    ctx.findNodes(
      body,
      ctx.nodes,
      ctx.position + 1,
      loopId,
      ctx.nestingLevel,
      ctx.currentParentOp,
    );
  }

  return { handled: true };
}

// ============================================================================
// Binary Expression Handler
// ============================================================================

/**
 * Handle binary expressions (arithmetic, comparison, logical operators)
 *
 * Creates pseudo-tool tasks for operators to enable complete SHGAT learning.
 * Example: a + b becomes a task with tool: "code:add"
 */
export function handleBinaryExpression(
  n: Record<string, unknown>,
  ctx: HandlerContext,
  _visitor: ASTVisitor<HandlerContext, VisitorResult>,
): VisitorResult {
  const operator = n.operator as string;
  const operation = OPERATOR_MAP[operator];

  if (!operation) return { handled: false };

  // Determine if executable based on nesting level
  const isExecutable = ctx.nestingLevel === 0;

  const nodeId = ctx.generateNodeId("task");
  const metadata: NodeMetadata = {
    executable: isExecutable,
    nestingLevel: ctx.nestingLevel,
  };

  if (ctx.currentParentOp) {
    metadata.parentOperation = ctx.currentParentOp;
  }

  // Extract code from span
  const span = n.span as { start: number; end: number } | undefined;
  const code = ctx.extractCodeFromSpan(span);

  ctx.nodes.push({
    id: nodeId,
    type: "task",
    tool: `code:${operation}`,
    position: ctx.position,
    parentScope: ctx.parentScope,
    code,
    metadata,
  });

  // Process left operand
  const left = n.left as Record<string, unknown> | undefined;
  if (left) {
    ctx.findNodes(
      left,
      ctx.nodes,
      ctx.position + 1,
      ctx.parentScope,
      ctx.nestingLevel,
      ctx.currentParentOp,
    );
  }

  // Process right operand
  const right = n.right as Record<string, unknown> | undefined;
  if (right) {
    ctx.findNodes(
      right,
      ctx.nodes,
      ctx.position + 2,
      ctx.parentScope,
      ctx.nestingLevel,
      ctx.currentParentOp,
    );
  }

  return { handled: true };
}

/**
 * Handle arrow/function expressions (callbacks)
 *
 * Increments nesting level when entering callback bodies.
 */
export function handleFunctionExpression(
  n: Record<string, unknown>,
  ctx: HandlerContext,
  _visitor: ASTVisitor<HandlerContext, VisitorResult>,
): VisitorResult {
  // Recurse into callback body with incremented nesting level
  const body = n.body as Record<string, unknown> | undefined;
  if (body) {
    ctx.findNodes(
      body,
      ctx.nodes,
      ctx.position,
      ctx.parentScope,
      ctx.nestingLevel + 1, // Increment for callback context
      ctx.currentParentOp,
    );
  }
  return { handled: true };
}

/**
 * Handle variable declarators
 *
 * Delegates to builder's handleVariableDeclarator method.
 */
export function handleVariableDeclarator(
  n: Record<string, unknown>,
  ctx: HandlerContext,
  _visitor: ASTVisitor<HandlerContext, VisitorResult>,
): VisitorResult {
  if (ctx.handleVariableDeclarator) {
    ctx.handleVariableDeclarator(
      n,
      ctx.nodes,
      ctx.position,
      ctx.parentScope,
      ctx.nestingLevel,
      ctx.currentParentOp,
    );
    return { handled: true };
  }
  return { handled: false };
}

/**
 * Handle call expressions (MCP calls, array operations, etc.)
 *
 * Delegates to builder's handleCallExpression method.
 */
export function handleCallExpression(
  n: Record<string, unknown>,
  ctx: HandlerContext,
  _visitor: ASTVisitor<HandlerContext, VisitorResult>,
): VisitorResult {
  if (ctx.handleCallExpression) {
    const result = ctx.handleCallExpression(
      n,
      ctx.nodes,
      ctx.position,
      ctx.parentScope,
      ctx.nestingLevel,
      ctx.currentParentOp,
    );
    return { handled: result.handled, nodeId: result.nodeId };
  }
  return { handled: false };
}

/**
 * Default handler for AST traversal
 *
 * Recursively processes child nodes when no specific handler matches.
 */
export function defaultTraversalHandler(
  n: Record<string, unknown>,
  ctx: HandlerContext,
  _visitor: ASTVisitor<HandlerContext, VisitorResult>,
): VisitorResult {
  let childPosition = ctx.position;
  for (const key of Object.keys(n)) {
    const val = n[key];
    if (Array.isArray(val)) {
      for (const item of val) {
        ctx.findNodes(item, ctx.nodes, childPosition++, ctx.parentScope, ctx.nestingLevel, ctx.currentParentOp);
      }
    } else if (typeof val === "object" && val !== null) {
      ctx.findNodes(val, ctx.nodes, childPosition++, ctx.parentScope, ctx.nestingLevel, ctx.currentParentOp);
    }
  }
  return { handled: true };
}

/**
 * Create a configured AST visitor with all handlers registered
 *
 * Includes handlers for:
 * - Control flow: IfStatement, SwitchStatement, ConditionalExpression
 * - Operations: BinaryExpression, CallExpression
 * - Scope: ArrowFunctionExpression, FunctionExpression, VariableDeclarator
 * - Default: recursive traversal
 */
export function createStaticStructureVisitor(
  ASTVisitorClass: typeof ASTVisitor,
): ASTVisitor<HandlerContext, VisitorResult> {
  return new ASTVisitorClass<HandlerContext, VisitorResult>()
    // Control flow
    .register("IfStatement", handleIfStatement)
    .register("SwitchStatement", handleSwitchStatement)
    .register("ConditionalExpression", handleConditionalExpression)
    // Loops (SHGAT sees pattern once, not all iterations)
    .register("ForStatement", handleForStatement)
    .register("WhileStatement", handleWhileStatement)
    .register("DoWhileStatement", handleDoWhileStatement)
    .register("ForOfStatement", handleForOfStatement)
    .register("ForInStatement", handleForInStatement)
    // Operations
    .register("BinaryExpression", handleBinaryExpression)
    .register("CallExpression", handleCallExpression)
    // Scope
    .register("ArrowFunctionExpression", handleFunctionExpression)
    .register("FunctionExpression", handleFunctionExpression)
    .register("VariableDeclarator", handleVariableDeclarator)
    // Default traversal
    .setDefault(defaultTraversalHandler as DefaultHandler<HandlerContext, VisitorResult>);
}
