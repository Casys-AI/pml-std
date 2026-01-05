# Story 15.1: SET Clause Support

Status: in-progress

## Story

As a **graph database user**, I want **to update properties on existing nodes and edges using SET clause**, so that **I can modify embeddings, counters, and other mutable data without recreating entities**.

## Context

Currently CasysDB only supports:
- `CREATE` - Insert new nodes/edges
- `MATCH` - Read existing data

Without `SET`, there's no way to update existing data, which is critical for:
- Updating embeddings after Node2Vec training
- Incrementing counters (usage stats, scores)
- Modifying metadata (timestamps, status flags)

## Acceptance Criteria

1. **AC1:** Parser recognizes `SET` keyword after MATCH clause
2. **AC2:** Support `SET n.prop = value` syntax for single property updates
3. **AC3:** Support `SET n.prop1 = val1, n.prop2 = val2` for multiple properties
4. **AC4:** Support `SET n += {prop1: val1, prop2: val2}` for bulk property merge
5. **AC5:** Support `SET n.prop = $param` with parameterized values
6. **AC6:** GraphWriteStore trait extended with `update_node_properties()` method
7. **AC7:** InMemoryGraphStore implements property updates
8. **AC8:** Persistence correctly saves updated properties on flush
9. **AC9:** At least 10 unit tests covering SET scenarios
10. **AC10:** All existing tests continue to pass

## Tasks / Subtasks

- [ ] Task 1: Extend AST with SetClause (AC: #1)
  - [ ] 1.1: Add `SetClause` struct to ast.rs
  - [ ] 1.2: Add `SetItem` enum (PropertySet, PropertyMerge)
  - [ ] 1.3: Add `set_clause: Option<SetClause>` to Query struct

- [ ] Task 2: Extend Parser to handle SET (AC: #1, #2, #3, #4, #5)
  - [ ] 2.1: Add Token::Set to lexer (already exists, verify)
  - [ ] 2.2: Implement `parse_set()` method
  - [ ] 2.3: Handle `n.prop = expr` syntax
  - [ ] 2.4: Handle `n += {props}` merge syntax
  - [ ] 2.5: Support comma-separated multiple SET items

- [ ] Task 3: Extend GraphWriteStore trait (AC: #6)
  - [ ] 3.1: Add `update_node_properties(&mut self, id: NodeId, props: HashMap<String, Value>) -> Result<(), EngineError>`
  - [ ] 3.2: Add `update_edge_properties(&mut self, id: EdgeId, props: HashMap<String, Value>) -> Result<(), EngineError>`

- [ ] Task 4: Implement in InMemoryGraphStore (AC: #7)
  - [ ] 4.1: Implement `update_node_properties` - merge props into existing node
  - [ ] 4.2: Implement `update_edge_properties` - merge props into existing edge
  - [ ] 4.3: Handle case where node/edge doesn't exist (return error)

- [ ] Task 5: Extend Planner with SetNode (AC: #1)
  - [ ] 5.1: Add `PlanNode::Set { input: Box<PlanNode>, items: Vec<SetItem> }`
  - [ ] 5.2: Planner generates Set node after Match when set_clause present

- [ ] Task 6: Extend Executor to execute SET (AC: #2, #3, #4, #5)
  - [ ] 6.1: Add `execute_set()` method
  - [ ] 6.2: For each matched tuple, extract node/edge ID from variable
  - [ ] 6.3: Evaluate RHS expressions (including parameters)
  - [ ] 6.4: Call `update_node_properties` on write store

- [ ] Task 7: Add unit tests (AC: #9)
  - [ ] 7.1: Test basic SET single property
  - [ ] 7.2: Test SET multiple properties
  - [ ] 7.3: Test SET with property merge (+=)
  - [ ] 7.4: Test SET with parameters
  - [ ] 7.5: Test SET on edges
  - [ ] 7.6: Test SET updates persist after flush/load
  - [ ] 7.7: Test SET on non-existent node returns error
  - [ ] 7.8: Test SET with WHERE filter
  - [ ] 7.9: Test SET followed by RETURN
  - [ ] 7.10: Test SET array/map property types

- [ ] Task 8: Verify persistence (AC: #8, #10)
  - [ ] 8.1: Run existing persistence tests
  - [ ] 8.2: Add test: SET then flush, load, verify updated values

## Dev Notes

### GQL SET Syntax (ISO GQL / Cypher)

```cypher
-- Single property
MATCH (n:Person {id: 'alice'})
SET n.age = 30

-- Multiple properties
MATCH (n:Person {id: 'alice'})
SET n.age = 30, n.updated_at = 1704067200

-- Property merge (adds/overwrites without removing existing)
MATCH (n:Person {id: 'alice'})
SET n += {age: 30, city: 'Paris'}

-- With parameter
MATCH (n:Capability {id: $capId})
SET n.embedding = $embedding
```

### Implementation Strategy

1. **AST Changes** (ast.rs):
```rust
pub struct SetClause {
    pub items: Vec<SetItem>,
}

pub enum SetItem {
    Property {
        variable: String,
        property: String,
        value: Expr,
    },
    Merge {
        variable: String,
        properties: HashMap<String, Expr>,
    },
}
```

2. **Trait Extension** (casys_core/src/lib.rs):
```rust
pub trait GraphWriteStore: GraphReadStore {
    // existing methods...
    fn update_node_properties(&mut self, id: NodeId, props: HashMap<String, Value>) -> Result<(), EngineError>;
    fn update_edge_properties(&mut self, id: EdgeId, props: HashMap<String, Value>) -> Result<(), EngineError>;
}
```

3. **Executor Logic**:
- After MATCH produces tuples with bound variables
- For each tuple, extract the node ID from the variable binding
- Evaluate the SET expressions
- Call update_node_properties with the new values

### Edge Cases

- SET on variable that doesn't exist in MATCH → Error
- SET property to NULL → Remove property or set to null?
- SET on multiple nodes (MATCH returns many) → Update all
- SET without MATCH → Error (nothing to update)

### Files to Modify

| File | Action |
|------|--------|
| `crates/casys_engine/src/exec/ast.rs` | Add SetClause, SetItem |
| `crates/casys_engine/src/exec/parser.rs` | Add parse_set() |
| `crates/casys_core/src/lib.rs` | Extend GraphWriteStore trait |
| `crates/casys_engine/src/index/mod.rs` | Implement update methods |
| `crates/casys_engine/src/exec/planner.rs` | Add PlanNode::Set |
| `crates/casys_engine/src/exec/executor.rs` | Add execute_set() |
| `crates/casys_engine/tests/set_clause.rs` | New test file |

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Completion Notes List

(To be filled during implementation)

### File List

(To be filled during implementation)

### Change Log

- 2026-01-03: Story created, moved to Phase 1 as prerequisite for embeddings
