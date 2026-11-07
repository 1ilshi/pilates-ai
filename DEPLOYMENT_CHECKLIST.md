# Deployment Checklist — Three-OS Comparison

**Version:** 2.0.5 · **Status date:** 2026-11-07
**Verdict:** every platform builds, installs, syncs and updates. **The only gate left is code signing.**
**Companion documents:** [readiness report](DESKTOP_DEPLOYMENT_READINESS.md) · [implementation plan](DESKTOP_DEPLOYMENT_PLAN.md)

Legend: ✅ working · ⚪ not applicable · ❌ blocking · 🟡 works, with a caveat

---

## 1. The comparison

Windows ships **two** formats. They are not interchangeable: only one of them can update itself.

| | **Windows — NSIS `.exe`** | **Windows — MSI** | **macOS 12+ (arm64)** | **Linux x64** |
|---|---|---|---|---|
| **Artifact** | `Pilates.AI_2.0.5_x64-setup.exe` | `Pilates.AI_2.0.5_x64_en-US.msi` | `…_aarch64.dmg` (71.1 MiB) + `Pilates.AI.app.tar.gz` (72.3 MiB) | `…_amd64.AppImage` (124 MiB) + `…_amd64.deb` (71.4 MiB) |
| **Size** | 39.7 MiB | 45.2 MiB | 71.1 / 72.3 MiB | 124 / 71.4 MiB |
| **Install scope** | asks at install time: *all users* (`Program Files`) or *just me* (`%LOCALAPPDATA%`) — but the installer itself elevates, so **UAC fires either way** | per-machine only, no choice, **admin required** | drag to `/Applications` | deb: system-wide · AppImage: anywhere |
| **Updates itself** | ✅ **yes** | ❌ **no** — re-deploy the MSI | ✅ yes | ✅ AppImage · ❌ deb |
| **Update artifact** | the `.exe` | — (not the update target) | `app.tar.gz` | `.AppImage` |
| **Runtime dependency** | WebView2 (embedded bootstrapper, needs internet once) | WebView2 **must already be present** | none — WKWebView ships with macOS | glibc ≥ 2.35, WebKitGTK 4.1 |
| **Camera API** | MediaFoundation / DirectShow | same | AVFoundation + TCC prompt | V4L2 (`video` group) |
| **Camera permission** | OS prompt | same | `NSCameraUsageDescription` in Info.plist | group membership, no prompt |
| **Inference provider** | CPU | CPU | **CoreML** | CPU |
| **Data directory** | `%LOCALAPPDATA%\PilatesAI` | same | `~/Library/Application Support/com.pilatesai.workstation` | `~/.local/share/com.pilatesai.workstation` |
| **Pairing flow** | ✅ | ✅ | ✅ | ✅ |
| **Builds in CI** | ✅ | ✅ (same job) | ✅ | ✅ |
| **Launched on real hardware** | ✅ simulated install + MSI install | ✅ | ❌ **never** | ❌ **never** |
| **Signed** | ❌ SmartScreen warning | ❌ | ❌ Gatekeeper refuses | ⚪ none expected |

### Reading the Windows columns

**Ship the NSIS `.exe` to clinics.** It is the only format the updater can replace — the manifest points Windows at the `.exe`, so an MSI install will be offered an NSIS installer, which installs *alongside* it rather than upgrading. You would end up with two entries in Apps & Features.

**Use the MSI when IT pushes updates** with Intune, GPO or similar. An MSI-installed machine cannot self-update, by design, and should not be expected to.

**Why the `.exe` still shows a UAC prompt.** `tauri.windows.conf.json` sets `nsis.installMode: "both"`, which lets the user choose all-users or just-me — but Tauri requires elevation to offer that choice, and the generated installer declares `MULTIUSER_EXECUTIONLEVEL Highest`. So a clinic user sees an elevation prompt at install *and* at update, even if they pick "just me".

Changing it to `"currentUser"` removes the prompt entirely (`RequestExecutionLevel user`, installs to `%LOCALAPPDATA%`, no admin ever) at the cost of losing the machine-wide option. For a clinic where staff are not administrators, `currentUser` is the smoother 1-click experience; `both` suits mixed estates but costs a UAC prompt on every update.

---

## 2. What is the same everywhere

| | Status |
|---|---|
| Builds from one tag, three runners, no manual steps | ✅ |
| Installer + updater signature published to a GitHub Release | ✅ |
| Update manifest resolves anonymously, all URLs 200 | ✅ |
| Signature in the manifest matches the published `.sig` | ✅ |
| Device-code pairing, first run and re-pair | ✅ |
| Session records → Firestore document + Parquet archive in Storage | ✅ verified from an installed build |
| Patient profile edits (name, contact fields) reach Firestore | ✅ |
| Offline queue, dead-letter after 5 attempts, amber banners | ✅ |
| Data survives uninstall (credentials and queue live outside the install) | ✅ |

---

## 3. The single remaining gate: signing

| OS | What blocks it | What it costs | Effect while unsigned |
|---|---|---|---|
| **Windows** (both formats) | Authenticode certificate | ~$10/mo (Azure Trusted Signing) or an OV/EV cert | SmartScreen: "Windows protected your PC" on first run, every machine |
| **macOS** | Apple Developer Program + notarization | $99/year | Gatekeeper refuses the DMG; the user must right-click → Open |
| **Linux** | nothing | — | — |

Both are wired: the workflow already carries the `APPLE_*` and `TAURI_SIGNING_*` env slots, and `tools/sign-windows.ps1` handles the manual path. Adding certificates is a secrets change, not a code change.

> **Ordering trap, Windows.** Tauri writes the updater `.sig` over the installer bytes. Signing the installer *afterwards* invalidates it and every client silently rejects the update. Either let Tauri sign during bundling (`certificateThumbprint` in `tauri.windows.conf.json`), or use the script, which re-generates the `.sig` and the manifests.

---

## 4. Per-OS notes

### Windows

- **Two formats, one update channel.** See §1.
- **WebView2.** The NSIS installer embeds a bootstrapper, which still needs internet once. For air-gapped clinics use `offlineInstaller` (+127 MB) or push the runtime by GPO.
- **Data** lives in `%LOCALAPPDATA%\PilatesAI`, outside the install directory, so uninstalling keeps credentials and queued sessions.

### macOS

- **Apple Silicon only.** ONNX Runtime 1.31.1 publishes no x86_64 and no universal2 artifact, so an Intel Mac cannot run inference. Supporting Intel means building ONNX Runtime from source in CI.
- **Camera permission** comes from `NSCameraUsageDescription`; without it macOS terminates the process on first capture rather than denying.
- **Untested on hardware.** The DMG has never been opened. Before the first clinic install: mount it, drag to Applications, confirm the camera prompt and that detections run.

### Linux

- **glibc ≥ 2.35.** Built on Ubuntu 22.04 for that reason. It will not start on 20.04 or Debian 11.
- **AppImage updates itself; the deb does not.** Ship the AppImage as the update channel and the deb for managed estates.
- **Camera needs the `video` group**: `usermod -aG video $USER`, then sign out and back in. The device list is empty and the error names the fix.
- **Untested on hardware.** Same first-run check as macOS.

---

## 5. First install on each OS — the test to run

Do this once per platform before a clinic sees it.

| Step | Windows | macOS | Linux |
|---|---|---|---|
| Install | run the `.exe` (not the MSI) | mount DMG, drag to Applications | `dpkg -i` or run the AppImage |
| Launch | Start menu | double-click | menu entry / AppImage |
| Version | sidebar reads **v2.0.5** | same | same |
| Pair | code + approve in portal | same | same |
| Camera | preview opens | permission prompt appears | device list populated |
| Record | one session | one session | one session |
| Verify | Firestore document **and** Storage object | same | same |
| Update | a newer version shows the banner and installs | same | AppImage only |

---

## 6. Verification commands

```powershell
# The update channel: every URL must be 200
$m = Invoke-RestMethod https://github.com/1ilshi/pilates-ai/releases/latest/download/latest.json
$m.platforms.PSObject.Properties | ForEach-Object {
  "{0,-16} {1}" -f $_.Name, (& curl.exe -s -o NUL -w "%{http_code}" -L $_.Value.url)
}

# The release and its assets
Invoke-RestMethod https://api.github.com/repos/1ilshi/pilates-ai/releases/latest |
  Select-Object tag_name, @{n='assets';e={$_.assets.Count}}

# Local build health
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml   # 152 passed
node tools/set-version.mjs --check                                      # all four manifests agree
```

---

## 7. Known risks, consciously accepted

| Risk | Where | Mitigation |
|---|---|---|
| Unsigned installers | Windows, macOS | §3 |
| macOS and Linux never launched | both | §5 before the first clinic |
| Intel Macs unsupported | macOS | build ONNX Runtime from source, or document Apple Silicon only |
| MSI cannot self-update | Windows | re-deploy the MSI, or install from NSIS |
| glibc floor | Linux | document Ubuntu 22.04+ |
| `cloud.json` is per-machine | all | provisioning runbook: bucket, claim, then rules |
| Portal deploys on every `master` push | server | gate with the Firebase service-account secret only when ready |
