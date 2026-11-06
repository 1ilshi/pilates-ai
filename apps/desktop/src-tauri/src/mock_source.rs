//! Hardware-free frame + detection source.
//!
//! CI runners have no webcam and no ONNX Runtime, so the capture pipeline
//! cannot be exercised through its real inputs there. This module produces a
//! deterministic synthetic sequence — frames plus detections — that drives
//! [`crate::session::CaptureSession`] through complete repetitions.
//!
//! The geometry is exact rather than approximate: keypoints are placed so that
//! `calculate_joint_angle(hip, knee, ankle)` equals the intended angle, which
//! lets tests assert on real FSM behaviour instead of on mocked metrics.

use glam::Vec2;

use crate::camera::Frame;
use crate::inference::{Detection, ExecutionProviderKind, InferenceOutput, Keypoint};

/// One second of capture at the target cadence.
pub const FPS: usize = 30;

/// A scripted angle profile, in seconds.
#[derive(Debug, Clone, Copy)]
pub struct RepProfile {
    /// Angle held before the movement starts.
    pub rest_angle: f32,
    /// Angle at the top of the repetition (inside the target band).
    pub peak_angle: f32,
    /// Time spent moving from rest to peak.
    pub ramp_sec: f32,
    /// Time held at the peak; must exceed the pose's minimum hold.
    pub hold_sec: f32,
    /// Time spent returning to rest.
    pub return_sec: f32,
}

impl Default for RepProfile {
    fn default() -> Self {
        Self {
            rest_angle: 20.0,
            peak_angle: 90.0,
            ramp_sec: 1.0,
            hold_sec: 4.0,
            return_sec: 1.0,
        }
    }
}

impl RepProfile {
    /// Total duration of one repetition, in seconds.
    pub fn duration_sec(&self) -> f32 {
        self.ramp_sec + self.hold_sec + self.return_sec
    }

    /// Angle at a given time within one repetition.
    pub fn angle_at(&self, elapsed: f32) -> f32 {
        let ramp_end = self.ramp_sec;
        let hold_end = ramp_end + self.hold_sec;
        let return_end = hold_end + self.return_sec;

        if elapsed < ramp_end {
            lerp(self.rest_angle, self.peak_angle, elapsed / ramp_end.max(f32::EPSILON))
        } else if elapsed < hold_end {
            self.peak_angle
        } else if elapsed < return_end {
            let progress = (elapsed - hold_end) / self.return_sec.max(f32::EPSILON);
            lerp(self.peak_angle, self.rest_angle, progress)
        } else {
            self.rest_angle
        }
    }
}

fn lerp(from: f32, to: f32, progress: f32) -> f32 {
    from + (to - from) * progress.clamp(0.0, 1.0)
}

/// Keypoints for a knee at `angle`, arranged so the measured angle matches.
///
/// `pose1` uses indices hip = 0, knee = 1, ankle = 2.
pub fn knee_keypoints(angle_deg: f32) -> Vec<Keypoint> {
    let knee = Vec2::new(0.5, 0.5);
    let hip = Vec2::new(0.5, 0.3);
    let thigh = hip - knee;

    let radians = angle_deg.to_radians();
    let rotated = Vec2::new(
        thigh.x * radians.cos() - thigh.y * radians.sin(),
        thigh.x * radians.sin() + thigh.y * radians.cos(),
    );
    let ankle = knee + rotated;

    vec![
        Keypoint { id: 0, x: hip.x, y: hip.y, confidence: 0.95 },
        Keypoint { id: 1, x: knee.x, y: knee.y, confidence: 0.95 },
        Keypoint { id: 2, x: ankle.x, y: ankle.y, confidence: 0.95 },
    ]
}

/// Deterministic replacement for a camera plus a pose model.
pub struct MockPipeline {
    profile: RepProfile,
    total_frames: usize,
    cursor: usize,
}

impl MockPipeline {
    /// Build a sequence long enough to cover `reps` repetitions.
    pub fn new(reps: usize, profile: RepProfile) -> Self {
        let frames_per_rep = (profile.duration_sec() * FPS as f32).ceil() as usize;
        Self {
            profile,
            total_frames: frames_per_rep.max(1) * reps.max(1),
            cursor: 0,
        }
    }

    pub fn total_frames(&self) -> usize {
        self.total_frames
    }

    /// Produce the next `(frame, inference output)` pair, or `None` when done.
    pub fn next_frame(&mut self) -> Option<(Frame, InferenceOutput)> {
        if self.cursor >= self.total_frames {
            return None;
        }

        let elapsed = self.cursor as f32 / FPS as f32;
        let within_rep = elapsed % self.profile.duration_sec().max(f32::EPSILON);
        let angle = self.profile.angle_at(within_rep);

        let frame = Frame {
            width: 640,
            height: 480,
            // A cheap gradient is enough: inference is bypassed, so the pixels
            // only need to satisfy the frame contract.
            rgb: gradient_frame_bytes(self.cursor),
            captured_at_ms: (self.cursor as i64) * (1000 / FPS as i64),
            sequence: self.cursor as u64 + 1,
        };

        // The models are two-class classifiers, and a repetition is a
        // `start` → `end` transition. Emit `start` at the resting position and
        // `end` at the peak, with nothing in between — exactly what a working
        // model would report for this movement.
        let label = if angle >= self.profile.peak_angle - 5.0 {
            Some("end")
        } else if angle <= self.profile.rest_angle + 5.0 {
            Some("start")
        } else {
            None
        };

        let detections = match label {
            Some(label) => vec![Detection {
                bbox: [0.4, 0.25, 0.6, 0.75],
                class_id: if label == "end" { 0 } else { 1 },
                class_confidence: 0.9,
                label: label.to_string(),
                keypoints: knee_keypoints(angle),
            }],
            None => Vec::new(),
        };

        self.cursor += 1;

        Some((
            frame,
            InferenceOutput {
                detections,
                inference_ms: 0.0,
                provider: ExecutionProviderKind::Cpu,
            best_class_id: -1,
            best_class_score: 0.0,
            best_class_label: String::new(),
            },
        ))
    }
}

fn gradient_frame_bytes(seed: usize) -> Vec<u8> {
    let mut rgb = vec![0u8; 640 * 480 * 3];
    let shift = (seed % 256) as u8;
    for (index, pixel) in rgb.chunks_mut(3).enumerate() {
        let value = ((index + seed) % 256) as u8;
        pixel[0] = value;
        pixel[1] = value.wrapping_add(shift);
        pixel[2] = 255u8.saturating_sub(value);
    }
    rgb
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::biomechanics::calculate_joint_angle;

    #[test]
    fn keypoints_encode_the_requested_angle() {
        for expected in [0.0f32, 20.0, 45.0, 90.0, 135.0, 180.0] {
            let points = knee_keypoints(expected);
            let hip = Vec2::new(points[0].x, points[0].y);
            let knee = Vec2::new(points[1].x, points[1].y);
            let ankle = Vec2::new(points[2].x, points[2].y);
            let measured = calculate_joint_angle(hip, knee, ankle);
            assert!(
                (measured - expected).abs() < 0.5,
                "expected {expected}, measured {measured}"
            );
        }
    }

    #[test]
    fn profile_ramps_holds_and_returns() {
        let profile = RepProfile::default();
        assert!((profile.angle_at(0.0) - 20.0).abs() < 0.01);
        assert!((profile.angle_at(0.5) - 55.0).abs() < 1.0, "mid-ramp");
        assert!((profile.angle_at(3.0) - 90.0).abs() < 0.01, "holding");
        assert!((profile.angle_at(5.5) - 55.0).abs() < 1.0, "returning");
        assert!((profile.angle_at(6.5) - 20.0).abs() < 0.01, "rest again");
    }

    #[test]
    fn sequence_length_matches_requested_repetitions() {
        let profile = RepProfile::default();
        let pipeline = MockPipeline::new(2, profile);
        assert_eq!(pipeline.total_frames(), (profile.duration_sec() * 30.0) as usize * 2);
    }

    #[test]
    fn sequence_terminates() {
        let mut pipeline = MockPipeline::new(1, RepProfile::default());
        let mut frames = 0;
        while pipeline.next_frame().is_some() {
            frames += 1;
            assert!(frames < 10_000, "sequence must terminate");
        }
        assert_eq!(frames, pipeline.total_frames());
    }

    #[test]
    fn frames_are_deterministic() {
        let mut a = MockPipeline::new(1, RepProfile::default());
        let mut b = MockPipeline::new(1, RepProfile::default());
        let (frame_a, out_a) = a.next_frame().expect("frame");
        let (frame_b, out_b) = b.next_frame().expect("frame");
        assert_eq!(frame_a.rgb, frame_b.rgb);
        assert_eq!(frame_a.captured_at_ms, frame_b.captured_at_ms);
        assert_eq!(out_a.detections.len(), out_b.detections.len());
        if let (Some(left), Some(right)) = (out_a.detections.first(), out_b.detections.first()) {
            assert_eq!(left.keypoints[0].x, right.keypoints[0].x);
        }
    }

    #[test]
    fn detections_only_appear_while_holding() {
        let mut pipeline = MockPipeline::new(1, RepProfile::default());
        let mut with_detection = 0;
        let mut without = 0;
        while let Some((_, output)) = pipeline.next_frame() {
            if output.detections.is_empty() {
                without += 1;
            } else {
                with_detection += 1;
            }
        }
        assert!(with_detection > 0, "the hold phase must produce detections");
        assert!(
            without > 0,
            "ramp and return phases must not, or one long episode would never close"
        );
    }
}
