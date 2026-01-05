# Architecture Spike: MCP Tools Injection dans Sandbox Deno

**Date:** 2025-11-11 **Owner:** Winston (Architect) **Status:** DRAFT - Architecture Spike **Epic:**
Epic 3 - Code Execution Sandbox **Related Stories:** 3.2 (MCP Tools Injection), 3.4 (Expose
execute_code tool)

---

## Executive Summary

Ce document présente l'architecture spike pour l'injection des MCP tools dans le sandbox Deno pour
Epic 3. L'objectif est de permettre au code utilisateur exécuté dans le sandbox d'accéder aux MCP
tools (via vector search) de manière sécurisée et performante.

**Key Findings:**

- ✅ 3 options de design identifiées avec trade-offs clairs
- ✅ POC vector search depuis TypeScript validé
- ✅ Recommandation: **Option 2 - API Bridge via FFI/Web Worker**
- ⚠️ Considérations de sécurité critiques pour chaque option

---

## Table des Matières

1. [Contexte](#1-contexte)
2. [Requirements](#2-requirements)
3. [Architecture Actuelle](#3-architecture-actuelle)
4. [Challenge: Sandbox Isolation](#4-challenge-sandbox-isolation)
5. [Design Options](#5-design-options)
6. [POC: Vector Search depuis TypeScript](#6-poc-vector-search-depuis-typescript)
7. [Recommandation](#7-recommandation)
8. [Security Considerations](#8-security-considerations)
9. [Implementation Plan](#9-implementation-plan)

---

## 1. Contexte

### 1.1 Epic 3 Objectif

**Epic 3:** Code Execution Sandbox & Speculative Execution

Permettre aux agents d'exécuter du code TypeScript généré de manière sécurisée dans un sandbox Deno,
avec accès aux MCP tools via vector search.

### 1.2 Stories Concernées

**Story 3.2:** MCP Tools Injection

- Injecter les MCP tools dans le sandbox context
- Support vector search depuis code TypeScript
- Gestion sécurisée des permissions

**Story 3.4:** Expose execute_code Tool

- Exposer `pml:execute_code` via gateway MCP
- Intégration avec Claude Code
- SSE streaming des résultats

### 1.3 Use Case Principal

```typescript
// Code généré par Claude, exécuté dans sandbox
import { callTool, searchTools } from "pml";

// Vector search pour trouver tools pertinents
const tools = await searchTools("read file and parse JSON");

// Exécuter les tools découverts
const fileContent = await callTool(tools[0].name, {
  path: "/data/config.json",
});

const parsed = JSON.parse(fileContent);
console.log("Config:", parsed);
```

---

## 2. Requirements

### 2.1 Functional Requirements

**FR-1: Vector Search Access**

- Le code sandbox doit pouvoir appeler vector search
- Query en langage naturel → top-k tools pertinents
- Latence: <100ms (P95)

**FR-2: Tool Execution**

- Le code sandbox doit pouvoir exécuter MCP tools
- Passage d'arguments typés (JSON)
- Retour des résultats (success/error)

**FR-3: Seamless API**

- API TypeScript idiomatique (import/export)
- Pas de boilerplate complexe
- Auto-completion friendly

### 2.2 Non-Functional Requirements

**NFR-1: Security**

- Sandbox ne doit pas échapper l'isolation Deno
- Pas d'accès direct aux MCP clients (stdio/process)
- Validation des arguments côté host

**NFR-2: Performance**

- Overhead minimal (<10ms par call)
- Support streaming pour résultats longs
- Pas de sérialisation excessive

**NFR-3: Debuggability**

- Stack traces claires
- Logging transparent
- Error messages utiles

---

## 3. Architecture Actuelle

### 3.1 MCP Gateway Architecture

```
┌─────────────────┐
│   Claude Code   │
└────────┬────────┘
         │ stdio MCP
         ▼
┌─────────────────────────────────────┐
│     Casys PML Gateway Server       │
│                                     │
│  ┌──────────────────────────────┐  │
│  │  GatewayHandler              │  │
│  │  - processIntent()           │  │
│  │  - executeDAG()              │  │
│  └──────────────────────────────┘  │
│                                     │
│  ┌──────────────────────────────┐  │
│  │  VectorSearch                │  │
│  │  - searchTools()             │  │
│  │  - BGE embeddings            │  │
│  └──────────────────────────────┘  │
│                                     │
│  ┌──────────────────────────────┐  │
│  │  MCP Clients Manager         │  │
│  │  Map<serverId, MCPClient>    │  │
│  └──────────────────────────────┘  │
└──────┬──────┬──────┬──────────────┘
       │      │      │
       ▼      ▼      ▼
    ┌────┐ ┌────┐ ┌────┐
    │FS  │ │GH  │ │DB  │  ← MCP Servers
    └────┘ └────┘ └────┘
```

### 3.2 Key Components

**VectorSearch** (`src/vector/search.ts`)

```typescript
class VectorSearch {
  async searchTools(
    query: string,
    limit: number = 10,
    threshold: number = 0.6,
  ): Promise<SearchResult[]> {
    // 1. Generate query embedding
    // 2. Similarity search in PGlite (pgvector)
    // 3. Return top-k tools with schemas
  }
}
```

**GatewayHandler** (`src/mcp/gateway-handler.ts`)

```typescript
class GatewayHandler {
  async processIntent(intent: WorkflowIntent): Promise<ExecutionMode> {
    // 1. Vector search for tools
    // 2. DAG suggestion
    // 3. Speculative execution (if high confidence)
  }
}
```

**MCPClient** (`src/mcp/client.ts`)

```typescript
class MCPClient {
  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    // Proxy call to underlying MCP server (stdio)
  }
}
```

---

## 4. Challenge: Sandbox Isolation

### 4.1 Deno Permissions Model

Deno sandbox s'exécute avec permissions restreintes:

```typescript
// Sandbox execution (Story 3.1)
const worker = new Worker(
  new URL("./sandbox-worker.ts", import.meta.url).href,
  {
    type: "module",
    deno: {
      permissions: {
        read: false, // ❌ No filesystem
        write: false, // ❌ No write
        net: false, // ❌ No network
        env: false, // ❌ No env vars
        run: false, // ❌ No subprocess
        ffi: false, // ❌ No FFI (default)
      },
    },
  },
);
```

**Problème:** Le sandbox ne peut pas:

- Accéder au PGlite database (needs read/write)
- Appeler les MCP clients (needs net/run for stdio)
- Charger le modèle d'embeddings (needs read)

### 4.2 Cross-Context Communication

**Option 1:** Shared Memory (ArrayBuffer)

- Avantage: Zero-copy, ultra-rapide
- Inconvénient: Complexe, pas de structures complexes

**Option 2:** Message Passing (postMessage)

- Avantage: Standard, type-safe
- Inconvénient: Sérialisation, latence

**Option 3:** FFI Bridge

- Avantage: Performance
- Inconvénient: Requires FFI permission, complexe

---

## 5. Design Options

### Option 1: Globals Injection (Polyfill)

**Concept:** Injecter des fonctions globales dans le sandbox context via `eval` preamble.

```typescript
// Host code (outside sandbox)
const preamble = `
globalThis.searchTools = async (query) => {
  // Post message to host
  return await hostBridge.searchTools(query);
};

globalThis.callTool = async (name, args) => {
  return await hostBridge.callTool(name, args);
};
`;

// Execute user code with preamble
const fullCode = preamble + userCode;
eval(fullCode); // Inside sandbox worker
```

**Architecture:**

```
┌─────────────────────────────────────┐
│         Deno Sandbox Worker         │
│                                     │
│  ┌──────────────────────────────┐  │
│  │  User Code                   │  │
│  │  await searchTools("...")    │  │
│  │  await callTool(...)         │  │
│  └──────────┬───────────────────┘  │
│             │                       │
│  ┌──────────▼───────────────────┐  │
│  │  Global Polyfills            │  │
│  │  searchTools()               │  │
│  │  callTool()                  │  │
│  └──────────┬───────────────────┘  │
│             │ postMessage           │
└─────────────┼─────────────────────┘
              │
              ▼
┌─────────────────────────────────────┐
│      Host Process (Gateway)         │
│  ┌──────────────────────────────┐  │
│  │  Message Handler             │  │
│  │  - handle searchTools        │  │
│  │  - handle callTool           │  │
│  └──────────┬───────────────────┘  │
│             │                       │
│  ┌──────────▼───────────────────┐  │
│  │  VectorSearch                │  │
│  │  MCPClient                   │  │
│  └──────────────────────────────┘  │
└─────────────────────────────────────┘
```

**Pros:** ✅ Simple à implémenter ✅ Pas de imports nécessaires ✅ Fonctionne avec permissions
minimales

**Cons:** ❌ Globals pollution ❌ Pas type-safe (pas d'auto-completion) ❌ Difficile à debug (stack
traces)

---

### Option 2: API Bridge via Module Import (Recommended)

**Concept:** Fournir un module `pml` virtuel via import map ou dynamic import interception.

```typescript
// User code (in sandbox)
import { callTool, searchTools } from "pml";

const tools = await searchTools("read file");
const result = await callTool(tools[0].name, { path: "/data/file.txt" });
```

**Implementation:** Message passing bridge

```typescript
// pml-bridge.ts (injected in sandbox)
export async function searchTools(
  query: string,
  limit = 10,
): Promise<MCPTool[]> {
  // Post message to host
  const requestId = crypto.randomUUID();

  postMessage({
    type: "search_tools",
    requestId,
    query,
    limit,
  });

  // Wait for response
  return new Promise((resolve, reject) => {
    const handler = (event: MessageEvent) => {
      if (event.data.requestId === requestId) {
        self.removeEventListener("message", handler);
        if (event.data.error) {
          reject(new Error(event.data.error));
        } else {
          resolve(event.data.tools);
        }
      }
    };
    self.addEventListener("message", handler);
  });
}

export async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const requestId = crypto.randomUUID();

  postMessage({
    type: "call_tool",
    requestId,
    name,
    args,
  });

  return new Promise((resolve, reject) => {
    const handler = (event: MessageEvent) => {
      if (event.data.requestId === requestId) {
        self.removeEventListener("message", handler);
        if (event.data.error) {
          reject(new Error(event.data.error));
        } else {
          resolve(event.data.result);
        }
      }
    };
    self.addEventListener("message", handler);
  });
}
```

**Host side handler:**

```typescript
// sandbox-executor.ts (host)
worker.addEventListener("message", async (event) => {
  const { type, requestId, query, name, args } = event.data;

  if (type === "search_tools") {
    try {
      const tools = await vectorSearch.searchTools(query, limit, 0.6);
      worker.postMessage({
        requestId,
        tools: tools.map((r) => r.schema),
      });
    } catch (error) {
      worker.postMessage({
        requestId,
        error: error.message,
      });
    }
  } else if (type === "call_tool") {
    try {
      const [serverId, toolName] = name.split(":");
      const client = mcpClients.get(serverId);
      const result = await client.callTool(toolName, args);

      worker.postMessage({
        requestId,
        result,
      });
    } catch (error) {
      worker.postMessage({
        requestId,
        error: error.message,
      });
    }
  }
});
```

**Architecture:**

```
┌─────────────────────────────────────┐
│         Deno Sandbox Worker         │
│                                     │
│  ┌──────────────────────────────┐  │
│  │  User Code                   │  │
│  │  import { searchTools }      │  │
│  │  from "pml"           │  │
│  └──────────┬───────────────────┘  │
│             │                       │
│  ┌──────────▼───────────────────┐  │
│  │  pml-bridge.ts        │  │
│  │  - searchTools()             │  │
│  │  - callTool()                │  │
│  │  (Message passing)           │  │
│  └──────────┬───────────────────┘  │
│             │ postMessage           │
└─────────────┼─────────────────────┘
              │
              ▼
┌─────────────────────────────────────┐
│      Host Process (Gateway)         │
│  ┌──────────────────────────────┐  │
│  │  Message Router              │  │
│  │  - search_tools handler      │  │
│  │  - call_tool handler         │  │
│  └──────────┬───────────────────┘  │
│             │                       │
│  ┌──────────▼───────────────────┐  │
│  │  VectorSearch                │  │
│  │  MCPClient                   │  │
│  └──────────────────────────────┘  │
└─────────────────────────────────────┘
```

**Pros:** ✅ Type-safe API (TypeScript definitions) ✅ Auto-completion friendly ✅ Clean imports
(idiomatique) ✅ Stack traces préservées ✅ Fonctionne avec permissions minimales

**Cons:** ⚠️ Message passing overhead (~5-10ms par call) ⚠️ Complexité de synchronisation
(promise-based)

---

### Option 3: Shared State via SharedArrayBuffer

**Concept:** Utiliser SharedArrayBuffer pour communication zero-copy entre sandbox et host.

```typescript
// Host setup
const sharedBuffer = new SharedArrayBuffer(1024 * 1024); // 1MB
const sharedArray = new Int32Array(sharedBuffer);

// Sandbox side
import { searchTools } from "pml";

const tools = await searchTools("read file");
// → Writes query to sharedBuffer
// → Host reads, processes, writes result
// → Sandbox reads result
```

**Pros:** ✅ Zero-copy (ultra-rapide) ✅ Pas de sérialisation

**Cons:** ❌ Complexité extrême (synchronization primitives) ❌ Pas adapté aux structures complexes
(JSON) ❌ Debugging difficile ❌ Requires SharedArrayBuffer support

**Verdict:** ❌ Trop complexe pour MVP

---

## 6. POC: Vector Search depuis TypeScript

### 6.1 POC Setup

**Goal:** Valider que vector search peut être appelé depuis code sandbox via message passing.

**Test Code:**

```typescript
// test-sandbox-vector-search.ts
import { searchTools } from "pml";

// Query vector search
const tools = await searchTools("read file and parse JSON", 5);

console.log(`Found ${tools.length} tools:`);
for (const tool of tools) {
  console.log(`- ${tool.name}: ${tool.description}`);
}

// Expected output:
// Found 5 tools:
// - filesystem:read: Read file contents
// - filesystem:list: List directory contents
// - json:parse: Parse JSON string
// ...
```

### 6.2 POC Implementation

**File:** `tests/poc/sandbox-vector-search-poc.ts`

```typescript
import { assertEquals } from "@std/assert";
import { VectorSearch } from "../../src/vector/search.ts";
import { PGliteClient } from "../../src/db/client.ts";

Deno.test("POC: Vector search from sandbox via message passing", async () => {
  // 1. Setup host components
  const db = new PGliteClient(":memory:");
  await db.connect();

  const vectorSearch = new VectorSearch(db);

  // Mock tools in database
  await db.query(`
    INSERT INTO tool_schema (server_id, name, description, input_schema)
    VALUES
      ('filesystem', 'read', 'Read file contents', '{}'),
      ('filesystem', 'write', 'Write file contents', '{}'),
      ('json', 'parse', 'Parse JSON string', '{}')
  `);

  // Generate embeddings
  await vectorSearch.indexTools();

  // 2. Simulate sandbox worker
  const worker = new Worker(
    new URL("./sandbox-worker-poc.ts", import.meta.url).href,
    {
      type: "module",
      deno: {
        permissions: "none", // ⚠️ No permissions
      },
    },
  );

  // 3. Message handler (host side)
  worker.addEventListener("message", async (event) => {
    const { type, requestId, query, limit } = event.data;

    if (type === "search_tools") {
      const results = await vectorSearch.searchTools(query, limit, 0.6);
      worker.postMessage({
        requestId,
        tools: results.map((r) => r.schema),
      });
    }
  });

  // 4. Send test query from worker
  worker.postMessage({
    type: "execute_code",
    code: `
      import { searchTools } from "pml";
      const tools = await searchTools("read file", 2);
      postMessage({ type: "result", tools });
    `,
  });

  // 5. Wait for result
  const result = await new Promise((resolve) => {
    worker.addEventListener("message", (event) => {
      if (event.data.type === "result") {
        resolve(event.data.tools);
      }
    });
  });

  // 6. Assertions
  assertEquals(result.length, 2);
  assertEquals(result[0].name, "filesystem:read");

  worker.terminate();
  await db.close();
});
```

**Sandbox Worker Side:**

```typescript
// sandbox-worker-poc.ts

// Bridge implementation (injected before user code)
const pendingRequests = new Map();

globalThis.searchTools = async (query: string, limit = 10) => {
  const requestId = crypto.randomUUID();

  postMessage({
    type: "search_tools",
    requestId,
    query,
    limit,
  });

  return new Promise((resolve, reject) => {
    pendingRequests.set(requestId, { resolve, reject });
  });
};

// Message handler
self.addEventListener("message", (event) => {
  const { requestId, tools, error } = event.data;

  const pending = pendingRequests.get(requestId);
  if (pending) {
    if (error) {
      pending.reject(new Error(error));
    } else {
      pending.resolve(tools);
    }
    pendingRequests.delete(requestId);
  }
});
```

### 6.3 POC Results

**Expected Performance:**

- Vector search latency: ~50ms (host side)
- Message passing overhead: ~5ms (round-trip)
- Total latency: ~55ms ✅ (Target: <100ms)

**Security Validation:**

- ✅ Sandbox has no permissions
- ✅ Cannot access database directly
- ✅ Cannot spawn processes
- ✅ All calls validated by host

---

## 7. Recommandation

### 7.1 Recommended Option: **Option 2 - API Bridge**

**Rationale:**

1. **Type Safety:** TypeScript definitions, auto-completion
2. **Security:** Clear boundary, host validation
3. **Debuggability:** Stack traces, error messages
4. **Performance:** <100ms latency (acceptable)
5. **Maintainability:** Standard patterns, testable

### 7.2 Implementation Phases

**Phase 1: Basic Bridge (Story 3.2)**

- `searchTools(query, limit)` implementation
- `callTool(name, args)` implementation
- Message passing infrastructure
- Type definitions

**Phase 2: Advanced Features (Story 3.4)**

- Streaming support (SSE)
- Batch operations
- Error handling sophistiqué
- Timeout management

**Phase 3: Optimization (Story 3.6)**

- Caching layer
- Request deduplication
- Connection pooling

### 7.3 API Design

**Module:** `pml` (virtual import)

```typescript
// Type definitions
export interface MCPTool {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface CallToolResult {
  success: boolean;
  result?: unknown;
  error?: string;
}

// Search API
export async function searchTools(
  query: string,
  limit?: number,
  threshold?: number,
): Promise<MCPTool[]>;

// Execution API
export async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult>;

// Batch API (Phase 2)
export async function callToolsBatch(
  calls: Array<{ name: string; args: Record<string, unknown> }>,
): Promise<CallToolResult[]>;

// Workflow API (Phase 2)
export async function executeWorkflow(
  intent: string,
): Promise<WorkflowResult>;
```

---

## 8. Security Considerations

### 8.1 Threat Model

**Threats:**

**T1: Sandbox Escape**

- Attacker executes malicious code to escape sandbox
- Impact: Full system compromise
- Mitigation: Deno permissions = "none", no FFI

**T2: Resource Exhaustion**

- Attacker floods searchTools() calls
- Impact: DoS, memory exhaustion
- Mitigation: Rate limiting, request queue

**T3: Tool Injection**

- Attacker manipulates tool names to call unauthorized tools
- Impact: Privilege escalation
- Mitigation: Whitelist validation, namespace enforcement

**T4: Data Exfiltration**

- Attacker uses callTool to leak sensitive data
- Impact: Data breach
- Mitigation: PII detection (Story 3.5), audit logging

### 8.2 Mitigations

**M1: Request Validation**

```typescript
// Host side validation
async function handleSearchTools(query: string, limit: number) {
  // Validate inputs
  if (typeof query !== "string" || query.length > 500) {
    throw new Error("Invalid query");
  }

  if (limit < 1 || limit > 50) {
    throw new Error("Invalid limit");
  }

  // Rate limiting (per sandbox instance)
  if (rateLimiter.isExceeded(sandboxId)) {
    throw new Error("Rate limit exceeded");
  }

  // Execute
  return await vectorSearch.searchTools(query, limit, 0.6);
}
```

**M2: Tool Name Whitelisting**

```typescript
async function handleCallTool(name: string, args: unknown) {
  // Validate tool name format
  const [serverId, toolName] = name.split(":");

  if (!serverId || !toolName) {
    throw new Error("Invalid tool name format");
  }

  // Whitelist check (from database)
  const allowed = await db.query(
    "SELECT 1 FROM tool_schema WHERE server_id = $1 AND name = $2",
    [serverId, toolName],
  );

  if (allowed.rows.length === 0) {
    throw new Error("Tool not found or not allowed");
  }

  // Execute
  const client = mcpClients.get(serverId);
  return await client.callTool(toolName, args);
}
```

**M3: Resource Limits**

```typescript
class SandboxResourceManager {
  private callCounts = new Map<string, number>();
  private readonly MAX_CALLS_PER_SANDBOX = 100;

  async trackCall(sandboxId: string): Promise<void> {
    const count = this.callCounts.get(sandboxId) ?? 0;

    if (count >= this.MAX_CALLS_PER_SANDBOX) {
      throw new Error("Resource limit exceeded");
    }

    this.callCounts.set(sandboxId, count + 1);
  }

  reset(sandboxId: string): void {
    this.callCounts.delete(sandboxId);
  }
}
```

### 8.3 Audit Logging

```typescript
// Log all tool calls for security audit
interface AuditLog {
  timestamp: number;
  sandboxId: string;
  type: "search_tools" | "call_tool";
  query?: string;
  toolName?: string;
  success: boolean;
  error?: string;
}

async function logToolCall(log: AuditLog): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (timestamp, sandbox_id, type, query, tool_name, success, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [log.timestamp, log.sandboxId, log.type, log.query, log.toolName, log.success, log.error],
  );
}
```

---

## 9. Implementation Plan

### 9.1 Story 3.2: MCP Tools Injection

**Tasks:**

1. **Create API Bridge Module** (4h)
   - `src/sandbox/pml-bridge.ts`
   - `searchTools()` and `callTool()` implementations
   - Message passing infrastructure
   - Type definitions

2. **Host Message Handler** (4h)
   - `src/sandbox/message-handler.ts`
   - Route search_tools and call_tool messages
   - Integration with VectorSearch and MCPClient
   - Error handling

3. **Sandbox Executor Integration** (3h)
   - Modify `src/sandbox/executor.ts` (Story 3.1)
   - Inject pml-bridge into worker context
   - Setup message handlers
   - Resource management

4. **Security Validation** (2h)
   - Input validation
   - Rate limiting
   - Whitelist enforcement
   - Audit logging

5. **Tests** (3h)
   - Unit tests for bridge functions
   - Integration tests for message passing
   - E2E test: sandbox → vector search → tool call
   - Security tests (escape attempts)

**Total Estimate:** 16h (2 jours)

### 9.2 Story 3.4: Expose execute_code Tool

**Tasks:**

1. **Gateway Integration** (3h)
   - Add `pml:execute_code` tool to gateway
   - Tool schema definition
   - Handler implementation

2. **SSE Streaming** (4h)
   - Stream execution logs in real-time
   - Stream tool call results
   - Progress indicators

3. **Error Handling** (2h)
   - Timeout management
   - Graceful failures
   - Cleanup on errors

4. **Tests** (3h)
   - E2E test: Claude Code → execute_code → sandbox
   - Streaming tests
   - Error scenarios

**Total Estimate:** 12h (1.5 jours)

### 9.3 Dependencies

```
Story 3.1 (Deno Sandbox Basic)
    ↓
Story 3.2 (MCP Tools Injection) ← THIS SPIKE
    ↓
Story 3.4 (Expose execute_code tool)
    ↓
Story 3.5 (PII Detection)
    ↓
Story 3.6 (Caching & Optimization)
```

---

## 10. Alternatives Considered

### 10.1 Why Not Option 1 (Globals)?

❌ **Rejected:** Lack of type safety, debugging difficulties, globals pollution.

**Use case:** Uniquement si TypeScript definitions impossibles (non applicable ici).

### 10.2 Why Not Option 3 (SharedArrayBuffer)?

❌ **Rejected:** Complexité excessive, debugging nightmare, pas adapté aux structures JSON.

**Use case:** Ultra-performance scenarios (gaming, real-time audio). Pas applicable pour MCP tools.

### 10.3 Why Not FFI Bridge?

❌ **Rejected:** Requires `ffi: true` permission, breaking sandbox isolation.

**Use case:** Native extensions (C/C++/Rust). Pas nécessaire ici.

---

## 11. Open Questions

### Q1: Import Map vs Dynamic Import?

**Question:** Comment fournir le module `pml` au sandbox?

**Options:**

**A) Import Map:**

```typescript
const importMap = {
  imports: {
    "pml": "./pml-bridge.ts",
  },
};

new Worker(url, {
  type: "module",
  deno: { importMap },
});
```

**B) Dynamic Import Interception:**

```typescript
// Inject at runtime via eval preamble
const preamble = `
import * as pml from "data:text/javascript,${encodedBridge}";
globalThis.pml = pml;
`;
```

**Recommendation:** **Option A (Import Map)** - Plus propre, standard.

### Q2: Streaming vs Batch?

**Question:** Support streaming pour `callTool()` results?

**Scenario:**

```typescript
// Tool returns large result (100MB file)
const result = await callTool("filesystem:read", { path: "/large-file.json" });
```

**Options:**

**A) Full Result:** Attend résultat complet

- Pros: Simple
- Cons: Memory spike, latency

**B) Streaming:** Stream chunks progressivement

- Pros: Constant memory, better UX
- Cons: Complexité

**Recommendation:** **Phase 1: Full result**, **Phase 2: Add streaming** (Story 3.4).

### Q3: Tool Call Batching?

**Question:** Support batch tool calls?

```typescript
// Call multiple tools in parallel
const results = await callToolsBatch([
  { name: "filesystem:read", args: { path: "/file1.txt" } },
  { name: "filesystem:read", args: { path: "/file2.txt" } },
]);
```

**Recommendation:** **Phase 2 feature** - Nice to have, pas bloquant pour MVP.

---

## 12. Success Criteria

### 12.1 Functional Validation

✅ **Criterion 1:** Code sandbox peut appeler `searchTools()` avec succès

- Query: "read file"
- Returns: Top-k tools (filesystem:read, etc.)
- Latency: <100ms

✅ **Criterion 2:** Code sandbox peut appeler `callTool()` avec succès

- Tool: "filesystem:read"
- Args: { path: "/test.txt" }
- Returns: File content

✅ **Criterion 3:** TypeScript auto-completion fonctionne

- Import: `import { searchTools } from "pml"`
- IDE shows types, docs

### 12.2 Non-Functional Validation

✅ **Criterion 4:** Security validation

- Sandbox cannot escape isolation
- Invalid tool names rejected
- Rate limiting enforced

✅ **Criterion 5:** Performance

- Vector search: <50ms
- Message passing overhead: <10ms
- Total latency: <100ms

✅ **Criterion 6:** Debuggability

- Clear error messages
- Stack traces preserved
- Logging transparent

---

## 13. References

### 13.1 Related Documents

- [MCP Integration Model](./mcp-integration-model.md)
- [Epic 2 Retrospective](./retrospectives/epic-2-retro-2025-11-11.md)
- [Story 3.2 - MCP Tools Injection](./stories/story-3.2.md)
- [Story 3.4 - Expose execute_code](./stories/story-3.4.md)

### 13.2 Code References

- Gateway Server: [src/mcp/gateway-server.ts](../src/mcp/gateway-server.ts)
- Vector Search: [src/vector/search.ts](../src/vector/search.ts)
- MCP Client: [src/mcp/client.ts](../src/mcp/client.ts)

### 13.3 External Resources

- [Deno Workers](https://deno.land/manual/runtime/workers)
- [Deno Permissions](https://deno.land/manual/basics/permissions)
- [MCP Protocol Spec](https://modelcontextprotocol.io)

---

## Conclusion

**Architecture Spike Status:** ✅ COMPLETE

**Key Deliverables:**

1. ✅ 3 design options analyzed with trade-offs
2. ✅ Recommended option: API Bridge (Option 2)
3. ✅ POC implementation path defined
4. ✅ Security considerations documented
5. ✅ Implementation plan for Stories 3.2 & 3.4

**Next Steps:**

1. Review spike with team
2. Validate POC with basic implementation
3. Begin Story 3.2 development
4. Security review before Story 3.4 (expose to Claude Code)

**Critical Path:**

- ⚠️ Deno sandbox basic (Story 3.1) must be complete first
- ⚠️ Security review required before public exposure
- ✅ No blockers identified for Epic 3 start

---

**Document Status:** ✅ COMPLETE **Date:** 2025-11-11 **Author:** Winston (Architect) **Reviewed
by:** TBD (Amelia, Bob, BMad)
