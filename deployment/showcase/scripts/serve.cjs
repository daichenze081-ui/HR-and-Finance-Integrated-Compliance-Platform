'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../public');
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.mp3':'audio/mpeg','.md':'text/markdown; charset=utf-8','.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation','.ppsx':'application/vnd.openxmlformats-officedocument.presentationml.slideshow'};
function createServer(){return http.createServer((req,res)=>{
 let file;
 try{const requested=decodeURIComponent(new URL(req.url,'http://localhost').pathname);file=path.resolve(root,'.'+(requested.endsWith('/')?requested+'index.html':requested));}catch{res.writeHead(400).end();return;}
 if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
 let stat;try{stat=fs.statSync(file);if(!stat.isFile())throw Error();}catch{res.writeHead(404).end('Not found');return;}
 const headers={'Content-Type':mime[path.extname(file)]||'application/octet-stream','Accept-Ranges':'bytes','Cache-Control':'no-store'};
 const match=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range||'');
 if(match){const start=Number(match[1]),end=Math.min(match[2]?Number(match[2]):stat.size-1,stat.size-1);if(start>end||start>=stat.size){res.writeHead(416,{'Content-Range':`bytes */${stat.size}`}).end();return;}res.writeHead(206,{...headers,'Content-Range':`bytes ${start}-${end}/${stat.size}`,'Content-Length':end-start+1});if(req.method==='HEAD')res.end();else fs.createReadStream(file,{start,end}).pipe(res);}
 else{res.writeHead(200,{...headers,'Content-Length':stat.size});if(req.method==='HEAD')res.end();else fs.createReadStream(file).pipe(res);}
 });}
if(require.main===module){const port=Number(process.env.PORT||4397);createServer().listen(port,'127.0.0.1',()=>console.log(`Showcase available at http://127.0.0.1:${port}`));}
module.exports={createServer};
