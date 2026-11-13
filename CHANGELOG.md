# Changelog

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
