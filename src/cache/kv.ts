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
