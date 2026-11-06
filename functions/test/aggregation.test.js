const assert = require("node:assert/strict");
const test = require("node:test");

const {applySessionAggregate, LEDGER_COLLECTION} = require("../aggregation");

/** Minimal in-memory Firestore stand-in (documents only, no queries). */
class FakeFirestore {
    constructor(seed = {}) {
        this.documents = structuredClone(seed);
    }

    collection(name) {
        return {
            doc: (id) => new FakeRef(this, `${name}/${id}`),
        };
    }

    async runTransaction(handler) {
        // The fake applies writes directly; real Firestore batches them.
        const transaction = {
            get: async (ref) => new FakeSnapshot(this.documents[ref.path]),
            set: (ref, value, options) => {
                const existing = this.documents[ref.path];
                this.documents[ref.path] = options && options.merge
                    ? {...(existing || {}), ...structuredClone(value)}
                    : structuredClone(value);
            },
        };
        return handler(transaction);
    }
}

class FakeRef {
    constructor(database, path) {
        this.database = database;
        this.path = path;
    }

    get id() {
        return this.path.split("/").at(-1);
    }
}

class FakeSnapshot {
    constructor(value) {
        this.value = value;
    }

    get exists() {
        return this.value !== undefined;
    }

    data() {
        return this.value === undefined ? undefined : structuredClone(this.value);
    }
}

function sessionSnapshot(id, session) {
    return {
        exists: true,
        id,
        data: () => structuredClone(session),
    };
}

function completedSession(meanScore, completedAt = "2026-03-01T10:00:00Z") {
    return {
        summary: {mean_form_score: meanScore},
        completed_at: completedAt,
    };
}

test("first session sets totals on the patient", async () => {
    const database = new FakeFirestore({
        "patients/p1": {name: "Ada", age: "34"},
    });

    const applied = await applySessionAggregate({
        database,
        snapshot: sessionSnapshot("s1", completedSession(80)),
        patientId: "p1",
        serverTimestamp: "SERVER_TS",
    });

    assert.equal(applied, true);
    const patient = database.documents["patients/p1"];
    assert.equal(patient.total_sessions, 1);
    assert.equal(patient.lifetime_avg_score, 80);
    assert.equal(patient.last_active, "2026-03-01T10:00:00Z");
});

test("redelivery of the same session is ignored", async () => {
    const database = new FakeFirestore({
        "patients/p1": {name: "Ada"},
    });
    const args = {
        database,
        snapshot: sessionSnapshot("s1", completedSession(80)),
        patientId: "p1",
        serverTimestamp: "SERVER_TS",
    };

    assert.equal(await applySessionAggregate(args), true);
    // At-least-once delivery: the same event arrives again.
    assert.equal(await applySessionAggregate(args), false);

    const patient = database.documents["patients/p1"];
    assert.equal(patient.total_sessions, 1, "must not double-count");
    assert.equal(patient.lifetime_avg_score, 80);
});

test("second session produces a weighted running average", async () => {
    const database = new FakeFirestore({
        "patients/p1": {
            name: "Ada",
            total_sessions: 1,
            lifetime_avg_score: 80,
        },
    });

    await applySessionAggregate({
        database,
        snapshot: sessionSnapshot("s2", completedSession(90)),
        patientId: "p1",
        serverTimestamp: "SERVER_TS",
    });

    const patient = database.documents["patients/p1"];
    assert.equal(patient.total_sessions, 2);
    assert.equal(patient.lifetime_avg_score, 85, "mean of 80 and 90");
});

test("fields owned by other clients are preserved", async () => {
    const database = new FakeFirestore({
        "patients/p1": {
            name: "Ada",
            address: "KEEP-ADDRESS",
            note: "KEEP-NOTE",
            tel_number: "KEEP-TEL",
            pose1_avg: 76.75,
            count_pose1: 12,
        },
    });

    await applySessionAggregate({
        database,
        snapshot: sessionSnapshot("s1", completedSession(88)),
        patientId: "p1",
        serverTimestamp: "SERVER_TS",
    });

    const patient = database.documents["patients/p1"];
    assert.equal(patient.address, "KEEP-ADDRESS");
    assert.equal(patient.note, "KEEP-NOTE");
    assert.equal(patient.tel_number, "KEEP-TEL");
    assert.equal(patient.pose1_avg, 76.75);
    assert.equal(patient.count_pose1, 12);
    assert.equal(patient.name, "Ada");
});

test("session without a usable score is skipped", async () => {
    const database = new FakeFirestore({
        "patients/p1": {name: "Ada"},
    });

    const applied = await applySessionAggregate({
        database,
        snapshot: sessionSnapshot("s1", {summary: {}, completed_at: "x"}),
        patientId: "p1",
        serverTimestamp: "SERVER_TS",
    });

    assert.equal(applied, false);
    assert.equal(database.documents["patients/p1"].total_sessions, undefined);
    assert.equal(database.documents[`${LEDGER_COLLECTION}/s1`], undefined);
});

test("missing patient is not resurrected", async () => {
    const database = new FakeFirestore({});

    const applied = await applySessionAggregate({
        database,
        snapshot: sessionSnapshot("s1", completedSession(70)),
        patientId: "gone",
        serverTimestamp: "SERVER_TS",
    });

    assert.equal(applied, false);
    assert.equal(database.documents["patients/gone"], undefined);
    assert.equal(
        database.documents[`${LEDGER_COLLECTION}/s1`],
        undefined,
        "no ledger entry when nothing was applied",
    );
});

test("non-existent snapshot is ignored", async () => {
    const database = new FakeFirestore({});
    const applied = await applySessionAggregate({
        database,
        snapshot: {exists: false, id: "s1", data: () => undefined},
        patientId: "p1",
        serverTimestamp: "SERVER_TS",
    });
    assert.equal(applied, false);
});

test("ledger records provenance for each applied session", async () => {
    const database = new FakeFirestore({
        "patients/p1": {name: "Ada"},
    });

    await applySessionAggregate({
        database,
        snapshot: sessionSnapshot("s1", completedSession(77)),
        patientId: "p1",
        serverTimestamp: "SERVER_TS",
    });

    const ledger = database.documents[`${LEDGER_COLLECTION}/s1`];
    assert.equal(ledger.patientId, "p1");
    assert.equal(ledger.sessionId, "s1");
    assert.equal(ledger.meanScore, 77);
});
