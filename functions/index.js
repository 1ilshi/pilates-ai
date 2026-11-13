/**
 * Cloud Functions for Pilates AI.
 *
 * The legacy per-metric triggers (`aggregatePoseData_pose1..5`, listening on
 * `patients/{patientId}/pose{N}/{docId}`) have been **removed**. They rebuilt
 * cohort averages by scanning the whole `patients` collection on every write,
 * and they targeted a data shape the current application no longer produces.
 *
 * The desktop app now writes exactly one document per completed exercise
 * session, so aggregation is a single O(1) transaction per session.
 */

const {onDocumentCreated, onDocumentWritten} = require(
    "firebase-functions/v2/firestore",
);
const admin = require("firebase-admin");

const {applySessionAggregate} = require("./aggregation");

admin.initializeApp();

/**
 * Keep `patients/{patientId}` running totals in sync with new sessions.
 *
 * Region is pinned to the Firestore location (`asia-east2`) to avoid a
 * cross-region hop per invocation. `retry` is enabled because the aggregation
 * is idempotent via the session ledger.
 */
exports.onSessionCreated = onDocumentCreated(
    {
        document: "patients/{patientId}/sessions/{sessionId}",
        region: "asia-east2",
        retry: true,
    },
    async (event) => {
        const snapshot = event.data;
        if (!snapshot) return;

        await applySessionAggregate({
            database: admin.firestore(),
            snapshot,
            patientId: event.params.patientId,
            serverTimestamp: admin.firestore.FieldValue.serverTimestamp(),
        });

        // Announce the new session to the other workstations.
        await recordChange(snapshot.data()?.last_origin || "");
    },
);

/**
 * Bump the clinic change marker.
 *
 * One small document (`syncState/current`) that desktops can poll cheaply:
 * a read of it costs a single document instead of scanning the roster. The
 * writer records `last_origin`, the id of the workstation that made the change,
 * so that workstation can ignore the echo of its own upload.
 *
 * @param {string} origin Instance id of the writer, empty when unknown.
 */
async function recordChange(origin) {
    await admin.firestore().doc("syncState/current").set(
        {
            revision: admin.firestore.FieldValue.increment(1),
            last_origin: origin || "",
            updated_at: admin.firestore.FieldValue.serverTimestamp(),
        },
        {merge: true},
    );
}

/**
 * Announce any patient document change (create, edit, delete).
 *
 * Writes made from the console or the portal carry no `last_origin`, which
 * reads as "someone else" — exactly what the desktops should react to.
 */
exports.onPatientWritten = onDocumentWritten(
    {
        document: "patients/{patientId}",
        region: "asia-east2",
    },
    async (event) => {
        const after = event.data?.after;
        const before = event.data?.before;
        const data = (after && after.exists ? after.data() : before?.data()) || {};
        await recordChange(data.last_origin || "");
    },
);

// Device-code pairing. See functions/pairing.js for the security notes.
const pairing = require("./pairing");

exports.pairStart = pairing.pairStart;
exports.pairApprove = pairing.pairApprove;
exports.pairPoll = pairing.pairPoll;

// One-time handoff so "Analysis" opens the portal already signed in.
// See functions/portal_login.js for the security notes.
const portalLogin = require("./portal_login");

exports.portalLoginStart = portalLogin.portalLoginStart;
exports.portalLoginExchange = portalLogin.portalLoginExchange;
