import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const origin=new URL(process.argv[2]).origin
if(!origin.startsWith('https://'))throw new Error('Production verification requires HTTPS.')
const accounts=JSON.parse(readFileSync('private-data/production-accounts/credentials.json','utf8'))
const publicCheck=await fetch(`${origin}/api/datasets`)
assert.equal(publicCheck.status,401,'Unauthenticated data access must be denied')
for(const account of accounts){
  const response=await fetch(`${origin}/api/login`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({username:account.username,password:account.password})})
  assert.equal(response.status,200,`${account.username}: production login failed`)
  const {user}=await response.json()
  assert.equal(user.role,account.role)
  assert.equal(user.mustChangePassword,true)
  const cookie=response.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie)
  assert.match(response.headers.get('set-cookie'),/HttpOnly/)
  assert.match(response.headers.get('set-cookie'),/Secure/)
  const blocked=await fetch(`${origin}/api/datasets`,{headers:{Cookie:cookie}})
  assert.equal(blocked.status,403,'Temporary password must not grant access to data')
  const logout=await fetch(`${origin}/api/logout`,{method:'POST',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json'},body:'{}'})
  assert.equal(logout.status,200)
  const revoked=await fetch(`${origin}/api/me`,{headers:{Cookie:cookie}})
  assert.equal(revoked.status,401)
  console.log(`Verified ${account.username}: ${account.role}, first-login password change required, logout revokes session.`)
}
