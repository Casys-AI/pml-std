/**
 * Cache Module
 *
 * Provides shared caching infrastructure using Deno KV.
 *
 * Story 11.0: Created for shared KV singleton and workflow state caching.
 *
 * @module cache
 */

// KV singleton
export { closeKv, getKv } from "./kv.ts";

// Workflow state cache
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
} from "./workflow-state-cache.ts";

export type { WorkflowDAGRecord, WorkflowStateRecord } from "./workflow-state-cache.ts";
