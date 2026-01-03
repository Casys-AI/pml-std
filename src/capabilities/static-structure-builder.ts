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
  StaticStructure,
  StaticStructureEdge,
  StaticStructureNode,
} from "./types.ts";
import { getLogger } from "../telemetry/logger.ts";
import { getToolPermissionConfig } from "./permission-inferrer.ts";
// Phase 2.5: Import refactored modules
import {
  createStaticStructureVisitor,
  evaluateBinaryOp,
  evaluateUnaryOp,
  extractArrayLiteral as extractArrayLiteralUtil,
  extractConditionText as extractConditionTextUtil,
  extractMemberChain as extractMemberChainUtil,
  extractObjectLiteral as extractObjectLiteralUtil,
  extractTemplateLiteralText as extractTemplateLiteralTextUtil,
  generateAllEdges,
} from "./static-structure/mod.ts";
import type { InternalNode, NodeMetadata, VisitorResult } from "./static-structure/mod.ts";
import { BuilderContextAdapter } from "./static-structure/builder-context-adapter.ts";
import { ASTVisitor } from "../infrastructure/patterns/visitor/mod.ts";

const logger = getLogger("default");

// Types ToolSchema, NodeMetadata, InternalNode are now imported from ./static-structure/mod.ts

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
    loop: 0,
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
  public variableToNodeId = new Map<string, string>();

  /**
   * Maps variable names to literal values (Story 10.2b - Option B)
   *
   * When we see `const numbers = [10, 20, 30]`, we track:
   * - "numbers" → [10, 20, 30] (the literal value)
   *
   * This allows us to resolve shorthand arguments like `{ numbers }`
   * where `numbers` is a local variable with a literal value.
   */
  public literalBindings = new Map<string, JsonValue>();

  /**
   * Tracks processed CallExpression spans to prevent double-processing
   * (Story 10.2c - Method chaining support)
   *
   * When we recursively process chained calls like numbers.filter().map().sort(),
   * we visit each CallExpression twice:
   * - Once via normal AST traversal
   * - Once via recursion from the parent chained call
   *
   * This set stores "start-end" keys to return the existing nodeId instead
   * of creating duplicates.
   */
  public processedSpans = new Map<string, string>();

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
   * AST Visitor for node type dispatch (Phase 2.5)
   *
   * Lazily initialized to ensure builder methods are bound correctly.
   * Uses the Visitor pattern for clean node type dispatch.
   */
  private _visitor: ASTVisitor<
    import("./static-structure/ast-handlers.ts").HandlerContext,
    VisitorResult
  > | null = null;

  /**
   * Get or create the AST visitor
   */
  private get visitor(): ASTVisitor<
    import("./static-structure/ast-handlers.ts").HandlerContext,
    VisitorResult
  > {
    if (!this._visitor) {
      this._visitor = createStaticStructureVisitor(ASTVisitor);
    }
    return this._visitor;
  }

  /**
   * Extract code from SWC span
   * SWC spans use 1-based byte offsets that accumulate globally,
   * so we subtract the base offset to get the relative position
   */
  public extractCodeFromSpan(
    span: { start: number; end: number } | undefined,
  ): string | undefined {
    if (!span || !this.originalCode) return undefined;
    // Adjust for SWC global offset accumulation
    const relativeStart = span.start - this.spanBaseOffset;
    const relativeEnd = span.end - this.spanBaseOffset;
    // SWC uses 1-based positions, JavaScript substring uses 0-based
    return this.originalCode.substring(relativeStart - 1, relativeEnd - 1);
  }

  /**
   * Extract full method chain span (from source to final call)
   * (Story 10.2c - Method chaining regression fix)
   *
   * For: numbers.filter(...).map(...).sort()
   * Returns span from "numbers" to "sort()"
   *
   * This ensures executable nodes have the complete chain code for execution,
   * not just the isolated method fragment.
   *
   * @param node The CallExpression AST node
   * @returns Full chain span { start, end } or undefined
   */
  public extractFullChainSpan(
    node: Record<string, unknown>,
  ): { start: number; end: number } | undefined {
    const nodeSpan = node.span as { start: number; end: number } | undefined;
    if (!nodeSpan) return undefined;

    // End = current node's end (the end of the chain)
    const end = nodeSpan.end;

    // Start = walk to the deepest object in callee chain
    let start = nodeSpan.start;
    let current: Record<string, unknown> | undefined = node;

    while (current) {
      const callee = current.callee as Record<string, unknown> | undefined;
      if (!callee || callee.type !== "MemberExpression") break;

      const object = callee.object as Record<string, unknown> | undefined;
      if (!object) break;

      const objSpan = object.span as { start: number; end: number } | undefined;
      if (objSpan) start = objSpan.start;

      // Continue only if object is also a CallExpression
      if (object.type === "CallExpression") {
        current = object;
      } else {
        break; // Reached source (Identifier, ArrayExpression, etc.)
      }
    }

    return { start, end };
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

      // Convert to external nodes (strip position, keep parentScope for loop membership)
      // Bug 2 Fix: parentScope is now preserved for downstream loop tracking
      const nodes: StaticStructureNode[] = internalNodes.map((n) => {
        const { position: _pos, ...node } = n;
        return node as StaticStructureNode;
      });

      // Generate edges
      const edges: StaticStructureEdge[] = [];
      await this.generateEdges(internalNodes, edges);

      // Export variable bindings for code task context injection
      const variableBindings = Object.fromEntries(this.variableToNodeId);

      // Export literal bindings for argument resolution (Story 10.2b)
      const literalBindings = Object.fromEntries(this.literalBindings);

      logger.debug("Static structure built", {
        nodeCount: nodes.length,
        edgeCount: edges.length,
        variableBindingsCount: Object.keys(variableBindings).length,
        literalBindingsCount: Object.keys(literalBindings).length,
      });

      return { nodes, edges, variableBindings, literalBindings };
    } catch (error) {
      // Non-critical: return empty structure on parse errors
      logger.warn("Static structure analysis failed, returning empty", {
        error: error instanceof Error ? error.message : String(error),
      });

      return { nodes: [], edges: [], variableBindings: {}, literalBindings: {} };
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
      loop: 0,
    };
    this.variableToNodeId.clear();
    this.literalBindings.clear();
    this.processedSpans.clear();
  }

  /**
   * Generate unique node ID
   */
  public generateNodeId(type: keyof typeof this.nodeCounters): string {
    this.nodeCounters[type]++;
    const prefixes = {
      task: "n",
      decision: "d",
      capability: "c",
      fork: "f",
      join: "j",
      loop: "l",
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
   *
   * Option B: Uses nestingLevel parameter for tracking callback nesting.
   * - nestingLevel=0: top-level code (executable=true)
   * - nestingLevel>0: inside callback (executable=false)
   *
   * @param node AST node to process
   * @param nodes Accumulator for found nodes
   * @param position AST traversal position
   * @param parentScope Parent scope for containment (e.g., "d1:true")
   * @param nestingLevel Current callback nesting depth (default 0 = top-level)
   * @param currentParentOp Parent operation name if inside callback (e.g., "code:map")
   */
  public findNodes(
    node: unknown,
    nodes: InternalNode[],
    position: number,
    parentScope?: string,
    nestingLevel: number = 0,
    currentParentOp?: string,
  ): void {
    if (!node || typeof node !== "object") {
      return;
    }

    const n = node as Record<string, unknown>;

    // Phase 2.5: Use Visitor pattern for node type dispatch
    // The visitor handles all node types via registered handlers:
    // - Control flow: IfStatement, SwitchStatement, ConditionalExpression
    // - Operations: BinaryExpression, CallExpression
    // - Scope: ArrowFunctionExpression, FunctionExpression, VariableDeclarator
    // - Default: recursive traversal for unhandled node types
    const ctx = new BuilderContextAdapter(
      this,
      nodes,
      position,
      parentScope,
      nestingLevel,
      currentParentOp,
    );

    // Visit the node - the visitor dispatches to the appropriate handler
    // Handlers return { handled: true } to prevent default recursion
    const result = this.visitor.visit(n as { type: string; [key: string]: unknown }, ctx);

    // If a handler processed this node, we're done
    // Note: The default handler does recursion, so this should always be true
    // unless visiting an unknown node type without a type field
    if (result?.handled) {
      return;
    }

    // Fallback: If no handler matched (e.g., node has no type field),
    // do manual recursion through children
    let childPosition = position;
    for (const key of Object.keys(n)) {
      const val = n[key];
      if (Array.isArray(val)) {
        for (const item of val) {
          this.findNodes(item, nodes, childPosition++, parentScope, nestingLevel, currentParentOp);
        }
      } else if (typeof val === "object" && val !== null) {
        this.findNodes(val, nodes, childPosition++, parentScope, nestingLevel, currentParentOp);
      }
    }
  }

  /**
   * Handle CallExpression: mcp.server.tool() or capabilities.name()
   *
   * Option B: Accepts nestingLevel and currentParentOp for executable tracking.
   * Sets currentParentOp when entering array operations with callbacks.
   *
   * Story 10.2c: Supports method chaining by recursively processing chained calls
   * BEFORE creating the current node, then creating edges between them.
   *
   * @returns Object with:
   *   - nodeId: ID of the created task node (undefined if no task created)
   *   - handled: true if children were fully handled (don't recurse further)
   */
  public handleCallExpression(
    n: Record<string, unknown>,
    nodes: InternalNode[],
    position: number,
    parentScope?: string,
    nestingLevel: number = 0,
    currentParentOp?: string,
  ): { nodeId?: string; handled: boolean } {
    const callee = n.callee as Record<string, unknown> | undefined;
    if (!callee) return { handled: false };

    // Story 10.2c: Check if already processed (prevent duplicates from AST + recursion)
    const span = n.span as { start: number; end: number } | undefined;
    if (span) {
      const spanKey = `${span.start}-${span.end}`;
      const existingNodeId = this.processedSpans.get(spanKey);
      if (existingNodeId !== undefined) {
        return { nodeId: existingNodeId || undefined, handled: true };
      }
    }

    // Story 10.2c: Process chained call BEFORE creating current node
    let chainedInputNodeId: string | undefined;
    if (callee.type === "MemberExpression") {
      const objectExpr = (callee as Record<string, unknown>).object as Record<string, unknown>;
      if (objectExpr?.type === "CallExpression") {
        // Recursively process the chained call
        const chainedResult = this.handleCallExpression(
          objectExpr,
          nodes,
          position,
          parentScope,
          nestingLevel,
          currentParentOp,
        );
        chainedInputNodeId = chainedResult.nodeId;
      }
    }

    // Check for Promise.all / Promise.allSettled
    if (callee.type === "MemberExpression") {
      const chain = this.extractMemberChain(callee);

      // Promise.all or Promise.allSettled - handles its own children
      if (chain[0] === "Promise" && (chain[1] === "all" || chain[1] === "allSettled")) {
        this.handlePromiseAll(n, nodes, position, parentScope, nestingLevel, currentParentOp);
        // Mark as processed but no chainable nodeId
        if (span) {
          this.processedSpans.set(`${span.start}-${span.end}`, "");
        }
        return { handled: true }; // Fully handled, don't recurse
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

        // Option B: Determine if this task is executable
        const isExecutable = nestingLevel === 0;

        // Story 10.2c fix: Always extract full code including the object reference.
        // For chains: nums.filter().map() → full chain
        // For single calls: nums.map() → includes nums
        const code = this.extractCodeFromSpan(this.extractFullChainSpan(n));

        nodes.push({
          id: nodeId,
          type: "task",
          tool: `code:${methodName}`,
          position,
          parentScope,
          code,
          // Option B: Add execution metadata
          metadata: {
            executable: isExecutable,
            nestingLevel,
            parentOperation: currentParentOp,
          },
        });

        // Story 10.2c: Create edge from chained input to this node
        if (chainedInputNodeId) {
          // Store the relationship in metadata for edge generation
          const existingNode = nodes.find((node) => node.id === nodeId);
          if (existingNode && existingNode.metadata) {
            (existingNode.metadata as NodeMetadata & { chainedFrom?: string }).chainedFrom =
              chainedInputNodeId;
          }

          // Story 10.2c fix: Mark the INPUT node as non-executable (it's intermediate in chain)
          // The current node (this one) is the final/executable one
          const inputNode = nodes.find((node) => node.id === chainedInputNodeId);
          if (inputNode && inputNode.metadata) {
            (inputNode.metadata as NodeMetadata).executable = false;
            // Also update code to method-only (not full chain)
            // Type guard: only task nodes have code and tool properties
            if (inputNode.type === "task" && inputNode.code && inputNode.tool) {
              const inputMethodName = inputNode.tool.replace("code:", "");
              const methodStart = inputNode.code.indexOf(inputMethodName + "(");
              if (methodStart > 0) {
                inputNode.code = inputNode.code.substring(methodStart);
              }
            }
          }
        }

        logger.debug("Detected array operation", {
          operation: methodName,
          nodeId,
          codeExtracted: !!code,
          executable: isExecutable,
          nestingLevel,
          chainedFrom: chainedInputNodeId,
        });

        // Mark as processed
        if (span) {
          this.processedSpans.set(`${span.start}-${span.end}`, nodeId);
        }

        // Option B: When recursing into callback arguments, set currentParentOp
        // so nested operations know their parent
        const args = n.arguments as Array<Record<string, unknown>> | undefined;
        if (args) {
          for (const arg of args) {
            const argExpr = (arg?.expression as Record<string, unknown>) ?? arg;
            // Pass the current operation as parent for nested ops
            this.findNodes(
              argExpr,
              nodes,
              position + 1,
              parentScope,
              nestingLevel,
              `code:${methodName}`, // This becomes currentParentOp for nested ops
            );
          }
        }
        return { nodeId, handled: true }; // Fully handled (we recursed into args ourselves)
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
        const isExecutable = nestingLevel === 0;

        // Story 10.2c fix: Always extract full code including the object reference
        const code = this.extractCodeFromSpan(this.extractFullChainSpan(n));

        nodes.push({
          id: nodeId,
          type: "task",
          tool: `code:${methodName}`,
          position,
          parentScope,
          code,
          metadata: {
            executable: isExecutable,
            nestingLevel,
            parentOperation: currentParentOp,
            ...(chainedInputNodeId ? { chainedFrom: chainedInputNodeId } : {}),
          },
        });

        // Story 10.2c fix: Mark the INPUT node as non-executable (it's intermediate in chain)
        if (chainedInputNodeId) {
          const inputNode = nodes.find((node) => node.id === chainedInputNodeId);
          if (inputNode && inputNode.metadata) {
            (inputNode.metadata as NodeMetadata).executable = false;
            // Also update code to method-only (not full chain)
            // Type guard: only task nodes have code and tool properties
            if (inputNode.type === "task" && inputNode.code && inputNode.tool) {
              const inputMethodName = inputNode.tool.replace("code:", "");
              const methodStart = inputNode.code.indexOf(inputMethodName + "(");
              if (methodStart > 0) {
                inputNode.code = inputNode.code.substring(methodStart);
              }
            }
          }
        }

        // Mark as processed
        if (span) {
          this.processedSpans.set(`${span.start}-${span.end}`, nodeId);
        }

        logger.debug("Detected string operation", {
          operation: methodName,
          nodeId,
          codeExtracted: !!code,
          executable: isExecutable,
          chainedFrom: chainedInputNodeId,
        });
        return { nodeId, handled: false };
      }

      // Object operations (Object.keys, Object.values, etc.)
      if (
        chain[0] === "Object" &&
        ["keys", "values", "entries", "fromEntries", "assign"].includes(chain[1])
      ) {
        const nodeId = this.generateNodeId("task");
        const operation = chain[1];
        const code = span ? this.extractCodeFromSpan(span) : undefined;
        const isExecutable = nestingLevel === 0;

        nodes.push({
          id: nodeId,
          type: "task",
          tool: `code:Object.${operation}`,
          position,
          parentScope,
          code,
          metadata: { executable: isExecutable, nestingLevel, parentOperation: currentParentOp },
        });

        if (span) {
          this.processedSpans.set(`${span.start}-${span.end}`, nodeId);
        }

        logger.debug("Detected Object operation", {
          operation,
          nodeId,
          codeExtracted: !!code,
          executable: isExecutable,
        });
        return { nodeId, handled: false };
      }

      // Math operations
      if (
        chain[0] === "Math" && ["max", "min", "abs", "floor", "ceil", "round"].includes(chain[1])
      ) {
        const nodeId = this.generateNodeId("task");
        const operation = chain[1];
        const code = span ? this.extractCodeFromSpan(span) : undefined;
        const isExecutable = nestingLevel === 0;

        nodes.push({
          id: nodeId,
          type: "task",
          tool: `code:Math.${operation}`,
          position,
          parentScope,
          code,
          metadata: { executable: isExecutable, nestingLevel, parentOperation: currentParentOp },
        });

        if (span) {
          this.processedSpans.set(`${span.start}-${span.end}`, nodeId);
        }

        logger.debug("Detected Math operation", {
          operation,
          nodeId,
          codeExtracted: !!code,
          executable: isExecutable,
        });
        return { nodeId, handled: false };
      }

      // JSON operations
      if (chain[0] === "JSON" && ["parse", "stringify"].includes(chain[1])) {
        const nodeId = this.generateNodeId("task");
        const operation = chain[1];
        const code = span ? this.extractCodeFromSpan(span) : undefined;
        const isExecutable = nestingLevel === 0;

        nodes.push({
          id: nodeId,
          type: "task",
          tool: `code:JSON.${operation}`,
          position,
          parentScope,
          code,
          metadata: { executable: isExecutable, nestingLevel, parentOperation: currentParentOp },
        });

        if (span) {
          this.processedSpans.set(`${span.start}-${span.end}`, nodeId);
        }

        logger.debug("Detected JSON operation", {
          operation,
          nodeId,
          codeExtracted: !!code,
          executable: isExecutable,
        });
        return { nodeId, handled: false };
      }

      // mcp.server.tool pattern - MCP tools are always executable (they handle their own context)
      if (chain[0] === "mcp" && chain.length >= 3) {
        const toolId = `${chain[1]}:${chain[2]}`;
        const nodeId = this.generateNodeId("task");
        const args = n.arguments as Array<Record<string, unknown>> | undefined;
        const extractedArgs = this.extractArguments(args);

        nodes.push({
          id: nodeId,
          type: "task",
          tool: toolId,
          position,
          parentScope,
          ...(Object.keys(extractedArgs).length > 0 ? { arguments: extractedArgs } : {}),
          // MCP tools are always executable - they're self-contained
          metadata: { executable: true, nestingLevel, parentOperation: currentParentOp },
        });

        if (span) {
          this.processedSpans.set(`${span.start}-${span.end}`, nodeId);
        }

        return { nodeId, handled: false };
      }

      // Note: capabilities.name pattern removed in Migration 028
      // Capabilities are now called via mcp.namespace.action like regular tools
    }

    return { handled: false };
  }

  /**
   * Handle variable declarations to track variable → nodeId mapping (Story 10.5)
   * and variable → literal value mapping (Story 10.2b - Option B)
   *
   * Pattern 1: const file = await mcp.fs.read({ path: "config.json" });
   * → Tracks "file" → "n1" so that references like file.content become n1.content
   *
   * Pattern 2: const numbers = [10, 20, 30];
   * → Tracks "numbers" → [10, 20, 30] so that { numbers } resolves to the literal value
   */
  public handleVariableDeclarator(
    n: Record<string, unknown>,
    nodes: InternalNode[],
    position: number,
    parentScope?: string,
    nestingLevel: number = 0,
    currentParentOp?: string,
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

    // Story 10.2b Option B: Check if init is a literal value (no MCP call)
    // If so, store it in literalBindings for argument resolution
    const init = n.init as Record<string, unknown> | undefined;
    if (variableName && init) {
      // Handle AwaitExpression: unwrap to get the actual expression
      const actualInit = init.type === "AwaitExpression"
        ? init.argument as Record<string, unknown>
        : init;

      // Check if it's a literal value (not a function call that creates a node)
      if (actualInit && this.isLiteralExpression(actualInit)) {
        const literalValue = this.extractLiteralValue(actualInit);
        if (literalValue !== undefined) {
          this.literalBindings.set(variableName, literalValue);
          logger.debug("Tracked variable to literal binding", {
            variableName,
            valueType: typeof literalValue,
            isArray: Array.isArray(literalValue),
          });
          // Don't recurse into literal - no nodes to create
          return;
        }
      }
    }

    // Track current node count before processing init
    const nodeCountBefore = this.nodeCounters.task;

    // Process the initializer (this may create nodes)
    if (init) {
      this.findNodes(init, nodes, position, parentScope, nestingLevel, currentParentOp);
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
   * Check if an AST node is a literal expression (not a function call)
   *
   * Story 10.2b: Used to determine if a variable declaration should be
   * tracked as a literal binding (for argument resolution) vs a node mapping
   * (for task result references).
   *
   * Extended to support computed expressions (a + b) where operands are literals.
   */
  private isLiteralExpression(node: Record<string, unknown>): boolean {
    const literalTypes = [
      "StringLiteral",
      "NumericLiteral",
      "BooleanLiteral",
      "NullLiteral",
      "ArrayExpression",
      "ObjectExpression",
      // Story 10.2b: Support computed expressions
      "BinaryExpression",
      "UnaryExpression",
      "ParenthesisExpression",
    ];

    if (literalTypes.includes(node.type as string)) {
      return true;
    }

    // Identifier is only a "literal expression" if it references a tracked literal
    if (node.type === "Identifier") {
      const varName = node.value as string;
      return this.literalBindings.has(varName);
    }

    return false;
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
    nestingLevel: number = 0,
    currentParentOp?: string,
  ): void {
    const args = n.arguments as Array<Record<string, unknown>> | undefined;
    if (!args || args.length === 0) return;

    // SWC wraps arguments in { spread, expression } structure
    const firstArg = args[0];
    const arrayArg = (firstArg?.expression as Record<string, unknown>) ?? firstArg;

    // Pattern 1: Direct ArrayExpression - Promise.all([a, b, c])
    if (arrayArg?.type === "ArrayExpression") {
      this.handlePromiseAllArray(
        arrayArg,
        nodes,
        position,
        parentScope,
        nestingLevel,
        currentParentOp,
      );
      return;
    }

    // Pattern 2: map() call - Promise.all(arr.map(fn))
    if (arrayArg?.type === "CallExpression") {
      const mapResult = this.handlePromiseAllMap(
        arrayArg,
        nodes,
        position,
        parentScope,
        nestingLevel,
        currentParentOp,
      );
      if (mapResult) return;
    }

    // Fallback: try to find MCP calls in the expression
    this.findNodes(arrayArg, nodes, position, parentScope, nestingLevel, currentParentOp);
  }

  /**
   * Handle Promise.all with direct array: Promise.all([mcp.a(), mcp.b()])
   */
  private handlePromiseAllArray(
    arrayArg: Record<string, unknown>,
    nodes: InternalNode[],
    position: number,
    parentScope?: string,
    nestingLevel: number = 0,
    currentParentOp?: string,
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
      this.findNodes(expr, nodes, position + 1, forkId, nestingLevel, currentParentOp);
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
    nestingLevel: number = 0,
    currentParentOp?: string,
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
        // Note: nestingLevel stays same, callback body processing handles it
        for (let i = 0; i < elements.length; i++) {
          this.findNodes(
            callbackBody,
            nodes,
            position + 1 + i,
            forkId,
            nestingLevel,
            currentParentOp,
          );
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
    this.findNodes(callbackBody, nodes, position + 1, forkId, nestingLevel, currentParentOp);

    const joinId = this.generateNodeId("join");
    nodes.push({
      id: joinId,
      type: "join",
      position: position + 2,
      parentScope,
    });

    return true;
  }

  // Phase 2.5: Handler methods moved to ./static-structure/ast-handlers.ts
  // - handleIfStatement
  // - handleSwitchStatement
  // - handleConditionalExpression
  // - handleBinaryExpression

  /**
   * Extract member expression chain: mcp.filesystem.read → ["mcp", "filesystem", "read"]
   * Phase 2.5: Delegates to extracted utility
   */
  public extractMemberChain(
    node: Record<string, unknown>,
    parts: string[] = [],
  ): string[] {
    return extractMemberChainUtil(node, parts);
  }

  /**
   * Extract condition text from AST node
   * Phase 2.5: Delegates to extracted utility
   */
  public extractConditionText(node: Record<string, unknown> | undefined): string {
    return extractConditionTextUtil(node);
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

            // Story 10.2d: Track inline literals for parameterization
            // This makes capabilities reusable by extracting hardcoded values
            if (argValue.type === "literal" && argValue.value !== null) {
              // Only track primitive values (not nested objects/arrays)
              const val = argValue.value;
              if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
                this.literalBindings.set(keyName, val);
                logger.debug("Tracked inline literal for parameterization", {
                  keyName,
                  valueType: typeof val,
                });
              }
            }
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

    // === Template Literal ===
    if (node.type === "TemplateLiteral") {
      const expressions = node.expressions as Array<unknown> | undefined;
      const quasis = node.quasis as Array<Record<string, unknown>> | undefined;

      // Simple template literal (no interpolation) → treat as literal
      // e.g., `SELECT * FROM users` → { type: "literal", value: "SELECT * FROM users" }
      if (!expressions || expressions.length === 0) {
        // Extract the raw text content from quasis
        const textContent = quasis
          ?.map((q) => (q.cooked as string) ?? "")
          .join("") ?? "";
        if (textContent.length > 0) {
          return { type: "literal", value: textContent };
        }
      }

      // Template with interpolation → treat as reference (dynamic value)
      // e.g., `SELECT * FROM ${table}` → { type: "reference", expression: "..." }
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
   * Phase 2.5: Delegates to extracted utility
   */
  private extractObjectLiteral(node: Record<string, unknown>): Record<string, JsonValue> {
    return extractObjectLiteralUtil(node, (n) => this.extractLiteralValue(n));
  }

  /**
   * Extract array literal as a plain JavaScript array
   * Phase 2.5: Delegates to extracted utility
   */
  private extractArrayLiteral(node: Record<string, unknown>): JsonValue[] {
    return extractArrayLiteralUtil(node, (n) => this.extractLiteralValue(n));
  }

  /**
   * Extract a literal value from an AST node (recursive helper for objects/arrays)
   *
   * Story 10.2b: Extended to support BinaryExpression (a + b) and Identifier references
   * to already-tracked literal bindings.
   *
   * @param node AST node
   * @returns The literal value, or undefined for non-literal nodes
   */
  public extractLiteralValue(node: Record<string, unknown>): JsonValue | undefined {
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

    // Story 10.2b: Support Identifier references to tracked literals
    if (node.type === "Identifier") {
      const varName = node.value as string;
      if (this.literalBindings.has(varName)) {
        return this.literalBindings.get(varName);
      }
      return undefined;
    }

    // Story 10.2b: Support BinaryExpression (a + b, a - b, etc.)
    if (node.type === "BinaryExpression") {
      return this.evaluateBinaryExpression(node);
    }

    // Story 10.2b: Support UnaryExpression (-a, !a, etc.)
    if (node.type === "UnaryExpression") {
      return this.evaluateUnaryExpression(node);
    }

    // Story 10.2b: Support parenthesized expressions
    if (node.type === "ParenthesisExpression") {
      const expr = node.expression as Record<string, unknown>;
      return expr ? this.extractLiteralValue(expr) : undefined;
    }

    // Non-literal values return undefined
    return undefined;
  }

  /**
   * Evaluate a binary expression statically (Story 10.2b)
   * Phase 2.5: Delegates to extracted utility
   */
  private evaluateBinaryExpression(node: Record<string, unknown>): JsonValue | undefined {
    const left = this.extractLiteralValue(node.left as Record<string, unknown>);
    const right = this.extractLiteralValue(node.right as Record<string, unknown>);
    const operator = node.operator as string;
    return evaluateBinaryOp(left, right, operator);
  }

  /**
   * Evaluate a unary expression statically (Story 10.2b)
   * Phase 2.5: Delegates to extracted utility
   */
  private evaluateUnaryExpression(node: Record<string, unknown>): JsonValue | undefined {
    const argument = this.extractLiteralValue(node.argument as Record<string, unknown>);
    const operator = node.operator as string;
    return evaluateUnaryOp(argument, operator);
  }

  /**
   * Extract text representation of a template literal
   * Phase 2.5: Delegates to extracted utility
   */
  private extractTemplateLiteralText(node: Record<string, unknown>): string {
    return extractTemplateLiteralTextUtil(node);
  }

  /**
   * Generate edges between nodes
   * Phase 2.5: Delegates to extracted module
   */
  private async generateEdges(
    nodes: InternalNode[],
    edges: StaticStructureEdge[],
  ): Promise<void> {
    await generateAllEdges(nodes, edges, this.db);
  }

  // Edge generation methods moved to ./static-structure/edge-generators.ts

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
