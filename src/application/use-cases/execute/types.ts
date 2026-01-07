/**
 * Execute Use Case Types
 *
 * Shared types for execute-related use cases.
 *
 * Phase 3.1: Execute Handler → Use Cases refactoring
 *
 * @module application/use-cases/execute/types
 */

import type { JsonValue, TraceTaskResult, StaticStructure } from "../../../capabilities/types/mod.ts";

// Re-export TraceTaskResult for consumers
export type { TraceTaskResult };

// Re-export shared types
export type { UseCaseError, UseCaseResult } from "../shared/types.ts";

// ============================================================================
// Execute Direct
// ============================================================================

/**
 * Request to execute code directly
 */
export interface ExecuteDirectRequest {
  /** TypeScript code to execute */
  code: string;
  /** Natural language intent */
  intent: string;
  /** Execution options */
  options?: {
    timeout?: number;
    perLayerValidation?: boolean;
  };
}

/**
 * Result of direct code execution
 */
export interface ExecuteDirectResult {
  /** Execution succeeded */
  success: boolean;
  /** Execution output */
  result?: JsonValue;
  /** Created capability ID */
  capabilityId?: string;
  /** User-friendly capability name */
  capabilityName?: string;
  /** Full FQDN of capability */
  capabilityFqdn?: string;
  /** Execution mode */
  mode: "direct";
  /** Execution time in milliseconds */
  executionTimeMs: number;
  /** DAG execution metadata */
  dag?: {
    mode: "dag" | "sandbox";
    tasksCount: number;
    layersCount: number;
    speedup?: number;
    toolsDiscovered?: string[];
  };
  /** Tool failures (if any) */
  toolFailures?: Array<{ tool: string; error: string }>;
  /** Traces collected during execution */
  traces?: TraceTaskResult[];
  /** Static structure from code analysis */
  staticStructure?: StaticStructure;
}

// ============================================================================
// Execute Suggestion
// ============================================================================

/**
 * Request for suggestion mode
 */
export interface ExecuteSuggestionRequest {
  /** Natural language intent */
  intent: string;
  /** Options */
  options?: {
    timeout?: number;
  };
}

/**
 * Suggested task in a DAG
 */
export interface SuggestedTask {
  id: string;
  callName: string;
  type: "tool" | "capability";
  inputSchema?: unknown;
  dependsOn: string[];
}

/**
 * Suggested DAG structure
 */
export interface SuggestedDag {
  tasks: SuggestedTask[];
}

/**
 * Result of suggestion mode
 */
export interface ExecuteSuggestionResult {
  /** Suggested workflow DAG */
  suggestedDag?: SuggestedDag;
  /** Confidence score (0-1) */
  confidence: number;
  /** Best capability match */
  bestCapability?: {
    id: string;
    score: number;
  };
  /** Execution time in milliseconds */
  executionTimeMs: number;
}

// ============================================================================
// Continue Workflow
// ============================================================================

/**
 * Request to continue a workflow
 */
export interface ContinueWorkflowRequest {
  /** Workflow ID to continue */
  workflowId: string;
  /** Approval decision */
  approved: boolean;
  /** Optional checkpoint ID */
  checkpointId?: string;
}

/**
 * Result of continuing a workflow
 */
export interface ContinueWorkflowResult {
  /** Workflow completed successfully */
  success: boolean;
  /** Execution output */
  result?: JsonValue;
  /** Final workflow status */
  status: "completed" | "paused" | "failed" | "aborted";
  /** Capability created (if any) */
  capabilityId?: string;
  capabilityName?: string;
  capabilityFqdn?: string;
  /** Execution time in milliseconds */
  executionTimeMs: number;
  /** If paused again, the new checkpoint */
  checkpointId?: string;
  pendingLayer?: number;
  layerResults?: unknown[];
}

// ============================================================================
// Accept Suggestion
// ============================================================================

/**
 * Request to accept a suggestion
 */
export interface AcceptSuggestionRequest {
  /** Call name from suggested DAG */
  callName: string;
  /** Arguments for execution */
  args?: Record<string, JsonValue>;
  /** Execution options */
  options?: {
    timeout?: number;
    perLayerValidation?: boolean;
  };
}

/**
 * Result of accepting a suggestion
 */
export interface AcceptSuggestionResult {
  success: boolean;
  result?: JsonValue;
  capabilityId?: string;
  capabilityName?: string;
  capabilityFqdn?: string;
  mode: "accept_suggestion";
  executionTimeMs: number;
  dag?: {
    mode: "dag";
    tasksCount: number;
    layersCount: number;
    speedup?: number;
    toolsDiscovered?: string[];
  };
  toolFailures?: Array<{ tool: string; error: string }>;
}

// ============================================================================
// Train SHGAT
// ============================================================================

/**
 * Request to train SHGAT
 */
export interface TrainSHGATRequest {
  /** Task results from execution */
  taskResults: TraceTaskResult[];
  /** Whether execution succeeded */
  success: boolean;
  /** Execution time in milliseconds */
  executionTimeMs: number;
  /** Intent embedding (if available) */
  intentEmbedding?: number[];
  /** Capability ID (if saved) */
  capabilityId?: string;
}

/**
 * Result of SHGAT training
 */
export interface TrainSHGATResult {
  /** Training was executed (vs skipped) */
  trained: boolean;
  /** Number of traces processed */
  tracesProcessed: number;
  /** Number of examples generated */
  examplesGenerated: number;
  /** Final loss value */
  loss: number;
}

// ============================================================================
// Shared Response Types
// ============================================================================

/**
 * Execute response format (for handler facade)
 */
export interface ExecuteResponse {
  status: "success" | "approval_required" | "suggestions";
  result?: JsonValue;
  capabilityId?: string;
  capabilityName?: string;
  capabilityFqdn?: string;
  mode?: "direct" | "speculation" | "accept_suggestion";
  executionTimeMs?: number;
  workflowId?: string;
  checkpointId?: string;
  pendingLayer?: number;
  layerResults?: unknown[];
  suggestions?: {
    suggestedDag?: SuggestedDag;
    confidence: number;
  };
  toolFailures?: Array<{ tool: string; error: string }>;
  dag?: {
    mode: "dag" | "sandbox";
    tasksCount?: number;
    layersCount?: number;
    speedup?: number;
    toolsDiscovered?: string[];
  };
}
