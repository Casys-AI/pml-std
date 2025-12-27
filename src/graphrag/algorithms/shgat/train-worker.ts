/**
 * SHGAT Training Worker
 *
 * Runs in a subprocess to avoid blocking the main event loop.
 * Receives training data via stdin, outputs results via stdout.
 *
 * Used for both:
 * - Startup batch training (epochs=3-5, many traces)
 * - Live/PER training (epochs=1, few traces)
 *
 * Usage:
 * ```typescript
 * const result = await spawnSHGATTraining({
 *   capabilities,
 *   examples,
 *   epochs: 1,      // 1 for live, 3-5 for batch
 *   batchSize: 16,
 * });
 * ```
 *
 * @module graphrag/algorithms/shgat/train-worker
 */

import { createSHGATFromCapabilities, type TrainingExample } from "../shgat.ts";

interface WorkerInput {
  capabilities: Array<{
    id: string;
    embedding: number[];
    toolsUsed: string[];
    successRate: number;
  }>;
  examples: TrainingExample[];
  config: {
    epochs: number;
    batchSize: number;
  };
  /** Optional: import existing params before training (for live updates) */
  existingParams?: Record<string, unknown>;
}

interface WorkerOutput {
  success: boolean;
  finalLoss?: number;
  finalAccuracy?: number;
  params?: Record<string, unknown>;
  /** TD errors for PER priority updates (only if returnTdErrors=true) */
  tdErrors?: number[];
  error?: string;
}

async function main() {
  // Read input from stdin
  const decoder = new TextDecoder();
  const chunks: Uint8Array[] = [];

  for await (const chunk of Deno.stdin.readable) {
    chunks.push(chunk);
  }

  const inputJson = decoder.decode(new Uint8Array(chunks.flatMap((c) => [...c])));
  const input: WorkerInput = JSON.parse(inputJson);

  try {
    // Create SHGAT from capabilities
    const shgat = createSHGATFromCapabilities(input.capabilities);

    // Import existing params for incremental training (live/PER mode)
    if (input.existingParams) {
      shgat.importParams(input.existingParams);
    }

    // Train with PER: multiple epochs, collect TD errors from last epoch for priority updates
    const { epochs, batchSize } = input.config;
    let finalLoss = 0;
    let finalAccuracy = 0;
    let lastEpochTdErrors: number[] = [];

    for (let epoch = 0; epoch < epochs; epoch++) {
      // Shuffle examples each epoch
      const shuffled = [...input.examples].sort(() => Math.random() - 0.5);

      let epochLoss = 0;
      let epochAccuracy = 0;
      let epochBatches = 0;
      const epochTdErrors: number[] = [];

      for (let i = 0; i < shuffled.length; i += batchSize) {
        const batch = shuffled.slice(i, i + batchSize);
        const result = shgat.trainBatch(batch);
        epochLoss += result.loss;
        epochAccuracy += result.accuracy;
        epochTdErrors.push(...result.tdErrors);
        epochBatches++;
      }

      finalLoss = epochLoss / epochBatches;
      finalAccuracy = epochAccuracy / epochBatches;
      lastEpochTdErrors = epochTdErrors;

      console.error(
        `[SHGAT Worker] Epoch ${epoch}: loss=${finalLoss.toFixed(4)}, acc=${finalAccuracy.toFixed(2)}`,
      );
    }

    // Output result to stdout
    // Return TD errors from last epoch for PER priority updates
    const output: WorkerOutput = {
      success: true,
      finalLoss,
      finalAccuracy,
      params: shgat.exportParams(),
      tdErrors: lastEpochTdErrors,
    };

    console.log(JSON.stringify(output));
  } catch (error) {
    const output: WorkerOutput = {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
    console.log(JSON.stringify(output));
    Deno.exit(1);
  }
}

main();
