use std::{
    fs::{self, File},
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

use casys_core::{BranchName, DatabaseName, EngineError};

fn wal_dir(root: &Path, db: &DatabaseName, branch: &BranchName) -> PathBuf {
    root.join(db.as_str()).join("branches").join(branch.as_str()).join("wal")
}

fn wal_filename(epoch: u64, seq: u64) -> String {
    format!("wal-{}-{}.wal", epoch, seq)
}

fn parse_seq_from_name(name: &str) -> Option<(u64, u64)> {
    // wal-<epoch>-<seq>.wal
    if !name.starts_with("wal-") || !name.ends_with(".wal") { return None; }
    let core = &name[4..name.len()-4];
    let mut it = core.split('-');
    let epoch = it.next()?.parse::<u64>().ok()?;
    let seq = it.next()?.parse::<u64>().ok()?;
    Some((epoch, seq))
}

pub fn list_wal_paths(root: &Path, db: &DatabaseName, branch: &BranchName) -> Result<Vec<PathBuf>, EngineError> {
    let dir = wal_dir(root, db, branch);
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
            if parse_seq_from_name(name).is_some() { out.push(p); }
        }
    }
    out.sort_by(|a,b| a.file_name().cmp(&b.file_name()));
    Ok(out)
}

pub struct WalWriter {
    dir: PathBuf,
    file: File,
    epoch: u64,
    seq: u64,
    bytes_written: u64,
    max_segment_bytes: u64,
}

impl WalWriter {
    pub fn open(root: &Path, db: &DatabaseName, branch: &BranchName, max_segment_bytes: u64) -> Result<Self, EngineError> {
        let dir = wal_dir(root, db, branch);
        fs::create_dir_all(&dir).map_err(|e| EngineError::StorageIo(format!("create_dir_all({}): {e}", dir.display())))?;
        // Determine next seq
        let mut next_epoch = 0u64;
        let mut next_seq = 0u64;
        let existing = list_wal_paths(root, db, branch)?;
        if let Some(last) = existing.last() {
            if let Some(name) = last.file_name().and_then(|s| s.to_str()) { if let Some((ep, sq)) = parse_seq_from_name(name) {
                next_epoch = ep;
                next_seq = sq + 1;
            }}
        }
        let path = dir.join(wal_filename(next_epoch, next_seq));
        let file = File::create(&path).map_err(|e| EngineError::StorageIo(format!("create({}): {e}", path.display())))?;
        Ok(Self { dir, file, epoch: next_epoch, seq: next_seq, bytes_written: 0, max_segment_bytes })
    }

    fn rotate(&mut self) -> Result<(), EngineError> {
        self.seq += 1;
        let path = self.dir.join(wal_filename(self.epoch, self.seq));
        self.file = File::create(&path).map_err(|e| EngineError::StorageIo(format!("create({}): {e}", path.display())))?;
        self.bytes_written = 0;
        Ok(())
    }

    /// Write a length-prefixed record (u32 LE + payload)
    pub fn write_record(&mut self, payload: &[u8]) -> Result<(), EngineError> {
        let need = 4u64 + payload.len() as u64;
        if self.bytes_written + need > self.max_segment_bytes {
            self.flush()?;
            self.rotate()?;
        }
        let len = payload.len() as u32;
        self.file.write_all(&len.to_le_bytes())
            .and_then(|_| self.file.write_all(payload))
            .map_err(|e| EngineError::StorageIo(format!("wal write: {e}")))?;
        self.bytes_written += need;
        Ok(())
    }

    pub fn flush(&mut self) -> Result<(), EngineError> {
        self.file.sync_all().map_err(|e| EngineError::StorageIo(format!("wal fsync: {e}")))
    }
}

pub fn read_records(path: &Path) -> Result<Vec<Vec<u8>>, EngineError> {
    let mut f = File::open(path).map_err(|e| EngineError::StorageIo(format!("open({}): {e}", path.display())))?;
    let mut out = Vec::new();
    loop {
        let mut len_bytes = [0u8; 4];
        match f.read_exact(&mut len_bytes) {
            Ok(()) => {},
            Err(e) => {
                if e.kind() == io::ErrorKind::UnexpectedEof { break; }
                else { return Err(EngineError::StorageIo(format!("read len: {e}"))); }
            }
        }
        let len = u32::from_le_bytes(len_bytes) as usize;
        let mut buf = vec![0u8; len];
        f.read_exact(&mut buf).map_err(|e| EngineError::StorageIo(format!("read payload: {e}")))?;
        out.push(buf);
    }
    Ok(out)
}
