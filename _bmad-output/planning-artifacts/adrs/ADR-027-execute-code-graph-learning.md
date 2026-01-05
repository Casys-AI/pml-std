# ADR-027: Execute Code Graph Learning Integration

**Status:** ⛔ Superseded **Date:** 2025-12-05 | **Superseded by:** ADR-032

> Tracing approach (`__TRACE__` stdout parsing) replaced by Worker RPC Bridge. The rationale and
> vision remain valid; implementation changed.
>
> **What is superseded:**
>
> - Phase 2 implementation (`__TRACE__` prefix, `parseTraces()`, etc.)
> - IPC mechanism selection (stdout prefix → postMessage RPC)

---

**Original Status:** Approved (2025-12-04) → Integrated into Epic 7 (Story 7.1)

> **Original Decision: Option B (Accurate Tracking)** - IPC via `__TRACE__` prefix on stdout

> **Rationale (2025-12-03):** Code execution is expected to become a central feature. Claude may
> reuse code snippets, store successful patterns, and learn from execution history. Accurate
> tracking is worth the implementation complexity.

## Context

Currently, `execute_code` allows running TypeScript/JavaScript in a Deno sandbox with access to MCP
tools via the `ContextBuilder`. However, tool usage within code execution is **not tracked** for
GraphRAG learning.

### Current Flow

```
execute_code(intent, code)
       ↓
   VectorSearch → finds relevant tools (top-k)
       ↓
   ContextBuilder → injects tools into sandbox
       ↓
   DenoSandboxExecutor → runs code, calls MCP tools
       ↓
   Return result ← NO GRAPH UPDATE
```

### Comparison with execute_dag

| Feature         | `execute_dag`                          | `execute_code` |
| --------------- | -------------------------------------- | -------------- |
| Calls MCP tools | ✅                                     | ✅             |
| Creates edges   | ✅ `graphEngine.updateFromExecution()` | ❌ Missing     |
| Learning loop   | ✅                                     | ❌             |

### Problem

When a user executes code like:

```typescript
const content = await filesystem.readFile({ path: "README.md" });
await memory.createEntities({ entities: [...] });
```

The sequence `filesystem:read_file → memory:create_entities` is **not learned** by the GraphRAG.
This means:

1. No edge created between these tools
2. No confidence boost for this pattern
3. Future DAG suggestions won't benefit from this usage data

## Decision

Implement graph learning for `execute_code` tool calls with the following approach:

### Option A: Track Injected Tools (Simpler)

Track which tools were **injected** into the sandbox based on intent, regardless of actual usage:

```typescript
// After successful execution
if (result.success && request.intent && toolResults.length > 0) {
  await this.graphEngine.updateFromExecution({
    execution_id: crypto.randomUUID(),
    executed_at: new Date(),
    intent_text: request.intent,
    dag_structure: {
      tasks: toolResults.map((t, i) => ({
        id: `task_${i}`,
        tool: `${t.serverId}:${t.toolName}`,
        depends_on: i > 0 ? [`task_${i - 1}`] : [],
      })),
    },
    success: true,
    execution_time_ms: executionTimeMs,
    source: "execute_code",
  });
}
```

**Pros:**

- Simple implementation
- No sandbox modification needed
- Consistent with existing learning API

**Cons:**

- May create edges for tools that weren't actually called
- Less accurate than actual usage tracking

### Option B: Track Actual Tool Calls (More Accurate)

Instrument the `ContextBuilder` wrappers to report actual tool invocations:

```typescript
// In context-builder.ts wrapMCPClient()
wrapped[methodName] = async (args) => {
  const result = await client.callTool(toolName, args);

  // Report usage to tracker
  this.usageTracker?.recordToolCall(serverId, toolName);

  return result;
};
```

Then after execution:

```typescript
const toolsUsed = executor.getToolsUsed(); // Ordered list of actual calls
await this.graphEngine.updateFromExecution({
  dag_structure: buildDAGFromToolSequence(toolsUsed),
  // ...
});
```

**Pros:**

- Accurate edge creation (only actual usage)
- Captures real tool sequences
- Better learning signal

**Cons:**

- More complex implementation
- Requires sandbox-to-parent communication for tracking
- Need to handle async/parallel tool calls

### Option C: Hybrid Approach (Recommended)

1. **Phase 1**: Implement Option A (track injected tools) as quick win
2. **Phase 2**: Add optional actual tracking via wrapper instrumentation

This provides immediate value while allowing for future accuracy improvements.

## Implementation Plan

### Phase 1: Injected Tools Tracking

**File:** `src/mcp/gateway-server.ts`

```typescript
// In handleExecuteCode(), after line 1131 (success log)

// Track tool usage for graph learning (ADR-027)
if (result.success && request.intent && toolResults.length > 0) {
  try {
    await this.graphEngine.updateFromExecution({
      execution_id: crypto.randomUUID(),
      executed_at: new Date(),
      intent_text: request.intent,
      dag_structure: {
        tasks: toolResults.map((t, i) => ({
          id: `code_task_${i}`,
          tool: `${t.serverId}:${t.toolName}`,
          arguments: {},
          depends_on: [], // No dependency info available
        })),
      },
      success: true,
      execution_time_ms: executionTimeMs,
    });
    log.debug(`Graph updated with ${toolResults.length} tools from execute_code`);
  } catch (err) {
    log.warn(`Failed to update graph from execute_code: ${err}`);
    // Non-fatal: don't fail the execution for learning errors
  }
}
```

### Phase 2: Actual Usage Tracking via IPC

**Decision (2025-12-03):** Use stdout-based IPC with `__TRACE__` prefix for sandbox-to-parent
communication.

#### IPC Mechanism: Why stdout with prefix?

| Option                | Pour                         | Contre                      | Verdict         |
| --------------------- | ---------------------------- | --------------------------- | --------------- |
| **stdout JSON lines** | Simple, Deno-native, no deps | Mélangé avec output         | ✅ Avec préfixe |
| **stderr séparé**     | Séparation claire            | stderr = erreurs convention | ❌              |
| **Pipe/socket dédié** | Propre, bidirectionnel       | Plomberie complexe          | ❌ Overkill     |
| **Post-hoc wrapper**  | Simple                       | Pas de streaming            | ❌              |

**Choix:** `__TRACE__` prefix sur stdout car:

1. Deno subprocess capture stdout nativement
2. Préfixe évite collision avec `console.log` utilisateur
3. JSON parsing simple et rapide
4. Extensible (nouveaux event types)

#### Implementation: context-builder.ts

**File:** `src/sandbox/context-builder.ts` (dans `wrapMCPClient()`, ligne ~381)

```typescript
wrapped[methodName] = async (args: Record<string, unknown>): Promise<unknown> => {
  const traceId = crypto.randomUUID();
  const startTs = Date.now();

  // Emit start event via stdout IPC
  console.log(`__TRACE__${
    JSON.stringify({
      type: "tool_start",
      tool: `${client.serverId}:${toolName}`,
      trace_id: traceId,
      ts: startTs,
    })
  }`);

  try {
    logger.debug(`Calling tool: ${client.serverId}:${toolName}`, {
      argsKeys: Object.keys(args),
    });

    const result = await client.callTool(toolName, args);

    // Emit success event
    console.log(`__TRACE__${
      JSON.stringify({
        type: "tool_end",
        tool: `${client.serverId}:${toolName}`,
        trace_id: traceId,
        success: true,
        duration_ms: Date.now() - startTs,
      })
    }`);

    logger.debug(`Tool call succeeded: ${client.serverId}:${toolName}`);
    return result;
  } catch (error) {
    // Emit failure event
    console.log(`__TRACE__${
      JSON.stringify({
        type: "tool_end",
        tool: `${client.serverId}:${toolName}`,
        trace_id: traceId,
        success: false,
        duration_ms: Date.now() - startTs,
        error: error instanceof Error ? error.message : String(error),
      })
    }`);

    logger.error(`Tool call failed: ${client.serverId}:${toolName}`, {
      error: error instanceof Error ? error.message : String(error),
    });

    throw new MCPToolError(
      `${client.serverId}:${toolName}`,
      error instanceof Error ? error : new Error(String(error)),
    );
  }
};
```

#### Implementation: gateway-server.ts

**File:** `src/mcp/gateway-server.ts` (dans `handleExecuteCode()`, après exécution)

```typescript
// Parse traces from sandbox stdout
function parseTraces(
  stdout: string,
): Array<{ tool: string; success: boolean; duration_ms: number }> {
  const traces: Array<{ tool: string; success: boolean; duration_ms: number }> = [];

  for (const line of stdout.split("\n")) {
    if (line.startsWith("__TRACE__")) {
      try {
        const event = JSON.parse(line.slice(9)); // Remove '__TRACE__' prefix
        if (event.type === "tool_end") {
          traces.push({
            tool: event.tool,
            success: event.success,
            duration_ms: event.duration_ms,
          });
        }
      } catch {
        // Ignore malformed traces
      }
    }
  }

  return traces;
}

// In handleExecuteCode(), after successful execution:
const toolsUsed = parseTraces(result.stdout || "");
const successfulTools = toolsUsed.filter((t) => t.success).map((t) => t.tool);

if (result.success && request.intent && successfulTools.length > 0) {
  try {
    await this.graphEngine.updateFromExecution({
      execution_id: crypto.randomUUID(),
      executed_at: new Date(),
      intent_text: request.intent,
      dag_structure: {
        tasks: successfulTools.map((tool, i) => ({
          id: `code_task_${i}`,
          tool,
          arguments: {},
          depends_on: [], // Séquentiel par défaut, inférence statistique fera le reste
        })),
      },
      success: true,
      execution_time_ms: executionTimeMs,
    });
    log.debug(`Graph updated with ${successfulTools.length} tools from execute_code`);
  } catch (err) {
    log.warn(`Failed to update graph from execute_code: ${err}`);
  }
}
```

#### Event Types

```typescript
type TraceEvent =
  | { type: "tool_start"; tool: string; trace_id: string; ts: number }
  | {
    type: "tool_end";
    tool: string;
    trace_id: string;
    success: boolean;
    duration_ms: number;
    error?: string;
  }
  | { type: "progress"; message: string; done?: number; total?: number } // Future: long tasks
  | { type: "log"; level: "debug" | "info" | "warn"; message: string }; // Future: debug mode
```

#### Why NOT track dependencies explicitly?

Le spike a conclu que **les dépendances émergent du learning statistique**:

1. On track l'ordre d'appel (séquentiel)
2. `updateFromExecution()` crée/renforce les edges
3. `buildDAG()` cherche les paths dans le graphe
4. Si A précède toujours B → edge fort → dépendance
5. Si ordre variable → pas d'edge fort → parallèle possible

**Avantage:** Pas besoin de parser le code pour détecter `Promise.all()` - l'inférence statistique
suffit.

## Consequences

### Positive

- `execute_code` contributes to GraphRAG learning
- Tool patterns discovered via code execution improve future suggestions
- Consistent learning across all execution modes

### Negative

- Phase 1 may create some false edges (tools injected but not called)
- Additional database writes per execution
- Slight performance overhead

### Neutral

- Learning from code execution is inherently less structured than DAG execution
- Edge confidence from code execution should potentially be weighted lower

## Metrics

Track effectiveness via:

- `execute_code_graph_updates_total` - Number of graph updates from code execution
- `execute_code_tools_tracked` - Tools per execution
- Compare edge creation rate between `execute_dag` and `execute_code`

## Future Vision: Claude as High-Level Orchestrator

The ultimate goal is to transform Claude from a tool caller into a **strategic orchestrator** that
delegates execution to Casys PML:

```
┌─────────────────────────────────────────────────────────────┐
│  CLAUDE (High-Level Orchestrator)                           │
│                                                              │
│  "Analyze this week's commits and create a report"          │
│                          │                                   │
│  1. Search snippet library → "I've done this before"        │
│  2. Or compose new code from learned patterns               │
│  3. Launch execute_code                                      │
│  4. Receive only: { status: "ok", summary: {...} }          │
│                                                              │
│  Claude does NOT see:                                        │
│  - 1000 raw commits                                          │
│  - 47 intermediate MCP calls                                 │
│  - Processing details                                        │
└─────────────────────────────────────────────────────────────┘
                          │
            IPC (progress, logs, result)
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  AGENTCARDS (Autonomous Execution)                          │
│                                                              │
│  - Execute code in sandbox                                   │
│  - Call MCP tools as needed                                  │
│  - Handle errors/retries                                     │
│  - Track patterns → GraphRAG learning                        │
│  - Return condensed result                                   │
└─────────────────────────────────────────────────────────────┘
```

### Benefits of This Architecture

1. **Context Preservation** - Claude keeps context for strategy, not data crunching
2. **Code Reuse** - Proven snippets retrieved from library
3. **Autonomous Learning** - GraphRAG learns effective patterns without Claude involvement
4. **Scalability** - 1 Claude call = N operations under the hood

### IPC Event Stream

Claude receives structured progress updates:

```typescript
// Progress events (optional, for long tasks)
{ type: "progress", step: "fetching commits", done: 250, total: 1000 }
{ type: "progress", step: "processing", done: 800, total: 1000 }

// Final result (what matters)
{
  type: "result",
  success: true,
  data: { topContributors: [...], totalCommits: 47 },
  executionTime: 3200,
  toolsCalled: ["github:list_commits", "memory:create_entities"]
}
```

### Code Snippet Library

- Store successful code snippets with metadata (intent, tools used, performance)
- Claude can retrieve and reuse proven patterns
- Version control for code evolution
- Fingerprinting for deduplication

### Learning Loops

1. **Execution Learning** - Track which tool sequences work for which intents
2. **Snippet Ranking** - Promote frequently successful code patterns
3. **Error Learning** - Remember what failed and why
4. **Performance Optimization** - Learn faster alternatives

### Research Topics

- **IPC patterns for Deno subprocesses** - Best practices for parent-child communication
- **Parallel execution tracking** - Representing `Promise.all()` patterns in DAG structure
- **Code fingerprinting** - Identify similar code for deduplication/reuse
- **Snippet retrieval** - Semantic search over code library

### Related Epic Ideas

- Epic 7: Code Snippet Memory & Reuse
- Epic 8: Execution Pattern Learning
- Epic 9: Claude Orchestrator Mode

## References

- ADR-016: Deno Sandbox Execution
- Story 3.4: Tool Discovery for Code Execution
- `src/mcp/gateway-server.ts:1019-1148` - handleExecuteCode implementation
- `src/sandbox/context-builder.ts` - Tool injection system
