import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { makeStudentRotation, verifyRotationPlan, rotationSQL, rotationCSV, rotationText } from '../scripts/lib/student-rotation.mjs';
import { verifyStudentPassword } from '../worker/student-pin.mjs';

const pepper = randomBytes(32).toString('base64url');
const hash = (salt, password) => createHash('sha256').update(`${salt}:${password}`).digest('hex');
function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE school_users(id TEXT PRIMARY KEY,role TEXT,name TEXT);
    CREATE TABLE school_student_credentials(slot INTEGER,user_id TEXT,login_id TEXT UNIQUE,salt TEXT,password_hash TEXT);
    CREATE TABLE school_sessions(user_id TEXT,session TEXT);
    CREATE TABLE school_assets(owner_id TEXT,name TEXT);
    INSERT INTO school_users VALUES('one','student','練習A'),('two','student','練習B'),('teacher','teacher','先生'),('old-google','student','以前の生徒');
    INSERT INTO school_sessions VALUES('one','first'),('two','second'),('teacher','keep'),('old-google','keep-google');
    INSERT INTO school_assets VALUES('two','fictional.stl');`);
  const insert = db.prepare('INSERT INTO school_student_credentials VALUES(?,?,?,?,?)');
  for (const [i, id] of ['one', 'two'].entries()) {
    const salt='salt-'+i;
    insert.run(i+1,id,'s-000000000'+(i+1),salt,hash(salt, 'a'.repeat(24)));
  }
  return db;
}
const roster = db => db.prepare('SELECT c.*,u.role,u.name FROM school_student_credentials c JOIN school_users u ON u.id=c.user_id ORDER BY slot').all();
const sessions = db => db.prepare('SELECT session FROM school_sessions ORDER BY session').all().map(row=>row.session);

test('password-only batch preserves every ID, name, asset and non-target session; its PINs work with the Worker', async t => {
  const db=fixture(t), before=roster(db), plan=await makeStudentRotation(before,pepper);
  const sql=rotationSQL(plan,'a'.repeat(32));
  assert.doesNotMatch(sql,/SET\s+login_id/i);
  db.exec(sql);
  const after=roster(db);
  const identities=entries=>entries.map(({user_id,login_id,slot,name})=>[user_id,login_id,slot,name]);
  assert.deepEqual(identities(after),identities(before));
  assert.deepEqual(db.prepare('SELECT name FROM school_assets WHERE owner_id=?').all('two').map(row=>row.name),['fictional.stl']);
  assert.deepEqual(sessions(db),['keep','keep-google']);
  assert.equal(new Set(plan.map(p=>p.password)).size,plan.length);
  for(const [i,row] of after.entries()){
    assert.match(plan[i].password,/^[0-9]{4}$/);
    assert.ok(await verifyStudentPassword(row,plan[i].password,pepper));
    assert.equal(await verifyStudentPassword(row,'a'.repeat(24),pepper),false);
  }
  await verifyRotationPlan(plan,pepper,false);
  await assert.rejects(verifyRotationPlan(plan,randomBytes(32).toString('base64url'),false),/incompatible/);
  await assert.rejects(verifyRotationPlan(plan,pepper,true),/incompatible/);
  db.exec("INSERT INTO school_sessions VALUES('one','new-session')");
  db.exec(sql);
  assert.deepEqual(sessions(db),['keep','keep-google','new-session']);
  const next=await makeStudentRotation(after,pepper);
  assert.ok(next.every((entry,i)=>entry.password!==plan[i].password));
});

test('stale credential, role or changed roster prevents the entire batch from revoking or updating',async t=>{
  for(const change of ["UPDATE school_student_credentials SET password_hash='changed' WHERE user_id='one'", "UPDATE school_users SET role='teacher' WHERE id='two'",
    "INSERT INTO school_student_credentials VALUES(3,'three','s-0000000003','new','new')"]){
    const db=fixture(t),plan=await makeStudentRotation(roster(db),pepper);
    db.exec(change);const before=roster(db),active=sessions(db);
    db.exec(rotationSQL(plan,'b'.repeat(32)));assert.deepEqual(roster(db),before);assert.deepEqual(sessions(db),active);
  }
});

test('optional ID-and-PIN rotation preserves the previous administrative workflow and guards a failed UPDATE',async t=>{
  const db=fixture(t),before=roster(db),plan=await makeStudentRotation(before,pepper,{rotateIds:true}),active=sessions(db);
  assert.ok(plan.every((row,i)=>row.newLoginId!==before[i].login_id));
  await verifyRotationPlan(plan,pepper,true);
  const conflict=plan.map(p=>({...p,newLoginId:plan[0].newLoginId}));
  assert.throws(()=>db.exec(rotationSQL(conflict,'c'.repeat(32))));
  assert.deepEqual(roster(db),before);assert.deepEqual(sessions(db),active);
  db.exec(rotationSQL(plan,'d'.repeat(32)));
  assert.deepEqual(roster(db).map(r=>r.login_id),plan.map(p=>p.newLoginId));
});

test('handouts retain leading zeroes and contain one safe row per student',async()=>{
  await assert.rejects(makeStudentRotation([{role:'teacher',slot:1,user_id:'x',password_hash:'h'}],pepper),/Invalid student/);
  const cards=[{slot:1,name:' =TEST("x")\nname',login_id:'s-0000000001',newLoginId:'s-0000000001',password:'0042'}];
  assert.match(rotationText(cards),/1\t =TEST\("x"\) name\ts-0000000001\t0042\r\n$/);
  assert.ok(rotationCSV(cards).includes(`"' =TEST(""x"") name","s-0000000001","0042"`));
});
