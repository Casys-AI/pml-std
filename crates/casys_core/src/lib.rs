use std::collections::HashMap;

pub type NodeId = u64;
pub type EdgeId = u64;

// -----------------------
// Graph Domain Types (Node, Edge)
// -----------------------

/// A graph node with labels and properties
#[derive(Debug, Clone)]
pub struct Node {
    pub id: NodeId,
    pub labels: Vec<String>,
    pub properties: HashMap<String, Value>,
}

/// A graph edge connecting two nodes
#[derive(Debug, Clone)]
pub struct Edge {
    pub id: EdgeId,
    pub from_node: NodeId,
    pub to_node: NodeId,
    pub edge_type: String,
    pub properties: HashMap<String, Value>,
}

// -----------------------
// Graph Storage Traits (Ports)
// -----------------------

/// Read-only graph storage interface
pub trait GraphReadStore {
    fn scan_all(&self) -> Result<Vec<Node>, EngineError>;
    fn scan_by_label(&self, label: &str) -> Result<Vec<Node>, EngineError>;
    fn get_node(&self, id: NodeId) -> Result<Option<Node>, EngineError>;
    fn get_neighbors(&self, node_id: NodeId, edge_type: Option<&str>) -> Result<Vec<(Edge, Node)>, EngineError>;
    fn get_neighbors_incoming(&self, node_id: NodeId, edge_type: Option<&str>) -> Result<Vec<(Edge, Node)>, EngineError>;
}

/// Write-capable storage interface (extends read)
pub trait GraphWriteStore: GraphReadStore {
    fn add_node(&mut self, labels: Vec<String>, properties: HashMap<String, Value>) -> Result<NodeId, EngineError>;
    fn add_edge(&mut self, from: NodeId, to: NodeId, edge_type: String, properties: HashMap<String, Value>) -> Result<EdgeId, EngineError>;
}

#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    String(String),
    Bytes(Vec<u8>),
    Array(Vec<Value>),
    Map(std::collections::BTreeMap<String, Value>),
    NodeId(NodeId),
}

// -----------------------
// Granular Storage Ports (optional for adapters)
// -----------------------

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SegmentId(pub String);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WalTailMeta {
    pub epoch: u64,
    pub seq: u64,
}

#[derive(Clone, Debug)]
pub struct ManifestMeta {
    pub branch: String,
    pub version_ts: Timestamp,
    pub segments: Vec<SegmentId>,
    pub wal_tail: Option<WalTailMeta>,
}

pub trait StorageCatalog: Send + Sync + 'static {
    fn list_branches(&self, root: &Path, db: &DatabaseName) -> Result<Vec<BranchName>, EngineError>;
    fn create_branch(&self, root: &Path, db: &DatabaseName, from: &BranchName, new_branch: &BranchName, at: Option<Timestamp>) -> Result<(), EngineError>;
}

pub trait ManifestStore: Send + Sync + 'static {
    fn list_snapshot_timestamps(&self, root: &Path, db: &DatabaseName, branch: &BranchName) -> Result<Vec<Timestamp>, EngineError>;
    fn latest_manifest_meta(&self, root: &Path, db: &DatabaseName, branch: &BranchName) -> Result<Option<ManifestMeta>, EngineError>;
    fn pitr_manifest_meta(&self, root: &Path, db: &DatabaseName, branch: &BranchName, at: Timestamp) -> Result<Option<ManifestMeta>, EngineError>;
    fn read_manifest_meta(&self, root: &Path, db: &DatabaseName, branch: &BranchName, ts: Timestamp) -> Result<Option<ManifestMeta>, EngineError>;
    fn write_manifest_meta(&self, root: &Path, db: &DatabaseName, branch: &BranchName, meta: &ManifestMeta) -> Result<(), EngineError>;
}

pub trait SegmentStore: Send + Sync + 'static {
    fn write_segment(&self, root: &Path, db: &DatabaseName, segment_id: &SegmentId, data: &[u8], node_count: u64, edge_count: u64) -> Result<(), EngineError>;
    fn read_segment(&self, root: &Path, db: &DatabaseName, segment_id: &SegmentId) -> Result<(Vec<u8>, u64, u64), EngineError>;
}

pub trait WalSink: Send + Sync + 'static {
    fn append_records(&self, root: &Path, db: &DatabaseName, branch: &BranchName, records: &[Vec<u8>]) -> Result<WalTailMeta, EngineError>;
}

pub trait WalSource: Send + Sync + 'static {
    fn list_wal_segments(&self, root: &Path, db: &DatabaseName, branch: &BranchName) -> Result<Vec<WalTailMeta>, EngineError>;
    fn read_wal_segment(&self, root: &Path, db: &DatabaseName, branch: &BranchName, tail: &WalTailMeta) -> Result<Vec<Vec<u8>>, EngineError>;
}

pub trait StorageBackend: Send + Sync + 'static {
    fn list_branches(&self, root: &Path, db: &DatabaseName) -> Result<Vec<BranchName>, EngineError>;
    fn create_branch(&self, root: &Path, db: &DatabaseName, from: &BranchName, new_branch: &BranchName, at: Option<Timestamp>) -> Result<(), EngineError>;
    fn snapshot(&self, root: &Path, db: &DatabaseName, branch: &BranchName) -> Result<Timestamp, EngineError>;
    fn commit_tx(&self, root: &Path, db: &DatabaseName, branch: &BranchName, records: &[Vec<u8>]) -> Result<Timestamp, EngineError>;
    fn list_snapshot_timestamps(&self, root: &Path, db: &DatabaseName, branch: &BranchName) -> Result<Vec<Timestamp>, EngineError>;
}

// -----------------------
// Composite backend (aggregates granular ports)
// -----------------------

pub struct CompositeBackend {
    pub catalog: std::sync::Arc<dyn StorageCatalog>,
    pub manifest: std::sync::Arc<dyn ManifestStore>,
    pub segments: std::sync::Arc<dyn SegmentStore>,
    pub wal_sink: Option<std::sync::Arc<dyn WalSink>>, // optional
    pub wal_source: Option<std::sync::Arc<dyn WalSource>>, // optional
}

impl CompositeBackend {
    pub fn new(
        catalog: std::sync::Arc<dyn StorageCatalog>,
        manifest: std::sync::Arc<dyn ManifestStore>,
        segments: std::sync::Arc<dyn SegmentStore>,
        wal_sink: Option<std::sync::Arc<dyn WalSink>>,
        wal_source: Option<std::sync::Arc<dyn WalSource>>,
    ) -> Self {
        Self { catalog, manifest, segments, wal_sink, wal_source }
    }
}

impl StorageBackend for CompositeBackend {
    fn list_branches(&self, root: &Path, db: &DatabaseName) -> Result<Vec<BranchName>, EngineError> {
        self.catalog.list_branches(root, db)
    }

    fn create_branch(&self, root: &Path, db: &DatabaseName, from: &BranchName, new_branch: &BranchName, at: Option<Timestamp>) -> Result<(), EngineError> {
        self.catalog.create_branch(root, db, from, new_branch, at)
    }

    fn snapshot(&self, root: &Path, db: &DatabaseName, branch: &BranchName) -> Result<Timestamp, EngineError> {
        // Minimal FS-like semantics: create a new manifest version with same segments and preserved wal_tail
        use std::time::{SystemTime, UNIX_EPOCH};
        let now_ms: Timestamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
        let meta = self.manifest.latest_manifest_meta(root, db, branch)?;
        let new_meta = ManifestMeta {
            branch: branch.as_str().to_string(),
            version_ts: now_ms,
            segments: meta.as_ref().map(|m| m.segments.clone()).unwrap_or_default(),
            wal_tail: meta.as_ref().and_then(|m| m.wal_tail.clone()),
        };
        self.manifest.write_manifest_meta(root, db, branch, &new_meta)?;
        Ok(now_ms)
    }

    fn commit_tx(&self, root: &Path, db: &DatabaseName, branch: &BranchName, records: &[Vec<u8>]) -> Result<Timestamp, EngineError> {
        // Append to WAL if available, then snapshot with updated wal_tail
        use std::time::{SystemTime, UNIX_EPOCH};
        let tail = if let Some(sink) = &self.wal_sink {
            Some(sink.append_records(root, db, branch, records)?)
        } else { None };

        let now_ms: Timestamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
        let prev = self.manifest.latest_manifest_meta(root, db, branch)?;
        let new_meta = ManifestMeta {
            branch: branch.as_str().to_string(),
            version_ts: now_ms,
            segments: prev.as_ref().map(|m| m.segments.clone()).unwrap_or_default(),
            wal_tail: tail.or_else(|| prev.as_ref().and_then(|m| m.wal_tail.clone())),
        };
        self.manifest.write_manifest_meta(root, db, branch, &new_meta)?;
        Ok(now_ms)
    }

    fn list_snapshot_timestamps(&self, root: &Path, db: &DatabaseName, branch: &BranchName) -> Result<Vec<Timestamp>, EngineError> {
        self.manifest.list_snapshot_timestamps(root, db, branch)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct CommitId(pub u64);

// -----------------------
// Shared Engine Types
// -----------------------

use std::convert::TryFrom;
use std::path::Path;

/// Epoch millis (MVP)
pub type Timestamp = u64;

#[derive(thiserror::Error, Debug, Clone)]
pub enum EngineError {
    #[error("storage io: {0}")]
    StorageIo(String),
    #[error("invalid argument: {0}")]
    InvalidArgument(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("concurrency error: {0}")]
    Concurrency(String),
    #[error("not implemented: {0}")]
    NotImplemented(String),
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct DatabaseName(String);

impl TryFrom<&str> for DatabaseName {
    type Error = EngineError;
    fn try_from(value: &str) -> Result<Self, Self::Error> {
        validate_identifier(value)?;
        Ok(Self(value.to_string()))
    }
}

impl DatabaseName {
    pub fn as_str(&self) -> &str { &self.0 }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct BranchName(String);

impl TryFrom<&str> for BranchName {
    type Error = EngineError;
    fn try_from(value: &str) -> Result<Self, Self::Error> {
        validate_identifier(value)?;
        Ok(Self(value.to_string()))
    }
}

impl BranchName {
    pub fn as_str(&self) -> &str { &self.0 }
}

#[derive(Clone, Debug)]
pub struct GqlQuery(pub String);

#[derive(Clone, Debug)]
pub struct ColumnMeta {
    pub name: String,
    pub r#type: String,
}

#[derive(Clone, Debug)]
pub struct QueryStats {
    pub elapsed_ms: u64,
    pub scanned: u64,
    pub expanded: u64,
}

#[derive(Clone, Debug)]
pub struct QueryResult {
    pub columns: Vec<ColumnMeta>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub stats: Option<QueryStats>,
}

fn validate_identifier(s: &str) -> Result<(), EngineError> {
    if s.is_empty() || s.len() > 128 {
        return Err(EngineError::InvalidArgument("identifier length".into()));
    }
    if !s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' ) {
        return Err(EngineError::InvalidArgument("identifier charset".into()));
    }
    Ok(())
}
