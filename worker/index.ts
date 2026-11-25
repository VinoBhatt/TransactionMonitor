import { z } from 'zod'
import { schemaFor } from '../shared/schema'
import { canViewAudit, canWrite } from '../shared/auth'
import type { Role, User } from '../shared/auth'
import { hashPassword, verifyPassword } from '../shared/password'
import { notificationSchema } from '../shared/schema'
import { alertEmail, mailConfig, sendMail } from './email'
import type { MailEnv } from './email'

type UserRow={id:string,username:string,display_name:string,role:Role,password_hash:string,must_change_password:number,active:number}
const publicUser=(user:UserRow):User=>({id:user.id,username:user.username,displayName:user.display_name,role:user.role,mustChangePassword:!!user.must_change_password})

class HttpError extends Error { constructor(public status:number,message:string){super(message)} }
const json = (value:unknown,status=200,headers:Record<string,string>={}) => Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers}})
const now = () => Math.floor(Date.now()/1000)
const timestamp = () => new Date().toISOString()
function temporaryPassword() {
  const bytes=crypto.getRandomValues(new Uint8Array(24))
  return btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','')
}
async function hash(value:string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('')
}
async function body(request:Request) {
  const reader=request.body?.getReader()
  if(!reader) throw new HttpError(400,'Request body required.')
  const chunks:Uint8Array[]=[]; let size=0
  for(;;){const {done,value}=await reader.read(); if(done)break; size+=value.length; if(size>1_000_000){await reader.cancel();throw new HttpError(413,'Upload chunk is too large.')} chunks.push(value)}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}
  try{return JSON.parse(new TextDecoder().decode(bytes))}catch{throw new HttpError(400,'Invalid JSON.')}
}
function cookie(request:Request,value:string,maxAge=28800) {
  return `tm_session=${value}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${new URL(request.url).protocol==='https:'?'; Secure':''}`
}
async function tokenHash(request:Request) {
  const token=request.headers.get('Cookie')?.match(/(?:^|;\s*)tm_session=([^;]+)/)?.[1]
  return token?hash(token):''
}
async function api(request:Request,env:Env) {
  const url=new URL(request.url), path=url.pathname
  if(request.method!=='GET' && request.headers.get('Origin')!==url.origin) throw new HttpError(403,'This request must come from this website.')
  if(!env.AUTH_PEPPER || env.AUTH_PEPPER.length<32) throw new HttpError(503,'Account authentication has not been configured.')
  if(path==='/api/login' && request.method==='POST'){
    const {username,password}=z.object({username:z.string().trim().min(1).max(100).transform(s=>s.toLowerCase()),password:z.string().max(1024)}).parse(await body(request))
    const address=await hash(request.headers.get('CF-Connecting-IP')||'local')
    const attempt=await env.DB.prepare(`INSERT INTO login_attempts(address,attempts,reset_at) VALUES (?,1,?) ON CONFLICT(address) DO UPDATE SET attempts=CASE WHEN reset_at<=? THEN 1 ELSE attempts+1 END, reset_at=CASE WHEN reset_at<=? THEN ? ELSE reset_at END RETURNING attempts`).bind(address,now()+900,now(),now(),now()+900).first<{attempts:number}>()
    if(attempt && attempt.attempts>10)throw new HttpError(429,'Too many sign-in attempts. Try again in 15 minutes.')
    const user=await env.DB.prepare('SELECT * FROM users WHERE username=? AND active=1').bind(username).first<UserRow>()
    const dummy=`pbkdf2-sha256:100000:${'0'.repeat(32)}:${'0'.repeat(64)}`
    const valid=await verifyPassword(password,user?.password_hash||dummy,env.AUTH_PEPPER)
    if(!user || !valid)throw new HttpError(401,'Incorrect username or password.')
    const token=crypto.randomUUID()+crypto.randomUUID()
    await env.DB.batch([
      env.DB.prepare('DELETE FROM sessions WHERE expires_at<=?').bind(now()),
      env.DB.prepare('DELETE FROM login_attempts WHERE reset_at<=? OR address=?').bind(now(),address),
      env.DB.prepare('INSERT INTO sessions(token_hash,expires_at,user_id,credential_version) VALUES (?,?,?,?)').bind(await hash(token),now()+28800,user.id,user.password_hash),
      env.DB.prepare("INSERT INTO audit_log(dataset,version,action,created_at,user_id) VALUES ('account',?,'login',?,?)").bind(crypto.randomUUID(),timestamp(),user.id),
    ])
    return json({user:publicUser(user)},200,{'Set-Cookie':cookie(request,token)})
  }
  const token=await tokenHash(request)
  const user=token?await env.DB.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.active=1 AND s.credential_version=u.password_hash').bind(token,now()).first<UserRow>():null
  if(!user)throw new HttpError(401,'Please sign in to your workspace.')
  if(path==='/api/me' && request.method==='GET')return json({user:publicUser(user)})
  if(path==='/api/password' && request.method==='POST'){
    const input=z.object({currentPassword:z.string().max(1024),newPassword:z.string().min(1).max(128)}).parse(await body(request))
    // Reuse the IP rate limiter for password verification as well as sign-in.
    const address=await hash('password:'+user.id)
    const attempt=await env.DB.prepare(`INSERT INTO login_attempts(address,attempts,reset_at) VALUES (?,1,?) ON CONFLICT(address) DO UPDATE SET attempts=CASE WHEN reset_at<=? THEN 1 ELSE attempts+1 END, reset_at=CASE WHEN reset_at<=? THEN ? ELSE reset_at END RETURNING attempts`).bind(address,now()+900,now(),now(),now()+900).first<{attempts:number}>()
    if(attempt && attempt.attempts>10)throw new HttpError(429,'Too many attempts. Try again in 15 minutes.')
    if(!await verifyPassword(input.currentPassword,user.password_hash,env.AUTH_PEPPER))throw new HttpError(400,'Current password is incorrect.')
    if(input.currentPassword===input.newPassword)throw new HttpError(400,'Choose a different password.')
    const encoded=await hashPassword(input.newPassword,env.AUTH_PEPPER)
    const updated=await env.DB.prepare('UPDATE users SET password_hash=?,must_change_password=0,password_changed_at=? WHERE id=? AND password_hash=?').bind(encoded,new Date().toISOString(),user.id,user.password_hash).run()
    if(!updated.meta.changes)throw new HttpError(409,'Password was changed elsewhere. Sign in again.')
    await env.DB.batch([
      env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(user.id),
      env.DB.prepare('DELETE FROM login_attempts WHERE address=?').bind(address),
      env.DB.prepare("INSERT INTO audit_log(dataset,version,action,created_at,user_id) VALUES ('account',?,'password_changed',?,?)").bind(crypto.randomUUID(),new Date().toISOString(),user.id),
    ])
    return json({ok:true},200,{'Set-Cookie':cookie(request,'',0)})
  }
  if(path==='/api/logout' && request.method==='POST'){
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(token).run()
    return json({ok:true},200,{'Set-Cookie':cookie(request,'',0)})
  }
  if(user.must_change_password)throw new HttpError(403,'Change your temporary password before opening the workspace.')
  if(path==='/api/report-log' && request.method==='POST'){
    // Reports are generated in the browser; this records who produced which report and when.
    const input=z.object({kind:z.enum(['monitoring','deposits','investments','withdrawals','staff','staff-all','pack']),month:z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),subject:z.string().trim().max(200).optional()}).parse(await body(request))
    await env.DB.prepare("INSERT INTO audit_log(dataset,version,action,created_at,user_id) VALUES (?,?,'report_downloaded',?,?)")
      .bind(`report:${input.kind}:${input.month}${input.subject?`:${input.subject}`:''}`,crypto.randomUUID(),new Date().toISOString(),user.id).run()
    return json({ok:true})
  }
  if(path==='/api/notifications/status' && request.method==='GET'){
    const config=mailConfig(env as Env&MailEnv)
    return json({configured:!!config,from:config?.user||'',server:config?`${config.host}:${config.port}`:''})
  }
  if(path==='/api/notifications/send' && request.method==='POST'){
    const month=z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), count=z.number().int().min(0).max(1_000_000)
    const input=z.discriminatedUnion('event',[
      z.object({event:z.literal('test')}),
      z.object({event:z.literal('flags'),months:z.array(z.object({month,tm001:count,tm001Amount:z.number().finite().min(0),total:count})).min(1).max(36)}),
      z.object({event:z.literal('screening'),unsc:count,moha:count}),
    ]).parse(await body(request))
    if(input.event==='test'&&user.role!=='admin')throw new HttpError(403,'Only an Admin can send a test email.')
    const config=mailConfig(env as Env&MailEnv)
    if(!config)throw new HttpError(503,'Email is not set up yet. Add the SMTP secrets to the Worker first.')
    const stored=await env.DB.prepare("SELECT r.payload FROM datasets d JOIN records r ON r.dataset=d.name AND r.version=d.version WHERE d.name='notifications' ORDER BY r.position LIMIT 1").first<{payload:string}>()
    const settings=stored?notificationSchema.parse(JSON.parse(stored.payload)):null
    if(input.event!=='test'){
      if(!settings?.recipients.length)return json({sent:false,reason:'No alert recipients are set up.'})
      if((input.event==='flags'&&!settings.onFlags)||(input.event==='screening'&&!settings.onScreening))return json({sent:false,reason:'This alert is switched off.'})
    }
    // A simple guard against a runaway loop filling inboxes.
    const recent=await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='email_sent' AND created_at>?").bind(new Date(Date.now()-3600_000).toISOString()).first<{n:number}>()
    if((recent?.n||0)>=30)throw new HttpError(429,'Too many alert emails in the last hour. Try again later.')
    const to=input.event==='test'?(settings?.recipients.length?settings.recipients:[config.user]):settings!.recipients
    const by=`${user.display_name} on ${new Date().toLocaleString('en-MY',{timeZone:'Asia/Kuala_Lumpur',dateStyle:'medium',timeStyle:'short'})}`
    const label=(m:string)=>new Intl.DateTimeFormat('en-MY',{month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(`${m}-01T00:00:00Z`))
    const rm=(n:number)=>`RM ${n.toLocaleString('en-MY',{minimumFractionDigits:2,maximumFractionDigits:2})}`
    let subject:string, mail:{text:string,html:string}
    if(input.event==='test'){
      subject='Test alert from Cofundr Transaction Monitoring'
      mail=alertEmail('Email alerts are working','This test was sent by '+by+'.',['Flag alerts: '+(settings?.onFlags?'on':'off'),'Sanctions screening alerts: '+(settings?.onScreening?'on':'off'),`Recipients: ${to.length}`],url.origin,'Open the workspace')
    }else if(input.event==='flags'){
      const tm001=input.months.reduce((n,m)=>n+m.tm001,0)
      subject=input.months.length===1?`${label(input.months[0].month)}: ${input.months[0].tm001} investor(s) above RM30,000`:`${input.months.length} months uploaded: ${tm001} investor-month(s) above RM30,000`
      mail=alertEmail('New transaction monitoring flags',`A transaction log was uploaded by ${by}. These flags are pending compliance review.`,
        input.months.map(m=>`${label(m.month)}: ${m.tm001} investor(s) above RM30,000 (TM-001, total ${rm(m.tm001Amount)}); ${m.total} flag(s) in all`),url.origin,'Open the review queue')
    }else{
      const total=input.unsc+input.moha
      subject=`Sanctions screening: ${total} possible match(es) to review`
      mail=alertEmail('Possible sanctions list matches',`A sanctions screening was run by ${by}. Each possible match must be reviewed as a false positive or a true match.`,
        [...(input.unsc?[`UNSC Consolidated List: ${input.unsc} possible match(es)`]:[]),...(input.moha?[`MOHA list: ${input.moha} possible match(es)`]:[])],url.origin,'Review the matches')
    }
    try{await sendMail(config,{to,subject:`[Cofundr TM] ${subject}`,...mail})}
    catch(e){throw new HttpError(502,`${e instanceof Error?e.message:'The email could not be sent.'} (mail server ${config.host}:${config.port})`)}
    await env.DB.prepare("INSERT INTO audit_log(dataset,version,action,created_at,user_id) VALUES (?,?,'email_sent',?,?)").bind(`email:${input.event}`,crypto.randomUUID(),timestamp(),user.id).run()
    return json({sent:true,recipients:to.length})
  }
  if(path==='/api/screening/unsc' && request.method==='GET'){
    // Downloads the public UN Security Council Consolidated List. Nothing about investors is sent;
    // names are compared in the browser.
    const list=await fetch('https://scsanctions.un.org/resources/xml/en/consolidated.xml',{headers:{'User-Agent':'TransactionMonitor sanctions screening'}})
    if(!list.ok)throw new HttpError(502,`The UN list could not be downloaded (HTTP ${list.status}). Upload the XML file instead.`)
    return new Response(list.body,{headers:{'Content-Type':'application/xml; charset=utf-8','Cache-Control':'no-store'}})
  }
  if(path==='/api/users' && request.method==='GET'){
    if(user.role!=='admin')throw new HttpError(403,'Only an Admin can manage accounts.')
    const users=await env.DB.prepare('SELECT id,username,display_name,role,must_change_password,active,created_at,password_changed_at FROM users ORDER BY display_name').all<{
      id:string,username:string,display_name:string,role:Role,must_change_password:number,active:number,created_at:string,password_changed_at:string|null
    }>()
    return json(users.results.map(row=>({id:row.id,username:row.username,displayName:row.display_name,role:row.role,mustChangePassword:!!row.must_change_password,active:!!row.active,createdAt:row.created_at,passwordChangedAt:row.password_changed_at})))
  }
  const userMatch=path.match(/^\/api\/users\/([a-zA-Z0-9-]+)\/(reset-password|status)$/)
  if(userMatch && request.method==='POST'){
    if(user.role!=='admin')throw new HttpError(403,'Only an Admin can manage accounts.')
    const target=await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(userMatch[1]).first<UserRow>()
    if(!target)throw new HttpError(404,'Account not found.')
    if(userMatch[2]==='reset-password'){
      const password=temporaryPassword(),encoded=await hashPassword(password,env.AUTH_PEPPER),changedAt=timestamp()
      await env.DB.batch([
        env.DB.prepare('UPDATE users SET password_hash=?,must_change_password=1,password_changed_at=? WHERE id=?').bind(encoded,changedAt,target.id),
        env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(target.id),
        env.DB.prepare("INSERT INTO audit_log(dataset,version,action,created_at,user_id) VALUES ('account',?,'password_reset',?,?)").bind(target.id,changedAt,user.id),
      ])
      return json({temporaryPassword:password})
    }
    const {active}=z.object({active:z.boolean()}).parse(await body(request))
    if(target.id===user.id&&!active)throw new HttpError(400,'You cannot deactivate your own account.')
    if(!active&&target.role==='admin'){
      const remaining=await env.DB.prepare("SELECT COUNT(*) AS count FROM users WHERE role='admin' AND active=1 AND id<>?").bind(target.id).first<{count:number}>()
      if(!remaining?.count)throw new HttpError(400,'At least one active Admin account is required.')
    }
    const changedAt=timestamp()
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET active=? WHERE id=?').bind(active?1:0,target.id),
      ...(!active?[env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(target.id)]:[]),
      env.DB.prepare("INSERT INTO audit_log(dataset,version,action,created_at,user_id) VALUES ('account',?,?,?,?)").bind(target.id,active?'account_activated':'account_deactivated',changedAt,user.id),
    ])
    return json({ok:true})
  }
  if(path==='/api/audit' && request.method==='GET'){
    if(!canViewAudit(user.role))throw new HttpError(403,'Your role cannot view the audit trail.')
    const limit=z.coerce.number().int().min(1).max(200).parse(url.searchParams.get('limit')||100)
    const events=await env.DB.prepare(`SELECT a.id,a.dataset,a.action,a.created_at,u.id AS user_id,u.display_name,u.username
      FROM audit_log a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT ?`).bind(limit).all<{
      id:number,dataset:string,action:string,created_at:string,user_id:string|null,display_name:string|null,username:string|null
    }>()
    return json(events.results.map(row=>({id:row.id,dataset:row.dataset,action:row.action,createdAt:row.created_at,userId:row.user_id,displayName:row.display_name,username:row.username})))
  }
  if(path==='/api/datasets' && request.method==='GET'){
    return json((await env.DB.prepare('SELECT * FROM datasets ORDER BY name').all()).results)
  }
  if(path==='/api/records' && request.method==='GET'){
    const dataset=url.searchParams.get('dataset')||'',version=url.searchParams.get('version')||''
    const offset=z.coerce.number().int().nonnegative().parse(url.searchParams.get('offset')||0)
    // Read an immutable version so pagination cannot mix two imports.
    const result=await env.DB.prepare('SELECT payload FROM records WHERE dataset=? AND version=? AND position>=? ORDER BY position LIMIT 500').bind(dataset,version,offset).all<{payload:string}>()
    return json(result.results.map(row=>JSON.parse(row.payload)))
  }
  if(path==='/api/imports' && request.method==='POST'){
    const input=z.object({dataset:z.string().max(520),version:z.string().max(50),source:z.string().max(500),count:z.number().int().min(0).max(200000)}).parse(await body(request))
    if(!schemaFor(input.dataset))throw new HttpError(400,'Unknown dataset.')
    if(!canWrite(user.role,input.dataset))throw new HttpError(403,'Your role cannot change this data.')
    const id=crypto.randomUUID()
    await env.DB.batch([
      env.DB.prepare('DELETE FROM imports WHERE created_at<=?').bind(now()-3600),
      env.DB.prepare('INSERT INTO imports(id,dataset,expected_version,source,row_count,created_at,user_id) VALUES (?,?,?,?,?,?,?)').bind(id,input.dataset,input.version,input.source,input.count,now(),user.id),
    ])
    return json({id})
  }
  const match=path.match(/^\/api\/imports\/([a-f0-9-]+)(\/commit)?$/)
  if(match){
    const job=await env.DB.prepare('SELECT * FROM imports WHERE id=? AND created_at>? AND user_id=?').bind(match[1],now()-3600,user.id).first<{id:string,dataset:string,expected_version:string,source:string,row_count:number}>()
    if(!job)throw new HttpError(404,'Import not found or expired. Please retry.')
    if(!canWrite(user.role,job.dataset))throw new HttpError(403,'Your role cannot change this data.')
    if(request.method==='PUT' && !match[2]){
      const input=z.object({offset:z.number().int().nonnegative(),items:z.array(z.unknown()).min(1).max(250)}).parse(await body(request))
      if(input.offset+input.items.length>job.row_count)throw new HttpError(400,'Invalid chunk range.')
      const schema=schemaFor(job.dataset)
      const items=input.items.map(item=>schema.parse(item))
      for(const item of items){
        const row=item as Record<string,unknown>
        if(job.dataset.startsWith('review:') && job.dataset!==`review:${row.flagId}`)throw new HttpError(400,'Review ID mismatch.')
        if(job.dataset.startsWith('signoff:') && job.dataset!==`signoff:${row.month}`)throw new HttpError(400,'Sign-off month mismatch.')
        if(job.dataset.startsWith('review:')){row.reviewedAt=new Date().toISOString();row.reviewedBy=user.display_name}
        if(job.dataset.startsWith('signoff:')){row.updatedAt=new Date().toISOString();row.reviewedBy=user.display_name}
        if(job.dataset.startsWith('amlreview:')){if(job.dataset!==`amlreview:${row.investorId}`)throw new HttpError(400,'AML review ID mismatch.');row.completedAt=new Date().toISOString();row.completedBy=user.display_name}
        if(job.dataset.startsWith('screen:')){if(job.dataset!==`screen:${row.key}`)throw new HttpError(400,'Screening ID mismatch.');row.reviewedAt=new Date().toISOString();row.reviewedBy=user.display_name}
      }
      await env.DB.prepare(`INSERT OR REPLACE INTO records(dataset,version,position,payload) SELECT ?,?,CAST(key AS INTEGER)+?,value FROM json_each(?) WHERE EXISTS(SELECT 1 FROM imports WHERE id=?) AND NOT EXISTS(SELECT 1 FROM datasets WHERE version=?)`).bind(job.dataset,job.id,input.offset,JSON.stringify(items),job.id,job.id).run()
      return json({ok:true})
    }
    if(request.method==='POST' && match[2]){
      const count=await env.DB.prepare('SELECT COUNT(*) AS count FROM records WHERE dataset=? AND version=?').bind(job.dataset,job.id).first<{count:number}>()
      if(count?.count!==job.row_count)throw new HttpError(400,'Import is incomplete. Existing data has not changed.')
      const timestamp=new Date().toISOString()
      const results=await env.DB.batch([
        env.DB.prepare(`INSERT INTO datasets(name,version,source,updated_at) SELECT ?,?,?,? WHERE ?='' ON CONFLICT(name) DO NOTHING`).bind(job.dataset,job.id,job.source,timestamp,job.expected_version),
        env.DB.prepare(`UPDATE datasets SET version=?,source=?,updated_at=? WHERE name=? AND version=?`).bind(job.id,job.source,timestamp,job.dataset,job.expected_version),
        env.DB.prepare(`INSERT INTO audit_log(dataset,version,action,created_at,user_id) SELECT name,version,'save',?,? FROM datasets WHERE name=? AND version=?`).bind(timestamp,user.id,job.dataset,job.id),
        // Replacing a month's source records invalidates its previous conclusions.
        env.DB.prepare(`DELETE FROM datasets WHERE (? LIKE 'transactions:%') AND (name LIKE ? OR name=?) AND EXISTS(SELECT 1 FROM datasets WHERE name=? AND version=?)`).bind(job.dataset,`review:${job.dataset.slice(13)}|%`,`signoff:${job.dataset.slice(13)}`,job.dataset,job.id),
      ])
      if(!results[0].meta.changes && !results[1].meta.changes)throw new HttpError(409,'Someone else updated this data. Refresh the workspace before saving again.')
      await env.DB.prepare('DELETE FROM imports WHERE id=?').bind(job.id).run()
      return json({version:job.id})
    }
  }
  throw new HttpError(404,'API endpoint not found.')
}
export default {
  async fetch(request,env) {
    if(!new URL(request.url).pathname.startsWith('/api/')){
      const response=await env.ASSETS.fetch(request),headers=new Headers(response.headers)
      headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
      headers.set('Permissions-Policy','camera=(), microphone=(), geolocation=()')
      headers.set('Referrer-Policy','no-referrer')
      headers.set('X-Content-Type-Options','nosniff')
      headers.set('X-Frame-Options','DENY')
      if(new URL(request.url).protocol==='https:')headers.set('Strict-Transport-Security','max-age=31536000; includeSubDomains')
      return new Response(response.body,{status:response.status,statusText:response.statusText,headers})
    }
    try{return await api(request,env)}catch(error){
      if(error instanceof HttpError)return json({error:error.message},error.status)
      if(error instanceof z.ZodError)return json({error:'Invalid data: '+error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('; ')},400)
      console.error(JSON.stringify({event:'api_error',path:new URL(request.url).pathname,message:error instanceof Error?error.message:'Unknown error'}))
      return json({error:'The database request failed. Please retry or contact your administrator.'},500)
    }
  },
} satisfies ExportedHandler<Env>
