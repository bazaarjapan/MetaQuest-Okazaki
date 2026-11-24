// Explicit one-time operator action. No credentials are printed. A private
// persisted plan makes a retry after an unknown outcome idempotent.
import {execFile} from 'node:child_process';
import {promisify,parseArgs} from 'node:util';
import {readFile,writeFile,mkdir,readdir,lstat,chmod,realpath,unlink} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {makeStudentRotation,verifyRotationPlan,rotationSQL,rotationCSV,rotationText} from './lib/student-rotation.mjs';

const {values:options}=parseArgs({options:{output:{type:'string'},apply:{type:'boolean'},'rotate-ids':{type:'boolean'}}});
if(!options.output)throw Error('Specify --output with a private folder');
const pepper=process.env.STUDENT_PIN_PEPPER;
if(!/^[A-Za-z0-9_-]{43}$/.test(pepper ?? ''))throw Error('Set STUDENT_PIN_PEPPER to the deployed Worker secret');
delete process.env.STUDENT_PIN_PEPPER; // Wrangler and ACL helpers do not need the PIN pepper.
const rotateIds=Boolean(options['rotate-ids']);
const exec=promisify(execFile),folder=resolve(options.output);
const root=await realpath(fileURLToPath(new URL('../',import.meta.url)));
function outsideRepository(path){
 const rel=relative(root,path);
 return isAbsolute(rel)||rel==='..'||rel.startsWith('..'+sep);
}
if(!outsideRepository(folder))throw Error('Output must be outside the repository');
const wrangler=join(root,'node_modules/wrangler/bin/wrangler.js'),db='okazaki-school-worlds';
async function query(sql,mutation=false){
 const file=mutation ? join(folder,'operation-'+randomBytes(12).toString('hex')+'.sql') : null;
 if(file)await writeFile(file,sql,{flag:'wx',mode:0o600});
 try{
  const args=[wrangler,'d1','execute',db,'--remote','--json',...(file?['--file',file,'--yes']:['--command',sql])];
  const r=await exec(process.execPath,args,{cwd:root,windowsHide:true,maxBuffer:8*1024*1024,timeout:120000});
  const start=r.stdout.startsWith('[')?0:r.stdout.indexOf('\n[')+1;if(start===0&&!r.stdout.startsWith('['))throw Error('Missing D1 result');
  const result=JSON.parse(r.stdout.slice(start));if(!Array.isArray(result)||result.some(v=>!v.success))throw Error('D1 result failed');return result.flatMap(v=>v.results??[]);
 }catch{throw Error('D1 operation failed; private plan retained for retry. No credentials logged.');}
 finally{if(file)await unlink(file);}
}
const rosterSQL=`SELECT c.slot,c.user_id,c.login_id,c.salt,c.password_hash,u.role,json_extract(u.avatar_json,'$.name') AS name FROM school_student_credentials c JOIN school_users u ON u.id=c.user_id ORDER BY c.slot;`;
const countsSQL=`SELECT (SELECT COUNT(*) FROM school_users u WHERE role='student' AND NOT EXISTS(SELECT 1 FROM school_student_credentials c WHERE c.user_id=u.id)) AS studentsWithoutPassword,(SELECT COUNT(*) FROM school_student_credentials) AS studentSlots,(SELECT COUNT(*) FROM school_sessions s JOIN school_student_credentials c ON c.user_id=s.user_id) AS studentSessions,(SELECT COUNT(*) FROM school_users WHERE role='teacher') AS teachers,(SELECT COUNT(*) FROM school_sessions s JOIN school_users u ON u.id=s.user_id WHERE u.role='teacher') AS teacherSessions,(SELECT COUNT(*) FROM school_assets) AS assets,(SELECT COUNT(*) FROM school_members) AS members,(SELECT COUNT(*) FROM school_users) AS users;`;
await mkdir(folder,{recursive:true,mode:0o700});
if(!outsideRepository(await realpath(folder)))throw Error('Private output resolves inside the repository');
const allowedFiles=new Set(['private-plan.json','生徒ログイン配布用.csv','生徒ログイン配布用.txt','verification.json']);
if((await lstat(folder)).isSymbolicLink())throw Error('Private output must not be a link');
for(const file of await readdir(folder)){
 const stat=await lstat(join(folder,file));
 if((!allowedFiles.has(file)&&!/^operation-[a-f0-9]{24}\.sql$/.test(file))||!stat.isFile()||stat.nlink!==1)throw Error('Use a dedicated private output folder');
}
// Replace the DACL, including explicit grants, before writing secrets. Reset
// known existing files as well so retries cannot retain a shared explicit ACE.
if(process.platform==='win32'){
 const script=`$ErrorActionPreference='Stop'
$dir=$env:STUDENT_ROTATION_PRIVATE_DIR
$owner=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system=New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
$targets=@(Get-Item -LiteralPath $dir)+@(Get-ChildItem -LiteralPath $dir -Force)
foreach($target in $targets){
 if($target.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Private output must not be a reparse point'}
 if($target.PSIsContainer){$acl=New-Object System.Security.AccessControl.DirectorySecurity;$inherit=[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}else{$acl=New-Object System.Security.AccessControl.FileSecurity;$inherit=[System.Security.AccessControl.InheritanceFlags]::None}
 $acl.SetOwner($owner);$acl.SetAccessRuleProtection($true,$false)
 foreach($sid in @($owner,$system)){$rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,[System.Security.AccessControl.FileSystemRights]::FullControl,$inherit,[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow);$acl.AddAccessRule($rule)}
 $target.SetAccessControl($acl)
 $actual=$target.GetAccessControl()
 if(!$actual.AreAccessRulesProtected){throw 'Private output ACL is inherited'}
 foreach($rule in $actual.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])){if($rule.IdentityReference.Value -notin @($owner.Value,$system.Value)){throw 'Unexpected private output ACL principal'}}
}`;
 try{await exec('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,env:{...process.env,STUDENT_ROTATION_PRIVATE_DIR:folder}});}
 catch{throw Error('Cannot restrict private output permissions. No credential writes attempted.');}
}else{await chmod(folder,0o700);for(const file of await readdir(folder))await chmod(join(folder,file),0o600);}
let saved;
const planPath=join(folder,'private-plan.json');
try{saved=JSON.parse(await readFile(planPath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw Error('Private plan could not be read. Keep the original folder for recovery');}
if(!saved){
 const rows=await query(rosterSQL),before=(await query(countsSQL))[0];
 if(!rows.length){
  if(before.studentSlots!==0)throw Error('Student roster is incomplete or changed; retry before distributing');
  console.log(JSON.stringify({students:0,changed:false,studentsWithoutPassword:before.studentsWithoutPassword}));process.exit(0);
 }
 if(before.studentSlots!==rows.length)throw Error('Student roster is incomplete or changed; retry before distributing');
 const previousSessions=await query('SELECT token_hash FROM school_sessions s JOIN school_student_credentials c ON c.user_id=s.user_id');
 saved={version:2,rotateIds,previousSessions:previousSessions.map(r=>r.token_hash),operation:randomBytes(16).toString('hex'),before,plan:await makeStudentRotation(rows,pepper,{rotateIds})};
 await writeFile(planPath,JSON.stringify(saved),{flag:'wx',mode:0o600,flush:true});
}
if(saved.version!==2||saved.rotateIds!==rotateIds)throw Error('This private folder belongs to a different type of rotation. Keep it and select a new folder');
await verifyRotationPlan(saved.plan,pepper,rotateIds);
const csvPath=join(folder,'生徒ログイン配布用.csv'),textPath=join(folder,'生徒ログイン配布用.txt');
for(const [path,content] of [[csvPath,rotationCSV(saved.plan)],[textPath,rotationText(saved.plan)]]){
 try{if(await readFile(path,'utf8')!==content)throw Error('Private handout differs from retained plan');}
 catch(error){if(error.code!=='ENOENT')throw error;await writeFile(path,content,{flag:'wx',mode:0o600,flush:true});}
}
if(!options.apply){console.log(JSON.stringify({planned:saved.plan.length,changed:false,rotateIds,output:folder}));process.exit(0);}
function applied(roster){
 return roster.length===saved.plan.length&&saved.plan.every(p=>roster.some(r=>
   r.role==='student'&&r.slot===p.slot&&r.user_id===p.user_id&&r.login_id===p.newLoginId&&r.salt===p.salt&&r.password_hash===p.newHash));
}
const already=applied(await query(rosterSQL));
if(!already)await query(rotationSQL(saved.plan,saved.operation),true);
if(!applied(await query(rosterSQL)))throw Error('Credentials differ from retained plan; do not distribute this handout');
const counts=(await query(countsSQL))[0];
const activeHashes=new Set((await query('SELECT token_hash FROM school_sessions s JOIN school_student_credentials c ON c.user_id=s.user_id')).map(r=>r.token_hash));
const remainingPreviousStudentSessions=saved.previousSessions.filter(hash=>activeHashes.has(hash)).length;
if(remainingPreviousStudentSessions)throw Error('Previous student sessions remain; investigate before distributing');
// A newly signed-in student may already have a new session. Never revoke it
// on verification or retry. The UPDATE trigger only removes pre-rotation sessions.
for(const key of ['teachers','assets','members','users'])if(counts[key]<saved.before[key])throw Error('Unexpected data count decrease; investigate before distributing');
const report={students:saved.plan.length,rotated:true,loginIdsChanged:rotateIds,reusedPlan:already,remainingPreviousStudentSessions,before:saved.before,after:counts,
 checkedAt:new Date().toISOString(),csv:csvPath,handout:textPath};
await writeFile(join(folder,'verification.json'),JSON.stringify(report,null,2),{mode:0o600});
console.log(JSON.stringify(report));
