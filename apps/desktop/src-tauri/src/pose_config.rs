//! Pose definitions loader.
//!
//! Reads `config/pose-definitions.json` — the single source of truth shared
//! with the TypeScript packages — and turns it into the FSM tuning the engine
//! needs. Keeping this data-driven means correcting a joint label or target ROM
//! never requires a Rust rebuild of the logic itself.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::biomechanics::FsmConfig;
use crate::error::{EngineError, EngineResult};

/// Joint angle defined by three keypoint indices: `a` and `c` are segment
/// endpoints, `b` is the joint vertex.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JointAngleSpec {
    pub name: String,
    pub a: i32,
    pub b: i32,
    pub c: i32,
    #[serde(default)]
    pub unit: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TargetRom {
    pub min: f32,
    pub max: f32,
    pub target: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfidenceBands {
    pub high: f32,
    pub medium: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PoseDefinition {
    pub pose_id: String,
    pub display_name: String,
    pub keypoint_count: usize,
    #[serde(default)]
    pub keypoint_labels: Vec<String>,
    #[serde(default)]
    pub bones: Vec<Vec<i32>>,
    pub primary_angle: JointAngleSpec,
    #[serde(default)]
    pub secondary_angle: Option<JointAngleSpec>,
    pub target_rom: TargetRom,
    #[serde(default = "default_hold_seconds")]
    pub hold_seconds: f32,
    /// How repetitions are counted for this pose.
    #[serde(default)]
    pub detection: DetectionSpec,
}

/// Repetition counting rules, driven by the model's own classification.
///
/// In every pose model the class named **`end`** is the exercise itself (the
/// position being held) and **`start`** is the neutral position the patient
/// returns to between repetitions. A repetition is therefore a *hold of the
/// action pose*, and its duration is the hold time.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectionSpec {
    /// Class for the neutral position between repetitions.
    #[serde(default = "default_start_class")]
    pub start_class: String,
    /// Class for the exercise itself — the position being held.
    #[serde(default = "default_end_class")]
    pub end_class: String,
    #[serde(default = "default_min_confidence")]
    pub min_confidence: f32,
    /// Consecutive frames required before a class is believed.
    #[serde(default = "default_confirm_frames")]
    pub confirm_frames: u32,
    /// A hold shorter than this is treated as a misdetection.
    #[serde(default = "default_min_hold")]
    pub min_hold_sec: f32,
    /// Safety cap so a stuck detection cannot run forever.
    #[serde(default = "default_max_hold")]
    pub max_hold_sec: f32,
    /// How long the pose may go undetected before the hold ends.
    #[serde(default = "default_grace")]
    pub grace_sec: f32,
}

fn default_start_class() -> String {
    "start".to_string()
}
fn default_end_class() -> String {
    "end".to_string()
}
fn default_min_confidence() -> f32 {
    0.25
}
fn default_confirm_frames() -> u32 {
    3
}
fn default_min_hold() -> f32 {
    2.5
}
fn default_max_hold() -> f32 {
    60.0
}
fn default_grace() -> f32 {
    0.6
}

impl Default for DetectionSpec {
    fn default() -> Self {
        Self {
            start_class: default_start_class(),
            end_class: default_end_class(),
            min_confidence: default_min_confidence(),
            confirm_frames: default_confirm_frames(),
            min_hold_sec: default_min_hold(),
            max_hold_sec: default_max_hold(),
            grace_sec: default_grace(),
        }
    }
}

fn default_hold_seconds() -> f32 {
    3.0
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PoseDefinitionDocument {
    pub schema_version: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub label_source: Option<String>,
    pub confidence_bands: ConfidenceBands,
    #[serde(default = "default_hold_seconds")]
    pub default_hold_seconds: f32,
    pub poses: BTreeMap<String, PoseDefinition>,
}

/// How many `..` components Tauri may have folded into `_up_` segments.
///
/// The bundler rewrites every `ParentDir` of a resource path into a literal
/// `_up_` directory (`tauri_utils::resources::resource_relpath`), so a resource
/// declared as `../../../config/x.json` is installed at
/// `<resource>/_up_/_up_/_up_/config/x.json` rather than at `<resource>/config/`.
/// Builds before 2.1 shipped that layout, so accept it too — otherwise an
/// in-place upgrade leaves the previous installation unable to start.
const MAX_UP_DEPTH: usize = 4;

/// Push the resource-relative candidates for `relative`, current layout first.
fn push_resource_candidates(candidates: &mut Vec<PathBuf>, relative: &Path) {
    let Ok(resource_dir) = std::env::var("TAURI_RESOURCE_DIR") else {
        return;
    };

    let root = PathBuf::from(resource_dir);
    candidates.push(root.join(relative));

    // Legacy flattening: probe every plausible depth instead of hardcoding
    // one, so the search survives a change to how many `..` a resource uses.
    let mut nested = root;
    for _ in 0..MAX_UP_DEPTH {
        nested.push("_up_");
        candidates.push(nested.join(relative));
    }
}

/// Candidate locations for `pose-definitions.json`, most specific first.
fn candidate_paths() -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(explicit) = std::env::var("PILATES_POSE_DEFINITIONS") {
        candidates.push(PathBuf::from(explicit));
    }

    // Tauri resource directory (bundled installers).
    push_resource_candidates(&mut candidates, Path::new("config/pose-definitions.json"));

    // Walk up from the executable and the working directory so `cargo run`,
    // `tauri dev` and an installed binary all resolve.
    for base in [std::env::current_exe().ok(), std::env::current_dir().ok()]
        .into_iter()
        .flatten()
    {
        let mut dir = base.as_path();
        for _ in 0..6 {
            candidates.push(dir.join("config/pose-definitions.json"));
            candidates.push(dir.join("../config/pose-definitions.json"));
            match dir.parent() {
                Some(parent) => dir = parent,
                None => break,
            }
        }
    }

    candidates
}

/// Locate a file under `config/`, searching the same roots as the pose
/// definitions so dev runs and installed bundles both resolve.
pub fn find_config_file(name: &str) -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("PILATES_CONFIG_DIR") {
        let candidate = Path::new(&explicit).join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    let mut resource_candidates = Vec::new();
    push_resource_candidates(&mut resource_candidates, &Path::new("config").join(name));
    for candidate in resource_candidates {
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    for base in [std::env::current_exe().ok(), std::env::current_dir().ok()]
        .into_iter()
        .flatten()
    {
        let mut dir = base.as_path();
        for _ in 0..6 {
            for candidate in [
                dir.join("config").join(name),
                dir.join("../config").join(name),
            ] {
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
            match dir.parent() {
                Some(parent) => dir = parent,
                None => break,
            }
        }
    }
    None
}

impl PoseDefinitionDocument {
    pub fn load() -> EngineResult<Self> {
        let candidates = candidate_paths();
        for candidate in &candidates {
            if candidate.is_file() {
                let raw = std::fs::read_to_string(candidate).map_err(|e| {
                    EngineError::Config(format!("cannot read {}: {e}", candidate.display()))
                })?;
                let document: PoseDefinitionDocument = serde_json::from_str(&raw).map_err(|e| {
                    EngineError::Config(format!("invalid {}: {e}", candidate.display()))
                })?;
                document.validate()?;
                return Ok(document);
            }
        }
        Err(EngineError::Config(format!(
            "pose-definitions.json not found; looked in {} locations (set PILATES_POSE_DEFINITIONS to override)",
            candidates.len()
        )))
    }

    /// Parse from an in-memory string (used by tests and bundling checks).
    pub fn from_json(raw: &str) -> EngineResult<Self> {
        let document: PoseDefinitionDocument = serde_json::from_str(raw)?;
        document.validate()?;
        Ok(document)
    }

    pub fn validate(&self) -> EngineResult<()> {
        if self.poses.len() != 5 {
            return Err(EngineError::Config(format!(
                "expected exactly 5 poses, found {}",
                self.poses.len()
            )));
        }
        for (key, pose) in &self.poses {
            if &pose.pose_id != key {
                return Err(EngineError::Config(format!(
                    "{key}: pose_id '{}' does not match its key",
                    pose.pose_id
                )));
            }
            if pose.keypoint_count == 0 {
                return Err(EngineError::Config(format!("{key}: keypoint_count must be > 0")));
            }
            if !pose.keypoint_labels.is_empty()
                && pose.keypoint_labels.len() != pose.keypoint_count
            {
                return Err(EngineError::Config(format!(
                    "{key}: {} labels for {} keypoints",
                    pose.keypoint_labels.len(),
                    pose.keypoint_count
                )));
            }
            for spec in [Some(&pose.primary_angle), pose.secondary_angle.as_ref()]
                .into_iter()
                .flatten()
            {
                for (slot, index) in [("a", spec.a), ("b", spec.b), ("c", spec.c)] {
                    if index < 0 || index as usize >= pose.keypoint_count {
                        return Err(EngineError::Config(format!(
                            "{key}: {}.{slot} index {index} out of range for {} keypoints",
                            spec.name, pose.keypoint_count
                        )));
                    }
                }
            }
            let rom = &pose.target_rom;
            if !(rom.min <= rom.target && rom.target <= rom.max) {
                return Err(EngineError::Config(format!(
                    "{key}: target_rom must satisfy min <= target <= max"
                )));
            }
            if pose.hold_seconds <= 0.0 {
                return Err(EngineError::Config(format!("{key}: hold_seconds must be > 0")));
            }
        }
        Ok(())
    }

    pub fn pose(&self, pose_id: &str) -> EngineResult<&PoseDefinition> {
        self.poses
            .get(pose_id)
            .ok_or_else(|| EngineError::Invalid(format!("unknown pose '{pose_id}'")))
    }

    /// Build the FSM tuning for a pose.
    ///
    /// The tolerance band is derived from the target ROM: 12% of the span,
    /// floored at 5 degrees so a narrow ROM still has a usable window.
    pub fn fsm_config(&self, pose_id: &str) -> EngineResult<FsmConfig> {
        let pose = self.pose(pose_id)?;
        let span = (pose.target_rom.max - pose.target_rom.min).abs();
        let tolerance = (span * 0.12).max(5.0);

        Ok(FsmConfig {
            target_angle: pose.target_rom.target,
            tolerance_deg: tolerance,
            min_hold_sec: pose.hold_seconds,
            min_rep_duration_sec: 0.5,
            smoothing: 0.35,
            min_confidence: self.confidence_bands.medium,
        })
    }

    /// Repetition-counting rules for a pose.
    ///
    /// Repetitions are counted from continuous detection of the target class,
    /// not from joint angles, because the models' keypoint labels are
    /// provisional. Angles remain available as a secondary metric.
    pub fn detection_config(
        &self,
        pose_id: &str,
    ) -> EngineResult<crate::rep_tracker::DetectionRepConfig> {
        let pose = self.pose(pose_id)?;
        Ok(crate::rep_tracker::DetectionRepConfig {
            start_class: pose.detection.start_class.clone(),
            end_class: pose.detection.end_class.clone(),
            min_confidence: pose.detection.min_confidence,
            confirm_frames: pose.detection.confirm_frames,
            min_hold_sec: pose.detection.min_hold_sec,
            max_hold_sec: pose.detection.max_hold_sec,
            grace_sec: pose.detection.grace_sec,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn real_document() -> PoseDefinitionDocument {
        PoseDefinitionDocument::load().expect("load real pose definitions")
    }

    #[test]
    fn bundled_definitions_are_valid() {
        let document = real_document();
        assert_eq!(document.poses.len(), 5);
        assert!(document.confidence_bands.high > document.confidence_bands.medium);
    }

    #[test]
    fn every_pose_yields_fsm_config() {
        let document = real_document();
        for pose_id in ["pose1", "pose2", "pose3", "pose4", "pose5"] {
            let config = document.fsm_config(pose_id).expect("fsm config");
            assert!(config.target_angle > 0.0);
            assert!(config.tolerance_deg >= 5.0);
            assert_eq!(config.min_hold_sec, 3.0);
        }
    }

    #[test]
    fn keypoint_counts_match_the_exported_models() {
        // Mirrors config/model-manifest.json: 3/3/5/7/15.
        let document = real_document();
        let counts: Vec<usize> = ["pose1", "pose2", "pose3", "pose4", "pose5"]
            .iter()
            .map(|id| document.pose(id).unwrap().keypoint_count)
            .collect();
        assert_eq!(counts, vec![3, 3, 5, 7, 15]);
    }

    #[test]
    fn unknown_pose_is_rejected() {
        let document = real_document();
        assert!(document.pose("pose9").is_err());
        assert!(document.fsm_config("pose9").is_err());
    }

    #[test]
    fn invalid_document_is_rejected() {
        let broken = r#"{
            "schema_version": "1.0.0",
            "confidence_bands": {"high": 0.8, "medium": 0.5},
            "poses": {}
        }"#;
        assert!(PoseDefinitionDocument::from_json(broken).is_err());
    }

    #[test]
    fn out_of_range_angle_index_is_rejected() {
        let broken = r#"{
            "schema_version": "1.0.0",
            "confidence_bands": {"high": 0.8, "medium": 0.5},
            "default_hold_seconds": 3.0,
            "poses": {
                "pose1": {"pose_id":"pose1","display_name":"X","keypoint_count":3,
                  "primary_angle":{"name":"j","a":0,"b":1,"c":9},
                  "target_rom":{"min":0,"max":100,"target":90},"hold_seconds":3.0},
                "pose2": {"pose_id":"pose2","display_name":"X","keypoint_count":3,
                  "primary_angle":{"name":"j","a":0,"b":1,"c":2},
                  "target_rom":{"min":0,"max":100,"target":90},"hold_seconds":3.0},
                "pose3": {"pose_id":"pose3","display_name":"X","keypoint_count":3,
                  "primary_angle":{"name":"j","a":0,"b":1,"c":2},
                  "target_rom":{"min":0,"max":100,"target":90},"hold_seconds":3.0},
                "pose4": {"pose_id":"pose4","display_name":"X","keypoint_count":3,
                  "primary_angle":{"name":"j","a":0,"b":1,"c":2},
                  "target_rom":{"min":0,"max":100,"target":90},"hold_seconds":3.0},
                "pose5": {"pose_id":"pose5","display_name":"X","keypoint_count":3,
                  "primary_angle":{"name":"j","a":0,"b":1,"c":2},
                  "target_rom":{"min":0,"max":100,"target":90},"hold_seconds":3.0}
            }
        }"#;
        let error = PoseDefinitionDocument::from_json(broken).expect_err("must reject");
        assert!(error.to_string().contains("out of range"), "{error}");
    }

    // ------------------------------------------------------------------
    // Installed-layout resolution (regression tests for the `_up_` bug)
    //
    // `tauri dev` and `cargo run` resolve the repository's own `config/`
    // through the walk-up fallback, which hides a broken bundle layout. These
    // tests point `TAURI_RESOURCE_DIR` at a fake install tree so the resource
    // path is the only thing that can satisfy them.
    // ------------------------------------------------------------------

    /// Serialises tests that mutate `TAURI_RESOURCE_DIR`.
    ///
    /// The variable is process-global; two of these tests running at once
    /// would see each other's tree.
    static RESOURCE_ENV: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Restores `TAURI_RESOURCE_DIR` when it goes out of scope.
    struct ResourceDir {
        previous: Option<std::ffi::OsString>,
        dir: PathBuf,
    }

    impl ResourceDir {
        fn install(relative: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("pilates-install-{}", uuid::Uuid::new_v4()));
            let file = dir.join(relative);
            std::fs::create_dir_all(file.parent().expect("parent")).expect("mkdir");
            std::fs::write(&file, "{}").expect("write");
            let previous = std::env::var_os("TAURI_RESOURCE_DIR");
            std::env::set_var("TAURI_RESOURCE_DIR", &dir);
            Self { previous, dir }
        }
    }

    impl Drop for ResourceDir {
        fn drop(&mut self) {
            match self.previous.take() {
                Some(value) => std::env::set_var("TAURI_RESOURCE_DIR", value),
                None => std::env::remove_var("TAURI_RESOURCE_DIR"),
            }
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn bundled_layout_resolves_from_the_resource_directory() {
        let _guard = RESOURCE_ENV.lock().unwrap_or_else(|error| error.into_inner());
        let tree = ResourceDir::install("config/pose-definitions.json");

        let found = find_config_file("pose-definitions.json").expect("resolve");
        assert_eq!(found, tree.dir.join("config/pose-definitions.json"));
    }

    #[test]
    fn legacy_up_layout_still_resolves() {
        let _guard = RESOURCE_ENV.lock().unwrap_or_else(|error| error.into_inner());
        let tree = ResourceDir::install("_up_/_up_/_up_/config/pose-definitions.json");

        let found = find_config_file("pose-definitions.json").expect("resolve");
        assert_eq!(
            found,
            tree.dir.join("_up_/_up_/_up_/config/pose-definitions.json")
        );
    }

    #[test]
    fn loader_reports_a_parse_error_rather_than_not_found() {
        // Proves the resource path is actually reached: the fake file exists
        // but is empty JSON, so the failure must be a parse error mentioning
        // the path — not "not found".
        let _guard = RESOURCE_ENV.lock().unwrap_or_else(|error| error.into_inner());
        let _tree = ResourceDir::install("config/pose-definitions.json");

        let error = PoseDefinitionDocument::load().expect_err("empty document is invalid");
        let message = error.to_string();
        assert!(
            message.contains("invalid") || message.contains("missing field"),
            "expected a parse error, got: {message}"
        );
        assert!(!message.contains("not found"), "{message}");
    }
}
