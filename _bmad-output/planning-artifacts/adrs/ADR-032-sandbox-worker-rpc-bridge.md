# ADR-032: Sandbox Worker RPC Bridge with Native Tracing

**Status:** 📝 Draft **Date:** 2025-12-05 | **Supersedes:** ADR-027 (partially)

> Replaces `__TRACE__` stdout parsing with native RPC bridge tracing.

## Context

### The Problem: A Hidden Bug Since Story 3.2

Story 3.2 implemented `wrapMCPClient()` in `src/sandbox/context-builder.ts` to inject MCP tools into
the sandbox. **This code exists, is actively called, but has never actually worked** for the
subprocess sandbox.

#### What the code does:

```typescript
// context-builder.ts:148 - This IS called in production
const serverToolContext = wrapMCPClient(client, tools); // Creates JavaScript FUNCTIONS
context[serverId] = serverToolContext;
// Result: { filesystem: { list_directory: async (args) => client.callTool(...) } }

// gateway-server.ts:1175 - Passes context to executor
const result = await executor.execute(request.code, executionContext);

// executor.ts:356 - Tries to serialize for subprocess
return `const ${key} = ${JSON.stringify(value)};`;
// JSON.stringify(function) → undefined
// Result: MCP tools silently disappear from the context!
```

#### Why this was never caught:

1. **Story 3.2 tests** used mock contexts, not real MCP clients with functions
2. **`execute_code` tests** used simple code that didn't call MCP tools
3. **No integration test** verified "execute code that actually calls an MCP tool"
4. **Silent failure** - `JSON.stringify()` doesn't throw, it just returns `undefined`

#### The error when we finally tried:

```
Server log: "Security validation failed"
Server log: "Context contains function value"
```

The security validator in `executor.ts` catches this, but the root cause is architectural: **you
cannot serialize functions to a subprocess**.

### Research Findings

We evaluated three approaches based on industry best practices:

| Approach                          | Used By                | Pros                                   | Cons                                              |
| --------------------------------- | ---------------------- | -------------------------------------- | ------------------------------------------------- |
| **Subprocess + stdin/stdout IPC** | Traditional            | Strong isolation                       | Slow (process spawn), complex JSON-RPC over pipes |
| **Web Worker + postMessage**      | SandpackVM, Cloudflare | Fast, native RPC, granular permissions | Same V8 isolate (less isolation)                  |
| **V8 Isolates**                   | Cloudflare Workers     | Best isolation + performance           | Requires Cloudflare runtime                       |

**Key insight from Cloudflare's Code Mode:**

> "The sandbox is totally isolated from the Internet. Its only access to the outside world is
> through TypeScript APIs representing its connected MCP servers. These APIs are backed by RPC
> invocation which calls back to the agent loop."

**Key insight from SandpackVM:**

> "True sandboxing is about controlled bridges, not walls."

### Deno Worker Permissions

Deno Workers support granular permission restrictions:

```typescript
const worker = new Worker(workerUrl, {
  type: "module",
  deno: {
    permissions: "none", // Fully sandboxed - no network, no filesystem, no env
  },
});
```

This provides security isolation without subprocess overhead.

## Decision

Replace the current subprocess-based sandbox with a **Web Worker + RPC Bridge** architecture:

### Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  Main Process (Gateway Server)                                       │
│                                                                      │
│  ┌──────────────────┐     ┌──────────────────────────────────────┐  │
│  │  MCP Clients     │     │  RPC Bridge                          │  │
│  │  - filesystem    │◄────│  - Receives tool calls from Worker   │  │
│  │  - memory        │     │  - Executes via MCPClient            │  │
│  │  - playwright    │     │  - Returns results to Worker         │  │
│  └──────────────────┘     └──────────────────────────────────────┘  │
│                                      ▲                               │
│                                      │ postMessage                   │
│                                      ▼                               │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  Sandbox Worker (permissions: "none")                          │  │
│  │                                                                │  │
│  │  ┌─────────────────────────────────────────────────────────┐  │  │
│  │  │  Generated Tool Proxies                                  │  │  │
│  │  │                                                          │  │  │
│  │  │  const tools = {                                         │  │  │
│  │  │    filesystem: {                                         │  │  │
│  │  │      list_directory: (args) => __rpcCall("filesystem",   │  │  │
│  │  │                                  "list_directory", args) │  │  │
│  │  │    }                                                     │  │  │
│  │  │  };                                                      │  │  │
│  │  └─────────────────────────────────────────────────────────┘  │  │
│  │                                                                │  │
│  │  User Code executes with tools.* available                     │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  Native Tracing: Bridge captures ALL tool calls automatically        │
│  (No __TRACE__ stdout parsing needed - supersedes ADR-027)           │
└─────────────────────────────────────────────────────────────────────┘
```

### RPC Protocol

#### Message Types

```typescript
// Worker → Main: Tool call request
interface RPCCallMessage {
  type: "rpc_call";
  id: string; // UUID for correlation
  server: string; // "filesystem"
  tool: string; // "list_directory"
  args: Record<string, unknown>;
}

// Main → Worker: Tool call result
interface RPCResultMessage {
  type: "rpc_result";
  id: string; // Matching request ID
  success: boolean;
  result?: unknown; // Tool result if success
  error?: string; // Error message if failure
}

// Worker → Main: Execution complete
interface ExecutionCompleteMessage {
  type: "execution_complete";
  success: boolean;
  result?: unknown;
  error?: string;
  // Note: traces are collected by the bridge, not sent from worker
}

// Main → Worker: Start execution
interface ExecuteMessage {
  type: "execute";
  code: string;
  tools: ToolDefinition[]; // Which tools are available
  context?: Record<string, unknown>; // Additional context
}
```

#### Sequence Diagram

```
Main                                    Worker
  │                                        │
  │──── { type: "execute", code, tools } ──►│
  │                                        │
  │                                        │ (generates tool proxies)
  │                                        │ (executes user code)
  │                                        │
  │◄─── { type: "rpc_call", id: "1", ... } │ (code calls tool)
  │                                        │
  │ (executes MCP tool)                    │
  │                                        │
  │──── { type: "rpc_result", id: "1" } ───►│
  │                                        │
  │                                        │ (Promise resolves, code continues)
  │                                        │
  │◄─── { type: "execution_complete" } ────│
  │                                        │
```

### Tool Proxy Generation (Worker Side)

The Worker receives tool definitions and generates simple proxy functions:

```typescript
// sandbox-worker.ts (runs in Worker) - SIMPLE, NO TRACING

const pendingCalls = new Map<string, { resolve: Function; reject: Function }>();

// Simple RPC call - no tracing here, bridge handles it
function __rpcCall(server: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
  const id = crypto.randomUUID();

  return new Promise((resolve, reject) => {
    pendingCalls.set(id, { resolve, reject });
    self.postMessage({ type: "rpc_call", id, server, tool, args });
  });
}

// Handle responses from main
self.onmessage = (event) => {
  const msg = event.data;

  if (msg.type === "rpc_result") {
    const pending = pendingCalls.get(msg.id);
    if (pending) {
      pendingCalls.delete(msg.id);
      if (msg.success) {
        pending.resolve(msg.result);
      } else {
        pending.reject(new Error(msg.error));
      }
    }
  }

  if (msg.type === "execute") {
    executeCode(msg.code, msg.tools, msg.context);
  }
};

// Generate tool proxies from definitions
function generateToolProxies(tools: ToolDefinition[]): Record<string, Record<string, Function>> {
  const proxies: Record<string, Record<string, Function>> = {};
  for (const tool of tools) {
    if (!proxies[tool.serverId]) proxies[tool.serverId] = {};
    proxies[tool.serverId][tool.toolName] = (args) => __rpcCall(tool.serverId, tool.toolName, args);
  }
  return proxies;
}
```

### Native Tracing in RPC Bridge (Main Side)

**Key insight: The bridge IS the tracing point.** Every tool call passes through the bridge, so we
trace there - not in the Worker. This supersedes the `__TRACE__` stdout approach from ADR-027.

```typescript
// worker-bridge.ts (runs in Main) - TRACING HAPPENS HERE

interface TraceEvent {
  type: "tool_start" | "tool_end" | "capability_start" | "capability_end";
  tool?: string;
  capability_id?: string;
  trace_id: string;
  ts: number;
  success?: boolean;
  duration_ms?: number;
  error?: string;
}

class WorkerBridge {
  private traces: TraceEvent[] = [];
  private mcpClients: Map<string, MCPClient>;

  handleWorkerMessage(event: MessageEvent) {
    const msg = event.data;

    if (msg.type === "rpc_call") {
      this.executeToolWithTracing(msg);
    }

    if (msg.type === "execution_complete") {
      // Return traces with result for GraphRAG update
      this.onExecutionComplete(msg.result, msg.error, this.traces);
    }
  }

  private async executeToolWithTracing(msg: RPCCallMessage) {
    const { id, server, tool, args } = msg;
    const toolId = `${server}:${tool}`;
    const startTime = Date.now();

    // ✅ TRACE START - captured at bridge level
    this.traces.push({
      type: "tool_start",
      tool: toolId,
      trace_id: id,
      ts: startTime,
    });

    try {
      const client = this.mcpClients.get(server);
      if (!client) throw new Error(`MCP server "${server}" not connected`);

      const result = await client.callTool(tool, args);

      // ✅ TRACE END (success) - captured at bridge level
      this.traces.push({
        type: "tool_end",
        tool: toolId,
        trace_id: id,
        ts: Date.now(),
        success: true,
        duration_ms: Date.now() - startTime,
      });

      this.worker.postMessage({ type: "rpc_result", id, success: true, result });
    } catch (error) {
      // ✅ TRACE END (failure) - captured at bridge level
      this.traces.push({
        type: "tool_end",
        tool: toolId,
        trace_id: id,
        ts: Date.now(),
        success: false,
        duration_ms: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error),
      });

      this.worker.postMessage({ type: "rpc_result", id, success: false, error: String(error) });
    }
  }
}
```

### GraphRAG Integration

After execution completes, update GraphRAG with the traced tool calls:

```typescript
// In gateway-server.ts or worker-bridge.ts

onExecutionComplete(result: unknown, error: string | undefined, traces: TraceEvent[]) {
  // Extract successful tool calls
  const toolsCalled = traces
    .filter(t => t.type === "tool_end" && t.success)
    .map(t => t.tool!);

  if (toolsCalled.length > 0 && request.intent) {
    await graphEngine.updateFromExecution({
      execution_id: crypto.randomUUID(),
      executed_at: new Date(),
      intent_text: request.intent,
      dag_structure: {
        tasks: toolsCalled.map((tool, i) => ({
          id: `task_${i}`,
          tool,
          arguments: {},
          depends_on: i > 0 ? [`task_${i-1}`] : [],
        })),
      },
      success: !error,
      execution_time_ms: totalExecutionTime,
    });
  }

  return { success: !error, result, error, traces };
}
```

### Why Native Tracing is Better than `__TRACE__`

| Aspect                    | `__TRACE__` (ADR-027)                | Native Bridge Tracing (ADR-032) |
| ------------------------- | ------------------------------------ | ------------------------------- |
| **Where tracing happens** | Worker (console.log)                 | Main (bridge)                   |
| **Data format**           | JSON strings in stdout               | Structured objects              |
| **Parsing needed**        | Yes (regex + JSON.parse)             | No                              |
| **Reliability**           | Can break if user logs `__TRACE__`   | 100% reliable                   |
| **Performance**           | String concat + parse overhead       | Direct object push              |
| **Capability tracing**    | Need separate `capability_start/end` | Same mechanism                  |
| **Code complexity**       | Worker + parser + filter             | Bridge only                     |

### What This Replaces

The following code from Story 7.1 implementation is **no longer needed**:

1. `wrapToolCall()` in `context-builder.ts` - tracing wrapper ❌
2. `parseTraces()` in `gateway-server.ts` - stdout parsing ❌
3. `rawStdout` in `ExecutionResult` type ❌
4. `__TRACE__` prefix filtering from output ❌

All tracing is now handled by the bridge - simpler, more reliable, better performance.

## Implementation Plan

### Design Principle: Maximum Reuse

The existing sandbox infrastructure is well-designed. We preserve:

- **Same interface** - `execute(code, context)` signature unchanged
- **Same types** - `SandboxConfig`, `ExecutionResult` unchanged
- **Same services** - Cache, SecurityValidator, ResourceLimiter, PIIDetector
- **Same error handling** - `StructuredError` types preserved

### What Changes

| Component        | Current                       | New                   |
| ---------------- | ----------------------------- | --------------------- |
| Code execution   | Deno subprocess               | Deno Worker           |
| Tool injection   | Functions in context (broken) | RPC proxies (working) |
| Trace collection | Parse stdout `__TRACE__`      | Native in bridge      |
| IPC              | stdin/stdout                  | postMessage           |

### Phase 1: Worker Bridge (Story 7.1b)

**New files (minimal):**

1. `src/sandbox/worker-bridge.ts` (~150 LOC)
   - Worker lifecycle management
   - RPC request/response handling
   - Tool call routing to MCPClients

2. `src/sandbox/sandbox-worker.ts` (~100 LOC)
   - Runs inside Worker
   - Receives tool definitions, generates proxies
   - Executes user code
   - Collects traces

3. `src/sandbox/types.ts` - Extend existing (~50 LOC added)
   - Add RPC message types to existing file
   - Shared between main and worker
   - Keeps all sandbox types in one place

**Modified files:**

4. `src/sandbox/executor.ts` - Add Worker mode
   ```typescript
   export class DenoSandboxExecutor {
     private mode: "worker" | "subprocess" = "worker"; // New default

     async execute(code, context) {
       // Existing validation (SecurityValidator, ResourceLimiter) - REUSED
       // Existing cache check - REUSED

       if (this.mode === "worker") {
         return this.executeViaWorker(code, context); // NEW
       }
       return this.executeViaSubprocess(code, context); // EXISTING (renamed)
     }
   }
   ```

5. `src/sandbox/context-builder.ts` - Generate tool definitions instead of functions
   ```typescript
   // New method
   buildToolDefinitions(searchResults: SearchResult[]): ToolDefinition[] {
     // Returns metadata only, no functions
   }

   // Existing wrapMCPClient() - kept for backward compat, marked deprecated
   ```

6. `src/mcp/gateway-server.ts` - Pass MCPClients to executor for RPC routing
   ```typescript
   const executor = new DenoSandboxExecutor({
     ...config,
     mcpClients: this.mcpClients, // NEW: for Worker RPC
   });
   ```

**Estimated:** ~300 LOC new, ~50 LOC modified

### Phase 2: Cleanup (Future)

1. Remove subprocess code path after validation
2. Remove deprecated `wrapMCPClient()` function wrapper mode
3. Simplify context-builder to only generate definitions

### Reuse Matrix

| Existing Component      | Reused? | Notes                                                     |
| ----------------------- | ------- | --------------------------------------------------------- |
| `types.ts`              | ✅ 100% | Interface unchanged                                       |
| `cache.ts`              | ✅ 100% | Works with any executor                                   |
| `security-validator.ts` | ✅ 100% | Pre-execution validation                                  |
| `resource-limiter.ts`   | ✅ 100% | Concurrency control                                       |
| `pii-detector.ts`       | ✅ 100% | Output sanitization                                       |
| `context-builder.ts`    | ⚠️ 80%  | Add `buildToolDefinitions()`, deprecate function wrappers |
| `executor.ts`           | ⚠️ 70%  | Keep interface, add Worker mode                           |

## Files Summary

| File                             | Action | LOC          |
| -------------------------------- | ------ | ------------ |
| `src/sandbox/worker-bridge.ts`   | Create | ~150         |
| `src/sandbox/sandbox-worker.ts`  | Create | ~100         |
| `src/sandbox/types.ts`           | Extend | ~50          |
| `src/sandbox/executor.ts`        | Modify | ~30          |
| `src/sandbox/context-builder.ts` | Modify | ~20          |
| `src/mcp/gateway-server.ts`      | Modify | ~10          |
| **Total**                        |        | **~360 LOC** |

## Consequences

### Positive

- **Tools actually work in sandbox** - Fixes the core broken functionality
- **Better performance** - Workers are faster than subprocess spawn
- **Native RPC** - postMessage is cleaner than stdin/stdout JSON parsing
- **Granular security** - `permissions: "none"` provides strong isolation
- **Native tracing** - Bridge captures all tool calls automatically, no parsing
- **Simpler code** - Removes `__TRACE__`, `parseTraces()`, `rawStdout`
- **Industry standard** - Same pattern as Cloudflare Code Mode, SandpackVM

### Negative

- **Less isolation than subprocess** - Same V8 process (mitigated by Deno permissions)
- **New code to maintain** - RPC bridge adds complexity
- **Migration effort** - Need to update existing executor usage

### Risks

- **Worker message overhead** - Each tool call is a round-trip (mitigated: postMessage is fast)
- **Deadlock potential** - Worker waiting for RPC that never returns (mitigated: timeouts)
- **Memory sharing** - Workers share heap with main (mitigated: Deno permissions block most access)

## Alternatives Considered

### Alternative 1: Keep Subprocess + Add IPC Bridge

Add stdin/stdout JSON-RPC to existing subprocess executor.

**Rejected because:**

- Subprocess spawn is slow (~50-100ms overhead)
- stdin/stdout parsing is error-prone
- More complex than postMessage

### Alternative 2: In-Process Execution (eval-like)

Execute code in same thread with restricted scope.

**Rejected because:**

- No isolation - code can access anything
- Security risk too high
- Violates sandbox principle

### Alternative 3: External Sandbox Service

Use Cloudflare Workers or similar.

**Rejected because:**

- External dependency
- Latency for remote calls
- Cost for hosted service
- Complexity of deployment

## Code to Remove (Story 7.1 cleanup)

When implementing ADR-032, the following code from Story 7.1 should be **removed**:

### `src/sandbox/context-builder.ts`

- `wrapToolCall()` function (~40 LOC)
- `setTracingEnabled()` / `isTracingEnabled()` functions
- `tracingEnabled` module variable

### `src/mcp/gateway-server.ts`

- `parseTraces()` function (~30 LOC)
- `TraceEvent` interface
- `ParsedTraces` interface
- Trace parsing logic in `handleExecuteCode()`

### `src/sandbox/types.ts`

- `rawStdout` field in `ExecutionResult` interface

### `tests/`

- `tests/unit/mcp/trace_parsing_test.ts` - entire file
- `tests/unit/sandbox/tracing_performance_test.ts` - entire file
- Tracing-related tests in `context_builder_test.ts`

**Total cleanup:** ~150 LOC removed, replaced by ~50 LOC in bridge

## References

- [Cloudflare: Code Mode](https://blog.cloudflare.com/code-mode/) - RPC binding pattern
- [SandpackVM](https://dev.to/ackermannq/building-sandpackvm-how-to-build-a-lightweight-vm-88c) -
  Worker RPC bridge
- [Deno Workers](https://docs.deno.com/runtime/manual/runtime/workers) - Permission configuration
- [Anthropic: Code Execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp) -
  Sandbox architecture
- ADR-027: Execute Code Graph Learning (superseded for tracing)
- Epic 3 Story 3.2: MCP Tools Injection into Code Context
- `src/sandbox/executor.ts` - Current (broken) implementation
- `src/sandbox/context-builder.ts` - Tool wrapper generation
