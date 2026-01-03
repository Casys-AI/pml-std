//! Casys Redis Storage Adapter
//! Implements WalSink and WalSource for Redis.
//! 
//! Future implementation: store WAL records in Redis streams.
//! Enables high-performance, in-memory WAL with persistence options.

use casys_core::{
    DatabaseName, BranchName, WalTailMeta, EngineError,
    WalSink, WalSource,
};
use std::path::Path;

/// Redis Storage adapter (stub for future implementation)
pub struct RedisBackend {
    // TODO: Add Redis client, connection pool
}

impl RedisBackend {
    /// Create a new Redis backend
    pub fn new() -> Self {
        Self {}
    }
}

impl Default for RedisBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl WalSink for RedisBackend {
    fn append_records(
        &self,
        _root: &Path,
        _db: &DatabaseName,
        _branch: &BranchName,
        _records: &[Vec<u8>],
    ) -> Result<WalTailMeta, EngineError> {
        Err(EngineError::NotImplemented(
            "Redis WalSink not yet implemented".into(),
        ))
    }
}

impl WalSource for RedisBackend {
    fn list_wal_segments(
        &self,
        _root: &Path,
        _db: &DatabaseName,
        _branch: &BranchName,
    ) -> Result<Vec<WalTailMeta>, EngineError> {
        Err(EngineError::NotImplemented(
            "Redis WalSource not yet implemented".into(),
        ))
    }

    fn read_wal_segment(
        &self,
        _root: &Path,
        _db: &DatabaseName,
        _branch: &BranchName,
        _tail: &WalTailMeta,
    ) -> Result<Vec<Vec<u8>>, EngineError> {
        Err(EngineError::NotImplemented(
            "Redis WalSource not yet implemented".into(),
        ))
    }
}
