//! Per-user application data directory.
//!
//! The SQLite outbox, `cloud.json`, the workstation's `instance-id` and the
//! legacy import source all live in one directory per user. It is resolved
//! **once** at startup, from Tauri — which knows the platform convention —
//! and cached, because the sync layer needs it from threads that hold no
//! `AppHandle`.

use std::path::PathBuf;
use std::sync::OnceLock;

/// Set once from `setup` with the directory Tauri resolved.
static RESOLVED: OnceLock<PathBuf> = OnceLock::new();

/// Record the directory resolved at startup.
///
/// Ignored on Windows, where the location is pinned for compatibility (see
/// [`data_dir`]). Called once; later calls are no-ops.
pub fn init(dir: PathBuf) {
    let _ = RESOLVED.set(dir);
}

/// The directory holding this user's desktop state.
///
/// Precedence:
/// 1. `PILATES_AI_DATA_DIR` — CI, kiosks and tests.
/// 2. Windows: `%LOCALAPPDATA%\PilatesAI`. Deliberately **not** Tauri's
///    roaming `app_data_dir`: 2.0.0 already wrote its database there, and
///    relocating it would orphan every existing installation's patients on
///    upgrade.
/// 3. The directory Tauri resolved at startup (macOS, Linux).
/// 4. `$HOME/.pilates-ai`, when nothing was initialised — unit tests and
///    command-line tools.
pub fn data_dir() -> PathBuf {
    if let Ok(override_dir) = std::env::var("PILATES_AI_DATA_DIR") {
        return PathBuf::from(override_dir);
    }

    #[cfg(target_os = "windows")]
    {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            return PathBuf::from(local).join("PilatesAI");
        }
    }

    if let Some(dir) = RESOLVED.get() {
        return dir.clone();
    }

    fallback()
}

/// Last-resort location, also used when Tauri cannot resolve one.
pub fn fallback() -> PathBuf {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".pilates-ai")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `PILATES_AI_DATA_DIR` is process-global; serialise the tests that set it.
    static ENV: std::sync::Mutex<()> = std::sync::Mutex::new(());

    struct Override(Option<std::ffi::OsString>);

    impl Override {
        fn set(value: &std::path::Path) -> Self {
            let previous = std::env::var_os("PILATES_AI_DATA_DIR");
            std::env::set_var("PILATES_AI_DATA_DIR", value);
            Self(previous)
        }
    }

    impl Drop for Override {
        fn drop(&mut self) {
            match self.0.take() {
                Some(value) => std::env::set_var("PILATES_AI_DATA_DIR", value),
                None => std::env::remove_var("PILATES_AI_DATA_DIR"),
            }
        }
    }

    #[test]
    fn override_wins_over_everything() {
        let _guard = ENV.lock().unwrap_or_else(|error| error.into_inner());
        let dir = std::env::temp_dir().join("pilates-data-dir-override");
        let _override = Override::set(&dir);

        assert_eq!(data_dir(), dir);
    }

    #[test]
    fn fallback_is_a_directory_path() {
        // Must never be empty and must not be the bare root.
        let path = fallback();
        assert!(path.components().count() > 1, "{}", path.display());
        assert!(path.ends_with(".pilates-ai"), "{}", path.display());
    }
}
