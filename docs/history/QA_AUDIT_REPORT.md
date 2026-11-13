# Pilates AI — Independent QA & Security Audit

**Auditor role:** Principal QA Engineer / Security Auditor
**Baseline (gold standard):** `final.pdf` (34 pp.) — *"Developed AI Exercise Application improved health and well-being for Physical therapy"*
**Codebase audited:** working tree at `C:\Users\muham\OneDrive\Documents\pilates-ai` (commit `f817fbb` + uncommitted redesign)
**Date:** 2026-11-05
**Scope:** all first-party source under `apps/`, `packages/`, `functions/`, `tools/`, `config/` (~95 files, ~18k LOC); Firebase project config; CI workflows; git history.

---

## 0. Verdict

> **Not production-ready for a clinical environment.**

The engineering quality of the *plumbing* is genuinely high — local-first SQLite outbox, WAL, versioned migrations, idempotent Cloud Function ledger, narrow Firestore `updateMask`, tested Parquet round-trip. But the system fails on the things a clinic actually depends on:

| Gate | Result | Why |
| :--- | :--- | :--- |
| **Clinical data confidentiality** | **FAIL** | Firebase **admin private key committed in git history**; **no security rules in the repo**; rules documented as *permissive* by the team itself. |
| **No patient data loss** | **FAIL** | Session is destroyed in RAM before it is persisted; a crash or save error loses the whole session. Orphaned `uploading` rows are never retried. |
| **Hardware resilience** | **FAIL** | USB unplug is **not detected at all** — the UI keeps showing "Live" on a frozen frame. No reconnect, no alert. |
| **Offline to online continuity** | **PARTIAL** | Persistence is solid; **automatic drain on reconnect does not exist** (manual button only). |
| **Resource lifecycle** | **FAIL** | Navigating away from the camera tab leaves the camera, inference thread and an unbounded in-memory recorder running. |
| **Fidelity to final.pdf** | **FAIL** | The scoring formula, the 4-joint reference template, the 5-frame temporal rule, the pose identities, and the cohort-aggregation collections are all **absent or different**. |

**Risk counts:** 7 Critical · 11 High · 16 Medium · 16 Minor (50 findings).

---

## 1. Method

1. Extracted all 34 pages of `final.pdf` to text and derived a numbered requirements baseline (section 2 below).
2. Read every first-party source file end-to-end (Rust engine, React desktop, React web, Firebase Functions, config, CI).
3. Cross-checked the *claims* in `README.md`, `MASTER_EXECUTION_PLAN.md` and `TESTING.md` against the code.
4. Inspected git history (`git log`, `git show HEAD:<path>`) for secrets and deleted security artefacts.
5. Ran targeted static checks: panic/`unwrap` inventory, `catch {}` inventory, thread/lock topology, IPC payload sizing.

> **Baseline caveat — read this first (finding H-01).** `final.pdf` describes the **previous** architecture: a PyQt6/OpenCV desktop client, FlutterFlow web client, and Cloud Functions writing `ageRangeGraph` / `genderGraph`. The codebase is a deliberate re-architecture (Tauri + Rust + ONNX + Parquet + React). **The document you nominated as the gold standard does not describe the system you built.** That is itself a production-readiness defect: there is no authoritative, current specification to audit against, and the clinical claims in the paper (78.1 % accuracy, 67 ms latency) cannot be traced to this code. Findings below distinguish *intentional re-architecture* from *unintentional drift*.

---

## 2. Requirements baseline extracted from `final.pdf`

| # | Requirement | PDF location | Codebase status |
| :-- | :--- | :--- | :--- |
| R1 | 5 pose-specific keypoint models, one per exercise | p.11 §3.6.1 | Met: 5 ONNX models |
| R2 | 640x640 letterboxed input | p.11, p.17 §4.1.1 | Met: `inference.rs:28,383` |
| R3 | Confidence filtering **0.25-0.35** | p.14 §3.7.1 | Partial: fixed 0.25 (`inference.rs:32`) |
| R4 | **EMA smoothing over 3-5 consecutive frames** on keypoints | p.14 §3.7.1 | Missing: EMA on the *angle*, alpha=0.35, no frame window (`biomechanics.rs:243-248`) |
| R5 | Four angles: **knee, hip flexion, trunk inclination, shoulder elevation** | p.14 §3.7.2 | Missing: one primary angle (+ optional secondary) only |
| R6 | Pose-4 left/right side awareness from shoulder/elbow elevation | p.14-15 §3.7.2 | Missing: not implemented |
| R7 | Reference template Theta = {trunk, hip, knee, shoulder} per pose stage | p.15 §3.7.3 | Missing: no template; one scalar target |
| R8 | Tolerances **trunk +/-8 deg, hip +/-10 deg, knee +/-12 deg, shoulder +/-10 deg** | p.15 §3.7.3 | Missing: derived as `12 % of ROM span`, floor 5 deg (`pose_config.rs:239`) |
| R9 | Correct iff **all** joints within tolerance **AND** confidence >= threshold | p.15 §3.7.3 | Partial: single-angle band + mean confidence |
| R10 | Continuous score `s = 1 - (1/\|Theta\|) * sum(min(\|theta_i - theta_ref_i\| / Delta_i, 1))`, bands **0.85 / 0.70** | p.15 §3.7.3 | Missing: replaced by 0-100 weighted blend (0.5/0.3/0.2) |
| R11 | **Five consecutive frames** of correct pose before a rep registers | p.15 §3.7.4 | Missing: requires a **3.0 s hold** and only counts on exit from band |
| R12 | Pose stages `start / end / end-left / end-right` used for classification | p.6 §2.2.3, p.14 | Partial: class id stored, **never used** by any decision |
| R13 | Firestore holds session summary + 2 Hz curve | p.9 §3.4, README | Met: `session.rs:20,296` |
| R14 | Cloud Function recomputes **per-exercise** average on write | p.8 §3.3 | Missing: only lifetime mean across all poses |
| R15 | Cloud Function recomputes **cohort** averages (age + gender) into `ageRangeGraph` / `genderGraph` | p.8-9 §3.3 | Missing: collections do not exist |
| R16 | `onDelete` recalibrates group averages | p.8 §3.3 | Missing: no delete trigger at all |
| R17 | Dashboard reads **only pre-aggregated** collections, never raw patient data | p.9 §3.4 | Violated: web reads raw patient + session docs (`data.ts:63-91`) |
| R18 | Session persisted locally, uploaded on reconnect | (implied by §3.2/3.3) | Partial: persisted yes, auto-upload no |
| R19 | Latency target approx. 67 ms/frame, 24-30 fps | p.19 §4.1.3 | Unmeasured; CPU-only today (`TESTING.md:307`) |
| R20 | 2 m camera distance, 1080p/30 webcam | p.17 §4.1.1 | Partial: requests 640x480@30 MJPEG (`camera.rs:28-29,170-176`) |

**Score: 4 of 20 met as specified, 6 partial, 10 not met.**

---

## 3. Direct answers to your four questions

| Question | Short answer |
| :--- | :--- |
| **Does the codebase perfectly reflect final.pdf?** | **No.** The five pose identities are wrong (`pose1` is "The Hundred", not Shoulder Bridge), the correctness formula is replaced by a different one, four joint angles became one, the 5-frame rule became a 3-second hold, and the cohort-aggregation collections (`ageRangeGraph`, `genderGraph`) and the `onDelete` recalculation do not exist. See H-01 to H-07. |
| **USB webcam unplugged / blocked mid-session?** | **Silently ignored.** The capture thread records the error and retries forever; `CameraHandle::last_error()` is **never called by any code path**; `latest()` keeps returning the last good frame, so the preview freezes while the badge still says **"Live"**. Inference then runs on a stale frame at 30 Hz, the FSM receives a frozen timestamp, and the session keeps "recording". No alert, no pause, no reconnect. See **C-03**. |
| **Wi-Fi lost?** | **Data survives, delivery does not resume by itself.** Every session is committed to SQLite with its Parquet blob *before* any network call — that part is solid. But there is **no reconnect detection and no background drain**: sync only happens when a human clicks **Sync** (`PatientListPage.tsx:179`). A crash *during* upload also strands the row in `uploading` state forever, which no retry path selects. See **C-05** and **H-06**. |
| **Are ML sessions dropped and memory released when leaving the camera view?** | **No.** Switching tabs unmounts the React page, but the Rust camera thread, the preview/inference thread and (if a session is active) the `TelemetryRecorder` all keep running. The recorder has **no cap**, so a therapist who walks away mid-session grows RAM indefinitely. See **C-06**. |

---

## 4. Critical findings (P0 — app crash / data loss / PHI exposure)

### C-01 · Firebase admin private key is committed in git history
**Pillar:** Security · **Evidence:** `git show HEAD:config/firebase-sdk.json` (2,371 bytes) — a full `service_account` JSON with `"private_key": "-----BEGIN PRIVATE KEY-----..."` for `firebase-adminsdk-i3ak4@pilates-ai.iam.gserviceaccount.com`. `git status` shows the file as deleted in the working tree, **but deletion is not committed**, and even if it were, the blob remains reachable in history.

**Impact:** Anyone with repository access (or a clone, fork, backup, or the leaked OneDrive folder) can mint admin tokens for the entire `pilates-ai` project: read/write/delete every patient document, every session, every Parquet object. This bypasses *all* Firestore rules regardless of how good they are. This is a reportable PHI breach if the repo was ever shared.

**Reproduce:** `git show HEAD:config/firebase-sdk.json | Select-String private_key`

**Fix (in order):**
1. **Rotate now** — disable key `c3c39d1e...` in GCP IAM > Service Accounts, issue a new one only if a server-side process truly needs it (the desktop deliberately does *not*).
2. Purge history with `git filter-repo --path config/firebase-sdk.json --invert-paths` (or BFG), force-push, and invalidate all clones/forks.
3. Review Cloud Audit Logs / Firestore usage for the key's lifetime.
4. Add a pre-commit secret scanner (gitleaks) and a CI secret-scan job.

---

### C-02 · No Firestore or Storage security rules exist in the repository
**Pillar:** Security · **Evidence:** `firebase.json:1-30` declares only `functions` and `hosting`. No `firestore.rules`, no `storage.rules`, no `firestore.indexes.json` anywhere in the tree (verified by recursive glob and `git log --diff-filter=D`). The team's own blueprint records the deployed state: *"These rules are permissive — any account in the project can modify any patient. Tighten before clinical use."* (`MASTER_EXECUTION_PLAN.md:763`).

**Impact:** Every authenticated account — including any clinic staff account, any ex-employee account, any account created for a demo — can read and write the entire patient database from the browser console. The web portal authenticates with email/password (`apps/web/src/lib/auth.tsx:67`) and then reads directly from the client (`apps/web/src/lib/data.ts:63-91`), so *all* access control is delegated to rules that are (a) not version-controlled, (b) not deployed by CI, and (c) documented as too loose. There is no tenant/clinic scoping and no role separation: any signed-in user sees every patient's name, age, weight, height, phone, address and clinical notes.

**Fix:**
```jsonc
// firebase.json
"firestore": { "rules": "firestore.rules", "indexes": "firestore.indexes.json" },
"storage":  { "rules": "storage.rules" }
```
Rules must: require `request.auth != null`; scope reads/writes to a `clinics/{clinicId}` membership claim (`request.auth.token.clinic == clinicId`); make `patients/**` read-only for non-clinicians; deny all client writes to `sessionLedger` and aggregate fields; deny direct Storage reads except via signed URLs. Add emulator rule tests (`@firebase/rules-unit-testing`) to CI, and add `firebase deploy --only firestore:rules,storage` to `web-ci.yml`.

---

### C-03 · USB camera loss is undetectable and unrecoverable during a session
**Pillar:** Hardware resilience · **Evidence:**
- `camera.rs:224-231` — on `frame()` error it writes `last_error`, sleeps 250 ms, and **loops forever**; `running` stays `true`; the device is never re-opened.
- `camera.rs:126-128` — `last_error()` is defined but **never called** (verified: the only match in the entire codebase is the definition).
- `camera.rs:105-107` — `latest()` keeps returning the **last good frame** indefinitely.
- `commands.rs:443-452` — the preview loop takes `latest()` and never inspects the camera's error state.
- `commands.rs:554` — it keeps emitting `telemetry-frame` at 30 Hz from that stale frame.
- `LivePreview.tsx:71-73` — IPC failures are swallowed (`catch { /* skip this frame */ }`), and `preview_frame` never fails anyway because the stale frame is still in the slot.
- `ActiveCapturePage.tsx:210-212` — the badge is driven by `status.running`, which stays `true`.

**Impact (clinic reality):** A therapist unplugs the webcam (or a video-call app grabs it, or Windows USB power management drops it). The screen keeps showing the last frame with a green **"Live"** badge. The FSM receives a frozen `captured_at_ms`, so hold timers stop advancing but no error is raised; inference burns 30 Hz of CPU/GPU on the same bitmap. The session that gets saved looks plausible and is clinically meaningless. **No human is told anything is wrong.**

**Fix:**
1. Add a watchdog in the preview loop: if `frame.sequence` has not advanced for > 500 ms, emit a `camera-lost` event and set a `camera_status` field.
2. Surface it in `PreviewStatus` / `capture_status` and render a **blocking red banner + audible alarm** in `ActiveCapturePage`; flip the badge to "Signal lost".
3. Auto-pause the session (`session.pause()`), and attempt reconnect with exponential backoff (1 s, 2 s, 5 s, 10 s, capped) inside the capture thread; on success, resume and emit `camera-restored`.
4. Stop feeding `session.process()` when the frame age exceeds the watchdog threshold, and record the gap in the session document (`interruptions[]`).

---

### C-04 · A session is destroyed before it is durably saved
**Pillar:** Data integrity · **Evidence:** `commands.rs:702-745`
```rust
let session = { ... guard.take() ... };          // in-memory session removed
if session.frame_count() == 0 { ... }
let result = session.finish(&state.gcs_bucket)?; // Parquet encode can fail
let document_json = serde_json::to_string(&result.document)?;
outbox.save_session(...)?;                       // disk full / SQLite busy can fail
```
`CaptureSession::finish(self, ...)` consumes `self`. Any error on that path (Parquet encode, `serde_json`, `SQLITE_BUSY`, disk full, antivirus lock) returns early and the **entire recorded session is gone** — there is no second copy anywhere.

Two aggravating variants:
- `commands.rs:632-636` — `start_session` does `*guard = Some(session)` with **no check for an existing session**. Pressing Start twice (or a double-click, or a retry after a UI hiccup) silently discards the previous recording.
- Nothing is written incrementally: if the app is closed, crashes, or the OS reboots mid-session, all frames are lost. A 20-minute session lives only in a `Vec` until Stop is pressed.

**Fix:**
1. Keep the session in state until the outbox write **succeeds**; on failure, return a recoverable error and leave it in place so the user can retry.
2. Persist incrementally: create the session row at `start_session` (`state='recording'`) and append frames every N seconds (or on a background writer thread) as Parquet row-groups; on crash, a startup sweep finalises `recording` rows.
3. Reject `start_session` while another is active (return `Invalid("session already in progress")`) and require an explicit `abandon_session`.

---

### C-05 · Sessions stranded in `uploading` are never retried (silent non-delivery)
**Pillar:** Offline/sync · **Evidence:** `cloud_sync.rs:480` sets `UploadState::Uploading` before the network call. `outbox.rs:549-557` selects only `WHERE upload_state IN ('pending','failed')`. `outbox.rs:790-797` counts only `pending`/`failed`.

**Impact:** If the app is killed, the machine sleeps, or the Wi-Fi drops mid-upload, the row stays `uploading` **forever**. It is invisible in the "pending" counter, invisible to `pending_sessions`, and never retried. The local copy still exists (good), but the cloud record and the Cloud Function aggregate never materialise — and nobody is told. In a clinic this looks exactly like "the portal is missing today's sessions".

**Fix:** add `uploading_since` (timestamp) and, on startup and on each flush, reset rows whose lease is older than ~10 min back to `pending`. Alternatively make the upload path idempotent and skip the `uploading` state entirely.

---

### C-06 · Navigating away from the camera view leaks the camera, the inference thread and memory
**Pillar:** Resource lifecycle · **Evidence:**
- `App.tsx:104-112` — `{tab === "capture" && <ActiveCapturePage .../>}`; switching tabs **unmounts** the page.
- `ActiveCapturePage.tsx` — has **no `useEffect` cleanup**; the only effects are the status poller, `engineStatus`, and the chime.
- `useTauriCapture.ts:54-59` — cleanup only calls the `unlisten` functions; it never calls `stopPreview()`.
- `commands.rs:395-400` — the preview thread is spawned and its `JoinHandle` is **discarded**; the loop runs while the global `preview_running` is true.
- `camera.rs:163-241` — the capture thread likewise keeps the device open until explicitly stopped.
- `session.rs:159,263-283` — `TelemetryRecorder` pushes every frame into a `Vec` with **no cap** (`with_capacity(40_000)` is only a hint).

**Impact:** After one tab switch, the clinic PC keeps: the webcam device locked (so Zoom/Teams/the next app cannot use it), a 30 Hz inference loop, a 30 Hz Tauri event serialisation, and — if a session was running — an ever-growing frame vector. `stop_session` is never called, so the session document's `duration_seconds` will include the time the therapist spent on the Patients tab. **This is your memory leak**, and it is also why the camera can appear "blocked by another application".

**Fix:**
1. Add `useEffect(() => () => { void stopPreview(); }, [])` in `ActiveCapturePage`, or better: lift capture into a provider and release on route change.
2. On unmount with an active session, either auto-stop-and-save (with a confirmation) or explicitly pause; never leave it recording.
3. Store the preview thread's `JoinHandle` + a generation counter in `AppState`, join on stop.
4. Cap the recorder (e.g. 2 h) and spill to disk beyond it.

---

### C-07 · Duplicate preview threads (double inference, duplicated frames)
**Pillar:** Concurrency · **Evidence:** `commands.rs:361-409` — `start_preview` calls `stop_preview_inner` (sets `preview_running=false`) and then immediately sets it back to `true` **without joining the previous thread**. The old loop re-checks `running.load()` at the top of each iteration (`commands.rs:424`) and sees `true` again, so **both** loops keep running, sharing `preview_pose` and the global state. `commands.rs:538-544` — each loop feeds `session.process()`.

**Impact:** Two inferences per frame (2x CPU/GPU), duplicate `telemetry-frame` events, and **the same frame processed twice into the session recorder** — doubling recorded frames and hold-time accumulation, and corrupting `frame_index` continuity in the Parquet archive. Triggered by double-clicking **Preview** or pressing **Start** while preview is live.

**Fix:** keep `(JoinHandle, AtomicU64 generation)` in `AppState`; each thread captures its generation and exits when it no longer matches; `stop_preview` sets the flag, joins, *then* `start_preview` spawns.

---

## 5. High findings (P1)

### H-01 · The nominated "gold standard" does not describe the built system
`final.pdf` specifies PyQt6 + OpenCV, a FlutterFlow dashboard, and Cloud Functions writing `ageRangeGraph`/`genderGraph`. The repository is Tauri/Rust/ONNX/Parquet/React. Every audit against the PDF therefore produces false "deviations" unless the intentional redesign is separated from accidental drift. **Impact:** no traceable specification, no way to validate the paper's accuracy/latency claims, and future maintainers cannot tell which behaviour is contractual. **Fix:** publish an architecture decision record (ADR) that supersedes §3.1-3.4 of the paper, and regenerate the paper's methodology section from the code (or mark it as describing v1).

### H-02 · The correctness score is not the paper's formula
`biomechanics.rs:340-366` computes `0.5*angle_accuracy + 0.3*stability + 0.2*confidence` on a 0-100 scale, where angle accuracy is 100 inside the band and decays linearly to 0 at 3x tolerance. `final.pdf` §3.7.3 specifies `s = 1 - (1/|Theta|) * sum(min(|theta_i - theta_ref_i| / Delta_i, 1))` with clinical bands `>=0.85 good / 0.70-0.85 acceptable / <0.70 incorrect`. **Impact:** every score shown to a clinician (desktop gauge, portal trend, Cloud Function `lifetime_avg_score`) is a different quantity from the one the paper validates. The published 78.1 % accuracy figure is not reproducible from this code. **Fix:** implement the paper's normalised multi-joint score as the primary metric, keep the composite as a secondary "stability" indicator, and unit-test the three band boundaries.

### H-03 · One joint angle replaced four, and side-awareness is missing
`pose_config.rs:41-56,236-249` + `session.rs:214-245` compute a single `primary_angle` (plus an optional `secondary_angle`) per pose. `final.pdf` §3.7.2 requires **knee, hip flexion, trunk inclination (vs vertical) and shoulder elevation**, and §3.7.2 requires Pose 4 left/right discrimination by comparing shoulder and elbow elevation. `pose4` is defined as "Side Leg Lift" using left/right *elbow flexion* — the spine-twist directional logic does not exist anywhere. **Impact:** trunk inclination — the most clinically meaningful cue for lower-back-pain rehab — is never measured. **Fix:** extend the config schema to `angles: [{name, a, b, c, reference, tolerance, weight}]` and evaluate all of them per frame; add `side_detection` for pose 4.

### H-04 · Pose identities and keypoint labels do not match the clinical protocol
`config/pose-definitions.json:12-153` names the exercises **The Hundred, Roll Up, Single Leg Stretch, Side Leg Lift, Swimming**. `final.pdf` §4.1.2 defines them as **Shoulder Bridge, Side Kick Series, Single Leg Stretch, Spine Twist, Swimming**. Only pose 3 and pose 5 agree. Worse, the file itself states `"label_source": "provisional"` and *"Labels must be confirmed against the original training dataset before clinical use"* (`pose-definitions.json:4-5`); `TESTING.md:311` repeats the warning.

**Impact:** the app can display "The Hundred" while the model was trained on Shoulder Bridge; and because the angle triplets are defined over **guessed** keypoint indices, `knee_flexion` may be measuring the angle between three unrelated landmarks. Every downstream number (form score, rep count, ROM, portal trends) inherits that uncertainty. **This is a clinical-safety blocker independent of any code quality.**

**Fix:** recover the real `kpt_shape`/names from the Roboflow export or the training dataset; regenerate `pose-definitions.generated.ts` via `tools/generate-pose-definitions.mjs`; re-validate against an instructor; flip `label_source` to `"verified"` and make the app refuse to start in clinical mode while it is `"provisional"`.

### H-05 · The cohort-aggregation contract from §3.3/§3.4 is gone
`functions/index.js` exposes exactly one trigger, `onSessionCreated`, which updates `patients/{id}.total_sessions`, `lifetime_avg_score`, `last_active` (`aggregation.js:52-90`). There is **no** per-exercise average, **no** age/gender cohort document, **no** `ageRangeGraph`/`genderGraph` collection, and **no** `onDelete` recalculation. The dashboard instead recomputes clinic totals in the browser from patient documents (`data.ts:107-129`). **Impact:** the paper's therapist dashboard (cohort comparison by age and gender) cannot be built on this backend; deleting a patient leaves stale aggregates; and the portal performs client-side aggregation, contradicting §3.4's explicit "no complex calculations in the browser". **Fix:** add `onDocumentDeleted`/`onDocumentUpdated` for sessions and patients, maintain `cohorts/{ageBand}_{gender}` documents transactionally in the same ledger pattern already used, and have the portal read only those.

### H-06 · No automatic offline-to-online drain
`useTauriSync.ts:65-73` polls `outbox_stats` every 15 s but **never calls `sync()`**. `sync_now` is invoked only from the button at `PatientListPage.tsx:179-191`. There is no connectivity listener, no retry timer, no exponential backoff, and no Rust-side periodic task (verified: `flush()` has exactly one caller, `commands.rs:927`). **Impact:** the README/plan claim the queue "drains later", but in practice sessions stay local until a human remembers to press Sync. A clinic that loses Wi-Fi for an afternoon will have a silent backlog. **Fix:** spawn a background sync task (Tauri async runtime) with backoff (30 s, 1 m, 5 m, 15 m, jittered), trigger an immediate flush on `online`/window-focus, and show a persistent "N sessions not yet uploaded" chip.

### H-07 · 30 Hz full-payload React re-renders + 3.4 MB/s preview IPC
**Pillar:** Concurrency/performance · **Evidence:**
- `commands.rs:554` emits `telemetry-frame` at capture cadence; `metrics_to_payload` (`commands.rs:192-247`) serialises **every keypoint with its label string** on every frame.
- `useTauriCapture.ts:46-48` calls `setFrame(payload)` on every event — a React state update 30x/s.
- `ActiveCapturePage.tsx` re-renders the whole tree at 30 Hz: keypoint `useMemo` (`:127-137`), `<SkeletalCanvas>` (`:201-206`), `<JointAngleGauge>` (`:328-333`), phase badge, hold/deviation cards.
- `LivePreview.tsx:46-84` polls `preview_frame` at ~15 Hz; each response is `320*240*3 = 230,400` bytes, repacked in a **76,800-iteration JS loop** per frame — roughly 3.4 MB/s over IPC and a measurable slice of a core just converting RGB to RGBA.

**Impact:** visible jank on low-end clinic PCs, fan spin, and a UI that drops frames exactly when the therapist is watching the skeleton. **Fix:** (a) emit telemetry at 10 Hz and interpolate in the UI; (b) strip `label` from the per-frame payload (join client-side from the pose definition); (c) write the preview into a reusable `ImageData` via `requestAnimationFrame` and throttle to 10-12 fps; (d) better: return **RGBA** from Rust (or a shared `ArrayBuffer`/`ImageBitmap`) so the JS loop disappears; (e) isolate the gauge/skeleton in memoised leaf components keyed on rounded values.

### H-08 · Patient edits can silently roll back Cloud Function aggregates
`cloud_sync.rs:184-211` includes `total_sessions`, `lifetime_avg_score` and `last_active` in the PATCH mask **whenever they are present locally**. Those values come from the last pull; the Cloud Function increments them server-side. A therapist renaming a patient therefore pushes the *old* counts over the *new* ones. **Impact:** clinic totals go backwards; `lifetime_avg_score` drifts; the portal's headline metrics become wrong and nobody notices. **Fix:** never include aggregate fields in client writes — let the function own them exclusively (drop them from `OWNED_PATIENT_FIELDS` and from `patient_document_body`).

### H-09 · Session documents can exceed the Firestore 1 MiB limit
`session.rs:296` embeds a 2 Hz curve; `telemetry.rs:234-264` produces one point per 500 ms. A 20-minute session yields ~2,400 points; each point serialises to a map with `t_sec/angle/score/phase` at roughly 80-120 B — 200-290 KB — plus `reps[]`. Longer sessions (the app never auto-stops) or many reps push the document toward the 1,048,576-byte hard limit. `write_session_document` (`cloud_sync.rs:437-468`) has no size check or chunking. **Impact:** the write fails permanently, the session is marked `failed`, retried forever on every sync, and the portal never sees it. **Fix:** enforce a session cap; downsample adaptively (or store the curve in a subcollection / Storage and keep only a pointer + summary); add a pre-flight `serde_json::to_vec(...).len()` guard with a documented fallback.

### H-10 · Silent failure inventory (exceptions swallowed with no staff alert)
| Location | What is swallowed | Consequence |
| :--- | :--- | :--- |
| `LivePreview.tsx:71-73` | every `preview_frame` IPC error | frozen preview, no message |
| `ActiveCapturePage.tsx:72-74` | `capture_status` polling errors | "Camera 0 / Recorded 0" looks normal |
| `ActiveCapturePage.tsx:114-116` | audio failure | no chime, staff unaware |
| `useTauriCapture.ts:57` | listener teardown errors | leaked listeners across HMR |
| `ipc.ts:106-108` | malformed `legacy_json` | silently hides history |
| `commands.rs:272-293` | poisoned mutexes via `.ok()` | reports "not running" instead of "engine unhealthy" |
| `commands.rs:620-627` | `resolve_model(...).unwrap_or_else(...)` | a missing model silently records `model_version: "2.0.0"` |
| `cloud_sync.rs:699-705,723,730-734,740` | `let _ = outbox.resolve_*` | queue bookkeeping failures invisible |
| `main.rs:65-71` | legacy import error printed to stderr only | staff never see it |

Additionally, **neither React app has an error boundary** (`main.tsx` in both apps renders `<App/>` bare). Any render-time exception blanks the window to a white screen with no message and no recovery path — the worst possible failure mode for a clinic.

**Fix:** add a top-level `ErrorBoundary` that shows a "Call IT / session saved locally" screen and logs to a local file; add a global Tauri `engine-error`/`camera-error`/`sync-error` toast channel; replace `.ok()` on locks with an explicit "engine unhealthy" state.

### H-11 · Changing the pose mid-session silently stops all recording
**Pillar:** Data integrity · **Evidence:** the pose `<select>` in `ActiveCapturePage.tsx:251-267` has **no `disabled` attribute** — it stays interactive while a session is running. Selecting a new pose calls `selectPose` -> `set_preview_pose` -> `preview_pose` changes. The preview loop then evaluates `if session.pose_id() == pose_id { session.process(...) }` (`commands.rs:538-544`); because the session keeps its original `pose_id`, **the guard is false and no further frames are recorded** — but the preview FSM has been recreated for the new pose (`commands.rs:504-509`) and keeps emitting `telemetry-frame`, so the rep counter, gauge and form score continue to update.

**Impact:** the therapist sees a live, apparently working session, while the saved document stops at the moment of the switch. Worse, the document's `pose_id` and `model_version` describe the *old* exercise while the on-screen numbers describe the *new* one — a clinically misleading record with no warning.

**Fix:** disable the pose selector while `sessionId` is set (require Stop -> change -> Start), and defensively reject `set_preview_pose` during an active session or auto-finalise the current session before switching.

---

## 6. Medium findings (P2)

| ID | Finding | Evidence | Impact | Fix |
| :-- | :--- | :--- | :--- | :--- |
| M-01 | **CSP disabled** in the desktop WebView | `tauri.conf.json:24-26` (`"csp": null`) | Any XSS in the React app can exfiltrate the clinic token / patient data; no defence-in-depth | Set a strict CSP (`default-src 'self'; connect-src https://*.googleapis.com ...`), no `unsafe-eval` |
| M-02 | **Plaintext clinic credentials** on disk; `config/cloud.json` not gitignored | `cloud_sync.rs:48-82`; `.gitignore:14-17` (covers `*-sdk.json`, not `cloud.json`) | Any local user/process can read the clinic password; accidental commit is one `git add .` away | Store in Windows Credential Manager / DPAPI; add `config/cloud.json` and `**/cloud.json` to `.gitignore` |
| M-03 | **Deleted patients still appear in the web portal** | `data.ts:63-69` (no `local_state` filter) vs `outbox.rs:393-401` (desktop filters) | Tombstoned patients (and their PHI) remain visible in the cloud dashboard | Filter `local_state != 'tombstone'` client-side **and** in rules |
| M-04 | **No RBAC or tenant scoping** in the portal | `auth.tsx`, `data.ts` | Every signed-in account sees every patient; no therapist/admin distinction | Custom claims + rules; per-clinic collections |
| M-05 | **Provider is misreported** | `inference.rs:285` uses `active_provider()` (a *capability* check) after the session may have fallen back to CPU; `commands.rs:402-408,577-583` hardcode `inference_available: true`; `commands.rs:332` returns true if only the runtime exists | UI/telemetry claims "DirectML" while running on CPU; performance triage is misled | Record which EP the session actually committed with (try GPU, inspect, fall back) and propagate the real value |
| M-06 | **Startup panic instead of a recoverable error** | `main.rs:54` (`load()?`), `main.rs:57` (`Outbox::open(...)?`), `main.rs:121` (`.run().expect(...)`) | A missing/corrupt `pose-definitions.json` or an unreadable DB crashes the app with a Rust panic dialog | Show a native error window with the path and a "Reset config" action |
| M-07 | **`total_hold_time_sec` is computed wrongly** | `session.rs:258` — `total_hold_sec += metrics.hold_duration_sec / 30.0` sums a *cumulative* value each frame, and assumes exactly 30 fps | Summary "Hold time" in the portal (`SessionPage.tsx:127`) is inflated and frame-rate dependent | Accumulate `dt` only while `phase == Holding`, using real frame deltas |
| M-08 | **No session duration cap / auto-stop** | `session.rs:159`, `telemetry.rs:74-93` | Unbounded RAM, huge Parquet blobs, Firestore doc overflow (H-09) | Cap at e.g. 60 min, warn at 45, auto-stop |
| M-09 | **`capture_tick` is dead but dangerous** | `commands.rs:648-699`; exported at `ipc.ts:233`, never called | If wired up later it double-processes frames into the session (the preview loop already feeds it) -> double reps | Delete it, or make the preview loop the *only* producer and remove the FSM duplication |
| M-10 | **`sync_queue` grows forever** | `outbox.rs:639-649`; `resolve_*` only updates state, never deletes | Multi-year DB growth, slower `queue_entries` scans | Prune `done` rows older than 30 days |
| M-11 | **No retry cap / backoff on failed uploads** | `cloud_sync.rs:748-773` | Every manual sync re-attempts every failed session; a permanently invalid doc hammers the API | Attempt counter + exponential backoff + "needs attention" state |
| M-12 | **CI gaps** | `.github/workflows/*.yml` | Functions tests never run (package not in `pnpm-workspace.yaml`); web CI deploys hosting only (no rules/functions); no `cargo clippy`; no web unit tests | Add `functions` to the workspace + test job; deploy rules; add clippy `-D warnings` |

---

## 7. Medium findings (continued, M-13 to M-16)

| ID | Finding | Evidence | Impact | Fix |
| :-- | :--- | :--- | :--- | :--- |
| M-13 | **Model load under the engine mutex** | `commands.rs:166-183`, `460-471` | First frame or a pose switch blocks the preview loop and any `capture_tick` caller for the duration of an ONNX load (hundreds of ms) -> visible freeze | Load in a worker, swap the `Option` atomically; keep the old engine until the new one is ready |
| M-14 | **`stop_preview` joins the camera thread with no timeout** | `camera.rs:131-136`; `commands.rs:564-572` | A hung `camera.frame()` call freezes the IPC command and therefore the UI | Bound the join; drop the handle if it does not exit within ~2 s |
| M-15 | **One-click irreversible patient delete** | `PatientListPage.tsx:262-269` | Misclick hides a patient (soft delete) with no confirm/undo | Confirmation dialog + "Recently deleted" restore view |
| M-16 | **Raw session documents pushed over IPC and read by the portal** | `commands.rs:748-775`; `data.ts:77-82` | Large payloads, extra re-renders, and a direct contradiction of §3.4's pre-aggregation rule | Return list summaries; fetch the curve only on the session detail route; paginate |

---

## 8. Minor findings (P3)

| ID | Finding | Evidence |
| :-- | :--- | :--- |
| N-01 | Documentation overstates behaviour ("drains later", "rock-solid 60 FPS", "guarantees") | `README.md:21-23`, `MASTER_EXECUTION_PLAN.md:15,869` |
| N-02 | `start_preview` returns `provider: "pending"` and `inference_available: true` unconditionally | `commands.rs:402-408` |
| N-03 | Letterbox/downscale use nearest-neighbour; quality loss on downscaled previews | `inference.rs:407-432`, `commands.rs:1004-1024` |
| N-04 | The paper's "brightness adjustment" preprocessing step is absent | `final.pdf` §4.1.1 vs `inference.rs:383-435` |
| N-05 | Confidence threshold fixed at 0.25 instead of the documented 0.25-0.35 adaptive band | `inference.rs:32` |
| N-06 | `delete_patient` enqueues a sync op even for an unknown id | `outbox.rs:501-513` |
| N-07 | `save_session` upsert does not reset `upload_state`/`last_error` | `outbox.rs:532-542` |
| N-08 | Legacy import counts rows it did not insert (`INSERT OR IGNORE` then `imported += 1`) | `outbox.rs:861-875` |
| N-09 | `AudioContext` is created without a user gesture and errors are swallowed; chime may never play | `ActiveCapturePage.tsx:98-117` |
| N-10 | `engine-error` dedupe never clears `last_error`, so a recovered-then-recurring identical error is not re-alerted | `commands.rs:495-501` |
| N-11 | `outbox_stats` is polled every 15 s even when idle | `useTauriSync.ts:65-73` |
| N-12 | `engine_status` re-reads and parses `model-manifest.json` per pose on every call | `commands.rs:317-329` |

---

## 9. Minor findings (continued, N-13 to N-16)

| ID | Finding | Evidence |
| :-- | :--- | :--- |
| N-13 | `tauri-plugin-shell` initialised but unused; no `capabilities/` directory, so its permissions are effectively absent (confusing, and a future foot-gun) | `main.rs:46`, no `src-tauri/capabilities` |
| N-14 | `README.md`/`TESTING.md` reproduce the wrong pose names ("The Hundred", "Roll Up") | `TESTING.md:132` |
| N-15 | `preview_pose` is not cleared on stop; `active_pose` and `preview_pose` can diverge | `commands.rs:574-584,638-643` |
| N-16 | React `StrictMode` double-invokes effects in dev; once a cleanup `stopPreview()` is added (C-06) it will double-stop — guard with a ref | `apps/desktop/src/main.tsx:7-9` |

---

## 10. Pillar scorecards

### 10.1 Implementation vs `final.pdf`
| Area | Verdict |
| :--- | :--- |
| Model pipeline (5 models, 640x640, letterbox, NMS, decode) | Faithful and well-tested |
| Confidence filtering + EMA | Partial (fixed threshold; EMA on angle, not keypoints, no 3-5 frame window) |
| Joint-angle methodology | Missing (1 angle instead of 4; side-awareness absent) |
| Reference templates & tolerances | Missing (replaced by a single scalar band) |
| Continuous correctness score | Missing (different formula and scale) |
| Temporal validation | Missing (3 s hold instead of 5 frames) |
| Pose identities / clinical protocol | Missing (3 of 5 names differ; keypoint labels provisional) |
| Data schema (session doc, 2 Hz curve, Parquet) | Met (internally consistent and tested) |
| Aggregation backend (`ageRangeGraph`, `genderGraph`, onDelete) | Missing |
| Dashboard pre-aggregation contract | Violated (raw client reads) |

### 10.2 Hardware & edge cases
| Scenario | Behaviour today |
| :--- | :--- |
| Webcam unplugged mid-session | Frozen frame, "Live" badge, no alert, no reconnect (C-03) |
| Webcam claimed by another app | Same as above |
| Webcam absent at start | Typed error surfaced in the red banner (`ActiveCapturePage.tsx:184-188`) |
| No ONNX Runtime | Degrades, records frames without detections, warns the user |
| Model fails to load | Warns and emits `engine-error` once, but keeps recording "successfully" with no skeleton; session still saved |
| Wi-Fi lost | Session persisted locally; no automatic upload later (H-06) |
| App killed mid-session | Entire session lost (C-04) |
| App killed mid-upload | Row stranded in `uploading` forever (C-05) |
| Disk full / SQLite busy | Session already consumed -> lost (C-04) |
| Navigate away from camera | Camera + inference + recorder keep running (C-06) |
| Second session started | Previous session silently discarded (C-04) |
| Pose changed mid-session | Recording stops silently, UI keeps counting (H-11) |

### 10.3 Concurrency & state boundaries
- Inference runs on a dedicated thread; camera publishes lock-free via `ArcSwapOption`; SQLite in WAL with a busy timeout — the architecture is right.
- Preview thread is unjoined and shares one global flag (C-07).
- Session is fed from the preview loop *and* exposed via `capture_tick` (M-09) — two producers for one recorder.
- Model load and inference hold the engine mutex; `capture_tick` (if used) would block the caller for a full forward pass.
- 30 Hz state updates and a 76k-iteration pixel loop on the UI thread (H-07).
- `stop_preview` can block indefinitely on a hung device read (M-14).

### 10.4 Data security & silent failures
- Admin key in git history (C-01).
- No rules in the repo; documented as permissive (C-02).
- No CSP (M-01), plaintext credentials (M-02), no RBAC (M-04).
- No error boundary in either app; camera errors never reach the UI; several `catch {}` and `let _ =` paths (H-10).
- Positive: no service account is shipped to the workstation at runtime; the runtime uses a clinic ID token; `updateMask` correctly protects fields the app does not own; sessions are hashed (SHA-256) and content-addressed by path.

---

## 11. What is genuinely good (do not regress)

1. **Local-first durability**: SQLite outbox in WAL, sessions + Parquet blob written before any network call, blob reclaimed after sync (`outbox.rs`).
2. **Schema discipline**: `PRAGMA user_version` migrations, a `verify_schema` guard that turns "legacy DB" into an actionable error, and a test that proves it.
3. **Idempotent aggregation**: a `sessionLedger` document inside the same transaction prevents double-counting on at-least-once trigger delivery (`aggregation.js:52-90`) — this is textbook correct.
4. **Narrow Firestore mask**: patient writes cannot null out `address`/`note`/`tel_number`/legacy aggregates (`cloud_sync.rs:160-211`).
5. **Test culture where it exists**: real ONNX forward-pass test (skips cleanly), Parquet round-trip verified by an independent reader (polars), letterbox/NMS/FSM unit tests, hardware-free synthetic pipeline.
6. **Graceful degradation**: no camera / no runtime / no credentials each produce a typed, explainable state rather than a crash.

---

## 12. Prioritised remediation plan

**Before any patient contact (P0 — this week)**
1. **Rotate and purge** the Firebase admin key; audit access logs (C-01).
2. Write and deploy **Firestore + Storage rules**; add to CI; add emulator tests (C-02).
3. Add the **camera watchdog + alert + auto-pause + reconnect** (C-03).
4. Make `stop_session` **non-destructive**: keep the session until the outbox write succeeds; block a second `start_session` (C-04).
5. Reset stale `uploading` rows at startup (C-05).
6. **Stop capture on unmount** and cap the recorder (C-06).
7. Join the preview thread; add a generation counter (C-07).
8. Disable the pose selector during a session (H-11).

**Before pilot with staff (P1 — 1-2 weeks)**
9. Error boundary + global error channel; remove `catch {}` on the camera path (H-10).
10. Background sync with backoff + connectivity listener (H-06).
11. Confirm keypoint labels and pose identities with the instructor; flip `label_source` to verified (H-04).
12. Implement the paper's multi-joint score and 4 angles — or formally document the deviation and re-validate the clinical claims (H-02, H-03).
13. Fix the 30 Hz render/IPC storm (H-07).
14. Remove aggregate fields from client writes (H-08).
15. Add the session-size guard (H-09).

**Before general availability (P2)**
16. CSP, credential storage, RBAC/tenant scoping, tombstone filtering (M-01 to M-04).
17. Cohort aggregation functions + `onDelete` (H-05).
18. Real provider reporting, startup error window, hold-time fix, session cap, CI gaps (M-05 to M-12).
19. Publish an ADR/spec that supersedes the PDF's §3.1-3.4 (H-01).

---

## 13. Reproduction commands

```powershell
# 1. The committed admin key
git show HEAD:config/firebase-sdk.json | Select-String 'private_key|client_email'

# 2. No security rules exist
Get-ChildItem -Recurse -File -Include *.rules,firestore.indexes.json | Where-Object FullName -notmatch node_modules
Select-String -Path firebase.json -Pattern 'firestore|storage'

# 3. Camera errors never reach the UI
Select-String -Path apps\desktop\src-tauri\src\*.rs -Pattern 'last_error\('   # only the definition
Select-String -Path apps\desktop\src-tauri\src\*.rs -Pattern 'camera-error'    # no such event

# 4. No background sync
Select-String -Path apps\desktop\src-tauri\src\*.rs -Pattern '\.flush\('      # only commands.rs:927
Select-String -Path apps\desktop\src\hooks\useTauriSync.ts -Pattern 'syncNow' # only the manual button

# 5. No cleanup on unmount
Select-String -Path apps\desktop\src\pages\ActiveCapturePage.tsx -Pattern 'return \(\) =>|stopPreview'

# 6. Stranded uploads
Select-String -Path apps\desktop\src-tauri\src\outbox.rs -Pattern "upload_state IN"

# 7. Design drift
Select-String -Path apps\desktop\src-tauri\src\biomechanics.rs -Pattern 'WEIGHT_ANGLE|min_hold_sec'
Select-String -Path config\pose-definitions.json -Pattern 'display_name|label_source'
```

---

*End of report. 50 findings: 7 Critical, 11 High, 16 Medium, 16 Minor.*
