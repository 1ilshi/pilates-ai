/**
 * O(1) incremental session aggregation.
 *
 * Replaces the legacy `aggregateCreatedMetric` path, which scanned the entire
 * `patients` collection on every metric write (O(N)) to rebuild the
 * age/gender cohort averages.
 *
 * This module is deliberately free of `firebase-admin` imports: the database
 * handle is injected, so the logic is unit-testable without the emulator.
 */

/** Collection used to make aggregation idempotent across trigger retries. */
const LEDGER_COLLECTION = "sessionLedger";

/**
 * Apply one completed session to its patient's running totals.
 *
 * Firestore triggers are delivered **at least once**, so a ledger document
 * keyed by session id guarantees a redelivered event cannot double-count.
 *
 * The patient document is written with `merge`, so fields this function does
 * not own (`address`, `note`, `tel_number`, legacy `pose{N}_*` aggregates)
 * are preserved.
 *
 * @param {object} options
 * @param {object} options.database Firestore instance.
 * @param {{exists: boolean, id: string, data: () => object}} options.snapshot
 *   The created session document.
 * @param {string} options.patientId Owning patient document id.
 * @param {unknown} options.serverTimestamp Sentinel for server time.
 * @returns {Promise<boolean>} true when this delivery changed the totals.
 */
async function applySessionAggregate({
    database,
    snapshot,
    patientId,
    serverTimestamp,
}) {
    if (!snapshot || !snapshot.exists) return false;

    const session = snapshot.data() || {};
    const sessionId = snapshot.id;
    const meanScore = Number(session?.summary?.mean_form_score);

    // A session without a usable score carries nothing to aggregate.
    if (!Number.isFinite(meanScore)) return false;
    if (!patientId || !sessionId) return false;

    const patientRef = database.collection("patients").doc(patientId);
    const ledgerRef = database.collection(LEDGER_COLLECTION).doc(sessionId);

    return database.runTransaction(async (transaction) => {
        const ledgerSnapshot = await transaction.get(ledgerRef);
        if (ledgerSnapshot.exists) {
            // Already applied: this is a trigger redelivery.
            return false;
        }

        const patientSnapshot = await transaction.get(patientRef);
        if (!patientSnapshot.exists) {
            // Patient was removed before the trigger ran; nothing to update.
            return false;
        }

        const patient = patientSnapshot.data() || {};
        const previousCount = Number(patient.total_sessions) || 0;
        const previousAverage = Number(patient.lifetime_avg_score) || 0;
        const totalSessions = previousCount + 1;
        const lifetimeAverage =
            ((previousAverage * previousCount) + meanScore) / totalSessions;

        transaction.set(
            patientRef,
            {
                total_sessions: totalSessions,
                lifetime_avg_score: lifetimeAverage,
                last_active: session.completed_at || serverTimestamp,
            },
            {merge: true},
        );

        transaction.set(ledgerRef, {
            patientId,
            sessionId,
            meanScore,
            createdAt: serverTimestamp,
        });

        return true;
    });
}

module.exports = {
    LEDGER_COLLECTION,
    applySessionAggregate,
};
