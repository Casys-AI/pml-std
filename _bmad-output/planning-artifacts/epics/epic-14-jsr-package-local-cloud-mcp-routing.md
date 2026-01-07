---
stepsCompleted: [
  "step-01-validate-prerequisites",
  "step-02-design-epics",
  "step-03-create-stories",
  "step-04-final-validation",
]
status: ready-for-development
inputDocuments:
  - docs/spikes/2025-12-23-jsr-package-local-mcp-routing.md
  - docs/PRD.md
  - docs/architecture.md
---

# Procedural Memory Layer (PML) - Epic 14: JSR Package Local/Cloud MCP Routing

## Overview

This document provides the complete epic and story breakdown for Epic 14, implementing a lightweight
JSR package (`jsr:@casys/pml`) that enables hybrid local/cloud MCP execution. This solves the
critical problem where cloud-hosted PML gateway uses server filesystem and API keys instead of
user's local resources.

## Requirements Inventory

### Functional Requirements

**From Spike Document:**

- **FR14-1:** The system must provide a lightweight JSR package (`jsr:@casys/pml`) installable via
  `deno install`
- **FR14-2:** The system must resolve workspace path using priority: ENV var → project root
  detection → CWD fallback
- **FR14-3:** The system must route MCP calls based on `routing: local | cloud` configuration in
  `mcp-permissions.yaml`
- **FR14-4:** The system must dynamically import MCP code from unified PML registry (`pml.casys.ai/mcp/{fqdn}`)
- **FR14-5:** The system must execute local MCPs (filesystem, shell, sqlite) in Deno sandbox with
  scoped permissions
- **FR14-6:** The system must forward server MCPs (pml:search, GraphRAG, tavily) via HTTP RPC to
  `pml.casys.ai`
- **FR14-7:** The system must expose an MCP HTTP Streamable server for Claude Code integration
- **FR14-8:** The system must support BYOK (Bring Your Own Key) for third-party MCPs via local
  environment variables
- **FR14-9:** The system must generate `.mcp.json` configuration via `pml init` command
- **FR14-10:** The system must cache downloaded MCP code via Deno's native module caching

**Cross-referenced from PRD (FR020-FR025):**

- **FR14-11:** The package must work in both Local mode (zero-auth) and Cloud mode (API key
  required)
- **FR14-12:** The system must apply user's local API keys for BYOK MCPs (stored in local env, not
  sent to cloud for storage)

### Non-Functional Requirements

- **NFR14-1:** Package size must be minimal (~few KB) for fast installation
- **NFR14-2:** Local MCP execution must have <50ms overhead vs direct execution
- **NFR14-3:** Sandbox permissions must follow principle of least privilege (read/write scoped to
  workspace only by default, extensible if user wants)
- **NFR14-4:** Package must work offline for cached local MCPs (graceful degradation if cloud
  unavailable)
- **NFR14-5:** Installation to first workflow must complete in <5 minutes (aligned with PRD NFR002)

### Additional Requirements

**From Architecture (ADR-040, tech-spec-open-core-workspace):**

- Must integrate with existing `PermissionInferrer` for routing decisions
- Must use existing `mcp-permissions.yaml` schema with new `routing` field
- Must align with dual-server architecture (API server + Dashboard)
- Sandbox execution must use Deno Worker or subprocess with explicit permission flags

**Technical Notes:**

- HIL (Human-in-the-Loop) integration needs verification (existing technical debt)
- Users may want permissions broader than workspace - must be configurable
- **Critical Invariant:** Local execution NEVER goes to cloud server

**Dependencies:**

- **Epic 9:** Authentication & Multi-tenancy (for API key validation)
- **Epic 13:** Capability Naming & Curation (for registry strategy decision)

### FR Coverage Map

| FR      | Epic    | Story       | Description                                           |
| ------- | ------- | ----------- | ----------------------------------------------------- |
| FR14-1  | Epic 14 | 14.1        | Package JSR installable via `deno install`            |
| FR14-2  | Epic 14 | 14.2        | Workspace resolution (ENV → detection → CWD)          |
| FR14-3  | Epic 14 | 14.3, 14.3b | Routing based on cloud config (cached locally)        |
| FR14-4  | Epic 14 | 14.4, 14.7  | Dynamic MCP import from unified registry              |
| FR14-5  | Epic 14 | 14.5        | Sandboxed local MCP execution                         |
| FR14-6  | Epic 14 | 14.1        | Forward cloud MCPs via HTTP RPC (from stdio)          |
| FR14-7  | Epic 14 | 14.6        | HTTP Streamable server (optional, for debug)          |
| FR14-8  | Epic 14 | 14.1        | BYOK support via local env vars                       |
| FR14-9  | Epic 14 | 14.1        | `.mcp.json` generation via `pml init` (stdio type)    |
| FR14-10 | Epic 14 | 14.4        | MCP code caching via Deno HTTP cache                  |
| FR14-11 | Epic 14 | 14.1        | Local and Cloud mode support (via stdio)              |
| FR14-12 | Epic 14 | 14.1        | Local API keys never stored on cloud                  |
| FR14-13 | Epic 14 | 14.10       | Standalone capability distribution (add/run/remove)   |
| FR14-14 | Epic 14 | 14.3b       | HIL approval flow via MCP response (stdio compatible) |

## Epic List

- **Epic 14**: JSR Package Local/Cloud MCP Routing

---

## Epic 14: JSR Package Local/Cloud MCP Routing

**Goal:** Implement a lightweight JSR package that routes MCP calls between local execution (user's
filesystem, shell, API keys) and cloud execution (PML gateway services), enabling users to leverage
cloud PML intelligence while maintaining local data sovereignty.

**Value Proposition:**

- Users can use cloud-hosted PML features (GraphRAG, DAG execution, search)
- While local MCPs (filesystem, shell) execute on user's machine with user's permissions
- BYOK model ensures user API keys never leave their machine (not stored on cloud)
- Single `deno install` + `pml init` setup experience

**Architecture Overview:**

```
Claude Code
    │ stdio (spawned automatically via .mcp.json)
    ▼
pml stdio (jsr:@casys/pml)
    │
    ├─► Load permissions (.pml.json)
    ├─► Check routing (cached from cloud)
    │
    ├─► Local MCPs (routing: local)
    │     └─► Sandboxed Deno execution with workspace-scoped permissions
    │     └─► Code loaded from: pml.casys.ai/mcp/{fqdn}
    │
    └─► Cloud MCPs (routing: cloud)
          └─► HTTP fetch to pml.casys.ai/mcp + BYOK injection
```

**Why stdio (not HTTP)?** Claude Code spawns MCP servers via stdio, not HTTP connections.
The `pml stdio` command is the primary interface. `pml serve` (HTTP) remains available
for debugging, dashboard integration, and non-Claude clients.

---

### Distribution Modes (Clarified 2025-01-06)

PML supports three distinct usage modes:

**Mode A: PML Toolkit (Meta-Tools Only)**
```
.mcp.json:
{
  "mcpServers": {
    "pml": { "command": "pml", "args": ["stdio"] }
  }
}

Claude sees:
├── pml:discover      ← Search capabilities
├── pml:execute       ← Run any capability
├── pml:create        ← Create new workflows
```
**Use case:** Developers who want full control - discovery, execution, workflow creation.

**Mode B: Standalone Capability (Direct MCP)**
```bash
# CLI command (terminal)
pml add namespace.action[@version]

# Examples:
pml add db.postgres_query           # latest par défaut
pml add db.postgres_query@latest    # explicit
pml add db.postgres_query@1.2.0     # version spécifique (future)
```
```
.mcp.json (auto-modified):
{
  "mcpServers": {
    "db_postgres_query": { "command": "pml", "args": ["run", "db.postgres_query"] }
  }
}

Claude sees:
├── db_postgres_query:run      ← Direct call, no wrapper
├── db_postgres_query:config   ← Capability config
```
**Use case:** Users who want ONE specific capability as a native MCP, without meta-layer.
**Note:** Requires Claude Code restart to load new capability.

**Mode C: Hybrid (Meta-Tools + Curated Caps) - TARGET END-USER MODE** ⚠️ BLOCKED
```
.mcp.json:
{
  "mcpServers": {
    "pml": { "command": "pml", "args": ["stdio"] }
  }
}

.pml.json:
{
  "expose_tools": {
    "mode": "hybrid",
    "curated_limit": 10
  }
}

Claude sees (dynamic, no restart needed):
├── pml:discover           ← Meta-tool
├── pml:execute            ← Meta-tool
├── pml:create             ← Meta-tool
├── pml:smartSearch        ← Curated capability (dynamic)
├── pml:db_query           ← Curated capability (dynamic)
├── pml:fs_read_json       ← Curated capability (dynamic)
```
**Use case:** End users who want both meta-tools AND direct access to most-used caps.
**Key advantage:** Curated list changes dynamically (via `tools/list_changed` notification).

⚠️ **BLOCKED:** Claude Code doesn't support `notifications/tools/list_changed` yet.
- See: [Issue #4118](https://github.com/anthropics/claude-code/issues/4118) (Open, no ETA)
- VSCode and Cursor already support it
- **Workaround:** Pre-load curated list at startup (requires restart for changes)
- See: `spike-2025-01-06-dynamic-tool-injection.md`

**Comparison:**
| Aspect | Mode A (Toolkit) | Mode B (Standalone) | Mode C (Hybrid) ⚠️ |
|--------|------------------|---------------------|---------------------|
| `.mcp.json` entries | 1 ("pml") | N (one per cap) | 1 ("pml") |
| Meta-tools | ✅ Yes | ❌ No | ✅ Yes |
| Direct cap access | ❌ Via execute | ✅ Native | ✅ Dynamic |
| Restart needed | For config | Per capability | ❌ No (dynamic) |
| Target user | Developer | Fixed workflow | End user |
| **Status** | ✅ Ready | ✅ Ready | ⚠️ Blocked (#4118) |

---

### Capability Bundling (Clarified 2025-01-05)

**Key Insight:** All Deno capabilities are **bundled** before distribution.

```
Source (with deps)              →    Bundle (self-contained)
─────────────────────────            ────────────────────────
import { z } from "zod";             // All deps inlined
import { Client } from "pg";         // Zero external imports
                                     // Pure Deno/TypeScript
export function query() {...}        export function query() {...}
```

**Why bundling matters:**
- ✅ Dynamic `import()` works without dependency resolution
- ✅ Deno caches the bundle natively (offline support)
- ✅ Immutable (content hash = identity)
- ✅ Fast loading (single file)

**What CAN'T be bundled:**
- Stdio MCP servers (e.g., `@modelcontextprotocol/server-memory`)
- These require installation + subprocess spawn

**Capability with stdio MCP deps:**
```json
{
  "fqdn": "casys.pml.myCapability",
  "type": "deno",
  "code_url": "https://pml.casys.ai/mcp/casys.pml.myCapability",
  "mcp_deps": [
    {
      "name": "memory",
      "type": "stdio",
      "install": "npx @modelcontextprotocol/server-memory@1.2.3",
      "version": "1.2.3",
      "integrity": "sha256-abc123..."
    }
  ]
}
```

**Security:** Version pinned + integrity hash vérifié à l'installation (comme npm).

**Installation flow (Story 14.4):**
1. Check si dep installée avec bonne version
2. Si non → HIL prompt: "Installer memory@1.2.3?"
3. Install + verify integrity hash
4. Execute capability

**Cleanup:** Les hashes des deps plus utilisées doivent être nettoyés périodiquement
(éviter le bloat). À gérer via `pml cleanup` ou automatiquement.

---

### Naming Convention (Consolidated 2026-01-06)

| Context | Format | Example |
|---------|--------|---------|
| **FQDN** (registry lookup) | org.project.namespace.action | `casys.pml.filesystem.read_file` |
| **Tool name** (config, Claude sees) | namespace:action | `filesystem:read_file` |
| **Code TS** (capability code) | mcp.namespace.action() | `mcp.filesystem.read_file()` |

**Rules:**
- FQDN = all dots (for registry URLs)
- Tool names = colon (MCP standard, what Claude displays)
- Code calls = dots with `mcp.` prefix (our internal DSL)

**No difference between capabilities and MCP servers** - same naming applies to both.

**Conversion:**
- FQDN → Tool: `casys.pml.filesystem.read_file` → `filesystem:read_file`
- Tool → Code: `filesystem:read_file` → `mcp.filesystem.read_file()`

---

### Routing = WHERE to Execute (Clarified 2026-01-06)

**Terminology:**
- `client` = runs on user's machine (dangerous tools: filesystem, docker, ssh)
- `server` = runs on pml.casys.ai (safe tools: json, math, tavily)

Routing determines **where** code executes:

```
Capability: "smartSearch"       Capability: "fileProcessor"
Routing: "server"               Routing: "client"
    │                               │
    ▼                               ▼
pml.casys.ai imports +          User's PML imports +
executes on server              executes on client
    │                               │
    ▼                               ▼
mcp.tavily.search → server      mcp.filesystem.read_file → local
```

**Same code, different execution context:**
- Code is fetched from same URL (`pml.casys.ai/mcp/{fqdn}`)
- Routing decides: execute on server OR on user's machine (client)
- `mcp.*` calls resolve differently based on context

**Config source:** `config/mcp-routing.json` (synced from server at startup)

---

### API Keys & BYOK (Clarified 2025-01-05)

**Two flows for API key management:**

**1. Standalone (`pml add`) - Option B: Warning**
```bash
pml add notion
# ⚠ notion requires:
#   - NOTION_API_KEY
# Add to .env before using.
# ✓ notion added.
```
Simple warning at install, error at runtime if missing.

**2. Execute (cloud PML toolkit) - HIL Pause**
```
mcp.pml.execute({ cap: "notion_search" })
    │
    ├─► notion_search needs NOTION_API_KEY
    │
    ├─► User has key configured on pml.casys.ai?
    │       Yes → execute
    │       No  → HIL PAUSE
    │             "Configure your API key: pml.casys.ai/settings/keys"
    │             [Continue] [Abort] [Replan]
    │
    │             User configures key online
    │             User clicks [Continue]
    │             │
    │             ▼
    └─► Resume execution (no retry needed)
```

**BYOK (Bring Your Own Key):**
- Local execution: PML reads keys from `.env`
- Cloud execution: Keys stored in user's cloud profile (pml.casys.ai/settings)
  → Cloud uses key one-shot, never in logs

**Stdio subprocess management (cloud):**
- Many MCPs are stdio even with APIs (notion, google-sheets, serena)
- Cloud must manage subprocess pool for concurrent calls
- See ADR-044 (JSON-RPC multiplexer) for multiplexing pattern
- Latency monitoring required

**Unified Registry (Story 13.8):**

```
pml.casys.ai/mcp/{fqdn}
        │
        ├─► Lookup in pml_registry table
        │     record_type = 'capability' | 'mcp-server'
        │
        ├─► If 'mcp-server' → serve native MCP code
        └─► If 'capability' → serve learned capability code (same MCP interface)

External clients see only standard MCP - internal distinction is transparent.
```

**Prerequisites:**

- Epic 9 (Authentication & Multi-tenancy) for API key validation
- Epic 13 (Capability Naming & Curation) for final registry strategy

---

### Story 14.1: Package Scaffolding & CLI Commands (init, stdio)

As a developer, I want to install the PML package with a single command and initialize my project,
So that I can start using PML with minimal setup friction.

**Acceptance Criteria:**

**AC1-2 (Installation):**

**Given** a developer with Deno installed **When** they run `deno install -A -n pml jsr:@casys/pml`
**Then** the `pml` command is available globally **And** the package size is under 50KB

**AC3-4 (Init Command):**

**Given** a developer in their project directory **When** they run `pml init` **Then** they are
prompted for their PML API key (or can skip for local-only mode) **And** a `.mcp.json` file is
generated with the PML server configuration (stdio type) **And** a `.pml.json` config file is
created with workspace and cloud URL settings

**Given** an existing `.mcp.json` file **When** running `pml init` **Then** the system asks for
confirmation before modifying **And** backs up the original file to `.mcp.json.backup`

**AC5-7 (Stdio Command - Primary Interface):**

**Given** a `.mcp.json` configuration:
```json
{
  "pml": {
    "type": "stdio",
    "command": "pml",
    "args": ["stdio"],
    "env": {
      "PML_WORKSPACE": "${workspaceFolder}",
      "TAVILY_API_KEY": "${TAVILY_API_KEY}"
    }
  }
}
```
**When** Claude Code starts **Then** it spawns `pml stdio` as a subprocess **And** communicates
via stdin/stdout JSON-RPC

**Given** `pml stdio` is running **When** it receives a JSON-RPC request **Then** it:
1. Loads permissions from `.pml.json`
2. Checks routing (from cached cloud config)
3. Routes to local sandbox OR forwards to cloud via HTTP
4. Returns JSON-RPC response via stdout

**Given** `pml stdio` is running **When** the cloud is unreachable **Then** local MCPs continue
to work **And** cloud MCPs return clear offline error messages

---

### Story 14.2: Workspace Resolution System

As a developer, I want PML to automatically detect my project workspace, So that file operations are
correctly scoped without manual configuration.

**Acceptance Criteria:**

**Given** the environment variable `PML_WORKSPACE` is set **When** the PML package starts **Then**
it uses that path as the workspace root

**Given** no `PML_WORKSPACE` env var **When** the PML package starts from a directory with `.git`,
`deno.json`, or `package.json` **Then** it traverses up to find the project root containing these
markers **And** uses that as the workspace

**Given** no env var and no project markers found **When** the PML package starts **Then** it falls
back to the current working directory **And** logs a warning suggesting explicit configuration

**Given** a resolved workspace path **When** any local MCP requests a file operation **Then** the
path is validated to be within the workspace **And** operations outside workspace are rejected with
clear error message

**Given** a `.pml.json` file exists in the workspace **When** PML loads permissions **Then** the
user's `permissions` section (`allow`/`deny`/`ask`) is used as THE source of truth **And** our
default `config/mcp-permissions.json` is NOT used as fallback **And** only the user's config
determines HIL behavior

---

### Story 14.3: Routing Configuration & Permission Inferrer Integration

As a platform maintainer, I want MCP routing decisions based on declarative configuration, So that
routing logic is consistent and auditable.

**Note (2025-12-30):** The original routing AC (schema extension, `getToolRouting()`) was implemented
in Story 13.9 (`src/capabilities/routing-resolver.ts`, `config/mcp-routing.json`). Story 14.3 now
focuses on PML package integration and capability permission inference.

**Acceptance Criteria:**

**AC1-3 (Routing - DONE via Story 13.9, Updated 2025-01-06):**

~~**Given** the existing `mcp-permissions.yaml` configuration **When** the schema is extended **Then**
each MCP entry supports a `routing: client | server` field **And** the default is `client` if not
specified~~ → **DONE:** `config/mcp-routing.json` exists with explicit client/server lists.

**Terminology (2025-01-06):**
- `client` = runs on user's machine (filesystem, docker, ssh, etc.)
- `server` = runs on pml.casys.ai (json, math, tavily, etc.)
- `default: "client"` = unknown tools run on client (safe)

~~**Given** the PermissionInferrer module **When** a new function `getToolRouting(mcpName: string)` is
called **Then** it returns the routing mode from configuration **And** caches the result for
performance~~ → **DONE:** `src/capabilities/routing-resolver.ts:getToolRouting()`

~~**Given** the default routing config **When** tool calls are processed **Then** each is routed
according to its configuration~~ → **DONE:** `resolveRouting()` with cache + pattern matching.

**AC4-6 (NEW - PML Package Integration + Permission Inference):**

**Given** the PML package (`packages/pml`) **When** it needs to determine routing **Then** it has an
embedded routing resolver matching `config/mcp-routing.json` **And** returns `"client"` for unknown
tools (security-first)

**Given** a capability with `tools_used = ["filesystem:read", "tavily:search"]` **And** user's
permissions from `.pml.json`: `{ allow: ["tavily:*"], ask: ["filesystem:*"] }` **When**
`inferCapabilityApprovalMode(toolsUsed, permissions)` is called **Then** it returns `"hil"` because
`filesystem:read` requires ask

**Given** a capability's tools_used list **When** inferring approval mode at runtime **Then** the
following precedence applies:
  1. If ANY tool is `denied` → throw error (capability blocked)
  2. If ANY tool is `ask` → return `"hil"`
  3. If ALL tools are `allow` → return `"auto"`
  4. Unknown tools → `"hil"` (safe default)

**Key Insight:** `routing` is platform-defined (stored in DB), `approval_mode` is user-specific
(computed at runtime from `tools_used` + user's `.pml.json` permissions)

**AC7-8 (NEW - "Always Approve" HIL Option):** `[VALIDATE]`

**Given** a tool call triggers HIL (permission is `ask`) **When** the user is prompted **Then**
the dialog offers three options: `[Yes]` `[Always]` `[No]` **And** "Always" adds the tool pattern
to the user's `allow` list in `.pml.json`

**Given** user selects "Always" for `serena:analyze` **When** the permission is persisted **Then**
`.pml.json` is updated: `{ "permissions": { "allow": [..., "serena:analyze"] } }` **And** future
calls to `serena:analyze` skip HIL **And** other `serena:*` tools still require approval

**Technical Note:**
> The "Always" option persists the specific tool (e.g., `serena:analyze`), not the namespace.
> Users can manually edit `.pml.json` to use wildcards (`serena:*`) if they want broader approval.

---

### Story 14.3b: HIL Approval Flow for Stdio Mode

As a developer using PML via Claude Code, I want dependency installation approval to work
seamlessly through Claude's native UI, So that I can approve, always-approve, or abort
without breaking the JSON-RPC protocol.

**Context (2026-01-06):**

Story 14.4 implemented HIL as a blocking callback (`await hilCallback(prompt)`), but this
doesn't work in stdio mode because stdin is used for JSON-RPC, not user input. This story
implements the correct pattern: return `approval_required` in the MCP response, let Claude
show [Continue] [Always] [Abort], then handle the `continue_workflow` callback.

**Acceptance Criteria:**

**AC1-2 (Approval Required Response):**

**Given** a tool call for a capability with uninstalled dependencies **And** the tool
permission is "ask" (not in allow list) **When** PML processes the request **Then** it
returns an MCP response with `approval_required: true` and `approval_context` containing
the dependency info and a unique `workflow_id` for continuation.

**Given** Claude Code receives an `approval_required` response **Then** it shows the native
[Continue] [Always] [Abort] UI to the user.

**AC3-4 (Continue Workflow Handling):**

**Given** user clicks [Continue] or [Always] **When** Claude calls back with
`continue_workflow: { workflow_id, approved: true, always: boolean }` **Then** PML proceeds
with dependency installation and executes the original tool call.

**Given** `always: true` in the continue_workflow request **When** PML processes it **Then**
it adds the tool to the user's `allow` list in `.pml.json` before proceeding.

**AC5-6 (Auto-Approve for Allowed Tools):**

**Given** a tool is in the user's `allow` list (e.g., `filesystem:*`) **When** it requires
dependency installation **Then** installation proceeds automatically without
`approval_required` response.

**Given** a tool is in the user's `deny` list **When** called **Then** PML returns an error
immediately without attempting installation.

**AC7-8 (Workflow Expiration):**

**Given** an `approval_required` response was sent **When** no `continue_workflow` is
received within 5 minutes **Then** the workflow expires and subsequent continuation
attempts return an error.

**Implementation:** See `14-3b-hil-approval-flow.md` for detailed tasks and dev notes.

---

### Story 14.4: Dynamic MCP Gateway with On-Demand Installation

As a developer, I want all MCPs (Deno, npm/stdio, cloud) to load automatically when first used,
So that I don't have to manually configure or install each MCP.

**Vision:** `[VALIDATE]`

PML acts as a **unified MCP gateway**. Claude Code connects to ONE MCP server (`pml`), and PML
handles all routing, installation, and execution behind the scenes. Installation is invisible -
it's just a side-effect of the first approved tool call.

```
Claude: serena:analyze(...)
    │
    ▼
PML: Check permissions → "ask" → HIL prompt
    │
    ▼ (User approves)
    │
PML: (invisible) Check if installed → No → Install via registry metadata
    │
    ▼
PML: Spawn subprocess / import module → Execute → Return result
```

**Acceptance Criteria:**

**AC1-2 (Multi-Type Registry Lookup):** `[VALIDATE]`

**Given** any tool call (e.g., `serena:analyze`, `filesystem:read`, `tavily:search`) **When** PML
receives the call **Then** it fetches from `pml.casys.ai/mcp/{fqdn}` **And** handles the response
based on content-type (TypeScript code for deno, JSON metadata for stdio/cloud)

**Given** a Deno MCP (e.g., `filesystem`) **When** fetched from `pml.casys.ai/mcp/filesystem`
**Then** the response is TypeScript code (content-type: application/typescript) **And** Deno
dynamically imports it directly **And** caches via Deno's native HTTP cache

**Given** a stdio MCP (e.g., `serena`) **When** fetched from `pml.casys.ai/mcp/serena` **Then**
the response is JSON metadata (content-type: application/json) with `install` instructions **And**
PML spawns the subprocess using the install command **And** manages the stdio connection

**Given** a cloud MCP (e.g., `tavily`) **When** fetched from `pml.casys.ai/mcp/tavily` **Then**
the response is JSON metadata with `proxy_to` URL **And** PML proxies requests to cloud with BYOK

**AC3-4 (Invisible Installation):**

**Given** a tool call for an MCP not yet installed/loaded **When** the user approves the action
(or it's in `allow` list) **Then** installation happens automatically before execution **And** no
separate "install" prompt is shown **And** the user only sees the tool result

**Given** an MCP requires environment variables (e.g., `ANTHROPIC_API_KEY` for Serena) **When**
the variable is missing **Then** a clear error is shown: "serena requires ANTHROPIC_API_KEY"
**And** instructions to set it are provided

**AC5-6 (Process Management):**

**Given** a stdio MCP subprocess is spawned **When** it's idle for >5 minutes **Then** PML may
terminate it to save resources **And** respawns on next call (transparent to user)

**Given** multiple concurrent calls to the same stdio MCP **When** processed **Then** they share
the same subprocess connection **And** use JSON-RPC multiplexing (ADR-044 pattern)

**AC7-8 (Caching & Offline):**

**Given** a Deno MCP module was previously imported **When** called again **Then** no network
request is made (Deno cache) **And** execution is instant

**Given** registry is unreachable **When** a Deno MCP is cached locally **Then** execution proceeds
offline **And** a warning is logged

**Given** registry is unreachable **When** a stdio MCP needs installation **Then** an error is
returned with instructions to restore connectivity

**Technical Notes:**

> This story transforms PML from a simple router to a **unified MCP gateway** that handles all
> MCP types transparently. The registry (Story 14.7) provides metadata for each type. Installation
> is never a user-facing action - it's an implementation detail of "making the tool work."
>
> **Key Insight:** Users don't "install MCPs" - they "use tools". Installation is invisible.

---

### Story 14.5: Sandboxed Local MCP Execution

As a security-conscious developer, I want local MCPs to execute with minimal permissions, So that
malicious or buggy code cannot compromise my system.

**Acceptance Criteria:**

**Given** a `filesystem:read_file` call **When** executed in the sandbox **Then** only
`--allow-read=${WORKSPACE}` permission is granted **And** reads outside workspace fail with
permission error

**Given** a `filesystem:write_file` call **When** executed in the sandbox **Then** both
`--allow-read=${WORKSPACE}` and `--allow-write=${WORKSPACE}` are granted **And** writes outside
workspace fail with permission error

**Given** a `shell:exec` call **When** executed in the sandbox **Then** `--allow-run` is granted for
the subprocess **And** the working directory is set to the workspace **And** HIL (Human-in-the-Loop)
approval is required per existing Epic 2.5 patterns (verify implementation)

**Given** any local MCP execution **When** it attempts network access **Then** the request is
blocked unless explicitly configured **And** an error explains that local MCPs are network-isolated

**Given** sandbox execution options **When** choosing implementation approach **Then** prefer Deno
Worker with `permissions: { read: [workspace], write: [workspace] }` **And** fallback to subprocess
with explicit `--allow-*` flags if Worker is insufficient

**Technical Notes:**

- HIL integration needs verification (existing technical debt)
- Users may want broader permissions than workspace - should be configurable
- **Critical Invariant:** Local execution NEVER goes to cloud server

---

### Story 14.6: MCP HTTP Streamable Server & BYOK Injection (Optional/Debug)

As a developer or platform operator, I want PML to optionally expose an HTTP MCP endpoint,
So that I can debug, test, or integrate with non-Claude clients (dashboards, scripts).

**Note:** The primary interface is `pml stdio` (Story 14.1). This HTTP server is for:
- Debugging and testing MCP calls
- Dashboard/web UI integration
- Non-Claude MCP clients that prefer HTTP

**Acceptance Criteria:**

**Given** the `.mcp.json` configuration generated by `pml init`:

```json
{
  "pml": {
    "type": "http",
    "url": "http://localhost:3003/mcp",
    "env": {
      "PML_API_KEY": "${PML_API_KEY}",
      "TAVILY_API_KEY": "${TAVILY_API_KEY}",
      "AIRTABLE_API_KEY": "${AIRTABLE_API_KEY}",
      "EXA_API_KEY": "${EXA_API_KEY}"
    }
  }
}
```

**When** `pml serve` is running **Then** an HTTP server listens on `localhost:PORT/mcp` **And**
supports MCP HTTP Streamable transport (ADR-025)

**Given** Claude Code sends a tool call via HTTP **When** the tool is a local MCP (filesystem,
shell) **Then** PML routes to sandboxed local execution **And** returns the result via HTTP
streaming

**Given** Claude Code sends a tool call via HTTP **When** the tool is a server MCP (pml:search,
GraphRAG, tavily) **Then** PML forwards via HTTP to `pml.casys.ai/mcp` **And** injects BYOK API keys
from local environment **And** returns the result via HTTP streaming

**Given** a required API key is not set locally **When** a cloud MCP requiring that key is called
**Then** a clear error indicates which env var is missing **And** provides instructions for setting
it

**Given** local mode (no `PML_API_KEY` set) **When** attempting cloud MCP calls **Then** an error is
returned: "Cloud mode requires PML_API_KEY" **And** only local MCPs are available

**Given** multiple rapid tool calls **When** processed by the HTTP server **Then** they are handled
concurrently where possible **And** the JSON-RPC multiplexer pattern (ADR-044) is applied

**Given** a local MCP sends `sampling/createMessage` (agent tools) **When** the package receives the
request **Then** it routes to configured LLM API (Anthropic, OpenAI via BYOK keys) **And** executes
the agentic loop with tool filtering per `allowedToolPatterns` **And** returns the result to the MCP
server **And** see `lib/README.md` "Agent Tools & MCP Sampling" section

**Technical Note (2024-12-24):**

> MCP SDK's `server.createMessage()` relay approach was tested but doesn't work with HTTP transport.
> The SDK expects a persistent stdio bidirectional channel for sampling relay. With HTTP Streamable
> transport, the sampling requests must go through direct cloud API calls (Anthropic API with BYOK
> keys) rather than relying on MCP protocol relay. See `src/mcp/sampling/` for the stdio relay
> implementation (works for stdio connections only).

---

### Story 14.7: MCP Registry Endpoint with Multi-Type Support (Server-Side)

As a platform operator, I want the PML cloud to expose a unified `/mcp/{fqdn}` endpoint that
serves both metadata and code for all MCP types, So that the local package can transparently
load any MCP.

**Vision:** `[VALIDATE]`

Single endpoint, single request. The package calls `/mcp/{fqdn}` and gets everything it needs:
- For Deno MCPs: Returns the module code directly (importable)
- For stdio/cloud MCPs: Returns metadata with install instructions

The package handles the response based on content-type or embedded metadata. No separate
"metadata fetch then code fetch" - it's invisible.

**Acceptance Criteria:**

**AC1-3 (Unified Endpoint - Type Detection):** `[VALIDATE]`

**Given** a request to `pml.casys.ai/mcp/filesystem` (type: deno) **When** the endpoint processes
it **Then** it returns the Deno module code directly **And** the code exports metadata as comments
or a `__meta__` export:
```typescript
// __meta__: { "type": "deno", "tools": ["filesystem:read_file", ...], "routing": "client" }
export async function read_file(args: { path: string }) { ... }
export async function write_file(args: { path: string, content: string }) { ... }
```

**Given** a request to `pml.casys.ai/mcp/serena` (type: stdio) **When** the endpoint processes it
**Then** it returns JSON metadata (content-type: application/json):
```json
{
  "fqdn": "serena",
  "type": "stdio",
  "description": "Code analysis and refactoring",
  "install": {
    "command": "npx",
    "args": ["@anthropic/serena"],
    "env_required": ["ANTHROPIC_API_KEY"]
  },
  "tools": ["serena:analyze", "serena:refactor", "serena:explain"],
  "warnings": { "creates_dotfiles": [".serena"] },
  "routing": "client"
}
```

**Given** a request to `pml.casys.ai/mcp/tavily` (type: cloud) **When** the endpoint processes it
**Then** it returns JSON metadata:
```json
{
  "fqdn": "tavily",
  "type": "cloud",
  "description": "Web search API",
  "proxy_to": "https://pml.casys.ai/mcp/proxy/tavily",
  "tools": ["tavily:search"],
  "env_required": ["TAVILY_API_KEY"],
  "routing": "server"
}
```

**AC4-5 (Capability Records & 404):**

**Given** a request to `pml.casys.ai/mcp/casys.pml.fs.read_json` (learned capability) **When** the endpoint
processes it **Then** it returns Deno module code (same as native MCP) **And** the capability is
indistinguishable from a native MCP

**Given** an unknown FQDN **When** requested **Then** a 404 JSON error is returned:
`{ "error": "not_found", "message": "MCP 'unknown' not in registry" }`

**AC6-7 (Caching & Content Negotiation):**

**Given** any MCP request **When** served **Then** appropriate HTTP cache headers are set
(`Cache-Control`, `ETag`) **And** Deno can cache the response locally

**Given** a Deno MCP **When** served **Then** content-type is `application/typescript` **And** the
module is self-contained with `https://` imports

**AC8 (Catalog Listing):**

**Given** a request to `pml.casys.ai/mcp` (no fqdn) **When** processed **Then** it returns a
paginated list of all available MCPs with `fqdn`, `type`, `description` for each

**Technical Notes:**

> Single endpoint simplifies the package - just `import()` or `fetch()` the same URL.
> Content-type tells the package how to handle the response:
> - `application/typescript` → Deno import
> - `application/json` → Parse metadata, spawn subprocess or proxy
>
> **Schema Evolution:** The `pml_registry` table (Story 13.8) needs new columns:
> - `type: "deno" | "stdio" | "cloud"`
> - `install_command`, `install_args` (for stdio)
> - `proxy_to` (for cloud)
> - `env_required` (array of required env var names)
> - `warnings` (JSON for dotfiles, etc.)

**Dependencies:**

- Story 13.8: Unified PML Registry (`pml_registry` table - needs schema extension)
- Story 13.9: Routing Inheritance (`routing` field populated)

---

### Story 14.8: E2E Integration Testing

As a quality engineer, I want comprehensive end-to-end tests for the local/cloud routing, So that we
can confidently release the package.

**Acceptance Criteria:**

**Given** a test environment with mock cloud server **When** running `pml init` → `pml serve` →
Claude Code simulation **Then** the full flow completes without errors **And** both local and cloud
MCPs are exercised

**Given** a local filesystem MCP test **When** reading a file within workspace **Then** content is
returned correctly **And** execution stays within sandbox permissions

**Given** a server MCP test (e.g., `pml:search_tools`) **When** called via the local package **Then**
the request is forwarded to cloud **And** results are returned through HTTP

**Given** offline mode simulation **When** cloud is unreachable but cache exists **Then** local MCPs
continue to function **And** cloud MCPs return appropriate offline errors

**Given** permission boundary tests **When** attempting file access outside workspace **Then** the
operation is blocked **And** security audit log captures the attempt

---

### Story 14.9: Private/Custom MCP Registration `[VALIDATE]`

As a power user or enterprise, I want to register private MCP servers with PML, So that I can use
internal tools through the same unified gateway without manual configuration.

**Context (Updated with new vision):**

With Stories 14.1-14.8, PML acts as a **unified MCP gateway** where all MCPs are discovered from
the registry and installed on-demand. This story extends that model to support private MCPs.

**Key Principle:** Users don't configure MCPs manually - they register them (once) and then use
them like any other MCP.

**Options for Private MCPs:** `[VALIDATE]`

| Option | Description | Effort |
|--------|-------------|--------|
| **A: Local Registry Override** | `.pml.json` can define private MCPs with same schema as registry | Low |
| **B: Private Registry URL** | Enterprise can host their own registry at `mcp.company.com` | Medium |
| **C: Submit to PML Registry** | Community MCPs go through PR/approval to main registry | Low (for us) |

**Acceptance Criteria (Option A - Local Override):**

**Given** a `.pml.json` with private MCP definitions:
```json
{
  "permissions": { "allow": ["*"], "ask": [], "deny": [] },
  "private_mcps": {
    "internal-db": {
      "type": "stdio",
      "install": { "command": "npx", "args": ["@company/internal-db-mcp"] },
      "tools": ["internal_db:query", "internal_db:migrate"]
    }
  }
}
```
**When** `internal_db:query` is called **Then** PML uses the local definition **And** installs
on-demand like registry MCPs

**Given** a private MCP name conflicts with a registry MCP **When** the tool is called **Then**
the private MCP takes precedence (local override) **And** a debug log notes the override

**Given** a private MCP **When** permissions are checked **Then** the same `allow/ask/deny` rules
apply **And** HIL works identically to registry MCPs

**Acceptance Criteria (Option B - Private Registry, if needed):**

**Given** a `.pml.json` with private registry URL:
```json
{
  "registries": [
    "https://pml.casys.ai/registry",
    "https://mcp.company.internal/registry"
  ]
}
```
**When** an unknown MCP is called **Then** PML checks registries in order **And** uses first match

**Technical Notes:**

> This story is **lower priority** than 14.1-14.8. Most users will use registry MCPs. Private MCPs
> are for enterprises with internal tools.
>
> **Recommendation:** Start with Option A (local override in `.pml.json`) - it's simple and covers
> most use cases. Option B (private registry) can be added later for large enterprises.
>
> **No more `.mcp-servers.json`** - all configuration lives in `.pml.json` for simplicity.

**Dependencies:**

- Stories 14.1-14.8 (complete Epic 14 foundation)

---

### Story 14.10: Standalone Capability Distribution (add/run/remove)

As an end user, I want to install specific capabilities as native MCP servers for Claude,
So that I can use them directly without the full PML meta-tools overhead.

**Context:**

This is the "Docker model" for capabilities:
- `pml add <cap>` = install capability as standalone MCP server
- `pml run <cap>` = start capability as MCP server (for .mcp.json)
- `pml remove <cap>` = uninstall capability
- `pml list` = list installed standalone capabilities

**Note:** Standalone mode does NOT require `PML_API_KEY`. Capabilities are fetched once from registry during `pml add` and cached locally. Unlike `pml stdio` (cloud mode), standalone capabilities run fully offline after installation.

**Acceptance Criteria:**

**AC1-2 (Add Command):**

**Given** a user runs `pml add smartSearch` **When** the capability exists in registry **Then**:
1. Capability code is fetched and cached locally
2. Stdio MCP deps (if any) are installed automatically
3. `.mcp.json` is updated to add the capability as a server:
```json
{
  "mcpServers": {
    "smartSearch": {
      "type": "stdio",
      "command": "pml",
      "args": ["run", "smartSearch"]
    }
  }
}
```
4. Success message: "✓ smartSearch added. Restart Claude Code to use."

**Given** a capability has stdio MCP dependencies **When** `pml add` is run **Then**:
1. Dependencies are listed: "smartSearch requires: memory, filesystem"
2. Each dep is installed (npx, pip, etc.)
3. Missing env vars are reported: "⚠ Set ANTHROPIC_API_KEY for serena"

**AC3-4 (Run Command):**

**Given** a `.mcp.json` with `"args": ["run", "smartSearch"]` **When** Claude Code starts **Then**:
1. PML spawns as stdio server for "smartSearch" capability
2. Dynamic imports the capability code from cache (or fetches if needed)
3. Exposes capability tools as native MCP tools
4. Routes internal `mcp.*` calls to appropriate MCPs (local or cloud)

**Given** `pml run smartSearch` is executed **When** capability has stdio deps **Then**:
1. Required stdio MCPs are spawned as subprocesses
2. `mcp.memory.create_entities()` calls route to memory subprocess
3. Subprocess lifecycle is managed (spawn on first call, idle timeout)

**AC5-6 (Remove & List Commands):**

**Given** `pml remove smartSearch` is run **When** capability is installed **Then**:
1. Entry is removed from `.mcp.json`
2. Local cache is optionally cleaned (`--clean` flag)
3. Stdio deps are NOT removed (might be used by other caps)

**Given** `pml list` is run **Then** output shows:
```
Installed capabilities:
  smartSearch     (cloud)    mcp.smartSearch.*
  fileProcessor   (local)    mcp.fileProcessor.*

PML meta-tools: enabled (mcp.pml.*)
```

**AC7-8 (Dynamic Import & Execution):**

**Given** `pml run <cap>` starts **When** loading capability **Then**:
```typescript
// Dynamic import from registry (or cache)
const cap = await import(`https://pml.casys.ai/mcp/${capName}.ts`);

// Expose as MCP server
server.addTool("run", cap.run);
server.addTool("config", cap.config);
```

**Given** capability code calls `mcp.X.action()` **When** executed **Then**:
1. PML intercepts the call
2. Resolves X to appropriate MCP (local subprocess, cloud HTTP, or another capability)
3. Returns result transparently

**Technical Notes:**

> **Standalone ≠ Isolated**: Standalone capabilities still need PML runtime for:
> - Resolving `mcp.*` calls
> - Managing stdio subprocess deps
> - Routing to cloud MCPs
>
> "Standalone" means: exposed as native MCP to Claude, not wrapped in `pml.execute()`.
>
> **Analogy:**
> - `docker run nginx` = standalone container, but needs Docker daemon
> - `pml run smartSearch` = standalone capability, but needs PML runtime

**Dependencies:**

- Story 14.4: Dynamic import infrastructure
- Story 14.7: Registry endpoint for capability code

---

### Story 14.11: Binary Distribution via Deno Compile

As an end user, I want to install PML as a standalone binary without any runtime dependencies,
So that I can use it immediately without installing Deno, Node, or any other prerequisite.

**Context:**

`deno compile` bundles the Deno runtime into a single executable (~80-100MB). Users download one file and it works. No `deno install`, no `npm install`, no runtime version conflicts.

**Distribution Channels:**
- Direct download from `pml.casys.ai/install.sh`
- GitHub Releases (Linux x64, macOS x64/arm64, Windows x64)
- Homebrew tap (macOS): `brew install casys/tap/pml`

**Acceptance Criteria:**

**AC1-2 (Cross-Platform Compilation):**

**Given** the PML source code
**When** CI/CD runs on release
**Then** it compiles binaries for:
- `pml-linux-x64`
- `pml-macos-x64`
- `pml-macos-arm64`
- `pml-windows-x64.exe`
**And** each binary is self-contained (no external dependencies)

**Given** a compiled binary
**When** user runs `./pml --version`
**Then** it shows version without requiring Deno installed

**AC3-4 (Installation Script):**

**Given** a user on Linux/macOS
**When** they run `curl -fsSL https://pml.casys.ai/install.sh | sh`
**Then** the script:
1. Detects OS and architecture
2. Downloads correct binary from GitHub Releases
3. Installs to `~/.pml/bin/pml` (or `/usr/local/bin` with sudo)
4. Adds to PATH if needed
5. Prints success: "✓ PML installed. Run 'pml init' to get started."

**Given** a Windows user
**When** they download `pml-windows-x64.exe`
**Then** they can run it directly or add to PATH manually

**AC5-6 (Self-Update):**

**Given** PML is installed
**When** user runs `pml upgrade`
**Then** it:
1. Checks latest version from GitHub Releases API
2. If newer, downloads new binary
3. Replaces current binary atomically
4. Prints: "✓ Upgraded from v1.0.0 to v1.1.0"

**Given** PML is already latest version
**When** user runs `pml upgrade`
**Then** it prints: "✓ Already up to date (v1.1.0)"

**AC7-8 (CI/CD Pipeline):**

**Given** a git tag `v*` is pushed
**When** GitHub Actions runs
**Then** it:
1. Runs `deno compile` for each platform
2. Creates GitHub Release with all binaries
3. Updates `install.sh` with latest version
4. Optionally updates Homebrew formula

**Technical Notes:**

> **Binary size:** ~80-100MB is acceptable for dev tools (VS Code is 300MB+)
>
> **Compilation command:**
> ```bash
> deno compile --allow-all --target x86_64-unknown-linux-gnu --output dist/pml-linux-x64 src/cli/mod.ts
> deno compile --allow-all --target x86_64-apple-darwin --output dist/pml-macos-x64 src/cli/mod.ts
> deno compile --allow-all --target aarch64-apple-darwin --output dist/pml-macos-arm64 src/cli/mod.ts
> deno compile --allow-all --target x86_64-pc-windows-msvc --output dist/pml-windows-x64.exe src/cli/mod.ts
> ```
>
> **Worker sandbox still works:** The compiled binary includes Deno runtime, so Deno Worker with permissions works as expected.

**Dependencies:**

- Story 14.1: CLI structure and commands
- Stories 14.1-14.8: Complete functionality to compile

---

## Technical Notes

### Package Structure

```
packages/pml/
├── deno.json           # JSR config
├── mod.ts              # Entry point
├── src/
│   ├── cli/
│   │   ├── mod.ts          # CLI entry (Cliffy)
│   │   ├── stdio-command.ts # Primary interface for Claude Code
│   │   └── serve-command.ts # HTTP server (debug/dashboard)
│   ├── routing/
│   │   ├── mod.ts          # Exports
│   │   ├── resolver.ts     # Client/Server routing
│   │   ├── cache.ts        # Local config cache
│   │   └── sync.ts         # Sync config from server
│   ├── permissions/        # User permission loading
│   └── workspace.ts        # Workspace resolution
└── README.md
```

### Key Dependencies

- `@cliffy/command` - CLI framework
- Deno native `Worker` API - Sandbox isolation
- Deno native `fetch` - Server RPC calls + registry fetching
- Story 13.8 - `pml_registry` table for unified MCP/capability storage
- Story 13.9 - `routing` field for client/server decisions

### Related ADRs

- ADR-025: MCP Streamable HTTP Transport
- ADR-040: Multi-tenant MCP & Secrets Management
- ADR-044: JSON-RPC Multiplexer

### Unified Registry Endpoint

All MCP code (native servers AND learned capabilities) served from single endpoint:

```
pml.casys.ai/mcp/{fqdn}

Examples:
  /mcp/filesystem        → Native MCP server code
  /mcp/casys.pml.fs.read_json      → Learned capability (same MCP interface)
  /mcp/casys.pml.data.transform    → Learned capability
```

Internal distinction via `pml_registry.record_type`:
- `mcp-server` - Native MCP server implementations
- `capability` - Learned capabilities wrapped as MCP

External clients see only standard MCP protocol - no distinction visible.

---

## Related Improvements (Post Story 13.8)

### Use `pml_registry` VIEW for Unified Tool/Capability Lookup

**Context:** When SWC parses `mcp.namespace.action()`, we need to determine if it's:
- A real MCP tool (in `tool_schema`)
- Or a learned capability (in `capability_records`)

**Current State:** Code in `capability-store.ts:422-438` queries only `capability_records`:

```typescript
const capResult = await this.db.query(
  `SELECT wp.pattern_id, cr.hierarchy_level
   FROM workflow_pattern wp
   INNER JOIN capability_records cr ON cr.workflow_pattern_id = wp.pattern_id
   WHERE (cr.namespace = $1 AND cr.action = $2)
      OR (cr.namespace || ':' || cr.action) = $3`,
  [namespace, action, toolId],
);
```

**Proposed Improvement:** Use `pml_registry` VIEW (Story 13.8) for unified lookup:

```sql
SELECT record_type, id, name, routing
FROM pml_registry
WHERE name = $1 OR id = $1
LIMIT 1
```

The `record_type` field (`'mcp-tool'` | `'capability'`) directly tells us the type.

**Files to update:**
- `src/capabilities/capability-store.ts:422-438` - dependency tracking
- `src/capabilities/code-transformer.ts:101-102` - capability resolution
- `src/capabilities/schema-inferrer.ts:427-429` - schema lookup

**Benefits:**
- Single query instead of separate table checks
- Consistent behavior for MCP tools and capabilities
- `routing` field available for local/cloud decisions
- Cleaner code, less fallback logic

---

## Open Questions (Resolved)

1. **Registry Strategy**: ✅ Resolved - Unified `pml.casys.ai/mcp/{fqdn}` endpoint (not JSR)
2. **Versioning**: Handled via `pml_registry.version` and `version_tag` fields
3. **Custom MCPs**: ✅ Deferred to Story 14.9 - `.mcp-servers.json` parked (gitignored) until 14.1-14.8 complete
4. **Offline Fallback**: Deno HTTP cache + optional pre-bundled essential MCPs in package
5. **Organization**: User's GitHub username (can have multiple projects under it)
6. **Routing Decision**: ✅ Platform decides, not user. See below.

---

## Routing Architecture (Platform Decision)

**Who decides routing?** → **Us (platform)**, not the user.

The `routing` field in `tool_schema` is set by **us** when we seed MCPs. Users cannot change it.

### Routing Rules (Updated 2025-01-06)

| Routing | Critère | Exemples |
|---------|---------|----------|
| **client** | MUST access user's workspace/files | `filesystem`, `shell`, `docker`, `ssh`, `git` |
| **server** | API-based, can proxy or BYOK | `tavily`, `github`, `slack`, `json`, `math`, `pml:*` |

**Config source:** `config/mcp-routing.json` (synced from server, NO hardcoded fallback)

### What the user controls

| User Config | Purpose |
|-------------|---------|
| `.pml.json` permissions | `allow/deny/ask` - HIL behavior |
| `.env` API keys | BYOK for server MCPs (TAVILY_API_KEY, etc.) |

### What the user does NOT control

- `routing` field - fixed by platform
- Which MCPs are client vs server - platform decision
- MCP code source - always from `pml.casys.ai/mcp/{fqdn}`

### Server MCP Flow (BYOK)

```
User calls tavily:search
    │
    ├─► PML package reads TAVILY_API_KEY from user's .env
    │
    ├─► Forwards request to pml.casys.ai with BYOK injection
    │
    └─► Cloud executes with user's API key (never stored)
```
