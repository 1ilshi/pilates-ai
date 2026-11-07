/**
 * Device-code pairing.
 *
 * A workstation with no stored credential shows a short code. A clinician who
 * is already signed in to the portal approves it, and the workstation exchanges
 * the approval for a Firebase refresh token.
 *
 * Three endpoints, all server-side:
 *
 *   pairStart   — unauthenticated, creates a code and a secret
 *   pairApprove — authenticated, requires the `clinic` claim, mints the token
 *   pairPoll    — unauthenticated, returns the token exactly once
 *
 * Security properties worth keeping if this is ever edited:
 *
 * - Only a SHA-256 of the secret is stored, so a leaked pairing document is
 *   useless without the secret the workstation holds in memory.
 * - The custom token is returned once and the record deleted, so a replayed
 *   poll gets nothing.
 * - `pairApprove` checks the `clinic` claim, not merely that the caller is
 *   authenticated: the legacy FlutterFlow integration account is a valid
 *   Firebase user with no claim and must not be able to mint a workstation.
 * - No secret, token or refresh token is ever logged.
 */

const {onRequest} = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const crypto = require("crypto");

const REGION = "asia-east2";
const PAIRING_COLLECTION = "devicePairings";
const CLINIC_CLAIM = "clinic";
const CLINIC_VALUE = "pilates-ai";

/** A code is useless after this long; the user can ask for another. */
const CODE_TTL_MS = 10 * 60 * 1000;

/** Unambiguous alphabet: no I, O, 0 or 1, which get mistyped. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;

/** `pairStart` budget per address. */
const START_LIMIT = 10;
const START_WINDOW_MS = 10 * 60 * 1000;

/** `pairPoll` budget per address, so a leaked code cannot be hammered. */
const POLL_LIMIT = 120;
const POLL_WINDOW_MS = 10 * 60 * 1000;

/* ------------------------------------------------------------------ */
/* Pure helpers — unit tested in test/pairing.test.js                  */
/* ------------------------------------------------------------------ */

/** `ABCD-EFGH` for display; the stored id is the unpunctuated form. */
function formatCode(code) {
    const raw = String(code || "");
    return raw.length === CODE_LENGTH ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
}

/**
 * Accept what a human typed: lowercase, spaces, or the displayed dash.
 *
 * Returns an empty string for anything that cannot be a code, so callers can
 * treat "not a code" and "wrong code" the same way.
 */
function normaliseCode(raw) {
    const cleaned = String(raw || "")
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "");
    return cleaned.length === CODE_LENGTH ? cleaned : "";
}

function generateCode(bytes) {
    let code = "";
    for (let index = 0; index < CODE_LENGTH; index += 1) {
        code += CODE_ALPHABET[bytes[index] % CODE_ALPHABET.length];
    }
    return code;
}

function sha256(value) {
    return crypto.createHash("sha256").update(String(value)).digest("hex");
}

/** Constant-time comparison so a wrong secret cannot be timed. */
function secretMatches(provided, expectedHash) {
    if (typeof expectedHash !== "string" || expectedHash.length === 0) return false;
    const providedHash = sha256(provided);
    if (providedHash.length !== expectedHash.length) return false;
    return crypto.timingSafeEqual(
        Buffer.from(providedHash, "utf8"),
        Buffer.from(expectedHash, "utf8"),
    );
}

function isExpired(record, now) {
    if (!record || !record.expires_at) return true;
    const expiry = Date.parse(record.expires_at);
    return !Number.isFinite(expiry) || expiry <= now;
}

/** First hop of X-Forwarded-For; Cloud Functions sits behind a proxy. */
function clientAddress(req) {
    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.length > 0) {
        return forwarded.split(",")[0].trim();
    }
    return req.ip || "unknown";
}

/**
 * Whether this address may perform another attempt.
 *
 * Returns `{ allowed, count }`. The counter document lives in the pairing
 * collection with a `rl_` prefix so the Firestore TTL policy already covering
 * `expires_at` cleans it up, and the collection's deny rule already hides it.
 */
function rateWindow(record, now, limit, windowMs) {
    if (!record || !record.window_start) {
        return {allowed: true, count: 1, windowStart: new Date(now).toISOString()};
    }
    const started = Date.parse(record.window_start);
    if (!Number.isFinite(started) || now - started > windowMs) {
        return {allowed: true, count: 1, windowStart: new Date(now).toISOString()};
    }
    const count = Number(record.count || 0) + 1;
    return {allowed: count <= limit, count, windowStart: record.window_start};
}

/* ------------------------------------------------------------------ */
/* Endpoints                                                           */
/* ------------------------------------------------------------------ */

async function takeRateLimit(db, prefix, address, limit, windowMs) {
    const id = `${prefix}_${sha256(address).slice(0, 32)}`;
    const ref = db.collection(PAIRING_COLLECTION).doc(id);
    const snapshot = await ref.get();
    const now = Date.now();
    const next = rateWindow(snapshot.exists ? snapshot.data() : null, now, limit, windowMs);

    await ref.set(
        {
            kind: "rate",
            count: next.count,
            window_start: next.windowStart,
            expires_at: new Date(now + windowMs * 2).toISOString(),
        },
        {merge: true},
    );

    return next.allowed;
}

/**
 * Create a pairing request.
 *
 * Returns `{ code, secret }` to the workstation only. The secret is never
 * stored; its hash is.
 */
exports.pairStart = onRequest(
    {region: REGION, invoker: "public"},
    async (req, res) => {
        if (req.method !== "POST") {
            res.status(405).json({error: "method-not-allowed"});
            return;
        }

        const db = admin.firestore();
        const address = clientAddress(req);

        if (!(await takeRateLimit(db, "rl_start", address, START_LIMIT, START_WINDOW_MS))) {
            res.status(429).json({error: "too-many-requests"});
            return;
        }

        const secret = crypto.randomBytes(32).toString("hex");
        const now = Date.now();
        const expiresAt = new Date(now + CODE_TTL_MS).toISOString();
        const instanceId = typeof req.body?.instance_id === "string"
            ? req.body.instance_id.slice(0, 100)
            : "";

        for (let attempt = 0; attempt < 4; attempt += 1) {
            const code = generateCode(crypto.randomBytes(CODE_LENGTH));
            const ref = db.collection(PAIRING_COLLECTION).doc(code);
            try {
                // `create` fails if the id is taken, which keeps a code unique
                // without a read-then-write race.
                await ref.create({
                    kind: "pairing",
                    secret_hash: sha256(secret),
                    instance_id: instanceId,
                    created_at: new Date(now).toISOString(),
                    expires_at: expiresAt,
                    approved_at: null,
                    approved_by: null,
                    custom_token: null,
                });
                res.status(200).json({
                    code: formatCode(code),
                    secret,
                    expires_at: expiresAt,
                });
                return;
            } catch (error) {
                if (attempt === 3) {
                    console.error("pairStart could not allocate a code", error.message);
                    res.status(503).json({error: "unavailable"});
                }
            }
        }
    },
);

/**
 * Approve a pairing request.
 *
 * Requires a Firebase ID token whose `clinic` claim matches, and records who
 * approved so the workstation's access is attributable.
 */
exports.pairApprove = onRequest(
    {region: REGION, invoker: "public", cors: true},
    async (req, res) => {
        if (req.method !== "POST") {
            res.status(405).json({error: "method-not-allowed"});
            return;
        }

        const header = req.get("authorization") || "";
        const token = header.startsWith("Bearer ") ? header.slice(7) : "";
        if (!token) {
            res.status(401).json({error: "unauthenticated"});
            return;
        }

        let decoded;
        try {
            decoded = await admin.auth().verifyIdToken(token);
        } catch {
            res.status(401).json({error: "unauthenticated"});
            return;
        }

        // Authentication alone is not enough: the legacy integration account is
        // a valid user without the claim.
        if (decoded[CLINIC_CLAIM] !== CLINIC_VALUE) {
            res.status(403).json({error: "not-a-clinician"});
            return;
        }

        const code = normaliseCode(req.body?.code);
        if (!code) {
            res.status(400).json({error: "invalid-code"});
            return;
        }

        const db = admin.firestore();
        const ref = db.collection(PAIRING_COLLECTION).doc(code);
        const snapshot = await ref.get();

        if (!snapshot.exists || snapshot.data().kind !== "pairing") {
            res.status(404).json({error: "unknown-code"});
            return;
        }
        const record = snapshot.data();
        if (isExpired(record, Date.now())) {
            res.status(410).json({error: "expired"});
            return;
        }
        if (record.approved_at) {
            // Idempotent: approving twice is harmless, the token is unchanged.
            res.status(200).json({ok: true, code: formatCode(code)});
            return;
        }

        let customToken;
        try {
            // The workstation acts as the approving clinician, so its writes are
            // attributable and its access is revoked with that account.
            customToken = await admin.auth().createCustomToken(decoded.uid);
        } catch (error) {
            console.error("pairApprove could not mint a token", error.message);
            res.status(500).json({error: "mint-failed"});
            return;
        }

        await ref.update({
            approved_at: new Date().toISOString(),
            approved_by: {uid: decoded.uid, email: decoded.email || ""},
            custom_token: customToken,
        });

        res.status(200).json({ok: true, code: formatCode(code)});
    },
);

/**
 * Collect the token once.
 *
 * Requires the secret issued at start, which only the workstation holds.
 */
exports.pairPoll = onRequest(
    {region: REGION, invoker: "public"},
    async (req, res) => {
        if (req.method !== "POST") {
            res.status(405).json({error: "method-not-allowed"});
            return;
        }

        const db = admin.firestore();
        const address = clientAddress(req);

        if (!(await takeRateLimit(db, "rl_poll", address, POLL_LIMIT, POLL_WINDOW_MS))) {
            res.status(429).json({error: "too-many-requests"});
            return;
        }

        const code = normaliseCode(req.body?.code);
        const secret = typeof req.body?.secret === "string" ? req.body.secret : "";
        if (!code || !secret) {
            res.status(400).json({error: "invalid-request"});
            return;
        }

        const ref = db.collection(PAIRING_COLLECTION).doc(code);
        const snapshot = await ref.get();

        if (!snapshot.exists || snapshot.data().kind !== "pairing") {
            res.status(404).json({error: "unknown-code"});
            return;
        }
        const record = snapshot.data();
        if (isExpired(record, Date.now())) {
            await ref.delete().catch(() => {});
            res.status(410).json({error: "expired"});
            return;
        }
        if (!secretMatches(secret, record.secret_hash)) {
            // Same answer as an unknown code: do not confirm that a code exists.
            res.status(404).json({error: "unknown-code"});
            return;
        }
        if (!record.approved_at || !record.custom_token) {
            res.status(202).json({status: "pending"});
            return;
        }

        const customToken = record.custom_token;
        // Single use: the record is destroyed before the response is written.
        await ref.delete();
        res.status(200).json({status: "approved", custom_token: customToken});
    },
);

// Attach the helpers without replacing the object: `exports.pairStart` and
// friends were assigned above, and a plain `module.exports = {...}` here would
// silently discard them — the functions would deploy as nothing at all.
Object.assign(module.exports, {
    formatCode,
    normaliseCode,
    generateCode,
    sha256,
    secretMatches,
    isExpired,
    rateWindow,
    clientAddress,
    CODE_TTL_MS,
    CODE_LENGTH,
    PAIRING_COLLECTION,
});
