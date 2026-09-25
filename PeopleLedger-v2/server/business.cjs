'use strict';
const E=require('../dist/core.js');
const RULE_VERSION='PL-INTEGRATED-2026.09-v1';
function reconcile(ledger,bank){
  const key=r=>[r.reference,r.currency,E.cents(r.amount),r.type?(r.type==='income'?'in':'out'):r.direction].join('|');
  const lg=new Map(),bg=new Map();for(const r of ledger){const k=key(r);lg.set(k,[...(lg.get(k)||[]),r]);}for(const r of bank){const k=key(r);bg.set(k,[...(bg.get(k)||[]),r]);}
  const used=new Set();const rows=ledger.map(r=>{const candidates=r.reference?(bg.get(key(r))||[]):[];const ambiguous=candidates.length>1||candidates.length===1&&lg.get(key(r)).length>1;
    const status=ambiguous?'ambiguous':candidates.length===1?'matched':'unmatched';if(status==='matched')used.add(candidates[0].id);
    return {ledgerId:r.id,reference:r.reference,amount:r.amount,direction:r.type==='income'?'in':'out',status,bankIds:candidates.map(b=>b.id)};
  });
  return {rows,unmatchedBank:bank.filter(b=>!used.has(b.id)),matched:rows.filter(r=>r.status==='matched').length,method:'Exact reference + SGD cents + direction; unique one-to-one matches only. Dates are retained for human review.'};
}
function analyze(s){
  const payroll=s.datasets.payroll,ledger=s.datasets.ledger,bank=s.datasets.bank;
  const pay=payroll.length?E.evaluate(payroll):{issues:[],totals:E.totals([]),ruleVersion:E.RULE_VERSION};const rec=reconcile(ledger,bank);
  const issues=pay.issues.map(i=>({...i,source:`payroll:${i.recordId}`}));
  const add=(rule,source,title,detail)=>issues.push({id:`${rule}:${source}`,rule,source,title,detail,severity:'blocking'});
  if(!ledger.length)add('FIN-000','dataset:ledger','No financial ledger','Import the ledger before requesting an integrated review.');
  if(!bank.length)add('BANK-000','dataset:bank','No bank statement','Import the bank statement before requesting an integrated review.');
  if(!payroll.length)add('PAY-000','dataset:payroll','No payroll','Import payroll before requesting an integrated review.');
  for(const r of rec.rows)if(r.status!=='matched')add('BANK-001',`ledger:${r.ledgerId}`,r.status==='ambiguous'?'Ambiguous bank match':'Ledger payment unmatched',`${r.reference||'Missing reference'} · SGD ${r.amount}; candidate bank IDs: ${r.bankIds.join(', ')||'none'}`);
  for(const b of rec.unmatchedBank)add('BANK-002',`bank:${b.id}`,'Bank transaction unmatched',`${b.reference||'Missing reference'} · SGD ${b.amount}`);
  const evidence=new Set(s.evidence.map(e=>e.id));
  for(const [kind,rows]of [['payroll',payroll],['ledger',ledger]])for(const r of rows){
    if(!r.costCenter)add('ORG-002',`${kind}:${r.id}`,'Missing cost center','Assign a cost center in the source file.');
    if(!r.evidence||!evidence.has(r.evidence))add('DOC-002',`${kind}:${r.id}`,'Supporting file missing',`Upload an evidence file with reference ${r.evidence||'(missing)'}.`);
  }
  for(const p of payroll){const l=ledger.filter(r=>r.category==='payroll'&&r.type==='expense'&&r.reference===p.evidence),employees=payroll.filter(x=>x.evidence===p.evidence);
    if(employees.length!==1||l.length!==1||E.cents(l[0].amount)!==E.cents(p.netPaid))add('LINK-001',`payroll:${p.id}`,'Payroll does not link uniquely to ledger',`Expected a unique employee reference and one payroll expense with reference ${p.evidence||'(missing)'} and amount ${p.netPaid}.`);
  }
  const income=ledger.filter(x=>x.type==='income').reduce((a,r)=>a+E.cents(r.amount),0),expense=ledger.filter(x=>x.type==='expense').reduce((a,r)=>a+E.cents(r.amount),0);
  for(const l of ledger.filter(r=>r.category==='payroll'))if(l.type!=='expense'||payroll.filter(p=>p.evidence===l.reference).length!==1)add('LINK-002',`ledger:${l.id}`,'Payroll ledger entry has no unique employee','Each payroll expense must link to exactly one imported employee.');
  return {ruleVersion:RULE_VERSION,payrollRuleVersion:E.RULE_VERSION,revision:s.revision,payroll:pay.totals,finance:{income,expense,netMovement:income-expense,currency:'SGD'},reconciliation:rec,issues};
}
const TOOL_NAMES=['workspace_summary','payroll_checks','financial_summary','bank_reconciliation','evidence_index','read_source'];
const tools=TOOL_NAMES.map(name=>({name,description:{workspace_summary:'Read imported dataset counts, revisions, source IDs and rule findings.',payroll_checks:'Read deterministic payroll totals and findings with employee source IDs.',financial_summary:'Read exact ledger income, expense and cash movement totals in integer SGD cents.',bank_reconciliation:'Read exact one-to-one bank matches, ambiguities and unmatched transactions.',evidence_index:'Read uploaded file IDs and hashes (file contents are not sent to the model).',read_source:'Read one imported row using a source ID such as ledger:LED-001.'}[name],parameters:{type:'object',properties:name==='read_source'?{sourceId:{type:'string'}}:{},required:name==='read_source'?['sourceId']:[],additionalProperties:false}}));
function toolResult(snapshot,name,args){
  if(!TOOL_NAMES.includes(name))throw new Error('Unknown read-only tool');if(!args||typeof args!=='object'||Array.isArray(args))throw new Error('Tool arguments must be an object');
  const allowed=name==='read_source'?['sourceId']:[];if(Object.keys(args).some(k=>!allowed.includes(k))||name==='read_source'&&typeof args.sourceId!=='string')throw new Error('Invalid tool arguments');
  const a=analyze(snapshot),ids=Object.entries(snapshot.datasets).flatMap(([k,rs])=>rs.map(r=>`${k}:${r.id}`));
  if(name==='workspace_summary')return {revision:snapshot.revision,sourceIds:ids,counts:Object.fromEntries(Object.entries(snapshot.datasets).map(([k,r])=>[k,r.length])),issues:a.issues};
  if(name==='payroll_checks')return {totalsInCents:a.payroll,findings:a.issues.filter(i=>i.source.startsWith('payroll:'))};
  if(name==='financial_summary')return {totalsInCents:a.finance,rows:snapshot.datasets.ledger.map(r=>({sourceId:`ledger:${r.id}`,...r}))};
  if(name==='bank_reconciliation')return a.reconciliation;
  if(name==='evidence_index')return snapshot.evidence;
  const match=/^(payroll|ledger|bank):([A-Za-z0-9_-]{1,40})$/.exec(args.sourceId);if(!match)throw new Error('Invalid source ID');const row=snapshot.datasets[match[1]].find(r=>r.id===match[2]);if(!row)throw new Error('Source record not found');return {sourceId:args.sourceId,row};
}
module.exports={analyze,reconcile,tools,toolResult,RULE_VERSION};
