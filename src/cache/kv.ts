/**
 * Shared Deno KV singleton for all application modules
 *
 * Uses a lazy singleton pattern to avoid connection leaks.
 * All modules needing KV (auth, workflow state, cache) should use getKv().
 *
 * Story 11.0: Moved from src/server/auth/kv.ts for shared access.
 *
 * @module cache/kv
 */

let _kv: Deno.Kv | null = null;

/**
 * Get shared Deno KV instance (singleton)
 * Lazily initialized on first call.
 *
 * @returns Shared Deno KV instance
 */
export async function getKv(): Promise<Deno.Kv> {
  if (!_kv) {
    _kv = await Deno.openKv();
  }
  return _kv;
}

/**
 * Close KV connection (for graceful shutdown/tests)
 */
export async function closeKv(): Promise<void> {
  if (_kv) {
    _kv.close();
    _kv = null;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// CROSS-PROCESS EVENT SIGNALING (Story 7.6+)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * KV key for cross-process event signals
 * Using a counter that increments on each event for reliable change detection
 */
const EVENT_SIGNAL_KEY = ["pml", "events", "signal"];

/**
 * Signal an event across processes via KV
 * Called by algorithm-tracer when new traces are logged.
 *
 * @param eventType - Type of event (e.g., "algorithm.scored")
 * @param payload - Minimal payload for the signal (full data is in DB)
 */
export async function signalEvent(
  eventType: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  const kv = await getKv();
  const signal = {
    type: eventType,
    timestamp: Date.now(),
    payload,
  };
  // Use versionstamp for atomic update detection
  await kv.set(EVENT_SIGNAL_KEY, signal);
}

/**
 * Watch for cross-process event signals
 * Returns an async iterator that yields events when they occur.
 *
 * @returns AsyncGenerator that yields event signals
 */
export async function* watchEvents(): AsyncGenerator<{
  type: string;
  timestamp: number;
  payload: Record<string, unknown>;
}> {
  const kv = await getKv();
  const stream = kv.watch([EVENT_SIGNAL_KEY]);

  for await (const entries of stream) {
    const entry = entries[0];
    if (entry.value && entry.versionstamp) {
      yield entry.value as {
        type: string;
        timestamp: number;
        payload: Record<string, unknown>;
      };
    }
  }
}
