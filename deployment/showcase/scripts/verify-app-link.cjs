'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {chromium}=require('C:/Users/seasu/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const {createServer}=require('./serve.cjs');
const root=path.resolve(__dirname,'..'),pub=path.join(root,'public');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
let browser,server;
(async()=>{
 const manifest=JSON.parse(fs.readFileSync(path.join(pub,'asset-manifest.json'),'utf8'));
 // Copy only the changed UI files and refresh their hashes; media stays untouched.
 for(const name of ['index.html','styles.css']) {
   fs.copyFileSync(path.join(root,'src',name),path.join(pub,name));
   const b=fs.readFileSync(path.join(pub,name)),entry=manifest.files.find(f=>f.path===name);
   entry.bytes=b.length;entry.sha256=hash(b);
 }
 for(const entry of manifest.files){assert.equal(hash(fs.readFileSync(path.join(pub,entry.path))),entry.sha256,'Unexpected asset mutation: '+entry.path);}
 manifest.generatedAt=new Date().toISOString();
 fs.writeFileSync(path.join(pub,'asset-manifest.json'),JSON.stringify(manifest,null,2));
 server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
 browser=await chromium.launch({headless:true,channel:'msedge'});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 await page.goto('http://127.0.0.1:'+server.address().port);await page.locator('#toggle-play:not([disabled])').waitFor();
 const app=page.getByRole('link',{name:'打开应用 Open app ↗'});
 assert.equal(await app.getAttribute('href'),'https://peopleledger-app.vercel.app');
 assert.equal(await app.getAttribute('target'),'_blank');
 assert.equal(await page.locator('.header-link').getAttribute('href'),'#downloads');
 const layouts=[];
 for(const width of [1440,390,320]){
   await page.setViewportSize({width,height:844});
   assert.equal(await app.isVisible(),true);
   assert.equal(await page.locator('.header-link').isVisible(),true);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'Overflow at '+width);
   layouts.push({width,noHorizontalOverflow:true,appLinkVisible:true,downloadLinkVisible:true});
   await page.screenshot({path:path.join(root,'qa',`header-${width}.png`),clip:{x:0,y:0,width,height:Math.min(await page.locator('.masthead').evaluate(el=>el.getBoundingClientRect().height),200)}});
 }
 const result={passed:true,url:'https://peopleledger-app.vercel.app',mediaUnchanged:true,verifiedFiles:manifest.files.length,layouts};
 fs.writeFileSync(path.join(root,'qa/app-link-results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
})().catch(e=>{console.error(e.stack);process.exitCode=1}).finally(async()=>{if(browser)await browser.close();if(server)await new Promise(r=>server.close(r));});
