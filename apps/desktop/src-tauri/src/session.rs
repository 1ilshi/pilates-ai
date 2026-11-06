//! Capture session orchestration.
//!
//! Ties the pipeline together for one exercise session:
//! `camera frame -> ONNX detection -> joint angle -> repetition FSM ->
//! Parquet recorder`, and finally assembles the `ClinicalSessionDocument` that
//! both the desktop UI and Firestore consume.

use chrono::{DateTime, Utc};
use glam::Vec2;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::biomechanics::{calculate_joint_angle, CompletedRep, FrameMetrics, MovementPhase, RepFsm};
use crate::rep_tracker::{DetectionRep, DetectionRepTracker};
use crate::camera::Frame;
use crate::inference::{Detection, InferenceOutput};
use crate::pose_config::PoseDefinition;
use crate::telemetry::{sha256_hex, DownsampledPoint, KinematicFrame, TelemetryRecorder};

/// Downsampling rate for the Firestore-hosted curve.
pub const CURVE_HZ: f32 = 2.0;

/// One repetition as serialized into the session document.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepetitionRecord {
    pub rep_index: u32,
    pub started_at_ms: i64,
    pub completed_at_ms: i64,
    pub duration_sec: f32,
    pub peak_rom_angle: f32,
    pub avg_hold_duration_sec: f32,
    pub form_score: f32,
    pub stability_variance: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionSummary {
    pub total_reps: u32,
    /// Percentage of attempted reps that satisfied the hold requirement.
    pub completion_rate: f32,
    pub mean_form_score: f32,
    pub peak_rom_angle: f32,
    pub total_hold_time_sec: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResearchTelemetryMeta {
    pub storage_path: String,
    pub gcs_bucket: String,
    pub sha256: String,
    pub file_size_bytes: usize,
    pub frame_count: usize,
}

/// The document written to `patients/{patientId}/sessions/{sessionId}`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClinicalSessionDocument {
    pub session_id: String,
    pub patient_id: String,
    pub pose_id: String,
    pub model_version: String,
    pub started_at: String,
    pub completed_at: String,
    pub duration_seconds: f64,
    pub summary: SessionSummary,
    /// Repetitions attempted (a confirmed `start`), whatever the outcome.
    ///
    /// Stored because `summary.completion_rate` is derived from it: without the
    /// denominator the metric cannot be audited or recomputed.
    pub attempts: u32,
    /// Transitions discarded for being too fast to be a real repetition.
    pub rejected_reps: u32,
    /// Frames the camera delivered that never reached this session.
    ///
    /// The capture loop is driven by the UI, so it can tick slower than the
    /// camera. That gap is invisible in every other metric and worth recording:
    /// it explains a curve that looks sparse or a rep that was never counted.
    pub dropped_frames: u64,
    pub reps: Vec<RepetitionRecord>,
    pub kinematic_curve: Vec<DownsampledPoint>,
    /// Version of this document shape, so a reader can migrate old records.
    pub schema_version: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub research_telemetry: Option<ResearchTelemetryMeta>,
}

/// Bumped whenever the session document shape changes.
pub const SESSION_SCHEMA_VERSION: u32 = 1;

/// Finished session payload, ready to persist.
#[derive(Debug, Clone)]
pub struct SessionResult {
    pub document: ClinicalSessionDocument,
    pub parquet: Vec<u8>,
    pub parquet_sha256: String,
}

/// Compute the primary joint angle for a pose from a detection.
///
/// Keypoints arrive normalized; they are projected into pixel space first so
/// the angle is not distorted by a non-square frame aspect ratio.
pub fn primary_angle_from_detection(
    detection: &Detection,
    pose: &PoseDefinition,
    frame_width: f32,
    frame_height: f32,
) -> Option<f32> {
    let spec = &pose.primary_angle;
    let lookup = |index: i32| {
        detection
            .keypoints
            .iter()
            .find(|keypoint| keypoint.id == index)
            .map(|keypoint| {
                Vec2::new(
                    keypoint.x * frame_width,
                    keypoint.y * frame_height,
                )
            })
    };

    let a = lookup(spec.a)?;
    let b = lookup(spec.b)?;
    let c = lookup(spec.c)?;

    let angle = calculate_joint_angle(a, b, c);
    if angle.is_finite() {
        Some(angle)
    } else {
        None
    }
}

/// Mean keypoint confidence across a detection.
pub fn mean_confidence(detection: &Detection) -> f32 {
    if detection.keypoints.is_empty() {
        return 0.0;
    }
    detection.keypoints.iter().map(|k| k.confidence).sum::<f32>() / detection.keypoints.len() as f32
}

/// A live capture session.
pub struct CaptureSession {
    session_id: String,
    patient_id: String,
    pose_id: String,
    model_version: String,
    started_at: DateTime<Utc>,
    started_ms: i64,
    /// Angle-based metrics (phase, angle, form score). Secondary.
    fsm: RepFsm,
    /// Detection-duration repetition counter. Authoritative.
    tracker: DetectionRepTracker,
    recorder: TelemetryRecorder,
    peak_angle: f32,
    total_hold_sec: f32,
    last_metrics: Option<FrameMetrics>,
    last_rep: Option<DetectionRep>,
    rejected_reps: u32,
    frame_index: i32,
    model_class: i8,
}

impl CaptureSession {
    pub fn new(
        patient_id: impl Into<String>,
        pose_id: impl Into<String>,
        model_version: impl Into<String>,
        fsm: RepFsm,
        tracker: DetectionRepTracker,
    ) -> Self {
        let now = Utc::now();
        Self {
            session_id: Uuid::new_v4().to_string(),
            patient_id: patient_id.into(),
            pose_id: pose_id.into(),
            model_version: model_version.into(),
            started_at: now,
            started_ms: now.timestamp_millis(),
            fsm,
            tracker,
            // 30 Hz for a 20 minute session ~= 36k frames.
            recorder: TelemetryRecorder::with_capacity(40_000),
            peak_angle: 0.0,
            total_hold_sec: 0.0,
            last_metrics: None,
            last_rep: None,
            rejected_reps: 0,
            frame_index: 0,
            model_class: -1,
        }
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn patient_id(&self) -> &str {
        &self.patient_id
    }

    pub fn pose_id(&self) -> &str {
        &self.pose_id
    }

    pub fn frame_count(&self) -> usize {
        self.recorder.len()
    }

    pub fn rep_count(&self) -> u32 {
        self.tracker.rep_count()
    }

    /// Repetitions discarded for being shorter than the minimum duration.
    pub fn rejected_reps(&self) -> u32 {
        self.rejected_reps
    }

    /// Duration of the hold currently in progress, in seconds.
    pub fn active_hold_sec(&self, timestamp_ms: i64) -> f32 {
        self.tracker.active_duration_sec(timestamp_ms)
    }

    /// Duration of the hold in progress, measured against the wall clock.
    pub fn active_hold_now(&self) -> f32 {
        let now = Utc::now().timestamp_millis() - self.started_ms;
        self.tracker.active_duration_sec(now)
    }

    /// `start` positions confirmed so far — one per attempted repetition.
    pub fn attempts(&self) -> u32 {
        self.tracker.attempts()
    }

    /// Most recent composite form score, 0 when nothing has been measured.
    pub fn last_form_score(&self) -> f32 {
        self.last_metrics
            .map(|metrics| metrics.instantaneous_form_score)
            .unwrap_or(0.0)
    }

    /// The most recently counted repetition, for live feedback.
    pub fn last_rep(&self) -> Option<&DetectionRep> {
        self.last_rep.as_ref()
    }

    pub fn last_metrics(&self) -> Option<FrameMetrics> {
        self.last_metrics
    }

    /// Feed one frame + its inference result through the pipeline.
    pub fn process(
        &mut self,
        frame: &Frame,
        output: &InferenceOutput,
        pose: &PoseDefinition,
    ) -> FrameMetrics {
        self.frame_index += 1;
        let timestamp_ms = frame.captured_at_ms - self.started_ms;

        // Highest-confidence detection wins; an empty frame freezes the FSM.
        let detection = output
            .detections
            .iter()
            .max_by(|a, b| {
                a.class_confidence
                    .partial_cmp(&b.class_confidence)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });

        let (angle, confidence, secondary_angle) = match detection {
            Some(detection) => {
                self.model_class = detection.class_id as i8;
                let primary = primary_angle_from_detection(
                    detection,
                    pose,
                    frame.width as f32,
                    frame.height as f32,
                );
                let secondary = pose
                    .secondary_angle
                    .as_ref()
                    .and_then(|spec| {
                        let lookup = |index: i32| {
                            detection
                                .keypoints
                                .iter()
                                .find(|k| k.id == index)
                                .map(|k| Vec2::new(k.x * frame.width as f32, k.y * frame.height as f32))
                        };
                        let a = lookup(spec.a)?;
                        let b = lookup(spec.b)?;
                        let c = lookup(spec.c)?;
                        let value = calculate_joint_angle(a, b, c);
                        value.is_finite().then_some(value)
                    })
                    .unwrap_or(f32::NAN);

                (primary, mean_confidence(detection), secondary)
            }
            None => (None, 0.0, f32::NAN),
        };

        let metrics = self.fsm.update(timestamp_ms, angle, confidence);

        // Repetitions are counted from continuous detection of the target
        // class, not from angles: the models' keypoint labels are provisional,
        // so an angle-based count could silently never fire.
        let rep_label = detection.map(|d| d.label.as_str());
        let rep_confidence = detection.map(|d| d.class_confidence).unwrap_or(0.0);
        if let Some(rep) = self.tracker.update(
            timestamp_ms,
            rep_label,
            rep_confidence,
            metrics.instantaneous_form_score,
            metrics.primary_angle,
        ) {
            if rep.counted {
                self.last_rep = Some(rep);
            } else {
                self.rejected_reps += 1;
            }
        }

        if metrics.primary_angle.is_finite() {
            self.peak_angle = self.peak_angle.max(metrics.primary_angle);
        }
        self.total_hold_sec += metrics.hold_duration_sec.max(0.0) / 30.0;
        self.last_metrics = Some(metrics);

        // Record every frame for the research lake.
        let keypoints = detection.map(|d| d.keypoints.as_slice()).unwrap_or(&[]);
        self.recorder.push(KinematicFrame {
            timestamp_ms,
            frame_index: self.frame_index,
            phase: metrics.phase,
            primary_angle: if metrics.primary_angle.is_finite() {
                metrics.primary_angle
            } else {
                0.0
            },
            secondary_angle: if secondary_angle.is_finite() {
                secondary_angle
            } else {
                0.0
            },
            form_score: metrics.instantaneous_form_score,
            keypoint_ids: keypoints.iter().map(|k| k.id as i8).collect(),
            keypoint_x: keypoints.iter().map(|k| k.x).collect(),
            keypoint_y: keypoints.iter().map(|k| k.y).collect(),
            keypoint_conf: keypoints.iter().map(|k| k.confidence).collect(),
            model_class: self.model_class,
        });

        metrics
    }

    /// Finalize the session into a document plus Parquet payload.
    pub fn finish(
        mut self,
        gcs_bucket: &str,
        camera_frames: u64,
    ) -> crate::error::EngineResult<SessionResult> {
        let completed_at = Utc::now();
        let duration_seconds = (completed_at - self.started_at).num_milliseconds() as f64 / 1000.0;

        // Close a hold that was still in progress when the session stopped.
        if let Some(rep) = self.tracker.finish() {
            if rep.counted {
                self.last_rep = Some(rep);
            } else {
                self.rejected_reps += 1;
            }
        }

        let parquet = self.recorder.to_parquet()?;
        let parquet_sha256 = sha256_hex(&parquet);
        let frame_count = self.recorder.len();
        // Frames the camera produced but this session never recorded, because
        // the UI ticks slower than the camera delivers.
        let dropped_frames = camera_frames.saturating_sub(frame_count as u64);
        let curve = crate::telemetry::cap_for_document(self.recorder.downsample(CURVE_HZ));

        let reps: Vec<RepetitionRecord> = self
            .tracker
            .counted()
            .iter()
            .map(RepetitionRecord::from)
            .collect();

        let total_reps = reps.len() as u32;
        let attempts = self.tracker.attempts();
        let completion_rate = if attempts == 0 {
            0.0
        } else {
            (total_reps as f32 / attempts as f32 * 100.0).clamp(0.0, 100.0)
        };
        let mean_form_score = if reps.is_empty() {
            0.0
        } else {
            reps.iter().map(|r| r.form_score).sum::<f32>() / reps.len() as f32
        };

        let document = ClinicalSessionDocument {
            session_id: self.session_id.clone(),
            patient_id: self.patient_id.clone(),
            pose_id: self.pose_id.clone(),
            model_version: self.model_version.clone(),
            started_at: self.started_at.to_rfc3339(),
            completed_at: completed_at.to_rfc3339(),
            duration_seconds,
            summary: SessionSummary {
                total_reps,
                completion_rate,
                mean_form_score,
                peak_rom_angle: self.peak_angle,
                // Hold time is the sum of the counted repetitions' durations.
                // The old angle-FSM accumulator reads zero under the
                // detection-based rep model, which made the metric useless.
                total_hold_time_sec: reps.iter().map(|rep| rep.duration_sec).sum(),
            },
            attempts,
            rejected_reps: self.rejected_reps,
            dropped_frames,
            reps,
            kinematic_curve: curve,
            schema_version: SESSION_SCHEMA_VERSION,
            research_telemetry: Some(ResearchTelemetryMeta {
                storage_path: crate::cloud_sync::telemetry_object_path(
                    &self.patient_id,
                    &self.session_id,
                ),
                gcs_bucket: gcs_bucket.to_string(),
                sha256: parquet_sha256.clone(),
                file_size_bytes: parquet.len(),
                frame_count,
            }),
        };

        Ok(SessionResult {
            document,
            parquet,
            parquet_sha256,
        })
    }
}

impl From<&CompletedRep> for RepetitionRecord {
    fn from(rep: &CompletedRep) -> Self {
        Self {
            rep_index: rep.rep_index,
            started_at_ms: rep.started_at_ms,
            completed_at_ms: rep.completed_at_ms,
            duration_sec: rep.duration_sec,
            peak_rom_angle: rep.peak_rom_angle,
            avg_hold_duration_sec: rep.avg_hold_duration_sec,
            form_score: rep.form_score,
            stability_variance: rep.stability_variance,
        }
    }
}

impl From<&DetectionRep> for RepetitionRecord {
    fn from(rep: &DetectionRep) -> Self {
        Self {
            rep_index: rep.rep_index,
            started_at_ms: rep.started_at_ms,
            completed_at_ms: rep.completed_at_ms,
            duration_sec: rep.duration_sec,
            peak_rom_angle: rep.peak_rom_angle,
            // For a detection-counted rep the hold *is* the episode.
            avg_hold_duration_sec: rep.duration_sec,
            form_score: rep.form_score,
            stability_variance: rep.stability_variance,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::biomechanics::FsmConfig;
    use crate::inference::{ExecutionProviderKind, Keypoint};

    fn detection(keypoints: Vec<Keypoint>) -> Detection {
        Detection {
            bbox: [0.1, 0.1, 0.9, 0.9],
            class_id: 1,
            class_confidence: 0.9,
            label: "start".into(),
            keypoints,
        }
    }

    /// Tracker configured for the synthetic labels used in these tests.
    ///
    /// `confirm_frames = 1` keeps the tests readable: they feed one frame per
    /// state rather than three.
    fn test_tracker(min_hold: f32) -> DetectionRepTracker {
        DetectionRepTracker::new(crate::rep_tracker::DetectionRepConfig {
            start_class: "start".into(),
            end_class: "end".into(),
            min_confidence: 0.25,
            confirm_frames: 1,
            min_hold_sec: min_hold,
            max_hold_sec: 120.0,
            grace_sec: 0.6,
        })
    }

    /// A detection carrying an explicit class label.
    fn labelled(label: &str, keypoints: Vec<Keypoint>) -> Detection {
        Detection {
            bbox: [0.1, 0.1, 0.9, 0.9],
            class_id: if label == "end" { 0 } else { 1 },
            class_confidence: 0.9,
            label: label.to_string(),
            keypoints,
        }
    }

    fn frame_at(t: i64) -> Frame {
        Frame {
            width: 640,
            height: 480,
            rgb: vec![0u8; 640 * 480 * 3],
            captured_at_ms: t,
            sequence: 1,
        }
    }

    fn pose() -> PoseDefinition {
        // pose1: hip(0) - knee(1) - ankle(2)
        PoseDefinition {
            pose_id: "pose1".into(),
            display_name: "The Hundred".into(),
            keypoint_count: 3,
            keypoint_labels: vec!["hip".into(), "knee".into(), "ankle".into()],
            bones: vec![vec![0, 1], vec![1, 2]],
            primary_angle: crate::pose_config::JointAngleSpec {
                name: "knee_flexion".into(),
                a: 0,
                b: 1,
                c: 2,
                unit: "degrees".into(),
            },
            secondary_angle: None,
            target_rom: crate::pose_config::TargetRom {
                min: 0.0,
                max: 140.0,
                target: 90.0,
            },
            hold_seconds: 3.0,
            detection: crate::pose_config::DetectionSpec::default(),
        }
    }

    fn straight_leg() -> Vec<Keypoint> {
        vec![
            Keypoint { id: 0, x: 0.5, y: 0.2, confidence: 0.95 },
            Keypoint { id: 1, x: 0.5, y: 0.5, confidence: 0.95 },
            Keypoint { id: 2, x: 0.5, y: 0.8, confidence: 0.95 },
        ]
    }

    #[test]
    fn primary_angle_of_straight_leg_is_180() {
        let angle = primary_angle_from_detection(&detection(straight_leg()), &pose(), 640.0, 480.0)
            .expect("angle");
        assert!((angle - 180.0).abs() < 1e-3, "got {angle}");
    }

    #[test]
    fn primary_angle_returns_none_when_keypoints_missing() {
        let partial = detection(vec![Keypoint { id: 0, x: 0.5, y: 0.2, confidence: 0.9 }]);
        assert!(primary_angle_from_detection(&partial, &pose(), 640.0, 480.0).is_none());
    }

    #[test]
    fn mean_confidence_handles_empty() {
        assert_eq!(mean_confidence(&detection(Vec::new())), 0.0);
        let mean = mean_confidence(&detection(straight_leg()));
        assert!((mean - 0.95).abs() < 1e-6);
    }

    #[test]
    fn empty_frame_freezes_fsm_but_still_records() {
        let fsm = RepFsm::new(FsmConfig::default());
        let mut session = CaptureSession::new("p1", "pose1", "v1", fsm, test_tracker(0.5));
        let output = InferenceOutput {
            detections: Vec::new(),
            inference_ms: 1.0,
            provider: ExecutionProviderKind::Cpu,
            best_class_id: -1,
            best_class_score: 0.0,
            best_class_label: String::new(),
        };
        let metrics = session.process(&frame_at(1000), &output, &pose());
        assert_eq!(metrics.phase, MovementPhase::Idle);
        assert_eq!(session.frame_count(), 1, "frames are still recorded for research");
    }

    #[test]
    fn session_finish_produces_valid_parquet_and_document() {
        let config = FsmConfig {
            target_angle: 180.0,
            tolerance_deg: 5.0,
            min_hold_sec: 0.2,
            min_rep_duration_sec: 0.05,
            smoothing: 1.0,
            min_confidence: 0.5,
        };
        let mut session = CaptureSession::new("p1", "pose1", "v1", RepFsm::new(config), test_tracker(0.5));

        // A repetition is a `start` → `end` transition, so feed both classes.
        let at_start = InferenceOutput {
            detections: vec![labelled("start", straight_leg())],
            inference_ms: 1.0,
            provider: ExecutionProviderKind::Cpu,
            best_class_id: -1,
            best_class_score: 0.0,
            best_class_label: String::new(),
        };
        let at_end = InferenceOutput {
            detections: vec![labelled(
                "end",
                vec![
                    Keypoint { id: 0, x: 0.5, y: 0.2, confidence: 0.95 },
                    Keypoint { id: 1, x: 0.5, y: 0.5, confidence: 0.95 },
                    Keypoint { id: 2, x: 0.8, y: 0.5, confidence: 0.95 },
                ],
            )],
            inference_ms: 1.0,
            provider: ExecutionProviderKind::Cpu,
            best_class_id: -1,
            best_class_score: 0.0,
            best_class_label: String::new(),
        };

        // Neutral position, then one second of holding the exercise pose:
        // a repetition is a hold of `end`, so this is one completed rep.
        for index in 0..5 {
            session.process(&frame_at(1_000 + index * 33), &at_start, &pose());
        }
        for index in 0..30 {
            session.process(&frame_at(1_200 + index * 33), &at_end, &pose());
        }

        let result = session.finish("bucket", 40).expect("finish");
        assert_eq!(&result.parquet[0..4], b"PAR1");
        assert_eq!(result.parquet_sha256.len(), 64);
        assert_eq!(result.document.patient_id, "p1");
        assert_eq!(result.document.summary.total_reps, 1);
        assert!(!result.document.kinematic_curve.is_empty());
        // The camera delivered 40 frames; 35 reached the session.
        assert_eq!(result.document.dropped_frames, 5);
        assert_eq!(result.document.attempts, 1, "the rep denominator is recorded");
        assert_eq!(result.document.schema_version, SESSION_SCHEMA_VERSION);
        let telemetry = result.document.research_telemetry.expect("meta");
        assert!(telemetry.storage_path.ends_with(".parquet"));
        assert_eq!(telemetry.gcs_bucket, "bucket");
        assert_eq!(telemetry.frame_count, 35);
    }

    /// Hardware-free end-to-end run: no webcam, no ONNX Runtime, no network.
    ///
    /// A scripted sequence of frames plus detections is pushed through the real
    /// capture pipeline, so this exercises the FSM, telemetry recorder and
    /// Parquet encoder together.
    #[test]
    fn synthetic_pipeline_completes_repetitions_without_hardware() {
        use crate::mock_source::{MockPipeline, RepProfile};

        let profile = RepProfile::default();
        let mut pipeline = MockPipeline::new(2, profile);

        let fsm = RepFsm::new(FsmConfig {
            target_angle: 90.0,
            tolerance_deg: 6.0,
            min_hold_sec: 3.0,
            min_rep_duration_sec: 0.5,
            smoothing: 1.0,
            min_confidence: 0.5,
        });
        let mut session = CaptureSession::new("p1", "pose1", "mock", fsm, test_tracker(0.5));
        let pose_definition = pose();

        let mut processed = 0;
        while let Some((frame, output)) = pipeline.next_frame() {
            session.process(&frame, &output, &pose_definition);
            processed += 1;
        }

        assert_eq!(processed, pipeline.total_frames());
        assert_eq!(session.frame_count(), processed, "every frame is recorded");

        let result = session.finish("test-bucket", 0).expect("finish");
        assert_eq!(
            result.document.summary.total_reps, 2,
            "the scripted profile contains two complete repetitions"
        );
        assert!(
            result.document.summary.peak_rom_angle > 80.0,
            "peak ROM should approach the scripted 90 degrees, got {}",
            result.document.summary.peak_rom_angle
        );
        assert_eq!(&result.parquet[0..4], b"PAR1");
        assert!(!result.document.kinematic_curve.is_empty());
    }

    #[test]
    fn document_serializes_to_the_typescript_contract() {
        let mut session = CaptureSession::new("p1", "pose1", "v1", RepFsm::new(FsmConfig::default()), test_tracker(0.5));
        let output = InferenceOutput {
            detections: vec![detection(straight_leg())],
            inference_ms: 1.0,
            provider: ExecutionProviderKind::Cpu,
            best_class_id: -1,
            best_class_score: 0.0,
            best_class_label: String::new(),
        };
        session.process(&frame_at(1_000), &output, &pose());
        let result = session.finish("bucket", 0).expect("finish");
        let json = serde_json::to_value(&result.document).expect("serialize");

        for key in [
            "session_id",
            "patient_id",
            "pose_id",
            "model_version",
            "started_at",
            "completed_at",
            "duration_seconds",
            "summary",
            "reps",
            "kinematic_curve",
            "research_telemetry",
        ] {
            assert!(json.get(key).is_some(), "missing {key}");
        }
        assert!(json["summary"].get("completion_rate").is_some());
        assert!(json["kinematic_curve"][0].get("t_sec").is_some());
        // Phase must serialize as the snake_case union the UI expects.
        assert!(json["kinematic_curve"][0]["phase"].is_string());
    }
}
