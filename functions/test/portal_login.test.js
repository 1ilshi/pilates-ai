const assert = require("node:assert/strict");
const test = require("node:test");

const {
    generateCode,
    CODE_TTL_MS,
    PORTAL_LOGIN_COLLECTION,
} = require("../portal_login");
const {sha256, isExpired} = require("../pairing");

test("a login code is URL-safe and long enough to be unguessable", () => {
    const code = generateCode();
    assert.equal(code.length, 32);
    // Base64url: letters, digits, '-' and '_'. A '+' or '/' would break a URL
    // fragment and a '=' would need escaping.
    assert.match(code, /^[A-Za-z0-9_-]{32}$/);
});

test("codes do not repeat", () => {
    const seen = new Set();
    for (let index = 0; index < 100; index += 1) {
        seen.add(generateCode());
    }
    assert.equal(seen.size, 100);
});

test("a code is short-lived", () => {
    assert.equal(CODE_TTL_MS, 60_000);
});

test("the stored id is the code's hash, never the code", () => {
    const code = generateCode();
    const id = sha256(code);
    assert.equal(id.length, 64);
    assert.notEqual(id, code);
    // The hash is stable, so an exchange can look the document up without
    // storing the plaintext code.
    assert.equal(sha256(code), id);
});

test("an expired record is refused by the shared expiry check", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    assert.ok(isExpired({expires_at: "2025-12-31T23:59:00Z"}, now));
    assert.ok(!isExpired({expires_at: "2026-01-01T00:01:00Z"}, now));
});

test("the module exports both HTTPS handlers", () => {
    const module_ = require("../portal_login");
    for (const name of ["portalLoginStart", "portalLoginExchange"]) {
        assert.equal(
            typeof module_[name],
            "function",
            `${name} must be exported or the deploy creates no function`,
        );
    }
    assert.equal(PORTAL_LOGIN_COLLECTION, "portalLogins");
});

test("functions/index.js re-exports the handoff endpoints", () => {
    const index = require("../index");
    for (const name of ["portalLoginStart", "portalLoginExchange"]) {
        assert.equal(
            typeof index[name],
            "function",
            `index.js must re-export ${name}`,
        );
    }
});
