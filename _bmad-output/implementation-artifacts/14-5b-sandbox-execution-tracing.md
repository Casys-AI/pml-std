# Story 14.5b: Sandbox Execution Tracing

Status: completed

> **Epic:** 14 - JSR Package Local/Cloud MCP Routing
> **FR Coverage:** FR14-5b (Execution tracing for sandboxed capability code)
> **Prerequisites:** Story 14.5 (Sandboxed Execution - DONE), Story 11.2 (Execution Trace Table)
> **Previous Story:** 14-5-sandboxed-local-mcp-execution.md

## Story

As a platform operator,
I want sandboxed capability executions to generate execution traces,
So that the learning system (TD-Error + PER + SHGAT) can improve from local executions.

## Architecture: Package Independence

> **CRITICAL:** `packages/pml` is a standalone JSR package (`jsr:@casys/pml`).
> It CANNOT import from `src/*` - that's server-side code unavailable to package users.

```
┌─────────────────────────────────────┐
│  packages/pml (JSR standalone)      │
│  ────────────────────────────       │
│  TraceCollector    ← NEW (this story)
│  TraceSyncer       ← NEW (this story)
│  LocalExecutionTrace ← NEW type     │
│  sanitizer.ts      ← NEW            │
└─────────────────────────────────────┘
        │ HTTP POST /api/traces
        ▼
┌─────────────────────────────────────┐
│  src/ (Server - REUSES existing)    │
│  ────────────────────────────       │
│  ExecutionTraceStore.saveTrace()    │
│  Types: ExecutionTrace (Story 11.2) │
│  Learning: TD-Error + PER (11.3)    │
└─────────────────────────────────────┘
```

**Type Alignment (NOT import):** `LocalExecutionTrace` must serialize to JSON compatible with server's `ExecutionTrace` schema (migration 020).

## Problem Context

### Current State (After Story 14.5)

| Component | Status | Description |
|-----------|--------|-------------|
| SandboxWorker | ✅ DONE | Executes capability code in isolated Worker |
| SandboxResult | ✅ DONE | Returns success/error/durationMs |
| RPC Bridge | ✅ DONE | Routes mcp.* calls to main thread |
| **Execution Tracing** | ❌ MISSING | No traces sent to learning system |

### Why Trace Sandbox Executions?

Without tracing, the learning system (Epic 11) cannot learn from:
- Local capability executions (most common case)
- User patterns and preferences
- Tool usage sequences
- Success/failure outcomes

**With tracing:**
- TD-Error can compute temporal difference for learning
- PER can prioritize surprising/novel executions
- SHGAT can update tool relationship weights

### Trace Data Flow (Cloud Sync)

```
┌─────────────────────────────────────┐
│  packages/pml (Local)               │
│  SandboxWorker.execute()            │
│  TraceCollector.finalize()          │
└─────────────────────────────────────┘
        │ trace data (async, batched)
        ▼
   POST /api/traces
        │
        ▼
┌─────────────────────────────────────┐
│  pml.casys.ai (Server)              │
│  ExecutionTraceStore.saveTrace()    │
│  TD-Error + PER + SHGAT learning    │
└─────────────────────────────────────┘
```

**Standalone mode:** When `cloudUrl` is null, traces are logged locally (debug level) - no sync.
**Future (14.5c):** Local PGlite storage + offline sync if needed.

## Acceptance Criteria

### AC1-2: Trace Generation from Sandbox

**Given** capability code executing in sandbox
**When** execution completes (success or failure)
**Then** a trace record is generated with:
  - `capabilityId`: FQDN of executed capability
  - `durationMs`: from SandboxResult
  - `success`: boolean outcome
  - `taskResults`: array of mcp.* call results
  - `decisions`: branch decisions (if any)

**Given** capability code makes mcp.* calls
**When** each call completes
**Then** the call is recorded in `taskResults`:
  - `toolId`: "namespace:action"
  - `args`: (sanitized) input arguments
  - `result`: (sanitized) output
  - `durationMs`: call duration
  - `success`: boolean

### AC3-4: Async Cloud Sync

**Given** trace generated from sandbox execution
**When** cloud URL is configured
**Then** trace is sent to `POST /api/traces` asynchronously
**And** execution does NOT wait for sync to complete
**And** failed syncs are queued for retry

**Given** no cloud URL configured (standalone mode)
**When** trace is generated
**Then** trace is logged locally (debug level)
**And** no network request is made

### AC5-6: Sanitization

**Given** trace contains sensitive data (API keys, passwords)
**When** trace is generated
**Then** sensitive fields are redacted before storage/sync
**And** PII patterns are detected and masked

**Given** trace contains large payloads (>10KB)
**When** trace is generated
**Then** payloads are truncated with "[TRUNCATED]" marker
**And** original size is recorded in metadata

### AC7-8: Performance

**Given** sandbox execution with tracing enabled
**When** compared to execution without tracing
**Then** overhead is less than 10ms per execution
**And** memory usage increase is less than 1MB per trace

**Given** multiple rapid sandbox executions
**When** traces are batched for sync
**Then** batch size is configurable (default: 10 traces)
**And** batch interval is configurable (default: 5 seconds)

## Tasks / Subtasks

### Phase 1: Trace Collector (~1h)

- [x] Task 1: Create TraceCollector class
  - [x] Create `packages/pml/src/tracing/collector.ts`
  - [x] Implement trace accumulation during execution
  - [x] Wire into SandboxWorker RPC handling (via CapabilityLoader)

- [x] Task 2: Create tracing types (ALIGNED with server schema)
  - [x] Create `packages/pml/src/tracing/types.ts`
  - [x] Define `LocalExecutionTrace`, `TraceTaskResult`, `TraceSyncConfig`
  - [x] **ALIGNED** field names with server's `ExecutionTrace`
  - [x] Export from `packages/pml/src/tracing/mod.ts`

### Phase 2: Sanitization (~45m)

- [x] Task 3: Implement trace sanitizer
  - [x] Create `packages/pml/src/tracing/sanitizer.ts`
  - [x] Sanitize sensitive patterns (API keys, passwords, tokens)
  - [x] Truncate large payloads (>10KB)
  - [x] Mask PII (emails, phone numbers, SSN, credit cards)

- [x] Task 4: Add sanitization tests
  - [x] Test API key detection and masking (19 tests)
  - [x] Test payload truncation
  - [x] Test PII masking

### Phase 3: Cloud Sync (~1h)

- [x] Task 5: Implement TraceSyncer
  - [x] Create `packages/pml/src/tracing/syncer.ts`
  - [x] Implement async batch sync to cloud
  - [x] Configure batch size and interval
  - [x] Handle offline/retry with configurable maxRetries

- [x] Task 6: Add cloud API endpoint (SERVER-SIDE, reuses existing)
  - [x] Create `src/api/traces.ts` on server side
  - [x] Accept batch of traces from packages/pml clients
  - [x] Map `LocalExecutionTrace` → `ExecutionTrace` (field names aligned)
  - [x] Store via existing `ExecutionTraceStore.saveTrace()`
  - [x] Learning happens automatically via existing TD-Error + PER (Story 11.3)

### Phase 4: Integration (~45m)

- [x] Task 7: Integrate with CapabilityLoader
  - [x] Modified `packages/pml/src/loader/capability-loader.ts`
  - [x] Create TraceCollector per execution in executeInSandbox()
  - [x] Record mcp.* calls in onRpc handler
  - [x] Finalize and sync trace on completion

- [x] Task 8: Add tracing config to CapabilityLoader
  - [x] Add `tracingEnabled` option (default: true)
  - [x] Add `tracingConfig` for batch settings
  - [x] Wire TraceSyncer into loader with shutdown handling

### Phase 5: Tests (~1h)

- [x] Task 9: Unit tests for TraceCollector (17 tests)
  - [x] Test recording mcp.* calls
  - [x] Test trace finalization
  - [x] Test sanitization integration

- [x] Task 10: Unit tests for TraceSyncer (12 tests)
  - [x] Test batching behavior
  - [x] Test offline queueing
  - [x] Test standalone mode

- [x] Task 11: Integration tests
  - [x] Test standalone mode (no cloud) - covered in syncer tests
  - [x] 48 total tests passing

## Dev Notes

### TraceCollector Design

```typescript
// packages/pml/src/tracing/collector.ts

import type { TraceTaskResult, LocalExecutionTrace } from "./types.ts";
import { sanitizeTrace } from "./sanitizer.ts";

export class TraceCollector {
  private taskResults: TraceTaskResult[] = [];
  private startTime: number;

  constructor() {
    this.startTime = Date.now();
  }

  /**
   * Record an mcp.* call result.
   */
  recordMcpCall(
    toolId: string,
    args: unknown,
    result: unknown,
    durationMs: number,
    success: boolean,
  ): void {
    this.taskResults.push({
      toolId,
      args,
      result,
      durationMs,
      success,
      timestamp: Date.now(),
    });
  }

  /**
   * Finalize the trace after execution completes.
   */
  finalize(
    capabilityId: string,
    success: boolean,
    error?: string,
  ): LocalExecutionTrace {
    const trace: LocalExecutionTrace = {
      capabilityId,
      success,
      error,
      durationMs: Date.now() - this.startTime,
      taskResults: this.taskResults,
      timestamp: new Date().toISOString(),
    };

    return sanitizeTrace(trace);
  }
}
```

### Integration with SandboxWorker

```typescript
// In SandboxWorker.execute()

async execute(code: string, args: unknown): Promise<SandboxResult> {
  const collector = new TraceCollector();

  // Wrap RPC handler to record calls
  const tracingRpcHandler = async (method: string, rpcArgs: unknown) => {
    const start = Date.now();
    try {
      const result = await this.onRpc(method, rpcArgs);
      collector.recordMcpCall(method, rpcArgs, result, Date.now() - start, true);
      return result;
    } catch (error) {
      collector.recordMcpCall(method, rpcArgs, error, Date.now() - start, false);
      throw error;
    }
  };

  // ... execute in sandbox with tracingRpcHandler ...

  // Finalize and sync trace
  const trace = collector.finalize(capabilityId, result.success, result.error?.message);
  this.traceSyncer?.enqueue(trace);

  return result;
}
```

### TraceSyncer Batching

```typescript
// packages/pml/src/tracing/syncer.ts

export interface TraceSyncConfig {
  /** Cloud URL for sync (null = standalone mode) */
  cloudUrl: string | null;
  /** Max traces per batch */
  batchSize: number;  // default: 10
  /** Flush interval in ms */
  flushIntervalMs: number;  // default: 5000
  /** Max retries for failed sync */
  maxRetries: number;  // default: 3
}

export class TraceSyncer {
  private queue: LocalExecutionTrace[] = [];
  private timer: number | null = null;

  constructor(private config: TraceSyncConfig) {
    if (config.cloudUrl) {
      this.startFlushTimer();
    }
  }

  enqueue(trace: LocalExecutionTrace): void {
    this.queue.push(trace);

    if (this.queue.length >= this.config.batchSize) {
      this.flush();
    }
  }

  async flush(): Promise<void> {
    if (!this.config.cloudUrl || this.queue.length === 0) return;

    const batch = this.queue.splice(0, this.config.batchSize);

    try {
      await fetch(`${this.config.cloudUrl}/api/traces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ traces: batch }),
      });
    } catch (error) {
      // Re-queue for retry
      this.queue.unshift(...batch);
      logDebug(`Trace sync failed, will retry: ${error}`);
    }
  }
}
```

### Server-Side API

```typescript
// src/api/traces.ts

import { ExecutionTraceStore } from "../capabilities/execution-trace-store.ts";
import { CapabilityRegistry } from "../capabilities/capability-registry.ts";
import { isValidFQDN, parseFQDN } from "../capabilities/fqdn.ts";

/**
 * Resolve FQDN → workflowPatternId (UUID) for FK storage.
 * Client sends FQDN like "local.default.fs.read_file.a7f3"
 * Server stores with capability_id FK to workflow_pattern.pattern_id
 */
async function resolveCapabilityId(capabilityId: string, db: DbClient): Promise<string | null> {
  // 1. If already UUID, return as-is
  if (isUUID(capabilityId)) return capabilityId;

  // 2. If valid FQDN (5 parts), lookup by components
  if (isValidFQDN(capabilityId)) {
    const { org, project, namespace, action, hash } = parseFQDN(capabilityId);
    const registry = new CapabilityRegistry(db);
    const record = await registry.getByFqdnComponents(org, project, namespace, action, hash);
    return record?.workflowPatternId ?? null;
  }

  // 3. Not found → standalone trace
  return null;
}

export async function handleTracesBatch(req: Request, ctx: RouteContext): Promise<Response> {
  const { traces } = await req.json();

  for (const trace of traces) {
    // Resolve FQDN → UUID before storage
    const resolvedCapabilityId = await resolveCapabilityId(trace.capabilityId, ctx.db);

    await traceStore.save({
      capabilityId: resolvedCapabilityId,  // UUID or null
      success: trace.success,
      durationMs: trace.durationMs,
      taskResults: trace.taskResults,
      // ... map other fields
    });
  }

  return new Response(JSON.stringify({ received: traces.length }));
}
```

### FQDN Resolution Flow

```
Client (packages/pml):
  TraceCollector.finalize(meta.fqdn)
  → capabilityId: "local.default.fs.read_file.a7f3"  (FQDN)

Server (src/api/traces.ts):
  resolveCapabilityId("local.default.fs.read_file.a7f3")
  → parseFQDN() → { org, project, namespace, action, hash }
  → CapabilityRegistry.getByFqdnComponents()
  → workflowPatternId: "550e8400-e29b-41d4-a716-446655440000"  (UUID)

Database:
  execution_trace.capability_id = UUID  → FK → workflow_pattern.pattern_id ✓
```

**Benefits:**
- Client API stays clean (just FQDN)
- FQDN can be renamed without breaking traces
- Server handles internal UUID mapping
- Proper FK linkage for learning system

### Project Structure

```
packages/pml/src/tracing/
├── mod.ts              # Exports
├── types.ts            # LocalExecutionTrace, TraceTaskResult
├── collector.ts        # TraceCollector class
├── sanitizer.ts        # Trace sanitization
└── syncer.ts           # TraceSyncer (batch sync to cloud)

packages/pml/tests/
├── trace_collector_test.ts
├── trace_sanitizer_test.ts
└── trace_syncer_test.ts
```

### Server Schema Reference (for type alignment)

> **DO NOT IMPORT** - just align field names for JSON serialization compatibility.

**Server-side ExecutionTrace type:** [Source: src/capabilities/types/execution.ts]
```typescript
// Server's ExecutionTrace - align LocalExecutionTrace fields with this
interface ExecutionTrace {
  id: string;                    // Server generates UUID
  capabilityId: string;          // → LocalExecutionTrace.capabilityId
  success: boolean;              // → LocalExecutionTrace.success
  durationMs: number;            // → LocalExecutionTrace.durationMs
  taskResults: TraceTaskResult[]; // → LocalExecutionTrace.taskResults
  decisions: BranchDecision[];   // → LocalExecutionTrace.decisions (optional)
  priority: number;              // Server computes via TD-Error
  createdAt: string;             // Server generates
}
```

**Server-side TraceTaskResult:** [Source: src/capabilities/types/execution.ts]
```typescript
interface TraceTaskResult {
  taskId: string;      // Unique ID for this task
  tool: string;        // "namespace:action" format
  args: JsonValue;     // Sanitized input
  result: JsonValue;   // Sanitized output
  durationMs: number;
  success: boolean;
}
```

**Database schema:** [Source: src/db/migrations/020_execution_trace.ts]
- Table: `execution_trace`
- JSONB columns: `task_results`, `decisions`
- FK: `capability_id` → `workflow_pattern.pattern_id`

**Server handler reuses:** [Source: src/capabilities/execution-trace-store.ts]
- `ExecutionTraceStore.saveTrace()` - persists traces
- `sampleByPriority()` - PER sampling for learning

## Estimation

- **Effort:** 1-1.5 days
- **LOC:** ~400-500 net
- **Risk:** Low
  - Clear separation from sandbox execution
  - Async sync doesn't block execution
  - Graceful degradation in standalone mode

## Open Questions

1. **Should traces include raw args/results or always sanitize?**
   - Proposal: Always sanitize, opt-in for raw (debug mode only)

2. **Local storage for standalone mode?**
   - Proposal: Defer to 14.5c if needed, just log for now

3. **Rate limiting on cloud sync?**
   - Proposal: Server-side rate limit, client respects 429

---

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

- All 48 tests pass (`deno test packages/pml/tests/trace*.ts --allow-all`)
- Type checking passes (`deno check packages/pml/src/loader/capability-loader.ts`)

### Completion Notes List

1. **TraceCollector** - Accumulates mcp.* calls during sandbox execution with:
   - Sequential task ID generation (t1, t2, t3...)
   - Automatic sanitization on finalize
   - Branch decision recording for capabilities with control flow

2. **TraceSyncer** - Async batch sync to cloud with:
   - Configurable batch size (default: 10)
   - Configurable flush interval (default: 5s)
   - Retry logic with configurable maxRetries
   - Standalone mode (no cloud) just logs locally

3. **Sanitizer** - Comprehensive data protection:
   - Redacts sensitive keys (api_key, token, password, secret, etc.)
   - Redacts sensitive values (OpenAI API keys, Bearer tokens)
   - Masks PII (emails, phone numbers, SSN, credit cards)
   - Truncates large payloads (>10KB)

4. **CapabilityLoader Integration** - Tracing wired into sandbox execution:
   - `tracingEnabled` option (default: true)
   - `tracingConfig` for custom sync settings
   - TraceCollector created per execution
   - Traces synced on both success and failure
   - TraceSyncer shutdown flushes pending traces

5. **Server API** - `POST /api/traces` endpoint:
   - Accepts batch of LocalExecutionTrace from packages/pml
   - **Resolves FQDN → workflowPatternId (UUID)** for proper FK linkage
   - Maps to SaveTraceInput format
   - Stores via ExecutionTraceStore.saveTrace()
   - Learning via TD-Error + PER happens automatically

6. **FQDN Resolution** - Client sends FQDN, server resolves to UUID:
   - Client only sees FQDN (public abstraction, can be renamed)
   - Server resolves via `CapabilityRegistry.getByFqdnComponents()`
   - Trace stored with `capability_id` FK to `workflow_pattern.pattern_id`
   - Standalone traces (unresolved FQDN) stored with `capability_id = null`

### Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-01-07 | Story created - trace collection and cloud sync for sandbox executions | Claude Opus 4.5 |
| 2026-01-07 | Validation: Added package independence architecture, server schema reference, type alignment guidance | Claude Opus 4.5 |
| 2026-01-07 | Implementation complete - all 11 tasks done, 48 tests passing | Claude Opus 4.5 |
| 2026-01-07 | Fix: Added FQDN → UUID resolution in traces.ts - client sends FQDN, server resolves to workflowPatternId for proper FK linkage | Claude Opus 4.5 |

### File List

**New Files (packages/pml):**
- `packages/pml/src/tracing/mod.ts` - Module exports
- `packages/pml/src/tracing/types.ts` - LocalExecutionTrace, TraceTaskResult, TraceSyncConfig
- `packages/pml/src/tracing/collector.ts` - TraceCollector class
- `packages/pml/src/tracing/sanitizer.ts` - Sanitization utilities
- `packages/pml/src/tracing/syncer.ts` - TraceSyncer class
- `packages/pml/tests/trace_collector_test.ts` - 17 tests
- `packages/pml/tests/trace_sanitizer_test.ts` - 19 tests
- `packages/pml/tests/trace_syncer_test.ts` - 12 tests

**New Files (server):**
- `src/api/traces.ts` - POST /api/traces endpoint

**Modified Files:**
- `packages/pml/src/loader/capability-loader.ts` - Added tracing integration
- `src/api/mod.ts` - Export handleTracesRoutes

