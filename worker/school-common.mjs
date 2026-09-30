export const LIMITS = Object.freeze({
  participants: 31, students: 30, stlBytes: 6 * 1024 * 1024,
  assetTriangles: 20000, userAssets: 10, userAssetBytes: 25 * 1024 * 1024,
  objects: 120, worldTriangles: 200000, objectMeters: 100,
  messageBytes: 16 * 1024, jsonBytes: 24 * 1024,
  sessionSeconds: 8 * 60 * 60, challengeSeconds: 5 * 60,
});

export class SchoolError extends Error {
  constructor(status, code, message = code) { super(message); this.status = status; this.code = code; }
}
export function fail(status, code, message) { throw new SchoolError(status, code, message); }
export function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: {
    "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff", ...headers,
  } });
}
export function errorResponse(error) {
  return json({ error: error instanceof SchoolError ? error.code : "internal_error" },
    error instanceof SchoolError ? error.status : 500);
}
export function base64url(bytes) {
  let text = "";
  for (const value of new Uint8Array(bytes)) text += String.fromCharCode(value);
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
export function decode64url(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) fail(401, "invalid_token");
  try { return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0)); }
  catch { fail(401, "invalid_token"); }
}
export function randomToken() { return base64url(crypto.getRandomValues(new Uint8Array(32))); }
export async function sha256(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((n) => n.toString(16).padStart(2, "0")).join("");
}
export function parseCookies(request) {
  const result = Object.create(null);
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    // Duplicate cookies are ambiguous, and must never select a caller's preferred identity.
    if (Object.hasOwn(result, name)) result[name] = null;
    else result[name] = part.slice(index + 1).trim();
  }
  return result;
}
export function sessionCookie(name, token, maxAge) {
  return `${name}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
export function requireOrigin(request, env) {
  const configured = env.APP_ORIGIN ?? "https://metaquest001.gigach.net";
  if (request.headers.get("Origin") !== configured || new URL(request.url).origin !== configured) fail(403, "invalid_origin");
}
export async function readBounded(request, limit) {
  const declared = request.headers.get("Content-Length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) fail(413, "body_too_large");
  if (!request.body) fail(400, "empty_body");
  const reader = request.body.getReader(), chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) { await reader.cancel(); fail(413, "body_too_large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
export async function readJson(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get("Content-Type") ?? "")) fail(415, "json_required");
  try {
    const data = JSON.parse(new TextDecoder().decode(await readBounded(request, LIMITS.jsonBytes)));
    if (!data || typeof data !== "object" || Array.isArray(data)) fail(400, "invalid_json");
    return data;
  } catch (error) { if (error instanceof SchoolError) throw error; fail(400, "invalid_json"); }
}
export function cleanName(value, fallback, maximum = 40) {
  if (value === undefined) return fallback;
  if (typeof value !== "string") fail(400, "invalid_name");
  const name = value.trim();
  if (!name || [...name].length > maximum || /[\u0000-\u001f\u007f<>]/u.test(name)) fail(400, "invalid_name");
  return name;
}
export function validId(value) { return typeof value === "string" && /^[a-f0-9-]{36}$/.test(value); }
export function requireConfigured(env) {
  if (!env.DB || !env.STL_BUCKET || !env.SCHOOL_ROOMS || !env.ASSETS || !env.GOOGLE_CLIENT_ID ||
    !(env.TEACHER_GOOGLE_SUBS || env.TEACHER_GOOGLE_EMAILS)) fail(503, "school_not_configured");
}
export function publicAvatar(user) {
  return { ...JSON.parse(user.avatar_json), id: user.id, role: user.role };
}
