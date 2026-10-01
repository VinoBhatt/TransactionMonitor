import { useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, readDataset, request, writeDataset } from './api'
import type { Dataset } from './api'
import { Login, ChangePassword } from './Login'
import { canWrite, roleLabels } from '../shared/auth'
import type { User } from '../shared/auth'
import type { Signoff } from '../shared/schema'
import type { Flag, HistoricalInvestor, NoteMasterRow, PriorComplianceContext, ReviewDecision, ReviewRecord, RuleConfig, StaffMember, Transaction } from './types'
import { exportRowsToXlsx, monthKey, monthLabel, parseGenericTable, parseHistoricalWorkbook, parseNoteMaster, parsePriorMonitoringWorkbook, normalizeName, parseWorkbook, runRules, staffInvestments } from './monitoring'

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

export default function App(){
  const [user,setUser]=useState<User|null>(null)
  const [loading,setLoading]=useState(true),[changingPassword,setChangingPassword]=useState(false)
  const [error,setError]=useState('')
  useEffect(()=>{request<{user:User}>('/me').then(data=>setUser(data.user)).catch(e=>{
    if(!(e instanceof ApiError && e.status===401))setError(e.message)
  }).finally(()=>setLoading(false))},[])
  if(loading||error)return <main className="login-page"><div className="card"><h2>{error?'Workspace unavailable':'Opening workspace...'}</h2>{error&&<><p role="alert">{error}</p><button onClick={()=>window.location.reload()}>Retry</button></>}</div></main>
  if(!user)return <Login onLogin={setUser}/>
  if(user.mustChangePassword||changingPassword)return <ChangePassword user={user} onDone={()=>{setUser(null);setChangingPassword(false)}} onCancel={user.mustChangePassword?undefined:()=>setChangingPassword(false)}/>
  return <Workspace user={user} onLogout={()=>setUser(null)} onChangePassword={()=>setChangingPassword(true)}/>
}

function Workspace({user,onLogout,onChangePassword}:{user:User,onLogout:()=>void,onChangePassword:()=>void}){
  const [tab,setTab]=useState<Tab>('dashboard')
  const [transactions,setTransactions]=useState<Transaction[]>([])
  const [sourceName,setSourceName]=useState('')
  const [historyName,setHistoryName]=useState('')
  const [priorName,setPriorName]=useState('')
  const [rules,setRules]=useState<RuleConfig[]>(defaultRules)
  const [reviews,setReviews]=useState<Record<string,ReviewRecord>>({})
  const [staff,setStaff]=useState<StaffMember[]>([])
  const [notes,setNotes]=useState<NoteMasterRow[]>([])
  const [history,setHistory]=useState<HistoricalInvestor[]>([])
  const [priorContext,setPriorContext]=useState<PriorComplianceContext[]>([])
  const [filterMonth,setFilterMonth]=useState('')
  const [busy,setBusy]=useState(false)
  const [message,setMessage]=useState('')
  const [ready,setReady]=useState(false)
  const [signoffs,setSignoffs]=useState<Record<string,Signoff>>({})
  const versions=useRef<Record<string,string>>({})
  const saving=useRef(false)
  async function reload(){
    setReady(false)
    try{
      const datasets=await request<Dataset[]>('/datasets')
      const values:Record<string,unknown[]>={}
      // Sequential pages keep large workbook imports within request limits.
      for(const dataset of datasets)values[dataset.name]=await readDataset(dataset)
      versions.current=Object.fromEntries(datasets.map(d=>[d.name,d.version]))
      const tx=Object.entries(values).filter(([key])=>key.startsWith('transactions:')).flatMap(([,rows])=>rows) as (Omit<Transaction,'date'>&{date:string|null})[]
      setTransactions(tx.map(t=>({...t,date:t.date?new Date(t.date):null})))
      setStaff((values.staff||[]) as StaffMember[]);setNotes((values.notes||[]) as NoteMasterRow[])
      setHistory((values.history||[]) as HistoricalInvestor[]);setPriorContext((values.context||[]) as PriorComplianceContext[])
      const storedRules=(values.rules||[]) as RuleConfig[]
      setRules(defaultRules.map(r=>r.locked?r:{...r,...storedRules.find(x=>x.id===r.id)}))
      setReviews(Object.fromEntries(Object.entries(values).filter(([key])=>key.startsWith('review:')).flatMap(([,rows])=>(rows as ReviewRecord[]).map(r=>[r.flagId,r]))))
      setSignoffs(Object.fromEntries(Object.entries(values).filter(([key])=>key.startsWith('signoff:')).flatMap(([,rows])=>(rows as Signoff[]).map(r=>[r.month,r]))))
      setSourceName(datasets.filter(d=>d.name.startsWith('transactions:')).map(d=>d.source).filter((s,i,a)=>a.indexOf(s)===i).join(', '))
      setHistoryName(datasets.find(d=>d.name==='history')?.source||'');setPriorName(datasets.find(d=>d.name==='context')?.source||'')
      setReady(true)
    }catch(e){handleError(e)}
  }
  function handleError(e:unknown){
    if(e instanceof ApiError && e.status===401){onLogout();return}
    setMessage(e instanceof Error?e.message:'Could not save changes.')
  }
  useEffect(()=>{void reload()},[])
  async function persist(dataset:string,items:unknown[],source=''){
    const result=await writeDataset(dataset,versions.current[dataset]||'',items,source)
    versions.current[dataset]=result.version
  }
  async function save(action:()=>Promise<void>){
    if(saving.current)return
    saving.current=true;setBusy(true);setMessage('Saving changes?')
    try{await action();setMessage('Changes saved.')}catch(e){handleError(e)}
    finally{saving.current=false;setBusy(false)}
  }


  const flags=useMemo(()=>runRules(transactions,rules,history,priorContext),[transactions,rules,history,priorContext])
  const months=useMemo(()=>Array.from(new Set(transactions.map(t=>monthKey(t.date)).filter(x=>x!=='Unknown'))).sort().reverse(),[transactions])
  const activeMonth=filterMonth || months[0] || ''
  const monthTx=useMemo(()=>transactions.filter(t=>monthKey(t.date)===activeMonth),[transactions,activeMonth])
  const monthFlags=useMemo(()=>flags.filter(f=>f.monthKey===activeMonth),[flags,activeMonth])
  const staffRows=useMemo(()=>staffInvestments(monthTx,staff,notes),[monthTx,staff,notes])
  const investors=useMemo(()=>{
    const names = new Map<string, string>()
    for (const investor of [...history, ...transactions]) {
      const name = investor.name.trim()
      const key = normalizeName(name)
      if (key && !names.has(key)) names.set(key, name)
    }
    return [...names.values()].sort((a,b)=>a.localeCompare(b))
  },[history,transactions])
  const deposits=monthTx.filter(t=>t.action.trim().toLowerCase()==='deposit')
  const totalDeposit=deposits.reduce((s,t)=>s+t.amount,0)
  const pending=monthFlags.filter(f=>(reviews[f.id]?.decision||'Pending')==='Pending').length
  const mandatory=monthFlags.filter(f=>f.ruleId==='TM-001')
  const highRiskMandatory=mandatory.filter(f=>f.riskProfile?.toLowerCase()==='high').length

  const saveRules=(next:RuleConfig[])=>save(async()=>{await persist('rules',next);setRules(next)})
  const saveReview=(flag:Flag,decision:ReviewDecision,comments:string,reviewedBy:string)=>save(async()=>{
    const review={flagId:flag.id,decision,comments,reviewedBy,reviewedAt:new Date().toISOString()}
    await persist(`review:${flag.id}`,[review]);setReviews(previous=>({...previous,[flag.id]:review}))
  })
  const saveStaff=(next:StaffMember[])=>save(async()=>{await persist('staff',next);setStaff(next)})
  async function uploadTransactions(file?:File){
    if(!file)return
    await save(async()=>{
      const rows=await parseWorkbook(file)
      if(!rows.length)throw new Error('No transactions found in this file.')
      if(rows.some(t=>!t.date))throw new Error('Some transactions have invalid dates. Correct the file before importing.')
      const groups=new Map<string,Transaction[]>()
      for(const row of rows){const month=monthKey(row.date);if(!groups.has(month))groups.set(month,[]);groups.get(month)!.push(row)}
      for(const [month,items] of groups){
        await persist(`transactions:${month}`,items,file.name)
        setTransactions(previous=>[...previous.filter(t=>monthKey(t.date)!==month),...items])
        setReviews(previous=>Object.fromEntries(Object.entries(previous).filter(([key])=>!key.startsWith(`${month}|`))))
        setSignoffs(previous=>Object.fromEntries(Object.entries(previous).filter(([key])=>key!==month)))
        for(const key of Object.keys(versions.current)){if(key.startsWith(`review:${month}|`)||key===`signoff:${month}`)delete versions.current[key]}
      }
      setSourceName(file.name);setFilterMonth('');setTab('dashboard')
    })
  }
  async function uploadNotes(file?:File){if(file)await save(async()=>{
    const rows=parseNoteMaster(await parseGenericTable(file));if(!rows.length)throw new Error('No note records found.')
    await persist('notes',rows,file.name);setNotes(rows)
  })}
  async function uploadHistory(file?:File){if(file)await save(async()=>{
    const rows=await parseHistoricalWorkbook(file);if(!rows.length)throw new Error('No investor profiles found.')
    await persist('history',rows,file.name);setHistory(rows);setHistoryName(file.name)
  })}
  async function uploadPrior(file?:File){if(file)await save(async()=>{
    const rows=await parsePriorMonitoringWorkbook(file);if(!rows.length)throw new Error('No compliance comments found.')
    await persist('context',rows,file.name);setPriorContext(rows);setPriorName(file.name)
  })}

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
      <div className="workspace-toolbar"><span className="badge cleared">{user.displayName} | {roleLabels[user.role]}</span><div><button className="secondary" disabled={busy} onClick={onChangePassword}>Change password</button><button className="secondary" disabled={busy} onClick={()=>void reload()}>Refresh</button><button className="secondary" disabled={busy} onClick={()=>void request('/logout','POST',{}).then(onLogout).catch(handleError)}>Sign out</button></div></div>
      <header className="topbar"><div><h1>{tabTitle(tab)}</h1><p>{sourceName?`Source: ${sourceName}`:'No monthly transaction file loaded'}</p></div>{months.length>0&&<select value={activeMonth} onChange={e=>setFilterMonth(e.target.value)}>{months.map(m=><option key={m} value={m}>{monthLabel(m)}</option>)}</select>}</header>
      {message&&<div className="notice" role="status">{message}</div>}
      {!ready&&<div className="notice">Loading saved records? If loading fails, use Refresh to retry.</div>}
      <fieldset className="workspace-content" disabled={busy||!ready}>

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
        <StaffRegister investors={investors} staff={staff} onChange={saveStaff} />
        <UploadCard title="5. Note Master" text="Maps Note ID to Note Reference ID and Note Name for the Staff Investment Report." accept=".xlsx,.xls,.csv" onFile={uploadNotes} detail={notes.length?`${notes.length} notes saved`:'Awaiting note master'} />
        <div className="privacy"><strong>Shared records.</strong> Imported records and review decisions are saved to your workspace. Original spreadsheets are not stored. Reimporting a month replaces its transactions; other months are kept. Reimporting a month resets its review decisions and sign-off so corrected transactions are reviewed again.</div>
      </section>}

      {tab==='reviews'&&<section className="card full">
        <div className="card-head"><div><h2>{monthLabel(activeMonth)} flags</h2><p className="muted">Review the mandatory RM30k threshold and any optional behavioural flags. Historical information is context only; Compliance still makes the final decision.</p></div></div>
        {!monthFlags.length?<div className="empty-small">No flags for the selected month.</div>:<div className="review-list">{monthFlags.map(f=><ReviewCard key={`${f.id}:${reviews[f.id]?.reviewedAt||''}`} flag={f} review={reviews[f.id]} onSave={saveReview} reviewer={user.displayName}/>)}</div>}
      </section>}

      {tab==='staff'&&<section className="card full printable" id="staff-report">
        <div className="report-title"><span>Appendix II – Staff Investment Report</span><h2>STAFF INVESTMENT REPORT – {activeMonth?monthLabel(activeMonth).toUpperCase():'[MONTH] [YEAR]'}</h2><p>Consolidated report generated by the Compliance Unit from the platform pursuant to Clause 7.1.3 and tabled at the monthly Senior Management Team meeting for review of possible conflicts of interest.</p></div>
        {!staff.some(s=>s.active)?<div className="callout">Select staff from the investor dropdown under <strong>Monthly Upload</strong> to enable staff matching.</div>:<><div className="actions"><button onClick={()=>exportRowsToXlsx(`Staff Investment Report - ${activeMonth}.xlsx`,'Staff Investment',staffExport)}>Export Excel</button><button className="secondary" onClick={()=>window.print()}>Print / Save PDF</button></div><div className="table-wrap"><table className="report-table"><thead><tr><th>No.</th><th>Note Reference ID</th><th>Note Name</th><th>Staff Name</th><th>Amount (RM)</th><th>Status</th><th>Date / Time</th></tr></thead><tbody>{staffRows.map((x,i)=><tr key={`${x.transaction.sourceRow}-${i}`}><td>{i+1}</td><td>{x.note?.referenceId||x.transaction.noteId}</td><td className={!x.note?.noteName?'missing':''}>{x.note?.noteName||'Note master required'}</td><td>{x.staff.name}</td><td className="num">{x.transaction.amount.toLocaleString('en-MY',{minimumFractionDigits:2})}</td><td>Successful</td><td>{fmtDate(x.transaction.date)}</td></tr>)}{!staffRows.length&&<tr><td colSpan={7} className="center">No staff investment transactions detected.</td></tr>}</tbody><tfoot><tr><td colSpan={4}>Total staff investment for the month</td><td className="num">{staffRows.reduce((s,x)=>s+x.transaction.amount,0).toLocaleString('en-MY',{minimumFractionDigits:2})}</td><td colSpan={2}></td></tr></tfoot></table></div></>}
      </section>}

      {tab==='rules'&&<fieldset className="workspace-content" disabled={!canWrite(user.role,'rules')}><RulesEditor key={JSON.stringify(rules)} initial={rules} onSave={saveRules}/></fieldset>}

      {tab==='reports'&&<section className="grid2">
        <div className="card"><h2>Monthly Deposit Monitoring Report</h2><p className="muted">Carries forward your earlier flagged-deposit format, now enriched with Investor ID, AML risk, historical average, prior compliance context and review audit fields.</p><div className="report-metrics"><Summary label="Review month" value={monthLabel(activeMonth)}/><Summary label="Flagged investors (TM-001)" value={String(mandatory.length)}/><Summary label="Total flagged amount" value={rm(mandatory.reduce((s,f)=>s+f.amount,0))}/><Summary label="Pending" value={String(mandatory.filter(f=>(reviews[f.id]?.decision||'Pending')==='Pending').length)}/></div><button disabled={!mandatory.length} onClick={()=>exportRowsToXlsx(`Monthly Deposit Monitoring - ${activeMonth}.xlsx`,'Flagged Deposits',reportRows)}>Export Monitoring Excel</button></div>
        <SignoffForm user={user} key={`${activeMonth}:${signoffs[activeMonth]?.updatedAt||''}`} month={activeMonth} saved={signoffs[activeMonth]} onSave={value=>save(async()=>{await persist(`signoff:${activeMonth}`,[value]);setSignoffs(previous=>({...previous,[activeMonth]:value}))})}/>

      </section>}
      </fieldset>
    </main>
  </div>
}

function RulesEditor({initial,onSave}:{initial:RuleConfig[],onSave:(next:RuleConfig[])=>void}){
  const [rules,setDraft]=useState(initial)
  return <section className="stack"><div className="callout"><strong>TM-001 is mandatory and fixed.</strong> Aggregate deposits must be strictly greater than RM30,000 to trigger it; RM30,000.00 exactly does not trigger TM-001.</div>{rules.map(r=><div className="rule-card" key={r.id}><div><div className="rule-id">{r.id}</div><h3>{r.name}</h3><p>{r.description}</p></div><div className="rule-controls"><label>{r.id==='TM-006'?'Multiple / threshold':'Threshold'}<input type="number" value={r.threshold??0} disabled={r.locked} onChange={e=>setDraft(rules.map(x=>x.id===r.id?{...x,threshold:Number(e.target.value)}:x))}/></label><label className="switch-row"><input type="checkbox" checked={r.enabled} disabled={r.locked} onChange={e=>setDraft(rules.map(x=>x.id===r.id?{...x,enabled:e.target.checked}:x))}/>{r.locked?'Mandatory':'Enabled'}</label></div></div>)}<button onClick={()=>onSave(rules)}>Save Rules</button></section>
}

function SignoffForm({month,saved,onSave,user}:{month:string,saved?:Signoff,onSave:(value:Signoff)=>void,user:User}){
  const [reviewedBy]=useState(user.displayName),[designation,setDesignation]=useState(saved?.designation||''),[comments,setComments]=useState(saved?.comments||''),[status,setStatus]=useState<Signoff['status']>(saved?.status||'Pending')
  return <form className="card" onSubmit={e=>{e.preventDefault();onSave({month,reviewedBy,designation,comments,status,updatedAt:new Date().toISOString()})}}><h2>Compliance Sign-Off</h2><p className="muted">Save the conclusion for {month?monthLabel(month):'the selected month'}. Sign-off records a review; it does not lock further edits.</p><div className="signoff"><label>Reviewed by<input readOnly value={reviewedBy}/></label><label>Designation<input required value={designation} onChange={e=>setDesignation(e.target.value)}/></label><label>Review comments<textarea rows={4} value={comments} onChange={e=>setComments(e.target.value)}/></label><label>Status<select value={status} onChange={e=>setStatus(e.target.value as Signoff['status'])}><option>Pending</option><option>Completed</option></select></label></div>{saved&&<p className="muted">Saved {new Date(saved.updatedAt).toLocaleString()}</p>}<div className="actions"><button disabled={!month||!canWrite(user.role,`signoff:${month}`)}>Save Sign-Off</button><button type="button" className="secondary" onClick={()=>window.print()}>Print Sign-Off</button></div></form>
}

function StaffRegister({investors,staff,onChange}:{investors:string[],staff:StaffMember[],onChange:(next:StaffMember[])=>void}) {
  const available = investors.filter(name=>!staff.some(s=>s.active && normalizeName(s.name)===normalizeName(name)))
  function selectStaff(name:string) {
    if (!available.includes(name)) return
    const key = normalizeName(name)
    const existing = staff.find(s=>normalizeName(s.name)===key)
    onChange(existing
      ? staff.map(s=>normalizeName(s.name)===key ? {...s,active:true} : s)
      : [...staff,{id:crypto.randomUUID(),name,active:true}])
  }
  return <div className="card stack">
    <div><h2>4. Staff Register</h2><p className="muted">Select investors who are staff members to include their investments in Appendix II. Your selections are saved to the shared workspace.</p></div>
    <label>Choose an investor to add as staff
      <select value="" disabled={!available.length} onChange={e=>selectStaff(e.target.value)}>
        <option value="">{!investors.length?'Upload transactions or a historical investor workbook first':!available.length?'All loaded investors are already selected':'Select an investor…'}</option>
        {available.map(name=><option key={normalizeName(name)} value={name}>{name}</option>)}
      </select>
    </label>
    <div className="summary-list">
      {staff.filter(s=>s.active).map(s=><div className="summary-row" key={s.id}><strong>{s.name}</strong><button className="secondary" aria-label={`Remove ${s.name} from staff`} onClick={()=>onChange(staff.filter(x=>normalizeName(x.name)!==normalizeName(s.name)))}>Remove</button></div>)}
      {!staff.some(s=>s.active)&&<p className="muted">No staff selected yet. Add each staff member using the dropdown.</p>}
    </div>
  </div>
}

function tabTitle(tab:Tab){return ({dashboard:'Monthly Monitoring Dashboard',upload:'Monthly Data Upload',reviews:'Compliance Review Queue',staff:'Staff Investment Report',rules:'Monitoring Rules',reports:'Reports & Sign-Off'} as Record<Tab,string>)[tab]}
function Kpi({label,value,sub,tone=''}:{label:string,value:string,sub:string,tone?:string}){return <div className={`kpi ${tone}`}><span>{label}</span><strong>{value}</strong><small>{sub}</small></div>}
function Summary({label,value}:{label:string,value:string}){return <div className="summary-row"><span>{label}</span><strong>{value}</strong></div>}
function StatusBadge({value}:{value:string}){return <span className={`badge ${value.toLowerCase().replace(/\s+/g,'-')}`}>{value}</span>}
function RiskBadge({value}:{value?:string}){const v=value||'Unknown';return <span className={`badge risk-${v.toLowerCase()}`}>{v}</span>}
function EmptyUpload({onFile,busy}:{onFile:(f?:File)=>void,busy:boolean}){return <div className="hero-empty"><div className="upload-icon">⇧</div><h2>Upload the monthly Cofundr transaction log</h2><p>The mandatory RM30,000 aggregate monthly deposit rule will run automatically.</p><label className="button">{busy?'Reading file…':'Choose Excel / CSV'}<input type="file" accept=".xlsx,.xls,.csv" hidden onChange={e=>onFile(e.target.files?.[0])}/></label></div>}
function UploadCard({title,text,accept,onFile,detail}:{title:string,text:string,accept:string,onFile:(f?:File)=>void,detail:string}){return <div className="upload-card"><div><h2>{title}</h2><p>{text}</p><small>{detail}</small></div><label className="button secondary">Choose file<input type="file" accept={accept} hidden onChange={e=>onFile(e.target.files?.[0])}/></label></div>}
function ReviewCard({flag,review,onSave,reviewer}:{flag:Flag,review?:ReviewRecord,reviewer:string,onSave:(f:Flag,d:ReviewDecision,c:string,r:string)=>void}){
  const [decision,setDecision]=useState<ReviewDecision>(review?.decision||'Pending');const [comments,setComments]=useState(review?.comments||'');const by=reviewer
  return <article className="review-card"><div className="review-main"><div className="rule-line"><span className={`severity ${flag.severity.toLowerCase()}`}>{flag.severity}</span><strong>{flag.ruleId} · {flag.ruleName}</strong></div><h3>{flag.investorName}</h3><div className="review-amount">{rm(flag.amount)}</div><p>{flag.reason}</p><div className="context-grid"><Context label="Investor ID" value={flag.investorId||'Not matched'}/><Context label="AML Risk" value={flag.riskProfile||'Not loaded'}/><Context label="Historical Avg Deposit" value={flag.historicalAverageDeposit?rm(flag.historicalAverageDeposit):'No history'}/><Context label="Historical Max Deposit" value={flag.historicalMaxDeposit?rm(flag.historicalMaxDeposit):'No history'}/></div>{flag.priorComplianceContext&&<div className="prior-context"><strong>Prior Compliance Context</strong><span>{flag.priorComplianceContext}</span></div>}<small>Source row(s): {flag.transactionRows.join(', ')} · Transactions: {flag.transactionCount}</small></div><div className="review-form"><label>Decision<select value={decision} onChange={e=>setDecision(e.target.value as ReviewDecision)}><option>Pending</option><option>Cleared</option><option>Request Information</option><option>Escalated</option></select></label><label>Reviewed by<input value={by} readOnly/></label><label>Compliance comments<textarea rows={4} value={comments} onChange={e=>setComments(e.target.value)} placeholder="Reason for decision / follow-up"/></label><button onClick={()=>onSave(flag,decision,comments,by)}>Save Review</button></div></article>
}
function Context({label,value}:{label:string,value:string}){return <div><span>{label}</span><strong>{value}</strong></div>}
