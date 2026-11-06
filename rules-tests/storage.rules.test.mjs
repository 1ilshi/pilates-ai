/**
 * Cloud Storage rules tests, run against the emulator.
 *
 * Same approach as the Firestore suite: the emulator decodes unsigned JWTs, so
 * the `clinic` claim can be exercised over the REST API with no test framework
 * beyond `node:test`.
 *
 * Run with:
 *   firebase emulators:exec --only storage --project demo-pilates \
 *     "node --test rules-tests/"
 */

import { before, describe, test } from "node:test";
import assert from "node:assert/strict";

// The emulator exports `STORAGE_EMULATOR_HOST` with a scheme already attached,
// while the documented fallback does not — normalise both to a bare host:port.
const RAW_HOST = process.env.STORAGE_EMULATOR_HOST ?? "127.0.0.1:9199";
const HOST = RAW_HOST.replace(/^https?:\/\//, "").replace(/\/$/, "");
const PROJECT = process.env.GCLOUD_PROJECT ?? "demo-pilates";
const BUCKET = `${PROJECT}.appspot.com`;
const BASE = `http://${HOST}/v0/b/${BUCKET}/o`;

const CLINIC = "pilates-ai";

const OUTSIDER = { sub: "outsider", email: "outsider@example.com" };
const CLINICIAN = { sub: "clinician", email: "clinician@example.com", clinic: CLINIC };

function base64url(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function bearer(claims) {
  return `${base64url({ alg: "none", typ: "JWT" })}.${base64url(claims)}.`;
}

function authHeaders(claims) {
  const headers = {};
  if (claims) headers.Authorization = `Bearer ${bearer(claims)}`;
  return headers;
}

/** Upload one object; returns the HTTP status. */
async function upload(objectPath, claims, body = "PAR1") {
  const url = `${BASE}?uploadType=media&name=${encodeURIComponent(objectPath)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { ...authHeaders(claims), "Content-Type": "application/octet-stream" },
    body,
  });
  return response.status;
}

async function download(objectPath, claims) {
  const url = `${BASE}/${encodeURIComponent(objectPath)}?alt=media`;
  const response = await fetch(url, { headers: authHeaders(claims) });
  return response.status;
}

async function remove(objectPath, claims) {
  const url = `${BASE}/${encodeURIComponent(objectPath)}`;
  const response = await fetch(url, {
    method: "DELETE",
    headers: authHeaders(claims),
  });
  return response.status;
}

const ARCHIVE = "telemetry/patient-1/session-1.parquet";

before(() => {
  assert.ok(HOST, "STORAGE_EMULATOR_HOST is not set — run under emulators:exec");
});

describe("uploading an archive", () => {
  test("anonymous uploads are refused", async () => {
    const status = await upload(ARCHIVE, undefined);
    assert.ok(
      status === 401 || status === 403,
      `expected a refusal, got ${status}`,
    );
  });

  test("an account without the clinic claim is refused", async () => {
    const status = await upload(ARCHIVE, OUTSIDER);
    assert.ok(status === 401 || status === 403, `expected a refusal, got ${status}`);
  });

  test("a clinician may upload a Parquet archive", async () => {
    const status = await upload(ARCHIVE, CLINICIAN);
    assert.equal(status, 200);
  });

  test("a non-Parquet object is refused", async () => {
    const status = await upload("telemetry/patient-1/session-1.csv", CLINICIAN);
    assert.equal(status, 403);
  });

  test("an object outside telemetry/ is refused", async () => {
    const status = await upload("elsewhere/session-1.parquet", CLINICIAN);
    assert.equal(status, 403);
  });
});

describe("reading an archive", () => {
  test("a clinician may download it", async () => {
    const status = await download(ARCHIVE, CLINICIAN);
    assert.equal(status, 200);
  });

  test("an anonymous reader is refused", async () => {
    const status = await download(ARCHIVE, undefined);
    assert.ok(status === 401 || status === 403, `expected a refusal, got ${status}`);
  });
});

describe("mutating an archive", () => {
  // Overwriting is deliberately not asserted here. Production Storage treats an
  // upload to an existing name as an `update`, which `allow update, delete: if
  // false` refuses — but the emulator's `uploadType=media` path always reports
  // `create`, so a passing assertion would only prove the emulator's behaviour.
  // The rule is in storage.rules; the delete case below is exercised for real.

  test("archives cannot be deleted", async () => {
    const status = await remove(ARCHIVE, CLINICIAN);
    assert.equal(status, 403);
  });
});
