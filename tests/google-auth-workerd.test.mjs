import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Log, LogLevel, Miniflare, convertV4MiniflareOptions } from "miniflare";
import { base64url } from "../worker/school-common.mjs";

// The actual verifier runs in workerd with its default global fetch and real
// WebCrypto, not an injected Node fetch. Only the external HTTP service is a
// local fixture. No network, D1, production identities or deployed endpoint.
const origin = "http://google-auth-runtime.invalid";
const audience = "workerd-fixture.apps.googleusercontent.com";
const nonce = "workerd-fixture-nonce";
const now = Math.floor(Date.now() / 1000);
const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const jwk = { ...await crypto.subtle.exportKey("jwk", pair.publicKey), kid: "workerd-fixture-key", alg: "RS256" };
const claims = { iss: "https://accounts.google.com", aud: audience, sub: "workerd-fixture-sub", email: "fixture@example.invalid",
  email_verified: true, nonce, iat: now, exp: now + 3600 };
async function credential(overrides = {}, invalidSignature = false, kid = jwk.kid) {
  const prefix = [{ alg: "RS256", kid }, { ...claims, ...overrides }]
    .map(value => base64url(new TextEncoder().encode(JSON.stringify(value)))).join(".");
  const signature = invalidSignature ? new Uint8Array(256)
    : await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(prefix));
  return `${prefix}.${base64url(signature)}`;
}
const source = `import { verifyGoogleToken } from "./worker/google-auth.mjs";
export default { async fetch(request) {
  try {
    const input = await request.json();
    const claims = await verifyGoogleToken(input.credential, { audience: ${JSON.stringify(audience)}, nonce: ${JSON.stringify(nonce)}, now: ${now} });
    return Response.json({ sub: claims.sub });
  } catch(error) { return Response.json({ error: error.code ?? "unexpected_runtime_error" }, { status: error.status ?? 500 }); }
} };`;
const bundle = await build({ stdin: { contents: source, resolveDir: fileURLToPath(new URL("../", import.meta.url)),
  sourcefile: "google-auth-runtime-entry.mjs" }, bundle: true, write: false, format: "esm", platform: "neutral", target: "es2022" });
async function runtime(task, redirectStatus = null) {
  let outboundCalls = 0;
  const mf = new Miniflare(convertV4MiniflareOptions({ name: "google-auth-runtime", host: "127.0.0.1", port: 0,
    modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-09-29",
    log: new Log(LogLevel.ERROR), cf: false, telemetry: { enabled: false },
    outboundService: async request => {
      outboundCalls++;
      assert.equal(request.url, "https://www.googleapis.com/oauth2/v3/certs");
      return new Response(JSON.stringify({ keys: [jwk] }), { status: redirectStatus ?? 200,
        headers: { "Cache-Control": "public, max-age=3600", ...(redirectStatus ? { Location: "https://untrusted.invalid/keys" } : {}) } });
    },
  }));
  const verify = async value => {
    const response = await mf.dispatchFetch(origin, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: value }) });
    return { status: response.status, body: await response.json() };
  };
  try { await task(verify, () => outboundCalls); }
  finally { await mf.dispose(); }
}

test("real workerd cold/warm global Google-key fetch preserves RSA and claim validation", { timeout: 30000 }, async () => {
  await runtime(async (verify, calls) => {
    // This cold invalid-signature request must reach the external key service.
    // redirect:"error" previously threw in workerd before any service call.
    assert.deepEqual(await verify(await credential({}, true)), { status: 401, body: { error: "invalid_token" } });
    assert.equal(calls(), 1);
    assert.deepEqual(await verify(await credential()), { status: 200, body: { sub: claims.sub } });
    for (const changed of [{ nonce: "wrong" }, { aud: "other-client" }, { azp: "other-client" }, { iss: "https://untrusted.invalid" },
      { exp: now }, { iat: now + 61 }, { iat: now - 3601 }, { email_verified: false }, { sub: {} }]) {
      assert.deepEqual(await verify(await credential(changed)), { status: 401, body: { error: "invalid_token" } });
    }
    assert.deepEqual(await verify(await credential({}, false, "unknown-key")), { status: 401, body: { error: "invalid_token" } });
    assert.equal(calls(), 1, "Warm verification/unknown keys reuse one bounded cache, not another Google request");
  });
});

test("real workerd rejects a Google-key redirect and never follows its target", { timeout: 30000 }, async () => {
  await runtime(async (verify, calls) => {
    const value = await credential();
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.deepEqual(await verify(value), { status: 503, body: { error: "google_keys_unavailable" } });
    }
    assert.equal(calls(), 1, "Redirect response is rejected and failed-fetch cooldown is retained");
  }, 302);
});
