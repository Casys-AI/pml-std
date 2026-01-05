# ADR-044: JSON-RPC Multiplexer Pattern for MCP Client

**Status:** Implemented **Date:** 2025-12-11 | **Deciders:** Architecture Team **Tech-Spec Source:**
`docs/tech-specs/tech-spec-dag-code-execution-integration.md`

## Context

### Problem

The `MCPClient.sendRequest()` had a critical concurrency bug that caused parallel MCP requests to
timeout. The implementation used a single shared reader that blocked concurrent requests, and
responses were not matched by request ID.

```
┌─────────────────────────────────────────────────────────────────┐
│ Thread A (Request 1)              Thread B (Request 2)          │
│ ──────────────────────            ──────────────────────        │
│ 1. writer.write(req1)             1. writer.write(req2)         │
│ 2. while(true) {                  2. while(true) {              │
│      reader.read() ← BLOCKS!           reader.read() ← WAITING  │
│    }                                 }                          │
│ 3. parse(response) ← May get      3. ... 10 seconds pass ...   │
│    req2's response!               4. TIMEOUT ERROR              │
│ 4. resolve(wrong response)                                      │
└─────────────────────────────────────────────────────────────────┘
```

**Root Causes:**

1. **Shared reader**: `this.reader` was shared across all concurrent `sendRequest()` calls
2. **Blocking loop**: Each request did `while(true) { reader.read() }` blocking the stream
3. **No ID matching**: First response received was returned, regardless of `response.id`

### Existing Pattern in Codebase

The exact solution already existed in `src/sandbox/worker-bridge.ts:88-92`:

```typescript
private pendingRPCs: Map<string, {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}> = new Map();
```

## Decision

**Adopt the WorkerBridge pattern for MCPClient** - implement a JSON-RPC multiplexer with:

1. **Pending requests map**: Track all in-flight requests by ID
2. **Single reader loop**: One continuous loop dispatches responses by ID
3. **Timeout isolation**: Each request has independent timeout
4. **Clean shutdown**: Connection close rejects all pending requests

### Implementation

```typescript
class MCPClient {
  private pendingRequests = new Map<number, {
    resolve: (response: JSONRPCResponse) => void;
    reject: (error: Error) => void;
    timeoutId: ReturnType<typeof setTimeout>;
  }>();
  private readerLoopRunning = false;

  private async startReaderLoop(): Promise<void> {
    if (this.readerLoopRunning) return;
    this.readerLoopRunning = true;

    while (this.readerLoopRunning && this.reader) {
      try {
        const response = await this.readNextResponse();
        const pending = this.pendingRequests.get(response.id);
        if (pending) {
          clearTimeout(pending.timeoutId);
          pending.resolve(response);
          this.pendingRequests.delete(response.id);
        }
      } catch (error) {
        this.rejectAllPending(error);
        break;
      }
    }
  }

  private async sendRequest(request: JSONRPCRequest): Promise<JSONRPCResponse> {
    this.startReaderLoop(); // fire and forget
    await this.writer.write(encode(request));

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(request.id);
        reject(new TimeoutError(this.serverId, this.timeout));
      }, this.timeout);

      this.pendingRequests.set(request.id, { resolve, reject, timeoutId });
    });
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeoutId);
      pending.reject(error);
      this.pendingRequests.delete(id);
    }
  }
}
```

## Consequences

### Positive

- Parallel MCP requests work correctly (4+ concurrent requests complete successfully)
- Each response matched to correct request by ID
- Timeouts only affect the specific request, not others
- Connection errors can clean up all pending requests gracefully
- **Proven pattern** - already working in WorkerBridge for months
- **Observability ready** - can plug into EventBus (ADR-036)

### Negative

- Slightly more complex code than naive sequential approach
- Reader loop runs continuously once started (minimal overhead)

### Neutral

- Optional mutex fallback added for safety (`allowConcurrentRequests` config flag)

## Acceptance Criteria (Verified)

- [x] AC6: Given 4 parallel MCP requests to same server, when executed, then all 4 complete
      successfully without timeout
- [x] AC7: Given parallel requests, when one times out, then other pending requests are not affected
- [x] AC8: Given MCPClient with multiplexer, when response arrives, then it is matched to correct
      pending request by ID

## Related

- **ADR-032**: Sandbox Worker RPC Bridge (original pattern source)
- **ADR-036**: BroadcastChannel Event Distribution (observability integration)
- **Tech-Spec**: `docs/tech-specs/tech-spec-dag-code-execution-integration.md`
