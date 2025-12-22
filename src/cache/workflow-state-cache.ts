/**
 * Workflow State Cache
 *
 * Deno KV-based storage for workflow DAG state with automatic TTL expiration.
 * Replaces PostgreSQL-based workflow_dags table for ephemeral runtime state.
 *
 * Story 11.0: Migration from PostgreSQL to Deno KV
 * - Native TTL support (1 hour expiration)
 * - No manual cleanup required
 * - Faster access for ephemeral state
 *
 * @module cache/workflow-state-cache
 */

import { getKv } from "./kv.ts";
import type { DAGStructure } from "../graphrag/types.ts";
import * as log from "@std/log";

/** TTL for workflow state: 1 hour in milliseconds */
const WORKFLOW_TTL_MS = 3600_000;

/** KV key prefix for workflow state */
const WORKFLOW_KEY_PREFIX = ["workflow"] as const;

/**
 * Workflow state record stored in KV
 */
export interface WorkflowStateRecord {
  dag: DAGStructure;
  intent: string | null;
  createdAt: number;
}

/**
 * Workflow DAG record with metadata (compatible with old interface)
 */
export interface WorkflowDAGRecord {
  workflow_id: string;
  dag: DAGStructure;
  intent: string | null;
  created_at: Date;
  expires_at: Date;
}

/**
 * Save workflow DAG to Deno KV
 *
 * Called at the start of per_layer_validation workflow to persist
 * the DAG for stateless MCP continuation.
 *
 * @param workflowId - Unique workflow identifier
 * @param dag - DAG structure to persist
 * @param intent - Original intent text (for observability)
 */
export async function saveWorkflowState(
  workflowId: string,
  dag: DAGStructure,
  intent: string = "",
): Promise<void> {
  const kv = await getKv();
  const key = [...WORKFLOW_KEY_PREFIX, workflowId];

  const record: WorkflowStateRecord = {
    dag,
    intent: intent || null,
    createdAt: Date.now(),
  };

  await kv.set(key, record, { expireIn: WORKFLOW_TTL_MS });
  log.debug(`Saved DAG for workflow ${workflowId} (${dag.tasks.length} tasks)`);
}

/**
 * Get workflow DAG from Deno KV
 *
 * Called by continue/replan handlers to retrieve the DAG
 * for resumeFromCheckpoint().
 *
 * @param workflowId - Workflow identifier
 * @returns DAG structure or null if not found/expired
 */
export async function getWorkflowState(
  workflowId: string,
): Promise<DAGStructure | null> {
  const kv = await getKv();
  const key = [...WORKFLOW_KEY_PREFIX, workflowId];

  const result = await kv.get<WorkflowStateRecord>(key);

  if (!result.value) {
    log.debug(`DAG not found for workflow ${workflowId}`);
    return null;
  }

  log.debug(`Retrieved DAG for workflow ${workflowId} (${result.value.dag.tasks.length} tasks)`);
  return result.value.dag;
}

/**
 * Get full workflow state record with metadata
 *
 * @param workflowId - Workflow identifier
 * @returns Full record or null if not found/expired
 */
export async function getWorkflowStateRecord(
  workflowId: string,
): Promise<WorkflowDAGRecord | null> {
  const kv = await getKv();
  const key = [...WORKFLOW_KEY_PREFIX, workflowId];

  const result = await kv.get<WorkflowStateRecord>(key);

  if (!result.value) {
    return null;
  }

  const createdAt = new Date(result.value.createdAt);
  const expiresAt = new Date(result.value.createdAt + WORKFLOW_TTL_MS);

  return {
    workflow_id: workflowId,
    dag: result.value.dag,
    intent: result.value.intent,
    created_at: createdAt,
    expires_at: expiresAt,
  };
}

/**
 * Update workflow DAG (for replanning)
 *
 * Replaces DAG and refreshes TTL.
 *
 * @param workflowId - Workflow identifier
 * @param dag - Updated DAG structure
 * @throws Error if workflow not found
 */
export async function updateWorkflowState(
  workflowId: string,
  dag: DAGStructure,
): Promise<void> {
  const kv = await getKv();
  const key = [...WORKFLOW_KEY_PREFIX, workflowId];

  // Check if workflow exists
  const existing = await kv.get<WorkflowStateRecord>(key);

  if (!existing.value) {
    throw new Error(`Workflow ${workflowId} not found`);
  }

  // Update with refreshed TTL
  const record: WorkflowStateRecord = {
    dag,
    intent: existing.value.intent,
    createdAt: Date.now(), // Reset creation time to refresh TTL
  };

  await kv.set(key, record, { expireIn: WORKFLOW_TTL_MS });
  log.debug(`Updated DAG for workflow ${workflowId}`);
}

/**
 * Delete workflow DAG from KV
 *
 * Called after workflow completes or is aborted to clean up.
 *
 * @param workflowId - Workflow identifier
 */
export async function deleteWorkflowState(
  workflowId: string,
): Promise<void> {
  const kv = await getKv();
  const key = [...WORKFLOW_KEY_PREFIX, workflowId];

  await kv.delete(key);
  log.debug(`Deleted DAG for workflow ${workflowId}`);
}

// =============================================================================
// Legacy API compatibility layer
// These functions maintain the same signatures as the old PostgreSQL-based
// workflow-dag-store.ts but ignore the db parameter (uses KV singleton).
// =============================================================================

import type { PGliteClient } from "../db/client.ts";

/**
 * Save workflow DAG (legacy API - db parameter ignored)
 * @deprecated Use saveWorkflowState() directly
 */
export async function saveWorkflowDAG(
  _db: PGliteClient,
  workflowId: string,
  dag: DAGStructure,
  intent: string = "",
): Promise<void> {
  return saveWorkflowState(workflowId, dag, intent);
}

/**
 * Get workflow DAG (legacy API - db parameter ignored)
 * @deprecated Use getWorkflowState() directly
 */
export async function getWorkflowDAG(
  _db: PGliteClient,
  workflowId: string,
): Promise<DAGStructure | null> {
  return getWorkflowState(workflowId);
}

/**
 * Get workflow DAG record (legacy API - db parameter ignored)
 * @deprecated Use getWorkflowStateRecord() directly
 */
export async function getWorkflowDAGRecord(
  _db: PGliteClient,
  workflowId: string,
): Promise<WorkflowDAGRecord | null> {
  return getWorkflowStateRecord(workflowId);
}

/**
 * Update workflow DAG (legacy API - db parameter ignored)
 * @deprecated Use updateWorkflowState() directly
 */
export async function updateWorkflowDAG(
  _db: PGliteClient,
  workflowId: string,
  dag: DAGStructure,
): Promise<void> {
  return updateWorkflowState(workflowId, dag);
}

/**
 * Delete workflow DAG (legacy API - db parameter ignored)
 * @deprecated Use deleteWorkflowState() directly
 */
export async function deleteWorkflowDAG(
  _db: PGliteClient,
  workflowId: string,
): Promise<void> {
  return deleteWorkflowState(workflowId);
}

/**
 * Cleanup expired DAGs - NO-OP with Deno KV (TTL is automatic)
 * @deprecated TTL cleanup is automatic with Deno KV
 */
export async function cleanupExpiredDAGs(_db: PGliteClient): Promise<number> {
  log.debug("cleanupExpiredDAGs: No-op with Deno KV (TTL is automatic)");
  return 0;
}

/**
 * Extend workflow DAG expiration - handled by updateWorkflowState
 * @deprecated Use updateWorkflowState which refreshes TTL automatically
 */
export async function extendWorkflowDAGExpiration(
  _db: PGliteClient,
  workflowId: string,
): Promise<void> {
  // Get current state and re-save to refresh TTL
  const kv = await getKv();
  const key = [...WORKFLOW_KEY_PREFIX, workflowId];
  const existing = await kv.get<WorkflowStateRecord>(key);

  if (existing.value) {
    const record: WorkflowStateRecord = {
      ...existing.value,
      createdAt: Date.now(),
    };
    await kv.set(key, record, { expireIn: WORKFLOW_TTL_MS });
    log.debug(`Extended expiration for workflow ${workflowId}`);
  }
}
