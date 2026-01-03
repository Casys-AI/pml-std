use std::{fs, io, path::Path};

pub fn fsync_dir(dir: &Path) -> io::Result<()> {
    let file = fs::File::open(dir)?;
    file.sync_all()
}

pub fn atomic_write_file(path: &Path, bytes: &[u8]) -> io::Result<()> {
    use std::io::Write;
    use std::time::{SystemTime, UNIX_EPOCH};

    let parent = path.parent().ok_or_else(|| io::Error::new(io::ErrorKind::Other, "missing parent"))?;
    fs::create_dir_all(parent)?;

    let ts = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis();
    let tmp_path = parent.join(format!(".{}.tmp-{}", path.file_name().unwrap().to_string_lossy(), ts));

    {
        let mut f = fs::File::create(&tmp_path)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }

    fs::rename(&tmp_path, path)?;
    fsync_dir(parent)
}
