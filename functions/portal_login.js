/**
 * Portal sign-in handoff.
 *
 * The desktop app is already signed in; the browser portal is a separate
 * security context and cannot inherit that session. These two endpoints hand a
 * one-time code from the desktop to the browser, which exchanges it for a
 * Firebase custom token — so clicking "Analysis" opens the portal already
 * signed in as the same account, with no password typed twice.
 *
 * Security properties worth keeping if this is ever edited:
 *
 * - The code is stored only as a SHA-256 hash, so a leaked document is useless
 *   without the code the desktop holds in memory.
 * - The code is single use (deleted inside a transaction before the token is
 *   minted) and expires after 60 seconds.
 * - The custom token is minted for the uid recorded at start time, never for a
 *   uid supplied by the caller.
 * - Codes are only ever returned to the desktop, never logged.
 *
 * The portal puts the code in the URL fragment (`#code=...`), which browsers do
 * not send to a server and which is stripped from history once exchanged.
 */

const {onRequest} = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const crypto = require("crypto");

const {sha256, isExpired, rateWindow, clientAddress} = require("./pairing");

const REGION = "asia-east2";
const PORTAL_LOGIN_COLLECTION = "portalLogins";

/** A code is useless after this long; the desktop requests a new one per click. */
const CODE_TTL_MS = 60 * 1000;

/** `portalLoginStart` budget per account. */
const START_LIMIT = 30;
const START_WINDOW_MS = 10 * 60 * 1000;

/** `portalLoginExchange` budget per address. */
const EXCHANGE_LIMIT = 60;
const EXCHANGE_WINDOW_MS = 10 * 60 * 1000;

/** 32 URL-safe characters: unguessable, and safe in a fragment. */
function generateCode() {
    return crypto.randomBytes(24).toString("base64url");
}

/**
 * Whether this address or account may perform another attempt.
 *
 * Counters live beside the codes in the same deny-all collection; the Firestore
 * TTL policy on `expires_at_ts` cleans both up.
 */
async function takeRateLimit(db, prefix, key, limit, windowMs) {
    const id = `${prefix}_${sha256(key).slice(0, 32)}`;
    const ref = db.collection(PORTAL_LOGIN_COLLECTION).doc(id);
    const snapshot = await ref.get();
    const now = Date.now();
    const next = rateWindow(snapshot.exists ? snapshot.data() : null, now, limit, windowMs);

    await ref.set(
        {
            kind: "rate",
            count: next.count,
            window_start: next.windowStart,
            expires_at: new Date(now + windowMs * 2).toISOString(),
            expires_at_ts: admin.firestore.Timestamp.fromDate(
                new Date(now + windowMs * 2),
            ),
        },
        {merge: true},
    );

    return next.allowed;
}

/**
 * Issue a one-time code for the calling workstation.
 *
 * The caller proves its identity with a Firebase ID token, so the code is bound
 * to that account.
 */
exports.portalLoginStart = onRequest(
    {region: REGION, invoker: "public"},
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

        const db = admin.firestore();
        if (!(await takeRateLimit(db, "rl_portal_start", decoded.uid, START_LIMIT, START_WINDOW_MS))) {
            res.status(429).json({error: "too-many-requests"});
            return;
        }

        const code = generateCode();
        const now = Date.now();
        const expiresAt = new Date(now + CODE_TTL_MS).toISOString();

        await db.collection(PORTAL_LOGIN_COLLECTION).doc(sha256(code)).create({
            kind: "portal_login",
            uid: decoded.uid,
            created_at: new Date(now).toISOString(),
            expires_at: expiresAt,
            expires_at_ts: admin.firestore.Timestamp.fromDate(new Date(now + CODE_TTL_MS)),
        });

        res.status(200).json({code, expires_at: expiresAt});
    },
);

/**
 * Exchange a code for a custom token.
 *
 * Unauthenticated by design: the code itself is the proof, and it is bound to
 * the uid recorded at start time.
 */
exports.portalLoginExchange = onRequest(
    {region: REGION, invoker: "public", cors: true},
    async (req, res) => {
        if (req.method !== "POST") {
            res.status(405).json({error: "method-not-allowed"});
            return;
        }

        const db = admin.firestore();
        const address = clientAddress(req);
        if (!(await takeRateLimit(db, "rl_portal_exchange", address, EXCHANGE_LIMIT, EXCHANGE_WINDOW_MS))) {
            res.status(429).json({error: "too-many-requests"});
            return;
        }

        const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
        if (!code) {
            res.status(400).json({error: "invalid-code"});
            return;
        }

        const ref = db.collection(PORTAL_LOGIN_COLLECTION).doc(sha256(code));

        // Read and delete in one transaction: two concurrent exchanges must not
        // both receive a token.
        let record;
        try {
            record = await db.runTransaction(async (transaction) => {
                const snapshot = await transaction.get(ref);
                if (!snapshot.exists) return null;

                const data = snapshot.data();
                if (data.kind !== "portal_login" || !data.uid) return null;
                if (isExpired(data, Date.now())) {
                    transaction.delete(ref);
                    return {expired: true};
                }

                transaction.delete(ref);
                return {uid: data.uid};
            });
        } catch (error) {
            console.error("portalLoginExchange transaction failed", error.message);
            res.status(500).json({error: "unavailable"});
            return;
        }

        if (!record) {
            res.status(404).json({error: "unknown-code"});
            return;
        }
        if (record.expired) {
            res.status(410).json({error: "expired"});
            return;
        }

        let customToken;
        try {
            customToken = await admin.auth().createCustomToken(record.uid);
        } catch (error) {
            console.error("portalLoginExchange could not mint a token", error.message);
            res.status(500).json({error: "mint-failed"});
            return;
        }

        res.status(200).json({custom_token: customToken});
    },
);

// Attach the helpers without replacing the handlers above.
Object.assign(module.exports, {
    generateCode,
    takeRateLimit,
    CODE_TTL_MS,
    PORTAL_LOGIN_COLLECTION,
});
