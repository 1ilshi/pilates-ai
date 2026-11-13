//! Shared application state.
//!
//! All mutable engine handles live behind `Mutex`es inside a single managed
//! struct. The capture thread only ever touches the lock-free frame slot, so UI
//! commands can take these locks without stalling frame delivery.

use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use crate::biomechanics::RepFsm;
use crate::camera::CameraHandle;
use crate::cloud_sync::CloudSync;
use crate::inference::InferenceEngine;
use crate::outbox::Outbox;
use crate::pose_config::PoseDefinitionDocument;
use crate::session::CaptureSession;

pub struct AppState {
    pub outbox: Mutex<Outbox>,
    pub pose_definitions: PoseDefinitionDocument,
    pub camera: Mutex<Option<CameraHandle>>,
    pub engine: Mutex<Option<InferenceEngine>>,
    pub session: Mutex<Option<CaptureSession>>,
    pub active_pose: Mutex<Option<String>>,
    pub cloud: Mutex<Option<CloudSync>>,
    /// Cloud Storage bucket for session archives, or empty when none is set.
    ///
    /// Behind a lock because sign-in can create `cloud.json` after launch: the
    /// value read at startup is not the value the first session should use.
    pub gcs_bucket: Mutex<String>,
    /// Signals the preview loop to stop.
    pub preview_running: Arc<AtomicBool>,
    /// Pose used by the preview loop (mirrors `active_pose` for lock-free read).
    pub preview_pose: Arc<Mutex<Option<String>>>,
}

impl AppState {
    pub fn new(outbox: Outbox, pose_definitions: PoseDefinitionDocument, gcs_bucket: String) -> Self {
        Self {
            outbox: Mutex::new(outbox),
            pose_definitions,
            camera: Mutex::new(None),
            engine: Mutex::new(None),
            session: Mutex::new(None),
            active_pose: Mutex::new(None),
            cloud: Mutex::new(None),
            gcs_bucket: Mutex::new(gcs_bucket),
            preview_running: Arc::new(AtomicBool::new(false)),
            preview_pose: Arc::new(Mutex::new(None)),
        }
    }

    /// The archive bucket, or an empty string when none is configured.
    pub fn bucket(&self) -> String {
        self.gcs_bucket
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default()
    }

    /// Replace the archive bucket after the configuration changes.
    pub fn set_bucket(&self, bucket: String) {
        if let Ok(mut guard) = self.gcs_bucket.lock() {
            *guard = bucket;
        }
    }

    /// FSM tuned for a pose, used by the preview loop.
    pub fn preview_fsm(&self, pose_id: &str) -> Option<RepFsm> {
        self.pose_definitions
            .fsm_config(pose_id)
            .ok()
            .map(RepFsm::new)
    }
}
