import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {spawn} from 'node:child_process'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {once} from 'node:events'
const dir=await mkdtemp(join(tmpdir(),'anycord-propagation-'))
const expected={version:'0.6.0',commit:'a'.repeat(40),apiVersion:1,schema:'0012_separate_s3_backups'},previous={...expected,version:'0.5.0',schema:'0011_fancy_vanisher'}
let migrations=0,clientReads=0
const server=createServer((req,res)=>{
  res.setHeader('Content-Type','application/json')
  if(req.url==='/api/_migrate'){assert.equal(req.headers['x-migration-token'],'private-fixture');migrations++;res.end('{}');return}
  const build=migrations<2?previous:expected
  if(req.url==='/api/health')res.end(JSON.stringify({ok:true,schema:build.schema,build}))
  else if(req.url==='/api/runtime')res.end(JSON.stringify({apiVersion:1,build}))
  else if(req.url==='/version.json')res.end(JSON.stringify(++clientReads<2?previous:expected))
  else res.end('{}')
})
try{
  await writeFile(join(dir,'version.json'),JSON.stringify(expected));server.listen(0,'127.0.0.1');await once(server,'listening')
  const child=spawn(process.execPath,[resolve('scripts/verify-deployment.mjs')],{cwd:dir,env:{...process.env,ANYCORD_URL:`http://127.0.0.1:${server.address().port}`,MIGRATION_TOKEN:'private-fixture'},stdio:['ignore','pipe','pipe']})
  let output='';child.stdout.on('data',b=>{output+=b});child.stderr.on('data',b=>{output+=b})
  const timer=setTimeout(()=>child.kill(),30_000)
  const [code]=await once(child,'exit');clearTimeout(timer);assert.equal(code,0,output);assert(migrations>=3);assert(clientReads>=2)
  console.log('PASS deployment verification: old Worker migration response and lagging public client are retried until exact schema/client/Worker identity converges')
}finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true})}
