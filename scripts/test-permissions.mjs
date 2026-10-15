import assert from 'node:assert/strict'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { setTimeout as delay } from 'node:timers/promises'
import { resolve } from 'node:path'
import { checkRoles } from './integration-roles.mjs'
import { endpoints, matchEndpoint, liveEventSchema } from '../runtime/contracts.mjs'

const base = 'https://permissions.test', sockets = [], providerCalls = []
let rejectRemoval = false, listenerMedia = 'NOT_ALLOWED'
const voice = { calls: providerCalls, rejectRemoval: value => { rejectRemoval = value }, listenerMedia: value => { listenerMedia = value } }
async function provider(request) {
  const url = new URL(request.url), path = url.pathname, body = request.method === 'POST' ? await request.json() : undefined
  assert.equal(url.origin, 'https://api.cloudflare.com'); assert(path.startsWith('/client/v4/accounts/'+'a'.repeat(32)+'/realtime/kit/test-app/'))
  assert.equal(request.headers.get('Authorization'), 'Bearer local-provider-double')
  providerCalls.push({ url: request.url, method: request.method, body })
  let data
  if (path.endsWith('/presets')) { assert.equal(url.searchParams.get('search'),'listener'); data = [{id:'00000000-0000-4000-8000-000000000001',name:'listener'}] }
  else if (path.endsWith('/presets/00000000-0000-4000-8000-000000000001')) data = {name:'listener',permissions:{media:{audio:{can_produce:'NOT_ALLOWED'},video:{can_produce:listenerMedia},screenshare:{can_produce:'NOT_ALLOWED'}},can_change_participant_permissions:false,can_accept_production_requests:false}}
  else if (path.endsWith('/meetings') && request.method === 'POST') { assert.equal(body.record_on_start,false); data = {id:crypto.randomUUID()} }
  else if (path.endsWith('/participants') && request.method === 'POST') { assert.equal(body.preset_name,'listener'); data = {id:crypto.randomUUID(),token:'local-participant-token'} }
  else if (request.method === 'DELETE') { if(rejectRemoval)return Response.json({success:false},{status:502}); data={} }
  else throw Error('Unexpected provider request')
  return Response.json({success:true,data})
}
const mf = new Miniflare(convertV4MiniflareOptions({
  modules: true, modulesRoot: resolve('runtime/cloudflare'), scriptPath: resolve('runtime/cloudflare/worker.js'),
  compatibilityDate: '2026-10-14', compatibilityFlags: ['nodejs_compat'], cf: false,
  d1Databases: ['DB'], r2Buckets: ['FILES'], durableObjects: { HUBS: { className: 'WorkspaceHub', useSQLite: true }, ROOMS: { className: 'ChatRoom', useSQLite: true } },
  bindings: { AUTH_BASE_URL: base, APP_SECRET: crypto.randomUUID(), MIGRATION_TOKEN: 'test-migration' },
  serviceBindings: { ASSETS: () => new Response('Anycord') },
  outboundService: provider,
}))
let ip = 0
async function api(path, { cookie, method = 'GET', body, expected = 200, headers = {} } = {}) {
  const response = await mf.dispatchFetch(base + path, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), Origin: base, 'CF-Connecting-IP': `192.0.2.${(++ip % 240) + 1}`, 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const data = await response.json()
  assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(data)}`)
  const endpoint = matchEndpoint(method, new URL(base + path).pathname)
  if (endpoint && response.ok) endpoints[endpoint.name].response.parse(data)
  return { data, cookie: response.headers.getSetCookie().filter(value => value.includes('cellcord.session_token=')).map(value => value.split(';')[0]).join('; ') || undefined }
}
async function connect(cookie, workspaceId) {
  const response = await mf.dispatchFetch(`${base}/api/workspaces/${workspaceId}/ws`, { headers: { Cookie: cookie, Origin: base, Upgrade: 'websocket' } })
  const ws = response.webSocket, events = []
  assert(ws); sockets.push(ws); ws.accept()
  ws.addEventListener('message', event => events.push(liveEventSchema.parse(JSON.parse(event.data))))
  const until = async predicate => { for (let i = 0; i < 200; i++) { const found = events.find(predicate); if (found) return found; await delay(25) }; throw new Error(`Missing realtime event: ${JSON.stringify(events)}`) }
  await until(event => event.type === 'ready')
  return { ws, events, until }
}
try {
  await mf.ready
  await api('/api/_migrate', { method: 'POST', body: {}, headers: { 'X-Migration-Token': 'test-migration' } })
  const owner = await api('/api/auth/register', { method: 'POST', body: { name: 'roles_owner', password: 'correct-horse-battery' }, expected: 201 })
  await api('/api/integrations', {cookie:owner.cookie,method:'PUT',body:{realtimeAccountId:'a'.repeat(32),realtimeAppId:'test-app',realtimePreset:'group_call_participant',realtimeToken:'local-provider-double'}})
  await checkRoles({ api, connect, owner, base, voice, fetch: (url, init) => mf.dispatchFetch(url, init) })
  // DB constraints independently reject cross-server assignments.
  const db = await mf.getD1Database('DB')
  const role = await db.prepare("SELECT id FROM roles WHERE workspace_id != 'main' AND position > 0 LIMIT 1").first()
  await assert.rejects(() => db.prepare('INSERT INTO member_roles (workspace_id, user_id, role_id) VALUES (?, ?, ?)').bind('main', owner.data.user.id, role.id).run(), /FOREIGN KEY/)
  const guest = await api('/api/auth/login', { method: 'POST', body: { name: 'roles_guest', password: 'correct-horse-battery' } })
  await db.batch(Array.from({ length: 120 }, (_, index) => db.prepare("INSERT INTO channels (id, workspace_id, name, topic, kind, position) VALUES (?, 'main', ?, '', 'text', ?)").bind(`scope-${index}`, `scope-${index}`, index)))
  await db.batch([
    db.prepare("INSERT INTO channel_overrides (channel_id, subject_type, subject_id, permission, effect) VALUES ('general', 'member', ?, 'channels.view', 'deny')").bind(guest.data.user.id),
    ...['general', 'scope-119'].map(channelId => db.prepare("INSERT INTO messages (id, channel_id, author_id, text, created_at) VALUES (?, ?, ?, 'scope-limit-test', ?)").bind(crypto.randomUUID(), channelId, owner.data.user.id, Date.now())),
  ])
  const matches = (await api('/api/search?workspace=main&q=scope-limit-test', { cookie: guest.cookie })).data
  assert.equal(matches.length, 1); assert.equal(matches[0].channelId, 'scope-119')
  console.log('PASS: permission-filtered search exceeds 100 channels without exceeding D1 bind limits.')
  console.log('PASS: Cloudflare entry on local workerd with real D1, SQLite Durable Objects, R2, WebSockets and cross-server database constraints.')
} finally {
  for (const ws of sockets) if (ws.readyState === 1) ws.close()
  await mf.dispose()
}
