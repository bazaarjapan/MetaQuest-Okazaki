import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import worker, { SchoolRoom } from "../worker/index.mjs";
import { enterClassroom, issueStudents, studentRoster, resetStudent, authenticateStudent } from "../worker/classroom.mjs";
import { CLASSROOM_ID } from "../worker/classroom-id.mjs";
import { createUser, createSession, updateAvatar, first, createWorld, authorizeWorld, authorizeRoomSession, requestSession } from "../worker/school-store.mjs";
const migrations = await Promise.all(["0001_school_worlds.sql","0002_single_classroom.sql"].map(file=>readFile(new URL(`../migrations/${file}`,import.meta.url),"utf8")));
const now=Math.floor(Date.now()/1000), origin="https://classroom.example";
async function fixture(t) {
  const sql=new DatabaseSync(":memory:"); migrations.forEach(text=>sql.exec(text)); t.after(()=>sql.close());
  const db={prepare(query){return {bind(...args){const statement=sql.prepare(query); return {
    async first(){return statement.get(...args)??null;}, async all(){return {results:statement.all(...args)};},
    async run(){return this.runSync();},runSync(){return {meta:{changes:Number(statement.run(...args).changes)}};}
  };},async run(){return this.bind().run();}};},async batch(statements){sql.exec("BEGIN");try{const values=statements.map(s=>s.runSync());sql.exec("COMMIT");return values;}catch(error){sql.exec("ROLLBACK");throw error;}}};
  const teacher=await createUser(db,{sub:"test-teacher"},"teacher",now), teacher2=await createUser(db,{sub:"test-teacher-2"},"teacher",now);
  const env={DB:db,ASSETS:{fetch:()=>new Response("asset")},STL_BUCKET:{},SCHOOL_ROOMS:{},GOOGLE_CLIENT_ID:"test",TEACHER_GOOGLE_SUBS:"test-teacher",APP_ORIGIN:origin,SINGLE_CLASSROOM:"true"};
  return {db,teacher,teacher2,env,sql};
}
const rejects=(task,code)=>assert.rejects(task,error=>error.code===code);
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
