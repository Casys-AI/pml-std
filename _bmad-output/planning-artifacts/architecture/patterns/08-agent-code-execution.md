# Pattern 5: Agent Code Execution & Local Processing (Epic 3)

**Status:** 🟡 IN PROGRESS (Stories 3.1-3.2 done, 3.4 ready for dev)

**Architecture Principle:** LLM writes code, sandbox executes safely

Epic 3 implémente un environnement d'exécution de code TypeScript sécurisé et isolé, permettant aux
agents LLM d'**écrire du code de traitement** qui s'exécute localement pour filtrer/agréger les
données volumineuses, retournant uniquement un résumé compact au contexte LLM.

## The Flow (Anthropic-Inspired Code Execution)

```
1. LLM voit tools disponibles → Vector search (Epic 1)
2. LLM décide quelle analyse faire → Natural language reasoning
3. LLM écrit code TypeScript → Agent generates custom processing code
4. Code s'exécute dans sandbox Deno → Isolated subprocess, timeout 30s, 512MB heap
5. Résultat traité retourne au LLM → Compact summary (<1KB), not raw data (1MB+)
```

**Concrete Example:**

```typescript
// User: "Analyze commits from last week"

// LLM discovers github.listCommits() via vector search
// LLM writes TypeScript code:
const code = `
  const commits = await github.listCommits({ limit: 1000 });

  // Filter locally (no context cost)
  const lastWeek = commits.filter(c =>
    new Date(c.date) > Date.now() - 7 * 24 * 3600 * 1000
  );

  // Aggregate locally
  const byAuthor = lastWeek.reduce((acc, c) => {
    acc[c.author] = (acc[c.author] || 0) + 1;
    return acc;
  }, {});

  // Return compact summary
  return Object.entries(byAuthor)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
`;

// Sandbox executes → 1000 commits (1.2MB) processed locally
// Returns to LLM: [{ author: "alice", count: 42 }, ...] (500 bytes)
// Context savings: 99.96%
```

## Architecture Components

**1. DenoSandboxExecutor** (`src/sandbox/executor.ts`) - Story 3.1 ✅

- Subprocess spawning: `Deno.Command` with explicit permissions
- Timeout enforcement: AbortController, 30s default
- Memory limits: `--v8-flags=--max-old-space-size=512`
- Structured errors: SyntaxError, RuntimeError, TimeoutError, MemoryError
- Performance: <100ms startup (achieved: 34.77ms), <50ms overhead

**2. ContextBuilder** (`src/sandbox/context-builder.ts`) - Story 3.2 ✅

- Intent-based tool discovery: Vector search for top-k relevant tools
- Type-safe wrapper generation: MCP tools → TypeScript functions
- Tool routing: Wrappers route calls through MCPGatewayServer
- Error propagation: MCP errors → JavaScript exceptions
- Security: No eval(), template strings only

**3. execute_code MCP Tool** (`src/mcp/gateway-server.ts`) - Story 3.4 ⏳

- MCP tool: `pml:execute_code`
- Input: `{ code: string, intent?: string, context?: object, sandbox_config?: object }`
- Output: `{ result: any, logs: string[], metrics: object, state?: object }`
- Modes: Intent-based (vector search) or Explicit (provided context)
- Integration: New TaskType `"code_execution"` in DAG

## Epic 2.5 Integration (Delegation Pattern)

**ControlledExecutor Delegation:**

```typescript
// Epic 2.5 ControlledExecutor builds DAG with code_execution tasks
const dag = {
  tasks: [
    { type: "mcp_tool", toolId: "github:list_commits" },  // Layer 0
    { type: "code_execution", code: "...", deps: [...] }, // Layer 1 (NEW)
    { type: "mcp_tool", toolId: "slack:send" }            // Layer 2
  ]
};

// ControlledExecutor routes code_execution tasks to sandbox
// Results integrated into WorkflowState via reducers
// Checkpoint-compatible (PGlite persistence)
```

**Safe-to-Fail Pattern:**

- Code execution tasks are **idempotent** (safe to retry)
- Sandbox isolation prevents side-effects
- Virtual filesystem hooks (foundation in 3.4, full implementation later)
- Rollback support: Execution can be aborted without permanent changes
- Foundation for Epic 3.5 speculation (safe speculative branches)

## What Epic 3 Does vs Doesn't Do

**✅ Epic 3 DOES:**

- Execute TypeScript code in isolated Deno sandbox
- Inject MCP tools into code context via vector search
- Process large datasets locally before returning to LLM
- Integrate as DAG task type in ControlledExecutor
- Provide safe-to-fail execution (sandbox isolation)
- Save code execution results in checkpoints

**❌ Epic 3 DOES NOT:**

- Automatically trigger DAG replanning from code
- Replan is AIL/HIL decision (Epic 2.5-3 already handles this)
- Code can return `state` for checkpoints, but no auto-enqueue of replan_dag
- Agent/Human decides when to replan based on code execution results

## Performance Targets

- Sandbox startup: <100ms (achieved: 34.77ms ✅)
- Code execution overhead: <50ms (achieved: 33.22ms ✅)
- Total execution (simple code): <500ms
- Tool discovery (intent-based): <200ms
- Hybrid workflow (5 tasks): <3s P95

## Security Model

- **Explicit permissions only:** `--allow-env`, `--allow-read=~/.pml`
- **Deny by default:** `--deny-write`, `--deny-net`, `--deny-run`, `--deny-ffi`
- **No eval():** Template strings only, no dynamic code generation
- **Process isolation:** Code runs in separate subprocess
- **Resource limits:** 30s timeout, 512MB heap

## Implementation Plan

**Epic 3:** Agent Code Execution & Local Processing (12-15 hours)

**Story 3.1:** Deno Sandbox Executor Foundation (2-3h) ✅ DONE

- DenoSandboxExecutor with subprocess isolation
- Timeout and memory limits
- Structured error handling

**Story 3.2:** MCP Tools Injection (2-3h) ✅ REVIEW

- ContextBuilder with vector search integration
- Type-safe tool wrappers
- Gateway routing for tool calls

**Story 3.3:** Local Data Processing Pipeline (2-3h) ⚠️ SCOPE CLARIFICATION

- **Status:** Likely skip/defer (overlaps with 3.4)
- Agent writes custom code instead of pre-built helpers

**Story 3.4:** execute_code MCP Tool (3-4h) ⏳ READY FOR DEV

- MCP tool registration in gateway
- Intent-based and explicit modes
- DAG integration (new TaskType)
- Checkpoint compatibility
- Safe-to-fail foundation

**Stories 3.5-3.8:** Advanced Features (4-6h) 📋 DRAFTED/BACKLOG

- 3.5: PII detection/tokenization
- 3.6: Code execution caching
- 3.7: E2E tests & documentation
- 3.8: Security hardening

---

**Affects Epics:** Epic 3 (Stories 3.1-3.8)

**References:**

- Tech Spec: `docs/tech-spec-epic-3.md`
- ADR-007: `docs/adrs/ADR-007-dag-adaptive-feedback-loops.md` (Epic 3 delegation architecture)
- Story 3.1: `docs/stories/story-3.1.md`
- Story 3.2: `docs/stories/story-3.2.md`
- Story 3.4: `docs/stories/story-3.4.md`

**Design Philosophy:** Code execution enables agents to "think locally, act globally" - process
massive datasets locally, return compact insights. Sandbox isolation provides safe-to-fail semantics
essential for speculative execution (Epic 3.5).

---
