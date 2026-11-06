/**
 * Firestore rules tests, run against the emulator.
 *
 * Deliberately dependency-free: the Firestore emulator accepts unsigned JWTs,
 * so the claims can be exercised directly over the REST API without pulling in
 * `@firebase/rules-unit-testing` and a test framework.
 *
 * Run with:
 *   firebase emulators:exec --only firestore --project demo-pilates \
 *     "node --test rules-tests/firestore.rules.test.mjs"
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = process.env.GCLOUD_PROJECT ?? "demo-pilates";
const BASE = `http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents`;

const CLINIC = "pilates-ai";

/** Claims for an account that has not been granted the clinic claim. */
const OUTSIDER = { sub: "outsider", email: "outsider@example.com" };
/** Claims for a clinician: this is what `set-clinic-claim.mjs` produces. */
const CLINICIAN = { sub: "clinician", email: "clinician@example.com", clinic: CLINIC };

function base64url(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/**
 * An unsigned JWT. The emulator decodes claims without verifying the
 * signature, which is exactly how rules are exercised in unit tests.
 */
function bearer(claims) {
  return `${base64url({ alg: "none", typ: "JWT" })}.${base64url(claims)}.`;
}

/** Convert one plain JS value into a Firestore typed `Value`. */
function toValue(item) {
  if (item === null || item === undefined) return { nullValue: null };
  if (typeof item === "string") return { stringValue: item };
  if (typeof item === "boolean") return { booleanValue: item };
  if (typeof item === "number") {
    return Number.isInteger(item)
      ? { integerValue: String(item) }
      : { doubleValue: item };
  }
  if (Array.isArray(item)) {
    return { arrayValue: { values: item.map(toValue) } };
  }
  return { mapValue: { fields: toFields(item) } };
}

/** Convert a plain JS object into a Firestore `fields` map. */
function toFields(value) {
  const fields = {};
  for (const [key, item] of Object.entries(value)) {
    fields[key] = toValue(item);
  }
  return fields;
}

/**
 * Issue one REST call.
 *
 * `params` is a list of pairs rather than an object because the Firestore API
 * repeats `updateMask.fieldPaths` once per field, which an object cannot express.
 */
async function call(method, path, { claims, body, params } = {}) {
  const url = new URL(`${BASE}${path}`);
  for (const [key, value] of params ?? []) {
    url.searchParams.append(key, value);
  }
  const headers = { "Content-Type": "application/json" };
  if (claims) headers.Authorization = `Bearer ${bearer(claims)}`;

  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

const createDoc = (collection, id, value, claims) =>
  call("POST", `/${collection}`, {
    claims,
    params: [["documentId", id]],
    body: { fields: toFields(value) },
  });

const patchDoc = (path, value, mask, claims) =>
  call("PATCH", `/${path}`, {
    claims,
    params: mask.map((field) => ["updateMask.fieldPaths", field]),
    body: { fields: toFields(value) },
  });

const getDoc = (path, claims) => call("GET", `/${path}`, { claims });
const deleteDoc = (path, claims) => call("DELETE", `/${path}`, { claims });

/** A patient document exactly as the desktop writes it. */
const patientBody = () => ({
  name: "Ada Lovelace",
  age: "34",
  weight: "62",
  height: "168",
  gender: "Female",
  revision: 1,
  local_state: "active",
  last_origin: "workstation-1",
});

/** A session document exactly as `ClinicalSessionDocument` serialises. */
const sessionBody = (patientId, sessionId) => ({
  session_id: sessionId,
  patient_id: patientId,
  pose_id: "pose1",
  model_version: "yolo-v8",
  started_at: "2026-11-06T09:00:00+00:00",
  completed_at: "2026-11-06T09:30:00+00:00",
  duration_seconds: 1800,
  summary: {
    total_reps: 10,
    completion_rate: 90,
    mean_form_score: 82.5,
    peak_rom_angle: 94.1,
    total_hold_time_sec: 120,
  },
  reps: [],
  kinematic_curve: [],
});

before(() => {
  assert.ok(HOST, "FIRESTORE_EMULATOR_HOST is not set — run under emulators:exec");
});

describe("unauthenticated and unaffiliated callers", () => {
  test("anonymous reads are denied", async () => {
    const result = await getDoc("patients/seed", undefined);
    // The emulator answers 401 for "no credentials" and 403 for "denied by
    // rules"; both are refusals, and which one appears is not our contract.
    assert.ok(
      result.status === 401 || result.status === 403,
      `expected a refusal, got ${result.status}`,
    );
  });

  test("a signed-in account without the clinic claim is denied", async () => {
    const result = await getDoc("patients/seed", OUTSIDER);
    assert.equal(result.status, 403);
  });
});

describe("patients", () => {
  test("a clinician can create a patient with owned fields only", async () => {
    const result = await createDoc("patients", "ada", patientBody(), CLINICIAN);
    assert.equal(result.status, 200, JSON.stringify(result.body));
  });

  test("creating a patient with a derived aggregate is denied", async () => {
    const body = { ...patientBody(), total_sessions: 3 };
    const result = await createDoc("patients", "grace", body, CLINICIAN);
    assert.equal(result.status, 403);
  });

  test("a clinician can edit profile fields", async () => {
    const result = await patchDoc(
      "patients/ada",
      { name: "Ada Byron" },
      ["name"],
      CLINICIAN,
    );
    assert.equal(result.status, 200, JSON.stringify(result.body));
  });

  test("editing a derived aggregate is denied", async () => {
    const result = await patchDoc(
      "patients/ada",
      { total_sessions: 99 },
      ["total_sessions"],
      CLINICIAN,
    );
    assert.equal(result.status, 403);
  });

  test("deleting a patient is denied — deletions are soft", async () => {
    const result = await deleteDoc("patients/ada", CLINICIAN);
    assert.equal(result.status, 403);
  });

  test("a tombstone write is allowed", async () => {
    const result = await patchDoc(
      "patients/ada",
      { local_state: "tombstone" },
      ["local_state"],
      CLINICIAN,
    );
    assert.equal(result.status, 200, JSON.stringify(result.body));
  });
});

describe("sessions", () => {
  test("a clinician can create a well-formed session", async () => {
    const result = await createDoc(
      "patients/ada/sessions",
      "session-1",
      sessionBody("ada", "session-1"),
      CLINICIAN,
    );
    assert.equal(result.status, 200, JSON.stringify(result.body));
  });

  test("a session whose patient_id disagrees with its path is denied", async () => {
    const result = await createDoc(
      "patients/ada/sessions",
      "session-2",
      sessionBody("someone-else", "session-2"),
      CLINICIAN,
    );
    assert.equal(result.status, 403);
  });

  test("a session is immutable", async () => {
    const result = await patchDoc(
      "patients/ada/sessions/session-1",
      { duration_seconds: 1 },
      ["duration_seconds"],
      CLINICIAN,
    );
    assert.equal(result.status, 403);
  });

  test("a session cannot be deleted", async () => {
    const result = await deleteDoc("patients/ada/sessions/session-1", CLINICIAN);
    assert.equal(result.status, 403);
  });
});

describe("comments", () => {
  test("a clinician can append a comment", async () => {
    const result = await createDoc(
      "patients/ada/comments",
      "note-1",
      { text: "Knee tracking improved", created_at: "2026-11-06T10:00:00+00:00" },
      CLINICIAN,
    );
    assert.equal(result.status, 200, JSON.stringify(result.body));
  });

  test("an empty comment is denied", async () => {
    const result = await createDoc(
      "patients/ada/comments",
      "note-2",
      { text: "", created_at: "2026-11-06T10:00:00+00:00" },
      CLINICIAN,
    );
    assert.equal(result.status, 403);
  });

  test("a comment cannot be edited", async () => {
    const result = await patchDoc(
      "patients/ada/comments/note-1",
      { text: "rewritten" },
      ["text"],
      CLINICIAN,
    );
    assert.equal(result.status, 403);
  });

  test("a clinician can delete a comment", async () => {
    const result = await deleteDoc("patients/ada/comments/note-1", CLINICIAN);
    assert.equal(result.status, 200);
  });
});

describe("server-owned collections", () => {
  test("sessionLedger is unreadable by a clinician", async () => {
    const result = await getDoc("sessionLedger/session-1", CLINICIAN);
    assert.equal(result.status, 403);
  });

  test("sessionLedger is unwritable by a clinician", async () => {
    const result = await createDoc(
      "sessionLedger",
      "session-1",
      { patientId: "ada", sessionId: "session-1", meanScore: 82.5 },
      CLINICIAN,
    );
    assert.equal(result.status, 403);
  });

  test("the change marker is readable by a clinician", async () => {
    // Written with admin credentials so the read has something to find; the
    // emulator treats `Bearer owner` as bypassing rules.
    const admin = await fetch(
      `${BASE}/syncState?documentId=current`,
      {
        method: "POST",
        headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
        body: JSON.stringify({ fields: toFields({ revision: 4, last_origin: "workstation-1" }) }),
      },
    );
    assert.equal(admin.status, 200);

    const result = await getDoc("syncState/current", CLINICIAN);
    assert.equal(result.status, 200, JSON.stringify(result.body));
  });

  test("the change marker cannot be forged by a clinician", async () => {
    const result = await patchDoc(
      "syncState/current",
      { revision: 999 },
      ["revision"],
      CLINICIAN,
    );
    assert.equal(result.status, 403);
  });
});

after(() => {
  // Nothing to tear down: `emulators:exec` discards the in-memory database.
});
