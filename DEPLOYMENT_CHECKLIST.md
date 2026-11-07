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
| **A session has synced end to end** | ⬜ never verified |
| **Installers are signed** | 🔴 no certificates |

**To finish, in this order:**

1. Run one session on an installed build → verifies the whole data path.
2. Sign (needs certificates) → removes the SmartScreen/Gatekeeper warnings.
3. Before deploying claim-only rules: give the claim to every clinic account, portal included.

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
| B8 | End-to-end sync | Record one session, then check for a Parquet object in Storage **and** a session document in Firestore. | any + camera |

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

### ⚠️ Before C4: every clinic account needs the claim

The desktop account is done. `firestore.rules` in this repo is **claim-only**, and the portal signs in with its own accounts. If any of them lack the claim, deploying the repo's rules locks them out.

```powershell
# grant the claim to every account that uses the desktop OR the portal
pnpm claim:clinic desktopaccess@pilatesai.com <portal-account@example.com> ...
```

Each account must sign in again afterwards. Only then is deploying `firestore.rules` safe — and only then does production match the repo.

`storage.rules` still carries an email allow-list. It is now redundant for the desktop account and can be removed once the other address in that list is either given the claim or dropped.

---

## D. Definition of finished

All five must be true. Today: 3 of 5.

- [x] Installers build on Windows, macOS and Linux from one tag
- [x] Installers and an update manifest are published and downloadable
- [x] A clinic account can read and write Firestore and Storage — *claim set and verified*
- [ ] One recorded session produces both an archive and a document — *not yet attempted*
- [ ] Installers are signed — *blocked on C2 and C3*

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
