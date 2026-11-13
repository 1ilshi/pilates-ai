# Testing Pilates AI yourself

This guide covers everything currently implemented. You can verify a lot of it
**without a webcam**, and the rest needs a camera.

---

## 1. Prerequisites

| Tool | Check with | Notes |
| :--- | :--- | :--- |
| Node.js 22 | `node --version` | What CI runs |
| pnpm | `pnpm --version` | `corepack enable pnpm` if missing |
| Rust (MSVC toolchain) | `cargo --version` | `rustup default stable-x86_64-pc-windows-msvc` |
| Visual Studio Build Tools | `cl.exe` in a Developer prompt | "Desktop development with C++" + a Windows 10/11 SDK |
| Python 3.12 | `.venv\Scripts\python.exe --version` | Only for the tooling scripts |

> **Why MSVC and not MinGW.** The Tauri bundler needs `windres`/`rc.exe` to embed
> the application icon and manifest. That step works with MSVC and the Windows
> SDK; the GNU toolchain has no `windres` on this machine. CI builds with
> `x86_64-pc-windows-msvc`, so building the same way locally is what keeps
> "works on my machine" honest.
>
> **PATH matters.** Cargo lives in `%USERPROFILE%\.cargo\bin`:
> ```powershell
> $env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
> ```
> The MSVC linker and SDK are only on PATH inside a Developer PowerShell, or
> after calling `vcvars64.bat`.

---

## 2. First-time setup

```powershell
cd C:\Users\muham\OneDrive\Documents\pilates-ai

# 1. JS dependencies
pnpm install

# 2. Build the shared packages (types, ui, viz)
pnpm turbo run build

# 3. Download ONNX Runtime (~17 MB, SHA-256 verified)
.venv\Scripts\python.exe tools\fetch_onnxruntime.py
```

Step 3 is **required for the AI features**. Without it the app still runs and
the patient/session UI works, but capture reports "inference unavailable".

---

## 3. Automated checks (no hardware needed)

These prove the logic works without a camera. Run all three:

```powershell
# A. Rust engine: 107 tests — start→end rep counting, joint angles, Parquet,
#    SQLite, inference, plus a hardware-free pipeline through real capture
cd apps\desktop\src-tauri
cargo test
cd ..\..

# B. Frontend components: 45 checks — renders + geometry
pnpm --filter @pilates/viz smoke

# C. Pose config is in sync with the generated TypeScript
node tools\generate-pose-definitions.mjs --check

# D. Parquet read by an independent reader (polars, not the Arrow writer)
.venv\Scripts\python.exe tools\verify_parquet.py
```

Expected: `107 passed`, `ALL SMOKE CHECKS PASSED`, `[ OK ] pose definitions up to date`,
`PASSED: schema, nulls, list lengths and phase values all conform`.

**What each covers:**

| Check | Proves |
| :--- | :--- |
| `biomechanics` tests | 0°/45°/90°/180° angles; a rep only counts after a ≥3 s hold; short holds are rejected; multiple reps count |
| `telemetry` tests | Parquet writes and reads back with **zero null fields**; 2 Hz downsampling |
| `outbox` tests | SQLite WAL, revision bumping, cascade delete, retry-after-failure |
| `inference` tests | letterbox geometry, NMS, and a **real ONNX forward pass** (see below) |
| `viz smoke` | every UI primitive and chart renders without throwing |

### Confirm the AI model actually runs

```powershell
cd apps\desktop\src-tauri
cargo test runs_real_forward_pass -- --nocapture
```

If ONNX Runtime is installed you'll see something like:

```
forward pass ok: provider=Cpu 58.8 ms, 0 detections
```

`0 detections` is correct — the test feeds a synthetic gradient, not a person.
It proves the model loads, the tensor is built, ONNX Runtime executes, and the
output decodes. If the runtime is missing the test prints `SKIP ...` instead of
failing.

### Re-verify the ONNX exports against PyTorch

```powershell
.venv\Scripts\python.exe tools\verify_onnx.py
```

Expected: `RESULT: 5 passed, 0 failed`.

---

## 4. Run the desktop app

```powershell
pnpm --filter @pilates/desktop tauri dev
```

First launch compiles Rust and takes a few minutes. A 1280×850 window opens.

**If it fails immediately**, the usual causes are:

| Symptom | Fix |
| :--- | :--- |
| `rc.exe not found` / `LINK : fatal error LNK1181` | Build from a Developer PowerShell, or call `vcvars64.bat` (section 1) |
| `cannot open input file 'kernel32.lib'` | The Windows SDK is missing — install it via the VS Build Tools installer |
| `pose-definitions.json not found` | Run from the repo root, or set `PILATES_POSE_DEFINITIONS` |
| Blank window | Run `pnpm turbo run build` first so `dist/` exists |

---

## 5. Walk through the app

1. **Patients** tab → **New patient** → enter a name → **Save**.
   The patient appears in the table and in the sidebar as the active patient.
2. Click the patient name → jumps to **Pose Capture**.
3. Pick a pose from the dropdown (The Hundred, Roll Up, …).
4. Click **Preview** — you should see live video with a teal skeleton overlay.
5. Click **Start** → perform the movement → the gauge, rep counter and form
   score update live. A chime plays when a rep completes.
6. Click **Stop & save** (large red button) → the **Session Summary** tab opens
   with the angle trajectory, rep table and telemetry details.
7. Back on **Patients**, the **Sync** button shows the pending count.

### Where your data lives

```
%LOCALAPPDATA%\PilatesAI\pilates-desktop.db
```

Sessions are written here with their Parquet blob before any upload is
attempted. Inspect it with any SQLite browser, or:

```powershell
.venv\Scripts\python.exe -c "import sqlite3,os; c=sqlite3.connect(os.path.expandvars(r'%LOCALAPPDATA%\PilatesAI\pilates-desktop.db')); print(c.execute('select session_id,pose_id,upload_state,parquet_bytes from sessions').fetchall())"
```

> **Note on the old database.** The legacy Python app used
> `pilates.db` in the same folder with an incompatible schema. The desktop app
> deliberately uses a **different file** so the two can never corrupt each
> other. On first launch the desktop app imports the legacy patient records
> (read-only) into the new database and leaves the old file untouched.
> Deleting a patient is a soft delete (`local_state = 'tombstone'`) so the
> removal can still be synced to Firestore.

---

### How repetitions are counted

The models are **two-class classifiers**: `start` marks the beginning of the
movement and `end` marks the finish. A repetition is the transition between
them.

```
  IDLE ──confirmed 'start'──▶ ARMED ──confirmed 'end'──▶ 1 rep ──▶ IDLE
                                │
                                └── no 'end' within 20 s ──▶ IDLE
```

Per pose, in `config/pose-definitions.json`:

```json
"detection": {
  "start_class": "start",
  "end_class": "end",
  "min_confidence": 0.25,
  "confirm_frames": 3,
  "min_transition_sec": 0.5,
  "max_transition_sec": 20.0
}
```

- `confirm_frames` — a class must be seen this many consecutive frames before
  it is believed. This is what stops the flicker: a one-frame blip never
  changes state.
- `min_transition_sec` — a `start → end` faster than this is a misdetection,
  not a movement, and is discarded.
- `max_transition_sec` — an unmatched `start` expires, so a stray detection
  cannot pair with an `end` a minute later.
- Class matching is a case-insensitive **substring**, so `end` also matches
  `end left` and `end right` (pose4 is split by side).

A fresh `start` is required for every repetition, so holding `end` — or `end`
flickering — never adds reps. A `start` with no matching `end` is not a rep and
is discarded when the session stops.

To change the rules, edit the JSON and run
`node tools/generate-pose-definitions.mjs`. No rebuild of the Rust binary is
needed for the values to take effect on the next launch.

---

## 6. What to expect without a webcam

The app is designed to degrade rather than crash:

- Device enumeration returns an empty list.
- **Preview** / **Start** surface a typed error in the red banner.
- Everything else — patients, session history, sync controls — works normally.

---

## 7. Cloud sync

Sync is configured by **signing in** (section "Signing in"), which writes a
refresh token to `auth.json` in the app data directory. That is the credential:
`cloud.json` only carries project, API key and bucket, and its password field is
left empty.

A `cloud.json` missing `project_id` or `api_key` still disables sync, and the
sidebar says **"Cloud sync off — not configured"** rather than pretending.
Environment variables (`PILATES_FIREBASE_PROJECT_ID`, `PILATES_FIREBASE_API_KEY`,
`PILATES_FIREBASE_BUCKET`) are the fallback **only when no `cloud.json` exists**;
the file deliberately wins, because a value set after logon is never seen by an
app launched from Explorer.

`PILATES_FIREBASE_BUCKET` (or `bucket` in `cloud.json`) is **optional but
needed for archival**: without it the session document still reaches Firestore,
but `research_telemetry.storage_path` is absent and there is no Parquet. The
capture page shows an amber banner when it is unset.

A live end-to-end check of the pull path (skipped in normal CI runs):

```powershell
cd apps\desktop\src-tauri
cargo test pull_patients_from_live_firestore -- --ignored --nocapture
```

Expected: `pulled: fetched=18 imported=18 updated=0` and
`patients carrying legacy_json: 18`.

### Pulling the existing patient roster

Your Firestore already holds patients created by the earlier app. The desktop
pulls them automatically once signed in — there is **no button to press**.
The first sync after sign-in imports the roster; later changes arrive on the
60-second sweep or when the change marker moves.

Restart the app to force the first pull, or wait for the sidebar to read
`Synced just now`. The Patients page then shows the imported roster.

Notes on that data:

- Existing patients use Firestore **auto-ids**, not UUIDs. The app accepts both;
  new patients still get UUIDs.
- Fields the app does not model (`address`, `note`, `tel_number`) and the legacy
  `pose{N}_*` aggregates are **preserved** in Firestore — writes use a narrow
  `updateMask`, verified against the live database.
- The legacy per-pose accuracy metrics (2,231 documents) are a frozen archive.
  They are **not** converted into sessions: doing so would mean inventing reps
  and kinematic curves.

### Verifying the mask behaviour yourself

If you ever doubt that a patient update preserves unknown fields, create a
throwaway document, patch it with a narrow mask, and read it back — the app
never touches documents it does not own.

### Verifying the deployed aggregation function

`onSessionCreated` is deployed (2nd gen, `asia-east2`). After syncing a session,
the owning patient document should gain:

| Field | Expected |
| :--- | :--- |
| `total_sessions` | incremented by 1 |
| `lifetime_avg_score` | running weighted mean of `summary.mean_form_score` (pose accuracy) |
| `last_active` | the session's `completed_at` |

To check by hand, open the Firebase console → Firestore → `patients` → a
patient that has just completed a session. `sessionLedger/{sessionId}` records
each applied session so a trigger retry cannot double-count.

Deploy changes with:

```powershell
firebase deploy --only functions:onSessionCreated --project pilates-ai
```

> Deploy **only the named function**. A bare `firebase deploy --only functions`
> deletes every function not present in this repository. That is now the safe
> direction — the legacy functions are gone — but it will also remove
> `pairStart`, `pairApprove`, `pairPoll` and the portal-login function if they
> are not in the checkout you deploy from, which breaks pairing and the portal
> sign-in link.

---

## 8. The clinical web portal

Live at **https://pilates-ai.web.app** (also `https://pilates-ai.firebaseapp.com`).

```powershell
pnpm turbo run build                     # the portal imports the workspace packages
pnpm --filter @pilates/web dev           # http://localhost:3000
```

Sign in with a clinic account. You should see:

| Page | Expected |
| :--- | :--- |
| Overview | patient count, session/score totals, recently active table |
| Patients | Directory with **Current / Legacy / None** badges |
| Patient | Current programme trend + read-only legacy panel |
| Session | Rep table, angle trajectory, telemetry + `.parquet` download (only when the archive exists) |

Notes:

- **Sessions are empty until you record one** on the desktop app — the portal
  reads `patients/{id}/sessions/{sid}`, which only the desktop writes.
- **The legacy panel is populated** for all 18 existing patients (materialised
  in Step 6.7a).
- **The `.parquet` download needs a Cloud Storage bucket.** None exists yet, so
  sessions carry no `research_telemetry` and the button is not rendered.
- **Skeleton replay is not available from Firestore.** The 2 Hz `kinematic_curve`
  holds angles only; keypoints live in the Parquet archive.

Deploy:

```powershell
firebase deploy --only hosting --project pilates-ai
```

---

## 9. Known limitations

| Area | Status |
| :--- | :--- |
| GPU acceleration | **None on Windows.** Microsoft stopped publishing DirectML builds for ONNX Runtime 1.24+, and `ort` binds the 1.31 API, so the Windows path is CPU SIMD (20–35 ms per frame). macOS Apple Silicon uses **CoreML**. There is no DirectML code path left to enable. |
| Cloud upload | **Exercised end-to-end against production.** A recorded session produces a Firestore document and a Parquet object in `gs://pilates-ai.firebasestorage.app/telemetry/`. |
| Cloud Functions | `onSessionCreated` (aggregation), `pairStart` / `pairApprove` / `pairPoll` (pairing) and the portal-login function are deployed in `asia-east2`. |
| Video preview | Downscaled to 320×240 raw RGB over IPC at ~15 FPS. |
| Keypoint labels | **Provisional** — the models never stored keypoint names. Repetitions count from **detection duration**, not angles; angles remain a secondary metric. |
| Session replay | Available in the web portal: angle trajectory and rep table from Firestore. **Skeleton replay needs the Parquet archive**, which holds keypoints. |
| Web portal | **Live** at https://pilates-ai.web.app |
| Firebase Storage | **Provisioned** (`pilates-ai.firebasestorage.app`). Sessions recorded before it was configured carry a `storage_path` with no object; the portal detects that and hides the download rather than offering a 404. |
| Installers | **Unsigned** on every platform. Windows shows SmartScreen, macOS needs right-click → Open. Debug builds are never signable this way. |
| macOS / Linux hardware | Compiled and bundled in CI on every release, but **never launched on real hardware**. Treat the first clinic install as the acceptance test. |

---

## 10. Quick reference

```powershell
pnpm turbo run build                              # build everything
pnpm --filter @pilates/desktop tauri dev          # run the app
cd apps\desktop\src-tauri; cargo test             # engine tests
pnpm --filter @pilates/viz smoke                  # component tests
.venv\Scripts\python.exe tools\verify_onnx.py     # model parity
node tools\generate-pose-definitions.mjs --check  # config in sync
```

---

## Signing in (first run)

A new install has no credential. It shows **Sign in**, and any account that
exists in Firebase Auth is accepted.

### First run

1. Launch the app on a machine with no `auth.json`.
2. Enter the email and password created in the Firebase console, then press
   **Sign in**. No claim, allow-list or portal approval is involved.
3. The app opens on the patient list and starts syncing. The stored credential
   is a refresh token in `auth.json`; the password is never written.
4. Reopening the app does not ask again. **Switch account** in the sidebar
   footer removes the credential and returns to the sign-in screen.

A credential written by **2.0.6 or earlier** is treated as stale: the app asks
for sign-in once after the upgrade, then keeps the new credential. The password
is never involved in that check — only the refresh token's schema version.

Check `%LOCALAPPDATA%\PilatesAI\auth.json` exists and contains a
`refresh_token` (and `"schema_version": 2`), never a password.

### Pairing instead (shared or unattended machines)

Choose **Pair it with a code instead** on the sign-in screen.

1. The app shows a code such as `K7M4-QP2X` and opens
   `https://pilates-ai.web.app/pair?code=K7M4-QP2X`.
2. Sign in to the portal with any clinic account and press **Authorise
   workstation**. The page states that the workstation will be able to read and
   write patient records.
3. The desktop polls every two seconds and enters the workstation on its own.
4. The code expires after ten minutes; if it lapses, press **Get a new code**.

### Signing in again

Sign in again when the credential is revoked, the account is disabled, or the
workstation changes hands.

1. The app opens normally and shows an amber banner: *"Sync is paused — the
   account on this workstation was rejected."*
2. Press **Sign in** and repeat the first-run steps.

**A rejected token still never hides the patient list.** Recording and the local
outbox keep working; only upload is paused, and sessions queued during that time
drain once sign-in succeeds. A *missing, stale or unreadable* credential is
different: it shows the sign-in screen, because nobody can prove which account
that machine belongs to.

### What to check after signing in

- A session recorded on the workstation reaches Firestore **and** Storage.
- Clicking **Analysis** opens the portal already signed in as the same account.
- A client cannot read `devicePairings` or `portalLogins` (expect `403`).
- `firebase functions:log --only pairApprove` shows the approving account.

### Failure modes

| Symptom | Meaning |
|---|---|
| Portal says *"not a clinic account"* | The deployed `pairApprove` is stale — redeploy functions. |
| Portal says *"That code has expired"* | More than ten minutes passed; get a new code. |
| App shows the banner immediately | The stored token was revoked — sign in again. |
| `pairApprove` returns 500 `mint-failed` | The functions service account lacks `roles/iam.serviceAccountTokenCreator`. |
| Analysis opens the plain portal | The handoff function is unreachable or not deployed; the portal's own sign-in works. |
