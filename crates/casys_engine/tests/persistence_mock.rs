//! Unit tests for persistence using MockSegmentStore
//!
//! These tests verify the trait-based persistence API (AC5) works correctly
//! without requiring the `fs` feature. The MockSegmentStore tracks all segment
//! operations in memory.

use casys_engine as engine;
use casys_core::{DatabaseName, EngineError, SegmentId, SegmentStore};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::convert::TryFrom;

/// Mock segment store that tracks all operations in memory
struct MockSegmentStore {
    segments: Mutex<HashMap<String, Vec<u8>>>,
    write_count: Mutex<u32>,
    read_count: Mutex<u32>,
}

impl MockSegmentStore {
    fn new() -> Self {
        Self {
            segments: Mutex::new(HashMap::new()),
            write_count: Mutex::new(0),
            read_count: Mutex::new(0),
        }
    }

    fn get_write_count(&self) -> u32 {
        *self.write_count.lock().expect("write_count mutex poisoned")
    }

    fn get_read_count(&self) -> u32 {
        *self.read_count.lock().expect("read_count mutex poisoned")
    }

    fn has_segment(&self, segment_id: &str) -> bool {
        self.segments.lock().expect("segments mutex poisoned").contains_key(segment_id)
    }
}

impl SegmentStore for MockSegmentStore {
    fn write_segment(
        &self,
        _root: &Path,
        _db: &DatabaseName,
        segment_id: &SegmentId,
        data: &[u8],
        _node_count: u64,
        _edge_count: u64,
    ) -> Result<(), EngineError> {
        let mut segments = self.segments.lock().expect("segments mutex poisoned");
        segments.insert(segment_id.0.clone(), data.to_vec());
        *self.write_count.lock().expect("write_count mutex poisoned") += 1;
        Ok(())
    }

    fn read_segment(
        &self,
        _root: &Path,
        _db: &DatabaseName,
        segment_id: &SegmentId,
    ) -> Result<(Vec<u8>, u64, u64), EngineError> {
        let segments = self.segments.lock().expect("segments mutex poisoned");
        *self.read_count.lock().expect("read_count mutex poisoned") += 1;
        segments
            .get(&segment_id.0)
            .map(|d| (d.clone(), 0, 0))
            .ok_or_else(|| EngineError::NotFound(segment_id.0.clone()))
    }
}

/// Test that flush() calls write_segment for nodes and edges (AC2, AC5)
#[test]
fn flush_calls_write_segment() {
    let store = MockSegmentStore::new();
    let mut graph = engine::index::InMemoryGraphStore::new();

    // Add some data to the graph
    use casys_core::GraphWriteStore;
    graph.add_node(vec!["Person".to_string()], HashMap::new()).unwrap();
    graph.add_node(vec!["Person".to_string()], HashMap::new()).unwrap();
    graph.add_edge(1, 2, "KNOWS".to_string(), HashMap::new()).unwrap();

    // Flush using the mock store
    let root = Path::new("/fake/root");
    let db = DatabaseName::try_from("testdb").unwrap();

    graph.flush(&store, root, &db).unwrap();

    // Verify write_segment was called for nodes and edges
    assert_eq!(store.get_write_count(), 2, "Should write 2 segments (nodes, edges)");
    assert!(store.has_segment("nodes"), "Should have nodes segment");
    assert!(store.has_segment("edges"), "Should have edges segment");
}

/// Test that load() calls read_segment for nodes and edges (AC3, AC5)
#[test]
fn load_calls_read_segment() {
    let store = MockSegmentStore::new();
    let mut graph = engine::index::InMemoryGraphStore::new();

    // Add data and flush first
    use casys_core::GraphWriteStore;
    graph.add_node(vec!["Person".to_string()], HashMap::new()).unwrap();

    let root = Path::new("/fake/root");
    let db = DatabaseName::try_from("testdb").unwrap();

    graph.flush(&store, root, &db).unwrap();

    // Reset read count
    *store.read_count.lock().unwrap() = 0;

    // Load from the mock store
    let _loaded = engine::index::InMemoryGraphStore::load(&store, root, &db).unwrap();

    // Verify read_segment was called
    assert_eq!(store.get_read_count(), 2, "Should read 2 segments (nodes, edges)");
}

/// Test round-trip: flush then load preserves data integrity (AC5)
#[test]
fn roundtrip_data_integrity() {
    let store = MockSegmentStore::new();
    let mut graph = engine::index::InMemoryGraphStore::new();

    // Add some nodes and edges
    use casys_core::{GraphWriteStore, GraphReadStore};
    let mut props = HashMap::new();
    props.insert("name".to_string(), casys_core::Value::String("Alice".to_string()));
    let id1 = graph.add_node(vec!["Person".to_string()], props).unwrap();

    let mut props2 = HashMap::new();
    props2.insert("name".to_string(), casys_core::Value::String("Bob".to_string()));
    let id2 = graph.add_node(vec!["Person".to_string()], props2).unwrap();

    let mut edge_props = HashMap::new();
    edge_props.insert("since".to_string(), casys_core::Value::Int(2020));
    graph.add_edge(id1, id2, "KNOWS".to_string(), edge_props).unwrap();

    // Flush
    let root = Path::new("/fake/root");
    let db = DatabaseName::try_from("testdb").unwrap();
    graph.flush(&store, root, &db).unwrap();

    // Load into a new graph
    let loaded = engine::index::InMemoryGraphStore::load(&store, root, &db).unwrap();

    // Verify nodes are preserved
    let all_nodes = loaded.scan_all().unwrap();
    assert_eq!(all_nodes.len(), 2, "Should have 2 nodes");

    // Verify node properties
    let alice = loaded.get_node(id1).unwrap().unwrap();
    assert!(alice.labels.contains(&"Person".to_string()));
    assert_eq!(alice.properties.get("name"), Some(&casys_core::Value::String("Alice".to_string())));

    let bob = loaded.get_node(id2).unwrap().unwrap();
    assert_eq!(bob.properties.get("name"), Some(&casys_core::Value::String("Bob".to_string())));

    // Verify edges are preserved
    let neighbors = loaded.get_neighbors(id1, Some("KNOWS")).unwrap();
    assert_eq!(neighbors.len(), 1, "Should have 1 edge");
    let (edge, target) = &neighbors[0];
    assert_eq!(edge.edge_type, "KNOWS");
    assert_eq!(edge.properties.get("since"), Some(&casys_core::Value::Int(2020)));
    assert_eq!(target.id, id2);
}

/// Test load on empty store returns empty graph (AC3)
#[test]
fn load_empty_store_returns_empty_graph() {
    let store = MockSegmentStore::new();

    let root = Path::new("/fake/root");
    let db = DatabaseName::try_from("testdb").unwrap();

    // Load from store that has no segments (returns NotFound)
    let loaded = engine::index::InMemoryGraphStore::load(&store, root, &db).unwrap();

    use casys_core::GraphReadStore;
    let nodes = loaded.scan_all().unwrap();
    assert_eq!(nodes.len(), 0, "Empty store should produce empty graph");
}

/// Test flush preserves node IDs across roundtrip (AC5)
#[test]
fn roundtrip_preserves_node_ids() {
    let store = MockSegmentStore::new();
    let mut graph = engine::index::InMemoryGraphStore::new();

    use casys_core::{GraphWriteStore, GraphReadStore};

    // Create nodes with specific properties
    let id1 = graph.add_node(vec!["A".to_string()], HashMap::new()).unwrap();
    let id2 = graph.add_node(vec!["B".to_string()], HashMap::new()).unwrap();
    let id3 = graph.add_node(vec!["C".to_string()], HashMap::new()).unwrap();

    let root = Path::new("/fake/root");
    let db = DatabaseName::try_from("testdb").unwrap();
    graph.flush(&store, root, &db).unwrap();

    let loaded = engine::index::InMemoryGraphStore::load(&store, root, &db).unwrap();

    // Verify IDs are preserved
    assert!(loaded.get_node(id1).unwrap().is_some());
    assert!(loaded.get_node(id2).unwrap().is_some());
    assert!(loaded.get_node(id3).unwrap().is_some());

    // Verify labels correspond to IDs
    let node1 = loaded.get_node(id1).unwrap().unwrap();
    assert!(node1.labels.contains(&"A".to_string()));

    let node2 = loaded.get_node(id2).unwrap().unwrap();
    assert!(node2.labels.contains(&"B".to_string()));

    let node3 = loaded.get_node(id3).unwrap().unwrap();
    assert!(node3.labels.contains(&"C".to_string()));
}

/// Test that adjacency indexes are rebuilt correctly on load (AC3)
#[test]
fn roundtrip_rebuilds_adjacency_indexes() {
    let store = MockSegmentStore::new();
    let mut graph = engine::index::InMemoryGraphStore::new();

    use casys_core::{GraphWriteStore, GraphReadStore};

    let id1 = graph.add_node(vec!["A".to_string()], HashMap::new()).unwrap();
    let id2 = graph.add_node(vec!["B".to_string()], HashMap::new()).unwrap();
    let id3 = graph.add_node(vec!["C".to_string()], HashMap::new()).unwrap();

    // Create edges: A -> B, A -> C, B -> C
    graph.add_edge(id1, id2, "LINK".to_string(), HashMap::new()).unwrap();
    graph.add_edge(id1, id3, "LINK".to_string(), HashMap::new()).unwrap();
    graph.add_edge(id2, id3, "LINK".to_string(), HashMap::new()).unwrap();

    let root = Path::new("/fake/root");
    let db = DatabaseName::try_from("testdb").unwrap();
    graph.flush(&store, root, &db).unwrap();

    let loaded = engine::index::InMemoryGraphStore::load(&store, root, &db).unwrap();

    // Verify outgoing neighbors
    let out1 = loaded.get_neighbors(id1, None).unwrap();
    assert_eq!(out1.len(), 2, "Node A should have 2 outgoing edges");

    let out2 = loaded.get_neighbors(id2, None).unwrap();
    assert_eq!(out2.len(), 1, "Node B should have 1 outgoing edge");

    let out3 = loaded.get_neighbors(id3, None).unwrap();
    assert_eq!(out3.len(), 0, "Node C should have 0 outgoing edges");

    // Verify incoming neighbors
    let in3 = loaded.get_neighbors_incoming(id3, None).unwrap();
    assert_eq!(in3.len(), 2, "Node C should have 2 incoming edges");
}

/// Test that label index is rebuilt correctly on load (AC3)
#[test]
fn roundtrip_rebuilds_label_index() {
    let store = MockSegmentStore::new();
    let mut graph = engine::index::InMemoryGraphStore::new();

    use casys_core::{GraphWriteStore, GraphReadStore};

    // Create nodes with different labels
    graph.add_node(vec!["Person".to_string()], HashMap::new()).unwrap();
    graph.add_node(vec!["Person".to_string()], HashMap::new()).unwrap();
    graph.add_node(vec!["Company".to_string()], HashMap::new()).unwrap();

    let root = Path::new("/fake/root");
    let db = DatabaseName::try_from("testdb").unwrap();
    graph.flush(&store, root, &db).unwrap();

    let loaded = engine::index::InMemoryGraphStore::load(&store, root, &db).unwrap();

    // Verify label index
    let persons = loaded.scan_by_label("Person").unwrap();
    assert_eq!(persons.len(), 2, "Should find 2 Person nodes");

    let companies = loaded.scan_by_label("Company").unwrap();
    assert_eq!(companies.len(), 1, "Should find 1 Company node");

    let others = loaded.scan_by_label("Other").unwrap();
    assert_eq!(others.len(), 0, "Should find 0 Other nodes");
}
