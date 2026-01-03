//! Casys PostgreSQL Storage Adapter
//! Implements StorageCatalog for PostgreSQL.
//! 
//! Future implementation: store catalog (branches, multi-tenant ACL) in PostgreSQL.
//! Enables centralized, scalable catalog management with ACID guarantees.

use casys_core::{
    DatabaseName, BranchName, Timestamp, EngineError,
    StorageCatalog,
};
use std::path::Path;

/// PostgreSQL Storage adapter (stub for future implementation)
pub struct PostgresBackend {
    // TODO: Add PostgreSQL connection pool, schema
}

impl PostgresBackend {
    /// Create a new PostgreSQL backend
    pub fn new() -> Self {
        Self {}
    }
}

impl Default for PostgresBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl StorageCatalog for PostgresBackend {
    fn list_branches(
        &self,
        _root: &Path,
        _db: &DatabaseName,
    ) -> Result<Vec<BranchName>, EngineError> {
        Err(EngineError::NotImplemented(
            "PostgreSQL StorageCatalog not yet implemented".into(),
        ))
    }

    fn create_branch(
        &self,
        _root: &Path,
        _db: &DatabaseName,
        _from: &BranchName,
        _new_branch: &BranchName,
        _at: Option<Timestamp>,
    ) -> Result<(), EngineError> {
        Err(EngineError::NotImplemented(
            "PostgreSQL StorageCatalog not yet implemented".into(),
        ))
    }
}
