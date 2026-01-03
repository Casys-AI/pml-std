use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
};

use casys_core::{DatabaseName, EngineError};

const SEGMENT_MAGIC: u32 = 0x43415353; // "CASS" for Casys
const SEGMENT_VERSION: u16 = 1;

#[derive(Debug, Clone)]
pub struct SegmentHeader {
    pub magic: u32,
    pub version: u16,
    pub node_count: u64,
    pub edge_count: u64,
    pub checksum: u32, // CRC32 of the data section
}

impl SegmentHeader {
    pub fn new(node_count: u64, edge_count: u64, checksum: u32) -> Self {
        Self {
            magic: SEGMENT_MAGIC,
            version: SEGMENT_VERSION,
            node_count,
            edge_count,
            checksum,
        }
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        let mut buf = Vec::new();
        buf.extend_from_slice(&self.magic.to_le_bytes());
        buf.extend_from_slice(&self.version.to_le_bytes());
        buf.extend_from_slice(&self.node_count.to_le_bytes());
        buf.extend_from_slice(&self.edge_count.to_le_bytes());
        buf.extend_from_slice(&self.checksum.to_le_bytes());
        buf
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self, EngineError> {
        if bytes.len() < 26 {
            return Err(EngineError::StorageIo("segment header too short".into()));
        }
        let magic = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
        if magic != SEGMENT_MAGIC {
            return Err(EngineError::StorageIo(format!("invalid segment magic: {:#x}", magic)));
        }
        let version = u16::from_le_bytes([bytes[4], bytes[5]]);
        let node_count = u64::from_le_bytes([bytes[6], bytes[7], bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13]]);
        let edge_count = u64::from_le_bytes([bytes[14], bytes[15], bytes[16], bytes[17], bytes[18], bytes[19], bytes[20], bytes[21]]);
        let checksum = u32::from_le_bytes([bytes[22], bytes[23], bytes[24], bytes[25]]);
        Ok(Self { magic, version, node_count, edge_count, checksum })
    }
}

#[derive(Debug, Clone)]
pub struct Segment {
    pub header: SegmentHeader,
    pub data: Vec<u8>,
}

impl Segment {
    pub fn new(node_count: u64, edge_count: u64, data: Vec<u8>) -> Self {
        let checksum = crc32fast::hash(&data);
        Self {
            header: SegmentHeader::new(node_count, edge_count, checksum),
            data,
        }
    }

    pub fn write_to_path(&self, path: &Path) -> Result<(), EngineError> {
        if let Some(p) = path.parent() {
            fs::create_dir_all(p).map_err(|e| EngineError::StorageIo(format!("create_dir_all: {e}")))?;
        }
        let mut f = File::create(path).map_err(|e| EngineError::StorageIo(format!("create({}): {e}", path.display())))?;
        f.write_all(&self.header.to_bytes())
            .and_then(|_| f.write_all(&self.data))
            .and_then(|_| f.sync_all())
            .map_err(|e| EngineError::StorageIo(format!("write segment: {e}")))
    }

    pub fn read_from_path(path: &Path) -> Result<Self, EngineError> {
        let mut f = File::open(path).map_err(|e| EngineError::StorageIo(format!("open({}): {e}", path.display())))?;
        let mut hdr_bytes = vec![0u8; 26];
        f.read_exact(&mut hdr_bytes).map_err(|e| EngineError::StorageIo(format!("read header: {e}")))?;
        let header = SegmentHeader::from_bytes(&hdr_bytes)?;
        let mut data = Vec::new();
        f.read_to_end(&mut data).map_err(|e| EngineError::StorageIo(format!("read data: {e}")))?;
        let computed = crc32fast::hash(&data);
        if computed != header.checksum {
            return Err(EngineError::StorageIo(format!("checksum mismatch: expected {:#x}, got {:#x}", header.checksum, computed)));
        }
        Ok(Self { header, data })
    }
}

fn segments_dir(root: &Path, db: &DatabaseName) -> PathBuf {
    root.join(db.as_str()).join("segments")
}

pub fn segment_path(root: &Path, db: &DatabaseName, segment_id: &str) -> PathBuf {
    let dir = segments_dir(root, db);
    // Use first 2 chars as prefix for sharding
    let prefix = if segment_id.len() >= 2 { &segment_id[..2] } else { "00" };
    dir.join(prefix).join(format!("{}.seg", segment_id))
}

pub fn write_segment(root: &Path, db: &DatabaseName, segment_id: &str, seg: &Segment) -> Result<PathBuf, EngineError> {
    let path = segment_path(root, db, segment_id);
    seg.write_to_path(&path)?;
    Ok(path)
}

pub fn read_segment(root: &Path, db: &DatabaseName, segment_id: &str) -> Result<Segment, EngineError> {
    let path = segment_path(root, db, segment_id);
    Segment::read_from_path(&path)
}
