# ADR-045: Capability-to-Capability Dependencies

**Status:** Implemented **Date:** 2025-12-11 | **Deciders:** Architecture Team **Tech-Spec Source:**
`docs/tech-specs/tech-spec-capability-dependency.md`

## Context

### Problem

Capabilities were stored independently in `workflow_pattern` without the ability to link them
together. The existing `tool_dependency` table managed tool-to-tool relationships with `edge_type`
and `edge_source` (ADR-041), but:

- Capabilities stored as `capability:{uuid}` in `tool_dependency` were not type-safe (UUIDs as TEXT)
- Semantically confusing (a "tool" table for capabilities)
- No foreign key to `workflow_pattern`

**Missing use cases:**

- A "deploy app" capability **composes** "build", "test", "push" capabilities
- A "full report" capability **depends** on "fetch data"
- Two capabilities can be linked in **sequence** (A then B)
- Two capabilities can be **alternatives** (same intent, different implementations)

### Existing Pattern

Edge types and sources from ADR-041:

```typescript
EDGE_TYPE_WEIGHTS = {
  dependency: 1.0, // Explicit DAG
  contains: 0.8, // Parent-child
  sequence: 0.5, // Temporal order
};

EDGE_SOURCE_MODIFIERS = {
  observed: 1.0, // 3+ observations
  inferred: 0.7, // 1-2 observations
  template: 0.5, // Bootstrap
};
```

## Decision

### 1. Create Dedicated `capability_dependency` Table

```sql
CREATE TABLE capability_dependency (
  from_capability_id UUID NOT NULL
    REFERENCES workflow_pattern(pattern_id) ON DELETE CASCADE,
  to_capability_id UUID NOT NULL
    REFERENCES workflow_pattern(pattern_id) ON DELETE CASCADE,
  observed_count INTEGER DEFAULT 1,
  confidence_score REAL DEFAULT 0.5,
  edge_type TEXT DEFAULT 'sequence',
  edge_source TEXT DEFAULT 'inferred',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_observed TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (from_capability_id, to_capability_id),
  CHECK (from_capability_id != to_capability_id)  -- No self-loops
);

CREATE INDEX idx_capability_dep_from ON capability_dependency(from_capability_id);
CREATE INDEX idx_capability_dep_to ON capability_dependency(to_capability_id);
CREATE INDEX idx_capability_dep_type ON capability_dependency(edge_type);
```

### 2. Add New Edge Type: `alternative`

```typescript
EDGE_TYPE_WEIGHTS = {
  dependency: 1.0, // Explicit DAG
  contains: 0.8, // Parent-child
  alternative: 0.6, // Same intent, different impl (NEW)
  sequence: 0.5, // Temporal order
};
```

**Use case:** Two capabilities with same intent but different implementations

- Example: "fetch via REST" ↔ "fetch via GraphQL"
- Detection: Intent embedding similarity > 0.9 + different tools used
- Usage: Suggestion Engine proposes alternative if capability fails

### 3. Unified Graph Loading

`GraphRAGEngine.syncFromDatabase()` loads both:

- `tool_dependency` edges (tool → tool)
- `capability_dependency` edges (capability → capability)

Both edge types use the same weight calculation: `type_weight × source_modifier`

### 4. Cycle Handling

- **Self-loops prevented** by `CHECK (from_capability_id != to_capability_id)`
- **Cycles A→B + B→A allowed**: Valid observations in different contexts
- **Warning log** if cycle in `contains` edges detected (logical paradox)
- Graphology handles cycles (PageRank converges, Dijkstra finds paths)

## Consequences

### Positive

- Type-safe capability relationships with proper foreign keys
- Clear semantic separation from tool dependencies
- Enables capability composition and orchestration
- `alternative` edge type enables fallback suggestions
- Consistent with existing edge type/source vocabulary

### Negative

- Additional table to maintain
- Slightly more complex graph loading

### Neutral

- API endpoints follow existing patterns (`/api/capabilities/:id/dependencies`)

## API Surface

```typescript
// CapabilityStore methods
async addDependency(input: CreateCapabilityDependencyInput): Promise<CapabilityDependency>
async updateDependency(fromId: string, toId: string, incrementBy?: number): Promise<void>
async getDependencies(capabilityId: string, direction: 'from' | 'to' | 'both'): Promise<CapabilityDependency[]>
async removeDependency(fromId: string, toId: string): Promise<void>
async searchByIntentWithDeps(intent: string, limit?: number): Promise<CapabilityWithDependencies[]>

// REST Endpoints
GET  /api/capabilities/:id/dependencies?direction=from|to|both
POST /api/capabilities/:id/dependencies  { to_capability_id, edge_type, edge_source? }
DELETE /api/capabilities/:from/dependencies/:to
```

## Related

- **ADR-041**: Hierarchical Trace Tracking (edge_type/edge_source origin)
- **ADR-042**: Capability Hyperedges (visualization)
- **Tech-Spec**: `docs/tech-specs/tech-spec-capability-dependency.md`
