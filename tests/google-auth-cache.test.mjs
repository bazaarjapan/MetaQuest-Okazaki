import test from "node:test";
import assert from "node:assert/strict";
import { base64url } from "../worker/school-common.mjs";
import { verifyGoogleToken } from "../worker/google-auth.mjs";

const now = 1801332000, audience = "cache-fixture.apps.googleusercontent.com", nonce = "cache-fixture-nonce";
const claims = { iss: "https://accounts.google.com", aud: audience, sub: "cache-fixture", exp: now + 3600,
  iat: now, nonce, email: "fixture@gmail.com", email_verified: true };
const keys = await Promise.all(["first-key", "rotated-key"].map(async (kid) => {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  return { pair, jwk: { ...await crypto.subtle.exportKey("jwk", pair.publicKey), kid, alg: "RS256" } };
}));
async function token(key = keys[0], kid = key.jwk.kid) {
  const head = base64url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", kid })));
  const body = base64url(new TextEncoder().encode(JSON.stringify(claims))), prefix = `${head}.${body}`;
  return `${prefix}.${base64url(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.pair.privateKey, new TextEncoder().encode(prefix)))}`;
}
function response(values = [keys[0].jwk], age = 3600) {
  return new Response(JSON.stringify({ keys: values }), { headers: { "Cache-Control": `public, max-age=${age}` } });
}
function verify(value, fetchImpl, at = now) { return verifyGoogleToken(value, { audience, nonce, now: at, fetchImpl }); }
const rejects = (promise, code) => assert.rejects(promise, (error) => error.code === code);
function gate() {
  let release, started;
  return { promise: new Promise((resolve) => { release = resolve; }), release: (...args) => release(...args),
    called: new Promise((resolve) => { started = resolve; }), started: () => started() };
}

test("unknown kid cold/serial attempts fetch Google keys once, regardless of kid variations", async () => {
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls++; assert.equal(url, "https://www.googleapis.com/oauth2/v3/certs");
    assert.equal(options.redirect, "error"); assert.ok(options.signal instanceof AbortSignal);
    return response();
  };
  for (let i = 0; i < 12; i++) await rejects(verify(await token(keys[0], `unknown-${i % 5}`), fetchImpl), "invalid_token");
  assert.equal(calls, 1);
  assert.equal((await verify(await token(), fetchImpl)).sub, claims.sub);
  assert.equal(calls, 1);
});

test("unknown-key refresh honors the exact 60-second boundary and discovers real rotation", async () => {
  let calls = 0;
  const fetchImpl = async () => response([keys[calls++ ? 1 : 0].jwk]);
  assert.equal((await verify(await token(), fetchImpl)).sub, claims.sub);
  await rejects(verify(await token(keys[1]), fetchImpl, now + 59), "invalid_token");
  assert.equal(calls, 1);
  assert.equal((await verify(await token(keys[1]), fetchImpl, now + 60)).sub, claims.sub);
  assert.equal(calls, 2);
  await rejects(verify(await token(keys[0], "another-unknown"), fetchImpl, now + 61), "invalid_token");
  assert.equal(calls, 2);
});

test("parallel cold-cache unknown keys share one in-flight request", async () => {
  const wait = gate(); let calls = 0;
  const fetchImpl = async () => { calls++; wait.started(); await wait.promise; return response(); };
  const values = await Promise.all(Array.from({ length: 24 }, (_, i) => token(keys[0], `unknown-${i}`)));
  const outcomes = values.map((value) => rejects(verify(value, fetchImpl), "invalid_token"));
  await wait.called; assert.equal(calls, 1); wait.release(); await Promise.all(outcomes);
  assert.equal(calls, 1);
});

test("parallel forced refreshes share one request and keep cached legitimate logins available", async () => {
  const wait = gate(); let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) return response();
    wait.started(); await wait.promise; return response([keys[1].jwk]);
  };
  const first = await token(), rotated = await token(keys[1]);
  await verify(first, fetchImpl);
  const pending = Array.from({ length: 24 }, () => verify(rotated, fetchImpl, now + 60));
  await wait.called; assert.equal(calls, 2);
  assert.equal((await verify(first, fetchImpl, now + 60)).sub, claims.sub);
  assert.equal(calls, 2); wait.release();
  assert.ok((await Promise.all(pending)).every((value) => value.sub === claims.sub));
  assert.equal(calls, 2);
});

test("network/status/JSON/key-shape failures reserve the cooldown and release in-flight state", async () => {
  const failures = [
    () => { throw Error("network failed"); },
    () => new Response(null, { status: 503 }),
    () => new Response("not JSON"),
    () => new Response(JSON.stringify({ keys: [null] })),
  ];
  const value = await token();
  for (const failure of failures) {
    let calls = 0;
    const fetchImpl = async () => ++calls === 1 ? failure() : response();
    await rejects(verify(value, fetchImpl), "google_keys_unavailable");
    await rejects(verify(value, fetchImpl, now + 59), "google_keys_unavailable");
    assert.equal(calls, 1);
    assert.equal((await verify(value, fetchImpl, now + 60)).sub, claims.sub);
    assert.equal(calls, 2);
  }
});

test("failed forced refresh keeps unexpired valid keys but suppresses more unknown-key fetches", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 2) throw Error("temporary outage");
    return response([keys[calls === 1 ? 0 : 1].jwk]);
  };
  const first = await token(), rotated = await token(keys[1]);
  await verify(first, fetchImpl);
  await rejects(verify(rotated, fetchImpl, now + 60), "google_keys_unavailable");
  assert.equal((await verify(first, fetchImpl, now + 61)).sub, claims.sub);
  await rejects(verify(rotated, fetchImpl, now + 61), "invalid_token");
  assert.equal(calls, 2);
  assert.equal((await verify(rotated, fetchImpl, now + 120)).sub, claims.sub);
  assert.equal(calls, 3);
});

test("expired JWKS fails closed during outage instead of verifying with stale keys", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return calls === 2 ? new Response(null, { status: 503 }) : response(undefined, 60); };
  const value = await token();
  await verify(value, fetchImpl);
  assert.equal((await verify(value, fetchImpl, now + 59)).sub, claims.sub);
  await rejects(verify(value, fetchImpl, now + 60), "google_keys_unavailable");
  await rejects(verify(value, fetchImpl, now + 61), "google_keys_unavailable");
  assert.equal(calls, 2);
  assert.equal((await verify(value, fetchImpl, now + 120)).sub, claims.sub);
  assert.equal(calls, 3);
});

test("explicit generated test JWKS still performs real RSA verification without network", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw Error("network must not be used"); };
  const options = { audience, nonce, now, jwks: [keys[0].jwk], fetchImpl };
  assert.equal((await verifyGoogleToken(await token(), options)).sub, claims.sub);
  await rejects(verifyGoogleToken(await token(keys[1]), options), "invalid_token");
  assert.equal(calls, 0);
});
