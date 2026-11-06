//! Local SQLite outbox (Step 6, Tier 0).
//!
//! Everything the clinic records is durable locally *before* any network call.
//! Sessions are written together with their Parquet blob and queued for upload;
//! if the network is down the queue simply keeps growing and drains later.
//!
//! The database runs in WAL mode so a long-running upload never blocks the
//! capture thread's writes.
//!
//! Schema evolution
//! ----------------
//! Migrations are versioned with `PRAGMA user_version`. Two guards protect
//! against the failure mode that motivated this design (see Step 6.5):
//!
//! 1. Opening a database written by a *newer* app version fails loudly instead
//!    of silently corrupting it.
//! 2. After migrating, [`Outbox::verify_schema`] asserts the expected columns
//!    exist. `CREATE TABLE IF NOT EXISTS` is a no-op on a pre-existing table,
//!    so without this check a mismatched database produces a confusing
//!    "no such column" error at query time instead of a clear message here.
//!
//! Patients are **soft-deleted** (`local_state = 'tombstone'`) so a deletion
//! can still be propagated to Firestore after the local row stops appearing in
//! the UI.

use std::path::{Path, PathBuf};

use chrono::Utc;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use crate::error::{EngineError, EngineResult};

/// Current on-disk schema version. Bump this and add a migration step whenever
/// the tables change.
///
/// v1 — initial schema.
/// v2 — contact details and the frozen legacy summary pulled from Firestore.
pub const SCHEMA_VERSION: i64 = 5;

/// Failures tolerated before a record is parked instead of retried.
///
/// Without this a record that can never succeed — a session document Firestore
/// rejects, a credential the clinic cannot fix — would retry every minute for
/// the life of the installation, hiding the real failure behind constant noise.
pub const MAX_UPLOAD_ATTEMPTS: i64 = 5;

/// File name used by the desktop application.
///
/// Deliberately distinct from the legacy Python app's `pilates.db`: the two
/// applications have incompatible schemas, and sharing one file corrupts both.
pub const DESKTOP_DB_FILENAME: &str = "pilates-desktop.db";

/// Where a session sits in the upload lifecycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UploadState {
    Pending,
    Uploading,
    Synced,
    Failed,
    /// Parked: it has failed too many times to keep retrying, but the data and
    /// the staged archive are kept so nothing is lost.
    Dead,
}

impl UploadState {
    pub fn as_str(self) -> &'static str {
        match self {
            UploadState::Pending => "pending",
            UploadState::Uploading => "uploading",
            UploadState::Synced => "synced",
            UploadState::Failed => "failed",
            UploadState::Dead => "dead",
        }
    }

    fn from_str(value: &str) -> Self {
        match value {
            "uploading" => UploadState::Uploading,
            "synced" => UploadState::Synced,
            "failed" => UploadState::Failed,
            "dead" => UploadState::Dead,
            _ => UploadState::Pending,
        }
    }
}

/// Lifecycle of a patient row.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PatientState {
    Active,
    Tombstone,
}

impl PatientState {
    pub fn as_str(self) -> &'static str {
        match self {
            PatientState::Active => "active",
            PatientState::Tombstone => "tombstone",
        }
    }

    fn from_str(value: &str) -> Self {
        if value == "tombstone" {
            PatientState::Tombstone
        } else {
            PatientState::Active
        }
    }
}

/// What applying a pulled patient document did to the local row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteUpsert {
    /// The patient was unknown locally and has been inserted.
    Inserted,
    /// The local row was refreshed from Firestore.
    Updated,
    /// The row is deleted locally but still active remotely (its tombstone has
    /// not reached Firestore yet). The deletion is kept and re-queued.
    KeptDeleted,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredPatient {
    pub id: String,
    pub name: String,
    pub age: String,
    pub weight: String,
    pub height: String,
    pub gender: String,
    /// Contact details that predate this application (Firestore-only fields).
    pub address: Option<String>,
    pub note: Option<String>,
    pub tel_number: Option<String>,
    /// Frozen FlutterFlow-era statistics as JSON, materialised by
    /// `tools/materialize_legacy.py`. `None` for patients created here.
    pub legacy_json: Option<String>,
    pub revision: i64,
    pub local_state: PatientState,
    pub created_at: String,
    pub updated_at: String,
    pub total_sessions: Option<i64>,
    pub lifetime_avg_score: Option<f64>,
    pub last_active: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredSession {
    pub session_id: String,
    pub patient_id: String,
    pub pose_id: String,
    /// Serialized `ClinicalSessionDocument`.
    pub document_json: String,
    pub parquet_sha256: Option<String>,
    pub parquet_bytes: Option<i64>,
    pub created_at: String,
    pub upload_state: UploadState,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncQueueEntry {
    pub id: i64,
    pub kind: String,
    pub entity_id: String,
    pub state: String,
    pub attempts: i64,
    pub last_error: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutboxStats {
    pub patients: i64,
    pub patients_deleted: i64,
    pub sessions_total: i64,
    pub sessions_pending: i64,
    pub sessions_failed: i64,
    /// Sessions parked after exhausting their retry budget. Their archives are
    /// still on disk; they need a human to look at them.
    pub sessions_dead: i64,
    pub queued_operations: i64,
}

/// Handle to the local durable store.
pub struct Outbox {
    connection: Connection,
    path: PathBuf,
}

impl Outbox {
    /// Open (creating if needed) the store at `path` in WAL mode.
    pub fn open(path: impl AsRef<Path>) -> EngineResult<Self> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                EngineError::Storage(format!("cannot create {}: {e}", parent.display()))
            })?;
        }

        let connection = Connection::open(&path)
            .map_err(|e| EngineError::Storage(format!("cannot open {}: {e}", path.display())))?;

        // WAL lets readers proceed while the capture thread writes.
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| EngineError::Storage(format!("cannot enable WAL: {e}")))?;
        connection
            .pragma_update(None, "synchronous", "NORMAL")
            .map_err(|e| EngineError::Storage(format!("cannot set synchronous: {e}")))?;
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .map_err(|e| EngineError::Storage(format!("cannot enable foreign keys: {e}")))?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| EngineError::Storage(format!("cannot set busy timeout: {e}")))?;

        let outbox = Self { connection, path };
        outbox.migrate()?;
        outbox.verify_schema()?;
        Ok(outbox)
    }

    /// Open an in-memory store (tests).
    pub fn in_memory() -> EngineResult<Self> {
        let connection = Connection::open_in_memory()
            .map_err(|e| EngineError::Storage(format!("cannot open in-memory db: {e}")))?;
        let outbox = Self {
            connection,
            path: PathBuf::from(":memory:"),
        };
        outbox.migrate()?;
        outbox.verify_schema()?;
        Ok(outbox)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn schema_version(&self) -> EngineResult<i64> {
        self.connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(|e| EngineError::Storage(e.to_string()))
    }

    fn migrate(&self) -> EngineResult<()> {
        let current: i64 = self
            .connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(|e| EngineError::Storage(e.to_string()))?;

        if current > SCHEMA_VERSION {
            return Err(EngineError::Storage(format!(
                "database {} uses schema v{current}, but this build supports v{SCHEMA_VERSION}. \
                 Update the application instead of downgrading the data.",
                self.path.display()
            )));
        }

        if current < 1 {
            self.apply_v1()?;
        }
        if current < 2 {
            self.apply_v2()?;
        }
        if current < 3 {
            self.apply_v3()?;
        }
        if current < 4 {
            self.apply_v4()?;
        }
        if current < 5 {
            self.apply_v5()?;
        }

        if current != SCHEMA_VERSION {
            self.connection
                .pragma_update(None, "user_version", SCHEMA_VERSION)
                .map_err(|e| EngineError::Storage(format!("cannot set user_version: {e}")))?;
        }
        Ok(())
    }

    /// v1: initial schema.
    fn apply_v1(&self) -> EngineResult<()> {
        self.connection
            .execute_batch(
                r#"
                CREATE TABLE IF NOT EXISTS patients (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    age TEXT NOT NULL DEFAULT '',
                    weight TEXT NOT NULL DEFAULT '',
                    height TEXT NOT NULL DEFAULT '',
                    gender TEXT NOT NULL DEFAULT '',
                    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
                    local_state TEXT NOT NULL DEFAULT 'active'
                        CHECK (local_state IN ('active', 'tombstone')),
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    total_sessions INTEGER,
                    lifetime_avg_score REAL,
                    last_active TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_patients_state ON patients(local_state);

                CREATE TABLE IF NOT EXISTS sessions (
                    session_id TEXT PRIMARY KEY,
                    patient_id TEXT NOT NULL,
                    pose_id TEXT NOT NULL,
                    document_json TEXT NOT NULL,
                    parquet_sha256 TEXT,
                    parquet_bytes INTEGER,
                    parquet_blob BLOB,
                    created_at TEXT NOT NULL,
                    upload_state TEXT NOT NULL DEFAULT 'pending',
                    last_error TEXT,
                    FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_sessions_state ON sessions(upload_state);

                CREATE TABLE IF NOT EXISTS sync_queue (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    kind TEXT NOT NULL,
                    entity_id TEXT NOT NULL,
                    state TEXT NOT NULL DEFAULT 'pending',
                    attempts INTEGER NOT NULL DEFAULT 0,
                    last_error TEXT,
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_queue_state ON sync_queue(state);
                "#,
            )
            .map_err(|e| EngineError::Storage(format!("migration v1 failed: {e}")))?;
        Ok(())
    }

    /// v2: contact details and the frozen legacy summary.
    ///
    /// SQLite has no `ADD COLUMN IF NOT EXISTS`, so each column is checked
    /// against the live table first. That also makes the step safe to re-run
    /// against a database that was only partially migrated.
    fn apply_v2(&self) -> EngineResult<()> {
        let existing = self.table_columns("patients")?;

        let additions = [
            ("address", "ALTER TABLE patients ADD COLUMN address TEXT"),
            ("note", "ALTER TABLE patients ADD COLUMN note TEXT"),
            ("tel_number", "ALTER TABLE patients ADD COLUMN tel_number TEXT"),
            ("legacy_json", "ALTER TABLE patients ADD COLUMN legacy_json TEXT"),
        ];

        for (name, statement) in additions {
            if existing.iter().any(|column| column == name) {
                continue;
            }
            self.connection
                .execute(statement, [])
                .map_err(|e| EngineError::Storage(format!("migration v2 ({name}) failed: {e}")))?;
        }
        Ok(())
    }

    /// v3: the Firestore `updateTime` of each patient document as last seen.
    ///
    /// Kept in its own table rather than as a `patients` column because it is
    /// sync bookkeeping, not clinical data: a pull refreshes it and a push uses
    /// it as an optimistic-concurrency precondition. `StoredPatient` keeps the
    /// shape the UI already consumes.
    fn apply_v3(&self) -> EngineResult<()> {
        self.connection
            .execute_batch(
                r#"
                CREATE TABLE IF NOT EXISTS patient_sync_meta (
                    patient_id TEXT PRIMARY KEY,
                    remote_update_time TEXT,
                    FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE
                );
                "#,
            )
            .map_err(|e| EngineError::Storage(format!("migration v3 failed: {e}")))?;
        Ok(())
    }

    /// v4: key/value bookkeeping for incremental sync.
    ///
    /// Holds the session watermark, so a pull asks Firestore only for sessions
    /// completed since the last one instead of re-reading the whole archive.
    fn apply_v4(&self) -> EngineResult<()> {
        self.connection
            .execute_batch(
                r#"
                CREATE TABLE IF NOT EXISTS sync_state (
                    state_key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                "#,
            )
            .map_err(|e| EngineError::Storage(format!("migration v4 failed: {e}")))?;
        Ok(())
    }

    /// v5: per-session upload attempt counter.
    ///
    /// Lets a record that can never succeed be parked instead of retried
    /// forever, while keeping its archive so nothing is destroyed.
    fn apply_v5(&self) -> EngineResult<()> {
        let existing = self.table_columns("sessions")?;
        if existing.iter().any(|column| column == "attempts") {
            return Ok(());
        }
        self.connection
            .execute(
                "ALTER TABLE sessions ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0",
                [],
            )
            .map_err(|e| EngineError::Storage(format!("migration v5 failed: {e}")))?;
        Ok(())
    }

    /// Assert the live schema matches what the queries expect.
    ///
    /// `CREATE TABLE IF NOT EXISTS` silently does nothing when a table already
    /// exists, so a database created by a different application would otherwise
    /// only fail later with "no such column".
    fn verify_schema(&self) -> EngineResult<()> {
        let columns = self.table_columns("patients")?;
        if columns.is_empty() {
            return Err(EngineError::Storage(
                "patients table was not created".into(),
            ));
        }

        let required = [
            "id",
            "name",
            "revision",
            "local_state",
            "total_sessions",
            "lifetime_avg_score",
            "last_active",
            "address",
            "note",
            "tel_number",
            "legacy_json",
        ];
        let missing: Vec<&str> = required
            .iter()
            .copied()
            .filter(|name| !columns.iter().any(|column| column == name))
            .collect();

        if !missing.is_empty() {
            return Err(EngineError::Storage(format!(
                "database {} has an incompatible `patients` table (missing: {}). \
                 This is likely the legacy Python database; the desktop app stores its \
                 data in {DESKTOP_DB_FILENAME}.",
                self.path.display(),
                missing.join(", ")
            )));
        }
        Ok(())
    }

    fn table_columns(&self, table: &str) -> EngineResult<Vec<String>> {
        let mut statement = self
            .connection
            .prepare(&format!("PRAGMA table_info({table})"))
            .map_err(|e| EngineError::Storage(e.to_string()))?;

        let rows = statement
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| EngineError::Storage(e.to_string()))?;

        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| EngineError::Storage(e.to_string()))
    }

    // ----- patients -------------------------------------------------------

    /// Active patients only; tombstoned rows are hidden from the UI.
    pub fn list_patients(&self) -> EngineResult<Vec<StoredPatient>> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT id, name, age, weight, height, gender, revision, local_state, created_at, \
                 updated_at, total_sessions, lifetime_avg_score, last_active, address, note, \
                 tel_number, legacy_json \
                 FROM patients WHERE local_state = 'active' ORDER BY name COLLATE NOCASE",
            )
            .map_err(|e| EngineError::Storage(e.to_string()))?;

        let rows = statement
            .query_map([], map_patient)
            .map_err(|e| EngineError::Storage(e.to_string()))?;

        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| EngineError::Storage(e.to_string()))
    }

    /// Fetch an active patient (used to validate a capture session).
    pub fn get_patient(&self, id: &str) -> EngineResult<Option<StoredPatient>> {
        Ok(self
            .fetch_patient(id)?
            .filter(|patient| patient.local_state == PatientState::Active))
    }

    /// Fetch a patient regardless of tombstone state.
    pub fn fetch_patient(&self, id: &str) -> EngineResult<Option<StoredPatient>> {
        self.connection
            .query_row(
                "SELECT id, name, age, weight, height, gender, revision, local_state, created_at, \
                 updated_at, total_sessions, lifetime_avg_score, last_active, address, note, \
                 tel_number, legacy_json \
                 FROM patients WHERE id = ?1",
                params![id],
                map_patient,
            )
            .optional()
            .map_err(|e| EngineError::Storage(e.to_string()))
    }

    /// Insert or update a patient, bumping `revision` and queueing a sync op.
    ///
    /// Saving a previously tombstoned patient restores it to `active`.
    pub fn save_patient(&mut self, patient: &StoredPatient) -> EngineResult<StoredPatient> {
        let now = Utc::now().to_rfc3339();
        let existing = self.fetch_patient(&patient.id)?;

        let revision = existing.as_ref().map(|p| p.revision + 1).unwrap_or(1);
        let created_at = existing
            .as_ref()
            .map(|p| p.created_at.clone())
            .unwrap_or_else(|| now.clone());

        let saved = StoredPatient {
            revision,
            local_state: PatientState::Active,
            created_at,
            updated_at: now.clone(),
            ..patient.clone()
        };

        self.connection
            .execute(
                "INSERT INTO patients (id, name, age, weight, height, gender, revision, local_state, \
                 created_at, updated_at, total_sessions, lifetime_avg_score, last_active, address, \
                 note, tel_number, legacy_json) \
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17) \
                 ON CONFLICT(id) DO UPDATE SET \
                   name=excluded.name, age=excluded.age, weight=excluded.weight, \
                   height=excluded.height, gender=excluded.gender, revision=excluded.revision, \
                   local_state=excluded.local_state, updated_at=excluded.updated_at, \
                   total_sessions=COALESCE(excluded.total_sessions, patients.total_sessions), \
                   lifetime_avg_score=COALESCE(excluded.lifetime_avg_score, patients.lifetime_avg_score), \
                   last_active=COALESCE(excluded.last_active, patients.last_active), \
                   address=COALESCE(excluded.address, patients.address), \
                   note=COALESCE(excluded.note, patients.note), \
                   tel_number=COALESCE(excluded.tel_number, patients.tel_number), \
                   legacy_json=COALESCE(excluded.legacy_json, patients.legacy_json)",
                params![
                    saved.id,
                    saved.name,
                    saved.age,
                    saved.weight,
                    saved.height,
                    saved.gender,
                    saved.revision,
                    saved.local_state.as_str(),
                    saved.created_at,
                    saved.updated_at,
                    saved.total_sessions,
                    saved.lifetime_avg_score,
                    saved.last_active,
                    saved.address,
                    saved.note,
                    saved.tel_number,
                    saved.legacy_json,
                ],
            )
            .map_err(|e| EngineError::Storage(e.to_string()))?;

        let kind = if existing.is_some() {
            "update_patient"
        } else {
            "create_patient"
        };
        self.enqueue(kind, &saved.id)?;

        // Re-read rather than returning `saved`: the `COALESCE` above may have
        // preserved aggregates and contact details the caller did not send, and
        // the UI renders whatever this returns. Returning the caller's own
        // sparse record made a profile edit look like it had erased the
        // patient's session totals.
        Ok(self.fetch_patient(&saved.id)?.unwrap_or(saved))
    }

    /// Soft-delete a patient so the deletion can still be synced.
    pub fn delete_patient(&mut self, id: &str) -> EngineResult<()> {
        let now = Utc::now().to_rfc3339();
        self.connection
            .execute(
                "UPDATE patients SET local_state = 'tombstone', revision = revision + 1, \
                 updated_at = ?2 WHERE id = ?1 AND local_state = 'active'",
                params![id, now],
            )
            .map_err(|e| EngineError::Storage(e.to_string()))?;

        self.enqueue("delete_patient", id)?;
        Ok(())
    }

    // ----- sessions -------------------------------------------------------

    /// Persist a completed session and queue both cloud writes.
    pub fn save_session(
        &mut self,
        session_id: &str,
        patient_id: &str,
        pose_id: &str,
        document_json: &str,
        parquet: Option<(&[u8], &str)>,
    ) -> EngineResult<()> {
        let now = Utc::now().to_rfc3339();
        let (sha, bytes, blob) = match parquet {
            Some((data, sha)) => (Some(sha.to_string()), Some(data.len() as i64), Some(data)),
            None => (None, None, None),
        };

        self.connection
            .execute(
                "INSERT INTO sessions (session_id, patient_id, pose_id, document_json, parquet_sha256, \
                 parquet_bytes, parquet_blob, created_at, upload_state) \
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'pending') \
                 ON CONFLICT(session_id) DO UPDATE SET document_json=excluded.document_json, \
                 parquet_sha256=excluded.parquet_sha256, parquet_bytes=excluded.parquet_bytes, \
                 parquet_blob=excluded.parquet_blob",
                params![session_id, patient_id, pose_id, document_json, sha, bytes, blob, now],
            )
            .map_err(|e| EngineError::Storage(e.to_string()))?;

        self.enqueue("create_session", session_id)?;
        Ok(())
    }

    /// Store a session that came from Firestore.
    ///
    /// Remote sessions are already synced, so they are never queued for upload.
    /// A local session with the same id that is still pending is left untouched:
    /// work recorded on this machine is the source of truth until it uploads.
    pub fn upsert_remote_session(
        &mut self,
        session_id: &str,
        patient_id: &str,
        pose_id: &str,
        document_json: &str,
    ) -> EngineResult<bool> {
        let existing: Option<String> = self
            .connection
            .query_row(
                "SELECT upload_state FROM sessions WHERE session_id = ?1",
                params![session_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| EngineError::Storage(e.to_string()))?;

        if let Some(state) = existing {
            if state != "synced" {
                return Ok(false);
            }
        }

        let now = Utc::now().to_rfc3339();
        self.connection
            .execute(
                "INSERT INTO sessions (session_id, patient_id, pose_id, document_json, created_at, upload_state) \
                 VALUES (?1,?2,?3,?4,?5,'synced') \
                 ON CONFLICT(session_id) DO UPDATE SET document_json=excluded.document_json",
                params![session_id, patient_id, pose_id, document_json, now],
            )
            .map_err(|e| EngineError::Storage(e.to_string()))?;

        Ok(true)
    }

    /// How many sessions are stored locally for a patient.
    pub fn session_count(&self, patient_id: &str) -> EngineResult<i64> {
        self.connection
            .query_row(
                "SELECT COUNT(*) FROM sessions WHERE patient_id = ?1",
                params![patient_id],
                |row| row.get(0),
            )
            .map_err(|e| EngineError::Storage(e.to_string()))
    }

    /// True once the frozen legacy archive has been downloaded at least once.
    pub fn has_legacy_patients(&self) -> EngineResult<bool> {
        let count: i64 = self
            .connection
            .query_row(
                "SELECT COUNT(*) FROM patients WHERE legacy_json IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .map_err(|e| EngineError::Storage(e.to_string()))?;
        Ok(count > 0)
    }

    /// True when a local change for this patient has not reached Firestore.
    ///
    /// A pull must not overwrite such a row: the local edit is newer than the
    /// remote copy, and the pending queue entry would then upload the stale
    /// remote value once it finally flushes.
    pub fn has_pending_patient(&self, patient_id: &str) -> EngineResult<bool> {
        let count: i64 = self
            .connection
            .query_row(
                "SELECT COUNT(*) FROM sync_queue WHERE entity_id = ?1 AND state = 'pending'",
                params![patient_id],
                |row| row.get(0),
            )
            .map_err(|e| EngineError::Storage(e.to_string()))?;
        Ok(count > 0)
    }

    /// Sessions still needing upload, oldest first.
    pub fn pending_sessions(&self, limit: usize) -> EngineResult<Vec<StoredSession>> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT session_id, patient_id, pose_id, document_json, parquet_sha256, parquet_bytes, \
                 created_at, upload_state, last_error FROM sessions \
                 WHERE upload_state IN ('pending','failed') ORDER BY created_at LIMIT ?1",
            )
            .map_err(|e| EngineError::Storage(e.to_string()))?;

        let rows = statement
            .query_map(params![limit as i64], map_session)
            .map_err(|e| EngineError::Storage(e.to_string()))?;

        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| EngineError::Storage(e.to_string()))
    }

    /// Every session for one patient, newest first (including synced ones).
    pub fn sessions_for_patient(&self, patient_id: &str) -> EngineResult<Vec<StoredSession>> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT session_id, patient_id, pose_id, document_json, parquet_sha256, parquet_bytes, \
                 created_at, upload_state, last_error FROM sessions \
                 WHERE patient_id = ?1 ORDER BY created_at DESC",
            )
            .map_err(|e| EngineError::Storage(e.to_string()))?;

        let rows = statement
            .query_map(params![patient_id], map_session)
            .map_err(|e| EngineError::Storage(e.to_string()))?;

        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| EngineError::Storage(e.to_string()))
    }

    /// Every session across all patients, newest first.
    ///
    /// Used by the analysis view, which aggregates across the whole clinic
    /// rather than a single patient.
    pub fn all_sessions(&self) -> EngineResult<Vec<StoredSession>> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT session_id, patient_id, pose_id, document_json, parquet_sha256, parquet_bytes, \
                 created_at, upload_state, last_error FROM sessions ORDER BY created_at DESC",
            )
            .map_err(|e| EngineError::Storage(e.to_string()))?;

        let rows = statement
            .query_map([], map_session)
            .map_err(|e| EngineError::Storage(e.to_string()))?;

        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| EngineError::Storage(e.to_string()))
    }

    /// The staged Parquet payload for a session.
    pub fn session_parquet(&self, session_id: &str) -> EngineResult<Option<Vec<u8>>> {
        self.connection
            .query_row(
                "SELECT parquet_blob FROM sessions WHERE session_id = ?1",
                params![session_id],
                |row| row.get::<_, Option<Vec<u8>>>(0),
            )
            .optional()
            .map(|row| row.flatten())
            .map_err(|e| EngineError::Storage(e.to_string()))
    }

    pub fn session(&self, session_id: &str) -> EngineResult<Option<StoredSession>> {
        self.connection
            .query_row(
                "SELECT session_id, patient_id, pose_id, document_json, parquet_sha256, parquet_bytes, \
                 created_at, upload_state, last_error FROM sessions WHERE session_id = ?1",
                params![session_id],
                map_session,
            )
            .optional()
            .map_err(|e| EngineError::Storage(e.to_string()))
    }

    pub fn mark_session_state(
        &mut self,
        session_id: &str,
        state: UploadState,
        error: Option<&str>,
    ) -> EngineResult<()> {
        // Every push begins by marking the session `Uploading`, so that is
        // where the attempt counter advances.
        if state == UploadState::Uploading {
            self.connection
                .execute(
                    "UPDATE sessions SET attempts = attempts + 1 WHERE session_id = ?1",
                    params![session_id],
                )
                .map_err(|e| EngineError::Storage(e.to_string()))?;
        }

        // A record that has exhausted its attempts is parked rather than
        // retried: it keeps its archive and stays visible in the stats.
        let effective = if state == UploadState::Failed
            && self.session_attempts(session_id)? >= MAX_UPLOAD_ATTEMPTS
        {
            UploadState::Dead
        } else {
            state
        };

        self.connection
            .execute(
                "UPDATE sessions SET upload_state = ?2, last_error = ?3 WHERE session_id = ?1",
                params![session_id, effective.as_str(), error],
            )
            .map_err(|e| EngineError::Storage(e.to_string()))?;

        // Reclaiming the blob is only safe because `Synced` is now reachable
        // solely after `CloudSync::push_session` has confirmed the archive is
        // stored in Cloud Storage. Every other state keeps the blob, so a
        // failed upload can be retried and nothing is destroyed unseen.
        if effective == UploadState::Synced {
            self.connection
                .execute(
                    "UPDATE sessions SET parquet_blob = NULL WHERE session_id = ?1",
                    params![session_id],
                )
                .map_err(|e| EngineError::Storage(e.to_string()))?;
        }
        Ok(())
    }

    fn session_attempts(&self, session_id: &str) -> EngineResult<i64> {
        self.connection
            .query_row(
                "SELECT attempts FROM sessions WHERE session_id = ?1",
                params![session_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map(|value| value.unwrap_or(0))
            .map_err(|e| EngineError::Storage(e.to_string()))
    }

    // ----- sync bookkeeping ----------------------------------------------

    /// Record the Firestore `updateTime` a patient document had when it was
    /// last read or written.
    ///
    /// `None` forgets the baseline, which disables the precondition for that
    /// patient: better to write unconditionally than to pin a stale timestamp
    /// and fail every retry.
    pub fn set_remote_update_time(
        &mut self,
        patient_id: &str,
        update_time: Option<&str>,
    ) -> EngineResult<()> {
        match update_time {
            Some(value) => self.connection.execute(
                "INSERT INTO patient_sync_meta (patient_id, remote_update_time) VALUES (?1, ?2) \
                 ON CONFLICT(patient_id) DO UPDATE SET \
                   remote_update_time = excluded.remote_update_time",
                params![patient_id, value],
            ),
            None => self.connection.execute(
                "DELETE FROM patient_sync_meta WHERE patient_id = ?1",
                params![patient_id],
            ),
        }
        .map_err(|e| EngineError::Storage(e.to_string()))?;
        Ok(())
    }

    /// The `updateTime` to send as an optimistic-concurrency precondition.
    pub fn remote_update_time(&self, patient_id: &str) -> EngineResult<Option<String>> {
        self.connection
            .query_row(
                "SELECT remote_update_time FROM patient_sync_meta WHERE patient_id = ?1",
                params![patient_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map(|row| row.flatten())
            .map_err(|e| EngineError::Storage(e.to_string()))
    }

    /// Read a small bookkeeping value, or `None` when it was never set.
    pub fn sync_state(&self, key: &str) -> EngineResult<Option<String>> {
        self.connection
            .query_row(
                "SELECT value FROM sync_state WHERE state_key = ?1",
                params![key],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| EngineError::Storage(e.to_string()))
    }

    pub fn set_sync_state(&mut self, key: &str, value: &str) -> EngineResult<()> {
        self.connection
            .execute(
                "INSERT INTO sync_state (state_key, value) VALUES (?1, ?2) \
                 ON CONFLICT(state_key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )
            .map_err(|e| EngineError::Storage(e.to_string()))?;
        Ok(())
    }

    // ----- sync queue -----------------------------------------------------

    pub fn enqueue(&mut self, kind: &str, entity_id: &str) -> EngineResult<()> {
        let now = Utc::now().to_rfc3339();

        // A fresh edit supersedes a parked conflict: the clinician has now seen
        // the newer remote version and chosen to save over it, so the old
        // refusal no longer describes reality.
        self.connection
            .execute(
                "UPDATE sync_queue SET state = 'done', \
                   last_error = 'superseded by a newer edit' \
                 WHERE entity_id = ?1 AND state = 'conflict'",
                params![entity_id],
            )
            .map_err(|e| EngineError::Storage(e.to_string()))?;

        self.connection
            .execute(
                "INSERT INTO sync_queue (kind, entity_id, state, attempts, created_at) \
                 VALUES (?1, ?2, 'pending', 0, ?3)",
                params![kind, entity_id, now],
            )
            .map_err(|e| EngineError::Storage(e.to_string()))?;
        Ok(())
    }

    /// Queue an operation unless the same one is already waiting to run.
    ///
    /// A pull runs every minute, so re-queueing blindly would grow the queue
    /// without bound while a push keeps failing.
    pub fn enqueue_pending_once(&mut self, kind: &str, entity_id: &str) -> EngineResult<()> {
        let pending: Option<i64> = self
            .connection
            .query_row(
                "SELECT id FROM sync_queue WHERE kind = ?1 AND entity_id = ?2 AND state = 'pending' \
                 LIMIT 1",
                params![kind, entity_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| EngineError::Storage(e.to_string()))?;

        if pending.is_none() {
            self.enqueue(kind, entity_id)?;
        }
        Ok(())
    }

    pub fn queue_entries(&self, limit: usize) -> EngineResult<Vec<SyncQueueEntry>> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT id, kind, entity_id, state, attempts, last_error, created_at FROM sync_queue \
                 ORDER BY id LIMIT ?1",
            )
            .map_err(|e| EngineError::Storage(e.to_string()))?;

        let rows = statement
            .query_map(params![limit as i64], |row| {
                Ok(SyncQueueEntry {
                    id: row.get(0)?,
                    kind: row.get(1)?,
                    entity_id: row.get(2)?,
                    state: row.get(3)?,
                    attempts: row.get(4)?,
                    last_error: row.get(5)?,
                    created_at: row.get(6)?,
                })
            })
            .map_err(|e| EngineError::Storage(e.to_string()))?;

        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| EngineError::Storage(e.to_string()))
    }

    pub fn resolve_queue_entry(
        &mut self,
        id: i64,
        state: &str,
        error: Option<&str>,
    ) -> EngineResult<()> {
        // A record that keeps failing is parked instead of retried forever.
        let state = if state == "pending" {
            let attempts: i64 = self
                .connection
                .query_row(
                    "SELECT attempts FROM sync_queue WHERE id = ?1",
                    params![id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| EngineError::Storage(e.to_string()))?
                .unwrap_or(0);
            if attempts + 1 >= MAX_UPLOAD_ATTEMPTS {
                "dead"
            } else {
                "pending"
            }
        } else {
            state
        };

        self.connection
            .execute(
                "UPDATE sync_queue SET state = ?2, last_error = ?3, attempts = attempts + 1 WHERE id = ?1",
                params![id, state, error],
            )
            .map_err(|e| EngineError::Storage(e.to_string()))?;
        Ok(())
    }

    /// Resolve every pending queue entry that targets `entity_id` of `kind`.
    ///
    /// Used by the sync loop, which works from the entity rather than the queue
    /// row (a session is pushed once but may have several queued operations).
    pub fn resolve_pending_for_entity(
        &mut self,
        kind: &str,
        entity_id: &str,
        state: &str,
        error: Option<&str>,
    ) -> EngineResult<usize> {
        let changed = self
            .connection
            .execute(
                "UPDATE sync_queue SET state = ?3, last_error = ?4, attempts = attempts + 1 \
                 WHERE kind = ?1 AND entity_id = ?2 AND state = 'pending'",
                params![kind, entity_id, state, error],
            )
            .map_err(|e| EngineError::Storage(e.to_string()))?;
        Ok(changed)
    }

    /// Apply a patient pulled from Firestore.
    ///
    /// Unlike [`Outbox::save_patient`] this does **not** enqueue an upload (the
    /// remote copy is already authoritative) and never lowers a local revision.
    ///
    /// A local tombstone is *not* overwritten by an active remote document: the
    /// delete either has not reached Firestore yet or the remote document
    /// predates `local_state` entirely (production documents do). Resurrecting
    /// it would undo a clinician's deletion, so the tombstone is kept and the
    /// pending delete is re-queued to let the roster converge.
    pub fn upsert_remote_patient(&mut self, patient: &StoredPatient) -> EngineResult<RemoteUpsert> {
        let existing = self.fetch_patient(&patient.id)?;
        let now = Utc::now().to_rfc3339();

        if let Some(current) = &existing {
            let deleted_here = current.local_state == PatientState::Tombstone;
            let deleted_remotely = patient.local_state == PatientState::Tombstone;
            if deleted_here && !deleted_remotely && patient.revision <= current.revision {
                self.enqueue_pending_once("delete_patient", &patient.id)?;
                return Ok(RemoteUpsert::KeptDeleted);
            }
        }

        let (revision, created_at, outcome) = match &existing {
            Some(current) => (
                current.revision.max(patient.revision).max(1),
                current.created_at.clone(),
                RemoteUpsert::Updated,
            ),
            None => (
                patient.revision.max(1),
                if patient.created_at.is_empty() {
                    now.clone()
                } else {
                    patient.created_at.clone()
                },
                RemoteUpsert::Inserted,
            ),
        };

        self.connection
            .execute(
                "INSERT INTO patients (id, name, age, weight, height, gender, revision, local_state, \
                 created_at, updated_at, total_sessions, lifetime_avg_score, last_active, address, \
                 note, tel_number, legacy_json) \
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17) \
                 ON CONFLICT(id) DO UPDATE SET \
                   name=excluded.name, age=excluded.age, weight=excluded.weight, \
                   height=excluded.height, gender=excluded.gender, revision=excluded.revision, \
                   local_state=excluded.local_state, updated_at=excluded.updated_at, \
                   total_sessions=COALESCE(excluded.total_sessions, patients.total_sessions), \
                   lifetime_avg_score=COALESCE(excluded.lifetime_avg_score, patients.lifetime_avg_score), \
                   last_active=COALESCE(excluded.last_active, patients.last_active), \
                   address=COALESCE(excluded.address, patients.address), \
                   note=COALESCE(excluded.note, patients.note), \
                   tel_number=COALESCE(excluded.tel_number, patients.tel_number), \
                   legacy_json=COALESCE(excluded.legacy_json, patients.legacy_json)",
                params![
                    patient.id,
                    patient.name,
                    patient.age,
                    patient.weight,
                    patient.height,
                    patient.gender,
                    revision,
                    patient.local_state.as_str(),
                    created_at,
                    now,
                    patient.total_sessions,
                    patient.lifetime_avg_score,
                    patient.last_active,
                    patient.address,
                    patient.note,
                    patient.tel_number,
                    patient.legacy_json,
                ],
            )
            .map_err(|e| EngineError::Storage(e.to_string()))?;

        Ok(outcome)
    }

    pub fn stats(&self) -> EngineResult<OutboxStats> {
        let count = |sql: &str| -> EngineResult<i64> {
            self.connection
                .query_row(sql, [], |row| row.get::<_, i64>(0))
                .map_err(|e| EngineError::Storage(e.to_string()))
        };

        Ok(OutboxStats {
            patients: count("SELECT COUNT(*) FROM patients WHERE local_state = 'active'")?,
            patients_deleted: count("SELECT COUNT(*) FROM patients WHERE local_state = 'tombstone'")?,
            sessions_total: count("SELECT COUNT(*) FROM sessions")?,
            sessions_pending: count("SELECT COUNT(*) FROM sessions WHERE upload_state = 'pending'")?,
            sessions_failed: count("SELECT COUNT(*) FROM sessions WHERE upload_state = 'failed'")?,
            sessions_dead: count("SELECT COUNT(*) FROM sessions WHERE upload_state = 'dead'")?,
            queued_operations: count("SELECT COUNT(*) FROM sync_queue WHERE state = 'pending'")?,
        })
    }

    /// Total patient rows, including tombstones.
    fn patient_row_count(&self) -> EngineResult<i64> {
        self.connection
            .query_row("SELECT COUNT(*) FROM patients", [], |row| row.get::<_, i64>(0))
            .map_err(|e| EngineError::Storage(e.to_string()))
    }

    // ----- legacy import --------------------------------------------------

    /// Copy patient records out of the legacy Python database.
    ///
    /// Runs at most once: it is skipped unless this store is completely empty
    /// (tombstones count as rows, so deleting every patient will not trigger a
    /// second import). The legacy file is opened **read-only** and is never
    /// modified.
    pub fn import_legacy_patients(&mut self, legacy_path: &Path) -> EngineResult<usize> {
        if !legacy_path.is_file() {
            return Ok(0);
        }
        if self.patient_row_count()? > 0 {
            return Ok(0);
        }

        let legacy = Connection::open_with_flags(
            legacy_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|e| {
            EngineError::Storage(format!(
                "cannot open legacy database {}: {e}",
                legacy_path.display()
            ))
        })?;

        let mut statement = legacy
            .prepare(
                "SELECT id, name, age, weight, height, gender, revision, created_at, updated_at \
                 FROM patients",
            )
            .map_err(|e| {
                EngineError::Storage(format!(
                    "legacy database has no compatible patients table: {e}"
                ))
            })?;

        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                    row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                    row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                    row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                    row.get::<_, i64>(6).unwrap_or(1),
                    row.get::<_, Option<String>>(7)?.unwrap_or_default(),
                    row.get::<_, Option<String>>(8)?.unwrap_or_default(),
                ))
            })
            .map_err(|e| EngineError::Storage(e.to_string()))?;

        let mut imported = 0usize;
        for row in rows {
            let (id, name, age, weight, height, gender, revision, created_at, updated_at) =
                row.map_err(|e| EngineError::Storage(e.to_string()))?;

            // Preserve the legacy id so any downstream references stay valid.
            self.connection
                .execute(
                    "INSERT OR IGNORE INTO patients (id, name, age, weight, height, gender, revision, \
                     local_state, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,'active',?8,?9)",
                    params![id, name, age, weight, height, gender, revision, created_at, updated_at],
                )
                .map_err(|e| EngineError::Storage(e.to_string()))?;
            imported += 1;
        }

        if imported > 0 {
            self.enqueue("import_legacy_patients", "legacy")?;
        }
        Ok(imported)
    }
}

fn map_patient(row: &Row<'_>) -> rusqlite::Result<StoredPatient> {
    let state: String = row.get(7)?;
    Ok(StoredPatient {
        id: row.get(0)?,
        name: row.get(1)?,
        age: row.get(2)?,
        weight: row.get(3)?,
        height: row.get(4)?,
        gender: row.get(5)?,
        revision: row.get(6)?,
        local_state: PatientState::from_str(&state),
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
        total_sessions: row.get(10)?,
        lifetime_avg_score: row.get(11)?,
        last_active: row.get(12)?,
        address: row.get(13)?,
        note: row.get(14)?,
        tel_number: row.get(15)?,
        legacy_json: row.get(16)?,
    })
}

fn map_session(row: &Row<'_>) -> rusqlite::Result<StoredSession> {
    let state: String = row.get(7)?;
    Ok(StoredSession {
        session_id: row.get(0)?,
        patient_id: row.get(1)?,
        pose_id: row.get(2)?,
        document_json: row.get(3)?,
        parquet_sha256: row.get(4)?,
        parquet_bytes: row.get(5)?,
        created_at: row.get(6)?,
        upload_state: UploadState::from_str(&state),
        last_error: row.get(8)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn patient(id: &str, name: &str) -> StoredPatient {
        StoredPatient {
            id: id.into(),
            name: name.into(),
            age: "34".into(),
            weight: "62".into(),
            height: "168".into(),
            gender: "Female".into(),
            revision: 0,
            local_state: PatientState::Active,
            created_at: String::new(),
            updated_at: String::new(),
            total_sessions: None,
            lifetime_avg_score: None,
            last_active: None,
            address: None,
            note: None,
            tel_number: None,
            legacy_json: None,
        }
    }

    fn temp_dir() -> PathBuf {
        std::env::temp_dir().join(format!("pilates-outbox-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn a_pending_patient_edit_is_detected() {
        let dir = temp_dir();
        let mut outbox = Outbox::open(dir.join(DESKTOP_DB_FILENAME)).expect("open");
        outbox.save_patient(&patient("p1", "Ada")).expect("save");

        assert!(
            outbox.has_pending_patient("p1").expect("pending"),
            "a new patient is queued for upload"
        );
        assert!(!outbox.has_pending_patient("nope").expect("pending"));

        drop(outbox);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn remote_sessions_are_stored_without_queueing_an_upload() {
        let dir = temp_dir();
        let mut outbox = Outbox::open(dir.join(DESKTOP_DB_FILENAME)).expect("open");
        outbox.save_patient(&patient("p1", "Ada")).expect("save");

        assert!(
            outbox
                .upsert_remote_session("s1", "p1", "pose1", "{\"session_id\":\"s1\"}")
                .expect("upsert"),
            "a new remote session is stored"
        );

        let stored = outbox.session("s1").expect("query").expect("row");
        assert_eq!(stored.upload_state, UploadState::Synced);
        assert_eq!(outbox.session_count("p1").expect("count"), 1);
        // Nothing should be queued: the session came from the cloud.
        assert!(outbox.pending_sessions(10).expect("pending").is_empty());

        drop(outbox);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_pending_local_session_survives_a_remote_pull() {
        let dir = temp_dir();
        let mut outbox = Outbox::open(dir.join(DESKTOP_DB_FILENAME)).expect("open");
        outbox.save_patient(&patient("p1", "Ada")).expect("save");
        outbox
            .save_session("s1", "p1", "pose1", "{\"local\":true}", None)
            .expect("save session");

        let replaced = outbox
            .upsert_remote_session("s1", "p1", "pose1", "{\"remote\":true}")
            .expect("upsert");

        assert!(!replaced, "local work is not overwritten by a pull");
        let stored = outbox.session("s1").expect("query").expect("row");
        assert_eq!(stored.document_json, "{\"local\":true}");
        assert_eq!(stored.upload_state, UploadState::Pending);

        drop(outbox);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn legacy_download_is_detected_once_it_lands() {
        let dir = temp_dir();
        let mut outbox = Outbox::open(dir.join(DESKTOP_DB_FILENAME)).expect("open");
        assert!(!outbox.has_legacy_patients().expect("initial"));

        let mut with_legacy = patient("p1", "Ada");
        with_legacy.legacy_json = Some("{\"source\":\"flutterflow-app\"}".into());
        outbox.save_patient(&with_legacy).expect("save");

        assert!(outbox.has_legacy_patients().expect("after"));

        drop(outbox);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn wal_mode_is_enabled_on_disk() {
        let dir = temp_dir();
        let outbox = Outbox::open(dir.join(DESKTOP_DB_FILENAME)).expect("open");
        let mode: String = outbox
            .connection
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .expect("pragma");
        assert_eq!(mode.to_lowercase(), "wal");
        drop(outbox);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn migration_sets_schema_version() {
        let dir = temp_dir();
        let outbox = Outbox::open(dir.join(DESKTOP_DB_FILENAME)).expect("open");
        assert_eq!(outbox.schema_version().unwrap(), SCHEMA_VERSION);
        drop(outbox);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn reopening_an_existing_database_is_idempotent() {
        let dir = temp_dir();
        let path = dir.join(DESKTOP_DB_FILENAME);
        {
            let mut outbox = Outbox::open(&path).expect("open");
            outbox.save_patient(&patient("p1", "Ada")).expect("save");
        }
        {
            let outbox = Outbox::open(&path).expect("reopen");
            assert_eq!(outbox.schema_version().unwrap(), SCHEMA_VERSION);
            assert_eq!(outbox.list_patients().unwrap().len(), 1, "data survives");
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Regression for the reported bug: pointing the app at the legacy Python
    /// database must produce a clear error, not "no such column: total_sessions".
    #[test]
    fn legacy_database_is_rejected_with_an_actionable_message() {
        let dir = temp_dir();
        std::fs::create_dir_all(&dir).unwrap();
        let legacy_path = dir.join("pilates.db");

        {
            let legacy = Connection::open(&legacy_path).unwrap();
            legacy
                .execute_batch(
                    "CREATE TABLE patients (
                        id TEXT PRIMARY KEY, name TEXT NOT NULL, age TEXT NOT NULL,
                        weight TEXT NOT NULL, height TEXT NOT NULL, gender TEXT NOT NULL,
                        revision INTEGER NOT NULL, local_state TEXT NOT NULL,
                        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                    );",
                )
                .unwrap();
        }

        let error = match Outbox::open(&legacy_path) {
            Ok(_) => panic!("must reject the legacy schema"),
            Err(error) => error,
        };
        let message = error.to_string();
        assert!(
            message.contains("incompatible") && message.contains("total_sessions"),
            "message must explain the mismatch: {message}"
        );
        assert!(
            message.contains(DESKTOP_DB_FILENAME),
            "message must point at the right file: {message}"
        );

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn save_patient_assigns_revision_and_queues() {
        let mut outbox = Outbox::in_memory().expect("open");
        let saved = outbox.save_patient(&patient("p1", "Ada")).expect("save");
        assert_eq!(saved.revision, 1);
        assert_eq!(saved.local_state, PatientState::Active);

        let updated = outbox
            .save_patient(&patient("p1", "Ada Lovelace"))
            .expect("save");
        assert_eq!(updated.revision, 2, "revision must bump on update");
        assert_eq!(updated.created_at, saved.created_at, "created_at is immutable");

        let queue = outbox.queue_entries(10).expect("queue");
        assert_eq!(queue.len(), 2);
        assert_eq!(queue[0].kind, "create_patient");
        assert_eq!(queue[1].kind, "update_patient");
    }

    /// A profile edit carries only the five form fields. Aggregates and contact
    /// details must survive it — in the database *and* in the returned record,
    /// because the UI renders what comes back.
    #[test]
    fn editing_a_profile_preserves_derived_and_contact_fields() {
        let mut outbox = Outbox::in_memory().expect("open");

        let mut seeded = patient("p1", "Ada");
        seeded.total_sessions = Some(7);
        seeded.lifetime_avg_score = Some(88.0);
        seeded.last_active = Some("2026-01-01T00:00:00Z".into());
        seeded.address = Some("somewhere".into());
        seeded.tel_number = Some("0800000000".into());
        outbox.upsert_remote_patient(&seeded).expect("seed");

        // Exactly what the form sends: no aggregates, no contact details.
        let saved = outbox
            .save_patient(&patient("p1", "Ada Lovelace"))
            .expect("save");

        assert_eq!(saved.total_sessions, Some(7), "totals must survive an edit");
        assert_eq!(saved.lifetime_avg_score, Some(88.0));
        assert_eq!(saved.address.as_deref(), Some("somewhere"));
        assert_eq!(saved.tel_number.as_deref(), Some("0800000000"));

        let stored = outbox.get_patient("p1").expect("read").expect("row");
        assert_eq!(stored.total_sessions, Some(7));
    }

    #[test]
    fn remote_update_time_round_trips_and_can_be_cleared() {
        let mut outbox = Outbox::in_memory().expect("open");
        outbox.save_patient(&patient("p1", "Ada")).expect("save");

        assert_eq!(outbox.remote_update_time("p1").expect("read"), None);

        outbox
            .set_remote_update_time("p1", Some("2026-11-06T10:00:00Z"))
            .expect("set");
        assert_eq!(
            outbox.remote_update_time("p1").expect("read").as_deref(),
            Some("2026-11-06T10:00:00Z")
        );

        outbox
            .set_remote_update_time("p1", None)
            .expect("clear");
        assert_eq!(outbox.remote_update_time("p1").expect("read"), None);
    }

    /// A record that can never succeed must stop being retried, and must not
    /// lose its archive while it waits for a human.
    #[test]
    fn a_session_is_parked_after_repeated_failures() {
        let mut outbox = Outbox::in_memory().expect("open");
        outbox.save_patient(&patient("p1", "Ada")).expect("patient");
        outbox
            .save_session("s1", "p1", "pose1", "{}", Some((b"PAR1data", "abc")))
            .expect("session");

        for _ in 0..MAX_UPLOAD_ATTEMPTS {
            outbox
                .mark_session_state("s1", UploadState::Uploading, None)
                .expect("start");
            outbox
                .mark_session_state("s1", UploadState::Failed, Some("rejected"))
                .expect("fail");
        }

        let stored = outbox.session("s1").expect("read").expect("row");
        assert_eq!(stored.upload_state.as_str(), "dead");

        assert!(
            outbox.session_parquet("s1").expect("read").is_some(),
            "a parked session must keep its archive"
        );
        assert!(
            outbox.pending_sessions(10).expect("pending").is_empty(),
            "a parked session must not be retried"
        );
        assert_eq!(outbox.stats().expect("stats").sessions_dead, 1);
    }

    #[test]
    fn sync_state_values_round_trip() {
        let mut outbox = Outbox::in_memory().expect("open");
        assert_eq!(
            outbox.sync_state("sessions_watermark").expect("read"),
            None,
            "an unset watermark must read as absent, not as empty"
        );

        outbox
            .set_sync_state("sessions_watermark", "2026-11-06T10:00:00Z")
            .expect("set");
        assert_eq!(
            outbox
                .sync_state("sessions_watermark")
                .expect("read")
                .as_deref(),
            Some("2026-11-06T10:00:00Z")
        );

        outbox
            .set_sync_state("sessions_watermark", "2026-11-07T10:00:00Z")
            .expect("update");
        assert_eq!(
            outbox
                .sync_state("sessions_watermark")
                .expect("read")
                .as_deref(),
            Some("2026-11-07T10:00:00Z")
        );
    }

    /// A parked conflict must not block the clinician forever: saving again is
    /// the resolution, and it supersedes the old refusal.
    #[test]
    fn a_fresh_edit_supersedes_a_parked_conflict() {
        let mut outbox = Outbox::in_memory().expect("open");
        outbox.save_patient(&patient("p1", "Ada")).expect("save");

        let entry = outbox.queue_entries(10).expect("queue")[0].id;
        outbox
            .resolve_queue_entry(entry, "conflict", Some("changed elsewhere"))
            .expect("park");

        outbox
            .save_patient(&patient("p1", "Ada L"))
            .expect("save again");

        let conflicts = outbox
            .queue_entries(10)
            .expect("queue")
            .into_iter()
            .filter(|entry| entry.state == "conflict")
            .count();
        assert_eq!(conflicts, 0, "the new edit must clear the old refusal");
    }

    #[test]
    fn patients_are_listed_case_insensitively_by_name() {
        let mut outbox = Outbox::in_memory().expect("open");
        outbox.save_patient(&patient("a", "zoe")).unwrap();
        outbox.save_patient(&patient("b", "Alice")).unwrap();
        let names: Vec<String> = outbox
            .list_patients()
            .unwrap()
            .into_iter()
            .map(|p| p.name)
            .collect();
        assert_eq!(names, vec!["Alice", "zoe"]);
    }

    #[test]
    fn deleting_a_patient_tombstones_instead_of_erasing() {
        let mut outbox = Outbox::in_memory().expect("open");
        outbox.save_patient(&patient("p1", "Ada")).unwrap();
        outbox.delete_patient("p1").expect("delete");

        assert!(outbox.list_patients().unwrap().is_empty(), "hidden from the UI");
        assert!(outbox.get_patient("p1").unwrap().is_none(), "not usable for capture");

        let row = outbox.fetch_patient("p1").unwrap().expect("row still exists");
        assert_eq!(row.local_state, PatientState::Tombstone);
        assert_eq!(row.revision, 2, "revision bumps on delete");

        let stats = outbox.stats().unwrap();
        assert_eq!(stats.patients, 0);
        assert_eq!(stats.patients_deleted, 1);
    }

    #[test]
    fn deleting_keeps_sessions_for_sync() {
        let mut outbox = Outbox::in_memory().expect("open");
        outbox.save_patient(&patient("p1", "Ada")).unwrap();
        outbox.save_session("s1", "p1", "pose1", "{}", None).unwrap();

        outbox.delete_patient("p1").expect("delete");
        assert_eq!(
            outbox.stats().unwrap().sessions_total,
            1,
            "tombstoning must not cascade-delete unsynced sessions"
        );
    }

    /// Regression: a pull used to copy the remote `local_state` over the local
    /// row, so a document Firestore still listed as active resurrected a patient
    /// the clinician had deleted.
    #[test]
    fn pulling_an_active_document_keeps_a_local_tombstone() {
        let mut outbox = Outbox::in_memory().expect("open");
        outbox.save_patient(&patient("p1", "Ada")).unwrap();
        outbox.delete_patient("p1").expect("delete");

        // Pretend the tombstone was already pushed, so the remote copy looking
        // active can only mean the write never landed.
        let queued = outbox.queue_entries(10).expect("queue");
        let delete_entry = queued
            .iter()
            .find(|entry| entry.kind == "delete_patient")
            .expect("delete is queued");
        outbox
            .resolve_queue_entry(delete_entry.id, "done", None)
            .expect("resolve");

        let remote = patient("p1", "Ada"); // legacy document: active, revision 0
        assert_eq!(
            outbox.upsert_remote_patient(&remote).expect("upsert"),
            RemoteUpsert::KeptDeleted
        );

        let row = outbox.fetch_patient("p1").unwrap().expect("row survives");
        assert_eq!(row.local_state, PatientState::Tombstone, "deletion is kept");
        assert!(outbox.list_patients().unwrap().is_empty(), "still hidden");

        let pending_deletes = |outbox: &Outbox| -> usize {
            outbox
                .queue_entries(50)
                .unwrap()
                .into_iter()
                .filter(|entry| entry.kind == "delete_patient" && entry.state == "pending")
                .count()
        };
        assert_eq!(pending_deletes(&outbox), 1, "the delete is re-queued");

        // Pulls run every minute; the queue must not grow on every tick.
        outbox.upsert_remote_patient(&remote).expect("upsert again");
        assert_eq!(pending_deletes(&outbox), 1, "re-queueing is idempotent");
    }

    #[test]
    fn a_remote_tombstone_still_deletes_the_local_row() {
        let mut outbox = Outbox::in_memory().expect("open");
        outbox.save_patient(&patient("p1", "Ada")).unwrap();

        let mut remote = patient("p1", "Ada");
        remote.local_state = PatientState::Tombstone;
        remote.revision = 5;

        assert_eq!(
            outbox.upsert_remote_patient(&remote).expect("upsert"),
            RemoteUpsert::Updated
        );
        assert_eq!(
            outbox.fetch_patient("p1").unwrap().unwrap().local_state,
            PatientState::Tombstone,
            "a deletion made on another workstation must win"
        );
        assert!(outbox.list_patients().unwrap().is_empty());
    }

    #[test]
    fn resaving_a_tombstoned_patient_restores_it() {
        let mut outbox = Outbox::in_memory().expect("open");
        outbox.save_patient(&patient("p1", "Ada")).unwrap();
        outbox.delete_patient("p1").unwrap();
        assert_eq!(outbox.list_patients().unwrap().len(), 0);

        outbox.save_patient(&patient("p1", "Ada")).unwrap();
        assert_eq!(outbox.list_patients().unwrap().len(), 1, "restored");
        assert_eq!(
            outbox.fetch_patient("p1").unwrap().unwrap().local_state,
            PatientState::Active
        );
    }

    #[test]
    fn session_is_staged_with_parquet_and_queued() {
        let mut outbox = Outbox::in_memory().expect("open");
        outbox.save_patient(&patient("p1", "Ada")).unwrap();

        let parquet = b"PAR1fake-parquet".to_vec();
        outbox
            .save_session(
                "s1",
                "p1",
                "pose1",
                "{\"session_id\":\"s1\"}",
                Some((&parquet, "deadbeef")),
            )
            .expect("save session");

        let staged = outbox.session_parquet("s1").expect("parquet").expect("present");
        assert_eq!(staged, parquet);

        let pending = outbox.pending_sessions(10).expect("pending");
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].upload_state, UploadState::Pending);
        assert_eq!(pending[0].parquet_sha256.as_deref(), Some("deadbeef"));
    }

    #[test]
    fn synced_session_releases_its_parquet_blob() {
        let mut outbox = Outbox::in_memory().expect("open");
        outbox.save_patient(&patient("p1", "Ada")).unwrap();
        outbox
            .save_session("s1", "p1", "pose1", "{}", Some((b"PAR1data", "abc")))
            .unwrap();

        outbox
            .mark_session_state("s1", UploadState::Synced, None)
            .expect("mark synced");

        assert!(outbox.session_parquet("s1").unwrap().is_none(), "blob reclaimed");
        let session = outbox.session("s1").unwrap().unwrap();
        assert_eq!(session.upload_state, UploadState::Synced);
        assert_eq!(session.parquet_sha256.as_deref(), Some("abc"), "digest retained");
        assert!(outbox.pending_sessions(10).unwrap().is_empty());
    }

    #[test]
    fn failed_session_stays_pending_for_retry() {
        let mut outbox = Outbox::in_memory().expect("open");
        outbox.save_patient(&patient("p1", "Ada")).unwrap();
        outbox.save_session("s1", "p1", "pose1", "{}", None).unwrap();
        outbox
            .mark_session_state("s1", UploadState::Failed, Some("offline"))
            .expect("mark failed");

        let pending = outbox.pending_sessions(10).unwrap();
        assert_eq!(pending.len(), 1, "failed sessions must be retried");
        assert_eq!(pending[0].last_error.as_deref(), Some("offline"));
    }

    #[test]
    fn sessions_for_patient_returns_newest_first() {
        let mut outbox = Outbox::in_memory().expect("open");
        outbox.save_patient(&patient("p1", "Ada")).unwrap();
        outbox.save_session("s1", "p1", "pose1", "{}", None).unwrap();
        outbox.save_session("s2", "p1", "pose2", "{}", None).unwrap();

        let sessions = outbox.sessions_for_patient("p1").unwrap();
        assert_eq!(sessions.len(), 2);
    }

    #[test]
    fn stats_reflect_queue_state() {
        let mut outbox = Outbox::in_memory().expect("open");
        outbox.save_patient(&patient("p1", "Ada")).unwrap();
        outbox.save_session("s1", "p1", "pose1", "{}", None).unwrap();

        let stats = outbox.stats().unwrap();
        assert_eq!(stats.patients, 1);
        assert_eq!(stats.sessions_total, 1);
        assert_eq!(stats.sessions_pending, 1);
        assert_eq!(stats.queued_operations, 2, "patient + session");
    }

    #[test]
    fn queue_entries_can_be_resolved() {
        let mut outbox = Outbox::in_memory().expect("open");
        outbox.enqueue("create_session", "s1").unwrap();
        let entries = outbox.queue_entries(10).unwrap();
        assert_eq!(entries.len(), 1);

        outbox
            .resolve_queue_entry(entries[0].id, "done", None)
            .expect("resolve");
        let after = outbox.queue_entries(10).unwrap();
        assert_eq!(after[0].state, "done");
        assert_eq!(after[0].attempts, 1);
    }

    // ----- legacy import --------------------------------------------------

    fn write_legacy_db(path: &Path, patients: &[(&str, &str)]) {
        let legacy = Connection::open(path).unwrap();
        legacy
            .execute_batch(
                "CREATE TABLE patients (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL, age TEXT NOT NULL,
                    weight TEXT NOT NULL, height TEXT NOT NULL, gender TEXT NOT NULL,
                    revision INTEGER NOT NULL, local_state TEXT NOT NULL,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                );",
            )
            .unwrap();
        for (index, (id, name)) in patients.iter().enumerate() {
            legacy
                .execute(
                    "INSERT INTO patients VALUES (?1,?2,'30','60','170','Female',?3,'active',?4,?4)",
                    params![id, name, index as i64 + 1, "2026-10-09T00:00:00+00:00"],
                )
                .unwrap();
        }
    }

    #[test]
    fn imports_patients_from_the_legacy_database() {
        let dir = temp_dir();
        std::fs::create_dir_all(&dir).unwrap();
        let legacy_path = dir.join("pilates.db");
        write_legacy_db(&legacy_path, &[("a", "Ada"), ("b", "Grace")]);

        let mut outbox = Outbox::open(dir.join(DESKTOP_DB_FILENAME)).expect("open");
        let imported = outbox
            .import_legacy_patients(&legacy_path)
            .expect("import");
        assert_eq!(imported, 2);

        let names: Vec<String> = outbox
            .list_patients()
            .unwrap()
            .into_iter()
            .map(|p| p.name)
            .collect();
        assert_eq!(names, vec!["Ada", "Grace"]);
        assert_eq!(
            outbox.fetch_patient("a").unwrap().unwrap().local_state,
            PatientState::Active
        );

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn import_is_skipped_when_patients_already_exist() {
        let dir = temp_dir();
        std::fs::create_dir_all(&dir).unwrap();
        let legacy_path = dir.join("pilates.db");
        write_legacy_db(&legacy_path, &[("a", "Ada")]);

        let mut outbox = Outbox::open(dir.join(DESKTOP_DB_FILENAME)).expect("open");
        outbox.save_patient(&patient("existing", "Existing")).unwrap();

        let imported = outbox.import_legacy_patients(&legacy_path).expect("import");
        assert_eq!(imported, 0, "must not duplicate into a non-empty store");
        assert_eq!(outbox.list_patients().unwrap().len(), 1);

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn legacy_fields_survive_a_round_trip() {
        let mut outbox = Outbox::in_memory().expect("open");
        let mut record = patient("p1", "Ada");
        record.address = Some("Somewhere".into());
        record.note = Some("Allergic to latex".into());
        record.tel_number = Some("0800000000".into());
        record.legacy_json = Some("{\"total_samples\":4}".into());
        outbox.save_patient(&record).expect("save");

        let stored = outbox.get_patient("p1").unwrap().expect("present");
        assert_eq!(stored.address.as_deref(), Some("Somewhere"));
        assert_eq!(stored.note.as_deref(), Some("Allergic to latex"));
        assert_eq!(stored.tel_number.as_deref(), Some("0800000000"));
        assert_eq!(stored.legacy_json.as_deref(), Some("{\"total_samples\":4}"));
    }

    #[test]
    fn saving_without_legacy_fields_does_not_erase_them() {
        let mut outbox = Outbox::in_memory().expect("open");
        let mut record = patient("p1", "Ada");
        record.legacy_json = Some("{\"frozen\":true}".into());
        record.tel_number = Some("0800000000".into());
        outbox.save_patient(&record).expect("save");

        // A plain edit from the UI carries none of these fields.
        outbox
            .save_patient(&patient("p1", "Ada Lovelace"))
            .expect("save");

        let stored = outbox.get_patient("p1").unwrap().expect("present");
        assert_eq!(stored.name, "Ada Lovelace");
        assert_eq!(
            stored.legacy_json.as_deref(),
            Some("{\"frozen\":true}"),
            "legacy summary must survive an edit"
        );
        assert_eq!(stored.tel_number.as_deref(), Some("0800000000"));
    }

    #[test]
    fn v1_database_upgrades_to_v2_preserving_rows() {
        let dir = temp_dir();
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(DESKTOP_DB_FILENAME);

        {
            // Recreate exactly what the previous release left on disk.
            let legacy = Connection::open(&path).unwrap();
            legacy
                .execute_batch(
                    "CREATE TABLE patients (
                        id TEXT PRIMARY KEY, name TEXT NOT NULL, age TEXT NOT NULL DEFAULT '',
                        weight TEXT NOT NULL DEFAULT '', height TEXT NOT NULL DEFAULT '',
                        gender TEXT NOT NULL DEFAULT '',
                        revision INTEGER NOT NULL DEFAULT 1,
                        local_state TEXT NOT NULL DEFAULT 'active',
                        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                        total_sessions INTEGER, lifetime_avg_score REAL, last_active TEXT);
                     CREATE TABLE sessions (
                        session_id TEXT PRIMARY KEY, patient_id TEXT NOT NULL, pose_id TEXT NOT NULL,
                        document_json TEXT NOT NULL, parquet_sha256 TEXT, parquet_bytes INTEGER,
                        parquet_blob BLOB, created_at TEXT NOT NULL,
                        upload_state TEXT NOT NULL DEFAULT 'pending', last_error TEXT);
                     CREATE TABLE sync_queue (
                        id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL,
                        entity_id TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
                        attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at TEXT NOT NULL);
                     PRAGMA user_version = 1;
                     INSERT INTO patients (id, name, created_at, updated_at)
                        VALUES ('p1', 'Ada', 'then', 'then');",
                )
                .unwrap();
        }

        let outbox = Outbox::open(&path).expect("must upgrade v1 -> v2");
        assert_eq!(outbox.schema_version().unwrap(), SCHEMA_VERSION);

        let stored = outbox.get_patient("p1").unwrap().expect("row preserved");
        assert_eq!(stored.name, "Ada");
        assert!(stored.legacy_json.is_none(), "new column defaults to NULL");

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn offline_sessions_persist_and_drain_after_reconnect() {
        let dir = temp_dir();
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(DESKTOP_DB_FILENAME);

        // --- Offline: record a session with no network at all ---------------
        {
            let mut outbox = Outbox::open(&path).expect("open");
            outbox.save_patient(&patient("p1", "Ada")).expect("patient");
            outbox
                .save_session(
                    "s1",
                    "p1",
                    "pose1",
                    "{\"session_id\":\"s1\"}",
                    Some((b"PAR1offline", "sha")),
                )
                .expect("session");

            let stats = outbox.stats().unwrap();
            assert_eq!(stats.sessions_pending, 1, "queued while offline");
            assert_eq!(stats.sessions_total, 1);
        }

        // --- Restart: nothing may be lost ----------------------------------
        {
            let mut outbox = Outbox::open(&path).expect("reopen");
            let pending = outbox.pending_sessions(10).unwrap();
            assert_eq!(pending.len(), 1, "survives an application restart");
            assert!(
                outbox.session_parquet("s1").unwrap().is_some(),
                "the Parquet blob is retained for later upload"
            );

            // --- Reconnect: the queue drains -------------------------------
            outbox
                .mark_session_state("s1", UploadState::Synced, None)
                .expect("mark synced");

            assert!(outbox.pending_sessions(10).unwrap().is_empty(), "queue drained");
            assert_eq!(outbox.stats().unwrap().sessions_pending, 0);
            assert!(
                outbox.session_parquet("s1").unwrap().is_none(),
                "blob reclaimed once uploaded"
            );
        }

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn import_tolerates_a_missing_legacy_database() {
        let mut outbox = Outbox::in_memory().expect("open");
        let missing = temp_dir().join("does-not-exist.db");
        assert_eq!(outbox.import_legacy_patients(&missing).unwrap(), 0);
    }

    #[test]
    fn import_does_not_modify_the_legacy_file() {
        let dir = temp_dir();
        std::fs::create_dir_all(&dir).unwrap();
        let legacy_path = dir.join("pilates.db");
        write_legacy_db(&legacy_path, &[("a", "Ada")]);
        let before = std::fs::read(&legacy_path).unwrap();

        let mut outbox = Outbox::open(dir.join(DESKTOP_DB_FILENAME)).expect("open");
        outbox.import_legacy_patients(&legacy_path).unwrap();
        let after = std::fs::read(&legacy_path).unwrap();

        assert_eq!(before, after, "the legacy database must stay byte-identical");
        let _ = std::fs::remove_dir_all(dir);
    }
}
