import {randomBytes,createHash} from 'node:crypto';
export function makeStudentRotation(rows){
 const seen=new Set();
 return rows.map(row=>{
  if(row.role!=='student'||!Number.isInteger(row.slot)||row.slot<1||row.slot>30||seen.has(row.user_id)||!row.password_hash)throw Error('Invalid student rotation target');
  seen.add(row.user_id);let password;
  do{password=randomBytes(18).toString('base64url');}while(!/^[A-Za-z0-9]/.test(password));
  const salt=randomBytes(32).toString('base64url');
  return {...row,newLoginId:'s-'+randomBytes(10).toString('hex').slice(0,10),password,salt,newHash:createHash('sha256').update(`${salt}:${password}`).digest('hex')};
 });
}
const quote=v=>"'"+String(v).replaceAll("'","''")+"'";
export function rotationSQL(plan,operation){
 if(!/^[a-f0-9]{32}$/.test(operation)||!plan.length||plan.length>30)throw Error('Invalid operation');
 const ids=plan.map(p=>quote(p.user_id)).join(','),matching=plan.map(p=>`(user_id=${quote(p.user_id)} AND slot=${p.slot} AND login_id=${quote(p.login_id)} AND password_hash=${quote(p.password_hash)})`).join(' OR ');
 const values=field=>'CASE user_id '+plan.map(p=>`WHEN ${quote(p.user_id)} THEN ${quote(p[field])}`).join(' ')+' END';
 const trigger='student_rotation_'+operation;
 // A single UPDATE is atomic, including its session-revocation triggers. If
 // any credential or the roster changed after planning, update zero rows.
 return `CREATE TRIGGER IF NOT EXISTS ${trigger} AFTER UPDATE OF password_hash ON school_student_credentials BEGIN DELETE FROM school_sessions WHERE user_id=NEW.user_id; END;
UPDATE school_student_credentials SET login_id=${values('newLoginId')},salt=${values('salt')},password_hash=${values('newHash')}
WHERE user_id IN (${ids}) AND (SELECT COUNT(*) FROM school_student_credentials)=${plan.length}
AND (SELECT COUNT(*) FROM school_student_credentials c JOIN school_users u ON u.id=c.user_id WHERE u.role='student' AND (${matching}))=${plan.length};
DROP TRIGGER ${trigger};`;
}
export function rotationCSV(plan){
 const cell=v=>'"'+String(v).replace(/^[=+\-@\t\r]/,"'$&").replaceAll('"','""')+'"';
 return '\ufeff'+[['番号','表示名','新しいID','新しいパスワード'],...plan.map(p=>[p.slot,p.name??'',p.newLoginId,p.password])].map(r=>r.map(cell).join(',')).join('\r\n')+'\r\n';
}
