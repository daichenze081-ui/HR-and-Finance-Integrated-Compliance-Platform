'use strict';
const {parentPort,workerData}=require('node:worker_threads');
const ExcelJS=require('exceljs');
(async()=>{
  const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(Buffer.from(workerData.buffer));
  const sheets=workbook.worksheets.filter(s=>s.actualRowCount>0);
  if(sheets.length>1&&!workerData.sheet)return parentPort.postMessage({needsSheet:true,sheets:sheets.map(s=>s.name)});
  const s=workerData.sheet?sheets.find(s=>s.name===workerData.sheet):sheets[0];if(!s)throw new Error('Worksheet not found');
  if(s.rowCount>501||s.columnCount>30)throw new Error('Worksheet limit: 500 data rows and 30 columns');
  const grid=[];s.eachRow(row=>{const cells=[];for(let i=1;i<=s.columnCount;i++){
    const cell=row.getCell(i),v=cell.value;
    const header=String(s.getRow(1).getCell(i).value||'').trim();
    if(row.number>1&&['id','reference','evidence','costCenter'].includes(header)&&typeof v==='number')throw new Error(`Cell ${cell.address}: store ${header} as text to preserve leading zeros`);
    if(v&&typeof v==='object'&&('formula'in v||'sharedFormula'in v||'error'in v))throw new Error(`Cell ${cell.address}: convert formulas/errors to plain values before importing`);
    if(v instanceof Date)cells.push(v.toISOString().slice(0,10));
    else if(v&&typeof v==='object')throw new Error(`Cell ${cell.address}: use plain text or numeric values`);
    else cells.push(v==null?'':String(v));
  }grid.push(cells);});parentPort.postMessage({sheet:s.name,grid});
})().catch(e=>parentPort.postMessage({error:e.message}));
