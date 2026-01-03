use std::{fs, io, path::{Path, PathBuf}};

use serde::{Deserialize, Serialize};

use casys_core::{BranchName, DatabaseName, EngineError, Timestamp};
use crate::util::atomic_write_file;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Range {
    pub tx_min: u64,
    pub tx_max: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SegmentRef {
    pub id: String, // sha256:...
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub range: Option<Range>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WalTail {
    pub epoch: u64,
    pub seq: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub branch: String,
    pub version_ts: Timestamp,
    #[serde(default)]
    pub segments: Vec<SegmentRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wal_tail: Option<WalTail>,
}

impl Manifest {
    pub fn filename(&self) -> String {
        format!("manifest-{}.json", self.version_ts)
    }
}

fn branch_dir(root: &Path, db: &DatabaseName, branch: &BranchName) -> PathBuf {
    root.join(db.as_str()).join("branches").join(branch.as_str())
}

pub fn write_manifest(root: &Path, db: &DatabaseName, branch: &BranchName, m: &Manifest) -> Result<PathBuf, EngineError> {
    let dir = branch_dir(root, db, branch);
    fs::create_dir_all(&dir).map_err(|e| EngineError::StorageIo(format!("create_dir_all({}): {e}", dir.display())))?;
    let path = dir.join(m.filename());
    let bytes = serde_json::to_vec_pretty(m).map_err(|e| EngineError::StorageIo(format!("serialize manifest: {e}")))?;
    atomic_write_file(&path, &bytes).map_err(|e| EngineError::StorageIo(format!("atomic_write_file({}): {e}", path.display())))?;
    Ok(path)
}

pub fn read_manifest(path: &Path) -> Result<Manifest, EngineError> {
    let data = fs::read(path).map_err(|e| EngineError::StorageIo(format!("read({}): {e}", path.display())))?;
    let m: Manifest = serde_json::from_slice(&data).map_err(|e| EngineError::StorageIo(format!("parse manifest ({}): {e}", path.display())))?;
    Ok(m)
}

fn parse_ts_from_filename(file_name: &str) -> Option<Timestamp> {
    // Expect manifest-<ts>.json
    let name = file_name.strip_prefix("manifest-")?.strip_suffix(".json")?;
    name.parse::<u64>().ok()
}

pub fn list_manifest_paths(root: &Path, db: &DatabaseName, branch: &BranchName) -> Result<Vec<PathBuf>, EngineError> {
    let dir = branch_dir(root, db, branch);
    let mut paths = Vec::new();
    let iter = match fs::read_dir(&dir) { Ok(it) => it, Err(e) => {
        if e.kind() == io::ErrorKind::NotFound { return Ok(paths); } else { return Err(EngineError::StorageIo(format!("read_dir({}): {e}", dir.display()))); }
    }};
    for entry in iter {
        let entry = entry.map_err(|e| EngineError::StorageIo(format!("read_dir entry: {e}")))?;
        let p = entry.path();
        if let Some(name) = p.file_name().and_then(|s| s.to_str()) {
            if name.starts_with("manifest-") && name.ends_with(".json") && parse_ts_from_filename(name).is_some() {
                paths.push(p);
            }
        }
    }
    paths.sort_by(|a, b| a.file_name().cmp(&b.file_name()));
    Ok(paths)
}

pub fn latest_manifest(root: &Path, db: &DatabaseName, branch: &BranchName) -> Result<Option<Manifest>, EngineError> {
    let mut paths = list_manifest_paths(root, db, branch)?;
    if let Some(p) = paths.pop() {
        read_manifest(&p).map(Some)
    } else {
        Ok(None)
    }
}

pub fn pitr_manifest(root: &Path, db: &DatabaseName, branch: &BranchName, at: Timestamp) -> Result<Option<Manifest>, EngineError> {
    let paths = list_manifest_paths(root, db, branch)?;
    let mut best: Option<(Timestamp, PathBuf)> = None;
    for p in paths {
        if let Some(name) = p.file_name().and_then(|s| s.to_str()) {
            if let Some(ts) = parse_ts_from_filename(name) {
                if ts <= at {
                    match &best {
                        Some((best_ts, _)) if *best_ts >= ts => { /* keep */ }
                        _ => best = Some((ts, p.clone())),
                    }
                }
            }
        }
    }
    if let Some((_, p)) = best { read_manifest(&p).map(Some) } else { Ok(None) }
}
