# Bug: Parallel Execution Not Properly Tracked

**Severity**: Medium **Component**: GraphRAG / graph-engine.ts, gateway-server.ts **Discovered**:
2025-12-16

## Summary

Two related issues with parallel execution tracking:

1. **DAG parallel tasks**: When a DAG has parallel tasks (no `dependsOn`), no edges are created
2. **execute_code Promise.all**: Parallel tool calls are traced as sequential, corrupting the
   invocation view

## Root Cause

### Issue 1: DAG Parallel Tasks

In `src/graphrag/graph-engine.ts:524-587`, the `updateFromExecution()` method only creates edges
based on the `dependsOn` array:

```typescript
for (const task of execution.dagStructure.tasks) {
  for (const depTaskId of task.dependsOn) { // <-- Empty for parallel tasks
    // ... create edge from depTask.tool → task.tool
  }
}
```

If tasks have empty `dependsOn` arrays (parallel execution), the inner loop never executes, so no
edges are learned.

### Issue 2: execute_code Promise.all

In `src/mcp/gateway-server.ts:1485-1490`, traced tools are always assumed sequential:

```typescript
const tracedDAG = {
  tasks: toolsCalled.map((tool, index) => ({
    id: `traced_${index}`,
    tool,
    arguments: {},
    dependsOn: index > 0 ? [`traced_${index - 1}`] : [], // <-- Always sequential!
  })),
};
```

Even when tools are called with `Promise.all()`, the tracing just records them in completion order
as a flat array, losing the parallel structure. The invocation view then shows a false sequential
flow.

## Reproduction

### Issue 1: DAG Parallel Tasks

```typescript
// DAG with parallel tasks - NO edges created
await pml_execute_dag({
  intent: "get project info",
  workflow: {
    tasks: [
      { id: "t1", tool: "filesystem:read_text_file", arguments: {...}, dependsOn: [] },
      { id: "t2", tool: "filesystem:list_directory", arguments: {...}, dependsOn: [] },
      { id: "t3", tool: "filesystem:get_file_info", arguments: {...}, dependsOn: [] }
    ]
  }
});

// Check edges - no new edges from this DAG
curl http://localhost:3003/api/graph/snapshot | jq '.edges | length'
```

### Issue 2: execute_code Promise.all

```typescript
// Parallel execution via Promise.all
await pml_execute_code({
  intent: "parallel json operations",
  code: `
    const [a, b] = await Promise.all([
      mcp.primitives.json_parse({ json: '{"x":1}' }),
      mcp.primitives.json_stringify({ value: {y:2} })
    ]);
    return { a, b };
  `,
});

// Edge created as json_parse → json_stringify (sequential)
// But they ran in PARALLEL - invocation view shows false flow
```

**Actual behavior:**

```
Code:       Promise.all([A, B, C])  // Parallel
Traced:     [A, B, C]               // Flat array, order = completion
Stored:     A → B → C               // Sequential edges
View:       A → B → C               // False sequential flow
```

## Expected Behavior

1. **DAG parallel tasks**: Tools used together should create "co-occurrence" edges
2. **execute_code**: Parallel calls should be detected and stored with `edge_type: "parallel"`

This would enable:

- Accurate invocation view showing real execution flow
- Learning tool affinities from parallel usage patterns
- Better DAG suggestions based on intent similarity
- Richer graph for semantic search

## Proposed Fix

### Fix for Issue 2: Track Timestamps in Worker

The worker should track execution timing to detect parallelism:

```typescript
// In worker-bridge.ts, track tool calls with timing
interface TracedToolCall {
  tool: string;
  startTime: number;
  endTime: number;
}

// Detect overlapping time windows = parallel execution
function detectParallelGroups(calls: TracedToolCall[]): TracedToolCall[][] {
  // Group calls with overlapping time ranges
  // Returns array of parallel groups
}

// In gateway-server.ts, build DAG from timing
const tracedDAG = buildDAGFromTiming(toolsWithTiming);
// Tools with overlapping times → dependsOn: [] (parallel)
// Tools after others complete → dependsOn: [previous] (sequential)
```

### Fix for Issue 1: Co-occurrence Edges

Add logic to create edges between all tools in a successful DAG:

```typescript
// After dependency-based edges, add co-occurrence edges
const toolsInDAG = execution.dagStructure.tasks.map((t) => t.tool);
for (let i = 0; i < toolsInDAG.length; i++) {
  for (let j = i + 1; j < toolsInDAG.length; j++) {
    const toolA = toolsInDAG[i];
    const toolB = toolsInDAG[j];
    if (toolA !== toolB) {
      await this.addEdge(toolA, toolB, {
        weight: 0.3, // Lower than dependency edges
        edge_type: "co-occurrence",
        edge_source: "inferred",
      });
    }
  }
}
```

## Affected Files

- `src/sandbox/worker-bridge.ts` - Add timing to tool call tracing
- `src/mcp/gateway-server.ts:1485-1490` - Build DAG from timing, not array order
- `src/graphrag/graph-engine.ts` - Add co-occurrence edges
- `src/graphrag/types.ts` - Add "co-occurrence" and "parallel" edge types

## Related

- ADR-041: Edge Types and Sources
- Story 3.5: GraphRAG Learning Loop
