import { useEffect, useState } from 'react'
import { request } from './api'
import { canViewAudit, roleLabels } from '../shared/auth'
import type { AuditEvent, ManagedUser, User } from '../shared/auth'

const actionLabels:Record<string,string>={login:'Signed in',save:'Saved data',password_changed:'Changed password',password_reset:'Reset password',account_activated:'Activated account',account_deactivated:'Deactivated account',report_downloaded:'Downloaded report'}
const reportKinds:Record<string,string>={monitoring:'Transaction Monitoring Report',deposits:'Deposit Report','staff':'Staff Investment Report','staff-all':'All Staff Investment Reports'}
const reportLabel=(value:string)=>{const [,kind,month,...rest]=value.split(':');return `${reportKinds[kind]||'Report'} · ${month}${rest.length?` · ${rest.join(':')}`:''}`}
const datasetLabel=(value:string)=>value.startsWith('report:')?reportLabel(value):value.startsWith('transactions:')?`Transactions · ${value.slice(13)}`:value.startsWith('review:')?'Compliance review':value.startsWith('signoff:')?`Monthly sign-off · ${value.slice(8)}`:value.replaceAll('_',' ')

export function AdminPanel({currentUser}:{currentUser:User}){
  const [users,setUsers]=useState<ManagedUser[]>([]),[events,setEvents]=useState<AuditEvent[]>([])
  const [message,setMessage]=useState(''),[busy,setBusy]=useState(false),[temporary,setTemporary]=useState<{name:string,password:string}|null>(null)
  const load=async()=>{
    setBusy(true);setMessage('')
    try{
      const [audit,accounts]=await Promise.all([
        canViewAudit(currentUser.role)?request<AuditEvent[]>('/audit?limit=100'):Promise.resolve([]),
        currentUser.role==='admin'?request<ManagedUser[]>('/users'):Promise.resolve([]),
      ])
      setEvents(audit);setUsers(accounts)
    }catch(error){setMessage(error instanceof Error?error.message:'Could not load administration data.')}
    finally{setBusy(false)}
  }
  useEffect(()=>{void load()},[])
  const reset=async(account:ManagedUser)=>{
    setBusy(true);setMessage('');setTemporary(null)
    try{const result=await request<{temporaryPassword:string}>(`/users/${account.id}/reset-password`,'POST',{});setTemporary({name:account.displayName,password:result.temporaryPassword});await load()}
    catch(error){setMessage(error instanceof Error?error.message:'Could not reset password.');setBusy(false)}
  }
  const setActive=async(account:ManagedUser,active:boolean)=>{
    setBusy(true);setMessage('')
    try{await request(`/users/${account.id}/status`,'POST',{active});await load()}
    catch(error){setMessage(error instanceof Error?error.message:'Could not update account.');setBusy(false)}
  }
  return <section className="stack">
    {message&&<div className="notice" role="alert">{message}</div>}
    {temporary&&<div className="credential-panel" role="status"><div><strong>Temporary password for {temporary.name}</strong><p>Copy it now. It is shown only once and must be changed at the next sign-in.</p><code>{temporary.password}</code></div><button className="secondary" onClick={()=>void navigator.clipboard.writeText(temporary.password)}>Copy password</button></div>}
    {currentUser.role==='admin'&&<div className="card"><div className="card-head"><div><h2>User accounts</h2><p className="muted">Reset passwords or suspend access. Password resets immediately revoke the user's sessions.</p></div><button className="secondary" disabled={busy} onClick={()=>void load()}>Refresh</button></div><div className="table-wrap"><table><thead><tr><th>User</th><th>Role</th><th>Status</th><th>Password</th><th>Actions</th></tr></thead><tbody>{users.map(account=><tr key={account.id}><td><strong>{account.displayName}</strong><small className="subline">{account.username}</small></td><td>{roleLabels[account.role]}</td><td><span className={`badge ${account.active?'cleared':'escalated'}`}>{account.active?'Active':'Suspended'}</span></td><td>{account.mustChangePassword?'Change required':account.passwordChangedAt?`Changed ${new Date(account.passwordChangedAt).toLocaleDateString('en-MY')}`:'Temporary'}</td><td><div className="row-actions"><button disabled={busy} onClick={()=>void reset(account)}>Reset password</button><button className="secondary" disabled={busy||account.id===currentUser.id} onClick={()=>void setActive(account,!account.active)}>{account.active?'Suspend':'Activate'}</button></div></td></tr>)}</tbody></table></div></div>}
    <div className="card"><div className="card-head"><div><h2>Audit trail</h2><p className="muted">Latest 100 account and workspace events, newest first.</p></div><button className="secondary" disabled={busy} onClick={()=>void load()}>Refresh</button></div><div className="table-wrap"><table><thead><tr><th>Date and time</th><th>User</th><th>Action</th><th>Record</th></tr></thead><tbody>{events.map(event=><tr key={event.id}><td>{new Date(event.createdAt).toLocaleString('en-MY')}</td><td>{event.displayName||'System'}<small className="subline">{event.username||''}</small></td><td>{actionLabels[event.action]||event.action}</td><td>{datasetLabel(event.dataset)}</td></tr>)}{!events.length&&!busy&&<tr><td colSpan={4} className="center">No audit events yet.</td></tr>}</tbody></table></div></div>
  </section>
}
