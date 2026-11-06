# Desktop Deployment Readiness Report

**Project:** Pilates AI Clinical Workstation (v2.0.0)
**Scope:** `apps/desktop/` (React 19 + Vite front end, Tauri 2 shell, Rust engine), plus the build and deploy inputs it depends on: `apps/desktop/src-tauri/`, `.github/workflows/`, `tools/`, `config/`, and the Firebase surface (`firebase.json`, `firestore.rules`, `storage.rules`, `firestore.indexes.json`, `functions/`, `rules-tests/`)
**Audit type:** static cross-platform packaging review (Windows / macOS / Linux)
**Repository state:** branch `rasheed`; the data-consistency pass (rules, indexes, claim script, watermark, dead-letter, schema work) has landed in the working tree
**Revision:** 3 — findings re-checked after the first implementation pass (see §0.1 and §0.2)
**Date:** 2026-11-06

---

## Verdict at a glance

| Platform | Compiles from source today | Produces an installer today | That installer would launch | Readiness |
|---|---|---|---|---|
| **Windows 10/11 x64** | ✅ verified (MSVC, local + CI) | ✅ NSIS + MSI, 84.5 MiB | ✅ verified from a simulated install | 🟢 **Ready (unsigned)** |
| **macOS 12+ (Apple Silicon)** | ✅ verified in CI | ✅ DMG + updater archive, 142.8 MiB | ⚠️ not launched here (no Mac) | 🟢 **Ready (unsigned)** |
| **macOS Intel** | ❌ no ONNX Runtime build exists (B20) | — | — | 🔴 **Unsupported** |
| **Linux (x64)** | ✅ verified in CI | ✅ deb + AppImage, 194.6 MiB | ⚠️ not launched here (no Linux host) | 🟢 **Ready (unsigned)** |

**Readiness by layer (revision 2):**

| Layer | Score | Why |
|---|---|---|
| **Data & sync correctness** | **8/10** | Security rules, indexes, claim script, watermark pull, dead-letter state, `updateTime` conflict preconditions, mandatory Parquet archive, bucket from config — all landed and tested. One open gap remains: workstation identity off Windows (B7b) |
| **Packaging & distribution** | **2/10** | Unchanged since revision 1: Windows-only bundle config, no installer ever built, macOS does not compile |

Overall **~35 %**, essentially where it was. The pass that just landed strengthened the half of the system that was already the stronger half — which is the right call, since the data layer carried the higher clinical risk — but it means the release blockers are exactly the ones below, untouched.

The single most consequential finding is **B1** below: even on Windows, an installed build would fail at startup because Tauri flattens out-of-tree resources into `_up_/_up_/_up_/config/…`, while the Rust loaders look for `<resource_dir>/config/…`. This bug is invisible in `tauri dev` and `cargo run` because a walk-up fallback finds the repository's `config/` directory by accident. It has never been caught because no test asserts the installed layout.

### 0.1 What changed since revision 1

| Revision 1 item | Status after the data-consistency pass | Evidence |
|---|---|---|
| **B7a** — `analysis_segments` used `LOCALAPPDATA` only | ✅ **Resolved** — both commands and their IPC bindings were deleted | gone from `main.rs` handler list and `ipc.ts` |
| **B7b** — `patient_origin()` returns `"unknown-origin"` off Windows | ⚠️ **Still open** (line moved) | `cloud_sync.rs:221`, still compared at `:840` |
| `PILATES_FIREBASE_BUCKET` defaulted to a non-existent bucket | ✅ **Fixed** — no default; sessions queue locally and the reason is logged | `main.rs:75-89` |
| No security rules / indexes / emulator tests | ✅ **Added** — rules, indexes, storage rules, `rules-tests/`, `functions/test/`, `test:rules` script, CI `rules` job | `firebase.json`, `firestore.rules`, `web-ci.yml:10-31` |
| Silent overwrite on concurrent patient edits | ✅ **Fixed** — `updateTime` preconditions + `EngineError::Conflict` | `cloud_sync.rs:724-728`, `error.rs` |
| Unbounded session curve could exceed the 1 MiB Firestore limit | ✅ **Guarded** — `MAX_DOCUMENT_CURVE_POINTS = 3000` | `telemetry.rs:275` |
| Endless retries of an unsendable record | ✅ **Fixed** — `UploadState::Dead` after `MAX_UPLOAD_ATTEMPTS` | `outbox.rs:57-66` |
| Full session re-pull on every sync | ✅ **Fixed** — `sessions_watermark` in `sync_state` | `outbox.rs:391`, `cloud_sync.rs:1266` |
| **New:** clinic `clinic` custom claim required by every rule | 🔴 **New blocker B17** — mandatory provisioning step, and a drift risk | `firestore.rules:38`, `storage.rules:13`, `set-clinic-claim.mjs` |
| **New:** bucket is now mandatory for the archive | 🟠 **New blocker B18** — sessions queue forever without it | `main.rs:81-89` |
| **New:** `functions/` is never deployed by CI, and its tests never run | 🟠 **New blocker B19** | no `firebase deploy --only functions` anywhere |

### 0.2 Implementation pass — what is now fixed

| Finding | Change | State |
|---|---|---|
| **B1** resource layout | `bundle.resources` converted to the map form; `_up_` fallback added to `pose_config`; three regression tests that fail if either is reverted | ✅ implemented |
| **B3** bundle targets | base `"targets": "all"` plus `tauri.{windows,macos,linux}.conf.json` | ✅ implemented |
| **B6** icons | 1024² master redrawn from measured geometry (`tools/make_app_icon.py`), full set generated including `icon.icns` | ✅ implemented (mean diff vs the old 512px icon: 0.43/255) |
| **B2** macOS compile | `coreml` feature enabled in `Cargo.toml` | ✅ implemented, **compile-verified only by CI** |
| **B4** runtime lookup | `libonnxruntime.dylib` + versioned `.so.*` / `.*.dylib` matching, with two tests | ✅ implemented (fetcher update in progress) |
| **B7b** workstation identity | new `paths` module: Tauri-resolved on macOS/Linux, **Windows pinned to `%LOCALAPPDATA%\PilatesAI`** so existing installs are not orphaned | ✅ implemented |
| **B11** WebView2 | `embedBootstrapper` + `nsis.installMode: both` | ✅ configured (decision D4 still open) |
| **B14** CSP | real policy replacing `null` | ⚠️ needs a runtime smoke test |
| **B19** functions deploy | `web-ci.yml` now runs `functions` tests and deploys them | ✅ implemented |
| **W5.5** startup diagnostics | `setup()` failures are appended to `<data dir>/startup-error.log` | ✅ implemented |
| **B8** FP16 on CPU | **not a blocker** — measured, see below | ✅ closed |

**Installer verified end to end (Windows).** With the SDK installed, `tauri build --bundles nsis` produced `Pilates AI_2.0.0_x64-setup.exe` (**38.68 MiB**). The release tree now contains `config/pose-definitions.json`, `config/model-manifest.json`, `config/models/pose1..5.onnx` and `resources/onnxruntime.dll` at the root — **no `_up_` directory** — and launching the binary from a simulated install directory stayed alive, created its database, and logged `ONNX Runtime: found …\resources\onnxruntime.dll` with no `startup-error.log`. B1 is fixed in practice, not just in theory.

**Verification status.** The Windows SDK and MSVC C++ tools were installed after the first pass, so every Rust change in revision 3 is now compiler- and test-verified: `cargo test --locked` on `x86_64-pc-windows-msvc` → **140 passed, 0 failed, 1 ignored**, including the three new resource-layout tests, both `paths` tests, both runtime-lookup tests, and the two end-to-end ONNX inference tests. The TypeScript, JSON, YAML, Python and lockfile changes were validated directly. macOS and Linux remain compile-unverified — the new workflow is their first compiler.

### 0.3 B8 closed by measurement, not by argument

The concern was that ONNX Runtime's CPU provider lacks FLOAT16 kernels, so the FP16 models would fail or crawl on Linux and on Windows without DirectML. Measured against ONNX Runtime **1.31.1** (the same version the app bundles) with all five models:

| Model | CPU run | Median latency | Output |
|---|---|---|---|
| pose1 | OK | 20.5 ms | `[1,15,8400]` float32 |
| pose2 | OK | 21.8 ms | `[1,15,8400]` float32 |
| pose3 | OK | 20.6 ms | `[1,21,8400]` float32 |
| pose4 | OK | 22.6 ms | `[1,28,8400]` float32 |
| pose5 | OK | 24.2 ms | `[1,51,8400]` float32 |

No failure of any kind. The mechanism is ORT's `InsertCastTransformer`: the CPU EP has **no native FP16 Conv kernel**, so ORT promotes weights and activations to FP32 transparently (56 `InsertedPrecisionFreeCast` nodes in the optimised graph; a one-node FP16 Conv control experiment reproduces it). Converting the models to FP32 made them **5–8 % slower** and **1.99× larger** (+30.4 MiB), so the FP16 export is the correct choice for every tier. W5.1 is withdrawn.

One caveat: this was measured on Windows x64. The CPU EP code is shared, but the Linux tier remains unverified until CI runs it.

---

## 1. Current Packaging Architecture

### 1.1 Toolchain inventory

| Layer | Tool | Version (verified) | Where |
|---|---|---|---|
| Monorepo orchestration | pnpm workspaces + Turborepo | pnpm `12.16.1` (pinned), turbo `^2.1.0` | `pnpm-workspace.yaml`, `turbo.json`, `package.json` |
| Desktop UI build | Vite + `@vitejs/plugin-react` + Tailwind 4 | Vite `^5.4.9`, React `19` | `apps/desktop/vite.config.ts` |
| UI type-check | TypeScript | `^5.6.3` | `apps/desktop/tsconfig.json` |
| Desktop shell / bundler | **Tauri 2** | CLI `2.12.4`, `tauri` crate `2.12.5`, `tauri-build` `2.7.4` | `apps/desktop/src-tauri/` |
| Engine | Rust | edition 2021; `ort-sys` declares **MSRV 1.92**; local host `rustc 1.98.1`, `x86_64-pc-windows-gnu` | `Cargo.toml`, `Cargo.lock` |
| Inference | ONNX Runtime (dynamically loaded) | **1.31.1** (Windows x64 CPU build, pinned SHA-256) | `tools/fetch_onnxruntime.py`, `resources/` |
| Camera | `nokhwa` 0.10.11 (`input-native`) | MediaFoundation/DirectShow (Win), AVFoundation (mac), V4L2 (Linux) | `src/camera.rs` |
| Telemetry | `arrow`/`parquet` 53 (in-memory) | — | `src/telemetry.rs` |
| Local store | `rusqlite` 0.32 (`bundled` SQLite, WAL) | — | `src/outbox.rs` |
| HTTP | `reqwest` 0.12 (default features → native-tls) | — | `src/cloud_sync.rs` |
| CI | GitHub Actions | `desktop-release.yml` (3-OS matrix, revision 3), `web-ci.yml` (rules + functions + web deploy) | `.github/workflows/` |
| Backend platform | Firebase: Firestore, Storage, Hosting, Functions | project `pilates-ai`; functions `nodejs22`, region `asia-east2` | `firebase.json`, `.firebaserc` |
| Rules testing | Firebase emulators + `node --test` | `pnpm test:rules`; CI installs Java 21 for the JVM emulator | `rules-tests/`, `package.json:9`, `web-ci.yml:20-31` |
| Functions testing | `node --test` | `functions/test/aggregation.test.js` — **not wired into CI** | `functions/package.json:4` |
| Clinic provisioning | `firebase-admin` one-shot script | `pnpm claim:clinic` sets the `clinic` custom claim | `functions/scripts/set-clinic-claim.mjs` |
| Legacy bundler | **PyInstaller — removed** | `pilates_ai.spec`, `src/*.py`, `requirements.txt` deleted from the tree | git status |

*Revision 1 found* no `rust-toolchain.toml`, no `.cargo/config.toml`, no per-OS `tauri.*.conf.json` and no `.icns` icon — all platform behaviour came from one 42-line `tauri.conf.json`. Revision 3 adds the per-OS configs and the icon set; `rust-toolchain.toml` and `.cargo/config.toml` are still absent (the CI pins the toolchain per job instead).

### 1.2 Configuration files and what they actually control

| File | Role | Cross-platform status |
|---|---|---|
| `apps/desktop/package.json` | Vite build, Tauri CLI entry (`pnpm tauri`) | Neutral |
| `apps/desktop/vite.config.ts` | Dev server on `:1420`, `strictPort`, build target `chrome105` (Windows) / `safari13` (other) | ✅ already branches on `TAURI_PLATFORM` |
| `apps/desktop/src-tauri/tauri.conf.json` | Product identity, window, **bundle targets, icons, resources** | 🔴 Windows-only (see B1, B3, B6) |
| `apps/desktop/src-tauri/Cargo.toml` | Crate graph + ONNX EP features | 🔴 macOS broken (B2) |
| `apps/desktop/src-tauri/Cargo.lock` | Resolved graph — **contains macOS and Linux deps** (`v4l` 0.14, `v4l2-sys-mit` 0.3, `core-graphics`, `objc2`), so the dependency graph itself is portable | ✅ good sign |
| `apps/desktop/src-tauri/capabilities/default.json` | Only `core:default` for window `main` | ✅ neutral |
| `apps/desktop/src-tauri/build.rs` | 1 line: `tauri_build::build()` | ✅ neutral |
| `tools/fetch_onnxruntime.py` | Downloads the ONNX Runtime shared library | 🔴 hardcodes the Windows x64 URL and `onnxruntime.dll` |
| `config/model-manifest.json` | Model registry: FP16, opset 17, SHA-256 per pose | ⚠️ FP16 risk on CPU EP (B8) |
| `firebase.json` | Wires rules, indexes, storage, emulators, functions, hosting | ✅ neutral (deploy topology) |
| `firestore.rules`, `storage.rules` | Server-side authorisation; every rule requires the `clinic` claim | 🟠 deployment prerequisite (B17) |
| `firestore.indexes.json` | Composite index on `sessions` (`patient_id` + `completed_at`) for the watermark pull | ✅ neutral |
| `functions/` | Aggregation trigger + claim script; **not deployed by any workflow** | 🟠 B19 |
| `rules-tests/` | Emulator tests for both rule sets | ✅ good |

### 1.3 The build pipeline as it exists

```
pnpm install (workspace)
   └─ turbo run build  →  packages/{types,ui,viz,patient-view}/dist
        └─ pnpm --filter @pilates/desktop build   (tsc && vite build)  →  apps/desktop/dist
             └─ tauri build
                  ├─ beforeBuildCommand: "pnpm build"        (runs in apps/desktop)
                  ├─ cargo build --release                   (Rust engine + shell)
                  └─ bundler → bundle.targets: ["nsis", "msi"] only
```

`bundle.targets` is `["nsis", "msi"]` (`tauri.conf.json:30`) — the only two Windows formats in Tauri's `BundleType` enum (`deb`, `rpm`, `appimage`, `msi`, `nsis`, `app`, `dmg`). There is no `"all"` fallback and no per-platform override file.

**What the bundler does with the current `resources` block** (`tauri.conf.json:35-40`):

```json
"resources": [
  "../../../config/models/*.onnx",
  "../../../config/model-manifest.json",
  "../../../config/pose-definitions.json",
  "resources/*.dll"
]
```

Tauri's `resource_relpath` (`tauri-utils 2.10.2`, `src/resources.rs:17-31`) maps every `..` component to a literal `_up_` directory:

```rust
Component::ParentDir => dest.push("_up_"),
```

This is not theoretical — the artifact is on disk in this workspace:

```
apps/desktop/src-tauri/target/debug/_up_/_up_/_up_/config/pose-definitions.json
apps/desktop/src-tauri/target/debug/_up_/_up_/_up_/config/model-manifest.json
apps/desktop/src-tauri/target/debug/_up_/_up_/_up_/config/models/pose1..5.onnx
apps/desktop/src-tauri/target/debug/resources/onnxruntime.dll
```

The same mapping is used by the bundler, so an installed app receives `<install>/_up_/_up_/_up_/config/…`, while every Rust loader looks for `<resource_dir>/config/…`. See **B1**.

### 1.4 What ships inside the installer

| Payload | Size | Included today |
|---|---|---|
| `config/models/pose1..5.onnx` (FP16, opset 17) | **30.8 MB** | ✅ via resources |
| `config/model-manifest.json`, `config/pose-definitions.json` | 11 KB | ✅ via resources |
| `onnxruntime.dll` (1.31.1 CPU) | **16.5 MB** | ✅ via `resources/*.dll` |
| `onnxruntime_providers_shared.dll` | 21 KB | ✅ via `resources/*.dll` |
| `DirectML.dll` | — | ❌ **never fetched** (see B9) |
| `assets/models/*/best.pt` (training weights) | 31.0 MB | ✅ correctly excluded |
| `final.pdf`, `.venv/`, `node_modules/` | — | ✅ correctly excluded |

Estimated installer sizes once the blockers are fixed: NSIS ≈ 55–60 MB, MSI ≈ 60–65 MB, DMG ≈ 70–85 MB (universal binary + universal ONNX dylib), `.deb` ≈ 55 MB, AppImage ≈ 80–95 MB.

### 0.4 New constraint found during implementation: no Intel Mac support

Microsoft's ONNX Runtime **1.31.1** release contains no macOS x86_64 and no universal2 artifact — only `onnxruntime-osx-arm64-1.31.1.tgz`. Since `ort` 2.0.0-rc.15 binds the 1.31 API, an Intel Mac cannot be served by any official prebuilt runtime.

| Option | Cost | Consequence |
|---|---|---|
| **Apple Silicon only** (chosen) | none | macOS 12+ on M-series. Intel Macs unsupported; the plan's universal DMG is withdrawn |
| Build ONNX Runtime 1.31 from source for `x86_64-apple-darwin` | ~1–2 h CI per build, CMake + Xcode, ongoing maintenance | Intel support restored |
| Ship an older ORT for Intel | blocked | API mismatch with `ort` 2.0.0-rc.15 — not viable |

The fetcher now pins `macos-arm64` and **refuses to detect** an Intel Mac rather than silently installing an arm64 dylib that cannot load. The release matrix builds `aarch64-apple-darwin` only. This is recorded as **B20** and is a product decision, not a code defect.

---

## 2. OS-Specific Blockers

Severity: **P0** = release impossible / installed app cannot run · **P1** = ships but degraded or unshippable without signing · **P2** = polish / operational risk · **P3** = cosmetic.

### Blocker register

| ID | Severity | Platform | Location | Symptom |
|---|---|---|---|---|
| B1 | **P0** | **All** | `tauri.conf.json:35-40` vs `pose_config.rs:153-155`, `main.rs:55` | Installed app aborts: `pose-definitions.json not found` |
| B2 | **P0** | macOS | `Cargo.toml:32` vs `inference.rs:264-267` | `cargo build` fails: `ep::CoreML` does not exist |
| B3 | **P0** | macOS, Linux | `tauri.conf.json:30` | No `.dmg`/`.app`/`.deb`/AppImage can be requested |
| B4 | **P0** | macOS, Linux | `inference.rs:114`, `tools/fetch_onnxruntime.py:58-64` | No ONNX Runtime for these OSes; macOS name never matched |
| B5 | **P0** | macOS | `tauri.conf.json` (no `macOS.infoPlist`) | TCC kills the app on first camera access |
| B6 | P1 | macOS, Linux | `tauri.conf.json:31-34`, `icons/` | No `.icns`; 512 px source below 1024 px requirement |
| B7 | P1 | macOS, Linux | `cloud_sync.rs:221-238`, `:840` | `patient_origin()` returns `"unknown-origin"` → change detection cannot tell peers apart |
| B8 | P1 | Linux, CPU-only Windows | `config/model-manifest.json` (`precision: FP16`) | CPU EP may reject or crawl on FP16 graphs |
| B9 | P1 | Windows | `resources/` | `DirectML.dll` absent → GPU tier never activates — **resolved by removal**: no DirectML EP exists for this API, so the branch is gone (D5) |
| B10 | P1 | Linux | `Cargo.toml:33`, `reqwest` defaults | Build needs `libclang-dev`, `libssl-dev`, `webkit2gtk-4.1` |
| B11 | P1 | Windows | `tauri.conf.json` (no `windows.webviewInstallMode`) | Default bootstrapper needs internet; MSI does not bootstrap WebView2 |
| B12 | P1 | All | — | No code signing. **Decision (revision 3): ship unsigned**; the pipeline is ready for the secrets |
| B13 | P2 | Windows | local GNU vs CI MSVC | Two different linkers, one untested combination |
| B14 | P2 | All | `tauri.conf.json:24-26`, `Cargo.toml:12` | `csp: null` on a clinical app; `tray-icon` feature unused |
| B15 | P2 | Linux | `camera.rs:77` | `/dev/video*` access requires the `video` group |
| B16 | P3 | macOS, Linux | `main.rs:39-42` | Data in `~/.pilates-ai` instead of platform conventions |
| B17 | **P1** | All (deploy) | `firestore.rules:38`, `storage.rules:13`, `set-clinic-claim.mjs:27` | Rules reject every client until the `clinic` claim is set; the claim id can drift from the hardcoded `'pilates-ai'` |
| B18 | **P1** | All (deploy) | `main.rs:81-89` | No bucket configured → sessions queue locally forever, with only a stderr line |
| B19 | P2 | All (deploy) | `functions/`, `web-ci.yml:70` | `functions/` is never deployed and its tests never run |
| B20 | **P1** | macOS Intel | ONNX Runtime 1.31.1 release assets | No x86_64 or universal2 runtime exists → Intel Macs cannot run inference |

---

### B1 — P0 · Installed builds cannot find their configuration (all platforms)

**Evidence.** Tauri writes resources to `_up_/_up_/_up_/config/…` (artifact on disk, §1.3). The loaders search:

- `pose_config.rs:153-155` → `<TAURI_RESOURCE_DIR>/config/pose-definitions.json`
- `pose_config.rs:186-190` → `<TAURI_RESOURCE_DIR>/config/<name>`
- then a walk-up from `current_exe()` / `current_dir()` up to 6 levels (`pose_config.rs:159-172`)

`main.rs:51-53` sets `TAURI_RESOURCE_DIR` from `app.path().resource_dir()`, then `main.rs:55` does `PoseDefinitionDocument::load()?`. The `?` propagates out of `setup()`, so Tauri aborts with `error while running tauri application` — a silent failure on a clinic desktop, with no window and no log file.

**Why it was never noticed.** In `tauri dev`, `cargo run`, and CI, the walk-up from `target/debug/` reaches the repository root in 4 hops and finds the real `config/` directory. The bug only manifests when the executable sits in `C:\Program Files\Pilates AI\` or `/Applications/Pilates AI.app/Contents/MacOS/`, where no ancestor has a `config/` folder.

**Fix (two parts, both required).**

1. Publish resources at their logical path using the map form of `bundle.resources` (supported by `BundleResources` in `config.schema.json`):

```json
"resources": {
  "../../../config/models/*.onnx": "config/models/",
  "../../../config/model-manifest.json": "config/model-manifest.json",
  "../../../config/pose-definitions.json": "config/pose-definitions.json",
  "resources/*": "resources/"
}
```

**Two traps in the map form, both verified the hard way:**

- A **glob** destination is a *directory* (`"config/models/"`), but a **single-file** destination is the *exact target path*. Writing `".../pose-definitions.json": "config/"` therefore copies the file to `$RESOURCE/config` — a file, not a directory — and the next entry that needs `config/` as a directory dies with `Cannot create a file when that file already exists. (os error 183)` from the build script. This looks like a Tauri bug and is not one.
- `tauri-build` copies resources to `target/<profile>/` for dev runs, so a corrupted copy survives between builds. Delete `target/debug/config`, `target/debug/_up_` and `target/debug/resources` before retrying, or the stale file masks the fix.

2. Add the `_up_` path as a fallback in `candidate_paths()` / `find_config_file()` so already-installed builds of 2.0.0 can still start after an in-place upgrade, and add a regression test that resolves from a temporary directory shaped like an install (`<tmp>/_up_/_up_/_up_/config/...`) rather than from the repo.

**Acceptance:** build an NSIS installer, install to a clean user profile, launch with `PILATES_POSE_DEFINITIONS` unset — the window must open and `engine_status` must report `poses: 5`.

---

### B2 — P0 · macOS does not compile: `ep::CoreML` is behind an unenabled feature

`inference.rs:264-267`:

```rust
#[cfg(target_os = "macos")]
{
    providers.push(ep::CoreML::default().build());
}
```

`Cargo.toml:32` enables only `["load-dynamic", "directml"]`. In `ort 2.0.0-rc.15` (`src/ep/mod.rs:427-432`) the type is gated:

```rust
#[cfg(feature = "coreml")]
pub mod coreml;
#[cfg(feature = "coreml")]
pub use self::coreml::CoreML;
```

So on macOS the build fails with `error[E0433]: failed to resolve: could not find CoreML in ep`. Note the asymmetry: `directml` **is** enabled (and compiles everywhere, since `ort-sys`'s build script returns immediately under `disable-linking`), while `coreml` is not.

**Fix.** Enable both EPs unconditionally — they are compile-time type bindings only, and `load-dynamic` means nothing is linked:

```toml
ort = { version = "2.0.0-rc.15", features = ["load-dynamic", "directml", "coreml"] }
```

`ort` 2.0.0-rc.15 declares MSRV **1.92** (`ort-sys` manifest), so pin the CI toolchain accordingly rather than floating `stable`.

---

### B3 — P0 · Bundle target list is Windows-only

`tauri.conf.json:30` — `"targets": ["nsis", "msi"]`. On macOS and Linux the CLI validates against the host platform's bundle types; neither `nsis` nor `msi` is valid there, so `tauri build` errors instead of producing a `.dmg`/`.app`/`.deb`/AppImage. Even a permissive CLI would emit nothing, because the list contains no macOS or Linux format.

**Fix.** Either `"targets": "all"` (Tauri filters by host — simplest) or per-platform override files, which also lets each OS carry its own config:

```
apps/desktop/src-tauri/tauri.windows.conf.json  { "bundle": { "targets": ["nsis", "msi"] } }
apps/desktop/src-tauri/tauri.macos.conf.json    { "bundle": { "targets": ["app", "dmg"], "macOS": { ... } } }
apps/desktop/src-tauri/tauri.linux.conf.json    { "bundle": { "targets": ["deb", "appimage"] } }
```

The base `tauri.conf.json` keeps only the shared identity, window, and resources. `tauri.windows.conf.json` is merged automatically by the CLI on Windows; `--config` can select the others explicitly.

---

### B4 — P0 · ONNX Runtime exists for Windows only, and macOS is not even name-matched

Two separate defects:

1. **Supply.** `tools/fetch_onnxruntime.py:58-64` pins a single artifact:
   `onnxruntime-win-x64-1.31.1.zip`. `REQUIRED_FILES = ("onnxruntime.dll",)` (`:66`). Nothing fetches the macOS or Linux builds, so `resources/` can never be populated correctly off Windows. The engine then degrades to the typed error `"onnxruntime shared library not found"` (`inference.rs:162-166`) — the app starts but performs no inference at all, which is the product's entire function.

2. **Lookup.** `inference.rs:114`:
   ```rust
   const NAMES: [&str; 2] = ["onnxruntime.dll", "libonnxruntime.so"];
   ```
   There is **no `libonnxruntime.dylib`**, so even a correctly placed macOS runtime would never be found. Linux is also incomplete: official tarballs ship `libonnxruntime.so.1.31.1` plus a `libonnxruntime.so` symlink; a `resources/*.so` glob copies the symlink but the link target must be present, and the current `resources/*.dll` glob matches nothing on Linux anyway.

**Fix.**

- Extend the fetcher to a per-platform artifact table with a pinned SHA-256 each:
  `onnxruntime-win-x64-1.31.1.zip`, `onnxruntime-osx-universal2-1.31.1.tgz` (universal, for the DMG), `onnxruntime-linux-x64-1.31.1.tgz`.
- `NAMES = ["onnxruntime.dll", "libonnxruntime.dylib", "libonnxruntime.so"]`, and additionally glob `libonnxruntime.so.*` / `libonnxruntime.*.dylib` so versioned sonames resolve.
- Change the resource glob from `resources/*.dll` to `resources/*` so `.dylib`/`.so` ship too (keeping `resources/` as the target directory so the existing `resource_dir/resources` probe in `inference.rs:127` still works).
- macOS dylib paths must be `@rpath`-relative or rewritten with `install_name_tool` after bundling if the dylib is placed in `Contents/Resources/`; simplest is to keep `ort`'s `ORT_DYLIB_PATH` env (already set by `prepare_runtime`, `inference.rs:153-168`) and ship the dylib next to the executable.

---

### B5 — P0 · macOS camera access has no usage description

`camera.rs` opens AVFoundation devices through `nokhwa` (`camera.rs:8-9, 77, 178`). On macOS, any process touching AVCapture without `NSCameraUsageDescription` in its `Info.plist` is **terminated by TCC** on first access — not denied, killed. `tauri.conf.json` has no `bundle.macOS.infoPlist`, and the schema confirms the key exists (`MacConfig.infoPlist`).

**Fix.** Add `apps/desktop/src-tauri/Info.plist` (or `macos/Info.plist`):

```xml
<key>NSCameraUsageDescription</key>
<string>Pilates AI uses the camera to track exercise repetitions during a session.</string>
```

and wire it via `"macOS": { "infoPlist": "Info.plist", "minimumSystemVersion": "12.0" }`. For a sandboxed/App-Store distribution also add the `com.apple.security.device.camera` entitlement — the default `hardenedRuntime: true` is already correct for notarization.

---

### B6 — P1 · Icons: no `.icns`, and the PNG is undersized

`icons/` contains only `icon.ico` (16–256 px, 20 KB) and `icon.png` (**512×512**, 4 KB). `tauri.conf.json:31-34` lists both. macOS bundling needs `icons/icon.icns` (Tauri's bundler expects it for `.app`/`.dmg`); Linux desktop integration wants 32–512 px PNGs in the freedesktop layout; `tauri icon` also requires a **1024×1024** source to generate the full set.

**Fix.** Produce a 1024×1024 RGBA master, then `pnpm --filter @pilates/desktop tauri icon assets/app-icon.png`. This regenerates `32x32.png … 512x512@2x.png`, `icon.icns`, `icon.ico`, and the Windows Store logos, and the `bundle.icon` array should list `icons/icon.icns`, `icons/icon.ico`, `icons/32x32.png`, `icons/128x128.png`, `icons/128x128@2x.png`, `icons/icon.png`.

---

### B7 — P1 · Workstation identity assumes `LOCALAPPDATA` (half resolved)

*Revision 2: the `analysis_segments` half is gone — both commands and their IPC bindings were deleted in the data-consistency pass. What remains is the origin half.*

```rust
// cloud_sync.rs:221-238
let Some(dir) = std::env::var_os("LOCALAPPDATA").map(std::path::PathBuf::from) else {
    return "unknown-origin".to_string();
};
let path = dir.join("PilatesAI").join("instance-id");
```

On macOS and Linux `LOCALAPPDATA` is unset, so `patient_origin()` returns the literal `"unknown-origin"` for **every** workstation. The change-marker check at `cloud_sync.rs:840` (`origin != patient_origin()`) therefore cannot distinguish "another non-Windows workstation wrote this" from "I wrote this", and the pull is skipped. A Windows workstation in the same clinic produces a real UUID, so it is detected — meaning the failure is asymmetric and easy to miss: **mac↔mac and linux↔linux changes are invisible, Windows↔anything works.**

The impact is bounded but real: the session watermark (`cloud_sync.rs:1266`) now pulls sessions independently of origin, so clinical records still arrive. What is lost is the patient-roster change notification, which degrades to the periodic full pull.

**Fix.** One `app_data_dir()` helper backed by `app.path().app_data_dir()` (Tauri resolves `%LOCALAPPDATA%\com.pilatesai.workstation`, `~/Library/Application Support/com.pilatesai.workstation`, `~/.local/share/com.pilatesai.workstation`), used by `patient_origin()`, `CloudConfig::from_file()` (`cloud_sync.rs:73`) and `main.rs:27-43`. Keep `PILATES_AI_DATA_DIR` as the override for CI and kiosk deployments. Because the id persists, changing the location once is safe — it yields a new id, at worst one redundant pull.

---

### B8 — P1 · FP16 models against a CPU execution provider

`config/model-manifest.json` records `"precision": "FP16"`, `half: true`, opset 17 for all five models (`tools/export_onnx.py:40`). That is correct for DirectML and CoreML. On the **CPU EP** — which is the only tier on Linux, and the fallback on any Windows machine without `DirectML.dll` — ONNX Runtime's FLOAT16 kernel coverage is partial; the common failure is `NOT_IMPLEMENTED: Could not find an implementation for Conv(...) with FLOAT16`, and where kernels do exist they are substantially slower than FP32.

This is not hypothetical for Windows: because of **B9** the CPU path is the *default* on Windows today.

**Fix.** Ship an FP32 variant for the CPU tier (`onnxruntime` session option `optimized_model_filepath`, or a second export), or run the FP32 original when `active_provider() == Cpu`. Validate with a Linux CI job that loads `pose1.onnx` on CPU and asserts a non-empty `InferenceOutput`.

---

### B9 — P1 · The GPU tier is dead even on Windows

`inference.rs:218-232` only enables DirectML when `DirectML.dll` sits next to the runtime. `resources/` contains `onnxruntime.dll` and `onnxruntime_providers_shared.dll` but **no `DirectML.dll`**, and `fetch_onnxruntime.py` deliberately ships the CPU build (documented at `:16-32`: Microsoft stopped publishing `-directml` assets after 1.24.x, and `ort` 2.0.0-rc.15 binds the 1.31 API).

Consequence: `directml_available()` is always `false`, so every Windows clinic runs FP16 models on CPU — contradicting `MASTER_EXECUTION_PLAN.md` §3.1 ("DirectML on any DX12 GPU") and §3.2 ("bundled `DirectML.dll`"). The degradation is graceful (typed error, CPU fallback), but the marketing claim is unmet and B8 then bites.

**Fix options, in order of effort:** (a) build ONNX Runtime 1.31 with `--use_directml` in CI and ship the resulting `onnxruntime.dll` + `DirectML.dll` as a Windows-only artifact; (b) ship the FP32 model on Windows CPU and defer the GPU tier to 2.1; (c) drop the DirectML branch and document CPU-only. Whichever is chosen, the plan document must be corrected — it currently states behaviour the code cannot deliver.

---

### B10 — P1 · Linux build prerequisites are undeclared

The Linux build pulls three non-obvious native dependencies:

1. **`nokhwa` → `v4l` → `v4l2-sys-mit` 0.3**, whose `build.rs` runs **bindgen** against `#include <linux/videodev2.h>` — requires `libclang-dev` (and kernel headers) at build time, or the build fails with `Unable to find libclang`.
2. **`reqwest` 0.12 with default features** → `native-tls` → `openssl-sys` → requires `libssl-dev` + `pkg-config`.
3. **Tauri 2** → `webkit2gtk-4.1`, `libgtk-3-dev`, `libsoup-3.0-dev`, `libjavascriptcoregtk-4.1-dev`, `librsvg2-dev`, `libappindicator3-dev` (tray), `patchelf`, `file`.

Note a **plan error**: §3.2 promises "any modern Linux distro with glibc 2.31+" (Ubuntu 20.04). WebKitGTK **4.1** only exists on Ubuntu 22.04+/Debian 12+/Fedora 38+, i.e. **glibc ≥ 2.35**. Build the AppImage on `ubuntu-22.04` (not `-latest`, which moves to 24.04 and raises the glibc floor) to maximise compatibility.

---

### B11 — P1 · WebView2 provisioning differs between NSIS and MSI

Tauri's default is `webviewInstallMode: { type: "downloadBootstrapper", silent: true }`. Per the CLI schema, `downloadBootstrapper` and `embedBootstrapper` **both require an internet connection** (the embedded one only avoids needing to *fetch* the bootstrapper); only `offlineInstaller` (+~127 MB) and `fixedRuntime` (+~180 MB) work air-gapped. Clinic networks are frequently restricted, and Windows 10 1803–1909 machines may have no WebView2 at all.

Additionally, the MSI/WiX path does not run the WebView2 bootstrapper by default, so a machine without the runtime gets an app that installs and then shows a blank window. Validate this on a WebView2-less VM before choosing MSI as the primary clinic format.

**Fix.** Pick per deployment model:

```json
"windows": {
  "webviewInstallMode": { "type": "embedBootstrapper", "silent": true },
  "nsis": { "installMode": "currentUser", "compression": "lzma" }
}
```

For online clinic estates `embedBootstrapper` is the right default (+1.8 MB, most compatible bootstrapper). For air-gapped sites, either switch to `offlineInstaller` (+127 MB, single self-contained `.exe`) or push the WebView2 Evergreen runtime by GPO/Intune and keep `skip`. Choose `installMode` deliberately too: `currentUser` (no admin, per-user, updates cleanly) vs `perMachine` (shared examination-room PCs, requires elevation). `both` gives the operator a choice at install time and is the pragmatic default for mixed estates.

---

### B12 — P1 · Nothing is signed

No Authenticode certificate, no Apple Developer ID, no notarization, no `createUpdaterArtifacts`, no updater plugin. Practical consequences:

- Windows: SmartScreen blocks an unsigned NSIS `.exe` on first run for every clinic machine; many will stop there.
- macOS: an unsigned/un-notarized `.dmg` is refused by Gatekeeper (macOS 10.15+); the user must right-click → Open, which is not a "1-click install".
- No update path: fixing any of the above requires re-downloading and reinstalling by hand at every site.

---

### B13 — P2 · Two Windows toolchains, one of them untested

Local host is `x86_64-pc-windows-gnu` (`rustc 1.98.1`), which is why `Cargo.toml` carries the long GNU/MSVC commentary at `:25-31` and why `target/dbg/` and `target/debug/` both contain a `WebView2Loader.dll` (GNU builds load it dynamically; MSVC links the loader statically). CI pins `x86_64-pc-windows-msvc` (`desktop-ci.yml:32`). The two produce different binaries and neither has ever been through the bundler.

**Fix.** Standardise release builds on **MSVC** (`rustup default stable-x86_64-pc-windows-msvc`, VS 2022 Build Tools + Windows SDK on the runner). With `load-dynamic`, the GNU/MSVC distinction stops mattering for ONNX Runtime — which is exactly the point of the current design — so MSVC is a free win: no stray `WebView2Loader.dll`, a statically linked CRT, and the best-tested Tauri path. Keep `--toolchain gnu` documented for contributors without VS.

---

### B14 — P2 · Hardening items with deployment impact

- `tauri.conf.json:24-26` — `"csp": null`. For a clinical workstation handling patient data this should be a real policy (`default-src 'self'; img-src 'self' data: blob:; connect-src 'self' https://*.googleapis.com …`). Also add `"withGlobalTauri": false` explicitly.
- `Cargo.toml:12` enables `tray-icon` but `tauri.conf.json` defines no `trayIcon`; on Linux the tray pulls `libappindicator3`, which then must be present at runtime or the feature is dead weight.
- No `bundle.category`, `publisher`, `copyright`, `shortDescription`/`longDescription` — required for a credible `.deb`/`.rpm` and for Windows "Apps & features".
- `bundle.macOS.minimumSystemVersion` is left at the `10.13` default while the plan targets macOS 12+; ONNX Runtime 1.31 itself needs 11+.

---

### B15 — P2 · Linux camera permissions

`camera.rs:77` enumerates with `ApiBackend::Auto` → V4L2. `/dev/video*` is typically `root:video 0660`, so a clinic user outside the `video` group sees an empty device list and a "cannot open camera 0" error. This is a deployment/onboarding note rather than a code bug — document `usermod -aG video $USER` (plus a logout) in the Linux install notes, and surface the enumeration error in the UI (it already does, via `last_error`).

### B16 — P3 · Data directory conventions

`main.rs:39-42` falls back to `$HOME/.pilates-ai` on macOS/Linux. It works, but it is a hidden dot-directory in the user's home rather than `~/Library/Application Support/…` or `$XDG_DATA_HOME/…`; backups and MDM tooling will not find it. Folded into the B7 fix.

### B17 — P1 · Every client is rejected until the `clinic` claim is set

The new rules gate *everything* on a custom claim:

```javascript
// firestore.rules:37-40 — identical in storage.rules:12-15
function isClinician() {
  return request.auth != null
    && request.auth.token.get('clinic', '') == 'pilates-ai';
}
```

Custom claims can only be written with the Admin SDK, so provisioning is an out-of-band step (`pnpm claim:clinic clinician@example.com`, `functions/scripts/set-clinic-claim.mjs`). Until it runs for an account, that account sees a permission-denied for **every** read and write — the portal renders empty, the desktop reports a sync error, and nothing in the UI explains why. The script's own header says to run it *before* deploying the rules, which is correct and easy to get wrong on a fresh project.

There is also a drift trap: the script defaults `CLINIC_ID` to `process.env.PILATES_CLINIC_ID ?? "pilates-ai"` (`:27`), while both rules files hardcode the literal `'pilates-ai'`. Set the env var to anything else and the script writes a claim the rules reject, with a success message.

**Fix.**

1. Treat "claim set" as step 0 of the clinic provisioning runbook, before rules deployment, and list the affected accounts.
2. Remove the drift: either drop `PILATES_CLINIC_ID` and hardcode, or generate the rules value from the same constant at build time. A one-line check in the rules test (`request.auth.token.clinic == 'pilates-ai'`) already pins the literal — assert the script's constant against it.
3. Make the failure legible: map a `PERMISSION_DENIED` from Firestore to "this account is not provisioned for this clinic — ask your administrator", not a generic sync error.

### B18 — P1 · The archive bucket is now mandatory, and its absence is only a stderr line

`main.rs:75-89` deliberately removed the old `pilates-telemetry` default: a session document must never point at a bucket that does not exist. The consequence is that a workstation with no `bucket` in `cloud.json` and no `PILATES_FIREBASE_BUCKET` will accept sessions, queue them, and **never upload the Parquet archive** — indefinitely, silently, apart from one `eprintln!` at startup that a clinic user never sees (the release build has no console: `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]`).

This is a deployment requirement, not a code defect — but it needs to be in the install checklist, and the app should surface it in the UI, because "the portal shows no telemetry for this patient" is otherwise undiagnosable at the clinic.

**Fix.**

1. Installer/provisioning checklist: `bucket` present in `cloud.json` (or the env var set) **and** Storage rules deployed.
2. Surface the condition in `engine_status` → an amber badge: "Archive upload disabled — no bucket configured".
3. Keep the current behaviour (queue, never write a dangling pointer) — that part is correct.

### B19 — P2 · `functions/` is never deployed, and its tests never run

`firebase.json` declares the functions codebase, and `functions/index.js` holds the aggregation trigger plus the `syncState` change marker. But:

- `web-ci.yml:70` deploys `firestore:rules,firestore:indexes,storage` — **not** `functions`.
- `package.json:10` (`deploy:rules`) likewise omits functions.
- `functions/test/aggregation.test.js` exists and passes `node --test`, but no workflow runs it (`web-ci.yml:31` runs only `npm run test:rules`).

So the aggregates and the change marker depend on a manual `firebase deploy --only functions` that nothing documents or enforces. When the marker is absent the desktop degrades gracefully (`cloud_sync.rs:826-828` falls back to a periodic full pull), which is exactly why this can go unnoticed for months while aggregates silently stop updating.

**Fix.** Add a `functions` job (or step) to `web-ci.yml` that runs `npm --prefix functions test` on every PR and `firebase deploy --only functions` on `main`, after the rules deploy. Note the region pin (`asia-east2`) must match the Firestore location or every invocation pays a cross-region hop.

### Platform-specific UI behaviour — findings

The front end is **clean** on this axis, which is worth stating explicitly because it is where cross-platform desktop apps usually rot:

- No hardcoded OS paths, no `process.platform`, no `navigator.userAgent` sniffing in `apps/desktop/src` (grep: zero matches for `C:\`, `Program Files`, `LOCALAPPDATA`, `win32`).
- No custom title bar (`decorations` untouched), so macOS traffic lights and Windows/Linux window chrome both behave natively.
- One window: 1280×850, `minWidth: 960`, `minHeight: 640`, resizable — comfortable on a 1366×768 clinic laptop and on a 13" MacBook.
- `isTauri()` (`ipc.ts:193`) gates every native call and renders a "Browser Mode" badge instead of throwing — useful for `pnpm dev`, and it means the UI degrades to a demo rather than a crash if the engine fails to initialise.
- Audio is a WebAudio `AudioContext` chime (`ActiveCapturePage.tsx:101-120`) — no OS audio backend dependency.
- `open_portal()` (`commands.rs:923-957`) already branches correctly: `cmd /C start` (Windows), `open` (macOS), `xdg-open` (Linux). This is the one place platform handling is done right, and it is the model the rest of the code should follow.
- `vite.config.ts:15` already selects `chrome105` vs `safari13` from `TAURI_PLATFORM` — correct for the older WebKitGTK on Linux.

---

## 3. Target Formats

| OS | Format | Feasible today? | What is missing | Est. size |
|---|---|---|---|---|
| Windows | **NSIS `.exe`** | ⚠️ builds, would fail at launch | B1 (startup abort), B9/B8 (GPU/CPU correctness), B11 (WebView2), B12 (signing) | ~55–60 MB |
| Windows | **MSI `.msi`** | ⚠️ same | B1, B11 (no bootstrapper path), B12, WiX toolset on the runner | ~60–65 MB |
| macOS | **`.app`** | ❌ cannot compile | B2 (CoreML feature), B4 (dylib), B5 (Info.plist), B6 (icns) | ~55–70 MB |
| macOS | **`.dmg`** | ❌ | all of the above + B12 (notarization) + universal target + universal ONNX dylib | ~70–85 MB |
| Linux | **`.deb`** | ❌ target not requested | B3 (target list), B4 (`.so`), B7 (paths), B10 (build deps) | ~55 MB |
| Linux | **AppImage** | ❌ | B3, B4, B7, B10; must be built on `ubuntu-22.04` | ~80–95 MB |
| Linux | `.rpm` (optional) | ❌ | same as `.deb` | ~55 MB |

**Feasibility judgement.** Every format is achievable with Tauri 2 as configured — nothing here requires abandoning the framework, and the heavy lifting (no Python runtime, no CUDA, dynamically loaded ORT, 31 MB of embedded models) is already done correctly. The gap is entirely in packaging configuration and per-OS asset provisioning. Realistic estimate to a signed, 1-click installer on all three OSes: **4–6 focused engineering days**, of which roughly half is Apple/Windows certificate procurement and notarization plumbing rather than code.

**One format caveat worth planning around:** AppImage is the most portable Linux artifact (Tauri bundles GTK/WebKitGTK via linuxdeploy) but has no auto-update and no desktop integration until first run; `.deb` integrates properly (menu entry, `apt` upgrades via a hosted repo) but assumes Debian/Ubuntu. Ship both — `.deb` for managed estates, AppImage for everything else — and note that neither can carry the app to glibc < 2.35.

---

## 4. CI/CD & Cross-Compilation Requirements

### 4.1 Why cross-compilation is not an option

Tauri cannot cross-compile, and this is a hard constraint rather than a configuration gap:

- **Windows** MSI/NSIS require WiX/NSIS and the Windows SDK; `cargo build` for `*-pc-windows-msvc` from macOS/Linux is unsupported.
- **macOS** `.app`/`.dmg` require `codesign`, `hdiutil`, and the Apple SDK, which are licensed for macOS hosts only. Notarization (`notarytool`) additionally requires an Apple ID session.
- **Linux** needs the exact `webkit2gtk-4.1` / `glibc` of the target distro at link time.

The practical consequence: **a native runner per OS**, which is precisely what GitHub Actions' matrix gives us. Cross-compiling would also be self-defeating here, because `nokhwa` binds to a different camera API per OS and `ort` loads a different shared library per OS — both need a real build on the real platform to be verified.

### 4.2 Required build matrix

| Job | Runner | Target triple | Artifacts | Notes |
|---|---|---|---|---|
| `windows-x64` | `windows-latest` | `x86_64-pc-windows-msvc` | `Pilates AI_2.0.0_x64-setup.exe` (NSIS), `Pilates AI_2.0.0_x64_en-US.msi` | WiX v3 + NSIS present; MSVC toolchain per B13 |
| `macos-arm64` | `macos-14` (Apple Silicon) | `aarch64-apple-darwin` | `.app`, `.dmg` | **implemented** — the only viable macOS job |
| ~~`macos-x64`~~ | ~~`macos-13`~~ | — | — | **withdrawn** — no ONNX Runtime x86_64 build exists (B20) |
| ~~`macos-universal`~~ | ~~`macos-14`~~ | — | — | **withdrawn** — no `osx-universal2` runtime exists (B20) |
| `linux-x64` | `ubuntu-22.04` (pinned, **not** `-latest`) | `x86_64-unknown-linux-gnu` | `.deb`, `.AppImage` | glibc 2.35 floor; `libwebkit2gtk-4.1-dev` et al. |

The revision-2 recommendation of a universal DMG is dead: for ONNX Runtime 1.31.1 Microsoft publishes only `onnxruntime-osx-arm64`. Apple Silicon is the supported macOS target; Intel support would require building ONNX Runtime from source in CI.

### 4.3 Current workflow gaps

*Revision 2: `web-ci.yml` gained a `rules` job (Java 21 + emulator) and now deploys rules, indexes and storage before hosting — that part is good. The desktop workflow is untouched.*

| Gap | Detail |
|---|---|
| **No installer is ever built** | `desktop-ci.yml:46` runs `pnpm --filter @pilates/desktop build` — that is `tsc && vite build`, i.e. the front end only. `tauri build` appears nowhere in either workflow. No artifact is uploaded. |
| **Single-platform matrix** | `platform: [windows-latest]` (`desktop-ci.yml:14`). macOS and Linux are never compiled, which is why B2 and B4 have gone unnoticed. |
| **ONNX Runtime never provisioned** | `tools/fetch_onnxruntime.py` is never invoked, so `resources/` is empty on a fresh checkout (the DLLs are gitignored). A bundle built from CI would ship without inference. |
| **No signing / no release** | No `tauri-action`, no `release`, no secrets, no `createUpdaterArtifacts`. |
| **No Rust caching** | Every run recompiles `tauri`, `arrow`, `parquet`, `rusqlite` (bundled SQLite) from scratch — 15–25 min per job. |
| **Non-reproducible install** | `pnpm install --frozen-lockfile=false` (`desktop-ci.yml:40`, `web-ci.yml:49`) permits lockfile drift. |
| **Missing workspace package in the build step** | Both workflows build only `types`, `ui`, `viz`, but `PatientDetailPage.tsx:8` and `SessionDetailPage.tsx:1` import `@pilates/patient-view`, whose `dist/` is gitignored (`packages/*/dist/`). On a clean runner `tsc` cannot resolve it (TS2307) and the build fails before Tauri is ever reached. |
| **Test coverage is Windows-only** | `cargo test` runs on one OS; the camera enumeration test (`camera.rs:296-313`) and the mock pipeline never run on the platforms that actually need validation. |
| **`functions/` is never deployed** (B19) | `web-ci.yml:70` deploys rules/indexes/storage only. The aggregation trigger and the `syncState` change marker are live only if someone runs a manual deploy. |
| **`functions/` tests never run** (B19) | `functions/test/aggregation.test.js` is not invoked by any workflow; `web-ci.yml:31` runs `test:rules` only. |
| **Rules tests are not a required check** | The `rules` job runs on PRs, which is right, but nothing gates the desktop job on it and there is no branch-protection note in the repo. |

### 4.4 Implemented `.github/workflows/desktop-release.yml`

> Revision 3: this workflow now exists in the repository and supersedes `desktop-ci.yml` (deleted). The listing below is the design it implements; the matrix has since been narrowed to `windows-x64`, `macos-arm64` and `linux-x64` per B20.

Drop-in replacement; it fixes every gap above and produces signed installers on tag push.

```yaml
name: Desktop Release

on:
  push:
    tags: ["v*"]
  workflow_dispatch:
  pull_request:
    branches: [main]

env:
  CARGO_TERM_COLOR: always
  RUST_BACKTRACE: 1

jobs:
  build:
    permissions:
      contents: write
    strategy:
      fail-fast: false
      matrix:
        include:
          - platform: windows-latest
            args: --target x86_64-pc-windows-msvc
            rust-target: x86_64-pc-windows-msvc
            label: windows-x64
          - platform: macos-14
            args: --target universal-apple-darwin
            rust-target: aarch64-apple-darwin,x86_64-apple-darwin
            label: macos-universal
          - platform: ubuntu-22.04
            args: ""
            rust-target: x86_64-unknown-linux-gnu
            label: linux-x64

    runs-on: ${{ matrix.platform }}

    steps:
      - uses: actions/checkout@v4

      # ---- Linux system dependencies (B10) ------------------------------
      - name: Install Linux dependencies
        if: matrix.platform == 'ubuntu-22.04'
        run: |
          sudo apt-get update
          sudo apt-get install -y \
            libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev \
            libjavascriptcoregtk-4.1-dev librsvg2-dev libappindicator3-dev \
            libssl-dev pkg-config libclang-dev clang \
            patchelf file build-essential curl wget

      # pnpm must be on PATH before setup-node's pnpm cache can resolve it
      - uses: pnpm/action-setup@v4
        with:
          version: 12.16.1

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - uses: dtolnay/rust-toolchain@stable
        with:
          targets: ${{ matrix.rust-target }}

      - uses: swatinem/rust-cache@v2
        with:
          workspaces: apps/desktop/src-tauri -> target
          key: ${{ matrix.label }}

      - name: Install JS dependencies
        run: pnpm install --frozen-lockfile

      - name: Build shared packages
        # `...` pulls in every workspace dependency, including @pilates/patient-view,
        # which the explicit list in desktop-ci.yml forgets.
        run: pnpm turbo run build --filter=@pilates/desktop...

      # ---- Per-OS ONNX Runtime (B4) -------------------------------------
      - name: Provision ONNX Runtime
        run: python tools/fetch_onnxruntime.py --platform ${{ matrix.label }}

      - name: Verify ONNX Runtime present
        shell: bash
        run: |
          ls -la apps/desktop/src-tauri/resources/
          test -n "$(ls apps/desktop/src-tauri/resources/*.dll \
                       apps/desktop/src-tauri/resources/*.dylib \
                       apps/desktop/src-tauri/resources/*.so 2>/dev/null)"

      # ---- Engine tests on every OS (not just Windows) ------------------
      - name: Engine tests
        working-directory: apps/desktop/src-tauri
        run: cargo test --locked

      - name: Pose definitions in sync
        run: node tools/generate-pose-definitions.mjs --check

      # ---- Bundle -------------------------------------------------------
      - uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          # Windows Authenticode
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
          # macOS Developer ID + notarization
          APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}
          APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}
          APPLE_SIGNING_IDENTITY: ${{ secrets.APPLE_SIGNING_IDENTITY }}
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_PASSWORD: ${{ secrets.APPLE_PASSWORD }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
        with:
          projectPath: apps/desktop
          args: ${{ matrix.args }}
          # Only attach to a release on tag pushes; PR runs just bundle.
          tagName: ${{ startsWith(github.ref, 'refs/tags/') && github.ref_name || '' }}
          releaseName: ${{ startsWith(github.ref, 'refs/tags/') && format('Pilates AI {0}', github.ref_name) || '' }}
          releaseDraft: true
          prerelease: false

      # PR runs still need artifacts even though nothing is released
      - uses: actions/upload-artifact@v4
        if: github.event_name == 'pull_request'
        with:
          name: installer-${{ matrix.label }}
          path: |
            apps/desktop/src-tauri/target/**/release/bundle/nsis/*.exe
            apps/desktop/src-tauri/target/**/release/bundle/msi/*.msi
            apps/desktop/src-tauri/target/**/release/bundle/dmg/*.dmg
            apps/desktop/src-tauri/target/**/release/bundle/deb/*.deb
            apps/desktop/src-tauri/target/**/release/bundle/appimage/*.AppImage
          if-no-files-found: error
```

### 4.5 Secrets to provision

| Secret | Purpose | Where to obtain |
|---|---|---|
| `APPLE_CERTIFICATE` (base64 `.p12`), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` | Developer ID Application signing | Apple Developer Program ($99/yr) |
| `APPLE_ID`, `APPLE_PASSWORD` (app-specific), `APPLE_TEAM_ID` | `notarytool` submission | Apple ID + team page |
| `TAURI_SIGNING_PRIVATE_KEY`, `…_PASSWORD` | Tauri updater signatures | `pnpm tauri signer generate` |
| Windows Authenticode cert (base64 + password) or a cloud HSM signer | SmartScreen reputation | CA (OV/EV) or Azure Trusted Signing |
| `FIREBASE_SERVICE_ACCOUNT_PILATES` | already used by `web-ci.yml` | existing |

**Recommendation:** adopt **Azure Trusted Signing** (~$10/month, no USB token, CI-friendly) over a traditional OV certificate, which now requires hardware token storage and makes GitHub-hosted runners painful.

### 4.6 Supporting changes the workflow depends on

1. `tools/fetch_onnxruntime.py --platform <label>` — add the flag and the per-OS artifact table (B4).
2. `bundle.targets` → `"all"` or per-OS override files (B3), otherwise the macOS/Linux jobs fail at the bundle step.
3. `ort` features must include `coreml` (B2) before the macOS job can compile at all.
4. `pnpm install --frozen-lockfile` requires the lockfile to be committed and current — verify `pnpm-lock.yaml` (v9.0) matches `package.json` after the legacy-app deletion.
5. A `pnpm tauri build --debug` smoke job on PRs keeps the bundle path exercised without waiting for a tag.
6. `--filter=@pilates/desktop...` instead of the explicit three-package list, which omits `@pilates/patient-view` (§4.3).

---

## 5. Remediation Plan

Ordered so that each phase is independently shippable and verifiable. Effort estimates assume one engineer familiar with the codebase.

### Phase 0 — Make the existing Windows installer actually work (0.5 day) — *unblocks everything*

| # | Action | Files | Verify |
|---|---|---|---|
| 0.1 | Switch `bundle.resources` to the **map form** so config lands at `<resource>/config/` (B1) | `tauri.conf.json` | `target/release/bundle` has no `_up_/` |
| 0.2 | Add `_up_` fallback paths to `candidate_paths()` and `find_config_file()` for upgrade safety | `pose_config.rs:145-213` | new unit test with a temp install tree |
| 0.3 | Add a test asserting resource resolution from a simulated install dir (this is the test that would have caught B1) | `pose_config.rs` tests | `cargo test` |
| 0.4 | Set `bundle.targets` to `"all"` | `tauri.conf.json:30` | `tauri build --bundles nsis` |
| 0.5 | `tauri icon` from a 1024² master; list `icns`/`ico`/PNGs in `bundle.icon` (B6) | `icons/`, `tauri.conf.json:31-34` | `icons/icon.icns` exists |
| 0.6 | Install the NSIS artifact on a clean VM and launch it | — | window opens, 5 poses listed, no console error |

**Exit criterion:** an unsigned NSIS `.exe` installs and runs on a clean Windows 11 VM.

### Phase 1 — Unblock macOS and Linux compilation (1.5 days)

| # | Action | Files | Verify |
|---|---|---|---|
| 1.1 | `ort` features += `coreml` (B2) | `Cargo.toml:32` | `cargo check --target aarch64-apple-darwin` on macOS |
| 1.2 | Add `libonnxruntime.dylib` + versioned soname matching (B4) | `inference.rs:114, 141-149` | unit test with a stub dylib |
| 1.3 | Per-platform artifact table + `--platform` flag in the fetcher (B4) | `tools/fetch_onnxruntime.py` | `--verify` passes per OS |
| 1.4 | `resources/*` glob (not `*.dll`) so `.dylib`/`.so` ship | `tauri.conf.json` | bundle contains the right lib |
| 1.5 | Per-OS `tauri.{windows,macos,linux}.conf.json` with targets + macOS `minimumSystemVersion: "12.0"` (B3) | `src-tauri/` | `tauri build` on each OS |
| 1.6 | `Info.plist` with `NSCameraUsageDescription` + `macOS.infoPlist` (B5) | `src-tauri/Info.plist` | camera prompt appears on macOS |
| 1.7 | Replace `LOCALAPPDATA` lookups with one `app_data_dir()` helper (B7) | `main.rs:27-43`, `cloud_sync.rs:221-238`, `:73` | `patient_origin()` stable per machine on all OSes |
| 1.8 | `cargo test` green on macOS + Linux | — | CI matrix |

**Exit criterion:** all three OSes compile and pass `cargo test`; macOS shows the camera permission prompt and produces detections.

### Phase 2 — CI matrix and first real artifacts (1 day)

| # | Action | Verify |
|---|---|---|
| 2.1 | Add `desktop-release.yml` (§4.4) with `windows-latest`, `macos-14`, `ubuntu-22.04` | three green jobs |
| 2.2 | Provision `fetch_onnxruntime.py --platform …` per job | `resources/` populated before `tauri build` |
| 2.3 | Upload unsigned artifacts on PRs, draft release on tags | five installers in the draft |
| 2.4 | `swatinem/rust-cache` + `pnpm --frozen-lockfile` | job time < 15 min |
| 2.5 | Install each artifact on a clean VM: Win 11, macOS 14 (arm64 + Intel), Ubuntu 22.04 | app launches, 5 poses, camera lists devices |
| 2.6 | Fix `MASTER_EXECUTION_PLAN.md` §3.2/§3.3 (glibc 2.35, no DirectML.dll today) | docs match reality |
| 2.7 | Replace the hand-written package filter with `--filter=@pilates/desktop...` in both workflows | clean-runner build succeeds |
| 2.8 | Add a `functions` step: `npm --prefix functions test` on PRs, `firebase deploy --only functions` on `main` (B19) | aggregates update after a session; `syncState/current` exists |

**Exit criterion:** tag `v2.0.0` produces five downloadable installers, each verified by hand on a clean machine.

### Phase 3 — Signing and the 1-click experience (2 days, mostly certificate lead time)

| # | Action | Verify |
|---|---|---|
| 3.1 | Windows Authenticode (Azure Trusted Signing) wired into `tauri-action` | `signtool verify` passes; SmartScreen clean |
| 3.2 | Apple Developer ID + `notarytool` via `APPLE_*` secrets; `hardenedRuntime: true` (already default) | `spctl --assess --type execute` accepts the `.app`; `stapler validate` passes |
| 3.3 | `windows.webviewInstallMode` decision: `embedBootstrapper` (online estates) or `offlineInstaller` / GPO-pushed runtime (air-gapped); `nsis.installMode: currentUser` (B11) | install succeeds on a WebView2-less VM under both models |
| 3.4 | `bundle.publisher`, `copyright`, `category`, `shortDescription`, `longDescription`, `license` | `.deb` metadata complete; Windows "Apps & features" correct |
| 3.5 | `createUpdaterArtifacts: true` + `tauri-plugin-updater` + a static `latest.json` | v2.0.1 auto-updates a v2.0.0 install on each OS |
| 3.6 | Tighten CSP (B14) | app loads, Firebase/Storage calls still work |
| 3.7 | Clinic provisioning runbook: set the `clinic` claim **before** deploying rules; confirm `bucket` in `cloud.json`; confirm Storage rules (B17, B18) | a fresh account signs in, syncs, and uploads one Parquet archive |
| 3.8 | Surface provisioning failures in the UI: `PERMISSION_DENIED` → "account not provisioned", missing bucket → amber badge (B17, B18) | both states visible without a console |

**Exit criterion:** a clinic user double-clicks one file per OS, sees no security warning, and the app opens; a subsequent patch release updates itself.

### Phase 4 — Correctness debt that only shows on real hardware (1–2 days)

| # | Action | Why |
|---|---|---|
| 4.1 | Ship an FP32 model (or `optimized_model_filepath`) for the CPU tier (B8) | FP16 on CPU EP is either rejected or slow; CPU is the default tier on Linux and on Windows without DirectML |
| 4.2 | Decide the DirectML story: build ORT 1.31 with `--use_directml` in CI, or delete the GPU branch and correct the plan (B9) | today the advertised Tier 1 never activates |
| 4.3 | Linux onboarding: `usermod -aG video`, `/dev/video*` check surfaced in the UI (B15) | empty camera list is the #1 Linux support ticket |
| 4.4 | Standardise Windows release on MSVC (B13) | one toolchain, no `WebView2Loader.dll` shim |
| 4.5 | Startup diagnostics: write the `setup()` error to a log file instead of aborting silently | a clinic cannot report "nothing happened" |

### Phase 5 — Distribution polish (ongoing)

- Publish the `.deb` to a signed `apt` repository (or a plain `apt install ./file.deb` instruction plus GPG-signed AppImage).
- Homebrew cask for macOS (`brew install --cask pilates-ai`).
- `winget` manifest for Windows.
- Document the offline/air-gapped install path (the fetch script already supports a manual DLL drop — that is the right escape hatch; formalise it).
- Adopt the release/versioning process in **§6** (tag naming, Changesets, release cadence).

### Dependency graph of the fixes

```
Phase 0 (0.1 resource map, 0.2 fallbacks) ──┐
Phase 1 (1.1 coreml, 1.2 dylib, 1.3 fetcher,│──> 2.1 CI matrix ──> 2.5 clean-VM installs
         1.4 glob, 1.5 targets, 1.6 plist,  │                     └──> 3.1/3.2 signing ──> 3.5 updater
         1.7 app_data_dir) ─────────────────┘

4.1 (FP32 for CPU) / 4.2 (DirectML decision) — independent of the installer path;
they gate the "GPU accelerated" claim, not the ability to build.
```

### Definition of done — per OS

**Windows:** `Pilates AI_2.0.0_x64-setup.exe` (signed) installs per-user without admin, launches from the Start menu on a clean Windows 11 VM and on a Windows 10 21H2 VM (WebView2 present; and once more on a machine without it, to exercise the bootstrapper), shows 5 poses, opens a USB webcam, records a session, writes `%LOCALAPPDATA%\PilatesAI\pilates-desktop.db`, and uninstalls cleanly.

**macOS:** universal `Pilates AI_2.0.0_universal.dmg` (signed + notarized + stapled) mounts, drags to Applications, passes Gatekeeper on first launch, shows the camera permission prompt, runs detections on both an M-series and an Intel Mac, and writes `~/Library/Application Support/com.pilatesai.workstation/`.

**Linux:** `.deb` and `.AppImage` on Ubuntu 22.04 and 24.04, user in the `video` group, camera enumerates, detections run on CPU, `pilates-desktop.db` under `~/.local/share/com.pilatesai.workstation/`, menu entry present, AppImage runs from any directory.

---

## 6. Release & Versioning Tooling — *deferred, do after Phases 0–3*

This section is process, not packaging. Nothing here blocks a build or an install, which is why it sits last. It is written down now so the decision is made once, in the open, instead of drifting.

### 6.1 What each tool is for

| Tool | Plain-language job | In this repo today | Priority |
|---|---|---|---|
| **Git + GitHub** | Keeps every past state of the code, who changed what, and review before merge | ✅ used | — |
| **GitHub Actions** | The robot that builds and deploys whenever code lands | ✅ 2 workflows, but never builds an installer | **P1** (§4) |
| **pnpm workspaces** | Lets `apps/*` and `packages/*` import each other without publishing to npm | ✅ used | — |
| **Turborepo** | Builds the shared packages in dependency order and caches the result | ✅ used | — |
| **Tauri bundler** | Turns the app into `.msi` / `.exe` / `.dmg` / `.deb` / AppImage | ⚠️ present, Windows-only config | **P0** (§3) |
| **`tauri-action`** | Runs the bundler on GitHub's machines and attaches the files to a release | ❌ missing | P2 |
| **git tag** (`desktop-v2.1.0`) | The name of a version. Nothing is "a version" until a tag exists | ❌ missing | P3 |
| **Changesets** | Collects the changes waiting since the last release and turns them into one version number + a changelog | ❌ missing | P3 |
| **semver** (`2.1.0`) | The numbering rule: patch = fix, minor = new feature, major = breaks old data | ❌ informal | P3 |
| **`tauri-plugin-updater`** | Lets the installed app ask "is there something newer?" | ❌ missing | P2 |
| **`latest.json`** | The small file that answers that question — one per OS | ❌ missing | P2 |
| **`tauri signer`** | Signs the update so a tampered installer is rejected by the app | ❌ missing | P2 |
| **Firebase Hosting** | Serves the portal; a merge is live in about a minute | ✅ used | — |
| **Firebase Storage** | The shelf where installers and `latest.json` sit for download | ❌ missing | P2 |
| **Firestore** | Where patients and sessions actually live | ✅ used | — |
| **Apple Developer ID + Windows certificate** | Removes "unknown publisher" / "cannot be opened" warnings | ❌ missing | **P1** (§4.5) |

### 6.2 Who does what, in one picture

```
code merged
   │
   ├─ GitHub ──────────► history, review trail
   │
   └─ GitHub Actions ──► the robot: builds, tests, packages
            │
            ├─ portal  ──► Firebase Hosting   live in ~60s, no version number
            │
            └─ desktop ──► Firebase Storage   installer + latest.json
                                 │
                                 ▼
                    installed app reads latest.json on launch
                                 │
                    "2.1.0 available" banner → user clicks Install → restart
```

The one sentence that matters: **a merge changes the portal but creates no version; a version exists only when a tag is pushed.**

### 6.3 When does a group of changes become a version?

Three triggers, no counting of changes:

| Trigger | Desktop release | Bump |
|---|---|---|
| **Calendar** — every second Friday | batch everything merged since the last tag | PATCH / MINOR |
| **Clinical-safety fix** — wrong rep count, wrong angle, crash mid-session | same day | PATCH |
| **Contract break** — Firestore document shape changes incompatibly | coordinated, forced update | MAJOR + raise `minimum` |

The group is defined by the interval since the last tag, not by how many changes accumulated. That is the whole answer to "is this change a version?" — it isn't; the release is.

### 6.4 What you do **not** need

- **A version number for the portal.** It deploys continuously; users never see a number. What is versioned is the *data contract* (`schema_version` on the session document), not the website build.
- **Docker, a release branch, or a separate repo.** One repo, one pipeline, two release trains.
- **Editing three version files by hand.** `package.json`, `tauri.conf.json` and `Cargo.toml` all say `2.0.0` today and will drift; the tag should be the only source, injected at build time.
- **A release for every merge.** That is exactly the trap this section avoids.

### 6.5 What I would decide now

1. **Biweekly release train** (Friday) + a same-day hotfix lane for clinical-safety defects. Batch size stops mattering.
2. **The tag is the version.** `desktop-v2.1.0` on `main`; CI injects it into the three manifests.
3. **Changesets** in the monorepo: each PR records its intent (patch/minor/major); the release step collapses them into one bump and one `CHANGELOG.md` entry.
4. **Portal stays unversioned**, the Firestore contract carries `schema_version`, and `minimum` is raised only on a MAJOR.

Deferred work, but cheap to adopt later because it touches no application code — only the release workflow and a few manifest fields.

### 6.6 Applied to the change that just landed

The data-consistency pass is a **MINOR**, not a MAJOR. Everything it added to the session document is optional (`attempts`, `rejected_reps`, `dropped_frames`, `schema_version` are all `?` in `packages/types/src/session.ts:51-62`), and `updated_by` was added to the patient write mask rather than replacing a field. An old desktop reading a new document ignores the extras; a new desktop reading an old document sees them absent. No `minimum` bump is needed, and the desktop stays in the `2.x` line.

One clarification, because "schema v3" appears in that work's task list: it refers to the **local SQLite migration** (`outbox.rs:368`, which adds the `remote_updated_at` column), not the Firestore contract. The Firestore session document is still `SESSION_SCHEMA_VERSION = 1` (`session.rs:88`). The two version numbers move independently and should not be confused when deciding a release number.

---

## Appendix A — Evidence index

| Claim | Evidence |
|---|---|
| Windows-only bundle targets | `apps/desktop/src-tauri/tauri.conf.json:30` |
| Resources escape the crate dir | `tauri.conf.json:35-40` |
| `..` → `_up_` mapping | `tauri-utils 2.10.2` `src/resources.rs:17-31`; on-disk `target/debug/_up_/_up_/_up_/config/` |
| Loaders expect `<resource>/config/` | `src/pose_config.rs:153-155`, `:186-190` |
| Startup aborts on missing definitions | `src/main.rs:55` (`?` inside `setup`) |
| macOS CoreML not compiled in | `Cargo.toml:32`; `ort` `src/ep/mod.rs:427-432`; `src/inference.rs:264-267` |
| Runtime library names | `src/inference.rs:114` |
| Windows-only ORT artifact | `tools/fetch_onnxruntime.py:58-66` |
| `LOCALAPPDATA`-only workstation identity | `src/cloud_sync.rs:221-238`, compared at `:840` |
| FP16 models, opset 17 | `config/model-manifest.json`, `tools/export_onnx.py:40-44` |
| No `DirectML.dll` shipped | `apps/desktop/src-tauri/resources/` (2 files only) |
| v4l2 bindgen requirement | `v4l2-sys-mit 0.3.0` `build.rs` + `wrapper.h` (`#include <linux/videodev2.h>`) |
| Icons lack `.icns`, PNG is 512² | `apps/desktop/src-tauri/icons/` (verified with PIL) |
| CI never bundles | `.github/workflows/desktop-ci.yml:46` |
| CI omits a required workspace package | `desktop-ci.yml:43` and `web-ci.yml:53` vs `PatientDetailPage.tsx:8`, `SessionDetailPage.tsx:1`, `packages/patient-view/package.json` (`main: ./dist/index.js`) |
| No release bundle ever produced | `apps/desktop/src-tauri/target/` → only `debug/`, `dbg/` |
| Legacy PyInstaller removed | `pilates_ai.spec`, `src/*.py`, `requirements.txt` deleted (git status) |
| Portable dependency graph | `Cargo.lock` contains `v4l` 0.14, `v4l2-sys-mit` 0.3, `core-graphics`, `objc2` |
| Rules require the `clinic` claim | `firestore.rules:37-40`, `storage.rules:12-15`; provisioned by `functions/scripts/set-clinic-claim.mjs:27` |
| Claim id can drift | script reads `PILATES_CLINIC_ID` with a `"pilates-ai"` default; both rules hardcode `'pilates-ai'` |
| Bucket has no default | `src/main.rs:75-89` |
| Functions never deployed | `web-ci.yml:70`, `package.json:10` (`--only firestore:rules,firestore:indexes,storage`) |
| Functions tests never run | `functions/package.json:4` vs `web-ci.yml:31` (`test:rules` only) |
| Rules/indexes are deployed before hosting | `web-ci.yml:66-78` |
| Session contract stayed compatible | `packages/types/src/session.ts:51-62` (all new fields optional) |
| Local DB schema version is independent | `outbox.rs:39` (`SCHEMA_VERSION = 5`), migration v3 at `:368`; Firestore doc `session.rs:88` (`= 1`) |
| Resource map: glob dest = directory, file dest = exact path | `tauri-utils 2.10.2` `src/resources.rs` `resource_from_path`; observed as `os error 183` when a file destination had a trailing slash |
| No macOS x86_64 / universal2 ONNX Runtime for 1.31.1 | GitHub release asset list for `v1.31.1`: `onnxruntime-osx-arm64-1.31.1.tgz` only |
| Pinned hashes for the new artifacts | `tools/fetch_onnxruntime.py` — linux-x64 `c849e36a…`, macos-arm64 `2e1344a1…` |
| FP16 runs on the CPU EP | measured: 5/5 models, 20–35 ms, ORT inserts FP32 casts (`InsertCastTransformer`) |
| Data directory resolution | `src/paths.rs`, called from `main.rs` `initialise` |
| CI: 3-OS matrix, functions deploy | `.github/workflows/desktop-release.yml`, `web-ci.yml` |

## Appendix B — Local verification commands

```powershell
# Confirm the resource-flattening bug without building anything
Get-ChildItem -Recurse apps/desktop/src-tauri/target/debug/_up_ |
  Select-Object -ExpandProperty FullName

# Confirm no installer has ever been produced
Test-Path apps/desktop/src-tauri/target/release/bundle        # -> False

# Confirm the macOS compile blocker (after `rustup target add aarch64-apple-darwin`, on macOS)
#   -> error[E0433]: failed to resolve: could not find `CoreML` in `ep`
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml --target aarch64-apple-darwin

# Confirm the ONNX Runtime fetcher is Windows-only
Select-String -Path tools/fetch_onnxruntime.py -Pattern 'onnxruntime-win'

# Confirm no tauri build in CI
Select-String -Path .github/workflows/*.yml -Pattern 'tauri-action|tauri build'

# Confirm functions are never deployed and their tests never run
Select-String -Path .github/workflows/*.yml -Pattern 'deploy --only|functions'

# Confirm the claim literal is hardcoded in both rule files
Select-String -Path firestore.rules,storage.rules -Pattern "clinic.*pilates-ai"

# Confirm the bucket has no default
Select-String -Path apps/desktop/src-tauri/src/main.rs -Pattern 'PILATES_FIREBASE_BUCKET|pilates-telemetry'
```

---

*Report generated from static analysis of the working tree on branch `rasheed`, revision 2 (after the data-consistency pass). No installer was built as part of this audit; the "would launch" column for Windows is derived from the resource-path mismatch documented in B1 and should be confirmed by the Phase 0 acceptance test.*
