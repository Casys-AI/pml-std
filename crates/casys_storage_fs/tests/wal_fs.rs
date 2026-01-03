// Integration test: FS WAL ports (append/list/read)

use casys_storage_fs::backend::FsBackend;
use casys_core::{DatabaseName, BranchName, WalSink, WalSource};
use std::time::{SystemTime, UNIX_EPOCH};
use std::fs;

#[test]
fn wal_append_list_read() {
    // Unique temp dir under target/tmp
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis();
    let root = std::env::current_dir().unwrap()
        .join("target").join("tmp").join(format!("wal_fs_{}", now));
    fs::create_dir_all(&root).unwrap();

    let backend = FsBackend::new();
    let db = DatabaseName::try_from("testdb").unwrap();
    let br = BranchName::try_from("main").unwrap();

    // Append two records
    let rec1 = br#"{"op":"set","k":"a","v":1}"#.to_vec();
    let rec2 = br#"{"op":"set","k":"b","v":2}"#.to_vec();
    let tail = <FsBackend as WalSink>::append_records(&backend, root.as_path(), &db, &br, &[rec1.clone(), rec2.clone()]).unwrap();

    // List segments
    let segs = <FsBackend as WalSource>::list_wal_segments(&backend, root.as_path(), &db, &br).unwrap();
    assert!(!segs.is_empty());

    // Read back the last segment
    let records = <FsBackend as WalSource>::read_wal_segment(&backend, root.as_path(), &db, &br, &tail).unwrap();
    assert!(records.len() >= 2);
    assert_eq!(records[records.len()-2], rec1);
    assert_eq!(records[records.len()-1], rec2);
}
