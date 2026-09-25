'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const E=require('../dist/core.js');
const TIME='2026-09-25T02:00:00.000Z';
const initial=()=>E.createState(TIME);
const cleanRows=()=>E.normalizeRows(E.SAMPLE).map(r=>({...r,netPaid:((E.cents(r.basePay)+E.cents(r.allowances)-E.cents(r.deductions))/100).toFixed(2),costCenter:r.costCenter||'CC-400',evidence:r.evidence||'PAY-202609-005'}));
function cleanDraft(){let s=E.transition(initial(),'hr','import',{rows:cleanRows()},TIME);s=E.transition(s,'finance','check',{},TIME);return E.transition(s,'finance','draft',{},TIME);}
test('money calculations use integer cents, including small decimals',()=>{
  const row={...E.SAMPLE[0],basePay:'3000.10',allowances:'100.20',deductions:'200.30',netPaid:'2900.00'};
  assert.equal(E.evaluate([row]).totals.expected,290000);assert.equal(E.evaluate([row]).issues.length,0);
  for(const input of ['1.001','-1','NaN','Infinity','1e3','','100000000','01.20','1,000'])assert.throws(()=>E.cents(input));
});
test('a one-cent payroll error is detected with exact record and rule',()=>{
  const row={...cleanRows()[0],netPaid:'7000.01'};const result=E.evaluate([row]);
  assert.equal(result.issues[0].recordId,row.id);assert.equal(result.issues[0].rule,'PAY-001');assert.match(result.issues[0].detail,/0.01 SGD/);
});
test('fixtures contain exactly the three intended findings',()=>{
  assert.deepEqual(E.evaluate(E.SAMPLE).issues.map(x=>x.id),['PAY-001:EMP-003','DOC-001:EMP-005','ORG-001:EMP-006']);
});
test('excess deductions are blocked and negative imported amounts rejected',()=>{
  assert.ok(E.evaluate([{...E.SAMPLE[0],deductions:'99999'}]).issues.some(x=>x.rule==='PAY-002'));
  assert.throws(()=>E.normalizeRows([{...E.SAMPLE[0],netPaid:'-1'}]));
});
test('CSV roundtrip supports Unicode, BOM, commas and escaped quotes',()=>{
  const rows=cleanRows();rows[0].name='Chen, "Lena" 陈';const parsed=E.parseCSV(E.toCSV(rows));assert.deepEqual(parsed,rows);
});
test('invalid imports are atomic and do not change current records',()=>{
  const s=initial(),before=JSON.stringify(s);
  const invalids=[[],[E.SAMPLE[0],E.SAMPLE[0]],[{...E.SAMPLE[0],id:''}],[{...E.SAMPLE[0],period:'2026-13'}],[{...E.SAMPLE[0],basePay:'2.123'}]];
  invalids.forEach(rows=>assert.throws(()=>E.transition(s,'hr','import',{rows},TIME)));
  assert.equal(JSON.stringify(s),before);
  assert.throws(()=>E.parseCSV('id,name\nx,y'));assert.throws(()=>E.parseCSV(E.FIELDS.join(',')+'\n"unclosed'));
});
test('rerunning checks is deterministic without duplicated findings',()=>{
  const a=E.transition(initial(),'hr','check',{},TIME),b=E.transition(a,'hr','check',{},TIME);
  assert.deepEqual(a.check,b.check);assert.equal(b.check.issues.length,3);assert.equal(b.events.length,a.events.length+1);
});
test('findings stay visible in draft and prevent finance submission',()=>{
  let s=E.transition(initial(),'finance','check',{},TIME);s=E.transition(s,'finance','draft',{},TIME);
  assert.equal(s.reports[0].check.issues.length,3);assert.throws(()=>E.transition(s,'finance','review',{id:s.reports[0].id,note:'Reviewed'},TIME),/待处理问题/);
});
test('role and finance-before-director sequence are enforced in demo engine',()=>{
  let s=cleanDraft();const id=s.reports[0].id;
  assert.throws(()=>E.transition(s,'hr','review',{id,note:'No'},TIME));
  assert.throws(()=>E.transition(s,'director','approve',{id,note:'Too early'},TIME));
  assert.throws(()=>E.transition(s,'finance','review',{id,note:'   '},TIME));
  s=E.transition(s,'finance','review',{id,note:'Amounts and references verified in demo'},TIME);
  assert.throws(()=>E.transition(s,'finance','approve',{id,note:'Wrong role'},TIME));
  s=E.transition(s,'director','approve',{id,note:'Approved for demo'},TIME);
  assert.equal(s.reports[0].status,'approved');assert.deepEqual(s.reports[0].decisions.map(d=>d.actor),['finance','director']);
});
test('edits invalidate checks and reports without modifying their snapshots',()=>{
  const before=cleanDraft(),id=before.reports[0].id;
  const after=E.transition(before,'hr','edit',{id:'EMP-001',changes:{allowances:'400'},note:'Corrected source allowance'},TIME);
  assert.ok(!E.currentCheck(after));assert.equal(after.reports[0].records[0].allowances,'300.00');
  assert.equal(after.records[0].allowances,'400.00');assert.throws(()=>E.transition(after,'finance','review',{id,note:'Old data'},TIME),/数据已更新/);
  assert.throws(()=>E.transition(after,'finance','draft',{},TIME),/重新检查/);assert.equal(before.revision,2);
});
test('approved report remains historical after replacement import',()=>{
  let s=cleanDraft();const id=s.reports[0].id;s=E.transition(s,'finance','review',{id,note:'Reviewed'},TIME);s=E.transition(s,'director','approve',{id,note:'Approved'},TIME);
  s=E.transition(s,'hr','import',{rows:cleanRows()},TIME);assert.equal(s.reports[0].status,'approved');assert.notEqual(s.reports[0].revision,s.revision);assert.ok(!E.currentCheck(s));
});
test('director rejection requires a reason and a new reviewed report',()=>{
  let s=cleanDraft();const id=s.reports[0].id;s=E.transition(s,'finance','review',{id,note:'Reviewed'},TIME);
  assert.throws(()=>E.transition(s,'director','reject',{id,note:''},TIME));
  s=E.transition(s,'director','reject',{id,note:'Please clarify assumptions'},TIME);
  assert.throws(()=>E.transition(s,'director','approve',{id,note:'Bypass'},TIME));
  s=E.transition(s,'finance','draft',{},TIME);assert.notEqual(s.reports[0].id,id);assert.equal(s.reports[0].status,'draft');assert.equal(s.reports[1].status,'rejected');
});
test('exports reconcile to snapshots and preserve source change explanations',()=>{
  let s=initial();s=E.transition(s,'hr','edit',{id:'EMP-003',changes:{netPaid:'4950'},note:'Corrected against mock payslip'},TIME);
  s=E.transition(s,'finance','check',{},TIME);s=E.transition(s,'finance','draft',{},TIME);
  const exported=E.evidencePackage(s,TIME);assert.deepEqual(exported.reports[0].check.totals,E.totals(exported.reports[0].records));
  assert.equal(exported.events[1].detail.changes[0].before,'4750.00');assert.equal(exported.events[1].detail.changes[0].after,'4950.00');
  assert.match(exported.reports[0].text,/未调用 AI/);assert.equal(exported.mode,'browser-local-demo');
  exported.records[0].name='Changed export';assert.notEqual(s.records[0].name,'Changed export');
});
test('CSV exports guard formula-leading user text',()=>{
  const csv=E.toCSV([{...E.SAMPLE[0],name:'=HYPERLINK("https://example.com")'}]);assert.ok(csv.includes('"\'=HYPERLINK'));
});
test('local save roundtrip and reset preserve expected state',()=>{
  const s=cleanDraft();assert.deepEqual(E.restore(JSON.parse(JSON.stringify(s))),s);
  assert.throws(()=>E.restore({version:0}));const reset=initial();assert.equal(reset.reports.length,0);assert.equal(reset.events.length,1);assert.equal(reset.revision,1);
});
test('multiline human notes save while imported single-line fields remain strict',()=>{
  let s=cleanDraft();s=E.transition(s,'finance','review',{id:s.reports[0].id,note:'金额已核对\n凭证编号已复查'},TIME);
  assert.match(s.reports[0].decisions[0].note,/\n/);
  assert.throws(()=>E.normalizeRows([{...E.SAMPLE[0],name:'Name\nOther'}]));
});
test('corrupted persisted checks, events and snapshots are rejected before rendering',()=>{
  assert.throws(()=>E.restore({...initial(),check:{revision:1}}));
  const s=cleanDraft();s.events.push({id:'bad',at:TIME,revision:1,actor:'hr',action:'edit',detail:{recordId:'EMP-001',note:'Bad',changes:null}});assert.throws(()=>E.restore(s));
  const r=cleanDraft();r.reports[0].records[0].basePay='invalid';assert.throws(()=>E.restore(r));
});
test('outdated rule versions require a fresh check and report before approval',()=>{
  const s=cleanDraft();s.check.ruleVersion='OLD';assert.equal(E.currentCheck(s),false);assert.throws(()=>E.transition(s,'finance','draft',{},TIME));
  s.reports[0].check.ruleVersion='OLD';assert.throws(()=>E.transition(s,'finance','review',{id:s.reports[0].id,note:'Reviewed'},TIME),/规则已更新/);
});
