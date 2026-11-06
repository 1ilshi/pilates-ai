# Desktop Deployment — Implementation Plan

**Derived from:** [DESKTOP_DEPLOYMENT_READINESS.md](DESKTOP_DEPLOYMENT_READINESS.md) (revision 2)
**Scope:** make `apps/desktop` installable and updatable on Windows, macOS and Linux
**Status:** not started — this is the build plan, not a record of work done
**Estimate:** 6–8 engineering days of code/config work, plus 1–2 weeks of certificate lead time that runs in parallel

---

## How to use this file

- Work top-down. Sprints 1–3 are strictly ordered; 4–5 can overlap with 6.
- Every item has an **acceptance check** — do not mark it done on "it compiles".
- `B*` refers to the blocker register in the report; `§` refers to its sections.
- If an item turns out bigger than estimated, stop and re-read the report entry before improvising.

## Progress (last updated 2026-11-06)

| Sprint | State | Note |
|---|---|---|
| 1 — Windows installable | ✅ **verified** | NSIS installer built (39.63 MiB with the WebView2 bootstrapper); installed-layout launch confirmed — no `_up_`, config resolves, ONNX runtime found, DB created |
| 2 — macOS/Linux compile | ✅ implemented | `coreml` feature, dylib/versioned lookup, per-OS configs, Info.plist, `paths` module — macOS/Linux still need a CI run |
| 3 — CI matrix | ✅ implemented | `desktop-release.yml` (3 OS), functions test+deploy, frozen lockfile |
| 4 — Signing / updates | 🟡 partial | **updater wired** (plugin, banner, signature produced); OS code signing deliberately deferred — pipeline ready for secrets |
| 5 — Hardware correctness | ✅ **decided** | B8 withdrawn by measurement; DirectML removed (D5); Linux camera hint and startup log done; MSVC standardised |
| 6 — Release train | 🟡 partial | `tools/set-version.mjs` done; Changesets and `channel.json` not started |

**Verification.** `cargo test --locked` on `x86_64-pc-windows-msvc`: **140 passed, 0 failed, 1 ignored** — with the updater and process plugins linked. `tauri build --bundles nsis` → 39.63 MiB installer plus `Pilates AI_2.0.0_x64-setup.exe.sig`. macOS and Linux have not been compiled yet; the workflow is their first compiler.

## CI findings (first runs on GitHub Actions)

| Problem | Cause | Fix |
|---|---|---|
| Every job died at "Install pnpm" | `pnpm/action-setup@v4` is forced onto Node 24 and its self-installer exits 1 | install pnpm with `npm install -g pnpm@12.16.1` |
| macOS job cancelled before its first step | `macos-14` is no longer an offered runner configuration | `macos-latest` (Apple Silicon) |
| macOS download rejected | the pinned SHA-256 was mistyped (one character dropped) | re-pinned and verified against the archive |
| Deploys never ran | web steps gated on `refs/heads/main`, but the default branch is `master` | gate on `master` |
| Opaque failures | a failed step reports only "exit code 1" | fetch and bundle steps now emit the real error as an annotation |

**Confirmed by CI:** macOS arm64 compiles and passes all 140 tests, as do Windows and Linux. The only remaining blocker is the missing `TAURI_SIGNING_PRIVATE_KEY` secret.

## Do this before the first CI run

`createUpdaterArtifacts` is now on, so **every** bundle must be signed with the update key. A local keypair was generated at `%USERPROFILE%\.tauri\pilates-updater.key` (private) and `.pub` (public, already embedded in `tauri.conf.json`).

1. Add the **private key file's contents** as the repository secret `TAURI_SIGNING_PRIVATE_KEY`. If it has a password, add `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` too.
2. Never commit the key. `%USERPROFILE%\.tauri\` is outside the repository — keep it, and back it up: losing it means existing installs can never be updated, only reinstalled.
3. Local builds now need the key too:
   ```powershell
   $env:TAURI_SIGNING_PRIVATE_KEY = "$env:USERPROFILE\.tauri\pilates-updater.key"
   pnpm --filter @pilates/desktop exec tauri build --bundles nsis
   ```
4. Publish the manifest: upload `latest.json` and the installers to Firebase, at the path the endpoint expects — `desktop/{{target}}/{{arch}}/latest.json`, i.e. `desktop/windows/x86_64/latest.json`. Each manifest lists `version`, `pub_date`, `notes` and a `platforms` map with `signature` + `url` per OS. **This publishing step is not yet in the workflow** — it is the next piece of Sprint 4.


---

## Definition of done

The project is done when a clinic can install without an administrator, without a console, and without a support call — and a bad release can be corrected without visiting the site.

| Platform | Artifact | Must pass |
|---|---|---|
| Windows 10 21H2 / 11 | signed `Pilates AI_x.y.z_x64-setup.exe` (NSIS) | installs per-user, launches from Start menu, 5 poses listed, webcam opens, session records, DB in `%LOCALAPPDATA%\PilatesAI\`, uninstalls cleanly |
| macOS 12+ **Apple Silicon only** | signed + notarized + stapled `Pilates AI_x.y.z_aarch64.dmg` | mounts, drags to Applications, passes Gatekeeper on first launch, camera prompt appears, detections run, data in `~/Library/Application Support/com.pilatesai.workstation/` |
| Ubuntu 22.04 / 24.04 | `.deb` **and** `.AppImage` | user in `video` group, camera enumerates, detections run on CPU, data in `~/.local/share/com.pilatesai.workstation/`, menu entry present |
| All | update path | v2.0.0 install sees "2.0.1 available", installs only after the user clicks, restarts into the new version |

> **Intel Macs are out of scope** unless ONNX Runtime 1.31 is built from source for `x86_64-apple-darwin` — Microsoft publishes no such artifact (report B20).

---

## Sprint 1 — Make the Windows installer actually work (0.5–1 day)

> Unblocks everything. Until W1.1 lands, an installed build aborts before showing a window (report **B1**).

| ID | Work | Files | Acceptance |
|---|---|---|---|
| **W1.1** | Convert `bundle.resources` from a glob list to the **map form** so config lands at `<resource>/config/`, not `<resource>/_up_/_up_/_up_/config/` | `apps/desktop/src-tauri/tauri.conf.json` | `target/release/bundle` contains no `_up_` directory; `config/pose-definitions.json` sits at the resource root |
| **W1.2** | Add a `_up_` fallback to the config search so 2.0.0 installs can still start after an in-place upgrade | `src/pose_config.rs` (`candidate_paths`, `find_config_file`) | unit test resolves a definitions file from a fake install tree |
| **W1.3** | Add the regression test that would have caught B1: build a temp dir shaped like an install (`<tmp>/config/…`) and assert resolution **without** the repo on the path | `src/pose_config.rs` tests | test fails if the `_up_`/map fix is reverted |
| **W1.4** | `"targets": "all"` (CLI filters by host) — or per-OS override files if W2.5 is done first | `tauri.conf.json:30` | `pnpm tauri build --bundles nsis` succeeds |
| **W1.5** | Produce a 1024×1024 master icon and regenerate the set (`pnpm --filter @pilates/desktop tauri icon <master>.png`); list `.icns`, `.ico`, and PNGs in `bundle.icon` | `apps/desktop/src-tauri/icons/` | `icons/icon.icns` exists; Windows shows the app icon in "Apps & features" |
| **W1.6** | Build and install on a clean Windows 11 VM (no dev tools) | — | ✅ **built and launched from a simulated install dir**: window stays up, config resolves, ONNX runtime found, DB created, no `startup-error.log`. Real NSIS install on a clean VM still pending |

**Config for W1.1:**

```json
"resources": {
  "../../../config/models/*.onnx": "config/models/",
  "../../../config/model-manifest.json": "config/",
  "../../../config/pose-definitions.json": "config/",
  "resources/*": "resources/"
}
```

---

## Sprint 2 — Unblock macOS and Linux compilation (1.5 days)

| ID | Work | Files | Acceptance |
|---|---|---|---|
| **W2.1** | Enable the CoreML execution provider — `ep::CoreML` is behind an unenabled feature, so macOS does not compile (**B2**) | `src-tauri/Cargo.toml:32` → `features = ["load-dynamic", "directml", "coreml"]` | `cargo check --target aarch64-apple-darwin` on macOS |
| **W2.2** | Teach the runtime lookup about macOS and versioned sonames (**B4**) | `src/inference.rs:114` | `NAMES` includes `libonnxruntime.dylib`; versioned `libonnxruntime.so.*` resolves |
| **W2.3** | Add a per-platform artifact table + `--platform` flag to the fetcher (**B4**) | `tools/fetch_onnxruntime.py` | `--platform linux-x64`, `--platform macos-universal`, `--platform windows-x64` each verify a pinned SHA-256 |
| **W2.4** | Widen the resource glob from `resources/*.dll` to `resources/*` | `tauri.conf.json` | bundle contains `.dylib` / `.so` on those platforms |
| **W2.5** | Split bundle config per OS; set `macOS.minimumSystemVersion: "12.0"` (**B3**) | new `tauri.windows.conf.json`, `tauri.macos.conf.json`, `tauri.linux.conf.json` | `tauri build` succeeds on all three runners |
| **W2.6** | Add `Info.plist` with `NSCameraUsageDescription` and wire `macOS.infoPlist` (**B5**) | new `src-tauri/Info.plist` | camera prompt appears; app not killed by TCC |
| **W2.7** | One `app_data_dir()` helper via `app.path().app_data_dir()`; use it in `patient_origin()`, `CloudConfig::from_file()`, `data_dir()` (**B7**, **B16**) | `main.rs:27-43`, `cloud_sync.rs:221-238`, `:73` | `patient_origin()` returns a stable non-`unknown-origin` value on all three OSes |
| **W2.8** | Run `cargo test` on macOS and Linux | — | green; camera enumeration test tolerates no device |

**macOS verification commands (W2.1, W2.6):**

```bash
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml --target aarch64-apple-darwin
plutil -p "target/release/bundle/macos/Pilates AI.app/Contents/Info.plist" | grep -i camera
```

---

## Sprint 3 — CI matrix and first real artifacts (1 day)

| ID | Work | Acceptance |
|---|---|---|
| **W3.1** | Add `.github/workflows/desktop-release.yml` per report §4.4 (windows-latest / macos-14 universal / ubuntu-22.04) | three green jobs; artifacts uploaded on PRs |
| **W3.2** | Add `swatinem/rust-cache`, switch to `--frozen-lockfile`, replace the hand-written package filter with `--filter=@pilates/desktop...` | clean-runner build succeeds; job < 15 min |
| **W3.3** | Add a functions step: `npm --prefix functions test` on PRs, `firebase deploy --only functions` on `main` (**B19**) | `functions/test/aggregation.test.js` runs in CI; aggregates update after a session |
| **W3.4** | Install each artifact on a clean VM (Win 11, macOS arm64 + Intel, Ubuntu 22.04) | matches the Definition of Done table |

**Exit criterion:** tag `v2.0.0` produces five downloadable installers, each hand-verified.

---

## Sprint 4 — Signing and the 1-click experience (2 days + lead time)

| ID | Work | Acceptance |
|---|---|---|
| **W4.1** | Windows Authenticode via Azure Trusted Signing wired into `tauri-action` | `signtool verify` passes; SmartScreen shows no warning on a fresh VM |
| **W4.2** | Apple Developer ID + `notarytool` via `APPLE_*` secrets | `spctl --assess --type execute` accepts the `.app`; `xcrun stapler validate` passes |
| **W4.3** | Decide and set `windows.webviewInstallMode` (online: `embedBootstrapper`; air-gapped: `offlineInstaller` or GPO) and `nsis.installMode` (**B11**) | installs on a machine without WebView2 |
| **W4.4** | Fill `bundle.publisher`, `copyright`, `category`, `shortDescription`, `longDescription`, `license` | `.deb` metadata complete; Windows "Apps & features" reads correctly |
| **W4.5** | `createUpdaterArtifacts: true`, `tauri-plugin-updater`, per-platform `latest.json` on Firebase Storage; **manual** check → banner → user clicks → install → relaunch | ✅ **wired and signed** — plugin registered, banner mounted (suppressed on the capture tab), installer + `.sig` produced. Manifest publishing still to add |
| **W4.6** | Replace `"csp": null` with a real policy (**B14**) | app loads, Firebase/Storage calls work, no console CSP violations |
| **W4.7** | Clinic provisioning runbook + UI surfacing (**B17**, **B18**) | `PERMISSION_DENIED` → "account not provisioned"; missing bucket → amber badge |

**Provisioning runbook (W4.7) — the order matters:**

1. Create the clinic account.
2. `pnpm claim:clinic <email>` — **before** deploying rules.
3. Confirm `bucket` in `cloud.json` (or `PILATES_FIREBASE_BUCKET`).
4. Deploy `firestore.rules`, `storage.rules`, indexes, functions.
5. Install the desktop, sign in, record one session, confirm the Parquet object exists in Storage.

---

## Sprint 5 — Correctness that only shows on real hardware (1–2 days)

| ID | Work | Why | Acceptance |
|---|---|---|---|
| **W5.1** | ~~Ship an FP32 model for the CPU tier~~ | **Withdrawn** — measured: FP16 runs on the CPU EP at 20–35 ms because ORT inserts FP32 casts; an FP32 variant is 5–8 % slower and 1.99× larger (report §0.3) | — |
| **W5.2** | ~~Decide DirectML~~ **decided: CPU-only** — the DirectML branch, the `DirectMl` variant and the `directml` crate feature were removed; the docs now describe what the app actually does | measured CPU inference is 20–35 ms, inside the 30 FPS budget | `engine_status.provider` reports `CPU` or `CoreML` only |
| **W5.3** | Linux onboarding: `usermod -aG video`, surface `/dev/video*` problems in the UI (**B15**) | empty camera list is the #1 Linux support ticket | UI explains a permission failure instead of showing "no devices" |
| **W5.4** | Standardise Windows release builds on MSVC (**B13**) | one toolchain, no `WebView2Loader.dll` shim | release exe builds on `x86_64-pc-windows-msvc` |
| **W5.5** | Write `setup()` failures to a log file instead of aborting silently | a clinic cannot report "nothing happened" | a forced failure leaves a readable log |

---

## Sprint 6 — Release train (0.5 day, can run last)

| ID | Work | Acceptance |
|---|---|---|
| **W6.1** | Adopt the tag convention `desktop-vX.Y.Z`; CI injects the version into `package.json`, `tauri.conf.json`, `Cargo.toml` | the three files can no longer drift |
| **W6.2** | Add Changesets; every PR records patch/minor/major | release step produces one bump + one `CHANGELOG.md` entry |
| **W6.3** | Biweekly Friday release + same-day hotfix lane for clinical-safety defects | documented in `TESTING.md` / release notes |
| **W6.4** | `desktop/channel.json` with `minimum`; raise it only on a contract break | an outdated desktop blocks capture with a clear message |

> The portal stays unversioned and keeps deploying on every merge. Only the desktop has versions. Report §6 has the reasoning.

---

## Sequencing

```
Sprint 1 (W1.1–W1.6) ──► Sprint 2 (W2.1–W2.8) ──► Sprint 3 (W3.1–W3.4) ──► Sprint 4 (W4.*)
        │                       │                        │
        └─ Windows install      └─ mac/linux compile     └─ first artifacts
                                                                  │
Sprint 5 (W5.*) — independent, can start any time after Sprint 2 ─┘
Sprint 6 (W6.*) — after Sprint 4
```

Certificate procurement (W4.1, W4.2) should start on **day 1** — it is the only item with an external lead time.

---

## Open decisions

| # | Decision | Options | Recommendation |
|---|---|---|---|
| D1 | Where installers + `latest.json` live | Firebase Storage · Firebase Hosting · GitHub Releases | **Firebase Storage** — public HTTPS, works with a private repo, same service account already in CI |
| D2 | macOS packaging | one arm64 DMG · separate arm64 + x64 DMGs · universal | **arm64 DMG only** — resolved by B20: no universal or x86_64 ONNX Runtime exists for 1.31.1 |
| D3 | Primary Windows format | NSIS · MSI | **NSIS primary** (in-place update works), MSI as the managed-deployment option |
| D4 | Windows install scope | `currentUser` · `perMachine` · `both` | **`both`** — mixed clinic estates; `currentUser` avoids admin prompts |
| D5 | GPU tier on Windows | build DirectML ORT · ship CPU-only and say so | **resolved: CPU-only.** The DirectML branch is deleted and the docs corrected — measured CPU inference (20–35 ms) fits the 30 FPS budget |
| D6 | Release cadence | biweekly · monthly · on-demand | **biweekly + hotfix lane** |

---

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| ONNX Runtime has no `osx-universal2` 1.31 build | Medium | Blocks D2 | Check before Sprint 2; fall back to two per-arch DMGs |
| FP16 model unsupported by CPU EP | High | No inference on Linux / CPU-only Windows | W5.1 ships FP32 for the CPU tier |
| Apple notarization lead time | Medium | Delays macOS | Start the Apple Developer account on day 1 |
| WebKitGTK version on clinic Linux boxes | Medium | App will not start | Publish the `glibc ≥ 2.35` / Ubuntu 22.04+ requirement explicitly |
| Clinic PCs without WebView2 | Medium | Blank window after install | W4.3 decides the install mode per estate |
| WSL cannot validate camera or WebKit rendering | High | False confidence | Treat WSL as a compile/unit-test loop only; cameras are validated on real VMs |

---

## PR checklist

- [ ] `cargo test` passes locally (Windows) and in CI (all three OSes)
- [ ] `pnpm test:rules` passes if rules/storage touched
- [ ] `npm --prefix functions test` passes if `functions/` touched
- [ ] No new absolute paths, no new `LOCALAPPDATA`-only lookups
- [ ] Version files untouched (CI injects them)
- [ ] If a user-visible behaviour changed: a changeset file is included

## Release checklist

- [ ] All CI jobs green on `main`
- [ ] Changesets collapsed into one version
- [ ] Tag `desktop-vX.Y.Z` pushed
- [ ] Five installers produced and signed
- [ ] `latest.json` published with all three platform entries
- [ ] One clean-VM install per OS
- [ ] Release notes mention any provisioning change (claim, bucket, rules)

## Install-verification matrix (per release)

| Check | Win 11 | Win 10 21H2 | macOS arm64 | macOS Intel | Ubuntu 22.04 | Ubuntu 24.04 |
|---|---|---|---|---|---|---|
| Launches from installer | | | | | | |
| 5 poses listed | | | | | | |
| Camera enumerates | | | | | | |
| Session records + syncs | | | | | | |
| Parquet object in Storage | | | | | | |
| Update banner appears | | | | | | |

---

## Out of scope

- Moving source control to Firebase (it is not a VCS — report §6.1)
- Versioning the portal
- Auto-installing updates without user action
- Rewriting the camera or inference layers
- iOS / Android targets (Tauri supports them; nothing here depends on it)
