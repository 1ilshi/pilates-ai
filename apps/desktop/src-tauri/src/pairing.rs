//! Device-code pairing and the stored refresh token.
//!
//! A workstation with no credential shows a code; a clinician approves it in
//! the portal; this module collects the resulting custom token and exchanges it
//! for a Firebase refresh token, which is stored in `auth.json`.
//!
//! Why a separate file from `cloud.json`: `cloud.json` is hand-edited by
//! administrators and copied between machines. A refresh token must not travel
//! with it, or copying the file would clone the first workstation's identity.
//! Deleting `auth.json` is the documented way to re-pair.

use std::path::{Path, PathBuf};

use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::error::{EngineError, EngineResult};

/// Device pairing endpoints, deployed in `asia-east2` beside the database.
const PAIRING_BASE: &str = "https://asia-east2-pilates-ai.cloudfunctions.net";

/// Identity Toolkit endpoints used to turn a custom token into a refresh token.
const SIGN_IN_WITH_CUSTOM_TOKEN: &str =
    "https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken";
const SECURE_TOKEN: &str = "https://securetoken.googleapis.com/v1/token";

/// Public Firebase identifiers for the clinic project.
///
/// These are not secrets — the same values ship in the portal's JavaScript
/// bundle. They are needed on a *clean* install, before any `cloud.json`
/// exists, because pairing is the first thing that install does.
pub const DEFAULT_API_KEY: &str = "AIzaSyA_FsX3RBj7bxjO9dMx5QOh2X_JnvBVToo";
pub const DEFAULT_PROJECT_ID: &str = "pilates-ai";

/// File holding the workstation's credential, beside `cloud.json`.
const AUTH_FILENAME: &str = "auth.json";

/// What `pairStart` returns and the user is shown.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PairingStart {
    /// `ABCD-EFGH`, for display.
    pub code: String,
    /// Kept in memory only; never written to disk.
    pub secret: String,
    pub expires_at: String,
}

/// The stored credential.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AuthState {
    #[serde(default)]
    pub schema_version: u32,
    pub refresh_token: String,
    #[serde(default)]
    pub paired_at: String,
    /// Binds the pairing to this machine so it is identifiable in audit.
    #[serde(default)]
    pub instance_id: String,
}

/// Outcome of one poll.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PollOutcome {
    /// The clinician has not approved yet.
    Pending,
    /// Approved; the custom token must be exchanged immediately.
    Approved(String),
}

pub fn auth_path() -> PathBuf {
    crate::paths::data_dir().join(AUTH_FILENAME)
}

/// Read the stored credential, or `None` when the workstation is unpaired.
///
/// A corrupt or half-written file is treated as unpaired rather than an error:
/// the user can re-pair, and the app must still open.
pub fn load_auth_from(path: &Path) -> Option<AuthState> {
    let text = crate::pose_config::read_config_text(path).ok()?;
    let state: AuthState = serde_json::from_str(&text).ok()?;
    if state.refresh_token.trim().is_empty() {
        return None;
    }
    Some(state)
}

pub fn load_auth() -> Option<AuthState> {
    load_auth_from(&auth_path())
}

/// Write the credential, creating the directory if needed.
pub fn save_auth_to(path: &Path, state: &AuthState) -> EngineResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| EngineError::Storage(format!("could not create {}: {e}", parent.display())))?;
    }
    let body = serde_json::to_string_pretty(state)
        .map_err(|e| EngineError::Storage(format!("auth encode: {e}")))?;
    std::fs::write(path, body)
        .map_err(|e| EngineError::Storage(format!("could not write {}: {e}", path.display())))
}

pub fn save_auth(state: &AuthState) -> EngineResult<()> {
    save_auth_to(&auth_path(), state)
}

/// Remove the credential. The next launch shows the pairing screen.
pub fn clear_auth() -> EngineResult<()> {
    let path = auth_path();
    if path.exists() {
        std::fs::remove_file(&path)
            .map_err(|e| EngineError::Storage(format!("could not remove {}: {e}", path.display())))?;
    }
    Ok(())
}

/// What the credential file looks like on disk.
///
/// Three states, not two: a file that exists but cannot be read is **not** the
/// same as no file at all. Treating them alike would show the pairing gate to a
/// workstation that is already paired, hiding its local patient list behind a
/// screen that needs the network — the failure this whole design exists to
/// prevent.
pub enum AuthFile {
    /// No credential: a first run, and the only case that gates.
    Missing,
    /// A file is there but unreadable or malformed. Fail open.
    Unreadable,
    Present(AuthState),
}

pub fn auth_file_state() -> AuthFile {
    let path = auth_path();
    if !path.exists() {
        return AuthFile::Missing;
    }
    match crate::pose_config::read_config_text(&path) {
        Ok(text) => match serde_json::from_str::<AuthState>(&text) {
            Ok(state) if !state.refresh_token.trim().is_empty() => AuthFile::Present(state),
            _ => AuthFile::Unreadable,
        },
        Err(_) => AuthFile::Unreadable,
    }
}

/// True when the workstation has a credential at all.
///
/// Note this says nothing about whether the credential still works — a rejected
/// token must never hide the patient list.
///
/// A `cloud.json` with an email and password is a credential too. Installations
/// that predate pairing have one and no `auth.json`; gating them would force
/// every existing clinic workstation to re-pair after an update, and would lock
/// them out of the patient list entirely if the pairing service is unreachable.
pub fn is_paired() -> bool {
    match auth_file_state() {
        AuthFile::Present(_) => true,
        // Fail open. Sync will report the problem; the patient list stays.
        AuthFile::Unreadable => true,
        AuthFile::Missing => legacy_credential_present(crate::cloud_sync::CloudConfig::load().as_ref()),
    }
}

/// Whether a `cloud.json` credential is complete enough to authenticate.
fn legacy_credential_present(config: Option<&crate::cloud_sync::CloudConfig>) -> bool {
    config
        .map(|config| {
            !config.email.trim().is_empty() && !config.password.trim().is_empty()
        })
        .unwrap_or(false)
}

/// Accept what a human types: lowercase, spaces, or the displayed dash.
pub fn normalise_code(raw: &str) -> String {
    raw.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_uppercase()
}

fn post_json(
    client: &Client,
    url: &str,
    body: serde_json::Value,
) -> EngineResult<serde_json::Value> {
    let response = client
        .post(url)
        .json(&body)
        .send()
        .map_err(|e| EngineError::Sync(format!("pairing request failed: {e}")))?;

    let status = response.status();
    let text = response.text().unwrap_or_default();

    if !status.is_success() {
        // Never include the body verbatim: it can echo a request value.
        return Err(EngineError::Sync(format!(
            "pairing request rejected ({status})"
        )));
    }

    serde_json::from_str(&text)
        .map_err(|e| EngineError::Sync(format!("pairing response: {e}")))
}

/// Ask for a code to show the user.
pub fn start(client: &Client, instance_id: &str) -> EngineResult<PairingStart> {
    let value = post_json(
        client,
        &format!("{PAIRING_BASE}/pairStart"),
        json!({ "instance_id": instance_id }),
    )?;

    Ok(PairingStart {
        code: value
            .get("code")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        secret: value
            .get("secret")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        expires_at: value
            .get("expires_at")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
    })
}

/// Poll once. `Pending` means keep waiting.
pub fn poll(client: &Client, code: &str, secret: &str) -> EngineResult<PollOutcome> {
    let response = client
        .post(format!("{PAIRING_BASE}/pairPoll"))
        .json(&json!({ "code": code, "secret": secret }))
        .send()
        .map_err(|e| EngineError::Sync(format!("pairing poll failed: {e}")))?;

    let status = response.status();
    let text = response.text().unwrap_or_default();

    if status.as_u16() == 202 {
        return Ok(PollOutcome::Pending);
    }
    if !status.is_success() {
        return Err(EngineError::Sync(format!(
            "pairing poll rejected ({status})"
        )));
    }

    let value: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| EngineError::Sync(format!("pairing poll response: {e}")))?;

    match value.get("custom_token").and_then(|v| v.as_str()) {
        Some(token) if !token.is_empty() => Ok(PollOutcome::Approved(token.to_string())),
        _ => Ok(PollOutcome::Pending),
    }
}

/// Exchange a custom token for a refresh token and persist it.
pub fn exchange_custom_token(
    client: &Client,
    api_key: &str,
    custom_token: &str,
    instance_id: &str,
) -> EngineResult<AuthState> {
    let value = post_json(
        client,
        &format!("{SIGN_IN_WITH_CUSTOM_TOKEN}?key={api_key}"),
        json!({ "token": custom_token, "returnSecureToken": true }),
    )?;

    let refresh_token = value
        .get("refreshToken")
        .and_then(|v| v.as_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| EngineError::Sync("pairing exchange returned no refresh token".into()))?
        .to_string();

    let state = AuthState {
        schema_version: 1,
        refresh_token,
        paired_at: chrono::Utc::now().to_rfc3339(),
        instance_id: instance_id.to_string(),
    };
    save_auth(&state)?;
    // A pairing on a clean install has no `cloud.json`, and without one the
    // sync client has no project to talk to: the app would open, look healthy,
    // and upload nothing. Write the project details pairing already implies.
    ensure_cloud_config()?;
    // Once there is a token, the shared password has no purpose and is the
    // thing pairing exists to remove. Best effort: if the file cannot be
    // rewritten, keeping the password is the safe outcome, never a failed pair.
    clear_legacy_password();
    Ok(state)
}

/// Blank the shared password in `cloud.json` after a successful pairing.
///
/// Deliberately infallible. Pairing has already succeeded by the time this
/// runs; reporting a failure here would tell the user pairing did not work
/// when it did. If the rewrite fails the password simply stays, which is the
/// more forgiving state.
///
/// The email is kept: it is not a secret and makes the workstation identifiable
/// in `cloud.json`. With the password empty, `is_paired` no longer counts this
/// file as a credential, so deleting `auth.json` really does re-trigger pairing.
pub fn clear_legacy_password() {
    let path = crate::paths::data_dir().join("cloud.json");
    let Ok(text) = crate::pose_config::read_config_text(&path) else {
        return;
    };
    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return;
    };
    let Some(object) = value.as_object_mut() else {
        return;
    };
    let present = object
        .get("password")
        .and_then(|entry| entry.as_str())
        .map(|password| !password.is_empty())
        .unwrap_or(false);
    if !present {
        return;
    }

    object.insert("password".into(), serde_json::Value::String(String::new()));
    match serde_json::to_string_pretty(&value) {
        Ok(body) => {
            if let Err(error) = std::fs::write(&path, body) {
                eprintln!(
                    "[pilates] paired, but could not remove the password from {}: {error}",
                    path.display()
                );
            }
        }
        Err(error) => eprintln!("[pilates] cloud config encode failed: {error}"),
    }
}

/// Bucket the telemetry archive is written to.
///
/// Fixed per deployment, like `DEFAULT_PROJECT_ID`: the workstation is paired
/// to one clinic project.
pub const DEFAULT_BUCKET: &str = "pilates-ai.firebasestorage.app";

/// Write a minimal `cloud.json` when pairing ran on a machine that had none.
///
/// It carries no password — the refresh token in `auth.json` is the credential.
/// An existing `cloud.json` is never touched: it may hold a clinic's own
/// project, bucket or legacy password.
pub fn ensure_cloud_config() -> EngineResult<()> {
    let path = crate::paths::data_dir().join("cloud.json");
    if path.exists() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            EngineError::Storage(format!("could not create {}: {e}", parent.display()))
        })?;
    }

    let config = serde_json::json!({
        "project_id": DEFAULT_PROJECT_ID,
        "api_key": DEFAULT_API_KEY,
        "bucket": DEFAULT_BUCKET,
        "email": "",
        "password": "",
    });
    let body = serde_json::to_string_pretty(&config)
        .map_err(|e| EngineError::Storage(format!("cloud config encode: {e}")))?;
    std::fs::write(&path, body)
        .map_err(|e| EngineError::Storage(format!("could not write {}: {e}", path.display())))
}

/// Exchange a stored refresh token for a fresh ID token.
pub fn refresh_id_token(
    client: &Client,
    api_key: &str,
    refresh_token: &str,
) -> EngineResult<(String, u64)> {
    let response = client
        .post(format!("{SECURE_TOKEN}?key={api_key}"))
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
        ])
        .send()
        .map_err(|e| EngineError::Sync(format!("token refresh failed: {e}")))?;

    let status = response.status();
    let text = response.text().unwrap_or_default();
    if !status.is_success() {
        return Err(EngineError::Sync(format!(
            "token refresh rejected ({status})"
        )));
    }

    let value: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| EngineError::Sync(format!("token refresh response: {e}")))?;

    let id_token = value
        .get("id_token")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    if id_token.is_empty() {
        return Err(EngineError::Sync("token refresh returned no ID token".into()));
    }

    let expires_in = value
        .get("expires_in")
        .and_then(|v| v.as_str())
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(3600);

    Ok((id_token, expires_in))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> PathBuf {
        std::env::temp_dir()
            .join(format!("pilates-pairing-{}", uuid::Uuid::new_v4()))
            .join(name)
    }

    #[test]
    fn a_typed_code_is_normalised() {        assert_eq!(normalise_code("abcd-efgh"), "ABCDEFGH");
        assert_eq!(normalise_code(" ABCD EFGH "), "ABCDEFGH");
        assert_eq!(normalise_code("AB-CD-EF-GH"), "ABCDEFGH");
        assert_eq!(normalise_code(""), "");
    }

    #[test]
    fn a_saved_credential_is_read_back() {
        let path = temp_path(AUTH_FILENAME);
        let state = AuthState {
            schema_version: 1,
            refresh_token: "token-value".into(),
            paired_at: "2026-01-01T00:00:00Z".into(),
            instance_id: "instance-1".into(),
        };
        save_auth_to(&path, &state).expect("save");

        let loaded = load_auth_from(&path).expect("load");
        assert_eq!(loaded.refresh_token, "token-value");
        assert_eq!(loaded.instance_id, "instance-1");

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_corrupt_file_reads_as_unpaired() {
        let path = temp_path(AUTH_FILENAME);
        std::fs::create_dir_all(path.parent().unwrap()).expect("dir");
        std::fs::write(&path, "{ not json").expect("write");

        // Unpaired, not a crash: the user can re-pair.
        assert!(load_auth_from(&path).is_none());

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_file_without_a_token_reads_as_unpaired() {
        let path = temp_path(AUTH_FILENAME);
        std::fs::create_dir_all(path.parent().unwrap()).expect("dir");
        std::fs::write(&path, r#"{"schema_version":1,"refresh_token":"  "}"#).expect("write");

        assert!(load_auth_from(&path).is_none());

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_missing_file_reads_as_unpaired() {
        assert!(load_auth_from(&temp_path(AUTH_FILENAME)).is_none());
    }

    #[test]
    fn an_installation_from_before_pairing_is_not_gated() {
        // The upgrade path: a workstation with a working cloud.json credential
        // and no auth.json must go straight to the patient list. Gating it would
        // force every existing clinic machine to re-pair, and lock it out
        // entirely if the pairing service were unreachable.
        let config = crate::cloud_sync::CloudConfig {
            project_id: "pilates-ai".into(),
            api_key: "key".into(),
            bucket: String::new(),
            email: "desktopaccess@pilatesai.com".into(),
            password: "secret".into(),
        };
        assert!(legacy_credential_present(Some(&config)));

        let no_password = crate::cloud_sync::CloudConfig {
            password: String::new(),
            ..config.clone()
        };
        assert!(!legacy_credential_present(Some(&no_password)));

        let blank_email = crate::cloud_sync::CloudConfig {
            email: "   ".into(),
            ..config
        };
        assert!(!legacy_credential_present(Some(&blank_email)));

        assert!(!legacy_credential_present(None));
    }

    #[test]
    fn a_utf8_bom_does_not_break_the_file() {
        let path = temp_path(AUTH_FILENAME);
        std::fs::create_dir_all(path.parent().unwrap()).expect("dir");
        std::fs::write(
            &path,
            "\u{feff}{\"schema_version\":1,\"refresh_token\":\"bom-token\"}",
        )
        .expect("write");

        let loaded = load_auth_from(&path).expect("BOM tolerated");
        assert_eq!(loaded.refresh_token, "bom-token");

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// `PILATES_AI_DATA_DIR` is process-global; these tests must not overlap.
    static DATA_DIR_ENV: std::sync::Mutex<()> = std::sync::Mutex::new(());

    struct DataDir(Option<std::ffi::OsString>);

    impl DataDir {
        fn set(dir: &Path) -> Self {
            let previous = std::env::var_os("PILATES_AI_DATA_DIR");
            std::env::set_var("PILATES_AI_DATA_DIR", dir);
            Self(previous)
        }
    }

    impl Drop for DataDir {
        fn drop(&mut self) {
            match self.0.take() {
                Some(value) => std::env::set_var("PILATES_AI_DATA_DIR", value),
                None => std::env::remove_var("PILATES_AI_DATA_DIR"),
            }
        }
    }

    #[test]
    fn pairing_on_a_clean_install_writes_a_project_config() {
        // Without this the workstation pairs, opens, and uploads nothing: it
        // has a token but no project to talk to.
        let _guard = DATA_DIR_ENV.lock().unwrap_or_else(|error| error.into_inner());
        let dir = std::env::temp_dir().join(format!("pilates-clean-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("dir");
        let _env = DataDir::set(&dir);

        ensure_cloud_config().expect("write config");

        let text = std::fs::read_to_string(dir.join("cloud.json")).expect("cloud.json written");
        let config: crate::cloud_sync::CloudConfig =
            serde_json::from_str(&text).expect("valid config");
        assert_eq!(config.project_id, DEFAULT_PROJECT_ID);
        assert_eq!(config.api_key, DEFAULT_API_KEY);
        assert_eq!(config.bucket, DEFAULT_BUCKET);
        // No password: the refresh token is the credential.
        assert!(config.password.is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unreadable_credential_does_not_gate() {
        // A file that exists but cannot be parsed must not be mistaken for a
        // first run: that would hide the local patient list behind a screen
        // that needs the network.
        let _guard = DATA_DIR_ENV.lock().unwrap_or_else(|error| error.into_inner());
        let dir = std::env::temp_dir().join(format!("pilates-bad-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("dir");
        let _env = DataDir::set(&dir);
        std::fs::write(dir.join(AUTH_FILENAME), "not json at all").expect("write");

        assert!(matches!(auth_file_state(), AuthFile::Unreadable));
        assert!(is_paired(), "an unreadable credential must fail open");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pairing_removes_the_shared_password() {
        let _guard = DATA_DIR_ENV.lock().unwrap_or_else(|error| error.into_inner());
        let dir = std::env::temp_dir().join(format!("pilates-pair-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("dir");
        let _env = DataDir::set(&dir);
        let path = dir.join("cloud.json");
        std::fs::write(
            &path,
            r#"{"project_id":"pilates-ai","api_key":"k","bucket":"b","email":"e@x","password":"secret"}"#,
        )
        .expect("write");

        clear_legacy_password();

        let text = std::fs::read_to_string(&path).expect("read");
        let value: serde_json::Value = serde_json::from_str(&text).expect("json");
        assert_eq!(value["password"], "");
        // The email is not a secret and stays, for identification.
        assert_eq!(value["email"], "e@x");
        // With no password this file is no longer a credential, so deleting
        // auth.json re-triggers pairing instead of silently continuing.
        let config: crate::cloud_sync::CloudConfig =
            serde_json::from_str(&text).expect("valid config");
        assert!(!legacy_credential_present(Some(&config)));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_existing_cloud_config_is_left_alone() {
        // A clinic may point the workstation at its own project or bucket.
        let _guard = DATA_DIR_ENV.lock().unwrap_or_else(|error| error.into_inner());
        let dir = std::env::temp_dir().join(format!("pilates-clean-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("dir");
        let _env = DataDir::set(&dir);
        let path = dir.join("cloud.json");
        std::fs::write(
            &path,
            r#"{"project_id":"other","api_key":"k","bucket":"b","email":"e","password":"p"}"#,
        )
        .expect("write");

        ensure_cloud_config().expect("no error");

        let text = std::fs::read_to_string(&path).expect("still there");
        assert!(text.contains("\"other\""), "existing config was overwritten: {text}");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
