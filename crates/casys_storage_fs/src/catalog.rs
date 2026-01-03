use std::{fs, io, path::{Path, PathBuf}};

use casys_core::{BranchName, DatabaseName, EngineError};
use crate::manifest as mf;

pub fn db_dir(root: &Path, db: &DatabaseName) -> PathBuf {
    root.join(db.as_str())
}

pub fn branches_dir(root: &Path, db: &DatabaseName) -> PathBuf {
    db_dir(root, db).join("branches")
}

pub fn branch_dir(root: &Path, db: &DatabaseName, branch: &BranchName) -> PathBuf {
    branches_dir(root, db).join(branch.as_str())
}

pub fn list_branches(root: &Path, db: &DatabaseName) -> Result<Vec<BranchName>, EngineError> {
    let dir = branches_dir(root, db);
    let mut out = Vec::new();
    let it = match fs::read_dir(&dir) {
        Ok(it) => it,
        Err(e) => {
            if e.kind() == io::ErrorKind::NotFound { return Ok(out); }
            else { return Err(EngineError::StorageIo(format!("read_dir({}): {e}", dir.display()))); }
        }
    };
    for entry in it {
        let entry = entry.map_err(|e| EngineError::StorageIo(format!("read_dir entry: {e}")))?;
        let p = entry.path();
        if let Some(name) = p.file_name().and_then(|s| s.to_str()) {
            let br = match BranchName::try_from(name) { Ok(b)=>b, Err(_)=>continue };
            let paths = mf::list_manifest_paths(root, db, &br)?;
            if !paths.is_empty() { out.push(br); }
        }
    }
    out.sort_by(|a,b| a.as_str().cmp(b.as_str()));
    Ok(out)
}
