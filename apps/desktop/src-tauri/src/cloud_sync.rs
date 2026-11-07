//! Dual-tier cloud sync (Step 6).
//!
//! * **Tier 1 (Firestore, hot):** the `ClinicalSessionDocument` is written once
//!   per session to `patients/{patientId}/sessions/{sessionId}`.
//! * **Tier 2 (Cloud Storage, cold):** the Snappy Parquet blob is uploaded to
//!   `telemetry/{patientId}/{sessionId}.parquet` via the Firebase Storage REST
//!   API, which is GCS-backed.
//!
//! Both use a Firebase ID token obtained by signing a clinic account in with
//! the Identity Toolkit REST API — no service-account key is ever shipped to a
//! clinic workstation, which would be a credential-leak risk.
//!
//! Everything here is *optional*: when the config is absent the app stays fully
//! functional offline and the [`crate::outbox::Outbox`] keeps staging work.

use std::time::Duration;

use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::error::{EngineError, EngineResult};
use crate::outbox::{Outbox, PatientState, RemoteUpsert, StoredPatient, UploadState};

const AUTH_ENDPOINT: &str = "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword";
const FIRESTORE_BASE: &str = "https://firestore.googleapis.com/v1";
const STORAGE_BASE: &str = "https://firebasestorage.googleapis.com/v0/b";

/// Key under which the highest downloaded session timestamp is stored.
const SESSIONS_WATERMARK: &str = "sessions_watermark";

/// Everything needed to talk to the clinic's Firebase project.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudConfig {
    pub project_id: String,
    pub api_key: String,
    #[serde(default)]
    pub bucket: String,
    pub email: String,
    pub password: String,
}

impl CloudConfig {
    /// Resolve configuration from `cloud.json`, falling back to environment
    /// variables only when no file exists.
    ///
    /// The file wins deliberately. A desktop app is normally started from
    /// Explorer, and Explorer keeps the environment block it received at logon:
    /// a `PILATES_CLINIC_*` value set (or changed) later is never seen by it,
    /// while the copy it *does* hold is inherited by every app it launches. That
    /// silently resurrects an old account after the operator edits the file —
    /// the exact failure this ordering prevents.
    ///
    /// Environment variables remain supported for CI and for workstations
    /// without a config file.
    pub fn load() -> Option<Self> {
        if let Some(config) = Self::from_file() {
            return Some(config);
        }
        if let Some(config) = Self::from_env() {
            eprintln!("[pilates] cloud config loaded from PILATES_* environment variables");
            return Some(config);
        }
        None
    }

    /// Read the first usable `cloud.json` from the documented locations.
    fn from_file() -> Option<Self> {
        let mut candidates: Vec<std::path::PathBuf> = Vec::new();
        // `paths::data_dir` already honours `PILATES_AI_DATA_DIR`, and keeps
        // the Windows location that 2.0.0 installations already use.
        candidates.push(crate::paths::data_dir().join("cloud.json"));
        if let Some(path) = crate::pose_config::find_config_file("cloud.json") {
            candidates.push(path);
        }

        for path in candidates {
            // Tolerate a UTF-8 BOM: a clinic administrator editing cloud.json
            // on Windows gets one from Notepad or `Set-Content -Encoding utf8`,
            // and serde_json would reject the whole file.
            let Ok(text) = crate::pose_config::read_config_text(&path) else {
                continue;
            };
            match serde_json::from_str::<CloudConfig>(&text) {
                Ok(config) if !config.api_key.is_empty() && !config.project_id.is_empty() => {
                    eprintln!("[pilates] cloud config loaded from {}", path.display());
                    return Some(config);
                }
                Ok(_) => eprintln!("[pilates] {} is missing project_id/api_key", path.display()),
                Err(error) => eprintln!("[pilates] {} is invalid: {error}", path.display()),
            }
        }
        None
    }

    /// Read configuration from the environment.
    ///
    /// `PILATES_FIREBASE_BUCKET` is optional: Firestore reads and writes work
    /// without it, so a clinic can pull its patient roster before Storage has
    /// been provisioned. Only the Parquet archive needs a bucket.
    ///
    /// Returns `None` when the deployment is intentionally offline-only.
    pub fn from_env() -> Option<Self> {
        let project_id = std::env::var("PILATES_FIREBASE_PROJECT_ID").ok()?;
        let api_key = std::env::var("PILATES_FIREBASE_API_KEY").ok()?;
        let email = std::env::var("PILATES_CLINIC_EMAIL").ok()?;
        let password = std::env::var("PILATES_CLINIC_PASSWORD").ok()?;
        let bucket = std::env::var("PILATES_FIREBASE_BUCKET").unwrap_or_default();

        if project_id.is_empty() || api_key.is_empty() || email.is_empty() || password.is_empty() {
            return None;
        }
        Some(Self {
            project_id,
            api_key,
            bucket,
            email,
            password,
        })
    }
}

/// Outcome of draining the outbox.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SyncReport {
    pub attempted: usize,
    pub synced: usize,
    pub failed: usize,
    pub errors: Vec<String>,
    /// False when no cloud credentials are configured.
    pub enabled: bool,
    /// Patient documents pushed during this run.
    pub patients_synced: usize,
    /// Writes refused because another workstation edited the document first.
    /// These are parked, not retried, until the clinician re-saves.
    pub conflicts: usize,
}

/// Outcome of pulling the patient roster from Firestore.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PullReport {
    pub fetched: usize,
    pub imported: usize,
    pub updated: usize,
    /// Rows deleted on this workstation that Firestore still lists as active.
    /// Their deletion was preserved and the pending delete re-queued.
    pub kept_deleted: usize,
    /// Session documents downloaded from Firestore this run.
    pub sessions_imported: usize,
    /// Patients skipped because this workstation still has unsynced edits.
    pub skipped_pending: usize,
    pub enabled: bool,
}

/// One dated clinical comment on a patient.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommentRecord {
    pub id: String,
    pub text: String,
    /// RFC 3339; empty when the document predates this field.
    pub created_at: String,
}

/// A patient document as it exists in Firestore.
#[derive(Debug, Clone, PartialEq)]
pub struct RemotePatient {
    pub id: String,
    pub name: String,
    pub age: String,
    pub weight: String,
    pub height: String,
    pub gender: String,
    pub revision: i64,
    pub local_state: PatientState,
    pub total_sessions: Option<i64>,
    pub lifetime_avg_score: Option<f64>,
    pub last_active: Option<String>,
    /// Contact details that only exist in Firestore.
    pub address: Option<String>,
    pub note: Option<String>,
    pub tel_number: Option<String>,
    /// Frozen FlutterFlow-era statistics (JSON), materialised out of band.
    pub legacy_json: Option<String>,
    /// Firestore's own `updateTime` for the document, used as the
    /// optimistic-concurrency baseline for the next write.
    pub update_time: Option<String>,
}

/// Fields this application owns on a patient document.
///
/// `address`, `note`, `tel_number` and the legacy `pose{N}_*` aggregates are
/// deliberately **absent**: writes use an explicit `updateMask`, so any field
/// not listed here is preserved untouched in Firestore.
///
/// The derived aggregates (`total_sessions`, `lifetime_avg_score`,
/// `last_active`) are absent too, and that is a correctness rule rather than a
/// tidy-up: they belong to the Cloud Function. A workstation that echoed the
/// copy it read minutes ago would undo a newer aggregate.
const OWNED_PATIENT_FIELDS: [&str; 9] = [
    "name",
    "age",
    "weight",
    "height",
    "gender",
    "revision",
    "local_state",
    "last_origin",
    "updated_by",
];

/// Stable identifier for this installation.
///
/// Written onto every document this workstation creates, so the change marker
/// can tell "someone else changed something" apart from "I just uploaded it".
/// A missing or unreadable file simply yields a fresh id: the worst case is one
/// redundant pull.
pub fn patient_origin() -> String {
    let dir = crate::paths::data_dir();
    let path = dir.join("instance-id");

    if let Ok(existing) = std::fs::read_to_string(&path) {
        let trimmed = existing.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }

    let id = uuid::Uuid::new_v4().to_string();
    if std::fs::create_dir_all(&dir).is_ok() {
        let _ = std::fs::write(&path, &id);
    }
    id
}

/// Patient fields the desktop reads on every pull. `legacy_json` is absent
/// because it is downloaded once and never changes.
const PATIENT_SYNC_FIELDS: [&str; 13] = [
    "name",
    "age",
    "weight",
    "height",
    "gender",
    "revision",
    "local_state",
    "total_sessions",
    "lifetime_avg_score",
    "last_active",
    "address",
    "note",
    "tel_number",
];

/// Convert a Firestore typed value back into plain JSON.
fn firestore_value_to_json(value: &Value) -> Value {
    if let Some(text) = value.get("stringValue").and_then(Value::as_str) {
        return Value::String(text.to_string());
    }
    if let Some(integer) = value.get("integerValue").and_then(Value::as_str) {
        if let Ok(parsed) = integer.parse::<i64>() {
            return json!(parsed);
        }
    }
    if let Some(number) = value.get("doubleValue").and_then(Value::as_f64) {
        return json!(number);
    }
    if let Some(flag) = value.get("booleanValue").and_then(Value::as_bool) {
        return json!(flag);
    }
    if value.get("nullValue").is_some() {
        return Value::Null;
    }
    if let Some(fields) = value
        .get("mapValue")
        .and_then(|inner| inner.get("fields"))
        .and_then(Value::as_object)
    {
        let mut object = Map::new();
        for (key, child) in fields {
            object.insert(key.clone(), firestore_value_to_json(child));
        }
        return Value::Object(object);
    }
    if let Some(values) = value
        .get("arrayValue")
        .and_then(|inner| inner.get("values"))
        .and_then(Value::as_array)
    {
        return Value::Array(values.iter().map(firestore_value_to_json).collect());
    }
    Value::Null
}

/// Build the Firestore body + update mask for a patient write.
///
/// The derived aggregates are **never** included, in body or mask. They are
/// owned by the Cloud Function, and a workstation echoing the copy it read
/// minutes ago would undo a newer aggregate. Omitting them entirely makes that
/// impossible rather than merely unlikely.
///
/// The contact fields (`address`, `note`, `tel_number`) are included **only
/// when this workstation knows a value**. The clinician can edit them, so they
/// must reach Firestore — but a workstation that has never pulled would
/// otherwise push an empty string and wipe an address that only exists in the
/// legacy records. Absent means "not mine to say", not "cleared".
pub fn patient_document_body(patient: &StoredPatient) -> (Value, Vec<String>) {
    let origin = patient_origin();

    let mut document = json!({
        "name": patient.name,
        "age": patient.age,
        "weight": patient.weight,
        "height": patient.height,
        "gender": patient.gender,
        "revision": patient.revision,
        "local_state": patient.local_state.as_str(),
        // Consumed by the `onPatientWritten` trigger to attribute the change
        // and to suppress the writer's own echo.
        "last_origin": origin.clone(),
        // The same value today, kept separately so a future per-user audit
        // field can diverge from the echo-suppression id without a migration.
        "updated_by": origin,
    });

    let mut mask: Vec<String> = OWNED_PATIENT_FIELDS.iter().map(|f| f.to_string()).collect();

    for (name, value) in [
        ("address", &patient.address),
        ("note", &patient.note),
        ("tel_number", &patient.tel_number),
    ] {
        if let Some(text) = value {
            document[name] = json!(text);
            mask.push(name.to_string());
        }
    }

    (document, mask)
}

fn read_string(fields: &Map<String, Value>, key: &str) -> String {
    fields
        .get(key)
        .and_then(|value| value.get("stringValue"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// Read an optional string field; absent or empty values become `None`.
fn optional_string(fields: &Map<String, Value>, key: &str) -> Option<String> {
    fields
        .get(key)
        .and_then(|value| value.get("stringValue"))
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn read_integer(fields: &Map<String, Value>, key: &str) -> Option<i64> {
    let value = fields.get(key)?;
    if let Some(raw) = value.get("integerValue") {
        return raw.as_str().and_then(|s| s.parse().ok());
    }
    value.get("doubleValue").and_then(Value::as_f64).map(|f| f as i64)
}

fn read_double(fields: &Map<String, Value>, key: &str) -> Option<f64> {
    let value = fields.get(key)?;
    if let Some(raw) = value.get("doubleValue").and_then(Value::as_f64) {
        return Some(raw);
    }
    value
        .get("integerValue")
        .and_then(Value::as_str)
        .and_then(|s| s.parse::<f64>().ok())
}

/// Parse a Firestore patient document.
///
/// Existing production documents predate this application: they carry no
/// `revision`, no timestamps, and use Firestore auto-IDs rather than UUIDs.
/// Those are tolerated here rather than rejected.
pub fn parse_remote_patient(document: &Value) -> Option<RemotePatient> {
    let id = document
        .get("name")
        .and_then(Value::as_str)
        .and_then(|name| name.rsplit('/').next())
        .filter(|id| !id.is_empty())?
        .to_string();

    let fields = document.get("fields")?.as_object()?;
    let name = read_string(fields, "name");
    if name.is_empty() {
        return None;
    }

    let local_state = match read_string(fields, "local_state").as_str() {
        "tombstone" => PatientState::Tombstone,
        _ => PatientState::Active,
    };

    Some(RemotePatient {
        id,
        name,
        age: read_string(fields, "age"),
        weight: read_string(fields, "weight"),
        height: read_string(fields, "height"),
        gender: read_string(fields, "gender"),
        revision: read_integer(fields, "revision").unwrap_or(0),
        local_state,
        total_sessions: read_integer(fields, "total_sessions"),
        lifetime_avg_score: read_double(fields, "lifetime_avg_score"),
        last_active: fields
            .get("last_active")
            .and_then(|v| v.get("stringValue"))
            .and_then(Value::as_str)
            .map(str::to_string),
        address: optional_string(fields, "address"),
        note: optional_string(fields, "note"),
        tel_number: optional_string(fields, "tel_number"),
        legacy_json: optional_string(fields, "legacy_json"),
        // `updateTime` sits beside `fields`, not inside it.
        update_time: document
            .get("updateTime")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

/// A token plus its absolute expiry.
#[derive(Debug, Clone)]
struct IdToken {
    value: String,
    expires_at: std::time::Instant,
}

#[derive(Debug, Deserialize)]
struct SignInResponse {
    #[serde(rename = "idToken")]
    id_token: String,
    #[serde(rename = "expiresIn")]
    expires_in: String,
}

/// Firestore-ready document writer + Storage uploader.
pub struct CloudSync {
    client: Client,
    config: CloudConfig,
    token: Option<IdToken>,
    /// Consecutive failed sign-ins; drives the backoff below.
    auth_failures: u32,
    /// While set, sign-in is refused locally instead of hitting the endpoint.
    ///
    /// Firebase locks an account after a burst of failed password attempts
    /// (`TOO_MANY_ATTEMPTS_TRY_LATER`), and the auto-sync loop retries every
    /// minute — so an unattended bad password escalates into a lockout that
    /// outlives the credential fix.
    auth_retry_after: Option<std::time::Instant>,
    /// When the session subcollections were last swept.
    ///
    /// A patient's `total_sessions` is maintained by the Cloud Function and
    /// can lag or read zero, so it is not a reliable "are there new
    /// sessions?" signal. Sweeping on a timer is correct and, at clinic
    /// scale, cheap.
    last_session_sweep: Option<std::time::Instant>,
    /// Highest change-marker revision already accounted for.
    last_marker_revision: Option<i64>,
    /// The message replayed while backing off.
    auth_error: Option<String>,
}

impl CloudSync {
    pub fn new(config: CloudConfig) -> EngineResult<Self> {
        let client = Client::builder()
            .timeout(Duration::from_secs(60))
            .build()
            .map_err(|e| EngineError::Sync(format!("http client: {e}")))?;
        Ok(Self {
            client,
            config,
            token: None,
            auth_failures: 0,
            auth_retry_after: None,
            last_session_sweep: None,
            last_marker_revision: None,
            auth_error: None,
        })
    }

    /// Build from the environment or `cloud.json`, or `None` when offline-only.
    pub fn load() -> EngineResult<Option<Self>> {
        match CloudConfig::load() {
            Some(config) => Self::new(config).map(Some),
            None => Ok(None),
        }
    }

    pub fn bucket(&self) -> &str {
        &self.config.bucket
    }

    /// True when a Cloud Storage bucket is configured for Parquet archival.
    ///
    /// Firestore reads and writes work without one, so the roster can be pulled
    /// before Storage has been provisioned.
    pub fn has_bucket(&self) -> bool {
        !self.config.bucket.is_empty()
    }

    /// Sign in (once) and cache the ID token until shortly before it expires.
    ///
    /// After a failure the next attempt is deferred (see `auth_retry_after`) so
    /// that a wrong password cannot turn into an account lockout.
    fn ensure_token(&mut self) -> EngineResult<String> {
        if let Some(token) = &self.token {
            if std::time::Instant::now() < token.expires_at {
                return Ok(token.value.clone());
            }
        }

        if let Some(retry_after) = self.auth_retry_after {
            if std::time::Instant::now() < retry_after {
                return Err(EngineError::Sync(
                    self.auth_error
                        .clone()
                        .unwrap_or_else(|| "sign-in paused after repeated failures".into()),
                ));
            }
        }

        // A paired workstation authenticates with its refresh token. The
        // password path stays for installations that predate pairing: they must
        // keep working after the upgrade with no re-pairing.
        if let Some(state) = crate::pairing::load_auth() {
            match crate::pairing::refresh_id_token(
                &self.client,
                &self.config.api_key,
                &state.refresh_token,
            ) {
                Ok((id_token, seconds)) => {
                    let ttl = seconds.saturating_sub(60).max(30);
                    self.token = Some(IdToken {
                        value: id_token.clone(),
                        expires_at: std::time::Instant::now() + Duration::from_secs(ttl),
                    });
                    self.auth_failures = 0;
                    self.auth_retry_after = None;
                    self.auth_error = None;
                    return Ok(id_token);
                }
                Err(error) => {
                    // A rejected token must not hide the patient list. Fall
                    // through to the password when one is configured; otherwise
                    // report degraded and let the caller keep working offline.
                    if self.config.email.trim().is_empty()
                        || self.config.password.trim().is_empty()
                    {
                        let message = error.to_string();
                        self.record_auth_failure(message.clone());
                        return Err(EngineError::Sync(message));
                    }
                }
            }
        }

        let response = self
            .client
            .post(format!("{AUTH_ENDPOINT}?key={}", self.config.api_key))
            .json(&json!({
                "email": self.config.email,
                "password": self.config.password,
                "returnSecureToken": true,
            }))
            .send()
            .map_err(|e| EngineError::Sync(format!("sign-in request failed: {e}")))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().unwrap_or_default();
            let message = sign_in_failure_message(status.as_u16(), &body, &self.config.email);
            self.record_auth_failure(message.clone());
            return Err(EngineError::Sync(message));
        }

        let parsed: SignInResponse = response
            .json()
            .map_err(|e| EngineError::Sync(format!("sign-in response: {e}")))?;

        let seconds: u64 = parsed.expires_in.parse().unwrap_or(3600);
        // Refresh a minute early to avoid racing an expiry mid-request.
        let ttl = seconds.saturating_sub(60).max(30);

        self.token = Some(IdToken {
            value: parsed.id_token.clone(),
            expires_at: std::time::Instant::now() + Duration::from_secs(ttl),
        });
        self.auth_failures = 0;
        self.auth_retry_after = None;
        self.auth_error = None;
        Ok(parsed.id_token)
    }

    /// Remember a failed sign-in and hold off before the next attempt.
    fn record_auth_failure(&mut self, message: String) {
        self.auth_failures = self.auth_failures.saturating_add(1);
        // 2, 4, 8, 16, then 30 minutes — long enough for Firebase's own
        // throttle to clear, short enough to recover on its own.
        let minutes = match self.auth_failures {
            1 => 2,
            2 => 4,
            3 => 8,
            4 => 16,
            _ => 30,
        };
        self.auth_retry_after = Some(std::time::Instant::now() + Duration::from_secs(minutes * 60));
        self.auth_error = Some(format!(
            "{message} Next automatic attempt in about {minutes} min."
        ));
    }

    /// Upload a Parquet payload to `telemetry/{patient_id}/{session_id}.parquet`.
    pub fn upload_parquet(
        &mut self,
        patient_id: &str,
        session_id: &str,
        bytes: &[u8],
    ) -> EngineResult<String> {
        if !self.has_bucket() {
            return Err(EngineError::Sync(
                "no Cloud Storage bucket configured (set PILATES_FIREBASE_BUCKET)".into(),
            ));
        }
        let token = self.ensure_token()?;
        let object_path = telemetry_object_path(patient_id, session_id);
        let url = format!(
            "{STORAGE_BASE}/{}/o?uploadType=media&name={}",
            self.config.bucket,
            urlencode(&object_path)
        );

        let response = self
            .client
            .post(&url)
            .bearer_auth(&token)
            .header("Content-Type", "application/octet-stream")
            .body(bytes.to_vec())
            .send()
            .map_err(|e| EngineError::Sync(format!("parquet upload failed: {e}")))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().unwrap_or_default();
            return Err(EngineError::Sync(format!(
                "parquet upload rejected ({status}): {}",
                truncate(&body, 300)
            )));
        }
        Ok(object_path)
    }

    /// Write the session document to Firestore (once per session).
    /// Write the session document to Firestore, creating it at most once.
    ///
    /// `currentDocument.exists=false` makes the write a create: a retry after a
    /// lost response is a no-op instead of an overwrite, and two workstations
    /// can never race the same session into different contents.
    pub fn write_session_document(
        &mut self,
        patient_id: &str,
        session_id: &str,
        document: &Value,
    ) -> EngineResult<()> {
        let token = self.ensure_token()?;
        let url = format!(
            "{FIRESTORE_BASE}/projects/{}/databases/(default)/documents/patients/{patient_id}/sessions/{session_id}?currentDocument.exists=false",
            self.config.project_id
        );

        let body = json!({ "fields": to_firestore_fields(document) });

        let response = self
            .client
            .patch(&url)
            .bearer_auth(&token)
            .json(&body)
            .send()
            .map_err(|e| EngineError::Sync(format!("firestore write failed: {e}")))?;

        let status = response.status();

        // 409 FAILED_PRECONDITION here means the document already exists: an
        // earlier attempt landed but its response was lost. That is success.
        if status.as_u16() == 409 {
            return Ok(());
        }

        if !status.is_success() {
            let text = response.text().unwrap_or_default();
            return Err(EngineError::Sync(format!(
                "firestore write rejected ({status}): {}",
                truncate(&text, 300)
            )));
        }
        Ok(())
    }

    /// Push a single session: the Parquet archive first, then the document.
    ///
    /// The archive is **mandatory**. A session document carries a
    /// `research_telemetry` pointer, so writing it while the object is absent
    /// advertises a download that can never resolve — and the `Synced` state
    /// that follows reclaims the only copy of the blob. Both mistakes are
    /// irreversible, so this refuses to proceed without a stored archive.
    pub fn push_session(&mut self, outbox: &mut Outbox, session_id: &str) -> EngineResult<()> {
        let session = outbox
            .session(session_id)?
            .ok_or_else(|| EngineError::Sync(format!("unknown session {session_id}")))?;

        if !self.has_bucket() {
            return Err(EngineError::Sync(
                "no Cloud Storage bucket is configured, so the telemetry archive cannot be \
                 uploaded. The session stays queued on this workstation until one is set \
                 (PILATES_FIREBASE_BUCKET, or `bucket` in cloud.json)."
                    .into(),
            ));
        }

        let bytes = outbox.session_parquet(session_id)?.ok_or_else(|| {
            EngineError::Sync(format!(
                "session {session_id} has no staged Parquet archive; refusing to write a \
                 document pointing at an object that was never uploaded"
            ))
        })?;

        let mut document: Value = serde_json::from_str(&session.document_json)
            .map_err(|e| EngineError::Sync(format!("session document is not valid JSON: {e}")))?;
        stamp_archive_pointer(
            &mut document,
            &self.config.bucket,
            &session.patient_id,
            session_id,
        );

        outbox.mark_session_state(session_id, UploadState::Uploading, None)?;

        if let Err(error) = self.upload_parquet(&session.patient_id, session_id, &bytes) {
            outbox.mark_session_state(session_id, UploadState::Failed, Some(&error.to_string()))?;
            return Err(error);
        }

        if let Err(error) = self.write_session_document(&session.patient_id, session_id, &document)
        {
            outbox.mark_session_state(session_id, UploadState::Failed, Some(&error.to_string()))?;
            return Err(error);
        }

        // Reaching this point means the archive is stored, so `mark_session_state`
        // may safely reclaim the local blob.
        outbox.mark_session_state(session_id, UploadState::Synced, None)?;
        Ok(())
    }

    /// Write (or update) a patient document without touching fields we do not own.
    ///
    /// `precondition` is the Firestore `updateTime` this workstation last saw
    /// for the document. Firestore refuses the write if anything changed since,
    /// which turns a silent overwrite into a reported [`EngineError::Conflict`].
    ///
    /// Returns the document's new `updateTime`, so the next edit starts from a
    /// fresh baseline without waiting for the next pull.
    pub fn write_patient_document(
        &mut self,
        patient: &StoredPatient,
        precondition: Option<&str>,
    ) -> EngineResult<Option<String>> {
        let token = self.ensure_token()?;
        let (document, mask) = patient_document_body(patient);

        let mut query: Vec<String> = mask
            .iter()
            .map(|field| format!("updateMask.fieldPaths={}", urlencode(field)))
            .collect();
        if let Some(update_time) = precondition {
            query.push(format!(
                "currentDocument.updateTime={}",
                urlencode(update_time)
            ));
        }

        let url = format!(
            "{FIRESTORE_BASE}/projects/{}/databases/(default)/documents/patients/{}?{}",
            self.config.project_id,
            patient.id,
            query.join("&")
        );
        let body = json!({ "fields": to_firestore_fields(&document) });

        let response = self
            .client
            .patch(&url)
            .bearer_auth(&token)
            .json(&body)
            .send()
            .map_err(|e| EngineError::Sync(format!("patient write failed: {e}")))?;

        let status = response.status();

        // 409 FAILED_PRECONDITION: someone else wrote this document after the
        // copy we based the edit on. Overwriting would discard their change.
        if status.as_u16() == 409 {
            return Err(EngineError::Conflict(format!(
                "patient {} was changed on another workstation after this copy was read; \
                 re-open the patient to pick up the newer version before saving again",
                patient.id
            )));
        }

        if !status.is_success() {
            let text = response.text().unwrap_or_default();
            return Err(EngineError::Sync(format!(
                "patient write rejected ({status}): {}",
                truncate(&text, 300)
            )));
        }

        let written: Value = response.json().unwrap_or(Value::Null);
        Ok(written
            .get("updateTime")
            .and_then(Value::as_str)
            .map(str::to_string))
    }

    /// Mark a patient deleted in Firestore without destroying its other fields.
    pub fn tombstone_patient_document(&mut self, patient_id: &str) -> EngineResult<()> {
        let token = self.ensure_token()?;
        let url = format!(
            "{FIRESTORE_BASE}/projects/{}/databases/(default)/documents/patients/{patient_id}?updateMask.fieldPaths=local_state",
            self.config.project_id
        );
        let body = json!({ "fields": { "local_state": { "stringValue": "tombstone" } } });

        let response = self
            .client
            .patch(&url)
            .bearer_auth(&token)
            .json(&body)
            .send()
            .map_err(|e| EngineError::Sync(format!("patient tombstone failed: {e}")))?;

        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().unwrap_or_default();
            return Err(EngineError::Sync(format!(
                "patient tombstone rejected ({status}): {}",
                truncate(&text, 300)
            )));
        }
        Ok(())
    }

    /// True when someone else changed the clinic since the last check.
    ///
    /// Advances the watermark regardless, so an echo of our own upload is
    /// consumed silently instead of triggering a pointless pull.
    pub fn remote_changed(&mut self) -> EngineResult<bool> {
        let Some((revision, origin)) = self.fetch_change_marker()? else {
            // Marker absent: the function is not deployed, so callers fall
            // back to their periodic full pull.
            return Ok(false);
        };

        let advanced = self
            .last_marker_revision
            .map(|previous| revision > previous)
            .unwrap_or(true);
        self.last_marker_revision = Some(revision);

        if !advanced {
            return Ok(false);
        }
        Ok(origin != patient_origin())
    }

    /// List a patient's clinical comments, newest first.
    pub fn list_comments(&mut self, patient_id: &str) -> EngineResult<Vec<CommentRecord>> {
        let token = self.ensure_token()?;
        let url = format!(
            "{FIRESTORE_BASE}/projects/{}/databases/(default)/documents/patients/{patient_id}/comments?pageSize=200",
            self.config.project_id
        );

        let response = self
            .client
            .get(&url)
            .bearer_auth(&token)
            .send()
            .map_err(|e| EngineError::Sync(format!("comment fetch failed: {e}")))?;

        if !response.status().is_success() {
            let status = response.status();
            return Err(EngineError::Sync(format!("comment fetch rejected ({status})")));
        }

        let body: Value = response
            .json()
            .map_err(|e| EngineError::Sync(format!("comment decode: {e}")))?;

        let mut comments: Vec<CommentRecord> = body
            .get("documents")
            .and_then(Value::as_array)
            .map(|documents| {
                documents
                    .iter()
                    .filter_map(|document| {
                        let name = document.get("name").and_then(Value::as_str)?;
                        let id = name.rsplit('/').next()?.to_string();
                        let fields = document.get("fields").and_then(Value::as_object)?;
                        Some(CommentRecord {
                            id,
                            text: read_string(fields, "text"),
                            created_at: read_string(fields, "created_at"),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();

        // Newest first; RFC 3339 timestamps sort lexicographically.
        comments.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(comments)
    }

    /// Append a comment. Comments are cloud-only: they are clinical notes a
    /// colleague may read from another workstation, not session telemetry.
    pub fn add_comment(&mut self, patient_id: &str, text: &str) -> EngineResult<CommentRecord> {
        let token = self.ensure_token()?;
        let created_at = chrono::Utc::now().to_rfc3339();
        let url = format!(
            "{FIRESTORE_BASE}/projects/{}/databases/(default)/documents/patients/{patient_id}/comments",
            self.config.project_id
        );
        let body = json!({
            "fields": {
                "text": { "stringValue": text },
                "created_at": { "stringValue": created_at },
            }
        });

        let response = self
            .client
            .post(&url)
            .bearer_auth(&token)
            .json(&body)
            .send()
            .map_err(|e| EngineError::Sync(format!("comment write failed: {e}")))?;

        if !response.status().is_success() {
            let status = response.status();
            let detail = response.text().unwrap_or_default();
            return Err(EngineError::Sync(format!(
                "comment write rejected ({status}): {}",
                truncate(&detail, 200)
            )));
        }

        let created: Value = response
            .json()
            .map_err(|e| EngineError::Sync(format!("comment decode: {e}")))?;
        let id = created
            .get("name")
            .and_then(Value::as_str)
            .and_then(|name| name.rsplit('/').next())
            .unwrap_or_default()
            .to_string();

        Ok(CommentRecord {
            id,
            text: text.to_string(),
            created_at,
        })
    }

    /// Remove a comment by id.
    pub fn delete_comment(&mut self, patient_id: &str, comment_id: &str) -> EngineResult<()> {
        let token = self.ensure_token()?;
        let url = format!(
            "{FIRESTORE_BASE}/projects/{}/databases/(default)/documents/patients/{patient_id}/comments/{comment_id}",
            self.config.project_id
        );

        let response = self
            .client
            .delete(&url)
            .bearer_auth(&token)
            .send()
            .map_err(|e| EngineError::Sync(format!("comment delete failed: {e}")))?;

        if !response.status().is_success() && response.status().as_u16() != 404 {
            let status = response.status();
            return Err(EngineError::Sync(format!("comment delete rejected ({status})")));
        }
        Ok(())
    }

    /// Read the clinic change marker.
    ///
    /// One small document instead of a full roster scan: the Cloud Function
    /// bumps `revision` whenever anything changes and records who wrote it.
    pub fn fetch_change_marker(&mut self) -> EngineResult<Option<(i64, String)>> {
        let token = self.ensure_token()?;
        let url = format!(
            "{FIRESTORE_BASE}/projects/{}/databases/(default)/documents/syncState/current",
            self.config.project_id
        );

        let response = self
            .client
            .get(&url)
            .bearer_auth(&token)
            .send()
            .map_err(|e| EngineError::Sync(format!("marker fetch failed: {e}")))?;

        if response.status().as_u16() == 404 {
            return Ok(None);
        }
        if !response.status().is_success() {
            let status = response.status();
            return Err(EngineError::Sync(format!("marker fetch rejected ({status})")));
        }

        let body: Value = response
            .json()
            .map_err(|e| EngineError::Sync(format!("marker decode: {e}")))?;
        let fields = body.get("fields").and_then(Value::as_object);

        let revision = fields
            .and_then(|f| f.get("revision"))
            .and_then(|v| v.get("integerValue"))
            .and_then(Value::as_str)
            .and_then(|text| text.parse::<i64>().ok())
            .unwrap_or(0);
        let origin = fields
            .and_then(|f| f.get("last_origin"))
            .and_then(|v| v.get("stringValue"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();

        Ok(Some((revision, origin)))
    }

    /// Download sessions completed at or after `watermark`, across all patients.
    ///
    /// One collection-group query replaces the old per-patient subcollection
    /// sweep. That sweep re-read every session ever recorded on every cycle —
    /// at a few hundred sessions that was ~100k document reads a day for data
    /// that changes a handful of times.
    ///
    /// Returns `(session_id, patient_id, pose_id, document_json, completed_at)`.
    pub fn fetch_sessions_since(
        &mut self,
        watermark: &str,
        limit: usize,
    ) -> EngineResult<Vec<(String, String, String, String, String)>> {
        let token = self.ensure_token()?;
        let url = format!(
            "{FIRESTORE_BASE}/projects/{}/databases/(default)/documents:runQuery",
            self.config.project_id
        );

        let body = json!({
            "structuredQuery": {
                "from": [{ "collectionId": "sessions", "allDescendants": true }],
                "where": {
                    "fieldFilter": {
                        "field": { "fieldPath": "completed_at" },
                        "op": "GREATER_THAN_OR_EQUAL",
                        "value": { "stringValue": watermark }
                    }
                },
                "orderBy": [
                    { "field": { "fieldPath": "completed_at" }, "direction": "ASCENDING" }
                ],
                "limit": limit
            }
        });

        let response = self
            .client
            .post(&url)
            .bearer_auth(&token)
            .json(&body)
            .send()
            .map_err(|e| EngineError::Sync(format!("session query failed: {e}")))?;

        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().unwrap_or_default();
            return Err(EngineError::Sync(format!(
                "session query rejected ({status}): {}",
                truncate(&text, 300)
            )));
        }

        let rows: Value = response
            .json()
            .map_err(|e| EngineError::Sync(format!("session query decode: {e}")))?;

        let mut sessions = Vec::new();
        for row in rows.as_array().map(Vec::as_slice).unwrap_or_default() {
            let Some(document) = row.get("document") else {
                continue;
            };
            let name = document
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default();

            // .../documents/patients/{patientId}/sessions/{sessionId}
            let segments: Vec<&str> = name.split('/').collect();
            let session_id = segments.last().copied().unwrap_or_default();
            let patient_id = segments
                .len()
                .checked_sub(3)
                .and_then(|index| segments.get(index))
                .copied()
                .unwrap_or_default();
            if session_id.is_empty() || patient_id.is_empty() {
                continue;
            }

            let mut object = Map::new();
            if let Some(fields) = document.get("fields").and_then(Value::as_object) {
                for (key, value) in fields {
                    object.insert(key.clone(), firestore_value_to_json(value));
                }
            }
            let pose_id = object
                .get("pose_id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let completed_at = object
                .get("completed_at")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();

            sessions.push((
                session_id.to_string(),
                patient_id.to_string(),
                pose_id,
                Value::Object(object).to_string(),
                completed_at,
            ));
        }

        Ok(sessions)
    }

    pub fn fetch_patients(&mut self, include_legacy: bool) -> EngineResult<Vec<RemotePatient>> {
        let token = self.ensure_token()?;
        let mut patients: Vec<RemotePatient> = Vec::new();
        let mut page_token: Option<String> = None;

        loop {
            let mut url = format!(
                "{FIRESTORE_BASE}/projects/{}/databases/(default)/documents/patients?pageSize=300",
                self.config.project_id
            );
            // The legacy archive is frozen, so it only needs downloading once.
            // A field mask keeps it out of the recurring minute-by-minute pull.
            if !include_legacy {
                for field in PATIENT_SYNC_FIELDS {
                    url.push_str(&format!("&mask.fieldPaths={field}"));
                }
            }
            if let Some(token) = &page_token {
                url.push_str(&format!("&pageToken={}", urlencode(token)));
            }

            let response = self
                .client
                .get(&url)
                .bearer_auth(&token)
                .send()
                .map_err(|e| EngineError::Sync(format!("patient fetch failed: {e}")))?;

            if !response.status().is_success() {
                let status = response.status();
                let text = response.text().unwrap_or_default();
                return Err(EngineError::Sync(format!(
                    "patient fetch rejected ({status}): {}",
                    truncate(&text, 300)
                )));
            }

            let body: Value = response
                .json()
                .map_err(|e| EngineError::Sync(format!("patient fetch decode: {e}")))?;

            if let Some(documents) = body.get("documents").and_then(Value::as_array) {
                for document in documents {
                    if let Some(patient) = parse_remote_patient(document) {
                        patients.push(patient);
                    }
                }
            }

            page_token = body
                .get("nextPageToken")
                .and_then(Value::as_str)
                .map(str::to_string);
            if page_token.is_none() || patients.len() > 10_000 {
                break;
            }
        }

        Ok(patients)
    }

    /// Pull the Firestore roster into the local store.
    ///
    /// Existing rows are updated in place (revision never decreases) and missing
    /// rows are inserted. Nothing is enqueued for upload, because the remote copy
    /// is already authoritative.
    pub fn pull_patients(&mut self, outbox: &mut Outbox) -> EngineResult<PullReport> {
        let include_legacy = !outbox.has_legacy_patients()?;
        let remote = self.fetch_patients(include_legacy)?;
        let mut report = PullReport {
            fetched: remote.len(),
            enabled: true,
            ..Default::default()
        };

        for patient in remote {
            // Never overwrite an edit that has not been uploaded yet.
            if outbox.has_pending_patient(&patient.id)? {
                report.skipped_pending += 1;
                continue;
            }

            // Captured before the fields below are moved into `local`.
            let remote_update_time = patient.update_time;

            let local = StoredPatient {
                id: patient.id,
                name: patient.name,
                age: patient.age,
                weight: patient.weight,
                height: patient.height,
                gender: patient.gender,
                revision: patient.revision,
                local_state: patient.local_state,
                created_at: String::new(),
                updated_at: String::new(),
                total_sessions: patient.total_sessions,
                lifetime_avg_score: patient.lifetime_avg_score,
                last_active: patient.last_active,
                address: patient.address,
                note: patient.note,
                tel_number: patient.tel_number,
                legacy_json: patient.legacy_json,
            };
            let kept_deleted = match outbox.upsert_remote_patient(&local)? {
                RemoteUpsert::Inserted => {
                    report.imported += 1;
                    false
                }
                RemoteUpsert::Updated => {
                    report.updated += 1;
                    false
                }
                RemoteUpsert::KeptDeleted => {
                    report.kept_deleted += 1;
                    true
                }
            };

            // Refresh the conflict baseline. A row whose local deletion is
            // still pending keeps the older baseline on purpose: moving it
            // forward would let that stale local edit overwrite a newer remote
            // change without anyone noticing.
            if !kept_deleted {
                outbox.set_remote_update_time(&local.id, remote_update_time.as_deref())?;
            }
        }
        Ok(report)
    }

    /// Download sessions recorded on any workstation since the last pull.
    ///
    /// The watermark lives in `sync_state`, so each run fetches only what is
    /// new. The filter is `>=` and the upsert is idempotent, which means a
    /// session sharing the boundary timestamp is re-read rather than skipped.
    pub fn pull_sessions(&mut self, outbox: &mut Outbox) -> EngineResult<usize> {
        const PAGE: usize = 300;
        const SWEEP_INTERVAL: std::time::Duration = std::time::Duration::from_secs(60);

        if let Some(last) = self.last_session_sweep {
            if last.elapsed() < SWEEP_INTERVAL {
                return Ok(0);
            }
        }
        self.last_session_sweep = Some(std::time::Instant::now());

        let mut watermark = outbox
            .sync_state(SESSIONS_WATERMARK)?
            .unwrap_or_else(|| "1970-01-01T00:00:00Z".to_string());
        let mut imported = 0usize;

        loop {
            let rows = self.fetch_sessions_since(&watermark, PAGE)?;
            if rows.is_empty() {
                break;
            }

            let mut highest = watermark.clone();
            for (session_id, patient_id, pose_id, document_json, completed_at) in &rows {
                // The query spans every patient, so it can surface a session
                // whose patient has not been pulled yet (or was removed
                // remotely). The local table has a foreign key; skip instead of
                // failing the whole pull.
                if outbox.get_patient(patient_id)?.is_none() {
                    continue;
                }
                if outbox.upsert_remote_session(session_id, patient_id, pose_id, document_json)? {
                    imported += 1;
                }
                if completed_at > &highest {
                    highest = completed_at.clone();
                }
            }

            let advanced = highest != watermark;
            watermark = highest;
            outbox.set_sync_state(SESSIONS_WATERMARK, &watermark)?;

            // A short page means nothing older is left. No progress means every
            // remaining row shares the boundary timestamp — stop rather than
            // re-reading the same page forever; the next pull resumes there.
            if rows.len() < PAGE || !advanced {
                break;
            }
        }

        Ok(imported)
    }

    /// Drain the outbox: patient operations first, then session uploads.
    ///
    /// Individual failures are recorded and do not abort the batch, so one bad
    /// record cannot block the rest of the queue.
    pub fn flush(&mut self, outbox: &mut Outbox, limit: usize) -> SyncReport {
        let mut report = SyncReport {
            enabled: true,
            ..Default::default()
        };

        // --- 1. Patient operations ---------------------------------------
        let entries = match outbox.queue_entries(limit.saturating_mul(4).max(50)) {
            Ok(entries) => entries,
            Err(error) => {
                report.errors.push(error.to_string());
                Vec::new()
            }
        };

        for entry in entries.into_iter().filter(|entry| entry.state == "pending") {
            match entry.kind.as_str() {
                "create_patient" | "update_patient" | "delete_patient" => {
                    report.attempted += 1;
                    let patient = match outbox.fetch_patient(&entry.entity_id) {
                        Ok(Some(patient)) => patient,
                        Ok(None) => {
                            let _ = outbox.resolve_queue_entry(
                                entry.id,
                                "done",
                                Some("patient no longer exists locally"),
                            );
                            continue;
                        }
                        Err(error) => {
                            report.failed += 1;
                            report.errors.push(error.to_string());
                            continue;
                        }
                    };

                    // Optimistic concurrency: refuse the write if the remote
                    // document moved since this copy was read.
                    let result = if patient.local_state == PatientState::Tombstone {
                        self.tombstone_patient_document(&patient.id).map(|()| None)
                    } else {
                        let precondition = outbox.remote_update_time(&patient.id).ok().flatten();
                        self.write_patient_document(&patient, precondition.as_deref())
                    };

                    match result {
                        Ok(update_time) => {
                            let _ = outbox
                                .set_remote_update_time(&patient.id, update_time.as_deref());
                            report.patients_synced += 1;
                            let _ = outbox.resolve_queue_entry(entry.id, "done", None);
                        }
                        // A conflict needs a human decision. Parking the entry
                        // stops the every-minute retry from failing forever and
                        // from silently overwriting the other edit later.
                        Err(EngineError::Conflict(message)) => {
                            report.conflicts += 1;
                            report
                                .errors
                                .push(format!("patient {}: {message}", entry.entity_id));
                            let _ = outbox.resolve_queue_entry(
                                entry.id,
                                "conflict",
                                Some(&message),
                            );
                        }
                        Err(error) => {
                            report.failed += 1;
                            report
                                .errors
                                .push(format!("patient {}: {error}", entry.entity_id));
                            let _ = outbox.resolve_queue_entry(
                                entry.id,
                                "pending",
                                Some(&error.to_string()),
                            );
                        }
                    }
                }
                // Bookkeeping marker from the one-time legacy import.
                "import_legacy_patients" => {
                    let _ = outbox.resolve_queue_entry(entry.id, "done", None);
                }
                // Sessions are handled below, from their own table.
                _ => {}
            }
        }

        // --- 2. Session uploads -------------------------------------------
        let pending = match outbox.pending_sessions(limit) {
            Ok(pending) => pending,
            Err(error) => {
                report.errors.push(error.to_string());
                return report;
            }
        };

        report.attempted += pending.len();
        for session in pending {
            match self.push_session(outbox, &session.session_id) {
                Ok(()) => {
                    report.synced += 1;
                    let _ = outbox.resolve_pending_for_entity(
                        "create_session",
                        &session.session_id,
                        "done",
                        None,
                    );
                }
                Err(error) => {
                    report.failed += 1;
                    report.errors.push(format!("{}: {error}", session.session_id));
                }
            }
        }

        report
    }
}

/// GCS object path for a session's telemetry.
pub fn telemetry_object_path(patient_id: &str, session_id: &str) -> String {
    format!("telemetry/{patient_id}/{session_id}.parquet")
}

/// Stamp the archive pointer from the live configuration before a session is
/// uploaded.
///
/// The document is assembled at capture time, when this workstation may not
/// have had a bucket configured — `main.rs` deliberately supplies no default.
/// The object exists only because this run just uploaded it, so the pointer is
/// authoritative here rather than at capture.
fn stamp_archive_pointer(
    document: &mut Value,
    bucket: &str,
    patient_id: &str,
    session_id: &str,
) {
    let Some(object) = document.as_object_mut() else {
        return;
    };

    object.insert("last_origin".into(), json!(patient_origin()));

    let path = telemetry_object_path(patient_id, session_id);

    // Replace a missing or non-object `research_telemetry` rather than
    // silently leaving the document without a pointer.
    let usable = object
        .get("research_telemetry")
        .map(Value::is_object)
        .unwrap_or(false);
    if !usable {
        object.insert("research_telemetry".into(), json!({}));
    }

    if let Some(telemetry) = object
        .get_mut("research_telemetry")
        .and_then(Value::as_object_mut)
    {
        telemetry.insert("storage_path".into(), json!(path));
        telemetry.insert("gcs_bucket".into(), json!(bucket));
    }
}

/// Convert a plain JSON object into Firestore's typed `fields` representation.
///
/// Firestore's REST API requires every value to be wrapped in a type tag
/// (`stringValue`, `integerValue`, …) rather than plain JSON.
pub fn to_firestore_fields(value: &Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map
            .iter()
            .map(|(key, value)| (key.clone(), to_firestore_value(value)))
            .collect(),
        _ => Map::new(),
    }
}

fn to_firestore_value(value: &Value) -> Value {
    match value {
        Value::Null => json!({ "nullValue": Value::Null }),
        Value::Bool(flag) => json!({ "booleanValue": flag }),
        Value::Number(number) => {
            if let Some(integer) = number.as_i64() {
                // Firestore expects 64-bit integers as strings.
                json!({ "integerValue": integer.to_string() })
            } else {
                json!({ "doubleValue": number.as_f64().unwrap_or(0.0) })
            }
        }
        Value::String(text) => json!({ "stringValue": text }),
        Value::Array(items) => json!({
            "arrayValue": {
                "values": items.iter().map(to_firestore_value).collect::<Vec<_>>()
            }
        }),
        Value::Object(_) => json!({
            "mapValue": { "fields": to_firestore_fields(value) }
        }),
    }
}

/// Percent-encode a GCS object path for use in a query string.
fn urlencode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn truncate(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        text.to_string()
    } else {
        format!("{}…", &text[..limit])
    }
}

/// Where the clinic credentials come from, for error messages.
///
/// Without this the operator is told to "update cloud.json" with no idea which
/// of the two supported locations is actually in use.
fn credentials_source() -> String {
    if std::env::var("PILATES_CLINIC_EMAIL").is_ok() {
        return "the PILATES_CLINIC_EMAIL / PILATES_CLINIC_PASSWORD environment variables"
            .to_string();
    }
    crate::paths::data_dir()
        .join("cloud.json")
        .display()
        .to_string()
}

/// Turn an Identity Toolkit failure into something a clinician can act on.
///
/// The payload is `{"error":{"message":"TOO_MANY_ATTEMPTS_TRY_LATER",…}}`; the
/// bare code is useless in the UI and hides the difference between "wrong
/// password" and "Firebase is throttling you".
fn sign_in_failure_message(status: u16, body: &str, email: &str) -> String {
    let code = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_default();

    match code.as_str() {
        "TOO_MANY_ATTEMPTS_TRY_LATER" => format!(
            "Firebase is blocking sign-in for {email} after too many failed attempts. \
             The block clears by itself in roughly 15–60 minutes; if the password has \
             changed, update {source} first. Automatic retries are paused meanwhile.",
            source = credentials_source()
        ),
        "EMAIL_NOT_FOUND" | "INVALID_PASSWORD" | "INVALID_LOGIN_CREDENTIALS" | "INVALID_EMAIL" => {
            format!(
                "Firebase rejected the clinic credentials for {email}. The stored password \
                 does not match the account — update {source} (Firebase console → \
                 Authentication → user) and restart the app.",
                source = credentials_source()
            )
        }
        "USER_DISABLED" => format!("The Firebase account {email} is disabled."),
        "API_KEY_INVALID" | "PROJECT_NOT_FOUND" => {
            "The Firebase api_key/project_id in cloud.json is not valid.".to_string()
        }
        _ => format!("sign-in rejected ({status}): {}", truncate(body, 300)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Environment variables are process-global, so tests that touch them must
    /// not run concurrently with each other.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn object_path_matches_plan_layout() {
        assert_eq!(
            telemetry_object_path("patient-1", "session-9"),
            "telemetry/patient-1/session-9.parquet"
        );
    }

    #[test]
    fn firestore_fields_wrap_every_type() {
        let document = json!({
            "session_id": "s1",
            "duration_seconds": 42.5,
            "total_reps": 8,
            "completed": true,
            "notes": Value::Null,
            "reps": [1, 2],
            "summary": { "mean_form_score": 91.2 }
        });

        let fields = to_firestore_fields(&document);
        assert_eq!(fields["session_id"], json!({ "stringValue": "s1" }));
        assert_eq!(fields["total_reps"], json!({ "integerValue": "8" }));
        assert_eq!(fields["duration_seconds"], json!({ "doubleValue": 42.5 }));
        assert_eq!(fields["completed"], json!({ "booleanValue": true }));
        assert_eq!(fields["notes"], json!({ "nullValue": Value::Null }));
        assert_eq!(
            fields["reps"],
            json!({ "arrayValue": { "values": [
                { "integerValue": "1" }, { "integerValue": "2" }
            ]}})
        );
        assert_eq!(
            fields["summary"],
            json!({ "mapValue": { "fields": { "mean_form_score": { "doubleValue": 91.2 } } } })
        );
    }

    #[test]
    fn non_object_documents_produce_no_fields() {
        assert!(to_firestore_fields(&json!([1, 2, 3])).is_empty());
    }

    #[test]
    fn urlencoding_escapes_path_separators() {
        assert_eq!(
            urlencode("telemetry/p1/s1.parquet"),
            "telemetry%2Fp1%2Fs1.parquet"
        );
        assert_eq!(urlencode("a-b_c.d~e"), "a-b_c.d~e");
    }

    #[test]
    fn config_is_none_without_credentials() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        // Ensure a clean slate for this assertion.
        for key in [
            "PILATES_FIREBASE_PROJECT_ID",
            "PILATES_FIREBASE_API_KEY",
            "PILATES_FIREBASE_BUCKET",
            "PILATES_CLINIC_EMAIL",
            "PILATES_CLINIC_PASSWORD",
        ] {
            std::env::remove_var(key);
        }
        // Only the environment path is asserted here: `CloudConfig::load` also
        // consults `cloud.json`, which may legitimately exist on a configured
        // workstation.
        assert!(CloudConfig::from_env().is_none());
    }

    /// Regression for the reported "still says the old account" bug: a shell or
    /// Explorer started before the credentials were corrected keeps the old
    /// `PILATES_CLINIC_*` in its environment block and hands them to every child
    /// process, shadowing the `cloud.json` the operator had already fixed.
    #[test]
    fn cloud_json_wins_over_a_stale_environment() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());

        let dir = std::env::temp_dir().join(format!("pilates-cloud-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        std::fs::write(
            dir.join("cloud.json"),
            r#"{"project_id":"p","api_key":"k","bucket":"","email":"file@example.com","password":"secret"}"#,
        )
        .expect("write config");

        std::env::set_var("PILATES_AI_DATA_DIR", &dir);
        std::env::set_var("PILATES_FIREBASE_PROJECT_ID", "p");
        std::env::set_var("PILATES_FIREBASE_API_KEY", "k");
        std::env::set_var("PILATES_CLINIC_EMAIL", "stale@example.com");
        std::env::set_var("PILATES_CLINIC_PASSWORD", "old-password");

        let config = CloudConfig::load().expect("configuration");
        assert_eq!(
            config.email, "file@example.com",
            "the file on disk must win over an inherited environment"
        );

        for key in [
            "PILATES_AI_DATA_DIR",
            "PILATES_FIREBASE_PROJECT_ID",
            "PILATES_FIREBASE_API_KEY",
            "PILATES_CLINIC_EMAIL",
            "PILATES_CLINIC_PASSWORD",
        ] {
            std::env::remove_var(key);
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn bucket_is_optional_for_firestore_only_setups() {
        let mut config = CloudConfig {
            project_id: "pilates-ai".into(),
            api_key: "key".into(),
            bucket: String::new(),
            email: "clinic@example.com".into(),
            password: "secret".into(),
        };

        let cloud = CloudSync::new(config.clone()).expect("client");
        assert!(
            !cloud.has_bucket(),
            "a Firestore-only deployment must still initialise"
        );

        config.bucket = "pilates-ai.appspot.com".into();
        let cloud = CloudSync::new(config).expect("client");
        assert!(cloud.has_bucket());
    }

    /// A session whose archive cannot be uploaded must never be marked
    /// `Synced`, because that state reclaims the only copy of the blob.
    #[test]
    fn push_session_refuses_without_a_bucket() {
        let config = CloudConfig {
            project_id: "pilates-ai".into(),
            api_key: "key".into(),
            bucket: String::new(),
            email: "clinic@example.com".into(),
            password: "secret".into(),
        };
        let mut cloud = CloudSync::new(config).expect("client");
        let mut outbox = Outbox::in_memory().expect("outbox");
        outbox
            .save_patient(&StoredPatient {
                id: "p1".into(),
                ..patient()
            })
            .expect("patient");
        outbox
            .save_session("s1", "p1", "pose1", "{}", Some((b"PAR1data", "abc")))
            .expect("save");

        let error = cloud.push_session(&mut outbox, "s1").unwrap_err();
        assert!(
            error.to_string().contains("bucket"),
            "the refusal must name the missing bucket: {error}"
        );

        // Nothing was uploaded, so the blob must still be staged for a retry.
        assert!(
            outbox.session_parquet("s1").expect("read").is_some(),
            "an un-uploaded archive must not be reclaimed"
        );
        assert_eq!(
            outbox.session("s1").expect("read").expect("present").upload_state.as_str(),
            "pending",
            "the session must stay queued, not be marked failed forever"
        );
    }

    /// A pending session with no staged blob is a bug in the pipeline, not a
    /// session to publish: the document would point at an object that does not
    /// exist.
    #[test]
    fn push_session_refuses_without_a_staged_archive() {
        let config = CloudConfig {
            project_id: "pilates-ai".into(),
            api_key: "key".into(),
            bucket: "pilates-ai.appspot.com".into(),
            email: "clinic@example.com".into(),
            password: "secret".into(),
        };
        let mut cloud = CloudSync::new(config).expect("client");
        let mut outbox = Outbox::in_memory().expect("outbox");
        outbox
            .save_patient(&StoredPatient {
                id: "p1".into(),
                ..patient()
            })
            .expect("patient");
        outbox
            .save_session("s1", "p1", "pose1", "{}", None)
            .expect("save");

        let error = cloud.push_session(&mut outbox, "s1").unwrap_err();
        assert!(
            error.to_string().contains("no staged Parquet archive"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn archive_pointer_is_stamped_from_the_live_bucket() {
        let mut document = json!({
            "session_id": "s1",
            "research_telemetry": {
                "storage_path": "stale/path.parquet",
                "gcs_bucket": "a-bucket-that-does-not-exist",
                "sha256": "abc"
            }
        });

        stamp_archive_pointer(&mut document, "real-bucket", "p1", "s1");

        assert_eq!(
            document["research_telemetry"]["gcs_bucket"],
            json!("real-bucket")
        );
        assert_eq!(
            document["research_telemetry"]["storage_path"],
            json!("telemetry/p1/s1.parquet")
        );
        assert_eq!(
            document["research_telemetry"]["sha256"],
            json!("abc"),
            "the capture-time digest must survive"
        );
        assert!(
            document.get("last_origin").is_some(),
            "every written document carries the writing workstation"
        );
    }

    #[test]
    fn archive_pointer_is_created_when_absent() {
        let mut document = json!({ "session_id": "s1" });
        stamp_archive_pointer(&mut document, "b", "p1", "s1");
        assert_eq!(
            document["research_telemetry"]["storage_path"],
            json!("telemetry/p1/s1.parquet")
        );
        assert_eq!(document["research_telemetry"]["gcs_bucket"], json!("b"));
    }

    /// Live round-trip against the configured Firebase project.
    ///
    /// Ignored by default so CI stays hermetic. Run explicitly with:
    ///     cargo test pull_patients_from_live_firestore -- --ignored --nocapture
    #[test]
    #[ignore = "requires PILATES_FIREBASE_* credentials and network access"]
    fn pull_patients_from_live_firestore() {
        let config = match CloudConfig::from_env() {
            Some(config) => config,
            None => {
                eprintln!("SKIP: PILATES_FIREBASE_* credentials are not configured");
                return;
            }
        };

        let mut cloud = CloudSync::new(config).expect("client");
        let mut outbox = Outbox::in_memory().expect("outbox");

        let report = cloud.pull_patients(&mut outbox).expect("pull must succeed");
        eprintln!(
            "pulled: fetched={} imported={} updated={}",
            report.fetched, report.imported, report.updated
        );

        assert!(report.fetched > 0, "expected at least one patient");
        assert_eq!(
            report.imported + report.updated + report.kept_deleted,
            report.fetched,
            "every fetched patient must be accounted for"
        );

        let stored = outbox.list_patients().expect("list");
        assert_eq!(stored.len(), report.imported, "all pulled rows are new here");

        // The materialised legacy summary must survive the round trip.
        let with_legacy = stored
            .iter()
            .filter(|patient| patient.legacy_json.is_some())
            .count();
        eprintln!("patients carrying legacy_json: {with_legacy}");
        assert!(with_legacy > 0, "expected materialised legacy summaries");
    }

    #[test]
    fn sync_report_defaults_to_disabled() {
        let report = SyncReport::default();
        assert!(!report.enabled);
        assert_eq!(report.attempted, 0);
    }

    /// The raw Identity Toolkit code is unusable in the UI: it neither names the
    /// account nor says that waiting fixes it.
    #[test]
    fn rate_limited_sign_in_explains_the_lockout() {
        let body = r#"{"error":{"code":400,"message":"TOO_MANY_ATTEMPTS_TRY_LATER","errors":[{"message":"TOO_MANY_ATTEMPTS_TRY_LATER","domain":"global","reason":"invalid"}]}}"#;
        let message = sign_in_failure_message(400, body, "clinic@example.com");

        assert!(message.contains("too many failed attempts"), "{message}");
        assert!(message.contains("clinic@example.com"), "{message}");
        assert!(
            message.contains("15–60 minutes"),
            "must say the block expires by itself: {message}"
        );
        assert!(
            !message.contains("TOO_MANY_ATTEMPTS_TRY_LATER"),
            "raw code must not leak into the UI: {message}"
        );
    }

    #[test]
    fn rejected_credentials_point_at_cloud_json() {
        // The message names whichever source is in use, so pin the environment.
        let _guard = ENV_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        std::env::remove_var("PILATES_CLINIC_EMAIL");

        let body = r#"{"error":{"code":400,"message":"INVALID_LOGIN_CREDENTIALS"}}"#;
        let message = sign_in_failure_message(400, body, "clinic@example.com");
        assert!(message.contains("cloud.json"), "{message}");
        assert!(message.contains("clinic@example.com"), "{message}");
    }

    #[test]
    fn unknown_sign_in_errors_keep_the_raw_payload() {
        let body = r#"{"error":{"message":"SOMETHING_NEW"}}"#;
        let message = sign_in_failure_message(400, body, "clinic@example.com");
        assert!(message.contains("SOMETHING_NEW"), "{message}");
        assert!(message.contains("400"), "{message}");
    }

    fn patient() -> StoredPatient {
        StoredPatient {
            id: "1vP4WZnlThz7Pq2BdhAE".into(),
            name: "Ada".into(),
            age: "34".into(),
            weight: "62".into(),
            height: "168".into(),
            gender: "Female".into(),
            revision: 3,
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

    #[test]
    fn owned_body_never_includes_foreign_fields() {
        let (document, mask) = patient_document_body(&patient());

        for foreign in ["address", "note", "tel_number", "pose1_avg", "count_pose1"] {
            assert!(!mask.contains(&foreign.to_string()), "body must not own {foreign}");
            assert!(document.get(foreign).is_none(), "body must not send {foreign}");
        }

        assert!(mask.contains(&"name".to_string()));
        assert!(mask.contains(&"revision".to_string()));
        assert!(mask.contains(&"local_state".to_string()));
    }

    /// The derived aggregates belong to the Cloud Function. A workstation that
    /// echoed its own copy would undo a newer aggregate, so they must never
    /// appear in either the body or the mask — even when the local row has them.
    #[test]
    fn aggregates_are_never_sent() {
        let mut with_stats = patient();
        with_stats.total_sessions = Some(4);
        with_stats.lifetime_avg_score = Some(88.5);
        with_stats.last_active = Some("2026-01-01T00:00:00Z".into());

        let (document, mask) = patient_document_body(&with_stats);

        for derived in ["total_sessions", "lifetime_avg_score", "last_active"] {
            assert!(
                !mask.contains(&derived.to_string()),
                "{derived} must not be in the update mask"
            );
            assert!(
                document.get(derived).is_none(),
                "{derived} must not be in the request body"
            );
        }
    }

    #[test]
    fn patient_writes_carry_an_audit_origin() {
        let (document, mask) = patient_document_body(&patient());
        assert_eq!(document["last_origin"], document["updated_by"]);
        assert!(mask.contains(&"last_origin".to_string()));
        assert!(mask.contains(&"updated_by".to_string()));
    }

    #[test]
    fn parses_a_legacy_document_without_revision() {
        // Shape taken from the live production data: auto-ID, no revision,
        // no timestamps, extra fields we do not model.
        let document = json!({
            "name": "projects/pilates-ai/databases/(default)/documents/patients/1vP4WZnlThz7Pq2BdhAE",
            "fields": {
                "name": { "stringValue": "Ada" },
                "age": { "stringValue": "34" },
                "gender": { "stringValue": "Female" },
                "address": { "stringValue": "somewhere" },
                "tel_number": { "stringValue": "0800000000" },
                "pose1_avg": { "doubleValue": 76.75 },
                "count_pose1": { "integerValue": "12" }
            }
        });

        let parsed = parse_remote_patient(&document).expect("must parse");
        assert_eq!(parsed.id, "1vP4WZnlThz7Pq2BdhAE");
        assert_eq!(parsed.name, "Ada");
        assert_eq!(parsed.revision, 0, "missing revision defaults to 0");
        assert_eq!(parsed.local_state, PatientState::Active);
        assert_eq!(parsed.total_sessions, None);
    }

    #[test]
    fn parses_a_document_with_aggregates() {
        let document = json!({
            "name": "projects/pilates-ai/databases/(default)/documents/patients/abc",
            "fields": {
                "name": { "stringValue": "Grace" },
                "revision": { "integerValue": "7" },
                "total_sessions": { "integerValue": "9" },
                "lifetime_avg_score": { "integerValue": "90" },
                "last_active": { "stringValue": "2026-02-02T00:00:00Z" },
                "local_state": { "stringValue": "tombstone" }
            }
        });

        let parsed = parse_remote_patient(&document).expect("must parse");
        assert_eq!(parsed.revision, 7);
        assert_eq!(parsed.total_sessions, Some(9));
        assert_eq!(parsed.lifetime_avg_score, Some(90.0), "integer doubles coerce");
        assert_eq!(parsed.local_state, PatientState::Tombstone);
    }

    #[test]
    fn documents_without_a_name_are_skipped() {
        let document = json!({
            "name": "projects/p/databases/(default)/documents/patients/abc",
            "fields": { "age": { "stringValue": "30" } }
        });
        assert!(parse_remote_patient(&document).is_none());
    }
}
