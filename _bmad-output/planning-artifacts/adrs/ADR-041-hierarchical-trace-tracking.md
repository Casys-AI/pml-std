# ADR-041: Hierarchical Trace Tracking with parent_trace_id

**Status:** Implemented (Code Review Complete) **Date:** 2025-12-09 | **Deciders:** Architecture
Team **Implemented:** 2025-12-09 **Code Review:** 2025-12-09 - 8 issues fixed (3 CRITICAL, 3 MEDIUM,
2 LOW)

## Context

### Current State

Le système de tracing actuel capture les événements `tool_start/end` et `capability_start/end` avec
un `trace_id` unique pour corréler start/end, mais **sans relation hiérarchique**.

```typescript
// src/sandbox/types.ts - Current
interface BaseTraceEvent {
  trace_id: string; // UUID pour corréler start/end
  ts: number; // Timestamp
  success?: boolean;
  duration_ms?: number;
  error?: string;
}
```

### Le Problème

Le GraphRAG crée des edges basés sur **l'ordre chronologique des `*_end` events** :

```typescript
// src/graphrag/graph-engine.ts - updateFromCodeExecution()
const endEvents = traces.filter((t) => t.type === "tool_end" || t.type === "capability_end");

// Create edges from CONSECUTIVE end events
for (let i = 0; i < endEvents.length - 1; i++) {
  const from = endEvents[i];
  const to = endEvents[i + 1];
  // ... create edge from → to
}
```

**Exemple d'exécution :**

```
Timeline:
t=0   capability_start (cap1, trace_id: "cap1")
t=10  tool_start (read_file, trace_id: "t1")
t=50  tool_end (read_file, trace_id: "t1")
t=60  tool_start (write_file, trace_id: "t2")
t=100 tool_end (write_file, trace_id: "t2")
t=110 capability_end (cap1, trace_id: "cap1")
```

**Edges créés (basés sur l'ordre temporel) :**

```
read_file → write_file → cap1
```

**Mais la vraie structure hiérarchique est :**

```
cap1
├── read_file
└── write_file
```

### Conséquences

1. **Shortest Path incorrect** : `buildDAG()` utilise `findShortestPath()` pour inférer les
   dépendances. Avec des edges temporels au lieu de causaux, les chemins sont incorrects.

2. **Adamic-Adar biaisé** : L'algorithme calcule la similarité basée sur les voisins communs. Sans
   hiérarchie, une capability est vue comme un "voisin" de ses propres tools au lieu de leur
   "parent".

3. **Scoring adaptatif limité** (Story 7.6) : L'algorithme ne peut pas distinguer :
   - "A appelle B" (causal)
   - "A se termine juste avant B" (temporel)
   - "A contient B" (hiérarchique)

4. **Pas d'arguments tracés** : On ne sait pas quels inputs ont causé un comportement.

## Decision

Ajouter `parent_trace_id` et `args` aux trace events pour capturer la vraie structure d'appel.

### 1. Extended BaseTraceEvent

```typescript
// src/sandbox/types.ts - UPDATED
interface BaseTraceEvent {
  trace_id: string;
  ts: number;
  success?: boolean;
  duration_ms?: number;
  error?: string;

  // NEW: Hierarchical tracking
  parent_trace_id?: string; // ID of caller (capability or tool that initiated this)

  // NEW: Arguments tracking (for debugging and learning)
  args?: Record<string, unknown>;
}
```

### 2. Propagation dans le Sandbox Worker

```typescript
// src/sandbox/sandbox-worker.ts - UPDATED
let currentTraceId: string | undefined; // Track current execution context

function __trace(event: Partial<TraceEvent>): void {
  const traceId = crypto.randomUUID();
  const fullEvent: TraceEvent = {
    ...event,
    trace_id: traceId,
    parent_trace_id: currentTraceId, // Link to parent
    ts: Date.now(),
  };

  // Update context for nested calls
  if (event.type?.endsWith("_start")) {
    currentTraceId = traceId;
  } else if (event.type?.endsWith("_end")) {
    // Restore parent context (simplified - real impl needs a stack)
    currentTraceId = event.parent_trace_id;
  }

  traceChannel.postMessage(fullEvent);
}
```

### 3. Enhanced GraphRAG Learning

```typescript
// src/graphrag/graph-engine.ts - UPDATED
async updateFromCodeExecution(traces: TraceEvent[]): Promise<void> {
  // Build hierarchy map
  const hierarchy = new Map<string, string[]>();  // parent_id → children_ids

  for (const trace of traces) {
    if (trace.parent_trace_id) {
      const children = hierarchy.get(trace.parent_trace_id) ?? [];
      children.push(trace.trace_id);
      hierarchy.set(trace.parent_trace_id, children);
    }
  }

  // Create edges with TYPE information
  for (const trace of traces) {
    if (trace.parent_trace_id) {
      // CONTAINMENT edge: parent contains this
      this.addEdge(getToolId(trace.parent_trace_id), getToolId(trace), {
        type: "contains",
        weight: 0.8,
      });
    }
  }

  // Sequence edges (existing logic) with type "sequence"
  const endEvents = traces.filter(t => t.type.endsWith("_end"));
  for (let i = 0; i < endEvents.length - 1; i++) {
    // Only create sequence edges between siblings (same parent)
    if (endEvents[i].parent_trace_id === endEvents[i+1].parent_trace_id) {
      this.addEdge(getToolId(endEvents[i]), getToolId(endEvents[i+1]), {
        type: "sequence",
        weight: 0.6,
      });
    }
  }
}
```

### 4. Edge Types for Algorithms

```typescript
// Edge types with different weights for shortest path
type EdgeType = "contains" | "sequence" | "dependency" | "template";

// Shortest path should weight by edge type
function getEdgeWeight(type: EdgeType): number {
  switch (type) {
    case "dependency":
      return 1.0; // Strongest signal
    case "contains":
      return 0.8; // Parent-child
    case "sequence":
      return 0.5; // Temporal
    case "template":
      return 0.3; // Bootstrap
  }
}
```

### 5. EventBus Payloads (Story 6.5)

```typescript
// src/events/types.ts - Already has parent_trace_id in payloads
interface CapabilityStartPayload {
  capability_id: string;
  capability: string;
  trace_id: string;
  parent_trace_id?: string; // ✅ Already defined
  args?: Record<string, unknown>; // ✅ Already defined
}
```

## Implementation Plan

### Phase 1: Types & Infrastructure (Story 6.5) - DONE

- [x] Add `parent_trace_id` to `PmlEvent` payloads (events/types.ts)
- [x] Add `parent_trace_id` and `args` to `BaseTraceEvent` (sandbox/types.ts)
- [x] Propagate `args` in WorkerBridge tool traces
- [x] Bridge capability traces to EventBus with parent_trace_id support

### Phase 2: Sandbox Propagation - DONE

- [x] Implement trace context stack in sandbox-worker.ts (`__traceContextStack`)
- [x] **TOOLS:** RPC calls include `parent_trace_id` from current context
- [x] **WorkerBridge:** Reads `parent_trace_id` from RPC and includes in traces
- [x] **Capabilities:** Nested capabilities propagate context via stack

### Phase 3: GraphRAG Enhancement - DONE

- [x] Add `edge_type` and `edge_source` support to Graphology graph
- [x] Update `updateFromCodeExecution()` to create hierarchical edges
- [x] Modify `findShortestPath()` to use Dijkstra with weighted edges
- [x] Update Adamic-Adar to consider edge weights

### Phase 4: Persistence & Visualization - DONE

- [x] Database migration 012 for `edge_type` and `edge_source` columns
- [x] D3.js visualization with color-coded edge types (migrated from Cytoscape)
- [x] Legend for edge types and confidence levels

### Phase 5: Algorithm Tuning - FUTURE

- [ ] A/B test weighted vs unweighted shortest path
- [ ] Tune edge type weights based on feedback
- [ ] Add "containment" to hybrid search scoring

## Implementation Details (2025-12-09)

### Files Created

| File                                             | Purpose                                             |
| ------------------------------------------------ | --------------------------------------------------- |
| `src/db/migrations/012_edge_types_migration.ts`  | DB migration for `edge_type`, `edge_source` columns |
| `tests/unit/graphrag/hierarchical_trace_test.ts` | 6 unit tests for hierarchical behavior              |

### Files Modified

| File                                     | Changes                                                                                                                                                                 |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/sandbox/types.ts`                   | Added `parent_trace_id` to `RPCCallMessage`                                                                                                                             |
| `src/sandbox/sandbox-worker.ts`          | Added `__traceContextStack`, `__getCurrentTraceId()`, updated `__trace()` and `__rpcCall()`                                                                             |
| `src/sandbox/worker-bridge.ts`           | Extract and propagate `parent_trace_id` in all trace events                                                                                                             |
| `src/graphrag/graph-engine.ts`           | Complete rewrite of `updateFromCodeExecution()`, new `createOrUpdateEdge()`, weighted Dijkstra in `findShortestPath()`, weighted `computeAdamicAdar()` and `buildDAG()` |
| `src/web/islands/GraphVisualization.tsx` | Edge styles by type (color) and source (line style), legend                                                                                                             |
| `src/db/migrations.ts`                   | Added migration 012                                                                                                                                                     |

### Edge Type Weights

```typescript
EDGE_TYPE_WEIGHTS = {
  dependency: 1.0, // Explicit DAG from templates
  contains: 0.8, // Parent-child hierarchy
  sequence: 0.5, // Temporal between siblings
};

EDGE_SOURCE_MODIFIERS = {
  observed: 1.0, // Confirmed by 3+ executions
  inferred: 0.7, // Single observation
  template: 0.5, // Bootstrap, not yet confirmed
};

// Combined weight = type_weight × source_modifier
// Example: contains + observed = 0.8 × 1.0 = 0.8
// Example: sequence + template = 0.5 × 0.5 = 0.25
```

### Algorithm Changes

1. **Dijkstra Shortest Path**: Uses `cost = 1 / weight` so higher-weight edges are preferred
2. **Adamic-Adar**: Weights neighbor contributions by edge quality
3. **BuildDAG**: Considers average edge weight along paths for cycle breaking
4. **Edge Source Promotion**: Edges upgrade from `inferred` to `observed` after 3 observations

### Visualization

| Edge Type    | Color            | Meaning                           |
| ------------ | ---------------- | --------------------------------- |
| `contains`   | Green (#22c55e)  | Parent-child relationship         |
| `sequence`   | Orange (#FFB86F) | Temporal order between siblings   |
| `dependency` | White (#f5f0ea)  | Explicit dependency from template |

| Edge Source | Line Style | Opacity |
| ----------- | ---------- | ------- |
| `observed`  | Solid      | 90%     |
| `inferred`  | Dashed     | 60%     |
| `template`  | Dotted     | 40%     |

## Consequences

### Positives

- **True causality** : Le graphe représente les vraies dépendances, pas juste la temporalité
- **Better suggestions** : Shortest path trouve les vraies chaînes de dépendances
- **Debugging** : On peut reconstruire l'arbre d'appels exact
- **Learning amélioré** : L'algorithme peut apprendre que "cap1 utilise [A, B]" vs "A suivi de B"

### Negatives

- **Complexité** : Gestion d'une stack de contexte dans le worker
- **Taille des events** : Plus de données par trace event
- **Migration** : Les anciennes traces sans parent_trace_id devront être gérées

### Risks

| Risk                 | Probability | Impact | Mitigation                                     |
| -------------------- | ----------- | ------ | ---------------------------------------------- |
| Context stack bugs   | Medium      | Medium | Tests exhaustifs, fallback sur temporel        |
| Backward compat      | Low         | Low    | parent_trace_id optional, graceful degradation |
| Performance overhead | Low         | Low    | parent_trace_id est juste un string UUID       |

## Code Review (2025-12-09)

### Issues Fixed

| ID         | Severity | File                            | Issue                                                              | Fix                                    |
| ---------- | -------- | ------------------------------- | ------------------------------------------------------------------ | -------------------------------------- |
| CRITICAL-1 | 🔴       | `GraphVisualization.tsx:602`    | Invalid `:hover` pseudo-class in inline style                      | Removed (handlers already exist)       |
| CRITICAL-2 | 🔴       | `worker-bridge.ts:125-147`      | `parent_trace_id` not propagated to EventBus for capability events | Added to both start/end payloads       |
| CRITICAL-3 | 🔴       | `graph-engine.ts:getEdgeData()` | Missing `edge_type`/`edge_source` in return type                   | Extended return type                   |
| MEDIUM-1   | 🟡       | Tech-Spec                       | Wrong migration filename (004 vs 012)                              | Updated to 012                         |
| MEDIUM-2   | 🟡       | `hierarchical_trace_test.ts`    | Tests only cover logic, not integration                            | Added 2 integration tests              |
| MEDIUM-3   | 🟡       | `code-generator.ts:82-102`      | Double emit of capability_end on error                             | Refactored with single emit in finally |
| LOW-1      | 🟢       | `graph-engine.ts:567-595`       | Unclear combined weight comments                                   | Added examples table                   |
| LOW-2      | 🟢       | `ADR-041.md`                    | Status not reflecting reality                                      | Updated with code review date          |

### Tests Passing

All 8 tests pass after fixes:

```
✓ ADR-041: updateFromCodeExecution creates 'contains' edges
✓ ADR-041: nested capabilities have correct parent_trace_id
✓ ADR-041: sequence edges only between siblings
✓ ADR-041: backward compat - traces without parent_trace_id
✓ ADR-041: edge weights are correctly computed
✓ ADR-041: edge_source upgrades at threshold
✓ ADR-041: integration - createOrUpdateEdge logic
✓ ADR-041: integration - Dijkstra cost inversion
```

## References

- ADR-036: BroadcastChannel for Event Distribution
- ADR-027: Execute Code Graph Learning
- ADR-039: Algorithm Observability Tracking
- Story 6.5: EventBus with BroadcastChannel
- Story 7.6: Algorithm Transparency (future)
- `src/graphrag/graph-engine.ts:updateFromCodeExecution()`
- `src/sandbox/types.ts`
