use std::time::{SystemTime, UNIX_EPOCH};
use std::path::Path;

use casys_core::{
    BranchName, DatabaseName, EngineError, StorageBackend, Timestamp,
    StorageCatalog, ManifestStore, SegmentStore, WalSink, WalSource,
    ManifestMeta, SegmentId, WalTailMeta,
};

use crate::{manifest as mf, catalog, wal, segments};

pub struct FsBackend;

impl FsBackend {
    pub fn new() -> Self { Self }
}

impl SegmentStore for FsBackend {
    fn write_segment(&self, root: &Path, db: &DatabaseName, segment_id: &SegmentId, data: &[u8], node_count: u64, edge_count: u64) -> Result<(), EngineError> {
        let seg = segments::Segment::new(node_count, edge_count, data.to_vec());
        let _ = segments::write_segment(root, db, &segment_id.0, &seg)?;
        Ok(())
    }

    fn read_segment(&self, root: &Path, db: &DatabaseName, segment_id: &SegmentId) -> Result<(Vec<u8>, u64, u64), EngineError> {
        let seg = segments::read_segment(root, db, &segment_id.0)?;
        Ok((seg.data, seg.header.node_count, seg.header.edge_count))
    }
}

fn to_meta(m: &mf::Manifest) -> ManifestMeta {
    ManifestMeta {
        branch: m.branch.clone(),
        version_ts: m.version_ts,
        segments: m.segments.iter().map(|s| SegmentId(s.id.clone())).collect(),
        wal_tail: m.wal_tail.as_ref().map(|w| WalTailMeta { epoch: w.epoch, seq: w.seq }),
    }
}

fn from_meta(meta: &ManifestMeta) -> mf::Manifest {
    mf::Manifest {
        branch: meta.branch.clone(),
        version_ts: meta.version_ts,
        segments: meta.segments.iter().map(|id| mf::SegmentRef { id: id.0.clone(), range: None }).collect(),
        wal_tail: meta.wal_tail.as_ref().map(|w| mf::WalTail { epoch: w.epoch, seq: w.seq }),
    }
}

impl StorageCatalog for FsBackend {
    fn list_branches(&self, root: &Path, db: &DatabaseName) -> Result<Vec<BranchName>, EngineError> {
        catalog::list_branches(root, db)
    }

    fn create_branch(&self, root: &Path, db: &DatabaseName, from: &BranchName, new_branch: &BranchName, at: Option<Timestamp>) -> Result<(), EngineError> {
        let base = match at {
            Some(ts) => mf::pitr_manifest(root, db, from, ts)?,
            None => mf::latest_manifest(root, db, from)?,
        };
        let now_ms: Timestamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
        let manifest = mf::Manifest {
            branch: new_branch.as_str().to_string(),
            version_ts: now_ms,
            segments: base.as_ref().map(|m| m.segments.clone()).unwrap_or_default(),
            wal_tail: base.as_ref().and_then(|m| m.wal_tail.clone()),
        };
        let _ = mf::write_manifest(root, db, new_branch, &manifest)?;
        Ok(())
    }
}

impl ManifestStore for FsBackend {
    fn list_snapshot_timestamps(&self, root: &Path, db: &DatabaseName, branch: &BranchName) -> Result<Vec<Timestamp>, EngineError> {
        let paths = mf::list_manifest_paths(root, db, branch)?;
        let mut ts = Vec::with_capacity(paths.len());
        for p in paths {
            let m = mf::read_manifest(&p)?;
            ts.push(m.version_ts);
        }
        Ok(ts)
    }

    fn latest_manifest_meta(&self, root: &Path, db: &DatabaseName, branch: &BranchName) -> Result<Option<ManifestMeta>, EngineError> {
        Ok(mf::latest_manifest(root, db, branch)?.map(|m| to_meta(&m)))
    }

    fn pitr_manifest_meta(&self, root: &Path, db: &DatabaseName, branch: &BranchName, at: Timestamp) -> Result<Option<ManifestMeta>, EngineError> {
        Ok(mf::pitr_manifest(root, db, branch, at)?.map(|m| to_meta(&m)))
    }

    fn read_manifest_meta(&self, root: &Path, db: &DatabaseName, branch: &BranchName, ts: Timestamp) -> Result<Option<ManifestMeta>, EngineError> {
        let file = format!("manifest-{}.json", ts);
        let path = catalog::branch_dir(root, db, branch).join(file);
        if !path.exists() {
            return Ok(None);
        }
        let m = mf::read_manifest(&path)?;
        Ok(Some(to_meta(&m)))
    }

    fn write_manifest_meta(&self, root: &Path, db: &DatabaseName, branch: &BranchName, meta: &ManifestMeta) -> Result<(), EngineError> {
        let m = from_meta(meta);
        let _ = mf::write_manifest(root, db, branch, &m)?;
        Ok(())
    }
}

impl StorageBackend for FsBackend {
    fn list_branches(&self, root: &Path, db: &DatabaseName) -> Result<Vec<BranchName>, EngineError> {
        catalog::list_branches(root, db)
    }

    fn create_branch(&self, root: &Path, db: &DatabaseName, from: &BranchName, new_branch: &BranchName, at: Option<Timestamp>) -> Result<(), EngineError> {
        let base = match at {
            Some(ts) => mf::pitr_manifest(root, db, from, ts)?,
            None => mf::latest_manifest(root, db, from)?,
        };
        let now_ms: Timestamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
        let manifest = mf::Manifest {
            branch: new_branch.as_str().to_string(),
            version_ts: now_ms,
            segments: base.as_ref().map(|m| m.segments.clone()).unwrap_or_default(),
            wal_tail: base.as_ref().and_then(|m| m.wal_tail.clone()),
        };
        let _ = mf::write_manifest(root, db, new_branch, &manifest)?;
        Ok(())
    }

    fn snapshot(&self, root: &Path, db: &DatabaseName, branch: &BranchName) -> Result<Timestamp, EngineError> {
        let base = mf::latest_manifest(root, db, branch)?;
        let now_ms: Timestamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
        let manifest = mf::Manifest {
            branch: branch.as_str().to_string(),
            version_ts: now_ms,
            segments: base.as_ref().map(|m| m.segments.clone()).unwrap_or_default(),
            wal_tail: base.as_ref().and_then(|m| m.wal_tail.clone()),
        };
        let _ = mf::write_manifest(root, db, branch, &manifest)?;
        Ok(now_ms)
    }

    fn commit_tx(&self, root: &Path, db: &DatabaseName, branch: &BranchName, records: &[Vec<u8>]) -> Result<Timestamp, EngineError> {
        let mut w = wal::WalWriter::open(root, db, branch, 4 * 1024 * 1024)?;
        for rec in records {
            w.write_record(rec)?;
        }
        w.flush()?;
        self.snapshot(root, db, branch)
    }

    fn list_snapshot_timestamps(&self, root: &Path, db: &DatabaseName, branch: &BranchName) -> Result<Vec<Timestamp>, EngineError> {
        let paths = mf::list_manifest_paths(root, db, branch)?;
        let mut ts = Vec::with_capacity(paths.len());
        for p in paths {
            let m = mf::read_manifest(&p)?;
            ts.push(m.version_ts);
        }
        Ok(ts)
    }
}

// -----------------------
// WAL ports implementation (FS)
// -----------------------

fn parse_seq_from_name(name: &str) -> Option<(u64, u64)> {
    if !name.starts_with("wal-") || !name.ends_with(".wal") { return None; }
    let core = &name[4..name.len()-4];
    let mut it = core.split('-');
    let epoch = it.next()?.parse::<u64>().ok()?;
    let seq = it.next()?.parse::<u64>().ok()?;
    Some((epoch, seq))
}

impl WalSink for FsBackend {
    fn append_records(&self, root: &Path, db: &DatabaseName, branch: &BranchName, records: &[Vec<u8>]) -> Result<WalTailMeta, EngineError> {
        let mut w = wal::WalWriter::open(root, db, branch, 4 * 1024 * 1024)?;
        for rec in records { w.write_record(rec)?; }
        w.flush()?;
        // Determine current tail by scanning latest file
        let paths = wal::list_wal_paths(root, db, branch)?;
        if let Some(last) = paths.last() {
            if let Some(name) = last.file_name().and_then(|s| s.to_str()) {
                if let Some((epoch, seq)) = parse_seq_from_name(name) {
                    return Ok(WalTailMeta { epoch, seq });
                }
            }
        }
        Ok(WalTailMeta { epoch: 0, seq: 0 })
    }
}

impl WalSource for FsBackend {
    fn list_wal_segments(&self, root: &Path, db: &DatabaseName, branch: &BranchName) -> Result<Vec<WalTailMeta>, EngineError> {
        let mut out = Vec::new();
        for p in wal::list_wal_paths(root, db, branch)? {
            if let Some(name) = p.file_name().and_then(|s| s.to_str()) {
                if let Some((epoch, seq)) = parse_seq_from_name(name) {
                    out.push(WalTailMeta { epoch, seq });
                }
            }
        }
        Ok(out)
    }

    fn read_wal_segment(&self, root: &Path, db: &DatabaseName, branch: &BranchName, tail: &WalTailMeta) -> Result<Vec<Vec<u8>>, EngineError> {
        for p in wal::list_wal_paths(root, db, branch)? {
            if let Some(name) = p.file_name().and_then(|s| s.to_str()) {
                if let Some((epoch, seq)) = parse_seq_from_name(name) {
                    if epoch == tail.epoch && seq == tail.seq {
                        return wal::read_records(&p);
                    }
                }
            }
        }
        Ok(Vec::new())
    }
}
