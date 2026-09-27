'use strict';
// Publish only explicit presentation assets. Never copy the repository recursively.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const repo = path.resolve(root, '../..');
const args = process.argv.slice(2), options = {};
for (let i=0; i<args.length; i++) {
  if (args[i] === '--require-downloads') options.requireDownloads = true;
  else if (['--slides','--content','--audio-manifest','--pptx','--ppsx'].includes(args[i]) && args[i+1]) options[args[i].slice(2)] = path.resolve(args[++i]);
  else throw Error('Unsupported argument: ' + args[i]);
}
const build = path.join(repo, '.presentation-build');
const contentPath = options.content || path.join(build,'deck-content.json');
const manifestPath = options['audio-manifest'] || path.join(build,'audio-work/narration/audio_manifest.json');
const slidesDir = options.slides || path.join(build,'slides');
const content = JSON.parse(fs.readFileSync(contentPath,'utf8'));
const manifest = JSON.parse(fs.readFileSync(manifestPath,'utf8'));
if (!manifest.complete || content.slides.length !== 20 || manifest.slides.length !== 20) throw Error('Expected 20 complete slides and audio files');
const target = path.join(root,'public');
const allowed = new Set();
function destination(relative) {
  const resolved = path.resolve(target,relative);
  if (!resolved.startsWith(target + path.sep)) throw Error('Output escaped public directory');
  allowed.add(relative.replaceAll('\\','/'));
  fs.mkdirSync(path.dirname(resolved),{recursive:true});
  return resolved;
}
function copy(source,relative) { fs.copyFileSync(source,destination(relative)); }
function write(relative,text) { fs.writeFileSync(destination(relative),text); }
for (const name of ['index.html','styles.css','app.js']) copy(path.join(root,'src',name),name);
const slides = content.slides.map((slide,i) => {
  const audio = manifest.slides[i];
  if (String(audio.id) !== String(slide.id) || audio.index !== i+1) throw Error('Slide/audio order mismatch');
  const n=String(i+1).padStart(2,'0');
  const audioName=path.basename(audio.audio_path);
  if (!/^slide-\d{2}-\d+\.mp3$/.test(audioName)) throw Error('Unexpected audio filename');
  const audioPath=path.join(path.dirname(manifestPath),audioName);
  const hash=crypto.createHash('sha256').update(fs.readFileSync(audioPath)).digest('hex');
  if (hash !== audio.sha256) throw Error('Audio integrity mismatch: '+audioName);
  copy(path.join(slidesDir,`slide-${n}.png`),`assets/slides/slide-${n}.png`);
  copy(audioPath,`assets/narration/slide-${n}.mp3`);
  return { id:slide.id, titleZh:slide.titleZh, titleEn:slide.titleEn, narration:slide.narration,
    durationSeconds:audio.duration_seconds, image:`/assets/slides/slide-${n}.png`, audio:`/assets/narration/slide-${n}.mp3` };
});
const configPath=path.join(root,'download-sources.local.json');
let downloadSources={};
if(fs.existsSync(configPath)) downloadSources=JSON.parse(fs.readFileSync(configPath,'utf8'));
for(const kind of ['pptx','ppsx']) if(options[kind]) downloadSources[kind]=options[kind];
const downloads=[];
for(const [kind,titleZh,titleEn] of [['pptx','可编辑演示稿','PowerPoint · PPTX'],['ppsx','自动播放演示','PowerPoint Show · PPSX']]) {
  const filename=`downloads/PeopleLedger-presentation.${kind}`;
  if(downloadSources[kind]) {
    if(path.extname(downloadSources[kind]).toLowerCase()!=='.'+kind) throw Error('Expected '+kind+' extension');
    copy(downloadSources[kind],filename);
    downloads.push({titleZh,titleEn,url:'/'+filename});
  } else {
    if(options.requireDownloads) throw Error('Missing final download: '+kind);
    downloads.push({titleZh,titleEn,url:null});
  }
}
fs.writeFileSync(configPath,JSON.stringify(downloadSources,null,2));
const script=['# PeopleLedger 项目成果展示 / Project showcase','',`20 页中英文演示，中文语音总演示时长约 ${Math.round(manifest.total_show_seconds / 60)} 分钟。`,'',...slides.flatMap((s,i)=>[`## ${i+1}. ${s.titleZh}`,s.titleEn,'',s.narration,''])].join('\n');
write('downloads/PeopleLedger-narration.md',script);
downloads.push({titleZh:'中文讲解稿',titleEn:'Narration script · Markdown',url:'/downloads/PeopleLedger-narration.md'});
// English presentation assets are also explicitly allowlisted.
const englishBuild=path.join(build,'english');
const englishFinal=path.join(repo,'deliverables/PeopleLedger_English_Presentation');
if(fs.existsSync(path.join(englishFinal,'PeopleLedger_English_Narrated.pptx'))) {
  const englishContent=JSON.parse(fs.readFileSync(path.join(englishBuild,'deck-content.json'),'utf8'));
  const englishAudio=JSON.parse(fs.readFileSync(path.join(englishBuild,'narration/audio_manifest.json'),'utf8'));
  if(!englishAudio.complete || englishContent.slides.length!==20 || englishAudio.slides.length!==20) throw Error('English presentation incomplete');
  for(const name of ['index.html','app.js']) copy(path.join(root,'src/en',name),'en/'+name);
  const englishSlides=englishContent.slides.map((slide,i)=>{
    const a=englishAudio.slides[i],n=String(i+1).padStart(2,'0');
    if(String(a.id)!==String(slide.id)||a.index!==i+1)throw Error('English audio order mismatch');
    const source=path.join(englishBuild,'narration',path.basename(a.audio_path));
    if(crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex')!==a.sha256)throw Error('English audio hash mismatch');
    copy(path.join(englishBuild,'final-render',`slide-${n}.png`),`assets/en/slides/slide-${n}.png`);
    copy(source,`assets/en/narration/slide-${n}.mp3`);
    return {id:slide.id,titleZh:slide.title,titleEn:slide.subtitle,narration:slide.narration,durationSeconds:a.duration_seconds,image:`/assets/en/slides/slide-${n}.png`,audio:`/assets/en/narration/slide-${n}.mp3`};
  });
  const englishDownloads=[];
  for(const [file,published,titleZh,titleEn] of [
    ['PeopleLedger_English_Narrated.pptx','PeopleLedger-English.pptx','英文可编辑演示稿','English PowerPoint · PPTX'],
    ['PeopleLedger_English_AutoPlay.ppsx','PeopleLedger-English.ppsx','英文自动播放演示','English PowerPoint Show · PPSX'],
    ['PeopleLedger_English_Narration.md','PeopleLedger-English-narration.md','英文讲解稿','English narration script · Markdown']
  ]) {
    copy(path.join(englishFinal,file),'downloads/'+published);
    const url='/downloads/'+published;
    downloads.push({titleZh,titleEn,url});
    englishDownloads.push({titleZh:titleEn,titleEn:published.endsWith('.md')?'Read or practise the narration':'English narration embedded',url});
  }
  write('en/deck.json',JSON.stringify({project:'PeopleLedger',language:'en-US',tailSeconds:englishAudio.tail_seconds,totalSeconds:englishAudio.total_show_seconds,slides:englishSlides,downloads:englishDownloads},null,2));
}
write('deck.json',JSON.stringify({project:'PeopleLedger',language:'zh-CN',tailSeconds:manifest.tail_seconds,totalSeconds:manifest.total_show_seconds,slides,downloads},null,2));
function walk(dir) {return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):[path.relative(target,path.join(dir,e.name)).replaceAll('\\','/')]);}
// Any unexpected file stops packaging rather than silently publishing it.
allowed.add('asset-manifest.json');
for(const name of walk(target)) if(!allowed.has(name)) throw Error('Unexpected public file; review before deployment: '+name);
const files=[...allowed].filter(name=>name!=='asset-manifest.json').map(name=>{const b=fs.readFileSync(path.join(target,name));return {path:name,bytes:b.length,sha256:crypto.createHash('sha256').update(b).digest('hex')};});
write('asset-manifest.json',JSON.stringify({generatedAt:new Date().toISOString(),files},null,2));
console.log(JSON.stringify({slides:slides.length,audio:slides.length,durationSeconds:manifest.total_show_seconds,downloads:downloads.map(d=>({name:d.titleZh,available:!!d.url})),publishedFiles:files.length+1,totalBytes:files.reduce((s,f)=>s+f.bytes,0)},null,2));
