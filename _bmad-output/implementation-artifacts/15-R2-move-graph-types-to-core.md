# Story 15.R2: Move Graph Types to Core

Status: done

## Story

As a **Rust developer**, I want **`Node`, `Edge`, `GraphReadStore`, and `GraphWriteStore` types moved from `casys_engine/src/index/mod.rs` to `casys_core`**, so that **storage adapters can depend only on core without circular dependency with engine**.

## Acceptance Criteria

1. **AC1:** `Node` struct with `id: NodeId`, `labels: Vec<String>`, `properties: HashMap<String, Value>` defined in `casys_core`
2. **AC2:** `Edge` struct with `id: EdgeId`, `from_node: NodeId`, `to_node: NodeId`, `edge_type: String`, `properties: HashMap<String, Value>` defined in `casys_core`
3. **AC3:** `GraphReadStore` trait defined in `casys_core` with methods: `scan_all`, `scan_by_label`, `get_node`, `get_neighbors`, `get_neighbors_incoming`
4. **AC4:** `GraphWriteStore` trait (extends GraphReadStore) defined in `casys_core` with methods: `add_node`, `add_edge`
5. **AC5:** `casys_engine::index` re-exports these types from `casys_core` (backward compatibility)
6. **AC6:** All existing tests pass without modification (`cargo test --workspace` in `crates/`)
7. **AC7:** No duplicate type definitions remain in `casys_engine`

## Tasks / Subtasks

- [x] Task 1: Add Node and Edge structs to casys_core (AC: #1, #2)
  - [x] 1.1: Add `use std::collections::HashMap;` import to casys_core/src/lib.rs
  - [x] 1.2: Add `Node` struct definition with `#[derive(Debug, Clone)]`
  - [x] 1.3: Add `Edge` struct definition with `#[derive(Debug, Clone)]`

- [x] Task 2: Add GraphReadStore trait to casys_core (AC: #3)
  - [x] 2.1: Define `GraphReadStore` trait with all 5 methods
  - [x] 2.2: Ensure trait returns `Result<_, EngineError>` (EngineError already in core)

- [x] Task 3: Add GraphWriteStore trait to casys_core (AC: #4)
  - [x] 3.1: Define `GraphWriteStore: GraphReadStore` trait
  - [x] 3.2: Add `add_node` and `add_edge` methods

- [x] Task 4: Update casys_engine to re-export from core (AC: #5, #7)
  - [x] 4.1: Add re-exports in `casys_engine/src/index/mod.rs`: `pub use casys_core::{Node, Edge, GraphReadStore, GraphWriteStore};`
  - [x] 4.2: Remove duplicate `Node` struct from `index/mod.rs`
  - [x] 4.3: Remove duplicate `Edge` struct from `index/mod.rs`
  - [x] 4.4: Remove duplicate `GraphReadStore` trait from `index/mod.rs`
  - [x] 4.5: Remove duplicate `GraphWriteStore` trait from `index/mod.rs`

- [x] Task 5: Verify and run tests (AC: #6)
  - [x] 5.1: Run `cargo test --workspace` in `crates/` directory
  - [x] 5.2: Fix any compilation errors from import changes
  - [x] 5.3: Verify all 14+ tests pass

## Dev Notes

### Current State Analysis

The types to move are currently defined in `casys_engine/src/index/mod.rs:11-40`:

```rust
// Current location: casys_engine/src/index/mod.rs
#[derive(Debug, Clone)]
pub struct Node {
    pub id: NodeId,
    pub labels: Vec<String>,
    pub properties: HashMap<String, Value>,
}

#[derive(Debug, Clone)]
pub struct Edge {
    pub id: EdgeId,
    pub from_node: NodeId,
    pub to_node: NodeId,
    pub edge_type: String,
    pub properties: HashMap<String, Value>,
}

pub trait GraphReadStore {
    fn scan_all(&self) -> Result<Vec<Node>, EngineError>;
    fn scan_by_label(&self, label: &str) -> Result<Vec<Node>, EngineError>;
    fn get_node(&self, id: NodeId) -> Result<Option<Node>, EngineError>;
    fn get_neighbors(&self, node_id: NodeId, edge_type: Option<&str>) -> Result<Vec<(Edge, Node)>, EngineError>;
    fn get_neighbors_incoming(&self, node_id: NodeId, edge_type: Option<&str>) -> Result<Vec<(Edge, Node)>, EngineError>;
}

pub trait GraphWriteStore: GraphReadStore {
    fn add_node(&mut self, labels: Vec<String>, properties: HashMap<String, Value>) -> Result<NodeId, EngineError>;
    fn add_edge(&mut self, from: NodeId, to: NodeId, edge_type: String, properties: HashMap<String, Value>) -> Result<EdgeId, EngineError>;
}
```

### Dependencies Already in casys_core

The following are already available in `casys_core/src/lib.rs`:
- `NodeId` (line 1): `pub type NodeId = u64;`
- `EdgeId` (line 2): `pub type EdgeId = u64;`
- `Value` (lines 4-15): Full enum with NodeId variant (from Story 15.R1)
- `EngineError` (lines 158-170): Error enum for Result types

### Why This Refactoring Matters

**Current Problem (Layering Violation):**
```
casys_storage_fs → casys_engine (for Node, Edge types)
casys_engine → casys_storage_fs (for FsBackend storage)
```
This creates a circular dependency risk.

**Target Architecture:**
```
casys_storage_* → casys_core (for Node, Edge, GraphReadStore, GraphWriteStore)
casys_engine → casys_core (for same types)
casys_engine → casys_storage_* (for storage implementations)
```
Clean hexagonal architecture with core as the dependency-free center.

### Files to Modify

| File | Action |
|------|--------|
| `casys_core/src/lib.rs` | Add Node, Edge structs + GraphReadStore, GraphWriteStore traits |
| `casys_engine/src/index/mod.rs` | Replace definitions with re-exports |

### No Breaking Changes

- All public types remain accessible via `casys_engine::index::{Node, Edge, GraphReadStore, GraphWriteStore}`
- `InMemoryGraphStore` implementation stays in engine (it's the concrete impl)
- Persistence module stays in engine (uses the traits)

### Architecture Compliance

- **Hexagonal Architecture:** Domain types (Node, Edge) and ports (GraphReadStore, GraphWriteStore) belong in core
- **Dependency Direction:** Storage adapters should only depend on core, not engine
- **Story 15.R3 Prep:** This unblocks removing the `casys_storage_fs` import from engine

### Project Structure After Refactoring

```
crates/
  casys_core/
    src/lib.rs          # NodeId, EdgeId, Value, Node, Edge, GraphReadStore, GraphWriteStore
  casys_engine/
    src/
      index/
        mod.rs          # Re-exports from core + InMemoryGraphStore impl
        persistence.rs  # Uses traits from core (via re-export)
      exec/
        executor.rs     # Uses traits from index (unchanged)
```

### Previous Story Learnings (15.R1)

From 15.R1 code review:
- Always add comprehensive tests for new/moved code
- Use extension traits for serde functionality not in core
- Keep core minimal - no serde_json dependency in core
- Document file changes in completion notes

### Testing Requirements

- Run `cargo test --workspace` from `crates/` directory
- Minimum 14 tests should pass (existing test count from 15.R1)
- No test modification required (API backward compatible)

### References

- [Source: crates/casys_core/src/lib.rs] - Current core types
- [Source: crates/casys_engine/src/index/mod.rs] - Types to move
- [Source: docs/sprint-artifacts/15-R1-unify-value-types.md] - Previous story learnings
- [Source: docs/epic-15-casysdb-native-engine.md#Story 15.R2] - Epic reference

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

N/A - No debug issues encountered

### Completion Notes List

- **2026-01-03:** Story 15.R2 implementation complete
  - Added `Node` and `Edge` structs to casys_core with proper documentation
  - Added `GraphReadStore` and `GraphWriteStore` traits to casys_core
  - casys_engine now re-exports all types from core (backward compatibility preserved)
  - All 28 tests pass: 14 graph_types + 12 value_ext + 1 persistence_fs + 1 wal_fs
  - No duplicate type definitions remain in casys_engine
  - Architecture follows hexagonal pattern: domain types in core, implementations in engine
- **2026-01-03:** Code Review fixes applied
  - Updated File List to include 3 additional modified files (executor.rs, persistence.rs, lib.rs)
  - Added 14 unit tests for Node, Edge, GraphReadStore, GraphWriteStore in casys_core/tests/graph_types.rs
  - Note: casys_storage_fs import in persistence.rs is a known layering violation addressed by Story 15.R3

### File List

| File | Change Type |
|------|-------------|
| crates/casys_core/src/lib.rs | Modified - Added HashMap import, Node/Edge structs, GraphReadStore/GraphWriteStore traits |
| crates/casys_engine/src/index/mod.rs | Modified - Replaced local definitions with re-exports from casys_core |
| crates/casys_engine/src/exec/executor.rs | Modified - Re-export Value from casys_core (unified type) |
| crates/casys_engine/src/index/persistence.rs | Modified - Import NodeId/EdgeId from casys_core |
| crates/casys_engine/src/lib.rs | Modified - Re-export casys_core::Value as canonical Value type |
| crates/casys_core/tests/graph_types.rs | Added - Unit tests for Node, Edge, GraphReadStore, GraphWriteStore |

### Change Log

- **2026-01-03:** Moved graph types to core (Story 15.R2)
  - Node, Edge structs moved to casys_core
  - GraphReadStore, GraphWriteStore traits moved to casys_core
  - casys_engine::index now re-exports from casys_core
  - InMemoryGraphStore implementation remains in engine (correct layering)
- **2026-01-03:** Code Review APPROVED
  - File List updated with 3 additional files (executor.rs, persistence.rs, lib.rs)
  - Added 14 unit tests for graph types in casys_core/tests/graph_types.rs
  - Total tests: 28 passing

