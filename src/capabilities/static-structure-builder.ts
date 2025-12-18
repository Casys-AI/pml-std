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
import type { PGliteClient } from "../db/client.ts";
import type {
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
type InternalNode = {
  /** Unique node identifier (e.g., "n1", "d1", "f1") */
  id: string;
  /** AST traversal position for ordering sequence edges */
  position: number;
  /** Parent scope for conditional/parallel containment (e.g., "d1:true", "f1") */
  parentScope?: string;
} & (
  | { type: "task"; tool: string }
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

  constructor(private db: PGliteClient) {
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

      // Parse with SWC
      const ast = await parse(wrappedCode, {
        syntax: "typescript",
        comments: false,
        script: true,
      });

      logger.debug("Code parsed for static structure", {
        codeLength: code.length,
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

      logger.debug("Static structure built", {
        nodeCount: nodes.length,
        edgeCount: edges.length,
      });

      return { nodes, edges };
    } catch (error) {
      // Non-critical: return empty structure on parse errors
      logger.warn("Static structure analysis failed, returning empty", {
        error: error instanceof Error ? error.message : String(error),
      });

      return { nodes: [], edges: [] };
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
   * Reset node ID counters
   */
  private resetCounters(): void {
    this.nodeCounters = {
      task: 0,
      decision: 0,
      capability: 0,
      fork: 0,
      join: 0,
    };
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

    // Check for MCP tool calls: mcp.server.tool()
    if (n.type === "CallExpression") {
      const fullyHandled = this.handleCallExpression(n, nodes, position, parentScope);
      if (fullyHandled) return; // Promise.all etc. handle their own children
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

      // mcp.server.tool pattern
      if (chain[0] === "mcp" && chain.length >= 3) {
        const toolId = `${chain[1]}:${chain[2]}`;
        const id = this.generateNodeId("task");
        nodes.push({
          id,
          type: "task",
          tool: toolId,
          position,
          parentScope,
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
   * Handle Promise.all / Promise.allSettled for parallel execution
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
    if (arrayArg?.type !== "ArrayExpression") return;

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
}
