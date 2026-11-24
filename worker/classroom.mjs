import { fail, randomToken, sha256, publicAvatar, requireAvatarName, LIMITS } from "./school-common.mjs";
import { first, run, all } from "./school-store.mjs";
import { CLASSROOM_ID } from "./classroom-id.mjs";
import { newStudentPin, verifyStudentPassword } from "./student-pin.mjs";

export async function enterClassroom(db, user, now) {
  if (user.role !== "teacher" && !await first(db, "SELECT user_id FROM school_student_credentials WHERE user_id=?", user.id)) fail(403, "student_id_required");
  requireAvatarName(user);
  if (user.role === "teacher") {
    await run(db, `INSERT INTO school_worlds(id,teacher_id,name,join_code,created_at) VALUES(?,?,?,?,?)
      ON CONFLICT(id) DO NOTHING`, CLASSROOM_ID, user.id, "岡崎 みんなのワールド", randomToken().slice(0,12).toUpperCase(), now);
  }
  const world = await first(db, "SELECT * FROM school_worlds WHERE id=?", CLASSROOM_ID);
  if (!world) fail(409, "classroom_not_ready");
  if (user.role === "teacher") {
    await run(db, `INSERT INTO school_members(world_id,user_id,joined_at) SELECT ?,?,? WHERE
      (SELECT COUNT(*) FROM school_members m JOIN school_users u ON u.id=m.user_id WHERE m.world_id=? AND u.role='teacher')<4
      ON CONFLICT DO NOTHING`, CLASSROOM_ID,user.id,now,CLASSROOM_ID);
    if (!await first(db,"SELECT user_id FROM school_members WHERE world_id=? AND user_id=?",CLASSROOM_ID,user.id)) fail(409,"teacher_full");
  } else await run(db, "INSERT INTO school_members(world_id,user_id,joined_at) VALUES(?,?,?) ON CONFLICT DO NOTHING", CLASSROOM_ID, user.id, now);
  return world;
}
function teacher(user) { if (user.role !== "teacher") fail(403, "teacher_required"); }
async function admittedTeacher(db, user) {
  teacher(user);
  requireAvatarName(user);
  if (!await first(db, "SELECT user_id FROM school_members WHERE world_id=? AND user_id=?", CLASSROOM_ID, user.id)) fail(403, "world_membership_required");
}
export async function studentRoster(db, user) {
  await admittedTeacher(db, user);
  return all(db, `SELECT c.slot,c.login_id AS loginId,u.id,u.avatar_json AS avatar FROM school_student_credentials c
    JOIN school_users u ON u.id=c.user_id ORDER BY c.slot`);
}
export async function issueStudents(db, user, value, now, pepper) {
  teacher(user); await enterClassroom(db, user, now);
  const count = value.count;
  if (!Number.isInteger(count) || count < 1 || count > 30) fail(400, "invalid_student_count");
  // One D1 batch transaction: concurrent teachers cannot issue beyond 30.
  const statements = [], results = [], issuedPins = new Set();
  for (let i=0; i<count; i++) {
    const id = crypto.randomUUID(), loginId = `s-${randomToken().slice(0,10).toLowerCase()}`;
    let key;
    do { key = await newStudentPin(pepper); } while (issuedPins.has(key.password));
    issuedPins.add(key.password);
    statements.push(db.prepare(`INSERT INTO school_users(id,google_sub,role,avatar_json,created_at) VALUES(?,?,'student',?,?)`)
      .bind(id, `classroom:${id}`, JSON.stringify({ name: "名前未登録", color: "#4a90e2", namePending: true }), now));
    statements.push(db.prepare(`INSERT INTO school_student_credentials(slot,user_id,login_id,salt,password_hash,created_at)
      SELECT COALESCE(MAX(slot),0)+1,?,?,?,?,? FROM school_student_credentials`).bind(id,loginId,key.salt,key.hash,now));
    results.push({ id, loginId, password: key.password });
  }
  try { await db.batch(statements); }
  catch (error) {
    if ((await first(db, "SELECT COUNT(*) AS total FROM school_student_credentials")).total + count > 30) fail(409,"class_full");
    throw error;
  }
  return results;
}
export async function resetStudent(db, user, id, pepper) {
  await admittedTeacher(db, user);
  const entry = await first(db, "SELECT * FROM school_student_credentials WHERE user_id=?", id);
  if (!entry) fail(404, "student_not_found");
  const key = await newStudentPin(pepper, entry);
  const [updated] = await db.batch([
    db.prepare("UPDATE school_student_credentials SET salt=?,password_hash=? WHERE user_id=? AND password_hash=?")
      .bind(key.salt,key.hash,id,entry.password_hash),
    db.prepare(`DELETE FROM school_sessions WHERE user_id=? AND EXISTS
      (SELECT 1 FROM school_student_credentials WHERE user_id=? AND password_hash=?)`).bind(id,id,key.hash),
  ]);
  if (!updated.meta.changes) fail(409, "student_reset_conflict");
  return { id, loginId: entry.login_id, password: key.password };
}
export async function authenticateStudent(db, value, now, bucket, pepper, beforeSession = async () => {}) {
  const loginId = typeof value.loginId === "string" ? value.loginId.trim().toLowerCase() : "";
  if (!/^s-[a-z0-9_-]{10}$/.test(loginId) || typeof value.password !== "string" || value.password.length > 128) fail(401,"invalid_student_login");
  const ipAttempt = await first(db, `INSERT INTO school_auth_limits(bucket,window_at,counter,expires_at) VALUES(?,?,1,?)
    ON CONFLICT(bucket) DO UPDATE SET counter=CASE WHEN window_at=excluded.window_at THEN counter+1 ELSE 1 END,
    window_at=excluded.window_at,expires_at=excluded.expires_at
    WHERE window_at<>excluded.window_at OR counter<120 RETURNING counter`, `student-ip:${bucket}`, Math.floor(now/60), now+120);
  if (!ipAttempt) fail(429, "login_rate_limit");
  const credential = await first(db, "SELECT * FROM school_student_credentials WHERE lower(login_id)=?", loginId);
  const account = `student-pin:${await sha256(`${loginId}:${credential?.salt ?? ""}`)}`;
  // Reserve an attempt before verifying, including concurrent requests across
  // IP addresses. A new salt grants freshly issued PINs their own budget.
  const attempt = await first(db, `INSERT INTO school_auth_limits(bucket,window_at,counter,expires_at) VALUES(?,?,1,?)
    ON CONFLICT(bucket) DO UPDATE SET
      counter=CASE WHEN expires_at<=excluded.window_at THEN 1 ELSE counter+1 END,
      window_at=CASE WHEN counter=0 OR expires_at<=excluded.window_at THEN excluded.window_at ELSE window_at END,
      expires_at=CASE WHEN counter=0 OR expires_at<=excluded.window_at THEN excluded.expires_at ELSE expires_at END
    WHERE expires_at<=excluded.window_at OR counter<5 RETURNING window_at`, account, now, now+15*60);
  if (!attempt) fail(429, "login_rate_limit");
  if (!await verifyStudentPassword(credential, value.password, pepper)) fail(401, "invalid_student_login");
  await run(db, "UPDATE school_auth_limits SET counter=counter-1 WHERE bucket=? AND window_at=? AND counter>0", account, attempt.window_at);
  await beforeSession();
  await run(db, "DELETE FROM school_sessions WHERE expires_at<=?", now);
  const token = randomToken(), csrf = randomToken();
  // Conditional insertion also rejects a password reset racing this login.
  const session = await first(db, `INSERT INTO school_sessions(token_hash,user_id,csrf,expires_at,created_at)
    SELECT ?,user_id,?,?,? FROM school_student_credentials WHERE user_id=? AND password_hash=? RETURNING user_id`,
    await sha256(token),csrf,now+LIMITS.sessionSeconds,now,credential.user_id,credential.password_hash);
  if (!session) fail(401,"invalid_student_login");
  const user = await first(db,"SELECT * FROM school_users WHERE id=?",session.user_id);
  return { token, csrf, user: publicAvatar(user) };
}
