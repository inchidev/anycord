import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, cp, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket from 'ws'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const { endpoints, matchEndpoint, apiErrorSchema, liveEventSchema, createApiClient } =
  await import(pathToFileURL(resolve(existsSync('contracts.mjs') ? 'contracts.mjs' : 'runtime/contracts.mjs')))

const folder = await mkdtemp(join(tmpdir(), 'cellcord-check-'))
const base = 'http://127.0.0.1:19876'
const migrationToken = crypto.randomUUID()
let child, logs = ''
const clients = []
await mkdir(join(folder, '.output'), { recursive: true })
// Only the disposable test bundle points at this local provider double.
const workerSource = (await readFile(process.env.TEST_WORKER_FILE || 'worker.js', 'utf8')).replaceAll('https://api.cloudflare.com/client/v4', 'http://127.0.0.1:19877').replaceAll('https://openrouter.ai/api/v1/chat/completions', 'http://127.0.0.1:19877/ai')
await writeFile(join(folder, 'worker.js'), workerSource)
await cp('wrangler.jsonc', join(folder, 'wrangler.jsonc'))
await cp('.output/public', join(folder, '.output/public'), { recursive: true })
await writeFile(join(folder, '.dev.vars'), `APP_SECRET=${crypto.randomUUID()}\nMIGRATION_TOKEN=${migrationToken}\nAUTH_BASE_URL=${base}\n`)
let storageVars = ''
for (const key of ['STORAGE_ENDPOINT','STORAGE_BUCKET','STORAGE_REGION','STORAGE_ACCESS_KEY_ID','STORAGE_SECRET_ACCESS_KEY']) if (process.env[key]) storageVars += `${key}=${JSON.stringify(process.env[key])}\n`
if (storageVars) await writeFile(join(folder, '.dev.vars'), await readFile(join(folder, '.dev.vars'), 'utf8') + storageVars)
const providerCalls = []
const provider = createServer(async (request, response) => {
  let raw = ''; for await (const chunk of request) raw += chunk
  const body = raw ? JSON.parse(raw) : undefined
  providerCalls.push({ url: request.url, method: request.method, body, authorization: request.headers.authorization })
  response.setHeader('Content-Type', 'application/json')
  if (request.url === '/ai') {
    assert.equal(request.headers.authorization, 'Bearer fake-test-ai-key-never-send')
    assert(body.messages.length <= 13)
    response.end(JSON.stringify({ choices: [{ message: { content: 'AI response from the local provider double' } }] })); return
  }
  assert.equal(request.headers.authorization, 'Bearer fake-test-token-never-send')
  let data = {}
  if (request.url.endsWith('/presets')) data = [{ name: 'group_call_participant' }]
  else if (request.url.endsWith('/meetings')) { assert.equal(body.record_on_start, false); data = { id: crypto.randomUUID() } }
  else if (request.url.endsWith('/participants') && request.method === 'POST') { assert.equal(body.preset_name, 'group_call_participant'); data = { id: crypto.randomUUID(), token: 'mock-participant-token' } }
  response.end(JSON.stringify({ success: true, data }))
})
await new Promise((resolve) => provider.listen(19877, '127.0.0.1', resolve))
async function start() {
  child = spawn('celld', ['dev', '.', '--host', '127.0.0.1', '--port', '19876', '--no-watch'], { cwd: folder })
  child.stdout.on('data', (data) => { logs += data })
  child.stderr.on('data', (data) => { logs += data })
  for (let i = 0; i < 160; i++) {
    try { if ((await fetch(`${base}/api/_runtime`)).ok) return } catch {}
    if (child.exitCode !== null) throw new Error(`Test runtime exited: ${logs}`)
    await delay(250)
  }
  throw new Error(`Test runtime did not start: ${logs}`)
}
async function stop() {
  if (!child || child.exitCode !== null) return
  const current = child, exited = once(current, 'exit'), timeout = new AbortController()
  current.kill('SIGINT')
  await Promise.race([exited, delay(20_000, undefined, { signal: timeout.signal }).then(() => { if (current.exitCode === null) current.kill('SIGKILL') }).catch(() => undefined)])
  timeout.abort()
  if (current.exitCode === null && current.signalCode === null) await exited
}
async function api(path, { cookie, method = 'GET', body, expected = 200, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
  const data = await response.json()
  assert.equal(response.headers.get('set-auth-token'), null, 'Cookie endpoints must not expose bearer tokens in headers')
  assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(data)}`)
  const contract = matchEndpoint(method, new URL(path, base).pathname)
  if (contract && response.ok) endpoints[contract.name].response.parse(data)
  if (!response.ok) apiErrorSchema.parse(data)
  return { data, cookie: response.headers.getSetCookie().filter((value) => value.includes('cellcord.session_token=')).map((value) => value.split(';')[0]).join('; ') || undefined }
}
async function connect(cookie, workspace = 'main') {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/api/workspaces/${workspace}/ws`, { headers: { Cookie: cookie, Origin: base } })
  clients.push(ws)
  const events = []
  ws.on('message', (data) => events.push(liveEventSchema.parse(JSON.parse(data.toString()))))
  ws.on('error', () => {})
  const until = async (predicate) => {
    for (let i = 0; i < 200; i++) { const found = events.find(predicate); if (found) return found; await delay(25) }
    throw new Error(`Expected WebSocket event: ${JSON.stringify(events)}`)
  }
  await until((event) => event.type === 'ready')
  return { ws, events, until }
}

try {
  await start()
  const runtime = await api('/api/runtime')
  assert.equal(runtime.data.engine, process.env.TEST_ENGINE || 'celld'); assert.equal(runtime.data.apiVersion, 1)
  const legacy = Array.from({ length: 100 }, (_, index) => ({ id: crypto.randomUUID(), name: 'archive', text: `Preserved message ${index} old-search-marker-${index}`, sentAt: Date.now() - 200_000 + index * 100 }))
  legacy[0].id = `archive-${'x'.repeat(110)}` // Opaque migrated IDs must not be truncated by the focus query.
  const firstName = JSON.parse(await readFile('drizzle/meta/_journal.json', 'utf8')).entries[0].tag
  const first = await api('/api/_migrate', { method: 'POST', headers: { 'X-Migration-Token': migrationToken }, body: { target: firstName, legacy } })
  assert.equal(first.data.applied.length, 1); assert.equal(first.data.messageCount, 101)
  const second = await api('/api/_migrate', { method: 'POST', headers: { 'X-Migration-Token': migrationToken }, body: {} })
  assert.equal(second.data.applied.length, 5); assert.equal(second.data.messageCount, 101)
  const third = await api('/api/_migrate', { method: 'POST', headers: { 'X-Migration-Token': migrationToken }, body: {} })
  assert.equal(third.data.applied.length, 0)
  console.log('PASS: Drizzle migrations through 0005 preserve existing rows; reapply is idempotent.')
  await api('/api/_migrate', { method: 'POST', body: {}, expected: 403 })
  await api('/api/bootstrap', { expected: 401 })
  const status = await api('/api/auth/status'); assert.equal(status.data.initialized, false)
  await api('/api/auth/register', { method: 'POST', body: { name: 'bad', password: 'short' }, expected: 400 })
  const alice = await api('/api/auth/register', { method: 'POST', body: { name: 'alice', password: 'correct-horse-battery' }, expected: 201 })
  const bob = await api('/api/auth/register', { method: 'POST', body: { name: 'bob', password: 'correct-horse-battery' }, expected: 201 })
  const signedIn = await api('/api/auth/login', { method: 'POST', body: { name: 'alice', password: 'correct-horse-battery' } })
  assert.equal(signedIn.data.user.id, alice.data.user.id); assert(signedIn.cookie)
  await api('/api/auth/sign-up/email', { method: 'POST', body: { email: 'bypass@example.com', name: 'bypass', password: 'correct-horse-battery' }, expected: 404 })
  assert.equal(alice.data.user.role, 'owner'); assert.equal(bob.data.user.role, 'member')
  await api('/api/auth/login', { method: 'POST', body: { name: 'alice', password: 'wrong-password' }, expected: 401 })
  await api('/api/bootstrap', { cookie: alice.cookie, headers: { Origin: 'https://example.com' }, expected: 403 })
  const html = await (await fetch(base)).text(); assert.match(html, /Anycord/); assert.match(html, /_nuxt/)
  const scripts = [...html.matchAll(/(?:src|href)="([^"]+\.js)"/g)].map((match) => match[1])
  for (const asset of scripts) assert.equal((await fetch(new URL(asset, base))).status, 200)
  const a = await connect(alice.cookie), b = await connect(bob.cookie)
  await a.until((event) => event.type === 'presence' && event.users.length === 2)
  const message = { id: crypto.randomUUID(), text: 'Hello from the migrated D1 database' }
  await api('/api/channels/general/messages', { cookie: alice.cookie, method: 'POST', body: message, expected: 201 })
  await b.until((event) => event.type === 'message' && event.message.id === message.id)
  await api('/api/channels/general/messages', { cookie: alice.cookie, method: 'POST', body: message })
  const concurrent = { id: crypto.randomUUID(), text: 'Concurrent retry' }
  const responses = await Promise.all([1, 2, 3].map(() => fetch(`${base}/api/channels/general/messages`, { method: 'POST', headers: { Cookie: alice.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(concurrent) })))
  assert.equal(responses.filter((response) => response.status === 201).length, 1)
  await delay(150)
  assert.equal(b.events.filter((event) => event.type === 'message' && event.message.id === message.id).length, 1)
  assert.equal(b.events.filter((event) => event.type === 'message' && event.message.id === concurrent.id).length, 1)
  a.ws.send(JSON.stringify({ type: 'typing', channelId: 'general' }))
  await b.until((event) => event.type === 'typing' && event.name === 'alice')
  await api(`/api/channels/general/messages/${message.id}`, { cookie: bob.cookie, method: 'PATCH', body: { text: 'not mine' }, expected: 403 })
  await api(`/api/channels/general/messages/${message.id}`, { cookie: alice.cookie, method: 'PATCH', body: { text: 'Edited and persisted' } })
  await api(`/api/channels/general/messages/${message.id}`, { cookie: bob.cookie, method: 'POST', body: { emoji: '👍' } })
  const history = await api('/api/channels/general/messages', { cookie: bob.cookie })
  const edited = history.data.find((row) => row.id === message.id)
  assert.equal(edited.text, 'Edited and persisted'); assert(edited.editedAt); assert(edited.reactions[0].mine)
  const old = await api(`/api/channels/general/messages?focus=${legacy[0].id}`, { cookie: alice.cookie })
  assert(old.data.some((row) => row.id === legacy[0].id))
  const search = await api('/api/search?q=old-search-marker-0', { cookie: alice.cookie }); assert.equal(search.data[0].id, legacy[0].id)
  console.log('PASS: cookie authentication, two-client delivery, typing/presence, duplicate and concurrent retry suppression, edits, reactions, and older-message search navigation.')
  const channel = await api('/api/workspaces/main/channels', { cookie: alice.cookie, method: 'POST', body: { name: 'terminal-check', kind: 'text', topic: 'API test' }, expected: 201 })
  const separate = await api(`/api/channels/${channel.data.id}/messages`, { cookie: alice.cookie }); assert.equal(separate.data.length, 0)
  const reply = await api('/api/channels/general/messages', { cookie: bob.cookie, method: 'POST', body: { id: crypto.randomUUID(), text: 'A real reply', replyToId: message.id }, expected: 201 })
  assert.equal(reply.data.reply.id, message.id); assert.equal(reply.data.reply.author, 'alice'); assert.equal(reply.data.reply.text, 'Edited and persisted')
  await api(`/api/channels/${channel.data.id}/messages`, { cookie: alice.cookie, method: 'POST', body: { id: crypto.randomUUID(), text: 'Cross-channel reply', replyToId: message.id }, expected: 404 })
  await api(`/api/channels/general/messages/${message.id}`, { cookie: bob.cookie, method: 'POST', body: { emoji: '🦊' } })
  await api(`/api/channels/general/messages/${message.id}`, { cookie: bob.cookie, method: 'POST', body: { emoji: 'not-an-emoji' }, expected: 400 })
  const root = await api('/api/channels/general/messages', { cookie: bob.cookie, method: 'POST', body: { id: crypto.randomUUID(), text: 'A thread starter' }, expected: 201 })
  const thread = await api('/api/channels/general/threads', { cookie: alice.cookie, method: 'POST', body: { id: crypto.randomUUID(), parentMessageId: root.data.id, name: 'A real thread' }, expected: 201 })
  const reused = await api('/api/channels/general/threads', { cookie: bob.cookie, method: 'POST', body: { id: crypto.randomUUID(), parentMessageId: root.data.id, name: 'Duplicate thread' } })
  assert.equal(reused.data.id, thread.data.id)
  const threaded = await api('/api/channels/general/messages', { cookie: alice.cookie, method: 'POST', body: { id: crypto.randomUUID(), text: 'Only in thread thread-search-marker', threadId: thread.data.id }, expected: 201 })
  const threadReply = await api('/api/channels/general/messages', { cookie: bob.cookie, method: 'POST', body: { id: crypto.randomUUID(), text: 'Thread reply', threadId: thread.data.id, replyToId: threaded.data.id }, expected: 201 })
  assert.equal(threadReply.data.reply.id, threaded.data.id)
  const threadHistory = await api(`/api/channels/general/threads/${thread.data.id}?focus=${threaded.data.id}`, { cookie: bob.cookie })
  assert.equal(threadHistory.data.thread.messageCount, 2); assert.equal(threadHistory.data.parent.id, root.data.id)
  assert.equal(threadHistory.data.messages.length, 2)
  const mainHistory = await api('/api/channels/general/messages', { cookie: bob.cookie })
  assert(!mainHistory.data.some((row) => row.threadId)); assert(mainHistory.data.find((row) => row.id === root.data.id).thread.messageCount === 2)
  const foundThread = await api('/api/search?q=thread-search-marker', { cookie: bob.cookie }); assert.equal(foundThread.data[0].threadId, thread.data.id)
  await api(`/api/channels/general/messages?focus=${threaded.data.id}`, { cookie: alice.cookie, expected: 404 })
  await api('/api/channels/general/messages', { cookie: alice.cookie, method: 'POST', body: { id: crypto.randomUUID(), text: 'Wrong context', replyToId: threaded.data.id }, expected: 404 })
  await api(`/api/channels/${channel.data.id}/messages`, { cookie: alice.cookie, method: 'POST', body: { id: crypto.randomUUID(), text: 'Wrong channel', threadId: thread.data.id }, expected: 404 })
  await api(`/api/channels/${channel.data.id}/threads/${thread.data.id}`, { cookie: alice.cookie, expected: 404 })
  await api('/api/channels/general/messages', { cookie: alice.cookie, method: 'POST', body: { id: threaded.data.id, text: 'Changed retry', threadId: thread.data.id }, expected: 409 })
  const quote = '> alice:\n> A quoted message\n\nMy reply with 🦊'
  const quoted = await api('/api/channels/general/messages', { cookie: bob.cookie, method: 'POST', body: { id: crypto.randomUUID(), text: quote }, expected: 201 }); assert.equal(quoted.data.text, quote)
  await api(`/api/channels/general/messages/${threaded.data.id}`, { cookie: alice.cookie, method: 'DELETE' })
  const tombstone = await api(`/api/channels/general/threads/${thread.data.id}`, { cookie: bob.cookie }); assert.equal(tombstone.data.messages[0].replyToId, threaded.data.id); assert.equal(tombstone.data.messages[0].reply, null)
  const retriedReply = await api('/api/channels/general/messages', { cookie: bob.cookie, method: 'POST', body: { id: threadReply.data.id, text: 'Thread reply', threadId: thread.data.id, replyToId: threaded.data.id } })
  assert.equal(retriedReply.data.id, threadReply.data.id); assert.equal(retriedReply.data.reply, null)
  await api(`/api/channels/general/messages/${root.data.id}`, { cookie: bob.cookie, method: 'DELETE' })
  const retained = await api(`/api/channels/general/threads/${thread.data.id}`, { cookie: alice.cookie }); assert.equal(retained.data.parent, null); assert.equal(retained.data.messages.length, 1)
  console.log('PASS: replies, Unicode emoji, quoted text, threads/search/focus, context isolation, conflicting retries, and deleted-original tombstones.')
  await api('/api/workspaces/main/channels', { cookie: bob.cookie, method: 'POST', body: { name: 'not-allowed' }, expected: 403 })
  const space = await api('/api/workspaces', { cookie: alice.cookie, method: 'POST', body: { name: 'Private server' }, expected: 201 })
  await api(`/api/bootstrap?workspace=${space.data.id}`, { cookie: bob.cookie, expected: 403 })
  const privateData = await api(`/api/bootstrap?workspace=${space.data.id}`, { cookie: alice.cookie })
  const typedClient = createApiClient((path, options) => api(path, { ...options, cookie: alice.cookie }).then((response) => response.data))
  const typedBootstrap = await typedClient('bootstrap', { query: { workspace: space.data.id } })
  assert.equal(typedBootstrap.user.id, alice.data.user.id)
  assert.equal(typedBootstrap.channels[0].id, privateData.data.channels[0].id)
  await api(`/api/search?q=${'x'.repeat(101)}`, { cookie: alice.cookie, expected: 400 })
  await api(`/api/channels/${privateData.data.channels[0].id}/messages`, { cookie: bob.cookie, expected: 403 })
  await api('/api/channels/hangout/huddle', { cookie: alice.cookie, method: 'POST', expected: 409 })
  await api('/api/channels/general/ai', { cookie: alice.cookie, method: 'POST', expected: 409 })
  const remoteOrigin = 'https://client.example.com'
  const preflight = await fetch(base + '/api/bootstrap', { method: 'OPTIONS', headers: { Origin: remoteOrigin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'Authorization' } })
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), remoteOrigin); assert.equal(preflight.headers.get('Access-Control-Allow-Credentials'), null)
  const loginResponse = await fetch(base + '/api/connections/login', { method: 'POST', headers: { Origin: remoteOrigin, 'Content-Type': 'application/json', Cookie: bob.cookie }, body: JSON.stringify({ name: 'alice', password: 'correct-horse-battery' }) })
  assert.equal(loginResponse.status, 200); assert.equal(loginResponse.headers.get('Set-Cookie'), null)
  const remote = await loginResponse.json(), remoteHeaders = { Authorization: `Bearer ${remote.token}`, Origin: remoteOrigin }
  assert.equal(remote.user.id, alice.data.user.id)
  await api('/api/bootstrap', { headers: remoteHeaders })
  await api('/api/bootstrap', { headers: { Origin: remoteOrigin, Cookie: alice.cookie }, expected: 403 })
  await api('/api/bootstrap', { headers: { Origin: remoteOrigin, Authorization: 'Bearer invalid', Cookie: alice.cookie }, expected: 401 })
  const ticket = (await api('/api/workspaces/main/live-ticket', { headers: remoteHeaders, method: 'POST' })).data.ticket
  const remoteWs = new WebSocket(`${base.replace('http', 'ws')}/api/workspaces/main/ws?ticket=${ticket}`, { headers: { Origin: remoteOrigin } })
  clients.push(remoteWs); remoteWs.on('error', () => {})
  await once(remoteWs, 'open')
  const replay = new WebSocket(`${base.replace('http', 'ws')}/api/workspaces/main/ws?ticket=${ticket}`, { headers: { Origin: remoteOrigin } }); replay.on('error', () => {}); clients.push(replay)
  await new Promise(resolve => replay.once('unexpected-response', (_request, response) => { assert.equal(response.statusCode, 401); response.resume(); resolve() }))
  await api('/api/auth/logout', { headers: remoteHeaders, method: 'POST' })
  await api('/api/bootstrap', { headers: remoteHeaders, expected: 401 })
  console.log('PASS: explicit remote login, CORS, no ambient cookie fallback, one-use WebSocket ticket and bearer logout revocation.')
  if (storageVars) {
    const channelId = privateData.data.channels[0].id
    await api('/api/storage/test', { cookie: bob.cookie, method: 'POST', expected: 403 })
    await api('/api/storage/test', { cookie: alice.cookie, method: 'POST' })
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1cAAAAASUVORK5CYII='), c => c.charCodeAt(0))
    const created = (await api(`/api/channels/${channelId}/attachments`, { cookie: alice.cookie, method: 'POST', body: { name: 'pixel.png', size: png.length }, expected: 201 })).data
    const path = `/api/attachments/${created.id}`
    const upload = await fetch(base + path + '/upload', { method: 'PUT', headers: { Cookie: alice.cookie, 'Content-Type': 'image/svg+xml' }, body: png })
    assert.equal(upload.status, 200, await upload.text())
    const duplicate = await fetch(base + path + '/upload', { method: 'PUT', headers: { Cookie: alice.cookie }, body: png }); assert.equal(duplicate.status, 409)
    await api(path + '/download', { cookie: alice.cookie, expected: 404 })
    const input = { id: crypto.randomUUID(), text: '', attachmentIds: [created.id] }
    const saved = (await api(`/api/channels/${channelId}/messages`, { cookie: alice.cookie, method: 'POST', body: input, expected: 201 })).data
    assert.equal(saved.attachments.length, 1); assert.equal(saved.attachments[0].contentType, 'image/png')
    await api(`/api/channels/${channelId}/messages`, { cookie: alice.cookie, method: 'POST', body: input })
    await api(`/api/channels/${channelId}/messages`, { cookie: alice.cookie, method: 'POST', body: { ...input, id: crypto.randomUUID() }, expected: 409 })
    await api(path + '/download', { cookie: bob.cookie, expected: 403 })
    const download = (await api(path + '/download', { cookie: alice.cookie })).data
    const file = await fetch(base + download.url); assert.equal(file.status, 200); assert.equal(file.headers.get('Content-Type'), 'image/png'); assert.deepEqual(new Uint8Array(await file.arrayBuffer()), png)
    const invalid = await fetch(base + download.url.replace('signature=', 'signature=x')); assert.equal(invalid.status, 403)
    await api(`/api/channels/${channelId}/messages/${input.id}`, { cookie: alice.cookie, method: 'DELETE' })
    assert.equal((await fetch(base + download.url)).status, 404)
    await api(path, { cookie: alice.cookie, method: 'DELETE' })
    console.log('PASS: real RustFS upload/read/delete, sniffed PNG type, attachment-only messages, atomic ownership, retries, private-channel access and deleted-message revocation.')
  }
  const beforeSettings = (await api('/api/bootstrap?workspace=main', { cookie: alice.cookie })).data
  const originalSpace = beforeSettings.workspaces.find(item => item.id === 'main')
  const originalChannel = beforeSettings.channels.find(item => item.id === 'general')
  await api('/api/workspaces/main', { cookie: bob.cookie, method: 'PATCH', body: { name: 'Denied', initials: 'NO' }, expected: 403 })
  await api(`/api/workspaces/${space.data.id}`, { cookie: bob.cookie, method: 'PATCH', body: { name: 'Denied', initials: 'NO' }, expected: 403 })
  await api('/api/workspaces/main', { cookie: alice.cookie, method: 'PATCH', body: { name: ' ', initials: 'TOOLONG' }, expected: 400 })
  const renamed = await api('/api/workspaces/main', { cookie: alice.cookie, method: 'PATCH', body: { name: '  Updated server  ', initials: ' UP ' } })
  assert.equal(renamed.data.name, 'Updated server'); assert.equal(renamed.data.initials, 'UP')
  await api('/api/channels/general', { cookie: bob.cookie, method: 'PATCH', body: { name: 'denied', topic: '' }, expected: 403 })
  await api(`/api/channels/${privateData.data.channels[0].id}`, { cookie: bob.cookie, method: 'PATCH', body: { name: 'denied', topic: '' }, expected: 403 })
  await api('/api/channels/general', { cookie: alice.cookie, method: 'PATCH', body: { name: 'Invalid name!', topic: '' }, expected: 400 })
  const editedChannel = await api('/api/channels/general', { cookie: alice.cookie, method: 'PATCH', body: { name: 'renamed-general', topic: 'Updated channel topic', kind: 'voice' } })
  assert.equal(editedChannel.data.kind, 'text'); assert.equal(editedChannel.data.topic, 'Updated channel topic')
  const reflectedSettings = (await api('/api/bootstrap?workspace=main', { cookie: alice.cookie })).data
  assert.equal(reflectedSettings.workspaces.find(item => item.id === 'main').name, 'Updated server')
  assert.equal(reflectedSettings.channels.find(item => item.id === 'general').name, 'renamed-general')
  await api('/api/workspaces/main', { cookie: alice.cookie, method: 'PATCH', body: { name: originalSpace.name, initials: originalSpace.initials } })
  await api('/api/channels/general', { cookie: alice.cookie, method: 'PATCH', body: { name: originalChannel.name, topic: originalChannel.topic } })
  console.log('PASS: server name/icon text and channel name/topic updates, validation, immutable channel kind, non-owner rejection, private-server isolation, and bootstrap consistency.')
  await api('/api/integrations', { cookie: bob.cookie, method: 'PUT', body: {}, expected: 403 })
  const configured = await api('/api/integrations', { cookie: alice.cookie, method: 'PUT', body: { realtimeAccountId: 'a'.repeat(32), realtimeAppId: 'test-app', realtimePreset: 'group_call_participant', realtimeToken: 'fake-test-token-never-send', openrouterKey: 'fake-test-ai-key-never-send' } })
  assert(configured.data.realtimeConfigured); assert(configured.data.aiConfigured)
  assert(!JSON.stringify(configured.data).includes('fake-test'))
  const database = await api('/api/database', { cookie: alice.cookie }); assert.equal(database.data.migrations.length, 6)
  await api('/api/database', { cookie: bob.cookie, expected: 403 })
  await api('/api/integrations/test', { cookie: alice.cookie, method: 'POST' })
  const calls = await Promise.all([alice, bob].map((account) => api('/api/channels/hangout/huddle', { cookie: account.cookie, method: 'POST' })))
  assert.equal(calls[0].data.meetingId, calls[1].data.meetingId)
  assert.equal(calls[0].data.authToken, 'mock-participant-token')
  assert.equal(providerCalls.filter((call) => call.url.endsWith('/meetings')).length, 1)
  await api(`/api/channels/hangout/huddle/${calls[0].data.participantId}`, { cookie: bob.cookie, method: 'DELETE', expected: 404 })
  await api(`/api/channels/hangout/huddle/${calls[0].data.participantId}`, { cookie: alice.cookie, method: 'DELETE' })
  await api(`/api/channels/hangout/huddle/${calls[1].data.participantId}`, { cookie: bob.cookie, method: 'DELETE' })
  await api('/api/channels/general/ai', { cookie: alice.cookie, method: 'POST' })
  console.log('PASS: server isolation, owner-only settings, masked secrets, RealtimeKit meeting/participant lifecycle, credential decryption, and AI API contract using a local provider double. No live provider calls.')
  for (const ws of clients) ws.close()
  await delay(100); await stop(); await start()
  const after = await api('/api/channels/general/messages', { cookie: alice.cookie })
  assert.equal(after.data.find((row) => row.id === message.id).text, 'Edited and persisted')
  const retainedThread = await api(`/api/channels/general/threads/${thread.data.id}`, { cookie: bob.cookie }); assert.equal(retainedThread.data.messages[0].text, 'Thread reply'); assert.equal(retainedThread.data.parent, null)
  const savedConfig = await api('/api/integrations', { cookie: alice.cookie }); assert(savedConfig.data.realtimeConfigured)
  const liveAfterRestart = await connect(alice.cookie)
  const closed = once(liveAfterRestart.ws, 'close')
  await api('/api/auth/logout', { cookie: alice.cookie, method: 'POST' })
  const [closeCode] = await Promise.race([closed, delay(5000).then(() => { throw new Error('Logout must close the realtime connection') })])
  assert.equal(closeCode, 4001)
  await api('/api/bootstrap', { cookie: alice.cookie, expected: 401 })
  console.log('PASS: messages, schema, sessions, and integration configuration survive a runtime restart; logout revokes access.')
} catch (error) {
  console.error(logs.slice(-8000))
  throw error
} finally {
  for (const ws of clients) ws.terminate()
  await stop()
  provider.close()
  await rm(folder, { recursive: true, force: true })
}
