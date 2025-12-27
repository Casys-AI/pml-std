/**
 * Database Synchronization Module
 *
 * Handles synchronization between PGlite database and Graphology in-memory graph.
 * Loads nodes (tools) and edges (dependencies) from database.
 *
 * @module graphrag/sync/db-sync
 */

import * as log from "@std/log";
import type { DbClient } from "../../db/types.ts";
import {
  EDGE_SOURCE_MODIFIERS,
  EDGE_TYPE_WEIGHTS,
  type EdgeType,
  OBSERVED_THRESHOLD,
} from "../algorithms/edge-weights.ts";
import { sanitizeForStorage } from "../../utils/mod.ts";
import { DEFAULT_TRACE_PRIORITY } from "../../capabilities/mod.ts";
import { isCodeOperation, isPureOperation } from "../../capabilities/pure-operations.ts";
import { getOperationCategory } from "../../capabilities/operation-descriptions.ts";

/**
 * Graph interface for sync operations
 */
export interface SyncableGraph {
  clear(): void;
  addNode(nodeId: string, attributes: Record<string, unknown>): void;
  addEdge(source: string, target: string, attributes: Record<string, unknown>): void;
  hasNode(nodeId: string): boolean;
  hasEdge(source: string, target: string): boolean;
  order: number;
  size: number;
  edges(): string[];
  extremities(edge: string): [string, string];
  getEdgeAttributes(edge: string): Record<string, unknown>;
}

/**
 * Database sync result
 */
export interface SyncResult {
  nodeCount: number;
  edgeCount: number;
  capabilityEdgeCount: number;
  syncDurationMs: number;
}

/**
 * Sync graph from PGlite to Graphology in-memory
 *
 * Performance target: <50ms P95 for 200 tools, 100 dependencies
 *
 * @param db - PGlite database client
 * @param graph - Graphology graph instance
 * @returns Sync statistics
 */
export async function syncGraphFromDatabase(
  db: DbClient,
  graph: SyncableGraph,
): Promise<SyncResult> {
  const startTime = performance.now();

  // Clear existing graph
  graph.clear();

  // 1. Load nodes (tools) from PGlite
  const tools = await db.query(`
    SELECT tool_id, tool_name, server_id, metadata
    FROM tool_embedding
  `);

  for (const tool of tools) {
    const toolId = tool.tool_id as string;

    // Phase 2a: Distinguish operations from tools
    const isOperation = isCodeOperation(toolId);
    const nodeType = isOperation ? "operation" : "tool";

    const attributes: Record<string, unknown> = {
      type: nodeType,
      name: tool.tool_name as string,
      serverId: tool.server_id as string,
      metadata: tool.metadata,
    };

    // Add operation-specific attributes
    if (isOperation) {
      const category = getOperationCategory(toolId);
      attributes.category = category || "unknown";
      attributes.pure = isPureOperation(toolId);
    }

    graph.addNode(toolId, attributes);
  }

  // 2. Load edges (dependencies) from PGlite
  // ADR-041: Include edge_type and edge_source
  const deps = await db.query(`
    SELECT from_tool_id, to_tool_id, observed_count, confidence_score, edge_type, edge_source
    FROM tool_dependency
    WHERE confidence_score > 0.3
  `);

  for (const dep of deps) {
    const from = dep.from_tool_id as string;
    const to = dep.to_tool_id as string;

    if (graph.hasNode(from) && graph.hasNode(to)) {
      graph.addEdge(from, to, {
        weight: dep.confidence_score as number,
        count: dep.observed_count as number,
        // ADR-041: Load edge_type and edge_source with defaults for legacy data
        edge_type: (dep.edge_type as string) || "sequence",
        edge_source: (dep.edge_source as string) || "inferred",
      });
    }
  }

  // 3. Load capability-to-capability edges from capability_dependency table
  const capDeps = await db.query(`
    SELECT from_capability_id, to_capability_id, observed_count, confidence_score, edge_type, edge_source
    FROM capability_dependency
    WHERE confidence_score > 0.3
  `);

  for (const dep of capDeps) {
    const fromNode = `capability:${dep.from_capability_id}`;
    const toNode = `capability:${dep.to_capability_id}`;

    // Ensure capability nodes exist
    if (!graph.hasNode(fromNode)) {
      graph.addNode(fromNode, { type: "capability" });
    }
    if (!graph.hasNode(toNode)) {
      graph.addNode(toNode, { type: "capability" });
    }

    // Add edge if not already present
    if (!graph.hasEdge(fromNode, toNode)) {
      graph.addEdge(fromNode, toNode, {
        weight: dep.confidence_score as number,
        count: dep.observed_count as number,
        edge_type: (dep.edge_type as string) || "sequence",
        edge_source: (dep.edge_source as string) || "inferred",
        relationship: "capability_dependency",
      });
    }
  }

  const syncDurationMs = performance.now() - startTime;

  log.info(
    `✓ Graph synced: ${graph.order} nodes, ${graph.size} edges (${syncDurationMs.toFixed(1)}ms)`,
  );

  return {
    nodeCount: graph.order,
    edgeCount: deps.length,
    capabilityEdgeCount: capDeps.length,
    syncDurationMs,
  };
}

/**
 * Persist graph edges to database
 *
 * ADR-041: Persists edge_type and edge_source
 *
 * @param db - PGlite database client
 * @param graph - Graphology graph instance
 */
export async function persistEdgesToDatabase(
  db: DbClient,
  graph: SyncableGraph,
): Promise<void> {
  for (const edge of graph.edges()) {
    const [from, to] = graph.extremities(edge);
    const attrs = graph.getEdgeAttributes(edge);

    // Skip capability edges (they're persisted separately)
    if (from.startsWith("capability:") || to.startsWith("capability:")) {
      continue;
    }

    // ADR-041: Include edge_type and edge_source in persistence
    await db.query(
      `
      INSERT INTO tool_dependency (from_tool_id, to_tool_id, observed_count, confidence_score, edge_type, edge_source)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (from_tool_id, to_tool_id) DO UPDATE SET
        observed_count = $3,
        confidence_score = $4,
        edge_type = $5,
        edge_source = $6,
        last_observed = NOW()
      `,
      [
        from,
        to,
        attrs.count,
        attrs.weight,
        attrs.edge_type || "sequence",
        attrs.edge_source || "inferred",
      ],
    );
  }
}

/**
 * Persist capability→capability edge to capability_dependency table
 *
 * Uses UPSERT to handle repeated observations:
 * - First observation: creates with edge_source='inferred'
 * - 3+ observations: upgrades to edge_source='observed'
 *
 * @param db - PGlite database client
 * @param fromCapabilityId - Source capability UUID
 * @param toCapabilityId - Target capability UUID
 * @param edgeType - Edge type: 'contains', 'sequence', 'dependency', 'alternative'
 */
export async function persistCapabilityDependency(
  db: DbClient,
  fromCapabilityId: string,
  toCapabilityId: string,
  edgeType: EdgeType,
): Promise<void> {
  const baseWeight = EDGE_TYPE_WEIGHTS[edgeType];
  const inferredModifier = EDGE_SOURCE_MODIFIERS["inferred"];
  const observedModifier = EDGE_SOURCE_MODIFIERS["observed"];
  const threshold = OBSERVED_THRESHOLD;

  await db.query(
    `INSERT INTO capability_dependency (
      from_capability_id, to_capability_id, observed_count, confidence_score,
      edge_type, edge_source, created_at, last_observed
    ) VALUES ($1, $2, 1, $3, $4, 'inferred', NOW(), NOW())
    ON CONFLICT (from_capability_id, to_capability_id) DO UPDATE SET
      observed_count = capability_dependency.observed_count + 1,
      last_observed = NOW(),
      edge_source = CASE
        WHEN capability_dependency.observed_count + 1 >= $5
          AND capability_dependency.edge_source = 'inferred'
        THEN 'observed'
        ELSE capability_dependency.edge_source
      END,
      confidence_score = $6 * CASE
        WHEN capability_dependency.observed_count + 1 >= $5
          AND capability_dependency.edge_source = 'inferred'
        THEN $7
        ELSE $8
      END`,
    [
      fromCapabilityId,
      toCapabilityId,
      baseWeight * inferredModifier, // initial confidence
      edgeType,
      threshold,
      baseWeight,
      observedModifier,
      inferredModifier,
    ],
  );

  // Warn if contains cycle detected (potential paradox)
  if (edgeType === "contains") {
    const reverseExists = await db.queryOne(
      `SELECT 1 FROM capability_dependency
       WHERE from_capability_id = $1 AND to_capability_id = $2 AND edge_type = 'contains'`,
      [toCapabilityId, fromCapabilityId],
    );
    if (reverseExists) {
      log.warn(
        `Potential paradox: contains cycle detected between capabilities ${fromCapabilityId} ↔ ${toCapabilityId}`,
      );
    }
  }
}

/**
 * Persist workflow execution to database
 *
 * Story 9.5: Includes user_id and created_by for multi-tenant isolation
 * Story 11.2: Now writes to execution_trace table (replaces workflow_execution)
 *
 * @param db - PGlite database client
 * @param execution - Workflow execution data
 */
export async function persistWorkflowExecution(
  db: DbClient,
  execution: {
    intentText?: string;
    dagStructure: unknown;
    success: boolean;
    executionTimeMs: number;
    errorMessage?: string;
    userId?: string;
    capabilityId?: string;
    decisions?: unknown[];
    taskResults?: unknown[];
    executedPath?: string[];
    parentTraceId?: string;
  },
): Promise<string | undefined> {
  const userId = execution.userId || "local";

  // Story 11.2: Write to execution_trace table
  // AC11: Sanitize sensitive data before storage
  const sanitizedDecisions = sanitizeForStorage(execution.decisions || []);
  const sanitizedTaskResults = sanitizeForStorage(execution.taskResults || []);

  const result = await db.query(
    `INSERT INTO execution_trace
     (intent_text, success, duration_ms, error_message, user_id, created_by,
      capability_id, decisions, task_results, executed_path, parent_trace_id,
      initial_context, priority)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12::jsonb, $13)
     RETURNING id`,
    [
      execution.intentText || null,
      execution.success,
      Math.round(execution.executionTimeMs),
      execution.errorMessage || null,
      userId,
      userId,
      execution.capabilityId || null,
      sanitizedDecisions, // postgres.js auto-serializes to JSONB
      sanitizedTaskResults, // postgres.js auto-serializes to JSONB
      execution.executedPath || [],
      execution.parentTraceId || null,
      {}, // initial_context - postgres.js auto-serializes
      DEFAULT_TRACE_PRIORITY,
    ],
  );

  // Return the generated trace ID
  return result[0]?.id as string | undefined;
}
