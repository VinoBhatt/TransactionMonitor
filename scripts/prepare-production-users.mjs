import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { randomBytes, randomUUID } from 'node:crypto'
import { hashPassword } from '../shared/password.ts'

// Run with Node's --experimental-strip-types. Never print credentials to logs.
const directory='private-data/production-accounts'
if(existsSync(directory))throw new Error('Production account files already exist. Reuse them; do not rotate credentials by rerunning this script.')
mkdirSync(directory,{recursive:true})
const pepper=randomBytes(48).toString('base64url')
const roles=[['admin','Admin','admin'],['compliance','Compliance Officer','compliance'],['chiefcompliance','Chief Compliance Officer','chief_compliance']]
const sql=[],credentials=[]
const quote=value=>"'"+String(value).replaceAll("'","''")+"'"
for(const [username,displayName,role] of roles){
  const password=randomBytes(24).toString('base64url')
  const encoded=await hashPassword(password,pepper)
  sql.push(`INSERT INTO users(id,username,display_name,role,password_hash,must_change_password,created_at) VALUES (${[randomUUID(),username,displayName,role,encoded].map(quote).join(',')},1,${quote(new Date().toISOString())});`)
  credentials.push({username,displayName,role,password})
}
writeFileSync(`${directory}/accounts.sql`,sql.join('\n')+'\n',{mode:0o600})
writeFileSync(`${directory}/secrets.json`,JSON.stringify({AUTH_PEPPER:pepper}),{mode:0o600})
writeFileSync(`${directory}/credentials.json`,JSON.stringify(credentials,null,2),{mode:0o600})
writeFileSync(`${directory}/credentials.md`,'# Cofundr production accounts\n\nEach temporary password must be changed at first sign-in.\n\n| Role | Username | Temporary password |\n|---|---|---|\n'+credentials.map(u=>`| ${u.displayName} | ${u.username} | ${u.password} |`).join('\n')+'\n',{mode:0o600})
console.log(`Prepared 3 accounts. Credentials are in ${directory}/credentials.md (excluded from Git).`)
