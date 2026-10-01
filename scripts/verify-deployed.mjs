import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const base=process.argv[2]??'https://metaquest001.gigach.net';
const results=[];const sha=b=>createHash('sha256').update(b).digest('hex');
const paths=[];
async function walk(dir){for(const e of await readdir('dist/'+dir,{withFileTypes:true})){const path=dir+e.name;if(e.isDirectory())await walk(path+'/');else if(!e.name.startsWith('_'))paths.push(path);}}
await walk('');let cursor=0;
await Promise.all(Array.from({length:8},async()=>{while(cursor<paths.length){const path=paths[cursor++];let remote;for(let attempt=0;attempt<3;attempt++){try{remote=await fetch(base+(path==='index.html'?'/':'/'+path),{signal:AbortSignal.timeout(30000)});if(remote.status===200)break;}catch(error){if(attempt===2)throw error;}}assert.equal(remote.status,200,path);const bytes=Buffer.from(await remote.arrayBuffer());assert.equal(sha(bytes),sha(await readFile('dist/'+path)),path+' digest mismatch');results.push({path,status:remote.status,bytes:bytes.length,sha256:sha(bytes)});}}));
results.sort((a,b)=>a.path.localeCompare(b.path));const response=await fetch(base);const headers=Object.fromEntries(response.headers);assert.ok(headers['content-security-policy']?.includes("default-src 'self'"));assert.match(headers['content-security-policy']??'',/connect-src 'self'[^;]*https:\/\/cyberjapandata\.gsi\.go\.jp/);assert.ok(headers['content-security-policy']?.includes('https://accounts.google.com/gsi/client'));assert.equal(headers['cross-origin-opener-policy'],'same-origin-allow-popups');assert.ok(headers['permissions-policy']?.includes('xr-spatial-tracking=(self)'));
assert.equal((await fetch(base+'/nonexistent-acceptance-check')).status,404);
await mkdir('test-results',{recursive:true});const report={base,checkedAt:new Date().toISOString(),passed:true,assets:results,securityHeaders:{csp:headers['content-security-policy'],permissionsPolicy:headers['permissions-policy']},notFound404:true};await writeFile('test-results/deployment.json',JSON.stringify(report,null,2));console.log(JSON.stringify({passed:true,base,verifiedFiles:results.length,totalBytes:results.reduce((n,r)=>n+r.bytes,0),securityHeaders:report.securityHeaders,notFound404:true}));
