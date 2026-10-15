import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { mkdtemp, readFile, writeFile, cp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID, createHash } from 'node:crypto'
import { operationClient, createBackup, verifyBackup, restoreBackup, executeJob, verifyInstallation, retainBackups } from '../operations/core.mjs'

const root = await mkdtemp(join(tmpdir(), 'anycord-operations-')), fixtures = []
const sourceBuild = JSON.parse(await readFile('shared/build-info.json', 'utf8'))
const parts = sourceBuild.version.split('.').map(Number); parts[2]++
const targetBuild = { ...sourceBuild, version: parts.join('.'), commit: '2'.repeat(40) }
const passwordFallback = fileURLToPath(new URL('./password.mjs', import.meta.resolve('@better-auth/utils/password')))
const objects = new Map(), providerCalls = []
async function fixture(engine, label) {
  const dir = join(root, label); await mkdir(dir)
  const origin = `https://${label}.anycord.test`, secret = randomUUID() + randomUUID(), token = randomUUID()
  const envName = 'OPS_TEST_TOKEN_' + label; process.env[envName] = token
  let currentBuild = sourceBuild
  async function bundle(info) {
    const outfile = join(dir, info.version + '.mjs')
    await build({ stdin: { contents: `import {createD1Handler} from './worker/router';export {WorkspaceHub,ChatRoom} from './worker/cloudflare';export default createD1Handler('${engine}')`, resolveDir: process.cwd(), loader: 'ts' }, outfile, bundle: true, format: 'esm', target: 'es2022', conditions: ['workerd', 'worker', 'browser'], alias: { '@better-auth/utils/password': passwordFallback }, external: ['cloudflare:*', 'node:*'], plugins: [{ name: 'test-release', setup(builder) { builder.onLoad({ filter: /shared\/build-info\.json$/ }, () => ({ contents: JSON.stringify(info), loader: 'json' })) } }] })
    return outfile
  }
  const options = { modules: true, modulesRoot: dir, scriptPath: await bundle(sourceBuild), compatibilityDate: '2026-10-14', compatibilityFlags: ['nodejs_compat'], cf: false, d1Databases: ['DB'], d1Persist: join(dir, 'd1'), durableObjectsPersist: join(dir, 'do'), ...(engine === 'cloudflare' ? { r2Buckets: ['FILES'], r2Persist: join(dir, 'r2') } : {}), durableObjects: { HUBS: { className: 'WorkspaceHub', useSQLite: true }, ROOMS: { className: 'ChatRoom', useSQLite: true } }, bindings: { AUTH_BASE_URL: origin, APP_SECRET: secret, MIGRATION_TOKEN: token, SETUP_TOKEN: 'setup-' + label, ...(engine === 'celld' ? { STORAGE_ENDPOINT: 'https://s3.test', STORAGE_BUCKET: label + '-files', STORAGE_REGION: 'us-east-1', STORAGE_ACCESS_KEY_ID: 'fake-key', STORAGE_SECRET_ACCESS_KEY: 'fake-secret' } : {}) }, serviceBindings: { ASSETS: request => new URL(request.url).pathname === '/version.json' ? Response.json(currentBuild) : new Response('<html>Anycord</html>') }, outboundService: async request => {
    const url = new URL(request.url); providerCalls.push(url.origin)
    if (url.origin === 'https://s3.test') {
      assert.match(request.headers.get('authorization'), /^AWS4-HMAC-SHA256 /)
      if (request.method === 'PUT') { objects.set(url.pathname, new Uint8Array(await request.arrayBuffer())); return new Response(null) }
      if (request.method === 'GET') return objects.has(url.pathname) ? new Response(objects.get(url.pathname)) : new Response(null, { status: 404 })
      if (request.method === 'DELETE') { objects.delete(url.pathname); return new Response(null) }
    }
    if (url.origin === 'https://api.telegram.org' && url.pathname.endsWith('/getMe')) return Response.json({ ok: true, result: { id: 12345, username: 'test_bot', is_bot: true } })
    if (url.origin === 'https://api.github.com') return Response.json({ tag_name: 'v' + targetBuild.version, immutable: true, draft: false, prerelease: false, body: 'Test release', assets: [{ name: 'anycord-release.json' }] })
    if (url.origin === 'https://github.com' && url.pathname.endsWith('anycord-release.json')) return Response.json({ format: 1, ...targetBuild, engines: ['cloudflare','celld'], artifacts: [] })
    throw new Error('Unexpected test provider request: ' + url.origin)
  } }
  const mf = new Miniflare(convertV4MiniflareOptions(options)); await mf.ready
  const transport = (url, options) => mf.dispatchFetch(url, options)
  const config = { origin, engine, migrationTokenEnv: envName, backupDirectory: join(dir, 'backups'), releaseDirectory: join(dir, 'releases') }
  async function app(path, { method = 'GET', body, cookie, expected = 200, raw = false, operator = false } = {}) {
    const response = await mf.dispatchFetch(origin + path, { method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(operator ? { 'X-Migration-Token': token } : {}), ...(body !== undefined ? { 'Content-Type': raw ? 'application/octet-stream' : 'application/json' } : {}) }, ...(body === undefined ? {} : { body: raw ? body : JSON.stringify(body) }) })
    const bytes = await response.arrayBuffer(), text = new TextDecoder().decode(bytes)
    assert.equal(response.status, expected, `${method} ${path}: ${raw ? '(binary)' : text.slice(0,400)}`)
    const cookieValue = response.headers.getSetCookie().find(c => c.includes('cellcord.session_token='))?.split(';')[0]
    return { data: raw ? new Uint8Array(bytes) : (text ? JSON.parse(text) : null), cookie: cookieValue }
  }
  await app('/api/_migrate', { method: 'POST', body: {}, operator: true })
  const value = { mf, app, config, origin, secret, token, client: operationClient(config, transport), transport, activate: async (info = targetBuild) => { currentBuild = info; await mf.setOptions(convertV4MiniflareOptions({ ...options, scriptPath: await bundle(info) })); await mf.ready } }
  fixtures.push(value); return value
}
try {
  for (const engine of ['cloudflare','celld']) {
    const source = await fixture(engine, engine + '-source')
    const owner = await source.app('/api/auth/register', { method: 'POST', body: { name: 'owner', password: 'correct-horse-battery', setupCode: 'setup-' + engine + '-source' }, expected: 201 })
    const member = await source.app('/api/auth/register', { method: 'POST', body: { name: 'member', password: 'correct-horse-battery' }, expected: 201 })
    await source.app('/api/installation/operations', { cookie: member.cookie, expected: 403 })
    await source.app('/api/_operations/status', { expected: 403 })
    await source.app('/api/integrations', { method: 'PUT', cookie: owner.cookie, body: { openrouterKey: 'fake-openrouter-key' } })
    await source.app('/api/integrations/telegram', { method: 'PUT', cookie: owner.cookie, body: { botToken: '12345:abcdefghijklmnopqrstuvwx', clientId: '', notifications: true } })
    const community = (await source.app('/api/workspaces', { method: 'POST', cookie: owner.cookie, body: { name: 'Private community' }, expected: 201 })).data.id
    const channel = (await source.app('/api/bootstrap?workspace=' + community, { cookie: owner.cookie })).data.channels[0].id
    const invite = (await source.app(`/api/workspaces/${community}/invites`, { method: 'POST', cookie: owner.cookie, body: { maxUses: 2, expiresInHours: 1 }, expected: 201 })).data
    await source.app('/api/invitations/accept', { method: 'POST', cookie: member.cookie, body: { token: invite.token } })
    // Combined release recovery must preserve the permissions and app modules too.
    const role = (await source.app(`/api/workspaces/${community}/roles`, { method: 'POST', cookie: owner.cookie, body: { name: 'Recovery role', color: '#5865f2', position: 1, permissions: ['reactions.add'] }, expected: 201 })).data
    await source.app(`/api/workspaces/${community}/members/${member.data.user.id}/roles`, { method: 'PUT', cookie: owner.cookie, body: { roleIds: [role.id] } })
    await source.app(`/api/channels/${channel}/permissions`, { method: 'PUT', cookie: owner.cookie, body: { overrides: [{ subjectType: 'member', subjectId: member.data.user.id, permission: 'attachments.upload', effect: 'deny' }] } })
    await source.app('/api/installation/apps', { method: 'PUT', cookie: owner.cookie, body: { enabled: true, allowedOrigins: [] } })
    const bot = (await source.app(`/api/workspaces/${community}/apps`, { method: 'POST', cookie: owner.cookie, body: { name: 'Recovery bot', avatarUrl: '', kind: 'webhook', channelIds: [channel], enabled: true, endpointUrl: '', events: [], commands: [] }, expected: 201 })).data
    const webhook = (await source.app(`/api/workspaces/${community}/apps/${bot.app.id}/slack-webhooks`, { method: 'POST', cookie: owner.cookie, body: { channelId: channel }, expected: 201 })).data
    const botPost = { id: randomUUID(), channelId: channel, text: 'Preserved bot message and receipt' }
    const botResponse = await source.mf.dispatchFetch(source.origin + `/api/apps/${bot.app.id}/messages`, { method: 'POST', headers: { Authorization: `Bearer ${bot.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(botPost) })
    assert.equal(botResponse.status, 201); await botResponse.body?.cancel()
    const messageId = randomUUID(), threadId = randomUUID()
    await source.app(`/api/channels/${channel}/messages`, { method: 'POST', cookie: owner.cookie, body: { id: messageId, text: 'Preserved root' }, expected: 201 })
    await source.app(`/api/channels/${channel}/threads`, { method: 'POST', cookie: member.cookie, body: { id: threadId, parentMessageId: messageId, name: 'Preserved thread' }, expected: 201 })
    await source.app(`/api/channels/${channel}/messages`, { method: 'POST', cookie: member.cookie, body: { id: randomUUID(), text: 'Preserved reply', replyToId: messageId }, expected: 201 })
    await source.app(`/api/channels/${channel}/messages`, { method: 'POST', cookie: member.cookie, body: { id: randomUUID(), text: 'Preserved thread message', threadId }, expected: 201 })
    const unicodeText='Привет 👋\nA\u0000B\n終わり';await source.app(`/api/channels/${channel}/messages`,{method:'POST',cookie:owner.cookie,body:{id:randomUUID(),text:unicodeText},expected:201})
    await source.app(`/api/channels/${channel}/messages/${messageId}`, { method: 'POST', cookie: member.cookie, body: { emoji: '👍' } })
    const bytes = new Uint8Array([137,80,78,71,13,10,26,10,0,1,2,3])
    const attachment = (await source.app(`/api/channels/${channel}/attachments`, { method: 'POST', cookie: owner.cookie, body: { name: 'private.png', size: bytes.length }, expected: 201 })).data.id
    await source.app(`/api/attachments/${attachment}/upload`, { method: 'PUT', cookie: owner.cookie, body: bytes, raw: true })
    await source.app(`/api/channels/${channel}/messages`, { method: 'POST', cookie: owner.cookie, body: { id: randomUUID(), text: 'Private attachment', attachmentIds: [attachment] }, expected: 201 })
    const appDb = await source.mf.getD1Database('DB')
    const pendingId = randomUUID()
    await appDb.batch([
      appDb.prepare("INSERT INTO app_invocations (id,app_id,channel_id,user_id,request_hash,status,created_at) VALUES (?,?,?,?,'fixture','pending',?)").bind(pendingId,bot.app.id,channel,member.data.user.id,Date.now()),
      appDb.prepare("INSERT INTO app_outbox (id,app_id,channel_id,type,payload,due_at,created_at) VALUES (?,?,?,'command.invoked','{}',?,?)").bind(pendingId,bot.app.id,channel,Date.now()+3600000,Date.now()),
    ])
    const id = randomUUID(), runnerId = randomUUID()
    await source.app('/api/installation/operations', { method: 'POST', cookie: owner.cookie, body: { id, kind: 'backup' }, expected: 409 })
    await source.client('/heartbeat', { method: 'POST', body: {} })
    const queued = await source.app('/api/installation/operations', { method: 'POST', cookie: owner.cookie, body: { id, kind: 'backup' } }); assert.equal(queued.data.id,id)
    assert.equal((await source.app('/api/installation/operations', { method: 'POST', cookie: owner.cookie, body: { id, kind: 'backup' } })).data.id,id)
    await source.app('/api/installation/operations', { method: 'POST', cookie: owner.cookie, body: { id: randomUUID(), kind: 'backup' }, expected: 409 })
    const claim = await source.client('/claim', { method: 'POST', body: { runnerId } }); assert.equal(claim.job.id,id)
    assert.equal((await source.client('/claim', { method: 'POST', body: { runnerId: randomUUID() } })).job,null)
    await source.client(`/jobs/${id}/snapshot`, { method: 'POST', key: claim.key, body: {} })
    await source.app(`/api/channels/${channel}/messages`, { method: 'POST', cookie: owner.cookie, body: { id: randomUUID(), text: 'Must not enter the snapshot' }, expected: 503 })
    const db = await source.mf.getD1Database('DB')
    await assert.rejects(db.prepare("UPDATE messages SET text='In-flight write' WHERE id=?").bind(messageId).run(), /maintenance/)
    for (const table of ['roles', 'channel_overrides', 'server_apps', 'app_slack_webhooks', 'app_message_requests', 'app_outbox']) {
      await assert.rejects(db.prepare(`UPDATE ${table} SET ${table === 'roles' ? 'name=name' : table === 'channel_overrides' ? 'effect=effect' : table === 'server_apps' ? 'enabled=enabled' : table === 'app_slack_webhooks' ? 'token_hash=token_hash' : table === 'app_message_requests' ? 'request_hash=request_hash' : 'status=status'}`).run(), /maintenance/)
    }
    const frozenWebhook = await source.mf.dispatchFetch(webhook.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Cannot bypass maintenance' }) })
    assert.equal(frozenWebhook.status,503);assert.equal(await frozenWebhook.text(),'maintenance')
    const backup = await createBackup(source.client, claim.job, claim.key, source.config.backupDirectory)
    await verifyBackup(backup.path); assert.equal((await source.client('/status')).maintenance,false)
    const retentionDir=join(root,engine+'-retention');await mkdir(retentionDir)
    const retention=[]
    for(let i=0;i<6;i++) {
      const backupId=randomUUID(),path=join(retentionDir,backupId);retention.push(path);await cp(backup.path,path,{recursive:true})
      await writeFile(join(path,'manifest.json'),JSON.stringify({...backup.manifest,id:backupId,createdAt:i,...(i===4?{installationId:'foreign-installation'}:{})}))
      if(i===5)await writeFile(join(path,backup.manifest.objects[0].path),'corrupt')
    }
    await retainBackups(retentionDir,backup.manifest.installationId,2,new Set([retention[0].split('/').at(-1)]))
    await assert.rejects(readFile(join(retention[1],'manifest.json')),/ENOENT/)
    for(const i of [0,2,3,4,5])assert(await readFile(join(retention[i],'manifest.json')),'Keep recent, pinned, foreign and corrupt directories')
    await source.app(`/api/channels/${channel}/messages`, { cookie: member.cookie })
    const corrupt = join(root, engine + '-corrupt'); await cp(backup.path,corrupt,{recursive:true}); await writeFile(join(corrupt,backup.manifest.objects[0].path),new Uint8Array([1]))
    let targetCalls=0; await assert.rejects(restoreBackup(async()=>{targetCalls++},corrupt,runnerId),/integrity/); assert.equal(targetCalls,0)
    const target = await fixture(engine, engine + '-target')
    let failUpload=true
    const interruptedClient=async(path,options)=>{if(failUpload&&options?.method==='PUT'&&path.includes('/objects/')){failUpload=false;throw new Error('Injected upload interruption')}return target.client(path,options)}
    await assert.rejects(restoreBackup(interruptedClient,backup.path,runnerId),/incomplete/)
    let state=await target.client('/status');assert(state.maintenance);const restoreId=state.jobs.find(j=>j.kind==='restore').id
    await target.app('/api/bootstrap',{cookie:owner.cookie,expected:503})
    const otherBackup=join(root,engine+'-other-backup');await cp(backup.path,otherBackup,{recursive:true})
    await writeFile(join(otherBackup,'manifest.json'),JSON.stringify({...backup.manifest,id:randomUUID()}))
    await assert.rejects(restoreBackup(target.client,otherBackup,runnerId,{resumeId:restoreId}),/original verified/)
    let changed=false
    const corruptImport=async(path,options)=>{
      if(!changed&&path.endsWith('/tables/messages')&&options?.method==='POST'&&!options.body.links){changed=true;options={...options,body:{...options.body,rows:options.body.rows.map(row=>row.id===messageId?{...row,text:'Injected record corruption'}:row)}}}
      return target.client(path,options)
    }
    await assert.rejects(restoreBackup(corruptImport,backup.path,runnerId,{resumeId:restoreId}),/incomplete/)
    assert((await target.client('/status')).maintenance,'Record readback failure keeps restore frozen')
    await restoreBackup(target.client,backup.path,runnerId,{resumeId:restoreId});state=await target.client('/status');assert(!state.maintenance&&state.outboundDisabled)
    await target.app('/api/bootstrap',{cookie:owner.cookie,expected:401})
    const signedIn=await target.app('/api/auth/login',{method:'POST',body:{name:'member',password:'correct-horse-battery'}})
    const restored=await target.app('/api/bootstrap?workspace='+community,{cookie:signedIn.cookie});assert(restored.data.workspaces.some(w=>w.id===community))
    assert(restored.data.members.find(m=>m.id===member.data.user.id).roleIds.includes(role.id))
    assert(!restored.data.channels.find(c=>c.id===channel).permissions.includes('attachments.upload'))
    const targetDb=await target.mf.getD1Database('DB')
    assert.equal(await targetDb.prepare('SELECT enabled FROM server_apps WHERE id=?').bind(bot.app.id).first('enabled'),0)
    assert.equal(await targetDb.prepare('SELECT count(*) AS n FROM app_slack_webhooks WHERE id=?').bind(webhook.id).first('n'),1)
    assert.equal(await targetDb.prepare('SELECT count(*) AS n FROM app_message_requests WHERE app_id=? AND request_id=?').bind(bot.app.id,botPost.id).first('n'),1)
    for(const table of ['app_outbox','app_invocations']) assert.equal(await targetDb.prepare(`SELECT count(*) AS n FROM ${table}`).first('n'),0)
    const restoredAppResponse=await target.mf.dispatchFetch(target.origin+`/api/apps/${bot.app.id}/messages`,{method:'POST',headers:{Authorization:`Bearer ${bot.token}`,'Content-Type':'application/json'},body:JSON.stringify({...botPost,id:randomUUID()})})
    assert.equal(restoredAppResponse.status,403);await restoredAppResponse.body?.cancel()
    const history=(await target.app(`/api/channels/${channel}/messages`,{cookie:signedIn.cookie})).data;assert(history.some(m=>m.id===messageId&&m.text==='Preserved root'))
    assert(history.some(m=>m.bot&&m.author==='Recovery bot'&&m.text===botPost.text))
    assert(history.some(m=>m.text===unicodeText),'Unicode, multiline and embedded NUL survive portable recovery')
    assert(history.find(m=>m.id===messageId).reactions.some(r=>r.emoji==='👍'&&r.mine&&r.count===1))
    assert(history.some(m=>m.text==='Preserved reply'&&m.replyToId===messageId&&m.reply?.text==='Preserved root'))
    const restoredThread=(await target.app(`/api/channels/${channel}/threads/${threadId}`,{cookie:signedIn.cookie})).data
    assert.equal(restoredThread.thread.parentMessageId,messageId);assert(restoredThread.messages.some(m=>m.threadId===threadId&&m.text==='Preserved thread message'))
    const download=(await target.app(`/api/attachments/${attachment}/download`,{cookie:signedIn.cookie})).data
    assert.deepEqual((await target.app(download.url,{raw:true})).data,bytes)
    const calls=providerCalls.length;await target.app(`/api/channels/${channel}/ai`,{method:'POST',cookie:signedIn.cookie,expected:409});assert.equal(providerCalls.length,calls)
    await assert.rejects(restoreBackup(source.client,backup.path,runnerId),/409/)
    console.log(`PASS ${engine}: owner isolation, single job/idempotency, frozen writes, real table/file backup, corruption refusal, interrupted restore/resume, independent destination, password/membership/thread/file recovery, session revocation and outbound disablement`)
    const updateId=randomUUID();await source.app('/api/installation/operations',{method:'POST',cookie:owner.cookie,body:{id:updateId,kind:'update',version:targetBuild.version}})
    const update=await source.client('/claim',{method:'POST',body:{runnerId}})
    const hooks={prepare:async()=>({manifest:{format:1,...targetBuild,engines:['cloudflare','celld'],artifacts:[]},directory:root}),verify:(origin,expected)=>verifyInstallation(origin,expected,source.transport),migrate:()=>source.app('/api/_migrate',{method:'POST',operator:true,body:{}})}
    await assert.rejects(executeJob(source.client,update.job,update.key,source.config,{...hooks,activate:async()=>{throw new Error('Injected deployment failure')}}),/recovery point/)
    state=await source.client('/status');assert(state.maintenance);assert(state.jobs[0].checkpoint)
    const resumed=await source.client('/claim',{method:'POST',body:{runnerId,resumeId:updateId}})
    await assert.rejects(executeJob(source.client,resumed.job,resumed.key,source.config,{...hooks,activate:()=>source.activate(),verify:async()=>{throw new Error('Injected interruption after runtime replacement')}}),/recovery point/)
    state=await source.client('/status');assert(state.maintenance);assert.equal(state.build.version,targetBuild.version)
    const deployed=await source.client('/claim',{method:'POST',body:{runnerId,resumeId:updateId}})
    await executeJob(source.client,deployed.job,deployed.key,source.config,{...hooks,activate:async()=>{throw new Error('Must not deploy twice')},prepare:async()=>{throw new Error('Must use approved installed identity')}})
    state=await source.client('/status');assert.equal(state.build.version,targetBuild.version);assert.equal(state.jobs[0].status,'complete');assert(!state.maintenance)
    assert((await source.app(`/api/channels/${channel}/messages`,{cookie:member.cookie})).data.some(m=>m.id===messageId))
    const cancelledId=randomUUID();await source.client('/enqueue',{method:'POST',body:{id:cancelledId,kind:'backup'}})
    const cancelled=await source.client('/claim',{method:'POST',body:{runnerId}})
    await source.client(`/jobs/${cancelledId}/snapshot`,{method:'POST',key:cancelled.key,body:{}})
    await source.app(`/api/installation/operations/${cancelledId}`,{method:'DELETE',cookie:owner.cookie})
    assert(!(await source.client('/status')).maintenance)
    await assert.rejects(source.client(`/jobs/${cancelledId}/checkpoint`,{method:'POST',key:cancelled.key,body:backup.result}),/409/)
    assert.equal((await source.client('/status')).jobs[0].phase,'cancelled')
    await source.app('/api/installation/backup-policy',{method:'PUT',cookie:owner.cookie,body:{backupHours:1,retainBackups:2}})
    await (await source.mf.getD1Database('DB')).prepare('UPDATE installation_state SET last_backup=0').run()
    const scheduled=await source.client('/claim',{method:'POST',body:{runnerId}});assert.equal(scheduled.job.kind,'backup')
    assert.equal((await source.client('/claim',{method:'POST',body:{runnerId}})).job,null,'One overdue operation, no parallel catch-up burst')
    await source.app(`/api/installation/operations/${scheduled.job.id}`,{method:'DELETE',cookie:owner.cookie})
    const restoredOwner=await target.app('/api/auth/login',{method:'POST',body:{name:'owner',password:'correct-horse-battery'}})
    const rollbackId=randomUUID();await target.client('/enqueue',{method:'POST',body:{id:rollbackId,kind:'update',version:targetBuild.version}})
    const rollbackClaim=await target.client('/claim',{method:'POST',body:{runnerId}})
    const targetHooks={...hooks,migrate:()=>target.app('/api/_migrate',{method:'POST',operator:true,body:{}}),verify:(origin,expected)=>verifyInstallation(origin,expected,target.transport)}
    await assert.rejects(executeJob(target.client,rollbackClaim.job,rollbackClaim.key,target.config,{...targetHooks,activate:()=>target.activate(),verify:async()=>{throw new Error('Injected failure requires compatible rollback')}}),/recovery point/)
    const rollbackState=await target.client('/status'), failed=rollbackState.jobs.find(j=>j.id===rollbackId), recovery=await verifyBackup(join(target.config.backupDirectory,failed.checkpoint))
    const rollbackResume=await target.client('/claim',{method:'POST',body:{runnerId,resumeId:rollbackId}})
    await assert.rejects(target.client(`/jobs/${rollbackId}/rollback`,{method:'POST',key:rollbackResume.key,body:{sourceBuild:{...recovery.manifest.build,schema:'incompatible-schema'},backupId:recovery.manifest.id,manifestHash:recovery.manifestHash}}),/409/)
    const rollbackJob=await target.client(`/jobs/${rollbackId}/rollback`,{method:'POST',key:rollbackResume.key,body:{sourceBuild:recovery.manifest.build,backupId:recovery.manifest.id,manifestHash:recovery.manifestHash}})
    await executeJob(target.client,rollbackJob,rollbackResume.key,target.config,{...targetHooks,prepare:async()=>({manifest:{...sourceBuild,engines:['cloudflare','celld']},directory:root}),activate:()=>target.activate(sourceBuild)})
    assert(!(await target.client('/status')).maintenance);assert.equal((await target.client('/status')).build.version,sourceBuild.version)
    assert((await target.app(`/api/channels/${channel}/messages`,{cookie:restoredOwner.cookie})).data.some(m=>m.id===messageId))
    console.log(`PASS ${engine}: pre-update checkpoint; failure before/after deploy; explicit resume without repeated activation; runtime replacement/migrations; preserved data/files/keys/login session; cancelled-claim fencing and serialized overdue backup`)
    console.log(`PASS ${engine}: retention keeps recent/pinned/foreign/corrupt copies; compatible code rollback verifies original data/keys; schema rollback refused`)
  }
} finally { await Promise.allSettled(fixtures.map(f=>f.mf.dispose())); await rm(root,{recursive:true,force:true}) }
