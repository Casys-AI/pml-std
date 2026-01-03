//! Persistence: flush/load graph index depuis segments
//!
//! This module uses the SegmentStore trait from casys_core for hexagonal architecture.
//! Storage adapters (FS, S3, etc.) implement SegmentStore and are injected by the caller.

use super::{InMemoryGraphStore, Node, Edge, Value};
use casys_core::{NodeId, EdgeId, SegmentId, SegmentStore};
use crate::exec::executor::ValueExt; // Import extension trait for to_json/from_json
use crate::types::{EngineError, DatabaseName};
#[cfg(feature = "fs")]
use crate::types::BranchName;
use std::collections::HashMap;
use std::path::Path;

/// WAL record pour mutations graph
#[derive(Debug, Clone)]
pub enum WalRecord {
    AddNode {
        id: NodeId,
        labels: Vec<String>,
        properties: HashMap<String, Value>,
    },
    AddEdge {
        id: EdgeId,
        from_node: NodeId,
        to_node: NodeId,
        edge_type: String,
        properties: HashMap<String, Value>,
    },
}

impl WalRecord {
    /// Sérialise le record en bytes (format simple: type(1) + JSON)
    pub fn to_bytes(&self) -> Vec<u8> {
        let json = match self {
            WalRecord::AddNode { id, labels, properties } => {
                serde_json::json!({
                    "type": "add_node",
                    "id": id,
                    "labels": labels,
                    "properties": serialize_props(properties)
                })
            }
            WalRecord::AddEdge { id, from_node, to_node, edge_type, properties } => {
                serde_json::json!({
                    "type": "add_edge",
                    "id": id,
                    "from": from_node,
                    "to": to_node,
                    "edge_type": edge_type,
                    "properties": serialize_props(properties)
                })
            }
        };
        serde_json::to_vec(&json).unwrap_or_default()
    }

    /// Désérialise depuis bytes
    pub fn from_bytes(data: &[u8]) -> Result<Self, EngineError> {
        let json: serde_json::Value = serde_json::from_slice(data)
            .map_err(|e| EngineError::StorageIo(format!("WAL record parse: {}", e)))?;

        let rec_type = json["type"].as_str()
            .ok_or_else(|| EngineError::StorageIo("missing type".into()))?;

        match rec_type {
            "add_node" => {
                let id = json["id"].as_u64().unwrap_or(0);
                let labels: Vec<String> = serde_json::from_value(json["labels"].clone())
                    .unwrap_or_default();
                let properties = deserialize_props(&json["properties"])?;
                Ok(WalRecord::AddNode { id, labels, properties })
            }
            "add_edge" => {
                let id = json["id"].as_u64().unwrap_or(0);
                let from_node = json["from"].as_u64().unwrap_or(0);
                let to_node = json["to"].as_u64().unwrap_or(0);
                let edge_type = json["edge_type"].as_str().unwrap_or("").to_string();
                let properties = deserialize_props(&json["properties"])?;
                Ok(WalRecord::AddEdge { id, from_node, to_node, edge_type, properties })
            }
            _ => Err(EngineError::StorageIo(format!("unknown WAL record type: {}", rec_type))),
        }
    }
}

fn serialize_props(props: &HashMap<String, Value>) -> serde_json::Value {
    let mut m = serde_json::Map::new();
    for (k, v) in props {
        m.insert(k.clone(), v.to_json());
    }
    serde_json::Value::Object(m)
}

fn deserialize_props(json: &serde_json::Value) -> Result<HashMap<String, Value>, EngineError> {
    let mut props = HashMap::new();
    if let Some(obj) = json.as_object() {
        for (k, v) in obj {
            if let Some(val) = Value::from_json(v) {
                props.insert(k.clone(), val);
            }
        }
    }
    Ok(props)
}

// Segment IDs for graph data
const NODE_SEGMENT_ID: &str = "nodes";
const EDGE_SEGMENT_ID: &str = "edges";

impl InMemoryGraphStore {
    /// Flush the graph to segments using the provided SegmentStore.
    ///
    /// # Arguments
    /// * `store` - A SegmentStore implementation (e.g., `FsBackend` from `casys_storage_fs`)
    /// * `root` - The root path for storage (typically the segments directory)
    /// * `db` - The database name
    ///
    /// # Errors
    /// Returns `EngineError::StorageIo` if serialization or segment writing fails.
    ///
    /// # Hexagonal Architecture
    /// This method depends only on the SegmentStore trait (port), not on any
    /// concrete storage adapter. The caller is responsible for constructing
    /// the appropriate SegmentStore implementation.
    ///
    /// For filesystem storage, use `flush_to_fs()` convenience method (requires `fs` feature),
    /// or inject `casys_storage_fs::backend::FsBackend` which implements `SegmentStore`.
    pub fn flush(
        &self,
        store: &dyn SegmentStore,
        root: &Path,
        db: &DatabaseName,
    ) -> Result<(), EngineError> {
        // Serialize and write nodes segment
        let nodes_data = self.serialize_nodes()?;
        let node_count = self.nodes.len() as u64;
        store.write_segment(
            root,
            db,
            &SegmentId(NODE_SEGMENT_ID.to_string()),
            &nodes_data,
            node_count,
            0,
        )?;

        // Serialize and write edges segment
        let edges_data = self.serialize_edges()?;
        let edge_count = self.edges.len() as u64;
        store.write_segment(
            root,
            db,
            &SegmentId(EDGE_SEGMENT_ID.to_string()),
            &edges_data,
            0,
            edge_count,
        )?;

        Ok(())
    }

    /// Load the graph from segments using the provided SegmentStore.
    ///
    /// # Arguments
    /// * `store` - A SegmentStore implementation (e.g., `FsBackend` from `casys_storage_fs`)
    /// * `root` - The root path for storage (typically the segments directory)
    /// * `db` - The database name
    ///
    /// # Returns
    /// A new InMemoryGraphStore populated with the loaded data, or an empty graph
    /// if no segments exist yet.
    ///
    /// # Errors
    /// Returns `EngineError::StorageIo` if segment reading or deserialization fails.
    /// Note: `EngineError::NotFound` for missing segments is handled gracefully (empty graph).
    ///
    /// For filesystem storage, use `load_from_fs()` convenience method (requires `fs` feature),
    /// or inject `casys_storage_fs::backend::FsBackend` which implements `SegmentStore`.
    #[must_use = "load returns a new graph store that should be used"]
    pub fn load(
        store: &dyn SegmentStore,
        root: &Path,
        db: &DatabaseName,
    ) -> Result<Self, EngineError> {
        let mut graph = Self::new();

        // Load nodes segment (may not exist yet)
        match store.read_segment(root, db, &SegmentId(NODE_SEGMENT_ID.to_string())) {
            Ok((data, _node_count, _edge_count)) => {
                graph.deserialize_nodes(&data)?;
            }
            Err(EngineError::NotFound(_)) => {
                // No nodes segment yet - that's OK for a new graph
            }
            Err(e) => return Err(e),
        }

        // Load edges segment (may not exist yet)
        match store.read_segment(root, db, &SegmentId(EDGE_SEGMENT_ID.to_string())) {
            Ok((data, _node_count, _edge_count)) => {
                graph.deserialize_edges(&data)?;
            }
            Err(EngineError::NotFound(_)) => {
                // No edges segment yet - that's OK for a new graph
            }
            Err(e) => return Err(e),
        }

        Ok(graph)
    }

    fn serialize_nodes(&self) -> Result<Vec<u8>, EngineError> {
        let nodes: Vec<_> = self.nodes.values().collect();
        let json = serde_json::json!({
            "count": nodes.len(),
            "nodes": nodes.iter().map(|n| {
                serde_json::json!({
                    "id": n.id,
                    "labels": n.labels,
                    "properties": serialize_props(&n.properties)
                })
            }).collect::<Vec<_>>()
        });

        serde_json::to_vec(&json)
            .map_err(|e| EngineError::StorageIo(format!("serialize nodes: {}", e)))
    }

    fn serialize_edges(&self) -> Result<Vec<u8>, EngineError> {
        let edges: Vec<_> = self.edges.values().collect();
        let json = serde_json::json!({
            "count": edges.len(),
            "edges": edges.iter().map(|e| {
                serde_json::json!({
                    "id": e.id,
                    "from": e.from_node,
                    "to": e.to_node,
                    "type": e.edge_type,
                    "properties": serialize_props(&e.properties)
                })
            }).collect::<Vec<_>>()
        });

        serde_json::to_vec(&json)
            .map_err(|e| EngineError::StorageIo(format!("serialize edges: {}", e)))
    }

    fn deserialize_nodes(&mut self, data: &[u8]) -> Result<(), EngineError> {
        let json: serde_json::Value = serde_json::from_slice(data)
            .map_err(|e| EngineError::StorageIo(format!("parse nodes: {}", e)))?;

        if let Some(nodes_array) = json["nodes"].as_array() {
            for node_json in nodes_array {
                let id = node_json["id"].as_u64().unwrap_or(0);
                let labels: Vec<String> = serde_json::from_value(node_json["labels"].clone())
                    .unwrap_or_default();
                let properties = deserialize_props(&node_json["properties"])?;

                let node = Node { id, labels: labels.clone(), properties };
                self.nodes.insert(id, node);

                // Rebuild label index
                for label in labels {
                    self.label_index.entry(label).or_insert_with(Vec::new).push(id);
                }

                // Update next_node_id
                if id >= self.next_node_id {
                    self.next_node_id = id + 1;
                }
            }
        }

        Ok(())
    }

    fn deserialize_edges(&mut self, data: &[u8]) -> Result<(), EngineError> {
        let json: serde_json::Value = serde_json::from_slice(data)
            .map_err(|e| EngineError::StorageIo(format!("parse edges: {}", e)))?;

        if let Some(edges_array) = json["edges"].as_array() {
            for edge_json in edges_array {
                let id = edge_json["id"].as_u64().unwrap_or(0);
                let from_node = edge_json["from"].as_u64().unwrap_or(0);
                let to_node = edge_json["to"].as_u64().unwrap_or(0);
                let edge_type = edge_json["type"].as_str().unwrap_or("").to_string();
                let properties = deserialize_props(&edge_json["properties"])?;

                let edge = Edge { id, from_node, to_node, edge_type, properties };
                self.edges.insert(id, edge);

                // Rebuild adjacency indexes
                self.adjacency_out.entry(from_node).or_insert_with(Vec::new).push(id);
                self.adjacency_in.entry(to_node).or_insert_with(Vec::new).push(id);

                // Update next_edge_id
                if id >= self.next_edge_id {
                    self.next_edge_id = id + 1;
                }
            }
        }

        Ok(())
    }

    /// Rejouer des WAL records
    pub fn replay_wal(&mut self, records: &[WalRecord]) -> Result<(), EngineError> {
        for record in records {
            match record {
                WalRecord::AddNode { id, labels, properties } => {
                    let node = Node {
                        id: *id,
                        labels: labels.clone(),
                        properties: properties.clone(),
                    };
                    self.nodes.insert(*id, node);

                    // Update indexes
                    for label in labels {
                        self.label_index.entry(label.clone()).or_insert_with(Vec::new).push(*id);
                    }

                    if *id >= self.next_node_id {
                        self.next_node_id = id + 1;
                    }
                }
                WalRecord::AddEdge { id, from_node, to_node, edge_type, properties } => {
                    let edge = Edge {
                        id: *id,
                        from_node: *from_node,
                        to_node: *to_node,
                        edge_type: edge_type.clone(),
                        properties: properties.clone(),
                    };
                    self.edges.insert(*id, edge);

                    // Update adjacency
                    self.adjacency_out.entry(*from_node).or_insert_with(Vec::new).push(*id);
                    self.adjacency_in.entry(*to_node).or_insert_with(Vec::new).push(*id);

                    if *id >= self.next_edge_id {
                        self.next_edge_id = id + 1;
                    }
                }
            }
        }
        Ok(())
    }
}

// =============================================================================
// Optional FS convenience functions (only when `fs` feature is enabled)
// =============================================================================
//
// These are convenience wrappers for filesystem storage. For custom storage
// backends, use the trait-based `flush()` and `load()` methods directly with
// any type implementing `SegmentStore` from `casys_core`.
//
// Example with FsBackend:
// ```ignore
// use casys_storage_fs::backend::FsBackend;
// let backend = FsBackend::new();
// graph.flush(&backend, &segments_root, &db)?;
// ```

#[cfg(feature = "fs")]
mod fs_convenience {
    use super::*;
    use casys_storage_fs::catalog;

    impl InMemoryGraphStore {
        /// Convenience method to flush directly to filesystem.
        ///
        /// This is a helper that constructs the FsSegmentStore internally.
        /// For more control, use `flush()` with a custom SegmentStore.
        ///
        /// # Arguments
        /// * `root` - Storage root path
        /// * `db` - Database name
        /// * `branch` - Branch name (used to construct segments directory)
        pub fn flush_to_fs(
            &self,
            root: &Path,
            db: &DatabaseName,
            branch: &BranchName,
        ) -> Result<(), EngineError> {
            let segments_root = catalog::branch_dir(root, db, branch);
            let store = FsSegmentStoreImpl;
            self.flush(&store, &segments_root, db)
        }

        /// Convenience method to load from filesystem.
        ///
        /// This is a helper that constructs the FsSegmentStore internally.
        /// For more control, use `load()` with a custom SegmentStore.
        pub fn load_from_fs(
            root: &Path,
            db: &DatabaseName,
            branch: &BranchName,
        ) -> Result<Self, EngineError> {
            let segments_root = catalog::branch_dir(root, db, branch);
            let store = FsSegmentStoreImpl;
            Self::load(&store, &segments_root, db)
        }
    }

    /// Filesystem SegmentStore implementation
    struct FsSegmentStoreImpl;

    impl SegmentStore for FsSegmentStoreImpl {
        fn write_segment(
            &self,
            root: &Path,
            db: &DatabaseName,
            segment_id: &SegmentId,
            data: &[u8],
            node_count: u64,
            edge_count: u64,
        ) -> Result<(), EngineError> {
            use casys_storage_fs::segments::{Segment, write_segment};
            let seg = Segment::new(node_count, edge_count, data.to_vec());
            write_segment(root, db, &segment_id.0, &seg)?;
            Ok(())
        }

        fn read_segment(
            &self,
            root: &Path,
            db: &DatabaseName,
            segment_id: &SegmentId,
        ) -> Result<(Vec<u8>, u64, u64), EngineError> {
            use casys_storage_fs::segments::read_segment;
            let seg = read_segment(root, db, &segment_id.0)?;
            Ok((seg.data, seg.header.node_count, seg.header.edge_count))
        }
    }
}

// Note: fs_convenience module adds methods to InMemoryGraphStore via impl blocks.
// No re-exports needed - methods are automatically available when the module is compiled.
