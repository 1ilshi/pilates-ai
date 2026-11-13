# Changelog

## 2.0.10 — 2026-11-13

- **Signing in now enables archive upload immediately.** The telemetry bucket is
  refreshed whenever the cloud configuration changes, so the "no telemetry
  bucket" banner clears without a restart and the next session records its
  Parquet archive. Previously the bucket was read once at launch, before
  sign-in, and stayed empty for the rest of that run.
- **A clearer update banner.** It shows the version transition, the release
  notes, download progress and a manual **Check for updates** control in the
  sidebar. Installing is still a click, and never happens during a recording.
- **Update notes now come from this changelog**, so the banner says what
  actually changed instead of repeating the version number.

## 2.0.9 — 2026-11-13

- **The "Firebase rejected the clinic credentials" banner is gone.** Sync now
  uses only the stored sign-in; the legacy `cloud.json` password fallback was
  removed. A refused sign-in produces one persistent *"Sign in to resume
  syncing"* banner instead of a password error that appeared and vanished as
  retries alternated between the two paths.
- **Signing in drops the previous account's cached token** and starts a sync
  immediately, so switching accounts takes effect at once.
- **Sign out now asks for confirmation**, with the queued-session reassurance
  spelled out; Escape or Cancel returns without signing out.
- **The desktop patient list says "Mean accuracy"**, not "Mean score".
- **Analysis still hands the portal a one-time code**; it now works as soon as
  the workstation has a valid sign-in, which the fixed credential path
  guarantees.

## 2.0.8 — 2026-11-13

- **Sign out in the workstation.** A bordered **Sign out** button in the sidebar
  footer removes the credential and returns to the sign-in screen. It is
  disabled while a recording is open, so a session is never stranded.
- **One logo everywhere.** The product mark now lives in the shared design
  system, so the portal header, sign-in screen, analysis handoff and the
  desktop workstation render the same asset.

## 2.0.7 — 2026-11-13

- **A credential written by 2.0.6 or earlier must be confirmed once.** Upgrading
  shows the sign-in screen, so no machine keeps syncing as an account nobody
  chose in this version. After that, sign-in persists as before.
- **`cloud.json` is no longer a credential.** A pre-pairing install cannot skip
  sign-in with a stored email and password; only `auth.json` counts.
- **A missing, stale or unreadable `auth.json` now shows the sign-in screen**
  instead of opening the patient list.
- **Portal fits phones and tablets:** the repetition accuracy distribution spans
  the full row, the cohort controls wrap, patient and session views use their
  mobile layouts, and dialogs scroll instead of overflowing.
- **Hold time uses `avg_hold_duration_sec`** in the session header, rep table
  and mobile rep card, not the whole repetition duration.
- **Remaining "Score" / "Form" labels** in the patient and session views now
  read "Accuracy".

## 2.0.6 — 2026-11-13

- **Sign-in replaces pairing for personal laptops.** Install, enter the clinic
  email and password, record. The password is used once and never stored; a
  refresh token keeps the workstation signed in until **Switch account**.
- **Any account created in Firebase Auth can use the app.** The `clinic` custom
  claim is no longer required, so a newly created account works immediately.
  New-user sign-up must stay disabled in the Firebase console.
- **Analysis opens the portal already signed in.** The workstation hands the
  browser a one-time code (60 seconds, single use) and the portal exchanges it
  for a session as the same account.
- **"Form score" is now "pose accuracy"** throughout the interface and docs.
- **New cohort chart: hold time per repetition vs pose accuracy**, one dot per
  repetition, with a trend line per cohort.
- **Hold-time charts use the actual hold duration** (`avg_hold_duration_sec`)
  rather than the whole repetition duration.
- **Cloud sync starts immediately after sign-in**, without restarting the app.
- **Switch account** in the sidebar footer removes the credential so a shared
  laptop can be handed to the next person.
