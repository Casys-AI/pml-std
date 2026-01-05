# Story 11.4: Definition vs Invocation Views

Status: ready-for-dev

## Story

As a user, I want the Invocation view to show real execution traces from database, So that I can see
actual past executions with their real timestamps and results.

## Context & Background

**Epic 11: Learning from Execution Traces** implements a learning system that stores execution
traces. This story connects the existing Definition/Invocation toggle to real execution data.

### What Already Exists (DO NOT RECREATE)

1. **CodePanel** - `CodePanel.tsx` displays capability code when selected
2. **Hypergraph endpoint** - `/api/graph/hypergraph` returns capabilities
3. **Capability selection** - Click capability → CodePanel opens

### What's Missing (THIS STORY)

The CodePanel only shows the code snippet. We need to add a toggle to also show execution traces.

**Current flow:**

```
Click capability → CodePanel shows code snippet only
```

**Target flow:**

````
Click capability → CodePanel shows split view:
  ┌─────────────────────────┬─────────────────────────────┐
  │ Definition              │ Trace: [▼ 2min ago ✅ 234ms]│
  │                         ├─────────────────────────────┤
  │ ```typescript           │                             │
  │ async function analyze()│ ├─ read_file    45ms  ✅    │
  │   const data = await... │ ├─ grep_code    89ms  ✅    │
  │   return process(data); │ └─ write_file  100ms  ✅    │
  │ ```                     │                             │
  │                         │ Total: 234ms                │
  │ Tools: read_file, grep  │ Priority: 0.45              │
  │ Success: 87% (26/30)    │                             │
  └─────────────────────────┴─────────────────────────────┘
````

**Architecture Decision:**

- Split layout in CodePanel: Definition (left) + Invocation (right)
- Graph always shows structure (Definition mode)
- Trace selector dropdown to switch between past executions
- Shows ONE trace at a time (not a list)
- Traces included in hypergraph response via `?include_traces=true`

| CodePanel Side         | Content                            | Source                             |
| ---------------------- | ---------------------------------- | ---------------------------------- |
| **Left (Definition)**  | Code snippet, tools list, stats    | `capability.code_snippet`          |
| **Right (Invocation)** | Single trace detail, task timeline | `capability.traces[selectedIndex]` |

**Graph Edge Types:**

| Mode           | Edge Type   | Status  | Meaning                                              |
| -------------- | ----------- | ------- | ---------------------------------------------------- |
| **Definition** | `contains`  | ✅ Done | compound nodes (bento boxes)                         |
| **Definition** | `provides`  | ❌ TODO | any → any (A.output feeds B.input, data flow)        |
| **Definition** | `dependsOn` | ❌ TODO | any → any (inferred from provides: B dependsOn A)    |
| **Invocation** | `sequence`  | ⚠️ Fix  | task → task (currently linear, needs fan-in/fan-out) |

**Existing Code (CytoscapeGraph.tsx:954-986):**

- Toggle `nodeMode` already switches between definition/invocation ✅
- Invocation mode generates sequence edges BUT **linearly** (A→B→C→D)
- Need to fix: use `layerIndex` for fan-in/fan-out edges

**Fan-in/Fan-out for Parallel Tasks:**

Tasks with the same `layerIndex` execute in parallel → need fan-out/fan-in edges:

```
Layer 0: [read_config]        → single node
Layer 1: [parse_a, parse_b]   → fan-out (parallel, same layer)
Layer 2: [merge_results]      → fan-in

     read_config (layer 0)
          │
    ┌─────┴─────┐   ← fan-out
    ▼           ▼
 parse_a    parse_b  (layer 1, parallel)
    └─────┬─────┘   ← fan-in
          ▼
    merge_results (layer 2)
```

**Schema Extension - Add `layerIndex` to `TraceTaskResult`:**

```typescript
// src/capabilities/types.ts
interface TraceTaskResult {
  taskId: string;
  tool: string;
  args: Record<string, JsonValue>;
  result: JsonValue;
  success: boolean;
  durationMs: number;
  layerIndex?: number; // NEW: DAG layer for fan-in/fan-out detection
}
```

This enables edge reconstruction from traces:

- Same `layerIndex` → parallel execution → fan-out from previous layer, fan-in to next layer
- Sequential `layerIndex` → simple sequence edge

**Why this matters:**

- Definition: "What CAN this capability do?" → Static structure
- Invocation: "What DID this capability do?" → Real past executions with actual timestamps,
  durations, success/failure

**Previous Stories Intelligence:**

- **Story 11.2 (done)** - `ExecutionTraceStore.getTraces(capabilityId)` returns real traces
- **Story 11.3 (done)** - `priority` field for PER learning
- **Epic 8 (done)** - Toggle UI already exists in `GraphLegendPanel.tsx`

**Key Insight:** CodePanel becomes a split view: Definition (left) + Invocation (right) with trace
selector dropdown. Both views visible simultaneously for better UX.

## Acceptance Criteria

1. **AC1:** Split layout in CodePanel:
   - Left side: Definition view (code snippet, tools, stats)
   - Right side: Invocation view (single trace detail)
   - Both visible simultaneously when capability selected

2. **AC2:** **Left side - Definition** (existing, minor layout changes):
   - Shows code snippet with syntax highlighting
   - Shows tools list, success rate, usage count
   - Takes ~50% width

3. **AC3:** **Right side - Invocation** with trace selector:
   - Dropdown selector showing available traces: `[▼ 2min ago ✅ 234ms]`
   - Dropdown options: relative time, success icon, duration
   - Default: most recent trace selected

4. **AC4:** Trace detail view (right side, below selector):
   - Shows task timeline for selected trace
   - Each `task_result` as a row: tool name, duration, success icon
   - Failed tasks highlighted in red with error message
   - Clickable tool → highlights in graph
   - Shows total duration and priority score

5. **AC5:** Extend `GET /api/graph/hypergraph` endpoint:
   - New query param: `?include_traces=true`
   - Each capability includes `traces: ApiExecutionTrace[]`
   - Uses `ExecutionTraceStore.getTraces()` from Story 11.2
   - Limit: 10 most recent traces per capability

6. **AC6:** Update `CytoscapeGraph.tsx` fetch:
   - Always include `?include_traces=true` (traces needed for CodePanel)
   - Pass traces to CodePanel via `capability.traces`

7. **AC7:** Tests: API endpoint returns traces
   - Test: hypergraph with `include_traces=true` includes traces
   - Test: traces ordered by `executed_at DESC`
   - Test: max 10 traces per capability

8. **AC8:** Tests: CodePanel Invocation mode
   - Test: Toggle switches between Definition and Invocation
   - Test: Trace list displays correctly
   - Test: Task results timeline renders

9. **AC9:** Performance: CodePanel switch <100ms

10. **AC10:** Schema extension - `layerIndex` in `TraceTaskResult`:
    - Add `layerIndex?: number` field to `TraceTaskResult` type
    - DAG executor populates `layerIndex` when saving traces
    - Enables fan-in/fan-out edge reconstruction for parallel tasks

11. **AC11:** Fix `execution-learning.ts` to learn parallel edges:
    - Use `layerIndex` to group tasks by layer
    - Create fan-out edges: layer N → all tasks in layer N+1
    - Create fan-in edges: all tasks in layer N → layer N+1
    - Replace linear sequence edge creation (A→B→C) with correct DAG structure

12. **AC12:** Definition mode edges in graph:
    - Add `provides` edges: any → any (A.output feeds B.input, data flow)
    - Add `dependsOn` edges: inferred from provides (if A provides B, then B dependsOn A)
    - Source: `tool_dependency` + `capability_dependency` tables

13. **AC13:** Invocation mode edges in graph (fix CytoscapeGraph.tsx:954-986):
    - Fix sequence edge generation to use `layerIndex`
    - Group invocations by layer, connect layer N → layer N+1
    - Visual fan-in/fan-out for parallel tasks

## Tasks / Subtasks

- [ ] **Task 0: Add `layerIndex` to TraceTaskResult + fix execution-learning** (AC: #10, #11)
  - [ ] 0.1 Add `layerIndex?: number` to `TraceTaskResult` in `src/capabilities/types.ts`
  - [ ] 0.2 Add `layerIndex?: number` to `TaskResult` in `src/dag/types.ts`
  - [ ] 0.3 Update DAG executor to include `layerIndex` in task results
  - [ ] 0.4 Update `workflow-execution-handler.ts` to pass layer info when building traces
  - [ ] 0.5 Fix `execution-learning.ts` Phase 3 to use `layerIndex` for fan-in/fan-out edges

- [ ] **Task 1: Extend hypergraph endpoint with traces** (AC: #5)
  - [ ] 1.1 Modify `src/mcp/routing/handlers/graph.ts` - add `include_traces` query param
  - [ ] 1.2 Modify `src/capabilities/data-service.ts` - add traces to `buildHypergraphData()`
  - [ ] 1.3 Use `ExecutionTraceStore.getTraces(capabilityId, 10)` for each capability
  - [ ] 1.4 Include traces in capability node: `traces: ApiExecutionTrace[]` (snake_case)

- [ ] **Task 2: Update CytoscapeGraph fetch** (AC: #6)
  - [ ] 2.1 Add `?include_traces=true` to fetch URL
  - [ ] 2.2 Map `capability.traces` (snake_case) to internal types (camelCase)
  - [ ] 2.3 Pass `traces` to CodePanel via `CapabilityData`

- [ ] **Task 3: Implement split layout in CodePanel** (AC: #1, #2)
  - [ ] 3.1 Change CodePanel to flex split layout (left 50%, right 50%)
  - [ ] 3.2 Left side: existing Definition view (code snippet, tools, stats)
  - [ ] 3.3 Right side: new Invocation view container

- [ ] **Task 4: Implement Invocation view with trace selector** (AC: #3, #4)
  - [ ] 4.1 Add state: `const [selectedTraceIndex, setSelectedTraceIndex] = useState(0)`
  - [ ] 4.2 Create TraceSelector dropdown (relative time, success icon, duration)
  - [ ] 4.3 Create TraceDetail component (task timeline for selected trace)
  - [ ] 4.4 Add task result row: tool name, duration, success/error
  - [ ] 4.5 Clickable tool → call `onToolClick(toolId)`

- [ ] **Task 5: Add Definition mode edges** (AC: #12)
  - [ ] 5.1 Fetch `provides` edges from `tool_dependency` + `capability_dependency`
  - [ ] 5.2 Add `provides` edges in graph (any → any, data flow)
  - [ ] 5.3 Infer `dependsOn` from provides (reverse direction)
  - [ ] 5.4 Add `dependsOn` edges in graph
  - [ ] 5.5 Style edges (provides: dashed, dependsOn: solid arrow)

- [ ] **Task 6: Fix Invocation mode edges** (AC: #13)
  - [ ] 6.1 Update `generatedInvocations` to include `layerIndex` from trace
  - [ ] 6.2 Replace linear edge generation (lines 970-984) with layer-based
  - [ ] 6.3 Group invocations by `layerIndex`, connect layer N → layer N+1
  - [ ] 6.4 Test fan-in/fan-out visual rendering

- [ ] **Task 7: Write tests** (AC: #7, #8, #12, #13)
  - [ ] 7.1 Test: hypergraph with `include_traces=true` includes traces
  - [ ] 7.2 Test: CodePanel split layout renders both sides
  - [ ] 7.3 Test: TraceSelector dropdown changes selected trace
  - [ ] 7.4 Test: Definition mode shows provides/dependsOn edges
  - [ ] 7.5 Test: Invocation mode shows fan-in/fan-out edges

- [ ] **Task 8: Validation**
  - [ ] 8.1 `deno check` passes for all modified files
  - [ ] 8.2 Run existing tests: no regressions
  - [ ] 8.3 Visual QA: Definition mode edges render correctly
  - [ ] 8.4 Visual QA: Invocation mode fan-in/fan-out renders correctly
  - [ ] 8.5 Visual QA: CodePanel split view works

## Dev Notes

### Critical Implementation Details

**0. Add `layerIndex` to TraceTaskResult (types.ts + executor)**

```typescript
// src/capabilities/types.ts - Add layerIndex field
export interface TraceTaskResult {
  taskId: string;
  tool: string;
  args: Record<string, JsonValue>;
  result: JsonValue;
  success: boolean;
  durationMs: number;
  layerIndex?: number; // NEW: DAG layer for fan-in/fan-out
}
```

```typescript
// src/dag/executor.ts - Pass layerIdx when building task results
// In the layer execution loop (around line 142):
for (let i = 0; i < layer.length; i++) {
  const task = layer[i];
  const result = layerResults[i];

  if (result.status === "fulfilled") {
    results.set(task.id, {
      taskId: task.id,
      status: "success",
      output: result.value.output,
      executionTimeMs: result.value.executionTimeMs,
      layerIndex: layerIdx, // NEW: track which layer this task belongs to
    });
  }
}
```

```typescript
// src/mcp/handlers/workflow-execution-handler.ts - Include layerIndex in trace
const taskResults: TraceTaskResult[] = dagResult.results.map((r) => ({
  taskId: r.taskId,
  tool: taskToolMap.get(r.taskId) ?? "unknown",
  args: taskArgsMap.get(r.taskId) ?? {},
  result: r.output as JsonValue,
  success: r.status === "success",
  durationMs: r.executionTimeMs ?? 0,
  layerIndex: r.layerIndex, // NEW: propagate layer info to trace
}));
```

```typescript
// src/graphrag/dag/execution-learning.ts - Fix Phase 3 for parallel edges
// BEFORE (linear, wrong):
for (let i = 0; i < children.length - 1; i++) {
  createEdge(children[i], children[i + 1], "sequence");
}

// AFTER (fan-in/fan-out, correct):
// Group children by layerIndex
const byLayer = new Map<number, string[]>();
for (const child of childrenWithLayer) {
  const layer = child.layerIndex ?? 0;
  if (!byLayer.has(layer)) byLayer.set(layer, []);
  byLayer.get(layer)!.push(child.nodeId);
}

// Create edges between consecutive layers (fan-out/fan-in)
const sortedLayers = [...byLayer.keys()].sort((a, b) => a - b);
for (let i = 0; i < sortedLayers.length - 1; i++) {
  const currentLayer = byLayer.get(sortedLayers[i])!;
  const nextLayer = byLayer.get(sortedLayers[i + 1])!;

  // Fan-out: each task in current layer → all tasks in next layer
  for (const from of currentLayer) {
    for (const to of nextLayer) {
      await createOrUpdateEdge(graph, from, to, "sequence", eventEmitter);
    }
  }
}
```

**1. Extend hypergraph endpoint (graph.ts)**

```typescript
// In handleGraphHypergraph(), add include_traces param
const includeTraces = url.searchParams.get("include_traces") === "true";

// Pass to buildHypergraphData
const result = await ctx.capabilityDataService.buildHypergraphData({
  ...options,
  includeTraces,
});
```

**2. Extend data-service.ts**

```typescript
// In buildHypergraphData(), fetch traces for each capability
if (options.includeTraces) {
  for (const cap of capabilities) {
    const traces = await this.traceStore.getTraces(cap.id, 10);
    cap.traces = traces.map(traceToSnakeCase);
  }
}
```

**3. Update CytoscapeGraph fetch URL**

```typescript
// Always include traces (needed for CodePanel Invocation mode)
const response = await fetch(`${apiBase}/api/graph/hypergraph?include_traces=true`);
```

**4. API Response Structure (snake_case externe)**

```typescript
// Capability node in hypergraph response now includes traces
interface ApiCapabilityNode {
  id: string;
  type: "capability";
  label: string;
  code_snippet?: string;
  success_rate?: number;
  usage_count?: number;
  tools_used?: string[];
  // NEW: traces included when include_traces=true
  traces?: ApiExecutionTrace[];
}

interface ApiExecutionTrace {
  id: string;
  capability_id?: string;
  executed_at: string; // ISO date string
  success: boolean;
  duration_ms: number;
  error_message?: string;
  task_results: ApiTraceTaskResult[];
  priority: number;
}

interface ApiTraceTaskResult {
  task_id: string;
  tool: string;
  args: Record<string, JsonValue>;
  result: JsonValue;
  success: boolean;
  duration_ms: number;
  layer_index?: number; // NEW: for fan-in/fan-out edge reconstruction
}
```

**5. Add traces to CapabilityData type**

```typescript
// In CytoscapeGraph.tsx, extend CapabilityData interface
export interface CapabilityData {
  id: string;
  name: string;
  // ... existing fields
  traces?: ExecutionTrace[]; // NEW
}

// Map traces when transforming API response
const traces = d.traces?.map((t) => ({
  id: t.id,
  executedAt: new Date(t.executed_at),
  success: t.success,
  durationMs: t.duration_ms,
  errorMessage: t.error_message,
  taskResults: t.task_results.map((r) => ({
    taskId: r.task_id,
    tool: r.tool,
    success: r.success,
    durationMs: r.duration_ms,
    layerIndex: r.layer_index, // NEW: for parallel task detection
  })),
  priority: t.priority,
}));
```

**6. CodePanel split layout implementation**

```typescript
// In CodePanel.tsx - Split layout with Definition (left) and Invocation (right)
export function CodePanel({ capability, onToolClick }: CodePanelProps) {
  const [selectedTraceIndex, setSelectedTraceIndex] = useState(0);
  const selectedTrace = capability.traces?.[selectedTraceIndex];

  return (
    <div class="flex h-full">
      {/* Left side: Definition */}
      <div class="w-1/2 border-r border-border overflow-auto p-4">
        <h3 class="text-sm font-semibold text-dim mb-2">Definition</h3>
        <DefinitionView capability={capability} />
      </div>

      {/* Right side: Invocation */}
      <div class="w-1/2 overflow-auto p-4">
        <div class="flex items-center justify-between mb-2">
          <h3 class="text-sm font-semibold text-dim">Invocation</h3>
          <TraceSelector
            traces={capability.traces}
            selectedIndex={selectedTraceIndex}
            onSelect={setSelectedTraceIndex}
          />
        </div>
        {selectedTrace
          ? <TraceDetail trace={selectedTrace} onToolClick={onToolClick} />
          : <div class="text-dim text-sm">No executions yet</div>}
      </div>
    </div>
  );
}
```

**7. TraceSelector dropdown component**

```typescript
function TraceSelector({ traces, selectedIndex, onSelect }: {
  traces?: ExecutionTrace[];
  selectedIndex: number;
  onSelect: (index: number) => void;
}) {
  if (!traces?.length) return null;

  return (
    <select
      class="bg-surface border border-border rounded px-2 py-1 text-sm"
      value={selectedIndex}
      onChange={(e) => onSelect(Number(e.currentTarget.value))}
    >
      {traces.map((trace, i) => (
        <option key={trace.id} value={i}>
          {formatRelativeTime(trace.executedAt)} {trace.success ? "✅" : "❌"} {trace.durationMs}ms
        </option>
      ))}
    </select>
  );
}
```

**8. TraceDetail component (task timeline)**

```typescript
function TraceDetail({ trace, onToolClick }: {
  trace: ExecutionTrace;
  onToolClick?: (toolId: string) => void;
}) {
  return (
    <div class="space-y-1">
      {/* Task timeline */}
      <div class="border-l-2 border-border pl-3 space-y-1">
        {trace.taskResults.map((task, i) => (
          <div
            key={i}
            class={`flex items-center gap-2 py-1 px-2 rounded cursor-pointer
              hover:bg-surface ${!task.success ? "bg-red-500/10" : ""}`}
            onClick={() => onToolClick?.(task.tool)}
          >
            <span class="font-mono text-sm">{task.tool}</span>
            <span class="text-dim text-xs">{task.durationMs}ms</span>
            <span>{task.success ? "✅" : "❌"}</span>
          </div>
        ))}
      </div>

      {/* Summary */}
      <div class="flex gap-4 mt-3 text-sm text-dim">
        <span>Total: {trace.durationMs}ms</span>
        <span>Priority: {trace.priority.toFixed(2)}</span>
      </div>

      {/* Error message if failed */}
      {trace.errorMessage && (
        <div class="mt-2 p-2 bg-red-500/10 border border-red-500/30 rounded text-sm text-red-400">
          {trace.errorMessage}
        </div>
      )}
    </div>
  );
}
```

### Architecture Compliance

- **Deno 2.x** - Runtime (not Node.js)
- **TypeScript strict mode** - All types explicit
- **snake_case** - API responses (external convention)
- **camelCase** - Internal TypeScript types and variables
- **Mapping required** - Transform API responses to internal types in frontend
- **Preact** - For UI components (not React)
- **Fresh 2.0** - Islands architecture for interactive components
- **Cytoscape.js** - Existing visualization library (NOT D3 for this feature)
- **TailwindCSS v4** - Styling

### Files to Create

| File                                           | Purpose                             | LOC |
| ---------------------------------------------- | ----------------------------------- | --- |
| `tests/unit/mcp/handlers/graph_traces_test.ts` | Unit tests for include_traces param | ~80 |

### Files to Modify

| File                                             | Changes                                              | LOC  |
| ------------------------------------------------ | ---------------------------------------------------- | ---- |
| `src/capabilities/types.ts`                      | Add `layerIndex?: number` to `TraceTaskResult`       | ~5   |
| `src/dag/types.ts`                               | Add `layerIndex?: number` to `TaskResult`            | ~5   |
| `src/dag/executor.ts`                            | Populate `layerIndex` in task results                | ~10  |
| `src/mcp/handlers/workflow-execution-handler.ts` | Propagate `layerIndex` to trace                      | ~5   |
| `src/graphrag/dag/execution-learning.ts`         | Fix Phase 3: fan-in/fan-out edges using `layerIndex` | ~30  |
| `src/mcp/routing/handlers/graph.ts`              | Add `include_traces` query param to hypergraph       | ~20  |
| `src/capabilities/data-service.ts`               | Fetch traces in `buildHypergraphData()`              | ~30  |
| `src/web/islands/CytoscapeGraph.tsx`             | Add `?include_traces=true`, pass traces to CodePanel | ~30  |
| `src/web/islands/CodePanel.tsx`                  | Split layout + TraceSelector + TraceDetail           | ~100 |

### References

- [Epic 11: Learning from Traces](../epics/epic-11-learning-from-traces.md)
- [Story 11.2: Execution Trace Table](./11-2-execution-trace-table.md) - DONE (provides
  ExecutionTraceStore)
- [Story 11.3: TD Error + PER Priority](./11-3-td-error-per-priority.md) - DONE (priority field)
- [Source: src/mcp/routing/handlers/graph.ts](../../src/mcp/routing/handlers/graph.ts) - Hypergraph
  endpoint to extend
- [Source: src/capabilities/data-service.ts](../../src/capabilities/data-service.ts) -
  buildHypergraphData() to extend
- [Source: src/capabilities/execution-trace-store.ts](../../src/capabilities/execution-trace-store.ts) -
  Trace store
- [Source: src/web/islands/CytoscapeGraph.tsx](../../src/web/islands/CytoscapeGraph.tsx) - Graph
  component to modify
- [Source: src/web/components/ui/molecules/GraphLegendPanel.tsx](../../src/web/components/ui/molecules/GraphLegendPanel.tsx) -
  Toggle UI exists
- [Project Context](../project-context.md) - Architecture patterns

### Previous Story Intelligence (11.2, 11.3)

From Story 11.2 (Execution Trace Table):

- `ExecutionTraceStore.getTraces(capabilityId)` returns traces ordered by `executed_at DESC`
- `TraceTaskResult` includes `taskId`, `tool`, `args`, `result`, `success`, `durationMs`
- `execution_trace.task_results` is JSONB array

From Story 11.3 (TD Error + PER Priority):

- `priority` field (0.0-1.0) indicates learning value
- High priority traces = surprising executions
- Can filter traces by priority for focused analysis

**Existing Toggle UI (GraphLegendPanel.tsx:116-165):**

- `NodeMode` type: `"definition" | "invocation"`
- Toggle buttons already styled and functional
- **NOT USED** - We're using split layout in CodePanel instead

**Current Invocation Mode (CytoscapeGraph.tsx:831-966):**

- Generates fake nodes from `capability.toolsUsed`
- Does NOT fetch real traces from database
- **REPLACED BY** split layout in CodePanel with real traces

### Dependencies

```
Story 11.2 (execution_trace table) - DONE
       |
       v
Story 11.3 (TD Error + PER Priority) - DONE
       |
       v
Story 11.4 (Wire Invocation to Real Traces) - THIS STORY
```

**This story provides:**

- Extended hypergraph endpoint with `?include_traces=true` param
- Split layout CodePanel: Definition (left) + Invocation (right)
- TraceSelector dropdown to switch between past executions
- TraceDetail view with task timeline
- SSE-compatible: traces refresh automatically with graph data

### Estimation

**Effort:** 1 day (simplified scope since UI already exists)

**Breakdown:**

- Task 1 (API endpoint): 1h
- Task 2 (Wire CytoscapeGraph to API): 3h
- Task 3 (Trace selector UI): 2h
- Task 4 (Unit tests): 1h
- Task 5 (Validation): 30min

**Risk:**

- None significant - straightforward wiring of existing components

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List
