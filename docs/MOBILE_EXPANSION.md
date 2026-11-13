# Desktop → Mobile: Possibilities, Methodologies, and Paths

**Scope.** This document is about taking the **desktop application** (`apps/desktop`)
to mobile. The clinical web portal (`apps/web`) is deliberately out of scope: no
portal work is proposed, and where a mobile change would alter a shared contract
(e.g. a new field in a session document) the note says so and stops there.

**Status.** Exploration and recommendation. No code has been changed.

**How to read it.** §1 establishes what the desktop actually is. §2 frames the
product decision that determines the technical path. §3 is the portability audit
(what survives, what must be replaced). §4 lists the methodologies that make any
path cheaper. §5 lays out the six viable paths with effort and risk. §6 recommends
a sequence. §7–§11 are the architecture, clinical-equivalence, performance,
security and release implications. §12–§14 are risks, decisions needed, and the
first two weeks.

---

## 0. Executive summary

The desktop is unusually well positioned for a mobile port, because almost none of
its value is in the shell:

- **10,283 lines of Rust across 16 files** (15 modules plus `main.rs`) carry the pipeline (camera → ONNX →
  biomechanics → repetition FSM → Parquet → SQLite outbox → cloud sync). The React
  shell is **2,802 lines** and 34 IPC commands.
- Only **seven `#[cfg]` sites in four files** touch the operating system at all
  (`camera.rs`, `inference.rs`, `commands.rs`, `paths.rs`). The domain crates have
  no platform code.
- Exactly **one module has no mobile equivalent**: `camera.rs`, built on `nokhwa`,
  which supports MediaFoundation / AVFoundation / V4L2 and has no iOS or Android
  backend.
- Everything else is packaging: ONNX Runtime must be shipped for the phone's
  architecture, the SQLite/Parquet layer already cross-compiles, and the sync
  client is ordinary HTTP.

Three things are genuinely unknown and must be measured before committing:

1. **Inference speed on a phone** at a cadence that still measures holds correctly.
2. **Camera capture inside a Tauri mobile app** (there is no first-party camera
   plugin, and `getUserMedia` support in the embedded webview is unproven here).
3. **Rendering 30 Hz telemetry in a mobile webview** without dropping frames or
   heating the device.

**Recommendation.** Tauri 2, Android-first, sharing the Rust engine and the React
screens, delivered in three phases: 3-week spike programme → 6–8 week Android
capture companion → 4–6 week iOS/parity. Keep React Native + UniFFI in reserve with
a written trigger for switching (see §12). Do **not** attempt the engine in
WASM for capture; it is the right answer only for a review-only app.

---

## 1. What exists today

### 1.1 Pipeline

```text
┌────────────────────────────── Rust (src-tauri) ──────────────────────────────┐
│                                                                              │
│  nokhwa capture thread          ArcSwapOption<Frame>       preview thread     │
│  640×480 @30 MJPEG ────────────▶  (lock-free slot) ───────▶  33 ms cadence    │
│                                     ▲                          │             │
│                                     │                          ▼             │
│                            camera.rs:158                ort session (640×640)│
│                                                          FP16, CPU / CoreML   │
│                                                               │              │
│                                                               ▼              │
│                                             glam joint angles + RepFsm       │
│                                             + DetectionRepTracker            │
│                                                               │              │
│                     ┌─────────────────────────────────────────┤              │
│                     ▼                                         ▼              │
│          emit "telemetry-frame" @30 Hz            CaptureSession.process()   │
│          (React overlay, gauges)                  → TelemetryRecorder        │
│                                                   (40k frames ≈ 22 min)      │
│                                                               │              │
│                                                               ▼              │
│                                                   Snappy Parquet (11 cols)   │
│                                                               │              │
│                                                               ▼              │
│                     SQLite WAL outbox (parquet BLOB) → Firestore + GCS       │
└──────────────────────────────────────────────────────────────────────────────┘
                                    ▲
                    React 19 shell (apps/desktop/src)
                    · preview: 320×240 RGB polled every 66 ms over IPC
                    · skeleton overlay: separate canvas, 30 Hz
```

### 1.2 Inventory and size

| Area | Files | Lines | Notes |
| :--- | :--- | ---: | :--- |
| Rust engine | 15 modules + `main.rs` in `apps/desktop/src-tauri/src` | 10,283 | includes tests |
| Largest modules | `outbox.rs`, `cloud_sync.rs`, `commands.rs` | 1,860 / 1,790 / 1,486 | all portable Rust |
| React shell | `apps/desktop/src` | 2,802 | 4 pages, 5 components, 3 hooks |
| Shared packages | `packages/{types,ui,viz,patient-view}` | — | React + canvas + recharts |
| Models | `config/models/*.onnx` | 5 × 6.1–6.4 MB | 1×3×640×640 FP16, opset 17 |
| IPC surface | `main.rs:142` | 34 commands | all plain functions |

### 1.3 Facts that matter for mobile

| Fact | Where | Why it matters |
| :--- | :--- | :--- |
| Capture is a dedicated thread writing into an `ArcSwapOption`, readers never lock | `camera.rs:1-9`, `camera.rs:158` | The frame source is already an interface in disguise: swapping it is the whole camera port. |
| ONNX Runtime is loaded **dynamically** at runtime | `inference.rs:196-213` | Same strategy works on Android (`.so` in `jniLibs`) and iOS (static xcframework); the loader already has a search path and an env override. |
| Execution provider chain is CoreML → CPU; no Windows GPU tier | `inference.rs:1-21` | Adding NNAPI/XNNPACK for Android is an extension, not a redesign. |
| Inference measured at 20–35 ms/frame on desktop CPU | `inference.rs:13` | The mobile budget is the central unknown. |
| Preview is 320×240 RGB, polled every 66 ms and converted RGB→RGBA in JS | `LivePreview.tsx:48-80`, `ipc.ts:213` | Works, but is the first thing to replace on a phone (battery, IPC, GC). |
| Telemetry events at 33 ms drive React state | `commands.rs:526`, `useTauriCapture.ts:49` | 30 Hz `setState` on a mobile webview is a real risk. |
| Recorder capacity 40,000 frames | `session.rs:183` | ≈22 minutes at 30 Hz; a session cap already exists. |
| Repetition confirmation is counted in **frames**, not time | `rep_tracker.rs:38-39` | Clinically significant across devices — see §8. |
| Session document curve capped at 3,000 points | `telemetry.rs:275` | Firestore's 1 MiB limit is already engineered around. |
| Parquet blob is stored inside SQLite | `outbox.rs:311-324`, `outbox.rs:626-642` | On a phone this is app-private storage that must be excluded from cloud backup. |
| Sync client is `reqwest::blocking` with a 60 s timeout | `cloud_sync.rs:465-470` | Long blocking commands are tolerable on desktop, not on Android/iOS. |
| Credential is a plaintext refresh token in `auth.json` | `pairing.rs:117-126` | Not acceptable on a device that leaves the building. |
| Updater / process / shell plugins registered unconditionally | `main.rs:128-141` | Updater has no mobile support (verified: plugin README marks Android and iOS unsupported). |
| `open_url` has Windows/macOS/Linux arms only | `commands.rs:1032-1066` | Fails to compile for mobile — a useful canary for how much platform code is left. |
| Window is fixed at 1280×850, minimum 960×640 | `tauri.conf.json` | No responsive shell today; the sidebar is 240 px of permanent chrome. |

---

## 2. What "mobile" means here

The technical path is decided by which of these five products you are building.
They are not variations on a theme; they have different cameras, different data
flows and different regulatory postures.

| # | Product shape | What the clinician does | Needs | Effort shape |
| :-- | :--- | :--- | :--- | :--- |
| **1** | **Review companion** | Opens a phone to check a patient's history and last session between clients | Patients + session documents; no camera, no inference | Small: a read-only client over the existing local DB or Firestore |
| **2** | **Capture companion** | Puts a phone or tablet on a tripod and records the session in the studio or at a home visit | Camera + inference + recorder + sync; patient roster | Medium: the real port |
| **3** | **Portable workstation** | Runs the whole product on a tablet, no laptop in the room | Everything in 2, plus patient CRUD, sign-in, comments | Medium-large: 2 + parity work |
| **4** | **Patient self-guided** | Patient follows prompts at home | Patient accounts, consent, remote config, coaching UI | A different product; new regulatory posture |
| **5** | **Phone as camera** | Phone streams frames to the laptop already running the app | LAN pairing, streaming, desktop unchanged | Small-medium; solves placement, not portability |

**The decision to make:** is mobile a *replacement* for the workstation (3), a
*portable capture device* that still syncs to the same clinic data (2), or a
*convenience view* (1)? Path 4 should be treated as a separate product line and
is out of scope for this document. Path 5 is worth keeping in the back pocket
because it is cheap and it answers the most common complaint — camera placement —
without porting anything.

Everything below assumes the target is **2, on the way to 3**.

---

## 3. Portability audit

Verdict legend: **portable** (compiles and runs unchanged), **adapter** (same
logic, different platform edge), **replace** (no mobile equivalent), **drop**
(desktop-only by nature), **extend** (needs new platform targets in the build).

| Subsystem | Evidence | Verdict | Work required |
| :--- | :--- | :--- | :--- |
| `biomechanics.rs`, `rep_tracker.rs`, `pose_config.rs`, `mock_source.rs` | pure Rust + serde + glam | **portable** | none (add `confirm_ms`, §8) |
| `session.rs`, `telemetry.rs` | arrow/parquet are pure Rust | **portable** | verify memory ceiling on device; measure Parquet write time |
| `outbox.rs` (SQLite WAL) | `rusqlite` with `bundled` | **portable** | bundled SQLite compiles with the NDK/Apple clang; set backup-exclusion; consider SQLCipher |
| `error.rs`, `state.rs` | no I/O | **portable** | none |
| `camera.rs` | `nokhwa` desktop backends only | **replace** | native camera plugin feeding the same `ArcSwapOption<Frame>` |
| `inference.rs` | `ort` with `load-dynamic` | **adapter** | ship `.so` per ABI / static xcframework; add XNNPACK + NNAPI (Android) and CoreML (iOS) selection with fallback |
| `cloud_sync.rs` | `reqwest::blocking`, 60 s timeout | **adapter** | async or worker-thread execution; `rustls` to avoid OpenSSL cross-compiles; smaller timeouts with retry |
| `pairing.rs` | refresh token in `auth.json` | **adapter** | Keychain / Android Keystore; keep the file format for migration |
| `paths.rs` | Windows path pinned; `app_data_dir` otherwise | **adapter** | `cfg` the Windows pin; mobile uses Tauri's app data dir |
| `commands.rs` | 34 IPC commands, 3 platform arms | **adapter** | `#[cfg(desktop)]` arms; async for network commands; `open_url` via opener plugin |
| `main.rs` | `windows_subsystem`, tray feature, desktop plugins | **adapter** | split into `lib.rs` + `main.rs` with `#[cfg_attr(mobile, tauri::mobile_entry_point)]`; `#[cfg(desktop)]` around updater/process/shell |
| Tray, updater, process relaunch | `Cargo.toml:12`, `main.rs:131-132` | **drop** | mobile updates come from the store; there is no in-app updater |
| Window config | `tauri.conf.json` | **replace** | responsive shell; landscape capture screen; keep-screen-on |
| React shell | 4 pages, sidebar layout | **adapter** | bottom tabs under `md`, touch targets, no hover-only affordances |
| `LivePreview` | 320×240 RGB over IPC | **replace (preferred)** | native preview layer + transparent overlay, or JPEG/WebSocket stream |
| Build & release | desktop matrix only | **extend** | Android SDK/NDK/JDK, macOS + Xcode + CocoaPods, signing, store tracks |

**Bottom line:** of 16 engine files, **9 need no changes**, **6 need a platform
edge** (four modules plus the command layer), and **1 — the camera — needs a new
implementation**. That is a port, not a rewrite.

---

## 4. Methodologies

These are the "how", independent of which path is chosen. They are ordered by how
much they pay off, and M1 should be done regardless.

### M1 — Extract the engine: ports and adapters

Move everything except `commands.rs` and `main.rs` into crates, with the platform
edge expressed as traits:

```rust
// crates/pilates-ports/src/lib.rs  (sketch)
pub trait FrameSource: Send {
    fn device(&self) -> DeviceInfo;
    fn latest(&self) -> Option<Arc<Frame>>;
    fn stop(&mut self);
}

pub trait PoseDetector: Send {
    fn provider(&self) -> ProviderKind;
    fn infer(&mut self, frame: &Frame) -> EngineResult<InferenceOutput>;
}

pub trait SecureStore: Send + Sync {
    fn load(&self) -> Option<AuthState>;
    fn save(&self, state: &AuthState) -> EngineResult<()>;
    fn clear(&self) -> EngineResult<()>;
}
```

Proposed layout:

```text
crates/
  pilates-core/        # biomechanics, rep_tracker, session, telemetry, pose_config, mock_source
  pilates-store/       # outbox (rusqlite), parquet blob lifecycle, migrations
  pilates-cloud/       # firestore/storage REST, token refresh (async)
  pilates-ports/       # FrameSource, PoseDetector, SecureStore, Clock
  pilates-engine-desktop/   # nokhwa + ort(load-dynamic) + keyring
  pilates-engine-mobile/    # camera plugin bridge + ort(jni/static) + keystore
apps/
  desktop/             # unchanged Tauri app, now a thin shell over the crates
  mobile/              # second Tauri app (own identifier, own tauri.conf.json)
packages/
  screens/             # pages extracted from apps/desktop/src/pages
```

Why this first: it is the only change that every path benefits from, it makes the
engine testable without Tauri, and it turns the camera port into "write one
implementation of a trait" instead of "edit a pipeline".

Rule: **no `#[cfg]` inside the domain crates.** Platform selection happens only in
the adapter crates and the two `main.rs` files. That rule is what keeps a third
shell (if it ever comes) from becoming a fork.

### M2 — Strangler-fig the UI

Extract pages into `packages/screens` one at a time, with the desktop build as the
gate after each extraction. Start with `PatientListPage` (no camera, no native
calls), then `PatientDetailPage` and `SessionDetailPage`, and leave
`ActiveCapturePage` last because it is the one page that will genuinely diverge
between desktop and mobile (landscape, keep-awake, native preview).

The pattern is already proven in this repo: `packages/patient-view` is a shared
React package consumed by both the desktop app and the portal. `packages/screens`
is the same idea applied to the desktop's own pages.

### M3 — Spike-gated phases

The repo already has a step/gate culture (`docs/history/MASTER_EXECUTION_PLAN.md`
uses numbered steps with ✅ gates). Keep it: every unknown gets a spike with a
**numeric pass criterion** before it becomes a commitment. §6 defines them.

### M4 — Contract-first codegen

The same domain shape is currently written three times by hand:

| Concept | Rust | TypeScript |
| :--- | :--- | :--- |
| `MovementPhase` | `biomechanics.rs:17` | `packages/types/src/biomechanics.ts` |
| `KinematicFrame` (TS: `KinematicFrameRecord`) | `telemetry.rs:27` | `packages/types/src/telemetry.ts` |
| `ClinicalSessionDocument` | `session.rs` | `packages/types/src/session.ts` |

Two clients can be kept in sync by discipline; three cannot. Generate the
TypeScript from the Rust types (`ts-rs` or `typeshare`) or from a JSON Schema, and
add a CI check (`cargo test --features ts-export && git diff --exit-code`). This is
a prerequisite for any path that adds a second UI.

### M5 — Capabilities instead of `isTauri()`

There are **17 occurrences of `isTauri()`** (including the helper and its doc
comment). Every call asks "am I inside the desktop app?", which becomes the wrong
question on mobile. Replace it with a capability object returned once at startup:

```ts
interface PlatformCapabilities {
  capture: boolean;        // camera + engine available
  inference: boolean;      // ONNX runtime loaded
  updater: boolean;        // desktop only
  tray: boolean;           // desktop only
  secureStore: boolean;
  share: boolean;          // mobile only
  platform: "windows" | "macos" | "linux" | "android" | "ios" | "browser";
}
```

The UI then renders from capabilities (`capture: false` → the existing "Browser
preview mode" banner; `updater: false` → no update button). This is a small
refactor that removes the most common source of mobile-only bugs before they are
written.

### M6 — Golden-fixture conformance

`mock_source.rs` already generates a deterministic frame/detection sequence that
drives `CaptureSession` through complete repetitions. That is the cross-platform
test: run the same scripted profile on desktop, on Android and in CI, and diff the
resulting `ClinicalSessionDocument` (ignoring timestamps). If the phone counts a
different number of reps, the port is not done — regardless of what the UI looks
like. This is also the cheapest form of clinical validation available.

### M7 — Dual-track release

Desktop keeps its current 38-minute matrix and update channel untouched. The
mobile app is a separate workflow, a separate version number, and a separate
store track. Shared code moves forward together; releases do not.

### M8 — Distribution strategy decided early

"Where does the app come from?" changes the security design and the timeline:

- **Clinic-owned devices (MDM):** Managed Google Play private app / Apple Business
  Manager custom app. No public review, controlled updates, remote wipe, kiosk mode.
  Best fit for a studio tablet bolted to a stand.
- **Personal phones (public stores):** Play production + App Store review, privacy
  labels, per-user installs. Necessary if therapists use their own devices.
- **Sideload (Android only):** an APK over the existing update channel. Fine for a
  pilot, not for a clinic.

---

## 5. The paths

Each path is described by what it keeps, what it rewrites, and when it wins.

### Path A — Tauri 2, Android-first, native camera plugin

*Recommended.*

**Keeps:** the entire Rust engine (via M1), the React screens (via M2), the design
system, the models, the sync protocol, the Parquet contract.

**Rewrites:** `camera.rs` → a Tauri mobile plugin (`CameraX` `ImageAnalysis` on
Kotlin, RGB into a `JNI` callback into the same `ArcSwapOption<Frame>`), the preview
transport, the shell layout, credential storage, and the build pipeline.

**Work items**

1. `apps/mobile/` — second Tauri app, identifier `com.pilatesai.mobile`, path
   dependencies on the crates; `main.rs` split into `lib.rs` + `main.rs` with
   `#[cfg_attr(mobile, tauri::mobile_entry_point)]`.
2. `tauri android init` → `gen/android`; capabilities for mobile window labels;
   `#[cfg(desktop)]` around updater/process/shell/tray.
3. Camera plugin: permission flow (`CAMERA`), rear/front selection, rotation and
   mirroring, 640×480 `ImageAnalysis` at 30 fps with RGB output where the device
   supports it and YUV→RGB conversion otherwise.
4. ONNX Runtime packaging: extend `tools/fetch_onnxruntime.py` with
   `android-arm64`/`android-arm`/`android-x64`; place `libonnxruntime.so` in
   `jniLibs/<abi>/`; set `ORT_DYLIB_PATH` from `nativeLibraryDir` at startup; try
   NNAPI → fall back to XNNPACK → CPU, and report the provider in `engine_status`.
   Treat NNAPI as opportunistic: its long-term support is uncertain, so XNNPACK is
   the portable default and the one the pass criteria are measured against.
5. Responsive shell: sidebar becomes bottom tabs under `md`; capture page locks
   landscape and keeps the screen on; touch targets ≥44 px.
6. Secure storage: Keystore-backed `SecureStore`, migrating `auth.json` on first
   launch.
7. Async network commands; `rustls`; shorter timeouts with retry/backoff.
8. Play internal testing → closed testing with one or two clinics → production.

**Effort:** 6–8 weeks for a capture companion with patient roster, session review
and sync; +2 weeks for parity polish. Assumptions in Appendix B.

**Risk:** the webview render budget (spike S3) and camera plugin plumbing are the
two places this can slip.

### Path B — iOS after Android

Same crates, new edge: `AVCaptureSession` plugin in Swift, `onnxruntime.xcframework`
statically linked, CocoaPods, Xcode project under `gen/apple`, TestFlight.

**Extra work over A:** Xcode/CocoaPods toolchain, static linking instead of dynamic
loading (the loader already supports both, but the packaging does not), App Store
review, privacy manifest (`NSPrivacyAccessedAPITypes`), background behaviour (no
background capture; screen-on is mandatory), and the "minimum functionality"
review risk that faces any webview-based app.

**Effort:** 4–6 weeks once Android is done and the screens are responsive.

**Risk:** lower ecosystem maturity than Android in Tauri; expect a week of
toolchain friction that does not appear in estimates.

### Path C — React Native + Rust core via UniFFI

**Keeps:** the Rust domain (biomechanics, FSM, telemetry, outbox, sync) behind a
UniFFI bridge; `packages/types` shapes.

**Rewrites:** the entire UI in React Native primitives; the camera layer becomes
`react-native-vision-camera` frame processors; inference becomes
`onnxruntime-react-native` (or stays in Rust behind the bridge).

**Wins when:** mobile becomes the primary product and desktop secondary; or when
spikes show the Tauri webview cannot sustain the overlay; or when native gestures,
AR guidance or background recording become requirements.

**Cost:** two UI codebases (desktop React DOM vs RN), a bridge to maintain, and the
loss of `packages/viz` (canvas + recharts) unless reimplemented with
`react-native-svg`/Skia. **Effort:** 10–16 weeks. **Risk:** moderate — every piece
is well-trodden, but the total surface is larger.

### Path D — Flutter + `flutter_rust_bridge`

**Keeps:** the Rust domain via codegen; the team has FlutterFlow history (the
README credits it for the legacy visualisation).

**Rewrites:** everything UI; the design system and all charts; the shared
TypeScript packages become irrelevant to mobile.

**Wins when:** the mobile app is a long-lived separate product with its own design
language, or if the team standardises on Dart.

**Cost:** a third stack in a monorepo that already has two; the clinical charts
(`packages/viz`, ~110 KB of source) would be rebuilt. **Effort:** 12–18 weeks.

### Path E — Webview-only engine (ONNX Runtime Web / WASM / WebGPU)

Run the same `.onnx` files in the webview; camera via `getUserMedia`; storage via
OPFS or a WASM SQLite; no Rust on mobile at all.

**Keeps:** the React UI and the models.

**Rewrites:** the engine in TypeScript — preprocessing, NMS, biomechanics, FSM,
Parquet (arrow-js), SQLite, sync. That is most of the 10k lines, reimplemented.

**Wins when:** the goal is a review-only app, a demo, or a browser fallback; or as
a *temporary* capture prototype to validate clinical demand before committing.

**Why not for production capture:**

- WASM threads need cross-origin isolation (COOP/COEP headers); inside a Tauri
  webview the asset protocol makes that awkward, and without threads WASM is
  several times slower.
- iOS Safari/WKWebView memory limits make 5 × 6 MB models plus a frame buffer
  uncomfortable; WebGPU on iOS is only recent.
- The desktop's reliability claim ("engine ready, degrades gracefully") is exactly
  what gets lost when the engine moves into the page.

**Effort to a demo:** 1–2 weeks. **Effort to parity:** 8–12 weeks, with worse
performance. It is a prototype tool, not a path to parity.

### Path F — Phone as camera peripheral for the desktop

A capture-only mobile build (or even a plain camera app) streams frames over the
LAN to the workstation, which does the inference and recording as it does today.

**Keeps:** every line of the engine and the entire clinical workflow.

**Adds:** discovery/pairing on the LAN, a streaming protocol (MJPEG over WebSocket
is enough at 640×480), and a "remote camera" state in the desktop.

**Wins when:** the pain is camera placement (phone on a tripod near the reformer,
laptop on the desk), not portability. **Effort:** 3–5 weeks. **Risk:** low, but it
does not deliver the "no laptop in the room" outcome.

### 5.1 Scoring

Weights reflect this project's constraints: time-to-clinical-use and reuse matter
more than raw performance, because the domain is slow (isometric holds), not
explosive. Scores are judgement, 1–5.

| Path | Time (0.20) | Reuse (0.15) | Perf (0.15) | Camera (0.10) | Maint. (0.10) | Risk (0.15) | Distribution (0.05) | Team fit (0.10) | Weighted |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **A** Tauri Android | 3 | 5 | 4 | 4 | 4 | 3 | 3 | 5 | **3.85** |
| **B** A + iOS | 2 | 5 | 4 | 4 | 4 | 3 | 3 | 5 | 3.65 |
| **C** RN + UniFFI | 2 | 3 | 5 | 5 | 3 | 4 | 4 | 4 | 3.60 |
| **D** Flutter | 2 | 2 | 5 | 5 | 3 | 4 | 4 | 4 | 3.45 |
| **E** WASM | 5 | 3 | 2 | 3 | 4 | 4 | 5 | 4 | 3.70 |
| **F** Remote camera | 4 | 4 | 5 | 5 | 4 | 4 | 4 | 5 | 4.35 |

**Veto gates.** A weighted score is not a decision. These are pass/fail:

1. On-device inference ≥ **10 fps sustained** at 480×480 on the reference mid-range
   device after 20 minutes (thermal steady state).
2. Capture ≥ **25 fps** preview and ≤ 1 dropped frame/s.
3. No video leaves the device.
4. The session document produced on the phone passes the golden-fixture diff (§8).
5. The app can be distributed to clinic devices without per-device manual installs.

Path E fails gate 1 and 4 for capture (it passes for review-only). Path F passes
everything but does not deliver the product goal. Path A is the only path that
passes all five while keeping the engine and the screens.

---

## 6. Recommendation and sequence

### Phase 0 — Spike programme (3 weeks, one engineer)

| Spike | Question | Pass criterion | Deliverable |
| :--- | :--- | :--- | :--- |
| **S1** Inference | Can ORT run `pose1.onnx` on the reference phone at a useful cadence? | ≤ 100 ms/frame median at 640, ≤ 60 ms at 480, provider reported, 20-min soak without >30 % slowdown | `tools/spike/ort-android` report: ms/frame per provider, thermal trace |
| **S2** Camera | Does CameraX → Rust → preview work end to end? | 30 fps capture, correct rotation in portrait and landscape, permission denial handled | Plugin prototype committed to `apps/mobile` |
| **S3** Webview budget | Can the React overlay hold 25 fps with 30 Hz events (worst case)? | ≥ 25 fps UI, JS heap stable over 10 min, no ANR | Screen recording + Chrome DevTools trace |
| **S4** Storage | Does a 10-minute session survive on device? | Parquet verifies with `tools/verify_parquet.py`, peak RSS < 200 MB, 5 queued sessions | Device test log |
| **S5** Auth & sync | Secure token + offline queue → upload | Token survives restart in Keystore, upload resumes after airplane mode | Working sign-in on device |

Gate: if S1 or S3 fails, stop and re-evaluate Path C (RN) before writing UI code.
Write the decision as `docs/adr/0001-mobile-platform.md` either way.

### Phase 1 — Android capture companion (6–8 weeks)

Ship: sign-in (secure store), patient roster, capture (camera + inference +
recorder), session review, offline queue and sync, landscape capture screen with
keep-awake, capability-driven UI. No tray, no updater, no portal handoff (Analysis
is desktop-only).

Pilot with one clinic on Play internal testing, using clinic-owned devices.

### Phase 2 — iOS + parity (4–6 weeks)

Same feature set on iPhone/iPad, TestFlight, privacy manifest, App Store submission
(be prepared to justify "not just a website" — native camera + on-device ML does
that), then parity polish: comments, patient editing, export/share.

### Phase 3 — Consolidation (ongoing)

Codegen (M4), golden-fixture CI on both platforms (M6), performance tuning per
device class, and the extraction cleanup that Phase 1 will have deferred.

### Timeline

| Phase | Duration | Confidence | Notes |
| :--- | :--- | :--- | :--- |
| 0 | 3 weeks | high | unknowns are measured, not assumed |
| 1 | 6–8 weeks | medium | camera plugin and webview perf are the variance |
| 2 | 4–6 weeks | medium-low | toolchain and review add unpredictable days |
| 3 | continuous | — | ~20 % of mobile effort is maintenance |

Total to a clinic-usable Android app: **9–11 weeks** after Phase 0 starts, one
engineer. Two engineers do not halve it; they overlap Phase 1 and Phase 2 by about
a third.

---

## 7. Target architecture after extraction

```text
pilates-ai/
├─ crates/
│  ├─ pilates-core/          # no I/O, no cfg: math, FSM, session, telemetry, pose config
│  ├─ pilates-store/         # SQLite outbox, migrations, Parquet blob lifecycle
│  ├─ pilates-cloud/         # async REST client, token refresh, upload queue
│  ├─ pilates-ports/         # FrameSource, PoseDetector, SecureStore, Clock
│  ├─ pilates-engine-desktop/ # nokhwa, ort dynamic, keyring, tray
│  └─ pilates-engine-mobile/  # camera plugin bridge, ort jni/static, keystore
├─ apps/
│  ├─ desktop/               # thin Tauri shell; existing config and release pipeline
│  ├─ mobile/                # second Tauri shell; android/ + ios/ generated projects
│  └─ web/                   # portal (out of scope)
├─ packages/
│  ├─ types/ ui/ viz/ patient-view/
│  ├─ screens/               # pages shared by desktop and mobile
│  └─ ipc/                   # typed bridge + PlatformCapabilities
└─ config/                   # models, manifest, pose definitions (unchanged)
```

**Rules**

1. Domain crates stay `no_std`-ish in spirit: no `std::env`, no filesystem paths,
   no `cfg(target_os)`.
2. The adapter crates are the only place that knows about Android, iOS or Windows.
3. `apps/mobile` is a separate Tauri app, not a feature flag in `apps/desktop`.
   Separate identifier, separate window config, separate plugins, separate release
   workflow. Sharing happens through crates and `packages/screens`.
4. The `ClinicalSessionDocument` contract is the integration point. It already
   carries everything the portal needs; adding `engine` metadata (§8) is the only
   contract change proposed.

---

## 8. Clinical equivalence across devices

This is the part that is easy to miss and expensive to discover late: **the same
code on a slower device does not produce the same clinical numbers.**

### 8.1 `confirm_frames` is a cadence-dependent parameter

`DetectionRepConfig` confirms a class after **3 consecutive frames**
(`rep_tracker.rs:38-39, 55`). At the desktop's 30 Hz that is 100 ms. At the 10 Hz a
mid-range phone may sustain, it is 300 ms — three times more permissive. A brief
misdetection that the desktop ignores becomes a counted hold on the phone.

**Fix:** replace with `confirm_ms` (default 100), keep `confirm_frames` as a
deprecated alias for one release, and regenerate
`config/pose-definitions.json` with `tools/generate-pose-definitions.mjs` (CI
already verifies the generated file is in sync). `min_hold_sec`, `grace_sec` and
`max_hold_sec` are already time-based and need no change.

### 8.2 Form score is device-dependent

`form_score` blends angle accuracy, hold stability and **detection confidence**
(`biomechanics.rs` header). Different execution providers and input resolutions
produce different confidence distributions, so the same patient can score
differently on two devices. Options, in order of preference:

1. Record the provider, input size and cadence in the session document (`engine`
   block) and never compare scores across device classes in the same chart.
2. Calibrate per provider class with a reference recording.
3. Remove confidence from the score and report it separately.

Option 1 is cheap and is also what an auditor would ask for.

### 8.3 Conformance test

Extend the existing Rust test harness: run the `mock_source` profile through
`CaptureSession` on desktop and on device, serialize the document, drop
timestamps, and assert equality. Any divergence is a port bug, not a clinical
judgement call. This test is also the fastest way to catch a cadence change
slipping into the FSM.

### 8.4 Validation before clinical use

Twenty recorded sessions, replayed through the phone build and the desktop build,
comparing rep count, ROM, hold duration and form score. Acceptance: rep count
identical, angles within 2°, hold duration within 100 ms. This is a half-day of
work once the golden-fixture harness exists, and it is the difference between "it
runs" and "a therapist can trust it".

---

## 9. Performance, thermal and battery budgets

| Resource | Desktop today | Mobile budget | Mitigation |
| :--- | :--- | :--- | :--- |
| Capture | 640×480 @ 30 fps | same | CameraX `ImageAnalysis` with `STRATEGY_KEEP_ONLY_LATEST` |
| Inference | 20–35 ms/frame (CPU) | ≤ 60 ms at 480, ≤ 100 ms at 640 | XNNPACK, 2–4 threads on big cores; NNAPI where it does not fall back |
| Detection cadence | 30 Hz | 10–15 Hz sustained | run inference every 2nd/3rd frame; keep the preview at 30 fps |
| UI events | 30 Hz React state | 10–15 Hz | throttle `setState`, draw the overlay in one `requestAnimationFrame` loop, use refs |
| Preview | 320×240 RGB over IPC @15 fps | native preview layer | camera texture behind a transparent overlay; no per-frame IPC |
| Recorder | 40,000 frames in memory | same cap | Parquet write on a worker thread; free the buffer immediately |
| Storage | SQLite blob | same | exclude from cloud backup; add a storage-used indicator |
| Battery | wall power | ≤ 15 % per 30-min session | 10 Hz inference, screen-on but dimmed, no video encoding |
| Thermal | n/a | no throttle-induced cadence collapse | 10 Hz design point, not 30 Hz; monitor and degrade gracefully |

**The key design decision:** treat **10 Hz detection as the design point**, not a
degraded mode. This is an isometric-hold product; holds last 2.5–60 seconds
(`rep_tracker.rs:56-58`), and hold duration is measured from timestamps, not from
frame counts. Ten detections per second is ample to see a hold begin and end, and
it is what makes the phone survive a 30-minute session. The desktop can keep
running at 30 Hz.

---

## 10. Security, privacy and compliance

Mobile changes the threat model: the device leaves the building, gets lost, and is
used by several people.

| Issue | Today | Required on mobile |
| :--- | :--- | :--- |
| Credential at rest | plaintext `auth.json` (`pairing.rs:117-126`) | Keychain / Android Keystore; keep file format for migration |
| Patient data at rest | plaintext SQLite | SQLCipher (`rusqlite` `bundled-sqlcipher`) **or** OS file-based encryption + device passcode enforcement, documented as an accepted risk |
| Backups | n/a | exclude patient data from iCloud/Google backup (`isExcludedFromBackup`, `android:allowBackup="false"` + data extraction rules) |
| App switcher / screenshots | n/a | `FLAG_SECURE` on Android; blur on `applicationWillResignActive` on iOS |
| Lost device | delete `auth.json` | MDM remote wipe; revoke refresh token server-side (already supported) |
| Video | never uploaded | keep it — this is the strongest privacy claim in the product |
| Store declarations | n/a | camera usage description, no tracking, health-data questions answered honestly |
| Medical claims | "records and analyses" | keep the wording; diagnostic claims would trigger MDR/FDA SaMD work |
| Consent | none in-app | a per-patient consent checkbox before recording is worth adding for mobile, where the patient is in the room |

Two of these — credential storage and backup exclusion — are cheap and should be
done in Phase 1 regardless of the rest.

---

## 11. Distribution and release engineering

**Mobile has no in-app updater.** The Tauri updater plugin's supported-platform
table marks Android and iOS as unsupported; updates come from the store. The
desktop's `latest.json` / `channel.json` mechanism has no mobile equivalent, so the
"minimum supported version" idea has to move server-side (a config document the app
reads at startup) if you want to force upgrades.

| Concern | Desktop today | Mobile |
| :--- | :--- | :--- |
| Build host | 3-OS GitHub matrix (`desktop-release.yml`) | Ubuntu (Android) + macOS (iOS) jobs |
| Toolchain | Rust + Node + Python | + JDK (Android Studio's JBR), Android SDK/NDK, Xcode, CocoaPods |
| Signing | updater key (`TAURI_SIGNING_PRIVATE_KEY`) | Play App Signing / Apple distribution certificate + provisioning profiles |
| Distribution | NSIS/MSI/DMG/AppImage + updater | Play tracks, TestFlight, App Store; or MDM private apps |
| Version sync | `tools/set-version.mjs --sync` | extend to Android `versionCode` and iOS `CFBundleVersion` |
| Crash reporting | none | strongly recommended (Sentry or Crashlytics); a clinic will not file bug reports from a phone |

**Costs:** Apple Developer Program $99/yr; Google Play $25 once; a device lab of one
mid-range Android phone, one Android tablet, one iPhone and one iPad (roughly
$1,500–3,000 depending on what the team already owns); MDM licensing only if the
clinic route is chosen.

---

## 12. Risks and kill criteria

| Risk | Likelihood | Impact | Mitigation | Kill / pivot criterion |
| :--- | :--- | :--- | :--- | :--- |
| ONNX Runtime packaging on Android fails (NDK, ABI, linker) | medium | high | spike S1 uses `cargo-ndk` and the official ORT Android `.so`; fallback is a TFLite export (Ultralytics supports it) with a Rust binding | not resolved in 5 days → pivot to TFLite or Path C |
| Webview cannot hold 25 fps | medium | high | native preview layer, throttle React to 10 Hz | S3 fails twice → Path C (RN) |
| Camera plugin complexity (rotation, YUV, permissions) | medium | medium | use a community plugin as reference; keep the frame contract identical to `camera.rs` | > 3 weeks → adopt a community plugin and accept less control |
| Thermal throttling ruins 30-min sessions | high on mid-range | medium | design at 10 Hz; add a device-class profile | sustained < 5 fps → restrict to flagship/tablet device list |
| App Store rejection (4.2 minimum functionality) | low-medium | medium | native camera + on-device ML; provide a demo account and video | rejection twice → iOS via enterprise/Ad Hoc for clinics only |
| Clinical metrics differ across devices | medium | high | `confirm_ms`, golden fixtures, 20-session validation | any rep-count divergence → block release |
| Scope creep into patient-facing product | medium | high | keep Path 4 out of scope explicitly | requirements for patient accounts appear → re-plan as a separate product |
| Two UI codebases drift | medium | medium | M2 extraction into `packages/screens`, M4 codegen, capability object | screens diverge → consider Path C deliberately |

---

## 13. Decisions needed before Phase 1

1. **Device ownership.** Clinic-owned tablets (MDM, kiosk) or therapists' personal
   phones (public stores)? This changes security, distribution and the update
   story.
2. **Platform order.** Android-first is recommended: cheaper devices, easier
   sideloading, no review gate. iOS-first only if the clinics are Apple-only.
3. **Replace or complement?** Does the tablet replace the laptop in the room, or
   is it a companion that syncs to the same clinic data?
4. **Camera quality bar.** Is a phone camera on a tripod acceptable for clinical
   measurement, or must the workstation's camera remain the reference? If the
   latter, Path F may be the honest answer.
5. **Regulatory posture.** Documentation/measurement aid, or diagnostic claims?
   The answer changes the review process and the wording everywhere.
6. **Who builds it.** One engineer who knows the codebase, or a mobile contractor
   with the engine handed over? The estimates in this document assume the former.
7. **Budget and deadline.** The 9–11 week figure assumes full-time attention; it
   doubles at half-time.

---

## 14. First two weeks (concrete)

Ordered, each independently shippable:

1. **Extract `crates/pilates-core`** — move `biomechanics`, `rep_tracker`,
   `session`, `telemetry`, `pose_config`, `mock_source`; no behaviour change; the
   desktop app keeps compiling and all existing tests keep passing. Add a golden
   fixture test that snapshots a scripted session.
2. **Add `PlatformCapabilities`** — one Rust command plus a TS module; replace the
   17 `isTauri()` occurrences; no visual change on desktop.
3. **Convert `confirm_frames` → `confirm_ms`** — default 100 ms, deprecated alias
   retained, `config/pose-definitions.json` regenerated, CI check green.
4. **Make network commands async** — `sync_now`, `sync_pull_patients`,
   `auth_sign_in`, `pairing_*`, `open_portal`; swap `reqwest::blocking` for async
   with `rustls`; the desktop UI should behave identically.
5. **Run spike S1** — a bare Rust binary on the reference Android device with ORT
   and `pose1.onnx`, printing ms/frame per provider and a 20-minute thermal trace.
   This single result decides whether the plan holds.
6. **Draft `docs/adr/0001-mobile-platform.md`** — record the decision, the spike
   numbers, and the trigger that would reopen it.

---

## Appendix A — Evidence index

| Claim | Source |
| :--- | :--- |
| Engine size, module list | `apps/desktop/src-tauri/src/*` (10,283 lines across 16 files) |
| 34 IPC commands | `apps/desktop/src-tauri/src/main.rs:142-177` |
| Desktop-only cfg sites | `camera.rs:80-84`, `inference.rs:287,302`, `commands.rs:1033,1045,1056`, `paths.rs:39` |
| nokhwa backends | `camera.rs:7-9` |
| Dynamic ORT loading | `inference.rs:16-21,196-213` |
| EP chain and desktop timing | `inference.rs:3-14` |
| Model shape and precision | `config/model-manifest.json` |
| Capture constants | `camera.rs:28-31` |
| Preview transport | `apps/desktop/src/components/LivePreview.tsx:48-80`, `src/lib/ipc.ts:213-214` |
| Telemetry cadence | `commands.rs:526,654` |
| Recorder capacity | `session.rs:183` |
| Frame-based confirmation | `rep_tracker.rs:38-39,55` |
| Firestore curve cap | `telemetry.rs:273-290` |
| Outbox schema and blob | `outbox.rs:293-340,626-642` |
| Blocking sync client | `cloud_sync.rs:465-470` |
| Credential storage | `pairing.rs:117-130` |
| Desktop-only plugins | `main.rs:128-141`; updater platform table: <https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/updater/README.md> |
| Window config | `apps/desktop/src-tauri/tauri.conf.json` |
| Tauri mobile prerequisites | <https://v2.tauri.app/start/prerequisites/> |
| ORT mobile support (Android/iOS, YOLO pose tutorial) | <https://onnxruntime.ai/docs/get-started/with-mobile.html> |
| `ort` iOS static linking (`ORT_LIB_PROFILE`) | <https://ort.pyke.io/setup/linking> |
| Updater has no mobile support | updater README platform table (Android ✗, iOS ✗) |

## Appendix B — Estimate assumptions

- One senior full-stack engineer who already knows this codebase, full-time.
- Part-time design support for the responsive shell (≈5 days).
- A reference device available: mid-range Android phone (2023–2024, 8 GB RAM) and
  one Android tablet; iOS devices available in Phase 2.
- No new clinical requirements, no portal changes, no backend changes beyond a
  version-config document for minimum supported version.
- Estimates exclude App Store review latency and clinical validation time.
- Ranges are 80 % confidence intervals, not commitments.
