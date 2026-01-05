# Story 13.3: CapabilityMCPServer + Gateway

Status: done

## Story

As a **MCP client (Claude)**, I want **capabilities to appear as MCP tools in the unified tool
list**, So that **I can discover and call them like any other MCP tool**.

## Design Decisions (2025-12-24)

**Core Architecture:**

- **Format:** `mcp__<namespace>__<action>` (indistinguable des outils MCP natifs)
- **Pattern:** CapabilityMCPServer implémente `MCPClientBase` (même interface que vrais MCPs)
- **Architecture:** Suivre les nouveaux Architecture Patterns de project-context.md
- **Structure:** Feature Module Pattern avec vertical slices

**Exemple:**

```
Capability: namespace=code, action=analyze
→ MCP tool: mcp__code__analyze
→ Claude appelle: tools/call mcp__code__analyze
→ Gateway route vers CapabilityMCPServer
→ Exécution via WorkerBridge
```

## Acceptance Criteria

### AC1: Tool Listing

**Given** 5 capabilities: `code:analyze`, `code:refactor`, `data:transform` **When** `tools/list`
appelé sur Gateway **Then** retourne tools `mcp__code__analyze`, `mcp__code__refactor`,
`mcp__data__transform` avec inputSchema

### AC2: Tool Execution

**Given** tool call `mcp__code__analyze` avec args `{ file: "src/main.ts" }` **When** `tools/call`
exécuté **Then** capability code exécuté via sandbox et résultat retourné format MCP

### AC3: Error Handling

**Given** tool call pour capability inexistante **When** exécuté **Then** retourne
`{ isError: true, content: [{ type: "text", text: "Capability not found" }] }`

### AC4: InputSchema from parameters_schema

**Given** capability avec `parameters_schema` dans workflow_pattern **When** listé comme tool
**Then** tool.inputSchema = capability.parameters_schema

### AC5: Usage Tracking

**Given** capability appelée avec succès **When** exécution complète **Then** `usage_count` et
`success_count` incrémentés via `CapabilityRegistry.recordUsage()`

### AC6: Gateway Integration

**Given** Gateway avec 3 vrais MCPs + 5 capabilities **When** `handleListTools()` appelé **Then**
retourne tous les tools (meta-tools + capability tools) dans une liste unifiée

### AC7: Immediate Visibility

**Given** nouvelle capability créée **When** prochain `tools/list` appelé **Then** capability
apparaît immédiatement (query DB, pas de cache)

## Architecture

### Feature Module Structure (project-context.md Pattern)

```
src/mcp/capability-server/
  mod.ts                    # Public exports
  interfaces.ts             # CapabilityExecutor, CapabilityLister interfaces
  server.ts                 # CapabilityMCPServer class (implements MCPClientBase)
  handlers/
    mod.ts                  # Handler exports
    list-handler.ts         # listTools implementation
    call-handler.ts         # callTool implementation
  services/
    capability-executor.ts  # Business logic for execution
```

### Interface-First Design

```typescript
// src/mcp/capability-server/interfaces.ts

export interface CapabilityLister {
  /** List all capabilities as MCP tools */
  listTools(): Promise<MCPTool[]>;
}

export interface CapabilityExecutor {
  /** Execute capability by MCP tool name */
  execute(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<ExecuteResult>;
}

export interface ExecuteResult {
  success: boolean;
  data: unknown;
  error?: string;
  latencyMs: number;
}
```

### Server Class (Max 5 Dependencies)

```typescript
// src/mcp/capability-server/server.ts

export class CapabilityMCPServer implements MCPClientBase {
  readonly serverId = "pml-capabilities";
  readonly serverName = "PML Capabilities";

  constructor(
    private lister: CapabilityLister,
    private executor: CapabilityExecutor,
    private registry: CapabilityRegistry,
  ) {}

  async connect(): Promise<void> {/* no-op */}
  async disconnect(): Promise<void> {/* no-op */}
  async close(): Promise<void> {/* no-op */}

  async listTools(): Promise<MCPTool[]> {
    return this.lister.listTools();
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const result = await this.executor.execute(name, args);

    // Track usage
    const { namespace, action } = parseToolName(name);
    const fqdn = await this.findFqdnByNamespaceAction(namespace, action);
    if (fqdn) {
      await this.registry.recordUsage(fqdn, result.success, result.latencyMs);
    }

    if (!result.success) {
      return {
        isError: true,
        content: [{ type: "text", text: result.error || "Execution failed" }],
      };
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }],
    };
  }
}
```

### Service Layer (Repository Pattern)

```typescript
// src/mcp/capability-server/services/capability-executor.ts

export class CapabilityExecutorService implements CapabilityExecutor {
  constructor(
    private capabilityStore: CapabilityStore,
    private capabilityRegistry: CapabilityRegistry,
    private workerBridge: WorkerBridge,
  ) {}

  async execute(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<ExecuteResult> {
    const startTime = Date.now();

    // Parse tool name: mcp__namespace__action
    const { namespace, action } = parseToolName(toolName);
    if (!namespace || !action) {
      return { success: false, data: null, error: "Invalid tool name format", latencyMs: 0 };
    }

    // Find capability via registry (Repository pattern)
    const displayName = `${namespace}:${action}`;
    const scope = { org: "local", project: "default" };
    const record = await this.capabilityRegistry.resolveByName(displayName, scope);

    if (!record) {
      return {
        success: false,
        data: null,
        error: `Capability not found: ${toolName}`,
        latencyMs: Date.now() - startTime,
      };
    }

    // Get code from workflow_pattern via FK
    const pattern = await this.capabilityStore.getById(record.workflowPatternId!);
    if (!pattern?.codeSnippet) {
      return {
        success: false,
        data: null,
        error: `Capability has no code: ${toolName}`,
        latencyMs: Date.now() - startTime,
      };
    }

    // Execute via sandbox
    try {
      const result = await this.workerBridge.execute({
        code: pattern.codeSnippet,
        context: args,
        timeout: 30000,
      });

      return {
        success: true,
        data: result,
        latencyMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        data: null,
        error: (error as Error).message,
        latencyMs: Date.now() - startTime,
      };
    }
  }
}
```

### Lister Service

```typescript
// src/mcp/capability-server/services/capability-lister.ts

export class CapabilityListerService implements CapabilityLister {
  constructor(private capabilityStore: CapabilityStore) {}

  async listTools(): Promise<MCPTool[]> {
    // Use repository pattern - no direct SQL
    const capabilities = await this.capabilityStore.listWithSchemas({
      visibility: ["public", "org", "project", "private"],
      createdBy: "local",
      limit: 100,
      orderBy: "usageCount",
    });

    return capabilities.map((cap) => ({
      name: `mcp__${cap.namespace}__${cap.action}`,
      description: cap.description || `Capability: ${cap.displayName}`,
      inputSchema: cap.parametersSchema || { type: "object", properties: {} },
    }));
  }
}
```

### Gateway Integration

```typescript
// src/mcp/gateway-server.ts modifications

export class PMLGatewayServer {
  private capabilityServer: CapabilityMCPServer;

  constructor(...) {
    // Initialize capability server with services
    const lister = new CapabilityListerService(this.capabilityStore);
    const executor = new CapabilityExecutorService(
      this.capabilityStore,
      this.capabilityRegistry,
      this.workerBridge,
    );
    this.capabilityServer = new CapabilityMCPServer(lister, executor, this.capabilityRegistry);
  }

  private async handleListTools(): Promise<{ tools: MCPTool[] }> {
    const metaTools = getMetaTools();
    const capabilityTools = await this.capabilityServer.listTools();
    return { tools: [...metaTools, ...capabilityTools] };
  }

  private async routeToolCall(name: string, args: unknown): Promise<MCPToolResponse> {
    // Route capability tools
    if (name.startsWith("mcp__")) {
      return await this.capabilityServer.callTool(name, args as Record<string, unknown>);
    }

    // Existing routing...
  }
}
```

## Tasks / Subtasks

- [ ] Task 1: Create Feature Module Structure (AC: all)
  - [ ] 1.1: Create `src/mcp/capability-server/` directory
  - [ ] 1.2: Create `interfaces.ts` with CapabilityLister, CapabilityExecutor, ExecuteResult
  - [ ] 1.3: Create `mod.ts` with public exports

- [ ] Task 2: Implement CapabilityListerService (AC: #1, #4, #7)
  - [ ] 2.1: Create `services/capability-lister.ts`
  - [ ] 2.2: Add `listWithSchemas()` method to CapabilityStore (Repository pattern)
  - [ ] 2.3: Implement `listTools()` with mcp__namespace__action format
  - [ ] 2.4: Unit tests for lister

- [ ] Task 3: Implement CapabilityExecutorService (AC: #2, #3, #5)
  - [ ] 3.1: Create `services/capability-executor.ts`
  - [ ] 3.2: Implement `parseToolName()` utility
  - [ ] 3.3: Implement `execute()` with WorkerBridge
  - [ ] 3.4: Handle not found / no code errors
  - [ ] 3.5: Unit tests for executor

- [ ] Task 4: Implement CapabilityMCPServer (AC: all)
  - [ ] 4.1: Create `server.ts` implementing MCPClientBase
  - [ ] 4.2: Wire lister and executor via constructor injection
  - [ ] 4.3: Implement listTools() delegation
  - [ ] 4.4: Implement callTool() with usage tracking
  - [ ] 4.5: Unit tests for server

- [ ] Task 5: Gateway Integration (AC: #6)
  - [ ] 5.1: Add CapabilityMCPServer initialization in Gateway constructor
  - [ ] 5.2: Modify handleListTools() to include capability tools
  - [ ] 5.3: Modify routeToolCall() to detect mcp__ pattern
  - [ ] 5.4: Integration tests

- [ ] Task 6: CapabilityStore Extensions (Repository Pattern)
  - [ ] 6.1: Add `listWithSchemas()` method
  - [ ] 6.2: Add `getById()` method if missing
  - [ ] 6.3: Ensure no direct SQL in services

## Dev Notes

### Tool Name Format

```typescript
// Parsing utility
function parseToolName(name: string): { namespace: string; action: string } | null {
  const match = name.match(/^mcp__([a-z0-9_]+)__([a-z0-9_]+)$/);
  if (!match) return null;
  return { namespace: match[1], action: match[2] };
}

// Generation
function toMCPToolName(namespace: string, action: string): string {
  return `mcp__${namespace}__${action}`;
}
```

### Data Flow

```
Claude: tools/list
  → Gateway.handleListTools()
    → getMetaTools() + capabilityServer.listTools()
      → CapabilityListerService.listTools()
        → CapabilityStore.listWithSchemas() [Repository]
    ← [pml:execute, pml:discover, mcp__code__analyze, ...]

Claude: tools/call mcp__code__analyze {file: "x.ts"}
  → Gateway.routeToolCall("mcp__code__analyze", {file: "x.ts"})
    → capabilityServer.callTool(...)
      → CapabilityExecutorService.execute(...)
        → CapabilityRegistry.resolveByName() [Repository]
        → CapabilityStore.getById() [Repository]
        → WorkerBridge.execute() [Sandbox]
      → CapabilityRegistry.recordUsage() [Repository]
    ← { content: [{ type: "text", text: "..." }] }
```

### Architecture Compliance Checklist

- [x] Service Layer Separation: Handlers → Services → Repositories
- [x] Repository Pattern: CapabilityStore, CapabilityRegistry
- [x] Interface-First: CapabilityLister, CapabilityExecutor interfaces
- [x] Constructor Injection: Max 3-4 dependencies per class
- [x] Feature Module: Self-contained `capability-server/` folder

### Files to Create/Modify

| File                                                        | Type   | Description               |
| ----------------------------------------------------------- | ------ | ------------------------- |
| `src/mcp/capability-server/mod.ts`                          | NEW    | Public exports            |
| `src/mcp/capability-server/interfaces.ts`                   | NEW    | Interfaces                |
| `src/mcp/capability-server/server.ts`                       | NEW    | CapabilityMCPServer class |
| `src/mcp/capability-server/services/capability-lister.ts`   | NEW    | Lister service            |
| `src/mcp/capability-server/services/capability-executor.ts` | NEW    | Executor service          |
| `src/capabilities/capability-store.ts`                      | MODIFY | Add listWithSchemas()     |
| `src/mcp/gateway-server.ts`                                 | MODIFY | Integration               |
| `tests/unit/mcp/capability-server/`                         | NEW    | Unit tests                |

### References

- [Story 13.1: Schema, FQDN & Aliases](./13-1-schema-fqdn-aliases.md)
- [Story 13.2: pml_execute Naming Support](./13-2-pml-execute-naming-support.md)
- [Epic 13: Capability Naming & Curation](../epics/epic-13-capability-naming-curation.md)
- [Project Context - Architecture Patterns](../project-context.md#architecture-patterns)

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5

### Debug Log References

N/A

### Completion Notes List

**2025-12-26: Core Implementation Complete (Tasks 1-5)**

Implementation following the Feature Module Pattern:

1. **Task 1: Module Structure** ✅
   - Created `src/mcp/capability-server/` with interfaces.ts, mod.ts
   - `parseToolName()` and `toMCPToolName()` utilities
   - 9 tests passing

2. **Task 2: CapabilityListerService** ✅
   - Implements `CapabilityLister` interface
   - Uses `CapabilityStore.listWithSchemas()` (new method added)
   - Maps capabilities to MCP tool format: `mcp__<namespace>__<action>`
   - 7 tests passing

3. **Task 3: CapabilityExecutorService** ✅
   - Implements `CapabilityExecutor` interface
   - Resolves capability via `CapabilityRegistry.resolveByName()`
   - Gets code from `CapabilityStore.findById()`
   - Executes via `WorkerBridge`
   - 7 tests passing

4. **Task 4: CapabilityMCPServer** ✅
   - Orchestrates listing and execution
   - `handleListTools()` - returns capability tools
   - `handleCallTool()` - executes and records usage
   - `isCapabilityTool()` - routing helper
   - 8 tests passing

5. **Task 5: Gateway Integration** ✅
   - Added `CapabilityMCPServer` to `PMLGatewayServer`
   - Added routing for `mcp__` prefix in `routeToolCall()`
   - Initialized with `WorkerBridge` for sandbox execution

**Total: 31 unit tests + 2 e2e tests passing**

**2025-12-26: E2E Integration Tests Added**

- Created `tests/integration/capability_server_e2e_test.ts`
- Test 1: Full integration - capability found, resolved, executed via WorkerBridge
- Test 2: Unknown capability - returns proper "not found" error
- Both tests validate complete flow: Gateway → CapabilityMCPServer → WorkerBridge

### File List

- `src/mcp/capability-server/interfaces.ts` - Interfaces and utilities
- `src/mcp/capability-server/mod.ts` - Module exports
- `src/mcp/capability-server/server.ts` - CapabilityMCPServer class
- `src/mcp/capability-server/services/capability-lister.ts` - Lister service
- `src/mcp/capability-server/services/capability-executor.ts` - Executor service
- `src/capabilities/types.ts` - Added CapabilityWithSchema, ListWithSchemasOptions
- `src/capabilities/capability-store.ts` - Added listWithSchemas() method
- `src/mcp/gateway-server.ts` - Integration with Gateway
- `src/mcp/handlers/execute-handler.ts` - Added capabilityRegistry dependency for naming support
- `tests/unit/mcp/capability-server/interfaces_test.ts` - 9 tests
- `tests/unit/mcp/capability-server/capability-lister_test.ts` - 7 tests
- `tests/unit/mcp/capability-server/capability-executor_test.ts` - 7 tests
- `tests/unit/mcp/capability-server/server_test.ts` - 8 tests
- `tests/integration/capability_server_e2e_test.ts` - 2 e2e tests
