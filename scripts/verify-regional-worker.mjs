// Real workerd verification of regional source loading (no auth or mutation).
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {createDistAssetService} from './school-browser-server.mjs';
const assets=await createDistAssetService();
const {outputFiles}=await build({stdin:{contents:`
import {loadRegionalPlacement} from './worker/regional-placement.mjs';
import {validatePlacement} from './src/placement.js';
export default {async fetch(request,env){
const candidate={positions:new Float32Array([0,0,0,1,0,0,0,0,1,0,0,0,0,2,0,1,0,0]),position:[1200,9999,0],rotation:[0,0,0],scale:[1,1,1]};
try{return Response.json(validatePlacement(candidate,await loadRegionalPlacement(env.ASSETS,candidate)));}
catch(e){return Response.json({error:e.message,stack:e.stack},{status:500});}
}};`,resolveDir:process.cwd(),sourcefile:'regional-gate.mjs'},bundle:true,write:false,platform:'browser',format:'esm'});
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:outputFiles[0].text,compatibilityDate:'2026-09-29',cf:false,
 serviceBindings:{ASSETS:assets.fetch},outboundService:async request=>{
 const u=new URL(request.url);if(u.origin!=='https://cyberjapandata.gsi.go.jp'||!/^\/xyz\/dem_png\/14\/\d+\/\d+\.png$/.test(u.pathname))throw Error('Unexpected outbound request');
 const r=await fetch(u.href,{redirect:'error',signal:AbortSignal.timeout(8000)});
 return new Response(await r.arrayBuffer(),{status:r.status,headers:r.headers});
 }}));
try{const response=await mf.dispatchFetch('http://localhost/');const result=await response.json();console.log(result);if(!result.valid)process.exitCode=1;}
finally{await mf.dispose();}
