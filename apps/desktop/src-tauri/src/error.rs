//! Unified error type for the native engine.
//!
//! Tauri commands return `EngineResult<T>`; the `Serialize` impl below flattens
//! the error into a human-readable string for the React layer, which renders it
//! in a toast rather than exposing a Rust backtrace.

use serde::{Serialize, Serializer};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum EngineError {
    #[error("camera: {0}")]
    Camera(String),

    #[error("inference: {0}")]
    Inference(String),

    #[error("telemetry: {0}")]
    Telemetry(String),

    #[error("storage: {0}")]
    Storage(String),

    #[error("sync: {0}")]
    Sync(String),

    /// A concurrent edit landed first. The write was refused rather than
    /// silently overwriting it; the caller must re-read before retrying.
    #[error("conflict: {0}")]
    Conflict(String),

    #[error("configuration: {0}")]
    Config(String),

    #[error("invalid input: {0}")]
    Invalid(String),

    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    #[error("json: {0}")]
    Json(#[from] serde_json::Error),

    #[error("database: {0}")]
    Sqlite(#[from] rusqlite::Error),
}

pub type EngineResult<T> = Result<T, EngineError>;

impl Serialize for EngineError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

impl From<reqwest::Error> for EngineError {
    fn from(value: reqwest::Error) -> Self {
        EngineError::Sync(value.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_serializes_as_display_string() {
        let error = EngineError::Camera("no device".into());
        let json = serde_json::to_string(&error).expect("serialize");
        assert_eq!(json, "\"camera: no device\"");
    }

    #[test]
    fn io_errors_convert() {
        let io = std::io::Error::new(std::io::ErrorKind::NotFound, "missing");
        let error: EngineError = io.into();
        assert!(error.to_string().starts_with("io:"));
    }
}
