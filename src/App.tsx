import { useMemo, useState } from 'react'
import type { Flag, HistoricalInvestor, NoteMasterRow, PriorComplianceContext, ReviewDecision, ReviewRecord, RuleConfig, StaffMember, Transaction } from './types'
import { exportRowsToXlsx, monthKey, monthLabel, parseGenericTable, parseHistoricalWorkbook, parseNoteMaster, parsePriorMonitoringWorkbook, parseStaffRows, parseWorkbook, runRules, staffInvestments } from './monitoring'

type Tab = 'dashboard'|'upload'|'reviews'|'staff'|'rules'|'reports'

const defaultRules: RuleConfig[] = [
  { id:'TM-001', name:'Monthly Deposit Threshold', description:'Mandatory: flag when aggregate Deposit transactions for the same investor exceed RM30,000 in a calendar month.', enabled:true, locked:true, threshold:30000 },
  { id:'TM-002', name:'Single Large Deposit', description:'Optional: flag when one Deposit exceeds the configured amount.', enabled:false, locked:false, threshold:100000 },
  { id:'TM-003', name:'Deposit Frequency', description:'Optional: flag when an investor makes at least the configured number of deposits in the month.', enabled:false, locked:false, threshold:3 },
  { id:'TM-004', name:'Rapid Deposit / Withdrawal', description:'Optional: flag where a withdrawal of at least 80% of a deposit follows within the configured number of days.', enabled:false, locked:false, threshold:3 },
  { id:'TM-005', name:'High-Risk Customer Deposit', description:'Optional: use the historical AML risk profile and flag High-risk customers whose monthly deposits exceed the configured amount.', enabled:false, locked:false, threshold:10000 },
  { id:'TM-006', name:'Historical Deposit Spike', description:'Optional: flag when current monthly deposits are at least the configured multiple of the investor\'s average positive historical monthly deposits, and also exceed RM30,000.', enabled:false, locked:false, threshold:3 },
]

const rm = (n:number) => `RM ${n.toLocaleString('en-MY',{minimumFractionDigits:2,maximumFractionDigits:2})}`
const fmtDate = (d:Date|null) => d ? new Intl.DateTimeFormat('en-MY',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(d) : '—'

function loadReviews(): Record<string,ReviewRecord> { try { return JSON.parse(localStorage.getItem('cofundr-tm-reviews') || '{}') } catch { return {} } }
function loadRules(): RuleConfig[] {
  try {
    const saved = JSON.parse(localStorage.getItem('cofundr-tm-rules') || 'null') as RuleConfig[] | null
    if (!saved) return defaultRules
    return defaultRules.map(d => {
      const s = saved.find(x=>x.id===d.id)
      return {...d,...(s||{}),enabled:d.locked?true:(s?.enabled ?? d.enabled),threshold:d.locked?30000:(s?.threshold ?? d.threshold)}
    })
  } catch { return defaultRules }
}
function loadStaff(): StaffMember[] { try{return JSON.parse(localStorage.getItem('cofundr-tm-staff')||'[]')}catch{return []} }
function loadNotes(): NoteMasterRow[] { try{return JSON.parse(localStorage.getItem('cofundr-tm-notes')||'[]')}catch{return []} }
function loadContext(): PriorComplianceContext[] { try{return JSON.parse(localStorage.getItem('cofundr-tm-context')||'[]')}catch{return []} }

export default function App(){
  const [tab,setTab]=useState<Tab>('dashboard')
  const [transactions,setTransactions]=useState<Transaction[]>([])
  const [sourceName,setSourceName]=useState('')
  const [historyName,setHistoryName]=useState('')
  const [priorName,setPriorName]=useState('')
  const [rules,setRules]=useState<RuleConfig[]>(loadRules)
  const [reviews,setReviews]=useState<Record<string,ReviewRecord>>(loadReviews)
  const [staff,setStaff]=useState<StaffMember[]>(loadStaff)
  const [notes,setNotes]=useState<NoteMasterRow[]>(loadNotes)
  const [history,setHistory]=useState<HistoricalInvestor[]>([])
  const [priorContext,setPriorContext]=useState<PriorComplianceContext[]>(loadContext)
  const [filterMonth,setFilterMonth]=useState('')
  const [busy,setBusy]=useState(false)
  const [message,setMessage]=useState('')

  const flags=useMemo(()=>runRules(transactions,rules,history,priorContext),[transactions,rules,history,priorContext])
  const months=useMemo(()=>Array.from(new Set(transactions.map(t=>monthKey(t.date)).filter(x=>x!=='Unknown'))).sort().reverse(),[transactions])
  const activeMonth=filterMonth || months[0] || ''
  const monthTx=useMemo(()=>transactions.filter(t=>monthKey(t.date)===activeMonth),[transactions,activeMonth])
  const monthFlags=useMemo(()=>flags.filter(f=>f.monthKey===activeMonth),[flags,activeMonth])
  const staffRows=useMemo(()=>staffInvestments(monthTx,staff,notes),[monthTx,staff,notes])
  const deposits=monthTx.filter(t=>t.action.trim().toLowerCase()==='deposit')
  const totalDeposit=deposits.reduce((s,t)=>s+t.amount,0)
  const pending=monthFlags.filter(f=>(reviews[f.id]?.decision||'Pending')==='Pending').length
  const mandatory=monthFlags.filter(f=>f.ruleId==='TM-001')
  const highRiskMandatory=mandatory.filter(f=>f.riskProfile?.toLowerCase()==='high').length

  const saveRules=(next:RuleConfig[])=>{setRules(next);localStorage.setItem('cofundr-tm-rules',JSON.stringify(next))}
  const saveReview=(flag:Flag, decision:ReviewDecision, comments:string, reviewedBy:string)=>{
    const next={...reviews,[flag.id]:{flagId:flag.id,decision,comments,reviewedBy,reviewedAt:new Date().toISOString()}}
    setReviews(next);localStorage.setItem('cofundr-tm-reviews',JSON.stringify(next))
  }

  async function uploadTransactions(file?:File){
    if(!file)return; setBusy(true);setMessage('')
    try{const rows=await parseWorkbook(file);setTransactions(rows);setSourceName(file.name);setFilterMonth('');setMessage(`${rows.length.toLocaleString()} transactions loaded.`);setTab('dashboard')}
    catch(e){setMessage(e instanceof Error?e.message:'Could not read transaction file.')}
    finally{setBusy(false)}
  }
  async function uploadStaff(file?:File){if(!file)return;try{const x=parseStaffRows(await parseGenericTable(file));setStaff(x);localStorage.setItem('cofundr-tm-staff',JSON.stringify(x));setMessage(`${x.length} staff records loaded.`)}catch(e){setMessage(e instanceof Error?e.message:'Could not read staff register.')}}
  async function uploadNotes(file?:File){if(!file)return;try{const x=parseNoteMaster(await parseGenericTable(file));setNotes(x);localStorage.setItem('cofundr-tm-notes',JSON.stringify(x));setMessage(`${x.length} note-master rows loaded.`)}catch(e){setMessage(e instanceof Error?e.message:'Could not read note master.')}}
  async function uploadHistory(file?:File){if(!file)return;try{const x=await parseHistoricalWorkbook(file);setHistory(x);setHistoryName(file.name);setMessage(`${x.length} historical investor profiles loaded from the working workbook.`)}catch(e){setMessage(e instanceof Error?e.message:'Could not read historical workbook.')}}
  async function uploadPrior(file?:File){if(!file)return;try{const x=await parsePriorMonitoringWorkbook(file);setPriorContext(x);setPriorName(file.name);localStorage.setItem('cofundr-tm-context',JSON.stringify(x));setMessage(`${x.length} prior compliance comments carried forward.`)}catch(e){setMessage(e instanceof Error?e.message:'Could not read prior monitoring workbook.')}}

  const staffExport=staffRows.map((x,i)=>({
    'No.':i+1,'Note Reference ID':x.note?.referenceId||x.transaction.noteId,'Note Name':x.note?.noteName||'Note master required','Staff Name':x.staff.name,'Amount (RM)':x.transaction.amount,'Status':'Successful','Date / Time':fmtDate(x.transaction.date)
  }))
  const reportRows=mandatory.map(f=>({
    'Month':monthLabel(f.monthKey),'Investor ID':f.investorId||'','Name':f.investorName,'Amount (RM)':f.amount,'Risk Profile':f.riskProfile||'','Historical Avg Deposit (RM)':f.historicalAverageDeposit||'','Prior Compliance Context':f.priorComplianceContext||'','Remarks':f.reason,'Compliance Decision':reviews[f.id]?.decision||'Pending','Compliance Comments':reviews[f.id]?.comments||'','Reviewed By':reviews[f.id]?.reviewedBy||'','Reviewed At':reviews[f.id]?.reviewedAt||''
  }))

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark">C</div><div><strong>Cofundr</strong><span>Transaction Monitoring</span></div></div>
      <nav>
        <button className={tab==='dashboard'?'active':''} onClick={()=>setTab('dashboard')}>Dashboard</button>
        <button className={tab==='upload'?'active':''} onClick={()=>setTab('upload')}>Monthly Upload</button>
        <button className={tab==='reviews'?'active':''} onClick={()=>setTab('reviews')}>Review Queue {pending>0?`(${pending})`:''}</button>
        <button className={tab==='staff'?'active':''} onClick={()=>setTab('staff')}>Staff Investment</button>
        <button className={tab==='rules'?'active':''} onClick={()=>setTab('rules')}>Monitoring Rules</button>
        <button className={tab==='reports'?'active':''} onClick={()=>setTab('reports')}>Reports & Sign-Off</button>
      </nav>
      <div className="sidebar-note"><strong>Mandatory control</strong><span>TM-001 flags aggregate monthly deposits strictly above RM30,000. This control cannot be disabled.</span></div>
    </aside>

    <main>
      <header className="topbar"><div><h1>{tabTitle(tab)}</h1><p>{sourceName?`Source: ${sourceName}`:'No monthly transaction file loaded'}</p></div>{months.length>0&&<select value={activeMonth} onChange={e=>setFilterMonth(e.target.value)}>{months.map(m=><option key={m} value={m}>{monthLabel(m)}</option>)}</select>}</header>
      {message&&<div className="notice">{message}</div>}

      {tab==='dashboard'&&<>{!transactions.length?<EmptyUpload onFile={uploadTransactions} busy={busy}/>:<>
        <section className="kpis">
          <Kpi label="Transactions analysed" value={monthTx.length.toLocaleString()} sub={monthLabel(activeMonth)}/>
          <Kpi label="Deposits" value={rm(totalDeposit)} sub={`${deposits.length} deposit transaction(s)`}/>
          <Kpi label="Investors > RM30k" value={mandatory.length.toString()} sub="Mandatory TM-001" tone={mandatory.length?'warn':''}/>
          <Kpi label="Pending reviews" value={pending.toString()} sub={`${monthFlags.length} total flag(s)`} tone={pending?'danger':'good'}/>
        </section>
        <section className="grid2">
          <div className="card"><div className="card-head"><h2>Mandatory threshold review</h2><button className="link" onClick={()=>setTab('reviews')}>Open review queue →</button></div>{mandatory.length?<div className="table-wrap"><table><thead><tr><th>Investor</th><th>Risk</th><th>Monthly Deposits</th><th>History</th><th>Status</th></tr></thead><tbody>{mandatory.slice(0,10).map(f=><tr key={f.id}><td>{f.investorName}<small className="subline">{f.investorId?`ID ${f.investorId}`:''}</small></td><td><RiskBadge value={f.riskProfile}/></td><td>{rm(f.amount)}</td><td>{f.historicalAverageDeposit?`${(f.amount/f.historicalAverageDeposit).toFixed(1)}× avg`:'—'}</td><td><StatusBadge value={reviews[f.id]?.decision||'Pending'}/></td></tr>)}</tbody></table></div>:<div className="empty-small">No investor exceeded RM30,000 for this month.</div>}</div>
          <div className="card"><h2>Monitoring data coverage</h2><div className="summary-list"><Summary label="TM-001 threshold" value="> RM30,000 aggregate deposits"/><Summary label="Historical investor profiles" value={history.length?`${history.length} loaded`:'Not loaded'}/><Summary label="Prior compliance contexts" value={priorContext.length?`${priorContext.length} carried forward`:'Not loaded'}/><Summary label="High-risk investors in TM-001" value={String(highRiskMandatory)}/><Summary label="Staff register" value={`${staff.filter(s=>s.active).length} active staff`}/><Summary label="Note master" value={`${notes.length} notes loaded`}/><Summary label="Staff investments detected" value={`${staffRows.length}`}/></div></div>
        </section>
      </>}</>}

      {tab==='upload'&&<section className="stack">
        <UploadCard title="1. Monthly Transaction Log" text="Upload the Cofundr Admin Panel Excel/CSV export for the month being reviewed." accept=".xlsx,.xls,.csv" onFile={uploadTransactions} detail={sourceName||'Required each month'} />
        <UploadCard title="2. Historical Investor / AML Workbook" text="Upload your 2024–2026 ACTIVE INVESTORS & ISSUERS working file. The app reads Monthly Deposit, Monthly Investment, Monthly Gross Withdrawal, Risk Profile and Account Balances sheets to provide investor history and AML context." accept=".xlsx,.xls" onFile={uploadHistory} detail={historyName||'Recommended for historical comparison'} />
        <UploadCard title="3. Prior Monitoring Workbook" text="Upload an earlier Flagged Transaction Monitoring workbook to carry forward standing Compliance Comments such as known relationships or institutional-fund context." accept=".xlsx,.xls" onFile={uploadPrior} detail={priorName||`${priorContext.length} saved context record(s)`} />
        <UploadCard title="4. Staff Register" text="Used to match Investment Committed transactions to staff for Appendix II." accept=".xlsx,.xls,.csv" onFile={uploadStaff} detail={staff.length?`${staff.length} records stored locally`:'Required for staff report'} />
        <UploadCard title="5. Note Master" text="Maps Note ID to Note Reference ID and Note Name for the Staff Investment Report." accept=".xlsx,.xls,.csv" onFile={uploadNotes} detail={notes.length?`${notes.length} notes stored locally`:'Awaiting note master'} />
        <div className="privacy"><strong>Local-first.</strong> The transaction and historical workbooks stay in browser memory for the current session. Staff, note-master and prior-context reference records are stored in browser localStorage. No backend upload is performed by this prototype.</div>
      </section>}

      {tab==='reviews'&&<section className="card full">
        <div className="card-head"><div><h2>{monthLabel(activeMonth)} flags</h2><p className="muted">Review the mandatory RM30k threshold and any optional behavioural flags. Historical information is context only; Compliance still makes the final decision.</p></div></div>
        {!monthFlags.length?<div className="empty-small">No flags for the selected month.</div>:<div className="review-list">{monthFlags.map(f=><ReviewCard key={f.id} flag={f} review={reviews[f.id]} onSave={saveReview}/>)}</div>}
      </section>}

      {tab==='staff'&&<section className="card full printable" id="staff-report">
        <div className="report-title"><span>Appendix II – Staff Investment Report</span><h2>STAFF INVESTMENT REPORT – {activeMonth?monthLabel(activeMonth).toUpperCase():'[MONTH] [YEAR]'}</h2><p>Consolidated report generated by the Compliance Unit from the platform pursuant to Clause 7.1.3 and tabled at the monthly Senior Management Team meeting for review of possible conflicts of interest.</p></div>
        {!staff.length?<div className="callout">Upload the Staff Register under <strong>Monthly Upload</strong> to enable staff matching.</div>:<><div className="actions"><button onClick={()=>exportRowsToXlsx(`Staff Investment Report - ${activeMonth}.xlsx`,'Staff Investment',staffExport)}>Export Excel</button><button className="secondary" onClick={()=>window.print()}>Print / Save PDF</button></div><div className="table-wrap"><table className="report-table"><thead><tr><th>No.</th><th>Note Reference ID</th><th>Note Name</th><th>Staff Name</th><th>Amount (RM)</th><th>Status</th><th>Date / Time</th></tr></thead><tbody>{staffRows.map((x,i)=><tr key={`${x.transaction.sourceRow}-${i}`}><td>{i+1}</td><td>{x.note?.referenceId||x.transaction.noteId}</td><td className={!x.note?.noteName?'missing':''}>{x.note?.noteName||'Note master required'}</td><td>{x.staff.name}</td><td className="num">{x.transaction.amount.toLocaleString('en-MY',{minimumFractionDigits:2})}</td><td>Successful</td><td>{fmtDate(x.transaction.date)}</td></tr>)}{!staffRows.length&&<tr><td colSpan={7} className="center">No staff investment transactions detected.</td></tr>}</tbody><tfoot><tr><td colSpan={4}>Total staff investment for the month</td><td className="num">{staffRows.reduce((s,x)=>s+x.transaction.amount,0).toLocaleString('en-MY',{minimumFractionDigits:2})}</td><td colSpan={2}></td></tr></tfoot></table></div></>}
      </section>}

      {tab==='rules'&&<section className="stack"><div className="callout"><strong>TM-001 is mandatory and fixed.</strong> Aggregate deposits must be strictly greater than RM30,000 to trigger it; RM30,000.00 exactly does not trigger TM-001.</div>{rules.map(r=><div className="rule-card" key={r.id}><div><div className="rule-id">{r.id}</div><h3>{r.name}</h3><p>{r.description}</p></div><div className="rule-controls"><label>{r.id==='TM-006'?'Multiple / threshold':'Threshold'}<input type="number" value={r.threshold??0} disabled={r.locked} onChange={e=>saveRules(rules.map(x=>x.id===r.id?{...x,threshold:Number(e.target.value)}:x))}/></label><label className="switch-row"><input type="checkbox" checked={r.enabled} disabled={r.locked} onChange={e=>saveRules(rules.map(x=>x.id===r.id?{...x,enabled:e.target.checked}:x))}/>{r.locked?'Mandatory':'Enabled'}</label></div></div>)}</section>}

      {tab==='reports'&&<section className="grid2">
        <div className="card"><h2>Monthly Deposit Monitoring Report</h2><p className="muted">Carries forward your earlier flagged-deposit format, now enriched with Investor ID, AML risk, historical average, prior compliance context and review audit fields.</p><div className="report-metrics"><Summary label="Review month" value={monthLabel(activeMonth)}/><Summary label="Flagged investors (TM-001)" value={String(mandatory.length)}/><Summary label="Total flagged amount" value={rm(mandatory.reduce((s,f)=>s+f.amount,0))}/><Summary label="Pending" value={String(mandatory.filter(f=>(reviews[f.id]?.decision||'Pending')==='Pending').length)}/></div><button disabled={!mandatory.length} onClick={()=>exportRowsToXlsx(`Monthly Deposit Monitoring - ${activeMonth}.xlsx`,'Flagged Deposits',reportRows)}>Export Monitoring Excel</button></div>
        <div className="card"><h2>Compliance Sign-Off</h2><p className="muted">Monthly closing control. V1 prints a sign-off summary; true locking should be enforced by authentication/database in production.</p><div className="signoff"><label>Reviewed By<input placeholder="Compliance Officer"/></label><label>Designation<input placeholder="e.g. Compliance Officer"/></label><label>Review Comments<textarea rows={4} placeholder="Overall monthly review conclusion"/></label><label>Status<select><option>Pending</option><option>Completed</option></select></label></div><button className="secondary" onClick={()=>window.print()}>Print Sign-Off</button></div>
      </section>}
    </main>
  </div>
}

function tabTitle(tab:Tab){return ({dashboard:'Monthly Monitoring Dashboard',upload:'Monthly Data Upload',reviews:'Compliance Review Queue',staff:'Staff Investment Report',rules:'Monitoring Rules',reports:'Reports & Sign-Off'} as Record<Tab,string>)[tab]}
function Kpi({label,value,sub,tone=''}:{label:string,value:string,sub:string,tone?:string}){return <div className={`kpi ${tone}`}><span>{label}</span><strong>{value}</strong><small>{sub}</small></div>}
function Summary({label,value}:{label:string,value:string}){return <div className="summary-row"><span>{label}</span><strong>{value}</strong></div>}
function StatusBadge({value}:{value:string}){return <span className={`badge ${value.toLowerCase().replace(/\s+/g,'-')}`}>{value}</span>}
function RiskBadge({value}:{value?:string}){const v=value||'Unknown';return <span className={`badge risk-${v.toLowerCase()}`}>{v}</span>}
function EmptyUpload({onFile,busy}:{onFile:(f?:File)=>void,busy:boolean}){return <div className="hero-empty"><div className="upload-icon">⇧</div><h2>Upload the monthly Cofundr transaction log</h2><p>The mandatory RM30,000 aggregate monthly deposit rule will run automatically.</p><label className="button">{busy?'Reading file…':'Choose Excel / CSV'}<input type="file" accept=".xlsx,.xls,.csv" hidden onChange={e=>onFile(e.target.files?.[0])}/></label></div>}
function UploadCard({title,text,accept,onFile,detail}:{title:string,text:string,accept:string,onFile:(f?:File)=>void,detail:string}){return <div className="upload-card"><div><h2>{title}</h2><p>{text}</p><small>{detail}</small></div><label className="button secondary">Choose file<input type="file" accept={accept} hidden onChange={e=>onFile(e.target.files?.[0])}/></label></div>}
function ReviewCard({flag,review,onSave}:{flag:Flag,review?:ReviewRecord,onSave:(f:Flag,d:ReviewDecision,c:string,r:string)=>void}){
  const [decision,setDecision]=useState<ReviewDecision>(review?.decision||'Pending');const [comments,setComments]=useState(review?.comments||'');const [by,setBy]=useState(review?.reviewedBy||'')
  return <article className="review-card"><div className="review-main"><div className="rule-line"><span className={`severity ${flag.severity.toLowerCase()}`}>{flag.severity}</span><strong>{flag.ruleId} · {flag.ruleName}</strong></div><h3>{flag.investorName}</h3><div className="review-amount">{rm(flag.amount)}</div><p>{flag.reason}</p><div className="context-grid"><Context label="Investor ID" value={flag.investorId||'Not matched'}/><Context label="AML Risk" value={flag.riskProfile||'Not loaded'}/><Context label="Historical Avg Deposit" value={flag.historicalAverageDeposit?rm(flag.historicalAverageDeposit):'No history'}/><Context label="Historical Max Deposit" value={flag.historicalMaxDeposit?rm(flag.historicalMaxDeposit):'No history'}/></div>{flag.priorComplianceContext&&<div className="prior-context"><strong>Prior Compliance Context</strong><span>{flag.priorComplianceContext}</span></div>}<small>Source row(s): {flag.transactionRows.join(', ')} · Transactions: {flag.transactionCount}</small></div><div className="review-form"><label>Decision<select value={decision} onChange={e=>setDecision(e.target.value as ReviewDecision)}><option>Pending</option><option>Cleared</option><option>Request Information</option><option>Escalated</option></select></label><label>Reviewed by<input value={by} onChange={e=>setBy(e.target.value)} placeholder="Name"/></label><label>Compliance comments<textarea rows={4} value={comments} onChange={e=>setComments(e.target.value)} placeholder="Reason for decision / follow-up"/></label><button onClick={()=>onSave(flag,decision,comments,by)}>Save Review</button></div></article>
}
function Context({label,value}:{label:string,value:string}){return <div><span>{label}</span><strong>{value}</strong></div>}
