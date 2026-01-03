//! Utilitaires système (fs atomique, checksums, paths)

use std::{fs, io::{self, Write}, path::Path};
use std::time::{SystemTime, UNIX_EPOCH};

/// Fsync the directory containing the given path.
pub fn fsync_dir(dir: &Path) -> io::Result<()> {
    // Open the directory and sync it
    let file = fs::File::open(dir)?;
    file.sync_all()
}

/// Atomically write bytes to `path` by writing to a temp file in the same directory then renaming.
/// Ensures data and metadata durability by fsyncing the file and its parent directory.
pub fn atomic_write_file(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = path.parent().ok_or_else(|| io::Error::new(io::ErrorKind::Other, "missing parent"))?;
    fs::create_dir_all(parent)?;

    let ts = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis();
    let tmp_path = parent.join(format!(".{}.tmp-{}", path.file_name().unwrap().to_string_lossy(), ts));

    {
        let mut f = fs::File::create(&tmp_path)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }

    // Rename is atomic on POSIX when on the same filesystem
    fs::rename(&tmp_path, path)?;

    // Fsync directory to persist the rename
    fsync_dir(parent)
}
