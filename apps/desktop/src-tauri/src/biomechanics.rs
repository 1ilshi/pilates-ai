//! Biomechanical math engine.
//!
//! Owns three responsibilities, all of them pure and unit-testable:
//!
//! 1. **Joint trigonometry** — [`calculate_joint_angle`] mirrors
//!    `packages/viz/src/lib/geometry.ts` so the UI and the engine can never
//!    disagree about a displayed angle.
//! 2. **Repetition finite state machine** — [`RepFsm`] turns a stream of
//!    primary joint angles into clinical movement phases and completed reps.
//! 3. **Composite form scoring** — angle accuracy, hold stability and
//!    detection confidence blended into a 0-100 score.

use glam::Vec2;
use serde::{Deserialize, Serialize};

/// Movement phases. Must stay in lockstep with `MovementPhase` in
/// `packages/types/src/biomechanics.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MovementPhase {
    Idle,
    StartPosition,
    Eccentric,
    Holding,
    Concentric,
    RepCompleted,
}

impl MovementPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            MovementPhase::Idle => "idle",
            MovementPhase::StartPosition => "start_position",
            MovementPhase::Eccentric => "eccentric",
            MovementPhase::Holding => "holding",
            MovementPhase::Concentric => "concentric",
            MovementPhase::RepCompleted => "rep_completed",
        }
    }
}

/// Angle at vertex `b`, formed by segments `b->a` and `b->c`, in degrees.
///
/// Returns `f32::NAN` for a degenerate configuration (coincident points), which
/// callers must treat as "no reading" rather than as a valid angle.
pub fn calculate_joint_angle(a: Vec2, b: Vec2, c: Vec2) -> f32 {
    let v1 = a - b;
    let v2 = c - b;
    if v1.length_squared() == 0.0 || v2.length_squared() == 0.0 {
        return f32::NAN;
    }
    let v1 = v1.normalize();
    let v2 = v2.normalize();
    v1.dot(v2).clamp(-1.0, 1.0).acos().to_degrees()
}

/// Composite form-score weights. Must sum to 1.0.
pub const WEIGHT_ANGLE: f32 = 0.50;
pub const WEIGHT_STABILITY: f32 = 0.30;
pub const WEIGHT_CONFIDENCE: f32 = 0.20;

/// Tuning for the repetition state machine. One instance per pose, built from
/// `config/pose-definitions.json`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct FsmConfig {
    /// Clinically targeted joint angle in degrees.
    pub target_angle: f32,
    /// Half-width of the acceptable band around `target_angle`.
    pub tolerance_deg: f32,
    /// Minimum continuous time inside the band for a rep to count.
    pub min_hold_sec: f32,
    /// A rep shorter than this is discarded as a twitch/artifact.
    pub min_rep_duration_sec: f32,
    /// Exponential smoothing factor applied to the incoming angle (0-1).
    /// Lower values are steadier but lag more.
    pub smoothing: f32,
    /// Below this keypoint confidence the frame is treated as "no reading".
    pub min_confidence: f32,
}

impl Default for FsmConfig {
    fn default() -> Self {
        Self {
            target_angle: 90.0,
            tolerance_deg: 10.0,
            min_hold_sec: 3.0,
            min_rep_duration_sec: 0.5,
            smoothing: 0.35,
            min_confidence: 0.5,
        }
    }
}

/// Per-frame metrics emitted by the engine to the UI and the Parquet writer.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct FrameMetrics {
    pub phase: MovementPhase,
    pub rep_count: u32,
    pub primary_angle: f32,
    pub target_angle: f32,
    pub angle_deviation: f32,
    pub instantaneous_form_score: f32,
    pub hold_duration_sec: f32,
    pub in_target_band: bool,
}

/// A completed repetition, matching `RepetitionRecord` in `packages/types`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompletedRep {
    pub rep_index: u32,
    pub started_at_ms: i64,
    pub completed_at_ms: i64,
    pub duration_sec: f32,
    pub peak_rom_angle: f32,
    pub avg_hold_duration_sec: f32,
    pub form_score: f32,
    pub stability_variance: f32,
}

/// Running accumulator for one rep.
#[derive(Debug, Clone)]
struct RepInFlight {
    started_at_ms: i64,
    peak_angle: f32,
    angle_sum: f32,
    angle_sq_sum: f32,
    samples: u32,
    hold_started_at_ms: Option<i64>,
    accumulated_hold_sec: f32,
    score_sum: f32,
    score_samples: u32,
}

impl RepInFlight {
    fn new(started_at_ms: i64) -> Self {
        Self {
            started_at_ms,
            peak_angle: f32::NEG_INFINITY,
            angle_sum: 0.0,
            angle_sq_sum: 0.0,
            samples: 0,
            hold_started_at_ms: None,
            accumulated_hold_sec: 0.0,
            score_sum: 0.0,
            score_samples: 0,
        }
    }

    fn observe(&mut self, angle: f32, score: f32) {
        self.peak_angle = self.peak_angle.max(angle);
        self.angle_sum += angle;
        self.angle_sq_sum += angle * angle;
        self.samples += 1;
        self.score_sum += score;
        self.score_samples += 1;
    }

    /// Population variance of the observed angles; low = steady hold.
    fn variance(&self) -> f32 {
        if self.samples < 2 {
            return 0.0;
        }
        let n = self.samples as f32;
        let mean = self.angle_sum / n;
        ((self.angle_sq_sum / n) - mean * mean).max(0.0)
    }

    fn mean_score(&self) -> f32 {
        if self.score_samples == 0 {
            0.0
        } else {
            self.score_sum / self.score_samples as f32
        }
    }
}

/// Repetition finite state machine.
///
/// Transitions: `Idle -> StartPosition -> Concentric -> Holding -> RepCompleted
/// -> (Eccentric) -> StartPosition`, with `Eccentric` also reachable directly
/// from `Concentric` when the patient aborts a rep before holding.
#[derive(Debug, Clone)]
pub struct RepFsm {
    config: FsmConfig,
    phase: MovementPhase,
    smoothed_angle: Option<f32>,
    previous_angle: Option<f32>,
    rep_in_flight: Option<RepInFlight>,
    completed: Vec<CompletedRep>,
    last_timestamp_ms: i64,
    hold_started_ms: Option<i64>,
    last_hold_sec: f32,
    last_score: f32,
}

impl RepFsm {
    pub fn new(config: FsmConfig) -> Self {
        Self {
            config,
            phase: MovementPhase::Idle,
            smoothed_angle: None,
            previous_angle: None,
            rep_in_flight: None,
            completed: Vec::new(),
            last_timestamp_ms: 0,
            hold_started_ms: None,
            last_hold_sec: 0.0,
            last_score: 0.0,
        }
    }

    pub fn phase(&self) -> MovementPhase {
        self.phase
    }

    pub fn rep_count(&self) -> u32 {
        self.completed.len() as u32
    }

    pub fn completed_reps(&self) -> &[CompletedRep] {
        &self.completed
    }

    pub fn config(&self) -> &FsmConfig {
        &self.config
    }

    /// Feed one frame. `angle` is `None` when keypoints were missing or too
    /// low-confidence; such frames freeze the FSM without inventing motion.
    pub fn update(&mut self, timestamp_ms: i64, angle: Option<f32>, confidence: f32) -> FrameMetrics {
        self.last_timestamp_ms = timestamp_ms;

        let Some(raw_angle) = angle.filter(|a| a.is_finite()) else {
            // No usable reading: hold current phase, report last known values.
            return self.metrics(None, confidence);
        };

        if confidence < self.config.min_confidence {
            return self.metrics(Some(raw_angle), confidence);
        }

        // Exponential smoothing keeps a shaky detection from flapping the FSM.
        let alpha = self.config.smoothing.clamp(0.0, 1.0);
        let smoothed = match self.smoothed_angle {
            Some(previous) => previous + alpha * (raw_angle - previous),
            None => raw_angle,
        };
        self.smoothed_angle = Some(smoothed);

        let deviation = (smoothed - self.config.target_angle).abs();
        let in_band = deviation <= self.config.tolerance_deg;
        let direction = match self.previous_angle {
            Some(previous) => smoothed - previous,
            None => 0.0,
        };
        self.previous_angle = Some(smoothed);

        let score = self.compute_score(smoothed, confidence);

        // Lazily start a rep as soon as we see real motion.
        if self.rep_in_flight.is_none() && self.phase != MovementPhase::Idle {
            self.rep_in_flight = Some(RepInFlight::new(timestamp_ms));
        }
        if self.phase == MovementPhase::Idle {
            self.phase = MovementPhase::StartPosition;
        }

        if let Some(rep) = self.rep_in_flight.as_mut() {
            rep.observe(smoothed, score);
        }

        if in_band {
            let hold_started = *self.hold_started_ms.get_or_insert(timestamp_ms);
            let hold_sec = ((timestamp_ms - hold_started) as f32 / 1000.0).max(0.0);
            self.last_hold_sec = hold_sec;
            self.phase = MovementPhase::Holding;

            if let Some(rep) = self.rep_in_flight.as_mut() {
                rep.hold_started_at_ms.get_or_insert(hold_started);
            }
        } else if self.phase == MovementPhase::Holding {
            // Leaving the band after a valid hold completes the rep.
            let hold_sec = self.last_hold_sec;
            self.hold_started_ms = None;

            if hold_sec >= self.config.min_hold_sec {
                self.complete_rep(timestamp_ms, hold_sec);
                self.phase = MovementPhase::RepCompleted;
            } else {
                // Aborted hold: no rep credit, treat as motion away from target.
                self.phase = MovementPhase::Eccentric;
                if let Some(rep) = self.rep_in_flight.as_mut() {
                    rep.accumulated_hold_sec += hold_sec;
                    rep.hold_started_at_ms = None;
                }
            }
        } else {
            self.hold_started_ms = None;
            self.last_hold_sec = 0.0;
            // Moving toward the target is concentric; away from it is eccentric.
            let toward_target = direction * (self.config.target_angle - smoothed) > 0.0;
            self.phase = if direction == 0.0 {
                self.phase
            } else if toward_target {
                MovementPhase::Concentric
            } else {
                MovementPhase::Eccentric
            };
        }

        self.last_score = score;
        self.metrics(Some(smoothed), confidence)
    }

    fn complete_rep(&mut self, timestamp_ms: i64, hold_sec: f32) {
        let Some(rep) = self.rep_in_flight.take() else {
            return;
        };
        let duration_sec = (timestamp_ms - rep.started_at_ms) as f32 / 1000.0;

        // Discard sub-threshold twitches.
        if duration_sec < self.config.min_rep_duration_sec {
            return;
        }

        let total_hold = rep.accumulated_hold_sec + hold_sec;
        self.completed.push(CompletedRep {
            rep_index: self.completed.len() as u32 + 1,
            started_at_ms: rep.started_at_ms,
            completed_at_ms: timestamp_ms,
            duration_sec,
            peak_rom_angle: rep.peak_angle,
            avg_hold_duration_sec: total_hold,
            form_score: rep.mean_score(),
            stability_variance: rep.variance(),
        });
    }

    /// Blend angle accuracy, hold stability and detection confidence into 0-100.
    fn compute_score(&self, angle: f32, confidence: f32) -> f32 {
        let deviation = (angle - self.config.target_angle).abs();
        // Full credit inside the tolerance band, decaying to zero at 3x tolerance.
        let tolerance = self.config.tolerance_deg.max(1.0);
        let angle_accuracy = if deviation <= tolerance {
            100.0
        } else {
            let excess = (deviation - tolerance) / (tolerance * 2.0);
            (100.0 * (1.0 - excess)).clamp(0.0, 100.0)
        };

        // Stability: penalise frame-to-frame jitter of the smoothed signal.
        let stability = match self.previous_angle {
            Some(previous) => {
                let jitter = (angle - previous).abs();
                (100.0 - jitter * 8.0).clamp(0.0, 100.0)
            }
            None => 100.0,
        };

        let detection = (confidence.clamp(0.0, 1.0)) * 100.0;

        (angle_accuracy * WEIGHT_ANGLE
            + stability * WEIGHT_STABILITY
            + detection * WEIGHT_CONFIDENCE)
            .clamp(0.0, 100.0)
    }

    fn metrics(&self, angle: Option<f32>, _confidence: f32) -> FrameMetrics {
        let primary_angle = angle.or(self.smoothed_angle).unwrap_or(f32::NAN);
        let deviation = if primary_angle.is_finite() {
            (primary_angle - self.config.target_angle).abs()
        } else {
            f32::NAN
        };
        FrameMetrics {
            phase: self.phase,
            rep_count: self.rep_count(),
            primary_angle,
            target_angle: self.config.target_angle,
            angle_deviation: deviation,
            instantaneous_form_score: self.last_score,
            hold_duration_sec: self.last_hold_sec,
            in_target_band: deviation.is_finite() && deviation <= self.config.tolerance_deg,
        }
    }

    /// Reset motion state but keep completed reps (used when the pose changes).
    pub fn reset_motion(&mut self) {
        self.phase = MovementPhase::Idle;
        self.smoothed_angle = None;
        self.previous_angle = None;
        self.rep_in_flight = None;
        self.hold_started_ms = None;
        self.last_hold_sec = 0.0;
        self.last_score = 0.0;
    }

    pub fn last_timestamp_ms(&self) -> i64 {
        self.last_timestamp_ms
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EPS: f32 = 1e-4;

    #[test]
    fn angle_right_angle_is_90() {
        let angle = calculate_joint_angle(Vec2::new(1.0, 0.0), Vec2::ZERO, Vec2::new(0.0, 1.0));
        assert!((angle - 90.0).abs() < EPS, "got {angle}");
    }

    #[test]
    fn angle_straight_line_is_180() {
        let angle =
            calculate_joint_angle(Vec2::new(-1.0, 0.0), Vec2::ZERO, Vec2::new(1.0, 0.0));
        assert!((angle - 180.0).abs() < EPS, "got {angle}");
    }

    #[test]
    fn angle_coincident_rays_is_0() {
        let angle = calculate_joint_angle(Vec2::new(1.0, 0.0), Vec2::ZERO, Vec2::new(2.0, 0.0));
        assert!(angle.abs() < EPS, "got {angle}");
    }

    #[test]
    fn angle_45_degrees() {
        let angle = calculate_joint_angle(Vec2::new(1.0, 0.0), Vec2::ZERO, Vec2::new(1.0, 1.0));
        assert!((angle - 45.0).abs() < 1e-3, "got {angle}");
    }

    #[test]
    fn angle_degenerate_is_nan() {
        let angle = calculate_joint_angle(Vec2::ZERO, Vec2::ZERO, Vec2::new(1.0, 1.0));
        assert!(angle.is_nan());
    }

    fn cfg() -> FsmConfig {
        FsmConfig {
            target_angle: 90.0,
            tolerance_deg: 5.0,
            min_hold_sec: 3.0,
            min_rep_duration_sec: 0.5,
            smoothing: 1.0, // no smoothing: deterministic tests
            min_confidence: 0.5,
        }
    }

    /// Drive the FSM at 30 Hz for `duration_ms` at a constant angle.
    fn drive(fsm: &mut RepFsm, start_ms: i64, duration_ms: i64, angle: f32) -> i64 {
        let mut t = start_ms;
        while t < start_ms + duration_ms {
            fsm.update(t, Some(angle), 0.95);
            t += 33;
        }
        t
    }

    #[test]
    fn fsm_starts_idle_then_reaches_start_position() {
        let mut fsm = RepFsm::new(cfg());
        assert_eq!(fsm.phase(), MovementPhase::Idle);
        fsm.update(0, Some(20.0), 0.95);
        assert_eq!(fsm.phase(), MovementPhase::StartPosition);
    }

    #[test]
    fn fsm_completes_rep_after_minimum_hold() {
        let mut fsm = RepFsm::new(cfg());
        // Move from rest up into the band.
        let mut t = drive(&mut fsm, 0, 1000, 20.0);
        t = drive(&mut fsm, t, 1000, 90.0); // arrives at target
        assert_eq!(fsm.phase(), MovementPhase::Holding);
        // Hold long enough.
        t = drive(&mut fsm, t, 3500, 90.0);
        // Leave the band to complete the rep.
        fsm.update(t, Some(20.0), 0.95);

        assert_eq!(fsm.rep_count(), 1);
        let rep = &fsm.completed_reps()[0];
        assert_eq!(rep.rep_index, 1);
        assert!(rep.avg_hold_duration_sec >= 3.0, "hold {}", rep.avg_hold_duration_sec);
        assert!(rep.form_score > 0.0 && rep.form_score <= 100.0);
    }

    #[test]
    fn fsm_rejects_hold_shorter_than_threshold() {
        let mut fsm = RepFsm::new(cfg());
        let mut t = drive(&mut fsm, 0, 500, 20.0);
        t = drive(&mut fsm, t, 1000, 90.0); // in band ~1s only
        fsm.update(t, Some(20.0), 0.95);
        assert_eq!(fsm.rep_count(), 0, "short hold must not count as a rep");
    }

    #[test]
    fn fsm_counts_multiple_reps() {
        let mut fsm = RepFsm::new(cfg());
        let mut t = 0;
        for _ in 0..3 {
            t = drive(&mut fsm, t, 500, 20.0);
            t = drive(&mut fsm, t, 1000, 90.0);
            t = drive(&mut fsm, t, 3500, 90.0);
            fsm.update(t, Some(20.0), 0.95);
            t += 33;
        }
        assert_eq!(fsm.rep_count(), 3);
    }

    #[test]
    fn missing_reading_freezes_phase() {
        let mut fsm = RepFsm::new(cfg());
        let mut t = drive(&mut fsm, 0, 500, 20.0);
        t = drive(&mut fsm, t, 500, 90.0);
        assert_eq!(fsm.phase(), MovementPhase::Holding);
        fsm.update(t, None, 0.0);
        assert_eq!(fsm.phase(), MovementPhase::Holding, "no-reading frame must not invent motion");
        assert_eq!(fsm.rep_count(), 0);
    }

    #[test]
    fn low_confidence_frames_are_ignored() {
        let mut fsm = RepFsm::new(cfg());
        fsm.update(0, Some(90.0), 0.10);
        assert_eq!(fsm.phase(), MovementPhase::Idle);
    }

    #[test]
    fn form_score_is_maximal_inside_band_with_full_confidence() {
        let mut fsm = RepFsm::new(cfg());
        fsm.update(0, Some(90.0), 1.0);
        let metrics = fsm.update(33, Some(90.0), 1.0);
        assert!(metrics.instantaneous_form_score > 99.0, "{}", metrics.instantaneous_form_score);
        assert!(metrics.in_target_band);
    }

    #[test]
    fn form_score_degrades_far_from_target() {
        let mut fsm = RepFsm::new(cfg());
        fsm.update(0, Some(90.0), 1.0);
        let far = fsm.update(33, Some(170.0), 1.0);
        assert!(far.instantaneous_form_score < 60.0, "{}", far.instantaneous_form_score);
        assert!(!far.in_target_band);
    }

    #[test]
    fn form_score_always_within_bounds() {
        let mut fsm = RepFsm::new(cfg());
        for (i, angle) in [0.0f32, 45.0, 90.0, 179.0, 12.0].iter().enumerate() {
            let m = fsm.update(i as i64 * 33, Some(*angle), 0.7);
            assert!(
                (0.0..=100.0).contains(&m.instantaneous_form_score),
                "score {} out of range",
                m.instantaneous_form_score
            );
        }
    }

    #[test]
    fn reset_motion_keeps_completed_reps() {
        let mut fsm = RepFsm::new(cfg());
        let mut t = drive(&mut fsm, 0, 500, 20.0);
        t = drive(&mut fsm, t, 1000, 90.0);
        t = drive(&mut fsm, t, 3500, 90.0);
        fsm.update(t, Some(20.0), 0.95);
        assert_eq!(fsm.rep_count(), 1);

        fsm.reset_motion();
        assert_eq!(fsm.phase(), MovementPhase::Idle);
        assert_eq!(fsm.rep_count(), 1, "completed reps survive a pose switch");
    }

    #[test]
    fn phase_serializes_to_typescript_contract() {
        let json = serde_json::to_string(&MovementPhase::StartPosition).unwrap();
        assert_eq!(json, "\"start_position\"");
        let json = serde_json::to_string(&MovementPhase::RepCompleted).unwrap();
        assert_eq!(json, "\"rep_completed\"");
    }
}
