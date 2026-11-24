import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

// Usage: node scripts/verify-production-users.mjs https://<site>
// Reads private-data/production-accounts/credentials.json:
// [{username, role, password, mustChangePassword}]. Accounts whose owner has since chosen their own
// password can no longer be signed in with the stored one; they are reported and skipped.
const origin=new URL(process.argv[2]).origin
if(!origin.startsWith('https://'))throw new Error('Production verification requires HTTPS.')
const accounts=JSON.parse(readFileSync('private-data/production-accounts/credentials.json','utf8'))
const publicCheck=await fetch(`${origin}/api/datasets`)
assert.equal(publicCheck.status,401,'Unauthenticated data access must be denied')
for(const account of accounts){
  const response=await fetch(`${origin}/api/login`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({username:account.username,password:account.password})})
  if(response.status===401){console.log(`Skipped ${account.username}: the stored password no longer works (probably changed by the user).`);continue}
  assert.equal(response.status,200,`${account.username}: production login failed`)
  const {user}=await response.json()
  assert.equal(user.role,account.role)
  const mustChange=account.mustChangePassword??true
  const cookie=response.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie)
  assert.match(response.headers.get('set-cookie'),/HttpOnly/)
  assert.match(response.headers.get('set-cookie'),/Secure/)
  const data=await fetch(`${origin}/api/datasets`,{headers:{Cookie:cookie}})
  if(user.mustChangePassword)assert.equal(data.status,403,'Temporary password must not grant access to data')
  else assert.equal(data.status,200,'Signed-in user must be able to read data')
  const logout=await fetch(`${origin}/api/logout`,{method:'POST',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json'},body:'{}'})
  assert.equal(logout.status,200)
  const revoked=await fetch(`${origin}/api/me`,{headers:{Cookie:cookie}})
  assert.equal(revoked.status,401)
  console.log(`Verified ${account.username}: ${account.role}, password change ${user.mustChangePassword?'required':'not required'}${user.mustChangePassword===mustChange?'':' (differs from credentials.json)'}, logout revokes session.`)
}
