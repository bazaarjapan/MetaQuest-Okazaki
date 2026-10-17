import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import worker, { SchoolRoom } from "../worker/index.mjs";
import { enterClassroom, issueStudents, studentRoster, resetStudent, authenticateStudent } from "../worker/classroom.mjs";
import { CLASSROOM_ID } from "../worker/classroom-id.mjs";
import { createUser, createSession, updateAvatar, first, createWorld, joinWorld, authorizeWorld, authorizeRoomSession, requestSession } from "../worker/school-store.mjs";
const migrations = await Promise.all(["0001_school_worlds.sql","0002_single_classroom.sql","0003_unique_avatar_names.sql"].map(file=>readFile(new URL(`../migrations/${file}`,import.meta.url),"utf8")));
const now=Math.floor(Date.now()/1000), origin="https://classroom.example";
async function fixture(t) {
  const sql=new DatabaseSync(":memory:"); migrations.forEach(text=>sql.exec(text)); t.after(()=>sql.close());
  const db={prepare(query){return {bind(...args){const statement=sql.prepare(query); return {
    async first(){return statement.get(...args)??null;}, async all(){return {results:statement.all(...args)};},
    async run(){return this.runSync();},runSync(){return {meta:{changes:Number(statement.run(...args).changes)}};}
  };},async run(){return this.bind().run();}};},async batch(statements){sql.exec("BEGIN");try{const values=statements.map(s=>s.runSync());sql.exec("COMMIT");return values;}catch(error){sql.exec("ROLLBACK");throw error;}}};
  const teacher=await namedTeacher(db,"test-teacher"), teacher2=await namedTeacher(db,"test-teacher-2");
  const env={DB:db,ASSETS:{fetch:()=>new Response("asset")},STL_BUCKET:{},SCHOOL_ROOMS:{},GOOGLE_CLIENT_ID:"test",TEACHER_GOOGLE_SUBS:"test-teacher",APP_ORIGIN:origin,SINGLE_CLASSROOM:"true"};
  return {db,teacher,teacher2,env,sql};
}
const rejects=(task,code)=>assert.rejects(task,error=>error.code===code);
async function namedTeacher(db,sub) {
  const user=await createUser(db,{sub},"teacher",now);
  await updateAvatar(db,user,{name:sub});
  return first(db,"SELECT * FROM school_users WHERE id=?",user.id);
}
test("one canonical world shared by approved teachers; legacy world and its ownership are preserved",async t=>{
  const {db,teacher,teacher2}=await fixture(t);
  const legacy=await createWorld(db,teacher,{name:"legacy"},now);
  const a=await enterClassroom(db,teacher,now),b=await enterClassroom(db,teacher2,now);
  assert.equal(a.id,CLASSROOM_ID);assert.equal(a.id,b.id);
  await authorizeWorld(db,a.id,teacher2,true);
  const session=await createSession(db,teacher2.id,now);
  await authorizeRoomSession(db,a.id,session.hash,now,true);
  await rejects(()=>authorizeWorld(db,legacy.id,teacher2,true),"world_membership_required");
  assert.equal((await first(db,"SELECT COUNT(*) AS n FROM school_worlds")).n,2);
});
test("issuance is teacher-only, capped transactionally at 30, and stores no plaintext passwords",async t=>{
  const {db,teacher}=await fixture(t);
  const student=await createUser(db,{sub:"google-student"},"student",now);
  await rejects(()=>issueStudents(db,student,{count:1},now),"teacher_required");
  const result=await issueStudents(db,teacher,{count:29},now);
  assert.equal(result.length,29);assert.equal(new Set(result.map(row=>row.password)).size,29);
  assert.ok(result.every(row=>row.password.length===24));
  const attempts=await Promise.allSettled([issueStudents(db,teacher,{count:1},now),issueStudents(db,teacher,{count:1},now)]);
  assert.equal(attempts.filter(row=>row.status==="fulfilled").length,1);
  assert.equal((await studentRoster(db,teacher)).length,30);
  assert.equal((await first(db,"SELECT COUNT(*) AS n FROM school_users WHERE role='student'")).n,31,"no orphan user after rolled back issuance");
  const persisted=JSON.stringify((await db.prepare("SELECT * FROM school_student_credentials").bind().all()).results);
  result.forEach(row=>assert.ok(!persisted.includes(row.password)));
  await rejects(()=>enterClassroom(db,student,now),"student_id_required");
});
test("first login requires a name; relogin retains identity, name and world; reset revokes old sessions",async t=>{
  const {db,teacher}=await fixture(t);
  const [issued]=await issueStudents(db,teacher,{count:1},now);
  const login=await authenticateStudent(db,issued,now,"test"); assert.equal(login.user.namePending,true);
  let user=await first(db,"SELECT * FROM school_users WHERE id=?",login.user.id);
  await rejects(()=>enterClassroom(db,user,now),"name_required");
  await rejects(()=>updateAvatar(db,user,{name:" "}),"name_required");
  const updated=await updateAvatar(db,user,{name:"作品づくりさん"});assert.equal(updated.namePending,undefined);
  user=await first(db,"SELECT * FROM school_users WHERE id=?",user.id);
  assert.equal((await enterClassroom(db,user,now)).id,CLASSROOM_ID);
  const again=await authenticateStudent(db,issued,now,"test");assert.equal(again.user.id,user.id);assert.equal(again.user.name,"作品づくりさん");
  const replacement=await resetStudent(db,teacher,user.id);
  await rejects(()=>authenticateStudent(db,issued,now,"test"),"invalid_student_login");
  const oldRequest=new Request(origin,{headers:{Cookie:`__Host-school-session=${login.token}`}});
  assert.equal(await requestSession(oldRequest,db,now,true),null);
  assert.equal((await authenticateStudent(db,replacement,now,"test")).user.id,user.id);
  assert.ok(await first(db,"SELECT * FROM school_members WHERE user_id=?",user.id));
});
test("student login attempts are rate-limited across fresh challenges and identity enumeration is generic",async t=>{
  const {db,teacher}=await fixture(t); const [issued]=await issueStudents(db,teacher,{count:1},now);
  for(let i=0;i<8;i++) await rejects(()=>authenticateStudent(db,{...issued,password:"wrong"},now,"same-ip"),"invalid_student_login");
  await rejects(()=>authenticateStudent(db,issued,now,"different-ip"),"login_rate_limit");
  assert.equal((await authenticateStudent(db,issued,now+60,"different-ip")).user.id,issued.id);
});
test("real API enforces Origin, challenge and CSRF before login; credentials roster never returns hashes",async t=>{
  const {db,teacher,env}=await fixture(t);const [issued]=await issueStudents(db,teacher,{count:1},now);
  const challenge=await worker.fetch(new Request(`${origin}/api/session`),env);
  const data=await challenge.json(), cookie=challenge.headers.get("Set-Cookie").split(";")[0];
  const login=(csrf,from=origin)=>worker.fetch(new Request(`${origin}/api/auth/student`,{method:"POST",headers:{Origin:from,Cookie:cookie,"Content-Type":"application/json"},body:JSON.stringify({...issued,csrf})}),env);
  assert.equal((await login(data.csrf,"https://evil.example")).status,403);
  assert.equal((await login("wrong")).status,403);
  const good=await login(data.csrf);assert.equal(good.status,200);assert.match(good.headers.get("Set-Cookie"),/HttpOnly; Secure; SameSite=Lax/);
  assert.equal((await login(data.csrf)).status,401);
  const user=await good.json(), sessionCookie=good.headers.getSetCookie().find(v=>v.startsWith("__Host-school-session=")).split(";")[0];
  const roster=await worker.fetch(new Request(`${origin}/api/classroom/students`,{headers:{Cookie:sessionCookie}}),env);assert.equal(roster.status,403);
  const enter=await worker.fetch(new Request(`${origin}/api/classroom/enter`,{method:"POST",headers:{Origin:origin,Cookie:sessionCookie,"X-CSRF-Token":user.csrf}}),env);assert.equal(enter.status,409);
  assert.equal((await worker.fetch(new Request(`${origin}/api/config`),env).then(r=>r.json())).singleClassroom,true);
});
test("shared room prevents duplicate slot placement and even teachers cannot retrieve another owner's object",async()=>{
  const object={id:crypto.randomUUID(),assetId:crypto.randomUUID(),ownerId:"student"};
  const room={state:{objects:[object],revision:0}};
  await rejects(()=>SchoolRoom.prototype.applyEdit.call(room,{type:"object.delete",id:object.id},{id:"teacher",role:"teacher"},{id:CLASSROOM_ID}),"object_owner_required");
  await rejects(()=>SchoolRoom.prototype.applyEdit.call(room,{type:"object.create",assetId:object.assetId},{id:"student"},{id:CLASSROOM_ID}),"asset_already_placed");
  await SchoolRoom.prototype.applyEdit.call(room,{type:"object.delete",id:object.id},{id:"student"},{id:CLASSROOM_ID});
  assert.equal(room.state.objects.length,0);
});

test("a fifth rejected teacher cannot list IDs or reset a student's credentials", async t => {
  const {db,teacher,teacher2}=await fixture(t);
  const [issued]=await issueStudents(db,teacher,{count:1},now);
  await enterClassroom(db,teacher2,now);
  for (const sub of ["teacher-three", "teacher-four"]) {
    await enterClassroom(db,await namedTeacher(db,sub),now);
  }
  const fifth=await namedTeacher(db,"teacher-five");
  await rejects(()=>enterClassroom(db,fifth,now),"teacher_full");
  await rejects(()=>studentRoster(db,fifth),"world_membership_required");
  await rejects(()=>resetStudent(db,fifth,issued.id),"world_membership_required");
  assert.equal((await authenticateStudent(db,issued,now,"test")).user.id,issued.id);
  assert.equal((await studentRoster(db,teacher2)).length,1);
  assert.ok((await resetStudent(db,teacher2,issued.id)).password);
});

test("teachers and students share one atomic display-name namespace",async t=>{
  const {db,teacher}=await fixture(t);
  const issued=await issueStudents(db,teacher,{count:2},now);
  const users=await Promise.all(issued.map(v=>first(db,"SELECT * FROM school_users WHERE id=?",v.id)));
  await rejects(()=>updateAvatar(db,users[0],{name:"test-teacher"}),"name_taken");
  const results=await Promise.allSettled(users.map(u=>updateAvatar(db,u,{name:" 同じ名前 "})));
  assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
  assert.equal(results.find(r=>r.status==="rejected").reason.code,"name_taken");
  const winner=results.findIndex(r=>r.status==="fulfilled"),loser=1-winner;
  assert.equal(JSON.parse((await first(db,"SELECT avatar_json FROM school_users WHERE id=?",users[loser].id)).avatar_json).namePending,true);
  await rejects(()=>updateAvatar(db,teacher,{name:"同じ名前"}),"name_taken");
  await updateAvatar(db,users[winner],{name:"Same Name"});
  await rejects(()=>updateAvatar(db,users[loser],{name:"  SAME NAME  "}),"name_taken");
  await updateAvatar(db,users[winner],{color:"#abcdef"}); // same owner's name is allowed
  assert.equal((await authenticateStudent(db,issued[winner],now,"test")).user.name,"Same Name");
  await updateAvatar(db,users[loser],{name:"同じ名前"}); // freed name may be reused
  await updateAvatar(db,users[winner],{name:"Alice"});
  for (const name of ["Alice\u200d", "Alice\ufe0f", "Alice\u034f", "Alice\u{e0100}","Alice\ufff9","Alice\u0600","Alice\u{13430}"]) {
    await rejects(()=>updateAvatar(db,users[loser],{name}),"name_taken");
  }
});

test("canonical Japanese spellings collide and legacy non-NFC names require confirmation",async t=>{
  const {db,sql,teacher}=await fixture(t);
  const issued=await issueStudents(db,teacher,{count:2},now);
  const users=await Promise.all(issued.map(v=>first(db,"SELECT * FROM school_users WHERE id=?",v.id)));
  const name=await updateAvatar(db,users[0],{name:'か\u3099'});
  assert.equal(name.name,'が');
  await rejects(()=>updateAvatar(db,users[1],{name:'が'}),'name_taken');
  // Historical non-normalized spellings retain identity/display bytes but
  // cannot appear in a room until reconfirmed through the NFC write path.
  for(const legacyName of ['か\u3099','か\u200d\u3099']) {
    sql.exec('DROP INDEX school_users_unique_avatar_name');
    sql.prepare('UPDATE school_users SET avatar_json=? WHERE id=?').run(JSON.stringify({name:legacyName,color:'#abcdef'}),users[1].id);
    sql.exec(migrations[2]);
    const legacy=await first(db,'SELECT * FROM school_users WHERE id=?',users[1].id);
    await rejects(()=>enterClassroom(db,legacy,now),'name_required');
    await rejects(()=>updateAvatar(db,legacy,{name:legacyName}),'name_taken');
    await updateAvatar(db,legacy,{name:'別の名前'});
    assert.equal((await first(db,'SELECT * FROM school_users WHERE id=?',legacy.id)).id,legacy.id);
  }
});

test("pending names cannot mutate legacy multi-world membership either",async t=>{
  const {db,teacher}=await fixture(t),pending={...teacher,avatar_json:JSON.stringify({name:'未登録',namePending:true})};
  await rejects(()=>createWorld(db,pending,{},now),'name_required');
  const world=await createWorld(db,teacher,{},now);
  await rejects(()=>joinWorld(db,pending,world.join_code,now),'name_required');
});

test("admitted teachers with pending names cannot read or reset student credentials",async t=>{
  const {db,teacher}=await fixture(t);
  const [student]=await issueStudents(db,teacher,{count:1},now);
  const pending={...teacher,avatar_json:JSON.stringify({name:"重複",namePending:true})};
  await rejects(()=>studentRoster(db,pending),"name_required");
  await rejects(()=>resetStudent(db,pending,student.id),"name_required");
  assert.equal((await authenticateStudent(db,student,now,"test")).user.id,student.id);
});

test("migration canonical key matches writes and preserves display emoji",async t=>{
  const {db,sql,teacher}=await fixture(t);
  const issued=await issueStudents(db,teacher,{count:2},now);
  sql.exec("DROP INDEX school_users_unique_avatar_name");
  for(const [i,entry] of issued.entries()) sql.prepare("UPDATE school_users SET avatar_json=? WHERE id=?")
    .run(JSON.stringify({name:i?"Alice\u200d":"Alice",color:"#4a90e2"}),entry.id);
  sql.exec(migrations[2]);
  const rows=await Promise.all(issued.map(v=>first(db,"SELECT * FROM school_users WHERE id=?",v.id)));
  assert.equal(rows.filter(r=>JSON.parse(r.avatar_json).namePending).length,1);
  assert.ok(rows.every(r=>JSON.parse(r.avatar_json).nameKey==="alice"));
  assert.ok(rows.some(r=>JSON.parse(r.avatar_json).name==="Alice\u200d"));
  const {avatarNameKey}=await import("../worker/avatar-name-key.mjs");
  // Exercise every range boundary, including astral selectors, in SQLite and JS.
  const boundaries=[];let previous=false;
  for(let cp=0;cp<=0x10ffff;cp++) {
    const current=/[\p{Cf}\p{Default_Ignorable_Code_Point}]/u.test(String.fromCodePoint(cp));
    if(current!==previous){if(cp>0)boundaries.push(cp-1);boundaries.push(cp);}previous=current;
  }
  for(const cp of boundaries) {
    sql.exec("DROP INDEX school_users_unique_avatar_name");
    const name=`A${String.fromCodePoint(cp)}B`;
    sql.prepare("UPDATE school_users SET avatar_json=? WHERE id=?").run(JSON.stringify({name,namePending:true}),issued[0].id);
    sql.exec(migrations[2]);
    assert.equal(JSON.parse((await first(db,"SELECT * FROM school_users WHERE id=?",issued[0].id)).avatar_json).nameKey,avatarNameKey(name));
  }
});

test("new Google teachers choose a name too; repeat Google login never resets it",async t=>{
  const {db}=await fixture(t),sub="new-teacher";
  let teacher=await createUser(db,{sub},"teacher",now);
  assert.equal(JSON.parse(teacher.avatar_json).namePending,true);
  await rejects(()=>enterClassroom(db,teacher,now),"name_required");
  await updateAvatar(db,teacher,{name:"あお先生"});
  teacher=await createUser(db,{sub},"teacher",now+10);
  assert.equal(JSON.parse(teacher.avatar_json).name,"あお先生");
  assert.equal(JSON.parse(teacher.avatar_json).namePending,undefined);
  await enterClassroom(db,teacher,now);
});

test("names cannot collapse to a different rendered label; emoji and Japanese are supported",async t=>{
  const {db,teacher}=await fixture(t);
  for(const name of ["a@example.com","a\u200bb","\u2060","生徒-abcd"]) {
    await rejects(()=>updateAvatar(db,teacher,{name}),"invalid_avatar_name");
  }
  assert.equal((await updateAvatar(db,teacher,{name:"あおぞら👩‍🚀"})).name,"あおぞら👩‍🚀");
});

test("migration retains earliest duplicate and preserves IDs, credentials, memberships and work",async t=>{
  const {db,sql,teacher}=await fixture(t);
  sql.exec("DROP INDEX school_users_unique_avatar_name");
  const issued=await issueStudents(db,teacher,{count:2},now);
  for(const entry of [teacher,...issued]) sql.prepare("UPDATE school_users SET avatar_json=? WHERE id=?")
    .run(JSON.stringify({name:"同じ名前",color:"#4a90e2"}),entry.id);
  const student=await first(db,"SELECT * FROM school_users WHERE id=?",issued[0].id);
  await enterClassroom(db,student,now);
  sql.prepare("UPDATE school_members SET pose_json=? WHERE user_id=?").run('{"position":[1,2,3],"yaw":1}',student.id);
  sql.prepare("INSERT INTO school_assets VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(crypto.randomUUID(),CLASSROOM_ID,student.id,"stl-key","作品.stl","y","m",100,12,"abc","ready",now);
  sql.prepare("INSERT INTO school_snapshots VALUES(?,?,?,?,?,?)").run(crypto.randomUUID(),CLASSROOM_ID,teacher.id,7,'{"objects":[{"ownerId":"'+student.id+'","position":[1,2,3]}]}',now);
  const tables=["school_student_credentials","school_assets","school_members","school_snapshots"];
  const before=tables.map(table=>JSON.stringify(sql.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
  sql.exec(migrations[2]);
  const rows=sql.prepare("SELECT * FROM school_users ORDER BY created_at,id").all();
  assert.equal(rows.filter(r=>!JSON.parse(r.avatar_json).namePending).length,2); // other named teacher + winner
  const group=rows.filter(r=>JSON.parse(r.avatar_json).name==="同じ名前");
  assert.equal(JSON.parse(group[0].avatar_json).namePending,undefined);
  assert.ok(group.slice(1).every(r=>JSON.parse(r.avatar_json).nameConflict===true));
  assert.deepEqual(tables.map(table=>JSON.stringify(sql.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())),before);
  const pending=group.find(r=>r.id===student.id&&JSON.parse(r.avatar_json).namePending)??group.find(r=>JSON.parse(r.avatar_json).namePending);
  await rejects(()=>authorizeWorld(db,CLASSROOM_ID,pending),"name_required");
  await updateAvatar(db,pending,{name:"重複解消"});
  assert.equal((await first(db,"SELECT id FROM school_users WHERE id=?",pending.id)).id,pending.id);
  assert.deepEqual(tables.map(table=>JSON.stringify(sql.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())),before);
});
