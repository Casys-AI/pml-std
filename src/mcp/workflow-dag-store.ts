/**
 * Workflow DAG Store
 *
 * Re-exports from src/cache/workflow-state-cache.ts for backwards compatibility.
 *
 * Story 11.0: Migrated from PostgreSQL to Deno KV.
 * - Native TTL support (1 hour expiration)
 * - No manual cleanup required
 * - Faster access for ephemeral state
 *
 * @module mcp/workflow-dag-store
 * @deprecated Import from src/cache/workflow-state-cache.ts directly
 */

export {
  cleanupExpiredDAGs,
  deleteWorkflowDAG,
  deleteWorkflowState,
  extendWorkflowDAGExpiration,
  getWorkflowDAG,
  getWorkflowDAGRecord,
  getWorkflowState,
  getWorkflowStateRecord,
  saveWorkflowDAG,
  saveWorkflowState,
  updateWorkflowDAG,
  updateWorkflowState,
} from "../cache/workflow-state-cache.ts";

export type {
  WorkflowDAGRecord,
  WorkflowStateRecord,
} from "../cache/workflow-state-cache.ts";
