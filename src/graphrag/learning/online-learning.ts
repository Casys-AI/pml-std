/**
 * Online Learning - Real-time SHGAT training from execution events
 *
 * Listens to execution.trace.saved events and triggers immediate training
 * using the V1 K-head architecture. This enables continuous learning
 * from user feedback without explicit training epochs.
 *
 * @module graphrag/learning/online-learning
 */

import { eventBus } from "../../events/mod.ts";
import type { SHGAT } from "../algorithms/shgat.ts";
import { trainSHGATOnExecution } from "../algorithms/shgat.ts";
import type { ExecutionTraceStore } from "../../capabilities/execution-trace-store.ts";
import { getLogger } from "../../telemetry/logger.ts";

const log = getLogger("default");

/**
 * Configuration for online learning
 */
export interface OnlineLearningConfig {
  /** Minimum gradient norm to log training (default: 0.01) */
  minGradNormLog?: number;
  /** Whether to log each training event (default: false) */
  verbose?: boolean;
}

/**
 * Online learning controller
 *
 * Manages the event subscription for real-time SHGAT training.
 */
export class OnlineLearningController {
  private unsubscribe?: () => void;
  private trainingCount = 0;
  private totalLoss = 0;

  constructor(
    private shgat: SHGAT,
    private traceStore: ExecutionTraceStore,
    private config: OnlineLearningConfig = {},
  ) {}

  /**
   * Start listening for execution events and training
   *
   * @example
   * ```typescript
   * const controller = new OnlineLearningController(shgat, traceStore);
   * controller.start();
   *
   * // Later, when shutting down:
   * controller.stop();
   * console.log(controller.getStats());
   * ```
   */
  start(): void {
    if (this.unsubscribe) {
      log.warn("[OnlineLearning] Already started, ignoring duplicate start()");
      return;
    }

    log.info("[OnlineLearning] Starting real-time training listener");

    this.unsubscribe = eventBus.on("execution.trace.saved", async (event) => {
      const payload = event.payload as {
        trace_id: string;
        capability_id: string | null;
        success: boolean;
      };

      // Skip if no capability (can't train without target)
      if (!payload.capability_id) {
        if (this.config.verbose) {
          log.debug("[OnlineLearning] Skipping trace without capability", {
            traceId: payload.trace_id,
          });
        }
        return;
      }

      // Fetch trace from DB to get intent_embedding
      const trace = await this.traceStore.getTraceById(payload.trace_id);
      if (!trace?.intentEmbedding) {
        if (this.config.verbose) {
          log.debug("[OnlineLearning] Skipping trace without intent embedding", {
            traceId: payload.trace_id,
          });
        }
        return;
      }

      try {
        const result = await trainSHGATOnExecution(this.shgat, {
          intentEmbedding: trace.intentEmbedding,
          targetCapId: payload.capability_id,
          outcome: payload.success ? 1 : 0,
        });

        this.trainingCount++;
        this.totalLoss += result.loss;

        const minGradNorm = this.config.minGradNormLog ?? 0.01;
        if (this.config.verbose || result.gradNorm > minGradNorm) {
          log.info("[OnlineLearning] Trained on execution", {
            traceId: payload.trace_id,
            capabilityId: payload.capability_id,
            success: payload.success,
            loss: result.loss.toFixed(4),
            gradNorm: result.gradNorm.toFixed(4),
            totalTrainings: this.trainingCount,
          });
        }

        // Emit training event for observability
        eventBus.emit({
          type: "learning.online.trained",
          source: "online-learning",
          payload: {
            trace_id: payload.trace_id,
            capability_id: payload.capability_id,
            loss: result.loss,
            grad_norm: result.gradNorm,
            training_count: this.trainingCount,
          },
        });
      } catch (error) {
        log.error("[OnlineLearning] Training failed", {
          traceId: payload.trace_id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  /**
   * Stop listening for events
   */
  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
      log.info("[OnlineLearning] Stopped", this.getStats());
    }
  }

  /**
   * Get training statistics
   */
  getStats(): { trainingCount: number; avgLoss: number } {
    return {
      trainingCount: this.trainingCount,
      avgLoss: this.trainingCount > 0 ? this.totalLoss / this.trainingCount : 0,
    };
  }

  /**
   * Check if controller is active
   */
  isActive(): boolean {
    return !!this.unsubscribe;
  }
}

/**
 * Convenience function to start online learning
 *
 * @param shgat - SHGAT instance to train
 * @param traceStore - ExecutionTraceStore to fetch traces
 * @param config - Optional configuration
 * @returns Controller to manage the listener
 *
 * @example
 * ```typescript
 * import { startOnlineLearning } from "./online-learning.ts";
 *
 * // In your app initialization:
 * const controller = startOnlineLearning(shgat, traceStore, { verbose: true });
 *
 * // On shutdown:
 * controller.stop();
 * ```
 */
export function startOnlineLearning(
  shgat: SHGAT,
  traceStore: ExecutionTraceStore,
  config?: OnlineLearningConfig,
): OnlineLearningController {
  const controller = new OnlineLearningController(shgat, traceStore, config);
  controller.start();
  return controller;
}
