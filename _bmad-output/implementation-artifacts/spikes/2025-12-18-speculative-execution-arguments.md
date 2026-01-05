# Spike: Speculative Execution with Arguments

**Date**: 2025-12-18 **Status**: Complete **Related Stories**: 10.2, 10.3, 3.5-1, 3.5-2

## Context

During review of speculative execution mode, we discovered that arguments weren't being considered.
This spike documents our findings and the path forward.

## Unified Model: Capabilities, Workflows, and Speculation

**Key insight**: Workflows ARE capabilities. A capability can contain other capabilities (nested).
The execution model is unified:

```
┌─────────────────────────────────────────────────────────────┐
│  UNIFIED EXECUTION MODEL                                     │
│                                                              │
│  Capability = Workflow = DAG of tools/capabilities           │
│                                                              │
│  Standard execution (high confidence, args provided):        │
│    → Execute entire DAG at once                             │
│    → THIS IS ALREADY "SPECULATION" (trusting the plan)      │
│                                                              │
│  per_layer execution (requires validation):                  │
│    → Checkpoints between layers                             │
│    → Human/AI validation at each pause                      │
│    → CAN speculate during pause if next layer is safe       │
│                                                              │
│  Post-workflow prefetch (NEW):                               │
│    → Workflow complete, full context available              │
│    → Preload next likely capabilities/tools                 │
│    → True speculative optimization                          │
└─────────────────────────────────────────────────────────────┘
```

| Mode                       | What Happens         | Speculative?                 |
| -------------------------- | -------------------- | ---------------------------- |
| Standard (high confidence) | Execute full DAG     | ✅ Implicit                  |
| per_layer                  | Pause between layers | ✅ **If next layer is safe** |
| **Post-workflow prefetch** | Preload next caps    | ✅ Explicit                  |

**Important**: per_layer and speculation are **orthogonal**:

- per_layer = WHEN to pause (checkpoints)
- speculation = CAN we pre-execute (security-based)

During a checkpoint pause, we CAN speculate the next layer IF it's safe:

```
Layer 1: read_file (safe)
     ↓
[Speculate layer 2 while paused] ← YES if safe!
     ↓
Checkpoint pause (per_layer)
     ↓
Agent: "continue"
     ↓
Layer 2: parse_json → Cache HIT if speculated!
```

| Next tool              | Can speculate during pause? |
| ---------------------- | --------------------------- |
| `read_file`, `search`  | ✅ Yes (read-only)          |
| `parse_json`, `format` | ✅ Yes (pure transform)     |
| `github:push`          | ❌ No (side effects)        |
| `write_file`           | ❌ No (modifies FS)         |

**Conclusion**: Speculation can happen in ALL modes. The only constraint is security
(`canSpeculate()`). Post-workflow prefetch extends this to AFTER workflow completion.

## Key Clarification: Speculation vs Capability Creation

**Important distinction**: Speculative execution and capability creation are **separate concerns**.

```
┌─────────────────────────────────────────────────────────────────┐
│  SPECULATION = Optimization WITHIN a workflow                   │
│                                                                 │
│  Intent → Code → Execute A → [Speculate B] → Execute B → Done  │
│                                    ↓                            │
│                         Pre-execute B while                     │
│                         A is still running                      │
│                                    ↓                            │
│                         Cache hit if correct                    │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  CAPABILITY CREATION = Already handled by saveCapability()      │
│                                                                 │
│  Workflow execution complete                                    │
│           ↓                                                     │
│  saveCapability(code, intent, toolsUsed)                       │
│           ↓                                                     │
│  Stored in workflow_pattern (Eager Learning - ADR-028)         │
│           ↓                                                     │
│  Next similar intent → capability matched & reused             │
└─────────────────────────────────────────────────────────────────┘
```

**Why this matters**:

- We do NOT need a separate "pattern detection → capability promotion" mechanism
- The workflow itself IS the capability (created after successful execution)
- Speculation optimizes execution speed, not capability discovery
- The real question is: **how to pre-execute the next node with correct arguments**

## Current State

### What Works

- `predictNextNodes()` predicts next tools based on:
  - Community membership (graph)
  - Co-occurrence (historical patterns)
  - Capability matching
- `SpeculativeExecutor` runs predictions in sandboxes
- Results are cached for instant retrieval on cache hit

### What's Missing

- **Arguments are not populated** in `PredictedNode`
- **`generateSpeculationCode()` is a placeholder** - returns preparation metadata, not real
  execution
- **`CompletedTask` has no `result` field** - can't chain outputs to inputs

## Key Findings

### 1. PredictedNode Structure

```typescript
interface PredictedNode {
  toolId: string;
  confidence: number;
  reasoning: string;
  source: "community" | "co-occurrence" | "capability" | "hint" | "learned";
  capabilityId?: string; // Set when source === "capability"
  arguments?: Record<string, unknown>; // Added, but never populated
}
```

### 2. Placeholder in generateSpeculationCode

Location: `src/speculation/speculative-executor.ts:245-266`

```typescript
private generateSpeculationCode(
  prediction: PredictedNode,
  _context: Record<string, unknown>,  // IGNORED
): string {
  // Just returns preparation metadata, not real tool execution
  return `
    const preparation = {
      toolId: "${prediction.toolId}",
      prepared: true,
      timestamp: Date.now(),
    };
    return preparation;
  `;
}
```

### 3. WorkflowPredictionState Has Context

```typescript
interface WorkflowPredictionState {
  workflowId: string;
  currentLayer: number;
  completedTasks: CompletedTask[];
  context?: Record<string, unknown>; // Could hold task results
}
```

But `CompletedTask` doesn't include results:

```typescript
interface CompletedTask {
  taskId: string;
  tool: string;
  status: "success" | "error" | "failed_safe";
  executionTimeMs?: number;
  // NO result field!
}
```

### 4. Capability Predictions

When `source === "capability"`:

- We have `capabilityId` to load the capability
- Capability has `dag_structure.static_structure` (Story 10.1)
- With Story 10.2: nodes will have `.arguments`
- Currently `createCapabilityTask()` returns `arguments: {}` (hardcoded empty)

## Data Flow for Real Speculative Execution

```
┌─────────────────────────────────────────────────────────────────┐
│  1. Story 10.2: Static Argument Extraction                      │
│     Parse AST → Extract arguments per tool call                 │
│     Store in: dag_structure.static_structure.nodes[].arguments  │
│                                                                 │
│     { path: { type: "literal", value: "config.json" } }        │
│     { input: { type: "reference", expression: "task0.result" } }│
│     { filePath: { type: "parameter", parameterName: "path" } }  │
├─────────────────────────────────────────────────────────────────┤
│  2. Story 10.3: ProvidesEdge (already done)                     │
│     Maps tool outputs to inputs via fieldMapping                │
│     { from: "read_file", to: "parse_json", field: "content" }  │
├─────────────────────────────────────────────────────────────────┤
│  3. At Prediction Time (predictNextNodes)                       │
│     - Load static_structure for predicted tool/capability       │
│     - Resolve argument values:                                  │
│       • literal → use value directly                           │
│       • reference → lookup in context (previous results)       │
│       • parameter → skip (user must provide)                   │
│     - Populate PredictedNode.arguments                         │
├─────────────────────────────────────────────────────────────────┤
│  4. In generateSpeculationCode (to implement)                   │
│     - Use prediction.arguments                                  │
│     - Generate real MCP tool call code                         │
│     - Execute speculatively in sandbox                         │
└─────────────────────────────────────────────────────────────────┘
```

## Open Questions

### Q1: How to populate context with task results?

Options:

- A) Extend `CompletedTask` with `result?: unknown`
- B) Use `WorkflowPredictionState.context` (already exists)
- C) Separate result store keyed by taskId

**Recommendation**: Option B - context already exists, just need to populate it.

### Q2: What if a reference points to a task not yet executed?

Scenarios:

- Speculation for node N+2 when only N is done (N+1 not yet executed)
- Reference to parallel branch not yet complete

**Options**:

- Skip speculation if any reference unresolved
- Speculate only for nodes with all refs resolvable
- Use placeholder/mock values (risky)

**Recommendation**: Skip speculation if references unresolved.

### Q3: How to generate real MCP tool calls?

Current placeholder doesn't actually call tools. Need:

- Tool ID → MCP server + method mapping
- Arguments → properly formatted call
- Result capture → for chaining

**Answer**: `createToolExecutor(mcpClients)` already exists in
`workflow-execution-handler.ts:112-122`:

```typescript
function createToolExecutor(mcpClients: Map<string, MCPClientBase>) {
  return async (tool: string, args: Record<string, unknown>): Promise<unknown> => {
    const [serverId, ...toolNameParts] = tool.split(":");
    const toolName = toolNameParts.join(":");
    const client = mcpClients.get(serverId);
    if (!client) throw new Error(`Unknown MCP server: ${serverId}`);
    return await client.callTool(toolName, args);
  };
}
```

For speculation, we need to:

1. Pass `mcpClients` to `SpeculativeExecutor` (or the tool executor function)
2. Use it in `generateSpeculationCode` to make real calls
3. Capture results for validation on cache hit

### Q4: Capability vs Tool prediction differences?

| Aspect           | Tool                       | Capability           |
| ---------------- | -------------------------- | -------------------- |
| Arguments source | Need to infer from context | Has static_structure |
| Execution        | Single MCP call            | Multi-step code      |
| Result           | Direct tool result         | Capability output    |

### Q5: How to handle parameter-type arguments?

Parameters come from user intent, not previous tasks. Options:

- Don't speculate if parameters required
- Extract from original workflow intent (NLP)
- Only speculate for chains with no parameters

**Recommendation**: For next-node speculation, chaining should suffice (no NLP needed).

## Security: What Can Be Speculated?

### Current State: Safe (No Real Execution)

Currently, `generateSpeculationCode()` returns a **placeholder** that does NOT execute real tools:

```typescript
// Just returns metadata, no actual tool call
return `
  const preparation = {
    toolId: "${prediction.toolId}",
    prepared: true,
    timestamp: Date.now(),
  };
  return preparation;
`;
```

The sandbox (`DenoSandboxExecutor`) has no MCP clients, no network access - it's completely
isolated.

### Future Requirement: Permission-Based Speculation Guard

When implementing real speculative execution with `createToolExecutor()`, we MUST add guards:

```typescript
function canSpeculate(toolId: string): boolean {
  const permConfig = getToolPermissionConfig(toolId);

  // Same criteria as requiresValidation() - if it needs validation, NO speculation
  if (permConfig?.scope !== "minimal") return false;
  if (permConfig?.approvalMode === "hil") return false;
  if (permConfig?.ffi || permConfig?.run) return false;

  // Only speculate on safe, read-only tools
  return true;
}
```

| Tool Category                     | Can Speculate? | Reason                     |
| --------------------------------- | -------------- | -------------------------- |
| `read_file`, `list_dir`, `search` | ✅ Yes         | Read-only, no side effects |
| `github:push`, `create_issue`     | ❌ **NO**      | Modifies external state    |
| `write_file`, `delete_file`       | ❌ **NO**      | Modifies filesystem        |
| `http_request` (POST/PUT/DELETE)  | ❌ **NO**      | External side effects      |
| `http_request` (GET)              | ⚠️ Maybe       | Read-only but network cost |
| `code_execution` (elevated)       | ❌ **NO**      | Security risk              |

**Rule**: If `requiresValidation()` returns true → NO speculation allowed.

### Standard Execution Mode: Implicit Speculation

In `executeStandardWorkflow()` (no per_layer_validation):

- DAG runs to completion without pauses
- This IS already "speculative" in the sense that we trust the entire plan
- No explicit next-node prediction needed - the DAG is the prediction

**Explicit speculation** (predicting and pre-executing) makes sense during:

1. Intent-based suggestions (before DAG exists)
2. per_layer mode (during checkpoint pauses)
3. Post-workflow prefetch (after workflow completion)

## Implementation Path

### Phase 1: Story 10.2 (Current Sprint)

- Extract arguments from AST
- Store in `static_structure.nodes[].arguments`
- Simple, focused scope

### Phase 2: Argument Resolution (Future)

- Add logic to `predictNextNodes` to resolve arguments
- Use `context` for task results
- Populate `PredictedNode.arguments`

### Phase 3: Real Speculative Execution (Future)

- Replace `generateSpeculationCode` placeholder
- Generate real MCP calls
- Handle result capture and validation

### Phase 4: Post-Workflow Capability Prefetching (Future)

**Idea**: When a workflow/capability completes, speculatively execute likely NEXT capabilities.

```
Workflow A completes → full context available
       ↓
Predict: "After A, users often run B, C..."
       ↓
Speculatively execute B, C with A's results
       ↓
Agent sends new intent
       ├── Matches B → Cache HIT! Instant result
       └── No match → Normal execution
```

**Why this is cleaner than intra-workflow speculation:**

| Aspect     | Intra-workflow          | Post-workflow Prefetch         |
| ---------- | ----------------------- | ------------------------------ |
| Context    | Partial (mid-execution) | Complete (workflow done)       |
| References | May be unresolved       | All resolved                   |
| Security   | Complex (mid-flow)      | Cleaner (new session boundary) |
| Validation | Interrupts flow         | Between intents                |

**Implementation sketch:**

```typescript
// In workflow completion handler
async function onWorkflowComplete(
  workflowResult: WorkflowResult,
  dagSuggester: DAGSuggester,
  speculativeExecutor: SpeculativeExecutor,
) {
  // Predict next likely capabilities based on what just completed
  const predictions = await dagSuggester.predictNextCapabilities(
    workflowResult.toolsUsed,
    workflowResult.context,
  );

  // Filter to safe-to-speculate only
  const safeToSpeculate = predictions.filter((p) => canSpeculate(p.toolId));

  // Speculatively execute with full workflow results as context
  await speculativeExecutor.startSpeculations(
    safeToSpeculate,
    workflowResult.context, // Rich context from completed workflow
  );
}
```

**Benefit**: If user's next intent matches a predicted capability, result is instant.

## Files to Modify (Future Phases)

| File                                      | Change                                                   |
| ----------------------------------------- | -------------------------------------------------------- |
| `src/graphrag/types.ts`                   | Extend `CompletedTask` with result?                      |
| `src/graphrag/dag-suggester.ts`           | Add argument resolution in `predictNextNodes`            |
| `src/speculation/speculative-executor.ts` | Replace placeholder in `generateSpeculationCode`         |
| `src/graphrag/prediction/capabilities.ts` | Use static_structure arguments in `createCapabilityTask` |

## Execution Modes Analysis: per_layer_validation vs AIL

### Two Independent Mechanisms

There are TWO separate pause mechanisms in the executor, often confused:

```
┌─────────────────────────────────────────────────────────────────┐
│  MECHANISM 1: per_layer_validation (Checkpoints)               │
│                                                                 │
│  Activation:                                                    │
│    pml_execute({ config: { per_layer_validation: true } })     │
│                                                                 │
│  Code path:                                                     │
│    workflow-execution-handler.ts:143                            │
│    → executeWithPerLayerValidation()                           │
│    → controlledExecutor.executeStream()                        │
│    → saveCheckpoint() after each layer                         │
│    → yield "checkpoint" event                                  │
│                                                                 │
│  Handler catches checkpoint → returns "layer_complete"         │
│  Claude calls "continue" to resume                             │
│                                                                 │
│  Purpose: VALIDATION between layers                            │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  MECHANISM 2: AIL (Agent-in-the-Loop)                          │
│                                                                 │
│  Activation:                                                    │
│    ExecutorConfig.ail = {                                      │
│      enabled: true,                                            │
│      decision_points: "per_layer" | "on_error" | "manual"      │
│    }                                                           │
│                                                                 │
│  Code path:                                                     │
│    controlled-executor.ts:1069                                  │
│    → shouldTriggerAIL(config, layerIdx, hasErrors)             │
│    → yield "decision_required" event                           │
│    → waitForAILResponse() blocks for continue/abort/replan     │
│                                                                 │
│  Purpose: AGENT DECISIONS (abort, replan workflow)             │
└─────────────────────────────────────────────────────────────────┘
```

### Key Discovery: They Are Independent!

| Configuration                     | Checkpoints | Decision Points |
| --------------------------------- | ----------- | --------------- |
| `per_layer_validation: true` only | ✅ Yes      | ❌ No           |
| `ail.enabled + per_layer` only    | ❌ No       | ✅ Yes          |
| Both enabled                      | ✅ Yes      | ✅ Yes          |
| Neither                           | ❌ No       | ❌ No           |

**Important**: `per_layer_validation: true` does NOT automatically enable `ail.enabled`!

The handler creates ControlledExecutor with **default config** (`ail.enabled: false`):

```typescript
// workflow-execution-handler.ts:312-318
const controlledExecutor = new ControlledExecutor(
  createToolExecutor(deps.mcpClients),
  {
    taskTimeout: ServerDefaults.taskTimeout,
    userId: userId ?? "local",
    // NOTE: No ail config passed! Uses default: { enabled: false }
  },
);
```

### Where Speculation Fits In

Speculation is most useful during **pause windows** between layers:

```
┌─────────────────────────────────────────────────────────────────┐
│  SPECULATION OPPORTUNITY WINDOWS                                │
│                                                                 │
│  1. During slow tool execution (Tool A running, speculate B)   │
│     → Already implemented in startSpeculativeExecution()       │
│                                                                 │
│  2. During per_layer_validation pause                          │
│     Layer complete → checkpoint → Claude thinking              │
│                      ↑                                         │
│                      Speculate here! (results available)       │
│                                                                 │
│  3. During AIL decision pause                                  │
│     Layer complete → decision_required → Agent thinking        │
│                      ↑                                         │
│                      Speculate here! (has abort/replan option) │
└─────────────────────────────────────────────────────────────────┘
```

### Current State: Functional but Redundant

With `per_layer_validation: true` alone, Claude can already:

- **continue** → call `pml_continue(workflow_id)` to resume
- **abort** → simply don't call continue (workflow times out or is abandoned)

AIL adds:

- **replan_dag** → modify the DAG mid-execution based on new context

**Note on replan**: Don't underestimate this feature. In practice, it could be useful when:

- Claude discovers unexpected files/formats during execution
- Intermediate results suggest a different approach is needed
- Error recovery requires adding diagnostic/fix tasks

The key is to ensure it's accessible. Currently `pml:replan` tool exists but AIL isn't auto-enabled
with `per_layer_validation`.

**Cleanup opportunity**: The two mechanisms could potentially be consolidated:

- `per_layer_validation` handles checkpointing + basic continue/abort
- AIL handles advanced decisions (replan)
- Currently they're independent, which is confusing but functional

**TODO**: Study if we should:

1. Keep them separate (current state - works)
2. Make `per_layer_validation` auto-enable basic AIL
3. Merge into a single unified pause mechanism

For now, the current state works - this is a future cleanup task.

### Recommendation for Real Speculation

For speculation with arguments to work well:

1. **Enable both mechanisms** when speculation is wanted:
   ```typescript
   pml_execute({
     config: {
       per_layer_validation: true,
       ail: { enabled: true, decision_points: "per_layer" },
     },
   });
   ```

2. **During checkpoint pause**:
   - Previous layer results are available in context
   - `predictNextNodes()` can resolve arguments from results
   - Speculate the likely next tool with real arguments

3. **On speculation miss (replan)**:
   - AIL allows `replan_dag` command
   - Discard speculated results
   - Re-generate DAG based on new context

## Schema Exposure in DAG Suggestions

### Current State

**Q: Do suggestions include output schemas?** **A: NO.** The `DAGStructure` returned by
`suggestDAG()` only contains:

```typescript
{ id: `task_${i}`, tool: toolId, arguments: {}, dependsOn }
```

Schemas (`input_schema`, `output_schema`) are stored in the `tool_schema` table and used by
`ProvidesEdgeCalculator`, but they are **NOT included** in the suggestion itself.

**Q: Do input schemas indicate dependencies on previous tool outputs?** **A: NO** in the suggestion.
The `dependsOn` field indicates _which_ task must execute first, but **NOT how data flows** (which
output field maps to which input field).

### Existing Data Flow Information

This information **exists** in `ProvidesEdge`:

```typescript
interface ProvidesEdge {
  from: string; // "read_file"
  to: string; // "parse_json"
  coverage: "strict" | "partial" | "optional";
  fieldMapping: FieldMapping[]; // ← Precise field-to-field mapping!
  providerOutputSchema: JSONSchema;
  consumerInputSchema: JSONSchema;
}

interface FieldMapping {
  fromField: string; // "content"
  toField: string; // "text"
  typeCompatible: boolean;
  fromType?: string; // "string"
  toType?: string; // "string"
}
```

But this information is **not propagated** to the DAG suggestion - it stays in the `tool_dependency`
table.

### Gap: Field Mapping Not Exposed

For speculative execution with arguments to work well:

1. **Option A**: Enrich `Task` with optional `fieldMappings`:
   ```typescript
   interface Task {
     id: string;
     tool: string;
     arguments: Record<string, unknown>;
     dependsOn: string[];
     fieldMappings?: Record<string, { fromTask: string; fromField: string }>;
   }
   ```

2. **Option B**: Look up ProvidesEdge at speculation time:
   ```typescript
   const edge = await findDirectProvidesEdge(db, previousTool, currentTool);
   if (edge?.fieldMapping) {
     // Resolve arguments from previous task results
   }
   ```

**Recommendation**: Option B is simpler - no schema changes, just use existing `ProvidesEdge` data
at speculation time.

## References

- ADR-006: Speculative Execution
- Story 3.5-1: DAG Suggester & Speculative Execution
- Story 3.5-2: Confidence-Based Speculation & Rollback
- Story 10.1: Static DAG Parsing
- Story 10.2: Static Argument Extraction
- Story 10.3: ProvidesEdge for Data Flow
