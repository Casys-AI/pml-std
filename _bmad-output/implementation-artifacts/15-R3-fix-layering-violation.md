# Story 15.R3: Fix Layering Violation in Persistence

Status: done

## Story

As a **Rust developer**, I want **the engine module to use injected storage traits instead of importing `casys_storage_fs` directly**, so that **the hexagonal architecture is respected and storage adapters remain truly pluggable**.

## Acceptance Criteria

1. **AC1:** Remove direct import of `casys_storage_fs::catalog` from `casys_engine/src/index/persistence.rs`
2. **AC2:** `InMemoryGraphStore::flush_to_segments()` takes `&dyn SegmentStore` parameter instead of constructing paths internally
3. **AC3:** `InMemoryGraphStore::load_from_segments()` takes `&dyn SegmentStore` parameter for loading
4. **AC4:** Engine feature `fs` only enables optional convenience constructors (e.g., `flush_to_fs()` helper)
5. **AC5:** Unit tests use mock storage backend implementing `SegmentStore` trait
6. **AC6:** All existing tests pass (`cargo test --workspace` in `crates/`)

## Tasks / Subtasks

- [x] Task 1: Define path helper trait or use existing catalog abstraction (AC: #2, #3)
  - [x] 1.1: Analyze if `StorageCatalog::list_branches()` can provide path info or if new trait needed
  - [x] 1.2: Determine if `SegmentStore` trait needs extension for path resolution
  - [x] 1.3: Decide: inject paths directly OR inject catalog trait (Decision: Option C - inject path directly)

- [x] Task 2: Refactor flush_to_segments to accept trait (AC: #1, #2)
  - [x] 2.1: Change signature to `fn flush(&self, store: &dyn SegmentStore, root: &Path, db: &DatabaseName) -> Result<(), EngineError>`
  - [x] 2.2: Remove `use casys_storage_fs::catalog` import from main module (only in fs_convenience now)
  - [x] 2.3: Use `store.write_segment()` instead of file operations
  - [x] 2.4: Ensure nodes and edges serialized to segments correctly

- [x] Task 3: Refactor load_from_segments to accept trait (AC: #3)
  - [x] 3.1: Change signature to `fn load(store: &dyn SegmentStore, root: &Path, db: &DatabaseName) -> Result<Self, EngineError>`
  - [x] 3.2: Use `store.read_segment()` instead of file operations
  - [x] 3.3: Reconstruct indexes (label_index, adjacency_out, adjacency_in) from loaded data

- [x] Task 4: Add convenience feature flag for FS (AC: #4)
  - [x] 4.1: Feature `fs = ["casys_storage_fs"]` already exists in Cargo.toml
  - [x] 4.2: Create `#[cfg(feature = "fs")] mod fs_convenience;` with helpers like `flush_to_fs()`
  - [x] 4.3: FsSegmentStoreImpl instantiated internally by convenience methods

- [x] Task 5: Add mock tests for new API (AC: #5)
  - [x] 5.1: Create `MockSegmentStore` implementing `SegmentStore` trait
  - [x] 5.2: Write test for `flush()` with mock (verify write_segment called)
  - [x] 5.3: Write test for `load()` with mock (verify read_segment called)
  - [x] 5.4: Write round-trip test: flush → load → verify data integrity (7 tests total)

- [x] Task 6: Verify all tests pass (AC: #6)
  - [x] 6.1: Run `cargo test --workspace` in `crates/`
  - [x] 6.2: Fix any compilation errors from import changes
  - [x] 6.3: Verify 35 tests pass (14 graph_types + 7 mock + 12 value_ext + 1 wal_fs + 1 persistence_fs)

## Dev Notes

### Current State Analysis (VIOLATION)

The violation is at `crates/casys_engine/src/index/persistence.rs:7`:

```rust
// VIOLATION - engine depends on concrete adapter
use casys_storage_fs::catalog;
```

This import is used in two places:
1. `flush_to_segments()` at line 108: `catalog::branch_dir(root, db, branch).join("segments")`
2. `load_from_segments()` at line 180: same path construction

### Traits Already Available in casys_core

The good news: `casys_core` already defines the necessary traits (lines 94-115):

```rust
pub trait SegmentStore: Send + Sync + 'static {
    fn write_segment(&self, root: &Path, db: &DatabaseName, segment_id: &SegmentId, data: &[u8], node_count: u64, edge_count: u64) -> Result<(), EngineError>;
    fn read_segment(&self, root: &Path, db: &DatabaseName, segment_id: &SegmentId) -> Result<(Vec<u8>, u64, u64), EngineError>;
}
```

### Key Insight: SegmentStore vs Path Construction

The current code does TWO things that need separation:
1. **Path construction** (branch_dir → segments) - This is catalog logic
2. **File I/O** (write_all, read_to_end) - This should use SegmentStore

**Options:**
- **Option A:** Extend `SegmentStore` to handle branch-aware segment paths internally
- **Option B:** Add `branch: &BranchName` parameter to SegmentStore methods
- **Option C:** Inject path directly (simplest, less abstraction)

**Recommendation:** Option B - Aligns with `ManifestStore` pattern which already has branch parameter.

### Proposed Refactored API

```rust
// Before (violation)
impl InMemoryGraphStore {
    pub fn flush_to_segments(&self, root: &Path, db: &DatabaseName, branch: &BranchName) -> Result<(), EngineError>
}

// After (hexagonal)
impl InMemoryGraphStore {
    pub fn flush(&self, store: &dyn SegmentStore, root: &Path, db: &DatabaseName, branch: &BranchName) -> Result<(), EngineError>
}

// Optional FS convenience (gated by feature)
#[cfg(feature = "fs")]
impl InMemoryGraphStore {
    pub fn flush_to_fs(&self, root: &Path, db: &DatabaseName, branch: &BranchName) -> Result<(), EngineError> {
        let fs_store = casys_storage_fs::FsSegmentStore::new();
        self.flush(&fs_store, root, db, branch)
    }
}
```

### SegmentStore May Need Branch Parameter

Current `SegmentStore::write_segment()` doesn't have `branch` parameter. Two options:

1. **Add branch to SegmentStore trait** (breaking change but cleaner)
2. **Use composite SegmentId that encodes branch** (workaround)

Check `casys_storage_fs/src/segments.rs` for current implementation details.

### Architecture Compliance

- **Hexagonal Architecture:** Engine (core) should not know about FS adapter
- **Dependency Inversion:** Depend on abstraction (trait), not concretion (casys_storage_fs)
- **Port/Adapter Pattern:** `SegmentStore` is the port, `FsSegmentStore` is the adapter

### Previous Story Learnings (15.R2)

From 15.R2 code review:
- Re-exports from core maintain backward compatibility
- Tests should cover new trait implementations
- Keep file list accurate in completion notes
- Document any breaking API changes

### Git Recent Patterns

Recent commits show:
- `ea3915dd`: 15.R1 + 15.R2 refactoring pattern (same epic)
- `ce7c3111`: Review fixes included additional tests
- Pattern: Add tests during refactoring, not after

### Testing Strategy

1. **Mock SegmentStore** - For unit tests without FS dependency
2. **In-memory store** - Track calls to `write_segment`/`read_segment`
3. **Round-trip test** - Verify data integrity through serialize/deserialize

```rust
struct MockSegmentStore {
    segments: std::cell::RefCell<HashMap<SegmentId, Vec<u8>>>,
}

impl SegmentStore for MockSegmentStore {
    fn write_segment(&self, _root: &Path, _db: &DatabaseName, segment_id: &SegmentId, data: &[u8], _nc: u64, _ec: u64) -> Result<(), EngineError> {
        self.segments.borrow_mut().insert(segment_id.clone(), data.to_vec());
        Ok(())
    }

    fn read_segment(&self, _root: &Path, _db: &DatabaseName, segment_id: &SegmentId) -> Result<(Vec<u8>, u64, u64), EngineError> {
        self.segments.borrow()
            .get(segment_id)
            .map(|d| (d.clone(), 0, 0))
            .ok_or_else(|| EngineError::NotFound(segment_id.0.clone()))
    }
}
```

### Files to Modify

| File | Action |
|------|--------|
| `crates/casys_engine/src/index/persistence.rs` | Refactor to use injected trait |
| `crates/casys_engine/Cargo.toml` | Add optional `fs` feature |
| `crates/casys_core/src/lib.rs` | May need to extend SegmentStore with branch param |
| `crates/casys_engine/src/index/mod.rs` | Update re-exports if needed |
| `crates/casys_engine/tests/persistence_test.rs` | Add mock-based tests |

### Potential Challenges

1. **SegmentStore branch parameter** - May require trait modification
2. **Backward compatibility** - Existing code uses `flush_to_segments` directly
3. **Path construction** - Need to abstract or inject segment paths

### References

- [Source: crates/casys_engine/src/index/persistence.rs:7] - Current violation
- [Source: crates/casys_core/src/lib.rs:94-97] - SegmentStore trait
- [Source: crates/casys_storage_fs/src/catalog.rs:14] - branch_dir function
- [Source: docs/sprint-artifacts/15-R2-move-graph-types-to-core.md] - Previous story learnings
- [Source: docs/epics/epic-15-casysdb-native-engine.md#Story 15.R3] - Epic reference

### Project Structure After Refactoring

```
crates/
  casys_core/
    src/lib.rs          # SegmentStore trait (may add branch param)
  casys_engine/
    src/
      index/
        mod.rs          # Re-exports from core + InMemoryGraphStore impl
        persistence.rs  # Uses SegmentStore trait (NO casys_storage_fs import)
        fs_convenience.rs # Optional: #[cfg(feature = "fs")] helpers
    Cargo.toml          # [features] fs = ["casys_storage_fs"]
  casys_storage_fs/
    src/
      segments.rs       # FsSegmentStore implements SegmentStore
```

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

None - implementation proceeded without issues.

### Completion Notes List

1. **Architecture Decision**: Chose Option C (inject path directly) instead of Option B from Dev Notes because:
   - SegmentStore trait already exists in casys_core with appropriate signature
   - No trait modification needed - simpler and non-breaking
   - Caller constructs the segments_root path from branch info

2. **API Changes**:
   - `flush_to_segments()` → `flush(&dyn SegmentStore, &Path, &DatabaseName)` - trait-based, hexagonal
   - `load_from_segments()` → `load(&dyn SegmentStore, &Path, &DatabaseName)` - trait-based, hexagonal
   - `flush_to_fs()` / `load_from_fs()` - convenience methods gated by `#[cfg(feature = "fs")]`

3. **Violation Fixed**:
   - `use casys_storage_fs::catalog` removed from main persistence module
   - Only used inside `#[cfg(feature = "fs")] mod fs_convenience` block
   - Engine module no longer has unconditional dependency on storage adapter

4. **Tests Added**: 7 new tests in `persistence_mock.rs`:
   - `flush_calls_write_segment` - verifies mock receives write calls
   - `load_calls_read_segment` - verifies mock receives read calls
   - `roundtrip_data_integrity` - full node/edge/property preservation
   - `load_empty_store_returns_empty_graph` - handles NotFound gracefully
   - `roundtrip_preserves_node_ids` - ID stability after reload
   - `roundtrip_rebuilds_adjacency_indexes` - incoming/outgoing edges
   - `roundtrip_rebuilds_label_index` - scan_by_label works

5. **Backward Compatibility**:
   - Engine API `flush_branch()` and `load_branch()` updated internally
   - External callers using Engine API see no change
   - `#[cfg(feature = "fs")]` gates FS convenience for those needing direct access

### File List

| File | Action |
|------|--------|
| `crates/casys_engine/src/index/persistence.rs` | Modified - refactored to use SegmentStore trait |
| `crates/casys_engine/src/index/mod.rs` | Modified - removed `#[cfg(feature = "fs")]` gate, added docs |
| `crates/casys_engine/src/lib.rs` | Modified - updated to call flush_to_fs/load_from_fs |
| `crates/casys_engine/tests/persistence_mock.rs` | Created - 7 new mock-based unit tests |

### Change Log

- 2026-01-03: Story 15.R3 implemented - fixed layering violation, 35 tests passing
- 2026-01-03: Code review fixes applied:
  - M1: Changed `.unwrap()` to `.expect("descriptive message")` in MockSegmentStore (test reliability)
  - M2: Added documentation for FsBackend usage as alternative to convenience methods
  - M3: Enhanced doc comments with `# Errors` sections and usage guidance
  - L1: Renamed `NODES_SEGMENT_ID`/`EDGES_SEGMENT_ID` to `NODE_SEGMENT_ID`/`EDGE_SEGMENT_ID`
  - L2: Added `#[must_use]` attribute to `load()` method
