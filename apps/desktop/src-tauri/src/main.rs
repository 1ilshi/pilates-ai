// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod biomechanics;
mod camera;
mod cloud_sync;
mod commands;
mod error;
mod inference;
mod mock_source;
mod outbox;
mod pairing;
mod paths;
mod pose_config;
mod rep_tracker;
mod session;
mod state;
mod telemetry;

use tauri::Manager;

use crate::outbox::Outbox;
use crate::pose_config::PoseDefinitionDocument;
use crate::state::AppState;

/// Everything startup does, factored out so a failure can be logged before the
/// process exits.
fn initialise(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    // Installed builds keep config/ and the ONNX models in the resource
    // directory; expose it so the loaders can find them.
    if let Ok(resource_dir) = app.path().resource_dir() {
        std::env::set_var("TAURI_RESOURCE_DIR", &resource_dir);
    }

    // Resolve the per-user data directory once, from Tauri, so macOS and Linux
    // use their platform convention (`~/Library/Application Support/...`,
    // `~/.local/share/...`). Windows keeps its existing location — see
    // `paths::data_dir`.
    paths::init(
        app.path()
            .app_data_dir()
            .unwrap_or_else(|_| paths::fallback()),
    );

    let definitions = PoseDefinitionDocument::load()?;

    let data_dir = paths::data_dir();
    let mut outbox = Outbox::open(data_dir.join(outbox::DESKTOP_DB_FILENAME))?;

    // One-time import from the legacy Python database. That file uses an
    // incompatible schema, so it is read-only and never opened as our store
    // (see Step 6.5).
    let legacy = data_dir.join("pilates.db");
    if legacy.is_file() {
        match outbox.import_legacy_patients(&legacy) {
            Ok(0) => {}
            Ok(count) => {
                eprintln!("[pilates] imported {count} patient(s) from the legacy database")
            }
            Err(error) => eprintln!("[pilates] legacy import skipped: {error}"),
        }
    }

    // The archive bucket comes from the same configuration the sync client
    // uses. There is deliberately **no default**: the old `pilates-telemetry`
    // fallback stamped every session document with a bucket that does not
    // exist, so the portal advertised downloads that could never resolve.
    // Without a bucket, sessions queue locally instead of being written with a
    // pointer to nothing.
    let bucket = cloud_sync::CloudConfig::load()
        .map(|config| config.bucket)
        .unwrap_or_default();
    if bucket.is_empty() {
        eprintln!(
            "[pilates] no telemetry bucket configured — sessions queue locally \
             until PILATES_FIREBASE_BUCKET (or `bucket` in cloud.json) is set"
        );
    }

    // Surface the inference runtime up front: an unavailable engine produces an
    // empty overlay with no other symptom.
    eprintln!(
        "[pilates] ONNX Runtime: {}",
        inference::runtime_description()
    );

    let state = AppState::new(outbox, definitions, bucket);

    // Cloud sync is optional; a clinic can run fully offline.
    match commands::initialise_cloud_sync(&state) {
        Ok(true) => eprintln!("[pilates] cloud sync enabled"),
        Ok(false) => eprintln!("[pilates] cloud sync disabled (no credentials configured)"),
        Err(error) => eprintln!("[pilates] cloud sync unavailable: {error}"),
    }

    app.manage(state);
    Ok(())
}

/// Append a startup failure to `<data dir>/startup-error.log`.
///
/// Best effort: if even this fails there is nowhere left to report to.
fn record_startup_failure(error: &dyn std::error::Error) {
    let message = format!(
        "{}: {error}\n",
        chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
    );
    let path = paths::data_dir().join("startup-error.log");
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let written = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut file| {
            use std::io::Write;
            file.write_all(message.as_bytes())
        });
    if written.is_ok() {
        eprintln!("[pilates] startup failed: {error} (recorded in {})", path.display());
    } else {
        eprintln!("[pilates] startup failed: {error}");
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        // Checks a manifest on launch; installing is always a user action.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            if let Err(error) = initialise(app) {
                // A release build has no console (`windows_subsystem`), so a
                // failure here otherwise looks like "the app does nothing".
                record_startup_failure(&*error);
                return Err(error);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_cameras,
            commands::capture_status,
            commands::open_portal,
            commands::open_external,
            commands::sync_check_remote,
            commands::pairing_status,
            commands::pairing_start,
            commands::pairing_poll,
            commands::list_comments,
            commands::add_comment,
            commands::delete_comment,
            commands::engine_status,
            commands::get_pose_definitions,
            commands::movement_phases,
            commands::start_preview,
            commands::stop_preview,
            commands::set_preview_pose,
            commands::start_session,
            commands::capture_tick,
            commands::stop_session,
            commands::list_sessions,
            commands::list_all_sessions,
            commands::get_session_document,
            commands::list_patients,
            commands::save_patient,
            commands::delete_patient,
            commands::outbox_stats,
            commands::sync_now,
            commands::sync_pull_patients,
            commands::sync_status,
            commands::preview_frame,
            commands::preview_dimensions,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
