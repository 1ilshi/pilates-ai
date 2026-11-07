# Pairing Authentication — Agent Brief

**For:** the agent implementing device-code pairing.
**Written by:** the session that owns deployment, packaging and releases.
**Read this before writing code.** Several assumptions in the original plan are out of date; §2 lists them.

---

## 1. What you are building

A TV-style device pairing flow:

1. First run with no stored credential → the app shows a code (`K7M4-QP2X`) and opens `https://pilates-ai.web.app/pair?code=K7M4-QP2X`.
2. An already signed-in clinician approves it in the portal.
3. A Cloud Function mints a custom token; the desktop polls, exchanges it for an ID token + refresh token, stores the refresh token, and enters the workstation.
4. Later launches refresh silently. A rejected token never blocks the app — it shows an amber "re-pair to resume sync" banner.

The last point is the most important rule in this brief. See §5.3.

---

## 2. Corrections to the plan — read these first

| Plan says | Reality |
|---|---|
| "`firestore.rules` currently missing from repo" | **It exists and is tracked** (`firestore.rules`, claim-only). Do not create it — edit it. |
| — | `storage.rules` is also claim-only and **deployed**. Both files authorise solely on the `clinic` claim. |
| — | Every clinic account already carries `clinic=pilates-ai`: `desktopaccess@`, `yadanuch@`, `6531503067@lamduan.mfu.ac.th`. `firebase@flutterflow.io` deliberately does **not** (legacy vendor integration). |
| "First run (no credential stored)" | Today "first run" means *no `cloud.json`*. The app has **no sign-in UI at all** — it authenticates from `cloud.json` at startup. |
| — | `cloud.json` and other config files are read through `pose_config::read_config_text()`, which strips a UTF-8 BOM. Use it for any new file; Windows editors add one and `serde_json` rejects it. |
| — | Per-user files belong in `paths::data_dir()`. Do not invent paths; it already handles `%LOCALAPPDATA%\PilatesAI` on Windows and the platform convention elsewhere. |

**Current known-good baseline — do not regress it:**

- `cargo test --locked` → **141 passed, 0 failed, 1 ignored**
- CI `Desktop Release` green on all three platforms; `Web CI` rules job green
- Release `v2.0.0` published, update manifest live
- A session recorded from an MSI install produces a Firestore document **and** a valid Parquet archive (verified 2026-11-07)

---

## 3. Scope

**In scope:** pairing endpoints, desktop refresh-token auth, pairing UI, portal `/pair` page, rules for `devicePairings`, docs.

**Out of scope — do not touch:**

- Build/packaging config, CI workflows, updater, release manifests (owned by the deployment session)
- The aggregation trigger and `sessionLedger` logic
- Any change to the Firestore document shapes for patients/sessions
- OS code signing

---

## 4. File ownership

Two sessions are working in one working tree. **Edit only the files in your column.** If you need a change in the other column, ask first — do not "just fix" it.

| You own | Deployment session owns |
|---|---|
| `functions/pairing.js` (new), `functions/index.js` | `.github/workflows/**` |
| `firestore.rules` (add the `devicePairings` deny rule only) | `apps/desktop/src-tauri/tauri*.conf.json` |
| `apps/desktop/src-tauri/src/pairing.rs` (new) | `apps/desktop/src-tauri/Cargo.toml` (except a dependency you add — announce it) |
| `apps/desktop/src-tauri/src/cloud_sync.rs` (auth path only) | `tools/fetch_onnxruntime.py`, `tools/build-update-manifest.mjs`, `tools/set-version.mjs` |
| `apps/desktop/src-tauri/src/commands.rs` (your three commands) | `storage.rules` |
| `apps/desktop/src-tauri/src/main.rs` (register your module/commands only) | `DEPLOYMENT_CHECKLIST.md`, `DESKTOP_DEPLOYMENT_*.md` |
| `apps/desktop/src/components/PairingGate.tsx` (new), `App.tsx` | `functions/scripts/set-clinic-claim.mjs` |
| `apps/web/src/pages/PairingPage.tsx` (new), `apps/web/src/App.tsx` | — |
| `TESTING.md` | — |

**Rules of engagement:**

- Work on a branch (`feature/pairing`). Do not push to `master` — every push there runs a 38-minute three-OS build, and a half-finished auth change would break the release.
- Commit by path, never `git add -A`.
- Do not run `pnpm install` / `pnpm add` / `cargo add` while a build is running; announce any dependency you add (lockfile churn affects CI).
- Do not bump the app version. The deployment session does that at release time.

---

## 5. Design decisions I recommend, and why

### 5.1 Store the credential in a separate file, not in `cloud.json`

`cloud.json` is hand-edited by administrators and copied between machines. A refresh token must not travel with it — copying the file to a second workstation would clone the first workstation's identity.

Use `auth.json` beside it (via `paths::data_dir()`):

```json
{ "schema_version": 1, "refresh_token": "...", "paired_at": "...", "instance_id": "..." }
```

Deleting `auth.json` is then the documented way to re-pair. Include `instance_id` (from `patient_origin()`) so the pairing is bound to this machine and shows up in audit.

### 5.2 Put the refresh path at the single choke point

`cloud_sync.rs:501` `ensure_token()` is the only place a token is obtained. Inside it:

1. If `auth.json` has a `refresh_token` → `POST https://securetoken.googleapis.com/v1/token?key=API_KEY` with `grant_type=refresh_token`. Cache the resulting ID token as it does today.
2. Else if `cloud.json` has `email` + `password` → current behaviour, unchanged.
3. Else → no credential; the app is unpaired.

Keeping the password path is not optional: existing installations must keep working after the upgrade, with no re-pairing.

### 5.3 Never gate on a *rejected* credential — only on an *absent* one

The gate is shown when there is **no credential at all**. If a credential exists but the server rejects it (revoked, disabled, network down), the app must still open, record, and queue uploads, with an amber "re-pair to resume sync" banner.

This is not a nicety. A credential problem that hides the patient list is indistinguishable from data loss, and it has already happened twice.

Add a unit test for exactly this: token present + refresh fails → app proceeds, `sync_status` reports degraded, no panic.

### 5.4 The minted custom token must carry `clinic=pilates-ai`

Both rule files are claim-only. A workstation token without that claim can read nothing, so pairing necessarily grants full clinic access. Say so in the approval copy ("this workstation will be able to read and write patient records"), and record who approved it:

```
devicePairings/{code} = {
  secret_hash, created_at, expires_at, approved_at, approved_by (uid + email),
  instance_id, consumed: false
}
```

### 5.5 `pairApprove` must check the approver's claim, not just that they are signed in

Any authenticated Firebase user can call an HTTPS function. Verify `request.auth.token.clinic == 'pilates-ai'` before minting anything. Without that check, the FlutterFlow integration account — which is authenticated but has no claim — could mint a workstation token.

### 5.6 Store only a hash of the secret; return the token exactly once

`pairStart` returns `{ code, secret }`; the desktop keeps the secret in memory only. `pairPoll(code, secret)` compares hashes, and on success returns the custom token **once** and deletes the record. A stolen pairing document is then useless.

### 5.7 Expiry needs a TTL policy, not just delete-on-poll

Abandoned pairings are never polled. Add `expires_at` and configure a Firestore TTL policy on `devicePairings.expires_at` so the collection does not accumulate junk.

### 5.8 Rate limiting

Cloud Functions v2 sits behind a proxy: `req.rawRequest.ip` may be the proxy. Read the first entry of `X-Forwarded-For`. Enforce:

- `pairStart`: a small per-IP budget (e.g. 10 per 10 minutes) using a Firestore counter.
- `pairApprove`: a per-user budget.
- `pairPoll`: no meaningful limit needed if the secret is 32 random bytes — but cap it anyway so a leaked code cannot be hammered.

Do not log the secret, the custom token, or the refresh token.

### 5.9 Portal route ordering

`apps/web/src/App.tsx` ends with `<Route path="*" element={<OverviewPage />} />`. A `/pair` route added after it will never render. Declare it before the catch-all.

---

## 6. Phases and acceptance

### Phase 1 — server

| # | Work | Acceptance |
|---|---|---|
| 1.1 | Add the `devicePairings` deny rule to the **existing** `firestore.rules` | `pnpm test:rules` passes; a client read is denied |
| 1.2 | `pairStart` — code + secret hash, 10-minute expiry, per-IP limit | `curl` returns a code; a client cannot read the document |
| 1.3 | `pairApprove` — verify claim, mint custom token, record approver | a token-less caller gets 403 |
| 1.4 | `pairPoll` — hash compare, single return, delete | second poll returns 410/expired |
| 1.5 | Deploy and verify the round trip with `curl` | start → approve → poll returns a custom token |

### Phase 2 — desktop auth

| # | Work | Acceptance |
|---|---|---|
| 2.1 | `auth.json` read/write via `paths::data_dir()` + `read_config_text` | BOM tolerated; corrupt file → treated as unpaired, not a crash |
| 2.2 | Refresh path inside `ensure_token()` | a valid refresh token yields an ID token without a password |
| 2.3 | `pairing.rs` — start, poll, exchange custom token → refresh token | unit test for code normalisation (case, dash, whitespace) |
| 2.4 | Commands `pairing_start`, `pairing_poll`, `pairing_status` | registered; `pairing_status` never fails |
| 2.5 | `cargo test --locked` | **142+ passed, 0 failed** |

### Phase 3 — desktop UI

| # | Work | Acceptance |
|---|---|---|
| 3.1 | `PairingGate` — code, "Open portal to authorize", 2 s poll, success/expiry, retry | deleting `auth.json` shows it; pairing completes |
| 3.2 | Gate only on absent credential | with a credential present the app opens straight to the workstation |
| 3.3 | Amber "re-pair to resume sync" banner for a rejected token | revoking the token shows the banner; patients remain visible; sessions queue |
| 3.4 | Manual run | delete `cloud.json` + `auth.json`, launch, pair, record one session, confirm it reaches Firestore **and** Storage |

### Phase 4 — portal

| # | Work | Acceptance |
|---|---|---|
| 4.1 | `/pair` route declared before the catch-all | the URL renders the page, not the overview |
| 4.2 | Shows what is being authorised, calls `pairApprove`, shows success/expired | full round trip from a clean desktop install |

### Phase 5 — hardening

| # | Work | Acceptance |
|---|---|---|
| 5.1 | Expiry and rate-limit tests | an expired code is refused; the limit returns 429 |
| 5.2 | Re-pair without data loss | revoke server-side → banner → re-pair → queued sessions drain |
| 5.3 | `TESTING.md` procedure | someone else can follow it unaided |

---

## 7. Verifying locally without waiting for CI

CI takes ~38 minutes per push. Use these instead.

```powershell
# Rust (MSVC is required; the GNU toolchain has no windres here)
cmd /c "call `"C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat`" >nul && C:\Users\muham\.cargo\bin\cargo.exe +stable-x86_64-pc-windows-msvc test --locked --manifest-path apps\desktop\src-tauri\Cargo.toml"

# Front end
pnpm --filter @pilates/desktop build

# Rules (needs Java; the emulator is a JVM program)
pnpm test:rules

# Functions
npm --prefix functions test

# Deploy functions + rules by hand (the CI deploy is inactive — no service-account secret yet)
firebase deploy --only functions,firestore:rules --project pilates-ai
```

`firebase` is installed globally at `%APPDATA%\npm\firebase.cmd`; it may not be on PATH in every shell.

---

## 8. Deployment coordination

- **Functions deploy is manual right now.** `web-ci.yml` deploys `functions` on push to `master`, but the `FIREBASE_SERVICE_ACCOUNT_PILATES` secret is not set, so that job fails at authentication and nothing deploys. Your functions reach production only via `firebase deploy`.
- **Once that secret is added**, CI owns the deploy. Your work must therefore be committed before then, or the next CI run will deploy the repo without your functions.
- **The desktop change needs a release** to reach clinics: version bump → tag → three-OS build → publish. The deployment session does that; tell it when your branch is green.
- **Do not bump the version yourself** and do not edit `tauri.conf.json`.

---

## 9. Definition of done

- [ ] A clean install with no `cloud.json` shows the pairing screen and completes the flow
- [ ] An existing install with email/password keeps working, unchanged, with no re-pairing
- [ ] A revoked token shows the amber banner and still allows recording; re-pairing drains the queue
- [ ] `devicePairings` is unreadable by any client
- [ ] `pairApprove` refuses a caller without the `clinic` claim
- [ ] `cargo test --locked` ≥ 142 passed; `pnpm test:rules` green; `npm --prefix functions test` green
- [ ] `TESTING.md` documents the first-run and re-pair procedures
- [ ] Nothing outside §4's "you own" column was modified
