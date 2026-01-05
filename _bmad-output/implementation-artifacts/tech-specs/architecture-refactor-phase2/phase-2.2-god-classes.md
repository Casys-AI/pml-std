# Phase 2.2: Refactor God Classes (P0 - Critical)

**Parent:** [index.md](./index.md)
**Priority:** P0 - Critical
**Timeline:** Weeks 3-5
**Depends On:** Phase 2.1 (DI setup)

---

## Objective

Break down the 3 largest files that violate single responsibility:

| File | Current | Target | Reduction |
|------|---------|--------|-----------|
| `static-structure-builder.ts` | 2,399 | 300 | 87% |
| `controlled-executor.ts` | 1,556 | 600 | 61% |
| `capability-store.ts` | 1,441 | 200 | 86% |

---

## Target 1: `static-structure-builder.ts` (2,399 lines)

### Responsibilities Identified

1. SWC AST parsing (lines 1-800)
2. Node extraction (tool calls, decisions, fork/join) (lines 801-1400)
3. Edge generation (sequence, conditional, provides) (lines 1401-1800)
4. Argument extraction and resolution (lines 1801-2200)
5. Variable tracking and literal bindings (lines 2201-2399)

### Target Structure

```
src/capabilities/analysis/
├── static-structure-builder.ts  # ~300 lines - Facade orchestrator
├── parsers/
│   ├── ast-parser.ts             # SWC parsing wrapper
│   ├── node-extractor.ts         # Extract task/decision/fork nodes
│   └── argument-extractor.ts     # Extract arguments from AST
├── graph/
│   ├── edge-builder.ts           # Generate edges (sequence, conditional, provides)
│   └── scope-tracker.ts          # Track scopes for conditional edges
└── context/
    ├── variable-tracker.ts       # Map variables to node IDs
    └── literal-resolver.ts       # Resolve literal bindings
```

### Migration Strategy

**Week 3:** Extract AST parsing utilities
- Create `parsers/ast-parser.ts` with SWC wrapper
- Move `parse()` call and span extraction logic
- Unit tests for parser module

**Week 4:** Extract node and edge logic
- Create `parsers/node-extractor.ts`
- Create `graph/edge-builder.ts`
- Move visitor methods

**Week 5:** Extract context tracking
- Create `context/variable-tracker.ts` and `literal-resolver.ts`
- Integration tests for full flow

### Acceptance Criteria

- [ ] Main file < 300 lines (87% reduction)
- [ ] Each module independently testable
- [ ] Zero breaking changes to public API
- [ ] Test coverage > 85%

---

## Target 2: `controlled-executor.ts` (1,556 lines)

### Analysis

File re-inflated from 841 → 1,556 lines since Phase 3.

### Bloat Sources

- Lines 1-200: Imports and setup (bloated)
- Lines 400-700: Speculation logic (should be in `speculation/`)
- Lines 900-1100: Permission escalation (should be in `permissions/`)
- Lines 1200-1400: Checkpoint logic (should be in `checkpoints/`)

### Re-refactoring Plan

**1. Move speculation logic**
```typescript
// src/dag/speculation/executor-integration.ts
export class SpeculationExecutorIntegration {
  async handleSpeculativeExecution(task: Task): Promise<TaskResult> { }
  async consumeSpeculation(taskId: string): Promise<SpeculationResult | null> { }
}
```

**2. Move permission logic**
```typescript
// src/dag/permissions/escalation-manager.ts
export class EscalationManager {
  checkPermissions(task: Task): PermissionCheckResult { }
  requestEscalation(request: EscalationRequest): Promise<void> { }
}
```

**3. Consolidate checkpoint logic**
```typescript
// src/dag/checkpoints/coordinator.ts
export class CheckpointCoordinator {
  saveCheckpoint(state: ExecutionState): Promise<void> { }
  loadCheckpoint(workflowId: string): Promise<ExecutionState | null> { }
}
```

### Target

Reduce to 600 lines (61% reduction)

### Acceptance Criteria

- [ ] File size < 600 lines
- [ ] No duplicate logic in extracted modules
- [ ] All existing tests pass
- [ ] Code review: single responsibility verified

---

## Target 3: `capability-store.ts` (1,441 lines)

### Current Responsibilities (6 domains)

1. CRUD operations (save, find, update, delete)
2. Embedding generation
3. Schema inference
4. Dependency management
5. Trace storage
6. Code transformation

### Target Structure

```
src/capabilities/
├── capability-store.ts           # ~200 lines - Repository facade
├── storage/
│   ├── repository.ts             # CRUD operations
│   ├── query-builder.ts          # Complex queries (findByIntent, etc.)
│   └── embedding-indexer.ts      # Embedding generation and indexing
├── analysis/
│   ├── schema-analyzer.ts        # Schema inference (uses SchemaInferrer)
│   └── dependency-analyzer.ts    # Dependency graph building
└── tracing/
    └── trace-recorder.ts         # Execution trace storage
```

### Migration Strategy

1. Extract repository layer (pure CRUD)
2. Extract embedding indexing
3. Extract schema and dependency analysis
4. Create facade for backward compatibility

### Target

Reduce to 200 lines (86% reduction)

### Acceptance Criteria

- [ ] File size < 200 lines
- [ ] Each module < 300 lines
- [ ] Existing tests pass
- [ ] New unit tests per module

---

## Deliverables

| Target | New Files | Main File Target |
|--------|-----------|------------------|
| static-structure-builder | 7 files | 300 lines |
| controlled-executor | 3 files | 600 lines |
| capability-store | 6 files | 200 lines |

**Total new files:** 16
**Total LOC reduction:** ~3,500 lines
