---
stepsCompleted: [
  "step-01-validate-prerequisites",
  "step-02-design-epics",
  "step-03-create-stories",
  "step-04-final-validation",
  "step-05-consolidation",
]
workflowStatus: complete
inputDocuments:
  - docs/tech-specs/tech-spec-capability-naming-curation.md
  - docs/PRD.md
  - docs/architecture/executive-summary.md
epicNumber: 13
epicTitle: "Capability Naming & Curation System"
lastUpdated: 2024-12-26
consolidationNotes: "Stories fusionnées pour cohérence dev. Architecture simplifiée: cap:* pour gestion (query→list, tag→rename), meta:* dropped, nommage libre."
---

# Procedural Memory Layer (PML) - Epic 13: Capability Naming & Curation System

## Overview

This document provides the complete epic and story breakdown for the **Capability Naming & Curation
System**, transforming opaque capability IDs into a naming system with full metadata, versioning,
and curation capabilities.

**Related Tech Spec:**
[tech-spec-capability-naming-curation.md](../tech-specs/tech-spec-capability-naming-curation.md)

## Architecture Decisions

### FQDN Architecture (decided 2024-12-26)

**Immutable vs Mutable Identifiers:**

| Identifier       | Location                          | Mutable?       | Purpose                                |
| ---------------- | --------------------------------- | -------------- | -------------------------------------- |
| **FQDN**         | `capability_records.id`           | ❌ Immutable   | Permanent identity, used in saved code |
| **display_name** | `capability_records.display_name` | ✅ Mutable     | Human-friendly name, can be renamed    |
| **aliases**      | `capability_aliases.alias`        | ➕ Append-only | Old names after `cap:rename`           |

**FQDN Format:** `<org>.<project>.<namespace>.<action>.<hash>`

- Example: `local.default.fs.read_json.a7f3`
- `hash` is 4-char hex derived from code content (ensures uniqueness)

**Why FQDNs in Saved Code:**

- When capability A calls capability B by name, we save `mcp["FQDN_of_B"]` not
  `mcp.namespace.displayName`
- If B is renamed later, A's saved code still works (FQDN doesn't change)
- The code transformer handles this conversion automatically at save time

### Naming Convention

| Type                         | Format                       | Examples                                                            |
| ---------------------------- | ---------------------------- | ------------------------------------------------------------------- |
| **Capabilities (MCP tools)** | `mcp__<namespace>__<action>` | `mcp__code__analyze`, `mcp__data__transform`, `mcp__fs__read_json`  |
| **Capability display_name**  | `namespace:action`           | `code:analyze`, `data:transform`, `fs:read_json`                    |
| **Capability Management**    | `cap:*` prefix               | `cap:lookup`, `cap:list`, `cap:curate`, `cap:rename`, `cap:history` |
| **System Introspection**     | `meta:*` prefix (optional)   | `meta:tools`, `meta:servers`, `meta:stats`                          |

**Key Points (updated 2024-12-24):**

- Capability tool names follow MCP format: `mcp__<namespace>__<action>` (indistinguishable from
  native MCP tools)
- display_name = `namespace:action` (derived, not free-form)
- Standard namespaces (`fs`, `api`, `db`, `git`, `shell`, `ai`, `util`, `code`, `data`, `test`) are
  recommended
- `cap:*` tools handle all capability registry operations
- No `dns:*` prefix (confusing with real DNS)
- No `learn:*` prefix (redundant with existing functionality)

**Namespace/Action Strategy (decided 2024-12-24):**

1. **Auto-generated** at creation: heuristics based on tools used (e.g., `filesystem:*` → `fs`,
   `shell:*` → `shell`)
2. **LLM-refined** via `cap:curate`: Story 13.4 allows renaming with better namespace:action after
   analysis

### Capability Invocation Syntax (decided 2024-12-26)

**In Code (at runtime):**

```typescript
// Capabilities use same syntax as MCP tools:
await mcp.fs.readJson({ path: "config.json" });

// After transformation (saved to DB):
await mcp["local.default.fs.read_json.a7f3"]({ path: "config.json" });
```

**Resolution Logic:**

1. Parser finds `mcp.namespace.action()` pattern
2. Lookup action name in capability registry
3. If found → capability → transform to FQDN
4. If not found → MCP tool → leave unchanged

## Requirements Inventory

### Functional Requirements

**Core Naming System:**

- **FR001:** The system must accept an optional `name` parameter in `pml_execute` for capability
  naming
- **FR002:** The system must validate capability names are non-empty and unique
- **FR003:** The system must return errors for name collisions during capability creation
- **FR004:** The system must include `capabilityName` in `pml_execute` response

**Capability Calling by Name:**

- **FR005:** The system must accept a `capability` parameter in `pml_execute` to call existing
  capabilities by name
- **FR006:** The system must perform name-based lookup to resolve capabilities
- **FR007:** The system must merge provided `args` with default parameters when calling capabilities
- **FR008:** The system must execute the capability code with merged arguments

**Auto-Generation & Curation:**

- **FR009:** Capabilities created without names must receive temporary names (`unnamed_<hash>`)
- **FR010:** The system must trigger curation after N unnamed capabilities (configurable threshold)
- **FR011:** The system must provide `cap:curate` tool with modes: `suggest`, `auto`, `apply`
- **FR012:** The system must generate name suggestions via LLM + heuristics based on tools used and
  intent
- **FR013:** The system must validate proposed names for uniqueness before applying

**Capability Listing & Query:**

- **FR014:** The system must provide `cap:list` tool to list all named capabilities
- **FR015:** The system must support filtering by namespace pattern and named_only flag
- **FR016:** The system must support sorting by name, usage, or creation date
- **FR017:** The system must provide `cap:lookup` for name resolution
- **FR018:** ~~`cap:query`~~ MERGED into `cap:list` - extend with tags, creator, visibility filters
  if needed
- **FR019:** The system must provide `cap:history` for version history
- **FR020:** The system must provide `cap:whois` for complete metadata

**Virtual MCP Server (CapabilityMCPServer):**

- **FR021:** The system must create a virtual MCP server at `src/mcp/servers/capability-server.ts`
- **FR022:** The virtual server must implement `listTools()` returning named capabilities as tools
  (user-defined names)
- **FR023:** The virtual server must implement `callTool()` executing capabilities via WorkerBridge
- **FR024:** The Gateway must integrate virtual server in `handleListTools()` and `handleCallTool()`

**Dynamic Refresh:**

- **FR025:** The system must send `tools/list_changed` notifications when capabilities are
  named/renamed
- **FR026:** MCP clients must receive notifications and refresh their tool lists
- **FR027:** Newly named capabilities must appear immediately in tools/list

**Unified Tracking:**

- **FR028:** Capability calls must be tracked in the `tool_usage` table
- **FR029:** Metrics must be unified with real tools (same tracking infrastructure)
- **FR030:** Capability calls must use `server_id = "pml-capabilities"` for filtering

**Transparent Resolution:**

- **FR031:** The system must fallback to aliases when names have been changed
- **FR032:** A `capability_aliases` table must be created automatically on rename
- **FR033:** Warning logs must be emitted when deprecated aliases are used
- **FR034:** Internal FQDNs must never be exposed to agents (implementation detail)

**Capability Registry Schema:**

- **FR035:** Capabilities must use FQDN structure: `<org>.<project>.<namespace>.<action>.<hash>`
- **FR036:** The `capability_records` table must store complete metadata (creator, versioning,
  trust, visibility)
- **FR037:** Creator fields must include `created_by`, `created_at`
- **FR038:** Versioning fields must include `version`, `version_tag`, `updated_by`, `updated_at`
- **FR039:** Trust fields must include `verified`, `signature`
- **FR040:** Visibility levels must support `private | project | org | public`

**Versioning:**

- **FR041:** A `capability_versions` table must track version history
- **FR042:** The system must support version specifiers: `@v1`, `@v1.2.0`, `@2025-12-22`
- **FR043:** Default resolution must use `@latest`

**Fork & Merge (Future - Epic 14+):**

- **FR044:** The system must provide `cap:fork` to copy capabilities for modification
- **FR045:** The system must provide `cap:merge` to combine capabilities into pipelines
- **FR046:** Public visibility must enable marketplace functionality
- **FR047:** `forked_from` must track provenance in capability_records

**PML Standard Library (`lib/std/cap.ts`):**

- **FR048:** ✅ Create `lib/std/cap.ts` with `PmlStdServer` class
- **FR049:** ✅ Create `CapModule` for capability management (lookup, list, rename, whois).
  `curate`/`history` in 13.4/13.6
- **FR050:** ~~Create `meta.ts` module~~ DROPPED - not needed for MVP
- **FR051:** ✅ Integrate stdlib via `pmlTools` export in `lib/std/mod.ts`
- **FR052:** ✅ Route by prefix (`cap:`)

**MCP Server Registry (Extension for Epic 14 integration):**

- **FR053:** The registry must support `record_type = 'mcp-server'` in addition to `'capability'`
- **FR054:** `cap:lookup("mcp:{name}")` must return the MCP server code URL and metadata
- **FR055:** MCP servers must support versioning (`mcp:filesystem@v1.2.0`)
- **FR056:** MCP servers must support visibility (private/org/public)

**Routing Inheritance:**

- **FR057:** Capabilities must store `tools_used` array tracking which tools they use
- **FR058:** Capability `routing` must be inherited from tools: `local` if ANY tool is local,
  otherwise `cloud`
- **FR059:** Explicit `routing` in capability metadata must override inherited routing

### Non-Functional Requirements

**From PRD (applicable to this epic):**

- **NFR001: Performance** - Capability resolution (name → FQDN) must complete in <10ms P95
- **NFR002: Usability** - Named capabilities must be discoverable and callable without documentation
  lookup
- **NFR003: Reliability** - Rename operations must be atomic with automatic alias creation

**Epic-specific NFRs:**

- **NFR004: Backward Compatibility** - Existing capabilities without names must continue to function
- **NFR005: Migration Safety** - `capabilityId`-based calls must remain supported during transition
- **NFR006: Curation Quality** - LLM-generated names must achieve >80% acceptance rate
- **NFR007: Scalability** - System must handle 10,000+ named capabilities without performance
  degradation

### Open Questions (requiring decisions)

- **Decision Required:** Name collision handling strategy (Error vs Auto-suffix vs Versioning)
- **Decision Required:** Deleted capability name handling (Free immediately vs Reserve N days)
- **Decision Required:** LLM model for naming (Haiku vs Sonnet vs Heuristics-only)

### FR Coverage Map

| FR Range    | Story       | Description                                        |
| ----------- | ----------- | -------------------------------------------------- |
| FR001-FR008 | 13.2        | pml_execute naming + calling by name               |
| FR009-FR013 | 13.4        | Curation system (LLM + heuristics)                 |
| FR014-FR020 | 13.5        | Discovery & Query API (cap:list, cap:lookup, etc.) |
| FR021-FR024 | 13.3        | CapabilityMCPServer + Gateway integration          |
| FR025-FR027 | 13.3        | Dynamic refresh notifications                      |
| FR028-FR030 | 13.3        | Unified tracking                                   |
| FR031-FR034 | 13.1        | Aliases & transparent resolution                   |
| FR035-FR040 | 13.1        | Schema & FQDN structure                            |
| FR041-FR043 | 13.6        | Versioning                                         |
| FR044-FR047 | **Epic 14** | Fork & Merge (DEFERRED)                            |
| FR048-FR052 | 13.7        | PML Stdlib                                         |
| FR053-FR056 | 13.8        | MCP Server Registry                                |
| FR057-FR059 | 13.9        | Routing Inheritance                                |

**Coverage Summary:** 55/59 FRs covered in Epic 13 (FR044-FR047 deferred to Epic 14)

---

## Epic 13: Capability Naming & Curation System

**Goal:** Transform opaque capability IDs into a naming system with callable names, rich metadata,
versioning, and intelligent curation. Enable capabilities to be first-class MCP citizens via virtual
server integration.

**Phases:**

- Phase 1: Core MVP (Schema, FQDN, pml_execute, CapabilityMCPServer, Gateway)
- Phase 2: Curation & Query (cap:curate, cap:list, cap:lookup)
- Phase 3: Versioning & History
- Phase 4: Stdlib & Registry

---

## Story List Summary

| Story | Title                         | Phase | Effort | Status  |
| ----- | ----------------------------- | ----- | ------ | ------- |
| 13.1  | Schema, FQDN & Aliases        | 1     | 2j     | ✅ done |
| 13.2  | pml_execute Naming Support    | 1     | 1.5j   | ✅ done |
| 13.3  | CapabilityMCPServer + Gateway | 1     | 2.5j   | backlog |
| 13.4  | Capability Curation System    | 2     | 3j     | backlog |
| 13.5  | Discovery & Query API         | 2     | 2j     | ✅ done |
| 13.6  | Capability Versioning         | 3     | 2j     | backlog |
| 13.7  | PmlStdServer Unification      | 4     | 4j     | ✅ done |
| 13.8  | MCP Server Registry           | 4     | 2j     | backlog |
| 13.9  | Routing Inheritance           | 4     | 1j     | backlog |

**Total Estimated Effort:** ~20 jours (vs 25j avant consolidation)

---

## Detailed Stories

### Story 13.1: Schema, FQDN & Aliases

**Consolidation:** Merges original 13.1 (Schema) + 13.2 (FQDN) + alias parts of 13.7

**As a** PML developer, **I want** a capability registry with FQDN structure, rich metadata, and
alias support, **So that** capabilities have stable identities with full provenance tracking and
rename safety.

**Acceptance Criteria:**

**AC1: Schema Creation** **Given** the PGlite database **When** migration 020 is executed **Then**
the `capability_records` table is created with columns:

- Identity: `id` (FQDN primary key), `display_name`, `org`, `project`, `namespace`, `action`, `hash`
- Provenance: `created_by`, `created_at`, `updated_by`, `updated_at`
- Versioning: `version`, `version_tag`
- Trust: `verified`, `signature`
- Metrics: `usage_count`, `success_count`, `total_latency_ms`
- Metadata: `tags`, `visibility`, `code_snippet`, `parameters_schema`, `description`, `tools_used`,
  `routing`

**AC2: Indexes** **Given** the capability_records table **When** schema is applied **Then** indexes
exist for: `(org, project)`, `(org, project, display_name)`, `namespace`, `created_by`, `tags`
(GIN), `visibility`

**AC3: Aliases Table** **Given** the migration **When** executed **Then** `capability_aliases` table
is created with columns: `alias`, `org`, `project`, `target_fqdn`, `created_at`

**AC4: FQDN Generation** **Given** capability with namespace "fs", action "read_json" **When** FQDN
is generated with org "local" and project "default" **Then** FQDN is
`local.default.fs.read_json.<hash>` where hash is 4-char hex of content hash

**AC5: Display Name Extraction** **Given** FQDN `acme.webapp.fs.read_json.a7f3` **When** display
name is requested **Then** returns the user-provided name (free format)

**AC6: FQDN Parsing** **Given** FQDN string **When** parsed **Then** returns object with
`{ org, project, namespace, action, hash }`

**AC7: Scope Resolution** **Given** short name and session context
`{ org: "acme", project: "webapp" }` **When** resolved **Then** searches matching records in current
scope and returns matching FQDN

**AC8: Alias Resolution** **Given** call using old name after rename **When** lookup performed
**Then** resolves via alias table and logs warning about deprecated name

**AC9: Alias Chain Prevention** **Given** alias A → B, then B renamed to C **When** rename executed
**Then** alias A updated to point to C directly (no alias chains)

**AC10: Backward Compatibility** **Given** existing `workflow_pattern` table **When** migration runs
**Then** existing data is preserved and new columns are nullable or have defaults

---

### Story 13.2: pml_execute Naming Support

**Consolidation:** Merges original 13.3 (name param) + 13.4 (capability call)

**Status:** ✅ DONE (2024-12-26)

**Implementation Notes:**

**Architecture - Identifiers:**

- **FQDN** (Fully Qualified Domain Name): `<org>.<project>.<namespace>.<action>.<hash>` - immutable
  identifier stored in `capability_records.id`
- **display_name**: Human-readable mutable name stored in `capability_records.display_name`
- **capability_aliases**: Table for old names after `cap:rename` operations (enables transparent
  resolution)

**Capability Syntax:**

- Capabilities use same syntax as MCP tools: `mcp.namespace.action()`
- Tool vs Capability distinction: if action name is found in registry → capability, if not → MCP
  tool
- This allows capabilities to be indistinguishable from native MCP tools at call sites

**Code Transformation (display_name → FQDN):**

- When capability code references other capabilities by display_name, the code transformer converts
  them to FQDNs before saving
- Pattern: `mcp.fs.readJson({ path: "x" })` →
  `mcp["local.default.fs.read_json.a7f3"]({ path: "x" })`
- This ensures saved code uses immutable FQDNs, not mutable display_names that could break after
  rename

**Key Files:**

- `src/capabilities/code-transformer.ts` - transforms display_name references to FQDN when saving
- `src/capabilities/swc-analyzer.ts` - shared SWC AST parser for tools + capabilities
- `tests/unit/capabilities/code_transformer_test.ts` - 10 unit tests

**Technical Details:**

- SWC parser maintains cumulative positions across `parse()` calls → fixed with dynamic
  `baseOffset = ast.span.start + WRAPPER_OFFSET`
- `WRAPPER_OFFSET = 15` (the length of `(async () => {` wrapper)
- `buildCapabilitiesObject` exposes capabilities by FQDN for runtime resolution

**As a** developer, **I want** to name capabilities and call them by name via pml_execute, **So
that** I can create reusable, discoverable capabilities.

**Acceptance Criteria:**

**AC1: Optional Name Parameter** **Given** `pml_execute({ intent, code, name: "my-config-reader" })`
**When** executed successfully **Then** capability is saved with `display_name = "my-config-reader"`

**AC2: Free Format Names** **Given** various name formats **When** pml_execute called with names
like `read_config`, `myapp:fetch`, `my-tool-v2` **Then** all are accepted (no format validation
beyond non-empty + unique)

**AC3: Collision Detection** **Given** existing capability named `read_config` **When** pml_execute
called with same name **Then** returns error "Capability name 'read_config' already exists"

**AC4: Response Includes Name** **Given** successful pml_execute with name **When** response
returned **Then** includes `capabilityName` and `capabilityFqdn`

**AC5: Auto-generated Name** **Given** pml_execute without name parameter **When** executed
successfully **Then** capability receives temporary name `unnamed_<hash>` (first 8 chars of hash)

**AC6: Call by Name** **Given** existing capability `my-config-reader` **When**
`pml_execute({ intent: "read config", capability: "my-config-reader", args: { path: "config.json" } })`
**Then** capability code is executed with args merged into context

**AC7: Name Resolution** **Given** capability name **When** lookup performed **Then** resolves to
full FQDN and retrieves code_snippet

**AC8: Args Merging** **Given** capability with default params `{ encoding: "utf-8" }` **When**
called with args `{ path: "x.json" }` **Then** execution context has
`{ path: "x.json", encoding: "utf-8" }`

**AC9: Not Found Error** **Given** non-existent capability name **When** pml_execute called **Then**
returns error "Capability not found: <name>"

**AC10: Usage Tracking** **Given** capability called successfully **When** execution completes
**Then** `usage_count` incremented and `success_count` updated based on result

---

### Story 13.3: CapabilityMCPServer + Gateway

**Consolidation:** Merges original 13.5 (Server) + 13.6 (Gateway) + notification parts of 13.7

**As a** MCP client (Claude), **I want** capabilities to appear as MCP tools in the unified tool
list, **So that** I can discover and call them like any other MCP tool.

**Design Decision (2024-12-24):**

- **Naming format:** `mcp__<namespace>__<action>` (indistinguishable from native MCP tools)
- **display_name:** `namespace:action` (not free-form, derived from namespace + action)
- **Dynamic servers:** One virtual MCP server per namespace (e.g., `code`, `data`, `test`)
- **Example:** Capability with namespace=`code`, action=`analyze` → tool name `mcp__code__analyze`

This makes learned capabilities completely transparent - Claude cannot distinguish them from native
MCP tools.

**Acceptance Criteria:**

**AC1: Dynamic Server Registration** **Given** capabilities with namespaces `code`, `data`, `test`
**When** Gateway initialized **Then** virtual MCP servers registered dynamically for each namespace

**AC2: listTools Implementation** **Given** 5 capabilities: `code:analyze`, `code:refactor`,
`data:transform`, etc. **When** `listTools()` called **Then** returns tools as `mcp__code__analyze`,
`mcp__code__refactor`, `mcp__data__transform` with proper inputSchema

**AC3: callTool Implementation** **Given** tool call for `mcp__code__analyze` with args
`{ file: "src/main.ts" }` **When** `callTool()` executed **Then** capability code runs via
WorkerBridge and result returned as ToolResult

**AC4: Error Handling** **Given** tool call for non-existent capability **When** `callTool()`
executed **Then** returns
`{ isError: true, content: [{ type: "text", text: "Capability not found" }] }`

**AC5: InputSchema Generation** **Given** capability with `parameters_schema` **When** listed as
tool **Then** tool.inputSchema matches the capability's parameters_schema

**AC6: Unified tools/list** **Given** 3 real servers (filesystem, github, memory) and 5 capabilities
**When** `handleListTools()` called **Then** returns all real tools + all capability tools in single
list

**AC7: Routing Capability Calls** **Given** tool call for a capability name **When**
`handleCallTool()` receives it **Then** routes to `CapabilityMCPServer.callTool()`

**AC8: tool_usage Tracking** **Given** successful capability call **When** execution completes
**Then** record inserted in `tool_usage` with `server_id = "pml-capabilities"`

**AC9: Latency Tracking** **Given** capability execution taking 45ms **When** call completes
**Then** `total_latency_ms` incremented by 45 in capability_records

**AC10: tools/list_changed Notification** **Given** capability renamed or newly named **When**
operation completes **Then** Gateway sends `notifications/tools/list_changed` to all connected
clients

**AC11: Immediate Visibility** **Given** newly named capability **When** next `listTools()` called
**Then** new capability appears immediately

---

### Story 13.4: Capability Curation System

**Consolidation:** Merges original 13.8 (pml_curate) + 13.10 (Curation Agent LLM)

**As a** developer, **I want** the system to intelligently suggest and apply names to unnamed
capabilities, **So that** I don't have to manually name every capability.

**Acceptance Criteria:**

**AC1: Suggest Mode** **Given** 5 unnamed capabilities (`unnamed_a7f3`, `unnamed_b8e2`, etc.)
**When** `cap:curate({ mode: "suggest" })` called **Then** returns array of suggestions:
`[{ id, currentName, suggestedName, confidence, reasoning }]`

**AC2: Auto Mode** **Given** unnamed capabilities with high-confidence suggestions (>0.8) **When**
`cap:curate({ mode: "auto" })` called **Then** automatically applies names where confidence > 0.8,
returns summary of changes

**AC3: Apply Mode** **Given** manual rename list `[{ id: "abc", name: "my-reader" }]` **When**
`cap:curate({ mode: "apply", renames: [...] })` called **Then** applies specified renames, creates
aliases for old names

**AC4: Filter Options** **Given** mix of capabilities **When**
`cap:curate({ filter: { unnamed_only: true, min_usage: 3 } })` called **Then** only processes
matching capabilities

**AC5: Heuristic Namespace Detection** **Given** capability using tools
`["filesystem:read", "filesystem:write"]` **When** namespace inferred **Then** suggests "fs" related
name

**AC6: Heuristic Action Detection** **Given** capability with intent "read and parse JSON config
file" **When** action inferred **Then** suggests name like "read-json-config" or "config-parser"

**AC7: LLM Name Generation** **Given** capability with intent, code_snippet, tools_used **When** LLM
prompt sent **Then** returns meaningful name suggestion

**AC8: Confidence Scoring** **Given** name suggestion **When** confidence calculated **Then** score
0.0-1.0 based on: tools match (0.3), intent clarity (0.3), uniqueness (0.4)

**AC9: Collision Avoidance** **Given** suggested name already exists **When** suggestion generated
**Then** suggests variant with suffix or different phrasing, lower confidence

**AC10: Batch Processing** **Given** 20 unnamed capabilities **When** curation triggered **Then**
processes in batches of 5 to manage LLM costs/latency

**AC11: Model Selection** **Given** config `curation.model: "haiku"` or `"sonnet"` **When** LLM
called **Then** uses configured model (default: haiku for cost efficiency)

---

### Story 13.5: Discovery & Query API

**Status:** ✅ DONE (2024-12-26)

**Consolidation:** Merges original 13.9 (pml_list) + 13.11 (Query API)

**Implementation Notes:**

- `cap:list`, `cap:lookup`, `cap:whois` implemented in `lib/std/cap.ts`
- `cap:query` removed - filters merged into `cap:list` as optional extensions
- Sort by usage_count DESC by default, can extend with `sortBy` param if needed

**As a** developer, **I want** powerful tools to discover and query capabilities, **So that** I can
find and understand what capabilities exist.

**Acceptance Criteria:**

**AC1: cap:list Basic** **Given** 10 capabilities (5 named, 5 unnamed) **When** `cap:list({})`
called **Then** returns all 10 with: `id`, `name`, `description`, `usage_count`, `success_rate`,
`parameters`

**AC2: Filter Named Only** **Given** mix of named and unnamed **When**
`cap:list({ named_only: true })` called **Then** returns only named capabilities

**AC3: Filter by Pattern** **Given** capabilities with various names **When**
`cap:list({ pattern: "fs:*" })` called **Then** returns only matching capabilities

**AC4: Sort Options** **Given** capabilities **When**
`cap:list({ sort_by: "usage" | "name" | "created" })` called **Then** returns sorted accordingly

**AC5: Pagination** **Given** 100 capabilities **When** `cap:list({ limit: 10, offset: 20 })` called
**Then** returns capabilities 21-30

**AC6: cap:lookup** **Given** capability name exists **When** `cap:lookup({ name: "my-reader" })`
called **Then** returns `{ fqdn, display_name, description, usage_count, success_rate }`

**AC7-9: Advanced Filters (MERGED into cap:list)** ~~`cap:query`~~ removed - extend `cap:list` with
these optional filters if needed:

- `createdBy: "erwan"` - filter by creator
- `tags: ["json", "config"]` - filter by tags (AND match)
- `visibility: "public"` - filter by visibility level

**AC10: cap:whois** **Given** capability FQDN **When**
`cap:whois({ fqdn: "acme.webapp.fs.read_json.a7f3" })` called **Then** returns complete
CapabilityRecord with all metadata

**AC11: pml_discover Integration** **Given** `pml_discover({ intent: "read json files" })` **When**
capabilities match **Then** results include `name` field for direct calling

---

### Story 13.6: Capability Versioning

**As a** developer, **I want** to track capability versions and call specific versions, **So that**
I can maintain backward compatibility and audit changes.

**Acceptance Criteria:**

**AC1: Version Table Creation** **Given** migration executed **When** schema applied **Then**
`capability_versions` table created with: `id`, `capability_fqdn`, `version`, `version_tag`,
`code_snippet`, `parameters_schema`, `updated_by`, `updated_at`, `change_summary`

**AC2: Auto-versioning on Update** **Given** capability at version 2 **When** code_snippet updated
**Then** version incremented to 3, previous version saved to capability_versions

**AC3: Semantic Version Tags** **Given** capability update **When** `version_tag: "v1.2.0"` provided
**Then** version_tag stored alongside numeric version

**AC4: Version Specifier @v1** **Given** capability with versions 1, 2, 3 **When** `my-reader@v1`
called **Then** executes version 1 code (major version match)

**AC5: Version Specifier @v1.2.0** **Given** capability with version_tag "v1.2.0" **When**
`my-reader@v1.2.0` called **Then** executes exact version matching that tag

**AC6: Version Specifier @latest** **Given** capability with multiple versions **When**
`my-reader@latest` or `my-reader` called **Then** executes highest version number

**AC7: Version Specifier @date** **Given** capability versions from different dates **When**
`my-reader@2025-12-22` called **Then** executes version that was current on that date

**AC8: Version Not Found** **Given** capability without version 5 **When** `my-reader@v5` called
**Then** returns error "Version v5 not found for my-reader"

**AC9: cap:history** **Given** capability with 5 versions **When**
`cap:history({ name: "my-reader" })` called **Then** returns all versions with change_summary and
diffs

**AC10: Immutable Versions** **Given** saved version in capability_versions **When** any update
attempted **Then** rejected - versions are immutable (append-only)

---

### Story 13.7: PmlStdServer Unification

**Status:** ✅ DONE (2024-12-26)

**Simplification:** Refactored from original 13.13, removes dns.ts, learn.ts, meta.ts

**As a** developer, **I want** a unified stdlib MCP server with cap module, **So that** I have a
complete toolkit for capability management.

**Implementation Notes:**

- `PmlStdServer` class in `lib/std/cap.ts` (not separate mcp/ folder)
- `CapModule` handles all `cap:*` tool calls
- Types exported from `lib/std/cap.ts` directly
- `cap:query` removed - use `cap:list` with extended filters instead
- `cap:tag` removed - merged into `cap:rename` as optional param
- `meta.ts` dropped - not needed for MVP

**Acceptance Criteria:**

**AC1: PmlStdServer Class** ✅ **Given** `lib/std/cap.ts` **When** server initialized **Then**
`PmlStdServer` implements MCPServer interface with `serverId = "pml-std"`

**AC2: Module cap.ts** ✅ **Given** cap module **When** `listTools()` called **Then** returns:
`cap:lookup`, `cap:list`, `cap:rename`, `cap:whois` **Note:** `cap:curate` and `cap:history` are in
Stories 13.4 and 13.6 respectively

**AC3: cap:list Extension** ✅ **Given** `cap:list` tool **When** called with filters **Then**
supports: `pattern`, `unnamedOnly`, `limit`, `offset` **Future:** Can extend with `createdBy`,
`tags`, `visibility`, `sortBy` if needed

**AC4: Prefix Routing** ✅ **Given** tool call `cap:lookup` **When** `callTool()` invoked **Then**
routes to `CapModule.call("lookup", args)`

**AC5: cap:rename Tool (unified update)** ✅ **Given**
`cap:rename({ name: "old-name", newName?, description?, tags?, visibility? })` **When** executed
**Then** updates capability with provided optional fields **Note:** Only `name` is required - all
other fields optional for partial updates

---

### Story 13.8: MCP Server Registry

**Problem Statement:** Cloud PML cannot execute capabilities that use local-only MCP tools
(filesystem, shell). We need metadata about MCP servers to know their routing requirements (local vs
cloud) so that capability execution can be routed to the correct environment.

**As a** platform maintainer, **I want** MCP server metadata (routing, code_url) registered in the
capability registry, **So that** the system knows which servers are local-only and can route
capability execution accordingly.

**Acceptance Criteria:**

**AC1: Record Type Support** **Given** the `capability_records` table **When** schema is extended
**Then** `record_type` column exists with values: `'capability'` | `'mcp-server'` **And** existing
records default to `'capability'`

**AC2: MCP Server Registration** **Given** an MCP server to register (e.g., filesystem) **When**
registered in the system **Then** FQDN follows pattern: `{org}.{project}.mcp.{name}.{hash}` **And**
`display_name` is `mcp:{name}` (e.g., `mcp:filesystem`)

**AC3: Code URL Storage** **Given** an MCP server record **When** stored **Then** `code_url` field
contains the URL to fetch the implementation

**AC4: cap:lookup for MCP** **Given** `cap:lookup("mcp:filesystem")` **When** resolved in session
context **Then** returns
`{ type: "mcp-server", code_url: "...", version: "1.2.0", visibility: "public" }`

**AC5: Versioning** **Given** an MCP server with multiple versions **When**
`cap:lookup("mcp:filesystem@v1.2.0")` called **Then** returns specific version

**AC6: Visibility** **Given** an MCP server with `visibility: "org"` **When** another org tries to
resolve it **Then** returns not found error

**AC7: Seeding Base MCPs** **Given** initial system setup **When** migrations run **Then** base MCPs
are seeded: `mcp:filesystem`, `mcp:shell`, `mcp:sqlite`

**AC8: Routing Field** (KEY for 13.9) **Given** an MCP server record **When** stored **Then**
`routing` field indicates `"local"` or `"cloud"` **Example:** `mcp:filesystem` → `routing: "local"`,
`mcp:tavily` → `routing: "cloud"`

---

### Story 13.9: Routing Inheritance

**Problem Statement:** When a capability is created, we don't know if it needs local or cloud
execution. But we CAN infer this from the tools it uses: if ANY tool is local-only (filesystem,
shell), the capability MUST run locally. This avoids manual routing configuration.

**As a** developer, **I want** capability routing automatically inherited from tools used, **So
that** local execution happens when any tool requires local access.

**Acceptance Criteria:**

**AC1: Tools Used Tracking** **Given** a capability created via `pml_execute` **When** execution
completes **Then** `tools_used` array is populated with all tools called during execution

**AC2: Routing Resolution - Local Priority** **Given** capability with
`tools_used: ["filesystem:read", "pml:search"]` **When** routing is resolved **Then**
`routing = "local"` because filesystem is local

**AC3: Routing Resolution - All Cloud** **Given** capability with
`tools_used: ["pml:search", "tavily:search"]` **When** routing is resolved **Then**
`routing = "cloud"` because all tools are cloud

**AC4: Routing Lookup** **Given** tool name like `filesystem:read` **When** routing lookup performed
**Then** checks `mcp-permissions.yaml` for the server's routing config

**AC5: Explicit Override** **Given** capability with explicit `routing: "cloud"` in metadata
**When** routing is resolved **Then** explicit value is used regardless of tools_used

**AC6: No Tools Used** **Given** capability with empty `tools_used` (pure compute) **When** routing
is resolved **Then** defaults to `cloud`

**AC7: API Exposure** **Given** `cap:lookup("my-reader")` **When** resolved **Then** response
includes `routing: "local" | "cloud"`
