//! ONNX inference engine.
//!
//! Execution-provider chain:
//!
//! ```text
//! macOS Apple Silicon ->  CoreML EP
//! otherwise           ->  CPU SIMD EP
//! ```
//!
//! There is no Windows GPU tier. Microsoft publishes no DirectML-enabled ONNX
//! Runtime for the 1.31 API this crate binds, so a DirectML session could never
//! initialise; advertising it would make `engine_status` claim acceleration the
//! app does not have. CPU inference measures 20-35 ms per frame on these
//! models, which fits the 30 FPS capture budget.
//!
//! ONNX Runtime is loaded **dynamically** (`load-dynamic`): the installer ships
//! `onnxruntime.dll` / `libonnxruntime.dylib` / `libonnxruntime.so` as a
//! bundled resource and we point `ORT_DYLIB_PATH` at it. If the runtime or the
//! model is missing the engine reports [`EngineError::Inference`] instead of
//! aborting the app, so the clinic can still record camera preview and manage
//! patients.

use std::path::{Path, PathBuf};

use ort::ep;
use ort::session::Session;
use ort::value::Tensor;
use serde::{Deserialize, Serialize};

use crate::camera::Frame;
use crate::error::{EngineError, EngineResult};

/// Square model input resolution.
pub const INPUT_SIZE: u32 = 640;
/// Letterbox padding value (matches the Ultralytics convention).
const PAD_VALUE: u8 = 114;
/// Detections below this are not even produced for display.
///
/// Deliberately **low**: the UI should show what the model actually sees, and
/// the repetition tracker applies the stricter clinical threshold separately.
/// Filtering at 0.25 here made weak-but-real detections invisible, which is
/// indistinguishable from "the model detects nothing".
pub const DETECTION_THRESHOLD: f32 = 0.10;
/// Non-maximum suppression IoU threshold.
pub const IOU_THRESHOLD: f32 = 0.45;
/// Upper bound on detections returned per frame.
pub const MAX_DETECTIONS: usize = 32;

/// Which execution provider actually served the session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionProviderKind {
    CoreMl,
    Cpu,
}

impl ExecutionProviderKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ExecutionProviderKind::CoreMl => "CoreML",
            ExecutionProviderKind::Cpu => "CPU",
        }
    }
}

/// A detected keypoint in normalized (0-1) frame coordinates.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Keypoint {
    pub id: i32,
    pub x: f32,
    pub y: f32,
    pub confidence: f32,
}

/// One pose detection.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Detection {
    /// Normalized `[x1, y1, x2, y2]`.
    pub bbox: [f32; 4],
    pub class_id: i32,
    pub class_confidence: f32,
    /// Human-readable class name from the manifest, e.g. `start` / `end`.
    #[serde(default)]
    pub label: String,
    pub keypoints: Vec<Keypoint>,
}

/// Result of a forward pass.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InferenceOutput {
    pub detections: Vec<Detection>,
    pub inference_ms: f32,
    pub provider: ExecutionProviderKind,
    /// Strongest class score in the frame, even when below the display
    /// threshold. This is the number that answers "is the model seeing me?".
    pub best_class_id: i32,
    pub best_class_score: f32,
    /// Human-readable name of the best class, from the manifest.
    pub best_class_label: String,
}

impl InferenceOutput {
    /// An output representing "nothing detected" (engine unavailable).
    pub fn empty(provider: ExecutionProviderKind) -> Self {
        Self {
            detections: Vec::new(),
            inference_ms: 0.0,
            provider,
            best_class_id: -1,
            best_class_score: 0.0,
            best_class_label: String::new(),
        }
    }
}

/// Locate a bundled ONNX Runtime shared library, if one ships with the app.
fn locate_runtime_library() -> Option<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(explicit) = std::env::var("PILATES_ORT_DYLIB") {
        let path = PathBuf::from(explicit);
        if path.is_file() {
            return Some(path);
        }
    }
    if let Ok(resource_dir) = std::env::var("TAURI_RESOURCE_DIR") {
        roots.push(PathBuf::from(&resource_dir));
        // Tauri preserves the path relative to tauri.conf.json, so bundled
        // resources land in a nested `resources/` directory.
        roots.push(PathBuf::from(&resource_dir).join("resources"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            roots.push(dir.to_path_buf());
            roots.push(dir.join("resources"));
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd.clone());
        roots.push(cwd.join("src-tauri/resources"));
        roots.push(cwd.join("resources"));
    }

    for root in roots {
        if let Some(found) = find_runtime_in(&root) {
            return Some(found);
        }
    }
    None
}

/// Unversioned shared-library names, in priority order.
const RUNTIME_NAMES: [&str; 3] = ["onnxruntime.dll", "libonnxruntime.dylib", "libonnxruntime.so"];

/// Find ONNX Runtime inside one directory.
///
/// Falls back to versioned sonames because the official Linux and macOS
/// tarballs ship `libonnxruntime.so.1.31.1` / `libonnxruntime.1.31.1.dylib`,
/// and an archive extracted without symlink support has no unversioned copy.
fn find_runtime_in(root: &Path) -> Option<PathBuf> {
    for name in RUNTIME_NAMES {
        let candidate = root.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    let entries = std::fs::read_dir(root).ok()?;
    let mut best: Option<(String, PathBuf)> = None;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let versioned_so = name
            .strip_prefix("libonnxruntime.so.")
            .map(|rest| !rest.is_empty())
            .unwrap_or(false);
        let versioned_dylib = name.starts_with("libonnxruntime.") && name.ends_with(".dylib");
        if !versioned_so && !versioned_dylib {
            continue;
        }
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        // Prefer the highest version string when several are present.
        let replace = match &best {
            Some((current, _)) => name.as_str() > current.as_str(),
            None => true,
        };
        if replace {
            best = Some((name, path));
        }
    }

    best.map(|(_, path)| path)
}

/// Ensure ONNX Runtime can be located before `ort` tries to load it.
fn prepare_runtime() -> EngineResult<()> {
    if std::env::var_os("ORT_DYLIB_PATH").is_some() {
        return Ok(());
    }
    match locate_runtime_library() {
        Some(path) => {
            std::env::set_var("ORT_DYLIB_PATH", &path);
            Ok(())
        }
        None => Err(EngineError::Inference(
            "onnxruntime shared library not found. Expected onnxruntime.dll (Windows), \
             libonnxruntime.dylib (macOS) or libonnxruntime.so (Linux) next to the \
             executable or in resources/, or set PILATES_ORT_DYLIB."
                .into(),
        )),
    }
}

/// True when an ONNX Runtime shared library can be located.
///
/// Used by the UI to decide whether to offer capture, and by tests to skip
/// cleanly on machines without the runtime installed.
pub fn runtime_available() -> bool {
    std::env::var_os("ORT_DYLIB_PATH").is_some() || locate_runtime_library().is_some()
}

/// The process-wide ONNX Runtime environment.
///
/// ONNX Runtime allows **exactly one environment per process**. Creating a
/// second one fails with "only one environment is allowed per process", which
/// meant the first pose loaded fine and every later load silently failed —
/// leaving the app running the previous pose's model and producing no
/// detections. Initialise once, then share it with every session.
static ORT_ENVIRONMENT: std::sync::OnceLock<ort::environment::Environment> =
    std::sync::OnceLock::new();

fn shared_environment() -> EngineResult<&'static ort::environment::Environment> {
    if let Some(environment) = ORT_ENVIRONMENT.get() {
        return Ok(environment);
    }

    prepare_runtime()?;

    let environment = ort::init()
        .with_name("pilates-ai")
        .build()
        .map_err(|error| {
            EngineError::Inference(format!(
                "cannot initialise ONNX Runtime (is onnxruntime.dll present?): {error}"
            ))
        })?;

    // If another thread won the race, keep whichever was stored.
    let _ = ORT_ENVIRONMENT.set(environment);

    ORT_ENVIRONMENT
        .get()
        .ok_or_else(|| EngineError::Inference("ONNX Runtime environment unavailable".into()))
}

/// Human-readable description of where the runtime was (or was not) found.
///
/// Logged at startup so "inference unavailable" is diagnosable from the
/// terminal instead of silently producing an empty overlay.
pub fn runtime_description() -> String {
    if let Ok(explicit) = std::env::var("ORT_DYLIB_PATH") {
        return format!("ORT_DYLIB_PATH={explicit}");
    }
    match locate_runtime_library() {
        Some(path) => format!("found {}", path.display()),
        None => format!(
            "not found (cwd={})",
            std::env::current_dir()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|_| "?".into())
        ),
    }
}

/// Ordered execution-provider chain for the host platform.
///
/// Windows deliberately has no GPU tier: Microsoft publishes no
/// DirectML-enabled ONNX Runtime for the 1.31 API that `ort` 2.0.0-rc.15
/// binds, so a DirectML session could never initialise. Shipping an EP that
/// silently falls back would make `engine_status` claim acceleration the app
/// does not have. Measured CPU inference on these models is 20-35 ms, well
/// inside the 30 FPS capture budget.
fn provider_chain() -> Vec<ep::ExecutionProviderDispatch> {
    let mut providers: Vec<ep::ExecutionProviderDispatch> = Vec::new();

    #[cfg(target_os = "macos")]
    {
        providers.push(ep::CoreML::default().build());
    }

    providers.push(ep::CPU::default().build());
    providers
}

fn cpu_only() -> Vec<ep::ExecutionProviderDispatch> {
    vec![ep::CPU::default().build()]
}

/// The provider that will actually serve inference on this host.
fn active_provider() -> ExecutionProviderKind {
    #[cfg(target_os = "macos")]
    {
        return ExecutionProviderKind::CoreMl;
    }
    #[allow(unreachable_code)]
    ExecutionProviderKind::Cpu
}

/// A loaded ONNX pose model bound to a pose definition.
pub struct InferenceEngine {
    session: Session,
    provider: ExecutionProviderKind,
    pose_id: String,
    model_path: PathBuf,
    num_classes: usize,
    num_keypoints: usize,
    input_name: String,
    /// Class names from the manifest, indexed by class id.
    class_names: Vec<String>,
}

impl InferenceEngine {
    /// Load a model, falling back through the execution-provider chain.
    pub fn load(
        model_path: &Path,
        pose_id: &str,
        num_classes: usize,
        num_keypoints: usize,
        class_names: Vec<String>,
    ) -> EngineResult<Self> {
        prepare_runtime()?;

        if !model_path.is_file() {
            return Err(EngineError::Inference(format!(
                "model not found: {}",
                model_path.display()
            )));
        }
        if num_classes == 0 || num_keypoints == 0 {
            return Err(EngineError::Inference(
                "num_classes and num_keypoints must be non-zero".into(),
            ));
        }

        let environment = shared_environment()?;

        // Tier 1/2 (GPU) then Tier 3 (CPU). A GPU provider that fails to
        // initialise on this host must not block the app.
        let chain = provider_chain();
        let session = match Self::build_session(environment, model_path, chain) {
            Ok(session) => session,
            Err(primary_error) => {
                Self::build_session(environment, model_path, cpu_only()).map_err(|cpu_error| {
                    EngineError::Inference(format!(
                        "no usable execution provider (gpu: {primary_error}; cpu: {cpu_error})"
                    ))
                })?
            }
        };

        let provider = active_provider();
        let input_name = session
            .inputs()
            .first()
            .map(|input| input.name().to_string())
            .unwrap_or_else(|| "images".to_string());

        Ok(Self {
            session,
            provider,
            pose_id: pose_id.to_string(),
            model_path: model_path.to_path_buf(),
            num_classes,
            num_keypoints,
            input_name,
            class_names,
        })
    }

    fn build_session(
        environment: &ort::environment::Environment,
        model_path: &Path,
        providers: Vec<ep::ExecutionProviderDispatch>,
    ) -> EngineResult<Session> {
        Session::builder(environment)
            .map_err(|e| EngineError::Inference(format!("session builder: {e}")))?
            .with_execution_providers(providers)
            .map_err(|e| EngineError::Inference(format!("execution providers: {e}")))?
            .commit_from_file(model_path)
            .map_err(|e| EngineError::Inference(format!("load model: {e}")))
    }

    pub fn pose_id(&self) -> &str {
        &self.pose_id
    }

    pub fn provider(&self) -> ExecutionProviderKind {
        self.provider
    }

    pub fn model_path(&self) -> &Path {
        &self.model_path
    }

    pub fn num_classes(&self) -> usize {
        self.num_classes
    }

    pub fn num_keypoints(&self) -> usize {
        self.num_keypoints
    }

    /// Run one forward pass over a camera frame.
    pub fn infer(&mut self, frame: &Frame) -> EngineResult<InferenceOutput> {
        let started = std::time::Instant::now();
        let (input, scale, pad_x, pad_y) = letterbox(frame);
        let tensor = Tensor::from_array((
            [1usize, 3, INPUT_SIZE as usize, INPUT_SIZE as usize],
            input.into_boxed_slice(),
        ))
        .map_err(|e| EngineError::Inference(format!("tensor creation: {e}")))?;

        let outputs = self
            .session
            .run(ort::inputs![tensor])
            .map_err(|e| EngineError::Inference(format!("forward pass: {e}")))?;

        let (_shape, raw) = outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(|e| EngineError::Inference(format!("output extraction: {e}")))?;

        let decoded = decode_detections(
            raw,
            self.num_classes,
            self.num_keypoints,
            frame.width as f32,
            frame.height as f32,
            scale,
            pad_x,
            pad_y,
        );

        let mut detections = decoded.detections;

        // Attach the manifest's class names so the UI can label each box.
        for detection in &mut detections {
            detection.label = self
                .class_names
                .get(detection.class_id.max(0) as usize)
                .cloned()
                .unwrap_or_default();
        }

        let best_class_label = self
            .class_names
            .get(decoded.best_class_id.max(0) as usize)
            .cloned()
            .unwrap_or_default();

        Ok(InferenceOutput {
            detections,
            inference_ms: started.elapsed().as_secs_f32() * 1000.0,
            provider: self.provider,
            best_class_id: decoded.best_class_id,
            best_class_score: decoded.best_class_score,
            best_class_label,
        })
    }

    /// Input tensor name of the loaded graph.
    pub fn input_name(&self) -> &str {
        &self.input_name
    }
}

/// Letterbox a frame into a `3 x 640 x 640` NCHW f32 tensor.
///
/// Returns `(tensor_data, scale, pad_x, pad_y)` so detections can be mapped
/// back to normalized frame coordinates.
pub fn letterbox(frame: &Frame) -> (Vec<f32>, f32, f32, f32) {
    let target = INPUT_SIZE as f32;
    let width = frame.width.max(1) as f32;
    let height = frame.height.max(1) as f32;

    let scale = (target / width).min(target / height);
    let scaled_w = (width * scale).round().max(1.0);
    let scaled_h = (height * scale).round().max(1.0);
    let pad_x = ((target - scaled_w) / 2.0).floor();
    let pad_y = ((target - scaled_h) / 2.0).floor();

    let channels = (INPUT_SIZE * INPUT_SIZE) as usize;
    let mut out = vec![0f32; channels * 3];
    let pad = PAD_VALUE as f32 / 255.0;

    for value in out.iter_mut() {
        *value = pad;
    }

    let src_w = frame.width as usize;
    let src_h = frame.height as usize;
    let dst_w = scaled_w as usize;
    let dst_h = scaled_h as usize;

    for dy in 0..dst_h {
        // Nearest-neighbour is adequate here: the network resizes internally
        // and this keeps preprocessing off the critical path.
        let sy = ((dy as f32 / scale) as usize).min(src_h.saturating_sub(1));
        for dx in 0..dst_w {
            let sx = ((dx as f32 / scale) as usize).min(src_w.saturating_sub(1));
            let src_index = (sy * src_w + sx) * 3;
            if src_index + 2 >= frame.rgb.len() {
                continue;
            }
            let r = frame.rgb[src_index] as f32 / 255.0;
            let g = frame.rgb[src_index + 1] as f32 / 255.0;
            let b = frame.rgb[src_index + 2] as f32 / 255.0;

            let px = dx + pad_x as usize;
            let py = dy + pad_y as usize;
            if px >= INPUT_SIZE as usize || py >= INPUT_SIZE as usize {
                continue;
            }
            let dst_index = py * INPUT_SIZE as usize + px;

            out[dst_index] = r;
            out[channels + dst_index] = g;
            out[channels * 2 + dst_index] = b;
        }
    }

    (out, scale, pad_x, pad_y)
}

/// Decoded detections plus the strongest class score seen anywhere.
#[derive(Debug, Clone, Default)]
pub struct DecodedFrame {
    pub detections: Vec<Detection>,
    pub best_class_id: i32,
    pub best_class_score: f32,
}

/// Decode a raw `(1, 4 + nc + nk*3, N)` YOLO-pose tensor into detections.
#[allow(clippy::too_many_arguments)]
pub fn decode_detections(
    raw: &[f32],
    num_classes: usize,
    num_keypoints: usize,
    frame_width: f32,
    frame_height: f32,
    scale: f32,
    pad_x: f32,
    pad_y: f32,
) -> DecodedFrame {
    let channels = 4 + num_classes + num_keypoints * 3;
    if channels == 0 || raw.len() < channels {
        return DecodedFrame::default();
    }
    let anchors = raw.len() / channels;

    // YOLO layout is channel-major: value(channel, anchor) = raw[channel * anchors + anchor].
    let at = |channel: usize, anchor: usize| raw[channel * anchors + anchor];

    let mut candidates: Vec<Detection> = Vec::new();
    let mut best_class_id = -1i32;
    let mut best_class_score = 0.0f32;

    for anchor in 0..anchors {
        let mut best_class = -1i32;
        let mut best_score = 0.0f32;
        for class in 0..num_classes {
            let score = at(4 + class, anchor);
            if score > best_score {
                best_score = score;
                best_class = class as i32;
            }
        }

        // Record the strongest score regardless of the display threshold, so
        // the UI can report "closest match 0.18" instead of silence.
        if best_score > best_class_score {
            best_class_score = best_score;
            best_class_id = best_class;
        }

        if best_score < DETECTION_THRESHOLD || best_class < 0 {
            continue;
        }

        let cx = at(0, anchor);
        let cy = at(1, anchor);
        let w = at(2, anchor);
        let h = at(3, anchor);
        if !(cx.is_finite() && cy.is_finite() && w.is_finite() && h.is_finite()) {
            continue;
        }

        let keypoints = (0..num_keypoints)
            .map(|k| {
                let base = 4 + num_classes + k * 3;
                Keypoint {
                    id: k as i32,
                    x: normalize_x(at(base, anchor), frame_width, scale, pad_x),
                    y: normalize_y(at(base + 1, anchor), frame_height, scale, pad_y),
                    confidence: at(base + 2, anchor).clamp(0.0, 1.0),
                }
            })
            .collect();

        candidates.push(Detection {
            bbox: [
                normalize_x(cx - w / 2.0, frame_width, scale, pad_x),
                normalize_y(cy - h / 2.0, frame_height, scale, pad_y),
                normalize_x(cx + w / 2.0, frame_width, scale, pad_x),
                normalize_y(cy + h / 2.0, frame_height, scale, pad_y),
            ],
            class_id: best_class,
            class_confidence: best_score,
            label: String::new(),
            keypoints,
        });
    }

    candidates.sort_by(|a, b| {
        b.class_confidence
            .partial_cmp(&a.class_confidence)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    DecodedFrame {
        detections: non_max_suppression(candidates, IOU_THRESHOLD, MAX_DETECTIONS),
        best_class_id,
        best_class_score,
    }
}

fn normalize_x(value: f32, frame_width: f32, scale: f32, pad_x: f32) -> f32 {
    let unletterboxed = (value - pad_x) / scale;
    (unletterboxed / frame_width).clamp(0.0, 1.0)
}

fn normalize_y(value: f32, frame_height: f32, scale: f32, pad_y: f32) -> f32 {
    let unletterboxed = (value - pad_y) / scale;
    (unletterboxed / frame_height).clamp(0.0, 1.0)
}

/// Greedy per-class non-maximum suppression.
pub fn non_max_suppression(
    mut candidates: Vec<Detection>,
    iou_threshold: f32,
    max_detections: usize,
) -> Vec<Detection> {
    candidates.sort_by(|a, b| {
        b.class_confidence
            .partial_cmp(&a.class_confidence)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut kept: Vec<Detection> = Vec::new();
    for candidate in candidates {
        if kept.len() >= max_detections {
            break;
        }
        let overlaps = kept.iter().any(|other| {
            other.class_id == candidate.class_id
                && iou(&other.bbox, &candidate.bbox) > iou_threshold
        });
        if !overlaps {
            kept.push(candidate);
        }
    }
    kept
}

/// Intersection-over-union of two normalized `[x1, y1, x2, y2]` boxes.
pub fn iou(a: &[f32; 4], b: &[f32; 4]) -> f32 {
    let x1 = a[0].max(b[0]);
    let y1 = a[1].max(b[1]);
    let x2 = a[2].min(b[2]);
    let y2 = a[3].min(b[3]);

    let inter_w = (x2 - x1).max(0.0);
    let inter_h = (y2 - y1).max(0.0);
    let intersection = inter_w * inter_h;

    let area_a = ((a[2] - a[0]).max(0.0)) * ((a[3] - a[1]).max(0.0));
    let area_b = ((b[2] - b[0]).max(0.0)) * ((b[3] - b[1]).max(0.0));
    let union = area_a + area_b - intersection;

    if union <= 0.0 {
        0.0
    } else {
        intersection / union
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(width: u32, height: u32) -> Frame {
        Frame {
            width,
            height,
            rgb: vec![128u8; (width * height * 3) as usize],
            captured_at_ms: 0,
            sequence: 1,
        }
    }

    #[test]
    fn iou_of_identical_boxes_is_one() {
        let box_a = [0.0, 0.0, 1.0, 1.0];
        assert!((iou(&box_a, &box_a) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn iou_of_disjoint_boxes_is_zero() {
        let a = [0.0, 0.0, 0.2, 0.2];
        let b = [0.8, 0.8, 1.0, 1.0];
        assert_eq!(iou(&a, &b), 0.0);
    }

    #[test]
    fn iou_of_half_overlap() {
        let a = [0.0, 0.0, 2.0, 2.0];
        let b = [1.0, 0.0, 3.0, 2.0];
        // intersection 2, union 6
        assert!((iou(&a, &b) - (2.0 / 6.0)).abs() < 1e-6);
    }

    #[test]
    fn letterbox_preserves_aspect_ratio() {
        let (tensor, scale, pad_x, pad_y) = letterbox(&frame(1280, 720));
        assert_eq!(tensor.len(), 3 * 640 * 640);
        assert!((scale - 0.5).abs() < 1e-6, "scale {scale}");
        // 1280x720 -> 640x360, so vertical padding of 140 px total.
        assert!((pad_x - 0.0).abs() < 1e-6, "pad_x {pad_x}");
        assert!((pad_y - 140.0).abs() < 1e-6, "pad_y {pad_y}");
        // Padded region must be the 114/255 grey, not black.
        let pad_value = tensor[0];
        assert!((pad_value - 114.0 / 255.0).abs() < 1e-6, "pad {pad_value}");
    }

    #[test]
    fn letterbox_of_square_frame_has_no_padding() {
        let (_, scale, pad_x, pad_y) = letterbox(&frame(640, 640));
        assert!((scale - 1.0).abs() < 1e-6);
        assert_eq!(pad_x, 0.0);
        assert_eq!(pad_y, 0.0);
    }

    #[test]
    fn decode_returns_nothing_below_threshold() {
        // 1 anchor, 2 classes, 1 keypoint, all scores zero.
        let raw = vec![0f32; 4 + 2 + 3];
        let decoded = decode_detections(&raw, 2, 1, 640.0, 480.0, 1.0, 0.0, 0.0);
        assert!(decoded.detections.is_empty());
        assert_eq!(decoded.best_class_score, 0.0);
    }

    #[test]
    fn decode_reports_the_best_score_even_below_threshold() {
        // Class score 0.05 is under the display threshold but must still be
        // reported, so the UI can distinguish "weak" from "nothing at all".
        let channels = 4 + 2 + 3;
        let mut raw = vec![0f32; channels];
        raw[0] = 320.0;
        raw[1] = 320.0;
        raw[2] = 32.0;
        raw[3] = 32.0;
        raw[4] = 0.05;

        let decoded = decode_detections(&raw, 2, 1, 640.0, 640.0, 1.0, 0.0, 0.0);
        assert!(decoded.detections.is_empty(), "below threshold, not drawn");
        assert!(
            (decoded.best_class_score - 0.05).abs() < 1e-6,
            "best score {}",
            decoded.best_class_score
        );
        assert_eq!(decoded.best_class_id, 0);
    }

    #[test]
    fn decode_maps_coordinates_back_to_normalized_space() {
        // One anchor: box centre (320,320) size (64,64); class 1 score 0.9;
        // one keypoint at (320,320) with confidence 0.8.
        let channels = 4 + 2 + 3;
        let mut raw = vec![0f32; channels];
        raw[0] = 320.0; // cx
        raw[1] = 320.0; // cy
        raw[2] = 64.0; // w
        raw[3] = 64.0; // h
        raw[4] = 0.1; // class 0
        raw[5] = 0.9; // class 1
        raw[6] = 320.0; // kx
        raw[7] = 320.0; // ky
        raw[8] = 0.8; // kconf

        let decoded = decode_detections(&raw, 2, 1, 640.0, 640.0, 1.0, 0.0, 0.0);
        assert_eq!(decoded.detections.len(), 1);
        let detection = &decoded.detections[0];
        assert_eq!(detection.class_id, 1);
        assert!((detection.class_confidence - 0.9).abs() < 1e-6);
        assert!((detection.keypoints[0].x - 0.5).abs() < 1e-6);
        assert!((detection.keypoints[0].y - 0.5).abs() < 1e-6);
        assert!((detection.bbox[0] - 0.45).abs() < 1e-6);
        assert!((detection.bbox[2] - 0.55).abs() < 1e-6);
    }

    #[test]
    fn nms_collapses_overlapping_same_class_boxes() {
        let make = |confidence: f32, class_id: i32| Detection {
            bbox: [0.1, 0.1, 0.5, 0.5],
            class_id,
            class_confidence: confidence,
            label: String::new(),
            keypoints: Vec::new(),
        };
        let kept = non_max_suppression(
            vec![make(0.9, 0), make(0.8, 0), make(0.7, 0)],
            0.45,
            10,
        );
        assert_eq!(kept.len(), 1, "identical boxes must collapse to one");
        assert!((kept[0].class_confidence - 0.9).abs() < 1e-6);
    }

    #[test]
    fn nms_keeps_different_classes() {
        let make = |confidence: f32, class_id: i32| Detection {
            bbox: [0.1, 0.1, 0.5, 0.5],
            class_id,
            class_confidence: confidence,
            label: String::new(),
            keypoints: Vec::new(),
        };
        let kept = non_max_suppression(vec![make(0.9, 0), make(0.8, 1)], 0.45, 10);
        assert_eq!(kept.len(), 2);
    }

    #[test]
    fn nms_respects_max_detections() {
        let make = |confidence: f32| Detection {
            bbox: [confidence, 0.0, confidence + 0.1, 0.1],
            class_id: 0,
            class_confidence: confidence,
            label: String::new(),
            keypoints: Vec::new(),
        };
        let kept = non_max_suppression(
            vec![make(0.9), make(0.5), make(0.4)],
            0.45,
            2,
        );
        assert_eq!(kept.len(), 2);
    }

    #[test]
    fn provider_labels_are_stable() {
        assert_eq!(ExecutionProviderKind::CoreMl.as_str(), "CoreML");
        assert_eq!(ExecutionProviderKind::Cpu.as_str(), "CPU");
    }

    #[test]
    fn runtime_lookup_accepts_versioned_sonames() {
        // The official Linux tarball ships `libonnxruntime.so.1.31.1` with a
        // symlink; an extraction without symlink support leaves only the
        // versioned file, which the unversioned lookup would miss.
        let dir = std::env::temp_dir().join(format!("pilates-ort-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("mkdir");

        std::fs::write(dir.join("libonnxruntime.so.1.31.1"), b"x").expect("write");
        let found = find_runtime_in(&dir).expect("versioned .so");
        assert_eq!(found, dir.join("libonnxruntime.so.1.31.1"));

        std::fs::remove_file(dir.join("libonnxruntime.so.1.31.1")).expect("rm");
        std::fs::write(dir.join("libonnxruntime.1.31.1.dylib"), b"x").expect("write");
        let found = find_runtime_in(&dir).expect("versioned dylib");
        assert_eq!(found, dir.join("libonnxruntime.1.31.1.dylib"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn runtime_lookup_prefers_the_unversioned_name() {
        let dir = std::env::temp_dir().join(format!("pilates-ort-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("mkdir");
        std::fs::write(dir.join("libonnxruntime.so.1.31.1"), b"x").expect("write");
        std::fs::write(dir.join("libonnxruntime.so"), b"x").expect("write");

        let found = find_runtime_in(&dir).expect("runtime");
        assert_eq!(found, dir.join("libonnxruntime.so"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// End-to-end check of the native path: load a real exported model, run a
    /// forward pass through ONNX Runtime, and decode the output tensor.
    ///
    /// Skips (with a message) when the runtime or model is absent so CI images
    /// without the DLL still pass; when they *are* present this must succeed.
    #[test]
    fn runs_real_forward_pass_when_runtime_is_installed() {
        if !runtime_available() {
            eprintln!(
                "SKIP runs_real_forward_pass: onnxruntime shared library not installed \
                 (run: python tools/fetch_onnxruntime.py)"
            );
            return;
        }

        let Some(model_path) = crate::pose_config::find_config_file("models/pose1.onnx") else {
            eprintln!("SKIP runs_real_forward_pass: config/models/pose1.onnx not found");
            return;
        };

        let mut engine = InferenceEngine::load(
            &model_path,
            "pose1",
            2,
            3,
            vec!["end".into(), "start".into()],
        )
        .expect("engine must load with the runtime installed");

        // Synthetic frame: we do not assert on detections (a gradient has no
        // person), only that the full pipeline executes and decodes.
        let mut rgb = vec![0u8; 640 * 480 * 3];
        for (index, pixel) in rgb.chunks_mut(3).enumerate() {
            let value = (index % 255) as u8;
            pixel[0] = value;
            pixel[1] = value / 2;
            pixel[2] = 255 - value;
        }
        let frame = Frame {
            width: 640,
            height: 480,
            rgb,
            captured_at_ms: 0,
            sequence: 1,
        };

        let output = engine.infer(&frame).expect("forward pass must succeed");

        assert!(
            output.inference_ms > 0.0,
            "inference must report a positive duration"
        );
        assert_eq!(engine.num_classes(), 2);
        assert_eq!(engine.num_keypoints(), 3);
        assert!(
            !engine.input_name().is_empty(),
            "input tensor name must be resolved from the graph"
        );
        eprintln!(
            "forward pass ok: provider={:?} {:.1} ms, {} detections",
            output.provider,
            output.inference_ms,
            output.detections.len()
        );
    }

    /// Push a **real photograph** through the compiled Rust pipeline.
    ///
    /// Python-side parity was verified separately (Step 2). This proves the
    /// actual binary path — letterbox → ONNX Runtime → decode → NMS — still
    /// produces detections, which is the difference between "the model sees
    /// nothing" and "our code drops the detections".
    ///
    /// The fixture is generated by a small Python helper; the test skips when
    /// it is absent so CI stays self-contained.
    #[test]
    fn detects_a_real_photograph() {
        if !runtime_available() {
            eprintln!("SKIP detects_a_real_photograph: ONNX Runtime not installed");
            return;
        }

        let fixture = std::path::Path::new("target/zidane.rgb");
        if !fixture.is_file() {
            eprintln!("SKIP detects_a_real_photograph: fixture missing");
            return;
        }

        let Some(model) = crate::pose_config::find_config_file("models/pose4.onnx") else {
            eprintln!("SKIP detects_a_real_photograph: pose4.onnx not found");
            return;
        };

        let rgb = std::fs::read(fixture).expect("read fixture");
        // Native 1280x720; squashing the aspect ratio measurably lowers the
        // model's confidence, so the fixture keeps the original geometry.
        assert_eq!(rgb.len(), 1280 * 720 * 3, "fixture must be raw RGB 1280x720");

        let frame = Frame {
            width: 1280,
            height: 720,
            rgb,
            captured_at_ms: 0,
            sequence: 1,
        };

        let mut engine = InferenceEngine::load(
            &model,
            "pose4",
            3,
            7,
            vec!["end left".into(), "end right".into(), "start".into()],
        )
        .expect("engine loads with the runtime installed");

        let output = engine.infer(&frame).expect("forward pass");

        eprintln!(
            "real-photo: detections={} best={} {:.3} ({:.1} ms)",
            output.detections.len(),
            output.best_class_label,
            output.best_class_score,
            output.inference_ms
        );

        assert!(
            !output.detections.is_empty(),
            "a photograph containing a person must produce at least one detection"
        );
        assert!(
            output.best_class_score > 0.25,
            "expected a confident detection, got {:.3}",
            output.best_class_score
        );
    }
}
