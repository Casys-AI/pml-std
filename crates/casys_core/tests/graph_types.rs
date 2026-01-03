//! Unit tests for graph domain types moved to casys_core (Story 15.R2)

use casys_core::{Node, Edge, GraphReadStore, GraphWriteStore, Value, NodeId, EdgeId, EngineError};
use std::collections::HashMap;

// =============================================================================
// Node struct tests
// =============================================================================

#[test]
fn test_node_creation() {
    let mut props = HashMap::new();
    props.insert("name".to_string(), Value::String("Alice".to_string()));
    props.insert("age".to_string(), Value::Int(30));

    let node = Node {
        id: 1,
        labels: vec!["Person".to_string(), "Employee".to_string()],
        properties: props,
    };

    assert_eq!(node.id, 1);
    assert_eq!(node.labels.len(), 2);
    assert!(node.labels.contains(&"Person".to_string()));
    assert_eq!(node.properties.get("name"), Some(&Value::String("Alice".to_string())));
}

#[test]
fn test_node_clone() {
    let node = Node {
        id: 42,
        labels: vec!["Test".to_string()],
        properties: HashMap::new(),
    };

    let cloned = node.clone();
    assert_eq!(cloned.id, node.id);
    assert_eq!(cloned.labels, node.labels);
}

#[test]
fn test_node_debug() {
    let node = Node {
        id: 1,
        labels: vec![],
        properties: HashMap::new(),
    };

    let debug_str = format!("{:?}", node);
    assert!(debug_str.contains("Node"));
    assert!(debug_str.contains("id: 1"));
}

// =============================================================================
// Edge struct tests
// =============================================================================

#[test]
fn test_edge_creation() {
    let mut props = HashMap::new();
    props.insert("weight".to_string(), Value::Float(0.5));

    let edge = Edge {
        id: 100,
        from_node: 1,
        to_node: 2,
        edge_type: "KNOWS".to_string(),
        properties: props,
    };

    assert_eq!(edge.id, 100);
    assert_eq!(edge.from_node, 1);
    assert_eq!(edge.to_node, 2);
    assert_eq!(edge.edge_type, "KNOWS");
    assert_eq!(edge.properties.get("weight"), Some(&Value::Float(0.5)));
}

#[test]
fn test_edge_clone() {
    let edge = Edge {
        id: 1,
        from_node: 10,
        to_node: 20,
        edge_type: "LINKS".to_string(),
        properties: HashMap::new(),
    };

    let cloned = edge.clone();
    assert_eq!(cloned.id, edge.id);
    assert_eq!(cloned.from_node, edge.from_node);
    assert_eq!(cloned.to_node, edge.to_node);
    assert_eq!(cloned.edge_type, edge.edge_type);
}

#[test]
fn test_edge_debug() {
    let edge = Edge {
        id: 1,
        from_node: 1,
        to_node: 2,
        edge_type: "REL".to_string(),
        properties: HashMap::new(),
    };

    let debug_str = format!("{:?}", edge);
    assert!(debug_str.contains("Edge"));
    assert!(debug_str.contains("from_node: 1"));
    assert!(debug_str.contains("to_node: 2"));
}

// =============================================================================
// Mock implementation to test trait definitions
// =============================================================================

/// Minimal mock implementation to verify trait signatures compile correctly
struct MockGraphStore {
    nodes: HashMap<NodeId, Node>,
    edges: HashMap<EdgeId, Edge>,
    next_node_id: NodeId,
    next_edge_id: EdgeId,
}

impl MockGraphStore {
    fn new() -> Self {
        Self {
            nodes: HashMap::new(),
            edges: HashMap::new(),
            next_node_id: 1,
            next_edge_id: 1,
        }
    }
}

impl GraphReadStore for MockGraphStore {
    fn scan_all(&self) -> Result<Vec<Node>, EngineError> {
        Ok(self.nodes.values().cloned().collect())
    }

    fn scan_by_label(&self, label: &str) -> Result<Vec<Node>, EngineError> {
        Ok(self.nodes.values()
            .filter(|n| n.labels.contains(&label.to_string()))
            .cloned()
            .collect())
    }

    fn get_node(&self, id: NodeId) -> Result<Option<Node>, EngineError> {
        Ok(self.nodes.get(&id).cloned())
    }

    fn get_neighbors(&self, node_id: NodeId, edge_type: Option<&str>) -> Result<Vec<(Edge, Node)>, EngineError> {
        let mut result = Vec::new();
        for edge in self.edges.values() {
            if edge.from_node == node_id {
                if let Some(et) = edge_type {
                    if edge.edge_type != et {
                        continue;
                    }
                }
                if let Some(to_node) = self.nodes.get(&edge.to_node) {
                    result.push((edge.clone(), to_node.clone()));
                }
            }
        }
        Ok(result)
    }

    fn get_neighbors_incoming(&self, node_id: NodeId, edge_type: Option<&str>) -> Result<Vec<(Edge, Node)>, EngineError> {
        let mut result = Vec::new();
        for edge in self.edges.values() {
            if edge.to_node == node_id {
                if let Some(et) = edge_type {
                    if edge.edge_type != et {
                        continue;
                    }
                }
                if let Some(from_node) = self.nodes.get(&edge.from_node) {
                    result.push((edge.clone(), from_node.clone()));
                }
            }
        }
        Ok(result)
    }
}

impl GraphWriteStore for MockGraphStore {
    fn add_node(&mut self, labels: Vec<String>, properties: HashMap<String, Value>) -> Result<NodeId, EngineError> {
        let id = self.next_node_id;
        self.next_node_id += 1;
        self.nodes.insert(id, Node { id, labels, properties });
        Ok(id)
    }

    fn add_edge(&mut self, from: NodeId, to: NodeId, edge_type: String, properties: HashMap<String, Value>) -> Result<EdgeId, EngineError> {
        let id = self.next_edge_id;
        self.next_edge_id += 1;
        self.edges.insert(id, Edge { id, from_node: from, to_node: to, edge_type, properties });
        Ok(id)
    }
}

// =============================================================================
// GraphReadStore trait tests
// =============================================================================

#[test]
fn test_graph_read_store_scan_all() {
    let mut store = MockGraphStore::new();
    store.add_node(vec!["A".into()], HashMap::new()).unwrap();
    store.add_node(vec!["B".into()], HashMap::new()).unwrap();

    let all = store.scan_all().unwrap();
    assert_eq!(all.len(), 2);
}

#[test]
fn test_graph_read_store_scan_by_label() {
    let mut store = MockGraphStore::new();
    store.add_node(vec!["Person".into()], HashMap::new()).unwrap();
    store.add_node(vec!["Company".into()], HashMap::new()).unwrap();
    store.add_node(vec!["Person".into()], HashMap::new()).unwrap();

    let persons = store.scan_by_label("Person").unwrap();
    assert_eq!(persons.len(), 2);

    let companies = store.scan_by_label("Company").unwrap();
    assert_eq!(companies.len(), 1);

    let unknown = store.scan_by_label("Unknown").unwrap();
    assert_eq!(unknown.len(), 0);
}

#[test]
fn test_graph_read_store_get_node() {
    let mut store = MockGraphStore::new();
    let id = store.add_node(vec!["Test".into()], HashMap::new()).unwrap();

    let found = store.get_node(id).unwrap();
    assert!(found.is_some());
    assert_eq!(found.unwrap().id, id);

    let not_found = store.get_node(999).unwrap();
    assert!(not_found.is_none());
}

#[test]
fn test_graph_read_store_get_neighbors() {
    let mut store = MockGraphStore::new();
    let a = store.add_node(vec!["A".into()], HashMap::new()).unwrap();
    let b = store.add_node(vec!["B".into()], HashMap::new()).unwrap();
    let c = store.add_node(vec!["C".into()], HashMap::new()).unwrap();

    store.add_edge(a, b, "KNOWS".into(), HashMap::new()).unwrap();
    store.add_edge(a, c, "LIKES".into(), HashMap::new()).unwrap();

    // All neighbors
    let neighbors = store.get_neighbors(a, None).unwrap();
    assert_eq!(neighbors.len(), 2);

    // Filtered by type
    let knows = store.get_neighbors(a, Some("KNOWS")).unwrap();
    assert_eq!(knows.len(), 1);
    assert_eq!(knows[0].1.id, b);
}

#[test]
fn test_graph_read_store_get_neighbors_incoming() {
    let mut store = MockGraphStore::new();
    let a = store.add_node(vec!["A".into()], HashMap::new()).unwrap();
    let b = store.add_node(vec!["B".into()], HashMap::new()).unwrap();

    store.add_edge(a, b, "POINTS_TO".into(), HashMap::new()).unwrap();

    // b has incoming edge from a
    let incoming = store.get_neighbors_incoming(b, None).unwrap();
    assert_eq!(incoming.len(), 1);
    assert_eq!(incoming[0].1.id, a);

    // a has no incoming edges
    let no_incoming = store.get_neighbors_incoming(a, None).unwrap();
    assert_eq!(no_incoming.len(), 0);
}

// =============================================================================
// GraphWriteStore trait tests
// =============================================================================

#[test]
fn test_graph_write_store_add_node() {
    let mut store = MockGraphStore::new();

    let mut props = HashMap::new();
    props.insert("key".into(), Value::String("value".into()));

    let id = store.add_node(vec!["Label".into()], props).unwrap();
    assert_eq!(id, 1);

    let node = store.get_node(id).unwrap().unwrap();
    assert_eq!(node.labels, vec!["Label".to_string()]);
    assert_eq!(node.properties.get("key"), Some(&Value::String("value".into())));
}

#[test]
fn test_graph_write_store_add_edge() {
    let mut store = MockGraphStore::new();
    let a = store.add_node(vec![], HashMap::new()).unwrap();
    let b = store.add_node(vec![], HashMap::new()).unwrap();

    let mut props = HashMap::new();
    props.insert("weight".into(), Value::Int(10));

    let edge_id = store.add_edge(a, b, "CONNECTS".into(), props).unwrap();
    assert_eq!(edge_id, 1);

    let neighbors = store.get_neighbors(a, Some("CONNECTS")).unwrap();
    assert_eq!(neighbors.len(), 1);
    assert_eq!(neighbors[0].0.properties.get("weight"), Some(&Value::Int(10)));
}

#[test]
fn test_graph_write_store_increments_ids() {
    let mut store = MockGraphStore::new();

    let id1 = store.add_node(vec![], HashMap::new()).unwrap();
    let id2 = store.add_node(vec![], HashMap::new()).unwrap();
    let id3 = store.add_node(vec![], HashMap::new()).unwrap();

    assert_eq!(id1, 1);
    assert_eq!(id2, 2);
    assert_eq!(id3, 3);
}
