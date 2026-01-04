/**
 * Execution trace types for capability learning
 *
 * Types for recording execution traces used by SHGAT training.
 * Story 11.2: Core types for learning from execution traces.
 *
 * @module capabilities/types/execution
 */

import type { JsonValue } from "./schema.ts";

/**
 * Branch decision recorded during execution
 *
 * Story 11.2: Captures control flow decisions for learning.
 * Each decision point (if/else, switch) records which branch was taken.
 */
export interface BranchDecision {
  /** ID of the decision node in static structure */
  nodeId: string;
  /** The outcome taken (e.g., "true", "false", "case:value") */
  outcome: string;
  /** The condition expression (optional, for debugging) */
  condition?: string;
}

/**
 * Logical operation within a fused task (Phase 2a)
 *
 * Represents an atomic operation that was part of a fused physical task.
 * Used for displaying detailed execution traces in the UI.
 */
export interface LogicalOperation {
  /** Tool ID of the logical operation (e.g., "code:filter") */
  toolId: string;

  /** Estimated duration in milliseconds (physical duration / num operations) */
  durationMs?: number;
}

/**
 * Task result recorded during execution
 *
 * Story 11.2: Captures individual tool invocation results.
 * Used for learning from execution patterns and TD error calculation.
 */
export interface TraceTaskResult {
  /** ID of the task node (matches StaticStructureNode.id) */
  taskId: string;
  /** Tool identifier (e.g., "filesystem:read_file") */
  tool: string;
  /** Arguments passed to the tool (sanitized, AC #10) */
  args: Record<string, JsonValue>;
  /** Result returned by the tool (sanitized) */
  result: JsonValue;
  /** Whether the tool call succeeded */
  success: boolean;
  /** Execution duration in milliseconds */
  durationMs: number;
  /**
   * DAG layer index for fan-in/fan-out edge reconstruction
   * Story 11.4: Tasks with same layerIndex execute in parallel
   * - Layer 0: root tasks (no dependencies)
   * - Layer N: tasks that depend on layer N-1
   */
  layerIndex?: number;

  /**
   * Phase 2a: Whether this is a fused physical task containing multiple logical operations
   * When true, logicalOperations contains the atomic operations that were fused together.
   */
  isFused?: boolean;

  /**
   * Phase 2a: Logical operations within this fused task
   * Only present when isFused is true. Contains the atomic operations that were
   * fused together for execution optimization.
   */
  logicalOperations?: LogicalOperation[];

  /**
   * Loop Abstraction: ID of the parent loop if this task is inside a loop
   * References the loop node ID from static structure (e.g., "l1")
   */
  loopId?: string;

  /**
   * Loop Abstraction: Loop iteration number (1-indexed)
   * Only present for tasks inside loops during multi-iteration execution
   */
  loopIteration?: number;

  /**
   * Loop Abstraction: Type of loop containing this task
   */
  loopType?: "for" | "while" | "forOf" | "forIn" | "doWhile";

  /**
   * Loop Abstraction: Loop condition expression (for display)
   */
  loopCondition?: string;

  /**
   * Loop Abstraction: Tools inside the loop body
   * Used by TraceTimeline to display nested tools in LoopTaskCard
   */
  bodyTools?: string[];
}

/**
 * Default priority for new traces (cold start)
 *
 * Story 11.2: Used when SHGAT hasn't computed TD error yet.
 * - 0.0 = expected trace (low learning value)
 * - 0.5 = cold start (neutral, SHGAT not trained)
 * - 1.0 = surprising trace (high learning value)
 */
export const DEFAULT_TRACE_PRIORITY = 0.5;

/**
 * Execution trace - a single execution record of a capability
 *
 * Story 11.2: Core type for learning from execution traces.
 *
 * Separation from Capability:
 * - Capability (workflow_pattern): Static structure, immutable after creation
 * - Trace (execution_trace): Runtime data, created per execution
 *
 * Used by:
 * - Story 11.3: TD error calculation (priority)
 * - Story 11.6: SHGAT training with PER sampling
 */
export interface ExecutionTrace {
  /** Unique identifier (UUID) */
  id: string;
  /** FK to workflow_pattern.pattern_id (optional for standalone code) */
  capabilityId?: string;
  /** Natural language intent that triggered this execution */
  intentText?: string;
  /**
   * BGE-M3 1024D embedding of intent_text (Story 11.x - SHGAT v2)
   *
   * Used for semantic similarity search in queryIntentSimilarSuccessRate().
   * Populated at trace save time from the intent embedding used for scoring.
   */
  intentEmbedding?: number[];
  /** Input arguments/context for the execution (AC #9 - Epic 12 dependency) */
  initialContext?: Record<string, JsonValue>;
  /** When the execution occurred */
  executedAt: Date;
  /** Whether the execution completed successfully */
  success: boolean;
  /** Total execution duration in milliseconds */
  durationMs: number;
  /** Error message if execution failed */
  errorMessage?: string;
  /** Array of node IDs in execution order */
  executedPath?: string[];
  /** Branch decisions made during execution */
  decisions: BranchDecision[];
  /** Results from each tool invocation (with sanitized args - AC #10) */
  taskResults: TraceTaskResult[];
  /**
   * Priority for PER (Prioritized Experience Replay)
   * - 0.0 = expected trace (low learning value)
   * - 0.5 = cold start (neutral, SHGAT not trained)
   * - 1.0 = surprising trace (high learning value)
   *
   * Calculated in Story 11.3 as |td_error|
   */
  priority: number;
  /** Parent trace ID for hierarchical traces (ADR-041) */
  parentTraceId?: string;
  /** User who triggered this execution (multi-tenancy) */
  userId?: string;
  /** Who created this record (migration, system, user) */
  createdBy?: string;
}
