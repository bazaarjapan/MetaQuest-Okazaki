import { decode64url, fail } from "./school-common.mjs";

const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const KEYS_RETRY_SECONDS = 60;
// Production always uses the same global fetch. A WeakMap also keeps explicit
// test fetch dependencies isolated without a reset flag or client-selectable kid cache.
const keyCaches = new WeakMap();
async function googleKeys(fetchImpl, now, force = false) {
  let cache = keyCaches.get(fetchImpl);
  if (!cache) {
    cache = { keys: null, expiresAt: 0, lastAttemptAt: -Infinity, inFlight: null };
    keyCaches.set(fetchImpl, cache);
  }
  if (!force && cache.keys && cache.expiresAt > now) return cache.keys;
  if (cache.inFlight) return cache.inFlight;
  // Count the first fetch and failed fetches too. An unknown kid must not cause
  // a second cold-cache fetch or one new Google request per invalid credential.
  if (now < cache.lastAttemptAt + KEYS_RETRY_SECONDS) {
    if (cache.keys && cache.expiresAt > now) return cache.keys;
    fail(503, "google_keys_unavailable");
  }
  cache.lastAttemptAt = now;
  const pending = (async () => {
    try {
      const response = await fetchImpl(JWKS_URL, { redirect: "error", signal: AbortSignal.timeout(10000) });
      if (!response.ok) fail(503, "google_keys_unavailable");
      const result = await response.json();
      if (!Array.isArray(result.keys) || result.keys.length > 20 || result.keys.some((key) => !key || typeof key !== "object")) fail(503, "google_keys_unavailable");
      const age = Number((response.headers.get("Cache-Control") ?? "").match(/max-age=(\d+)/)?.[1] ?? 300);
      cache.keys = result.keys;
      cache.expiresAt = now + Math.min(3600, Math.max(60, age));
      return cache.keys;
    } catch { fail(503, "google_keys_unavailable"); }
  })();
  cache.inFlight = pending;
  try { return await pending; }
  finally { if (cache.inFlight === pending) cache.inFlight = null; }
}

// Tests can pass generated public keys/fetch through dependencies; no environment flag can
// override issuer/key URLs or enable a production fake login.
export async function verifyGoogleToken(token, { audience, nonce, now = Math.floor(Date.now() / 1000), jwks, fetchImpl = fetch }) {
  if (typeof token !== "string" || token.length > 16000) fail(401, "invalid_token");
  const parts = token.split(".");
  if (parts.length !== 3) fail(401, "invalid_token");
  let header, claims;
  try {
    header = JSON.parse(new TextDecoder().decode(decode64url(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(decode64url(parts[1])));
  } catch { fail(401, "invalid_token"); }
  if (!header || header.alg !== "RS256" || typeof header.kid !== "string" || header.kid.length > 128 || header.crit) fail(401, "invalid_token");
  let keys = jwks ?? await googleKeys(fetchImpl, now);
  let key = keys.find((candidate) => candidate.kid === header.kid && candidate.kty === "RSA" && (!candidate.alg || candidate.alg === "RS256"));
  if (!key && !jwks) {
    keys = await googleKeys(fetchImpl, now, true);
    key = keys.find((candidate) => candidate.kid === header.kid && candidate.kty === "RSA" && (!candidate.alg || candidate.alg === "RS256"));
  }
  if (!key) fail(401, "invalid_token");
  let valid = false;
  try {
    const publicKey = await crypto.subtle.importKey("jwk", key, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, decode64url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  } catch { fail(401, "invalid_token"); }
  if (!valid || !claims || !["accounts.google.com", "https://accounts.google.com"].includes(claims.iss) ||
    !audience || claims.aud !== audience || (claims.azp && claims.azp !== audience) ||
    !Number.isSafeInteger(claims.exp) || claims.exp <= now || !Number.isSafeInteger(claims.iat) || claims.iat > now + 60 ||
    claims.iat < now - 3600 || !nonce || claims.nonce !== nonce ||
    typeof claims.sub !== "string" || !/^[A-Za-z0-9_-]{1,255}$/.test(claims.sub) ||
    claims.email_verified !== true || typeof claims.email !== "string" || claims.email.length > 320) fail(401, "invalid_token");
  return claims;
}
export function roleFromClaims(claims, env) {
  const list = (value) => (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  if (list(env.TEACHER_GOOGLE_SUBS).includes(claims.sub)) return "teacher";
  const authoritative = claims.email_verified === true && (claims.email.toLowerCase().endsWith("@gmail.com") || typeof claims.hd === "string" && !!claims.hd);
  if (authoritative && list(env.TEACHER_GOOGLE_EMAILS).map((item) => item.toLowerCase()).includes(claims.email.toLowerCase())) return "teacher";
  return "student";
}
