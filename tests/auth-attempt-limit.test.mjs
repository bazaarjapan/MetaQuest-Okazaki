import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { handleSchoolRequest } from "../worker/index.mjs";
import { base64url, LIMITS, sha256 } from "../worker/school-common.mjs";
import { first, getChallenge, limitGoogleAttempt, newChallenge } from "../worker/school-store.mjs";

const origin = "https://metaquest001.gigach.net", audience = "attempt-fixture.apps.googleusercontent.com";
const initialNow = 1801332000;
const migration = await readFile(new URL("../migrations/0001_school_worlds.sql", import.meta.url), "utf8");
const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const jwk = { ...await crypto.subtle.exportKey("jwk", pair.publicKey), kid: "attempt-key", alg: "RS256" };
async function token(nonce, now, kid = jwk.kid) {
  const claims = { iss: "https://accounts.google.com", aud: audience, sub: "attempt-user", exp: now + 3600,
    iat: now, nonce, email: "fixture@gmail.com", email_verified: true };
  const prefix = [ { alg: "RS256", kid }, claims ].map((value) => base64url(new TextEncoder().encode(JSON.stringify(value)))).join(".");
  return `${prefix}.${base64url(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(prefix)))}`;
}
function adapter(sqlite) {
  return { prepare(sql) { return { bind(...values) {
    const statement = sqlite.prepare(sql);
    return {
      async first() { const row = statement.get(...values); return row ? { ...row } : null; },
      async run() { const result = statement.run(...values); return { success: true, meta: { changes: Number(result.changes) } }; },
    };
  } }; } };
}
function setup() {
  const sqlite = new DatabaseSync(":memory:"); sqlite.exec(migration);
  let now = initialNow, verifications = 0;
  const db = adapter(sqlite);
  const env = { DB: db, STL_BUCKET: {}, SCHOOL_ROOMS: {}, ASSETS: {}, APP_ORIGIN: origin,
    GOOGLE_CLIENT_ID: audience, TEACHER_GOOGLE_EMAILS: "teacher@gmail.com" };
  const dependencies = { now: () => now * 1000, googleVerification: {
    get jwks() { verifications++; return [jwk]; },
  } };
  function request(path, data = null, headers = {}) {
    return new Request(`${origin}${path}`, { method: data ? "POST" : "GET",
      headers: { Origin: origin, ...(data ? { "Content-Type": "application/json" } : {}), ...headers },
      ...(data ? { body: JSON.stringify(data) } : {}) });
  }
  async function challenge() {
    const response = await handleSchoolRequest(request("/api/session"), env, dependencies);
    const body = await response.json(), cookie = response.headers.get("Set-Cookie").split(";")[0];
    const authoritative = await getChallenge(request("/api/session", null, { Cookie: cookie }), db, now);
    return { ...body, cookie, authoritative };
  }
  function login(value, credential, headers = {}, csrf = value.csrf) {
    return handleSchoolRequest(request("/api/auth/google", { csrf, credential }, { Cookie: value.cookie, ...headers }), env, dependencies);
  }
  return { sqlite, db, env, dependencies, request, challenge, login, now: () => now,
    advance(seconds) { now += seconds; }, verifications: () => verifications };
}
const rejects = (promise, code) => assert.rejects(promise, (error) => error.code === code);

test("atomic persistent challenge budget admits eight concurrent attempts and no more", async () => {
  const s = setup();
  try {
    const value = await s.challenge(), otherIsolateDb = adapter(s.sqlite);
    const results = await Promise.allSettled(Array.from({ length: 24 }, (_, i) =>
      limitGoogleAttempt(i % 2 ? otherIsolateDb : s.db, value.authoritative, s.now())));
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 8);
    assert.equal(results.filter((result) => result.status === "rejected" && result.reason.code === "login_rate_limit").length, 16);
    const row = await first(s.db, "SELECT * FROM school_auth_limits WHERE bucket=?", `google-attempt:${value.authoritative.token_hash}`);
    assert.equal(row.counter, 8); assert.equal(row.expires_at, value.authoritative.expires_at);
    assert.equal(row.bucket.includes(value.cookie.split("=")[1]), false);
    // A new adapter has no memory of prior attempts; the shared SQL row remains authoritative.
    await rejects(limitGoogleAttempt(adapter(s.sqlite), value.authoritative, s.now()), "login_rate_limit");
    assert.equal((await first(s.db, "SELECT counter FROM school_auth_limits WHERE bucket=?", row.bucket)).counter, 8);
  } finally { s.sqlite.close(); }
});

test("Google POST rejects repeated invalid credentials before further signature/key work", async () => {
  const s = setup();
  try {
    const value = await s.challenge(), invalid = await token(value.nonce, s.now(), "unknown-key");
    for (let i = 0; i < 8; i++) await rejects(s.login(value, invalid), "invalid_token");
    assert.equal(s.verifications(), 8);
    await rejects(s.login(value, invalid), "login_rate_limit");
    assert.equal(s.verifications(), 8);
    const reused = await handleSchoolRequest(s.request("/api/session", null, { Cookie: value.cookie }), s.env, s.dependencies);
    assert.deepEqual(await reused.json(), { user: null, csrf: value.csrf, nonce: value.nonce });
    await rejects(s.login(value, invalid), "login_rate_limit");
    assert.equal(s.verifications(), 8);
    assert.ok(await getChallenge(s.request("/api/session", null, { Cookie: value.cookie }), s.db, s.now()));
    assert.equal((await first(s.db, "SELECT COUNT(*) AS n FROM school_sessions")).n, 0);
  } finally { s.sqlite.close(); }
});

test("valid cookie, CSRF and Origin are required before any attempt budget or verifier use", async () => {
  const s = setup();
  try {
    const value = await s.challenge(), valid = await token(value.nonce, s.now());
    await rejects(s.login(value, valid, {}, "wrong-csrf"), "invalid_csrf");
    await rejects(s.login(value, valid, { Origin: "https://evil.example" }), "invalid_origin");
    await rejects(s.login(value, valid, { Cookie: "__Host-school-preauth=invalid" }), "login_challenge_required");
    assert.equal((await first(s.db, "SELECT COUNT(*) AS n FROM school_auth_limits WHERE bucket LIKE 'google-attempt:%'")).n, 0);
    assert.equal(s.verifications(), 0);
  } finally { s.sqlite.close(); }
});

test("minute boundary resets an unconsumed nonce budget and successful login consumes it once", async () => {
  const s = setup();
  try {
    const value = await s.challenge(), invalid = await token(value.nonce, s.now(), "unknown-key");
    for (let i = 0; i < 8; i++) await rejects(s.login(value, invalid), "invalid_token");
    s.advance(59); await rejects(s.login(value, invalid), "login_rate_limit");
    s.advance(1);
    const successful = await s.login(value, await token(value.nonce, s.now()));
    assert.equal(successful.status, 200); assert.equal((await successful.json()).user.role, "student");
    assert.ok(successful.headers.getSetCookie().some((cookie) => cookie.startsWith("__Host-school-session=") && cookie.includes("HttpOnly; Secure")));
    assert.equal(s.verifications(), 9);
    await rejects(s.login(value, invalid), "login_challenge_expired");
    assert.equal(s.verifications(), 9);
    assert.equal((await first(s.db, "SELECT COUNT(*) AS n FROM school_sessions")).n, 1);
  } finally { s.sqlite.close(); }
});

test("30 students sharing a NAT have independent nonce attempt budgets", async () => {
  const s = setup();
  try {
    const natBucket = await sha256("192.0.2.42"), people = [];
    for (let i = 0; i < 30; i++) {
      const issued = await newChallenge(s.db, s.now(), natBucket);
      people.push(await getChallenge(s.request("/api/session", null, { Cookie: `__Host-school-preauth=${issued.token}` }), s.db, s.now()));
    }
    assert.equal(new Set(people.map((person) => person.token_hash)).size, 30);
    for (const person of people) {
      for (let i = 0; i < 8; i++) await limitGoogleAttempt(s.db, person, s.now());
      await rejects(limitGoogleAttempt(s.db, person, s.now()), "login_rate_limit");
    }
    assert.equal((await first(s.db, "SELECT COUNT(*) AS n FROM school_auth_limits WHERE bucket LIKE 'google-attempt:%'")).n, 30);
    assert.equal((await first(s.db, "SELECT counter FROM school_auth_limits WHERE bucket=?", natBucket)).counter, 30);
  } finally { s.sqlite.close(); }
});

test("expired challenge cannot reset a POST budget or reach Google verification", async () => {
  const s = setup();
  try {
    const value = await s.challenge(), valid = await token(value.nonce, s.now());
    s.advance(LIMITS.challengeSeconds);
    await rejects(s.login(value, valid), "login_challenge_expired");
    assert.equal(s.verifications(), 0);
    assert.equal((await first(s.db, "SELECT COUNT(*) AS n FROM school_auth_limits WHERE bucket LIKE 'google-attempt:%'")).n, 0);
  } finally { s.sqlite.close(); }
});

test("concurrent valid exchanges still issue only one session for a nonce", async () => {
  const s = setup();
  try {
    const value = await s.challenge(), valid = await token(value.nonce, s.now());
    const results = await Promise.allSettled([s.login(value, valid), s.login(value, valid)]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected" && result.reason.code === "login_challenge_expired").length, 1);
    assert.equal((await first(s.db, "SELECT COUNT(*) AS n FROM school_sessions")).n, 1);
  } finally { s.sqlite.close(); }
});
