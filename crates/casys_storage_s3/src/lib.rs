//! Casys S3 Storage Adapter
//! Implements ManifestStore and SegmentStore for AWS S3.
//! 
//! Future implementation: store manifests and segments in S3 buckets.
//! Enables cloud-native deployments with scalable object storage.

use casys_core::{
    DatabaseName, BranchName, SegmentId, ManifestMeta, WalTailMeta, Timestamp, EngineError,
    ManifestStore, SegmentStore,
};
use std::path::Path;

/// S3 Storage adapter (stub for future implementation)
pub struct S3Backend {
    // TODO: Add S3 client, bucket name, credentials
}

impl S3Backend {
    /// Create a new S3 backend
    pub fn new() -> Self {
        Self {}
    }
}

impl Default for S3Backend {
    fn default() -> Self {
        Self::new()
    }
}

impl ManifestStore for S3Backend {
    fn list_snapshot_timestamps(
        &self,
        _root: &Path,
        _db: &DatabaseName,
        _branch: &BranchName,
    ) -> Result<Vec<Timestamp>, EngineError> {
        Err(EngineError::NotImplemented(
            "S3 ManifestStore not yet implemented".into(),
        ))
    }

    fn latest_manifest_meta(
        &self,
        _root: &Path,
        _db: &DatabaseName,
        _branch: &BranchName,
    ) -> Result<Option<ManifestMeta>, EngineError> {
        Err(EngineError::NotImplemented(
            "S3 ManifestStore not yet implemented".into(),
        ))
    }

    fn pitr_manifest_meta(
        &self,
        _root: &Path,
        _db: &DatabaseName,
        _branch: &BranchName,
        _at: Timestamp,
    ) -> Result<Option<ManifestMeta>, EngineError> {
        Err(EngineError::NotImplemented(
            "S3 ManifestStore not yet implemented".into(),
        ))
    }

    fn read_manifest_meta(
        &self,
        _root: &Path,
        _db: &DatabaseName,
        _branch: &BranchName,
        _ts: Timestamp,
    ) -> Result<Option<ManifestMeta>, EngineError> {
        Err(EngineError::NotImplemented(
            "S3 ManifestStore not yet implemented".into(),
        ))
    }

    fn write_manifest_meta(
        &self,
        _root: &Path,
        _db: &DatabaseName,
        _branch: &BranchName,
        _meta: &ManifestMeta,
    ) -> Result<(), EngineError> {
        Err(EngineError::NotImplemented(
            "S3 ManifestStore not yet implemented".into(),
        ))
    }
}

impl SegmentStore for S3Backend {
    fn write_segment(
        &self,
        _root: &Path,
        _db: &DatabaseName,
        _segment_id: &SegmentId,
        _data: &[u8],
        _node_count: u64,
        _edge_count: u64,
    ) -> Result<(), EngineError> {
        Err(EngineError::NotImplemented(
            "S3 SegmentStore not yet implemented".into(),
        ))
    }

    fn read_segment(
        &self,
        _root: &Path,
        _db: &DatabaseName,
        _segment_id: &SegmentId,
    ) -> Result<(Vec<u8>, u64, u64), EngineError> {
        Err(EngineError::NotImplemented(
            "S3 SegmentStore not yet implemented".into(),
        ))
    }
}
