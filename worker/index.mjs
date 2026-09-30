import { LIMITS, errorResponse, fail, json, publicAvatar, readJson, requireConfigured, requireOrigin, sessionCookie, sha256 } from "./school-common.mjs";
import { verifyGoogleToken, roleFromClaims } from "./google-auth.mjs";
import { PREAUTH_COOKIE, SESSION_COOKIE, all, assetPublic, authorizeWorld, consumeChallenge, createSession, createUser, createWorld, getChallenge, joinWorld, newChallenge, requestSession, requireCsrf, run, updateAvatar, worldPublic } from "./school-store.mjs";
import { downloadAsset, uploadAsset } from "./school-assets.mjs";
export { SchoolRoom } from "./school-room.mjs";

export function roomRequest(env, worldId, session, path, method = "GET", data = null, upgrade = false) {
  const headers = { "X-School-Context": JSON.stringify({ worldId, sessionHash: session.token_hash }) };
  if (data) headers["Content-Type"] = "application/json";
  if (upgrade) headers.Upgrade = "websocket";
  // Fresh headers: never copy X-School-Context, role, userId or cookies supplied by callers.
  return env.SCHOOL_ROOMS.getByName(worldId).fetch(new Request(`https://room.internal${path}`, {
    method, headers, ...(data ? { body: JSON.stringify(data) } : {}),
  }));
}
export async function handleSchoolRequest(request, env, dependencies = {}) {
  const now = Math.floor((dependencies.now?.() ?? Date.now()) / 1000);
  const url = new URL(request.url), path = url.pathname;
  if (!path.startsWith("/api/")) return env.ASSETS.fetch(request);
  if (path === "/api/config" && request.method === "GET") {
    let configured = true;
    try { requireConfigured(env); } catch { configured = false; }
    return json({ configured, googleClientId: env.GOOGLE_CLIENT_ID ?? null, placement: "station-core", limits: LIMITS });
  }
  requireConfigured(env);
  if (request.method !== "GET" || (request.headers.get("Upgrade") ?? "").toLowerCase() === "websocket") requireOrigin(request, env);
  if (path === "/api/session" && request.method === "GET") {
    const session = await requestSession(request, env.DB, now, true);
    if (session) return json({ user: publicAvatar(session), csrf: session.csrf });
    const existing = await getChallenge(request, env.DB, now, true);
    if (existing) return json({ user: null, csrf: existing.csrf, nonce: existing.nonce });
    // Cloudflare supplies this header at the edge. Keep only a short-lived hash,
    // never log/store the raw IP; local tests have no edge header.
    const rateBucket = await sha256(request.headers.get("CF-Connecting-IP") ?? "local");
    const challenge = await newChallenge(env.DB, now, rateBucket);
    return json({ user: null, csrf: challenge.csrf, nonce: challenge.nonce }, 200,
      { "Set-Cookie": sessionCookie(PREAUTH_COOKIE, challenge.token, LIMITS.challengeSeconds) });
  }
  if (path === "/api/auth/google" && request.method === "POST") {
    const data = await readJson(request), challenge = await getChallenge(request, env.DB, now);
    if (data.csrf !== challenge.csrf) fail(403, "invalid_csrf");
    const claims = await verifyGoogleToken(data.credential, { ...(dependencies.googleVerification ?? {}),
      audience: env.GOOGLE_CLIENT_ID, nonce: challenge.nonce, now });
    await consumeChallenge(env.DB, challenge, now);
    const user = await createUser(env.DB, claims, roleFromClaims(claims, env), now);
    const session = await createSession(env.DB, user.id, now);
    const response = json({ user: publicAvatar(user), csrf: session.csrf });
    response.headers.append("Set-Cookie", sessionCookie(SESSION_COOKIE, session.token, LIMITS.sessionSeconds));
    response.headers.append("Set-Cookie", sessionCookie(PREAUTH_COOKIE, "", 0));
    return response;
  }
  const session = await requestSession(request, env.DB, now);
  if (request.method !== "GET") requireCsrf(request, session);
  if (path === "/api/auth/logout" && request.method === "POST") {
    const worlds = await all(env.DB, "SELECT world_id FROM school_members WHERE user_id=?", session.id);
    // Close this particular browser session, not other logged-in devices. If the
    // room is temporarily unavailable, DB revocation still rejects its next message.
    for (const world of worlds) { try { await roomRequest(env, world.world_id, session, "/disconnect", "POST"); } catch { /* DB remains authoritative */ } }
    await run(env.DB, "DELETE FROM school_sessions WHERE token_hash=?", session.token_hash);
    return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(SESSION_COOKIE, "", 0) });
  }
  if (path === "/api/avatar" && request.method === "PATCH") return json({ user: await updateAvatar(env.DB, session, await readJson(request)) });
  if (path === "/api/worlds" && request.method === "GET") {
    const rows = await all(env.DB, "SELECT w.* FROM school_worlds w JOIN school_members m ON m.world_id=w.id WHERE m.user_id=? ORDER BY w.created_at DESC", session.id);
    return json({ worlds: rows.map((world) => worldPublic(world, session.role === "teacher" && session.id === world.teacher_id)) });
  }
  if (path === "/api/worlds" && request.method === "POST") return json({ world: worldPublic(await createWorld(env.DB, session, await readJson(request), now), true) }, 201);
  if (path === "/api/worlds/join" && request.method === "POST") {
    const world = await joinWorld(env.DB, session, (await readJson(request)).code, now);
    return json({ world: worldPublic(world, session.role === "teacher" && session.id === world.teacher_id) });
  }
  const match = path.match(/^\/api\/worlds\/([a-f0-9-]{36})\/(state|socket|assets|save|restore)(?:\/([a-f0-9-]{36}))?$/);
  if (!match) fail(404, "not_found");
  const [, worldId, action, assetId] = match;
  await authorizeWorld(env.DB, worldId, session, ["save", "restore"].includes(action));
  if (action === "state" && !assetId && request.method === "GET") return roomRequest(env, worldId, session, "/state");
  if (action === "socket" && !assetId && request.method === "GET") {
    if ((request.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket") fail(426, "websocket_required");
    return roomRequest(env, worldId, session, "/socket", "GET", null, true);
  }
  if (action === "assets" && request.method === "POST" && !assetId) return json({ asset: await uploadAsset(request, env, session, worldId, now) }, 201);
  if (action === "assets" && request.method === "GET") {
    if (assetId) return downloadAsset(env, worldId, assetId);
    return json({ assets: (await all(env.DB, "SELECT * FROM school_assets WHERE world_id=? AND status='ready' ORDER BY created_at,id", worldId)).map(assetPublic) });
  }
  if (action === "save" && request.method === "POST" && !assetId) return roomRequest(env, worldId, session, "/save", "POST");
  if (action === "restore" && request.method === "POST" && !assetId) return roomRequest(env, worldId, session, "/restore", "POST", await readJson(request));
  fail(405, "method_not_allowed");
}
export default {
  async fetch(request, env) {
    try { return await handleSchoolRequest(request, env); }
    catch (error) { return errorResponse(error); }
  },
};
