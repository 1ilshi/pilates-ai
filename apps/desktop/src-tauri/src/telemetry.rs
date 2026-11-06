//! Apache Parquet telemetry recorder (Tier 2 "cold" layer).
//!
//! Accumulates 30 Hz kinematic frames in memory and serializes them into a
//! Snappy-compressed Parquet file for the research data lake. The schema here
//! is the contract described in `MASTER_EXECUTION_PLAN.md` §4.3 and must stay
//! aligned with `KinematicFrameRecord` in `packages/types/src/telemetry.ts`.

use std::sync::Arc;

use arrow::array::{
    ArrayRef, Float32Array, Int32Array, Int64Array, Int8Array, ListArray, StringArray,
};
use arrow::buffer::{OffsetBuffer, ScalarBuffer};
use arrow::datatypes::{DataType, Field, Schema, SchemaRef};
use arrow::record_batch::RecordBatch;
use parquet::arrow::ArrowWriter;
use parquet::basic::Compression;
use parquet::file::properties::WriterProperties;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::biomechanics::MovementPhase;
use crate::error::{EngineError, EngineResult};

/// One 30 Hz kinematic sample.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KinematicFrame {
    /// Monotonic milliseconds from session start.
    pub timestamp_ms: i64,
    pub frame_index: i32,
    pub phase: MovementPhase,
    pub primary_angle: f32,
    pub secondary_angle: f32,
    pub form_score: f32,
    pub keypoint_ids: Vec<i8>,
    pub keypoint_x: Vec<f32>,
    pub keypoint_y: Vec<f32>,
    pub keypoint_conf: Vec<f32>,
    /// YOLO classification index (e.g. 0 = end, 1 = start).
    pub model_class: i8,
}

/// Canonical Parquet schema for the research telemetry lake.
pub fn telemetry_schema() -> SchemaRef {
    Arc::new(Schema::new(vec![
        Field::new("timestamp_ms", DataType::Int64, false),
        Field::new("frame_index", DataType::Int32, false),
        Field::new("phase", DataType::Utf8, false),
        Field::new("primary_angle", DataType::Float32, false),
        Field::new("secondary_angle", DataType::Float32, false),
        Field::new("form_score", DataType::Float32, false),
        Field::new("keypoint_ids", DataType::List(Arc::new(Field::new("item", DataType::Int8, true))), false),
        Field::new("keypoint_x", DataType::List(Arc::new(Field::new("item", DataType::Float32, true))), false),
        Field::new("keypoint_y", DataType::List(Arc::new(Field::new("item", DataType::Float32, true))), false),
        Field::new("keypoint_conf", DataType::List(Arc::new(Field::new("item", DataType::Float32, true))), false),
        Field::new("model_class", DataType::Int8, false),
    ]))
}

/// Build the flat offsets buffer for a set of equal-length-or-not lists.
fn offsets_for(lengths: &[i32]) -> OffsetBuffer<i32> {
    let mut offsets = Vec::with_capacity(lengths.len() + 1);
    offsets.push(0i32);
    let mut running = 0i32;
    for len in lengths {
        running += *len;
        offsets.push(running);
    }
    OffsetBuffer::new(ScalarBuffer::from(offsets))
}

/// In-memory accumulation buffer for one capture session.
#[derive(Debug, Default)]
pub struct TelemetryRecorder {
    frames: Vec<KinematicFrame>,
}

impl TelemetryRecorder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            frames: Vec::with_capacity(capacity),
        }
    }

    pub fn push(&mut self, frame: KinematicFrame) {
        self.frames.push(frame);
    }

    pub fn len(&self) -> usize {
        self.frames.len()
    }

    pub fn is_empty(&self) -> bool {
        self.frames.is_empty()
    }

    pub fn frames(&self) -> &[KinematicFrame] {
        &self.frames
    }

    pub fn clear(&mut self) {
        self.frames.clear();
    }

    /// Convert the accumulated frames into a single Arrow `RecordBatch`.
    pub fn to_record_batch(&self) -> EngineResult<RecordBatch> {
        let schema = telemetry_schema();

        let timestamp: Vec<i64> = self.frames.iter().map(|f| f.timestamp_ms).collect();
        let frame_index: Vec<i32> = self.frames.iter().map(|f| f.frame_index).collect();
        let phases: Vec<&str> = self.frames.iter().map(|f| f.phase.as_str()).collect();
        let primary: Vec<f32> = self.frames.iter().map(|f| f.primary_angle).collect();
        let secondary: Vec<f32> = self.frames.iter().map(|f| f.secondary_angle).collect();
        let scores: Vec<f32> = self.frames.iter().map(|f| f.form_score).collect();
        let model_class: Vec<i8> = self.frames.iter().map(|f| f.model_class).collect();

        let id_lists: Vec<i8> = self
            .frames
            .iter()
            .flat_map(|f| f.keypoint_ids.iter().copied())
            .collect();
        let x_lists: Vec<f32> = self
            .frames
            .iter()
            .flat_map(|f| f.keypoint_x.iter().copied())
            .collect();
        let y_lists: Vec<f32> = self
            .frames
            .iter()
            .flat_map(|f| f.keypoint_y.iter().copied())
            .collect();
        let conf_lists: Vec<f32> = self
            .frames
            .iter()
            .flat_map(|f| f.keypoint_conf.iter().copied())
            .collect();

        let id_lengths: Vec<i32> = self.frames.iter().map(|f| f.keypoint_ids.len() as i32).collect();
        let x_lengths: Vec<i32> = self.frames.iter().map(|f| f.keypoint_x.len() as i32).collect();
        let y_lengths: Vec<i32> = self.frames.iter().map(|f| f.keypoint_y.len() as i32).collect();
        let conf_lengths: Vec<i32> = self.frames.iter().map(|f| f.keypoint_conf.len() as i32).collect();

        let item_int8 = Arc::new(Field::new("item", DataType::Int8, true));
        let item_float = Arc::new(Field::new("item", DataType::Float32, true));

        let keypoint_ids = ListArray::new(
            item_int8.clone(),
            offsets_for(&id_lengths),
            Arc::new(Int8Array::from(id_lists)),
            None,
        );
        let keypoint_x = ListArray::new(
            item_float.clone(),
            offsets_for(&x_lengths),
            Arc::new(Float32Array::from(x_lists)),
            None,
        );
        let keypoint_y = ListArray::new(
            item_float.clone(),
            offsets_for(&y_lengths),
            Arc::new(Float32Array::from(y_lists)),
            None,
        );
        let keypoint_conf = ListArray::new(
            item_float,
            offsets_for(&conf_lengths),
            Arc::new(Float32Array::from(conf_lists)),
            None,
        );

        let columns: Vec<ArrayRef> = vec![
            Arc::new(Int64Array::from(timestamp)),
            Arc::new(Int32Array::from(frame_index)),
            Arc::new(StringArray::from(phases)),
            Arc::new(Float32Array::from(primary)),
            Arc::new(Float32Array::from(secondary)),
            Arc::new(Float32Array::from(scores)),
            Arc::new(keypoint_ids),
            Arc::new(keypoint_x),
            Arc::new(keypoint_y),
            Arc::new(keypoint_conf),
            Arc::new(Int8Array::from(model_class)),
        ];

        RecordBatch::try_new(schema, columns)
            .map_err(|e| EngineError::Telemetry(format!("failed to build record batch: {e}")))
    }

    /// Serialize to a Snappy-compressed Parquet file held in memory.
    ///
    /// The session document only stores a GCS pointer plus a SHA-256, so the
    /// bytes never need to touch disk before upload.
    pub fn to_parquet(&self) -> EngineResult<Vec<u8>> {
        if self.frames.is_empty() {
            return Err(EngineError::Telemetry(
                "refusing to encode an empty telemetry session".into(),
            ));
        }

        let batch = self.to_record_batch()?;
        let props = WriterProperties::builder()
            .set_compression(Compression::SNAPPY)
            .build();

        let mut buffer: Vec<u8> = Vec::new();
        {
            let mut writer = ArrowWriter::try_new(&mut buffer, batch.schema(), Some(props))
                .map_err(|e| EngineError::Telemetry(format!("parquet writer: {e}")))?;
            writer
                .write(&batch)
                .map_err(|e| EngineError::Telemetry(format!("parquet write: {e}")))?;
            writer
                .close()
                .map_err(|e| EngineError::Telemetry(format!("parquet close: {e}")))?;
        }
        Ok(buffer)
    }

    /// Downsample to the 2 Hz kinematic curve stored on the Firestore document.
    ///
    /// Picks the frame closest to each `1 / hz` boundary, preserving phase so
    /// the web chart can still shade hold zones.
    pub fn downsample(&self, hz: f32) -> Vec<DownsampledPoint> {
        if self.frames.is_empty() || hz <= 0.0 {
            return Vec::new();
        }
        let step_ms = (1000.0 / hz) as i64;
        let start = self.frames[0].timestamp_ms;
        let end = self.frames[self.frames.len() - 1].timestamp_ms;

        let mut points = Vec::new();
        let mut cursor = 0usize;
        let mut boundary = start;

        while boundary <= end {
            // Advance while the next frame is closer to this boundary.
            while cursor + 1 < self.frames.len()
                && (self.frames[cursor + 1].timestamp_ms - boundary).abs()
                    <= (self.frames[cursor].timestamp_ms - boundary).abs()
            {
                cursor += 1;
            }
            let frame = &self.frames[cursor];
            points.push(DownsampledPoint {
                t_sec: (frame.timestamp_ms - start) as f32 / 1000.0,
                angle: frame.primary_angle,
                score: frame.form_score,
                phase: frame.phase,
            });
            boundary += step_ms;
        }
        points
    }
}

/// A 2 Hz curve point, matching `DownsampledPoint` in `packages/types`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownsampledPoint {
    pub t_sec: f32,
    pub angle: f32,
    pub score: f32,
    pub phase: MovementPhase,
}

/// Maximum number of points kept in the Firestore document's inline curve.
///
/// A Firestore document is capped at 1 MiB, and each point costs roughly 160
/// bytes in the typed encoding. A full hour at 2 Hz is ~7,200 points, which
/// would exceed the limit — and a rejected write retries forever. The inline
/// curve is a preview; the Parquet archive keeps full fidelity.
pub const MAX_DOCUMENT_CURVE_POINTS: usize = 3000;

/// Thin a curve evenly so the document stays inside its size budget.
///
/// Striding rather than truncating keeps the whole session visible in the
/// preview instead of showing only its first half.
pub fn cap_for_document(points: Vec<DownsampledPoint>) -> Vec<DownsampledPoint> {
    if points.len() <= MAX_DOCUMENT_CURVE_POINTS {
        return points;
    }
    let stride = points.len().div_ceil(MAX_DOCUMENT_CURVE_POINTS);
    points.into_iter().step_by(stride).collect()
}

/// Lowercase hex SHA-256 of the encoded Parquet payload.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;

    fn frame(index: i32, t: i64, angle: f32, phase: MovementPhase) -> KinematicFrame {
        KinematicFrame {
            timestamp_ms: t,
            frame_index: index,
            phase,
            primary_angle: angle,
            secondary_angle: angle * 0.5,
            form_score: 88.0,
            keypoint_ids: vec![0, 1, 2],
            keypoint_x: vec![0.5, 0.45, 0.55],
            keypoint_y: vec![0.2, 0.4, 0.6],
            keypoint_conf: vec![0.95, 0.88, 0.91],
            model_class: 1,
        }
    }

    fn sample_recorder() -> TelemetryRecorder {
        let mut recorder = TelemetryRecorder::new();
        for i in 0..30 {
            let phase = if i % 3 == 0 {
                MovementPhase::Holding
            } else {
                MovementPhase::Concentric
            };
            recorder.push(frame(i, (i as i64) * 33, 80.0 + i as f32, phase));
        }
        recorder
    }

    #[test]
    fn schema_matches_plan_contract() {
        let schema = telemetry_schema();
        let names: Vec<&str> = schema.fields().iter().map(|f| f.name().as_str()).collect();
        assert_eq!(
            names,
            vec![
                "timestamp_ms",
                "frame_index",
                "phase",
                "primary_angle",
                "secondary_angle",
                "form_score",
                "keypoint_ids",
                "keypoint_x",
                "keypoint_y",
                "keypoint_conf",
                "model_class",
            ]
        );
        assert_eq!(schema.field(0).data_type(), &DataType::Int64);
        assert_eq!(schema.field(2).data_type(), &DataType::Utf8);
        assert_eq!(schema.field(10).data_type(), &DataType::Int8);
    }

    #[test]
    fn empty_recorder_refuses_to_encode() {
        let recorder = TelemetryRecorder::new();
        assert!(recorder.to_parquet().is_err());
    }

    #[test]
    fn parquet_round_trips_with_zero_nulls() {
        let recorder = sample_recorder();
        let bytes = recorder.to_parquet().expect("encode parquet");
        assert!(!bytes.is_empty());
        // PAR1 magic
        assert_eq!(&bytes[0..4], b"PAR1");

        let reader = ParquetRecordBatchReaderBuilder::try_new(bytes::Bytes::from(bytes))
            .expect("open parquet")
            .build()
            .expect("build reader");
        let batches: Vec<RecordBatch> = reader.map(|b| b.expect("read batch")).collect();
        let total: usize = batches.iter().map(|b| b.num_rows()).sum();
        assert_eq!(total, 30, "all frames must survive the round trip");

        let batch = &batches[0];
        assert_eq!(batch.num_columns(), 11);
        let nulls: usize = (0..batch.num_columns())
            .map(|index| batch.column(index).null_count())
            .sum();
        assert_eq!(nulls, 0, "schema must contain no null values");

        let phases = batch
            .column(2)
            .as_any()
            .downcast_ref::<StringArray>()
            .expect("phase column");
        assert_eq!(phases.value(0), "holding");
        assert_eq!(phases.value(1), "concentric");

        let ids = batch
            .column(6)
            .as_any()
            .downcast_ref::<ListArray>()
            .expect("keypoint_ids column");
        assert_eq!(ids.value_length(0), 3);
    }

    #[test]
    fn sha256_is_stable_and_lowercase_hex() {
        let digest = sha256_hex(b"pilates");
        assert_eq!(digest.len(), 64);
        assert!(digest.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_eq!(digest, sha256_hex(b"pilates"), "digest must be deterministic");
        assert_ne!(digest, sha256_hex(b"pilates2"));
    }

    #[test]
    fn cap_for_document_thins_a_long_curve() {
        let points: Vec<DownsampledPoint> = (0..(MAX_DOCUMENT_CURVE_POINTS * 2 + 10))
            .map(|index| DownsampledPoint {
                t_sec: index as f32 * 0.5,
                angle: 90.0,
                score: 80.0,
                phase: MovementPhase::Holding,
            })
            .collect();

        let capped = cap_for_document(points);
        assert!(
            capped.len() <= MAX_DOCUMENT_CURVE_POINTS,
            "a long session must be thinned to fit the document, got {}",
            capped.len()
        );
        assert!(!capped.is_empty(), "thinning must not discard the curve");
        // The whole session must stay represented, not just its beginning.
        assert!(
            capped.last().expect("point").t_sec > 0.0,
            "the preview must span the session"
        );
    }

    #[test]
    fn cap_for_document_leaves_a_short_curve_untouched() {
        let points: Vec<DownsampledPoint> = (0..10)
            .map(|index| DownsampledPoint {
                t_sec: index as f32 * 0.5,
                angle: 90.0,
                score: 80.0,
                phase: MovementPhase::Holding,
            })
            .collect();
        assert_eq!(cap_for_document(points).len(), 10);
    }

    #[test]
    fn downsample_targets_two_hertz() {
        // 30 frames at 33 ms spans 0..957 ms, so 2 Hz boundaries are 0 and 500.
        let recorder = sample_recorder();
        let points = recorder.downsample(2.0);
        assert_eq!(points.len(), 2, "got {points:?}");
        assert!((points[0].t_sec - 0.0).abs() < 1e-6);
        assert!(
            (points[1].t_sec - 0.5).abs() < 0.05,
            "second boundary should land near 0.5s, got {}",
            points[1].t_sec
        );
        // Phase must survive downsampling so the web chart can shade holds.
        assert!(points
            .iter()
            .all(|p| matches!(p.phase, MovementPhase::Holding | MovementPhase::Concentric)));
    }

    #[test]
    fn downsample_of_empty_is_empty() {
        assert!(TelemetryRecorder::new().downsample(2.0).is_empty());
    }

    /// Emit a real Parquet file so it can be validated by an independent
    /// reader (Python `polars`), rather than only by the Arrow writer that
    /// produced it. Consumed by `tools/verify_parquet.py`.
    #[test]
    fn writes_parquet_fixture_for_external_validation() {
        let recorder = sample_recorder();
        let bytes = recorder.to_parquet().expect("encode parquet");

        let dir = std::path::PathBuf::from("target");
        std::fs::create_dir_all(&dir).expect("create target dir");
        let path = dir.join("parquet-fixture.parquet");
        std::fs::write(&path, &bytes).expect("write fixture");

        assert!(path.is_file());
        assert!(std::fs::metadata(&path).expect("metadata").len() > 0);
        eprintln!("parquet fixture written to {}", path.display());
    }
}
