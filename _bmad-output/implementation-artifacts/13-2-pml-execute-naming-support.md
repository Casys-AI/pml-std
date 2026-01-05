# Story 13.2: pml_execute Auto-FQDN & Accept Suggestion

Status: done

## Story

As a **developer**, I want **capabilities to get auto-generated FQDNs and be executable from suggestions**, So
that **I can reuse capabilities discovered via Suggestion mode**.

## Acceptance Criteria

### AC1: Auto-generated FQDN

**Given** `pml_execute({ intent, code })` **When** executed successfully **Then** capability
registered in `capability_records` with auto-generated FQDN like
`local.default.filesystem.exec_a7f3b2c1.a7f3`

### AC2: Deduplication by Code Hash

**Given** same code executed twice **When** second pml_execute called **Then** existing capability
reused (usage_count incremented), no duplicate created

### AC3: Response Includes FQDN

**Given** successful pml_execute **When** response returned **Then** includes `capabilityName`
(auto-generated) and `capabilityFqdn` (full FQDN)

### AC4: Auto-generated Display Name

**Given** pml_execute without explicit naming **When** executed successfully **Then** capability
receives display_name like `unnamed_<hash>` or inferred from intent

### AC6: Accept Suggestion (formerly Call-by-Name)

**Given** a Suggestion mode response with `suggestedDag.tasks[0].callName = "fs:read_json"` **When**
`pml_execute({ accept_suggestion: { callName: "fs:read_json", args: { path: "config.json" } } })`
**Then** capability code is executed with args merged into context

> **Note:** This replaces the former Call-by-Name mode which used `capability` and `args` as
> top-level parameters. The new design treats execution of suggested capabilities as a **response
> pattern** to a previous Suggestion mode response, not as a separate execution mode.

### AC7: Name Resolution

**Given** callName from suggestedDag **When** lookup performed via `CapabilityRegistry.resolveByName()`
**Then** resolves to full FQDN and retrieves `code_snippet` from `capability_records`

### AC8: Args Merging

**Given** capability with default params `{ encoding: "utf-8" }` (from `parameters_schema.default`)
**When** called with args `{ path: "x.json" }` **Then** execution context has
`{ path: "x.json", encoding: "utf-8" }`

### AC9: Not Found Error

**Given** non-existent callName **When** pml_execute called with `accept_suggestion: { callName: "non-existent" }`
**Then** returns error "Capability not found for callName: non-existent"

### AC10: Usage Tracking

**Given** capability executed via accept_suggestion **When** execution completes **Then** `usage_count`
incremented in `capability_records` and `success_count` updated based on result

## Tasks / Subtasks

- [x] Task 1: Extend ExecuteArgs Interface (AC: #6)
  - [x] 1.1: Add `accept_suggestion?: { callName: string; args?: Record<string, JsonValue> }` response pattern
  - [x] 1.2: Add `continue_workflow?: { workflow_id: string; approved: boolean }` response pattern
  - [x] 1.3: Update JSDoc with examples for suggestion → accept flow
  - Note: Former Call-by-Name mode (`capability` + `args` params) replaced with `accept_suggestion` response pattern.

- [x] Task 2: Extend ExecuteResponse Interface (AC: #3)
  - [x] 2.1: Add `capabilityName?: string` field (auto-generated)
  - [x] 2.2: Add `capabilityFqdn?: string` field (auto-generated)
  - [x] 2.3: Update response building in `executeDirectMode()` to include new fields

- [x] Task 3: Implement Auto-FQDN in Direct Mode (AC: #1, #4, #3)
  - [x] 3.1: Create session scope context: `{ org: "local", project: "default" }`
  - [x] 3.2: After successful execution, create `CapabilityRecord` via `CapabilityRegistry.create()`
  - [x] 3.3: Auto-generate displayName as `unnamed_<hash>` or from capability.name
  - [x] 3.4: Auto-generate FQDN: `{org}.{project}.{namespace}.exec_{hash}.{hash}`
  - [x] 3.5: Include `capabilityName` and `capabilityFqdn` in response

- [x] Task 4: Implement Accept Suggestion Response Pattern (AC: #6, #7, #8, #9)
  - [x] 4.1: Detect accept_suggestion when `params.accept_suggestion` is present
  - [x] 4.2: Resolve callName via `CapabilityRegistry.resolveByName(callName, scope)`
  - [x] 4.3: Fetch `code_snippet` and `parameters_schema` from resolved record
  - [x] 4.4: Merge `args` with defaults from `parameters_schema.default`
  - [x] 4.5: Execute capability code via existing DAG/WorkerBridge flow
  - [x] 4.6: Record usage via `CapabilityRegistry.recordUsage(fqdn, success, latencyMs)`

- [x] Task 5: Wire CapabilityRegistry Dependency (AC: all)
  - [x] 5.1: Add `capabilityRegistry?: CapabilityRegistry` to `ExecuteDependencies`
  - [x] 5.2: Initialize `CapabilityRegistry` in Gateway startup with PGliteClient
  - [x] 5.3: Pass registry to `handleExecute()` via deps

- [x] Task 6: Unit Tests (AC: all)
  - [x] 6.1: Test mutual exclusivity (code + capability error)
  - [x] 6.2: Test call-by-name requires registry
  - [x] 6.3: Test not-found error
  - [x] 6.4: Test mode detection priority

## Dev Notes

### Architecture: Dual-Table Strategy

Story 13.1 introduced `capability_records` as a **registry** alongside `workflow_pattern`. Story
13.2 connects them:

```
┌──────────────────────┐         ┌───────────────────────┐
│   capability_records │ ◄────── │    workflow_pattern   │
│   (FQDN registry)    │ code_   │  (code, embeddings,   │
│   Story 13.1         │ hash    │   execution stats)    │
└──────────────────────┘         └───────────────────────┘
       │
       │  display_name
       ▼
   "my-config-reader"
```

**Linking Strategy:**

- When capability is named, find or create `capability_records` entry
- Link via matching `code_hash` (capability_records.hash == workflow_pattern.code_hash first 4
  chars)
- `workflow_pattern` continues to store execution data (success_rate, avg_duration_ms)
- `capability_records` stores naming metadata (display_name, visibility, tags)

### ExecuteArgs Extension

```typescript
// src/mcp/handlers/execute-handler.ts
export interface ExecuteArgs {
  /** Natural language description of the intent (REQUIRED for Direct/Suggestion modes) */
  intent?: string;
  /** TypeScript code to execute (OPTIONAL - triggers Mode Direct) */
  code?: string;
  /** Execution options */
  options?: {
    timeout?: number;
    per_layer_validation?: boolean;
  };

  // === Response Patterns (to previous execute responses) ===

  /** Accept a suggestion from suggestedDag */
  accept_suggestion?: {
    callName: string;  // From suggestedDag.tasks[n].callName
    args?: Record<string, JsonValue>;
  };

  /** Continue a paused workflow */
  continue_workflow?: {
    workflow_id: string;
    approved: boolean;
  };
}
```

### Execution Flow

```typescript
// In handleExecute()

// Response Pattern: Continue Workflow
if (params.continue_workflow) {
  return await handleApprovalResponse(...);
}

// Response Pattern: Accept Suggestion
if (params.accept_suggestion) {
  return await executeAcceptedSuggestion(callName, args, options, deps, startTime);
}

// Primary Modes (require intent)
if (params.code) {
  // Mode: Direct - execute code, auto-generate FQDN
  return await executeDirectMode(intent, code, options, deps, startTime);
} else {
  // Mode: Suggestion - DR-DSP search → Return suggestions
  return await executeSuggestionMode(intent, options, deps, startTime);
}
```

### Suggestion → Accept Flow

```typescript
// Step 1: Get suggestions
pml_execute({ intent: "read JSON config" })
// Response:
// {
//   status: "suggestions",
//   suggestions: {
//     suggestedDag: {
//       tasks: [{
//         callName: "fs:read_json",
//         type: "capability",
//         inputSchema: { properties: { path: { type: "string" } } }
//       }]
//     },
//     confidence: 0.85
//   }
// }

// Step 2: Accept the suggestion
pml_execute({
  accept_suggestion: {
    callName: "fs:read_json",  // From suggestedDag
    args: { path: "config.json" }  // Built according to inputSchema
  }
})
// Response: { status: "success", result: {...}, mode: "accept_suggestion" }
```

### Scope Context

For now, use hardcoded scope for local development:

```typescript
const defaultScope: Scope = {
  org: "local",
  project: "default",
};

// Future: Extract from session/auth context
// const scope = deps.sessionContext?.scope ?? defaultScope;
```

### Args Merging Algorithm

```typescript
function mergeArgs(
  providedArgs: Record<string, JsonValue>,
  parametersSchema: JSONSchema | undefined,
): Record<string, JsonValue> {
  const merged = { ...providedArgs };

  if (parametersSchema?.properties) {
    for (const [key, schema] of Object.entries(parametersSchema.properties)) {
      if (!(key in merged) && schema.default !== undefined) {
        merged[key] = schema.default;
      }
    }
  }

  return merged;
}
```

### Error Messages

| Scenario            | Error Message                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| Invalid name format | `Invalid capability name: "{name}". Must be alphanumeric with underscores, hyphens, and colons only.` |
| Name collision      | `Capability name '{name}' already exists in scope {org}.{project}`                                    |
| Not found           | `Capability not found: {name}`                                                                        |
| Resolved via alias  | `[WARN] Deprecated: Using alias "{alias}" for capability "{displayName}". Update your code.`          |

### Project Structure Notes

| File                                              | Purpose                                                    |
| ------------------------------------------------- | ---------------------------------------------------------- |
| `src/mcp/handlers/execute-handler.ts`             | Main handler - extend `ExecuteArgs`, add call-by-name mode |
| `src/capabilities/capability-registry.ts`         | Already exists (Story 13.1) - use for name resolution      |
| `src/capabilities/fqdn.ts`                        | Already exists - use `isValidMCPName()` for validation     |
| `src/mcp/server/types.ts`                         | Add `capabilityRegistry` to gateway config if needed       |
| `tests/unit/mcp/execute_handler_naming_test.ts`   | New unit tests                                             |
| `tests/integration/capability_naming_e2e_test.ts` | New E2E tests                                              |

### Existing Dependencies to Use

From `src/capabilities/capability-registry.ts` (Story 13.1):

- `CapabilityRegistry.create()` - Create named capability record
- `CapabilityRegistry.resolveByName()` - Resolve name to FQDN
- `CapabilityRegistry.recordUsage()` - Increment usage metrics

From `src/capabilities/fqdn.ts` (Story 13.1):

- `isValidMCPName()` - Validate MCP-compatible name format
- `generateHash()` - Generate 4-char hash for FQDN

From `src/capabilities/types.ts`:

- `Scope` - org/project context
- `CapabilityRecord` - Registry record type

### Response Format Extension

```typescript
// Extended response for capabilities
const response: ExecuteResponse = {
  status: "success",
  result: executionResult,
  capabilityId: capability.id, // UUID (existing)
  capabilityName: record?.displayName, // "my-config-reader" or "unnamed_a7f3"
  capabilityFqdn: record?.id, // "local.default.fs.read_json.a7f3"
  mode: "direct" | "accept_suggestion", // Execution mode used
  executionTimeMs,
  dag: {/* existing */},
};
```

### References

- [Story 13.1: Schema, FQDN & Aliases](./13-1-schema-fqdn-aliases.md) - Foundation for this story
- [Epic 13: Capability Naming & Curation](../epics/epic-13-capability-naming-curation.md) -
  FR001-FR008
- [execute-handler.ts](../../src/mcp/handlers/execute-handler.ts) - Main file to modify
- [capability-registry.ts](../../src/capabilities/capability-registry.ts) - Name resolution
- [capability-store.ts](../../src/capabilities/capability-store.ts) - Execution stats storage
- [Project Context](../project-context.md) - Technology stack, coding patterns

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5

### Debug Log References

### Completion Notes List

- Implemented 2 primary modes + 2 response patterns:
  - Primary: Direct (intent + code), Suggestion (intent only)
  - Response patterns: `accept_suggestion`, `continue_workflow`
- Extended `ExecuteArgs` with response patterns (removed old `capability`, `args`, `resume`, `approved`)
- Extended `ExecuteResponse` with `capabilityName`, `capabilityFqdn` fields
- Auto-generate FQDN on execution: `{org}.{project}.{namespace}.exec_{hash}.{hash}`
- Auto-generate displayName as `unnamed_<hash>` until renamed via cap:name
- Deduplication by code_hash: same code = same capability (usage_count++)
- Implemented `executeAcceptedSuggestion()` for suggestion acceptance (replaces `executeByNameMode()`)
- Added `mergeArgsWithDefaults()` for args merging with schema defaults
- Wired `CapabilityRegistry` into gateway-server.ts

**API Refactor (Response Patterns):**

- Removed Call-by-Name as a separate mode - now a response pattern to Suggestion mode
- `accept_suggestion: { callName, args }` replaces `capability` + `args` top-level params
- `continue_workflow: { workflow_id, approved }` replaces `resume` + `approved` top-level params
- Updated MCP schema in `definitions.ts` to reflect new structure
- Flow: Suggestion → suggestedDag response → accept_suggestion → execution

**Architecture Fix (Migration 022-023):**

- Migration 022: Removed duplicated `workflow_pattern.name` column (unified naming via
  capability_records)
- Migration 023: Added `workflow_pattern_id` FK to capability_records, removed duplicated columns
  (code_snippet, description, parameters_schema, tools_used)
- Updated `CapabilityRegistry.create()` to use FK + hash instead of duplicating data
- Updated `executeAcceptedSuggestion()` to fetch code from workflow_pattern via FK
- Updated `data-service.ts` JOIN to use FK instead of hash-based join
- Final architecture: capability_records = registry (naming), workflow_pattern = source of truth
  (code/stats)

### File List

- `src/mcp/handlers/execute-handler.ts` - Main implementation (2 modes + 2 response patterns)
- `src/mcp/gateway-server.ts` - Registry wiring + TraceFeatureExtractor init
- `src/capabilities/capability-registry.ts` - FK-based create()
- `src/capabilities/capability-store.ts` - Updated for Story 13.2 integration
- `src/capabilities/types.ts` - CapabilityRecord with workflowPatternId
- `src/capabilities/data-service.ts` - FK-based JOIN
- `src/capabilities/per-priority.ts` - PER priority updates
- `src/db/migrations.ts` - Migration registry updates
- `src/db/migrations/022_unify_capability_naming.ts` - Remove workflow_pattern.name
- `src/db/migrations/023_capability_records_fk.ts` - Add FK, remove duplicates
- `src/mcp/server/types.ts` - Type exports for registry
- `src/mcp/routing/handlers/capabilities.ts` - API endpoint updates
- `src/mcp/routing/handlers/graph.ts` - Graph handler updates
- `tests/unit/mcp/handlers/execute_handler_test.ts` - Unit tests (18 passing)
- `tests/unit/capabilities/data_service_test.ts` - Updated tests
