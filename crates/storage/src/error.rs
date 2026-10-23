use std::path::PathBuf;

use thiserror::Error;

/// Storage error. As in the core, [`StorageError::code`] lets the interface translate it.
#[derive(Debug, Error)]
pub enum StorageError {
    #[error("cannot access « {path} »: {source}")]
    Io { path: PathBuf, source: std::io::Error },
    #[error("« {path} » cannot be written: {source}")]
    Format { path: PathBuf, source: serde_json::Error },
}

impl StorageError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Io { .. } => "file_access",
            Self::Format { .. } => "file_format",
        }
    }

    pub fn subject(&self) -> Option<String> {
        match self {
            Self::Io { path, .. } | Self::Format { path, .. } => Some(path.display().to_string()),
        }
    }
}
