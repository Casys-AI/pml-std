/**
 * SHGAT Training Worker
 *
 * Runs in a subprocess to avoid blocking the main event loop.
 * Receives training data via stdin, outputs results via stdout.
 * Saves params directly to DB to avoid V8 string length limits (~150MB JSON).
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
 *   databaseUrl: process.env.DATABASE_URL,
 * });
 * ```
 *
 * @module graphrag/algorithms/shgat/train-worker
 */

import { createSHGATFromCapabilities, type TrainingExample } from "../shgat.ts";
import { random } from "./initialization/parameters.ts";
import postgres from "postgres";

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
  /** Database URL for saving params directly (avoids stdout size limits) */
  databaseUrl?: string;
}

interface WorkerOutput {
  success: boolean;
  finalLoss?: number;
  finalAccuracy?: number;
  /** TD errors for PER priority updates */
  tdErrors?: number[];
  error?: string;
  /** Whether params were saved to DB */
  savedToDb?: boolean;
}

/**
 * Save SHGAT params directly to PostgreSQL database.
 */
async function saveParamsToDb(
  databaseUrl: string,
  params: Record<string, unknown>,
): Promise<boolean> {
  const sql = postgres(databaseUrl, {
    max: 1, // Single connection for worker
    idle_timeout: 30,
    connect_timeout: 30,
  });

  try {
    // Use $1::jsonb cast with raw object - postgres.js auto-serializes to JSONB
    await sql`
      INSERT INTO shgat_params (user_id, params, updated_at)
      VALUES ('local', ${params}::jsonb, NOW())
      ON CONFLICT (user_id) DO UPDATE SET
        params = ${params}::jsonb,
        updated_at = NOW()
    `;

    return true;
  } finally {
    await sql.end();
  }
}

async function main() {
  // Read input from stdin
  const decoder = new TextDecoder();
  const chunks: Uint8Array[] = [];

  for await (const chunk of Deno.stdin.readable) {
    chunks.push(chunk);
  }

  // Concatenate chunks efficiently without intermediate array explosion
  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  const inputJson = decoder.decode(combined);
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
    const totalBatches = Math.ceil(input.examples.length / batchSize);
    console.error(
      `[SHGAT Worker] Starting training: ${input.examples.length} examples, ${epochs} epochs, ` +
      `batch_size=${batchSize}, ${totalBatches} batches/epoch, ${input.capabilities.length} capabilities`
    );

    let finalLoss = 0;
    let finalAccuracy = 0;
    let lastEpochTdErrors: number[] = [];

    for (let epoch = 0; epoch < epochs; epoch++) {
      // Shuffle examples each epoch
      const shuffled = [...input.examples].sort(() => random() - 0.5);

      let epochLoss = 0;
      let epochAccuracy = 0;
      let epochBatches = 0;
      const epochTdErrors: number[] = [];

      const totalBatches = Math.ceil(shuffled.length / batchSize);
      const progressInterval = Math.max(1, Math.floor(totalBatches / 10)); // Log ~10 times per epoch

      for (let i = 0; i < shuffled.length; i += batchSize) {
        const batch = shuffled.slice(i, i + batchSize);
        // Use trainBatchV1KHead (uses levelParams + headParams)
        // NOT trainBatch which uses deprecated layerParams
        const result = shgat.trainBatchV1KHead(batch);
        epochLoss += result.loss;
        epochAccuracy += result.accuracy;
        epochTdErrors.push(...result.tdErrors);
        epochBatches++;

        // Progress log every ~10% of batches
        if (epochBatches % progressInterval === 0 || epochBatches === totalBatches) {
          const pct = Math.round((epochBatches / totalBatches) * 100);
          const avgLoss = epochLoss / epochBatches;
          const avgAcc = epochAccuracy / epochBatches;
          console.error(
            `[SHGAT Worker] Epoch ${epoch} progress: ${pct}% (${epochBatches}/${totalBatches} batches, loss=${avgLoss.toFixed(4)}, acc=${avgAcc.toFixed(2)})`
          );
        }
      }

      finalLoss = epochLoss / epochBatches;
      finalAccuracy = epochAccuracy / epochBatches;
      lastEpochTdErrors = epochTdErrors;

      console.error(
        `[SHGAT Worker] Epoch ${epoch}: loss=${finalLoss.toFixed(4)}, acc=${
          finalAccuracy.toFixed(2)
        }`,
      );
    }

    // Save params directly to DB if URL provided
    let savedToDb = false;
    if (input.databaseUrl) {
      try {
        console.error(`[SHGAT Worker] Exporting params...`);
        const params = shgat.exportParams();
        console.error(`[SHGAT Worker] Params exported, keys: ${Object.keys(params).join(", ")}`);
        savedToDb = await saveParamsToDb(input.databaseUrl, params);
        console.error(`[SHGAT Worker] Params saved to DB`);
      } catch (e) {
        console.error(`[SHGAT Worker] Failed to save params to DB: ${e}`);
        // Continue - training still succeeded, params just couldn't be saved
      }
    } else {
      console.error(`[SHGAT Worker] No databaseUrl provided, skipping DB save`);
    }

    // Output lightweight status to stdout (no params - they're in the DB)
    const output: WorkerOutput = {
      success: true,
      finalLoss,
      finalAccuracy,
      tdErrors: lastEpochTdErrors,
      savedToDb,
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
