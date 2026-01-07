/**
 * SHGAT Trainer Adapter
 *
 * Adapts existing SHGATLiveTrainer to ISHGATTrainer interface.
 *
 * Phase 3.1: Execute Handler → Use Cases refactoring
 *
 * @module infrastructure/di/adapters/execute/shgat-trainer-adapter
 */

import * as log from "@std/log";
import type {
  ISHGATTrainer,
  SHGATTrainingResult,
  SHGATTrainingConfig,
  TrainFromTracesInput,
} from "../../../../domain/interfaces/shgat-trainer.ts";

/**
 * SHGAT live trainer interface (from existing infrastructure)
 */
export interface SHGATLiveTrainerInfra {
  train(
    traces: Array<{ type: string; tool?: string; success?: boolean }>,
    config?: {
      minTraces?: number;
      maxTraces?: number;
      batchSize?: number;
      epochs?: number;
    },
  ): Promise<{
    trained: boolean;
    tracesProcessed: number;
    examplesGenerated: number;
    loss: number;
    prioritiesUpdated?: number;
    fallback?: boolean;
  }>;

  shouldTrain(): boolean;
}

/**
 * Thompson sampling interface (from existing infrastructure)
 */
export interface ThompsonSamplingInfra {
  recordOutcome(toolId: string, success: boolean): void;
}

/**
 * Dependencies for SHGATTrainerAdapter
 */
export interface SHGATTrainerAdapterDeps {
  liveTrainer?: SHGATLiveTrainerInfra;
  thompsonSampling?: ThompsonSamplingInfra;
}

/**
 * Adapts SHGATLiveTrainer to ISHGATTrainer interface
 */
export class SHGATTrainerAdapter implements ISHGATTrainer {
  constructor(private readonly deps: SHGATTrainerAdapterDeps) {}

  /**
   * Check if training should be triggered
   */
  shouldTrain(): boolean {
    if (!this.deps.liveTrainer) {
      return false;
    }
    return this.deps.liveTrainer.shouldTrain();
  }

  /**
   * Train SHGAT from execution traces
   */
  async train(
    input: TrainFromTracesInput,
    config?: SHGATTrainingConfig,
  ): Promise<SHGATTrainingResult> {
    if (!this.deps.liveTrainer) {
      return {
        trained: false,
        tracesProcessed: 0,
        examplesGenerated: 0,
        loss: 0,
        prioritiesUpdated: 0,
      };
    }

    try {
      const result = await this.deps.liveTrainer.train(input.traces, config);

      return {
        trained: result.trained,
        tracesProcessed: result.tracesProcessed,
        examplesGenerated: result.examplesGenerated,
        loss: result.loss,
        prioritiesUpdated: result.prioritiesUpdated ?? 0,
        fallback: result.fallback,
      };
    } catch (error) {
      log.warn("[SHGATTrainerAdapter] Training failed", { error: String(error) });
      return {
        trained: false,
        tracesProcessed: 0,
        examplesGenerated: 0,
        loss: 0,
        prioritiesUpdated: 0,
      };
    }
  }

  /**
   * Record execution outcome for Thompson Sampling
   */
  recordToolOutcome(toolId: string, success: boolean): void {
    if (this.deps.thompsonSampling) {
      this.deps.thompsonSampling.recordOutcome(toolId, success);
    }
  }

  /**
   * Register a new capability in the SHGAT graph
   *
   * Note: This is a no-op in the adapter as capability registration
   * is handled by the capability store directly.
   */
  async registerCapability(
    _capabilityId: string,
    _embedding: number[],
    _toolsUsed: string[],
  ): Promise<void> {
    // No-op: capability registration handled by capability store
  }
}
