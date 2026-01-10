# ADR-059: Hybrid Routing - Server Analysis, Package Execution

**Status:** Accepted
**Date:** 2026-01-09
**Implementation:** Done
**Related:**

- ADR-032 (Sandbox Worker RPC Bridge)
- ADR-052 (Dynamic Capability Routing)
- Epic 14 (JSR Package Local/Cloud MCP Routing)
- Story 14.4 (Dynamic MCP Loader)
- Story 14.5 (Sandboxed Execution)

## Context

### Problem

When calling `pml:execute` with code containing client-routed tools (filesystem, shell, etc.):

```typescript
pml:execute({
  code: `const content = await mcp.filesystem.read_file({ path: "/home/user/file.txt" });
         return content;`
})
```

**Result:** `ENOENT: no such file or directory, open '/home/user/file.txt'`

The **server** tries to read the file on **its** filesystem, not the user's.

### Root Cause

The package forwarded ALL `pml:execute` calls directly to the server without checking routing:

```typescript
// packages/pml/src/cli/stdio-command.ts (before)
if (name === "pml:execute") {
  await forwardToCloud(...);  // BYPASS - no routing check
  return;
}
```

The server executed everything with its own MCP clients, ignoring tool routing configuration.

### Existing Infrastructure

The package already had all the components needed for local execution:

| Component | File | Status |
|-----------|------|--------|
| `CapabilityLoader` | `packages/pml/src/loader/capability-loader.ts` | Works for capabilities |
| `SandboxWorker` | `packages/pml/src/sandbox/execution/worker-runner.ts` | Tested |
| `resolveToolRouting()` | `packages/pml/src/routing/resolver.ts` | Used for capabilities |
| `StdioManager` | `packages/pml/src/loader/stdio-manager.ts` | Works |

The gap: `pml:execute` bypassed all of this.

## Decision

### Option A: Server Smart Analysis (CHOSEN)

The server decides intelligently whether to execute or delegate to the package.

### Flow

```
Claude → pml:execute(code)
    │
    ▼
Package forwards to Server
    │
    ▼
Server analyzes (SWC → StaticStructure → DAG)
    │
    ▼
Server checks routing of EACH tool in DAG
    │
    ├─► If ALL tools are "server" (json, tavily, math...)
    │       │
    │       ▼
    │   Server executes normally
    │   Returns result to Package
    │
    └─► If ANY tool is "client" (filesystem, shell...)
            │
            ▼
        Server returns to Package:
        {
          "status": "execute_locally",
          "code": "...",
          "dag": { tasks: [...] },
          "tools_used": ["filesystem:read_file", "tavily:search"],
          "client_tools": ["filesystem:read_file"]
        }
            │
            ▼
        Package executes via SandboxWorker
            │
            ▼
        ALL code runs in sandbox (permissions: "none")
            │
            ▼
        mcp.* calls → RPC bridge → routing:
          ├─► "client" → local execution (StdioManager)
          └─► "server" → HTTP forward to cloud
```

### Key Principle: ALL Code Executes in Sandbox

Whether the code is a registered capability or ad-hoc code from `pml:execute`,
it ALWAYS runs in the sandbox with `permissions: "none"`. The sandbox provides:

1. **Isolation** - Code cannot directly access filesystem, network, or subprocess
2. **Single exit point** - Only `mcp.*` RPC calls can interact with the system
3. **HIL protection** - All `mcp.*` calls go through HIL approval if tool is in "ask" list

```
┌─────────────────────────────────────────────────────────────┐
│  SANDBOX (Deno Worker, permissions: "none")                 │
│                                                             │
│  Capability code / pml:execute code                         │
│  - No direct filesystem access                              │
│  - No direct network access                                 │
│  - No subprocess spawning                                   │
│  - Only exit: mcp.* RPC                                     │
│                                                             │
│  Protection: Total isolation via Worker                     │
└─────────────────────────────────────────────────────────────┘
              │
              │ mcp.* RPC calls
              ▼
┌─────────────────────────────────────────────────────────────┐
│  MCP SERVERS (system access)                                │
│                                                             │
│  Local (stdio): filesystem, shell, git...                   │
│  Cloud (http): forward to pml.casys.ai                      │
│                                                             │
│  Protection: HIL approval + Lockfile integrity              │
└─────────────────────────────────────────────────────────────┘
```

### Alternatives Considered

| Option | Description | Rejected Because |
|--------|-------------|------------------|
| B: Server callbacks | Server executes, callbacks package for each client tool | Too many round-trips, complex state |
| C: Package analyzes | Package does SWC analysis locally | Duplicates server logic, larger package |
| D: Block client tools | Error if pml:execute contains client tools | Poor UX, limits usefulness |

### Why Option A?

1. **Optimal latency** - 100% server-tool DAGs execute on server (no extra round-trip)
2. **Reuses existing infrastructure** - Package sandbox already works for capabilities
3. **Single analysis point** - SWC/DAG logic stays on server
4. **Clear separation** - Server = analysis, Package = client execution

## Implementation

### Server Changes

`src/mcp/handlers/code-execution-handler.ts`:

```typescript
import { resolveRouting, getToolRouting } from "../../capabilities/routing-resolver.ts";

// After DAG is built (line ~219)
const toolsUsed = optimizedDAG.tasks.map((t) => t.tool);
const routing = resolveRouting(toolsUsed);

if (routing === "client") {
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        status: "execute_locally",
        code: request.code,
        dag: { tasks: optimizedDAG.tasks },
        tools_used: toolsUsed,
        client_tools: toolsUsed.filter(t => getToolRouting(t) === "client"),
      })
    }]
  };
}
// Continue with normal server execution...
```

### Package Changes

`packages/pml/src/cli/stdio-command.ts`:

```typescript
if (name === "pml:execute") {
  const response = await forwardToCloud(id, name, args || {}, cloudUrl);

  const parsed = parseExecuteLocallyResponse(response);
  if (parsed?.status === "execute_locally") {
    // Execute in sandbox with hybrid routing
    const result = await executeLocalCode(loader, parsed.code, parsed.dag, cloudUrl);
    sendResponse({ jsonrpc: "2.0", id, result });
    return;
  }

  // Normal server response
  sendResponse(response);
}
```

### Client Identification

Clients without the package (web app, API) cannot handle `execute_locally`.
The package identifies itself via header:

```typescript
// Package adds header
headers: { "X-PML-Client": "package" }

// Server checks before returning execute_locally
if (!isPackageClient && routing === "client") {
  return { error: "CLIENT_TOOLS_REQUIRE_PACKAGE", install_command: "..." };
}
```

## Consequences

### Positive

1. **Works transparently** - User code with filesystem/shell now works
2. **Secure by default** - ALL code in sandbox, mcp.* calls protected by HIL
3. **Optimal performance** - Server-only DAGs stay on server
4. **Composable** - Mixed DAGs (client + server tools) work correctly
5. **Reuses infrastructure** - No new components, just wiring

### Negative

1. **Extra round-trip** - Client-tool DAGs require package ↔ server ↔ package
2. **Package required** - Web app/API cannot execute client tools (clear error shown)
3. **Static analysis limitation** - Dynamic tool calls not detected (edge case)

### Per-Project State

All state is now per-project, not global:

| File | Location |
|------|----------|
| `.pml.json` | `${workspace}/.pml.json` |
| `mcp.lock` | `${workspace}/.pml/mcp.lock` |
| `deps.json` | `${workspace}/.pml/deps.json` |
| `client-id` | `${workspace}/.pml/client-id` |

`pml init` automatically adds these to `.gitignore`.

## Test Scenarios

### 1. 100% Server Tools
```typescript
pml:execute({ code: "await mcp.json.parse({ data: '{}' })" })
// → Executed on server, result returned
```

### 2. 100% Client Tools
```typescript
pml:execute({ code: "await mcp.filesystem.read_file({ path: '/tmp/test.txt' })" })
// → status: "execute_locally" → package sandbox → result
```

### 3. Mixed Tools
```typescript
pml:execute({
  code: `
    const content = await mcp.filesystem.read_file({ path: '/tmp/data.json' });
    const parsed = await mcp.json.parse({ data: content });
    return parsed;
  `
})
// → execute_locally (filesystem is client)
// → Package executes ALL in sandbox:
//   - filesystem.read_file → local via StdioManager
//   - json.parse → forward to cloud
```

### 4. HIL Approval
```typescript
pml:execute({ code: "await mcp.shell.exec({ command: 'rm -rf /tmp/test' })" })
// → execute_locally → sandbox → mcp.shell.exec → HIL prompt → user approves → execute
```

## References

- [Spike: PML Execute Hybrid Routing](../spikes/spike-2026-01-09-pml-execute-hybrid-routing.md)
- [Story 14.4: Dynamic MCP Loader](../../implementation-artifacts/14-4-dynamic-mcp-loader-registry.md)
- [Story 14.5: Sandboxed Execution](../../implementation-artifacts/14-5-sandboxed-local-mcp-execution.md)
- `packages/pml/src/cli/stdio-command.ts` - Package entry point
- `src/mcp/handlers/code-execution-handler.ts` - Server execution handler
