'use strict';
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const E = require('../dist/core.js');
const SCHEMAS = {
  payroll: E.FIELDS,
  ledger: ['id','date','type','category','department','costCenter','amount','currency','reference','evidence','description'],
  bank: ['id','date','direction','amount','currency','reference','description']
};
function fail(ok, message) { if (!ok) throw new Error(message); }
function csvGrid(input) {
  const s=input.replace(/^\uFEFF/,''); const rows=[]; let row=[],cell='',quoted=false,closed=false;
  for(let i=0;i<s.length;i++) { const c=s[i];
    if(quoted) { if(c==='"') { if(s[i+1]==='"'){cell+='"';i++;} else {quoted=false;closed=true;} } else cell+=c; }
    else if(c===',' || c==='\n' || c==='\r') { row.push(cell);cell='';closed=false;if(c!==','){rows.push(row);row=[];if(c==='\r'&&s[i+1]==='\n')i++;} }
    else if(c==='"'){fail(!cell&&!closed,'Unexpected quote in CSV');quoted=true;}
    else {fail(!closed,'Unexpected text after a closing quote');cell+=c;}
  }
  fail(!quoted,'Unclosed quote in CSV'); if(cell||row.length||closed){row.push(cell);rows.push(row);}
  return rows.filter(r=>r.some(c=>c!==''));
}
function normalize(kind, grid) {
  const fields=SCHEMAS[kind]; fail(fields,'Unknown dataset');
  fail(grid.length>=2&&grid.length<=501,'Import 1–500 data rows with a header');
  const headers=grid[0].map(x=>String(x).trim());
  fail(headers.length===fields.length&&new Set(headers).size===fields.length&&fields.every(f=>headers.includes(f)),`Columns must be: ${fields.join(', ')}`);
  const rows=grid.slice(1).map((cells,i)=>{
    fail(cells.length===fields.length,`Row ${i+2}: expected ${fields.length} columns`);
    return Object.fromEntries(headers.map((k,j)=>[k,String(cells[j]??'').trim()]));
  });
  if(kind==='payroll') { const normalized=E.normalizeRows(rows);fail(new Set(normalized.map(x=>x.period)).size===1,'Import one payroll month at a time');return normalized; }
  const ids=new Set();
  return rows.map((row,i)=>{
    const label=`Row ${i+2}`;
    for(const [k,v] of Object.entries(row))fail(v.length<=500&&!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(v),`${label} ${k}: invalid or overlong text`);
    fail(/^[A-Za-z0-9_-]{1,40}$/.test(row.id),`${label}: invalid ID`);fail(!ids.has(row.id),`${label}: duplicate ID ${row.id}`);ids.add(row.id);
    fail(/^\d{4}-\d{2}-\d{2}$/.test(row.date)&&!isNaN(Date.parse(row.date))&&new Date(row.date).toISOString().slice(0,10)===row.date,`${label}: use a valid YYYY-MM-DD date`);
    fail(row.currency==='SGD',`${label}: this workspace supports SGD only`);
    try{const c=E.cents(row.amount);fail(c>0,'amount must be greater than zero');row.amount=(c/100).toFixed(2);}catch(e){throw new Error(`${label} amount: ${e.message}`);}
    if(kind==='ledger'){fail(['income','expense'].includes(row.type),`${label}: type must be income or expense`);fail(row.category&&row.department,`${label}: category and department are required`);}
    else fail(['in','out'].includes(row.direction),`${label}: direction must be in or out`);
    return row;
  });
}
// Bound both compressed and expanded workbooks before ExcelJS parses them in an isolated worker.
function validateZip(b) {
  let end=-1;for(let i=b.length-22;i>=Math.max(0,b.length-65557);i--)if(b.readUInt32LE(i)===0x06054b50){end=i;break;}
  fail(end>=0,'Invalid XLSX archive');const count=b.readUInt16LE(end+10),offset=b.readUInt32LE(end+16);
  fail(count>0&&count<2000&&offset<b.length,'Unsupported or oversized XLSX archive');
  let p=offset,total=0;
  for(let i=0;i<count;i++) {fail(p+46<=b.length&&b.readUInt32LE(p)===0x02014b50,'Invalid XLSX directory');const size=b.readUInt32LE(p+24);total+=size;
    fail(!(b.readUInt16LE(p+8)&1)&&size!==0xffffffff&&total<=20*1024*1024,'Encrypted, ZIP64 or expanded workbooks above 20 MB are unsupported');
    p+=46+b.readUInt16LE(p+28)+b.readUInt16LE(p+30)+b.readUInt16LE(p+32);
  }
}
async function parseFile(kind, filename, buffer, sheet) {
  fail(Buffer.isBuffer(buffer)&&buffer.length>0&&buffer.length<=5*1024*1024,'Choose a file between 1 byte and 5 MB');
  if(/\.csv$/i.test(filename))return {rows:normalize(kind,csvGrid(new TextDecoder('utf-8',{fatal:true}).decode(buffer))),sheet:null};
  fail(/\.xlsx$/i.test(filename),'Use UTF-8 CSV or .xlsx (not .xls or .xlsm)');validateZip(buffer);
  const result=await new Promise((resolve,reject)=>{
    const worker=new Worker(path.join(__dirname,'xlsx-worker.cjs'),{workerData:{buffer,sheet},resourceLimits:{maxOldGenerationSizeMb:96}});
    const timer=setTimeout(()=>{worker.terminate();reject(new Error('Workbook parsing exceeded 15 seconds'));},15000);
    worker.once('message',r=>{clearTimeout(timer);r.error?reject(new Error(r.error)):resolve(r);});worker.once('error',e=>{clearTimeout(timer);reject(e);});
    worker.once('exit',code=>{clearTimeout(timer);if(code)reject(new Error('Workbook exceeded parsing limits'));});
  });
  if(result.needsSheet)return result;
  return {rows:normalize(kind,result.grid),sheet:result.sheet};
}
module.exports={SCHEMAS,csvGrid,normalize,parseFile,validateZip};
