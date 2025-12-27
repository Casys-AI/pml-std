/**
 * Static Structure Builder (Epic 10 - Story 10.1)
 *
 * Parses TypeScript code statically to generate a complete static_structure
 * with nodes (tools, decisions, capabilities, fork/join) and edges
 * (sequence, conditional, provides, contains).
 *
 * Creates the Capability immediately at analysis time with full branch/condition
 * visibility for HIL (Human-in-the-Loop) approval.
 *
 * @module capabilities/static-structure-builder
 */

import { parse } from "https://deno.land/x/swc@0.2.1/mod.ts";
import type { DbClient } from "../db/types.ts";
import type {
  ArgumentsStructure,
  ArgumentValue,
  BranchDecision,
  JsonValue,
  ProvidesCoverage,
  StaticStructure,
  StaticStructureEdge,
  StaticStructureNode,
} from "./types.ts";
import { getLogger } from "../telemetry/logger.ts";
import { getToolPermissionConfig } from "./permission-inferrer.ts";
const logger = getLogger("default");

/**
 * Tool schema from database for provides edge calculation
 */
interface ToolSchema {
  toolId: string;
  inputSchema: {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  outputSchema?: {
    properties?: Record<string, unknown>;
  };
}

/**
 * Internal node representation for AST traversal and edge generation
 *
 * This type extends StaticStructureNode with position information needed
 * during the analysis phase. The position field tracks AST traversal order
 * for generating sequence edges, and parentScope tracks containment for
 * conditional branches and parallel blocks.
 *
 * Uses TypeScript discriminated union pattern:
 * - `type: "task"` → MCP tool call with `tool` field (e.g., "filesystem:read_file")
 * - `type: "decision"` → Control flow (if/switch/ternary) with `condition` string
 * - `type: "capability"` → Nested capability call with `capabilityId` field
 * - `type: "fork"` → Start of Promise.all/allSettled parallel block
 * - `type: "join"` → End of parallel block
 *
 * @internal This type is not exported - use StaticStructureNode for external APIs
 */
type InternalNode =
  & {
    /** Unique node identifier (e.g., "n1", "d1", "f1") */
    id: string;
    /** AST traversal position for ordering sequence edges */
    position: number;
    /** Parent scope for conditional/parallel containment (e.g., "d1:true", "f1") */
    parentScope?: string;
  }
  & (
    | { type: "task"; tool: string; arguments?: ArgumentsStructure; code?: string }
    | { type: "decision"; condition: string }
    | { type: "capability"; capabilityId: string }
    | { type: "fork" }
    | { type: "join" }
  );

/**
 * StaticStructureBuilder - Analyzes code to extract control flow and data flow
 *
 * Uses SWC (Rust-based parser) to analyze TypeScript code and detect:
 * - MCP tool calls (mcp.server.tool)
 * - Capability calls (capabilities.name)
 * - Control flow (if/else, switch, ternary)
 * - Parallel execution (Promise.all/allSettled)
 *
 * @example
 * ```typescript
 * const builder = new StaticStructureBuilder(db);
 * const structure = await builder.buildStaticStructure(`
 *   const file = await mcp.filesystem.read_file({ path });
 *   if (file.exists) {
 *     await mcp.filesystem.write_file({ path, content });
 *   }
 * `);
 * // Returns:
 * // {
 * //   nodes: [
 * //     { id: "n1", type: "task", tool: "filesystem:read_file" },
 * //     { id: "d1", type: "decision", condition: "file.exists" },
 * //     { id: "n2", type: "task", tool: "filesystem:write_file" }
 * //   ],
 * //   edges: [
 * //     { from: "n1", to: "d1", type: "sequence" },
 * //     { from: "d1", to: "n2", type: "conditional", outcome: "true" }
 * //   ]
 * // }
 * ```
 */
export class StaticStructureBuilder {
  /** Counter for generating unique node IDs */
  private nodeCounters = {
    task: 0,
    decision: 0,
    capability: 0,
    fork: 0,
    join: 0,
  };

  /**
   * Maps variable names to node IDs (Story 10.5)
   *
   * When we see `const file = await mcp.fs.read(...)`, we track:
   * - "file" → "n1" (the node ID created for this call)
   *
   * This allows us to convert references like `file.content` to `n1.content`
   * in extracted arguments, making them resolvable at runtime.
   */
  private variableToNodeId = new Map<string, string>();

  /**
   * Original source code for span extraction
   * Used to extract code operations via SWC spans
   */
  private originalCode = "";

  /**
   * SWC span base offset
   * SWC accumulates spans globally across parses, so we need to track the base offset
   */
  private spanBaseOffset = 0;

  /**
   * Extract code from SWC span
   * SWC spans use 1-based byte offsets that accumulate globally,
   * so we subtract the base offset to get the relative position
   */
  private extractCodeFromSpan(
    span: { start: number; end: number } | undefined,
  ): string | undefined {
    if (!span || !this.originalCode) return undefined;
    // Adjust for SWC global offset accumulation
    const relativeStart = span.start - this.spanBaseOffset;
    const relativeEnd = span.end - this.spanBaseOffset;
    // SWC uses 1-based positions, JavaScript substring uses 0-based
    return this.originalCode.substring(relativeStart - 1, relativeEnd - 1);
  }

  constructor(private db: DbClient) {
    logger.debug("StaticStructureBuilder initialized");
  }

  /**
   * Build static structure from TypeScript code
   *
   * @param code TypeScript code to analyze
   * @returns StaticStructure with nodes and edges, empty arrays on errors
   */
  async buildStaticStructure(code: string): Promise<StaticStructure> {
    // Reset counters for fresh analysis
    this.resetCounters();

    try {
      // Wrap code in function if not already (for valid parsing)
      const wrappedCode = this.wrapCodeIfNeeded(code);

      // Store wrapped code for span extraction (SWC spans are relative to wrapped code)
      this.originalCode = wrappedCode;

      // Parse with SWC
      const ast = await parse(wrappedCode, {
        syntax: "typescript",
        comments: false,
        script: true,
      });

      // SWC accumulates spans globally, so we need the base offset for this parse
      // The script's first span starts at 1 for a fresh parse, but accumulates
      const scriptSpan = (ast as { span?: { start: number } }).span;
      this.spanBaseOffset = scriptSpan ? scriptSpan.start - 1 : 0;

      logger.debug("Code parsed for static structure", {
        codeLength: code.length,
        spanBaseOffset: this.spanBaseOffset,
      });

      // Extract nodes from AST
      const internalNodes: InternalNode[] = [];
      this.findNodes(ast, internalNodes, 0);

      // Convert to external nodes (strip internal fields)
      const nodes: StaticStructureNode[] = internalNodes.map((n) => {
        const { position: _pos, parentScope: _scope, ...node } = n;
        return node as StaticStructureNode;
      });

      // Generate edges
      const edges: StaticStructureEdge[] = [];
      await this.generateEdges(internalNodes, edges);

      // Export variable bindings for code task context injection
      const variableBindings = Object.fromEntries(this.variableToNodeId);

      logger.debug("Static structure built", {
        nodeCount: nodes.length,
        edgeCount: edges.length,
        variableBindingsCount: Object.keys(variableBindings).length,
      });

      return { nodes, edges, variableBindings };
    } catch (error) {
      // Non-critical: return empty structure on parse errors
      logger.warn("Static structure analysis failed, returning empty", {
        error: error instanceof Error ? error.message : String(error),
      });

      return { nodes: [], edges: [], variableBindings: {} };
    }
  }

  /**
   * Get tools that require HIL approval from static structure
   *
   * @param structure Static structure to analyze
   * @returns List of tool IDs that have approvalMode: "hil"
   */
  getHILRequiredTools(structure: StaticStructure): string[] {
    const hilTools: string[] = [];

    for (const node of structure.nodes) {
      if (node.type === "task") {
        // Extract server prefix from tool ID (e.g., "filesystem:read" → "filesystem")
        const serverPrefix = node.tool.split(":")[0];
        const config = getToolPermissionConfig(serverPrefix);

        if (config?.approvalMode === "hil") {
          hilTools.push(node.tool);
        }
      }
    }

    return hilTools;
  }

  /**
   * Reset node ID counters and variable mapping
   */
  private resetCounters(): void {
    this.nodeCounters = {
      task: 0,
      decision: 0,
      capability: 0,
      fork: 0,
      join: 0,
    };
    this.variableToNodeId.clear();
  }

  /**
   * Generate unique node ID
   */
  private generateNodeId(type: keyof typeof this.nodeCounters): string {
    this.nodeCounters[type]++;
    const prefixes = {
      task: "n",
      decision: "d",
      capability: "c",
      fork: "f",
      join: "j",
    };
    return `${prefixes[type]}${this.nodeCounters[type]}`;
  }

  /**
   * Wrap code in async function if needed for valid parsing
   * (Same pattern as SchemaInferrer)
   */
  private wrapCodeIfNeeded(code: string): string {
    if (
      code.includes("function ") ||
      code.includes("class ") ||
      code.includes("export ")
    ) {
      return code;
    }
    return `async function _pmlWrapper() {\n${code}\n}`;
  }

  /**
   * Find all nodes in the AST recursively
   */
  private findNodes(
    node: unknown,
    nodes: InternalNode[],
    position: number,
    parentScope?: string,
  ): void {
    if (!node || typeof node !== "object") {
      return;
    }

    const n = node as Record<string, unknown>;

    // Story 10.5: Track variable declarations for reference resolution
    // Pattern: const file = await mcp.fs.read(...) → track "file" → node ID
    if (n.type === "VariableDeclarator") {
      this.handleVariableDeclarator(n, nodes, position, parentScope);
      return; // Handled, don't recurse normally
    }

    // Check for MCP tool calls: mcp.server.tool()
    if (n.type === "CallExpression") {
      const fullyHandled = this.handleCallExpression(n, nodes, position, parentScope);
      if (fullyHandled) return; // Promise.all etc. handle their own children
    }

    // Check for binary operations (arithmetic, comparison, logical)
    if (n.type === "BinaryExpression") {
      this.handleBinaryExpression(n, nodes, position, parentScope);
      return; // Handled, don't recurse normally
    }

    // Check for if statements
    if (n.type === "IfStatement") {
      this.handleIfStatement(n, nodes, position, parentScope);
      return; // Don't recurse normally, handled in handleIfStatement
    }

    // Check for switch statements
    if (n.type === "SwitchStatement") {
      this.handleSwitchStatement(n, nodes, position, parentScope);
      return;
    }

    // Check for ternary operators
    if (n.type === "ConditionalExpression") {
      this.handleConditionalExpression(n, nodes, position, parentScope);
      return;
    }

    // Recurse through AST
    let childPosition = position;
    for (const key of Object.keys(n)) {
      const val = n[key];
      if (Array.isArray(val)) {
        for (const item of val) {
          this.findNodes(item, nodes, childPosition++, parentScope);
        }
      } else if (typeof val === "object" && val !== null) {
        this.findNodes(val, nodes, childPosition++, parentScope);
      }
    }
  }

  /**
   * Handle CallExpression: mcp.server.tool() or capabilities.name()
   * @returns true if this node was fully handled (don't recurse into children)
   */
  private handleCallExpression(
    n: Record<string, unknown>,
    nodes: InternalNode[],
    position: number,
    parentScope?: string,
  ): boolean {
    const callee = n.callee as Record<string, unknown> | undefined;
    if (!callee) return false;

    // Check for Promise.all / Promise.allSettled
    if (callee.type === "MemberExpression") {
      const chain = this.extractMemberChain(callee);

      // Promise.all or Promise.allSettled - handles its own children
      if (chain[0] === "Promise" && (chain[1] === "all" || chain[1] === "allSettled")) {
        this.handlePromiseAll(n, nodes, position, parentScope);
        return true; // Fully handled, don't recurse
      }

      // Array operations (filter, map, reduce, etc.) - Phase 1
      const arrayOps = [
        "filter",
        "map",
        "reduce",
        "flatMap",
        "find",
        "findIndex",
        "some",
        "every",
        "sort",
        "reverse",
        "slice",
        "concat",
        "join",
        "includes",
        "indexOf",
        "lastIndexOf",
      ];

      const methodName = chain[chain.length - 1];
      if (arrayOps.includes(methodName)) {
        const nodeId = this.generateNodeId("task");

        // Extract code via SWC span
        const span = n.span as { start: number; end: number } | undefined;
        const code = this.extractCodeFromSpan(span);

        nodes.push({
          id: nodeId,
          type: "task",
          tool: `code:${methodName}`,
          position,
          parentScope,
          code, // Original code extracted via span
        });
        logger.debug("Detected array operation", {
          operation: methodName,
          nodeId,
          codeExtracted: !!code,
        });
        return false; // Continue recursing
      }

      // String operations
      const stringOps = [
        "split",
        "replace",
        "replaceAll",
        "trim",
        "trimStart",
        "trimEnd",
        "toLowerCase",
        "toUpperCase",
        "substring",
        "substr",
        "match",
        "matchAll",
      ];

      if (stringOps.includes(methodName)) {
        const nodeId = this.generateNodeId("task");

        // Extract code via SWC span
        const span = n.span as { start: number; end: number } | undefined;
        const code = span ? this.extractCodeFromSpan(span) : undefined;

        nodes.push({
          id: nodeId,
          type: "task",
          tool: `code:${methodName}`,
          position,
          parentScope,
          code, // Original code extracted via span
        });
        logger.debug("Detected string operation", {
          operation: methodName,
          nodeId,
          codeExtracted: !!code,
        });
        return false;
      }

      // Object operations (Object.keys, Object.values, etc.)
      if (
        chain[0] === "Object" &&
        ["keys", "values", "entries", "fromEntries", "assign"].includes(chain[1])
      ) {
        const nodeId = this.generateNodeId("task");
        const operation = chain[1];

        // Extract code via SWC span
        const span = n.span as { start: number; end: number } | undefined;
        const code = span ? this.extractCodeFromSpan(span) : undefined;

        nodes.push({
          id: nodeId,
          type: "task",
          tool: `code:Object.${operation}`,
          position,
          parentScope,
          code, // Original code extracted via span
        });
        logger.debug("Detected Object operation", { operation, nodeId, codeExtracted: !!code });
        return false;
      }

      // Math operations
      if (
        chain[0] === "Math" && ["max", "min", "abs", "floor", "ceil", "round"].includes(chain[1])
      ) {
        const nodeId = this.generateNodeId("task");
        const operation = chain[1];

        // Extract code via SWC span
        const span = n.span as { start: number; end: number } | undefined;
        const code = span ? this.extractCodeFromSpan(span) : undefined;

        nodes.push({
          id: nodeId,
          type: "task",
          tool: `code:Math.${operation}`,
          position,
          parentScope,
          code, // Original code extracted via span
        });
        logger.debug("Detected Math operation", { operation, nodeId, codeExtracted: !!code });
        return false;
      }

      // JSON operations
      if (chain[0] === "JSON" && ["parse", "stringify"].includes(chain[1])) {
        const nodeId = this.generateNodeId("task");
        const operation = chain[1];

        // Extract code via SWC span
        const span = n.span as { start: number; end: number } | undefined;
        const code = span ? this.extractCodeFromSpan(span) : undefined;

        nodes.push({
          id: nodeId,
          type: "task",
          tool: `code:JSON.${operation}`,
          position,
          parentScope,
          code, // Original code extracted via span
        });
        logger.debug("Detected JSON operation", { operation, nodeId, codeExtracted: !!code });
        return false;
      }

      // mcp.server.tool pattern
      if (chain[0] === "mcp" && chain.length >= 3) {
        const toolId = `${chain[1]}:${chain[2]}`;
        const id = this.generateNodeId("task");

        // Story 10.2: Extract arguments from CallExpression
        const args = n.arguments as Array<Record<string, unknown>> | undefined;
        const extractedArgs = this.extractArguments(args);

        nodes.push({
          id,
          type: "task",
          tool: toolId,
          position,
          parentScope,
          // Only include arguments if we extracted some (backward compatibility)
          ...(Object.keys(extractedArgs).length > 0 ? { arguments: extractedArgs } : {}),
        });
        return false; // Continue recursing for nested expressions
      }

      // capabilities.name pattern
      if (chain[0] === "capabilities" && chain.length >= 2) {
        const capabilityId = chain[1];
        const id = this.generateNodeId("capability");
        nodes.push({
          id,
          type: "capability",
          capabilityId,
          position,
          parentScope,
        });
        return false; // Continue recursing for nested expressions
      }
    }

    return false;
  }

  /**
   * Handle variable declarations to track variable → nodeId mapping (Story 10.5)
   *
   * Pattern: const file = await mcp.fs.read({ path: "config.json" });
   * → Tracks "file" → "n1" so that references like file.content become n1.content
   */
  private handleVariableDeclarator(
    n: Record<string, unknown>,
    nodes: InternalNode[],
    position: number,
    parentScope?: string,
  ): void {
    // Extract variable name from id
    const id = n.id as Record<string, unknown> | undefined;
    let variableName: string | undefined;

    if (id?.type === "Identifier") {
      variableName = id.value as string;
    } else if (id?.type === "ArrayPattern") {
      // Destructuring: const [a, b] = await Promise.all([...])
      // Track each element
      const elements = id.elements as Array<Record<string, unknown>> | undefined;
      if (elements) {
        for (const elem of elements) {
          if (elem?.type === "Identifier") {
            // Will be tracked when we process the corresponding node
            // For now, just mark as potential variable
          }
        }
      }
    }

    // Track current node count before processing init
    const nodeCountBefore = this.nodeCounters.task;

    // Process the initializer (this may create nodes)
    const init = n.init;
    if (init) {
      this.findNodes(init, nodes, position, parentScope);
    }

    // If a new task node was created, map the variable to it
    const nodeCountAfter = this.nodeCounters.task;
    if (variableName && nodeCountAfter > nodeCountBefore) {
      // The most recently created node is the one assigned to this variable
      const nodeId = `n${nodeCountAfter}`;
      this.variableToNodeId.set(variableName, nodeId);
      logger.debug("Tracked variable to node mapping", { variableName, nodeId });
    }
  }

  /**
   * Handle Promise.all / Promise.allSettled for parallel execution
   *
   * Supports two patterns:
   * 1. Promise.all([mcp.a(), mcp.b(), ...]) - explicit array
   * 2. Promise.all(arr.map(x => mcp.tool({...x}))) - map over array
   */
  private handlePromiseAll(
    n: Record<string, unknown>,
    nodes: InternalNode[],
    position: number,
    parentScope?: string,
  ): void {
    const args = n.arguments as Array<Record<string, unknown>> | undefined;
    if (!args || args.length === 0) return;

    // SWC wraps arguments in { spread, expression } structure
    const firstArg = args[0];
    const arrayArg = (firstArg?.expression as Record<string, unknown>) ?? firstArg;

    // Pattern 1: Direct ArrayExpression - Promise.all([a, b, c])
    if (arrayArg?.type === "ArrayExpression") {
      this.handlePromiseAllArray(arrayArg, nodes, position, parentScope);
      return;
    }

    // Pattern 2: map() call - Promise.all(arr.map(fn))
    if (arrayArg?.type === "CallExpression") {
      const mapResult = this.handlePromiseAllMap(arrayArg, nodes, position, parentScope);
      if (mapResult) return;
    }

    // Fallback: try to find MCP calls in the expression
    this.findNodes(arrayArg, nodes, position, parentScope);
  }

  /**
   * Handle Promise.all with direct array: Promise.all([mcp.a(), mcp.b()])
   */
  private handlePromiseAllArray(
    arrayArg: Record<string, unknown>,
    nodes: InternalNode[],
    position: number,
    parentScope?: string,
  ): void {
    const elements = arrayArg.elements as Array<Record<string, unknown>> | undefined;
    if (!elements || elements.length === 0) return;

    // Create fork node
    const forkId = this.generateNodeId("fork");
    nodes.push({
      id: forkId,
      type: "fork",
      position,
      parentScope,
    });

    // Process each parallel task
    // Elements are also wrapped in { spread, expression } structure
    for (const element of elements) {
      const expr = (element?.expression as Record<string, unknown>) ?? element;
      this.findNodes(expr, nodes, position + 1, forkId);
    }

    // Create join node
    const joinId = this.generateNodeId("join");
    nodes.push({
      id: joinId,
      type: "join",
      position: position + elements.length + 1,
      parentScope,
    });
  }

  /**
   * Handle Promise.all with map: Promise.all(arr.map(x => mcp.tool({...x})))
   *
   * If arr is a literal array, unrolls into N parallel tasks.
   * Otherwise, creates a single "loop" representation.
   *
   * @returns true if handled, false otherwise
   */
  private handlePromiseAllMap(
    callExpr: Record<string, unknown>,
    nodes: InternalNode[],
    position: number,
    parentScope?: string,
  ): boolean {
    const callee = callExpr.callee as Record<string, unknown> | undefined;
    if (!callee || callee.type !== "MemberExpression") return false;

    // Check if it's a .map() call
    const prop = callee.property as Record<string, unknown> | undefined;
    if (prop?.type !== "Identifier" || prop?.value !== "map") return false;

    // Get the array being mapped over
    const arrayObj = callee.object as Record<string, unknown> | undefined;

    // Get the callback function
    const mapArgs = callExpr.arguments as Array<Record<string, unknown>> | undefined;
    if (!mapArgs || mapArgs.length === 0) return false;

    const callbackArg = mapArgs[0];
    const callback = (callbackArg?.expression as Record<string, unknown>) ?? callbackArg;

    // Must be arrow function or function expression
    if (callback?.type !== "ArrowFunctionExpression" && callback?.type !== "FunctionExpression") {
      return false;
    }

    // Extract callback body (where MCP calls are)
    const callbackBody = callback.body as Record<string, unknown> | undefined;
    if (!callbackBody) return false;

    // Check if array is a literal (can unroll)
    if (arrayObj?.type === "ArrayExpression") {
      const elements = arrayObj.elements as Array<Record<string, unknown>> | undefined;
      if (elements && elements.length > 0) {
        // Unroll: create N parallel tasks
        logger.debug("Unrolling Promise.all map over literal array", { count: elements.length });

        const forkId = this.generateNodeId("fork");
        nodes.push({
          id: forkId,
          type: "fork",
          position,
          parentScope,
        });

        // For each element, process the callback body
        // Note: We can't substitute the actual values statically,
        // but we can create N identical task nodes
        for (let i = 0; i < elements.length; i++) {
          this.findNodes(callbackBody, nodes, position + 1 + i, forkId);
        }

        const joinId = this.generateNodeId("join");
        nodes.push({
          id: joinId,
          type: "join",
          position: position + elements.length + 1,
          parentScope,
        });

        return true;
      }
    }

    // Dynamic array: create a single representation with the callback body
    // This captures the MCP tool pattern even if we don't know iteration count
    logger.debug("Promise.all map over dynamic array - extracting callback body");

    const forkId = this.generateNodeId("fork");
    nodes.push({
      id: forkId,
      type: "fork",
      position,
      parentScope,
    });

    // Process callback body to find MCP calls (creates 1 task node as template)
    this.findNodes(callbackBody, nodes, position + 1, forkId);

    const joinId = this.generateNodeId("join");
    nodes.push({
      id: joinId,
      type: "join",
      position: position + 2,
      parentScope,
    });

    return true;
  }

  /**
   * Handle if/else statements
   */
  private handleIfStatement(
    n: Record<string, unknown>,
    nodes: InternalNode[],
    position: number,
    parentScope?: string,
  ): void {
    // Extract condition
    const test = n.test as Record<string, unknown> | undefined;
    const condition = this.extractConditionText(test);

    // Create decision node
    const decisionId = this.generateNodeId("decision");
    nodes.push({
      id: decisionId,
      type: "decision",
      condition,
      position,
      parentScope,
    });

    // Process consequent (if true)
    const consequent = n.consequent as Record<string, unknown> | undefined;
    if (consequent) {
      this.findNodes(consequent, nodes, position + 1, `${decisionId}:true`);
    }

    // Process alternate (else)
    const alternate = n.alternate as Record<string, unknown> | undefined;
    if (alternate) {
      this.findNodes(alternate, nodes, position + 100, `${decisionId}:false`);
    }
  }

  /**
   * Handle switch statements
   */
  private handleSwitchStatement(
    n: Record<string, unknown>,
    nodes: InternalNode[],
    position: number,
    parentScope?: string,
  ): void {
    // Extract discriminant
    const discriminant = n.discriminant as Record<string, unknown> | undefined;
    const condition = this.extractConditionText(discriminant);

    // Create decision node
    const decisionId = this.generateNodeId("decision");
    nodes.push({
      id: decisionId,
      type: "decision",
      condition: `switch(${condition})`,
      position,
      parentScope,
    });

    // Process cases
    const cases = n.cases as Array<Record<string, unknown>> | undefined;
    if (cases) {
      let casePosition = position + 1;
      for (const caseClause of cases) {
        const testNode = caseClause.test as Record<string, unknown> | undefined;
        const caseValue = testNode ? this.extractConditionText(testNode) : "default";
        const caseScope = `${decisionId}:case:${caseValue}`;

        const consequent = caseClause.consequent as Array<Record<string, unknown>> | undefined;
        if (consequent) {
          for (const stmt of consequent) {
            this.findNodes(stmt, nodes, casePosition++, caseScope);
          }
        }
      }
    }
  }

  /**
   * Handle ternary conditional expressions
   */
  private handleConditionalExpression(
    n: Record<string, unknown>,
    nodes: InternalNode[],
    position: number,
    parentScope?: string,
  ): void {
    const test = n.test as Record<string, unknown> | undefined;
    const condition = this.extractConditionText(test);

    // Create decision node
    const decisionId = this.generateNodeId("decision");
    nodes.push({
      id: decisionId,
      type: "decision",
      condition,
      position,
      parentScope,
    });

    // Process consequent (true branch)
    const consequent = n.consequent as Record<string, unknown> | undefined;
    if (consequent) {
      this.findNodes(consequent, nodes, position + 1, `${decisionId}:true`);
    }

    // Process alternate (false branch)
    const alternate = n.alternate as Record<string, unknown> | undefined;
    if (alternate) {
      this.findNodes(alternate, nodes, position + 100, `${decisionId}:false`);
    }
  }

  /**
   * Handle binary expressions (arithmetic, comparison, logical operators)
   *
   * Creates pseudo-tool tasks for operators to enable complete SHGAT learning.
   * Example: a + b becomes a task with tool: "code:add"
   */
  private handleBinaryExpression(
    n: Record<string, unknown>,
    nodes: InternalNode[],
    position: number,
    parentScope?: string,
  ): void {
    const operator = n.operator as string;

    // Map operators to operation names
    const operatorMap: Record<string, string> = {
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

    const operation = operatorMap[operator];
    if (!operation) {
      // Unknown operator, skip but recurse into children
      const left = n.left as Record<string, unknown> | undefined;
      const right = n.right as Record<string, unknown> | undefined;
      if (left) this.findNodes(left, nodes, position, parentScope);
      if (right) this.findNodes(right, nodes, position + 1, parentScope);
      return;
    }

    // Process left and right operands first (to capture their nodes)
    const left = n.left as Record<string, unknown> | undefined;
    const right = n.right as Record<string, unknown> | undefined;

    if (left) {
      this.findNodes(left, nodes, position, parentScope);
    }
    if (right) {
      this.findNodes(right, nodes, position + 1, parentScope);
    }

    // Create a task for the operator
    const nodeId = this.generateNodeId("task");

    // Extract code via SWC span
    const span = n.span as { start: number; end: number } | undefined;
    const code = span ? this.extractCodeFromSpan(span) : undefined;

    nodes.push({
      id: nodeId,
      type: "task",
      tool: `code:${operation}`,
      position: position + 2,
      parentScope,
      code, // Original code extracted via span
    });

    logger.debug("Detected binary operation", {
      operation,
      operator,
      nodeId,
      codeExtracted: !!code,
    });
  }

  /**
   * Extract member expression chain: mcp.filesystem.read → ["mcp", "filesystem", "read"]
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
   * Extract condition text from AST node
   */
  private extractConditionText(node: Record<string, unknown> | undefined): string {
    if (!node) return "unknown";

    // Simple identifier
    if (node.type === "Identifier") {
      return node.value as string;
    }

    // Member expression: obj.prop
    if (node.type === "MemberExpression") {
      const chain = this.extractMemberChain(node);
      return chain.join(".");
    }

    // Binary expression: a === b
    if (node.type === "BinaryExpression") {
      const left = this.extractConditionText(node.left as Record<string, unknown>);
      const op = node.operator as string;
      const right = this.extractConditionText(node.right as Record<string, unknown>);
      return `${left} ${op} ${right}`;
    }

    // Unary expression: !a
    if (node.type === "UnaryExpression") {
      const op = node.operator as string;
      const arg = this.extractConditionText(node.argument as Record<string, unknown>);
      return `${op}${arg}`;
    }

    // Literal values
    if (node.type === "BooleanLiteral") {
      return String(node.value);
    }
    if (node.type === "NumericLiteral" || node.type === "StringLiteral") {
      return String(node.value);
    }

    // Call expression
    if (node.type === "CallExpression") {
      const callee = node.callee as Record<string, unknown>;
      const calleeText = this.extractConditionText(callee);
      return `${calleeText}()`;
    }

    return "...";
  }

  // ===========================================================================
  // Argument Extraction (Story 10.2)
  // ===========================================================================

  /**
   * Extract arguments from a CallExpression's arguments array
   *
   * Story 10.2: Parses ObjectExpression arguments to extract ArgumentsStructure
   *
   * @param callExprArgs Array of CallExpression arguments (SWC format)
   * @returns ArgumentsStructure mapping argument names to their resolution strategies
   */
  private extractArguments(
    callExprArgs: Array<Record<string, unknown>> | undefined,
  ): ArgumentsStructure {
    if (!callExprArgs || callExprArgs.length === 0) {
      return {};
    }

    // SWC wraps arguments in { spread, expression } structure
    const firstArg = callExprArgs[0];
    const argExpr = (firstArg?.expression as Record<string, unknown>) ?? firstArg;

    // We expect first argument to be an ObjectExpression for MCP tool calls
    if (argExpr?.type !== "ObjectExpression") {
      return {};
    }

    const properties = argExpr.properties as Array<Record<string, unknown>> | undefined;
    if (!properties) {
      return {};
    }

    const result: ArgumentsStructure = {};

    for (const prop of properties) {
      // Handle KeyValueProperty (standard object property)
      if (prop.type === "KeyValueProperty") {
        const keyNode = prop.key as Record<string, unknown>;
        const valueNode = prop.value as Record<string, unknown>;

        // Extract key name
        let keyName: string | undefined;
        if (keyNode?.type === "Identifier") {
          keyName = keyNode.value as string;
        } else if (keyNode?.type === "StringLiteral") {
          keyName = keyNode.value as string;
        }

        if (keyName && valueNode) {
          const argValue = this.extractArgumentValue(valueNode);
          if (argValue) {
            result[keyName] = argValue;
          }
        }
      } // Handle spread operator: { ...obj } - skip with warning
      else if (prop.type === "SpreadElement") {
        logger.debug("Spread operator in arguments - skipping", {
          expression: this.extractConditionText(prop.arguments as Record<string, unknown>),
        });
        // Don't add to result - we can't statically resolve spreads
      } // Handle shorthand property: { key } (same as { key: key })
      else if (prop.type === "Identifier") {
        const keyName = prop.value as string;
        result[keyName] = { type: "reference", expression: keyName };
      }
    }

    return result;
  }

  /**
   * Extract a single argument value from an AST node
   *
   * Story 10.2: Determines if argument is literal, reference, or parameter
   *
   * @param node AST node representing the argument value
   * @returns ArgumentValue with resolution strategy, or undefined if unhandled
   */
  private extractArgumentValue(node: Record<string, unknown>): ArgumentValue | undefined {
    if (!node || !node.type) {
      return undefined;
    }

    // === Literal values ===
    if (node.type === "StringLiteral") {
      return { type: "literal", value: node.value as string };
    }

    if (node.type === "NumericLiteral") {
      return { type: "literal", value: node.value as number };
    }

    if (node.type === "BooleanLiteral") {
      return { type: "literal", value: node.value as boolean };
    }

    if (node.type === "NullLiteral") {
      return { type: "literal", value: null };
    }

    // === Nested object literal ===
    if (node.type === "ObjectExpression") {
      const nestedValue = this.extractObjectLiteral(node);
      return { type: "literal", value: nestedValue };
    }

    // === Array literal ===
    if (node.type === "ArrayExpression") {
      const arrayValue = this.extractArrayLiteral(node);
      return { type: "literal", value: arrayValue };
    }

    // === Member Expression (reference or parameter) ===
    if (node.type === "MemberExpression") {
      const chain = this.extractMemberChain(node);

      // Check for parameter patterns: args.X, params.X, input.X
      if (chain.length >= 2 && ["args", "params", "input"].includes(chain[0])) {
        return { type: "parameter", parameterName: chain[1] };
      }

      // Story 10.5: Convert variable name to node ID if tracked
      // e.g., "file.content" → "n1.content" if file was assigned from node n1
      const variableName = chain[0];
      const nodeId = this.variableToNodeId.get(variableName);
      if (nodeId) {
        // Replace variable name with node ID
        const convertedChain = [nodeId, ...chain.slice(1)];
        const expression = convertedChain.join(".");
        return { type: "reference", expression };
      }

      // Otherwise keep as-is (may be external variable)
      const expression = chain.join(".");
      return { type: "reference", expression };
    }

    // === Simple Identifier (could be parameter or local variable) ===
    if (node.type === "Identifier") {
      const name = node.value as string;

      // Check if it's a known parameter pattern root
      if (["args", "params", "input"].includes(name)) {
        // This shouldn't happen alone, but handle gracefully
        return { type: "parameter", parameterName: name };
      }

      // Story 10.5: Convert variable name to node ID if tracked
      const nodeId = this.variableToNodeId.get(name);
      if (nodeId) {
        return { type: "reference", expression: nodeId };
      }

      // Otherwise treat as a reference (local variable, untracked)
      return { type: "reference", expression: name };
    }

    // === Template Literal (treat as literal with placeholder) ===
    if (node.type === "TemplateLiteral") {
      // For template literals, we extract a simplified representation
      const expression = this.extractTemplateLiteralText(node);
      return { type: "reference", expression };
    }

    // === Computed expressions (e.g., function calls) ===
    if (node.type === "CallExpression") {
      const calleeText = this.extractConditionText(node.callee as Record<string, unknown>);
      return { type: "reference", expression: `${calleeText}()` };
    }

    // Fallback: unhandled node type
    logger.debug("Unhandled argument node type", { type: node.type });
    return undefined;
  }

  /**
   * Extract object literal as a plain JavaScript object
   *
   * @param node ObjectExpression AST node
   * @returns Plain object with extracted values
   */
  private extractObjectLiteral(node: Record<string, unknown>): Record<string, JsonValue> {
    const result: Record<string, JsonValue> = {};
    const properties = node.properties as Array<Record<string, unknown>> | undefined;

    if (!properties) {
      return result;
    }

    for (const prop of properties) {
      if (prop.type === "KeyValueProperty") {
        const keyNode = prop.key as Record<string, unknown>;
        const valueNode = prop.value as Record<string, unknown>;

        let keyName: string | undefined;
        if (keyNode?.type === "Identifier") {
          keyName = keyNode.value as string;
        } else if (keyNode?.type === "StringLiteral") {
          keyName = keyNode.value as string;
        }

        if (keyName && valueNode) {
          const extractedValue = this.extractLiteralValue(valueNode);
          if (extractedValue !== undefined) {
            result[keyName] = extractedValue;
          }
        }
      }
    }

    return result;
  }

  /**
   * Extract array literal as a plain JavaScript array
   *
   * @param node ArrayExpression AST node
   * @returns Plain array with extracted values
   */
  private extractArrayLiteral(node: Record<string, unknown>): JsonValue[] {
    const result: JsonValue[] = [];
    const elements = node.elements as Array<Record<string, unknown>> | undefined;

    if (!elements) {
      return result;
    }

    for (const element of elements) {
      // SWC wraps array elements in { spread, expression } structure
      const expr = (element?.expression as Record<string, unknown>) ?? element;
      if (expr) {
        const extractedValue = this.extractLiteralValue(expr);
        if (extractedValue !== undefined) {
          result.push(extractedValue);
        }
      }
    }

    return result;
  }

  /**
   * Extract a literal value from an AST node (recursive helper for objects/arrays)
   *
   * @param node AST node
   * @returns The literal value, or undefined for non-literal nodes
   */
  private extractLiteralValue(node: Record<string, unknown>): JsonValue | undefined {
    if (!node || !node.type) {
      return undefined;
    }

    if (node.type === "StringLiteral") {
      return node.value as string;
    }
    if (node.type === "NumericLiteral") {
      return node.value as number;
    }
    if (node.type === "BooleanLiteral") {
      return node.value as boolean;
    }
    if (node.type === "NullLiteral") {
      return null;
    }
    if (node.type === "ObjectExpression") {
      return this.extractObjectLiteral(node);
    }
    if (node.type === "ArrayExpression") {
      return this.extractArrayLiteral(node);
    }

    // Non-literal values return undefined
    return undefined;
  }

  /**
   * Extract text representation of a template literal
   *
   * @param node TemplateLiteral AST node
   * @returns String representation with ${...} placeholders
   */
  private extractTemplateLiteralText(node: Record<string, unknown>): string {
    const quasis = node.quasis as Array<Record<string, unknown>> | undefined;
    const expressions = node.expressions as Array<Record<string, unknown>> | undefined;

    if (!quasis || quasis.length === 0) {
      return "`...template...`";
    }

    let result = "`";
    for (let i = 0; i < quasis.length; i++) {
      const quasi = quasis[i];
      const cooked = (quasi.cooked as Record<string, unknown>)?.value as string | undefined;
      result += cooked ?? "";

      if (expressions && i < expressions.length) {
        const exprText = this.extractConditionText(expressions[i]);
        result += `\${${exprText}}`;
      }
    }
    result += "`";

    return result;
  }

  /**
   * Generate edges between nodes
   */
  private async generateEdges(
    nodes: InternalNode[],
    edges: StaticStructureEdge[],
  ): Promise<void> {
    // Sort nodes by position
    const sortedNodes = [...nodes].sort((a, b) => a.position - b.position);

    // Generate sequence edges (between sequential nodes in same scope)
    this.generateSequenceEdges(sortedNodes, edges);

    // Generate conditional edges (from decision nodes to their branches)
    this.generateConditionalEdges(sortedNodes, edges);

    // Generate fork/join edges
    this.generateForkJoinEdges(sortedNodes, edges);

    // Generate provides edges (data flow based on schemas)
    await this.generateProvidesEdges(sortedNodes, edges);
  }

  /**
   * Generate sequence edges between consecutive await statements
   */
  private generateSequenceEdges(
    nodes: InternalNode[],
    edges: StaticStructureEdge[],
  ): void {
    // Group nodes by scope
    const scopeGroups = new Map<string | undefined, InternalNode[]>();

    for (const node of nodes) {
      const scope = node.parentScope;
      if (!scopeGroups.has(scope)) {
        scopeGroups.set(scope, []);
      }
      scopeGroups.get(scope)!.push(node);
    }

    // Create sequence edges within each scope
    for (const [_scope, scopeNodes] of scopeGroups) {
      const taskNodes = scopeNodes.filter(
        (n) => n.type === "task" || n.type === "capability" || n.type === "decision",
      );

      for (let i = 0; i < taskNodes.length - 1; i++) {
        const from = taskNodes[i];
        const to = taskNodes[i + 1];

        // Don't create sequence edge if "to" is inside a different decision branch
        if (to.parentScope?.includes(":") && !from.parentScope?.includes(":")) {
          continue;
        }

        edges.push({
          from: from.id,
          to: to.id,
          type: "sequence",
        });
      }
    }
  }

  /**
   * Generate conditional edges from decision nodes to their branches
   */
  private generateConditionalEdges(
    nodes: InternalNode[],
    edges: StaticStructureEdge[],
  ): void {
    const decisionNodes = nodes.filter((n) => n.type === "decision");

    for (const decision of decisionNodes) {
      // Find nodes in true and false branches
      const trueBranchNodes = nodes.filter(
        (n) => n.parentScope === `${decision.id}:true`,
      );
      const falseBranchNodes = nodes.filter(
        (n) => n.parentScope === `${decision.id}:false`,
      );

      // Connect decision to first node in each branch
      if (trueBranchNodes.length > 0) {
        const firstTrue = trueBranchNodes.sort((a, b) => a.position - b.position)[0];
        edges.push({
          from: decision.id,
          to: firstTrue.id,
          type: "conditional",
          outcome: "true",
        });
      }

      if (falseBranchNodes.length > 0) {
        const firstFalse = falseBranchNodes.sort((a, b) => a.position - b.position)[0];
        edges.push({
          from: decision.id,
          to: firstFalse.id,
          type: "conditional",
          outcome: "false",
        });
      }

      // Handle switch case branches
      const caseScopes = new Set(
        nodes
          .filter((n) => n.parentScope?.startsWith(`${decision.id}:case:`))
          .map((n) => n.parentScope),
      );

      for (const caseScope of caseScopes) {
        const caseNodes = nodes.filter((n) => n.parentScope === caseScope);
        if (caseNodes.length > 0) {
          const firstCase = caseNodes.sort((a, b) => a.position - b.position)[0];
          const caseValue = caseScope!.split(":case:")[1];
          edges.push({
            from: decision.id,
            to: firstCase.id,
            type: "conditional",
            outcome: `case:${caseValue}`,
          });
        }
      }
    }
  }

  /**
   * Generate fork/join edges for parallel execution
   */
  private generateForkJoinEdges(
    nodes: InternalNode[],
    edges: StaticStructureEdge[],
  ): void {
    const forkNodes = nodes.filter((n) => n.type === "fork");
    const joinNodes = nodes.filter((n) => n.type === "join");

    for (const fork of forkNodes) {
      // Find nodes inside this fork
      const parallelNodes = nodes.filter((n) => n.parentScope === fork.id);

      // Connect fork to each parallel node
      for (const parallel of parallelNodes) {
        edges.push({
          from: fork.id,
          to: parallel.id,
          type: "sequence",
        });
      }

      // Find matching join (next join after fork by position)
      const matchingJoin = joinNodes.find(
        (j) => j.position > fork.position && j.parentScope === fork.parentScope,
      );

      if (matchingJoin) {
        // Connect each parallel node to join
        for (const parallel of parallelNodes) {
          edges.push({
            from: parallel.id,
            to: matchingJoin.id,
            type: "sequence",
          });
        }
      }
    }
  }

  /**
   * Generate provides edges based on tool schema data flow
   */
  private async generateProvidesEdges(
    nodes: InternalNode[],
    edges: StaticStructureEdge[],
  ): Promise<void> {
    // Get all task nodes
    const taskNodes = nodes.filter((n) => n.type === "task") as Array<
      InternalNode & { type: "task"; tool: string }
    >;

    if (taskNodes.length < 2) return;

    // Load schemas for all tools
    const schemas = new Map<string, ToolSchema>();
    for (const node of taskNodes) {
      const schema = await this.loadToolSchema(node.tool);
      if (schema) {
        schemas.set(node.tool, schema);
      }
    }

    // Check each pair of nodes for provides relationship
    for (let i = 0; i < taskNodes.length; i++) {
      for (let j = i + 1; j < taskNodes.length; j++) {
        const provider = taskNodes[i];
        const consumer = taskNodes[j];

        const providerSchema = schemas.get(provider.tool);
        const consumerSchema = schemas.get(consumer.tool);

        if (!providerSchema?.outputSchema || !consumerSchema?.inputSchema) {
          continue;
        }

        const coverage = this.computeCoverage(
          providerSchema.outputSchema,
          consumerSchema.inputSchema,
        );

        if (coverage) {
          edges.push({
            from: provider.id,
            to: consumer.id,
            type: "provides",
            coverage,
          });
        }
      }
    }
  }

  /**
   * Load tool schema from database
   */
  private async loadToolSchema(toolId: string): Promise<ToolSchema | null> {
    try {
      const result = await this.db.query(
        `SELECT tool_id, input_schema, output_schema FROM tool_schema WHERE tool_id = $1`,
        [toolId],
      );

      if (result.length === 0) {
        return null;
      }

      const row = result[0];
      return {
        toolId: row.tool_id as string,
        inputSchema: (row.input_schema as ToolSchema["inputSchema"]) || {},
        outputSchema: row.output_schema as ToolSchema["outputSchema"] | undefined,
      };
    } catch (error) {
      logger.debug("Failed to load tool schema", {
        toolId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Compute coverage level for provides edge
   *
   * Based on intersection of provider outputs and consumer inputs:
   * - strict: All required inputs are covered
   * - partial: Some required inputs are covered
   * - optional: Only optional inputs are covered
   * - null: No intersection
   */
  private computeCoverage(
    providerOutput: { properties?: Record<string, unknown> },
    consumerInput: { properties?: Record<string, unknown>; required?: string[] },
  ): ProvidesCoverage | null {
    const outputProps = new Set(Object.keys(providerOutput.properties || {}));
    const inputProps = new Set(Object.keys(consumerInput.properties || {}));
    const requiredInputs = new Set(consumerInput.required || []);

    // Calculate intersections
    const allIntersection = new Set(
      [...outputProps].filter((p) => inputProps.has(p)),
    );
    const requiredIntersection = new Set(
      [...outputProps].filter((p) => requiredInputs.has(p)),
    );
    const optionalIntersection = new Set(
      [...allIntersection].filter((p) => !requiredInputs.has(p)),
    );

    // No intersection = no edge
    if (allIntersection.size === 0) {
      return null;
    }

    // All required covered = strict
    if (requiredInputs.size > 0 && requiredIntersection.size === requiredInputs.size) {
      return "strict";
    }

    // Some required covered = partial
    if (requiredIntersection.size > 0) {
      return "partial";
    }

    // Only optional covered
    if (optionalIntersection.size > 0) {
      return "optional";
    }

    return null;
  }

  /**
   * Infer branch decisions from executed path by matching against static structure
   *
   * Story 11.2: Compares the tools that were actually executed with the
   * conditional edges in the static structure to determine which branches
   * were taken at runtime.
   *
   * @param structure - Static structure with nodes and conditional edges
   * @param executedPath - Array of tool IDs that were actually executed
   * @returns Array of BranchDecision indicating which branches were taken
   *
   * @example
   * ```typescript
   * const structure = await builder.buildStaticStructure(`
   *   if (file.exists) {
   *     await mcp.fs.read({ path });
   *   } else {
   *     await mcp.fs.create({ path });
   *   }
   * `);
   *
   * // If read was executed but not create:
   * const decisions = StaticStructureBuilder.inferDecisions(
   *   structure,
   *   ["filesystem:read_file"]
   * );
   * // Returns: [{ nodeId: "d1", outcome: "true", condition: "file.exists" }]
   * ```
   */
  static inferDecisions(
    structure: StaticStructure,
    executedPath: string[],
  ): BranchDecision[] {
    const decisions: BranchDecision[] = [];

    if (!structure?.nodes || !structure?.edges || executedPath.length === 0) {
      return decisions;
    }

    // Build map: nodeId -> tool for task nodes
    const nodeToTool = new Map<string, string>();
    for (const node of structure.nodes) {
      if (node.type === "task") {
        nodeToTool.set(node.id, node.tool);
      }
    }

    // Build map: decisionNodeId -> condition for decision nodes
    const decisionConditions = new Map<string, string>();
    for (const node of structure.nodes) {
      if (node.type === "decision") {
        decisionConditions.set(node.id, node.condition);
      }
    }

    const executedSet = new Set(executedPath);

    // Track which decisions we've already recorded (avoid duplicates)
    const recordedDecisions = new Set<string>();

    // For each conditional edge, check if the target tool was executed
    for (const edge of structure.edges) {
      if (edge.type === "conditional" && edge.outcome) {
        const tool = nodeToTool.get(edge.to);

        // If this tool was executed and we haven't recorded this decision yet
        if (tool && executedSet.has(tool) && !recordedDecisions.has(edge.from)) {
          decisions.push({
            nodeId: edge.from,
            outcome: edge.outcome,
            condition: decisionConditions.get(edge.from),
          });
          recordedDecisions.add(edge.from);
        }
      }
    }

    logger.debug("Inferred branch decisions from executed path", {
      executedPathLength: executedPath.length,
      decisionsInferred: decisions.length,
    });

    return decisions;
  }
}
