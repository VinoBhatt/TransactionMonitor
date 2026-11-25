import { useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, mapLimit, readDataset, request, writeDataset } from './api'
import type { Dataset } from './api'
import { Login, ChangePassword } from './Login'
import { canViewAudit, canWrite, roleLabels } from '../shared/auth'
import type { User } from '../shared/auth'
import { AdminPanel } from './AdminPanel'
import { MonthlyReports } from './MonthlyReports'
import { AmlReviews } from './AmlReviews'
import { Screening } from './Screening'
import type { Signoff } from '../shared/schema'
import type { AmlReviewRecord, CustomerProfile, Flag, ScreeningDecision, ScreeningMatch, HistoricalInvestor, InvestorRecord, NoteMasterRow, PriorComplianceContext, ReviewDecision, ReviewRecord, RuleConfig, StaffMember, Transaction } from './types'
import { exportRowsToXlsx, monthKey, monthLabel, parseHistoricalWorkbook, parsePriorMonitoringWorkbook, normalizeName, parseWorkbook, runRules, staffInvestments, parseNoteWorkbook, parseInvestorDirectory, investorLookup, parseCustomerProfiles, profileLookup, nextMonth, transactionFingerprint, previousClearance, sameReasonComment } from './monitoring'
import type { PreviousClearance } from './monitoring'

type Tab = 'dashboard'|'upload'|'reviews'|'staff'|'rules'|'reports'|'aml'|'screening'|'admin'

const defaultRules: RuleConfig[] = [
  { id:'TM-001', name:'Monthly Deposit Threshold', description:'Mandatory: flag when aggregate Deposit transactions for the same investor exceed RM30,000 in a calendar month.', enabled:true, locked:true, threshold:30000 },
  { id:'TM-002', name:'Single Large Deposit', description:'Optional: flag when one Deposit exceeds the configured amount.', enabled:false, locked:false, threshold:100000 },
  { id:'TM-003', name:'Deposit Frequency', description:'Optional: flag when an investor makes at least the configured number of deposits in the month.', enabled:false, locked:false, threshold:3 },
  { id:'TM-004', name:'Rapid Deposit / Withdrawal', description:'Optional: flag where a withdrawal of at least 80% of a deposit follows within the configured number of days.', enabled:false, locked:false, threshold:3 },
  { id:'TM-005', name:'High-Risk Customer Deposit', description:'Optional: use the AML risk rating (Customer Risk Profiling, else the historical workbook) and flag High-risk customers whose monthly deposits exceed the configured amount.', enabled:false, locked:false, threshold:10000 },
  { id:'TM-006', name:'Historical Deposit Spike', description:'Optional: flag when current monthly deposits are at least the configured multiple of the investor\'s average positive historical monthly deposits, and also exceed RM30,000.', enabled:false, locked:false, threshold:3 },
  { id:'TM-007', name:'Large Monthly Withdrawals', description:'Optional: flag when aggregate withdrawals for the same investor exceed the configured amount in a calendar month. Rejected withdrawals are ignored.', enabled:false, locked:false, threshold:30000 },
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
  // Transactions are loaded per month on demand; the full history is too large to load at sign-in.
  const [txByMonth,setTxByMonth]=useState<Record<string,Transaction[]>>({})
  const [months,setMonths]=useState<string[]>([])
  const [loadingMonth,setLoadingMonth]=useState(false)
  const datasetIndex=useRef<Record<string,Dataset>>({})
  const [sourceName,setSourceName]=useState('')
  const [historyName,setHistoryName]=useState('')
  const [priorName,setPriorName]=useState('')
  const [rules,setRules]=useState<RuleConfig[]>(defaultRules)
  const [reviews,setReviews]=useState<Record<string,ReviewRecord>>({})
  const [staff,setStaff]=useState<StaffMember[]>([])
  const [notes,setNotes]=useState<NoteMasterRow[]>([])
  const [directory,setDirectory]=useState<InvestorRecord[]>([]),[directoryName,setDirectoryName]=useState(''),[notesName,setNotesName]=useState('')
  const [history,setHistory]=useState<HistoricalInvestor[]>([])
  const [profiles,setProfiles]=useState<CustomerProfile[]>([]),[profilesName,setProfilesName]=useState('')
  const [amlDone,setAmlDone]=useState<Record<string,AmlReviewRecord>>({})
  const [screening,setScreening]=useState<ScreeningMatch[]>([]),[screeningRun,setScreeningRun]=useState(''),[screenDecisions,setScreenDecisions]=useState<Record<string,ScreeningDecision>>({})
  const [priorContext,setPriorContext]=useState<PriorComplianceContext[]>([])
  const [filterMonth,setFilterMonth]=useState('')
  const [busy,setBusy]=useState(false)
  const [message,setMessage]=useState(''),[summary,setSummary]=useState('')
  const [ready,setReady]=useState(false)
  const [signoffs,setSignoffs]=useState<Record<string,Signoff>>({})
  const versions=useRef<Record<string,string>>({})
  const saving=useRef(false)
  async function reload(){
    setReady(false)
    try{
      const datasets=await request<Dataset[]>('/datasets')
      const values:Record<string,unknown[]>={}
      const small=datasets.filter(d=>!d.name.startsWith('transactions:'))
      // A few requests in parallel keeps sign-in quick as review records accumulate.
      await mapLimit(small,6,async dataset=>{values[dataset.name]=await readDataset(dataset)})
      versions.current=Object.fromEntries(datasets.map(d=>[d.name,d.version]))
      datasetIndex.current=Object.fromEntries(datasets.map(d=>[d.name,d]))
      setTxByMonth({})
      setMonths(datasets.filter(d=>d.name.startsWith('transactions:')).map(d=>d.name.slice(13)).sort().reverse())
      setStaff((values.staff||[]) as StaffMember[]);setNotes((values.notes||[]) as NoteMasterRow[]);setDirectory((values.investors||[]) as InvestorRecord[]);setProfiles((values.profiles||[]) as CustomerProfile[])
      setHistory((values.history||[]) as HistoricalInvestor[]);setPriorContext((values.context||[]) as PriorComplianceContext[])
      const storedRules=(values.rules||[]) as RuleConfig[]
      setRules(defaultRules.map(r=>r.locked?r:{...r,...storedRules.find(x=>x.id===r.id)}))
      setReviews(Object.fromEntries(Object.entries(values).filter(([key])=>key.startsWith('review:')).flatMap(([,rows])=>(rows as ReviewRecord[]).map(r=>[r.flagId,r]))))
      setAmlDone(Object.fromEntries(Object.entries(values).filter(([key])=>key.startsWith('amlreview:')).flatMap(([,rows])=>(rows as AmlReviewRecord[]).map(r=>[r.investorId,r]))))
      setScreenDecisions(Object.fromEntries(Object.entries(values).filter(([key])=>key.startsWith('screen:')).flatMap(([,rows])=>(rows as ScreeningDecision[]).map(r=>[r.key,r]))))
      setScreening((values.screening||[]) as ScreeningMatch[]);setScreeningRun(datasets.find(d=>d.name==='screening')?.source||'')
      setSignoffs(Object.fromEntries(Object.entries(values).filter(([key])=>key.startsWith('signoff:')).flatMap(([,rows])=>(rows as Signoff[]).map(r=>[r.month,r]))))
      setSourceName(datasets.filter(d=>d.name.startsWith('transactions:')).map(d=>d.source).filter((s,i,a)=>a.indexOf(s)===i).join(', '))
      setHistoryName(datasets.find(d=>d.name==='history')?.source||'');setPriorName(datasets.find(d=>d.name==='context')?.source||'');setDirectoryName(datasets.find(d=>d.name==='investors')?.source||'');setNotesName(datasets.find(d=>d.name==='notes')?.source||'');setProfilesName(datasets.find(d=>d.name==='profiles')?.source||'')
      setReady(true)
    }catch(e){handleError(e)}
  }
  function handleError(e:unknown){
    if(e instanceof ApiError && e.status===401){onLogout();return}
    setMessage(e instanceof Error?e.message:'Could not save changes.')
  }
  useEffect(()=>{void reload()},[])
  async function readMonth(month:string){
    const dataset=datasetIndex.current[`transactions:${month}`]
    if(!dataset)return []
    const rows=await readDataset<Omit<Transaction,'date'>&{date:string|null}>(dataset)
    return rows.map(t=>({...t,date:t.date?new Date(t.date):null}))
  }
  async function persist(dataset:string,items:unknown[],source=''){
    const result=await writeDataset(dataset,versions.current[dataset]||'',items,source)
    versions.current[dataset]=result.version
  }
  async function save(action:()=>Promise<void|string>){
    if(saving.current)return
    saving.current=true;setBusy(true);setMessage('Saving changes…')
    setSummary('')
    try{const summary=await action();setMessage('Changes saved.');if(summary)setSummary(summary)}catch(e){handleError(e)}
    finally{saving.current=false;setBusy(false)}
  }


  const monthlyTab=['dashboard','reviews','staff','reports','upload'].includes(tab)
  // Success messages fade after a few seconds; errors stay until the next action.
  useEffect(()=>{if(message!=='Changes saved.')return;const timer=setTimeout(()=>setMessage(m=>m==='Changes saved.'?'':m),5000);return ()=>clearTimeout(timer)},[message])
  const findInvestor=useMemo(()=>investorLookup(directory),[directory])
  const findProfile=useMemo(()=>profileLookup(profiles,findInvestor),[profiles,findInvestor])
  const today=new Date().toISOString().slice(0,10)
  const overdueProfiles=profiles.filter(p=>{const due=[p.nextReviewDate,amlDone[p.investorId]?.nextReviewDate].filter(Boolean).sort().pop();return !!due&&due<today})
  const amlDue=overdueProfiles.length
  const screeningPending=screening.filter(m=>!screenDecisions[m.key]).length
  // Everyone in the directory plus corporate business names from the risk profiles.
  const screenedNames=useMemo(()=>{
    const seen=new Set<string>(),out:{investorId:string,name:string}[]=[]
    const add=(investorId:string,name?:string)=>{const key=`${investorId}|${normalizeName(name||'')}`;if(name&&!seen.has(key)){seen.add(key);out.push({investorId,name})}}
    for(const i of directory)add(i.investorId,i.name)
    for(const p of profiles){add(p.investorId,p.name);add(p.investorId,p.businessName)}
    return out
  },[directory,profiles])
  // Fill investor IDs from the platform directory when the AML workbook has no match.
  const activeMonth=filterMonth || months[0] || ''
  // The following month is loaded too, so TM-004 sees withdrawals just after a month-end deposit.
  const neededMonths=useMemo(()=>activeMonth?[activeMonth,nextMonth(activeMonth)].filter(m=>months.includes(m)):[],[activeMonth,months])
  useEffect(()=>{
    const missing=neededMonths.filter(m=>!txByMonth[m])
    if(!ready||!missing.length){setLoadingMonth(false);return}
    let cancelled=false
    setLoadingMonth(true)
    Promise.all(missing.map(async m=>[m,await readMonth(m)] as const))
      .then(loaded=>{if(!cancelled)setTxByMonth(previous=>({...previous,...Object.fromEntries(loaded)}))})
      .catch(handleError).finally(()=>{if(!cancelled)setLoadingMonth(false)})
    return ()=>{cancelled=true}
  },[neededMonths,txByMonth,ready])
  const transactions=useMemo(()=>neededMonths.flatMap(m=>txByMonth[m]||[]),[neededMonths,txByMonth])
  const flags=useMemo(()=>runRules(transactions,rules,history,priorContext,findProfile).map(f=>({...f,investorId:f.investorId||findInvestor(f.investorName)?.investorId,riskProfile:f.riskProfile||(profiles.length?(f.customerType?'No rating':'Not profiled'):undefined)})),[transactions,rules,history,priorContext,findInvestor,findProfile,profiles.length])
  const monthTx=useMemo(()=>transactions.filter(t=>monthKey(t.date)===activeMonth),[transactions,activeMonth])
  const monthFlags=useMemo(()=>flags.filter(f=>f.monthKey===activeMonth),[flags,activeMonth])
  const staffRows=useMemo(()=>staffInvestments(monthTx,staff,notes),[monthTx,staff,notes])
  const investors=useMemo(()=>{
    const names = new Map<string, string>()
    // Fall back to names in the loaded month only when no investor directory is available.
    for (const investor of [...directory, ...history, ...(directory.length?[]:transactions.filter(t=>t.userType.toLowerCase()!=='issuer'))]) {
      const name = investor.name.trim()
      const key = normalizeName(name)
      if (key && !names.has(key)) names.set(key, name)
    }
    return [...names.values()].sort((a,b)=>a.localeCompare(b))
  },[directory,history,transactions])
  const deposits=monthTx.filter(t=>t.action.trim().toLowerCase()==='deposit')
  const totalDeposit=deposits.reduce((s,t)=>s+t.amount,0)
  const pending=monthFlags.filter(f=>(reviews[f.id]?.decision||'Pending')==='Pending').length
  const mandatory=monthFlags.filter(f=>f.ruleId==='TM-001')
  const highRiskMandatory=mandatory.filter(f=>f.riskProfile?.toLowerCase()==='high').length

  const saveRules=(next:RuleConfig[])=>save(async()=>{await persist('rules',next);setRules(next)})
  async function storeReview(flag:Flag,decision:ReviewDecision,comments:string,reviewedBy:string){
    const review:ReviewRecord={flagId:flag.id,decision,comments,reviewedBy,reviewedAt:new Date().toISOString(),investorName:flag.investorName,...(flag.investorId?{investorId:flag.investorId}:{})}
    await persist(`review:${flag.id}`,[review]);setReviews(previous=>({...previous,[flag.id]:review}))
  }
  const saveReview=(flag:Flag,decision:ReviewDecision,comments:string,reviewedBy:string)=>save(()=>storeReview(flag,decision,comments,reviewedBy))
  const previousClearances=useMemo(()=>Object.fromEntries(monthFlags.map(f=>[f.id,previousClearance(f,reviews)] as const).filter((e):e is [string,PreviousClearance]=>!!e[1])),[monthFlags,reviews])
  const repeatPending=monthFlags.filter(f=>(reviews[f.id]?.decision||'Pending')==='Pending'&&previousClearances[f.id])
  const clearRepeats=()=>{
    if(!window.confirm(`Clear ${repeatPending.length} pending flag(s) for investors who were cleared in an earlier month, using the same reason? Each flag is recorded as reviewed by you.`))return
    void save(async()=>{
      for(const f of repeatPending)await storeReview(f,'Cleared',sameReasonComment(previousClearances[f.id]),user.displayName)
      return `${repeatPending.length} repeat flag(s) cleared with their previous reason.`
    })
  }
  const saveStaff=(next:StaffMember[])=>save(async()=>{await persist('staff',next);setStaff(next)})
  // Sends an alert email when one is due. Problems are reported in the summary, never as a failed save.
  async function notify(payload:unknown){
    try{
      const result=await request<{sent:boolean,recipients?:number}>('/notifications/send','POST',payload)
      return result.sent?` Email alert sent to ${result.recipients} recipient(s).`:''
    }catch(e){
      if(e instanceof ApiError&&e.status===503)return ''
      return ` Email alert could not be sent: ${e instanceof Error?e.message:'unknown error'}`
    }
  }
  async function uploadTransactions(file?:File){
    if(!file)return
    await save(async()=>{
      const rows=await parseWorkbook(file)
      if(!rows.length)throw new Error('No transactions found in this file.')
      if(rows.some(t=>!t.date))throw new Error('Some transactions have invalid dates. Correct the file before importing.')
      const groups=new Map<string,Transaction[]>()
      for(const row of rows){const month=monthKey(row.date);if(!groups.has(month))groups.set(month,[]);groups.get(month)!.push(row)}
      // Replacing a month resets its reviews and sign-off, so months whose transactions are
      // unchanged (e.g. when the full Admin Panel history is uploaded again) are left alone.
      const changed:string[]=[],unchanged:string[]=[]
      for(const [month,items] of [...groups].sort(([a],[b])=>a.localeCompare(b))){
        const dataset=`transactions:${month}`
        if(datasetIndex.current[dataset]&&transactionFingerprint(txByMonth[month]||await readMonth(month))===transactionFingerprint(items)){unchanged.push(month);continue}
        setMessage(`Saving ${monthLabel(month)}…`)
        await persist(dataset,items,file.name)
        datasetIndex.current[dataset]={name:dataset,version:versions.current[dataset],source:file.name,updated_at:new Date().toISOString()}
        changed.push(month)
        setTxByMonth(previous=>({...previous,[month]:items}))
        setReviews(previous=>Object.fromEntries(Object.entries(previous).filter(([key])=>!key.startsWith(`${month}|`))))
        setSignoffs(previous=>Object.fromEntries(Object.entries(previous).filter(([key])=>key!==month)))
        for(const key of Object.keys(versions.current)){if(key.startsWith(`review:${month}|`)||key===`signoff:${month}`)delete versions.current[key]}
      }
      setMonths(Object.keys(datasetIndex.current).filter(k=>k.startsWith('transactions:')).map(k=>k.slice(13)).sort().reverse())
      setSourceName(file.name);setFilterMonth(changed.length?changed[changed.length-1]:'');setTab('dashboard')
      // Alert on the months that were replaced and now have flags.
      const flagged=changed.map(month=>{
        const found=runRules([...(groups.get(month)||[]),...(groups.get(nextMonth(month))||txByMonth[nextMonth(month)]||[])],rules,history,priorContext,findProfile).filter(f=>f.monthKey===month)
        const tm001=found.filter(f=>f.ruleId==='TM-001')
        return {month,tm001:tm001.length,tm001Amount:Math.round(tm001.reduce((s,f)=>s+f.amount,0)*100)/100,total:found.length}
      }).filter(m=>m.total>0)
      const emailed=flagged.length?await notify({event:'flags',months:flagged.slice(-36)}):''
      return `Import complete: ${changed.length} month(s) updated${changed.length?` (${changed.map(monthLabel).join(', ')})`:''}; ${unchanged.length} unchanged month(s) kept with their reviews.${emailed}`
    })
  }
  async function uploadNotes(file?:File){if(file)await save(async()=>{
    const rows=await parseNoteWorkbook(file);if(!rows.length)throw new Error('No note records found.')
    await persist('notes',rows,file.name);setNotes(rows);setNotesName(file.name)
  })}
  async function uploadDirectory(file?:File){if(file)await save(async()=>{
    const rows=await parseInvestorDirectory(file);if(!rows.length)throw new Error('No investors found in this file.')
    await persist('investors',rows,file.name);setDirectory(rows);setDirectoryName(file.name)
  })}
  async function completeAml(record:Omit<AmlReviewRecord,'completedBy'|'completedAt'>){await save(async()=>{
    const row={...record,completedBy:user.displayName,completedAt:new Date().toISOString()}
    await persist(`amlreview:${record.investorId}`,[row]);setAmlDone(d=>({...d,[record.investorId]:row}))
  })}
  async function saveScreening(matches:ScreeningMatch[],summary:string){await save(async()=>{
    await persist('screening',matches,summary.slice(0,500));setScreening(matches);setScreeningRun(summary.slice(0,500))
    if(!matches.length)return ''
    const emailed=await notify({event:'screening',unsc:matches.filter(m=>m.list==='UNSC').length,moha:matches.filter(m=>m.list==='MOHA').length})
    return emailed?`Screening saved: ${matches.length} possible match(es).${emailed}`:''
  })}
  async function decideScreening(key:string,decision:ScreeningDecision['decision'],comments:string){await save(async()=>{
    const row={key,decision,comments,reviewedBy:user.displayName,reviewedAt:new Date().toISOString()}
    await persist(`screen:${key}`,[row]);setScreenDecisions(d=>({...d,[key]:row}))
  })}
  async function uploadProfiles(file?:File){if(file)await save(async()=>{
    const rows=await parseCustomerProfiles(file);if(!rows.length)throw new Error('No customer profiles found. Expected sheets with Investor ID, Investor Name and AML Risk Rating columns.')
    await persist('profiles',rows,file.name);setProfiles(rows);setProfilesName(file.name)
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


  const monthlyReports=<MonthlyReports month={activeMonth} transactions={monthTx} flags={monthFlags} reviews={reviews} signoff={signoffs[activeMonth]} staff={staff} notes={notes} investors={directory} generatedBy={user.displayName}/>

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark">C</div><div><strong>Cofundr</strong><span>Transaction Monitoring</span></div></div>
      <nav>
        <span className="nav-group">Monthly monitoring</span>
        <NavButton tab="dashboard" current={tab} onSelect={setTab} label="Dashboard"/>
        <NavButton tab="reviews" current={tab} onSelect={setTab} label="Review Queue" count={pending}/>
        <NavButton tab="staff" current={tab} onSelect={setTab} label="Staff Investment"/>
        <NavButton tab="reports" current={tab} onSelect={setTab} label="Reports & Sign-Off"/>
        <span className="nav-group">Customer due diligence</span>
        <NavButton tab="aml" current={tab} onSelect={setTab} label="AML Reviews" count={amlDue}/>
        <NavButton tab="screening" current={tab} onSelect={setTab} label="Sanctions Screening" count={screeningPending}/>
        <span className="nav-group">Setup</span>
        <NavButton tab="upload" current={tab} onSelect={setTab} label="Monthly Upload"/>
        <NavButton tab="rules" current={tab} onSelect={setTab} label="Monitoring Rules"/>
        {canViewAudit(user.role)&&<NavButton tab="admin" current={tab} onSelect={setTab} label="Administration"/>}
      </nav>
      <div className="sidebar-note"><strong>Mandatory control</strong><span>TM-001 flags aggregate monthly deposits strictly above RM30,000. This control cannot be disabled.</span></div>
    </aside>

    <main>
      <div className="workspace-toolbar"><span className="user-chip"><span className="avatar">{user.displayName.slice(0,1).toUpperCase()}</span><span><strong>{user.displayName}</strong>{user.displayName!==roleLabels[user.role]&&<small>{roleLabels[user.role]}</small>}</span></span><div><button className="secondary" disabled={busy} onClick={onChangePassword}>Change password</button><button className="secondary" disabled={busy} onClick={()=>void reload()}>Refresh</button><button className="secondary" disabled={busy} onClick={()=>void request('/logout','POST',{}).then(onLogout).catch(handleError)}>Sign out</button></div></div>
      <header className="topbar"><div><h1>{tabTitle(tab)}</h1><p>{monthlyTab?(sourceName?`Source: ${sourceName}`:'No monthly transaction file loaded'):tabSubtitle(tab)}</p></div>{monthlyTab&&months.length>0&&<label className="month-picker">Review month<select value={activeMonth} onChange={e=>setFilterMonth(e.target.value)}>{months.map(m=><option key={m} value={m}>{monthLabel(m)}</option>)}</select></label>}</header>
      {message&&<div className={`notice ${noticeTone(message)}`} role="status">{message}</div>}
      {summary&&<div className="notice success dismissible"><span>{summary}</span><button className="link" aria-label="Dismiss" onClick={()=>setSummary('')}>×</button></div>}
      {!ready&&<div className="notice">Loading saved records… If loading fails, use Refresh to retry.</div>}
      {ready&&loadingMonth&&<div className="notice">Loading {monthLabel(activeMonth)} transactions…</div>}
      <fieldset className="workspace-content" disabled={busy||!ready}>

      {tab==='dashboard'&&<>{!months.length?<EmptyUpload onFile={uploadTransactions} busy={busy}/>:<>
        <section className="kpis">
          <Kpi label="Transactions analysed" value={monthTx.length.toLocaleString()} sub={monthLabel(activeMonth)}/>
          <Kpi label="Deposits" value={rm(totalDeposit)} sub={`${deposits.length} deposit transaction(s)`}/>
          <Kpi label="Investors > RM30k" value={mandatory.length.toString()} sub="Mandatory TM-001" tone={mandatory.length?'warn':''}/>
          <Kpi label="Pending reviews" value={pending.toString()} sub={`${monthFlags.length} total flag(s)`} tone={pending?'danger':'good'}/>
        </section>
        <section className="grid2">
          <div className="card"><div className="card-head"><h2>Mandatory threshold review</h2><button className="link" onClick={()=>setTab('reviews')}>Open review queue →</button></div>{mandatory.length?<div className="table-wrap"><table><thead><tr><th>Investor</th><th>Risk</th><th>Monthly Deposits</th><th>History</th><th>Status</th></tr></thead><tbody>{mandatory.slice(0,10).map(f=><tr key={f.id}><td>{f.investorName}<small className="subline">{f.investorId?`ID ${f.investorId}`:''}</small></td><td><RiskBadge value={f.riskProfile}/></td><td>{rm(f.amount)}</td><td>{f.historicalAverageDeposit?`${(f.amount/f.historicalAverageDeposit).toFixed(1)}× avg`:'—'}</td><td><StatusBadge value={reviews[f.id]?.decision||'Pending'}/></td></tr>)}</tbody></table></div>:<div className="empty-small">No investor exceeded RM30,000 for this month.</div>}</div>
          <div className="card"><h2>Monitoring data coverage</h2><div className="summary-list"><Summary label="TM-001 threshold" value="> RM30,000 aggregate deposits"/><Summary label="Historical investor profiles" value={history.length?`${history.length} loaded`:'Not loaded'}/><Summary label="Prior compliance contexts" value={priorContext.length?`${priorContext.length} carried forward`:'Not loaded'}/><Summary label="High-risk investors in TM-001" value={String(highRiskMandatory)}/><Summary label="Staff register" value={`${staff.filter(s=>s.active).length} active staff`}/><Summary label="Note master" value={`${notes.length} notes loaded`}/><Summary label="Investor directory" value={directory.length?`${directory.length} investors loaded`:'Not loaded'}/><Summary label="Customer risk profiles" value={profiles.length?`${profiles.length} loaded · ${profiles.filter(p=>p.riskRating==='High').length} High · ${profiles.filter(p=>p.riskRating==='Medium').length} Medium`:'Not loaded'}/><Summary label="AML periodic reviews overdue" value={profiles.length?String(overdueProfiles.length):'—'}/><Summary label="Flags without AML rating" value={profiles.length?String(monthFlags.filter(f=>f.riskProfile==='No rating'||f.riskProfile==='Not profiled').length):'—'}/><Summary label="Sanctions screening" value={screeningRun?`${screening.length} possible match(es), ${screeningPending} pending`:'Not run'}/><Summary label="Staff investments detected" value={`${staffRows.length}`}/></div></div>
        </section>
        {monthlyReports}
      </>}</>}

      {tab==='upload'&&<section className="stack">
        <h2 className="section-label">Every month</h2>
        <UploadCard title="1. Monthly Transaction Log" text="Upload the Cofundr Admin Panel Excel/CSV export for the month being reviewed." accept=".xlsx,.xls,.csv" onFile={uploadTransactions} detail={sourceName||'Required each month'} status={months.length?'loaded':'required'} />
        <h2 className="section-label">Reference data <span>Upload again whenever the source file changes</span></h2>
        <UploadCard title="2. Historical Investor / AML Workbook" text="Upload your 2024–2026 ACTIVE INVESTORS & ISSUERS working file. The app reads Monthly Deposit, Monthly Investment, Monthly Gross Withdrawal, Risk Profile and Account Balances sheets to provide investor history and AML context." accept=".xlsx,.xls" onFile={uploadHistory} detail={historyName||'Recommended for historical comparison'} status={history.length?'loaded':'missing'} />
        <UploadCard title="3. Prior Monitoring Workbook" text="Upload an earlier Flagged Transaction Monitoring workbook to carry forward standing Compliance Comments such as known relationships or institutional-fund context." accept=".xlsx,.xls" onFile={uploadPrior} detail={priorName||`${priorContext.length} saved context record(s)`} status={priorContext.length?'loaded':'missing'} />
        <StaffRegister investors={investors} directory={directory} staff={staff} onChange={saveStaff} />
        <UploadCard title="5. Note Master" text="Upload the Admin Panel note list (or any table with Note ID, Note Reference ID and Note Name). Maps each investment to its note for the Staff Investment Report." accept=".xlsx,.xls,.csv" onFile={uploadNotes} detail={notes.length?`${notes.length} notes saved${notesName?` · ${notesName}`:''}`:'Awaiting note master'} status={notes.length?'loaded':'missing'} />
        <UploadCard title="6. Investor Directory" text="Upload the Admin Panel investor list (Investor ID, Investor, Date Registered, Email, Balance, Status). Adds Investor IDs to flags and reports and lists every platform investor in the Staff Register. Contact numbers are not stored." accept=".xlsx,.xls,.csv" onFile={uploadDirectory} detail={directory.length?`${directory.length} investors saved${directoryName?` · ${directoryName}`:''}`:'Recommended'} status={directory.length?'loaded':'missing'} />
        <UploadCard title="7. Customer Risk Profiling" text="Upload the Customer Risk Profiling workbook (Retail Investors and Corporate Investors sheets). Adds the current AML risk rating, KYC status, next AML review date, source of funds, occupation, net worth and income to each flag, and drives TM-005. Phone numbers, emails, dates of birth and IC/passport numbers are not stored." accept=".xlsx,.xls" onFile={uploadProfiles} detail={profiles.length?`${profiles.length} profiles saved${profilesName?` · ${profilesName}`:''}`:'Recommended'} status={profiles.length?'loaded':'missing'} />
        <div className="privacy"><strong>Shared records.</strong> Imported records and review decisions are saved to your workspace. Original spreadsheets are not stored. Reimporting a month replaces its transactions; other months are kept. Reimporting a month resets its review decisions and sign-off so corrected transactions are reviewed again.</div>
      </section>}

      {tab==='reviews'&&<section className="card full">
        <div className="card-head"><div><h2>{monthLabel(activeMonth)} flags</h2><p className="muted">Review the mandatory RM30k threshold and any optional behavioural flags. Historical information is context only; Compliance still makes the final decision.</p></div>{repeatPending.length>0&&<button className="secondary" onClick={clearRepeats}>Clear {repeatPending.length} repeat investor(s) with previous reason</button>}</div>
        {!monthFlags.length?<div className="empty-small">No flags for the selected month.</div>:<div className="review-list">{monthFlags.map(f=><ReviewCard key={`${f.id}:${reviews[f.id]?.reviewedAt||''}`} flag={f} review={reviews[f.id]} previous={previousClearances[f.id]} onSave={saveReview} reviewer={user.displayName}/>)}</div>}
      </section>}

      {tab==='staff'&&<section className="card full printable" id="staff-report">
        <div className="report-title"><span>Appendix II – Staff Investment Report</span><h2>STAFF INVESTMENT REPORT – {activeMonth?monthLabel(activeMonth).toUpperCase():'[MONTH] [YEAR]'}</h2><p>Consolidated report generated by the Compliance Unit from the platform pursuant to Clause 7.1.3 and tabled at the monthly Senior Management Team meeting for review of possible conflicts of interest.</p></div>
        {!staff.some(s=>s.active)?<div className="callout">Select staff from the investor dropdown under <strong>Monthly Upload</strong> to enable staff matching.</div>:<><div className="actions"><button onClick={()=>exportRowsToXlsx(`Staff Investment Report - ${activeMonth}.xlsx`,'Staff Investment',staffExport)}>Export Excel</button><button className="secondary" onClick={()=>window.print()}>Print / Save PDF</button></div><div className="table-wrap"><table className="report-table"><thead><tr><th>No.</th><th>Note Reference ID</th><th>Note Name</th><th>Staff Name</th><th>Amount (RM)</th><th>Status</th><th>Date / Time</th></tr></thead><tbody>{staffRows.map((x,i)=><tr key={`${x.transaction.sourceRow}-${i}`}><td>{i+1}</td><td>{x.note?.referenceId||x.transaction.noteId}</td><td className={!x.note?.noteName?'missing':''}>{x.note?.noteName||'Note master required'}</td><td>{x.staff.name}</td><td className="num">{x.transaction.amount.toLocaleString('en-MY',{minimumFractionDigits:2})}</td><td>Successful</td><td>{fmtDate(x.transaction.date)}</td></tr>)}{!staffRows.length&&<tr><td colSpan={7} className="center">No staff investment transactions detected.</td></tr>}</tbody><tfoot><tr><td colSpan={4}>Total staff investment for the month</td><td className="num">{staffRows.reduce((s,x)=>s+x.transaction.amount,0).toLocaleString('en-MY',{minimumFractionDigits:2})}</td><td colSpan={2}></td></tr></tfoot></table></div></>}
      </section>}

      {tab==='rules'&&<fieldset className="workspace-content" disabled={!canWrite(user.role,'rules')}><RulesEditor key={JSON.stringify(rules)} initial={rules} onSave={saveRules}/></fieldset>}

      {tab==='reports'&&activeMonth&&monthlyReports}
      {tab==='reports'&&<section className="signoff-section">
        <SignoffForm user={user} key={`${activeMonth}:${signoffs[activeMonth]?.updatedAt||''}`} month={activeMonth} saved={signoffs[activeMonth]} onSave={value=>save(async()=>{await persist(`signoff:${activeMonth}`,[value]);setSignoffs(previous=>({...previous,[activeMonth]:value}))})}/>
      </section>}
      {tab==='aml'&&<AmlReviews profiles={profiles} completions={amlDone} onComplete={completeAml} canEdit={!busy}/>}
      {tab==='screening'&&<Screening names={screenedNames} matches={screening} lastRun={screeningRun} decisions={screenDecisions} canEdit={!busy} onRun={saveScreening} onDecide={decideScreening}/>}
      {tab==='admin'&&canViewAudit(user.role)&&<AdminPanel currentUser={user}/>}
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

function StaffRegister({investors,directory,staff,onChange}:{investors:string[],directory:InvestorRecord[],staff:StaffMember[],onChange:(next:StaffMember[])=>void}) {
  const active=staff.filter(s=>s.active)
  const isSelected=(name:string,id?:string)=>active.some(s=>id&&s.identifier?s.identifier===id:normalizeName(s.name)===normalizeName(name))
  // Prefer the investor directory so staff are picked by Investor ID; fall back to plain names.
  const options=directory.length
    ? [...directory].sort((a,b)=>a.name.localeCompare(b.name)).filter(i=>!isSelected(i.name,i.investorId)).map(i=>({value:`id:${i.investorId}`,label:`${i.name} · ID ${i.investorId}`}))
    : investors.filter(name=>!isSelected(name)).map(name=>({value:`name:${name}`,label:name}))
  const sharedNames=new Map<string,number>()
  for(const i of directory){const key=normalizeName(i.name);sharedNames.set(key,(sharedNames.get(key)||0)+1)}
  function selectStaff(value:string) {
    const record=value.startsWith('id:')?directory.find(i=>i.investorId===value.slice(3)):undefined
    const name=record?.name||value.replace(/^name:/,'')
    if(!name)return
    const matches=(s:StaffMember)=>record&&s.identifier?s.identifier===record.investorId:normalizeName(s.name)===normalizeName(name)
    const details=record?{identifier:record.investorId,...(record.email?{email:record.email}:{})}:{}
    onChange(staff.some(matches)
      ? staff.map(s=>matches(s)?{...s,...details,active:true}:s)
      : [...staff,{id:crypto.randomUUID(),name,active:true,...details}])
  }
  return <div className="card stack">
    <div><h2>4. Staff Register</h2><p className="muted">Select investors who are staff members to include their investments in Appendix II. Your selections are saved to the shared workspace.</p></div>
    <label>Choose an investor to add as staff
      <select value="" disabled={!options.length} onChange={e=>selectStaff(e.target.value)}>
        <option value="">{!investors.length&&!directory.length?'Upload transactions or the investor directory first':!options.length?'All loaded investors are already selected':'Select an investor…'}</option>
        {options.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
    <div className="summary-list">
      {active.map(s=>{
        const shared=sharedNames.get(normalizeName(s.name))||0
        return <div className="summary-row" key={s.id}><div><strong>{s.name}</strong>{s.identifier&&<small className="subline">Investor ID {s.identifier}</small>}{shared>1&&<small className="subline warning-text">{shared} investors on the platform share this name. The transaction log has no Investor ID, so all of their investments are attributed to this staff member. Check the report before tabling it.</small>}</div><button className="secondary" aria-label={`Remove ${s.name} from staff`} onClick={()=>onChange(staff.filter(x=>x.id!==s.id))}>Remove</button></div>
      })}
      {!active.length&&<p className="muted">No staff selected yet. Add each staff member using the dropdown.</p>}
    </div>
  </div>
}

function tabTitle(tab:Tab){return ({dashboard:'Monthly Monitoring Dashboard',upload:'Monthly Data Upload',reviews:'Compliance Review Queue',staff:'Staff Investment Report',rules:'Monitoring Rules',reports:'Reports & Sign-Off',aml:'AML Periodic Reviews',screening:'Sanctions Screening',admin:'Administration'} as Record<Tab,string>)[tab]}
function tabSubtitle(tab:Tab){return ({rules:'Thresholds for the optional monitoring rules. TM-001 is fixed.',aml:'Investors due for their periodic AML/CFT review.',screening:'UNSC Consolidated List and MOHA domestic list.',admin:'Accounts, password resets and the audit trail.'} as Partial<Record<Tab,string>>)[tab]||''}
function noticeTone(message:string){return message==='Changes saved.'?'success':/…$/.test(message)?'':'error'}
function NavButton({tab,current,onSelect,label,count=0}:{tab:Tab,current:Tab,onSelect:(t:Tab)=>void,label:string,count?:number}){
  const ref=useRef<HTMLButtonElement>(null)
  // Keeps the selected page visible in the swipeable phone menu.
  useEffect(()=>{if(tab===current)ref.current?.scrollIntoView({block:'nearest',inline:'center'})},[tab,current])
  return <button ref={ref} className={tab===current?'active':''} aria-current={tab===current?'page':undefined} onClick={()=>onSelect(tab)}>{label}{count>0&&<span className="nav-count"> {count}</span>}</button>}
function Kpi({label,value,sub,tone=''}:{label:string,value:string,sub:string,tone?:string}){return <div className={`kpi ${tone}`}><span>{label}</span><strong>{value}</strong><small>{sub}</small></div>}
function Summary({label,value}:{label:string,value:string}){return <div className="summary-row"><span>{label}</span><strong>{value}</strong></div>}
function StatusBadge({value}:{value:string}){return <span className={`badge ${value.toLowerCase().replace(/\s+/g,'-')}`}>{value}</span>}
function RiskBadge({value}:{value?:string}){const v=value||'Unknown';return <span className={`badge risk-${v.toLowerCase()}`}>{v}</span>}
function EmptyUpload({onFile,busy}:{onFile:(f?:File)=>void,busy:boolean}){return <div className="hero-empty"><div className="upload-icon">⇧</div><h2>Upload the monthly Cofundr transaction log</h2><p>The mandatory RM30,000 aggregate monthly deposit rule will run automatically.</p><label className="button">{busy?'Reading file…':'Choose Excel / CSV'}<input type="file" accept=".xlsx,.xls,.csv" hidden onChange={e=>onFile(e.target.files?.[0])}/></label></div>}
function UploadCard({title,text,accept,onFile,detail,status}:{title:string,text:string,accept:string,onFile:(f?:File)=>void,detail:string,status:'loaded'|'missing'|'required'}){return <div className={`upload-card is-${status}`}><div><div className="upload-title"><h2>{title}</h2><span className={`status-pill ${status}`}>{status==='loaded'?'✓ Loaded':status==='required'?'Required':'Not loaded'}</span></div><p>{text}</p><small>{detail}</small></div><label className="button secondary">Choose file<input type="file" accept={accept} hidden onChange={e=>onFile(e.target.files?.[0])}/></label></div>}
function ReviewCard({flag,review,previous,onSave,reviewer}:{flag:Flag,review?:ReviewRecord,previous?:PreviousClearance,reviewer:string,onSave:(f:Flag,d:ReviewDecision,c:string,r:string)=>void}){
  const [decision,setDecision]=useState<ReviewDecision>(review?.decision||'Pending');const [comments,setComments]=useState(review?.comments||'');const by=reviewer
  const [open,setOpen]=useState(false)
  // Reviewed flags collapse to one line; Edit reopens the full card.
  if(review&&review.decision!=='Pending'&&!open)return <div className="collapsed-item"><StatusBadge value={review.decision}/><strong>{flag.investorName}</strong><span className="muted">{flag.ruleId} · {rm(flag.amount)} · {review.reviewedBy}, {review.reviewedAt.slice(0,10)}{review.comments?` · ${review.comments.length>90?review.comments.slice(0,90)+'…':review.comments}`:''}</span><button className="secondary" aria-label={`Edit review for ${flag.investorName}`} onClick={()=>setOpen(true)}>Edit</button></div>
  return <article className="review-card"><div className="review-main"><div className="rule-line"><span className={`severity ${flag.severity.toLowerCase()}`}>{flag.severity}</span><strong>{flag.ruleId} · {flag.ruleName}</strong></div><h3>{flag.investorName}</h3><div className="review-amount">{rm(flag.amount)}</div><p>{flag.reason}</p><div className="context-grid"><Context label="Investor ID" value={flag.investorId||'Not matched'}/><Context label="AML Risk" value={flag.riskProfile||'Not loaded'}/>{flag.customerType&&<><Context label="KYC" value={flag.kycStatus||'Not recorded'}/><Context label="Next AML review" value={flag.amlReviewDue?`${flag.amlReviewDue}${flag.amlReviewDue<new Date().toISOString().slice(0,10)?' (overdue)':''}`:'Not set'}/><Context label="Source of funds" value={[flag.sourceOfFunds,flag.natureOfJob].filter(Boolean).join(' · ')||'Not recorded'}/><Context label={flag.customerType==='Corporate'?'Net worth':'Net worth / income'} value={[flag.netWorth,flag.grossIncome].filter(Boolean).join(' / ')||'Not recorded'}/></>}<Context label="Historical Avg Deposit" value={flag.historicalAverageDeposit?rm(flag.historicalAverageDeposit):'No history'}/><Context label="Historical Max Deposit" value={flag.historicalMaxDeposit?rm(flag.historicalMaxDeposit):'No history'}/></div>{previous&&<div className="prior-context previous-clearance"><strong>Previously cleared · {monthLabel(previous.month)} · {previous.ruleId} · {previous.review.reviewedBy}</strong><span>{previous.review.comments||'No comment recorded.'}</span>{(review?.decision||'Pending')==='Pending'&&<button className="secondary" onClick={()=>onSave(flag,'Cleared',sameReasonComment(previous),by)}>Clear with same reason</button>}</div>}{flag.priorComplianceContext&&<div className="prior-context"><strong>Prior Compliance Context</strong><span>{flag.priorComplianceContext}</span></div>}<small>Source row(s): {flag.transactionRows.join(', ')} · Transactions: {flag.transactionCount}</small></div><div className="review-form"><label>Decision<select value={decision} onChange={e=>setDecision(e.target.value as ReviewDecision)}><option>Pending</option><option>Cleared</option><option>Request Information</option><option>Escalated</option></select></label><label>Reviewed by<input value={by} readOnly/></label><label>Compliance comments<textarea rows={4} value={comments} onChange={e=>setComments(e.target.value)} placeholder="Reason for decision / follow-up"/></label><div className="inline-actions"><button onClick={()=>onSave(flag,decision,comments,by)}>Save Review</button>{open&&<button className="secondary" onClick={()=>setOpen(false)}>Cancel</button>}</div></div></article>
}
function Context({label,value}:{label:string,value:string}){return <div><span>{label}</span><strong>{value}</strong></div>}
