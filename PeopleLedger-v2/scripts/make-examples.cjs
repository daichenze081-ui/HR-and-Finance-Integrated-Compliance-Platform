'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),ExcelJS=require('exceljs'),E=require('../dist/core.js');
const {csvGrid,SCHEMAS}=require('../server/imports.cjs');
(async()=>{
 const root=path.resolve(__dirname,'../examples');
 const payroll=E.parseCSV(await fs.readFile(path.join(root,'payroll-corrected.csv'),'utf8'));
 const ledger=payroll.map((p,i)=>({id:`LED-${String(i+1).padStart(3,'0')}`,date:'2026-09-24',type:'expense',category:'payroll',department:p.department,costCenter:p.costCenter,amount:p.netPaid,currency:'SGD',reference:p.evidence,evidence:p.evidence,description:`September net salary: ${p.name}`}));
 ledger.push({id:'LED-007',date:'2026-09-20',type:'income',category:'sales',department:'Sales',costCenter:'CC-400',amount:'50000.00',currency:'SGD',reference:'INV-001',evidence:'INV-001',description:'Fictional customer payment'},{id:'LED-008',date:'2026-09-21',type:'expense',category:'rent',department:'Operations',costCenter:'CC-200',amount:'4000.00',currency:'SGD',reference:'RENT-001',evidence:'RENT-001',description:'Fictional office rent'});
 const bank=ledger.map((r,i)=>({id:`BANK-${String(i+1).padStart(3,'0')}`,date:r.date,direction:r.type==='income'?'in':'out',amount:r.amount,currency:r.currency,reference:r.reference,description:r.description}));
 const csv=(rows,fields)=>[fields,...rows.map(r=>fields.map(k=>r[k]))].map(row=>row.map(v=>'"'+String(v).replaceAll('"','""')+'"').join(',')).join('\r\n')+'\r\n';
 await fs.writeFile(path.join(root,'ledger-demo.csv'),csv(ledger,SCHEMAS.ledger));await fs.writeFile(path.join(root,'bank-demo.csv'),csv(bank,SCHEMAS.bank));
 for(const [kind,rows]of Object.entries({payroll,ledger,bank})){const w=new ExcelJS.Workbook();const s=w.addWorksheet(kind);s.addRow(SCHEMAS[kind]);rows.forEach(r=>s.addRow(SCHEMAS[kind].map(k=>r[k])));s.getRow(1).font={bold:true};s.columns.forEach(c=>c.width=22);await w.xlsx.writeFile(path.join(root,kind+'.xlsx'));}
 const broken=bank.map(x=>({...x}));broken[2].amount='4750.00';await fs.writeFile(path.join(root,'bank-with-mismatch.csv'),csv(broken,SCHEMAS.bank));
 console.log('Created three Excel files, linked ledger/bank CSVs and a mismatch scenario.');
})();
