//! Indexes: labels, properties, adjacency (in-memory MVP)
//!
//! The persistence module provides trait-based storage abstraction.
//! Core persistence (flush/load with SegmentStore trait) is always available.
//! FS convenience methods (flush_to_fs/load_from_fs) require the `fs` feature.

pub mod persistence;

use crate::types::EngineError;
use std::collections::HashMap;

// Re-export graph types and traits from casys_core (AC5: backward compatibility)
pub use casys_core::{
    Value, NodeId, EdgeId,
    Node, Edge,
    GraphReadStore, GraphWriteStore,
};

/// In-memory graph store with indexes
pub struct InMemoryGraphStore {
    pub(crate) nodes: HashMap<NodeId, Node>,
    pub(crate) edges: HashMap<EdgeId, Edge>,
    pub(crate) label_index: HashMap<String, Vec<NodeId>>,
    pub(crate) adjacency_out: HashMap<NodeId, Vec<EdgeId>>,
    pub(crate) adjacency_in: HashMap<NodeId, Vec<EdgeId>>,
    pub(crate) next_node_id: NodeId,
    pub(crate) next_edge_id: EdgeId,
}

impl InMemoryGraphStore {
    pub fn new() -> Self {
        Self {
            nodes: HashMap::new(),
            edges: HashMap::new(),
            label_index: HashMap::new(),
            adjacency_out: HashMap::new(),
            adjacency_in: HashMap::new(),
            next_node_id: 1,
            next_edge_id: 1,
        }
    }
}

impl GraphReadStore for InMemoryGraphStore {
    fn scan_all(&self) -> Result<Vec<Node>, EngineError> {
        Ok(self.nodes.values().cloned().collect())
    }

    fn scan_by_label(&self, label: &str) -> Result<Vec<Node>, EngineError> {
        if let Some(node_ids) = self.label_index.get(label) {
            Ok(node_ids.iter()
                .filter_map(|id| self.nodes.get(id).cloned())
                .collect())
        } else {
            Ok(Vec::new())
        }
    }

    fn get_node(&self, id: NodeId) -> Result<Option<Node>, EngineError> {
        Ok(self.nodes.get(&id).cloned())
    }

    fn get_neighbors(&self, node_id: NodeId, edge_type: Option<&str>) -> Result<Vec<(Edge, Node)>, EngineError> {
        let mut result = Vec::new();

        if let Some(edge_ids) = self.adjacency_out.get(&node_id) {
            for edge_id in edge_ids {
                if let Some(edge) = self.edges.get(edge_id) {
                    if let Some(et) = edge_type {
                        if edge.edge_type != et {
                            continue;
                        }
                    }
                    if let Some(node) = self.nodes.get(&edge.to_node) {
                        result.push((edge.clone(), node.clone()));
                    }
                }
            }
        }

        Ok(result)
    }

    fn get_neighbors_incoming(&self, node_id: NodeId, edge_type: Option<&str>) -> Result<Vec<(Edge, Node)>, EngineError> {
        let mut result = Vec::new();

        if let Some(edge_ids) = self.adjacency_in.get(&node_id) {
            for edge_id in edge_ids {
                if let Some(edge) = self.edges.get(edge_id) {
                    if let Some(et) = edge_type {
                        if edge.edge_type != et {
                            continue;
                        }
                    }
                    if let Some(node) = self.nodes.get(&edge.from_node) {
                        result.push((edge.clone(), node.clone()));
                    }
                }
            }
        }

        Ok(result)
    }
}

impl GraphWriteStore for InMemoryGraphStore {
    fn add_node(&mut self, labels: Vec<String>, properties: HashMap<String, Value>) -> Result<NodeId, EngineError> {
        let id = self.next_node_id;
        self.next_node_id += 1;

        let node = Node { id, labels: labels.clone(), properties };
        self.nodes.insert(id, node);

        // Update label index
        for label in labels {
            self.label_index.entry(label).or_insert_with(Vec::new).push(id);
        }

        Ok(id)
    }

    fn add_edge(&mut self, from: NodeId, to: NodeId, edge_type: String, properties: HashMap<String, Value>) -> Result<EdgeId, EngineError> {
        let id = self.next_edge_id;
        self.next_edge_id += 1;

        let edge = Edge {
            id,
            from_node: from,
            to_node: to,
            edge_type,
            properties,
        };
        self.edges.insert(id, edge);

        // Update adjacency indexes
        self.adjacency_out.entry(from).or_insert_with(Vec::new).push(id);
        self.adjacency_in.entry(to).or_insert_with(Vec::new).push(id);

        Ok(id)
    }
}
