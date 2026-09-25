'use strict';
const http=require('node:http'),fs=require('node:fs/promises'),path=require('node:path');
const {Store,must}=require('./store.cjs'),{parseFile}=require('./imports.cjs'),{analyze}=require('./business.cjs'),Agent=require('./agent.cjs');
const ROOT=path.resolve(__dirname,'../dist'),EXAMPLES=path.resolve(__dirname,'../examples');
async function body(req){let size=0;const chunks=[];for await(const c of req){size+=c.length;must(size<=8*1024*1024,'Request exceeds 8 MB',413);chunks.push(c);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new Error('Invalid JSON request');}}
function binary(value){must(typeof value==='string'&&value.length<=7*1024*1024&&/^[A-Za-z0-9+/]*={0,2}$/.test(value)&&value.length%4===0,'Invalid file encoding');const b=Buffer.from(value,'base64');must(b.length>0&&b.length<=5*1024*1024,'File limit is 5 MB');return b;}
function createApp({dbPath=process.env.PEOPLELEDGER_DB||path.resolve(__dirname,'../data/peopleledger.sqlite'),agent=Agent}={}){
  const store=new Store(dbPath);let activeRun=false;
  for(const r of store.runs())if(r.status==='running'){r.status='failed';r.error='The local server restarted before this run finished. Start a new run.';r.finishedAt=new Date().toISOString();store.saveRun(r);}
  const server=http.createServer(async(req,res)=>{
    const json=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try{
      const port=server.address()?.port,host=req.headers.host;must([`127.0.0.1:${port}`,`localhost:${port}`].includes(host),'Local access only',403);
      if(req.headers.origin)must(req.headers.origin===`http://${host}`,'Cross-origin access is not allowed',403);
      const url=new URL(req.url,`http://${host}`),route=url.pathname;
      if(route.startsWith('/api/')){
        if(req.method==='GET'){
          if(route==='/api/workspace'){const s=store.read();return json(200,{...s,analysis:analyze(s)});}
          if(route==='/api/providers')return json(200,await agent.status());
          if(route==='/api/runs')return json(200,store.runs().map(({snapshot,...r})=>({...r,revision:snapshot.revision})));
          if(route==='/api/export')return json(200,{scope:'Single-user local workspace; role selection is a workflow simulation, not authentication.',...store.read(),analysis:analyze(store.read()),runs:store.runs()});
          if(route.startsWith('/api/evidence/')){const id=decodeURIComponent(route.slice('/api/evidence/'.length)),meta=store.read().evidence.find(e=>e.id===id);must(meta,'Evidence not found',404);res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(meta.filename)}`});return res.end(store.file(id));}
          return json(404,{error:'Unknown API route'});
        }
        must(req.method==='POST','Method not allowed',405);must(req.headers['x-peopleledger-request']==='1'&&req.headers['content-type']?.startsWith('application/json'),'Use the same-origin application to submit changes',403);
        const p=await body(req);must(p&&typeof p==='object'&&!Array.isArray(p),'Request must be an object');
        if(route==='/api/import/preview'){
          must(typeof p.filename==='string'&&p.filename.length<=200,'Invalid filename');const data=binary(p.content);const result=await parseFile(p.kind,p.filename,data,p.sheet);if(result.needsSheet)return json(200,result);
          const preview=store.preview(p.kind,p.filename,data,result.rows,result.sheet);return json(200,{...preview,previousCount:store.read().datasets[p.kind].length});
        }
        if(route==='/api/import/commit'){must(typeof p.id==='string','Preview ID required');store.commit(p.id,p.role);return json(200,{ok:true});}
        if(['/api/evidence','/api/records/edit','/api/reports/rules','/api/reports/decision','/api/agent/run'].includes(route))must(Number.isInteger(p.revision)&&p.revision>0,'Workspace revision is required');
        if(route==='/api/records/edit'){store.edit(p);return json(200,{ok:true});}
        if(route==='/api/evidence'){
          must(['hr','finance'].includes(p.role),'Switch to HR or Finance to upload evidence',403);
          const data=binary(p.content);must(typeof p.filename==='string'&&p.filename.length<=200,'Invalid filename');let mime;
          if(data.subarray(0,5).toString()==='%PDF-'&&/\.pdf$/i.test(p.filename))mime='application/pdf';
          else if(data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&/\.png$/i.test(p.filename))mime='image/png';
          else if(data[0]===255&&data[1]===216&&/\.jpe?g$/i.test(p.filename))mime='image/jpeg';
          must(mime,'Use a PDF, PNG or JPEG file matching its extension');store.evidence(p.id,p.filename,mime,data,p.revision);return json(200,{ok:true});
        }
        if(route==='/api/reports/rules'){must(p.role==='finance','Switch to Finance reviewer',403);store.ruleReport(p.revision);return json(200,{ok:true});}
        if(route==='/api/reports/decision'){store.decision(p);return json(200,{ok:true});}
        if(route==='/api/agent/run'){
          must(!activeRun,'An Agent run is already in progress',409);must(p.role==='finance','Switch to Finance reviewer',403);must(['ollama','bedrock'].includes(p.provider),'Select a provider');must(typeof p.model==='string'&&p.model.length>0&&p.model.length<=300,'Select a model');must(typeof p.question==='string'&&p.question.trim().length>0&&p.question.length<=2000,'Enter a question up to 2,000 characters');
          const s=store.read();must(s.revision===p.revision,'Data changed. Refresh before running the Agent.',409);must(Object.values(s.datasets).some(r=>r.length),'Import data before running the Agent');
          const snapshot={revision:s.revision,datasets:s.datasets,imports:s.imports,evidence:s.evidence};activeRun=true;
          let id;const running=agent.execute({provider:p.provider,model:p.model,question:p.question.trim(),snapshot,onProgress:r=>{id=r.id;store.saveRun(r);}});
          running.then(run=>{if(run.status==='completed')store.report(run);}).catch(e=>{console.error('Agent persistence failed:',e.message);const run=store.runs().find(r=>r.id===id);if(run){run.status='failed';run.error='Draft could not be saved. Check database permissions and retry.';store.saveRun(run);}}).finally(()=>{activeRun=false;});
          return json(202,{id});
        }
        return json(404,{error:'Unknown API route'});
      }
      must(['GET','HEAD'].includes(req.method),'Method not allowed',405);
      const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.csv':'text/csv; charset=utf-8','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','.pdf':'application/pdf','.zip':'application/zip'};
      const examples=route.startsWith('/examples/'),root=examples?EXAMPLES:ROOT;const rel=decodeURIComponent(examples?route.slice(9):route==='/'?'/index.html':route);const file=path.resolve(root,'.'+rel);
      must(file.startsWith(root+path.sep),'Forbidden',403);const data=await fs.readFile(file);res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream'});res.end(req.method==='HEAD'?undefined:data);
    }catch(e){if(!res.headersSent)json(e.status|| (e.code==='ENOENT'?404:400),{error:e.code==='ENOENT'?'File not found':e.message});else res.end();}
  });server.requestTimeout=30000;return {server,store};
}
module.exports={createApp};
