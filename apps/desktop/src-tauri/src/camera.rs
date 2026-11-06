//! Native camera ingestion.
//!
//! A dedicated capture thread owns the device and publishes the newest decoded
//! RGB frame into an [`arc_swap::ArcSwapOption`] slot. Readers (the inference
//! loop and the preview command) perform an atomic load — never a mutex — so a
//! slow consumer can never stall the capture thread or drop the 30 FPS cadence.
//!
//! `nokhwa` selects the platform backend automatically: MediaFoundation /
//! DirectShow on Windows, AVFoundation on macOS, V4L2 on Linux.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use arc_swap::ArcSwapOption;
use nokhwa::pixel_format::RgbFormat;
use nokhwa::utils::{
    ApiBackend, CameraFormat, CameraIndex, FrameFormat, RequestedFormat, RequestedFormatType,
    Resolution,
};
use nokhwa::{query, Camera};
use serde::{Deserialize, Serialize};

use crate::error::{EngineError, EngineResult};

/// Target capture resolution; matches the ONNX input after letterboxing.
pub const TARGET_WIDTH: u32 = 640;
pub const TARGET_HEIGHT: u32 = 480;
/// Target capture cadence.
pub const TARGET_FPS: u32 = 30;

/// A decoded RGB frame.
#[derive(Debug, Clone)]
pub struct Frame {
    pub width: u32,
    pub height: u32,
    /// Packed RGB8, `width * height * 3` bytes.
    pub rgb: Vec<u8>,
    /// Wall-clock capture time, milliseconds since the Unix epoch.
    pub captured_at_ms: i64,
    /// Monotonic frame counter, starting at 1.
    pub sequence: u64,
}

impl Frame {
    pub fn bytes(&self) -> usize {
        self.rgb.len()
    }
}

/// Serializable camera description for the UI device picker.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CameraDescriptor {
    pub index: u32,
    pub human_name: String,
    pub description: String,
    pub is_default: bool,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn index_to_u32(index: &CameraIndex) -> u32 {
    match index {
        CameraIndex::Index(value) => *value,
        CameraIndex::String(value) => value.parse().unwrap_or(0),
    }
}

/// Extra guidance appended to enumeration failures.
///
/// On Linux the usual cause is `/dev/video*` being `root:video 0660`: the
/// camera is present but the user cannot open it, which is indistinguishable
/// from "no camera" in the device picker.
#[cfg(all(unix, not(target_os = "macos")))]
const ENUMERATION_HINT: &str =
    " (on Linux, add your user to the `video` group and sign in again)";
#[cfg(not(all(unix, not(target_os = "macos"))))]
const ENUMERATION_HINT: &str = "";

/// Enumerate available capture devices.
pub fn list_cameras() -> EngineResult<Vec<CameraDescriptor>> {
    let infos = query(ApiBackend::Auto).map_err(|e| {
        EngineError::Camera(format!("device enumeration failed: {e}{ENUMERATION_HINT}"))
    })?;

    Ok(infos
        .iter()
        .enumerate()
        .map(|(position, info)| CameraDescriptor {
            index: index_to_u32(info.index()),
            human_name: info.human_name().to_string(),
            description: info.description().to_string(),
            is_default: position == 0,
        })
        .collect())
}

/// Handle to a running capture thread.
pub struct CameraHandle {
    latest: Arc<ArcSwapOption<Frame>>,
    running: Arc<AtomicBool>,
    sequence: Arc<AtomicU64>,
    last_error: Arc<Mutex<Option<String>>>,
    thread: Option<JoinHandle<()>>,
    device: CameraDescriptor,
    negotiated: CameraFormat,
}

impl CameraHandle {
    /// Most recent frame, or `None` before the first frame arrives.
    pub fn latest(&self) -> Option<Arc<Frame>> {
        self.latest.load_full()
    }

    pub fn device(&self) -> &CameraDescriptor {
        &self.device
    }

    pub fn negotiated_format(&self) -> CameraFormat {
        self.negotiated
    }

    pub fn frames_captured(&self) -> u64 {
        self.sequence.load(Ordering::Relaxed)
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::Relaxed)
    }

    /// Last fatal error raised by the capture thread, if any.
    pub fn last_error(&self) -> Option<String> {
        self.last_error.lock().ok().and_then(|slot| slot.clone())
    }

    /// Signal the thread to stop and wait for it to release the device.
    pub fn stop(&mut self) {
        self.running.store(false, Ordering::Relaxed);
        if let Some(handle) = self.thread.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for CameraHandle {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Open a device and begin streaming into the lock-free frame slot.
pub fn start(device_index: u32) -> EngineResult<CameraHandle> {
    let latest: Arc<ArcSwapOption<Frame>> = Arc::new(ArcSwapOption::empty());
    let running = Arc::new(AtomicBool::new(true));
    let sequence = Arc::new(AtomicU64::new(0));
    let last_error: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

    // `nokhwa::Camera` is not `Send`, so it must be constructed inside the
    // capture thread. The thread reports its negotiated format back once the
    // stream is live, which also makes `start` fail fast on a dead device.
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(CameraDescriptor, CameraFormat), String>>();

    let thread_latest = Arc::clone(&latest);
    let thread_running = Arc::clone(&running);
    let thread_sequence = Arc::clone(&sequence);
    let thread_error = Arc::clone(&last_error);
    let frame_interval = Duration::from_millis(1000 / TARGET_FPS as u64);

    let handle = thread::Builder::new()
        .name("pilates-camera".into())
        .spawn(move || {
            let index = CameraIndex::Index(device_index);

            // Ask for 640x480@30 with the cheapest format the device supports;
            // `Closest` lets the driver negotiate rather than failing outright.
            let requested = RequestedFormat::new::<RgbFormat>(RequestedFormatType::Closest(
                CameraFormat::new(
                    Resolution::new(TARGET_WIDTH, TARGET_HEIGHT),
                    FrameFormat::MJPEG,
                    TARGET_FPS,
                ),
            ));

            let mut camera = match Camera::new(index, requested) {
                Ok(camera) => camera,
                Err(error) => {
                    let _ = ready_tx.send(Err(format!(
                        "cannot open camera {device_index}: {error}"
                    )));
                    return;
                }
            };

            if let Err(error) = camera.open_stream() {
                let _ = ready_tx.send(Err(format!(
                    "cannot open stream on camera {device_index}: {error}"
                )));
                return;
            }

            let descriptor = CameraDescriptor {
                index: device_index,
                human_name: camera.info().human_name().to_string(),
                description: camera.info().description().to_string(),
                is_default: device_index == 0,
            };
            let _ = ready_tx.send(Ok((descriptor, camera.camera_format())));

            while thread_running.load(Ordering::Relaxed) {
                let started = std::time::Instant::now();

                match camera.frame() {
                    Ok(buffer) => match buffer.decode_image::<RgbFormat>() {
                        Ok(decoded) => {
                            let frame = Frame {
                                width: decoded.width(),
                                height: decoded.height(),
                                rgb: decoded.into_raw(),
                                captured_at_ms: now_ms(),
                                sequence: thread_sequence.fetch_add(1, Ordering::Relaxed) + 1,
                            };
                            thread_latest.store(Some(Arc::new(frame)));
                        }
                        Err(error) => {
                            if let Ok(mut slot) = thread_error.lock() {
                                *slot = Some(format!("decode failed: {error}"));
                            }
                        }
                    },
                    Err(error) => {
                        if let Ok(mut slot) = thread_error.lock() {
                            *slot = Some(format!("frame grab failed: {error}"));
                        }
                        // Device disappeared or stalled: back off instead of
                        // spinning at 100% CPU.
                        thread::sleep(Duration::from_millis(250));
                    }
                }

                let elapsed = started.elapsed();
                if elapsed < frame_interval {
                    thread::sleep(frame_interval - elapsed);
                }
            }

            let _ = camera.stop_stream();
        })
        .map_err(|e| EngineError::Camera(format!("cannot spawn capture thread: {e}")))?;

    // Wait for the stream to come up so callers get a truthful error instead of
    // a handle that silently never produces frames.
    let (device, negotiated) = match ready_rx.recv_timeout(Duration::from_secs(10)) {
        Ok(Ok(ready)) => ready,
        Ok(Err(message)) => {
            running.store(false, Ordering::Relaxed);
            let _ = handle.join();
            return Err(EngineError::Camera(message));
        }
        Err(_) => {
            running.store(false, Ordering::Relaxed);
            let _ = handle.join();
            return Err(EngineError::Camera(format!(
                "camera {device_index} did not start within 10s"
            )));
        }
    };

    Ok(CameraHandle {
        latest,
        running,
        sequence,
        last_error,
        thread: Some(handle),
        device,
        negotiated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_reports_byte_length() {
        let frame = Frame {
            width: 2,
            height: 2,
            rgb: vec![0u8; 12],
            captured_at_ms: 0,
            sequence: 1,
        };
        assert_eq!(frame.bytes(), 12);
    }

    #[test]
    fn camera_index_conversion_handles_both_variants() {
        assert_eq!(index_to_u32(&CameraIndex::Index(3)), 3);
        assert_eq!(index_to_u32(&CameraIndex::String("2".into())), 2);
        assert_eq!(index_to_u32(&CameraIndex::String("not-a-number".into())), 0);
    }

    #[test]
    fn enumeration_does_not_panic_without_devices() {
        // CI runners have no webcam; enumeration must return Ok([]) rather than
        // panicking, and the UI renders an empty device list.
        let devices = list_cameras();
        match devices {
            Ok(list) => {
                if let Some(first) = list.first() {
                    assert_eq!(first.is_default, true);
                }
            }
            Err(error) => {
                // A backend failure is acceptable on headless machines, but it
                // must surface as a typed error, not a panic.
                assert!(error.to_string().starts_with("camera:"));
            }
        }
    }
}
