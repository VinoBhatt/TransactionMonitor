import { z } from 'zod'
import { schemaFor } from '../shared/schema'

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
  if(!env.APP_PASSWORD) throw new HttpError(503,'The workspace password has not been configured.')
  if(path==='/api/login' && request.method==='POST'){
    const {password}=z.object({password:z.string().max(1024)}).parse(await body(request))
    const address=await hash(request.headers.get('CF-Connecting-IP')||'local')
    const attempt=await env.DB.prepare(`INSERT INTO login_attempts(address,attempts,reset_at) VALUES (?,1,?) ON CONFLICT(address) DO UPDATE SET attempts=CASE WHEN reset_at<=? THEN 1 ELSE attempts+1 END, reset_at=CASE WHEN reset_at<=? THEN ? ELSE reset_at END RETURNING attempts`).bind(address,now()+900,now(),now(),now()+900).first<{attempts:number}>()
    if(attempt && attempt.attempts>10)throw new HttpError(429,'Too many sign-in attempts. Try again in 15 minutes.')
    const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.APP_PASSWORD),{name:'HMAC',hash:'SHA-256'},false,['sign','verify'])
    const signature=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(env.APP_PASSWORD))
    if(!await crypto.subtle.verify('HMAC',key,signature,new TextEncoder().encode(password)))throw new HttpError(401,'Incorrect password.')
    const token=crypto.randomUUID()+crypto.randomUUID()
    await env.DB.batch([
      env.DB.prepare('DELETE FROM sessions WHERE expires_at<=?').bind(now()),
      env.DB.prepare('DELETE FROM login_attempts WHERE reset_at<=? OR address=?').bind(now(),address),
      env.DB.prepare('INSERT INTO sessions VALUES (?,?)').bind(await hash(token),now()+28800),
    ])
    return json({ok:true},200,{'Set-Cookie':cookie(request,token)})
  }
  const token=await tokenHash(request)
  if(!token || !await env.DB.prepare('SELECT 1 FROM sessions WHERE token_hash=? AND expires_at>?').bind(token,now()).first())throw new HttpError(401,'Please sign in to your workspace.')
  if(path==='/api/logout' && request.method==='POST'){
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(token).run()
    return json({ok:true},200,{'Set-Cookie':cookie(request,'',0)})
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
    const id=crypto.randomUUID()
    await env.DB.prepare('INSERT INTO imports VALUES (?,?,?,?,?,?)').bind(id,input.dataset,input.version,input.source,input.count,now()).run()
    return json({id})
  }
  const match=path.match(/^\/api\/imports\/([a-f0-9-]+)(\/commit)?$/)
  if(match){
    const job=await env.DB.prepare('SELECT * FROM imports WHERE id=? AND created_at>?').bind(match[1],now()-3600).first<{id:string,dataset:string,expected_version:string,source:string,row_count:number}>()
    if(!job)throw new HttpError(404,'Import not found or expired. Please retry.')
    if(request.method==='PUT' && !match[2]){
      const input=z.object({offset:z.number().int().nonnegative(),items:z.array(z.unknown()).min(1).max(250)}).parse(await body(request))
      if(input.offset+input.items.length>job.row_count)throw new HttpError(400,'Invalid chunk range.')
      const schema=schemaFor(job.dataset)
      const items=input.items.map(item=>schema.parse(item))
      for(const item of items){
        const row=item as Record<string,unknown>
        if(job.dataset.startsWith('review:') && job.dataset!==`review:${row.flagId}`)throw new HttpError(400,'Review ID mismatch.')
        if(job.dataset.startsWith('signoff:') && job.dataset!==`signoff:${row.month}`)throw new HttpError(400,'Sign-off month mismatch.')
        if(job.dataset.startsWith('review:'))row.reviewedAt=new Date().toISOString()
        if(job.dataset.startsWith('signoff:'))row.updatedAt=new Date().toISOString()
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
        env.DB.prepare(`INSERT INTO audit_log(dataset,version,action,created_at) SELECT name,version,'save',? FROM datasets WHERE name=? AND version=?`).bind(timestamp,job.dataset,job.id),
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
