/**
 * SHGAT Trainer Interface
 *
 * Defines the contract for SHGAT training operations.
 * Uses PER (Prioritized Experience Replay) for sample selection.
 *
 * Phase 3.1: Execute Handler → Use Cases refactoring
 *
 * @module domain/interfaces/shgat-trainer
 */

import type { ExecutionTraceEvent } from "./code-executor.ts";

/**
 * Training example for SHGAT
 */
export interface SHGATTrainingExample {
  intentEmbedding: number[];
  capabilityId: string;
  toolsUsed: string[];
  success: boolean;
  executionTimeMs: number;
}

/**
 * Result from SHGAT training
 */
export interface SHGATTrainingResult {
  /** Whether training was executed (vs skipped) */
  trained: boolean;
  /** Number of traces processed */
  tracesProcessed: number;
  /** Number of examples generated */
  examplesGenerated: number;
  /** Final loss value */
  loss: number;
  /** Number of TD priorities updated */
  prioritiesUpdated: number;
  /** Whether fallback (in-process) was used instead of subprocess */
  fallback?: boolean;
}

/**
 * Input for training from execution traces
 */
export interface TrainFromTracesInput {
  traces: ExecutionTraceEvent[];
  intentEmbedding?: number[];
  success: boolean;
  executionTimeMs: number;
  capabilityId?: string;
}

/**
 * Configuration for SHGAT training
 */
export interface SHGATTrainingConfig {
  /** Minimum traces required to trigger training */
  minTraces?: number;
  /** Maximum traces per batch */
  maxTraces?: number;
  /** Batch size for training */
  batchSize?: number;
  /** Number of epochs per training run */
  epochs?: number;
}

/**
 * Interface for SHGAT training operations
 *
 * This interface abstracts the SHGAT training subsystem,
 * allowing for different implementations (subprocess, in-process)
 * and easy mocking in tests.
 */
export interface ISHGATTrainer {
  /**
   * Check if training should be triggered
   *
   * Based on trace accumulation threshold and training lock status.
   */
  shouldTrain(): boolean;

  /**
   * Train SHGAT from execution traces
   *
   * Uses PER sampling for efficient learning from high-priority experiences.
   *
   * @param input - Traces and metadata from execution
   * @param config - Optional training configuration
   * @returns Training result with metrics
   */
  train(
    input: TrainFromTracesInput,
    config?: SHGATTrainingConfig,
  ): Promise<SHGATTrainingResult>;

  /**
   * Record execution outcome for Thompson Sampling
   *
   * Updates the Beta distribution for per-tool adaptive thresholds.
   *
   * @param toolId - Tool identifier
   * @param success - Whether execution succeeded
   */
  recordToolOutcome?(toolId: string, success: boolean): void;

  /**
   * Register a new capability in the SHGAT graph
   *
   * Adds nodes without triggering full training.
   *
   * @param capabilityId - Capability ID
   * @param embedding - Capability embedding vector
   * @param toolsUsed - Tools used by this capability
   */
  registerCapability?(
    capabilityId: string,
    embedding: number[],
    toolsUsed: string[],
  ): Promise<void>;
}
