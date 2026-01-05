# ADR-030: Gateway Real Execution Implementation

**Status:** 🚧 Implementing **Date:** 2025-12-05

## Context

During deployment investigation, we discovered that the `GatewayHandler` in
`src/mcp/gateway-handler.ts` uses a **placeholder** for tool execution instead of actually calling
MCP tools.

### Current State

```typescript
// src/mcp/gateway-handler.ts:269-284
/**
 * Simulate tool execution (placeholder)
 */
private async simulateToolExecution(task: Task): Promise<unknown> {
  await new Promise((resolve) => setTimeout(resolve, 10));
  return {
    taskId: task.id,
    tool: task.tool,
    status: "completed",
    output: `Simulated execution of ${task.tool}`,  // <-- Never actually executes
  };
}
```

### The Gap

1. **DAG Suggestion works**: `DAGSuggester` correctly identifies tools and builds execution plans
2. **Tools are indexed**: All MCP tools (playwright, filesystem, memory, etc.) are properly indexed
   in the graph
3. **Confidence thresholds work**: The system correctly decides between `explicit_required`,
   `suggestion`, and `speculative_execution` modes
4. **Execution is simulated**: Even in `speculative_execution` mode, tools are never actually called

### Why This Matters

- The `ControlledDAGExecutor` has access to `MCPClient` instances and CAN execute real tools
- But `GatewayHandler.simulateToolExecution()` is disconnected from the actual MCP clients
- Users expect `speculative_execution` mode to actually execute, not simulate

## Decision

Implement real tool execution in `GatewayHandler` while **keeping simulation mode** for dry-run
scenarios:

### 1. Inject MCPClients into GatewayHandler

```typescript
constructor(
  private graphEngine: GraphRAGEngine,
  private dagSuggester: DAGSuggester,
  private mcpClients: Map<string, MCPClient>,  // Add this
  config?: Partial<GatewayConfig>,
)
```

### 2. Add execution mode enum

```typescript
type ExecutionMode = "real" | "dry_run";

interface GatewayConfig {
  // ... existing
  executionMode: ExecutionMode; // default: "real"
}
```

### 3. Add real execution method (keep simulation)

```typescript
private async executeTask(task: Task): Promise<unknown> {
  if (this.config.executionMode === "dry_run") {
    return this.simulateToolExecution(task);  // Keep existing simulation
  }
  return this.executeToolReal(task);
}

private async executeToolReal(task: Task): Promise<unknown> {
  const [serverName, toolName] = task.tool.split(':');
  const client = this.mcpClients.get(serverName);
  if (!client) throw new Error(`MCP server ${serverName} not connected`);

  // Tracing already handled by wrapMCPClient() from Story 7.1
  return await client.callTool(toolName, task.arguments ?? {});
}
```

### 4. Expose dry_run via MCP tool parameter

```typescript
// In execute_dag tool schema
{
  "dry_run": {
    "type": "boolean",
    "description": "If true, simulate execution without side effects",
    "default": false
  }
}
```

## Why Keep Simulation Mode?

The `dry_run` / simulation mode provides value for:

1. **Dry-run preview** - Agent sees what WOULD be executed before committing
2. **Planning validation** - Validate DAG structure without side effects
3. **Cost/time estimation** - Estimate execution cost before running
4. **CI/Testing** - Run tests without touching real resources
5. **Agent reasoning** - Future: agent can "mentally simulate" before acting

### Future Extension: Agent Simulation Loop

```
Agent thinks: "I want to deploy to production"
  → execute_dag(intent, dry_run=true)  // What would happen?
  → Reviews simulated output
  → execute_dag(intent, dry_run=false) // Actually do it
```

This enables a "think before acting" pattern where the agent can explore consequences safely.

## Consequences

### Positive

- DAG workflows will actually execute tools (when `dry_run=false`)
- Speculative execution becomes meaningful
- Full end-to-end workflow automation
- Dry-run mode preserved for safe exploration

### Negative

- Increased risk with real execution (mitigated by HIL checkpoints)
- Must handle MCP client connection failures gracefully

### Risks

- Destructive operations need HIL checkpoints (existing mechanism)
- Rate limiting for expensive operations (use existing RateLimiter)
- Timeout handling (use existing sandbox timeout patterns)

## Implementation Notes

**Estimated effort:** ~20 LOC

**Files to modify:**

- `src/mcp/gateway-handler.ts` - Add MCPClient injection, `executeToolReal()`, `executionMode`
  config
- `src/mcp/gateway-server.ts` - Pass MCPClients to GatewayHandler constructor

**Integration with Story 7.1b (ADR-032):**

- Tool calls via `mcpClient.callTool()` are automatically traced by the Worker RPC Bridge (Story
  7.1b)
- No additional tracing code needed in `executeToolReal()`
- Note: Original Story 7.1 `wrapMCPClient()` approach superseded by ADR-032

**Related files:**

- `src/dag/controlled-executor.ts` - Reference implementation for real execution
- `src/sandbox/worker-bridge.ts` - Native tracing in RPC bridge (Story 7.1b / ADR-032)

## Future Enhancement

See **ADR-031: Intelligent Dry-Run with MCP Mocking** for the evolution of dry_run mode:

- Type-checking against inferred schemas (Story 7.2b)
- Cached real responses from `capability_cache` (Story 7.5a)
- Full pre-flight validation before execution

## References

- ADR-017: Gateway Exposure Modes
- ADR-031: Intelligent Dry-Run with MCP Mocking (future enhancement)
- ADR-032: Sandbox Worker RPC Bridge (tracing integration)
- Story 7.1b: Worker RPC Bridge - Native Tracing
- `src/mcp/gateway-handler.ts:269-284` - Current placeholder
- `src/dag/controlled-executor.ts:129-136` - MCPClient usage pattern
