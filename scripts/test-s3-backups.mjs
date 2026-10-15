import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {Miniflare,convertV4MiniflareOptions} from 'miniflare'
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {fileURLToPath} from 'node:url'
import {setTimeout as delay} from 'node:timers/promises'
import {randomUUID} from 'node:crypto'
import {operationClient,downloadS3Backup,verifyBackup,restoreBackup,executeJob,verifyInstallation} from '../operations/core.mjs'
const root=await mkdtemp(join(tmpdir(),'anycord-s3-')),fixtures=[]
const sourceBuild=JSON.parse(await readFile('shared/build-info.json','utf8')),parts=sourceBuild.version.split('.').map(Number);parts[2]++
const targetBuild={...sourceBuild,version:parts.join('.'),commit:'5'.repeat(40)}
const passwordFallback=fileURLToPath(new URL('./password.mjs',import.meta.resolve('@better-auth/utils/password')))
async function fixture(engine,label){
 const dir=join(root,label);await mkdir(dir);const base=`https://${label}.anycord.test`,objects=new Map(),dispatches=[],putCounts=new Map(),token=randomUUID(),secret=randomUUID()+randomUUID(),tokenEnv='S3_OPS_'+label;process.env[tokenEnv]=token
 let currentBuild=sourceBuild,mf,r2,failFirst=false,gate=null,rejectDispatch=false,cloudRuns=[]
 const provider=async request=>{
  const url=new URL(request.url)
  if(url.origin==='https://s3.test'){
   const bucket=url.pathname.split('/')[1],key=url.pathname.split('/').slice(2).map(decodeURIComponent).join('/'),id=bucket+'/'+key
   assert.match(request.headers.get('authorization'),/^AWS4-HMAC-SHA256 /)
   if(request.method==='PUT'){
    const bytes=new Uint8Array(await request.arrayBuffer());if(bucket==='files'&&r2)await r2.put(key,bytes);else objects.set(id,bytes)
    putCounts.set(id,(putCounts.get(id)||0)+1)
    if(bucket==='backups'&&key.includes('/tables/')&&gate){gate.seen();await gate.wait}
    if(bucket==='backups'&&key.includes('/tables/')&&failFirst){failFirst=false;return new Response('temporary provider failure',{status:503})}
    return new Response(null)
   }
   if(request.method==='GET'){
    if(bucket==='files'&&r2){const value=await r2.get(key);return value?new Response(value.body):new Response(null,{status:404})}
    return objects.has(id)?new Response(objects.get(id)):new Response(null,{status:404})
   }
   if(request.method==='DELETE'){if(bucket==='files'&&r2)await r2.delete(key);else objects.delete(id);return new Response(null)}
  }
  if(url.origin==='https://api.github.com'){
   if(url.pathname.includes('/actions/workflows/')){
    assert.equal(request.headers.get('authorization'),'Bearer private-actions-token')
    if(request.method==='POST'){dispatches.push(await request.json());return new Response(null,{status:rejectDispatch?422:204})}
    if(url.pathname.endsWith('/runs'))return Response.json({workflow_runs:cloudRuns})
    return Response.json({state:'active'})
   }
   return Response.json({tag_name:'v'+targetBuild.version,immutable:true,draft:false,prerelease:false,body:'Fixture release',assets:[{name:'anycord-release.json'}]})
  }
  if(url.origin==='https://github.com'&&url.pathname.endsWith('/anycord-release.json'))return Response.json({format:1,...targetBuild,engines:['cloudflare','celld'],artifacts:[]})
  throw Error('Unexpected provider '+url.origin)
 }
 async function bundle(info){const file=join(dir,info.version+'.mjs');await build({stdin:{contents:`import{createD1Handler}from './worker/router';export{WorkspaceHub,ChatRoom}from './worker/cloudflare';const handler=createD1Handler('${engine}');export default {...handler,fetch(request,env,ctx){if(new URL(request.url).pathname==='/test-scheduled'){ctx.waitUntil(handler.scheduled({cron:'* * * * *'},env,ctx));return new Response('{}',{headers:{'Content-Type':'application/json'}})}return handler.fetch(request,env,ctx)}}`,resolveDir:process.cwd(),loader:'ts'},outfile:file,bundle:true,format:'esm',target:'es2022',conditions:['workerd','worker','browser'],alias:{'@better-auth/utils/password':passwordFallback},external:['cloudflare:*','node:*'],plugins:[{name:'release',setup(b){b.onLoad({filter:/shared\/build-info\.json$/},()=>({contents:JSON.stringify(info),loader:'json'}))}}]});return file}
 const options={modules:true,modulesRoot:dir,scriptPath:await bundle(sourceBuild),compatibilityDate:'2026-10-14',compatibilityFlags:['nodejs_compat'],cf:false,d1Databases:['DB'],...(engine==='cloudflare'?{r2Buckets:['FILES']}:{}),durableObjects:{HUBS:{className:'WorkspaceHub',useSQLite:true},ROOMS:{className:'ChatRoom',useSQLite:true}},bindings:{AUTH_BASE_URL:base,APP_SECRET:secret,MIGRATION_TOKEN:token,...(engine==='celld'?{STORAGE_ENDPOINT:'https://s3.test',STORAGE_BUCKET:'files',STORAGE_REGION:'auto',STORAGE_ACCESS_KEY_ID:'files-key',STORAGE_SECRET_ACCESS_KEY:'files-secret'}:{})},serviceBindings:{ASSETS:()=>Response.json(currentBuild)},outboundService:provider}
 mf=new Miniflare(convertV4MiniflareOptions(options));await mf.ready;if(engine==='cloudflare')r2=await mf.getR2Bucket('FILES')
 async function api(path,{actor,method='GET',body,expected=200,raw=false,operator=false,headers={}}={}){
  const response=await mf.dispatchFetch(base+path,{method,headers:{Origin:base,...(actor?{Cookie:actor.cookie}:{}),...(operator?{'X-Migration-Token':token}:{}),...(body===undefined?{}:{'Content-Type':raw?'application/octet-stream':'application/json'}),...headers},...(body===undefined?{}:{body:raw?body:JSON.stringify(body)})})
  const text=raw?new Uint8Array(await response.arrayBuffer()):await response.text();assert.equal(response.status,expected,`${engine} ${method} ${path}: ${raw?'binary':String(text).slice(0,300)}`)
  return {data:raw?text:text?JSON.parse(text):null,cookie:response.headers.getSetCookie().find(c=>c.includes('cellcord.session_token='))?.split(';')[0]}
 }
 await api('/api/_migrate',{method:'POST',body:{},operator:true})
 const client=operationClient({origin:base,migrationTokenEnv:tokenEnv},(url,init)=>mf.dispatchFetch(url,init))
 const value={mf,base,token,secret,api,client,objects,dispatches,putCounts,provider,db:await mf.getD1Database('DB'),config:{origin:base,engine,migrationTokenEnv:tokenEnv,backupDirectory:join(dir,'recovery'),releaseDirectory:join(dir,'releases'),backupMode:'installation-s3'},fail:()=>{failFirst=true},gate:g=>{gate=g},rejectDispatch:flag=>{rejectDispatch=flag},cloudRuns:runs=>{cloudRuns=runs},activate:async(info=targetBuild)=>{currentBuild=info;await mf.setOptions(convertV4MiniflareOptions({...options,scriptPath:await bundle(info)}));await mf.ready;value.db=await mf.getD1Database('DB');if(engine==='cloudflare')r2=await mf.getR2Bucket('FILES')},reboot:async()=>{await mf.setOptions(convertV4MiniflareOptions(options));await mf.ready;value.db=await mf.getD1Database('DB');if(engine==='cloudflare')r2=await mf.getR2Bucket('FILES')},transport:(url,init)=>mf.dispatchFetch(url,init)}
 fixtures.push(value);return value
}
async function until(client,predicate){for(let i=0;i<800;i++){const status=await client('/status');if(predicate(status))return status;await delay(50)}throw Error('Background S3 job did not reach its expected state')}
try{
 for(const engine of ['cloudflare','celld']){
  const source=await fixture(engine,engine+'-source'),api=source.api,password='correct-horse-battery'
  const owner=await api('/api/auth/register',{method:'POST',body:{name:'owner',password},expected:201}),member=await api('/api/auth/register',{method:'POST',body:{name:'member',password},expected:201})
  for(const path of ['/api/installation/backup-storage','/api/installation/cloud-updates'])await api(path,{actor:member,expected:403})
  const body={endpoint:'https://s3.test',bucket:'backups',region:'auto',accessKeyId:'backup-key',secretAccessKey:'backup-secret'}
  await api('/api/installation/backup-storage',{actor:member,method:'PUT',body,expected:403})
  const attachment=(await api('/api/channels/general/attachments',{actor:owner,method:'POST',body:{name:'private.bin',size:4},expected:201})).data.id
  await api(`/api/attachments/${attachment}/upload`,{actor:owner,method:'PUT',body:new Uint8Array([1,2,3,4]),raw:true})
  const messageId=randomUUID();await api('/api/channels/general/messages',{actor:owner,method:'POST',body:{id:messageId,text:'Secret recovery content',attachmentIds:[attachment]},expected:201})
  await api('/api/installation/backup-storage',{actor:owner,method:'PUT',body:{...body,bucket:'files'},expected:400})
  const saved=(await api('/api/installation/backup-storage',{actor:owner,method:'PUT',body})).data;assert(saved.verified&&saved.recoveryKey)
  assert(!JSON.stringify((await api('/api/installation/backup-storage',{actor:owner})).data).includes('backup-secret'))
  await api('/api/installation/backup-storage/recovery-key',{actor:member,method:'POST',body:{password},expected:403})
  await api('/api/installation/backup-storage/recovery-key',{actor:owner,method:'POST',body:{password:'wrong-password'},expected:401})
  assert.equal((await api('/api/installation/backup-storage/recovery-key',{actor:owner,method:'POST',body:{password}})).data.key,saved.recoveryKey)
  assert.equal((await source.client('/status')).runnerSeen,null)
  // Pause a real alarm in S3 I/O: writes are fenced, cancellation cannot record a checkpoint.
  let release,seen;const reached=new Promise(r=>{seen=r});source.gate({seen,wait:new Promise(r=>{release=r})})
  const cancelledId=randomUUID();await api('/api/installation/operations',{actor:owner,method:'POST',body:{id:cancelledId,kind:'backup'}})
  await reached;await api('/api/channels/general/messages',{actor:member,method:'POST',body:{id:randomUUID(),text:'Cannot enter the snapshot'},expected:503})
  await api(`/api/installation/operations/${cancelledId}`,{actor:owner,method:'DELETE'});source.gate(null);release()
  await delay(300);assert(!(await source.client('/status')).maintenance)
  assert.equal(await source.db.prepare('SELECT checkpoint FROM installation_jobs WHERE id=?').bind(cancelledId).first('checkpoint'),null)
  source.fail();const backupId=randomUUID();await api('/api/installation/operations',{actor:owner,method:'POST',body:{id:backupId,kind:'backup'}})
  await source.reboot()
  const completed=await until(source.client,s=>s.jobs.some(j=>j.id===backupId&&j.status==='complete'));assert(!completed.maintenance);const job=completed.jobs.find(j=>j.id===backupId)
  assert([...source.putCounts.values()].some(n=>n>1),'An acknowledged S3 write is retried safely')
  const remotePath=`backups/anycord-backups/${completed.installationId}/${job.checkpoint}/manifest.json`,manifest=JSON.parse(new TextDecoder().decode(source.objects.get(remotePath)))
  assert.equal(manifest.format,2);assert.equal(manifest.encrypted,'AES-256-GCM');assert.equal(manifest.tables.length,27)
  for(const [key,bytes] of source.objects)if(key.includes(job.checkpoint)&&!key.endsWith('/manifest.json')){const text=new TextDecoder().decode(bytes);for(const secret of ['Secret recovery content',source.secret,source.token,'backup-secret',saved.recoveryKey])assert(!text.includes(secret),'S3 payloads contain ciphertext only')}
  const downloaded=await downloadS3Backup({...body,installationId:completed.installationId,recoveryKey:saved.recoveryKey},job.checkpoint,source.config.backupDirectory,request=>source.provider(request))
  assert.equal((await verifyBackup(downloaded.path)).manifestHash,job.result.manifestHash)
  const manifestPath=join(downloaded.path,'manifest.json'),originalManifest=await readFile(manifestPath,'utf8')
  await writeFile(manifestPath,JSON.stringify({...JSON.parse(originalManifest),origin:'https://tampered.test'}));await assert.rejects(verifyBackup(downloaded.path),/authentication/);await writeFile(manifestPath,originalManifest)

  const keyPath=join(downloaded.path,'private/recovery-key');await writeFile(keyPath,'0'.repeat(64));let targetCalls=0;await assert.rejects(restoreBackup(async()=>{targetCalls++},downloaded.path,randomUUID()));assert.equal(targetCalls,0);await writeFile(keyPath,saved.recoveryKey)
  const target=await fixture(engine,engine+'-target');await restoreBackup(target.client,downloaded.path,randomUUID())
  const signed=await target.api('/api/auth/login',{method:'POST',body:{name:'member',password}});const history=(await target.api('/api/channels/general/messages',{actor:signed})).data;assert(history.some(m=>m.id===messageId&&m.text==='Secret recovery content'))
  const grant=(await target.api(`/api/attachments/${attachment}/download`,{actor:signed})).data;assert.deepEqual((await target.api(grant.url,{raw:true})).data,new Uint8Array([1,2,3,4]))
  const restoredOwner=await target.api('/api/auth/login',{method:'POST',body:{name:'owner',password}});assert.equal((await target.api('/api/installation/backup-storage',{actor:restoredOwner})).data.configured,false)
  // The UI update first makes a native S3 checkpoint, then dispatches Actions; no heartbeat.
  await api('/api/installation/cloud-updates',{actor:owner,method:'PUT',body:{repository:'owner/deployment',workflow:'installation-update.yml',token:'private-actions-token'}})
  assert(!JSON.stringify((await api('/api/installation/cloud-updates',{actor:owner})).data).includes('private-actions-token'))
  await api('/api/installation/cloud-updates',{actor:owner,method:'PUT',body:{repository:'../deployment',token:'private-actions-token'},expected:400})
  // A definitive dispatch rejection did not deploy anything and can safely unfreeze.
  source.rejectDispatch(true);const rejectedId=randomUUID()
  await api('/api/installation/operations',{actor:owner,method:'POST',body:{id:rejectedId,kind:'update',version:targetBuild.version}})
  const rejected=await until(source.client,s=>s.jobs.some(j=>j.id===rejectedId&&j.status==='failed'));assert(!rejected.maintenance);assert(rejected.jobs.find(j=>j.id===rejectedId).checkpoint)
  await assert.rejects(source.client('/claim',{method:'POST',body:{runnerId:rejectedId,resumeId:rejectedId}}),/409/)
  source.rejectDispatch(false);source.dispatches.length=0
  // A cloud job failing before the deployment claim safely unlocks the installation.
  const unclaimedId=randomUUID();await api('/api/installation/operations',{actor:owner,method:'POST',body:{id:unclaimedId,kind:'update',version:targetBuild.version}})
  await until(source.client,s=>s.jobs.some(j=>j.id===unclaimedId&&j.phase==='waiting-for-deployment'))
  source.cloudRuns([{display_title:'Update Anycord · job '+unclaimedId,created_at:new Date().toISOString(),status:'completed',conclusion:'failure'}])
  await source.db.prepare('UPDATE installation_jobs SET updated_at=? WHERE id=?').bind(Date.now()-20_000,unclaimedId).run()
  const failedCloud=await source.client('/status');assert(!failedCloud.maintenance);assert.equal(failedCloud.jobs.find(j=>j.id===unclaimedId).phase,'cloud-job-failed')
  await assert.rejects(source.client('/claim',{method:'POST',body:{runnerId:unclaimedId,resumeId:unclaimedId}}),/409/)
  source.cloudRuns([]);source.dispatches.length=0
  const updateId=randomUUID();await api('/api/installation/operations',{actor:owner,method:'POST',body:{id:updateId,kind:'update',version:targetBuild.version}})
  const waiting=await until(source.client,s=>s.jobs.some(j=>j.id===updateId&&j.phase==='waiting-for-deployment'));assert(waiting.maintenance);assert.equal(source.dispatches.length,1);assert.deepEqual(source.dispatches[0].inputs,{job_id:updateId,installation_id:waiting.installationId,origin:source.base,version:targetBuild.version})
  await api(`/api/installation/operations/${updateId}/retry`,{actor:owner,method:'POST',body:{},expected:409})
  const claim=await source.client('/claim',{method:'POST',body:{runnerId:updateId,resumeId:updateId}})
  source.cloudRuns([{display_title:'Update Anycord · job '+updateId,created_at:new Date().toISOString(),status:'completed',conclusion:'failure'}])
  await source.db.prepare('UPDATE installation_jobs SET updated_at=? WHERE id=?').bind(Date.now()-20_000,updateId).run()
  const claimedFailure=await source.client('/status');assert(claimedFailure.maintenance);assert.equal(claimedFailure.jobs.find(j=>j.id===updateId).status,'failed')
  // Retry uses the same pinned recovery point; an old workflow run cannot fail it again.
  source.cloudRuns([{display_title:'Update Anycord · job '+updateId,created_at:new Date(Date.now()-60_000).toISOString(),status:'completed',conclusion:'failure'}])
  source.rejectDispatch(true);await api(`/api/installation/operations/${updateId}/retry`,{actor:owner,method:'POST',body:{},expected:424});assert((await source.client('/status')).maintenance)
  source.rejectDispatch(false);await api(`/api/installation/operations/${updateId}/retry`,{actor:owner,method:'POST',body:{}})
  await source.db.prepare('UPDATE installation_jobs SET updated_at=? WHERE id=?').bind(Date.now()-20_000,updateId).run()
  assert.equal((await source.client('/status')).jobs.find(j=>j.id===updateId).status,'running')
  source.cloudRuns([])
  await assert.rejects(source.client(`/jobs/${updateId}/recovery-payload?path=../../private`,{key:claim.key}),/404/)
  await executeJob(source.client,claim.job,claim.key,source.config,{prepare:async()=>({manifest:{format:1,...targetBuild,engines:['cloudflare','celld'],artifacts:[]},directory:root}),activate:()=>source.activate(),migrate:()=>api('/api/_migrate',{operator:true,method:'POST',body:{}}),verify:(origin,expected)=>verifyInstallation(origin,expected,source.transport)})
  const final=await source.client('/status');assert(!final.maintenance);assert.equal(final.build.version,targetBuild.version);assert.equal(final.jobs.find(j=>j.id===updateId).status,'complete')
  assert((await api('/api/channels/general/messages',{actor:member})).data.some(m=>m.id===messageId))
  await api('/api/installation/backup-policy',{actor:owner,method:'PUT',body:{backupHours:0,retainBackups:2}})
  // The actual scheduled handler starts one overdue native backup without a runner.
  await source.db.prepare('UPDATE installation_jobs SET created_at=created_at-7200000').run()
  await source.db.prepare('UPDATE installation_state SET backup_hours=1,last_backup=0 WHERE id=1').run()
  await api('/test-scheduled')
  const scheduled=await until(source.client,s=>s.jobs.some(j=>j.kind==='backup'&&j.createdAt>Date.now()-60_000&&j.status==='complete'))
  const extraId=scheduled.jobs.find(j=>j.kind==='backup'&&j.createdAt>Date.now()-60_000).id
  await api('/test-scheduled');await delay(200)
  assert.equal((await source.client('/status')).jobs.filter(j=>j.kind==='backup'&&j.createdAt>Date.now()-60_000).length,1)
  assert.equal(await source.db.prepare('SELECT requested_by FROM installation_jobs WHERE id=?').bind(extraId).first('requested_by'),'scheduled-backup')
  for(let i=0;i<200;i++){if(await source.db.prepare('SELECT count(*) AS n FROM installation_backups').first('n')===4)break;await delay(100)}
  assert.equal(await source.db.prepare('SELECT count(*) AS n FROM installation_backups').first('n'),4)
  assert(!source.objects.has(remotePath),'Retention removes an old verified recovery point from the separate bucket')
  assert(source.objects.has(`backups/anycord-backups/${completed.installationId}/${rejected.jobs.find(j=>j.id===rejectedId).checkpoint}/manifest.json`),'Interrupted update checkpoints remain pinned')

  console.log(`PASS ${engine}: separate encrypted S3 with independent credentials; owner/password gating; native alarms/reboot/retry/cancel fencing; no runner heartbeat; offline download/key validation/restore; cloud update dispatch after verified S3 checkpoint; actual runtime replacement and preserved records/files/session`)
 }
}finally{await Promise.allSettled(fixtures.map(f=>f.mf.dispose()));await rm(root,{recursive:true,force:true})}
