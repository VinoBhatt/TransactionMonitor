const encoder=new TextEncoder()
const hex=(bytes:ArrayBuffer)=>Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('')
const unhex=(value:string)=>Uint8Array.from(value.match(/../g)||[],b=>parseInt(b,16))
const iterations=100000
async function derive(password:string,pepper:string,salt:string) {
  const secret=await crypto.subtle.importKey('raw',encoder.encode(pepper),{name:'HMAC',hash:'SHA-256'},false,['sign'])
  const material=await crypto.subtle.sign('HMAC',secret,encoder.encode(password))
  const key=await crypto.subtle.importKey('raw',material,'PBKDF2',false,['deriveBits'])
  return crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:unhex(salt),iterations},key,256)
}
export async function hashPassword(password:string,pepper:string) {
  const salt=hex(crypto.getRandomValues(new Uint8Array(16)).buffer)
  return `pbkdf2-sha256:${iterations}:${salt}:${hex(await derive(password,pepper,salt))}`
}
export async function verifyPassword(password:string,encoded:string,pepper:string) {
  const parts=encoded.split(':')
  if(parts[0]!=='pbkdf2-sha256'||parts[1]!==String(iterations)||!/^\w{32}$/.test(parts[2]||'')||!/^[a-f0-9]{64}$/.test(parts[3]||''))return false
  const actual=await derive(password,pepper,parts[2])
  // Web Crypto's HMAC verification compares the derived values without a JS string comparison.
  const key=await crypto.subtle.importKey('raw',actual,{name:'HMAC',hash:'SHA-256'},false,['sign','verify'])
  const signature=await crypto.subtle.sign('HMAC',key,unhex(parts[3]))
  return crypto.subtle.verify('HMAC',key,signature,actual)
}
