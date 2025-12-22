/**
 * Shared Deno KV instance for auth operations
 *
 * Re-exports from src/cache/kv.ts for backwards compatibility.
 * Story 11.0: KV singleton moved to shared location.
 *
 * @module server/auth/kv
 */

export { closeKv, getKv } from "../../cache/kv.ts";
