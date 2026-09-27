'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {createServer}=require('./serve.cjs');
const root=path.resolve(__dirname,'..'),repo=path.resolve(root,'../..');
const slideArg=process.argv.indexOf('--slides');
const slidesDir=slideArg>=0?path.resolve(process.argv[slideArg+1]):path.join(repo,'.presentation-build/audio-work/final-rendered');
const publicDir=path.join(root,'public');
const sources=JSON.parse(fs.readFileSync(path.join(root,'download-sources.local.json'),'utf8'));
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const checks=[];
let server;
(async()=>{
 server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port;
 const verify=async(route,source)=>{
   const expected=fs.readFileSync(source),response=await fetch(base+route);
   assert.equal(response.status,200,route);
   const actual=Buffer.from(await response.arrayBuffer());
   assert.equal(hash(actual),hash(expected),'HTTP/source hash mismatch: '+route);
   checks.push({route,bytes:actual.length,sha256:hash(actual),httpStatus:response.status,sourceMatches:true});
 };
 for(let i=1;i<=20;i++){const name=`slide-${String(i).padStart(2,'0')}.png`;await verify('/assets/slides/'+name,path.join(slidesDir,name));}
 for(const kind of ['pptx','ppsx']){assert.ok(sources[kind],'Missing '+kind);await verify(`/downloads/PeopleLedger-presentation.${kind}`,sources[kind]);}
 const manifest=JSON.parse(fs.readFileSync(path.join(publicDir,'asset-manifest.json'),'utf8'));
 for(const entry of manifest.files){assert.equal(hash(fs.readFileSync(path.join(publicDir,entry.path))),entry.sha256,'Published manifest mismatch: '+entry.path);}
 const deck=JSON.parse(fs.readFileSync(path.join(publicDir,'deck.json'),'utf8'));
 assert.equal(deck.slides.length,20);assert.ok(deck.downloads.every(d=>!!d.url));
 const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):[path.join(dir,e.name)]);
 const files=walk(publicDir),bundleBytes=files.reduce((sum,file)=>sum+fs.statSync(file).size,0);
 const result={passed:true,verifiedAt:new Date().toISOString(),slides:20,audio:20,allDownloadsAvailable:true,publicFiles:files.length,publicBundleBytes:bundleBytes,publicBundleMiB:Number((bundleBytes/1024/1024).toFixed(3)),durationSeconds:deck.totalSeconds,finalSourceDirectory:slidesDir,httpChecks:checks,manifestFilesVerified:manifest.files.length};
 fs.mkdirSync(path.join(root,'qa'),{recursive:true});fs.writeFileSync(path.join(root,'qa/final-bundle-verification.json'),JSON.stringify(result,null,2));
 console.log(JSON.stringify({...result,httpChecks:checks.filter(x=>x.route.startsWith('/downloads'))},null,2));
})().catch(e=>{console.error(e.stack);process.exitCode=1}).finally(async()=>{if(server)await new Promise(r=>server.close(r));});
