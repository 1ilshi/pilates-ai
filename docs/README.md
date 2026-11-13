# Pilates AI

Clinical workstation for capturing and analysing Pilates pose performance with
on-device computer vision.

## Architecture

| Path | What it is |
| :--- | :--- |
| `apps/desktop` | Tauri 2 desktop app — React 19 frontend + Rust engine |
| `apps/desktop/src-tauri` | Rust engine: camera capture, ONNX inference, biomechanics, Parquet telemetry, SQLite outbox, cloud sync |
| `apps/web` | Clinical web portal (React/Vite) |
| `packages/types` | Shared domain types and generated pose definitions |
| `packages/ui` | Design system (Tailwind v4 tokens + primitives) |
| `packages/viz` | Clinical visualisation (skeleton canvas, gauges, charts) |
| `functions` | Firebase Cloud Functions (O(1) session aggregation) |
| `tools` | Python tooling: ONNX export/verification, ONNX Runtime fetcher, pose-definition generator |
| `assets/models` | **Not in this repository.** Trained PyTorch weights (`poseN/best.pt`), needed only to re-export the ONNX models. Place them here before running `tools/export_onnx.py`. |
| `config` | Pose definitions, model manifest, ONNX models, Firebase config |

Data is dual-tier: **Firestore** holds session summaries and a 2 Hz kinematic
curve for instant queries, while full 30 Hz trajectories are written to
**Cloud Storage** as Snappy Parquet for research.

## Quick start

```powershell
pnpm install
pnpm turbo run build
.venv\Scripts\python.exe tools\fetch_onnxruntime.py   # ONNX Runtime DLL
pnpm --filter @pilates/desktop tauri dev
```

See [TESTING.md](TESTING.md) for how to verify each layer, including checks that
run without a webcam.

## Setting up a workstation (students and colleagues)

The normal path is **install, sign in, record** — one screen, one credential, no
pairing code and no second device. Any account that exists in Firebase Auth can
use the app; there is no claim or allow-list step.

**Supervisor, once per person**

1. Create the account in the Firebase console (Authentication → Users) with an
   email and password.
2. Hand the credentials over. That is the whole provisioning step.

New-user sign-up must stay **disabled** in Authentication → Settings → User
actions. If it is enabled, anyone with the public API key can create an account
and read every patient record. Disabling an account (or deleting it) revokes
access; the desktop stops syncing as soon as its token refresh is refused.

**The colleague, on their own laptop**

1. Install and open the app.
2. Enter that email and password, press **Sign in**.
3. That is the last time they sign in. The app stores a refresh token, so it
   opens straight to the patient list from then on, online or offline.

The internet is needed once, to sign in. Recording, the patient list and the
local queue all work offline afterwards; sessions upload when the connection
returns.

**Upgrading from 2.0.6 or earlier** — the app asks you to sign in once, then
remembers the account as usual. A `cloud.json` email and password is no longer a
credential, so an old install cannot skip the sign-in screen.

**Analysis** opens the clinical portal in the browser already signed in as the
same account: the workstation hands the browser a one-time code (60 seconds,
single use) and the portal exchanges it for a session. If the handoff service is
unreachable, the plain portal opens and asks for the password instead.

Deployment note: the one-time codes are cleaned up by a Firestore TTL policy on
`portalLogins.expires_at_ts` (Firestore → TTL). It is housekeeping only; sign-in
works without it.

**Shared or unattended machines** — choose **Pair it with a code instead** on
the sign-in screen. The machine shows a code; a signed-in clinician approves it
in the portal at `/pair`. Nothing is typed on the shared device.

**Shared laptop, several students** — use **Switch account** in the sidebar
footer between sessions. It removes the credential and returns to the sign-in
screen, so each person's sessions are attributed to their own account. The
button is disabled while a recording is open.

**Lost or replaced laptop** — disable the account in the Firebase console, or
delete its refresh tokens (Authentication → user → Revoke tokens). Use **Switch
account** on the machine if it is still in hand; deleting `auth.json` in the app
data directory has the same effect. Other workstations are unaffected.

## Documentation

- [history/MASTER_EXECUTION_PLAN.md](history/MASTER_EXECUTION_PLAN.md) — architecture blueprint
  and the step-by-step build record.
- [TESTING.md](TESTING.md) — how to run and test the application.
- [DEPLOYMENT_CHECKLIST.md](DEPLOYMENT_CHECKLIST.md) — what ships on each OS, and what is left before release.
- [CHANGELOG.md](CHANGELOG.md) — what changed in each version.

## Credits

- Muhammadrasheed — backend, data collection, data structuring
- Bilal — model training, data visualisation (FlutterFlow)
- Phumin — data visualisation (FlutterFlow)
