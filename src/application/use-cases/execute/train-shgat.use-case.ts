/**
 * Train SHGAT Use Case
 *
 * Triggers SHGAT training from execution traces.
 * Uses PER (Prioritized Experience Replay) for sample selection.
 *
 * Phase 3.1: Execute Handler → Use Cases refactoring
 *
 * @module application/use-cases/execute/train-shgat
 */

import * as log from "@std/log";
import type { ISHGATTrainer, SHGATTrainingConfig } from "../../../domain/interfaces/shgat-trainer.ts";
import type { UseCaseResult } from "../shared/types.ts";
import type { TrainSHGATRequest, TrainSHGATResult } from "./types.ts";
import type { TraceTaskResult } from "../../../capabilities/types/mod.ts";

// ============================================================================
// Interfaces (Clean Architecture - no concrete imports)
// ============================================================================

/**
 * Adaptive threshold manager interface
 */
export interface IAdaptiveThresholdManager {
  recordToolOutcome(toolId: string, success: boolean): void;
}

/**
 * Dependencies for TrainSHGATUseCase
 */
export interface TrainSHGATDependencies {
  shgatTrainer?: ISHGATTrainer;
  thresholdManager?: IAdaptiveThresholdManager;
  /** Callback after successful training */
  onTrainingComplete?: () => Promise<void>;
}

// ============================================================================
// Use Case Implementation
// ============================================================================

/**
 * Train SHGAT Use Case
 *
 * Triggers background SHGAT training and updates Thompson Sampling.
 */
export class TrainSHGATUseCase {
  constructor(private readonly deps: TrainSHGATDependencies) {}

  /**
   * Execute the use case
   */
  async execute(
    request: TrainSHGATRequest,
  ): Promise<UseCaseResult<TrainSHGATResult>> {
    const { taskResults, success, executionTimeMs, intentEmbedding, capabilityId } = request;

    // Update Thompson Sampling with tool outcomes
    this.updateThompsonSampling(taskResults);

    // Check if SHGAT training is available and should run
    if (!this.deps.shgatTrainer) {
      return {
        success: true,
        data: {
          trained: false,
          tracesProcessed: 0,
          examplesGenerated: 0,
          loss: 0,
        },
      };
    }

    if (!this.deps.shgatTrainer.shouldTrain()) {
      log.debug("[TrainSHGATUseCase] Training skipped (threshold not met or lock held)");
      return {
        success: true,
        data: {
          trained: false,
          tracesProcessed: 0,
          examplesGenerated: 0,
          loss: 0,
        },
      };
    }

    try {
      // Extract traces from task results
      const traces = taskResults.map((t) => ({
        type: t.success ? "tool_end" as const : "error" as const,
        tool: t.tool,
        success: t.success,
        timestamp: Date.now(),
      }));

      // Run training
      const config: SHGATTrainingConfig = {
        minTraces: 1,
        maxTraces: 50,
        batchSize: 16,
        epochs: 1, // Live mode: single epoch
      };

      const result = await this.deps.shgatTrainer.train(
        {
          traces,
          intentEmbedding,
          success,
          executionTimeMs,
          capabilityId,
        },
        config,
      );

      if (result.trained && result.tracesProcessed > 0) {
        log.debug("[TrainSHGATUseCase] Training completed", {
          traces: result.tracesProcessed,
          examples: result.examplesGenerated,
          loss: result.loss.toFixed(4),
        });

        // Callback after successful training (e.g., save params)
        if (this.deps.onTrainingComplete) {
          await this.deps.onTrainingComplete();
        }
      }

      return {
        success: true,
        data: {
          trained: result.trained,
          tracesProcessed: result.tracesProcessed,
          examplesGenerated: result.examplesGenerated,
          loss: result.loss,
        },
      };
    } catch (error) {
      log.warn("[TrainSHGATUseCase] Training failed", { error: String(error) });
      return {
        success: false,
        error: {
          code: "TRAINING_FAILED",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  /**
   * Update Thompson Sampling with execution outcomes
   */
  private updateThompsonSampling(taskResults: TraceTaskResult[]): void {
    if (!this.deps.thresholdManager) {
      return;
    }

    let updated = 0;
    for (const result of taskResults) {
      if (result.tool && result.tool !== "unknown") {
        this.deps.thresholdManager.recordToolOutcome(result.tool, result.success);
        updated++;
      }
    }

    log.debug("[TrainSHGATUseCase] Thompson Sampling updated", {
      toolsUpdated: updated,
      totalResults: taskResults.length,
    });
  }
}
