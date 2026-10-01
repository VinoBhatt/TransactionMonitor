import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
const directory=resolve('.wrangler',`test-${randomUUID()}`)
mkdirSync(directory,{recursive:true})
const config=JSON.parse(readFileSync('wrangler.jsonc','utf8'))
config.main=resolve(config.main)
config.assets.directory=resolve('dist')
config.d1_databases[0].migrations_dir=resolve('migrations')
config.vars={APP_PASSWORD:'local-integration-test-password'}
delete config.build
writeFileSync(resolve(directory,'wrangler.json'),JSON.stringify(config))
const cli=resolve('node_modules/wrangler/bin/wrangler.js')
const args=['--config',resolve(directory,'wrangler.json'),'--persist-to',resolve(directory,'state')]
const migration=spawnSync(process.execPath,[cli,'d1','migrations','apply','DB','--local',...args],{stdio:'inherit',windowsHide:true})
if(migration.status!==0)process.exit(migration.status||1)
const child=spawn(process.execPath,[cli,'dev','--ip','127.0.0.1','--port','8788',...args],{stdio:'inherit',windowsHide:true})
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal))
child.on('exit',code=>process.exit(code||0))
