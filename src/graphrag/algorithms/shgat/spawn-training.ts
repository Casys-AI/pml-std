/**
 * Spawn SHGAT Training Subprocess
 *
 * Runs training in a separate Deno process to avoid blocking the main event loop.
 * Worker saves params directly to DB to avoid V8 string length limits (~150MB JSON).
 *
 * @module graphrag/algorithms/shgat/spawn-training
 */

import * as log from "@std/log";
import type { TrainingExample } from "./types.ts";

interface SpawnTrainingInput {
  capabilities: Array<{
    id: string;
    embedding: number[];
    toolsUsed: string[];
    successRate: number;
  }>;
  examples: TrainingExample[];
  epochs?: number;
  batchSize?: number;
  /** Optional: existing SHGAT params for incremental/live training */
  existingParams?: Record<string, unknown>;
  /** Database URL for saving params directly (avoids stdout size limits) */
  databaseUrl?: string;
}

interface SpawnTrainingResult {
  success: boolean;
  finalLoss?: number;
  finalAccuracy?: number;
  params?: Record<string, unknown>;
  /** TD errors for PER priority updates (only if returnTdErrors=true) */
  tdErrors?: number[];
  error?: string;
  /** Whether params were saved to DB by worker */
  savedToDb?: boolean;
}

/**
 * Spawn SHGAT training in a subprocess
 *
 * Worker saves params directly to DB to avoid V8 string length limits
 * with 1024-dim embeddings (~150MB of params).
 *
 * @param input - Training input data
 * @returns Training result with updated params
 */
export async function spawnSHGATTraining(
  input: SpawnTrainingInput,
): Promise<SpawnTrainingResult> {
  const workerPath = new URL("./train-worker.ts", import.meta.url).pathname;

  log.info(`[SHGAT] Spawning training subprocess with ${input.examples.length} examples...`);

  // Get database URL from env or input
  const databaseUrl = input.databaseUrl || Deno.env.get("DATABASE_URL") || Deno.env.get("CAI_DB_PATH");

  const command = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", workerPath],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });

  const process = command.spawn();

  // Send input to worker (with database URL for direct save)
  const encoder = new TextEncoder();
  const inputJson = JSON.stringify({
    capabilities: input.capabilities,
    examples: input.examples,
    config: {
      epochs: input.epochs ?? 5,
      batchSize: input.batchSize ?? 16,
    },
    existingParams: input.existingParams,
    databaseUrl, // Worker saves params directly to DB
  });

  const writer = process.stdin.getWriter();
  await writer.write(encoder.encode(inputJson));
  await writer.close();

  // Collect stdout and stderr manually (process.output() conflicts with getReader())
  const decoder = new TextDecoder();

  // Collect stdout chunks (now just contains status, not params)
  const stdoutChunks: Uint8Array[] = [];
  const stdoutReader = process.stdout.getReader();
  const stdoutPromise = (async () => {
    try {
      while (true) {
        const { done, value } = await stdoutReader.read();
        if (done) break;
        stdoutChunks.push(value);
      }
    } catch {
      // Ignore read errors on close
    }
  })();

  // Stream stderr for progress logs
  const stderrChunks: Uint8Array[] = [];
  const stderrReader = process.stderr.getReader();
  const stderrPromise = (async () => {
    try {
      while (true) {
        const { done, value } = await stderrReader.read();
        if (done) break;
        stderrChunks.push(value);
        const text = decoder.decode(value).trim();
        if (text) log.debug(text);
      }
    } catch {
      // Ignore read errors on close
    }
  })();

  // Wait for both streams to complete
  await Promise.all([stdoutPromise, stderrPromise]);

  // Wait for process to exit
  const status = await process.status;

  if (!status.success) {
    const stderrBytes = new Uint8Array(stderrChunks.reduce((acc, c) => acc + c.length, 0));
    let offset = 0;
    for (const chunk of stderrChunks) {
      stderrBytes.set(chunk, offset);
      offset += chunk.length;
    }
    const stderr = decoder.decode(stderrBytes);

    // Also try to get stdout in case error was printed there
    const stdoutBytesErr = new Uint8Array(stdoutChunks.reduce((acc, c) => acc + c.length, 0));
    let offsetErr = 0;
    for (const chunk of stdoutChunks) {
      stdoutBytesErr.set(chunk, offsetErr);
      offsetErr += chunk.length;
    }
    const stdoutErr = decoder.decode(stdoutBytesErr);

    const errorMsg = stderr || stdoutErr || `Exit code: ${status.code}`;
    log.error(`[SHGAT] Training subprocess failed (code=${status.code}): ${errorMsg}`);
    return {
      success: false,
      error: errorMsg,
    };
  }

  // Parse status from stdout (lightweight - just metrics, params saved to DB)
  const stdoutBytes = new Uint8Array(stdoutChunks.reduce((acc, c) => acc + c.length, 0));
  let offset = 0;
  for (const chunk of stdoutChunks) {
    stdoutBytes.set(chunk, offset);
    offset += chunk.length;
  }
  const stdout = decoder.decode(stdoutBytes).trim();

  try {
    const statusResult = JSON.parse(stdout) as {
      success: boolean;
      finalLoss?: number;
      finalAccuracy?: number;
      tdErrors?: number[];
      error?: string;
      savedToDb?: boolean;
    };

    if (!statusResult.success) {
      return {
        success: false,
        error: statusResult.error ?? "Unknown error",
      };
    }

    log.info(
      `[SHGAT] Training complete: loss=${statusResult.finalLoss?.toFixed(4)}, accuracy=${
        statusResult.finalAccuracy?.toFixed(2)
      }${statusResult.savedToDb ? " (saved to DB)" : ""}`,
    );

    return {
      success: true,
      finalLoss: statusResult.finalLoss,
      finalAccuracy: statusResult.finalAccuracy,
      tdErrors: statusResult.tdErrors,
      savedToDb: statusResult.savedToDb,
      // params not included - they're in the DB
    };
  } catch (e) {
    log.error(`[SHGAT] Failed to parse training result: ${e}`);
    return {
      success: false,
      error: `Failed to parse result: ${stdout}`,
    };
  }
}
