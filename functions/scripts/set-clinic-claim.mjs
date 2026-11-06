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
import { readFileSync } from "node:fs";

/** Must match `isClinician()` in firestore.rules and storage.rules. */
const CLINIC_ID = process.env.PILATES_CLINIC_ID ?? "pilates-ai";

function usage(message) {
  if (message) console.error(`error: ${message}`);
  console.error(
    "usage: node scripts/set-clinic-claim.mjs [--revoke] <email> [email ...]",
  );
  process.exit(2);
}

function initialise() {
  const credentials = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (credentials) {
    const serviceAccount = JSON.parse(readFileSync(credentials, "utf8"));
    return initializeApp({ credential: cert(serviceAccount) });
  }
  return initializeApp({ credential: applicationDefault() });
}

async function main() {
  const args = process.argv.slice(2);
  const revoke = args.includes("--revoke");
  const emails = args.filter((arg) => arg !== "--revoke");

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
