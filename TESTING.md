# Testing Pilates AI yourself

This guide covers everything currently implemented: Steps 1–7 of
`MASTER_EXECUTION_PLAN.md`. You can verify a lot of it **without a webcam**,
and the rest needs a camera.

---

## 1. Prerequisites

| Tool | Check with | Notes |
| :--- | :--- | :--- |
| Node.js 20/22 | `node --version` | |
| pnpm | `pnpm --version` | `corepack enable pnpm` if missing |
| Rust (GNU toolchain) | `cargo --version` | `rustup default stable-x86_64-pc-windows-gnu` |
| MinGW (`windres`, `gcc`) | `windres --version` | Required to link the Tauri app |
| Python 3.11/3.12 | `.venv\Scripts\python.exe --version` | Only for the tooling scripts |

> **PATH matters.** Cargo lives in `%USERPROFILE%\.cargo\bin` and MinGW in
> `scoop\apps\mingw\current\bin`. If `cargo` isn't found, prepend both:
> ```powershell
> $env:PATH = "$env:USERPROFILE\.cargo\bin;C:\Users\<you>\scoop\apps\mingw\current\bin;$env:PATH"
> ```

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
| `windres` not found | Add MinGW to PATH (section 1) |
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

## 7. Optional: enable cloud sync

Sync is off unless credentials are present in the app's environment. For this
project they are already configured at user scope; the shape is:

```powershell
$env:PILATES_FIREBASE_PROJECT_ID = "pilates-ai"
$env:PILATES_FIREBASE_API_KEY    = "AIzaSyA_FsX3RBj7bxjO9dMx5QOh2X_JnvBVToo"
$env:PILATES_CLINIC_EMAIL        = "6531503067@lamduan.mfu.ac.th"
$env:PILATES_CLINIC_PASSWORD     = "<clinic account password>"
# Optional — only needed for Parquet archival:
$env:PILATES_FIREBASE_BUCKET     = "<storage bucket>"
```

`PILATES_FIREBASE_BUCKET` is **optional**: Firestore reads and writes work
without it, so the patient roster can be pulled before Cloud Storage has been
provisioned. Only the cold Parquet archive is skipped.

Without the four required variables, **Sync** returns `enabled: false` and the
outbox simply accumulates — this is expected, not a bug.

To confirm the credentials work, the app prints one of these at startup:

```
[pilates] cloud sync enabled
[pilates] cloud sync disabled (no credentials configured)
```

A live end-to-end check of the pull path (skipped in normal CI runs):

```powershell
cd apps\desktop\src-tauri
cargo test pull_patients_from_live_firestore -- --ignored --nocapture
```

Expected: `pulled: fetched=18 imported=18 updated=0` and
`patients carrying legacy_json: 18`.

### Pulling the existing patient roster

Your Firestore already holds patients created by the earlier app. The desktop
app has no live read path, so use **Pull from Firestore** on the Patients page
to import them:

1. Set the credentials above and restart the app.
2. Patients → **Pull from Firestore**.
3. You should see `Pulled N patient(s) — X new, Y updated`.

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
| `lifetime_avg_score` | running weighted mean of `summary.mean_form_score` |
| `last_active` | the session's `completed_at` |

To check by hand, open the Firebase console → Firestore → `patients` → a
patient that has just completed a session. `sessionLedger/{sessionId}` records
each applied session so a trigger retry cannot double-count.

Deploy changes with:

```powershell
firebase deploy --only functions:onSessionCreated --project pilates-ai
```

> Deploy **only the named function**. A bare `firebase deploy --only functions`
> would delete every function not present in this repository, including
> `downloadPatientData`, `getPoseAccuracySummary` and
> `updateGraphsOnPatientDeletion`, which exist only in production.

---

## 8. The clinical web portal

Live at **https://pilates-ai.web.app** (also `https://pilates-ai.firebaseapp.com`).

```powershell
pnpm turbo run build                     # the portal imports the workspace packages
pnpm --filter @pilates/web dev           # http://localhost:3000
```

Sign in with the clinic account from section 7. You should see:

| Page | Expected |
| :--- | :--- |
| Overview | 18 patients, session/score totals, recently active table |
| Patients | Directory with **Current / Legacy / None** badges |
| Patient | Current programme trend + read-only legacy panel |
| Session | Rep table, angle trajectory, telemetry + `.parquet` download |

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

## 9. Known limitations (as of Steps 1–9)

| Area | Status |
| :--- | :--- |
| DirectML GPU acceleration | **Not active.** Microsoft stopped shipping DirectML prebuilts after ONNX Runtime 1.24; `ort` needs the 1.31 API. The engine prefers DirectML automatically if you drop a matching `DirectML.dll` next to `onnxruntime.dll`. Runs on CPU today. |
| Cloud upload | Compiles and is unit-tested, but **never exercised against a live Firebase project**. |
| Cloud Functions | `onSessionCreated` is **deployed and verified end-to-end in production**, and is now the **only** deployed function — all 8 legacy ones were deleted. |
| Video preview | Downscaled to 320×240 raw RGB over IPC at ~15 FPS. |
| Keypoint labels | **Provisional** — the models never stored keypoint names. Repetitions therefore count from **detection duration**, not angles; angles remain a secondary metric. |
| Session replay | Available in the web portal: angle trajectory and rep table from Firestore. **Skeleton replay needs the Parquet archive**, which holds keypoints. |
| Web portal | **Live** at https://pilates-ai.web.app (Step 8). |
| Firebase Storage bucket | **None provisioned**, so sessions carry no `research_telemetry` and the `.parquet` download is unavailable. |

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

## Workstation pairing (first run)

A new install has no credential. It must be paired once, in the portal.

### First run

1. Launch the app on a machine with no `auth.json`.
2. It shows **Pair this workstation** with a code such as `K7M4-QP2X`, and opens
   `https://pilates-ai.web.app/pair?code=K7M4-QP2X`.
3. Sign in to the portal as a clinician who carries the `clinic=pilates-ai`
   claim. The page states that the workstation will be able to read and write
   patient records.
4. Press **Authorise workstation**. The portal confirms.
5. The desktop polls every two seconds and enters the workstation on its own.
6. The code expires after ten minutes; if it lapses, press **Get a new code**.

Check `%LOCALAPPDATA%\PilatesAI\auth.json` exists. It holds a refresh token —
never a password.

### Re-pairing

Re-pair when the credential is revoked, the account is disabled, or the
workstation moves to another clinic.

1. The app opens normally and shows an amber banner:
   *"Sync is paused — this workstation's pairing was rejected."*
2. Press **Re-pair** and repeat the first-run steps.

**The app never refuses to open because a credential was rejected.** Recording
and the local outbox keep working; only upload is paused. Sessions queued during
that time drain once pairing succeeds.

### What to check after pairing

- A session recorded on the paired machine reaches Firestore **and** Storage.
- `firebase functions:log --only pairApprove` shows the approving account.
- A client cannot read `devicePairings` (expect `403`).

### Failure modes

| Symptom | Meaning |
|---|---|
| Portal says *"not a clinic account"* | The signed-in account lacks the `clinic` claim. |
| Portal says *"That code has expired"* | More than ten minutes passed; get a new code. |
| App shows the banner immediately | The stored token was revoked — re-pair. |
| `pairApprove` returns 500 `mint-failed` | The functions service account lacks `roles/iam.serviceAccountTokenCreator`. |
