//! Atomic writes: the file is written next to its destination, then renamed over it, so that a crash
//! never leaves a half-written workspace behind.

use std::fs;
use std::io::Write;
use std::path::Path;

use crate::StorageError;

pub fn write(path: &Path, bytes: &[u8]) -> Result<(), StorageError> {
    let io = |source| StorageError::Io { path: path.to_path_buf(), source };
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(io)?;
    }
    let mut temp = path.as_os_str().to_owned();
    temp.push(".tmp");
    let temp = Path::new(&temp);
    let mut file = fs::File::create(temp).map_err(io)?;
    file.write_all(bytes).and_then(|()| file.sync_all()).map_err(io)?;
    drop(file);
    fs::rename(temp, path).map_err(io)
}
