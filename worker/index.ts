import { z } from 'zod'
import { schemaFor } from '../shared/schema'
import { canWrite } from '../shared/auth'
import type { Role, User } from '../shared/auth'
import { hashPassword, verifyPassword } from '../shared/password'

type UserRow={id:string,username:string,display_name:string,role:Role,password_hash:string,must_change_password:number,active:number}
const publicUser=(user:UserRow):User=>({id:user.id,username:user.username,displayName:user.display_name,role:user.role,mustChangePassword:!!user.must_change_password})

class HttpError extends Error { constructor(public status:number,message:string){super(message)} }
const json = (value:unknown,status=200,headers:Record<string,string>={}) => Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers}})
const now = () => Math.floor(Date.now()/1000)
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
    ])
    return json({user:publicUser(user)},200,{'Set-Cookie':cookie(request,token)})
  }
  const token=await tokenHash(request)
  const user=token?await env.DB.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.active=1 AND s.credential_version=u.password_hash').bind(token,now()).first<UserRow>():null
  if(!user)throw new HttpError(401,'Please sign in to your workspace.')
  if(path==='/api/me' && request.method==='GET')return json({user:publicUser(user)})
  if(path==='/api/password' && request.method==='POST'){
    const input=z.object({currentPassword:z.string().max(1024),newPassword:z.string().min(16).max(128)}).parse(await body(request))
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
    await env.DB.prepare('INSERT INTO imports(id,dataset,expected_version,source,row_count,created_at,user_id) VALUES (?,?,?,?,?,?,?)').bind(id,input.dataset,input.version,input.source,input.count,now(),user.id).run()
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
    if(!new URL(request.url).pathname.startsWith('/api/'))return env.ASSETS.fetch(request)
    try{return await api(request,env)}catch(error){
      if(error instanceof HttpError)return json({error:error.message},error.status)
      if(error instanceof z.ZodError)return json({error:'Invalid data: '+error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('; ')},400)
      console.error(JSON.stringify({event:'api_error',path:new URL(request.url).pathname,message:error instanceof Error?error.message:'Unknown error'}))
      return json({error:'The database request failed. Please retry or contact your administrator.'},500)
    }
  },
} satisfies ExportedHandler<Env>
