# Changelog

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
