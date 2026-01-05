# Epic Technical Specification: Agent Code Execution & Local Processing

Date: 2025-11-20 Author: BMad Epic ID: 3 Status: Draft

---

## Overview

Epic 3 implémente un environnement d'exécution de code TypeScript sécurisé et isolé, permettant aux
agents LLM d'**écrire du code de traitement** qui s'exécute localement pour filtrer/agréger les
données volumineuses, retournant uniquement un résumé compact au contexte LLM. Inspiré par
l'approche Anthropic de code execution, le flow typique est: (1) L'agent LLM voit les tools
disponibles via vector search (Epic 1), (2) L'agent **décide** quelle analyse faire et **écrit le
code TypeScript** pour la réaliser, (3) Ce code s'exécute dans un sandbox Deno isolé avec accès aux
MCP tools, (4) Le résultat traité retourne au contexte LLM, pas les données brutes.

**Exemple concret:** L'agent reçoit la requête "Analyse les commits de la semaine dernière". Via
vector search, il découvre le tool `github.listCommits()`. L'agent **écrit alors du code
TypeScript** qui appelle ce tool, filtre les commits de la semaine dernière, agrège par auteur, et
retourne `{ total: 42, top_authors: [...] }` (500 bytes) au lieu des 1000 commits bruts (1.2MB). Le
LLM garde le contrôle de **quoi** analyser, mais le traitement lourd s'exécute localement,
économisant 99.96% du contexte.

Epic 3 représente le **point de délégation** entre Epic 2.5 (ControlledExecutor orchestration) et
l'exécution de code isolée : le ControlledExecutor peut inclure des tâches `code_execution` dans ses
DAGs, qui s'exécutent dans un sandbox Deno avec permissions explicites, filesystem virtuel (ou hooks
pour), et capacité de rollback sans side-effects. Cette architecture safe-to-fail débloque la
speculation agressive (Epic 3.5) puisque les branches sandbox échouées ne corrompent pas l'état
système.

## Objectives and Scope

### In Scope

**Core Sandbox Foundation (Stories 3.1-3.2):**

- ✅ Deno sandbox executor avec isolation complète (subprocess, permissions explicites)
- ✅ Timeout enforcement (30s default), memory limits (512MB heap)
- ✅ MCP tools injection dans le contexte sandbox via vector search
- ✅ Type-safe tool wrappers générés automatiquement
- ✅ Error handling structuré (syntax, runtime, timeout errors)

**Code Execution Integration (Story 3.4):**

- ✅ MCP tool `pml:execute_code` exposé via gateway
- ✅ Intent-based mode (vector search → inject tools) et explicit mode
- ✅ DAG integration: nouveau type de tâche `code_execution`
- ✅ ControlledExecutor (Epic 2.5) peut déléguer tasks au sandbox
- ✅ Checkpoint-compatible (résultats structurés pour PGlite persistence)

**Safe-to-Fail & Rollback Foundation (Story 3.4 + prep 3.5):**

- ✅ Virtual filesystem hooks (ou implémentation basique)
- ✅ Rollback support: exécution peut être aborted sans side-effects
- ✅ Idempotence: code execution tasks sont safe-to-retry
- ✅ Foundation pour speculation (Epic 3.5)

**Security & Hardening (Stories 3.5-3.8 partiel):**

- ✅ PII detection basique (patterns regex pour emails, SSNs, tokens)
- ✅ Code execution caching (résultats identiques pour code identique)
- ✅ Sandbox security hardening (sandboxing renforcé)

### Out of Scope (Deferred)

**Story 3.3 - Local Data Processing Pipeline:**

- ❌ Pre-built pipeline helpers (filter, map, reduce, groupBy) → **Scope needs clarification**
- ❌ **Rationale:** Story 3.4 (execute_code) already covers code execution. Story 3.3 might be
  redundant or needs redefinition as "stdlib"

**Advanced Safe-to-Fail (Story 3.5 - Full implementation):**

- ❌ Complete safe-to-fail branches implementation (partial success, aggregation patterns)
- ❌ Resilient workflows (retry logic, graceful degradation, A/B testing)
- ❌ **Rationale:** Foundation in 3.4, full feature in separate story 3.5 or Epic 3.5

**Advanced PII & Optimization (Stories 3.6-3.7 - Advanced features):**

- ❌ ML-based PII detection (beyond regex patterns)
- ❌ Advanced caching strategies (semantic similarity, TTL policies)
- ❌ Code optimization (dead code elimination, bundling)

**Epic 3.5 (Speculation with Sandbox):**

- ❌ Speculative execution utilizing sandbox isolation
- ❌ Confidence-based branch execution (threshold tuning)
- ❌ THE feature combining Epic 2 speculation + Epic 3 safety

**Epic 4 (Episodic Memory):**

- ❌ Episodic memory for code execution patterns
- ❌ Adaptive learning from execution history

## System Architecture Alignment

**Architecture Foundation:**

Epic 3 s'intègre dans l'architecture Casys PML en ajoutant la couche **Code Execution** entre Epic
2.5 (ControlledExecutor orchestration) et les MCP tools. L'architecture repose sur trois composants
principaux:

**1. Sandbox Executor (Deno subprocess):**

- Module: `src/sandbox/executor.ts`
- Isolation: Processus Deno séparé avec permissions explicites
- Contraintes: 512MB heap, 30s timeout, <100ms startup
- Sécurité: Aucun accès filesystem/network par défaut
- Output: Structured errors (syntax, runtime, timeout)

**2. MCP Tools Injection (Vector Search):**

- Module: `src/sandbox/context-builder.ts`
- Pattern: Intent-based mode utilise vector search (Epic 1.5)
- Wrappers: Type-safe tool wrappers générés automatiquement
- Routing: Tool calls routés via existing MCP gateway (Epic 2.4)
- Integration: Seamless avec 15+ MCP servers déjà supportés

**3. DAG Integration (Epic 2.5 Delegation Point):**

- Module: `src/dag/controlled-executor.ts` extension
- Task Type: Nouveau type `code_execution` ajouté à `TaskType` enum
- State Management: Results intégrés dans `WorkflowState` via reducers
- Checkpoints: Compatible PGlite persistence (Epic 2.5-2)
- Rollback: Safe-to-fail pattern avec virtual filesystem hooks

**Relation avec Epic 2.5 (ADR-007):**

Epic 3 résout les limitations de checkpointing identifiées dans Epic 2.5:

- **Epic 2.5:** Sauvegarde orchestration state uniquement (tasks, decisions, messages)
- **Epic 3:** Ajoute filesystem isolation via sandbox Deno
- **Délégation:** ControlledExecutor délègue modifications de code à sandbox
- **Rollback:** Code execution tasks peuvent être aborted sans side-effects
- **Speculation:** Foundation pour Epic 3.5 speculation safe (sandbox isolation)

**Components Référencés:**

| Component           | Module                           | Epic     | Role in Epic 3                             |
| ------------------- | -------------------------------- | -------- | ------------------------------------------ |
| PGlite + pgvector   | `src/db/client.ts`               | Epic 1.2 | Checkpoint persistence, vector search      |
| VectorSearch        | `src/vector/search.ts`           | Epic 1.5 | Intent-based tool discovery                |
| MCPGatewayServer    | `src/mcp/gateway-server.ts`      | Epic 2.4 | Tool routing, execute_code registration    |
| ControlledExecutor  | `src/dag/controlled-executor.ts` | Epic 2.5 | DAG orchestration, code_execution tasks    |
| WorkflowState       | `src/dag/state.ts`               | Epic 2.5 | State management, checkpoint compatibility |
| DenoSandboxExecutor | `src/sandbox/executor.ts`        | Epic 3.1 | NEW - Code execution isolation             |
| ContextBuilder      | `src/sandbox/context-builder.ts` | Epic 3.2 | NEW - Tool injection                       |

**Contraintes Architecturales:**

1. **Zero Breaking Changes:** Sandbox executor est un composant optionnel, n'affecte pas DAG
   execution existant
2. **Performance:** Maintain <100ms sandbox startup, <3s P95 pour workflows hybrides (MCP + code)
3. **Security:** Explicit permissions only, no eval(), structured error handling
4. **Portability:** Deno runtime requis (déjà présent), pas de dépendances système additionnelles

## Detailed Design

### Services and Modules

**1. DenoSandboxExecutor** (`src/sandbox/executor.ts`) - Story 3.1

- **Purpose:** Exécution isolée de code TypeScript dans subprocess Deno
- **API:**
  `async execute(code: string, context?: Record<string, unknown>): Promise<ExecutionResult>`
- **Features:**
  - Subprocess spawning avec `Deno.Command`
  - Permissions explicites: `--allow-env`, `--allow-read=<paths>`, deny all others
  - Timeout enforcement: AbortController avec 30s default
  - Memory limits: `--v8-flags=--max-old-space-size=512`
  - Structured errors: SyntaxError, RuntimeError, TimeoutError, MemoryError
- **Performance:** <100ms startup, <50ms overhead
- **Dependencies:** Deno 2.5+ runtime

**2. ContextBuilder** (`src/sandbox/context-builder.ts`) - Story 3.2

- **Purpose:** Injection de MCP tools dans contexte sandbox via vector search
- **API:** `async buildContext(intent: string, topK: number = 5): Promise<ToolContext>`
- **Features:**
  - Vector search integration (Epic 1.5) pour intent-based tool discovery
  - Type-safe wrapper generation: MCP tools → TypeScript functions
  - Tool routing via existing MCPGatewayServer
  - Error propagation: MCP errors → JavaScript exceptions
  - Security: No eval(), no dynamic code generation
- **Performance:** <200ms tool discovery + wrapping
- **Dependencies:** VectorSearch, MCPGatewayServer, MCP SDK

**3. MCPGatewayServer Extension** (`src/mcp/gateway-server.ts`) - Story 3.4

- **Purpose:** Registration du tool `pml:execute_code` exposé via MCP protocol
- **API:** MCP tool with schema
  `{ code: string, intent?: string, context?: object, sandbox_config?: object }`
- **Features:**
  - Intent-based mode: vector search → inject tools → execute code
  - Explicit mode: execute code with provided context
  - Output schema: `{ result: any, logs: string[], metrics: object, state?: object }`
  - Error handling: MCP-compliant error responses
- **Integration:** Bridges ControlledExecutor → DenoSandboxExecutor
- **Dependencies:** DenoSandboxExecutor, ContextBuilder, MCPClient

**4. ControlledExecutor Extension** (`src/dag/controlled-executor.ts`) - Story 3.4

- **Purpose:** Exécution de tasks `code_execution` type dans DAG workflows
- **Changes:** Add `code_execution` to `TaskType` enum, route to sandbox executor
- **Features:**
  - Hybrid DAG workflows: MCP tools + code execution
  - Checkpoint compatibility: Results structured for PGlite persistence
  - State integration: Results merged into WorkflowState via reducers
  - Rollback support: Code execution tasks are idempotent
- **Dependencies:** DenoSandboxExecutor, WorkflowState, DAGStructure

**Module Interaction Flow:**

```
User Intent → MCPGatewayServer.execute_code
              ↓
         (Intent-based mode)
              ↓
    ContextBuilder.buildContext(intent)
         ↓ (vector search)
    VectorSearch.searchTools(intent, k=5)
         ↓ (tool wrappers)
    MCPClient wrappers generated
              ↓
    DenoSandboxExecutor.execute(code, context)
              ↓
    (subprocess execution)
              ↓
    ExecutionResult → WorkflowState
```

### Data Models and Contracts

**SandboxConfig** (`src/sandbox/types.ts`)

```typescript
interface SandboxConfig {
  timeoutMs: number; // Default: 30000 (30s)
  heapLimitMB: number; // Default: 512MB
  allowedReadPaths?: string[]; // Default: ["~/.pml"]
  allowNetwork?: boolean; // Default: false
  allowWrite?: boolean; // Default: false
}
```

**ExecutionResult** (`src/sandbox/types.ts`)

```typescript
interface ExecutionResult {
  result: unknown; // JSON-serializable output
  logs: string[]; // stdout/stderr lines
  metrics: {
    executionTimeMs: number;
    startupTimeMs: number;
    memoryUsedMB: number;
  };
  state?: Record<string, any>; // For checkpoint compatibility (Story 3.4)
  // Merged into WorkflowState.context for persistence
}
```

**StructuredError** (`src/sandbox/types.ts`)

```typescript
interface StructuredError {
  type: "SyntaxError" | "RuntimeError" | "TimeoutError" | "MemoryError";
  message: string;
  stack?: string;
  code?: string; // Error code for categorization
  toolName?: string; // If error from MCP tool call
}
```

**ToolContext** (`src/sandbox/context-builder.ts`)

```typescript
interface ToolContext {
  tools: Record<string, ToolWrapper>; // e.g., { github: { listCommits: async (...) => ... } }
  types: string; // TypeScript type definitions (.d.ts content)
  metadata: {
    discoveredTools: string[]; // Tool IDs identified by vector search
    injectedTools: string[]; // Tools actually injected (may be fewer due to limits)
  };
}
```

**CodeExecutionTask** (`src/dag/types.ts`)

```typescript
interface CodeExecutionTask {
  id: string;
  type: "code_execution"; // NEW task type
  code: string; // TypeScript code to execute
  intent?: string; // For intent-based tool injection
  context?: Record<string, unknown>; // Explicit context
  sandbox_config?: SandboxConfig;
  dependencies: string[]; // Task IDs this depends on
}
```

**MCPToolSchema** (execute_code tool)

```json
{
  "name": "pml:execute_code",
  "description": "Execute TypeScript code in isolated Deno sandbox with optional MCP tools injection",
  "inputSchema": {
    "type": "object",
    "properties": {
      "code": { "type": "string", "description": "TypeScript code to execute" },
      "intent": {
        "type": "string",
        "description": "Natural language intent for tool discovery (optional)"
      },
      "context": { "type": "object", "description": "Explicit context object (optional)" },
      "sandbox_config": { "type": "object", "description": "Sandbox configuration (optional)" }
    },
    "required": ["code"]
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "result": { "description": "Execution result" },
      "logs": { "type": "array", "items": { "type": "string" } },
      "metrics": { "type": "object" },
      "state": { "type": "object", "description": "Workflow state for checkpoints (optional)" }
    }
  }
}
```

### APIs and Interfaces

**DenoSandboxExecutor Public API:**

```typescript
class DenoSandboxExecutor {
  constructor(config?: Partial<SandboxConfig>);

  async execute(
    code: string,
    context?: Record<string, unknown>,
  ): Promise<ExecutionResult>;

  async executeWithTimeout(
    code: string,
    context?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<ExecutionResult>;

  async dispose(): Promise<void>; // Cleanup resources
}
```

**ContextBuilder Public API:**

```typescript
class ContextBuilder {
  constructor(
    private vectorSearch: VectorSearch,
    private mcpGateway: MCPGatewayServer,
  );

  async buildContext(
    intent: string,
    topK?: number,
  ): Promise<ToolContext>;

  async buildContextExplicit(
    toolIds: string[],
  ): Promise<ToolContext>;

  generateTypeDefinitions(tools: ToolMetadata[]): string;
}
```

**MCPGatewayServer.execute_code Handler:**

```typescript
interface ExecuteCodeHandler {
  async handleExecuteCode(params: {
    code: string;
    intent?: string;
    context?: Record<string, unknown>;
    sandbox_config?: SandboxConfig;
  }): Promise<{
    result: unknown;
    logs: string[];
    metrics: object;
    state?: object;
  }>;
}
```

**ControlledExecutor Extension:**

```typescript
class ControlledExecutor extends ParallelExecutor {
  // Existing methods...

  private async executeCodeTask(
    task: CodeExecutionTask,
    workflowState: WorkflowState,
  ): Promise<TaskResult>;

  private async routeToSandbox(
    code: string,
    context: Record<string, unknown>,
    config?: SandboxConfig,
  ): Promise<ExecutionResult>;
}
```

### Workflows and Sequencing

**Workflow 1: Intent-Based Code Execution**

```
1. User/Agent → MCPGateway.execute_code({ code, intent: "analyze GitHub commits" })
2. MCPGateway → ContextBuilder.buildContext(intent, k=5)
3. ContextBuilder → VectorSearch.searchTools(intent)
   → Returns: ["github:list_commits", "github:get_repo", "json:parse", ...]
4. ContextBuilder → Generate wrappers for top-5 tools
   → Output: { github: { listCommits: async (...) => ... }, ... }
5. MCPGateway → DenoSandboxExecutor.execute(code, toolContext)
6. DenoSandboxExecutor → Spawn Deno subprocess
   → Inject code + tool wrappers
   → Execute with timeout/memory limits
7. Subprocess → Agent code calls github.listCommits()
   → Wrapper routes to MCPClient.callTool()
   → Returns results to agent code
8. DenoSandboxExecutor → Captures result, logs, metrics
9. MCPGateway → Returns ExecutionResult to caller
```

**Workflow 2: Explicit Mode Code Execution**

```
1. User/Agent → MCPGateway.execute_code({ code, context: { data: [...] } })
2. MCPGateway → DenoSandboxExecutor.execute(code, context)
   (No vector search, use provided context directly)
3. DenoSandboxExecutor → Spawn subprocess with context
4. Subprocess → Agent code processes context.data
5. DenoSandboxExecutor → Returns ExecutionResult
```

**Workflow 3: DAG Integration (Hybrid Workflow)**

```
1. ControlledExecutor → Build DAG with mixed task types:
   [
     { type: "mcp_tool", toolId: "github:list_commits" },  // Layer 0
     { type: "code_execution", code: "...", deps: [...] }, // Layer 1
     { type: "mcp_tool", toolId: "slack:send", deps: [...] } // Layer 2
   ]
2. ControlledExecutor → Execute Layer 0 (MCP tools)
   → Store results in WorkflowState.context
3. ControlledExecutor → Execute Layer 1 (code execution)
   → ControlledExecutor.routeToSandbox(code, context)
   → DenoSandboxExecutor.execute(code, context from Layer 0)
   → Result merged into WorkflowState via add_tasks reducer
4. ControlledExecutor → Checkpoint saved to PGlite
   → WorkflowState serialized with all task results
5. ControlledExecutor → Execute Layer 2 (dependent MCP tools)
6. ControlledExecutor → Returns DAGExecutionResult
```

**Workflow 4: Rollback & Safe-to-Fail**

```
1. ControlledExecutor → Execute code_execution task
2. DenoSandboxExecutor → Subprocess starts
   → Virtual filesystem hooks active (or basic implementation)
   → All file operations isolated
3. Agent code → Performs computations, potentially writes files
4. Mid-execution → User/Agent sends ABORT command
5. ControlledExecutor → Sends kill signal to subprocess
6. DenoSandboxExecutor → Subprocess terminated
   → No permanent side-effects (virtual filesystem discarded)
7. ControlledExecutor → Rolls back to previous checkpoint
   → WorkflowState restored from PGlite
8. Workflow → Can re-execute from checkpoint or continue differently
```

**Error Handling Sequence:**

```
Sandbox Error Types:
- SyntaxError: TypeScript parsing fails
  → Captured during subprocess startup
  → Returned immediately with structured error

- RuntimeError: Exception during execution
  → Captured from stderr
  → Stack trace preserved
  → Returned with error type + message

- TimeoutError: Execution exceeds 30s
  → AbortController triggers kill signal
  → Subprocess terminated
  → Returned with timeout metadata

- MemoryError: Heap exceeds 512MB
  → V8 throws OOM exception
  → Captured and structured
  → Returned with memory usage metrics

- MCPToolError: MCP call fails within sandbox
  → Wrapper converts MCP error → JavaScript exception
  → Agent code can try/catch
  → Propagates to ExecutionResult if uncaught
```

## Non-Functional Requirements

### Performance

**Sandbox Execution Performance:**

- **Startup Time:** <100ms sandbox initialization (AC Story 3.1 #9)
  - Achieved: 34.77ms in benchmarks
  - Target: P95 < 100ms
- **Execution Overhead:** <50ms per code execution (AC Story 3.1 #9)
  - Achieved: 33.22ms overhead
  - Includes: subprocess spawn + serialization + cleanup
- **Total Execution Time:** Simple code (<10 LOC) should complete in <500ms
  - Includes: startup + execution + result serialization

**Tool Discovery Performance:**

- **Vector Search:** <200ms for intent-based tool discovery (k=5)
  - Inherited from Epic 1.5 (<100ms P95 vector search)
  - +100ms for wrapper generation
- **Context Building:** <300ms total for ContextBuilder.buildContext()

**Hybrid Workflow Performance:**

- **DAG with Code Execution:** <3s P95 for workflows with 5 tasks (mixed MCP + code)
  - Maintains Epic 2 speedup 5x for parallel layers
  - Code execution tasks add minimal overhead (<500ms per task)

**Checkpoint Performance:**

- **Save:** <50ms to persist WorkflowState to PGlite (Epic 2.5)
- **Resume:** <100ms to restore from checkpoint

**Metrics to Track:**

- `sandbox_startup_ms`: Subprocess initialization time
- `code_execution_ms`: Actual code execution time
- `tool_discovery_ms`: Vector search + wrapper generation time
- `checkpoint_save_ms`: WorkflowState persistence time

### Security

**Sandbox Isolation:**

- **Explicit Permissions Only:** Deno subprocess avec permissions explicites
  - Allow: `--allow-env`, `--allow-read=~/.pml`
  - Deny: `--deny-write`, `--deny-net`, `--deny-run`, `--deny-ffi`
- **No Eval:** Aucune utilisation de `eval()` ou `Function()` constructor dans tool injection
- **Subprocess Isolation:** Code agent exécute dans processus séparé, pas dans main process
- **Resource Limits:** Timeout 30s, memory 512MB → prevent DoS attacks

**Code Injection Protection:**

- **No Dynamic Code Generation:** Tool wrappers générés via template strings sûrs, pas d'eval
- **Input Validation:** Tool names validés (no `__proto__`, no special chars)
- **Structured Errors:** Error messages sanitized, no sensitive data leaks

**MCP Tool Security:**

- **Existing Security Maintained:** Tool calls routés via MCPGatewayServer (Epic 2.4)
- **Health Checks:** Epic 2.5 health checks still enforced
- **Rate Limiting:** Epic 2.6 rate limiting applies to tool calls from sandbox

**Virtual Filesystem (Foundation):**

- **Hooks for Isolation:** Prepare architecture for isolated file operations
- **Rollback-Safe:** Code execution tasks can be aborted without permanent side-effects
- **Epic 3.5 Goal:** Full virtual filesystem implementation for speculation safety

### Reliability/Availability

**Error Handling:**

- **Structured Errors:** All sandbox errors typed (SyntaxError, RuntimeError, TimeoutError,
  MemoryError)
- **Graceful Degradation:** If sandbox fails, workflow continues with error result
- **Retry Logic:** Code execution tasks are idempotent, safe to retry
- **Timeout Enforcement:** Prevent infinite loops, ensure bounded execution time

**Checkpoint & Resume:**

- **Workflow Resilience:** WorkflowState checkpoints enable resume after failure
- **State Persistence:** PGlite persistence (Epic 2.5) ensures durability
- **Idempotence:** Code execution tasks safe-to-retry (foundation for Epic 3.5 speculation)

**Resource Management:**

- **Memory Limits:** 512MB heap prevents OOM crashes
- **Timeout Enforcement:** 30s timeout prevents hung processes
- **Process Cleanup:** Subprocess terminated on completion/error/timeout
- **No Resource Leaks:** Explicit disposal of sandbox resources

**Availability Targets:**

- **Uptime:** 99.9% (same as Epic 2 MCPGateway)
- **Failure Recovery:** <100ms to resume from checkpoint
- **Error Rate:** <1% code execution failures (excluding user code errors)

### Observability

**Logging:**

- **Sandbox Events:** Log sandbox creation, execution, completion, errors
- **Tool Discovery:** Log vector search results, injected tools
- **Execution Metrics:** Log startup time, execution time, memory usage
- **Error Details:** Structured error logging with type, message, stack

**Metrics (Telemetry):**

- **Execution Count:** `code_execution_total` (counter)
- **Execution Latency:** `code_execution_duration_ms` (histogram)
- **Error Rate:** `code_execution_errors_total` by error type (counter)
- **Memory Usage:** `sandbox_memory_mb` (gauge)
- **Tool Injection:** `tools_injected_count` (histogram)

**Event Stream (Epic 2.5 Integration):**

- **Execution Events:** Emit events via ControlledExecutor event stream
  - `code_execution_started`
  - `code_execution_completed`
  - `code_execution_failed`
- **Real-Time Observability:** Consumers can subscribe to code execution events

**Debugging Support:**

- **Logs Output:** Capture stdout/stderr from subprocess
- **Stack Traces:** Preserve stack traces for RuntimeErrors
- **Execution Context:** Log code snippet, intent, injected tools for debugging
- **Replay Capability:** Checkpoints enable re-execution of failed workflows

## Dependencies and Integrations

**Runtime Dependencies:**

- **Deno 2.5+ / 2.2 LTS:** Core runtime for TypeScript execution and subprocess management
- **PGlite 0.3.11:** Checkpoint persistence (Epic 2.5)
- **@modelcontextprotocol/sdk 1.21.1:** MCP protocol implementation

**Internal Dependencies (Epic 1 & 2):**

- **VectorSearch** (`src/vector/search.ts`) - Epic 1.5
  - Used by ContextBuilder for intent-based tool discovery
  - <100ms P95 semantic search performance
- **MCPGatewayServer** (`src/mcp/gateway-server.ts`) - Epic 2.4
  - Tool registration for `pml:execute_code`
  - MCP tool call routing from sandbox
- **ControlledExecutor** (`src/dag/controlled-executor.ts`) - Epic 2.5
  - Orchestrates code_execution tasks in DAG
  - Event stream + command queue + state management
- **WorkflowState** (`src/dag/state.ts`) - Epic 2.5
  - State management avec reducers (MessagesState pattern)
  - Checkpoint compatibility for code execution results

**External Integrations:**

- **MCP Servers (15+):** Tools can be called from agent code via wrappers
- **GitHub, Filesystem, etc.:** Existing MCP servers work seamlessly with code execution

**Epic 3 Internal Dependencies:**

- **Story 3.1 → Story 3.2:** ContextBuilder uses DenoSandboxExecutor for code execution
- **Story 3.1 + 3.2 → Story 3.4:** MCPGateway execute_code tool orchestrates both
- **Story 3.4 → Epic 2.5:** ControlledExecutor delegates to execute_code tool

**Note on DAG Replanning:**

- DAG replanning is handled by **Epic 2.5 Story 2.5-3** (already done ✅)
- AIL/HIL decision points can trigger `replan_dag` commands
- Code execution results are integrated into WorkflowState via `state` field
- Agent/Human decides when to replan based on code execution results

**Foundation for Epic 3.5:**

- **Safe-to-Fail Architecture:** Virtual filesystem hooks enable safe speculation
- **Idempotent Tasks:** Code execution tasks can be speculatively executed and rolled back
- **Isolation:** Sandbox prevents side-effects, perfect for speculative execution

## Acceptance Criteria (Authoritative)

**Epic 3 Global Acceptance Criteria:**

1. ✅ **Sandbox Foundation (Stories 3.1-3.2):**
   - Deno sandbox executor avec isolation complète (subprocess, permissions explicites)
   - Timeout enforcement (30s default), memory limits (512MB heap)
   - MCP tools injection dans le contexte sandbox via vector search
   - Type-safe tool wrappers générés automatiquement
   - Error handling structuré (syntax, runtime, timeout errors)

2. ✅ **Code Execution Integration (Story 3.4):**
   - MCP tool `pml:execute_code` exposé via gateway
   - Intent-based mode (vector search → inject tools) et explicit mode
   - DAG integration: nouveau type de tâche `code_execution`
   - ControlledExecutor (Epic 2.5) peut déléguer tasks au sandbox
   - Checkpoint-compatible (résultats structurés pour PGlite persistence)

3. ✅ **Safe-to-Fail & Rollback Foundation (Story 3.4 + prep 3.5):**
   - Virtual filesystem hooks (ou implémentation basique)
   - Rollback support: exécution peut être aborted sans side-effects
   - Idempotence: code execution tasks sont safe-to-retry
   - Foundation pour speculation (Epic 3.5)

4. ⚠️ **Story 3.3 Status:**
   - Scope clarification needed (Skip, Redefine, or Defer)
   - May be redundant with Story 3.4
   - Decision pending

5. ⏳ **Deferred to Later Stories:**
   - PII detection (Story 3.5)
   - Code execution caching (Story 3.6)
   - Advanced safe-to-fail (Story 3.5 full implementation)
   - E2E documentation (Story 3.7)
   - Security hardening (Story 3.8)

**Story-Level Acceptance Criteria:**

**Story 3.1 (Deno Sandbox Executor Foundation):**

1. ✅ Sandbox module créé (`src/sandbox/executor.ts`)
2. ✅ Deno subprocess spawned avec permissions explicites
3. ✅ Code execution isolée (no access outside allowed paths)
4. ✅ Timeout enforcement (30s default, configurable)
5. ✅ Memory limits enforcement (512MB heap)
6. ✅ Error capturing et structured error messages
7. ✅ Return value serialization (JSON-compatible outputs)
8. ✅ Unit tests validating isolation
9. ✅ Performance: <100ms startup, <50ms overhead

**Story 3.2 (MCP Tools Injection):**

1. ✅ Tool injection system créé (`src/sandbox/context-builder.ts`)
2. ✅ MCP clients wrapped as TypeScript functions
3. ✅ Code context includes typed tool wrappers
4. ✅ Vector search used to identify relevant tools (top-k)
5. ✅ Type definitions generated for autocomplete
6. ✅ Tool calls routed through existing MCP gateway
7. ✅ Error propagation: MCP errors → JavaScript exceptions
8. ✅ Integration test: Agent code calls tools successfully
9. ✅ Security: No eval() or dynamic code generation

**Story 3.4 (execute_code MCP Tool):**

1. ⏳ New MCP tool registered: pml:execute_code
2. ⏳ Input schema: { code, intent?, context?, sandbox_config? }
3. ⏳ Intent-based mode: vector search → inject tools → execute
4. ⏳ Explicit mode: Execute with specified context
5. ⏳ Output schema: { result, logs, metrics, state? }
6. ⏳ Error handling: Syntax, runtime, timeout errors
7. ⏳ Integration with gateway: Tool appears in list_tools
8. ⏳ DAG task type: Add code_execution to TaskType enum
9. ⏳ ControlledExecutor integration: Execute code tasks via sandbox
10. ⏳ Checkpoint compatible: Results for PGlite persistence
11. ⏳ State management: Results integrated into WorkflowState
12. ⏳ Virtual filesystem hooks: Prepare for isolated FS
13. ⏳ Rollback support: Execution can be aborted safely
14. ⏳ Safe-to-fail foundation: Tasks marked as idempotent
15. ⏳ Example workflow: ControlledExecutor → DAG → code task → checkpoint
16. ⏳ Documentation: README with Epic 2.5 delegation patterns

## Traceability Mapping

**PRD Requirements → Epic 3 Stories:**

| PRD Requirement                                  | Story    | Implementation                              |
| ------------------------------------------------ | -------- | ------------------------------------------- |
| FR017: Agent code execution                      | 3.1, 3.4 | DenoSandboxExecutor + execute_code tool     |
| FR018: Context optimization via local processing | 3.2, 3.4 | Tool injection + intent-based mode          |
| FR019: Security isolation                        | 3.1      | Deno subprocess avec permissions explicites |
| FR020: Hybrid workflows                          | 3.4      | code_execution task type in DAG             |
| NFR001: Performance (<3s P95)                    | 3.1      | <100ms startup, <50ms overhead              |
| NFR002: Security isolation                       | 3.1      | Subprocess, timeout, memory limits          |
| NFR003: Checkpoint resilience                    | 3.4      | WorkflowState compatibility                 |

**Architecture Components → Stories:**

| Component                | Epic | Story | Status                        |
| ------------------------ | ---- | ----- | ----------------------------- |
| DenoSandboxExecutor      | 3    | 3.1   | ✅ Done                       |
| ContextBuilder           | 3    | 3.2   | ✅ Review                     |
| execute_code tool        | 3    | 3.4   | ⏳ Ready for dev              |
| code_execution task type | 3    | 3.4   | ⏳ Ready for dev              |
| Virtual filesystem hooks | 3    | 3.4   | ⏳ Ready for dev (foundation) |
| PII detection            | 3    | 3.5   | 📋 Drafted                    |
| Code execution caching   | 3    | 3.6   | 📋 Drafted                    |
| E2E tests & docs         | 3    | 3.7   | 📋 Drafted                    |
| Security hardening       | 3    | 3.8   | 📋 Backlog                    |

**Epic 2.5 (ADR-007) Integration:**

| ADR-007 Concept       | Epic 3 Implementation                                       |
| --------------------- | ----------------------------------------------------------- |
| Loop 1: Execution     | Event stream emits code_execution events                    |
| Loop 2: Adaptation    | ControlledExecutor can replan DAG, inject code tasks        |
| Loop 3: Meta-Learning | Code execution patterns learned (deferred Epic 4)           |
| Checkpoint/Resume     | Code execution results in WorkflowState, PGlite persistence |
| Safe-to-Fail          | Sandbox isolation, virtual filesystem, rollback support     |
| Idempotence           | Code execution tasks can be safely re-executed              |

## Risks, Assumptions, Open Questions

**Risks:**

1. **Story 3.3 Scope Ambiguity (MEDIUM):**
   - **Risk:** Story 3.3 overlaps significantly with Story 3.4
   - **Impact:** Potential wasted effort if implemented as-is
   - **Mitigation:** Decision pending (Skip, Redefine as stdlib, or Defer)
   - **Status:** Documented in story-3.3.md with clarification notes

2. **Virtual Filesystem Complexity (MEDIUM):**
   - **Risk:** Full virtual filesystem implementation may be complex
   - **Impact:** Story 3.4 timeline may extend if full implementation required
   - **Mitigation:** Foundation/hooks approach in 3.4, full implementation deferred to 3.5
   - **Status:** Mitigated by phased approach

3. **Subprocess Overhead (LOW):**
   - **Risk:** Subprocess spawning may add latency
   - **Impact:** Performance targets may not be met
   - **Mitigation:** Benchmarks show <100ms startup achieved (34.77ms)
   - **Status:** ✅ Mitigated, performance targets exceeded

4. **Tool Injection Security (LOW):**
   - **Risk:** Dynamic code generation could introduce vulnerabilities
   - **Impact:** Security compromise
   - **Mitigation:** No eval(), template strings only, input validation
   - **Status:** ✅ Mitigated, security audit in Story 3.2 AC #9

**Assumptions:**

1. **Deno Runtime Availability:**
   - Assume Deno 2.5+ (or 2.2 LTS) available in production environment
   - Valid: Deno already required for Casys PML runtime

2. **Epic 2.5 Completion:**
   - Assume ControlledExecutor, WorkflowState, checkpoints fully implemented
   - Valid: Epic 2.5 status = done (2025-11-14)

3. **MCP Gateway Stability:**
   - Assume MCPGatewayServer (Epic 2.4) stable and production-ready
   - Valid: Epic 2 status = done

4. **Vector Search Performance:**
   - Assume <100ms P95 vector search (Epic 1.5)
   - Valid: Epic 1 completed, performance benchmarks met

**Open Questions:**

1. **Story 3.3 Resolution (DECISION REQUIRED):**
   - **Question:** Skip, Redefine as stdlib, or Defer Story 3.3?
   - **Impact:** Epic 3 scope definition
   - **Owner:** BMad
   - **Status:** Awaiting decision

2. **Virtual Filesystem Implementation (CLARIFICATION NEEDED):**
   - **Question:** Full implementation in Story 3.4 or just hooks/foundation?
   - **Options:**
     - A) Hooks/basic implementation in 3.4, full implementation separate story
     - B) Full implementation in 3.4 (extended timeline)
   - **Recommendation:** Option A (phased approach)
   - **Status:** To be confirmed during 3.4 planning

3. **Epic 3.5 Speculation Trigger (DESIGN DECISION):**
   - **Question:** How does ControlledExecutor decide to use sandbox for speculation?
   - **Dependencies:** Requires Story 3.4 safe-to-fail foundation
   - **Status:** Deferred to Epic 3.5 planning

## Test Strategy Summary

**Test Pyramid:**

```
      E2E Tests (10%)
    ├── Epic 3 integration workflows
    └── Hybrid DAG execution scenarios

   Integration Tests (30%)
  ├── Sandbox + MCP Gateway
  ├── ContextBuilder + VectorSearch
  ├── ControlledExecutor + code_execution tasks
  └── Checkpoint/resume workflows

    Unit Tests (60%)
   ├── DenoSandboxExecutor isolation
   ├── ContextBuilder tool wrapping
   ├── Error handling & serialization
   └── Performance benchmarks
```

**Testing Approach by Story:**

**Story 3.1 (Sandbox Foundation):**

- **Unit Tests:** Isolation validation, timeout enforcement, memory limits, error handling
- **Benchmarks:** Startup <100ms, overhead <50ms
- **Security Tests:** Attempt filesystem/network access (must fail)
- **Coverage Target:** >90% (critical security component)

**Story 3.2 (Tools Injection):**

- **Unit Tests:** Wrapper generation, type definition generation, error propagation
- **Integration Tests:** Vector search integration, MCP gateway routing
- **Security Tests:** No eval() audit, malicious tool name rejection
- **Coverage Target:** >85%

**Story 3.4 (execute_code Tool):**

- **Unit Tests:** MCP tool handler, schema validation
- **Integration Tests:** Intent-based mode, explicit mode, DAG integration
- **E2E Tests:** Full ControlledExecutor → DAG → code task → checkpoint workflow
- **Coverage Target:** >80%

**Cross-Story Integration Tests:**

- **Hybrid DAG Workflows:** MCP tools + code execution tasks
- **Checkpoint/Resume:** Code execution state persistence and recovery
- **Error Propagation:** End-to-end error handling across all layers

**Performance Benchmarks:**

- **Sandbox Startup:** <100ms P95
- **Code Execution:** Simple code <500ms total
- **Tool Discovery:** <200ms for intent-based mode
- **Hybrid Workflow:** 5-task DAG <3s P95

**Test Environments:**

- **Local:** Deno 2.5 / 2.2 LTS
- **CI:** Automated test suite on every commit
- **Production:** Smoke tests for critical paths

**Regression Prevention:**

- All Epic 1 & 2 tests continue passing (zero breaking changes)
- Performance benchmarks gated in CI (fail if >10% regression)
