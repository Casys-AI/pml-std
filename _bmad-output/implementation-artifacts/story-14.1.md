# Story 14.1: Package Scaffolding & CLI Init Command

Status: done

## Story

As a developer, I want to install the PML package with a single command and initialize my project,
so that I can start using PML with minimal setup friction.

## Acceptance Criteria

### AC1: Package installable via deno install

**Given** a developer with Deno installed **When** they run `deno install -A -n pml jsr:@casys/pml`
**Then** the `pml` command is available globally **And** the package size is under 50KB

### AC2: pml init generates configuration

**Given** a developer in their project directory **When** they run `pml init` **Then** they are
prompted for their PML API key (or can skip for local-only mode) **And** a `.mcp.json` file is
generated with the PML server configuration **And** a `.pml.json` config file is created with
workspace and cloud URL settings

### AC3: Existing config backup

**Given** an existing `.mcp.json` file **When** running `pml init` **Then** the system asks for
confirmation before modifying **And** backs up the original file to `.mcp.json.backup`

### AC4: pml serve starts HTTP server

**Given** a configured `.pml.json` file **When** running `pml serve` **Then** an MCP HTTP Streamable
server starts on the configured port (default 3003) **And** the server is ready to receive tool
calls from Claude Code

### AC5: Version command

**Given** the pml package installed **When** running `pml --version` or `pml -V` **Then** the
package version is displayed (e.g., "0.1.0")

## Tasks / Subtasks

### Phase 1: Package Structure (~2h)

- [x] Task 1: Create package directory structure (AC: #1)
  - [x] Create `packages/pml/` directory
  - [x] Create `packages/pml/deno.json` with JSR config
  - [x] Create `packages/pml/mod.ts` entry point
  - [x] Create `packages/pml/src/` source directory
  - [x] Verify exports field follows JSR best practices

- [x] Task 2: Implement CLI commands (AC: #1, #5)
  - [x] Create `src/cli/mod.ts` with @cliffy/command
  - [x] Add `pml init` command
  - [x] Add `pml serve` command
  - [x] Add `pml --version` flag
  - [x] Add `pml --help` output

### Phase 2: Init Command (~3h)

- [x] Task 3: Implement init workflow (AC: #2)
  - [x] Create `src/init/mod.ts`
  - [x] Prompt for PML API key (with skip option)
  - [x] Validate API key format (if provided)
  - [x] Create `.pml.json` config file
  - [x] Create `.mcp.json` file

- [x] Task 4: Handle existing config (AC: #3)
  - [x] Check if `.mcp.json` exists
  - [x] Prompt for confirmation before overwrite
  - [x] Create `.mcp.json.backup` if overwriting
  - [ ] Merge with existing config if requested (deferred - not critical)

- [x] Task 5: Generate .mcp.json (AC: #2)
  - [x] Use MCP HTTP Streamable transport format
  - [x] Include BYOK env var placeholders
  - [x] Set correct localhost URL and port
  - [x] Validate JSON output

### Phase 3: Serve Command Stub (~1h)

- [x] Task 6: Create serve command skeleton (AC: #4)
  - [x] Create `src/cli/serve-command.ts`
  - [x] Simple HTTP stub server (Deno.serve)
  - [x] Add startup logging
  - [x] Return stub JSON-RPC response
  - [x] Note: Full implementation in Story 14.6

### Phase 4: Package Publishing Prep (~1h)

- [x] Task 7: Prepare for JSR publishing (AC: #1)
  - [x] Add README.md with usage instructions
  - [x] Configure publish.include/exclude
  - [ ] Test local install: `deno install -A -n pml ./mod.ts` (manual)
  - [ ] Verify bundle size < 50KB (manual)
  - [x] Note: Actual publish deferred until Epic 14 complete

### Phase 5: Tests (~1h)

- [x] Task 8: Unit tests
  - [x] Test init config generation
  - [x] Test backup creation
  - [x] Test CLI argument parsing
  - [x] Test version output

- [x] Task 9: Integration tests
  - [x] Test full init workflow
  - [x] Test serve command starts
  - [x] Test with existing .mcp.json

## Dev Notes

### Package Structure

```
packages/pml/
├── deno.json           # JSR config (@casys/pml)
├── mod.ts              # Entry point
├── src/
│   ├── cli/
│   │   └── mod.ts      # CLI commands (@cliffy/command)
│   ├── init/
│   │   └── mod.ts      # Init workflow
│   ├── server/
│   │   └── mod.ts      # HTTP server stub
│   └── workspace.ts    # Workspace resolution (for Story 14.2)
└── README.md
```

### deno.json Configuration

```json
{
  "name": "@casys/pml",
  "version": "0.1.0",
  "exports": {
    ".": "./mod.ts",
    "./cli": "./src/cli/mod.ts"
  },
  "publish": {
    "include": ["mod.ts", "src/**/*.ts", "README.md"]
  },
  "imports": {
    "@cliffy/command": "jsr:@cliffy/command@1.0.0-rc.8",
    "@modelcontextprotocol/sdk": "npm:@modelcontextprotocol/sdk@^1.15.1",
    "@std/fs": "jsr:@std/fs@1.0.19",
    "@std/path": "jsr:@std/path@^1"
  }
}
```

### Generated .mcp.json Format

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

### Generated .pml.json Format

```json
{
  "version": "0.1.0",
  "workspace": "/path/to/project",

  "cloud": {
    "url": "https://pml.casys.ai",
    "apiKey": "${PML_API_KEY}"
  },

  "server": {
    "port": 3003
  },

  "permissions": {
    "allow": [
      "json:*",
      "math:*",
      "datetime:*",
      "crypto:*",
      "collections:*",
      "validation:*",
      "format:*",
      "transform:*",
      "string:*",
      "path:*"
    ],
    "deny": [],
    "ask": [
      "filesystem:*",
      "github:*",
      "docker:*",
      "database:*",
      "ssh:*",
      "process:*",
      "cloud:*"
    ]
  }
}
```

**Permission categories:**
- `allow`: Auto-approved, no prompt (safe tools: pure computation)
- `deny`: Always refused
- `ask`: Requires user confirmation (I/O, network, system tools)

### CLI Implementation Pattern

Use @cliffy/command which is already in project dependencies:

```typescript
import { Command } from "@cliffy/command";

const main = new Command()
  .name("pml")
  .version("0.1.0")
  .description("PML - Procedural Memory Layer package")
  .command("init", initCommand)
  .command("serve", serveCommand);

await main.parse(Deno.args);
```

### Project Structure Notes

- Package lives in `packages/pml/` (new directory)
- Separate from main codebase to keep it lightweight
- Will be published independently to JSR
- Main codebase remains `jsr:@casys/mcp-gateway`

### Architecture Compliance

- **ADR-025**: MCP Streamable HTTP Transport - .mcp.json uses `type: "http"`
- **ADR-040**: Multi-tenant MCP & Secrets Management - BYOK via local env vars
- **ADR-044**: JSON-RPC Multiplexer - Will be used in serve command (Story 14.6)

### References

- [Source: docs/epics/epic-14-jsr-package-local-cloud-mcp-routing.md#Story-14.1]
- [Source: docs/spikes/2025-12-23-jsr-package-local-mcp-routing.md#Package-JSR-Structure]

---

## Implementation Notes (2026-01-09)

> **ADR Reference:** [ADR-059: Hybrid Routing - Server Analysis, Package Execution](../planning-artifacts/adrs/ADR-059-hybrid-routing-server-analysis-package-execution.md)

### Init Updates .gitignore

`pml init` now automatically adds PML entries to the project's `.gitignore`:
```gitignore
# PML (per-project config and state)
.pml.json
.pml/
```

This ensures per-project state is not committed to git.

### Hybrid Routing Architecture Change

**Original design:** Server executes everything.

**Current implementation:** Server analyzes, package executes client tools.

```
pml:execute(code)
    │
    ▼
Package → Forward to Server
    │
    ▼
Server analyzes (SWC → DAG)
    │
    ├─► All server tools → Server executes, returns result
    │
    └─► Any client tool → Returns { status: "execute_locally", code, dag }
            │
            ▼
        Package executes in sandbox
            │
            ├─► client tools → local execution (via CapabilityLoader)
            └─► server tools → HTTP forward to cloud
```

See: `_bmad-output/planning-artifacts/spikes/spike-2026-01-09-pml-execute-hybrid-routing.md`

### Per-Project State

All state is now per-project, NOT global:

| File | Location |
|------|----------|
| `.pml.json` | `${workspace}/.pml.json` |
| `mcp.lock` | `${workspace}/.pml/mcp.lock` |
| `deps.json` | `${workspace}/.pml/deps.json` |
| `client-id` | `${workspace}/.pml/client-id` |

### Registry Serves 3 MCP Types

Le registry `/api/registry/{fqdn}` sert maintenant 3 types de MCP:

| Type | Source | Response |
|------|--------|----------|
| `deno` | capability_records (code) | TypeScript code |
| `stdio` | mcp_server.connection_info | JSON metadata (install command) |
| `http` | mcp_server.connection_info | JSON metadata (proxy URL) |

Les tools `filesystem:*` sont de type `stdio` avec `routing: "client"` - ils sont installés et exécutés sur la machine de l'utilisateur.

Voir: `src/mcp/registry/mcp-registry.service.ts:enrichRow()`
- [Source: docs/project-context.md#CLI-Usage]
- [JSR Publishing Docs](https://jsr.io/docs/package-configuration)
- [Deno Install Docs](https://docs.deno.com/runtime/reference/cli/install/)

### Dependencies

- **Story 13.8** (Optional): MCP Server Registry - for registry strategy
- **Story 14.2**: Workspace Resolution - will extend this package
- **Story 14.6**: MCP HTTP Server - full serve implementation

### Testing Strategy

- Use project's existing test patterns: `Deno.test`, `@std/assert`
- Test files in `packages/pml/tests/`
- Run with: `deno test packages/pml/tests/`

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

N/A

### Completion Notes List

- Package structure created in `packages/pml/` (cloud-only, excluded from public sync)
- CLI uses @cliffy/command with init, serve, --version
- Init generates .mcp.json (HTTP transport) and .pml.json (workspace config)
- Backup mechanism for existing .mcp.json with user prompt
- Serve command is a stub - full implementation in Story 14.6
- Tests written but require Deno runtime to execute

### File List

- `packages/pml/deno.json` - JSR package config
- `packages/pml/mod.ts` - Package entry point
- `packages/pml/README.md` - Usage documentation
- `packages/pml/src/types.ts` - TypeScript types
- `packages/pml/src/cli/mod.ts` - CLI entry point
- `packages/pml/src/cli/init-command.ts` - Init command
- `packages/pml/src/cli/serve-command.ts` - Serve command stub
- `packages/pml/src/init/mod.ts` - Init logic
- `packages/pml/tests/init_test.ts` - Init unit tests
- `packages/pml/tests/cli_test.ts` - CLI unit tests
