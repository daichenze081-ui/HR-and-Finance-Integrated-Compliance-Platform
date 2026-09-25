(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ComplianceEngine = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const VERSION = 1;
  const RULE_VERSION = 'DEMO-2026.09-v1';
  const ROLES = ['hr', 'finance', 'director', 'auditor'];
  const FIELDS = ['id', 'name', 'department', 'costCenter', 'period', 'basePay', 'allowances', 'deductions', 'netPaid', 'evidence'];
  const SAMPLE = [
    ['EMP-001','Siyuan Chen','Product & Engineering','CC-100','2026-09','8500','300','1800','7000','PAY-202609-001'],
    ['EMP-002','Yue Lin','Product & Engineering','CC-100','2026-09','7200','200','1400','6000','PAY-202609-002'],
    ['EMP-003','Zihan Wang','Operations','CC-200','2026-09','5800','350','1200','4750','PAY-202609-003'],
    ['EMP-004','Amir Tan','Operations','CC-200','2026-09','6200','200','1300','5100','PAY-202609-004'],
    ['EMP-005','Priya Lee','Finance','CC-300','2026-09','7800','250','1600','6450',''],
    ['EMP-006','Anning Zhao','Human Resources','','2026-09','6800','200','1400','5600','PAY-202609-006']
  ].map(row => Object.fromEntries(FIELDS.map((k,i) => [k,row[i]])));
  const count=(n,noun)=>`${n} ${noun}${n===1?'':'s'}`;
  const clone = x => JSON.parse(JSON.stringify(x));
  function assert(ok,message) { if (!ok) throw new Error(message); }
  function text(value,label,max=160,required=true,multiline=false) {
    assert(typeof value === 'string', `${label} must be text`);
    const s=value.trim();
    assert((!required || s.length>0) && s.length<=max, `${label} must contain ${required?'1':'0'}–${max} characters`);
    assert(!(multiline?/[\x00-\x08\x0b\x0c\x0e-\x1f]/:/[\x00-\x1f]/).test(s),`${label} contains unsupported control characters`);
    return s;
  }
  function cents(value) {
    const s=String(value).trim();
    assert(/^(0|[1-9]\d{0,7})(\.\d{1,2})?$/.test(s),'Amounts must be nonnegative, below 100 million and have at most two decimal places');
    const [whole,frac='']=s.split('.');
    return Number(whole)*100+Number(frac.padEnd(2,'0'));
  }
  function amount(value) { return (cents(value)/100).toFixed(2); }
  function normalizeRows(rows) {
    assert(Array.isArray(rows) && rows.length>0 && rows.length<=500,'Import between 1 and 500 employee records');
    const ids=new Set();
    return rows.map((raw,i) => {
      assert(raw && typeof raw === 'object' && !Array.isArray(raw),`Invalid format in row ${i+1}`);
      const row={};
      for (const field of ['id','name','department','costCenter','period','evidence']) row[field]=text(raw[field],`Row ${i+1} ${field}`,field==='evidence'?240:80,!['costCenter','evidence'].includes(field));
      assert(/^[A-Za-z0-9_-]{1,40}$/.test(row.id),`Row ${i+1}: employee IDs may contain only letters, numbers, hyphens and underscores`);
      assert(/^\d{4}-(0[1-9]|1[0-2])$/.test(row.period),`Row ${i+1}: period must be YYYY-MM`);
      assert(!ids.has(row.id),`Duplicate employee ID: ${row.id}`); ids.add(row.id);
      for (const field of ['basePay','allowances','deductions','netPaid']) {
        try { row[field]=amount(raw[field]); } catch(error) { throw new Error(`Row ${i+1} ${field}: ${error.message}`); }
      }
      return row;
    });
  }
  function event(state,actor,action,detail,now) {
    state.events.push({id:`EVT-${String(state.events.length+1).padStart(4,'0')}`,at:now,actor,action,detail,revision:state.revision});
  }
  function createState(now=new Date().toISOString()) {
    const state={version:VERSION,revision:1,records:normalizeRows(SAMPLE),check:null,reports:[],events:[]};
    event(state,'system','Demo initialized','Loaded six fictional employee records with three findings to resolve',now);
    return state;
  }
  function totals(rows) {
    return rows.reduce((t,r) => {
      t.gross+=cents(r.basePay)+cents(r.allowances); t.deductions+=cents(r.deductions);
      t.expected+=cents(r.basePay)+cents(r.allowances)-cents(r.deductions); t.paid+=cents(r.netPaid);
      return t;
    },{gross:0,deductions:0,expected:0,paid:0});
  }
  function evaluate(rows) {
    const normalized=normalizeRows(rows), issues=[];
    const add=(r,rule,title,detail,field) => issues.push({id:`${rule}:${r.id}`,recordId:r.id,name:r.name,rule,ruleVersion:RULE_VERSION,severity:'blocking',title,detail,field});
    for (const r of normalized) {
      const gross=cents(r.basePay)+cents(r.allowances), expected=gross-cents(r.deductions),paid=cents(r.netPaid);
      if (expected!==paid) add(r,'PAY-001','Net pay mismatch',`Expected ${(expected/100).toFixed(2)}, recorded paid ${(paid/100).toFixed(2)}, difference ${((paid-expected)/100).toFixed(2)} SGD`,'netPaid');
      if (!r.evidence) add(r,'DOC-001','Missing evidence reference','Enter a payslip or payment reference for traceability.','evidence');
      if (!r.costCenter) add(r,'ORG-001','Missing cost center','This payroll record has no assigned cost center.','costCenter');
      if (cents(r.deductions)>gross) add(r,'PAY-002','Deductions exceed gross pay','Review the entered base pay, allowances and deductions.','deductions');
    }
    return {issues,totals:totals(normalized),ruleVersion:RULE_VERSION};
  }
  function currentCheck(state) { return !!(state.check && state.check.revision===state.revision && state.check.ruleVersion===RULE_VERSION); }
  function transition(original,actor,action,payload={},now=new Date().toISOString()) {
    assert(ROLES.includes(actor),'Unknown demo role');
    const s=clone(original);
    const allow=(roles)=>assert(roles.includes(actor),'The current demo role cannot perform this action');
    if (action==='import') {
      allow(['hr']); s.records=normalizeRows(payload.rows); s.revision++;
      event(s,actor,'Employee records replaced',`Imported ${count(s.records.length,'record')}; existing reports remain as historical versions`,now);
    } else if (action==='edit') {
      allow(['hr']); const index=s.records.findIndex(r=>r.id===payload.id); assert(index>=0,'Employee record not found');
      const note=text(payload.note,'Change explanation',500,true,true);
      const before=s.records[index], updated=normalizeRows([{...before,...payload.changes,id:before.id}])[0];
      const changes=FIELDS.filter(k=>before[k]!==updated[k]).map(k=>({field:k,before:before[k],after:updated[k]}));
      assert(changes.length>0,'No changes to save'); s.records[index]=updated; s.revision++;
      event(s,actor,'Employee record updated',{recordId:before.id,note,changes},now);
    } else if (action==='check') {
      allow(['hr','finance']); s.check={...evaluate(s.records),revision:s.revision,at:now};
      event(s,actor,'Data checks run',`Found ${count(s.check.issues.length,'open finding')}; rules ${RULE_VERSION}`,now);
    } else if (action==='draft') {
      allow(['finance']); assert(currentCheck(s),'Data or rules have changed. Run checks again first');
      const report={id:`RPT-${String(s.reports.length+1).padStart(3,'0')}`,revision:s.revision,createdAt:now,createdBy:actor,status:'draft',mode:'template',records:clone(s.records),check:clone(s.check),decisions:[]};
      s.reports.unshift(report); event(s,actor,'Report draft generated',`${report.id} · Local template · Data v${s.revision}`,now);
    } else if (['review','approve','reject'].includes(action)) {
      const report=s.reports.find(r=>r.id===payload.id); assert(report,'Report not found');
      assert(report.revision===s.revision,'Data has changed. This report is read-only; run checks and generate a new version');
      assert(report.check.ruleVersion===RULE_VERSION,'Rules have changed. Run checks again and generate a new report');
      const note=text(payload.note,'Review notes',1000,true,true);
      if (action==='review') {
        allow(['finance']); assert(report.status==='draft','Only a draft can be reviewed and submitted');
        assert(report.check.issues.length===0,'Open findings remain. Correct the records, rerun checks and generate a new report');
        report.status='reviewed';
      } else if (action==='approve') {
        allow(['director']); assert(report.status==='reviewed','Finance review must be completed first'); report.status='approved';
      } else {
        allow(['director']); assert(report.status==='reviewed','Only a report awaiting director approval can be returned'); report.status='rejected';
      }
      report.decisions.push({actor,action,note,at:now}); event(s,actor,{review:'Finance review completed',approve:'Director approved',reject:'Director returned report'}[action],{reportId:report.id,note},now);
    } else throw new Error('Unknown action');
    return s;
  }
  function reportText(report) {
    const t=report.check.totals;
    return [
      'HR & Finance Review Draft',`${report.id} | Data version v${report.revision} | ${report.createdAt}`,
      'Generation: deterministic local template (no AI model used)',
      `Covers ${count(report.records.length,'employee')}; periods ${[...new Set(report.records.map(r=>r.period))].join(', ')}.`,
      `Gross pay SGD ${(t.gross/100).toFixed(2)}; deductions SGD ${(t.deductions/100).toFixed(2)}; expected net SGD ${(t.expected/100).toFixed(2)}; recorded paid SGD ${(t.paid/100).toFixed(2)}.`,
      `Rule version ${report.check.ruleVersion}; ${count(report.check.issues.length,'open finding')}.`,
      ...report.check.issues.map(i=>`[${i.rule}] ${i.recordId} ${i.name}: ${i.title}. ${i.detail}`),
      'Sources: the attached employee snapshot, evidence references and check results. References do not mean original documents were uploaded or verified.',
      'Demo scope: amount reconciliation, field completeness and approval workflow. Deductions are entered values; CPF, tax and legal compliance are not assessed. Role switching is not authentication. Local records are not a tamper-proof audit system.',
      'For human review only. This draft is not an audit opinion or compliance assurance.'
    ].join('\n\n');
  }
  function evidencePackage(state,now=new Date().toISOString()) {
    return {format:'people-ledger-evidence-v1',exportedAt:now,mode:'browser-local-demo',limitations:['Synthetic demo data by default','No identity authentication','Local records are editable, not tamper-proof','References are not verified supporting documents','No live AI, AWS, Teams, CPF or regulatory submission'],...clone(state),reports:state.reports.map(r=>({...clone(r),text:reportText(r)}))};
  }
  function toCSV(rows) {
    const quote=x=>{let v=String(x??'');if (/^[=+\-@\t\r]/.test(v))v="'"+v;return '"'+v.replace(/"/g,'""')+'"';};
    return '\uFEFF'+[FIELDS,...rows.map(r=>FIELDS.map(k=>r[k]))].map(row=>row.map(quote).join(',')).join('\r\n');
  }
  function parseCSV(input) {
    assert(typeof input==='string'&&input.length<=1024*1024,'CSV files must not exceed 1 MB');
    const src=input.replace(/^\uFEFF/,''); let rows=[],row=[],cell='',quoted=false,closed=false;
    for(let i=0;i<src.length;i++){
      const ch=src[i];
      if(quoted){if(ch==='"'){if(src[i+1]==='"'){cell+='"';i++;}else{quoted=false;closed=true;}}else cell+=ch;continue;}
      if(ch==='"'){assert(cell===''&&!closed,'Invalid CSV quoting');quoted=true;continue;}
      if(ch===','||ch==='\n'||ch==='\r'){
        row.push(cell);cell='';closed=false;
        if(ch!==','){if(ch==='\r'&&src[i+1]==='\n')i++;rows.push(row);row=[];}continue;
      }
      assert(!closed,'A CSV closing quote must be followed by a separator');cell+=ch;
    }
    assert(!quoted,'Unclosed CSV quote'); if(cell!==''||row.length||closed){row.push(cell);rows.push(row);}
    rows=rows.filter(r=>r.some(x=>x!=='')); assert(rows.length>1,'CSV must contain a header and at least one record');
    const head=rows.shift().map(x=>x.trim()); assert(head.length===FIELDS.length&&FIELDS.every(k=>head.includes(k)),'CSV headers must include all fields from the downloaded template');
    return normalizeRows(rows.map((r,i)=>{assert(r.length===head.length,`Incorrect column count in CSV row ${i+2}`);return Object.fromEntries(head.map((k,j)=>[k,r[j]]));}));
  }
  function restore(raw) {
    assert(raw&&raw.version===VERSION&&Number.isInteger(raw.revision)&&raw.revision>=1,'Incompatible saved-data version');
    assert(Array.isArray(raw.events)&&Array.isArray(raw.reports),'Invalid saved-data format');
    normalizeRows(raw.records);
    // Saved state is only for a local demo. Never trust it as proof of identity or approval.
    const timestamp=s=>typeof s==='string'&&Number.isFinite(Date.parse(s));
    const revision=n=>Number.isInteger(n)&&n>=1&&n<=raw.revision;
    function check(c) {
      assert(c&&revision(c.revision)&&timestamp(c.at)&&typeof c.ruleVersion==='string'&&Array.isArray(c.issues),'Invalid saved check format');
      assert(c.totals&&['gross','deductions','expected','paid'].every(k=>Number.isSafeInteger(c.totals[k])),'Invalid saved totals');
      assert(c.issues.every(i=>i&&['id','recordId','name','rule','ruleVersion','severity','title','detail','field'].every(k=>typeof i[k]==='string')),'Invalid saved findings');
    }
    if(raw.check!==null)check(raw.check);
    for(const r of raw.reports){
      assert(r&&typeof r.id==='string'&&revision(r.revision)&&timestamp(r.createdAt)&&r.createdBy==='finance'&&r.mode==='template'&&['draft','reviewed','approved','rejected'].includes(r.status)&&Array.isArray(r.decisions),'Invalid saved report format');
      normalizeRows(r.records);check(r.check);assert(r.check.revision===r.revision,'Report and check versions do not match');
      assert(r.decisions.every(d=>d&&['finance','director'].includes(d.actor)&&['review','approve','reject'].includes(d.action)&&typeof d.note==='string'&&timestamp(d.at)),'Invalid saved approval records');
    }
    for(const ev of raw.events){
      assert(ev&&typeof ev.id==='string'&&timestamp(ev.at)&&revision(ev.revision)&&[...ROLES,'system'].includes(ev.actor)&&typeof ev.action==='string','Invalid saved activity records');
      const d=ev.detail;
      assert(typeof d==='string'||(d&&typeof d==='object'&&typeof d.note==='string'&&(typeof d.recordId==='string'?Array.isArray(d.changes)&&d.changes.every(c=>c&&['field','before','after'].every(k=>typeof c[k]==='string')):typeof d.reportId==='string')),'Invalid saved activity details');
    }
    return clone(raw);
  }
  return {VERSION,RULE_VERSION,ROLES,FIELDS,SAMPLE,createState,cents,normalizeRows,totals,evaluate,currentCheck,transition,reportText,evidencePackage,toCSV,parseCSV,restore};
});
