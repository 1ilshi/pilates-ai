#!/usr/bin/env node
/**
 * Grant the `clinic` custom claim to one or more accounts.
 *
 * Every Firestore and Storage rule requires `request.auth.token.clinic` to be
 * `pilates-ai`. Custom claims are only writable with the Admin SDK, so this is
 * a one-time, out-of-band step — it is deliberately not something the app can
 * do at runtime.
 *
 * Run this **before** deploying `firestore.rules` / `storage.rules`: the rules
 * reject every request from an account that does not carry the claim yet.
 *
 * Usage, from the `functions/` directory (so `firebase-admin` resolves):
 *
 *   node scripts/set-clinic-claim.mjs clinician@example.com [more@example.com ...]
 *   node scripts/set-clinic-claim.mjs --revoke clinician@example.com
 *
 * Credentials come from `GOOGLE_APPLICATION_CREDENTIALS` when set, otherwise
 * from Application Default Credentials (`gcloud auth application-default login`).
 */

import { applicationDefault, cert, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Must match `isClinician()` in firestore.rules and storage.rules. */
const CLINIC_ID = process.env.PILATES_CLINIC_ID ?? "pilates-ai";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The Firebase project to act on.
 *
 * Application Default Credentials from `gcloud auth application-default login`
 * are user credentials and carry no project, so the Admin SDK cannot infer one
 * and fails with "Failed to determine project ID for Auth". A service-account
 * key does carry it, which is why this only bites the ADC path.
 */
function projectId() {
  if (process.env.PILATES_FIREBASE_PROJECT_ID) return process.env.PILATES_FIREBASE_PROJECT_ID;
  if (process.env.GOOGLE_CLOUD_PROJECT) return process.env.GOOGLE_CLOUD_PROJECT;
  try {
    const rc = JSON.parse(readFileSync(join(ROOT, ".firebaserc"), "utf8"));
    const id = rc?.projects?.default;
    if (id) return id;
  } catch {
    // Fall through to the known default.
  }
  return "pilates-ai";
}

function usage(message) {
  if (message) console.error(`error: ${message}`);
  console.error(
    "usage: node scripts/set-clinic-claim.mjs [--revoke] <email> [email ...]",
  );
  process.exit(2);
}

function initialise() {
  const project = projectId();
  const credentials = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (credentials) {
    if (existsSync(credentials)) {
      const serviceAccount = JSON.parse(readFileSync(credentials, "utf8"));
      return initializeApp({ credential: cert(serviceAccount), projectId: project });
    }
    // A stale value here is common: the variable is often left over from
    // another project, and a bare ENOENT gives no hint that ADC would work.
    // Fall back, but say so — silently authenticating as a different identity
    // is worse than stopping.
    console.warn(
      `warning: GOOGLE_APPLICATION_CREDENTIALS points at ${credentials}, which does not exist.`,
    );
    console.warn(
      "         falling back to Application Default Credentials. Unset the variable to silence this.",
    );
  }
  return initializeApp({ credential: applicationDefault(), projectId: project });
}

async function main() {
  const args = process.argv.slice(2);
  const revoke = args.includes("--revoke");

  // Audit mode: who exists, and who already carries the claim. Rules are
  // claim-only, so an account without it is locked out of both Firestore and
  // Storage — worth being able to see at a glance before deploying rules.
  if (args.includes("--list")) {
    const auth = getAuth(initialise());
    const result = await auth.listUsers(1000);
    if (result.users.length === 0) {
      console.log("no accounts in this project");
      return;
    }
    console.log(`${result.users.length} account(s) in ${projectId()}:`);
    for (const user of result.users) {
      const clinic = user.customClaims?.clinic ?? "(none)";
      const marker = clinic === CLINIC_ID ? "ok  " : "MISS";
      console.log(`  [${marker}] ${(user.email ?? user.uid).padEnd(38)} clinic=${clinic}`);
    }
    if (result.pageToken) {
      console.log("  (more than 1000 accounts; only the first page was read)");
    }
    return;
  }

  const emails = args.filter((arg) => arg !== "--revoke" && !arg.startsWith("--"));

  if (emails.length === 0) usage("no email addresses given");

  const app = initialise();
  const auth = getAuth(app);

  let failures = 0;

  for (const email of emails) {
    try {
      const user = await auth.getUserByEmail(email);
      const existing = user.customClaims ?? {};

      // Preserve any other claims: this script owns `clinic` and nothing else.
      const claims = { ...existing };
      if (revoke) {
        delete claims.clinic;
      } else {
        claims.clinic = CLINIC_ID;
      }

      await auth.setCustomUserClaims(user.uid, claims);

      // An existing ID token keeps the old claim until it is refreshed, so say
      // so plainly rather than letting a stale session look like a broken rule.
      console.log(
        `${revoke ? "revoked" : "granted"} clinic=${revoke ? "(none)" : CLINIC_ID} ` +
          `for ${email} (uid ${user.uid})`,
      );
      console.log("  the account must sign in again for the new claim to apply");
    } catch (error) {
      failures += 1;
      console.error(`failed for ${email}: ${error.message}`);
    }
  }

  process.exit(failures === 0 ? 0 : 1);
}

main();
