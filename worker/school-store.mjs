import { LIMITS, cleanName, fail, parseCookies, publicAvatar, randomToken, sha256, validId } from "./school-common.mjs";

export const SESSION_COOKIE = "__Host-school-session";
export const PREAUTH_COOKIE = "__Host-school-preauth";
export const assetReservationPolicy = Object.freeze({ leaseSeconds: 15 * 60,
  uploadTimeoutMs: 120000, cleanupTimeoutMs: 5000, cleanupBatch: 10 });
export const first = (db, sql, ...values) => db.prepare(sql).bind(...values).first();
export const run = (db, sql, ...values) => db.prepare(sql).bind(...values).run();
export async function all(db, sql, ...values) { return (await db.prepare(sql).bind(...values).all()).results; }
function reservationClock(now) {
  if (!Number.isSafeInteger(now) || now < 0) fail(500, "invalid_reservation_clock");
  return now;
}

export async function newChallenge(db, now, rateBucket = "local") {
  await run(db, "DELETE FROM school_auth_limits WHERE expires_at<=?", now);
  const window = Math.floor(now / 60);
  const limit = await first(db, `INSERT INTO school_auth_limits(bucket,window_at,counter,expires_at) VALUES(?,?,1,?)
    ON CONFLICT(bucket) DO UPDATE SET counter=CASE WHEN window_at=excluded.window_at THEN counter+1 ELSE 1 END,
    window_at=excluded.window_at,expires_at=excluded.expires_at RETURNING counter`, rateBucket, window, now + 300);
  // Schools commonly share one NAT address: allow a full class and ordinary retries.
  if (limit.counter > 120) fail(429, "login_rate_limit");
  const token = randomToken(), hash = await sha256(token), nonce = randomToken(), csrf = randomToken();
  await run(db, "DELETE FROM school_auth_challenges WHERE expires_at <= ?", now);
  await run(db, "INSERT INTO school_auth_challenges(token_hash,nonce,csrf,expires_at) VALUES(?,?,?,?)", hash, nonce, csrf, now + LIMITS.challengeSeconds);
  return { token, nonce, csrf };
}
export async function getChallenge(request, db, now, optional = false) {
  const token = parseCookies(request)[PREAUTH_COOKIE];
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) { if (optional) return null; fail(401, "login_challenge_required"); }
  const hash = await sha256(token);
  const result = await first(db, "SELECT * FROM school_auth_challenges WHERE token_hash=? AND expires_at>?", hash, now);
  if (!result && !optional) fail(401, "login_challenge_expired");
  return result;
}
export async function consumeChallenge(db, challenge, now) {
  const used = await first(db, "DELETE FROM school_auth_challenges WHERE token_hash=? AND expires_at>? RETURNING token_hash", challenge.token_hash, now);
  if (!used) fail(401, "login_challenge_expired");
}
export async function limitGoogleAttempt(db, challenge, now) {
  // The authoritative challenge hash is supplied by getChallenge, never by JSON
  // or an IP header. Prefixes keep issuance and credential-attempt budgets apart.
  // One conditional SQL write admits at most eight attempts per minute even
  // across concurrent Worker isolates. Failed credentials do not consume nonce.
  const result = await first(db, `INSERT INTO school_auth_limits(bucket,window_at,counter,expires_at) VALUES(?,?,1,?)
    ON CONFLICT(bucket) DO UPDATE SET counter=CASE WHEN window_at=excluded.window_at THEN counter+1 ELSE 1 END,
    window_at=excluded.window_at,expires_at=excluded.expires_at
    WHERE school_auth_limits.window_at<>excluded.window_at OR school_auth_limits.counter<8 RETURNING counter`,
  `google-attempt:${challenge.token_hash}`, Math.floor(now / 60), challenge.expires_at);
  if (!result) fail(429, "login_rate_limit");
}
export async function createUser(db, claims, role, now) {
  const id = crypto.randomUUID();
  const color = ["#4a90e2", "#e67e22", "#2ecc71", "#9b59b6", "#e74c3c", "#16a085"][parseInt((await sha256(claims.sub)).slice(0, 4), 16) % 6];
  const avatar = JSON.stringify({ name: role === "teacher" ? "先生" : `生徒-${id.slice(0, 4)}`, color });
  return first(db, "INSERT INTO school_users(id,google_sub,role,avatar_json,created_at) VALUES(?,?,?,?,?) ON CONFLICT(google_sub) DO UPDATE SET role=excluded.role RETURNING *", id, claims.sub, role, avatar, now);
}
export async function createSession(db, userId, now) {
  const token = randomToken(), hash = await sha256(token), csrf = randomToken();
  await run(db, "DELETE FROM school_sessions WHERE expires_at<=?", now);
  await run(db, "INSERT INTO school_sessions(token_hash,user_id,csrf,expires_at,created_at) VALUES(?,?,?,?,?)", hash, userId, csrf, now + LIMITS.sessionSeconds, now);
  return { token, hash, csrf, expiresAt: now + LIMITS.sessionSeconds };
}
export async function sessionByHash(db, hash, now) {
  return first(db, "SELECT s.token_hash,s.csrf,s.expires_at,u.* FROM school_sessions s JOIN school_users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?", hash, now);
}
export async function requestSession(request, db, now, optional = false) {
  const token = parseCookies(request)[SESSION_COOKIE];
  const result = token && /^[A-Za-z0-9_-]{43}$/.test(token) ? await sessionByHash(db, await sha256(token), now) : null;
  if (!result && !optional) fail(401, "login_required");
  return result;
}
export function requireCsrf(request, session, body = null) {
  const csrf = request.headers.get("X-CSRF-Token") ?? body?.csrf;
  if (typeof csrf !== "string" || csrf !== session.csrf) fail(403, "invalid_csrf");
}
export async function getWorld(db, id) {
  if (!validId(id)) fail(404, "world_not_found");
  const world = await first(db, "SELECT * FROM school_worlds WHERE id=?", id);
  if (!world) fail(404, "world_not_found");
  return world;
}
export async function authorizeWorld(db, worldId, session, teacher = false) {
  const world = await getWorld(db, worldId);
  const membership = await first(db, "SELECT * FROM school_members WHERE world_id=? AND user_id=?", worldId, session.id);
  if (!membership) fail(403, "world_membership_required");
  if (teacher && (session.role !== "teacher" || world.teacher_id !== session.id)) fail(403, "teacher_required");
  return { world, membership };
}
export async function authorizeRoomSession(db, worldId, sessionHash, now, teacher = false) {
  // One fresh query checks revocation, current role and membership on every
  // room packet. No cached teacher/client claims and no three-query pose fan-out.
  const row = await first(db, `SELECT s.token_hash,s.csrf,s.expires_at,u.id,u.google_sub,u.role,u.avatar_json,u.created_at,
    w.teacher_id,w.name AS world_name,w.join_code,w.created_at AS world_created_at,m.pose_json,m.joined_at
    FROM school_sessions s JOIN school_users u ON u.id=s.user_id
    JOIN school_members m ON m.user_id=u.id AND m.world_id=?
    JOIN school_worlds w ON w.id=m.world_id WHERE s.token_hash=? AND s.expires_at>?`, worldId, sessionHash, now);
  if (!row) fail(401, "room_login_required");
  if (teacher && (row.role !== "teacher" || row.teacher_id !== row.id)) fail(403, "teacher_required");
  return { session: row, world: { id: worldId, teacher_id: row.teacher_id, name: row.world_name, join_code: row.join_code, created_at: row.world_created_at },
    membership: { world_id: worldId, user_id: row.id, pose_json: row.pose_json, joined_at: row.joined_at } };
}
export function worldPublic(world, teacher = false) {
  return { id: world.id, name: world.name, ...(teacher ? { joinCode: world.join_code } : {}) };
}
export async function createWorld(db, session, value, now) {
  if (session.role !== "teacher") fail(403, "teacher_required");
  const world = { id: crypto.randomUUID(), teacher_id: session.id, name: cleanName(value.name, "岡崎駅 クラスワールド"), join_code: randomToken().slice(0, 12).toUpperCase(), created_at: now };
  const result = await db.batch([
    db.prepare("INSERT INTO school_worlds(id,teacher_id,name,join_code,created_at) SELECT ?,?,?,?,? WHERE (SELECT COUNT(*) FROM school_worlds WHERE teacher_id=?)<10").bind(world.id, session.id, world.name, world.join_code, now, session.id),
    db.prepare("INSERT INTO school_members(world_id,user_id,joined_at) SELECT ?,?,? WHERE EXISTS(SELECT id FROM school_worlds WHERE id=?)").bind(world.id, session.id, now, world.id),
  ]);
  if (!result[0].meta.changes) fail(409, "world_quota_exceeded");
  return world;
}
export async function joinWorld(db, session, code, now) {
  if (typeof code !== "string" || !/^[A-Z0-9_-]{12}$/i.test(code)) fail(404, "join_code_not_found");
  const world = await first(db, "SELECT * FROM school_worlds WHERE join_code=?", code.toUpperCase());
  if (!world) fail(404, "join_code_not_found");
  if (session.role === "teacher" && world.teacher_id !== session.id) fail(403, "other_teacher_world");
  const existing = await first(db, "SELECT * FROM school_members WHERE world_id=? AND user_id=?", world.id, session.id);
  if (!existing) {
    // The INSERT performs the quota check inside a single serialized SQL write.
    const inserted = await first(db, "INSERT INTO school_members(world_id,user_id,joined_at) SELECT ?,?,? WHERE (SELECT COUNT(*) FROM school_members WHERE world_id=? AND user_id<>?)<? ON CONFLICT(world_id,user_id) DO NOTHING RETURNING user_id", world.id, session.id, now, world.id, world.teacher_id, LIMITS.students);
    if (!inserted && !await first(db, "SELECT user_id FROM school_members WHERE world_id=? AND user_id=?", world.id, session.id)) fail(409, "class_full");
  }
  return world;
}
export async function updateAvatar(db, session, value) {
  const previous = JSON.parse(session.avatar_json);
  const name = cleanName(value.name, previous.name, 20);
  const color = value.color ?? previous.color;
  if (typeof color !== "string" || !/^#[a-f0-9]{6}$/i.test(color)) fail(400, "invalid_avatar_color");
  const updated = await first(db, "UPDATE school_users SET avatar_json=? WHERE id=? RETURNING *", JSON.stringify({ name, color }), session.id);
  return publicAvatar(updated);
}
export async function reserveAsset(db, session, worldId, asset, now) {
  const cutoff = reservationClock(now) - assetReservationPolicy.leaseSeconds;
  const row = await first(db, `INSERT INTO school_assets(id,world_id,owner_id,object_key,name,up_axis,units,bytes,triangles,sha256,status,created_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,'pending',? WHERE
    (SELECT COUNT(*) FROM school_assets WHERE world_id=? AND owner_id=? AND
      (status='ready' OR (status='pending' AND created_at>=0 AND created_at>?)))<? AND
    COALESCE((SELECT SUM(bytes) FROM school_assets WHERE world_id=? AND owner_id=? AND
      (status='ready' OR (status='pending' AND created_at>=0 AND created_at>?))),0)+?<=? RETURNING id`,
  asset.id, worldId, session.id, asset.object_key, asset.name, asset.up_axis, asset.units, asset.bytes, asset.triangles, asset.sha256, now,
  worldId, session.id, cutoff, LIMITS.userAssets, worldId, session.id, cutoff, asset.bytes, LIMITS.userAssetBytes);
  if (!row) fail(409, "asset_quota_exceeded");
}
// Positive created_at is an active lease. A negative value is a private
// retirement ledger: -(cleanupNotBeforeSeconds + 1). Ready timestamps never
// change. Claim before touching R2 so a delayed finalize cannot become ready
// after its immutable bytes were removed; no schema migration is required.
export async function claimStaleAssetReservations(db, session, worldId, now) {
  reservationClock(now);
  return all(db, `UPDATE school_assets SET created_at=? WHERE status='pending'
    AND world_id=? AND owner_id=? AND id IN
    (SELECT id FROM school_assets WHERE world_id=? AND owner_id=? AND status='pending'
      AND ((created_at>=0 AND created_at<=?) OR (created_at<0 AND -created_at-1<=?))
      ORDER BY created_at,id LIMIT ?) RETURNING *`,
  -(now + 1), worldId, session.id, worldId, session.id,
  now - assetReservationPolicy.leaseSeconds, now, assetReservationPolicy.cleanupBatch);
}
export async function assetReservation(db, session, worldId, asset) {
  return first(db, "SELECT * FROM school_assets WHERE id=? AND world_id=? AND owner_id=? AND object_key=?",
    asset.id, worldId, session.id, asset.object_key);
}
export async function retireAssetReservation(db, session, worldId, asset, createdAt, cleanupNotBefore) {
  reservationClock(cleanupNotBefore);
  return first(db, `UPDATE school_assets SET created_at=? WHERE id=? AND world_id=? AND owner_id=?
    AND object_key=? AND status='pending' AND (created_at=? OR created_at<0) RETURNING *`,
  -(cleanupNotBefore + 1), asset.id, worldId, session.id, asset.object_key, createdAt);
}
export async function completeAssetReservation(db, session, worldId, asset, createdAt, now) {
  reservationClock(now);
  const row = await first(db, `UPDATE school_assets SET status='ready' WHERE id=? AND world_id=? AND owner_id=?
    AND object_key=? AND status='pending' AND created_at=? AND created_at>=0 AND created_at>? RETURNING *`,
  asset.id, worldId, session.id, asset.object_key, createdAt, now - assetReservationPolicy.leaseSeconds);
  if (!row) fail(409, "asset_reservation_expired");
  return row;
}
export async function removeRetiredAssetReservation(db, session, worldId, asset) {
  return run(db, `DELETE FROM school_assets WHERE id=? AND world_id=? AND owner_id=? AND object_key=?
    AND status='pending' AND created_at=? AND created_at<0`,
  asset.id, worldId, session.id, asset.object_key, asset.created_at);
}
export async function getAsset(db, worldId, id) {
  if (!validId(id)) fail(404, "asset_not_found");
  const asset = await first(db, "SELECT * FROM school_assets WHERE id=? AND world_id=? AND status='ready'", id, worldId);
  if (!asset) fail(404, "asset_not_found");
  return asset;
}
export function assetPublic(asset) {
  return { id: asset.id, ownerId: asset.owner_id, name: asset.name, upAxis: asset.up_axis, units: asset.units, bytes: asset.bytes, triangles: asset.triangles, sha256: asset.sha256 };
}
