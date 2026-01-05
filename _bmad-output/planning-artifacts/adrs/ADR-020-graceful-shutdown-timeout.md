# ADR-020: Graceful Shutdown with Timeout Guard

**Status:** ✅ Implemented **Date:** 2025-12-01 | **Story:** 6.2 (Graph Visualization)

## Problem

The Casys PML gateway server's shutdown handler would hang indefinitely when receiving
SIGINT/SIGTERM signals, requiring force-kill (kill -9).

**Observed behavior:**

```
^C[INFO] Shutting down...
^C[INFO] Shutting down...
^C[INFO] Shutting down...
# Process never exits, hangs forever
```

**Root cause:**

- `Deno.addSignalListener` doesn't properly handle async callbacks
- No guard against multiple concurrent shutdown attempts
- No timeout protection if `gateway.stop()` or `db.close()` hang
- Async shutdown never reaches `Deno.exit(0)`

## Decision

Implement **graceful shutdown with timeout guard**:

1. **Single shutdown guard:** Prevent multiple concurrent shutdowns with `isShuttingDown` flag
2. **Synchronous handler:** Make signal handler synchronous, use Promise handling
3. **Timeout protection:** Force exit after 2 seconds if graceful shutdown hangs
4. **Explicit exit:** Always call `Deno.exit()` with appropriate code

## Implementation

```typescript
// Setup graceful shutdown (ADR-020: Fix hanging shutdown)
let isShuttingDown = false;
const shutdown = () => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  log.info("\n\nShutting down...");
  log.info("Shutting down Casys PML gateway...");

  // Force exit after 2 seconds if graceful shutdown hangs
  const forceExitTimer = setTimeout(() => {
    log.warn("Graceful shutdown timeout - forcing exit");
    Deno.exit(1);
  }, 2000);

  // Attempt graceful shutdown
  Promise.all([
    gateway.stop(),
    db.close(),
  ])
    .then(() => {
      clearTimeout(forceExitTimer);
      log.info("✓ Shutdown complete");
      Deno.exit(0);
    })
    .catch((err) => {
      clearTimeout(forceExitTimer);
      log.error(`Shutdown error: ${err}`);
      Deno.exit(1);
    });
};

Deno.addSignalListener("SIGINT", shutdown);
Deno.addSignalListener("SIGTERM", shutdown);
```

## Benefits

✅ **Clean shutdown:** Server exits properly on Ctrl+C ✅ **No hangs:** 2-second timeout guarantees
process termination ✅ **No duplicates:** Flag prevents multiple concurrent shutdowns ✅ **Proper
cleanup:** Attempts graceful cleanup before forcing exit ✅ **Clear logging:** User sees shutdown
progress and completion

## Trade-offs

⚠️ **Hard timeout:** Forces exit after 2s even if cleanup incomplete → Acceptable: prevents
indefinite hangs, 2s is sufficient for cleanup

⚠️ **Exit code 1 on timeout:** Timeout treated as error condition → Acceptable: indicates abnormal
shutdown, useful for monitoring

## Testing

Manual test:

```bash
# Start server
deno run --allow-all src/main.ts serve --port 3001 --config playground/config/mcp-servers.json

# Press Ctrl+C once
^C
[INFO] Shutting down...
[INFO] Shutting down Casys PML gateway...
[INFO] ✓ Shutdown complete
# Process exits cleanly
```

## Related

- **File:** `src/cli/commands/serve.ts:281-314`
- **Pattern:** Also used in `playground/server.ts`, `public/examples/events-client.ts`
- **Alternative:** Could use `AbortController` for more granular cleanup control
