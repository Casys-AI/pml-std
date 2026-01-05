# Story 7.3b: Capability Injection - Inline Functions (Option B)

> **Epic:** 7 - Emergent Capabilities & Learning System **ADRs:** ADR-027 (Execute Code Graph
> Learning), ADR-028 (Emergent Capabilities), ADR-032 (Worker RPC Bridge) **Prerequisites:** Story
> 7.1b (Worker RPC Bridge - DONE), Story 7.3a (CapabilityMatcher - DONE) **Status:** done

## User Story

As a code executor, I want capabilities injected as inline functions in the Worker context, So that
code can call capabilities with zero RPC overhead and proper tracing.

## Problem Context

### Current State (After Story 7.3a)

The system has:

1. **WorkerBridge** (`src/sandbox/worker-bridge.ts`) - Exécute du code dans un Worker avec:
   - Tool proxies via RPC (`mcp.server.tool() → __rpcCall()`)
   - Native tracing dans le bridge (tool_start/tool_end)
   - Eager learning vers CapabilityStore

2. **CapabilityMatcher** (`src/capabilities/matcher.ts`) - Trouve les capabilities correspondant à
   un intent:
   - `findMatch(intent)` → CapabilityMatch | null
   - Utilise adaptive thresholds (pas de valeurs hardcodées)

3. **CapabilityStore** (`src/capabilities/capability-store.ts`) - Stocke les capabilities apprises:
   - `saveCapability()` - Eager learning (1ère exec)
   - `searchByIntent()` - Vector search

**MAIS:** Les capabilities ne sont pas injectées dans le Worker context. Claude doit toujours
générer du nouveau code même si une capability équivalente existe.

```
Current Flow:
Claude → CapabilityMatcher.findMatch() → MATCH → ??? → Pas d'injection automatique

Desired Flow:
Claude → findMatch() → MATCH → buildCapabilityContext() → Worker exécute capability code
```

### Missing Components

1. **CapabilityCodeGenerator** - Génère le code inline des capabilities avec wrappers `__trace()`
2. **WorkerBridge.buildCapabilityContext()** - Injecte les capabilities dans le Worker
3. **Worker `__trace()` function** - Trace les capability_start/end dans le Worker
4. **Nested tracing** - Trace les appels capability→capability avec parent/child

### Impact

Sans injection de capabilities :

- Claude doit toujours générer du code (~2-5s par génération)
- Les capabilities apprises ne sont jamais réutilisées automatiquement
- Pas de benefit du learning system (Epic 7)

## Solution: Capability Injection - Option B (Inline Functions)

### Architecture Decision: Why Option B?

> **ADR-032: Option B over Option A (RPC for capabilities)**
>
> - **No RPC overhead** for capability → capability calls (direct function call)
> - **Simpler** - capabilities are just functions in the same Worker context
> - **MCP tool calls** still go through RPC bridge (and get traced there natively)

| Call Type               | Mechanism            | Tracing Location |
| ----------------------- | -------------------- | ---------------- |
| Code → MCP tool         | RPC to bridge        | Bridge (native)  |
| Code → Capability       | Direct function call | Worker (wrapper) |
| Capability → MCP tool   | RPC to bridge        | Bridge (native)  |
| Capability → Capability | Direct function call | Worker (wrapper) |

### Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  WorkerBridge (Main Process)                                                 │
│    │                                                                         │
│    │ 1. buildCapabilityContext(matchedCapabilities)                          │
│    │    → Generates inline function code with __trace() wrappers             │
│    │                                                                         │
│    │ 2. execute(code, toolDefs, context, capabilityContext)                  │
│    ▼                                                                         │
└─────────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼ postMessage (init with capabilities)
┌─────────────────────────────────────────────────────────────────────────────┐
│  SandboxWorker (Worker, permissions: "none")                                 │
│                                                                              │
│  // Tool proxies (from Story 7.1b)                                          │
│  const mcp = {                                                               │
│    kubernetes: { deploy: (args) => __rpcCall("kubernetes", "deploy", args) },│
│    slack: { notify: (args) => __rpcCall("slack", "notify", args) },          │
│  };                                                                          │
│                                                                              │
│  // NEW: Capabilities as inline functions (Option B)                         │
│  const capabilities = {                                                      │
│    runTests: async (args) => {                                               │
│      __trace({ type: "capability_start", name: "runTests" });                │
│      const result = await mcp.jest.run({ path: args.path });                 │
│      __trace({ type: "capability_end", name: "runTests", success: true });   │
│      return result;                                                          │
│    },                                                                        │
│    deployProd: async (args) => {                                             │
│      __trace({ type: "capability_start", name: "deployProd" });              │
│      await capabilities.runTests({ path: "./tests" }); // Direct call        │
│      await mcp.kubernetes.deploy({ image: args.image }); // RPC              │
│      __trace({ type: "capability_end", name: "deployProd", success: true }); │
│      return { deployed: true };                                              │
│    },                                                                        │
│  };                                                                          │
│                                                                              │
│  // NEW: __trace() collects events for merging with bridge traces            │
│  const __workerTraces = [];                                                  │
│  function __trace(event) { __workerTraces.push({ ...event, ts: Date.now() });}│
│                                                                              │
│  // User code has access to both mcp AND capabilities                        │
│  await capabilities.deployProd({ image: "app:v1.0" });                       │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼ postMessage (execution_complete with traces)
┌─────────────────────────────────────────────────────────────────────────────┐
│  WorkerBridge (Main Process)                                                 │
│    │                                                                         │
│    │ 3. Merge worker traces (capability_*) with bridge traces (tool_*)       │
│    │                                                                         │
│    │ 4. updateFromExecution() → GraphRAG with ALL traces                     │
│    │    - Tool edges: tool A → tool B                                        │
│    │    - Capability edges: capability A → capability B                      │
│    ▼                                                                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Acceptance Criteria

### AC1: CapabilityCodeGenerator Class Created ✅

- [x] File `src/capabilities/code-generator.ts` created
- [x] Class `CapabilityCodeGenerator` exported
- [x] Method `generateInlineCode(capability: Capability): string`
  - Wraps `code_snippet` with `__trace()` calls
  - Returns valid JavaScript function body string
- [x] Generated code pattern:
  ```typescript
  async (args) => {
    __trace({ type: "capability_start", name: "${capability.name}", id: "${capability.id}" });
    try {
      // Original code_snippet
      ${capability.codeSnippet}
    } finally {
      __trace({ type: "capability_end", name: "${capability.name}", id: "${capability.id}" });
    }
  }
  ```

### AC2: WorkerBridge.buildCapabilityContext() Method Added ✅

- [x] Method `buildCapabilityContext(capabilities: Capability[]): string` added to WorkerBridge
- [x] Returns JavaScript code string defining `capabilities` object:
  ```javascript
  const capabilities = {
    capName1: async (args) => {/* traced code */},
    capName2: async (args) => {/* traced code */},
  };
  ```
- [x] Each capability name derived from `capability.name` or `capability.id`
- [x] Code sanitized for security (no code injection)

### AC3: Worker __trace() Function Implemented ✅

- [x] `__trace()` function added to SandboxWorker (via BroadcastChannel - ADR-036)
- [x] Trace events emitted in real-time via BroadcastChannel
- [x] **EXACT types.ts modifications required (discriminated union - see Issue #3 in
      Pre-Implementation Review):**
  ```typescript
  // REPLACE TraceEvent in src/sandbox/types.ts:227

  // Base interface for common fields
  interface BaseTraceEvent {
    trace_id: string;
    ts: number;
    success?: boolean;
    duration_ms?: number;
    error?: string;
  }

  // Tool trace events (existing behavior)
  interface ToolTraceEvent extends BaseTraceEvent {
    type: "tool_start" | "tool_end";
    tool: string;
  }

  // Capability trace events (NEW)
  interface CapabilityTraceEvent extends BaseTraceEvent {
    type: "capability_start" | "capability_end";
    capability: string;
    capability_id: string;
  }

  // Discriminated union (type-safe!)
  export type TraceEvent = ToolTraceEvent | CapabilityTraceEvent;
  ```
- [x] Traces sent via BroadcastChannel (not execution_complete message - ADR-036)
- [x] **__trace() implementation in Worker** (via BroadcastChannel):
  ```typescript
  const __workerTraces: TraceEvent[] = [];
  function __trace(event: Partial<TraceEvent>): void {
    try {
      __workerTraces.push({
        ...event,
        trace_id: crypto.randomUUID(),
        ts: Date.now(),
      } as TraceEvent);
    } catch {
      // Never throw - tracing must not break execution
    }
  }
  ```

### AC4: Trace Merging in WorkerBridge ✅

- [x] WorkerBridge receives worker traces via BroadcastChannel (real-time)
- [x] Combined trace array has chronological order (by `ts`)
- [x] Method `getTraces()` returns unified traces (tool + capability)
- [x] Trace types distinguished: `type: "tool_start|tool_end|capability_start|capability_end"`
- [x] **Merge algorithm** (via BroadcastChannel listener):
  ```typescript
  private mergeTraces(workerTraces: TraceEvent[]): void {
    // Combine bridge traces (tool_*) with worker traces (capability_*)
    this.traces = [...this.traces, ...workerTraces]
      .sort((a, b) => a.ts - b.ts); // Chronological order
  }
  ```

### AC5: Learning Loop - Capability Graph Edges ✅

- [x] GraphRAG receives combined traces (via WorkerBridge integration)
- [x] Edges created for:
  - Tool → Tool (existing, from bridge traces)
  - Capability → Capability (NEW, from worker traces)
  - Capability → Tool (NEW, cross-type edges)
- [x] **NEW method in GraphRAGEngine** (`src/graphrag/graph-engine.ts`):
  ```typescript
  /**
   * Update graph from code execution traces (tool + capability)
   * Called by WorkerBridge after execution completes
   */
  async updateFromCodeExecution(traces: TraceEvent[]): Promise<void> {
    // 1. Extract sequential pairs from chronological traces
    // 2. For each consecutive (traceA, traceB):
    //    - If both tool_end: create tool→tool edge (existing logic)
    //    - If both capability_end: create capability→capability edge
    //    - If capability_end + tool_end: create capability→tool edge
    // 3. Update edge weights (co-occurrence count)
  }
  ```
- [x] Integration point in WorkerBridge (`worker-bridge.ts:247`):
  ```typescript
  // After execution, before returning result
  if (this.graphRAG) {
    await this.graphRAG.updateFromCodeExecution(this.getTraces());
  }
  ```

### AC6: InitMessage & ExecutionCompleteMessage Extended ✅

- [x] `InitMessage` type extended in `src/sandbox/types.ts:189`:
  ```typescript
  export interface InitMessage {
    type: "init";
    code: string;
    toolDefinitions: ToolDefinition[];
    context?: Record<string, unknown>;
    capabilityContext?: string; // NEW: Inline capability code string
  }
  ```
- [x] `ExecutionCompleteMessage` type unchanged (BroadcastChannel used instead - ADR-036):
  ```typescript
  export interface ExecutionCompleteMessage {
    type: "execution_complete";
    success: boolean;
    result?: unknown;
    error?: string;
    workerTraces?: TraceEvent[]; // NEW: Capability traces from worker
  }
  ```
- [x] SandboxWorker injects `capabilityContext` **before user code** in `handleInit()`:
  ```typescript
  // In sandbox-worker.ts:handleInit(), line ~165
  async function handleInit(msg: InitMessage): Promise<void> {
    const { code, toolDefinitions, context, capabilityContext } = msg;

    const mcp = generateToolProxies(toolDefinitions);

    // NEW: Inject capability context BEFORE user code
    const fullCode = capabilityContext ? `${capabilityContext}\n\n${code}` : code;

    const result = await executeCode(fullCode, mcp, context);

    // NEW: Include worker traces in response
    self.postMessage({
      type: "execution_complete",
      success: true,
      result,
      workerTraces: __workerTraces, // NEW
    });
  }
  ```

### AC7: Tests - Capability Tracing ✅

- [x] Test: capability calls MCP tool → tool traced in bridge, capability traced in worker
- [x] Test: capability A calls capability B → both traced with correct timestamps
- [x] Test: nested capabilities (A → B → C) → all 3 traced with parent/child relationship
- [x] Test: verify merged traces have correct chronological order

### AC8: Tests - GraphRAG Integration ✅

- [x] Test: capability A calls capability B → edge A→B created in GraphRAG
- [x] Test: capability calls MCP tool → edge capability→tool created
- [x] Test: verify `updateFromCodeExecution()` receives both trace types

### AC9: Performance Requirements ✅

- [x] Capability → capability call **overhead** < 1ms (direct function call, excludes actual code
      execution)
- [x] Code generation (buildCapabilityContext) < 10ms for 10 capabilities
- [x] Trace merging < 5ms for 100 events
- [x] **Note:** MCP tool calls within capabilities still incur RPC overhead (~10ms) - this is
      expected

### AC10: Cycle Detection (Prevent Infinite Recursion) ✅

- [x] `CapabilityCodeGenerator` detects capability self-reference
- [x] Max call depth enforced = 3 levels (A → B → C → STOP)
- [x] **Implementation in generated code:**
  ```typescript
  // Generated capability wrapper includes depth tracking
  const __capabilityDepth = globalThis.__capabilityDepth || 0;
  if (__capabilityDepth >= 3) {
    throw new Error("Capability call depth exceeded (max: 3). Possible cycle detected.");
  }
  globalThis.__capabilityDepth = __capabilityDepth + 1;
  try {
    // Original capability code
  } finally {
    globalThis.__capabilityDepth = __capabilityDepth;
  }
  ```
- [x] Test: capability A calls A directly → throws after depth 3
- [x] Test: A → B → C → D → throws at D (depth exceeded)
- [x] Test: A → B → A → throws (cycle detected via depth)

---

## Tasks / Subtasks

- [x] **Task 1: Create CapabilityCodeGenerator** (AC: #1, #10)
  - [x] 1.1 Create `src/capabilities/code-generator.ts`
  - [x] 1.2 Implement `generateInlineCode()` with __trace wrappers
  - [x] 1.3 Handle code sanitization (see Dev Notes for rules)
  - [x] 1.4 Generate safe function names from capability.name (with collision handling)
  - [x] 1.5 Add cycle detection depth wrapper
  - [x] 1.6 Export from `src/capabilities/mod.ts`:
        `export { CapabilityCodeGenerator } from "./code-generator.ts";`

- [x] **Task 2: Extend WorkerBridge** (AC: #2, #4)
  - [x] 2.1 Add `buildCapabilityContext(capabilities)` method
  - [x] 2.2 Extend `execute()` to accept capability context
  - [x] 2.3 Implement trace merging via BroadcastChannel (ADR-036)
  - [x] 2.4 Update `getTraces()` to return merged traces

- [x] **Task 3: Extend SandboxWorker** (AC: #3, #6)
  - [x] 3.1 Add `__trace()` function using BroadcastChannel (ADR-036)
  - [x] 3.2 Modify `handleInit()` to inject capability context
  - [x] 3.3 Traces sent via BroadcastChannel (not workerTraces field)
  - [x] 3.4 Update types in `src/sandbox/types.ts` (discriminated union)

- [x] **Task 4: GraphRAG Integration** (AC: #5)
  - [x] 4.1 Add `updateFromCodeExecution()` method to GraphRAGEngine
  - [x] 4.2 Integrate in WorkerBridge after execution completes
  - [x] 4.3 Create capability→capability edges from traces
  - [x] 4.4 Create capability→tool cross-type edges

- [x] **Task 5: Unit Tests** (AC: #7, #8, #9, #10)
  - [x] 5.1 Create `tests/unit/capabilities/code_generator_test.ts` (27 tests)
  - [x] 5.2 Create `tests/unit/sandbox/capability_injection_test.ts` (12 tests)
  - [x] 5.3 Test nested capability tracing (A→B→C)
  - [x] 5.4 Test GraphRAG edge creation
  - [x] 5.5 Test performance requirements (< 10ms code gen, < 5ms merge)
  - [x] 5.6 Test cycle detection (A→A, A→B→A, depth > 3)
  - [x] 5.7 Test code sanitization (blocked patterns)

- [x] **Task 6: Create CapabilityExecutor Orchestrator** (AC: #11, #12)
  - [x] 6.1 Create `src/capabilities/executor.ts`
  - [x] 6.2 Implement `prepareCapabilityContext(intent)` method
  - [x] 6.3 Integrate with CapabilityMatcher.findMatch()
  - [x] 6.4 Export from `src/capabilities/mod.ts`
  - [x] 6.5 Create `tests/unit/capabilities/executor_test.ts` (13 tests)
  - [x] 6.6 Create `tests/integration/capability_e2e_test.ts` (6 tests)

---

## Dev Notes

### Critical Implementation Details

1. **Code Sanitization Rules (SECURITY CRITICAL)**

   CapabilityCodeGenerator MUST sanitize capability code. **Concrete rules:**

   ```typescript
   // src/capabilities/code-generator.ts
   const BLOCKED_PATTERNS = [
     /\beval\s*\(/, // Block eval()
     /\bFunction\s*\(/, // Block Function constructor
     /\bimport\s*\(/, // Block dynamic import()
     /\bimport\s+/, // Block static import
     /\bexport\s+/, // Block export
     /\brequire\s*\(/, // Block require()
     /\b__proto__\b/, // Block prototype pollution
     /\bconstructor\s*\[/, // Block constructor access
     /\bDeno\b/, // Block Deno namespace access
     /\bself\b/, // Block Worker self reference
     /\bglobalThis\b(?!.__capabilityDepth)/, // Allow only depth tracking
   ];

   function sanitizeCapabilityCode(code: string): string {
     for (const pattern of BLOCKED_PATTERNS) {
       if (pattern.test(code)) {
         throw new Error(`Blocked pattern detected in capability code: ${pattern}`);
       }
     }
     // Validate syntactic correctness
     try {
       new Function(code); // Syntax check only, not executed
     } catch (e) {
       throw new Error(`Invalid JavaScript syntax in capability: ${e.message}`);
     }
     return code;
   }
   ```

2. **Capability Name Normalization (with collision handling)**

   ```typescript
   // Track used names to prevent collisions
   function normalizeCapabilityName(
     name: string,
     id: string,
     usedNames: Set<string>,
   ): string {
     let normalized = (name || id)
       .replace(/[^a-zA-Z0-9_]/g, "_")
       .replace(/^[0-9]/, "_$&"); // Can't start with number

     // Handle collisions: append last 4 chars of UUID
     if (usedNames.has(normalized)) {
       normalized = `${normalized}_${id.slice(-4)}`;
     }
     usedNames.add(normalized);
     return normalized;
   }
   ```

3. **__trace() Must Not Throw**

   Trace collection should never break execution (already in AC3).

4. **Cycle Detection via Depth Tracking**

   Implemented via `globalThis.__capabilityDepth` (see AC10). Max depth = 3 prevents infinite
   recursion A→B→A or A→A→A→A.

5. **CapabilityCodeGenerator Skeleton**

   ```typescript
   // src/capabilities/code-generator.ts (~100 LOC)
   import type { Capability } from "./types.ts";

   const MAX_DEPTH = 3;

   export class CapabilityCodeGenerator {
     private usedNames = new Set<string>();

     /**
      * Generate inline function code for a single capability
      */
     generateInlineCode(capability: Capability): string {
       const sanitizedCode = this.sanitizeCapabilityCode(capability.codeSnippet);
       const name = this.normalizeCapabilityName(
         capability.name || "",
         capability.id,
       );

       // Template with tracing + depth guard
       return `
   async (args) => {
     const __depth = (globalThis.__capabilityDepth || 0);
     if (__depth >= ${MAX_DEPTH}) {
       throw new Error("Capability depth exceeded (max: ${MAX_DEPTH})");
     }
     globalThis.__capabilityDepth = __depth + 1;
     __trace({ type: "capability_start", capability: "${name}", capability_id: "${capability.id}" });
     try {
       ${sanitizedCode}
     } catch (e) {
       __trace({ type: "capability_end", capability: "${name}", capability_id: "${capability.id}", success: false, error: e.message });
       throw e;
     } finally {
       globalThis.__capabilityDepth = __depth;
       __trace({ type: "capability_end", capability: "${name}", capability_id: "${capability.id}", success: true });
     }
   }`;
     }

     /**
      * Build full capabilities object code from multiple capabilities
      */
     buildCapabilitiesObject(capabilities: Capability[]): string {
       this.usedNames.clear();
       const entries = capabilities.map((cap) => {
         const name = this.normalizeCapabilityName(cap.name || "", cap.id);
         const code = this.generateInlineCode(cap);
         return `  ${name}: ${code}`;
       });
       return `const capabilities = {\n${entries.join(",\n")}\n};`;
     }

     // sanitizeCapabilityCode() - see Dev Notes #1
     // normalizeCapabilityName() - see Dev Notes #2
   }
   ```

### Project Structure Notes

**Files to Create:**

```
src/capabilities/
├── code-generator.ts    # NEW: CapabilityCodeGenerator class (~80 LOC)
└── mod.ts               # MODIFY: Add export
```

**Files to Modify:**

```
src/sandbox/
├── worker-bridge.ts     # MODIFY: Add buildCapabilityContext() (~40 LOC)
├── sandbox-worker.ts    # MODIFY: Add __trace(), inject capabilities (~30 LOC)
└── types.ts             # MODIFY: Extend InitMessage, add WorkerTraceEvent

src/graphrag/
└── graph-engine.ts      # MODIFY: Add updateFromCodeExecution() (~20 LOC)
```

**File Locations (from architecture):**

- Capabilities: `src/capabilities/`
- Sandbox: `src/sandbox/`
- GraphRAG: `src/graphrag/`

### Existing Code Patterns to Follow

**WorkerBridge.execute()** (`src/sandbox/worker-bridge.ts:113-238`):

- Spawns Worker, handles RPC, returns ExecutionResult
- Story 7.3b extends this to inject capability context

**SandboxWorker.handleInit()** (`src/sandbox/sandbox-worker.ts:157-181`):

- Receives init message, generates tool proxies, executes code
- Story 7.3b adds capability context injection here

**Trace Event Structure** (`src/sandbox/types.ts`):

```typescript
export interface TraceEvent {
  type: "tool_start" | "tool_end";
  tool: string;
  trace_id: string;
  ts: number;
  success?: boolean;
  duration_ms?: number;
  error?: string;
}
// Story 7.3b adds: "capability_start" | "capability_end"
```

### References

- **WorkerBridge:** `src/sandbox/worker-bridge.ts:69-392`
- **SandboxWorker:** `src/sandbox/sandbox-worker.ts`
- **CapabilityMatcher:** `src/capabilities/matcher.ts` (Story 7.3a)
- **CapabilityStore:** `src/capabilities/capability-store.ts`
- **Trace Types:** `src/sandbox/types.ts`
- **GraphRAGEngine:** `src/graphrag/graph-engine.ts`
- **Previous story (7.3a):**
  `docs/sprint-artifacts/7-3a-capability-matching-search-capabilities-tool.md`
- **Epics doc:** `docs/epics.md` (Story 7.3b section)

---

## Previous Story Intelligence

### From Story 7.3a (CapabilityMatcher)

- **What worked:** Adaptive thresholds integration without hardcoded values
- **Pattern used:** Helper class injected via constructor (testable)
- **Testing pattern:** 3 unit tests in `tests/unit/capabilities/matcher_test.ts`
- **Integration:** CapabilityMatcher available via DAGSuggester

### From Story 7.1b (Worker RPC Bridge)

- **What worked:** postMessage RPC protocol, native tracing in bridge
- **Pattern used:** WorkerBridge class coordinates main↔worker communication
- **Key insight:** Traces collected in bridge (tool_*), not parsed from stdout
- **Files created:** `worker-bridge.ts`, `sandbox-worker.ts`

### Code from 7.3a that 7.3b can reuse:

```typescript
// CapabilityMatcher.findMatch() returns capabilities ready for injection
const match = await matcher.findMatch(intent);
if (match) {
  // match.capability has code_snippet ready to inject
  const capContext = bridge.buildCapabilityContext([match.capability]);
  // ... execute with capContext
}
```

---

## Git Intelligence

### Recent Commits (last 5):

```
1efcea3 feat: Introduce Drizzle ORM for database management, add API key handling, and update algorithm and observability ADRs.
18b73c2 bmad windsurf and antigravity
5f0a7b3 fix: update .gitignore to properly exclude BMAD framework and related files
b94e292 Adrs algos and landing
21b36e8 chore: clean up docs and obsolete files for open source
```

### Learnings from 1efcea3:

- Drizzle ORM now used for database schema
- API key handling patterns established
- ADR updates for scoring algorithms

### Patterns from worker-bridge.ts (Story 7.1b):

- RPC message types defined in `types.ts`
- Trace events collected with timestamps
- Error handling preserves traces
- `getTraces()` returns copy of array

---

## Technical Stack (from Architecture)

- **Runtime:** Deno 2.5+ with TypeScript 5.7+
- **Sandbox:** Deno Worker with `permissions: "none"`
- **Communication:** postMessage RPC protocol
- **Database:** PGlite 0.3.11 with pgvector
- **GraphRAG:** Graphology library
- **Testing:** Deno test runner, `deno task test:unit`

---

## Estimation (Original - SUPERSEDED)

> ⚠️ **See Revised Estimation in Pre-Implementation Review section below**

- ~~**Effort:** 2-2.5 days~~
- ~~**LOC:** ~200-250~~
- **Risk:** Low-Medium (builds on existing Worker RPC Bridge, added cycle detection complexity)

---

## Pre-Implementation Review (2024-12-08)

### Issues Identified

#### Issue #1: File Name Correction ⚠️

```
Story references:  src/graphrag/graph-rag-engine.ts  ← INCORRECT
Actual file:       src/graphrag/graph-engine.ts      ← CORRECT
```

**Action:** All references to `graph-rag-engine.ts` must use `graph-engine.ts`.

#### Issue #2: GraphRAG API Incompatibility ⚠️

**Story proposes (AC5):**

```typescript
async updateFromCodeExecution(traces: TraceEvent[]): Promise<void>
```

**Existing API (`graph-engine.ts:331`):**

```typescript
async updateFromExecution(execution: WorkflowExecution): Promise<void>
// WorkflowExecution = { dag_structure, success, intent_text, ... }
```

**Resolution:** Create a NEW method `updateFromCodeExecution()` that:

1. Converts TraceEvent[] to edge updates
2. Does NOT replace existing `updateFromExecution()` (used by DAG workflows)

#### Issue #3: TraceEvent Type Needs Discriminated Union ⚠️

**Current type has `tool: string` as required**, but capability events don't have a tool.

**Recommended refactor for `src/sandbox/types.ts`:**

```typescript
// Base interface for common fields
interface BaseTraceEvent {
  trace_id: string;
  ts: number;
  success?: boolean;
  duration_ms?: number;
  error?: string;
}

// Tool trace events (existing)
interface ToolTraceEvent extends BaseTraceEvent {
  type: "tool_start" | "tool_end";
  tool: string;
}

// Capability trace events (new)
interface CapabilityTraceEvent extends BaseTraceEvent {
  type: "capability_start" | "capability_end";
  capability: string;
  capability_id: string;
}

// Discriminated union
export type TraceEvent = ToolTraceEvent | CapabilityTraceEvent;
```

#### Issue #4: Cycle Detection Security Risk ⚠️

**Problem:** `globalThis.__capabilityDepth` can be manipulated by user code:

```typescript
globalThis.__capabilityDepth = -999; // Bypasses depth check
```

**Recommended fix:** Use a closure-scoped variable instead:

```typescript
// In sandbox-worker.ts (not accessible to user code)
let __capabilityDepth = 0;

// Generated capability wrapper
(async (args) => {
  if (__capabilityDepth >= 3) throw new Error("Depth exceeded");
  __capabilityDepth++;
  try {
    // capability code
  } finally {
    __capabilityDepth--;
  }
});
```

#### Issue #5: Missing Orchestration Layer ⚠️

**Gap:** No code connects CapabilityMatcher → CodeGenerator → WorkerBridge.

**Add new task (Task 6):**

```
- [ ] **Task 6: Create CapabilityExecutor Orchestrator** (NEW)
  - [ ] 6.1 Create `src/capabilities/executor.ts`
  - [ ] 6.2 Implement orchestration: Intent → Match → Inject → Execute
  - [ ] 6.3 Integrate with existing DAGSuggester.searchCapabilities()
  - [ ] 6.4 Add to mod.ts exports
```

**Skeleton:**

```typescript
// src/capabilities/executor.ts
export class CapabilityExecutor {
  constructor(
    private matcher: CapabilityMatcher,
    private codeGenerator: CapabilityCodeGenerator,
  ) {}

  async prepareCapabilityContext(intent: string): Promise<string | undefined> {
    const match = await this.matcher.findMatch(intent);
    if (!match) return undefined;
    return this.codeGenerator.buildCapabilitiesObject([match.capability]);
  }
}
```

### Additional Acceptance Criteria

#### AC11: End-to-End Integration Test ✅

- [x] Test full flow: Intent → CapabilityMatcher → CodeGenerator → WorkerBridge → Traces → GraphRAG
- [x] Verify capability is actually executed (not just injected)
- [x] Verify traces appear in merged output
- [x] Verify GraphRAG edge created for capability→tool call

#### AC12: CapabilityExecutor Orchestrator ✅

- [x] `src/capabilities/executor.ts` created
- [x] `prepareCapabilityContext(intent)` method implemented
- [x] Exported from `src/capabilities/mod.ts`
- [x] Unit test coverage (13 tests)

### Updated File List

| File                                              | Action | Notes                              |
| ------------------------------------------------- | ------ | ---------------------------------- |
| `src/capabilities/code-generator.ts`              | NEW    | CapabilityCodeGenerator class      |
| `src/capabilities/executor.ts`                    | NEW    | **Orchestrator (added)**           |
| `src/capabilities/mod.ts`                         | MODIFY | Export CodeGenerator + Executor    |
| `src/sandbox/worker-bridge.ts`                    | MODIFY | Add buildCapabilityContext()       |
| `src/sandbox/sandbox-worker.ts`                   | MODIFY | Add __trace(), inject capabilities |
| `src/sandbox/types.ts`                            | MODIFY | **Discriminated union TraceEvent** |
| `src/graphrag/graph-engine.ts`                    | MODIFY | **Add updateFromCodeExecution()**  |
| `tests/unit/capabilities/code_generator_test.ts`  | NEW    | Unit tests                         |
| `tests/unit/capabilities/executor_test.ts`        | NEW    | **Orchestrator tests (added)**     |
| `tests/unit/sandbox/capability_injection_test.ts` | NEW    | Integration tests                  |
| `tests/integration/capability_e2e_test.ts`        | NEW    | **E2E test (added)**               |

### Revised Estimation

- **Effort:** 2.5-3 days (added orchestrator + E2E tests)
- **LOC:** ~300-350 (added executor.ts ~50, e2e test ~50)
- **Risk:** Medium (type refactoring may have ripple effects)

---

## ADR Integration Opportunities

### ADR-036: BroadcastChannel ✅ RECOMMENDED

**Applicable à cette story:** Le tracing capability→Worker peut utiliser BroadcastChannel pour
l'émission temps réel.

**Avantages:**

- Traces émises **en temps réel** (pas batch à la fin)
- Live monitoring du dashboard pendant l'exécution
- API native Deno (pas de dépendance)
- Fonctionne cross-worker nativement

**Implementation proposée:**

```typescript
// src/sandbox/sandbox-worker.ts - Alternative to __workerTraces array
const traceChannel = new BroadcastChannel("pml-traces");

function __trace(event: Partial<TraceEvent>): void {
  const fullEvent: TraceEvent = {
    ...event,
    trace_id: crypto.randomUUID(),
    ts: Date.now(),
  } as TraceEvent;

  // Emit immediately instead of accumulating
  traceChannel.postMessage(fullEvent);
}

// Cleanup on worker termination
self.addEventListener("unload", () => traceChannel.close());
```

```typescript
// src/sandbox/worker-bridge.ts - Subscribe to trace channel
export class WorkerBridge {
  private traceChannel: BroadcastChannel;

  constructor(/* ... */) {
    this.traceChannel = new BroadcastChannel("pml-traces");
    this.traceChannel.onmessage = (e) => {
      this.traces.push(e.data as TraceEvent);
    };
  }

  terminate(): void {
    this.traceChannel.close();
    // ...
  }
}
```

**Impact sur les AC:**

- AC3 modifié: `__trace()` utilise BroadcastChannel au lieu de `__workerTraces[]`
- AC4 simplifié: Plus besoin de merge manuel, traces arrivent en temps réel
- AC6 modifié: `ExecutionCompleteMessage` n'a plus besoin de `workerTraces` field

**Task additionnelle proposée:**

```
- [ ] **Task 7: BroadcastChannel Integration** (AC: #3, #4) ← OPTIONAL
  - [ ] 7.1 Create trace channel in sandbox-worker.ts
  - [ ] 7.2 Subscribe to channel in worker-bridge.ts
  - [ ] 7.3 Remove workerTraces from ExecutionCompleteMessage (simplification)
  - [ ] 7.4 Test real-time trace emission
  - [ ] 7.5 Add channel cleanup on worker termination
```

### ADR-034: OpenTelemetry ⏳ FUTURE ENHANCEMENT

**Non recommandé pour cette story car:**

- Requiert flag `--unstable-otel` (sera stable dans Deno 2.3+)
- Plus gros refactoring de l'infrastructure de tracing
- BroadcastChannel suffit pour les besoins actuels

**Opportunité future:**

- Convertir `TraceEvent` en OTEL spans
- Activer distributed tracing avec parent/child automatique
- Export vers Jaeger/Tempo pour visualisation

**Story séparée recommandée:** "OTEL Integration for Capability Tracing" après Story 7.3b

---

## Dev Agent Record

### Context Reference

- `src/sandbox/worker-bridge.ts:113-238` - execute() method to extend
- `src/sandbox/sandbox-worker.ts:157-181` - handleInit() to modify
- `src/sandbox/types.ts:1-100` - Type definitions to extend
- `src/graphrag/graph-engine.ts:331-439` - updateFromExecution() (add new updateFromCodeExecution)
- `src/capabilities/types.ts:42-73` - Capability interface
- `src/capabilities/matcher.ts:37-102` - CapabilityMatcher.findMatch() for orchestrator integration

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

(Will be filled during implementation)

### Completion Notes List

**2024-12-09 - Code Review Fixes:**

1. **Tests Created (58 total):**
   - `executor_test.ts`: 13 tests for CapabilityExecutor orchestrator
   - `capability_injection_test.ts`: 12 tests for injection flow and tracing
   - `capability_e2e_test.ts`: 6 E2E integration tests
   - `code_generator_test.ts`: 27 tests (existing, verified passing)

2. **GraphRAG Integration Added (AC#5):**
   - `WorkerBridge` now calls `graphRAG.updateFromCodeExecution()` after execution
   - Optional `graphRAG` parameter in `WorkerBridgeConfig`
   - Error handling ensures execution doesn't fail if GraphRAG update fails

3. **BroadcastChannel (ADR-036) Used:**
   - Real-time trace emission instead of batch at completion
   - Simplifies trace merging (no manual merge needed)
   - Worker cleanup via `bridge.cleanup()` method

4. **All Tests Pass:**
   - 27 code_generator tests
   - 41 worker_bridge tests (including 8 new capability tests)
   - 12 capability_injection tests
   - 6 e2e integration tests

**Test Command:**

```bash
deno test tests/unit/capabilities/ tests/unit/sandbox/worker_bridge_test.ts tests/integration/capability_e2e_test.ts --allow-read --allow-write --allow-net --allow-env --allow-run --unstable-broadcast-channel --unstable-worker-options
```

### File List

- [x] `src/capabilities/code-generator.ts` - NEW (CapabilityCodeGenerator)
- [x] `src/capabilities/executor.ts` - NEW (CapabilityExecutor orchestrator)
- [x] `src/capabilities/mod.ts` - MODIFY (export CodeGenerator + Executor)
- [x] `src/sandbox/worker-bridge.ts` - MODIFY (add buildCapabilityContext, GraphRAG integration)
- [x] `src/sandbox/sandbox-worker.ts` - MODIFY (add __trace via BroadcastChannel)
- [x] `src/sandbox/types.ts` - MODIFY (discriminated union TraceEvent)
- [x] `src/graphrag/graph-engine.ts` - MODIFY (add updateFromCodeExecution)
- [x] `tests/unit/capabilities/code_generator_test.ts` - NEW (27 unit tests)
- [x] `tests/unit/capabilities/executor_test.ts` - NEW (13 orchestrator tests)
- [x] `tests/unit/sandbox/capability_injection_test.ts` - NEW (12 integration tests)
- [x] `tests/unit/sandbox/worker_bridge_test.ts` - MODIFY (capability tests added)
- [x] `tests/integration/capability_e2e_test.ts` - NEW (6 E2E tests)
- [x] `deno.json` - MODIFY (test configuration)
