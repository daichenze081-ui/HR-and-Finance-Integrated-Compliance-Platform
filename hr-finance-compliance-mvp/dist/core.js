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
    ['EMP-001','陈思远','产品研发','CC-100','2026-09','8500','300','1800','7000','PAY-202609-001'],
    ['EMP-002','林悦','产品研发','CC-100','2026-09','7200','200','1400','6000','PAY-202609-002'],
    ['EMP-003','王子涵','业务运营','CC-200','2026-09','5800','350','1200','4750','PAY-202609-003'],
    ['EMP-004','Amir Tan','业务运营','CC-200','2026-09','6200','200','1300','5100','PAY-202609-004'],
    ['EMP-005','Priya Lee','财务管理','CC-300','2026-09','7800','250','1600','6450',''],
    ['EMP-006','赵安宁','人力资源','','2026-09','6800','200','1400','5600','PAY-202609-006']
  ].map(row => Object.fromEntries(FIELDS.map((k,i) => [k,row[i]])));
  const clone = x => JSON.parse(JSON.stringify(x));
  function assert(ok,message) { if (!ok) throw new Error(message); }
  function text(value,label,max=160,required=true,multiline=false) {
    assert(typeof value === 'string', `${label}必须是文字`);
    const s=value.trim();
    assert((!required || s.length>0) && s.length<=max, `${label}长度应为${required?'1':'0'}–${max}个字符`);
    assert(!(multiline?/[\x00-\x08\x0b\x0c\x0e-\x1f]/:/[\x00-\x1f]/).test(s),`${label}不能含控制字符`);
    return s;
  }
  function cents(value) {
    const s=String(value).trim();
    assert(/^(0|[1-9]\d{0,7})(\.\d{1,2})?$/.test(s),'金额须为非负数，最多两位小数，且小于 1 亿');
    const [whole,frac='']=s.split('.');
    return Number(whole)*100+Number(frac.padEnd(2,'0'));
  }
  function amount(value) { return (cents(value)/100).toFixed(2); }
  function normalizeRows(rows) {
    assert(Array.isArray(rows) && rows.length>0 && rows.length<=500,'请导入 1–500 条员工记录');
    const ids=new Set();
    return rows.map((raw,i) => {
      assert(raw && typeof raw === 'object' && !Array.isArray(raw),`第 ${i+1} 行格式错误`);
      const row={};
      for (const field of ['id','name','department','costCenter','period','evidence']) row[field]=text(raw[field],`${i+1} 行 ${field}`,field==='evidence'?240:80,!['costCenter','evidence'].includes(field));
      assert(/^[A-Za-z0-9_-]{1,40}$/.test(row.id),`第 ${i+1} 行员工编号只能含英文字母、数字、横线和下划线`);
      assert(/^\d{4}-(0[1-9]|1[0-2])$/.test(row.period),`第 ${i+1} 行期间须为 YYYY-MM`);
      assert(!ids.has(row.id),`员工编号重复：${row.id}`); ids.add(row.id);
      for (const field of ['basePay','allowances','deductions','netPaid']) {
        try { row[field]=amount(raw[field]); } catch(error) { throw new Error(`第 ${i+1} 行 ${field}：${error.message}`); }
      }
      return row;
    });
  }
  function event(state,actor,action,detail,now) {
    state.events.push({id:`EVT-${String(state.events.length+1).padStart(4,'0')}`,at:now,actor,action,detail,revision:state.revision});
  }
  function createState(now=new Date().toISOString()) {
    const state={version:VERSION,revision:1,records:normalizeRows(SAMPLE),check:null,reports:[],events:[]};
    event(state,'system','初始化演示','已载入 6 条虚构员工记录，内含 3 个待处理问题',now);
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
      if (expected!==paid) add(r,'PAY-001','净薪资金额不一致',`应付 ${(expected/100).toFixed(2)}，录入实付 ${(paid/100).toFixed(2)}，差额 ${((paid-expected)/100).toFixed(2)} SGD`,'netPaid');
      if (!r.evidence) add(r,'DOC-001','缺少凭证引用','请填写工资单或付款凭证编号，便于追溯。','evidence');
      if (!r.costCenter) add(r,'ORG-001','缺少成本中心','该笔人员成本还没有关联成本中心。','costCenter');
      if (cents(r.deductions)>gross) add(r,'PAY-002','扣款超过应发金额','请核对基础工资、津贴和扣款录入。','deductions');
    }
    return {issues,totals:totals(normalized),ruleVersion:RULE_VERSION};
  }
  function currentCheck(state) { return !!(state.check && state.check.revision===state.revision && state.check.ruleVersion===RULE_VERSION); }
  function transition(original,actor,action,payload={},now=new Date().toISOString()) {
    assert(ROLES.includes(actor),'未知演示角色');
    const s=clone(original);
    const allow=(roles)=>assert(roles.includes(actor),'当前演示角色不能执行此操作');
    if (action==='import') {
      allow(['hr']); s.records=normalizeRows(payload.rows); s.revision++;
      event(s,actor,'替换员工数据',`导入 ${s.records.length} 条记录；已有报告保留为历史版本`,now);
    } else if (action==='edit') {
      allow(['hr']); const index=s.records.findIndex(r=>r.id===payload.id); assert(index>=0,'员工记录不存在');
      const note=text(payload.note,'修改说明',500,true,true);
      const before=s.records[index], updated=normalizeRows([{...before,...payload.changes,id:before.id}])[0];
      const changes=FIELDS.filter(k=>before[k]!==updated[k]).map(k=>({field:k,before:before[k],after:updated[k]}));
      assert(changes.length>0,'没有可保存的修改'); s.records[index]=updated; s.revision++;
      event(s,actor,'修改员工记录',{recordId:before.id,note,changes},now);
    } else if (action==='check') {
      allow(['hr','finance']); s.check={...evaluate(s.records),revision:s.revision,at:now};
      event(s,actor,'执行数据检查',`发现 ${s.check.issues.length} 个待处理问题；规则 ${RULE_VERSION}`,now);
    } else if (action==='draft') {
      allow(['finance']); assert(currentCheck(s),'数据已变化，请先重新检查');
      const report={id:`RPT-${String(s.reports.length+1).padStart(3,'0')}`,revision:s.revision,createdAt:now,createdBy:actor,status:'draft',mode:'template',records:clone(s.records),check:clone(s.check),decisions:[]};
      s.reports.unshift(report); event(s,actor,'生成报告草稿',`${report.id} · 本地模板生成 · 数据版本 v${s.revision}`,now);
    } else if (['review','approve','reject'].includes(action)) {
      const report=s.reports.find(r=>r.id===payload.id); assert(report,'报告不存在');
      assert(report.revision===s.revision,'数据已更新，此报告仅可查看；请检查并生成新版本');
      assert(report.check.ruleVersion===RULE_VERSION,'检查规则已更新，请重新检查并生成报告');
      const note=text(payload.note,'审批意见',1000,true,true);
      if (action==='review') {
        allow(['finance']); assert(report.status==='draft','只有草稿可以提交复核');
        assert(report.check.issues.length===0,'仍有待处理问题，修正后重新检查并生成报告');
        report.status='reviewed';
      } else if (action==='approve') {
        allow(['director']); assert(report.status==='reviewed','须先完成财务复核'); report.status='approved';
      } else {
        allow(['director']); assert(report.status==='reviewed','只有待董事审批的报告可以退回'); report.status='rejected';
      }
      report.decisions.push({actor,action,note,at:now}); event(s,actor,{review:'财务复核完成',approve:'董事批准',reject:'董事退回'}[action],{reportId:report.id,note},now);
    } else throw new Error('未知操作');
    return s;
  }
  function reportText(report) {
    const t=report.check.totals;
    return [
      '人力与财务合规复核草稿',`${report.id} | 数据版本 v${report.revision} | ${report.createdAt}`,
      '生成方式：本地确定性模板（未调用 AI 模型）',
      `覆盖 ${report.records.length} 名员工；期间 ${[...new Set(report.records.map(r=>r.period))].join('、')}。`,
      `应发总额 SGD ${(t.gross/100).toFixed(2)}；扣款 SGD ${(t.deductions/100).toFixed(2)}；应付净额 SGD ${(t.expected/100).toFixed(2)}；录入实付 SGD ${(t.paid/100).toFixed(2)}。`,
      `规则版本 ${report.check.ruleVersion}，检查发现 ${report.check.issues.length} 个待处理问题。`,
      ...report.check.issues.map(i=>`[${i.rule}] ${i.recordId} ${i.name}：${i.title}。${i.detail}`),
      '来源：本报告所附员工数据快照、凭证引用和检查结果。凭证引用不代表原始文件已上传或真实性已验证。',
      '演示范围：金额一致性、字段完整性及审批流程。扣款为录入值，未计算 CPF 或税款，未判断法定合规。角色切换不是身份认证，记录不是防篡改审计系统。',
      '本草稿供人工复核，不构成审计意见或合规保证。'
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
    assert(typeof input==='string'&&input.length<=1024*1024,'CSV 文件不能超过 1 MB');
    const src=input.replace(/^\uFEFF/,''); let rows=[],row=[],cell='',quoted=false,closed=false;
    for(let i=0;i<src.length;i++){
      const ch=src[i];
      if(quoted){if(ch==='"'){if(src[i+1]==='"'){cell+='"';i++;}else{quoted=false;closed=true;}}else cell+=ch;continue;}
      if(ch==='"'){assert(cell===''&&!closed,'CSV 引号格式错误');quoted=true;continue;}
      if(ch===','||ch==='\n'||ch==='\r'){
        row.push(cell);cell='';closed=false;
        if(ch!==','){if(ch==='\r'&&src[i+1]==='\n')i++;rows.push(row);row=[];}continue;
      }
      assert(!closed,'CSV 结束引号后须为分隔符');cell+=ch;
    }
    assert(!quoted,'CSV 引号未闭合'); if(cell!==''||row.length||closed){row.push(cell);rows.push(row);}
    rows=rows.filter(r=>r.some(x=>x!=='')); assert(rows.length>1,'CSV 需要表头和至少一条记录');
    const head=rows.shift().map(x=>x.trim()); assert(head.length===FIELDS.length&&FIELDS.every(k=>head.includes(k)),'CSV 表头须使用下载模板中的全部字段');
    return normalizeRows(rows.map((r,i)=>{assert(r.length===head.length,`CSV 第 ${i+2} 行列数不正确`);return Object.fromEntries(head.map((k,j)=>[k,r[j]]));}));
  }
  function restore(raw) {
    assert(raw&&raw.version===VERSION&&Number.isInteger(raw.revision)&&raw.revision>=1,'本地数据版本不兼容');
    assert(Array.isArray(raw.events)&&Array.isArray(raw.reports),'本地数据格式错误');
    normalizeRows(raw.records);
    // Saved state is only for a local demo. Never trust it as proof of identity or approval.
    const timestamp=s=>typeof s==='string'&&Number.isFinite(Date.parse(s));
    const revision=n=>Number.isInteger(n)&&n>=1&&n<=raw.revision;
    function check(c) {
      assert(c&&revision(c.revision)&&timestamp(c.at)&&typeof c.ruleVersion==='string'&&Array.isArray(c.issues),'本地检查格式错误');
      assert(c.totals&&['gross','deductions','expected','paid'].every(k=>Number.isSafeInteger(c.totals[k])),'本地汇总格式错误');
      assert(c.issues.every(i=>i&&['id','recordId','name','rule','ruleVersion','severity','title','detail','field'].every(k=>typeof i[k]==='string')),'本地问题记录格式错误');
    }
    if(raw.check!==null)check(raw.check);
    for(const r of raw.reports){
      assert(r&&typeof r.id==='string'&&revision(r.revision)&&timestamp(r.createdAt)&&r.createdBy==='finance'&&r.mode==='template'&&['draft','reviewed','approved','rejected'].includes(r.status)&&Array.isArray(r.decisions),'本地报告格式错误');
      normalizeRows(r.records);check(r.check);assert(r.check.revision===r.revision,'报告与检查版本不一致');
      assert(r.decisions.every(d=>d&&['finance','director'].includes(d.actor)&&['review','approve','reject'].includes(d.action)&&typeof d.note==='string'&&timestamp(d.at)),'本地审批记录格式错误');
    }
    for(const ev of raw.events){
      assert(ev&&typeof ev.id==='string'&&timestamp(ev.at)&&revision(ev.revision)&&[...ROLES,'system'].includes(ev.actor)&&typeof ev.action==='string','本地操作记录格式错误');
      const d=ev.detail;
      assert(typeof d==='string'||(d&&typeof d==='object'&&typeof d.note==='string'&&(typeof d.recordId==='string'?Array.isArray(d.changes)&&d.changes.every(c=>c&&['field','before','after'].every(k=>typeof c[k]==='string')):typeof d.reportId==='string')),'本地操作详情格式错误');
    }
    return clone(raw);
  }
  return {VERSION,RULE_VERSION,ROLES,FIELDS,SAMPLE,createState,cents,normalizeRows,totals,evaluate,currentCheck,transition,reportText,evidencePackage,toCSV,parseCSV,restore};
});
