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
- **FR14-6:** The system must forward cloud MCPs (pml:search, GraphRAG, tavily) via HTTP RPC to
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

| FR      | Epic    | Story      | Description                                           |
| ------- | ------- | ---------- | ----------------------------------------------------- |
| FR14-1  | Epic 14 | 14.1       | Package JSR installable via `deno install`            |
| FR14-2  | Epic 14 | 14.2       | Workspace resolution (ENV → detection → CWD)          |
| FR14-3  | Epic 14 | 14.3       | Routing based on cloud config (cached locally)        |
| FR14-4  | Epic 14 | 14.4, 14.7 | Dynamic MCP import from unified registry              |
| FR14-5  | Epic 14 | 14.5       | Sandboxed local MCP execution                         |
| FR14-6  | Epic 14 | 14.1       | Forward cloud MCPs via HTTP RPC (from stdio)          |
| FR14-7  | Epic 14 | 14.6       | HTTP Streamable server (optional, for debug)          |
| FR14-8  | Epic 14 | 14.1       | BYOK support via local env vars                       |
| FR14-9  | Epic 14 | 14.1       | `.mcp.json` generation via `pml init` (stdio type)    |
| FR14-10 | Epic 14 | 14.4       | MCP code caching via Deno HTTP cache                  |
| FR14-11 | Epic 14 | 14.1       | Local and Cloud mode support (via stdio)              |
| FR14-12 | Epic 14 | 14.1       | Local API keys never stored on cloud                  |

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

**AC1-3 (Routing - DONE via Story 13.9):**

~~**Given** the existing `mcp-permissions.yaml` configuration **When** the schema is extended **Then**
each MCP entry supports a `routing: local | cloud` field **And** the default is `cloud` if not
specified~~ → **DONE:** `config/mcp-routing.json` exists with cloud list, default is local.

~~**Given** the PermissionInferrer module **When** a new function `getToolRouting(mcpName: string)` is
called **Then** it returns the routing mode from configuration **And** caches the result for
performance~~ → **DONE:** `src/capabilities/routing-resolver.ts:getToolRouting()`

~~**Given** the default routing config **When** tool calls are processed **Then** each is routed
according to its configuration~~ → **DONE:** `resolveRouting()` with cache + pattern matching.

**AC4-6 (NEW - PML Package Integration + Permission Inference):**

**Given** the PML package (`packages/pml`) **When** it needs to determine routing **Then** it has an
embedded routing resolver matching `config/mcp-routing.json` **And** returns `"local"` for unknown
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

**Given** Claude Code sends a tool call via HTTP **When** the tool is a cloud MCP (pml:search,
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
// __meta__: { "type": "deno", "tools": ["filesystem:read_file", ...], "routing": "local" }
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
  "routing": "local"
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
  "routing": "cloud"
}
```

**AC4-5 (Capability Records & 404):**

**Given** a request to `pml.casys.ai/mcp/fs:read_json` (learned capability) **When** the endpoint
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

**Given** a cloud MCP test (e.g., `pml:search_tools`) **When** called via the local package **Then**
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
      "tools": ["internal-db:query", "internal-db:migrate"]
    }
  }
}
```
**When** `internal-db:query` is called **Then** PML uses the local definition **And** installs
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

## Technical Notes

### Package Structure

```
packages/pml/
├── deno.json           # JSR config
├── mod.ts              # Entry point
├── src/
│   ├── server.ts       # MCP HTTP Streamable server
│   ├── router.ts       # Local/Cloud routing
│   ├── local/
│   │   ├── executor.ts # Sandboxed execution
│   │   └── loader.ts   # Dynamic import from registry
│   ├── cloud/
│   │   └── rpc.ts      # HTTP RPC client to pml.casys.ai
│   └── workspace.ts    # Workspace resolution
└── README.md
```

### Key Dependencies

- `@modelcontextprotocol/sdk` - MCP HTTP server implementation
- Deno native `Worker` API - Sandbox isolation
- Deno native `fetch` - Cloud RPC calls + registry fetching
- Story 13.8 - `pml_registry` table for unified MCP/capability storage
- Story 13.9 - `routing` field for local/cloud decisions

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
  /mcp/fs:read_json      → Learned capability (same MCP interface)
  /mcp/data:transform    → Learned capability
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

### Routing Rules

| Routing | Critère | Exemples |
|---------|---------|----------|
| **local** | MUST access user's workspace/files | `filesystem`, `shell`, `sqlite`, `git` |
| **cloud** | API-based, can proxy or BYOK | `tavily`, `github`, `slack`, `pml:*` |

### What the user controls

| User Config | Purpose |
|-------------|---------|
| `.pml.json` permissions | `allow/deny/ask` - HIL behavior |
| `.env` API keys | BYOK for cloud MCPs (TAVILY_API_KEY, etc.) |

### What the user does NOT control

- `routing` field - fixed by platform
- Which MCPs are local vs cloud - platform decision
- MCP code source - always from `pml.casys.ai/mcp/{fqdn}`

### Cloud MCP Flow (BYOK)

```
User calls tavily:search
    │
    ├─► PML package reads TAVILY_API_KEY from user's .env
    │
    ├─► Forwards request to pml.casys.ai with BYOK injection
    │
    └─► Cloud executes with user's API key (never stored)
```
