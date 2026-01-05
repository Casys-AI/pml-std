# 08 - Migration & Backward Compatibility

**Parent**: [00-overview.md](./00-overview.md) **Depends on**:
[01-data-model.md](./01-data-model.md)

---

## Automatic Data Migration

```typescript
/**
 * Convert legacy CapabilityNode to new format
 */
function migrateCapabilityNode(
  legacy: {
    id: string;
    toolsUsed: string[];
    children: string[];
    embedding: number[];
    successRate: number;
  },
): CapabilityNode {
  return {
    id: legacy.id,
    embedding: legacy.embedding,
    members: [
      ...legacy.toolsUsed.map((id) => ({ type: "tool" as const, id })),
      ...legacy.children.map((id) => ({ type: "capability" as const, id })),
    ],
    hierarchyLevel: 0, // Will be recomputed
    successRate: legacy.successRate,
  };
}
```

---

## API Compatibility Layer

```typescript
class SHGAT {
  /**
   * Legacy API: accepts old format, converts internally
   * @deprecated Use addCapability() with new format
   */
  addCapabilityLegacy(
    id: string,
    embedding: number[],
    toolsUsed: string[],
    children: string[] = [],
  ): void {
    const members: Member[] = [
      ...toolsUsed.map((tid) => ({ type: "tool" as const, id: tid })),
      ...children.map((cid) => ({ type: "capability" as const, id: cid })),
    ];

    this.addCapability(id, embedding, members);
  }

  /**
   * New API: unified members
   */
  addCapability(
    id: string,
    embedding: number[],
    members: Member[],
    successRate: number = 0.5,
  ): void {
    this.capabilityNodes.set(id, {
      id,
      embedding,
      members,
      hierarchyLevel: 0, // Computed during rebuild
      successRate,
    });

    this.dirty = true; // Mark for rebuild
  }
}
```

---

## Database Schema Extension

**REQUIRED**: Add `parent_trace_id` to preserve hierarchy.

```sql
-- Required: Store parent trace for hierarchy reconstruction
ALTER TABLE execution_trace ADD COLUMN parent_trace_id TEXT;
CREATE INDEX idx_execution_trace_parent ON execution_trace(parent_trace_id);

-- Optional: Analytics metadata (not required for core functionality)
ALTER TABLE execution_trace ADD COLUMN node_types JSONB;
ALTER TABLE execution_trace ADD COLUMN hierarchy_levels JSONB;
```

---

## Execution Trace Format

### Current Format

```typescript
interface ExecutionTrace {
  path: string[]; // Tool IDs only
  outcome: "success" | "failure";
  // ... other fields
}
```

### New Format (Backward Compatible)

```typescript
interface ExecutionTrace {
  id: string;
  capabilityId: string;
  intentText: string;
  intentEmbedding?: number[];
  initialContext: Record<string, JsonValue>;
  executedAt: Date;
  success: boolean;
  durationMs: number;
  errorMessage?: string;
  executedPath?: string[];
  decisions?: BranchDecision[];
  taskResults?: TaskResult[];
  priority: number;

  parentTraceId?: string | null; // NEW: Link to parent trace in hierarchy

  userId?: string;
  createdBy: string;
}
```

### Example Data

```typescript
// Top-level trace (no parent)
{
  id: "trace-outer",
  executedPath: ["cap-outer", "cap-inner", "tool1"],  // Flat (unchanged)
  parentTraceId: null
}

// Nested trace (from capability_end event with parentTraceId)
{
  id: "trace-inner",
  executedPath: ["cap-inner", "tool1"],
  parentTraceId: "trace-outer"  // ← NEW: Preserves hierarchy
}

// Tool trace (leaf)
{
  id: "trace-tool1",
  executedPath: ["tool1"],
  parentTraceId: "trace-inner"
}
```

---

## Hierarchy Reconstruction

```typescript
interface HierarchyNode {
  trace: ExecutionTrace;
  children: HierarchyNode[];
}

/**
 * Rebuild hierarchy tree from flat traces
 */
function buildHierarchy(traces: ExecutionTrace[]): HierarchyNode[] {
  const traceMap = new Map<string, HierarchyNode>();
  const roots: HierarchyNode[] = [];

  // Build node map
  for (const trace of traces) {
    traceMap.set(trace.id, { trace, children: [] });
  }

  // Link children to parents
  for (const trace of traces) {
    const node = traceMap.get(trace.id)!;

    if (!trace.parentTraceId) {
      // Root node
      roots.push(node);
    } else {
      // Child node: attach to parent
      const parent = traceMap.get(trace.parentTraceId);
      if (parent) {
        parent.children.push(node);
      } else {
        // Parent not in result set: treat as root
        roots.push(node);
      }
    }
  }

  return roots;
}
```

---

## Code Changes Required

### File: `src/sandbox/worker-bridge.ts:354-361`

```typescript
// AFTER (preserves hierarchy via parent_trace_id)
const executedPath = sortedTraces
  .filter((t): t is ToolTraceEvent | CapabilityTraceEvent =>
    t.type === "tool_end" || t.type === "capability_end"
  )
  .map((t) => {
    if (t.type === "tool_end") return t.tool;
    return (t as CapabilityTraceEvent).capability;
  });

// NEW: Extract parentTraceId from the root trace event
const parentTraceId = sortedTraces[0]?.parentTraceId ?? null;

// Pass to traceData
traceData: {
  initialContext: (this.lastContext ?? {}) as Record<string, JsonValue>,
  executedPath,
  parentTraceId,  // ← NEW
  decisions: [],
  taskResults,
  userId: (this.lastContext?.userId as string) ?? "local",
},
```

### File: `src/capabilities/execution-trace-store.ts`

```typescript
interface SaveTraceParams {
  // ... existing fields
  parentTraceId?: string | null;  // NEW
}

async saveTrace(params: SaveTraceParams): Promise<ExecutionTrace> {
  const result = await this.db.query(`
    INSERT INTO execution_trace (
      capability_id, intent_text, intent_embedding,
      initial_context, executed_at, success,
      duration_ms, error_message, executed_path,
      decisions, task_results, priority,
      parent_trace_id,  -- NEW
      user_id, created_by
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
    RETURNING id;
  `, [
    // ... existing params
    params.parentTraceId,  // NEW
    // ... remaining params
  ]);

  return result.rows[0];
}
```

---

## Key Insight

The hierarchical message passing **complements** trace-based learning:

- **Message passing**: Captures structural relationships (tool→cap→meta-cap)
- **Trace features**: Captures behavioral patterns (success rates, co-occurrence, recency)

**Both are necessary**:

- Structure alone (v1) lacks historical context
- Traces alone (v2) lack compositional understanding
- Hybrid (v3) combines both for optimal performance

**Hierarchy preservation**:

- `parentTraceId` preserves hierarchy WITHOUT breaking existing `executedPath` format
- Reconstruction is opt-in (only when needed for analytics/debugging)
- Training and inference continue to use flat `executedPath` (unchanged)

---

## Acceptance Criteria

- [ ] `migrateCapabilityNode()` converts legacy format
- [ ] `addCapabilityLegacy()` backward compat API works
- [ ] DB migration adds `parent_trace_id` column
- [ ] `ExecutionTrace` interface updated
- [ ] `saveTrace()` accepts parentTraceId
- [ ] `buildHierarchy()` reconstruction works
- [ ] Old traces (null parentTraceId) continue to work
