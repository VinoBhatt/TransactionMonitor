import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { hashPassword } from '../shared/password.ts'
const directory=resolve('.wrangler',`test-${randomUUID()}`)
mkdirSync(directory,{recursive:true})
const config=JSON.parse(readFileSync('wrangler.jsonc','utf8'))
config.main=resolve(config.main)
config.assets.directory=resolve('dist')
config.d1_databases[0].migrations_dir=resolve('migrations')
config.vars={AUTH_PEPPER:'local-integration-test-pepper-at-least-32-characters'}
delete config.build
writeFileSync(resolve(directory,'wrangler.json'),JSON.stringify(config))
const cli=resolve('node_modules/wrangler/bin/wrangler.js')
const args=['--config',resolve(directory,'wrangler.json'),'--persist-to',resolve(directory,'state')]
const migration=spawnSync(process.execPath,[cli,'d1','migrations','apply','DB','--local',...args],{stdio:'inherit',windowsHide:true})
if(migration.status!==0)process.exit(migration.status||1)
const encoded=await hashPassword('local-integration-test-password',config.vars.AUTH_PEPPER)
const seed=[['admin','Admin','admin',0],['compliance','Compliance Officer','compliance',1],['chiefcompliance','Chief Compliance Officer','chief_compliance',0]].map(([username,name,role,mustChange])=>`INSERT INTO users(id,username,display_name,role,password_hash,must_change_password,created_at) VALUES ('${username}','${username}','${name}','${role}','${encoded}',${mustChange},'2026-10-01T00:00:00.000Z');`).join('\n')
const seedFile=resolve(directory,'users.sql');writeFileSync(seedFile,seed)
const seeded=spawnSync(process.execPath,[cli,'d1','execute','DB','--local',...args,'--file',seedFile],{stdio:'inherit',windowsHide:true})
if(seeded.status!==0)process.exit(seeded.status||1)
const child=spawn(process.execPath,[cli,'dev','--ip','127.0.0.1','--port','8788',...args],{stdio:'inherit',windowsHide:true})
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal))
child.on('exit',code=>process.exit(code||0))
