//! Repetition counting from the models' two classes.
//!
//! Across all five pose models the class named **`end`** is the exercise
//! itself — the position the patient is asked to hold — and **`start`** is the
//! neutral position they return to between repetitions.
//!
//! So a repetition is a *hold of `end`*, not the travel from `start` to `end`:
//!
//! ```text
//!   IDLE ──confirmed 'end'──▶ HOLDING ──confirmed 'start'──▶ count if long enough
//!                               │
//!                               ├── detection gap > grace ──▶ close
//!                               └── longer than max_hold ──▶ close
//! ```
//!
//! This makes the recorded duration the **time spent holding the pose**, which
//! is what a therapist measures, rather than the time taken to move into it.

use serde::{Deserialize, Serialize};

/// Which class a detection belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Class {
    Start,
    End,
    Other,
}

/// Tuning for one pose.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectionRepConfig {
    /// Class for the neutral position between repetitions.
    pub start_class: String,
    /// Class for the exercise itself — the position being held.
    pub end_class: String,
    /// Detections below this confidence are ignored entirely.
    pub min_confidence: f32,
    /// Consecutive frames required before a class is believed.
    pub confirm_frames: u32,
    /// A hold shorter than this is treated as a misdetection.
    pub min_hold_sec: f32,
    /// Safety cap: a hold longer than this is closed, so a stuck detection
    /// cannot run forever.
    pub max_hold_sec: f32,
    /// How long the pose may go undetected before the hold is considered over.
    pub grace_sec: f32,
}

impl Default for DetectionRepConfig {
    fn default() -> Self {
        Self {
            start_class: "start".to_string(),
            end_class: "end".to_string(),
            min_confidence: 0.25,
            confirm_frames: 3,
            min_hold_sec: 2.5,
            max_hold_sec: 60.0,
            grace_sec: 0.6,
        }
    }
}

impl DetectionRepConfig {
    fn classify(&self, label: &str, confidence: f32) -> Class {
        if !confidence.is_finite() || confidence < self.min_confidence {
            return Class::Other;
        }
        let label = label.to_lowercase();
        if label.is_empty() {
            return Class::Other;
        }
        // The action class is tested first: "end left" contains the start
        // substring in principle, and the action is the more specific match.
        if label.contains(&self.end_class.to_lowercase()) {
            return Class::End;
        }
        if label.contains(&self.start_class.to_lowercase()) {
            return Class::Start;
        }
        Class::Other
    }

    fn confirm_frames(&self) -> u32 {
        self.confirm_frames.max(1)
    }
}

/// One counted (or rejected) repetition.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectionRep {
    pub rep_index: u32,
    pub started_at_ms: i64,
    pub completed_at_ms: i64,
    /// Time spent holding the exercise position, in seconds.
    pub duration_sec: f32,
    pub peak_confidence: f32,
    pub mean_confidence: f32,
    /// Mean composite score observed during the hold (0-100).
    pub form_score: f32,
    /// Peak joint angle observed, if angles were available.
    pub peak_rom_angle: f32,
    /// Variance of detection confidence; lower means steadier.
    pub stability_variance: f32,
    /// False when the hold was too short to be a real repetition.
    pub counted: bool,
}

/// Debounce state for one class.
#[derive(Debug, Clone)]
struct Run {
    class: Class,
    frames: u32,
}

/// A hold currently in progress.
#[derive(Debug, Clone)]
struct Hold {
    started_at_ms: i64,
    last_seen_ms: i64,
    peak_confidence: f32,
    confidence_sum: f32,
    confidence_sq_sum: f32,
    samples: u32,
    score_sum: f32,
    score_samples: u32,
    peak_angle: f32,
}

impl Hold {
    fn new(timestamp_ms: i64) -> Self {
        Self {
            started_at_ms: timestamp_ms,
            last_seen_ms: timestamp_ms,
            peak_confidence: 0.0,
            confidence_sum: 0.0,
            confidence_sq_sum: 0.0,
            samples: 0,
            score_sum: 0.0,
            score_samples: 0,
            peak_angle: 0.0,
        }
    }

    fn observe(&mut self, timestamp_ms: i64, confidence: f32, score: f32, angle: f32) {
        self.last_seen_ms = timestamp_ms;
        self.peak_confidence = self.peak_confidence.max(confidence);
        self.confidence_sum += confidence;
        self.confidence_sq_sum += confidence * confidence;
        self.samples += 1;
        if score.is_finite() {
            self.score_sum += score;
            self.score_samples += 1;
        }
        if angle.is_finite() {
            self.peak_angle = self.peak_angle.max(angle);
        }
    }

    fn duration_sec(&self) -> f32 {
        ((self.last_seen_ms - self.started_at_ms) as f32 / 1000.0).max(0.0)
    }

    fn mean_confidence(&self) -> f32 {
        if self.samples == 0 {
            0.0
        } else {
            self.confidence_sum / self.samples as f32
        }
    }

    fn variance(&self) -> f32 {
        if self.samples < 2 {
            return 0.0;
        }
        let n = self.samples as f32;
        let mean = self.confidence_sum / n;
        ((self.confidence_sq_sum / n) - mean * mean).max(0.0)
    }

    fn mean_score(&self) -> f32 {
        if self.score_samples == 0 {
            0.0
        } else {
            self.score_sum / self.score_samples as f32
        }
    }
}

/// Counts repetitions as holds of the exercise class.
#[derive(Debug, Clone)]
pub struct DetectionRepTracker {
    config: DetectionRepConfig,
    run: Option<Run>,
    hold: Option<Hold>,
    counted: Vec<DetectionRep>,
    rejected: Vec<DetectionRep>,
    attempts: u32,
}

impl DetectionRepTracker {
    pub fn new(config: DetectionRepConfig) -> Self {
        Self {
            config,
            run: None,
            hold: None,
            counted: Vec::new(),
            rejected: Vec::new(),
            attempts: 0,
        }
    }

    pub fn config(&self) -> &DetectionRepConfig {
        &self.config
    }

    pub fn counted(&self) -> &[DetectionRep] {
        &self.counted
    }

    pub fn rejected(&self) -> &[DetectionRep] {
        &self.rejected
    }

    pub fn rep_count(&self) -> u32 {
        self.counted.len() as u32
    }

    pub fn attempts(&self) -> u32 {
        self.attempts
    }

    /// True while the exercise position is being held.
    pub fn is_holding(&self) -> bool {
        self.hold.is_some()
    }

    /// Time the current hold has lasted, in seconds.
    pub fn active_duration_sec(&self, timestamp_ms: i64) -> f32 {
        self.hold
            .as_ref()
            .map(|hold| {
                ((timestamp_ms.max(hold.last_seen_ms) - hold.started_at_ms) as f32 / 1000.0)
                    .max(0.0)
            })
            .unwrap_or(0.0)
    }

    /// Feed one frame. `label` is `None` when nothing was detected.
    pub fn update(
        &mut self,
        timestamp_ms: i64,
        label: Option<&str>,
        confidence: f32,
        frame_score: f32,
        angle: f32,
    ) -> Option<DetectionRep> {
        // Close a hold that has gone quiet before anything else.
        if let Some(hold) = &self.hold {
            let gap = (timestamp_ms - hold.last_seen_ms) as f32 / 1000.0;
            if gap > self.config.grace_sec {
                return self.close_hold();
            }
        }

        let observed = label
            .map(|label| self.config.classify(label, confidence))
            .unwrap_or(Class::Other);

        // Level-triggered: once a class is confirmed, every subsequent frame of
        // that class reports it, so a hold keeps extending for its duration.
        let confirmed = match self.run.as_mut() {
            Some(run) if run.class == observed => {
                run.frames += 1;
                if run.frames >= self.config.confirm_frames() {
                    Some(observed)
                } else {
                    None
                }
            }
            _ => {
                self.run = Some(Run {
                    class: observed,
                    frames: 1,
                });
                if self.config.confirm_frames() <= 1 && observed != Class::Other {
                    Some(observed)
                } else {
                    None
                }
            }
        };

        let confidence = confidence.clamp(0.0, 1.0);

        match confirmed? {
            Class::End => {
                // Holding the exercise position: start or extend the hold.
                match self.hold.as_mut() {
                    Some(hold) => hold.observe(timestamp_ms, confidence, frame_score, angle),
                    None => {
                        let mut hold = Hold::new(timestamp_ms);
                        hold.observe(timestamp_ms, confidence, frame_score, angle);
                        self.hold = Some(hold);
                        self.attempts += 1;
                    }
                }
                None
            }
            Class::Start => {
                // Returning to neutral ends the repetition.
                self.close_hold()
            }
            Class::Other => None,
        }
    }

    /// Close the hold still in progress (session stopped mid-hold).
    pub fn finish(&mut self) -> Option<DetectionRep> {
        self.close_hold()
    }

    fn close_hold(&mut self) -> Option<DetectionRep> {
        let hold = self.hold.take()?;
        self.run = None;

        // A stuck detection cannot inflate the recorded hold beyond the cap,
        // but the hold itself stays open until the patient returns to neutral
        // or the pose is lost — capping must not fabricate extra repetitions.
        let duration = hold.duration_sec().min(self.config.max_hold_sec);
        let counted = duration >= self.config.min_hold_sec;

        let rep = DetectionRep {
            rep_index: if counted {
                self.counted.len() as u32 + 1
            } else {
                self.rejected.len() as u32 + 1
            },
            started_at_ms: hold.started_at_ms,
            completed_at_ms: hold.last_seen_ms,
            duration_sec: duration,
            peak_confidence: hold.peak_confidence,
            mean_confidence: hold.mean_confidence(),
            form_score: hold.mean_score(),
            peak_rom_angle: hold.peak_angle,
            stability_variance: hold.variance(),
            counted,
        };

        if counted {
            self.counted.push(rep.clone());
        } else {
            self.rejected.push(rep.clone());
        }
        Some(rep)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tracker() -> DetectionRepTracker {
        DetectionRepTracker::new(DetectionRepConfig {
            confirm_frames: 1,
            min_hold_sec: 2.5,
            max_hold_sec: 60.0,
            grace_sec: 0.6,
            ..DetectionRepConfig::default()
        })
    }

    /// Feed `frames` samples at 30 Hz, returning the next timestamp.
    fn feed(
        t: &mut DetectionRepTracker,
        start_ms: i64,
        class: Option<&str>,
        frames: usize,
        conf: f32,
    ) -> i64 {
        let mut now = start_ms;
        for _ in 0..frames {
            t.update(now, class, conf, 90.0, 90.0);
            now += 33;
        }
        now
    }

    #[test]
    fn holding_the_action_pose_counts_a_rep() {
        let mut t = tracker();
        let now = feed(&mut t, 0, Some("end"), 100, 0.9); // ~3.3 s hold
        assert_eq!(t.rep_count(), 0, "still holding");
        t.update(now, Some("start"), 0.9, 90.0, 90.0); // return to neutral
        assert_eq!(t.rep_count(), 1);
        assert!(t.counted()[0].duration_sec >= 3.0);
    }

    #[test]
    fn a_short_hold_is_rejected() {
        let mut t = tracker();
        let now = feed(&mut t, 0, Some("end"), 30, 0.9); // ~1 s
        t.update(now, Some("start"), 0.9, 90.0, 90.0);
        assert_eq!(t.rep_count(), 0);
        assert_eq!(t.rejected().len(), 1);
    }

    #[test]
    fn a_start_without_a_hold_is_not_a_rep() {
        let mut t = tracker();
        feed(&mut t, 0, Some("start"), 60, 0.9);
        assert_eq!(t.rep_count(), 0);
        assert_eq!(t.attempts(), 0);
    }

    #[test]
    fn two_holds_separated_by_neutral_count_twice() {
        let mut t = tracker();
        let mut now = feed(&mut t, 0, Some("end"), 100, 0.9);
        now = feed(&mut t, now, Some("start"), 10, 0.9);
        now = feed(&mut t, now, Some("end"), 100, 0.9);
        t.update(now, Some("start"), 0.9, 90.0, 90.0);
        assert_eq!(t.rep_count(), 2);
    }

    #[test]
    fn a_single_dropped_frame_does_not_split_a_hold() {
        let mut t = tracker();
        let mut now = feed(&mut t, 0, Some("end"), 50, 0.9);
        now = feed(&mut t, now, None, 1, 0.0); // 33 ms gap
        now = feed(&mut t, now, Some("end"), 50, 0.9);
        t.update(now, Some("start"), 0.9, 90.0, 90.0);
        assert_eq!(t.rep_count(), 1, "the gap is inside the grace window");
    }

    #[test]
    fn a_long_dropout_closes_the_hold() {
        let mut t = tracker();
        let now = feed(&mut t, 0, Some("end"), 100, 0.9);
        // One second of nothing exceeds the 0.6 s grace.
        t.update(now + 1000, None, 0.0, 0.0, f32::NAN);
        assert_eq!(t.rep_count(), 1, "a closed hold still counts");
        assert!(!t.is_holding());
    }

    #[test]
    fn a_runaway_hold_is_capped_but_not_split() {
        let mut t = DetectionRepTracker::new(DetectionRepConfig {
            confirm_frames: 1,
            min_hold_sec: 0.5,
            max_hold_sec: 2.0,
            grace_sec: 5.0,
            ..DetectionRepConfig::default()
        });
        let mut now = feed(&mut t, 0, Some("end"), 150, 0.9); // ~5 s, past the cap
        assert!(t.is_holding(), "the cap must not close the hold");
        assert_eq!(t.rep_count(), 0, "capping must not fabricate repetitions");
        now = feed(&mut t, now, Some("start"), 2, 0.9);
        assert_eq!(t.rep_count(), 1);
        assert!(
            (t.counted()[0].duration_sec - 2.0).abs() < 0.01,
            "recorded hold is capped at max_hold_sec"
        );
        let _ = now;
    }

    #[test]
    fn low_confidence_never_opens_a_hold() {
        let mut t = tracker();
        feed(&mut t, 0, Some("end"), 100, 0.10);
        assert_eq!(t.attempts(), 0);
    }

    #[test]
    fn class_matching_handles_side_specific_labels() {
        let config = DetectionRepConfig::default();
        assert_eq!(config.classify("end", 0.9), Class::End);
        assert_eq!(config.classify("end left", 0.9), Class::End);
        assert_eq!(config.classify("end right", 0.9), Class::End);
        assert_eq!(config.classify("start", 0.9), Class::Start);
        assert_eq!(config.classify("Start", 0.9), Class::Start);
        assert_eq!(config.classify("end", 0.01), Class::Other);
    }

    #[test]
    fn finish_counts_a_hold_in_progress() {
        let mut t = tracker();
        feed(&mut t, 0, Some("end"), 100, 0.9);
        let rep = t.finish().expect("hold closed");
        assert!(rep.counted, "a long enough hold counts when the session ends");
        assert_eq!(t.rep_count(), 1);
    }

    #[test]
    fn rep_records_hold_statistics() {
        let mut t = tracker();
        let now = feed(&mut t, 0, Some("end"), 100, 0.8);
        t.update(now, Some("start"), 0.9, 90.0, 90.0);
        let rep = &t.counted()[0];
        assert!((rep.mean_confidence - 0.8).abs() < 0.01);
        assert!((rep.form_score - 90.0).abs() < 0.01);
        assert!(rep.stability_variance < 1e-6);
    }
}
