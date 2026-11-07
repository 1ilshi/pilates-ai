const assert = require("node:assert/strict");
const test = require("node:test");

const {
    formatCode,
    normaliseCode,
    generateCode,
    secretMatches,
    isExpired,
    rateWindow,
    clientAddress,
    sha256,
    CODE_LENGTH,
} = require("../pairing");

test("a code is shown with a dash and stored without one", () => {
    assert.equal(formatCode("ABCDEFGH"), "ABCD-EFGH");
    assert.equal(formatCode("ABC"), "ABC");
});

test("codes are accepted however a human types them", () => {
    assert.equal(normaliseCode("ABCD-EFGH"), "ABCDEFGH");
    assert.equal(normaliseCode("abcdefgh"), "ABCDEFGH");
    assert.equal(normaliseCode("  ABCD EFGH "), "ABCDEFGH");
    assert.equal(normaliseCode("abcd-efgh"), "ABCDEFGH");
});

test("anything that is not a full code is rejected", () => {
    assert.equal(normaliseCode(""), "");
    assert.equal(normaliseCode(null), "");
    assert.equal(normaliseCode(undefined), "");
    assert.equal(normaliseCode("ABCD"), "");
    assert.equal(normaliseCode("ABCDEFGHI"), "");
    assert.equal(normaliseCode("ABCD-EFG!"), "");
});

test("generated codes avoid characters that look alike", () => {
    // 0 and 1 are excluded from the alphabet, so mapping low bytes still
    // produces only unambiguous characters.
    const code = generateCode(Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]));
    assert.equal(code.length, CODE_LENGTH);
    assert.match(code, /^[A-HJ-NP-Z2-9]{8}$/);
});

test("the same bytes always produce the same code", () => {
    const bytes = Buffer.from([10, 20, 30, 40, 50, 60, 70, 80]);
    assert.equal(generateCode(bytes), generateCode(bytes));
});

test("a secret only matches its own hash", () => {
    const secret = "a".repeat(64);
    assert.ok(secretMatches(secret, sha256(secret)));
    assert.ok(!secretMatches("b".repeat(64), sha256(secret)));
    assert.ok(!secretMatches("", sha256(secret)));
});

test("a missing or malformed hash never matches", () => {
    assert.ok(!secretMatches("anything", null));
    assert.ok(!secretMatches("anything", ""));
    assert.ok(!secretMatches("anything", "short"));
});

test("expiry is judged from the record, not the clock", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    assert.ok(isExpired({expires_at: "2025-12-31T23:59:00Z"}, now));
    assert.ok(!isExpired({expires_at: "2026-01-01T00:10:00Z"}, now));
    assert.ok(isExpired({}, now));
    assert.ok(isExpired(null, now));
    assert.ok(isExpired({expires_at: "not-a-date"}, now));
});

test("the first attempt in a window is allowed and counted", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    const result = rateWindow(null, now, 10, 60000);
    assert.equal(result.allowed, true);
    assert.equal(result.count, 1);
});

test("attempts accumulate until the limit is reached", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    const started = new Date(now).toISOString();

    let record = null;
    const seen = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
        const result = rateWindow(record, now, 10, 60000);
        seen.push(result.allowed);
        record = {count: result.count, window_start: result.windowStart || started};
    }

    assert.equal(seen.slice(0, 10).every(Boolean), true, "first ten allowed");
    assert.equal(seen.slice(10).some(Boolean), false, "the rest refused");
});

test("a window that has elapsed resets the budget", () => {
    const started = Date.parse("2026-01-01T00:00:00Z");
    const later = started + 61000;
    const result = rateWindow(
        {count: 10, window_start: new Date(started).toISOString()},
        later,
        10,
        60000,
    );
    assert.equal(result.allowed, true);
    assert.equal(result.count, 1);
});

test("the client address prefers the first forwarded hop", () => {
    assert.equal(
        clientAddress({headers: {"x-forwarded-for": "203.0.113.9, 10.0.0.1"}}),
        "203.0.113.9",
    );
    assert.equal(clientAddress({headers: {}, ip: "198.51.100.4"}), "198.51.100.4");
    assert.equal(clientAddress({headers: {}}), "unknown");
});

// The three endpoints must survive `require`. A `module.exports = {...}` at the
// bottom of pairing.js silently discarded them once: the deploy reported success
// while creating no functions at all, and every unit test still passed because
// they only import the helpers. Assert the handlers themselves.
test("the module exports the three HTTPS handlers", () => {
    const pairing = require("../pairing");
    for (const name of ["pairStart", "pairApprove", "pairPoll"]) {
        assert.equal(
            typeof pairing[name],
            "function",
            `${name} must be exported or the deploy creates no function`,
        );
    }
});

test("functions/index.js re-exports the pairing endpoints", () => {
    const index = require("../index");
    for (const name of ["pairStart", "pairApprove", "pairPoll"]) {
        assert.equal(
            typeof index[name],
            "function",
            `index.js must re-export ${name}`,
        );
    }
});
