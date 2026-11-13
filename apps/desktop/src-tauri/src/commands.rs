//! Tauri IPC command handlers (Step 5).
//!
//! Each command is a thin adapter over the engine modules: it validates input,
//! takes the relevant lock, delegates, and returns a serializable result. The
//! live preview runs on a dedicated thread that pushes `telemetry-frame` events
//! to the React shell at capture cadence.

use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

use crate::biomechanics::{MovementPhase, RepFsm};
use crate::camera::{self, CameraDescriptor};
use crate::cloud_sync::{CloudConfig, CloudSync, SyncReport};
use crate::error::{EngineError, EngineResult};
use crate::inference::{ExecutionProviderKind, InferenceEngine, InferenceOutput};
use crate::outbox::{OutboxStats, StoredPatient, StoredSession};
use crate::pose_config::{find_config_file, PoseDefinition, PoseDefinitionDocument};
use crate::session::{mean_confidence, primary_angle_from_detection, CaptureSession, ClinicalSessionDocument};
use crate::state::AppState;

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct KeypointPayload {
    pub id: i32,
    pub label: String,
    pub x: f32,
    pub y: f32,
    pub confidence: f32,
}

/// One detection, so the UI can outline it the way the old app did.
#[derive(Debug, Clone, Serialize)]
pub struct DetectionPayload {
    pub bbox: [f32; 4],
    pub class_id: i32,
    pub confidence: f32,
    pub label: String,
}

/// Matches `LiveTelemetryFrame` in `packages/types`.
#[derive(Debug, Clone, Serialize)]
pub struct TelemetryFramePayload {
    pub timestamp_ms: i64,
    pub frame_index: i64,
    pub pose_id: String,
    pub phase: String,
    pub rep_count: u32,
    pub primary_angle: f32,
    pub target_angle: f32,
    pub angle_deviation: f32,
    pub instantaneous_form_score: f32,
    pub hold_duration_sec: f32,
    pub keypoints: Vec<KeypointPayload>,
    pub detections: Vec<DetectionPayload>,
    /// Strongest class in the frame, even when below the display threshold.
    /// This is what answers "is the model seeing me at all?".
    pub best_class_label: String,
    pub best_class_score: f32,
    pub inference_ms: f32,
}

#[derive(Debug, Clone, Serialize)]
pub struct PreviewStatus {
    pub running: bool,
    pub device: Option<CameraDescriptor>,
    pub pose_id: Option<String>,
    pub provider: String,
    pub inference_available: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct EngineStatus {
    /// An inference session is actually loaded and usable.
    pub inference_available: bool,
    /// The shared library was located on disk (necessary, not sufficient).
    pub runtime_found: bool,
    pub provider: String,
    pub detail: String,
    pub poses: Vec<PoseSummary>,
    pub cloud_sync_enabled: bool,
    /// A telemetry archive bucket is configured. Without one, sessions are
    /// recorded and queued locally but their Parquet archive is never
    /// uploaded, so the portal shows no telemetry for the patient. That is
    /// otherwise invisible until someone asks why the charts are empty.
    pub bucket_configured: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct PoseSummary {
    pub pose_id: String,
    pub display_name: String,
    pub keypoint_count: usize,
    pub target_angle: f32,
    pub hold_seconds: f32,
    pub model_version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionListItem {
    pub session_id: String,
    pub patient_id: String,
    pub pose_id: String,
    pub created_at: String,
    pub upload_state: String,
    pub document: Value,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PatientInputDto {
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub age: Option<String>,
    #[serde(default)]
    pub weight: Option<String>,
    #[serde(default)]
    pub height: Option<String>,
    #[serde(default)]
    pub gender: Option<String>,
    /// Contact details. `None` means "not sent, leave as is"; an empty string
    /// means "the clinician cleared it", which the `COALESCE` upsert then
    /// stores rather than preserving the old value.
    #[serde(default)]
    pub address: Option<String>,
    #[serde(default)]
    pub tel_number: Option<String>,
}

// ---------------------------------------------------------------------------
// Model manifest
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct ManifestDocument {
    #[serde(default)]
    onnx_models: Vec<ManifestModel>,
}

#[derive(Debug, Deserialize)]
struct ManifestModel {
    pose: String,
    onnx_path: String,
    num_classes: usize,
    num_keypoints: usize,
    #[serde(default)]
    sha256: String,
    /// `{"0": "end", "1": "start"}` as emitted by the export tool.
    #[serde(default)]
    class_names: std::collections::BTreeMap<String, String>,
}

/// Resolve a pose's ONNX model path, class/keypoint counts, version digest and
/// class names.
fn resolve_model(pose_id: &str) -> EngineResult<(PathBuf, usize, usize, String, Vec<String>)> {
    let manifest_path = find_config_file("model-manifest.json")
        .ok_or_else(|| EngineError::Config("model-manifest.json not found".into()))?;
    let raw = crate::pose_config::read_config_text(&manifest_path)
        .map_err(|e| EngineError::Config(format!("cannot read model manifest: {e}")))?;
    let manifest: ManifestDocument = serde_json::from_str(&raw)
        .map_err(|e| EngineError::Config(format!("invalid model manifest: {e}")))?;

    let entry = manifest
        .onnx_models
        .iter()
        .find(|model| model.pose == pose_id)
        .ok_or_else(|| EngineError::Config(format!("no ONNX model registered for {pose_id}")))?;

    // Manifest paths are recorded relative to the repo root ("config/models/x.onnx").
    let file_name = entry
        .onnx_path
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(&entry.onnx_path);
    let model_path = find_config_file(&format!("models/{file_name}"))
        .or_else(|| find_config_file(file_name))
        .ok_or_else(|| {
            EngineError::Config(format!(
                "model file {file_name} not found under config/models"
            ))
        })?;

    let version = if entry.sha256.len() >= 16 {
        entry.sha256[..16].to_string()
    } else {
        "2.0.0".to_string()
    };

    // Class names arrive as a string-keyed map; rebuild them in id order.
    let mut class_names = vec![String::new(); entry.num_classes];
    for (key, value) in &entry.class_names {
        if let Ok(index) = key.parse::<usize>() {
            if index < class_names.len() {
                class_names[index] = value.clone();
            }
        }
    }

    Ok((
        model_path,
        entry.num_classes,
        entry.num_keypoints,
        version,
        class_names,
    ))
}

/// Load (or reuse) the inference engine for a pose.
fn ensure_engine(state: &AppState, pose_id: &str) -> EngineResult<()> {
    let mut guard = state
        .engine
        .lock()
        .map_err(|_| EngineError::Inference("engine lock poisoned".into()))?;

    if let Some(engine) = guard.as_ref() {
        if engine.pose_id() == pose_id {
            return Ok(());
        }
    }

    let (model_path, num_classes, num_keypoints, _, class_names) = resolve_model(pose_id)?;

    // Drop the previous engine first: if the new load fails, the app must not
    // keep running the old pose's model, which would produce detections for
    // the wrong pose and look like "the model sees nothing".
    *guard = None;

    let engine = InferenceEngine::load(
        &model_path,
        pose_id,
        num_classes,
        num_keypoints,
        class_names,
    )?;
    *guard = Some(engine);
    Ok(())
}

fn pose_definition<'a>(
    definitions: &'a PoseDefinitionDocument,
    pose_id: &str,
) -> EngineResult<&'a PoseDefinition> {
    definitions.pose(pose_id)
}

fn metrics_to_payload(
    pose_id: &str,
    frame_index: i64,
    timestamp_ms: i64,
    metrics: &crate::biomechanics::FrameMetrics,
    output: &InferenceOutput,
    pose: &PoseDefinition,
) -> TelemetryFramePayload {
    let best = output.detections.iter().max_by(|a, b| {
        a.class_confidence
            .partial_cmp(&b.class_confidence)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let keypoints = best
        .map(|detection| {
            detection
                .keypoints
                .iter()
                .map(|keypoint| KeypointPayload {
                    id: keypoint.id,
                    label: pose
                        .keypoint_labels
                        .get(keypoint.id as usize)
                        .cloned()
                        .unwrap_or_default(),
                    x: keypoint.x,
                    y: keypoint.y,
                    confidence: keypoint.confidence,
                })
                .collect()
        })
        .unwrap_or_default();

    TelemetryFramePayload {
        timestamp_ms,
        frame_index,
        pose_id: pose_id.to_string(),
        phase: metrics.phase.as_str().to_string(),
        rep_count: metrics.rep_count,
        primary_angle: if metrics.primary_angle.is_finite() {
            metrics.primary_angle
        } else {
            0.0
        },
        target_angle: metrics.target_angle,
        angle_deviation: if metrics.angle_deviation.is_finite() {
            metrics.angle_deviation
        } else {
            0.0
        },
        instantaneous_form_score: metrics.instantaneous_form_score,
        hold_duration_sec: metrics.hold_duration_sec,
        keypoints,
        detections: output
            .detections
            .iter()
            .map(|detection| DetectionPayload {
                bbox: detection.bbox,
                class_id: detection.class_id,
                confidence: detection.class_confidence,
                label: detection.label.clone(),
            })
            .collect(),
        best_class_label: output.best_class_label.clone(),
        best_class_score: output.best_class_score,
        inference_ms: output.inference_ms,
    }
}

// ---------------------------------------------------------------------------
// Commands: devices & engine
// ---------------------------------------------------------------------------

/// Live capture diagnostics.
///
/// Exists because "no frames were captured" is indistinguishable from several
/// different faults (camera idle, preview loop not running, session not
/// attached). Surfacing the counters makes the cause obvious instead of
/// requiring a terminal.
#[derive(Debug, Clone, Serialize)]
pub struct CaptureStatus {
    pub preview_running: bool,
    pub session_active: bool,
    pub session_frames: usize,
    pub engine_available: bool,
    pub camera_frames: u64,
    /// Repetitions counted so far in the active session.
    pub rep_count: u32,
    /// `start` positions confirmed — one per attempted repetition.
    pub attempts: u32,
    /// Transitions discarded for being too fast.
    pub rejected_reps: u32,
    /// Duration of the most recently counted repetition, in seconds.
    pub last_rep_duration_sec: f32,
    /// Last fatal error from the capture thread, if any.
    ///
    /// The camera thread records decode and frame-grab failures but nothing
    /// surfaced them, so an unplugged webcam left a frozen frame under a green
    /// "Live" badge while the session recorded nothing.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub camera_error: Option<String>,
    /// Time since the current `start`, in seconds (0 when idle).
    pub active_hold_sec: f32,
    /// Latest composite pose accuracy, 0-100.
    pub last_form_score: f32,
}

#[tauri::command]
pub fn capture_status(state: State<'_, AppState>) -> CaptureStatus {
    let preview_running = state.preview_running.load(Ordering::Relaxed);

    let engine_available = state
        .engine
        .lock()
        .map(|guard| guard.is_some())
        .unwrap_or(false);

    let camera_frames = state
        .camera
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|camera| camera.frames_captured()))
        .unwrap_or(0);

    let session = state.session.lock().ok();
    let active = session.as_ref().and_then(|guard| guard.as_ref());

    // The capture thread records why a frame could not be read; without this
    // the UI showed a frozen frame and no reason for it.
    let camera_error = state
        .camera
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().and_then(|camera| camera.last_error()));

    CaptureStatus {
        preview_running,
        session_active: active.is_some(),
        session_frames: active.map(|s| s.frame_count()).unwrap_or(0),
        engine_available,
        camera_frames,
        camera_error,
        rep_count: active.map(|s| s.rep_count()).unwrap_or(0),
        attempts: active.map(|s| s.attempts()).unwrap_or(0),
        rejected_reps: active.map(|s| s.rejected_reps()).unwrap_or(0),
        last_rep_duration_sec: active
            .and_then(|s| s.last_rep().map(|rep| rep.duration_sec))
            .unwrap_or(0.0),
        active_hold_sec: active.map(|s| s.active_hold_now()).unwrap_or(0.0),
        last_form_score: active.map(|s| s.last_form_score()).unwrap_or(0.0),
    }
}

#[tauri::command]
pub fn list_cameras() -> EngineResult<Vec<CameraDescriptor>> {
    camera::list_cameras()
}

#[tauri::command]
pub fn engine_status(state: State<'_, AppState>) -> EngineStatus {
    let provider = state
        .engine
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|engine| engine.provider()));

    let poses = state
        .pose_definitions
        .poses
        .values()
        .map(|pose| PoseSummary {
            pose_id: pose.pose_id.clone(),
            display_name: pose.display_name.clone(),
            keypoint_count: pose.keypoint_count,
            target_angle: pose.target_rom.target,
            hold_seconds: pose.hold_seconds,
            model_version: resolve_model(&pose.pose_id).ok().map(|(_, _, _, v, _)| v),
        })
        .collect();

    EngineStatus {
        // Only a loaded session counts as available; the presence of the DLL
        // says nothing about whether it actually loaded.
        inference_available: provider.is_some(),
        runtime_found: crate::inference::runtime_available(),
        provider: provider
            .map(|p| p.as_str().to_string())
            .unwrap_or_else(|| "unavailable".to_string()),
        detail: match provider {
            Some(p) => format!("ONNX Runtime loaded ({})", p.as_str()),
            None => format!(
                "ONNX Runtime {}",
                crate::inference::runtime_description()
            ),
        },
        poses,
        cloud_sync_enabled: state
            .cloud
            .lock()
            .map(|guard| guard.is_some())
            .unwrap_or(false),
        bucket_configured: !state.gcs_bucket.is_empty(),
    }
}

#[tauri::command]
pub fn get_pose_definitions(state: State<'_, AppState>) -> PoseDefinitionDocument {
    state.pose_definitions.clone()
}

// ---------------------------------------------------------------------------
// Commands: preview pipeline
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn start_preview(
    app: AppHandle,
    state: State<'_, AppState>,
    device_index: Option<u32>,
    pose_id: Option<String>,
) -> EngineResult<PreviewStatus> {
    stop_preview_inner(&state)?;

    let handle = camera::start(device_index.unwrap_or(0))?;
    let device = handle.device().clone();

    if let Ok(mut guard) = state.camera.lock() {
        *guard = Some(handle);
    }

    let pose = pose_id.or_else(|| {
        state
            .pose_definitions
            .poses
            .keys()
            .next()
            .cloned()
    });
    if let Ok(mut guard) = state.preview_pose.lock() {
        *guard = pose.clone();
    }

    state.preview_running.store(true, Ordering::SeqCst);

    let running = std::sync::Arc::clone(&state.preview_running);
    let preview_pose = std::sync::Arc::clone(&state.preview_pose);
    let app_handle = app.clone();

    std::thread::Builder::new()
        .name("pilates-preview".into())
        .spawn(move || {
            preview_loop(app_handle, running, preview_pose);
        })
        .map_err(|e| EngineError::Camera(format!("cannot spawn preview thread: {e}")))?;

    Ok(PreviewStatus {
        running: true,
        device: Some(device),
        pose_id: pose,
        provider: "pending".into(),
        inference_available: true,
    })
}

/// Preview thread: pull newest frame, run inference, emit telemetry.
fn preview_loop(
    app: AppHandle,
    running: std::sync::Arc<std::sync::atomic::AtomicBool>,
    preview_pose: std::sync::Arc<std::sync::Mutex<Option<String>>>,
) {
    use tauri::Manager;

    let frame_interval = Duration::from_millis(33);
    let mut fsm: Option<(String, RepFsm)> = None;
    let mut frame_index: i64 = 0;
    let mut last_error: Option<String> = None;
    let mut logged_frames: u32 = 0;

    while running.load(Ordering::Relaxed) {
        let started = std::time::Instant::now();

        let state = app.state::<AppState>();
        let pose_id = preview_pose
            .lock()
            .ok()
            .and_then(|guard| guard.clone());

        let Some(pose_id) = pose_id else {
            std::thread::sleep(frame_interval);
            continue;
        };

        let Some(pose) = state.pose_definitions.poses.get(&pose_id) else {
            std::thread::sleep(frame_interval);
            continue;
        };

        let frame = state
            .camera
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().and_then(|camera| camera.latest()));

        let Some(frame) = frame else {
            std::thread::sleep(Duration::from_millis(10));
            continue;
        };

        // Inference failure must not stop recording. A session with no
        // detections is still valid data (frames, phases, timings); an empty
        // session is not, and previously the loop `continue`d here so nothing
        // was ever captured when the model was unavailable.
        let mut reported_error: Option<String> = None;

        let output = match ensure_engine(&state, &pose_id) {
            Err(error) => {
                reported_error = Some(error.to_string());
                InferenceOutput::empty(ExecutionProviderKind::Cpu)
            }
            Ok(()) => {
                let mut guard = match state.engine.lock() {
                    Ok(guard) => guard,
                    Err(_) => break,
                };
                match guard.as_mut() {
                    Some(engine) => match engine.infer(&frame) {
                        Ok(output) => output,
                        Err(error) => {
                            reported_error = Some(error.to_string());
                            InferenceOutput::empty(ExecutionProviderKind::Cpu)
                        }
                    },
                    None => InferenceOutput::empty(ExecutionProviderKind::Cpu),
                }
            }
        };

        if let Some(error) = reported_error {
            if last_error.as_deref() != Some(error.as_str()) {
                eprintln!("[pilates] inference unavailable: {error}");
                let _ = app.emit("engine-error", error.clone());
                last_error = Some(error);
            }
        }

        // Keep one FSM per pose so switching pose resets motion state.
        let needs_reset = fsm.as_ref().map(|(id, _)| id != &pose_id).unwrap_or(true);
        if needs_reset {
            if let Ok(config) = state.pose_definitions.fsm_config(&pose_id) {
                fsm = Some((pose_id.clone(), RepFsm::new(config)));
            }
        }

        if let Some((_, fsm)) = fsm.as_mut() {
            frame_index += 1;
            let detection = output.detections.iter().max_by(|a, b| {
                a.class_confidence
                    .partial_cmp(&b.class_confidence)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });

            let (angle, confidence) = match detection {
                Some(detection) => (
                    primary_angle_from_detection(
                        detection,
                        pose,
                        frame.width as f32,
                        frame.height as f32,
                    ),
                    mean_confidence(detection),
                ),
                None => (None, 0.0),
            };

            let timestamp_ms = frame.captured_at_ms;
            let metrics = fsm.update(timestamp_ms, angle, confidence);

            let mut payload = metrics_to_payload(
                &pose_id,
                frame_index,
                timestamp_ms,
                &metrics,
                &output,
                pose,
            );

            // Feed the active recording session. Without this the session
            // recorder never sees a frame and `stop_session` fails on an empty
            // telemetry buffer. The live counters come from the session's
            // detection-based tracker, not the angle FSM.
            if let Ok(mut guard) = state.session.lock() {
                if let Some(session) = guard.as_mut() {
                    if session.pose_id() == pose_id {
                        session.process(&frame, &output, pose);
                        payload.rep_count = session.rep_count();
                        payload.hold_duration_sec = session.active_hold_sec(timestamp_ms);
                    }
                }
            }

            let _ = app.emit("telemetry-frame", payload);

            // Terminal heartbeat: proves the loop is producing detections even
            // when the UI appears inert. One line per second at 30 FPS.
            logged_frames += 1;
            if logged_frames % 30 == 0 {
                eprintln!(
                    "[pilates] frame {} detections={} best={} {:.3} {:.1}ms",
                    frame_index,
                    output.detections.len(),
                    if output.best_class_label.is_empty() {
                        "-"
                    } else {
                        &output.best_class_label
                    },
                    output.best_class_score,
                    output.inference_ms
                );
            }
        }

        let elapsed = started.elapsed();
        if elapsed < frame_interval {
            std::thread::sleep(frame_interval - elapsed);
        }
    }
}

fn stop_preview_inner(state: &AppState) -> EngineResult<()> {
    state.preview_running.store(false, Ordering::SeqCst);
    if let Ok(mut guard) = state.camera.lock() {
        if let Some(mut handle) = guard.take() {
            handle.stop();
        }
    }
    Ok(())
}

#[tauri::command]
pub fn stop_preview(state: State<'_, AppState>) -> EngineResult<PreviewStatus> {
    stop_preview_inner(&state)?;
    Ok(PreviewStatus {
        running: false,
        device: None,
        pose_id: None,
        provider: "idle".into(),
        inference_available: true,
    })
}

#[tauri::command]
pub fn set_preview_pose(state: State<'_, AppState>, pose_id: String) -> EngineResult<()> {
    state
        .pose_definitions
        .pose(&pose_id)
        .map_err(|_| EngineError::Invalid(format!("unknown pose {pose_id}")))?;
    if let Ok(mut guard) = state.preview_pose.lock() {
        *guard = Some(pose_id);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Commands: sessions
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn start_session(
    state: State<'_, AppState>,
    patient_id: String,
    pose_id: String,
) -> EngineResult<String> {
    let fsm_config = state.pose_definitions.fsm_config(&pose_id)?;
    let detection_config = state.pose_definitions.detection_config(&pose_id)?;

    if state
        .outbox
        .lock()
        .map_err(|_| EngineError::Storage("outbox lock poisoned".into()))?
        .get_patient(&patient_id)?
        .is_none()
    {
        return Err(EngineError::Invalid(format!("unknown patient {patient_id}")));
    }

    // A session records which model produced its numbers, so a fabricated
    // version is worse than an absent one: "2.0.0" would look like real
    // provenance in a clinical record. If the manifest cannot be read the
    // session still starts (capture must not be blocked by a config problem)
    // and the field says plainly that it is unknown.
    let (_, _, _, version, _) = resolve_model(&pose_id).unwrap_or_else(|error| {
        eprintln!("[pilates] model manifest unavailable, recording an unknown version: {error}");
        (PathBuf::new(), 0, 0, "unknown".to_string(), Vec::new())
    });

    let session = CaptureSession::new(
        &patient_id,
        &pose_id,
        version,
        RepFsm::new(fsm_config),
        crate::rep_tracker::DetectionRepTracker::new(detection_config),
    );
    let session_id = session.session_id().to_string();

    let mut guard = state
        .session
        .lock()
        .map_err(|_| EngineError::Storage("session lock poisoned".into()))?;
    *guard = Some(session);

    if let Ok(mut pose) = state.active_pose.lock() {
        *pose = Some(pose_id.clone());
    }
    if let Ok(mut pose) = state.preview_pose.lock() {
        *pose = Some(pose_id);
    }

    Ok(session_id)
}

/// Run one inference step against the latest frame for the active session.
#[tauri::command]
pub fn capture_tick(state: State<'_, AppState>) -> EngineResult<Option<TelemetryFramePayload>> {
    let pose_id = state
        .active_pose
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
        .ok_or_else(|| EngineError::Invalid("no active session".into()))?;

    let pose = state.pose_definitions.pose(&pose_id)?.clone();
    ensure_engine(&state, &pose_id)?;

    let frame = state
        .camera
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().and_then(|camera| camera.latest()));

    let Some(frame) = frame else {
        return Ok(None);
    };

    let output = {
        let mut guard = state
            .engine
            .lock()
            .map_err(|_| EngineError::Inference("engine lock poisoned".into()))?;
        match guard.as_mut() {
            Some(engine) => engine.infer(&frame)?,
            None => return Ok(None),
        }
    };

    let mut guard = state
        .session
        .lock()
        .map_err(|_| EngineError::Storage("session lock poisoned".into()))?;
    let Some(session) = guard.as_mut() else {
        return Ok(None);
    };

    let metrics = session.process(&frame, &output, &pose);
    Ok(Some(metrics_to_payload(
        &pose_id,
        session.frame_count() as i64,
        frame.captured_at_ms,
        &metrics,
        &output,
        &pose,
    )))
}

#[tauri::command]
pub fn stop_session(state: State<'_, AppState>) -> EngineResult<ClinicalSessionDocument> {
    let session = {
        let mut guard = state
            .session
            .lock()
            .map_err(|_| EngineError::Storage("session lock poisoned".into()))?;
        guard
            .take()
            .ok_or_else(|| EngineError::Invalid("no active session".into()))?
    };

    let pose_id = session.pose_id().to_string();
    if let Ok(mut pose) = state.active_pose.lock() {
        *pose = None;
    }

    // Nothing was captured (preview never ran, or the camera produced no
    // frames). Stop the camera so the UI is not left with a live preview it
    // cannot shut down, and explain why.
    if session.frame_count() == 0 {
        let _ = stop_preview_inner(&state);
        return Err(EngineError::Invalid(
            "no frames were captured. Start the camera preview before recording.".into(),
        ));
    }

    let camera_frames = state
        .camera
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|camera| camera.frames_captured()))
        .unwrap_or(0);

    let result = session.finish(&state.gcs_bucket, camera_frames)?;
    let document_json = serde_json::to_string(&result.document)?;

    {
        let mut outbox = state
            .outbox
            .lock()
            .map_err(|_| EngineError::Storage("outbox lock poisoned".into()))?;
        outbox.save_session(
            &result.document.session_id,
            &result.document.patient_id,
            &pose_id,
            &document_json,
            Some((&result.parquet, &result.parquet_sha256)),
        )?;
    }

    Ok(result.document)
}

#[tauri::command]
pub fn list_sessions(
    state: State<'_, AppState>,
    patient_id: String,
) -> EngineResult<Vec<SessionListItem>> {
    let outbox = state
        .outbox
        .lock()
        .map_err(|_| EngineError::Storage("outbox lock poisoned".into()))?;

    // All sessions for the patient, not just the unsynced ones — the history
    // view must keep showing sessions after they have been uploaded.
    let sessions: Vec<StoredSession> = outbox.sessions_for_patient(&patient_id)?;
    let mut items = Vec::new();
    for session in sessions {
        let document = serde_json::from_str(&session.document_json)
            .unwrap_or(Value::Null);
        items.push(SessionListItem {
            session_id: session.session_id,
            patient_id: session.patient_id,
            pose_id: session.pose_id,
            created_at: session.created_at,
            upload_state: session.upload_state.as_str().to_string(),
            document,
        });
    }
    Ok(items)
}

/// Every session across all patients, newest first.
///
/// The analysis view aggregates clinic-wide, so it needs one query rather than
/// a round trip per patient.
#[tauri::command]
pub fn list_all_sessions(state: State<'_, AppState>) -> EngineResult<Vec<SessionListItem>> {
    let outbox = state
        .outbox
        .lock()
        .map_err(|_| EngineError::Storage("outbox lock poisoned".into()))?;

    let sessions: Vec<StoredSession> = outbox.all_sessions()?;
    let mut items = Vec::new();
    for session in sessions {
        let document = serde_json::from_str(&session.document_json).unwrap_or(Value::Null);
        items.push(SessionListItem {
            session_id: session.session_id,
            patient_id: session.patient_id,
            pose_id: session.pose_id,
            created_at: session.created_at,
            upload_state: session.upload_state.as_str().to_string(),
            document,
        });
    }
    Ok(items)
}

/// The clinical portal, hosted on Firebase Hosting.
pub const PORTAL_URL: &str = "https://pilates-ai.web.app";

/// Issues a one-time code that the browser exchanges for a portal session.
const PORTAL_LOGIN_START: &str =
    "https://asia-east2-pilates-ai.cloudfunctions.net/portalLoginStart";

/// Open the portal in the user's default browser, already signed in.
///
/// The desktop deliberately has no analysis page of its own: cohort-level
/// analysis belongs in the portal, where the data is shared and always current.
/// The browser is a separate security context and cannot inherit this session,
/// so the workstation asks for a one-time code and opens `/auth#code=…`; the
/// portal exchanges it for a session as the same account. Any failure falls back
/// to the plain portal, which has its own sign-in screen — a broken handoff must
/// never block analysis.
#[tauri::command]
pub fn open_portal(state: State<'_, AppState>) -> EngineResult<()> {
    match portal_handoff_url(&state) {
        Ok(url) => open_url(&url),
        Err(error) => {
            eprintln!("[pilates] portal handoff unavailable ({error}); opening the portal");
            open_url(PORTAL_URL)
        }
    }
}

/// Ask the login service for a code and build the `/auth` URL.
fn portal_handoff_url(state: &AppState) -> EngineResult<String> {
    let token = {
        let mut guard = state
            .cloud
            .lock()
            .map_err(|_| EngineError::Sync("cloud lock poisoned".into()))?;
        let Some(cloud) = guard.as_mut() else {
            return Err(EngineError::Sync(
                "this workstation is not signed in".to_string(),
            ));
        };
        cloud.id_token()?
    };

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| EngineError::Sync(format!("portal handoff client: {e}")))?;

    let response = client
        .post(PORTAL_LOGIN_START)
        .bearer_auth(&token)
        .json(&serde_json::json!({}))
        .send()
        .map_err(|e| EngineError::Sync(format!("portal handoff request: {e}")))?;

    if !response.status().is_success() {
        return Err(EngineError::Sync(format!(
            "portal handoff rejected ({})",
            response.status()
        )));
    }

    let value: Value = response
        .json()
        .map_err(|e| EngineError::Sync(format!("portal handoff response: {e}")))?;
    let code = value
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if code.is_empty() {
        return Err(EngineError::Sync(
            "portal handoff returned no code".to_string(),
        ));
    }

    Ok(format!("{PORTAL_URL}/auth#code={code}"))
}

/// Open an arbitrary URL in the user's default browser.
///
/// Used by the pairing screen, which has to open `/pair?code=…`. The front end
/// previously used the shell plugin's `open`, but no capability granted
/// `shell:allow-open`, so the ACL rejected it and the promise was swallowed —
/// the button silently did nothing. Going through Rust keeps one code path for
/// every platform and needs no plugin permission.
#[tauri::command]
pub fn open_external(url: String) -> EngineResult<()> {
    if !url.starts_with("https://") {
        return Err(EngineError::Invalid(
            "only https URLs can be opened".to_string(),
        ));
    }
    open_url(&url)
}

fn open_url(url: &str) -> EngineResult<()> {
    #[cfg(target_os = "windows")]
    {
        // `start` treats its first quoted argument as a window title, hence "".
        std::process::Command::new("cmd")
            .args(["/C", "start", "", url])
            .spawn()
            .map_err(|error| {
                EngineError::Storage(format!("cannot open the browser: {error}"))
            })?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(url)
            .spawn()
            .map_err(|error| {
                EngineError::Storage(format!("cannot open the browser: {error}"))
            })?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(url)
            .spawn()
            .map_err(|error| {
                EngineError::Storage(format!("cannot open the browser: {error}"))
            })?;
        return Ok(());
    }
}

#[tauri::command]
pub fn get_session_document(
    state: State<'_, AppState>,
    session_id: String,
) -> EngineResult<Value> {
    let outbox = state
        .outbox
        .lock()
        .map_err(|_| EngineError::Storage("outbox lock poisoned".into()))?;

    let session = outbox
        .session(&session_id)?
        .ok_or_else(|| EngineError::Invalid(format!("unknown session {session_id}")))?;

    Ok(serde_json::from_str(&session.document_json).unwrap_or(Value::Null))
}

// ---------------------------------------------------------------------------
// Commands: patients
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn list_patients(state: State<'_, AppState>) -> EngineResult<Vec<StoredPatient>> {
    state
        .outbox
        .lock()
        .map_err(|_| EngineError::Storage("outbox lock poisoned".into()))?
        .list_patients()
}

/// Validate a patient document id.
///
/// Existing production patients in Firestore use auto-generated ids
/// (`1vP4WZnlThz7Pq2BdhAE`), not UUID4. The requirement is therefore "safe as a
/// Firestore document id" rather than "canonical UUID"; newly created patients
/// still receive a UUID.
pub fn validate_patient_id(id: &str) -> EngineResult<()> {
    if id.is_empty() {
        return Err(EngineError::Invalid("patient id must not be empty".into()));
    }
    if id.len() > 1500 {
        return Err(EngineError::Invalid("patient id is too long".into()));
    }
    if id == "." || id == ".." {
        return Err(EngineError::Invalid(
            "patient id must not be '.' or '..'".into(),
        ));
    }
    if id.contains('/') {
        return Err(EngineError::Invalid(
            "patient id must not contain '/'".into(),
        ));
    }
    if id.chars().any(char::is_control) {
        return Err(EngineError::Invalid(
            "patient id must not contain control characters".into(),
        ));
    }
    // Firestore reserves document ids of the form `__…__`.
    if id.starts_with("__") && id.ends_with("__") && id.len() >= 4 {
        return Err(EngineError::Invalid(
            "patient id uses a Firestore-reserved form (__…__)".into(),
        ));
    }
    Ok(())
}

#[tauri::command]
pub fn save_patient(
    state: State<'_, AppState>,
    patient: PatientInputDto,
) -> EngineResult<StoredPatient> {
    let name = patient.name.trim();
    if name.is_empty() {
        return Err(EngineError::Invalid("patient name is required".into()));
    }

    let id = patient
        .id
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    validate_patient_id(&id)?;

    let record = StoredPatient {
        id,
        name: name.to_string(),
        age: patient.age.unwrap_or_default(),
        weight: patient.weight.unwrap_or_default(),
        height: patient.height.unwrap_or_default(),
        gender: patient.gender.unwrap_or_default(),
        revision: 0,
        local_state: crate::outbox::PatientState::Active,
        created_at: String::new(),
        updated_at: String::new(),
        total_sessions: None,
        lifetime_avg_score: None,
        last_active: None,
        address: patient.address.map(|text| text.trim().to_string()),
        note: None,
        tel_number: patient.tel_number.map(|text| text.trim().to_string()),
        legacy_json: None,
    };

    state
        .outbox
        .lock()
        .map_err(|_| EngineError::Storage("outbox lock poisoned".into()))?
        .save_patient(&record)
}

#[tauri::command]
pub fn delete_patient(state: State<'_, AppState>, patient_id: String) -> EngineResult<()> {
    state
        .outbox
        .lock()
        .map_err(|_| EngineError::Storage("outbox lock poisoned".into()))?
        .delete_patient(&patient_id)
}

#[tauri::command]
pub fn outbox_stats(state: State<'_, AppState>) -> EngineResult<OutboxStats> {
    state
        .outbox
        .lock()
        .map_err(|_| EngineError::Storage("outbox lock poisoned".into()))?
        .stats()
}

// ---------------------------------------------------------------------------
// Commands: sync
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn sync_now(state: State<'_, AppState>) -> EngineResult<SyncReport> {
    let mut cloud_guard = state
        .cloud
        .lock()
        .map_err(|_| EngineError::Sync("cloud lock poisoned".into()))?;

    let Some(cloud) = cloud_guard.as_mut() else {
        return Ok(SyncReport {
            enabled: false,
            ..Default::default()
        });
    };

    let mut outbox = state
        .outbox
        .lock()
        .map_err(|_| EngineError::Storage("outbox lock poisoned".into()))?;

    Ok(cloud.flush(&mut outbox, 50))
}

/// Pull the patient roster from Firestore into the local store.
///
/// Needed because the desktop app has no continuous read path: patients created
/// elsewhere (including the 18 that predate this application) would otherwise
/// never appear.
#[tauri::command]
pub fn sync_pull_patients(state: State<'_, AppState>) -> EngineResult<crate::cloud_sync::PullReport> {
    let mut cloud_guard = state
        .cloud
        .lock()
        .map_err(|_| EngineError::Sync("cloud lock poisoned".into()))?;

    let Some(cloud) = cloud_guard.as_mut() else {
        return Ok(crate::cloud_sync::PullReport {
            enabled: false,
            ..Default::default()
        });
    };

    let mut outbox = state
        .outbox
        .lock()
        .map_err(|_| EngineError::Storage("outbox lock poisoned".into()))?;

    let mut report = cloud.pull_patients(&mut outbox)?;
    // Sessions recorded on other workstations arrive on the same cycle.
    report.sessions_imported = match cloud.pull_sessions(&mut outbox) {
        Ok(imported) => imported,
        Err(error) => {
            // Reported, not just logged: a failed session pull looks exactly
            // like "no new sessions" and a release build has no console.
            eprintln!("[pilates] session pull failed: {error}");
            report.error = Some(format!("session pull failed: {error}"));
            0
        }
    };
    Ok(report)
}

/// Ask the cloud whether anything changed elsewhere.
///
/// One document read, so it is cheap enough to run every few seconds. Returns
/// `false` when the marker is missing (function not deployed) or the change was
/// this workstation's own upload.
#[tauri::command]
pub fn sync_check_remote(state: State<'_, AppState>) -> EngineResult<bool> {
    let mut cloud_guard = state
        .cloud
        .lock()
        .map_err(|_| EngineError::Sync("cloud lock poisoned".into()))?;

    let Some(cloud) = cloud_guard.as_mut() else {
        return Ok(false);
    };
    cloud.remote_changed()
}

/// Clinical comments for a patient, newest first.
#[tauri::command]
pub fn list_comments(
    state: State<'_, AppState>,
    patient_id: String,
) -> EngineResult<Vec<crate::cloud_sync::CommentRecord>> {
    let mut cloud_guard = state
        .cloud
        .lock()
        .map_err(|_| EngineError::Sync("cloud lock poisoned".into()))?;
    let Some(cloud) = cloud_guard.as_mut() else {
        return Ok(Vec::new());
    };
    cloud.list_comments(&patient_id)
}

/// Append a comment. Cloud-only by design: a note a colleague may read from
/// another workstation, not session telemetry that must survive offline.
#[tauri::command]
pub fn add_comment(
    state: State<'_, AppState>,
    patient_id: String,
    text: String,
) -> EngineResult<crate::cloud_sync::CommentRecord> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err(EngineError::Invalid("a comment cannot be empty".into()));
    }
    let mut cloud_guard = state
        .cloud
        .lock()
        .map_err(|_| EngineError::Sync("cloud lock poisoned".into()))?;
    let Some(cloud) = cloud_guard.as_mut() else {
        return Err(EngineError::Sync(
            "cloud sync is not configured on this workstation".into(),
        ));
    };
    cloud.add_comment(&patient_id, trimmed)
}

#[tauri::command]
pub fn delete_comment(
    state: State<'_, AppState>,
    patient_id: String,
    comment_id: String,
) -> EngineResult<()> {
    let mut cloud_guard = state
        .cloud
        .lock()
        .map_err(|_| EngineError::Sync("cloud lock poisoned".into()))?;
    let Some(cloud) = cloud_guard.as_mut() else {
        return Err(EngineError::Sync(
            "cloud sync is not configured on this workstation".into(),
        ));
    };
    cloud.delete_comment(&patient_id, &comment_id)
}

/// Sign this workstation in with a clinic account.
///
/// The low-friction first-run path: one form, no code, no second device. The
/// stored credential is the same refresh token pairing produces, so everything
/// downstream (sync, token refresh, the "signed in again" recovery) is shared.
#[tauri::command]
pub fn auth_sign_in(
    state: State<'_, AppState>,
    email: String,
    password: String,
) -> EngineResult<()> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| EngineError::Sync(format!("sign-in client: {e}")))?;

    // A clean install has no `cloud.json` yet, so fall back to the public
    // identifiers the deployment ships with — the same values pairing uses.
    let api_key = CloudConfig::load()
        .map(|config| config.api_key)
        .filter(|key| !key.is_empty())
        .unwrap_or_else(|| crate::pairing::DEFAULT_API_KEY.to_string());

    crate::pairing::sign_in(
        &client,
        &api_key,
        &email,
        &password,
        &crate::cloud_sync::patient_origin(),
    )?;

    // The sync client is built once at startup. On a clean install it was
    // `None` then, because there was no project config; sign-in has just
    // written one. Attach it now so the first session can upload without a
    // restart. A failure here is not a sign-in failure — the credential is
    // already saved and the next launch retries.
    if let Err(error) = initialise_cloud_sync(&state) {
        eprintln!("[pilates] signed in, but cloud sync did not start: {error}");
    }

    Ok(())
}

/// Remove this workstation's credential and forget the cached token.
///
/// The next launch shows the sign-in screen. Used when a shared laptop changes
/// hands, so switching accounts does not require finding and deleting a file.
#[tauri::command]
pub fn auth_sign_out(state: State<'_, AppState>) -> EngineResult<()> {
    crate::pairing::clear_auth()?;
    let mut guard = state
        .cloud
        .lock()
        .map_err(|_| EngineError::Sync("cloud lock poisoned".into()))?;
    if let Some(cloud) = guard.as_mut() {
        cloud.forget_token();
    }
    Ok(())
}

/// Whether this workstation has a credential, and which machine it is.
///
/// Deliberately infallible: the pairing gate must render even when the file
/// system or the network is misbehaving.
#[derive(serde::Serialize)]
pub struct PairingStatus {
    paired: bool,
    instance_id: String,
}

#[tauri::command]
pub fn pairing_status() -> PairingStatus {
    PairingStatus {
        paired: crate::pairing::is_paired(),
        instance_id: crate::cloud_sync::patient_origin(),
    }
}

/// Ask the pairing service for a code to show the user.
#[tauri::command]
pub fn pairing_start() -> EngineResult<crate::pairing::PairingStart> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| EngineError::Sync(format!("pairing client: {e}")))?;
    crate::pairing::start(&client, &crate::cloud_sync::patient_origin())
}

/// Poll once. Returns `true` when the workstation is now paired.
#[tauri::command]
pub fn pairing_poll(
    state: State<'_, AppState>,
    code: String,
    secret: String,
) -> EngineResult<bool> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| EngineError::Sync(format!("pairing client: {e}")))?;

    let normalised = crate::pairing::normalise_code(&code);
    match crate::pairing::poll(&client, &normalised, &secret)? {
        crate::pairing::PollOutcome::Pending => Ok(false),
        crate::pairing::PollOutcome::Approved(custom_token) => {
            crate::pairing::exchange_custom_token(
                &client,
                crate::pairing::DEFAULT_API_KEY,
                &custom_token,
                &crate::cloud_sync::patient_origin(),
            )?;
            // Same reason as sign-in: on a clean install the sync client was
            // built before `cloud.json` existed, so attach it now.
            if let Err(error) = initialise_cloud_sync(&state) {
                eprintln!("[pilates] paired, but cloud sync did not start: {error}");
            }
            Ok(true)
        }
    }
}

#[tauri::command]
pub fn sync_status(state: State<'_, AppState>) -> EngineResult<OutboxStats> {
    outbox_stats(state)
}

/// Initialise cloud sync from the environment (called once at startup).
pub fn initialise_cloud_sync(state: &AppState) -> EngineResult<bool> {
    let mut guard = state
        .cloud
        .lock()
        .map_err(|_| EngineError::Sync("cloud lock poisoned".into()))?;

    if guard.is_some() {
        return Ok(true);
    }

    match CloudSync::load()? {
        Some(cloud) => {
            *guard = Some(cloud);
            Ok(true)
        }
        None => Ok(false),
    }
}

/// Movement phases exposed to the UI for legends and colour keys.
#[tauri::command]
pub fn movement_phases() -> Vec<&'static str> {
    vec![
        MovementPhase::Idle.as_str(),
        MovementPhase::StartPosition.as_str(),
        MovementPhase::Eccentric.as_str(),
        MovementPhase::Holding.as_str(),
        MovementPhase::Concentric.as_str(),
        MovementPhase::RepCompleted.as_str(),
    ]
}

// ---------------------------------------------------------------------------
// Commands: live video preview
// ---------------------------------------------------------------------------

/// Preview frames are downscaled before crossing IPC: a full 640x480 RGB frame
/// is 921 KB, which is far too much to move 15x/second.
pub const PREVIEW_WIDTH: u32 = 320;
pub const PREVIEW_HEIGHT: u32 = 240;

/// Nearest-neighbour downscale of a packed RGB frame.
pub fn downscale_rgb(frame: &crate::camera::Frame, out_w: u32, out_h: u32) -> Vec<u8> {
    if frame.width == 0 || frame.height == 0 {
        return Vec::new();
    }
    let mut out = vec![0u8; (out_w * out_h * 3) as usize];
    for oy in 0..out_h {
        let sy = (oy as u64 * frame.height as u64 / out_h as u64) as usize;
        for ox in 0..out_w {
            let sx = (ox as u64 * frame.width as u64 / out_w as u64) as usize;
            let src = (sy * frame.width as usize + sx) * 3;
            let dst = ((oy * out_w + ox) * 3) as usize;
            if src + 2 < frame.rgb.len() {
                out[dst] = frame.rgb[src];
                out[dst + 1] = frame.rgb[src + 1];
                out[dst + 2] = frame.rgb[src + 2];
            }
        }
    }
    out
}

/// Latest camera frame as raw RGB bytes over Tauri's binary IPC channel.
///
/// Returns an empty payload when no camera is running, which the UI renders as
/// a placeholder rather than an error.
#[tauri::command]
pub fn preview_frame(state: State<'_, AppState>) -> tauri::ipc::Response {
    let frame = state
        .camera
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().and_then(|camera| camera.latest()));

    match frame {
        Some(frame) => tauri::ipc::Response::new(downscale_rgb(
            &frame,
            PREVIEW_WIDTH,
            PREVIEW_HEIGHT,
        )),
        None => tauri::ipc::Response::new(Vec::<u8>::new()),
    }
}

#[tauri::command]
pub fn preview_dimensions() -> (u32, u32) {
    (PREVIEW_WIDTH, PREVIEW_HEIGHT)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every pose must resolve through the manifest and load, with class names
    /// in id order.
    ///
    /// This exercises the production path that the UI depends on. The other
    /// inference tests pass explicit class names, so a manifest regression
    /// would otherwise go unnoticed — and it would silently produce no
    /// detections, no boxes and no repetitions.
    #[test]
    fn every_pose_resolves_and_loads() {
        for pose_id in ["pose1", "pose2", "pose3", "pose4", "pose5"] {
            let (path, num_classes, num_keypoints, version, class_names) =
                resolve_model(pose_id).unwrap_or_else(|e| panic!("{pose_id} resolve: {e}"));

            assert!(path.is_file(), "{pose_id}: model file missing at {}", path.display());
            assert_eq!(
                class_names.len(),
                num_classes,
                "{pose_id}: expected {num_classes} class names, got {class_names:?}"
            );
            assert!(
                class_names.iter().all(|name| !name.is_empty()),
                "{pose_id}: empty class name in {class_names:?}"
            );
            assert!(!version.is_empty(), "{pose_id}: missing version");

            if crate::inference::runtime_available() {
                match InferenceEngine::load(
                    &path,
                    pose_id,
                    num_classes,
                    num_keypoints,
                    class_names.clone(),
                ) {
                    Ok(engine) => {
                        assert_eq!(engine.num_classes(), num_classes);
                        assert_eq!(engine.num_keypoints(), num_keypoints);
                    }
                    Err(error) => panic!("{pose_id} failed to load: {error}"),
                }
            }
        }
    }

    /// The per-pose detection config must reach the tracker with the values
    /// declared in `pose-definitions.json`.
    #[test]
    fn detection_config_matches_the_pose_definitions() {
        let definitions = crate::pose_config::PoseDefinitionDocument::load()
            .expect("load pose definitions");
        let config = definitions.detection_config("pose1").expect("pose1 config");

        assert_eq!(config.start_class, "start");
        assert_eq!(config.end_class, "end");
        assert_eq!(config.confirm_frames, 3);
        assert!(config.min_hold_sec > 0.0);
        assert!(config.max_hold_sec > config.min_hold_sec);
        assert!(config.grace_sec > 0.0);
    }

    #[test]
    fn accepts_firestore_auto_ids_and_uuids() {
        // Existing production patient ids are Firestore auto-IDs.
        assert!(validate_patient_id("1vP4WZnlThz7Pq2BdhAE").is_ok());
        assert!(validate_patient_id("f874b022-e59c-4796-8b46-2da8a1c3f92d").is_ok());
    }

    #[test]
    fn rejects_unsafe_ids() {
        assert!(validate_patient_id("").is_err());
        assert!(validate_patient_id(".").is_err());
        assert!(validate_patient_id("..").is_err());
        assert!(validate_patient_id("a/b").is_err());
        assert!(validate_patient_id("a\nb").is_err());
        assert!(validate_patient_id(&"x".repeat(1501)).is_err());
        // Firestore rejects ids of the form `__…__` as reserved.
        assert!(validate_patient_id("__probe__").is_err());
    }
}
