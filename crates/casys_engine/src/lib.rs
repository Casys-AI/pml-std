//! Casys Engine (library)
//! Self-contained crate exposing the embedded engine API used by FFI/SDKs and apps.

pub mod types;
pub mod util;
pub mod index;
pub mod exec;
pub mod txn;
pub mod gds;
pub mod ann;

// Optional higher-level facades (placeholders kept for future API surface)
pub mod branch;
pub mod tx;
pub mod merge;

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

#[cfg(feature = "fs")]
use casys_core::StorageBackend;

pub use types::{
    BranchName,
    DatabaseName,
    EngineError,
    GqlQuery,
    QueryResult,
    Timestamp,
};

// Re-export casys_core::Value as the canonical Value type
pub use casys_core::Value;

/// Engine is the embedded entrypoint. It owns the data directory and shared resources.
pub struct Engine {
    data_dir: PathBuf,
    /// Writer locks per (db, branch) to enforce SW-MR
    writer_locks: Mutex<HashMap<(String, String), Arc<Mutex<()>>>>,
    #[cfg(feature = "fs")]
    backend: Arc<dyn StorageBackend>,
}

/// Opaque handle to a database
#[derive(Debug)]
pub struct DbHandle {
    pub(crate) name: DatabaseName,
}

impl DbHandle {
    pub fn name(&self) -> &DatabaseName {
        &self.name
    }
}

/// Opaque handle to a branch of a database
#[derive(Debug)]
pub struct BranchHandle {
    pub(crate) db: DatabaseName,
    pub(crate) name: BranchName,
}

impl Engine {
    /// Open (or create) an engine using the given data directory.
    pub fn open<P: AsRef<Path>>(data_dir: P) -> Result<Self, EngineError> {
        let dir = data_dir.as_ref();
        std::fs::create_dir_all(dir)
            .map_err(|e| EngineError::StorageIo(format!("create_dir_all({}): {e}", dir.display())))?;
        #[cfg(feature = "fs")]
        let backend = Arc::new(casys_storage_fs::backend::FsBackend::new());
        Ok(Engine {
            data_dir: dir.to_path_buf(),
            writer_locks: Mutex::new(HashMap::new()),
            #[cfg(feature = "fs")]
            backend,
        })
    }

    /// Open an engine with a custom storage backend (only when `fs` feature is enabled).
    #[cfg(feature = "fs")]
    pub fn open_with_backend<P: AsRef<Path>>(data_dir: P, backend: Arc<dyn StorageBackend>) -> Result<Self, EngineError> {
        let dir = data_dir.as_ref();
        std::fs::create_dir_all(dir)
            .map_err(|e| EngineError::StorageIo(format!("create_dir_all({}): {e}", dir.display())))?;
        Ok(Engine {
            data_dir: dir.to_path_buf(),
            writer_locks: Mutex::new(HashMap::new()),
            backend,
        })
    }

    /// Open an engine using a CompositeBackend composed from the FS adapter implementing granular ports.
    /// This keeps the injection surface consistent when mixing adapters in the future.
    #[cfg(feature = "fs")]
    pub fn open_fs_composite<P: AsRef<Path>>(data_dir: P) -> Result<Self, EngineError> {
        use casys_core::CompositeBackend;
        let fsb = Arc::new(casys_storage_fs::backend::FsBackend::new());
        let catalog: Arc<dyn casys_core::StorageCatalog> = fsb.clone();
        let manifest: Arc<dyn casys_core::ManifestStore> = fsb.clone();
        let segments: Arc<dyn casys_core::SegmentStore> = fsb.clone();
        let wal_sink: Option<Arc<dyn casys_core::WalSink>> = Some(fsb.clone());
        let wal_source: Option<Arc<dyn casys_core::WalSource>> = Some(fsb.clone());
        let composite = CompositeBackend::new(catalog, manifest, segments, wal_sink, wal_source);
        Self::open_with_backend(data_dir, Arc::new(composite))
    }

    /// Open a logical database by name (created lazily upon first write).
    pub fn open_database(&self, name: &str) -> Result<DbHandle, EngineError> {
        let db = DatabaseName::try_from(name)?;
        Ok(DbHandle { name: db })
    }

    /// Open a branch within a database (created lazily upon first write).
    pub fn open_branch(&self, db: &DbHandle, branch: &str) -> Result<BranchHandle, EngineError> {
        let br = BranchName::try_from(branch)?;
        Ok(BranchHandle { db: db.name.clone(), name: br })
    }

    fn branch_writer_lock(&self, db: &DatabaseName, br: &BranchName) -> Arc<Mutex<()>> {
        let key = (db.as_str().to_string(), br.as_str().to_string());
        let mut map = self
            .writer_locks
            .lock()
            .expect("writer_locks poisoned");
        map.entry(key)
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    /// Execute an ISO GQL query against a branch, optionally at a PITR timestamp.
    pub fn execute_gql(
        &self,
        _branch: &BranchHandle,
        _query: &GqlQuery,
        _at: Option<Timestamp>,
    ) -> Result<QueryResult, EngineError> {
        Err(EngineError::NotImplemented("execute_gql".into()))
    }

    /// Create a new branch from an existing one, optionally at a PITR timestamp.
    #[cfg(feature = "fs")]
    pub fn create_branch(
        &self,
        db: &DbHandle,
        from: &str,
        new_branch: &str,
        at: Option<Timestamp>,
    ) -> Result<(), EngineError> {
        let from_br = BranchName::try_from(from)?;
        let new_br = BranchName::try_from(new_branch)?;
        self.backend.create_branch(self.data_dir(), &db.name, &from_br, &new_br, at)
    }

    /// Create a new branch from an existing one (stub when fs disabled)
    #[cfg(not(feature = "fs"))]
    pub fn create_branch(
        &self,
        _db: &DbHandle,
        _from: &str,
        _new_branch: &str,
        _at: Option<Timestamp>,
    ) -> Result<(), EngineError> {
        Err(EngineError::NotImplemented("create_branch requires fs feature".into()))
    }

    /// List branches for a database.
    #[cfg(feature = "fs")]
    pub fn list_branches(&self, db: &DbHandle) -> Result<Vec<BranchName>, EngineError> {
        self.backend.list_branches(self.data_dir(), &db.name)
    }

    #[cfg(not(feature = "fs"))]
    pub fn list_branches(&self, _db: &DbHandle) -> Result<Vec<BranchName>, EngineError> {
        Err(EngineError::NotImplemented("list_branches requires fs feature".into()))
    }

    /// Create a snapshot on a branch and return its timestamp.
    #[cfg(feature = "fs")]
    pub fn snapshot(&self, branch: &BranchHandle, _label: Option<&str>) -> Result<Timestamp, EngineError> {
        self.backend.snapshot(self.data_dir(), &branch.db, &branch.name)
    }

    #[cfg(not(feature = "fs"))]
    pub fn snapshot(&self, _branch: &BranchHandle, _label: Option<&str>) -> Result<Timestamp, EngineError> {
        Err(EngineError::NotImplemented("snapshot requires fs feature".into()))
    }

    /// Commit a set of WAL records then publish a new manifest (snapshot). Returns the manifest timestamp.
    #[cfg(feature = "fs")]
    pub fn commit_tx(&self, branch: &BranchHandle, records: &[Vec<u8>]) -> Result<Timestamp, EngineError> {
        // Acquire writer lock for SW-MR
        let lock = self.branch_writer_lock(&branch.db, &branch.name);
        let _guard = lock.lock().expect("writer lock poisoned");
        self.backend.commit_tx(self.data_dir(), &branch.db, &branch.name, records)
    }

    #[cfg(not(feature = "fs"))]
    pub fn commit_tx(&self, _branch: &BranchHandle, _records: &[Vec<u8>]) -> Result<Timestamp, EngineError> {
        Err(EngineError::NotImplemented("commit_tx requires fs feature".into()))
    }

    /// Merge one branch into another.
    pub fn merge_branch(&self, _db: &DbHandle, _src: &str, _dst: &str) -> Result<(), EngineError> {
        Err(EngineError::NotImplemented("merge_branch".into()))
    }

    /// Return the engine data directory.
    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    /// Flush an in-memory store to on-disk segments for the given branch (requires `fs`).
    #[cfg(feature = "fs")]
    pub fn flush_branch(&self, db: &DbHandle, branch: &BranchHandle, store: &crate::index::InMemoryGraphStore) -> Result<(), EngineError> {
        store.flush_to_fs(self.data_dir(), &db.name, &branch.name)
    }

    #[cfg(not(feature = "fs"))]
    pub fn flush_branch(&self, _db: &DbHandle, _branch: &BranchHandle, _store: &crate::index::InMemoryGraphStore) -> Result<(), EngineError> {
        Err(EngineError::NotImplemented("flush_branch requires fs feature".into()))
    }

    /// Load an in-memory store from on-disk segments for the given branch (requires `fs`).
    #[cfg(feature = "fs")]
    pub fn load_branch(&self, db: &DbHandle, branch: &BranchHandle) -> Result<crate::index::InMemoryGraphStore, EngineError> {
        crate::index::InMemoryGraphStore::load_from_fs(self.data_dir(), &db.name, &branch.name)
    }

    #[cfg(not(feature = "fs"))]
    pub fn load_branch(&self, _db: &DbHandle, _branch: &BranchHandle) -> Result<crate::index::InMemoryGraphStore, EngineError> {
        Err(EngineError::NotImplemented("load_branch requires fs feature".into()))
    }

    /// List snapshot timestamps for a branch (requires `fs`).
    #[cfg(feature = "fs")]
    pub fn list_snapshot_timestamps(&self, db: &DbHandle, branch: &BranchHandle) -> Result<Vec<Timestamp>, EngineError> {
        self.backend.list_snapshot_timestamps(self.data_dir(), &db.name, &branch.name)
    }

    #[cfg(not(feature = "fs"))]
    pub fn list_snapshot_timestamps(&self, _db: &DbHandle, _branch: &BranchHandle) -> Result<Vec<Timestamp>, EngineError> {
        Err(EngineError::NotImplemented("list_snapshot_timestamps requires fs feature".into()))
    }

    /// Execute a GQL query against the provided in-memory store, with optional JSON parameters.
    /// This centralizes parsing, planning, and execution inside the engine so wrappers stay thin.
    pub fn execute_gql_on_store(
        &self,
        store: &mut crate::index::InMemoryGraphStore,
        gql: &GqlQuery,
        params: Option<std::collections::HashMap<String, serde_json::Value>>,
    ) -> Result<QueryResult, EngineError> {
        use crate::exec::{parser, planner::Planner, executor::{Executor, ValueExt}};
        use casys_core::Value as ExecValue;
        use crate::index::{GraphReadStore, GraphWriteStore};
        use std::collections::HashMap;

        // Parse & plan
        let ast = parser::parse(&gql.0)?;
        let _required_params = ast.extract_parameters();
        let plan = Planner::plan(&ast)?;

        // Convert JSON parameters to executor values
        let mut param_exec: HashMap<String, ExecValue> = HashMap::new();
        if let Some(p) = params {
            for (k, v) in p {
                if let Some(ev) = ExecValue::from_json(&v) { param_exec.insert(k, ev); }
            }
        }

        // Execute with write handle when CREATE is present; otherwise read-only path
        if ast.create_clause.is_some() {
            let write: Option<&mut dyn GraphWriteStore> = Some(store);
            let executor = if param_exec.is_empty() {
                Executor::new_no_read()
            } else {
                Executor::with_parameters_no_read(param_exec)
            };
            executor.execute(&plan, write)
        } else {
            let read = store as &dyn GraphReadStore;
            let executor = if param_exec.is_empty() {
                Executor::new(read)
            } else {
                Executor::with_parameters(read, param_exec)
            };
            executor.execute(&plan, None)
        }
    }
}
