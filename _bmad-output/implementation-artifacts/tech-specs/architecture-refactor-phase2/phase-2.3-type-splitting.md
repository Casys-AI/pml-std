# Phase 2.3: Split Type Files (P1 - High)

**Parent:** [index.md](./index.md)
**Priority:** P1 - High
**Timeline:** Week 6
**Depends On:** Phase 2.1 (Domain types extracted)

---

## Objective

Split large type files to reduce git conflicts and improve maintainability.

| File | Current | Target | Files |
|------|---------|--------|-------|
| `capabilities/types.ts` | 1,237 lines | 6 files × ~200 lines | 6 |
| `graphrag/types.ts` | 695 lines | 3 files × ~230 lines | 3 |

---

## Target: `capabilities/types.ts` (1,237 lines → 6 files)

### Current State

85+ types in single file across 6 domains:
- Capabilities (Capability, SaveCapabilityInput, CapabilityMatch, etc.)
- Execution (ExecutionTrace, TraceTaskResult, etc.)
- Permissions (PermissionSet, PermissionConfig, etc.)
- Static Analysis (StaticStructure, ArgumentsStructure, etc.)
- Graph (GraphNode, GraphEdge, etc.)
- Schemas (JSONSchema, etc.)

### Target Structure

```
src/capabilities/types/
├── capability.ts         # ~150 lines
│   ├── Capability
│   ├── SaveCapabilityInput
│   ├── CapabilityMatch
│   ├── CapabilityFilters
│   └── CacheConfig
│
├── execution.ts          # ~200 lines
│   ├── ExecutionTrace
│   ├── TraceTaskResult
│   ├── SaveTraceInput
│   └── ExecutionResult
│
├── permission.ts         # ~180 lines
│   ├── PermissionSet
│   ├── PermissionConfig
│   ├── PermissionEscalationRequest
│   └── PermissionAuditLogEntry
│
├── static-analysis.ts    # ~250 lines
│   ├── StaticStructure
│   ├── StaticStructureNode
│   ├── StaticStructureEdge
│   ├── ArgumentsStructure
│   └── ArgumentValue
│
├── graph.ts              # ~180 lines
│   ├── GraphNode
│   ├── GraphEdge
│   ├── HypergraphOptions
│   └── CapabilityZone
│
├── schema.ts             # ~150 lines
│   ├── JSONSchema
│   ├── SchemaProperty
│   └── SchemaValidationResult
│
└── mod.ts                # Re-exports all types
```

### mod.ts Pattern

```typescript
// src/capabilities/types/mod.ts
export * from "./capability.ts";
export * from "./execution.ts";
export * from "./permission.ts";
export * from "./static-analysis.ts";
export * from "./graph.ts";
export * from "./schema.ts";
```

---

## Target: `graphrag/types.ts` (695 lines → 3 files)

### Target Structure

```
src/graphrag/types/
├── graph.ts              # ~230 lines
│   ├── GraphSnapshot
│   ├── GraphMetrics
│   └── PathResult
│
├── prediction.ts         # ~230 lines
│   ├── PredictionResult
│   ├── DAGSuggestion
│   └── ToolRecommendation
│
├── learning.ts           # ~235 lines
│   ├── TrainingExample
│   ├── ModelConfig
│   └── EvaluationMetrics
│
└── mod.ts                # Re-exports
```

---

## Migration Steps

### Step 1: Create New Type Files

```bash
mkdir -p src/capabilities/types
mkdir -p src/graphrag/types
```

### Step 2: Move Types to Appropriate Files

1. Group types by domain
2. Copy to new files
3. Add necessary imports within type files

### Step 3: Update Imports Across Codebase

**Before:**
```typescript
import type { Capability, ExecutionTrace, PermissionSet } from "../capabilities/types.ts";
```

**After:**
```typescript
import type { Capability } from "../capabilities/types/capability.ts";
import type { ExecutionTrace } from "../capabilities/types/execution.ts";
import type { PermissionSet } from "../capabilities/types/permission.ts";

// OR use mod.ts for convenience
import type { Capability, ExecutionTrace, PermissionSet } from "../capabilities/types/mod.ts";
```

### Step 4: Delete Old Files

```bash
rm src/capabilities/types.ts
rm src/graphrag/types.ts
```

### Step 5: Validate

```bash
deno check src/**/*.ts
deno task test
```

---

## Import Map Enhancement

Add to `deno.json`:

```json
{
  "imports": {
    "@/types/capability": "./src/capabilities/types/capability.ts",
    "@/types/execution": "./src/capabilities/types/execution.ts",
    "@/types/permission": "./src/capabilities/types/permission.ts",
    "@/types/static-analysis": "./src/capabilities/types/static-analysis.ts",
    "@/types/graph": "./src/capabilities/types/graph.ts",
    "@/types/schema": "./src/capabilities/types/schema.ts"
  }
}
```

---

## Risk Mitigation

### Risk: Type Import Churn

**Impact:** 300+ files importing from `capabilities/types.ts`

**Mitigation:**
1. Keep `mod.ts` as drop-in replacement
2. Use import map aliases for new code
3. Gradual migration of imports over time

### Rollback Plan

If issues arise:
1. Keep old `types.ts` as re-export hub
2. Individual type files are the source of truth
3. Old imports continue to work via `mod.ts`

---

## Acceptance Criteria

- [ ] No type file > 300 lines
- [ ] Zero duplicate type definitions
- [ ] All files type-check successfully
- [ ] Import paths updated (or use `mod.ts`)
- [ ] No breaking changes to external API
