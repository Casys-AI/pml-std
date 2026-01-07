/**
 * Trace Collector Interface
 *
 * Defines the contract for collecting and storing execution traces.
 * Used for observability, debugging, and SHGAT training.
 *
 * Phase 3.1: Execute Handler → Use Cases refactoring
 *
 * @module domain/interfaces/trace-collector
 */

import type { JsonValue, TraceTaskResult } from "../../capabilities/types/mod.ts";

/**
 * Algorithm trace for decision logging
 */
export interface AlgorithmTrace {
  correlationId: string;
  algorithmName: "SHGAT" | "DRDSP" | "Thompson" | "Other";
  algorithmMode: "active_search" | "passive_suggestion";
  targetType: "tool" | "capability";
  intent: string;
  signals: Record<string, unknown>;
  params: {
    alpha?: number;
    reliabilityFactor?: number;
    structuralBoost?: number;
  };
  finalScore: number;
  thresholdUsed: number;
  decision: "accepted" | "rejected_by_threshold" | "rejected_by_policy";
}

/**
 * Complete execution trace for storage
 */
export interface ExecutionTrace {
  id: string;
  workflowPatternId: string;
  executedAt: Date;
  success: boolean;
  executionTimeMs: number;
  /** Task-level results */
  taskResults: TraceTaskResult[];
  /** Inferred branch decisions */
  decisions?: Array<{
    nodeId: string;
    branchTaken: string;
    confidence: number;
  }>;
  /** Initial context (intent, etc.) */
  initialContext?: Record<string, JsonValue>;
  /** Intent embedding for SHGAT training */
  intentEmbedding?: number[];
}

/**
 * Interface for execution trace collection
 *
 * This interface abstracts the trace storage layer,
 * allowing for different implementations (database, file, etc.)
 * and easy mocking in tests.
 */
export interface ITraceCollector {
  /**
   * Record a new execution trace
   *
   * @param trace - Complete execution trace
   * @returns Trace ID
   */
  record(trace: Omit<ExecutionTrace, "id">): Promise<string>;

  /**
   * Get traces for a capability (for SHGAT training)
   *
   * @param capabilityId - Capability ID
   * @param limit - Maximum traces to return
   * @returns Execution traces
   */
  getByCapability(capabilityId: string, limit?: number): Promise<ExecutionTrace[]>;

  /**
   * Get recent traces (for PER sampling)
   *
   * @param limit - Maximum traces to return
   * @returns Execution traces sorted by recency
   */
  getRecent(limit?: number): Promise<ExecutionTrace[]>;

  /**
   * Log an algorithm decision (for observability)
   *
   * @param trace - Algorithm trace
   */
  logAlgorithmTrace?(trace: AlgorithmTrace): void;
}
