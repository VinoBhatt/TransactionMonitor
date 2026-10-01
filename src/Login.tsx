import { useState } from 'react'
import { request } from './api'

export function Login({onLogin}:{onLogin:()=>void}) {
  const [password,setPassword]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  return <main className="login-page"><form className="card login-card" onSubmit={async e=>{
    e.preventDefault();setBusy(true);setError('')
    try{await request('/login','POST',{password});setPassword('');onLogin()}
    catch(e){setError(e instanceof Error?e.message:'Sign-in failed.')}
    finally{setBusy(false)}
  }}><div className="brand-mark">C</div><h1>Cofundr</h1><h2>Transaction Monitoring</h2><p className="muted">Sign in to your shared compliance workspace.</p><label>Workspace password<input type="password" autoComplete="current-password" required value={password} onChange={e=>setPassword(e.target.value)}/></label>{error&&<p role="alert" className="notice">{error}</p>}<button disabled={busy}>{busy?'Signing in…':'Sign in'}</button></form></main>
}
