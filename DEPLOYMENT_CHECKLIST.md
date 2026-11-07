# Deployment Checklist — Pilates AI Desktop

**Purpose:** the single page that answers "can we ship, and if not, why not".
**Status date:** 2026-11-07
**Companion documents:** [readiness report](DESKTOP_DEPLOYMENT_READINESS.md) · [implementation plan](DESKTOP_DEPLOYMENT_PLAN.md)

Legend: ✅ done and verified · 🟡 done, needs a runtime check · 🔴 blocked (needs something you have to obtain) · ⬜ not started

---

## The short version

| Gate | State |
|---|---|
| Builds on all three platforms | ✅ green in CI |
| Installers published and downloadable | ✅ release `v2.0.0` |
| Update channel resolves | ✅ manifest live |
| The desktop account can reach Firestore and Storage | ✅ claim set, both verified |
| **A session has synced end to end** | ✅ **verified from an MSI install** |
| **Installers are signed** | 🔴 no certificates |

**To finish:**

1. Sign (needs certificates) → removes the SmartScreen/Gatekeeper warnings.
2. Before the first real clinic rollout: run B1–B5, which no one has done yet on macOS or Linux.

---

## A. Done and verified

| # | Item | Evidence |
|---|---|---|
| A1 | Installed build resolves its bundled config | Launched from a simulated install dir: stayed alive, created the DB, logged `ONNX Runtime: found …\resources\onnxruntime.dll`, no `startup-error.log` |
| A2 | Resource layout fixed (the `_up_` bug) | `config/` and `resources/` at the bundle root; 3 regression tests |
| A3 | Rust suite passes | `cargo test --locked` → **141 passed, 0 failed, 1 ignored** (MSVC) |
| A4 | Windows installers | NSIS 39.63 MiB + MSI 45.23 MiB, both with updater signatures |
| A5 | macOS arm64 installer | DMG 71.08 MiB + app archive 72.33 MiB, signed updater artifact |
| A6 | Linux installers | AppImage 123.94 MiB + deb 71.41 MiB, signed updater artifact |
| A7 | CI matrix | 3-OS build + publish, all green, ~38 min cold |
| A8 | Release published | `v2.0.0` with 12 assets incl. `latest.json`, `channel.json` |
| A9 | Update manifest resolves anonymously | All three platforms listed; Windows → NSIS, Linux → AppImage, macOS → app archive |
| A10 | Updater wired | Plugin + banner; installs only on click; suppressed on the Capture tab |
| A11 | macOS compiles with CoreML | CI job green |
| A12 | Inference verified on CPU | FP16 runs at 20–35 ms; FP32 would be slower and 2× larger |
| A13 | DirectML removed | Dead path deleted; docs corrected; `provider` reports CPU/CoreML only |
| A14 | Data directory per-platform | Windows keeps `%LOCALAPPDATA%\PilatesAI`; macOS/Linux use the platform convention |
| A15 | Config files tolerate a UTF-8 BOM | New test covers it — this was the bug found after launch |
| A16 | Startup failures are logged | `<data dir>\startup-error.log` |
| A17 | Release train | Changesets + `set-version.mjs --sync` keep three manifests in step |
| A18 | Provisioning is visible in the UI | Amber banner when no bucket; "account not provisioned" on `PERMISSION_DENIED` |
| A19 | `.venv` (1.4 GB) no longer committable | `.gitignore` |
| A20 | `storage.rules` in git matches production | Committed after your deploy |
| A21 | Device-code pairing | Server endpoints deployed and round-tripped: start → approve → poll → exchange, replay refused. Refresh token in `auth.json`, password path preserved for existing installs. `devicePairings` denied to all clients |

### Pairing — operational notes

- **An existing install is not gated.** A workstation with a complete `cloud.json` credential counts as paired; only a machine with no credential at all shows the pairing screen.
- **Approval is a privileged act.** `pairApprove` requires the `clinic` claim, and the minted token carries it — approving grants read/write on patient records.
- **Project-level IAM is required.** `createCustomToken` needs `roles/iam.serviceAccountTokenCreator` on the Cloud Functions runtime service account, granted to itself. This is not in the repo; it was applied to `pilates-ai` and must be re-applied to any new project.
- **Cleanup is by TTL.** `devicePairings.expires_at_ts` carries a Firestore TTL policy; the string `expires_at` is only used by the logic.
- **Approval should come from the dedicated workstation account** (`desktopaccess@`), which is a synthetic account, not a person's. If a real clinician ever approves, their account removal takes every workstation they paired with it.

---

## B. Done, but never exercised at runtime

These are built and tested in code, but no human has run them. Each is a five-minute check on the right machine.

| # | Item | How to verify | Machine |
|---|---|---|---|
| B1 | macOS installer actually launches | Mount the DMG, drag to Applications, open. Expect the camera prompt on first preview. | any Apple Silicon Mac |
| B2 | macOS camera permission works | Start a preview. If the app dies instead of prompting, `NSCameraUsageDescription` is not reaching the bundle. | macOS |
| B3 | Linux installer launches | `dpkg -i` the `.deb` or run the AppImage; menu entry present. | Ubuntu 22.04/24.04 |
| B4 | Linux camera enumerates | `usermod -aG video $USER`, log out and back in, then check the device list. | Ubuntu |
| B5 | Windows NSIS installer on a **clean** VM | Install via the `.exe` (not the copied folder), launch from the Start menu. | clean Win 11 |
| B6 | CSP does not break the UI | Launch and confirm the window renders and the device list loads. A wrong `connect-src` shows as a blank page with console errors. | any |
| B7 | Update banner appears | Needs a **newer** version published — see C6. | any |
| ~~B8~~ | ~~End-to-end sync~~ | ✅ **verified 2026-11-07**: two sessions recorded from the MSI install produced a Firestore document each *and* a valid Parquet archive in Storage | done |

---

## C. Blocked — needs something you must obtain

| # | Blocker | What it needs | Exact action |
|---|---|---|---|
| ~~C1~~ | ~~The account has no `clinic` claim~~ | — | ✅ **done** — `clinic=pilates-ai` verified on a fresh token; Firestore returns 200, Storage authorises |
| C2 | Windows SmartScreen warning | Authenticode certificate (or Azure Trusted Signing) | obtain cert → follow "Signing Windows" in the plan |
| C3 | macOS Gatekeeper blocks the app | Apple Developer Program ($99/yr) | obtain cert → re-add the `APPLE_*` env block in `desktop-release.yml` |
| C4 | Portal does not auto-deploy | `FIREBASE_SERVICE_ACCOUNT_PILATES` secret | add the secret — **but see the warning below** |
| C5 | Intel Macs unsupported | ONNX Runtime built from source for x86_64 | decide: build it, or document Apple Silicon only |
| C6 | Update path unproven | a version newer than what is installed | bump to `2.0.1`, tag, publish |

### ✅ Before C4: every clinic account now has the claim

Verified with `pnpm claim:clinic --list`:

| Account | Claim |
|---|---|
| `desktopaccess@pilatesai.com` | ✅ `pilates-ai` |
| `yadanuch@pilatesai.com` | ✅ `pilates-ai` |
| `6531503067@lamduan.mfu.ac.th` | ✅ `pilates-ai` |
| `firebase@flutterflow.io` | — deliberately not granted (legacy vendor integration, not a clinician) |

Each account must sign in again for its new token to carry the claim.

`storage.rules` has been reduced to the claim check only — the email allow-list is gone, so both rule files now share one authorization mechanism. **Deployed and verified**: with a claim-bearing token, Storage authorises and Firestore returns 200.

The `firebase@flutterflow.io` account is denied by both rule sets. If the legacy FlutterFlow integration still needs access to anything, that is a separate decision — it is not a clinic user.

---

## D. Definition of finished

All five must be true. Today: 4 of 5.

- [x] Installers build on Windows, macOS and Linux from one tag
- [x] Installers and an update manifest are published and downloadable
- [x] A clinic account can read and write Firestore and Storage — *claim set and verified*
- [x] One recorded session produces both an archive and a document — *verified from an MSI install*
- [ ] Installers are signed — *blocked on C2 and C3*

### End-to-end evidence (2026-11-07)

Two sessions recorded from the MSI-installed build, patient `ness`:

| Session | Document | Archive |
|---|---|---|
| `61d12686…` pose4, 3 reps | written 01:04:24Z | 62.6 KB, uploaded 01:04:27Z, `PAR1` header and footer |
| `db0a7bda…` pose1, 2 reps | written 01:04:56Z | 19.5 KB, uploaded 01:04:58Z |

The archive landed 2–3 seconds after the document, which is the order the code intends: upload first, then the document that points at it. The portal renders both.

**One quirk worth knowing:** reading a specific object works, but *listing* objects through the Firebase Storage REST API returns `403` even for a clinician. Firebase's rules treat `read` as covering both, so this is either a quirk of that endpoint or a rule nuance — nothing in the app depends on it, since it always reads by exact path. If a future feature needs a directory listing, check this first.

---

## E. Re-verification commands

Run these to confirm the state has not drifted.

```powershell
# The claim — the single most important check
#   sign in, decode the token, look for clinic='pilates-ai'
#   (see the probe in this session's log; any JWT decoder will do)

# The update channel
Invoke-RestMethod https://github.com/1ilshi/pilates-ai/releases/latest/download/latest.json |
  ConvertTo-Json -Depth 4

# The published assets
Invoke-RestMethod https://api.github.com/repos/1ilshi/pilates-ai/releases/latest |
  Select-Object -ExpandProperty assets | Select-Object name, size

# Local build health
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml   # expect 141 passed
node tools/set-version.mjs --check                                      # manifests agree
```

---

## F. Known risks to accept consciously

| Risk | Impact | Mitigation |
|---|---|---|
| Unsigned Windows build | SmartScreen scares clinic staff on first run | C2, or ship with written install instructions |
| Unsigned macOS build | Gatekeeper refuses the app; user must right-click → Open | C3 |
| Linux needs glibc ≥ 2.35 | Will not start on Ubuntu 20.04 / Debian 11 | document the floor; build on 22.04 |
| `cloud.json` is per-machine | A new workstation syncs nothing until the file is copied | add it to the provisioning runbook |
| Production rules ≠ repo | CI deploy would break sync | C1, then deploy |
| macOS/Linux never launched | A packaging bug could reach a clinic | B1–B4 before the first real install |
