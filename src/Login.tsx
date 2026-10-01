import { useState } from 'react'
import { request } from './api'
import type { User } from '../shared/auth'

export function Login({onLogin}:{onLogin:(user:User)=>void}) {
  const [username,setUsername]=useState(''),[password,setPassword]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  return <main className="login-page"><form className="card login-card" onSubmit={async e=>{
    e.preventDefault();setBusy(true);setError('')
    try{const {user}=await request<{user:User}>('/login','POST',{username,password});setPassword('');onLogin(user)}
    catch(e){setError(e instanceof Error?e.message:'Sign-in failed.')}
    finally{setBusy(false)}
  }}><div className="brand-mark">C</div><h1>Cofundr</h1><h2>Transaction Monitoring</h2><p className="muted">Sign in to your shared compliance workspace.</p><label>Username<input autoComplete="username" required value={username} onChange={e=>setUsername(e.target.value)}/></label><label>Password<input type="password" autoComplete="current-password" required value={password} onChange={e=>setPassword(e.target.value)}/></label>{error&&<p role="alert" className="notice">{error}</p>}<button disabled={busy}>{busy?'Signing in…':'Sign in'}</button></form></main>
}

export function ChangePassword({user,onDone,onCancel}:{user:User,onDone:()=>void,onCancel?:()=>void}) {
  const [currentPassword,setCurrent]=useState(''),[newPassword,setNew]=useState(''),[confirm,setConfirm]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  return <main className="login-page"><form className="card login-card" onSubmit={async e=>{
    e.preventDefault();setError('')
    if(newPassword!==confirm){setError('The new passwords do not match.');return}
    setBusy(true)
    try{await request('/password','POST',{currentPassword,newPassword});onDone()}
    catch(e){setError(e instanceof Error?e.message:'Password change failed.')}
    finally{setBusy(false)}
  }}><h1>Change password</h1><p className="muted">{user.mustChangePassword?'Choose a new password before opening your workspace.':'Change your account password.'} Use at least 16 characters. You will sign in again afterwards.</p><label>Current password<input type="password" autoComplete="current-password" required value={currentPassword} onChange={e=>setCurrent(e.target.value)}/></label><label>New password<input type="password" autoComplete="new-password" minLength={16} maxLength={128} required value={newPassword} onChange={e=>setNew(e.target.value)}/></label><label>Confirm new password<input type="password" autoComplete="new-password" required value={confirm} onChange={e=>setConfirm(e.target.value)}/></label>{error&&<p role="alert" className="notice">{error}</p>}<button disabled={busy}>Save password</button>{onCancel&&<button type="button" className="secondary" disabled={busy} onClick={onCancel}>Cancel</button>}<button type="button" className="secondary" disabled={busy} onClick={()=>void request('/logout','POST',{}).then(onDone).catch(e=>setError(e.message))}>Sign out</button></form></main>
}
