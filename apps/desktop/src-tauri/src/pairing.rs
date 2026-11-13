//! Workstation credentials: email/password sign-in, device-code pairing, and
//! the stored refresh token.
//!
//! There are two ways to obtain the credential, and both end in the same place:
//!
//! * **Sign-in** — a colleague types their clinic email and password once. This
//!   is the easy path: no code, no second device. The password is used for one
//!   request and never stored.
//! * **Pairing** — a shared or unattended machine shows a code, a clinician
//!   approves it in the portal, and this module exchanges the custom token.
//!
//! Either way the persisted credential is a Firebase refresh token in
//! `auth.json`, so sync has one code path.
//!
//! Why a separate file from `cloud.json`: `cloud.json` is hand-edited by
//! administrators and copied between machines. A refresh token must not travel
//! with it, or copying the file would clone the first workstation's identity.
//! Deleting `auth.json` is the documented way to sign in again.

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

/// Email/password sign-in, used by the easy first-run path.
const SIGN_IN_WITH_PASSWORD: &str =
    "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword";

/// Public Firebase identifiers for the clinic project.
///
/// These are not secrets — the same values ship in the portal's JavaScript
/// bundle. They are needed on a *clean* install, before any `cloud.json`
/// exists, because pairing is the first thing that install does.
pub const DEFAULT_API_KEY: &str = "AIzaSyA_FsX3RBj7bxjO9dMx5QOh2X_JnvBVToo";
pub const DEFAULT_PROJECT_ID: &str = "pilates-ai";

/// File holding the workstation's credential, beside `cloud.json`.
const AUTH_FILENAME: &str = "auth.json";

/// Credential format written by this version.
///
/// Version 1 is the pairing-era file. It is deliberately treated as stale: a
/// credential created before the sign-in model must be confirmed once, so an
/// upgraded machine cannot keep syncing as an account nobody chose in this
/// version. The password is never involved — the user signs in again and the
/// new refresh token replaces the old one.
pub const CREDENTIAL_SCHEMA_VERSION: u32 = 2;

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

/// Read the stored credential, or `None` when this workstation must sign in.
///
/// A corrupt, half-written or older-format file is treated as no credential:
/// the user signs in again, and the app still opens to the sign-in screen.
pub fn load_auth_from(path: &Path) -> Option<AuthState> {
    let text = crate::pose_config::read_config_text(path).ok()?;
    let state: AuthState = serde_json::from_str(&text).ok()?;
    if state.refresh_token.trim().is_empty() {
        return None;
    }
    if state.schema_version < CREDENTIAL_SCHEMA_VERSION {
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

/// Remove the credential. The next launch shows the sign-in screen.
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
/// Only `Present` with a current schema version counts as signed in. A missing,
/// unreadable or older-format file all show the sign-in screen: a credential
/// nobody confirmed in this version must not silently keep syncing.
pub enum AuthFile {
    /// No credential: a first run.
    Missing,
    /// A file is there but unreadable or malformed.
    Unreadable,
    /// A pairing-era credential that must be confirmed once by signing in.
    Stale,
    Present(AuthState),
}

pub fn auth_file_state() -> AuthFile {
    let path = auth_path();
    if !path.exists() {
        return AuthFile::Missing;
    }
    match crate::pose_config::read_config_text(&path) {
        Ok(text) => match serde_json::from_str::<AuthState>(&text) {
            Ok(state) if !state.refresh_token.trim().is_empty() => {
                if state.schema_version < CREDENTIAL_SCHEMA_VERSION {
                    AuthFile::Stale
                } else {
                    AuthFile::Present(state)
                }
            }
            _ => AuthFile::Unreadable,
        },
        Err(_) => AuthFile::Unreadable,
    }
}

/// True only when the workstation has a credential created by this version.
///
/// A rejected token still never hides the patient list: this reports whether a
/// credential exists, not whether the server accepts it.
pub fn is_paired() -> bool {
    matches!(auth_file_state(), AuthFile::Present(_))
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
        schema_version: CREDENTIAL_SCHEMA_VERSION,
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

/// What Identity Toolkit returns for a password sign-in.
#[derive(Debug, Deserialize)]
struct PasswordSignInResponse {
    #[serde(rename = "refreshToken")]
    refresh_token: String,
    #[serde(rename = "idToken")]
    id_token: String,
}

/// Sign this workstation in with a clinic account.
///
/// This is the low-friction path for a colleague's own laptop: one form, one
/// credential, no code and no second device. The password is used for a single
/// request and never written anywhere — the persisted credential is the same
/// refresh token pairing produces, so sync has one code path.
///
/// Any account that exists in Firebase Auth is accepted. Accounts are created
/// only by the administrator in the Firebase console, and new-user sign-up is
/// disabled, so account existence is the roster. Firestore still refuses the
/// request if the account has been disabled.
pub fn sign_in(
    client: &Client,
    api_key: &str,
    email: &str,
    password: &str,
    instance_id: &str,
) -> EngineResult<AuthState> {
    if email.trim().is_empty() || password.is_empty() {
        return Err(EngineError::Invalid(
            "Enter the email and password your supervisor gave you.".into(),
        ));
    }

    let response = client
        .post(format!("{SIGN_IN_WITH_PASSWORD}?key={api_key}"))
        .json(&json!({
            "email": email.trim(),
            "password": password,
            "returnSecureToken": true,
        }))
        .send()
        .map_err(|error| {
            // The detail is for the log; the clinician gets something actionable.
            eprintln!("[pilates] sign-in request failed: {error}");
            EngineError::Sync(
                "Could not reach the sign-in service. Check the connection and try again.".into(),
            )
        })?;

    let status = response.status();
    let text = response.text().unwrap_or_default();

    if !status.is_success() {
        return Err(EngineError::Sync(sign_in_failure(&text, status.as_u16())));
    }

    let parsed: PasswordSignInResponse = serde_json::from_str(&text)
        .map_err(|error| EngineError::Sync(format!("sign-in response: {error}")))?;

    if parsed.refresh_token.trim().is_empty() || parsed.id_token.trim().is_empty() {
        return Err(EngineError::Sync(
            "Sign-in did not return a credential. Try again.".into(),
        ));
    }

    let state = AuthState {
        schema_version: CREDENTIAL_SCHEMA_VERSION,
        refresh_token: parsed.refresh_token,
        paired_at: chrono::Utc::now().to_rfc3339(),
        instance_id: instance_id.to_string(),
    };
    save_auth(&state)?;
    // Same post-conditions as pairing: a clean install has no project config,
    // and the shared password (if any) is now obsolete.
    ensure_cloud_config()?;
    clear_legacy_password();
    Ok(state)
}

/// Turn an Identity Toolkit error body into something a clinician can act on.
///
/// Firebase deliberately merges "unknown email" and "wrong password" into one
/// code, so this must not try to tell them apart.
fn sign_in_failure(body: &str, status: u16) -> String {
    let code = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(|message| message.as_str())
                .map(str::to_string)
        })
        .unwrap_or_default();

    match code.as_str() {
        "EMAIL_NOT_FOUND" | "INVALID_PASSWORD" | "INVALID_LOGIN_CREDENTIALS" => {
            "Email or password is incorrect.".to_string()
        }
        "INVALID_EMAIL" => "That does not look like an email address.".to_string(),
        "USER_DISABLED" => "This account has been disabled. Ask your supervisor.".to_string(),
        "TOO_MANY_ATTEMPTS_TRY_LATER" => {
            "Too many attempts. Wait a few minutes and try again.".to_string()
        }
        _ if status == 429 => "Too many attempts. Wait a few minutes and try again.".to_string(),
        _ if status >= 500 => {
            "The sign-in service is unavailable. Try again shortly.".to_string()
        }
        _ => "Sign-in was rejected. Check the email and password, then try again.".to_string(),
    }
}

/// Blank the shared password in `cloud.json` after a successful sign-in or
/// pairing.
///
/// Deliberately infallible. The credential is already stored by the time this
/// runs; reporting a failure here would tell the user it did not work when it
/// did. If the rewrite fails the password simply stays, which is the more
/// forgiving state.
///
/// The email is kept: it is not a secret and makes the workstation identifiable
/// in `cloud.json`. The password is removed because it has no remaining use:
/// `cloud.json` is never a credential, and deleting `auth.json` always returns
/// the workstation to the sign-in screen.
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
        // A 5xx or 429 is the service being unavailable; a 400/401/403 is the
        // credential being refused. Only the latter needs the user to sign in.
        if status.as_u16() >= 500 || status.as_u16() == 429 {
            return Err(EngineError::Sync(format!(
                "the sign-in service is unavailable ({status})"
            )));
        }
        eprintln!("[pilates] token refresh rejected ({status})");
        return Err(EngineError::Auth(
            "This workstation's sign-in was rejected. Sign in again to resume syncing.".into(),
        ));
    }

    let value: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| EngineError::Sync(format!("token refresh response: {e}")))?;

    let id_token = value
        .get("id_token")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    if id_token.is_empty() {
        return Err(EngineError::Auth(
            "The sign-in service returned no token. Sign in again.".into(),
        ));
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
            schema_version: CREDENTIAL_SCHEMA_VERSION,
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
        std::fs::write(&path, r#"{"schema_version":2,"refresh_token":"  "}"#).expect("write");

        assert!(load_auth_from(&path).is_none());

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_missing_file_reads_as_unpaired() {
        assert!(load_auth_from(&temp_path(AUTH_FILENAME)).is_none());
    }

    #[test]
    fn an_installation_from_before_pairing_is_gated() {
        // A cloud.json email and password is no longer a credential: a machine
        // that predates pairing must show the sign-in screen rather than sync
        // silently as whatever shared account the file happens to hold.
        let _guard = DATA_DIR_ENV.lock().unwrap_or_else(|error| error.into_inner());
        let dir = std::env::temp_dir().join(format!("pilates-legacy-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("dir");
        let _env = DataDir::set(&dir);
        std::fs::write(
            dir.join("cloud.json"),
            r#"{"project_id":"pilates-ai","api_key":"k","bucket":"","email":"clinician@example.com","password":"secret"}"#,
        )
        .expect("write");

        assert!(matches!(auth_file_state(), AuthFile::Missing));
        assert!(!is_paired(), "a cloud.json password must not bypass sign-in");
        assert!(load_auth().is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_pairing_era_credential_requires_a_fresh_sign_in() {
        // Strict upgrade: the pairing-era file is stale, so the app gates once
        // and the user confirms the account. The new credential then persists.
        let _guard = DATA_DIR_ENV.lock().unwrap_or_else(|error| error.into_inner());
        let dir = std::env::temp_dir().join(format!("pilates-stale-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("dir");
        let _env = DataDir::set(&dir);
        std::fs::write(
            dir.join(AUTH_FILENAME),
            r#"{"schema_version":1,"refresh_token":"old-token"}"#,
        )
        .expect("write");

        assert!(matches!(auth_file_state(), AuthFile::Stale));
        assert!(!is_paired(), "a pairing-era credential must not open the app");
        assert!(load_auth().is_none());

        save_auth(&AuthState {
            schema_version: CREDENTIAL_SCHEMA_VERSION,
            refresh_token: "new-token".into(),
            paired_at: String::new(),
            instance_id: String::new(),
        })
        .expect("save");

        assert!(is_paired());
        assert_eq!(load_auth().expect("load").refresh_token, "new-token");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_utf8_bom_does_not_break_the_file() {
        let path = temp_path(AUTH_FILENAME);
        std::fs::create_dir_all(path.parent().unwrap()).expect("dir");
        std::fs::write(
            &path,
            "\u{feff}{\"schema_version\":2,\"refresh_token\":\"bom-token\"}",
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
    fn an_unreadable_credential_gates() {
        // A file that exists but cannot be parsed is not a credential. Opening
        // the patient list from it would mean a machine nobody can prove is
        // signed in still shows clinical data.
        let _guard = DATA_DIR_ENV.lock().unwrap_or_else(|error| error.into_inner());
        let dir = std::env::temp_dir().join(format!("pilates-bad-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("dir");
        let _env = DataDir::set(&dir);
        std::fs::write(dir.join(AUTH_FILENAME), "not json at all").expect("write");

        assert!(matches!(auth_file_state(), AuthFile::Unreadable));
        assert!(!is_paired(), "an unreadable credential must not fail open");
        assert!(load_auth().is_none());

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

    #[test]
    fn sign_in_rejects_an_empty_form_before_any_request() {
        // A plain client is enough: validation must return before a request is
        // attempted, so this test never touches the network.
        let client = Client::new();
        assert!(sign_in(&client, "key", "  ", "secret", "instance-1").is_err());
        assert!(sign_in(&client, "key", "a@b.c", "", "instance-1").is_err());
    }

    #[test]
    fn sign_in_errors_are_actionable_and_do_not_leak_codes() {
        let wrong = r#"{"error":{"code":400,"message":"INVALID_LOGIN_CREDENTIALS"}}"#;
        assert_eq!(sign_in_failure(wrong, 400), "Email or password is incorrect.");

        let disabled = r#"{"error":{"code":400,"message":"USER_DISABLED"}}"#;
        assert!(sign_in_failure(disabled, 400).contains("disabled"));
        assert!(sign_in_failure("{}", 429).contains("Too many attempts"));
        assert!(sign_in_failure("not json", 500).contains("unavailable"));

        // An unrecognised code must not reach the user verbatim.
        let unknown = sign_in_failure(r#"{"error":{"message":"SOMETHING_NEW"}}"#, 400);
        assert!(!unknown.contains("SOMETHING_NEW"));
    }
}
