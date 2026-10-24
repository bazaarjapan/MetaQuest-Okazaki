// Explicit one-time operator action. No credentials are printed. A private
// persisted plan makes a retry after an unknown outcome idempotent.
import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {readFile,writeFile,mkdir,readdir,lstat,chmod} from 'node:fs/promises';import {resolve,join} from 'node:path';import {randomBytes} from 'node:crypto';
import {makeStudentRotation,rotationSQL,rotationCSV} from './lib/student-rotation.mjs';
const exec=promisify(execFile),args=process.argv.slice(2),output=args[args.indexOf('--output')+1];
if(!args.includes('--output')||!output)throw Error('Specify --output with a private folder');
const folder=resolve(output),root=resolve('.');if(folder.toLowerCase().startsWith(root.toLowerCase()))throw Error('Output must be outside the repository');
const wrangler=resolve('node_modules/wrangler/bin/wrangler.js'),db='okazaki-school-worlds';
async function query(sql,mutation=false){
 const file=join(folder,'operation.sql');await writeFile(file,sql,{mode:0o600});
 // File import returns only an import summary, not SELECT rows. Read queries
 // use --command; the mutation file contains hashes/salts, never passwords.
 try{const r=await exec(process.execPath,[wrangler,'d1','execute',db,'--remote','--json',...(mutation?['--file',file,'--yes']:['--command',sql])],{windowsHide:true,maxBuffer:8*1024*1024,timeout:120000});
  const start=r.stdout.startsWith('[')?0:r.stdout.indexOf('\n[')+1;if(start===0&&!r.stdout.startsWith('['))throw Error('Missing D1 result');
  const result=JSON.parse(r.stdout.slice(start));if(!Array.isArray(result)||result.some(v=>!v.success))throw Error('D1 result failed');return result.flatMap(v=>v.results??[]);}
 catch{throw Error('D1 operation failed; private plan retained for retry. No credentials logged.');}
}
const rosterSQL=`SELECT c.slot,c.user_id,c.login_id,c.password_hash,u.role,json_extract(u.avatar_json,'$.name') AS name FROM school_student_credentials c JOIN school_users u ON u.id=c.user_id ORDER BY c.slot;`;
const countsSQL=`SELECT (SELECT COUNT(*) FROM school_users WHERE role='teacher') AS teachers,(SELECT COUNT(*) FROM school_sessions s JOIN school_users u ON u.id=s.user_id WHERE u.role='teacher') AS teacherSessions,(SELECT COUNT(*) FROM school_assets) AS assets,(SELECT COUNT(*) FROM school_members) AS members,(SELECT COUNT(*) FROM school_users) AS users;`;
await mkdir(folder,{recursive:true});
const allowedFiles=new Set(['private-plan.json','生徒ログイン配布用.csv','operation.sql','verification.json']);
if((await lstat(folder)).isSymbolicLink())throw Error('Private output must not be a link');
for(const file of await readdir(folder)){if(!allowedFiles.has(file)||(await lstat(join(folder,file))).isSymbolicLink())throw Error('Use a dedicated private output folder');}
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
let saved;try{saved=JSON.parse(await readFile(join(folder,'private-plan.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
if(!saved){const rows=await query(rosterSQL);if(!rows.length){console.log(JSON.stringify({students:0,changed:false}));process.exit(0);}
 saved={operation:randomBytes(16).toString('hex'),before:(await query(countsSQL))[0],plan:makeStudentRotation(rows)};
 await writeFile(join(folder,'private-plan.json'),JSON.stringify(saved),{flag:'wx',mode:0o600});
}
const csvPath=join(folder,'生徒ログイン配布用.csv'),csv=rotationCSV(saved.plan);
try{if(await readFile(csvPath,'utf8')!==csv)throw Error('Private CSV differs from retained plan');}
catch(error){if(error.code!=='ENOENT')throw error;await writeFile(csvPath,csv,{flag:'wx',mode:0o600});}
if(!args.includes('--apply')){console.log(JSON.stringify({planned:saved.plan.length,changed:false,output:folder}));process.exit(0);}
const current=await query(rosterSQL),already=current.length===saved.plan.length&&saved.plan.every(p=>current.some(r=>r.user_id===p.user_id&&r.login_id===p.newLoginId&&r.password_hash===p.newHash));
if(!already)await query(rotationSQL(saved.plan,saved.operation),true);
const after=await query(rosterSQL),counts=(await query(countsSQL))[0];
if(after.length!==saved.plan.length||!saved.plan.every(p=>after.some(r=>r.user_id===p.user_id&&r.slot===p.slot&&r.login_id===p.newLoginId&&r.password_hash===p.newHash)))throw Error('Rotation outcome requires investigation; private plan retained');
const remaining=await query(`SELECT COUNT(*) AS total FROM school_sessions WHERE user_id IN (${saved.plan.map(p=>"'"+p.user_id.replaceAll("'","''")+"'").join(',')});`);
// Counts can grow during live teaching; loss of users/assets/members is never
// expected. Teacher session count is reported separately (natural expiry).
for(const key of ['teachers','assets','members','users'])if(counts[key]<saved.before[key])throw Error('Unexpected data count decrease; investigate before distributing');
const report={students:saved.plan.length,rotated:true,reusedPlan:already,remainingStudentSessions:remaining[0].total,before:saved.before,after:counts,checkedAt:new Date().toISOString(),csv:join(folder,'生徒ログイン配布用.csv')};
await writeFile(join(folder,'verification.json'),JSON.stringify(report,null,2));
await writeFile(join(folder,'operation.sql'),'-- Completed. Use private-plan.json to verify/retry this same operation.\n');
console.log(JSON.stringify(report));
