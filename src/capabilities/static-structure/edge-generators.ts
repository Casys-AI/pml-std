/**
 * Edge Generators for Static Structure Builder
 *
 * Functions that generate edges between nodes in the static structure.
 * Extracted from StaticStructureBuilder for modularity.
 *
 * @module capabilities/static-structure/edge-generators
 */

import type { DbClient } from "../../db/types.ts";
import type { ProvidesCoverage, StaticStructureEdge } from "../types.ts";
import type { InternalNode, ToolSchema } from "./types.ts";
import { getLogger } from "../../telemetry/logger.ts";

const logger = getLogger("default");

/**
 * Generate edges for method chaining (Story 10.2c)
 *
 * Creates sequence edges based on the chainedFrom metadata set during
 * CallExpression processing. These edges represent data flow in
 * chained method calls like: numbers.filter().map().sort()
 */
export function generateChainedEdges(
  nodes: InternalNode[],
  edges: StaticStructureEdge[],
  edgeSet: Set<string>,
): void {
  for (const node of nodes) {
    if (node.type === "task" && node.metadata?.chainedFrom) {
      const fromNodeId = node.metadata.chainedFrom;
      const toNodeId = node.id;
      const edgeKey = `${fromNodeId}->${toNodeId}:sequence`;

      // Skip if already exists
      if (edgeSet.has(edgeKey)) continue;

      // Verify the source node exists
      const sourceExists = nodes.some((n) => n.id === fromNodeId);
      if (sourceExists) {
        edges.push({
          from: fromNodeId,
          to: toNodeId,
          type: "sequence",
        });
        edgeSet.add(edgeKey);

        logger.debug("Created chained edge", {
          from: fromNodeId,
          to: toNodeId,
        });
      }
    }
  }
}

/**
 * Find the root of a method chain (first node in the chain)
 * Traverses chainedFrom metadata backwards to find the chain root.
 */
function findChainRoot(
  node: InternalNode,
  allNodes: InternalNode[],
): InternalNode {
  if (node.type !== "task" || !node.metadata?.chainedFrom) {
    return node;
  }

  const chainedFromId = node.metadata.chainedFrom as string;
  const chainedFromNode = allNodes.find((n) => n.id === chainedFromId);

  if (!chainedFromNode) {
    return node;
  }

  // Recursively find the root
  return findChainRoot(chainedFromNode, allNodes);
}

/**
 * Check if a node's arguments reference another node
 *
 * Returns true if any argument of type "reference" has an expression
 * that starts with the fromNodeId (e.g., "n1" or "n1.content").
 */
function nodeReferencesNode(node: InternalNode, fromNodeId: string): boolean {
  if (node.type !== "task" || !node.arguments) {
    return false;
  }

  for (const argValue of Object.values(node.arguments)) {
    if (argValue.type === "reference" && argValue.expression) {
      // Check if expression references the fromNodeId
      // e.g., "n1" or "n1.content" or "n1[0]"
      const expr = argValue.expression;
      if (expr === fromNodeId || expr.startsWith(`${fromNodeId}.`) || expr.startsWith(`${fromNodeId}[`)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Generate sequence edges between consecutive await statements
 *
 * Only creates edges when there's a real data dependency:
 * - The "to" node references the "from" node in its arguments
 * - Otherwise, nodes are independent and can run in parallel
 */
export function generateSequenceEdges(
  nodes: InternalNode[],
  edges: StaticStructureEdge[],
  edgeSet: Set<string>,
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
    // Filter to executable nodes only (skip nested operations in callbacks)
    const taskNodes = scopeNodes.filter(
      (n) =>
        (n.type === "task" || n.type === "capability" || n.type === "decision") &&
        (n.metadata?.executable !== false), // Skip non-executable nested operations
    );

    for (let i = 0; i < taskNodes.length - 1; i++) {
      const from = taskNodes[i];
      const to = taskNodes[i + 1];

      // Don't create sequence edge if "to" is inside a different decision branch
      if (to.parentScope?.includes(":") && !from.parentScope?.includes(":")) {
        continue;
      }

      // Fix: If "to" has a chain, connect to the chain root instead
      // This ensures dependencies flow to the first operation in the chain
      const targetNode = findChainRoot(to, nodes);

      // Skip if already exists (e.g., from chained edges)
      const edgeKey = `${from.id}->${targetNode.id}:sequence`;
      if (edgeSet.has(edgeKey)) continue;

      // Only create sequence edge if there's a real data dependency
      // Check if targetNode's arguments reference the from node
      if (!nodeReferencesNode(targetNode, from.id)) {
        logger.debug("Skipping sequence edge - no data dependency", {
          from: from.id,
          to: targetNode.id,
        });
        continue;
      }

      edges.push({
        from: from.id,
        to: targetNode.id,
        type: "sequence",
      });
      edgeSet.add(edgeKey);
    }
  }
}

/**
 * Generate conditional edges from decision nodes to their branches
 */
export function generateConditionalEdges(
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
 * Generate loop edges for iteration patterns
 *
 * Creates edges from loop node to the first node in its body.
 * The body content is analyzed once (not per-iteration) for SHGAT pattern learning.
 */
export function generateLoopEdges(
  nodes: InternalNode[],
  edges: StaticStructureEdge[],
): void {
  const loopNodes = nodes.filter((n) => n.type === "loop");

  for (const loop of loopNodes) {
    // Find nodes inside this loop's body
    const bodyNodes = nodes.filter((n) => n.parentScope === loop.id);

    if (bodyNodes.length > 0) {
      // Sort by position to get first node
      const sortedBody = bodyNodes.sort((a, b) => a.position - b.position);
      const firstNode = sortedBody[0];

      // Connect loop to first node in body
      edges.push({
        from: loop.id,
        to: firstNode.id,
        type: "loop_body",
      });

      // Note: We don't create a back-edge because SHGAT sees the pattern once,
      // not the iteration cycle. The "loop" node type indicates repetition semantically.
    }
  }
}

/**
 * Generate fork/join edges for parallel execution
 */
export function generateForkJoinEdges(
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
export async function generateProvidesEdges(
  nodes: InternalNode[],
  edges: StaticStructureEdge[],
  db: DbClient,
): Promise<void> {
  // Get all task nodes
  const taskNodes = nodes.filter((n) => n.type === "task") as Array<
    InternalNode & { type: "task"; tool: string }
  >;

  if (taskNodes.length < 2) return;

  // Load schemas for all tools
  const schemas = new Map<string, ToolSchema>();
  for (const node of taskNodes) {
    const schema = await loadToolSchema(node.tool, db);
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

      const coverage = computeCoverage(
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
export async function loadToolSchema(toolId: string, db: DbClient): Promise<ToolSchema | null> {
  try {
    const result = await db.query(
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
export function computeCoverage(
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
 * Main edge generation orchestrator
 */
export async function generateAllEdges(
  nodes: InternalNode[],
  edges: StaticStructureEdge[],
  db: DbClient,
): Promise<void> {
  // Sort nodes by position
  const sortedNodes = [...nodes].sort((a, b) => a.position - b.position);

  // Track already created edges to prevent duplicates
  const edgeSet = new Set<string>();

  // Story 10.2c: Generate chained edges FIRST (before sequence edges)
  generateChainedEdges(sortedNodes, edges, edgeSet);

  // Generate sequence edges (between sequential nodes in same scope)
  generateSequenceEdges(sortedNodes, edges, edgeSet);

  // Generate conditional edges (from decision nodes to their branches)
  generateConditionalEdges(sortedNodes, edges);

  // Generate loop edges (from loop nodes to their body)
  generateLoopEdges(sortedNodes, edges);

  // Generate fork/join edges
  generateForkJoinEdges(sortedNodes, edges);

  // Generate provides edges (data flow based on schemas)
  await generateProvidesEdges(sortedNodes, edges, db);
}
